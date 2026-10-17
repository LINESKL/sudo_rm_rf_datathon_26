"""Six simultaneous uploads, timing includes upload and queue. Nonzero on failure."""
import argparse
import asyncio
import json
import os
import time
from pathlib import Path

import httpx


async def run_one(client, video, number, output, timeout):
    started = time.monotonic()
    record = {"file": str(video), "number": number}
    try:
        async with asyncio.timeout(timeout):
            with video.open("rb") as stream:
                response = await client.post("/api/v1/analyze", files={"file": (video.name, stream)})
            response.raise_for_status()
            job_id = response.json()["job_id"]
            record["job_id"] = job_id
            while True:
                response = await client.get(f"/api/v1/jobs/{job_id}")
                response.raise_for_status()
                result = response.json()
                if result["status"] in {"done", "failed"}:
                    (output / f"{number}-{job_id}.json").write_text(
                        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                    record["status"] = result["status"]
                    if result["status"] == "failed":
                        details = await client.get(f"/api/v1/jobs/{job_id}/details")
                        details.raise_for_status()
                        record["error"] = details.json().get("error")
                    break
                await asyncio.sleep(.5)
    except (httpx.HTTPError, TimeoutError, OSError, ValueError, KeyError) as exc:
        record.update(status="failed", error=str(exc) or "deadline exceeded")
    record["elapsed_sec"] = round(time.monotonic() - started, 3)
    record["passed"] = record.get("status") == "done" and record["elapsed_sec"] <= timeout
    return record


async def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(base_url=args.url.rstrip("/"), headers={"X-API-Key": args.api_key},
                                 timeout=args.timeout, trust_env=False) as client:
        health = await client.get("/health")
        health.raise_for_status()
        mode = health.json().get("mode", "unknown")
        results = await asyncio.gather(*[
            run_one(client, args.videos[i % len(args.videos)], i + 1, args.output, args.timeout)
            for i in range(6)
        ])
    report = {"mode": mode, "results": results,
              "passed": all(item["passed"] for item in results) and (not args.require_real or mode == "pipeline")}
    (args.output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--api-key", default=os.getenv("API_KEY"))
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--output", type=Path, default=Path("test-results/loadtest"))
    parser.add_argument("--require-real", action="store_true", help="Fail if backend is using the stub")
    parser.add_argument("videos", type=Path, nargs="+", help="One video repeated six times, or six videos")
    args = parser.parse_args()
    if not args.api_key:
        parser.error("Set API_KEY or --api-key")
    if len(args.videos) not in (1, 6) or not all(path.is_file() for path in args.videos):
        parser.error("Provide one or six existing video files")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
