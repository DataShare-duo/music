from fastapi import APIRouter, Query, Request
from sqlalchemy import text

from music.core.streaming import stream_audio
from music.providers.official import SOURCE_NAMES
from music.schemas.api import CreatePlayback, PlaybackView, RefreshPlayback, SongList

router = APIRouter(prefix="/api")


@router.get("/sources")
async def sources(request: Request):
    return [
        {
            "id": key,
            "name": name,
            "enabled": key in request.app.state.service.providers.providers,
            "status": "not_checked",
            "note": "仅公开音频，实际可用性以请求结果为准",
        }
        for key, name in SOURCE_NAMES.items()
    ]


@router.get("/home", response_model=SongList)
async def home(request: Request, ids: str | None = Query(default=None, max_length=1200)):
    from music.core.errors import AppError

    selected = None
    if ids is not None:
        try:
            selected = list(dict.fromkeys(int(value) for value in ids.split(",") if value))
        except ValueError as exc:
            raise AppError("invalid_ids", "推荐列表参数无效", 400) from exc
        if len(selected) > 100 or any(value <= 0 or value > 2**63 - 1 for value in selected):
            raise AppError("invalid_ids", "推荐列表参数无效", 400)
    return await request.app.state.service.home(selected)


@router.get("/search", response_model=SongList)
async def search(
    request: Request,
    q: str = Query(min_length=1, max_length=100),
    source: str = "soda",
    page: int = Query(default=1, ge=1, le=100),
):
    from music.core.errors import AppError

    query = q.strip()
    if not query:
        raise AppError("invalid_query", "请输入搜索关键词", 400)
    return await request.app.state.service.search(source, query, page)


@router.post("/songs/{song_id}/playbacks", response_model=PlaybackView)
async def create_playback(song_id: int, body: CreatePlayback, request: Request):
    return await request.app.state.service.create_playback(song_id, str(body.client_request_id))


@router.get("/playbacks/{playback_id}", response_model=PlaybackView)
async def playback(playback_id: str, request: Request):
    service = request.app.state.service
    return service.playback_view(await service.get_playback(playback_id))


@router.post("/playbacks/{playback_id}/started")
async def started(playback_id: str, request: Request):
    return await request.app.state.service.started(playback_id)


@router.post("/playbacks/{playback_id}/refresh", response_model=PlaybackView)
async def refresh(playback_id: str, body: RefreshPlayback, request: Request):
    return await request.app.state.service.refresh(playback_id, body.expected_version)


@router.get("/playbacks/{playback_id}/stream")
async def stream(playback_id: str, request: Request):
    return await stream_audio(
        request.app.state.service,
        request.app.state.proxy,
        playback_id,
        request.headers.get("range"),
    )


@router.get("/health")
async def health(request: Request):
    async with request.app.state.db.sessions() as db:
        await db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "ok"}
