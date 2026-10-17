import secrets

from fastapi import HTTPException, Request, Security
from fastapi.security import APIKeyHeader
from starlette.responses import JSONResponse


def matches_key(provided: str, expected: str) -> bool:
    return secrets.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(request: Request, api_key: str | None = Security(api_key_header)):
    if not matches_key(api_key or "", request.app.state.settings.api_key):
        raise HTTPException(status_code=401, detail="Неверный или отсутствующий X-API-Key")


class APIBoundary:
    """Authenticate before multipart parsing and cap streamed request bodies."""

    def __init__(self, app, api_key: str, max_upload_bytes: int):
        self.app = app
        self.api_key = api_key
        self.max_body = max_upload_bytes + 1024 * 1024  # multipart headers, boundaries

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "") if scope["type"] == "http" else ""
        jury_api = path == "/api" or path.startswith("/api/")
        if not (jury_api or path.startswith("/ui/")):
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        key = headers.get(b"x-api-key", b"").decode("latin-1")
        # The web UI needs no key (case FAQ 27); only the jury API is keyed. Both keep the upload cap.
        if jury_api and not matches_key(key, self.api_key):
            return await JSONResponse(
                {"detail": "Неверный или отсутствующий X-API-Key"}, status_code=401
            )(scope, receive, send)
        length = headers.get(b"content-length")
        if length is not None:
            try:
                oversized = int(length) > self.max_body or int(length) < 0
            except ValueError:
                oversized = True
            if oversized:
                return await JSONResponse(
                    {"detail": "Превышен допустимый размер загрузки"}, status_code=400
                )(scope, receive, send)
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > self.max_body:
                raise HTTPException(400, "Превышен допустимый размер загрузки")
            return message

        await self.app(scope, limited_receive, send)
