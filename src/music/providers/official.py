"""Metadata-only adapters for the pinned musicdl commit

Never invoke musicdl.search(), download(), or any third-party parser
Only request-protocol helpers and the official Soda share-page parser are reused
"""

from __future__ import annotations

import importlib
import re
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from html import unescape
from types import SimpleNamespace
from typing import Literal
from urllib.parse import urlsplit

import requests

from music.core.errors import AppError
from music.core.limits import BoundedExecutor

SOURCE_NAMES = {"soda": "汽水音乐", "netease": "网易云音乐", "kuwo": "酷我音乐"}
UPSTREAM_COMMIT = "dca2f0967e46a8faf8d279737535471102d74ca3"


@dataclass
class Track:
    source: str
    source_track_id: str
    title: str
    artist: str = "未知歌手"
    album: str = ""
    cover_url: str = ""
    duration: float = 0


@dataclass
class ResolvedAudio:
    url: str
    headers: dict[str, str]
    audio_kind: Literal["preview", "full", "unknown"] = "unknown"
    expires_at: datetime | None = None
    https_only: bool = False


def cover(value) -> str:
    if isinstance(value, str):
        if not value.startswith(("https://", "http://")):
            return ""
        host = urlsplit(value).hostname or ""
        if host.endswith(".douyinpic.com") and "~" not in value and not urlsplit(value).query:
            return value + "~c5_500x500.jpg"
        return value
    if isinstance(value, dict):
        urls = value.get("urls") or []
        if urls:
            base = urls[0]
            uri = value.get("uri") or ""
            return cover(base + uri if not base.rstrip("/").endswith(uri) else base)
    return ""


def artists(values) -> str:
    return (
        ", ".join(str(a.get("name", "")) for a in (values or []) if isinstance(a, dict))
        or "未知歌手"
    )


