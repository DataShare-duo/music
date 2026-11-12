from fastapi import Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status: int = 502,
        playback_id: str | None = None,
        song_id: int | None = None,
        hidden: bool = False,
    ):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
        self.playback_id = playback_id
        self.song_id, self.hidden = song_id, hidden


async def error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "playback_id": exc.playback_id,
                "song_id": exc.song_id,
                "hidden": exc.hidden,
            }
        },
        headers={
            "Cache-Control": "no-store",
            **({"Retry-After": "5"} if exc.status in (429, 503) else {}),
        },
    )
