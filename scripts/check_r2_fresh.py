#!/usr/bin/env python3
"""Skip Live radar when R2 meta je dostatečně čerstvé (debounce fronty)."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data_freshness import age_minutes  # noqa: E402


def write_output(key: str, value: str) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")


def main() -> int:
    force = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
    max_age = float(os.environ.get("MAX_AGE_MIN", "4"))
    base = (os.environ.get("R2_PUBLIC_URL") or "").strip().rstrip("/")

    if force:
        print("gate: force run (manual dispatch)", flush=True)
        write_output("skip", "false")
        write_output("age_min", "")
        return 0

    if not base:
        print("gate: R2_PUBLIC_URL missing — run refresh", flush=True)
        write_output("skip", "false")
        return 0

    url = f"{base}/data/meta.json"
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            meta = json.load(resp)
        updated = meta.get("updatedAt")
        age = age_minutes(
            datetime.fromisoformat(str(updated).replace("Z", "+00:00"))
            if updated
            else None,
            datetime.now(timezone.utc),
        )
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        print(f"gate: meta fetch failed ({exc}) — run refresh", flush=True)
        write_output("skip", "false")
        return 0

    if age is None:
        age = 999.0

    print(f"gate: meta age={age:.1f} min threshold={max_age:.0f}", flush=True)
    write_output("age_min", f"{age:.1f}")
    if age < max_age:
        print("gate: skip — R2 already fresh", flush=True)
        write_output("skip", "true")
        return 0

    write_output("skip", "false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
