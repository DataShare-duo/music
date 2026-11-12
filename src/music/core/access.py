"""One-password access for the web UI, APIs and native browser audio requests."""

import asyncio
import base64
import binascii
import re
import secrets
import time
from collections import Counter

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse

from music.core.errors import AppError
from music.core.limits import Capacity, Lease

STREAM_PATH = re.compile(r"^/api/playbacks/([^/]+)/stream$")
ACTION_PATH = re.compile(r"^/api/(songs/[^/]+/playbacks|playbacks/[^/]+/refresh)$")
MAX_BODY = 16384


class RateLimits:
    """Fixed windows with a hard bound on the number of tracked IP/category pairs."""

    def __init__(self, max_keys=4096):
        self.entries = {}
        self.max_keys = max_keys
        self.last_sweep = 0

    def admit(self, key, limit):
        now = time.monotonic()
        if now - self.last_sweep >= 60:
            self.entries = {key: value for key, value in self.entries.items() if value[0] > now}
            self.last_sweep = now
        end, count = self.entries.get(key, (now + 60, 0))
        if end <= now:
            end, count = now + 60, 0
        if count >= limit or (key not in self.entries and len(self.entries) >= self.max_keys):
            raise AppError("rate_limited", "请求过于频繁，请稍后重试", 429)
        self.entries[key] = (end, count + 1)


class StreamLimits:
    def __init__(self, settings):
        self.settings = settings
        self.capacity = Capacity(settings.stream_concurrency)
        self.ips, self.sessions = Counter(), Counter()

    def acquire(self, ip, session):
        if (
            self.ips[ip] >= self.settings.stream_per_ip
            or self.sessions[session] >= self.settings.stream_per_session
        ):
            raise AppError("stream_limit", "播放连接过多，请关闭其他播放页面后重试", 429)
        lease = self.capacity.acquire()
        self.ips[ip] += 1
        self.sessions[session] += 1

        def release():
            lease.release()
            for counts, key in ((self.ips, ip), (self.sessions, session)):
                counts[key] -= 1
                if not counts[key]:
                    del counts[key]

        return Lease(release)


class AccessMiddleware:
    def __init__(self, app, settings):
        self.app, self.settings = app, settings
        self.requests = Capacity(settings.request_concurrency)
        self.streams = StreamLimits(settings)
        self.rates = RateLimits()

    def authorized(self, headers):
        authorization = headers.get("authorization", "")
        try:
            scheme, value = authorization.split(" ", 1)
            if scheme.lower() != "basic" or len(value) > 4096:
                return False
            decoded = base64.b64decode(value, validate=True)
            username, password = decoded.split(b":", 1)
            return secrets.compare_digest(
                username, self.settings.access_username.encode()
            ) & secrets.compare_digest(
                password, self.settings.access_password.get_secret_value().encode()
            )
        except (ValueError, binascii.Error, UnicodeError):
            return False

    async def respond(self, scope, receive, send, code, message, status, headers=None):
        await JSONResponse(
            {"error": {"code": code, "message": message, "playback_id": None, "hidden": False}},
            status_code=status,
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                **(headers or {}),
            },
        )(scope, receive, send)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path, method = scope["path"], scope["method"]
        headers = Headers(scope=scope)
        # Never accept an IP supplied by an arbitrary X-Forwarded-For header here
        ip = (scope.get("client") or ("unknown", 0))[0]
        public_health = path == "/api/health" and method in ("GET", "HEAD")
        try:
            self.rates.admit((ip, "request"), self.settings.request_rate_per_minute)
            if not public_health:
                if not self.settings.access_password.get_secret_value():
                    return await self.respond(
                        scope,
                        receive,
                        send,
                        "access_not_configured",
                        "请先配置 MUSIC_ACCESS_PASSWORD 访问密码",
                        503,
                        {"Retry-After": "60"},
                    )
                if not self.authorized(headers):
                    self.rates.admit((ip, "authentication"), 10)
                    return await self.respond(
                        scope,
                        receive,
                        send,
                        "authentication_required",
                        "请输入正确的访问账号和密码",
                        401,
                        {"WWW-Authenticate": 'Basic realm="Listen Music", charset="UTF-8"'},
                    )
                if headers.get("sec-fetch-site") == "cross-site":
                    raise AppError("cross_site_request", "不接受跨站请求", 403)
                if method == "POST" and ACTION_PATH.fullmatch(path):
                    self.rates.admit((ip, "action"), self.settings.action_rate_per_minute)
            stream = STREAM_PATH.fullmatch(path) if method in ("GET", "HEAD") else None
            lease = self.streams.acquire(ip, stream[1]) if stream else self.requests.acquire()
        except AppError as exc:
            return await self.respond(
                scope,
                receive,
                send,
                exc.code,
                exc.message,
                exc.status,
                {"Retry-After": "60"}
                if exc.status == 429
                else {"Retry-After": "5"}
                if exc.status == 503
                else None,
            )

        started = False

        async def protected_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                response_headers = MutableHeaders(scope=message)
                response_headers["Cache-Control"] = "private, no-store"
                response_headers["X-Content-Type-Options"] = "nosniff"
                response_headers["Referrer-Policy"] = "no-referrer"
            await send(message)

        try:
            if method in ("POST", "PUT", "PATCH"):
                try:
                    length = int(headers.get("content-length", "0"))
                    if length < 0:
                        raise ValueError
                except ValueError:
                    return await self.respond(
                        scope, receive, send, "invalid_body", "请求长度无效", 400
                    )
                if length > MAX_BODY:
                    return await self.respond(
                        scope, receive, send, "body_too_large", "请求内容过大", 413
                    )
                body = bytearray()
                try:
                    async with asyncio.timeout(10):
                        while True:
                            message = await receive()
                            if message["type"] == "http.disconnect":
                                return
                            chunk = message.get("body", b"")
                            if len(body) + len(chunk) > MAX_BODY:
                                return await self.respond(
                                    scope, receive, send, "body_too_large", "请求内容过大", 413
                                )
                            body.extend(chunk)
                            if not message.get("more_body", False):
                                break
                except TimeoutError:
                    return await self.respond(
                        scope, receive, send, "body_timeout", "请求内容接收超时", 408
                    )
                original_receive, delivered = receive, False

                async def replay():
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": bytes(body), "more_body": False}
                    return await original_receive()

                receive = replay
            if stream:
                try:
                    async with asyncio.timeout(self.settings.stream_max_seconds):
                        await self.app(scope, receive, protected_send)
                except TimeoutError:
                    if started:
                        # Do not append JSON to a partially sent audio response;
                        # let the ASGI server close the incomplete connection
                        raise
                    await self.respond(
                        scope, receive, send, "stream_timeout", "播放连接超过时限，请重新播放", 504
                    )
            else:
                await self.app(scope, receive, protected_send)
        finally:
            lease.release()
