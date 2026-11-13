import json
import re
import tomllib
from html.parser import HTMLParser

from music import __author__
from music.core.config import ROOT


class AuthorParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.authors = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta" and values.get("name") == "author":
            self.authors.append(values.get("content"))


def test_project_authorship_metadata():
    with (ROOT / "pyproject.toml").open("rb") as file:
        metadata = tomllib.load(file)
    assert metadata["project"]["authors"] == [{"name": "DataShare"}]
    package = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    assert package["author"] == __author__ == "DataShare"
    html = AuthorParser()
    html.feed((ROOT / "frontend/index.html").read_text(encoding="utf-8"))
    assert html.authors == ["DataShare"]
    assert 'org.opencontainers.image.authors="DataShare"' in (ROOT / "Dockerfile").read_text(
        encoding="utf-8"
    )
    assert (
        "CharlesPikachu"
        in (ROOT / "THIRD_PARTY_LICENSE_MUSICDL.txt").read_text(encoding="utf-8").splitlines()[0]
    )


def test_readme_has_requested_structure_and_valid_local_links():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    assert re.findall(r"^## (.+)$", text, re.MULTILINE) == ["1、用户界面与使用", "2、本地开发部署"]
    assert "作者：DataShare" in text
    assert all(topic not in text for topic in ("Render", "微信云托管", "SSH 隧道"))
    assert len(text.splitlines()) < 100
    assert "```powershell" in text and text.count("```") % 2 == 0
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
        if not target.startswith(("https://", "http://", "#")):
            assert (ROOT / target.split("#", 1)[0]).is_file(), target


def test_render_covers_example_settings_without_a_committed_password():
    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    render = (ROOT / "render.yaml").read_text(encoding="utf-8")
    keys = re.findall(r"^(MUSIC_[A-Z_]+)=", example, re.MULTILINE)
    render_keys = re.findall(r"- key: (MUSIC_[A-Z_]+)", render)
    assert set(keys) <= set(render_keys)
    assert len(render_keys) == len(set(render_keys))
    assert "MUSIC_ACCESS_PASSWORD=\n" in example
    assert "- key: MUSIC_ACCESS_PASSWORD\n        sync: false" in render
