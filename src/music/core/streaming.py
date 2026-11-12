"""Public-IP-pinned streaming transport, no arbitrary user URLs"""

import asyncio
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlsplit

import anyio
import httpx
from fastapi.responses import StreamingResponse

from music.core.errors import AppError
from music.db.models import now


async def public_target(url: str) -> tuple[httpx.URL, str, str]:
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("Invalid URL")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if port not in (80, 443):
            raise ValueError("Nonstandard port")
        host = parsed.hostname.encode("idna").decode()
        addresses = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM), timeout=5
        )
        ips = {entry[4][0] for entry in addresses}
        if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
            raise ValueError("Nonpublic address")
        ip = sorted(ips, key=lambda item: (":" in item, item))[0]
        pinned = httpx.URL(url).copy_with(host=ip)
        authority = f"[{host}]" if ":" in host else host
        if (parsed.scheme, port) not in (("http", 80), ("https", 443)):
            authority += f":{port}"
        return pinned, host, authority
    except (ValueError, OSError, UnicodeError, TimeoutError) as exc:
        raise AppError("unsafe_audio_url", "音频地址不是有效的公网 HTTP 地址，已拒绝代理") from exc


class UpstreamStream:
    def __init__(self, client, response):
        self.client, self.response = client, response
        self.iterator = response.aiter_raw()

    async def close(self):
        # Finalizers must run even when Starlette cancels on disconnect
        with anyio.CancelScope(shield=True):
            await self.response.aclose()
            await self.client.aclose()


class AudioStreamingResponse(StreamingResponse):
    """Also close upstream when the client disappears before the first body chunk"""

    def __init__(self, *args, upstream, **kwargs):
        super().__init__(*args, **kwargs)
        self.upstream = upstream

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.upstream.close()


class AudioProxy:
    def __init__(self, timeout=12):
        self.timeout = timeout

    async def open(self, url, headers, range_header=None):
        safe_headers = {
            k: v for k, v in headers.items() if k.lower() in ("user-agent", "referer", "origin")
        }
        safe_headers["Accept-Encoding"] = "identity"
        if range_header:
            if not re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", range_header):
                raise AppError("invalid_range", "只支持单段字节范围请求", 416)
            safe_headers["Range"] = range_header
        for _ in range(6):
            pinned, host, authority = await public_target(url)
            # New pool per upstream request also avoids sharing TLS/SNI across hostnames on one IP
            client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout), trust_env=False, follow_redirects=False
            )
            try:
                request = client.build_request(
                    "GET",
                    pinned,
                    headers={**safe_headers, "Host": authority},
                    extensions={"sni_hostname": host},
                )
                response = await client.send(request, stream=True)
            except BaseException:
                await client.aclose()
                raise
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                await response.aclose()
                await client.aclose()
                if not location:
                    raise AppError("invalid_redirect", "音频服务器返回无效跳转")
                url = urljoin(url, location)
                continue
            return UpstreamStream(client, response)
        raise AppError("too_many_redirects", "音频地址跳转次数过多")


def audio_content(headers, first: bytes, range_header) -> bool:
    mime = headers.get("content-type", "").split(";")[0].lower()
    if mime.startswith(("text/", "application/json", "application/xml")):
        return False
    if first.lstrip().startswith((b"<", b"{", b"[")):
        return False
    if mime.startswith("audio/") or mime == "video/mp4":
        return True
    # Opaque content is accepted only with a known audio signature at offset zero
    if range_header and not range_header.startswith("bytes=0-"):
        return mime in ("application/octet-stream", "binary/octet-stream")
    return (
        first.startswith(
            (
                b"ID3",
                b"OggS",
                b"fLaC",
                b"RIFF",
                b"\xff\xfb",
                b"\xff\xf3",
                b"\xff\xf2",
                b"\xff\xf1",
                b"\xff\xf9",
            )
        )
        or first[4:8] == b"ftyp"
    )


async def stream_audio(service, proxy, playback_id, range_header):
    # One initial attempt, one shared-budget refresh, then stop
    for attempt in range(2):
        pb, link = await service.stream_link(playback_id)
        upstream = None
        try:
            if link.expires_at and link.expires_at <= now():
                raise AppError("audio_link_expired", "音乐链接已过期")
            upstream = await proxy.open(link.url, link.headers, range_header)
            response = upstream.response
            if response.status_code == 416:
                raise AppError(
                    "range_not_satisfiable", "当前音频不支持此进度位置，请从头播放", 416, pb.id
                )
            if response.status_code not in (200, 206):
                code = (
                    "audio_link_expired"
                    if response.status_code in (401, 403, 404, 410)
                    else "upstream_stream_error"
                )
                raise AppError(code, f"音频服务器返回 {response.status_code}", 502, pb.id)
            if response.headers.get("content-encoding", "identity") != "identity":
                raise AppError("unsupported_encoding", "上游音频传输编码暂不支持", 502, pb.id)
            first = await anext(upstream.iterator, b"")
            if not first or not audio_content(response.headers, first, range_header):
                raise AppError("invalid_audio", "平台返回的内容不是可播放音频", 502, pb.id)
            await service.streaming(pb.id)
        except (AppError, httpx.HTTPError) as error:
            if upstream:
                await upstream.close()
            exc = (
                error
                if isinstance(error, AppError)
                else AppError("stream_network_error", "音频连接失败或读取超时", 502, pb.id)
            )
            retryable = exc.code in ("audio_link_expired", "invalid_audio", "stream_network_error")
            if retryable and attempt == 0:
                try:
                    await service.refresh(pb.id, link.version)
                except AppError as refresh_error:
                    if refresh_error.code == "refresh_exhausted":
                        # Unlike a redundant refresh request, this stream actually failed
                        await service.fail(pb.id, exc)
                        raise exc from refresh_error
                    raise
                continue
            if exc.status == 416:
                await service.note_stream_error(pb.id, exc)
            if exc.status != 416:
                await service.fail(pb.id, exc)
            exc.playback_id = pb.id
            raise exc from error
        except BaseException:
            if upstream:
                await upstream.close()
            raise

        captured_pb = pb

        async def chunks(
            stream=upstream, initial=first, used_version=link.version, playback=captured_pb
        ):
            try:
                yield initial
                async for chunk in stream.iterator:
                    yield chunk
            except httpx.HTTPError:
                # Headers are already sent, never append a replacement response
                async with service.db.sessions() as db:
                    from music.db.models import AudioLink

                    current = await db.get(AudioLink, playback.song_id)
                    if current and current.version == used_version:
                        current.last_error = "stream_interrupted"
                        await db.commit()
                raise
            finally:
                await stream.close()

        headers = {
            key: value
            for key, value in response.headers.items()
            if key.lower() in ("content-type", "content-length", "content-range", "accept-ranges")
        }
        headers.update(
            {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Audio-Version": str(link.version),
            }
        )
        if "accept-ranges" not in headers:
            headers["accept-ranges"] = "bytes" if response.status_code == 206 else "none"
        return AudioStreamingResponse(
            chunks(), upstream=upstream, status_code=response.status_code, headers=headers
        )
    raise AppError("refresh_exhausted", "音乐链接刷新后仍不可用", 502, playback_id)
