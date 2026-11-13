"""WeChat-native control API; audio bypasses the container entirely."""

from fastapi import APIRouter, Request

from music.schemas.api import CreatePlayback, NativePlaybackView, RefreshPlayback

router = APIRouter(prefix="/api/miniprogram")


@router.post("/songs/{song_id}/playbacks", response_model=NativePlaybackView)
async def create_playback(song_id: int, body: CreatePlayback, request: Request):
    return await request.app.state.service.create_playback(
        song_id, str(body.client_request_id), "direct"
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
