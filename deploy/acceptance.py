"""HTTP acceptance: upload, both contracts, private media, Range and H.264 metadata.

Run from the repository root: python -m deploy.acceptance --url URL sample.mov
Reports contain hashes and counts, never evidence images, cookies or API keys.
"""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from backend.app.schemas import JobOutput


class CheckFailed(Exception):
    pass


def check(condition, message):
    if not condition:
        raise CheckFailed(message)


def faststart(data):
    """Inspect top-level MP4 atoms instead of searching arbitrary payload bytes."""
    offset, atoms = 0, []
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        header = 8
        if size == 1:
            size = int.from_bytes(data[offset + 8:offset + 16], "big")
            header = 16
        elif size == 0:
            size = len(data) - offset
        check(size >= header and offset + size <= len(data), "Invalid MP4 atom")
        atoms.append(kind)
        offset += size
    return b"moov" in atoms and b"mdat" in atoms and atoms.index(b"moov") < atoms.index(b"mdat")


def run(args, report):
    started = time.monotonic()
    deadline = started + args.timeout
    with args.video.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    report["input"] = {"bytes": args.video.stat().st_size,
                       "sha256": digest,
                       "suffix": args.video.suffix.lower(), "source": args.source}
    headers = {"X-API-Key": args.api_key}
    with httpx.Client(base_url=args.url.rstrip("/"), timeout=min(30, args.timeout), trust_env=False) as client:
        check(client.get("/api/v1/jobs/missing").status_code == 401, "Missing API key must return 401")
        check(client.get("/api/v1/jobs/missing", headers={"X-API-Key": "invalid"}).status_code == 401,
              "Wrong API key must return 401")
        check(client.get("/api/v1/jobs/missing", headers=headers).status_code == 404, "Missing job must return 404")
        health = client.get("/health")
        health.raise_for_status()
        report["health"] = health.json()
        if args.require_real:
            check(report["health"]["mode"] == "pipeline", "Real acceptance cannot use stub mode")
        with args.video.open("rb") as source:
            response = client.post("/api/v1/analyze", headers=headers,
                                   files={"file": (args.video.name, source)}, timeout=args.timeout)
        check(response.status_code == 200 and set(response.json()) == {"job_id"}, "Upload must return 200 and job_id only")
        job_id = response.json()["job_id"]
        report["job_id"] = job_id
        while time.monotonic() < deadline:
            response = client.get(f"/api/v1/jobs/{job_id}", headers=headers)
            response.raise_for_status()
            jury = response.json()
            if jury["status"] == "done":
                break
            check(jury["status"] == "processing" and set(jury) == {"job_id", "status"},
                  "Job failed or processing contract changed; inspect authenticated /details")
            time.sleep(.25)
        else:
            raise CheckFailed("Analysis exceeded the acceptance deadline")
        response = client.get(f"/api/v1/jobs/{job_id}/details", headers=headers)
        response.raise_for_status()
        details = response.json()
        JobOutput.model_validate({"jury": jury, "details": details})
        check(set(jury) == {"job_id", "status", "verdict", "violations"}, "Jury response contains unexpected fields")
        check(jury["job_id"] == job_id, "Job identity changed")
        if args.require_real:
            check(details.get("degraded") is False, "Real acceptance requires explicit degraded=false")
        preview = details["preview_url"]
        check(preview == f"/previews/{job_id}.mp4", "Preview URL changed")
        cookie = response.headers.get("set-cookie", "").lower()
        check("httponly" in cookie and "samesite=strict" in cookie and f"path={preview}" in cookie,
              "Missing per-video HttpOnly cookie")
        check(args.api_key not in response.headers.get("set-cookie", "") and args.api_key not in preview,
              "API key exposed through media")
        if args.url.startswith("https://"):
            check("; secure" in cookie, "HTTPS media cookie must be Secure")
        report["result"] = {"verdict": jury["verdict"], "events": len(jury["violations"]),
                            "frames": sum(len(v["evidence_frames"]) for v in jury["violations"]),
                            "degraded": details.get("degraded"), "duration_sec": details.get("duration_sec")}
        check(client.get(f"/api/v1/jobs/{job_id}").status_code == 401, "Media cookie must not authorize API")
        full = client.get(preview)
        check(full.status_code == 200 and full.headers.get("content-type") == "video/mp4", "Cookie media GET failed")
        check(full.headers.get("cache-control") == "no-store", "Private media must not be cached")
        head = client.head(preview)
        check(head.status_code == 200 and not head.content and int(head.headers["content-length"]) == len(full.content),
              "Media HEAD failed")
        for start in (0, len(full.content) // 2):
            end = min(start + 99, len(full.content) - 1)
            partial = client.get(preview, headers={"Range": f"bytes={start}-{end}"})
            check(partial.status_code == 206 and partial.content == full.content[start:end + 1]
                  and partial.headers["content-range"] == f"bytes {start}-{end}/{len(full.content)}", "Media Range failed")
        check(client.get(preview, headers={"Range": f"bytes={len(full.content)}-"}).status_code == 416,
              "Invalid range must return 416")
        client.cookies.clear()
        check(client.get(preview).status_code == 401, "Preview is publicly accessible without cookie")
        check(client.get(preview, headers=headers).status_code == 200, "Header-authorized preview failed")
        check(client.get("/previews/" + "0" * 32 + ".mp4", headers=headers).status_code == 404,
              "Missing preview must return 404")
        check(faststart(full.content), "Preview lacks faststart")
        with tempfile.TemporaryDirectory(prefix="observer-acceptance-") as temporary:
            path = Path(temporary) / "preview.mp4"
            path.write_bytes(full.content)
            probe = subprocess.run([args.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                                    "stream=codec_name,pix_fmt,duration", "-of", "json", str(path)],
                                   capture_output=True, check=True, timeout=15)
            stream = json.loads(probe.stdout)["streams"][0]
            check(stream["codec_name"] == "h264" and stream["pix_fmt"] == "yuv420p", "Wrong preview codec/pixel format")
            report["preview"] = {**stream, "bytes": len(full.content), "faststart": True,
                                 "private": True, "range": True}
    report["elapsed_sec"] = round(time.monotonic() - started, 3)
    check(report["elapsed_sec"] <= args.timeout, "HTTP acceptance exceeded deadline")
    report["passed"] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--source", choices=("synthetic", "dataset"), required=True,
                        help="Explicit provenance; synthetic is not dataset acceptance")
    parser.add_argument("--require-real", action="store_true")
    parser.add_argument("--ffprobe", default=os.getenv("FFPROBE_BIN", "ffprobe"))
    parser.add_argument("--output", type=Path, default=Path("test-results/acceptance-http.json"))
    args = parser.parse_args()
    args.api_key = os.getenv("API_KEY")
    if not args.api_key or not args.video.is_file() or args.timeout <= 0:
        parser.error("Set API_KEY, provide an existing video and a positive timeout")
    report = {"checked_at": datetime.now(timezone.utc).isoformat(), "passed": False,
              "require_real": args.require_real, "browser_playback_checked": False}
    try:
        run(args, report)
    except Exception as exc:
        # Pydantic errors can include evidence; avoid logging raw payloads or HTTP credentials.
        report["error"] = str(exc) if isinstance(exc, CheckFailed) else type(exc).__name__
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
