import asyncio
import socket

import httpx
import pytest

from music.core.errors import AppError
from music.core.streaming import AudioProxy, audio_content, public_target


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/a",
        "http://user:pass@example.com/a",
        "https://example.com:8080/a",
        "http://127.0.0.1/a",
        "http://[::1]/",
        "http://169.254.169.254/a",
        "http://10.0.0.1/",
        "http://0.0.0.0/",
    ],
)
async def test_reject_unsafe_addresses(url):
    with pytest.raises(AppError) as exc:
        await public_target(url)
    assert exc.value.code == "unsafe_audio_url"


async def test_pin_validated_ip_and_reject_mixed_dns(monkeypatch):
    async def resolve(*args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolve)
    pinned, host, authority = await public_target("https://example.com/audio?token=test")
    assert str(pinned) == "https://93.184.216.34/audio?token=test"
    assert host == authority == "example.com"

    async def mixed(*args, **kwargs):
        return [(socket.AF_INET, 1, 6, "", (ip, 443)) for ip in ("93.184.216.34", "127.0.0.1")]

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", mixed)
    with pytest.raises(AppError):
        await public_target("https://example.com/audio")


async def test_invalid_range_rejected_before_network():
    with pytest.raises(AppError) as exc:
        await AudioProxy().open("https://example.com", {}, "bytes=0-1,5-6")
    assert exc.value.status == 416


async def test_redirect_to_private_ip_is_rejected(monkeypatch):
    import music.core.streaming as module

    seen = []
    real_target = module.public_target

    async def target(url):
        seen.append(url)
        if "127.0.0.1" in url:
            return await real_target(url)
        return httpx.URL("https://93.184.216.34/audio"), "example.com", "example.com"

    monkeypatch.setattr(module, "public_target", target)
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda request: httpx.Response(302, headers={"location": "http://127.0.0.1/private"})
    )
    monkeypatch.setattr(
        module.httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport)
    )
    with pytest.raises(AppError):
        await AudioProxy().open("https://example.com/audio", {})
    assert len(seen) == 2


def test_audio_sniffing():
    assert audio_content({"content-type": "application/octet-stream"}, b"ID3audio", None)
    assert not audio_content({"content-type": "audio/mpeg"}, b"<html>blocked</html>", None)
    assert not audio_content({"content-type": "text/html"}, b"blocked", None)
    assert not audio_content({}, b"random", None)


async def test_native_strict_https_rejects_plain_http_before_network():
    with pytest.raises(AppError) as error:
        await AudioProxy().open("http://example.com/audio", {}, https_only=True)
    assert error.value.code == "unsafe_audio_url"


async def test_native_redirect_cannot_downgrade_https(monkeypatch):
    import music.core.streaming as module

    async def target(url):
        return httpx.URL("https://93.184.216.34/audio"), "example.com", "example.com"

    monkeypatch.setattr(module, "public_target", target)
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda request: httpx.Response(302, headers={"location": "http://example.com/audio"})
    )
    monkeypatch.setattr(
        module.httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport)
    )
    with pytest.raises(AppError) as error:
        await AudioProxy().open("https://example.com/audio", {}, https_only=True)
    assert error.value.code == "unsafe_audio_url"


async def test_native_preflight_uses_generic_browser_ua_without_platform_credentials(monkeypatch):
    import music.core.streaming as module

    seen = []

    async def target(url):
        return httpx.URL("https://93.184.216.34/audio"), "example.com", "example.com"

    def handler(request):
        seen.append(request)
        return httpx.Response(206, headers={"content-type": "audio/mpeg"}, content=b"ID3audio")

    original_client = httpx.AsyncClient
    monkeypatch.setattr(module, "public_target", target)
    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=httpx.MockTransport(handler)),
    )
    stream = await AudioProxy().open(
        "https://example.com/audio", {}, "bytes=0-100", https_only=True
    )
    await stream.close()
    headers = seen[0].headers
    assert headers["user-agent"] == "Mozilla/5.0" and headers["range"] == "bytes=0-100"
    assert headers["accept-encoding"] == "identity"
    assert not any(name in headers for name in ("referer", "origin", "cookie", "authorization"))
