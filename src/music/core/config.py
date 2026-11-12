from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MUSIC_", env_file=".env", env_file_encoding="utf-8-sig", extra="ignore"
    )

    database_url: str = f"sqlite+aiosqlite:///{(ROOT / 'data/music.db').as_posix()}"
    frontend_dist: Path = ROOT / "frontend/dist"
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
    keywords: list[str] = [
        "热门歌曲",
        "流行",
        "抖音热歌",
        "华语流行",
        "新歌",
        "经典华语",
        "独立音乐",
        "民谣",
        "治愈",
        "轻音乐",
        "说唱",
        "粤语",
    ]
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
