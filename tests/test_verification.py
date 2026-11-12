import asyncio
from dataclasses import replace

import pytest

from music.core.config import Settings
from music.core.errors import AppError
from music.core.verification import FullAudioResolver, FullAudioUnavailable
from music.providers.matching import duration_matches, same_recording
from music.providers.official import ResolvedAudio, Track

ORIGINAL = Track("soda", "original", "无名的人", "毛不易", duration=282)


class Providers:
    providers = {"soda": True, "netease": True, "kuwo": True}

    def __init__(self):
        self.resolutions, self.searches = [], []
        self.values = {"soda": 60, "netease": 282, "kuwo": 282}
        self.kinds = {"soda": "preview", "netease": "unknown", "kuwo": "unknown"}
        self.candidates = {
            source: [replace(ORIGINAL, source=source, source_track_id=source)]
            for source in ("netease", "kuwo")
        }
        self.delay = 0

    async def resolve(self, source, track_id):
        self.resolutions.append((source, track_id))
        await asyncio.sleep(self.delay)
        return ResolvedAudio(f"https://example.com/{source}", {}, self.kinds[source])

    async def search(self, source, *args):
        self.searches.append(source)
        return self.candidates[source]


class Probe:
    def __init__(self, providers):
        self.providers = providers

    async def duration(self, audio, timeout=30):
        return self.providers.values[audio.url.rsplit("/", 1)[1]]


@pytest.fixture
def resolver():
    providers = Providers()
    return FullAudioResolver(providers, Probe(providers), Settings())


async def test_prefers_netease_verified_full_over_kuwo(resolver):
    result = await resolver.resolve(ORIGINAL)
    assert result.track.source == "netease" and result.audio.audio_kind == "full"
    assert result.duration == 282
    assert resolver.providers.searches == ["netease"]


async def test_falls_through_to_kuwo_without_playing_another_preview(resolver):
    resolver.providers.kinds["netease"] = "preview"
    result = await resolver.resolve(ORIGINAL)
    assert result.track.source == "kuwo"
    assert resolver.providers.searches == ["netease", "kuwo"]


async def test_share_page_audition_field_can_be_full_during_activity(resolver):
    resolver.providers.values["soda"] = 282
    result = await resolver.resolve(ORIGINAL)
    assert result.track.source == "soda" and result.audio.audio_kind == "full"
    assert resolver.providers.searches == []


async def test_unconfirmed_or_all_short_rejected(resolver):
    resolver.providers.values.update(netease=60, kuwo=60)
    with pytest.raises(FullAudioUnavailable) as error:
        await resolver.resolve(ORIGINAL)
    assert not error.value.retryable


async def test_network_error_uses_short_retry_not_permanent_exclusion(resolver):
    async def offline(*args):
        raise AppError("upstream_timeout", "timeout")

    resolver.providers.resolve = offline
    with pytest.raises(FullAudioUnavailable) as error:
        await resolver.resolve(ORIGINAL)
    assert error.value.retryable


async def test_global_deadline_covers_original_search_probe_and_fallback(resolver):
    resolver.settings.full_audio_verify_timeout = 0.01
    resolver.providers.delay = 0.1
    with pytest.raises(FullAudioUnavailable) as error:
        await resolver.resolve(ORIGINAL)
    assert error.value.retryable
    assert resolver.providers.searches == []


async def test_refresh_never_switches_sources_or_searches(resolver):
    resolver.providers.values["soda"] = 282
    resolver.providers.values["netease"] = 60
    preferred = resolver.providers.candidates["netease"][0]
    with pytest.raises(FullAudioUnavailable):
        await resolver.resolve(ORIGINAL, preferred=preferred, only_preferred=True)
    assert resolver.providers.searches == []
    assert resolver.providers.resolutions == [("netease", "netease")]


@pytest.mark.parametrize(
    "candidate",
    [
        replace(ORIGINAL, artist="其他歌手"),
        replace(ORIGINAL, title="无名的人 (Live)"),
        replace(ORIGINAL, title="无名的人 (Remix)"),
        replace(ORIGINAL, title="无名的人 (伴奏版)"),
        replace(ORIGINAL, title="无名的人 (翻唱版)"),
        replace(ORIGINAL, duration=60),
        replace(ORIGINAL, duration=0),
        replace(ORIGINAL, artist="未知歌手"),
        replace(ORIGINAL, title="另一首歌"),
    ],
)
def test_strict_matching_rejects_wrong_recording(candidate):
    assert not same_recording(ORIGINAL, candidate)


def test_normalization_allows_marketing_qualifier_and_singer_order():
    assert same_recording(ORIGINAL, replace(ORIGINAL, title="无名的人（电影《雄狮少年》主题曲）"))
    duet = replace(ORIGINAL, artist="歌手A, 歌手B")
    assert same_recording(duet, replace(duet, artist="歌手B / 歌手A"))


def test_duration_tolerance_is_strict_and_handles_unknown_values():
    assert duration_matches(281, 282)
    assert not duration_matches(60, 282)
    assert not duration_matches(float("nan"), 282)
    assert not duration_matches(282, 0)