class OfficialProvider:
    def __init__(self, source: str, timeout: float):
        self.source, self.timeout = source, timeout

    def _client_class(self):
        module = importlib.import_module(f"musicdl.modules.sources.{self.source}")
        return getattr(
            module,
            {"soda": "SodaMusicClient", "netease": "NeteaseMusicClient", "kuwo": "KuwoMusicClient"}[
                self.source
            ],
        )

    def _session(self):
        session = requests.Session()
        session.headers.update(
            {
                "User-Agent": "Mozilla/5.0",
                "Referer": {
                    "soda": "https://music.douyin.com/",
                    "netease": "https://music.163.com/",
                    "kuwo": "https://www.kuwo.cn/",
                }[self.source],
            }
        )
        return session

    def search_metadata(self, query: str, page: int, page_size: int) -> list[Track]:
        cls = self._client_class()
        ctx = SimpleNamespace(
            search_size_per_source=page * page_size, search_size_per_page=page_size
        )
        spec = cls._constructsearchurls(ctx, query)[page - 1]
        with self._session() as session:
            if self.source == "netease":
                response = session.post(spec["url"], data=spec["data"], timeout=self.timeout)
            else:
                response = session.get(spec.replace("http://", "https://", 1), timeout=self.timeout)
            response.raise_for_status()
            data = response.json()
        if self.source == "soda":
            if "result_groups" not in data:
                raise AppError("upstream_changed", "汽水搜索接口受限或返回结构发生变化")
            groups = data["result_groups"] or []
            rows = groups[0].get("data", []) if groups else []
            tracks = []
            for row in rows:
                track = (row.get("entity") or {}).get("track") or (
                    (row.get("entity") or {}).get("track_wrapper") or {}
                ).get("track")
                if not track or not track.get("id") or not track.get("name"):
                    continue
                album = track.get("album") or {}
                tracks.append(
                    Track(
                        "soda",
                        str(track["id"]),
                        track["name"],
                        artists(track.get("artists")),
                        album.get("name", ""),
                        cover(album.get("url_cover")),
                        float(track.get("duration") or 0) / 1000,
                    )
                )
            return tracks
        if self.source == "netease":
            if data.get("code") != 200:
                raise AppError("access_denied", "网易云搜索接口当前不可用或需要授权")
            return [
                Track(
                    "netease",
                    str(t["id"]),
                    t["name"],
                    artists(t.get("ar") or t.get("artists")),
                    (t.get("al") or t.get("album") or {}).get("name", ""),
                    cover((t.get("al") or t.get("album") or {}).get("picUrl")),
                    float(t.get("dt") or t.get("duration") or 0) / 1000,
                )
                for t in data.get("result", {}).get("songs", [])
            ]
        if "abslist" not in data:
            raise AppError("upstream_changed", "酷我搜索接口受限或返回结构发生变化")
        return [
            Track(
                "kuwo",
                str(t.get("MUSICRID") or t.get("musicrid") or "").removeprefix("MUSIC_"),
                unescape(t.get("SONGNAME") or t.get("name") or ""),
                unescape(t.get("ARTIST") or "未知歌手"),
                unescape(t.get("ALBUM") or ""),
                cover(t.get("hts_MVPIC") or t.get("albumpic")),
                float(t.get("DURATION") or 0),
            )
            for t in data["abslist"]
            if t.get("MUSICRID") or t.get("musicrid")
        ]

    def resolve_audio(self, track_id: str) -> ResolvedAudio:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", track_id):
            raise AppError("invalid_track_id", "平台歌曲 ID 无效", 400)
        with self._session() as session:
            if self.source == "soda":
                # Calling this isolated parser never enters the third-party/full-track paths
                ctx = SimpleNamespace(get=partial(session.get, timeout=self.timeout))
                metadata = self._client_class()._getsongmetainfo(ctx, track_id)
                url = metadata.get("audition_url")
                kind = "preview"
            elif self.source == "netease":
                from musicdl.modules.sources.netease import EapiCryptoUtils

                endpoint = "https://interface3.music.163.com/eapi/song/enhance/player/url/v1"
                payload = {
                    "ids": [int(track_id)],
                    "level": "standard",
                    "encodeType": "mp3",
                    "header": '{"os":"pc"}',
                }
                encrypted = EapiCryptoUtils.encryptparams(url=endpoint, payload=payload)
                response = session.post(endpoint, data={"params": encrypted}, timeout=self.timeout)
                response.raise_for_status()
                rows = response.json().get("data") or []
                row = rows[0] if rows else {}
                url = row.get("url")
                kind = "preview" if row.get("freeTrialInfo") else "unknown"
            else:
                from musicdl.modules.sources.kuwo import KuwoMusicClientUtils

                query = f"user=0&corp=kuwo&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&type=convert_url2&sig=0&format=mp3&rid={track_id}"
                response = session.get(
                    "https://mobi.kuwo.cn/mobi.s",
                    params={"f": "kuwo", "q": KuwoMusicClientUtils.encryptquery(query)},
                    timeout=self.timeout,
                )
                response.raise_for_status()
                match = re.search(r'https?[^\s$"<>]+', response.text)
                url = match.group(0) if match else None
                kind = "unknown"
            if not url:
                raise AppError("not_playable", "平台未提供公开可播放音频，可能需要授权或暂不支持")
            return ResolvedAudio(
                url, {"User-Agent": "Mozilla/5.0", "Referer": session.headers["Referer"]}, kind
            )


class ProviderManager:
    def __init__(self, concurrency: int = 3, timeout: float = 12, queue_size: int = 6):
        self.providers = {key: OfficialProvider(key, timeout) for key in SOURCE_NAMES}
        self.executor = BoundedExecutor(concurrency, queue_size, "music-platform")

    async def _call(self, source: str, method: str, *args):
        if source not in self.providers:
            raise AppError("invalid_source", "不支持的音乐来源", 400)
        try:
            return await self.executor.call(getattr(self.providers[source], method), *args)
        except AppError:
            raise
        except requests.Timeout as exc:
            raise AppError("upstream_timeout", "音乐平台响应超时，请稍后重试", 504) from exc
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 502
            code = (
                "access_denied"
                if status in (401, 403)
                else "upstream_rate_limited"
                if status == 429
                else "upstream_error"
            )
            raise AppError(code, f"音乐平台请求失败，状态码 {status}") from exc
        except (
            requests.RequestException,
            ValueError,
            KeyError,
            IndexError,
            AttributeError,
            AssertionError,
        ) as exc:
            raise AppError("upstream_changed", "音乐平台网络不可用或接口结构发生变化") from exc

    async def search(self, source: str, query: str, page: int, page_size: int):
        return await self._call(source, "search_metadata", query, page, page_size)

    async def resolve(self, source: str, track_id: str):
        return await self._call(source, "resolve_audio", track_id)

    def close(self):
        self.executor.close()
