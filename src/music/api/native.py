"""WeChat-native control API; audio bypasses the container entirely."""

import asyncio

from fastapi import APIRouter, Request

from music.core.lyrics import LyricsView
from music.schemas.api import (
    CreateNativePlayback,
    NativePlaybackView,
    RefreshPlayback,
    RestoreSong,
    RestoreView,
)

router = APIRouter(prefix="/api/miniprogram")


@router.post("/songs/{song_id}/playbacks", response_model=NativePlaybackView)
async def create_playback(song_id: int, body: CreateNativePlayback, request: Request):
    return await request.app.state.service.create_playback(
        song_id, str(body.client_request_id), "direct", defer_click=body.defer_click
    )


@router.get("/playbacks/{playback_id}", response_model=NativePlaybackView)
async def playback(playback_id: str, request: Request):
    service = request.app.state.service
    return service.playback_view(await service.get_playback(playback_id, "direct"))


@router.post("/playbacks/{playback_id}/started")
async def started(playback_id: str, request: Request):
    return await request.app.state.service.started(playback_id, "direct")


@router.post("/playbacks/{playback_id}/refresh", response_model=NativePlaybackView)
async def refresh(playback_id: str, body: RefreshPlayback, request: Request):
    return await request.app.state.service.refresh(playback_id, body.expected_version, "direct")


@router.get("/playbacks/{playback_id}/lyrics", response_model=LyricsView)
async def lyrics(playback_id: str, request: Request):
    return await request.app.state.lyrics.get(playback_id)


@router.post("/songs/restore", response_model=RestoreView)
async def restore(body: RestoreSong, request: Request):
    from music.core.errors import AppError
    from music.core.restore import restore_song

    hint = body.query_hint.strip()
    if not hint:
        raise AppError("invalid_query", "歌曲检索提示不能为空", 400)
    try:
        async with asyncio.timeout(request.app.state.service.settings.full_audio_verify_timeout):
            return await restore_song(
                request.app.state.service, body.source, body.source_track_id, hint
            )
    except TimeoutError as exc:
        raise AppError("restore_timeout", "歌曲恢复超时，请稍后重试", 504) from exc
