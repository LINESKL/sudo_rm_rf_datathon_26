"""Short-lived, per-video cookie grants; API credentials never enter media URLs."""
import hashlib
import hmac
import time

from fastapi import HTTPException, Request, Response

from .auth import matches_key
from .config import Settings

COOKIE_NAME = "cashguard_preview"


def grant(api_key: str, job_id: str, expires: int) -> str:
    message = f"cashguard-preview-v1:{job_id}:{expires}".encode()
    signature = hmac.new(api_key.encode(), message, hashlib.sha256).hexdigest()
    return f"{expires}.{signature}"


def authorize_preview(request: Request, job_id: str, settings: Settings):
    if matches_key(request.headers.get("X-API-Key", ""), settings.api_key):
        return
    token = request.cookies.get(COOKIE_NAME, "")
    try:
        expires_text, signature = token.split(".", 1)
        expires = int(expires_text)
        now = int(time.time())
        valid_time = now < expires <= now + settings.media_cookie_ttl_s
        if valid_time and len(signature) == 64 and matches_key(token, grant(settings.api_key, job_id, expires)):
            return
    except (ValueError, OverflowError):
        pass
    raise HTTPException(401, "Доступ к превью истёк или отсутствует. Обновите результат видео.")


def issue_preview_cookie(response: Response, request: Request, job_id: str, settings: Settings):
    expires = int(time.time()) + settings.media_cookie_ttl_s
    secure = settings.media_cookie_secure or request.url.scheme == "https"
    response.set_cookie(
        COOKIE_NAME, grant(settings.api_key, job_id, expires),
        max_age=settings.media_cookie_ttl_s, path=f"/previews/{job_id}.mp4",
        httponly=True, secure=secure, samesite="strict",
    )
    response.headers["Cache-Control"] = "no-store"
