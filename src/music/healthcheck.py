"""Container-local health probe, independent of passwords and proxy variables."""

import json
import os
from urllib.request import ProxyHandler, build_opener


def main() -> int:
    try:
        port = int(os.environ.get("PORT", "80"))
        if not 1 <= port <= 65535:
            return 1
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=3) as response:
            payload = json.loads(response.read(4096))
            healthy = (
                response.status == 200
                and isinstance(payload, dict)
                and payload.get("status") == "ok"
                and payload.get("database") == "ok"
            )
            return 0 if healthy else 1
    except (OSError, ValueError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
