"""Verify the packaged UI and every static asset through the running HTTP server.

Run inside the image, including with --network none. This complements browser
acceptance; it does not claim that video playback or JavaScript execution passed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import quote

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(os.environ.get("FRONTEND_DIR", "frontend/dist"))
    index = root / "index.html"
    if not index.is_file() or 'id="root"' not in index.read_text(encoding="utf-8"):
        raise SystemExit("Production React index.html is missing")
    files = sorted(path for path in root.rglob("*") if path.is_file())
    suffixes = {path.suffix for path in files}
    if not {".js", ".css", ".woff2"}.issubset(suffixes):
        raise SystemExit("Production JS, CSS or local fonts are missing")
    results = []
    with httpx.Client(base_url=args.url, timeout=10, trust_env=False) as client:
        for path in files:
            relative = path.relative_to(root).as_posix()
            url = "/" if relative == "index.html" else "/" + quote(relative)
            response = client.get(url)
            response.raise_for_status()
            expected = path.read_bytes()
            if response.content != expected:
                raise SystemExit(f"HTTP content differs from packaged file: {relative}")
            if path.suffix == ".js" and "javascript" not in response.headers.get("content-type", ""):
                raise SystemExit(f"Invalid JavaScript MIME type: {relative}")
            results.append({"path": relative, "bytes": len(expected),
                            "sha256": hashlib.sha256(expected).hexdigest(),
                            "content_type": response.headers.get("content-type")})
    report = {"passed": True, "files": results, "total_bytes": sum(row["bytes"] for row in results)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Packaged frontend: {len(results)} HTTP assets verified")


if __name__ == "__main__":
    main()
