#!/usr/bin/env python3
"""Skip Live radar jen když je mapový snímek (mozaika/ČHMÚ/OPERA) ještě čerstvý."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data_freshness import age_minutes, parse_iso  # noqa: E402


def write_output(key: str, value: str) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")


def main() -> int:
    force = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
    max_age = float(os.environ.get("MAX_AGE_MIN", "6"))
    base = (os.environ.get("R2_PUBLIC_URL") or "").strip().rstrip("/")

    if force:
        print("gate: force run (manual dispatch)", flush=True)
        write_output("skip", "false")
        write_output("age_min", "")
        write_output("opera_age_min", "")
        return 0

    if not base:
        print("gate: R2_PUBLIC_URL missing — run refresh", flush=True)
        write_output("skip", "false")
        return 0

    url = f"{base}/data/meta.json"
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            meta = json.load(resp)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        print(f"gate: meta fetch failed ({exc}) — run refresh", flush=True)
        write_output("skip", "false")
        return 0

    now = datetime.now(timezone.utc)
    frame_keys = ("mosaicTime", "radarTime", "chmiTime", "operaTime")
    frame_iso = None
    frame_key = None
    for k in frame_keys:
        if meta.get(k):
            frame_iso = meta.get(k)
            frame_key = k
            break
    frame_age = age_minutes(parse_iso(frame_iso), now)
    meta_age = age_minutes(parse_iso(meta.get("updatedAt")), now)
    if frame_age is None:
        frame_age = meta_age if meta_age is not None else 999.0

    print(
        f"gate: {frame_key or 'n/a'}={frame_age:.1f} min "
        f"meta_age={meta_age if meta_age is not None else 'n/a'} "
        f"threshold={max_age:.0f}",
        flush=True,
    )
    write_output("age_min", f"{frame_age:.1f}")
    write_output("opera_age_min", f"{frame_age:.1f}")

    if frame_age < max_age:
        print(
            f"gate: skip — map frame still fresh ({frame_age:.1f} min)",
            flush=True,
        )
        write_output("skip", "true")
        return 0

    print(
        f"gate: run — map frame stale ({frame_age:.1f} min >= {max_age:.0f})",
        flush=True,
    )
    write_output("skip", "false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
