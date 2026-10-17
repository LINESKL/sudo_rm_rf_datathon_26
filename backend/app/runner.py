"""One killable process per job. stdout is a small JSON progress protocol."""
import argparse
import contextlib
import importlib
import json
import os
import sys
import threading
import time
from pathlib import Path

from .schemas import JobOutput, Progress
from .video import make_preview


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--preview", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--analyzer", required=True)
    parser.add_argument("--timeout", type=float, required=True)
    parser.add_argument("--analysis-timeout", type=float, default=240)
    parser.add_argument("--job-id", required=True)
    args = parser.parse_args()
    deadline = time.monotonic() + args.timeout
    protocol = sys.stdout

    def on_progress(stage, value):
        progress = Progress(stage=stage, value=value)
        protocol.write(json.dumps(progress.model_dump()) + "\n")
        protocol.flush()

    with contextlib.redirect_stdout(sys.stderr):
        on_progress("decode", 0)
        # The browser preview is optional: it must never block or fail the jury result.
        preview_ok = threading.Event()

        def preview():
            try:
                make_preview(Path(args.video), Path(args.preview), os.getenv("FFMPEG_BIN", "ffmpeg"),
                             deadline - time.monotonic() - 5)
                preview_ok.set()
            except Exception as exc:  # noqa: BLE001 — logged, result still delivered
                print(f"preview failed: {exc!r}", file=sys.stderr)

        worker = threading.Thread(target=preview, daemon=True)
        worker.start()
        module, function = args.analyzer.split(":", 1)
        analyze = getattr(importlib.import_module(module), function)
        budget = min(args.analysis_timeout, deadline - time.monotonic())
        print(f"ML budget {budget:.2f} s", file=sys.stderr, flush=True)
        if budget <= 0:
            raise TimeoutError("Job deadline reached before ML analysis")
        result = analyze(args.video, deadline_s=budget, on_progress=on_progress)
        worker.join(max(0.0, deadline - time.monotonic() - 1))
        preview_url = f"/previews/{args.job_id}.mp4" if preview_ok.is_set() else None
        result = JobOutput(jury=result.to_jury(args.job_id),
                           details=result.to_details(args.job_id, preview_url))
        if result.jury.job_id != args.job_id or result.details.preview_url != preview_url:
            raise ValueError("Analyzer serializers changed the job identity or preview URL")
        # degraded=True is delivered as a normal result: for the jury a partial verdict beats "failed".
        output = Path(args.result)
        temporary = output.with_suffix(".tmp")
        temporary.write_text(result.model_dump_json(exclude_unset=True), encoding="utf-8")
        temporary.replace(output)


if __name__ == "__main__":
    main()
