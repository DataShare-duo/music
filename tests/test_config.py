import json

import pytest
from dotenv import dotenv_values

from music.core import config
from music.core.config import ROOT, Settings, default_keywords


def test_default_keywords_follow_current_example(monkeypatch):
    monkeypatch.delenv("MUSIC_KEYWORDS", raising=False)
    expected = json.loads(dotenv_values(ROOT / ".env.example")["MUSIC_KEYWORDS"])
    assert default_keywords() == expected
    assert Settings(_env_file=None).keywords == expected


def test_editing_example_changes_defaults_without_editing_python(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.delenv("MUSIC_KEYWORDS", raising=False)
    example = tmp_path / ".env.example"
    example.write_text('MUSIC_KEYWORDS=["新推荐词","活动歌曲"]\n', encoding="utf-8")
    assert Settings(_env_file=None).keywords == ["新推荐词", "活动歌曲"]
    example.write_text('MUSIC_KEYWORDS=["之后的新关键词"]\n', encoding="utf-8")
    assert Settings(_env_file=None).keywords == ["之后的新关键词"]


def test_explicit_keywords_still_override_defaults(monkeypatch, tmp_path):
    monkeypatch.setenv("MUSIC_KEYWORDS", '["临时环境变量"]')
    assert Settings(_env_file=None).keywords == ["临时环境变量"]
    monkeypatch.delenv("MUSIC_KEYWORDS")
    env = tmp_path / ".env"
    env.write_text('MUSIC_KEYWORDS=["本地自定义"]\n', encoding="utf-8")
    assert Settings(_env_file=env).keywords == ["本地自定义"]


@pytest.mark.parametrize("value", ["not-json", "{}", "[1]", '[" "]'])
def test_invalid_example_keywords_fail_clearly(monkeypatch, tmp_path, value):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    (tmp_path / ".env.example").write_text(f"MUSIC_KEYWORDS={value}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="MUSIC_KEYWORDS"):
        default_keywords()


def test_missing_example_keywords_fail_clearly(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    (tmp_path / ".env.example").write_text("PORT=80\n", encoding="utf-8")
    with pytest.raises(ValueError, match="MUSIC_KEYWORDS"):
        default_keywords()
