from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class SongView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    source: str
    source_track_id: str
    title: str
    artist: str
    album: str
    cover_url: str
    duration: float
    created_at: datetime
    updated_at: datetime
    click_count: int = 0
    listen_count: int = 0
    last_clicked_at: datetime | None = None
    last_listened_at: datetime | None = None
    audio_kind: Literal["preview", "full", "unknown"] = "unknown"
    play_source: str | None = None
    play_source_name: str | None = None


class SongList(BaseModel):
    items: list[SongView]
    count: int
    stale: bool = False
    refreshing: bool = False
    message: str | None = None
    page: int = 1
    has_more: bool = False
    updated_at: datetime | None = None
    verification_total: int = 0
    verification_pending: int = 0
    verification_available: int = 0
    verification_unavailable: int = 0
    verification_errors: int = 0


class CreatePlayback(BaseModel):
    client_request_id: UUID


class RefreshPlayback(BaseModel):
    expected_version: int = Field(ge=1)


class PlaybackView(BaseModel):
    id: str
    song_id: int
    state: str
    stream_url: str
    audio_kind: str
    link_version: int
    refresh_count: int
    expires_at: datetime
    play_source: str | None = None
    play_source_name: str | None = None
    audio_duration: float | None = None
    error: dict | None = None


class NativePlaybackView(BaseModel):
    id: str
    song_id: int
    transport: Literal["direct"] = "direct"
    state: str
    audio_url: str | None = None
    audio_kind: Literal["full"] = "full"
    link_version: int
    refresh_count: int
    expires_at: datetime
    play_source: str | None = None
    play_source_name: str | None = None
    play_source_track_id: str | None = None
    audio_duration: float | None = None
    error: dict | None = None


class RestoreSong(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: Literal["soda", "netease", "kuwo"]
    source_track_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    query_hint: str = Field(min_length=1, max_length=100)


class RestoreView(BaseModel):
    status: Literal["available", "pending", "unavailable"]
    song: SongView | None = None
    message: str = ""


class CreateNativePlayback(CreatePlayback):
    defer_click: bool = False
