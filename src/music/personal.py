from __future__ import annotations

import base64
import binascii
import hashlib
from datetime import UTC, datetime

from sqlalchemy import delete, func, select

from music.core.errors import AppError
from music.core.locks import Locks
from music.db.models import User, UserHistory, UserHistoryState, UserMark, UserOperation, now

MAX_AVATAR = 2 * 1024 * 1024
MARK_LIMIT = 200
SEARCH_LIMIT = 20
RECENT_LIMIT = 100


def user_key(app_id: str, openid: str) -> str:
    return hashlib.sha256(f"{app_id}:{openid}".encode()).hexdigest()


def _text(value, name, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise AppError("invalid_input", f"{name} 无效", 400)
    return value.strip()


def _song(value):
    if not isinstance(value, dict):
        raise AppError("invalid_song", "歌曲信息无效", 400)
    source = _text(value.get("source"), "歌曲来源", 20)
    if source not in {"soda", "netease", "kuwo"}:
        raise AppError("invalid_song", "歌曲来源无效", 400)
    track_id = _text(value.get("source_track_id"), "平台歌曲 ID", 100)
    if any(ch in track_id for ch in ("/", "\\", "\\x00")):
        raise AppError("invalid_song", "平台歌曲 ID 无效", 400)
    return {
        "source": source,
        "source_track_id": track_id,
        "title": _text(value.get("title"), "歌名", 500),
        "artist": _text(value.get("artist"), "歌手", 500),
        "album": str(value.get("album") or "")[:500],
        "cover_url": str(value.get("cover_url") or "")[:2048],
        "duration": max(0, min(86400, float(value.get("duration") or 0))),
    }


def _song_key(song):
    return f"{song['source']}:{song['source_track_id']}"


def _mime_and_bytes(encoded: str, mime: str):
    if not isinstance(encoded, str) or len(encoded) > 4 * 1024 * 1024:
        raise AppError("invalid_avatar", "头像内容过大", 413)
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise AppError("invalid_avatar", "头像内容无效", 400) from exc
    if len(content) > MAX_AVATAR:
        raise AppError("invalid_avatar", "头像不能超过 2 MiB", 413)
    jpeg = content[:3] == b"\xff\xd8\xff"
    png = content[:8] == b"\x89PNG\r\n\x1a\n"
    webp = content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    detected = "image/jpeg" if jpeg else "image/png" if png else "image/webp" if webp else ""
    if not detected or mime != detected:
        raise AppError("invalid_avatar", "头像必须是 JPEG、PNG 或 WebP", 400)
    return detected, content


class PersonalService:
    def __init__(self, db):
        self.db = db
        self.locks = Locks()

    async def _user(self, db, key, app_id, create=False):
        user = await db.get(User, key)
        if not user and create:
            user = User(user_key=key, app_id=app_id)
            db.add(user)
            await db.flush()
            for kind in ("search", "recent"):
                db.add(UserHistoryState(user_key=key, kind=kind, epoch=0))
        return user

    async def _history_state(self, db, key, kind):
        state = await db.scalar(
            select(UserHistoryState).where(
                UserHistoryState.user_key == key, UserHistoryState.kind == kind
            )
        )
        if not state:
            state = UserHistoryState(user_key=key, kind=kind, epoch=0)
            db.add(state)
            await db.flush()
        return state

    async def _view(self, db, key, active=True):
        marks = list(
            await db.scalars(
                select(UserMark)
                .where(UserMark.user_key == key)
                .order_by(UserMark.updated_at.desc())
            )
        )
        user = await db.get(User, key)
        histories = {}
        for kind, limit in (("search", SEARCH_LIMIT), ("recent", RECENT_LIMIT)):
            rows = list(
                await db.scalars(
                    select(UserHistory)
                    .where(UserHistory.user_key == key, UserHistory.kind == kind)
                    .order_by(UserHistory.happened_at.desc())
                    .limit(limit)
                )
            )
            state = await self._history_state(db, key, kind)
            items = []
            for row in rows:
                item = {"key": row.history_key, "at": row.happened_at.timestamp() * 1000}
                if kind == "search":
                    item["query"] = row.query
                else:
                    item["song"] = {
                        "source": row.source,
                        "source_track_id": row.source_track_id,
                        "title": row.title,
                        "artist": row.artist,
                        "album": row.album or "",
                        "cover_url": row.cover_url or "",
                        "duration": row.duration or 0,
                    }
                    item["sourceName"] = row.source_name or ""
                items.append(item)
            histories[kind] = {"epoch": state.epoch, "items": items}
        favorite, like = [], []
        for row in marks:
            item = {
                "key": _song_key({"source": row.source, "source_track_id": row.source_track_id}),
                "at": row.updated_at.timestamp() * 1000,
                "song": {
                    "source": row.source,
                    "source_track_id": row.source_track_id,
                    "title": row.title,
                    "artist": row.artist,
                    "album": row.album,
                    "cover_url": row.cover_url,
                    "duration": row.duration,
                },
            }
            (favorite if row.kind == "favorite" else like).append(item)
        return {
            "revision": user.revision if user else 0,
            "active": bool(active and user),
            "userKey": key,
            "avatar": "",
            "favorite": favorite,
            "like": like,
            "search": histories.get("search"),
            "recent": histories.get("recent"),
        }

    async def handle(self, action, data, key, app_id):
        action = _text(action, "操作", 40)
        data = data if isinstance(data, dict) else {}
        async with self.locks.get(key):
            async with self.db.sessions() as db:
                user = await self._user(db, key, app_id, create=action == "profile.enable")
                if action == "profile.get" and not user:
                    return await self._view(db, key, active=False)
                if not user:
                    raise AppError("profile_required", "请先启用个人空间", 409)
                if action == "profile.enable":
                    user.updated_at = now()
                elif action == "mark.set":
                    await self._mark(db, user, data)
                elif action == "history.sync":
                    result = await self._history(db, user, data)
                    await db.commit()
                    view = await self._view(db, key)
                    view.update(result)
                    return view
                elif action == "avatar.set":
                    await self._avatar(db, user, data)
                elif action == "avatar.get":
                    view = await self._view(db, key)
                    if user.avatar_blob:
                        import base64 as b64

                        view["avatar"] = (
                            "data:"
                            + (user.avatar_mime or "image/jpeg")
                            + ";base64,"
                            + b64.b64encode(user.avatar_blob).decode()
                        )
                    await db.commit()
                    return view
                elif action != "profile.get":
                    raise AppError("invalid_action", "不支持的个人操作", 400)
                user.revision += 1 if action != "profile.get" else 0
                user.updated_at = now()
                await db.commit()
                return await self._view(db, key)

    async def _mark(self, db, user, data):
        kind = data.get("kind")
        if kind not in {"favorite", "like"} or not isinstance(data.get("value"), bool):
            raise AppError("invalid_input", "标记操作无效", 400)
        operation_id = _text(data.get("opId"), "操作 ID", 100)
        if await db.scalar(
            select(UserOperation.id).where(
                UserOperation.user_key == user.user_key, UserOperation.operation_id == operation_id
            )
        ):
            return
        song = _song(data.get("song"))
        existing = await db.scalar(
            select(UserMark).where(
                UserMark.user_key == user.user_key,
                UserMark.kind == kind,
                UserMark.source == song["source"],
                UserMark.source_track_id == song["source_track_id"],
            )
        )
        if existing:
            await db.delete(existing)
        if data["value"]:
            count = await db.scalar(
                select(func.count())
                .select_from(UserMark)
                .where(UserMark.user_key == user.user_key, UserMark.kind == kind)
            )
            if count >= MARK_LIMIT:
                raise AppError("collection_limit", "每个列表最多保存 200 首歌曲", 409)
            db.add(UserMark(user_key=user.user_key, kind=kind, **song))
        db.add(UserOperation(user_key=user.user_key, operation_id=operation_id, kind=kind))

    async def _history(self, db, user, data):
        kind = data.get("kind")
        if (
            kind not in {"search", "recent"}
            or not isinstance(data.get("ops"), list)
            or len(data["ops"]) > 120
        ):
            raise AppError("invalid_input", "历史同步参数无效", 400)
        state = await self._history_state(db, user.user_key, kind)
        if data.get("epoch") != state.epoch:
            return {"conflict": True}
        for op in data["ops"]:
            operation_id = _text(op.get("id"), "操作 ID", 100)
            if await db.scalar(
                select(UserOperation.id).where(
                    UserOperation.user_key == user.user_key,
                    UserOperation.operation_id == operation_id,
                )
            ):
                continue
            typ = op.get("type")
            if typ == "clear":
                await db.execute(
                    delete(UserHistory).where(
                        UserHistory.user_key == user.user_key, UserHistory.kind == kind
                    )
                )
                state.epoch += 1
            elif typ == "remove":
                history_key = _text(op.get("key"), "历史键", 220)
                await db.execute(
                    delete(UserHistory).where(
                        UserHistory.user_key == user.user_key,
                        UserHistory.kind == kind,
                        UserHistory.history_key == history_key,
                    )
                )
            elif typ == "put":
                at = datetime.fromtimestamp(max(0, float(op.get("at", 0))) / 1000, UTC)
                if kind == "search":
                    query = _text(op.get("query"), "搜索词", 100)
                    history_key = query
                    values = dict(
                        user_key=user.user_key,
                        kind=kind,
                        history_key=history_key,
                        query=query,
                        happened_at=at,
                    )
                else:
                    song = _song(op.get("song"))
                    history_key = _song_key(song)
                    values = dict(
                        user_key=user.user_key,
                        kind=kind,
                        history_key=history_key,
                        **song,
                        source_name=str(op.get("sourceName") or "")[:80],
                        happened_at=at,
                    )
                old = await db.scalar(
                    select(UserHistory).where(
                        UserHistory.user_key == user.user_key,
                        UserHistory.kind == kind,
                        UserHistory.history_key == history_key,
                    )
                )
                if old:
                    if old.happened_at <= at:
                        for name, value in values.items():
                            setattr(old, name, value)
                else:
                    db.add(UserHistory(**values))
            else:
                raise AppError("invalid_input", "历史操作无效", 400)
            db.add(UserOperation(user_key=user.user_key, operation_id=operation_id, kind=kind))
        limit = SEARCH_LIMIT if kind == "search" else RECENT_LIMIT
        rows = list(
            await db.scalars(
                select(UserHistory)
                .where(UserHistory.user_key == user.user_key, UserHistory.kind == kind)
                .order_by(UserHistory.happened_at.desc())
            )
        )
        for row in rows[limit:]:
            await db.delete(row)
        return {"conflict": False}

    async def _avatar(self, db, user, data):
        mime, content = _mime_and_bytes(data.get("base64"), data.get("mime"))
        user.avatar_blob = content
        user.avatar_mime = mime
        user.avatar_sha256 = hashlib.sha256(content).hexdigest()
        user.avatar_updated_at = now()
