import json
from pathlib import Path
from typing import Literal

from dotenv import dotenv_values
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]


def default_keywords() -> list[str]:
    """The checked-in example is the only default keyword source."""
    raw = dotenv_values(ROOT / ".env.example", encoding="utf-8-sig", interpolate=False).get(
        "MUSIC_KEYWORDS"
    )
    if raw is None:
        raise ValueError(".env.example 缺少 MUSIC_KEYWORDS 默认关键词")
    try:
        keywords = json.loads(raw)
    except ValueError as exc:
        raise ValueError(".env.example 中 MUSIC_KEYWORDS 必须是 JSON 字符串数组") from exc
    if not isinstance(keywords, list) or any(
        not isinstance(keyword, str) or not keyword.strip() for keyword in keywords
    ):
        raise ValueError(".env.example 中 MUSIC_KEYWORDS 必须是 JSON 字符串数组")
    return keywords


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MUSIC_", env_file=".env", env_file_encoding="utf-8-sig", extra="ignore"
    )

    database_url: str = f"sqlite+aiosqlite:///{(ROOT / 'data/music.db').as_posix()}"
    frontend_dist: Path = ROOT / "frontend/dist"
    request_concurrency: int = Field(default=16, ge=1, le=128)
    request_rate_per_minute: int = Field(default=120, ge=1, le=10000)
    action_rate_per_minute: int = Field(default=20, ge=1, le=1000)
    search_task_limit: int = Field(default=4, ge=1, le=32)
    provider_queue_size: int = Field(default=6, ge=0, le=100)
    verification_queue_size: int = Field(default=100, ge=1, le=2000)
    stream_concurrency: int = Field(default=6, ge=1, le=100)
    stream_per_ip: int = Field(default=3, ge=1, le=100)
    stream_per_session: int = Field(default=2, ge=1, le=10)
    stream_max_seconds: int = Field(default=900, ge=1, le=7200)

    catalog_ttl: int = 21600
    search_ttl: int = 600
    failure_cooldown: int = 60
    playback_ttl: int = 7200
    catalog_target: int = 500
    provider_concurrency: int = Field(default=3, ge=1, le=10)
    network_timeout: float = Field(default=12, gt=0)
    fallback_sources: list[Literal["netease", "kuwo"]] = ["netease", "kuwo"]
    full_audio_verify_timeout: float = Field(default=30, gt=0)
    full_audio_verify_concurrency: int = Field(default=2, ge=1, le=2)
    full_audio_recheck_interval: int = Field(default=21600, ge=1)
    keywords: list[str] = Field(default_factory=default_keywords)
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
