import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .schemas import JobDetails, JobOutput, Progress


class Store:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at REAL NOT NULL,
                started_at REAL, finished_at REAL, result_json TEXT, details_json TEXT NOT NULL,
                error TEXT, video_path TEXT NOT NULL, duration_sec REAL NOT NULL
            )""")

    def create(self, job_id: str, video_path: Path, duration: float):
        details = JobDetails(job_id=job_id, duration_sec=duration)
        with self.connection() as conn:
            conn.execute(
                "INSERT INTO jobs(id,status,created_at,details_json,video_path,duration_sec) VALUES(?,?,?,?,?,?)",
                (job_id, "processing", time.time(), details.model_dump_json(), str(video_path), duration),
            )

    def get(self, job_id: str):
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return dict(row) if row else None

    def pending(self):
        with self.connection() as conn:
            return [r[0] for r in conn.execute(
                "SELECT id FROM jobs WHERE status='processing' ORDER BY created_at"
            )]

    def start(self, job_id: str):
        row = self.get(job_id)
        details = JobDetails(job_id=job_id, duration_sec=row["duration_sec"])
        with self.connection() as conn:
            conn.execute("UPDATE jobs SET started_at=?, details_json=?, error=NULL WHERE id=?",
                         (time.time(), details.model_dump_json(), job_id))

    def progress(self, job_id: str, progress: Progress):
        row = self.get(job_id)
        if row["status"] != "processing":
            return
        details = JobDetails.model_validate_json(row["details_json"])
        details.progress = progress
        details.processing_sec = max(0, time.time() - row["started_at"])
        with self.connection() as conn:
            conn.execute("UPDATE jobs SET details_json=? WHERE id=? AND status='processing'",
                         (details.model_dump_json(), job_id))

    def finish(self, job_id: str, result: JobOutput):
        row = self.get(job_id)
        now = time.time()
        details = result.details
        if details.duration_sec is None:
            details.duration_sec = row["duration_sec"]
        if details.processing_sec is None:
            details.processing_sec = max(0, now - row["started_at"])
        with self.connection() as conn:
            conn.execute("""UPDATE jobs SET status='done', finished_at=?, result_json=?,
                         details_json=?, error=NULL WHERE id=?""",
                         (now, result.jury.model_dump_json(), details.model_dump_json(), job_id))

    def fail(self, job_id: str, error: str):
        row = self.get(job_id)
        details = JobDetails.model_validate_json(row["details_json"])
        details.status = "failed"
        details.error = error
        details.progress.stage = "failed"
        details.processing_sec = max(0, time.time() - row["started_at"])
        with self.connection() as conn:
            conn.execute("UPDATE jobs SET status='failed', finished_at=?, details_json=?, error=? WHERE id=?",
                         (time.time(), details.model_dump_json(), error, job_id))

    def judge(self, row):
        return json.loads(row["result_json"]) if row["result_json"] else {
            "job_id": row["id"], "status": row["status"],
        }
