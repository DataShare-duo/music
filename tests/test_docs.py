"""Keep first-party instructions aligned with anonymous access and runtime defaults."""

import json
import re

from dotenv import dotenv_values

from music.core.config import ROOT, Settings


def first_party_docs():
    return [ROOT / "README.md", ROOT / "AGENTS.md", *sorted((ROOT / "docs").rglob("*.md"))]


def table_rows(path):
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("|"):
            cells = [cell.strip().strip("`") for cell in line.strip("|").split("|")]
            if len(cells) >= 2:
                rows[cells[0]] = cells[1]
    return rows


def test_readme_describes_anonymous_access_not_legacy_authentication():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "无需注册、登录或输入账号密码" in text
    assert "浏览器直接访问 `http://127.0.0.1:5173`" in text
    for obsolete in (
        "MUSIC_ACCESS_",
        "默认账号",
        "生成的随机密码",
        "secrets.token_urlsafe",
        "完成浏览器认证",
        "不配置密码时业务接口不可访问",
    ):
        assert obsolete not in text
    assert re.findall(r"^## (.+)$", text, re.MULTILINE) == [
        "1、用户界面与使用",
        "2、本地开发部署",
    ]


def test_first_party_docs_do_not_instruct_setting_removed_access_variables():
    for path in first_party_docs():
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"MUSIC_ACCESS_(?:USERNAME|PASSWORD)\s*=", text), path
        for obsolete in (
            "密码必须自行设置",
            "必填随机长密码",
            "空密码时只允许健康检查",
            "先访问 `http://127.0.0.1:5173/api/sources` 完成浏览器认证",
        ):
            assert obsolete not in text, path


def test_documented_resource_defaults_match_code_and_example():
    rows = table_rows(ROOT / "docs/security.md")
    example = dotenv_values(ROOT / ".env.example")
    for key, documented in rows.items():
        if key.startswith("MUSIC_"):
            field = key.removeprefix("MUSIC_").lower()
            assert field in Settings.model_fields, key
            assert int(documented) == Settings.model_fields[field].default == int(example[key]), key
    assert len([key for key in rows if key.startswith("MUSIC_")]) == 10


def test_documented_cloud_values_match_deployment_template():
    rows = table_rows(ROOT / "docs/wechat-cloudrun.md")
    env = json.loads((ROOT / "container.config.json").read_text(encoding="utf-8"))["envParams"]
    for key, documented in rows.items():
        if key == "PORT" or key.startswith("MUSIC_"):
            assert documented == env[key], key
    assert "MUSIC_KEYWORDS" not in env


def test_all_first_party_markdown_has_closed_fences_and_valid_local_links():
    for path in first_party_docs():
        text = path.read_text(encoding="utf-8")
        assert sum(line.startswith("```") for line in text.splitlines()) % 2 == 0, path
        assert len(re.findall(r"^# ", text, re.MULTILINE)) == 1, path
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if not target.startswith(("https://", "http://", "#", "mailto:")):
                destination = (path.parent / target.split("#", 1)[0]).resolve()
                assert destination.is_relative_to(ROOT.resolve()) and destination.exists(), (
                    path,
                    target,
                )
