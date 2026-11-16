from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.mysql import MEDIUMBLOB
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


class AvatarBlob(TypeDecorator):
    impl = LargeBinary
    cache_ok = True

    def load_dialect_impl(self, dialect):
        return dialect.type_descriptor(MEDIUMBLOB() if dialect.name == "mysql" else LargeBinary())


class Base(DeclarativeBase):
    @classmethod
    def __init_subclass__(cls, **kwargs):
        args = cls.__dict__.get("__table_args__", ())
        options = {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_bin",
        }
        if isinstance(args, tuple):
            cls.__table_args__ = (*args, options)
        else:
            cls.__table_args__ = {**options, **args}
        super().__init_subclass__(**kwargs)


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


class User(Base):
    __tablename__ = "users"
    user_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    app_id: Mapped[str] = mapped_column(String(64))
    avatar_blob: Mapped[bytes | None] = mapped_column(AvatarBlob())
    avatar_mime: Mapped[str | None] = mapped_column(String(40))
    avatar_sha256: Mapped[str | None] = mapped_column(String(64))
    avatar_updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)


class UserMark(Base):
    __tablename__ = "user_marks"
    __table_args__ = (UniqueConstraint("user_key", "kind", "source", "source_track_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_key: Mapped[str] = mapped_column(
        ForeignKey("users.user_key", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20), index=True)
    source: Mapped[str] = mapped_column(String(20))
    source_track_id: Mapped[str] = mapped_column(String(100))
    title: Mapped[str] = mapped_column(String(500))
    artist: Mapped[str] = mapped_column(String(500))
    album: Mapped[str] = mapped_column(String(500), default="")
    cover_url: Mapped[str] = mapped_column(Text, default="")
    duration: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)


class UserHistoryState(Base):
    __tablename__ = "user_history_state"
    __table_args__ = (UniqueConstraint("user_key", "kind"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_key: Mapped[str] = mapped_column(
        ForeignKey("users.user_key", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20))
    epoch: Mapped[int] = mapped_column(Integer, default=0)


class UserHistory(Base):
    __tablename__ = "user_history"
    __table_args__ = (UniqueConstraint("user_key", "kind", "history_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_key: Mapped[str] = mapped_column(
        ForeignKey("users.user_key", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20), index=True)
    history_key: Mapped[str] = mapped_column(String(220))
    query: Mapped[str | None] = mapped_column(String(100))
    source: Mapped[str | None] = mapped_column(String(20))
    source_track_id: Mapped[str | None] = mapped_column(String(100))
    title: Mapped[str | None] = mapped_column(String(500))
    artist: Mapped[str | None] = mapped_column(String(500))
    album: Mapped[str | None] = mapped_column(String(500))
    cover_url: Mapped[str | None] = mapped_column(Text)
    duration: Mapped[float | None] = mapped_column(Float)
    source_name: Mapped[str | None] = mapped_column(String(80))
    happened_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now, index=True)


class UserOperation(Base):
    __tablename__ = "user_operations"
    __table_args__ = (UniqueConstraint("user_key", "operation_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_key: Mapped[str] = mapped_column(
        ForeignKey("users.user_key", ondelete="CASCADE"), index=True
    )
    operation_id: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
