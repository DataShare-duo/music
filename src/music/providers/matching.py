"""Conservative identity matching: no fuzzy song/artist substitutions"""

import math
import re
import unicodedata

from music.providers.official import Track

VERSION_PATTERNS = {
    "live": r"\blive\b|现场|演唱会",
    "remix": r"\bremix\b|混音",
    "dj": r"\bdj\b",
    "cover": r"\bcover\b|翻唱",
    "instrumental": r"instrumental|伴奏|纯音乐|纯音版",
    "acoustic": r"acoustic|不插电",
    "remaster": r"remaster|重制|重录",
    "sped": r"sped|加速|减速|慢速",
}


def normalize(value):
    value = unicodedata.normalize("NFKC", value or "").casefold()
    return re.sub(r"[\W_]+", "", value)


def canonical_title(value):
    value = unicodedata.normalize("NFKC", value or "").casefold()
    # Marketing descriptors do not define a new recording, version qualifiers do
    value = re.sub(r"\([^()]*(?:主题曲|片尾曲|片头曲|插曲)[^()]*\)", "", value)
    return normalize(value)


def singer_set(value):
    singers = re.split(r"[,，、/;&＆]+", unicodedata.normalize("NFKC", value or ""))
    return {normalize(s) for s in singers if normalize(s)}


def versions(value):
    text = unicodedata.normalize("NFKC", value or "").casefold()
    return {label for label, pattern in VERSION_PATTERNS.items() if re.search(pattern, text)}


def duration_matches(actual, expected):
    return bool(
        math.isfinite(actual)
        and math.isfinite(expected)
        and actual > 0
        and expected > 0
        and abs(actual - expected) <= max(3, expected * 0.02)
    )


def same_recording(original: Track, candidate: Track):
    original_singers, candidate_singers = singer_set(original.artist), singer_set(candidate.artist)
    return bool(
        canonical_title(original.title)
        and canonical_title(original.title) == canonical_title(candidate.title)
        and original_singers
        and normalize("未知歌手") not in original_singers
        and original_singers == candidate_singers
        and versions(original.title) == versions(candidate.title)
        and duration_matches(candidate.duration, original.duration)
    )
