#!/usr/bin/env python3
"""Skip Live radar jen když je OPERA snímek na R2 ještě čerstvý.

Dříve se debounceovalo podle meta.updatedAt — po fast-path/env refresh
vypadal sync „před 2 min“, ale operaTime mohl být 10+ min starý a job se
přeskočil. Gate musí hledět na operaTime (stáří radaru), ne na updatedAt.
"""

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
    # Skip jen když máme snímek mladší než toto (OPERA ~5 min)
    max_opera_age = float(os.environ.get("MAX_AGE_MIN", "6"))
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
    opera_age = age_minutes(parse_iso(meta.get("operaTime")), now)
    meta_age = age_minutes(parse_iso(meta.get("updatedAt")), now)

    # Fallback: starý meta bez operaTime
    frame_age = opera_age if opera_age is not None else meta_age
    if frame_age is None:
        frame_age = 999.0

    print(
        f"gate: opera_age={opera_age if opera_age is not None else 'n/a'} min "
        f"meta_age={meta_age if meta_age is not None else 'n/a'} min "
        f"threshold={max_opera_age:.0f}",
        flush=True,
    )
    write_output(
        "age_min",
        f"{frame_age:.1f}",
    )
    write_output(
        "opera_age_min",
        f"{opera_age:.1f}" if opera_age is not None else "",
    )

    if frame_age < max_opera_age:
        print(
            f"gate: skip — OPERA frame still fresh ({frame_age:.1f} min)",
            flush=True,
        )
        write_output("skip", "true")
        return 0

    print(
        f"gate: run — OPERA frame stale ({frame_age:.1f} min >= {max_opera_age:.0f})",
        flush=True,
    )
    write_output("skip", "false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
