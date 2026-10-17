import asyncio
import importlib.util
import json
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse

from .auth import APIBoundary, require_api_key
from .config import Settings
from .lock import queue_lock
from .media import authorize_preview, issue_preview_cookie
from .queue import JobQueue
from .schemas import JobCreated, JobDetails, JobResult
from .store import Store
from .video import probe_video, save_upload


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.data_dir / "jobs.db")
    queue = JobQueue(store, settings)

    @asynccontextmanager
    async def lifespan(app):
        for directory in ("uploads", "previews", "results", "logs"):
            (settings.data_dir / directory).mkdir(parents=True, exist_ok=True)
        for name in (settings.ffmpeg, settings.ffprobe):
            if not shutil.which(name):
                raise RuntimeError(f"Executable not found: {name}")
        module, _, function = settings.analyzer.partition(":")
        if not function or importlib.util.find_spec(module) is None:
            raise RuntimeError(f"Analyzer is unavailable: {settings.analyzer}")
        with queue_lock(settings.data_dir / "queue.lock"):
            store.initialize()
            await queue.start()
            try:
                yield
            finally:
                await queue.stop()

    app = FastAPI(title="CashGuard API", version="0.1.0", lifespan=lifespan)
    app.state.settings, app.state.store, app.state.queue = settings, store, queue
    app.add_middleware(APIBoundary, api_key=settings.api_key, max_upload_bytes=settings.max_upload_bytes)
    # Outer CORS middleware also handles preflight requests without API credentials.
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                       allow_credentials=True,
                       allow_methods=["GET", "HEAD", "POST", "OPTIONS"],
                       allow_headers=["X-API-Key", "Content-Type", "Range"],
                       expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"])
    api = APIRouter(prefix="/api/v1", dependencies=[Depends(require_api_key)])

    @api.post("/analyze", response_model=JobCreated, status_code=200, openapi_extra={
        "requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
            "type": "object", "required": ["file"],
            "properties": {"file": {"type": "string", "format": "binary"}},
        }}}},
    })
    async def analyze(request: Request):
        # Explicit limits prevent extra multipart fields/files from filling temporary disk.
        async with request.form(max_files=1, max_fields=5) as form:
            upload = form.get("file")
            if upload is None or not hasattr(upload, "filename"):
                raise HTTPException(400, "Передайте видео в multipart-поле file")
            # Container is validated by ffprobe below; the client's filename may lack an extension.
            extension = Path(upload.filename or "").suffix.lower()
            if extension not in {".mov", ".mp4"}:
                extension = ".mov"
            job_id = uuid4().hex
            destination = settings.data_dir / "uploads" / f"{job_id}{extension}"
            await save_upload(upload, destination, settings.max_upload_bytes)
        try:
            duration = await asyncio.to_thread(probe_video, destination, settings.ffprobe)
            store.create(job_id, destination, duration)
        except BaseException as exc:
            destination.unlink(missing_ok=True)
            if isinstance(exc, ValueError):
                raise HTTPException(400, str(exc)) from exc
            raise
        queue.submit(job_id)
        return JobCreated(job_id=job_id)

    def get_job(job_id: str):
        row = store.get(job_id)
        if row is None:
            raise HTTPException(404, "Задача не найдена")
        return row

    @api.get("/jobs/{job_id}", response_model=JobResult, response_model_exclude_none=True)
    async def job(job_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.judge(get_job(job_id))

    @api.get("/jobs/{job_id}/details", response_model=JobDetails, response_model_exclude_unset=True)
    async def details(job_id: str, request: Request, response: Response):
        data = json.loads(get_job(job_id)["details_json"])
        response.headers["Cache-Control"] = "no-store"
        if data["status"] == "done" and data.get("preview_url"):
            issue_preview_cookie(response, request, job_id, settings)
        # Preserve rule:null on cards while omitting not-yet-known top-level fields.
        return JobDetails.model_validate({key: value for key, value in data.items() if value is not None})

    app.include_router(api)

    @app.api_route("/previews/{filename}", methods=["GET", "HEAD"], include_in_schema=False)
    async def preview(filename: str, request: Request):
        # Check credentials even before existence/identifier errors to prevent disclosure.
        authorize_preview(request, filename.removesuffix(".mp4"), settings)
        try:
            identifier = filename.removesuffix(".mp4")
            if filename != f"{UUID(identifier).hex}.mp4":
                raise ValueError()
        except ValueError:
            raise HTTPException(404, "Превью не найдено") from None
        row = store.get(identifier)
        path = settings.data_dir / "previews" / filename
        if not row or row["status"] != "done" or not path.is_file():
            raise HTTPException(404, "Превью ещё не готово")
        return FileResponse(path, media_type="video/mp4", headers={
            "Cache-Control": "no-store", "Vary": "Cookie, X-API-Key", "X-Content-Type-Options": "nosniff",
        })

    @app.get("/health")
    async def health():
        def gpu_status():
            try:
                result = subprocess.run([
                    "nvidia-smi", "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits",
                ], capture_output=True, text=True, timeout=3, check=True)
                return {"available": True, "devices": result.stdout.strip().splitlines()}
            except (OSError, subprocess.SubprocessError):
                return {"available": False, "devices": []}

        async def vllm_status():
            if not settings.vllm_enabled:
                return {"enabled": False, "ready": False}
            try:
                async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
                    response = await client.get(f"{settings.vlm_base_url.removesuffix('/v1')}/health")
                return {"enabled": True, "ready": response.status_code == 200}
            except httpx.HTTPError:
                return {"enabled": True, "ready": False}

        gpu, vllm = await asyncio.gather(asyncio.to_thread(gpu_status), vllm_status())
        disk = shutil.disk_usage(settings.data_dir)
        return {"status": "degraded" if settings.vllm_enabled and not vllm["ready"] else "ok",
                "mode": "stub" if settings.analyzer == "ml.stub:analyze" else "pipeline",
                "gpu": gpu, "vllm": vllm, "disk": {"free_bytes": disk.free, "total_bytes": disk.total},
                "workers": settings.workers, "queued": queue.queue.qsize()}

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        if path == "api" or path.startswith(("api/", "previews/")):
            raise HTTPException(404, "Маршрут не найден")
        root = settings.frontend_dir.resolve()
        candidate = (root / path).resolve()
        if not candidate.is_relative_to(root):
            raise HTTPException(404)
        if candidate.is_file():
            return FileResponse(candidate)
        index = root / "index.html"
        if index.is_file() and not Path(path).suffix:
            return FileResponse(index)
        if not path and not index.is_file():
            return HTMLResponse("<html lang='ru'><meta charset='utf-8'><title>CashGuard</title>"
                                "<h1>CashGuard API</h1><p>Сборка frontend/dist ещё не установлена.</p>"
                                "<a href='/docs'>Документация API</a></html>")
        raise HTTPException(404, "Файл не найден")

    return app
