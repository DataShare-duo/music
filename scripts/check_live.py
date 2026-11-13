"""Opt-in live checks with explicit distinction between a valid URL and full audio"""

import argparse
import asyncio
import json
import logging
import sys

from music.core.audio_probe import AudioProbe
from music.core.config import Settings
from music.core.direct_audio import DirectAudioCheck
from music.core.errors import AppError
from music.core.streaming import AudioProxy, audio_content
from music.core.verification import FullAudioResolver
from music.providers.official import ProviderManager


async def main(args):
    logging.getLogger("httpx").setLevel(logging.WARNING)
    settings = Settings()
    providers = ProviderManager(settings.provider_concurrency, settings.network_timeout)
    proxy = AudioProxy(settings.network_timeout)
    probe = AudioProbe(proxy, settings.full_audio_verify_concurrency)
    try:
        tracks = await providers.search(args.source, args.query, 1, 20)
        print(
            json.dumps(
                {
                    "source": args.source,
                    "count": len(tracks),
                    "sample": [
                        {
                            "id": t.source_track_id,
                            "title": t.title[:100],
                            "artist": t.artist,
                            "expected_duration": t.duration,
                        }
                        for t in tracks[:2]
                    ],
                },
                ensure_ascii=False,
            )
        )
        if not tracks:
            raise AppError("empty_results", "真实搜索无结果，未通过联调")
        if args.full or args.direct:
            result = await FullAudioResolver(providers, probe, settings).resolve(tracks[0])
            if args.direct:
                await DirectAudioCheck(probe, settings.full_audio_verify_timeout).check(result)
                print(
                    json.dumps(
                        {"direct_preflight_passed": True, "device_playback_verified": False},
                        ensure_ascii=False,
                    )
                )
            print(
                json.dumps(
                    {
                        "full_audio_confirmed": True,
                        "play_source": result.track.source,
                        "title": result.track.title,
                        "metadata_duration": result.track.duration,
                        "actual_audio_duration": result.duration,
                    },
                    ensure_ascii=False,
                )
            )
            return
        audio = await providers.resolve(args.source, tracks[0].source_track_id)
        print(
            json.dumps(
                {
                    "resolved": bool(audio.url),
                    "kind": audio.audio_kind,
                    "note": "此检查仅确认链接解析，不代表完整版",
                },
                ensure_ascii=False,
            )
        )
        if args.stream:
            stream = await proxy.open(audio.url, audio.headers, "bytes=0-4095")
            try:
                first = await anext(stream.iterator, b"")
                valid = stream.response.status_code in (200, 206) and audio_content(
                    stream.response.headers, first, "bytes=0-4095"
                )
                print(
                    json.dumps(
                        {
                            "status": stream.response.status_code,
                            "content_type": stream.response.headers.get("content-type"),
                            "probe_bytes": len(first),
                            "valid_audio_response": valid,
                            "full_audio_confirmed": False,
                        }
                    )
                )
                if not valid:
                    raise AppError("invalid_audio", "未返回有效音频")
            finally:
                await stream.close()
    finally:
        probe.close()
        providers.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("soda", "netease", "kuwo"), default="soda")
    parser.add_argument("--query", default="流行")
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Read a small audio segment, not a full-audio validation",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Verify actual audio duration with strict fallback matching",
    )
    parser.add_argument(
        "--direct",
        action="store_true",
        help="Probe header-free HTTPS full audio; does not certify native device playback",
    )
    try:
        asyncio.run(main(parser.parse_args()))
    except AppError as exc:
        print(json.dumps({"error": exc.code, "message": exc.message}, ensure_ascii=False))
        raise SystemExit(1) from None
