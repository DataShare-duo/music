import json
import re
from unittest.mock import Mock

import pytest

from music import healthcheck
from music.core.config import ROOT, Settings


@pytest.mark.parametrize("port", [None, "8080"])
def test_container_health_uses_runtime_port_without_auth_or_proxy(monkeypatch, port):
    if port is None:
        monkeypatch.delenv("PORT", raising=False)
    else:
        monkeypatch.setenv("PORT", port)
    response = Mock()
    response.status = 200
    response.read.return_value = b'{"status":"ok","database":"ok"}'
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=None)
    opener = Mock()
    opener.open.return_value = response
    factory = Mock(return_value=opener)
    monkeypatch.setattr(healthcheck, "build_opener", factory)
    assert healthcheck.main() == 0
    opener.open.assert_called_once_with(f"http://127.0.0.1:{port or '80'}/api/health", timeout=3)
    assert factory.call_args.args[0].proxies == {}
    response.read.assert_called_once_with(4096)


@pytest.mark.parametrize(
    ("status", "payload"),
    [
        (503, b'{"status":"ok","database":"ok"}'),
        (200, b'{"status":"ok","database":"failed"}'),
        (200, b"[]"),
        (200, b"not-json"),
    ],
)
def test_unhealthy_container_probe_fails(monkeypatch, status, payload):
    monkeypatch.setenv("PORT", "80")
    response = Mock()
    response.status, response.read.return_value = status, payload
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=None)
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(healthcheck, "build_opener", Mock(return_value=opener))
    assert healthcheck.main() == 1


@pytest.mark.parametrize("port", ["0", "-1", "65536", "bad"])
def test_invalid_health_port_is_rejected_without_network(monkeypatch, port):
    monkeypatch.setenv("PORT", port)
    factory = Mock()
    monkeypatch.setattr(healthcheck, "build_opener", factory)
    assert healthcheck.main() == 1
    factory.assert_not_called()


def test_health_connection_failure_returns_failure(monkeypatch):
    monkeypatch.setenv("PORT", "80")
    opener = Mock()
    opener.open.side_effect = OSError("connection refused")
    monkeypatch.setattr(healthcheck, "build_opener", Mock(return_value=opener))
    assert healthcheck.main() == 1


def test_wechat_config_and_docker_default_ports_are_consistent(monkeypatch):
    config = json.loads((ROOT / "container.config.json").read_text(encoding="utf-8"))
    docker = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    env = config["envParams"]
    assert config["name"] == "music"
    assert config["port"] == int(env["PORT"]) == 80
    assert config["minNum"] == 0 and config["maxNum"] == 1
    assert "ENV PORT=80" in docker and "EXPOSE 80" in docker
    cmd = json.loads(next(line[4:] for line in docker.splitlines() if line.startswith("CMD ")))
    assert cmd[:2] == ["sh", "-c"]
    assert '--port "${PORT:-80}"' in cmd[2]
    assert "--host 0.0.0.0" in cmd[2] and "--workers 1" in cmd[2]
    assert "--no-proxy-headers" in cmd[2]
    assert "USER app" in docker and "cap_net_bind_service=+ep" in docker
    assert "music.healthcheck" in docker and "HEALTHCHECK" in docker
    keys = re.findall(r"^([A-Z][A-Z0-9_]*)=", example, re.MULTILINE)
    assert set(keys) == set(env)
    assert env["MUSIC_ACCESS_PASSWORD"] == ""
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    settings = Settings(_env_file=None)
    assert settings.provider_concurrency == 2
    assert settings.full_audio_verify_concurrency == 1
    assert settings.stream_concurrency == 3
    assert settings.catalog_target == 100
    assert settings.access_password.get_secret_value() == ""
