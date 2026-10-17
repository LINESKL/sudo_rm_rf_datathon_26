import asyncio
import json
import logging
import os
import signal
import sys

import psutil

from .config import ROOT, Settings
from .schemas import JobOutput, Progress
from .store import Store

logger = logging.getLogger(__name__)


def kill_process_tree(pid: int):
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        if os.name == "posix":
            # Runner owns a session: kill ffmpeg and any model subprocesses together.
            os.killpg(pid, signal.SIGKILL)
        else:
            # Stop the parent first so it cannot create another child during cleanup.
            parent.kill()
        for child in children:
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        psutil.wait_procs([parent, *children], timeout=3)
    except (psutil.NoSuchProcess, ProcessLookupError):
        pass


class JobQueue:
    def __init__(self, store: Store, settings: Settings):
        self.store = store
        self.settings = settings
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.tasks: list[asyncio.Task] = []

    async def start(self):
        # A hard kill of uvicorn can leave its runner alive on the same host.
        # Match both PID and creation time; never kill an unrelated reused PID.
        for marker in (self.settings.data_dir / "results").glob("*.pid"):
            try:
                saved = json.loads(marker.read_text())
                process = psutil.Process(saved["pid"])
                if process.create_time() == saved["created_at"] and "backend.app.runner" in process.cmdline():
                    await asyncio.to_thread(kill_process_tree, process.pid)
            except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError, KeyError):
                pass
            marker.unlink(missing_ok=True)
        for job_id in self.store.pending():
            self.queue.put_nowait(job_id)
        self.tasks = [asyncio.create_task(self.worker(), name=f"analysis-{i}")
                      for i in range(self.settings.workers)]

    async def stop(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks.clear()

    def submit(self, job_id: str):
        self.queue.put_nowait(job_id)

    async def worker(self):
        while True:
            job_id = await self.queue.get()
            try:
                self.store.start(job_id)
                await self.run(job_id)
            except asyncio.CancelledError:
                # Keep processing status on shutdown; next startup requeues it.
                raise
            except TimeoutError:
                self.store.fail(job_id, f"Превышен лимит обработки {self.settings.job_timeout_s:g} с")
            except Exception:
                logger.exception("Job %s failed", job_id)
                self.store.fail(job_id, "Ошибка обработки видео; подробности в журнале сервера")
            finally:
                self.queue.task_done()

    async def run(self, job_id: str):
        row = self.store.get(job_id)
        result_path = self.settings.data_dir / "results" / f"{job_id}.json"
        preview_path = self.settings.data_dir / "previews" / f"{job_id}.mp4"
        result_path.unlink(missing_ok=True)
        env = dict(os.environ, FFMPEG_BIN=self.settings.ffmpeg, FFPROBE_BIN=self.settings.ffprobe,
                   PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8",
                   VLM_BASE_URL=self.settings.vlm_base_url, VLM_MODEL=self.settings.vlm_model)
        # Imports must work regardless of the directory uvicorn was started from.
        env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
        with (self.settings.data_dir / "logs" / f"{job_id}.log").open("wb") as log:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "backend.app.runner", "--video", row["video_path"],
                "--preview", str(preview_path), "--result", str(result_path),
                "--analyzer", self.settings.analyzer, "--timeout", str(self.settings.job_timeout_s),
                "--analysis-timeout", str(self.settings.ml_deadline_s), "--job-id", job_id,
                stdout=asyncio.subprocess.PIPE, stderr=log, env=env,
                start_new_session=os.name == "posix",
            )
            try:
                marker = result_path.with_suffix(".pid")
                marker.write_text(json.dumps({"pid": process.pid,
                                             "created_at": psutil.Process(process.pid).create_time()}))
                async with asyncio.timeout(self.settings.job_timeout_s):
                    while line := await process.stdout.readline():
                        self.store.progress(job_id, Progress.model_validate_json(line))
                    code = await process.wait()
                    if code:
                        raise RuntimeError(f"Runner exited {code}; see {job_id}.log")
                    result = await asyncio.to_thread(result_path.read_text, encoding="utf-8")
                    self.store.finish(job_id, JobOutput.model_validate_json(result))
            finally:
                if process.returncode is None:
                    await asyncio.to_thread(kill_process_tree, process.pid)
                    await process.wait()
                result_path.unlink(missing_ok=True)
                result_path.with_suffix(".tmp").unlink(missing_ok=True)
                result_path.with_suffix(".pid").unlink(missing_ok=True)
                preview_path.with_suffix(".partial.mp4").unlink(missing_ok=True)
