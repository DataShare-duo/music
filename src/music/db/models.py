from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def now() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator):
    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return value.astimezone(UTC).replace(tzinfo=None) if value else value

    def process_result_value(self, value, dialect):
        return value.replace(tzinfo=UTC) if value else value


class Base(DeclarativeBase):
    pass


class Song(Base):
    __tablename__ = "songs"
    __table_args__ = (UniqueConstraint("source", "source_track_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(20), index=True)
    source_track_id: Mapped[str] = mapped_column(String(100))
    title: Mapped[str] = mapped_column(String(500))
    artist: Mapped[str] = mapped_column(String(500), default="未知歌手")
    album: Mapped[str] = mapped_column(String(500), default="")
    cover_url: Mapped[str] = mapped_column(Text, default="")
    duration: Mapped[float] = mapped_column(Float, default=0)
    recommended: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    verification_state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    next_check_at: Mapped[datetime | None] = mapped_column(UTCDateTime, index=True)
    verification_error: Mapped[str | None] = mapped_column(Text)
    verified_track: Mapped[dict | None] = mapped_column(JSON)
    audio_duration: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)


class SongStats(Base):
    __tablename__ = "song_stats"
    song_id: Mapped[int] = mapped_column(
        ForeignKey("songs.id", ondelete="CASCADE"), primary_key=True
    )
    click_count: Mapped[int] = mapped_column(Integer, default=0)
    listen_count: Mapped[int] = mapped_column(Integer, default=0)
    first_clicked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    last_clicked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    first_listened_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    last_listened_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class AudioLink(Base):
    __tablename__ = "audio_links"
    song_id: Mapped[int] = mapped_column(
        ForeignKey("songs.id", ondelete="CASCADE"), primary_key=True
    )
    url: Mapped[str] = mapped_column(Text)
    headers: Mapped[dict] = mapped_column(JSON, default=dict)
    resolved_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    version: Mapped[int] = mapped_column(Integer, default=1)
    audio_kind: Mapped[str] = mapped_column(String(20), default="unknown")
    play_source: Mapped[str | None] = mapped_column(String(20))
    play_track: Mapped[dict | None] = mapped_column(JSON)
    audio_duration: Mapped[float | None] = mapped_column(Float)
    last_error: Mapped[str | None] = mapped_column(Text)


class Playback(Base):
    __tablename__ = "playback_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    song_id: Mapped[int] = mapped_column(ForeignKey("songs.id", ondelete="CASCADE"), index=True)
    client_request_id: Mapped[str] = mapped_column(String(36), unique=True)
    transport: Mapped[str] = mapped_column(String(20), default="proxy", server_default="proxy")
    state: Mapped[str] = mapped_column(String(20), default="resolving")
    counted: Mapped[bool] = mapped_column(Boolean, default=False)
    click_pending: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    refresh_count: Mapped[int] = mapped_column(Integer, default=0)
    link_version: Mapped[int] = mapped_column(Integer, default=0)
    audio_kind: Mapped[str] = mapped_column(String(20), default="unknown")
    play_source: Mapped[str | None] = mapped_column(String(20))
    play_track: Mapped[dict | None] = mapped_column(JSON)
    audio_duration: Mapped[float | None] = mapped_column(Float)
    audio_url: Mapped[str | None] = mapped_column(Text)
    audio_headers: Mapped[dict | None] = mapped_column(JSON)
    audio_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    error_code: Mapped[str | None] = mapped_column(String(60))
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)


class ProviderCache(Base):
    __tablename__ = "provider_cache"
    key: Mapped[str] = mapped_column(String(300), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
