"""Obnoví formation (+ wind ze stejného fetch) / wind podle stáří — Live radar každých ~5 min.

Prah (cíl UI ≤ ~15 min):
  formation > 15 min → fetch_formation --force (zapíše i wind)
  jinak wind > 10 min → fetch_wind --force
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_freshness import age_minutes, read_valid_at  # noqa: E402

FORMATION_REFRESH_MIN = 15.0
WIND_REFRESH_MIN = 10.0
WIND = "public/data/wind/low.json"
FORM = "public/data/formation/grid.json"


def main() -> int:
    now = datetime.now(timezone.utc)
    wind_age = age_minutes(read_valid_at(WIND), now) if os.path.isfile(WIND) else 999.0
    form_age = age_minutes(read_valid_at(FORM), now) if os.path.isfile(FORM) else 999.0
    if wind_age is None:
        wind_age = 999.0
    if form_age is None:
        form_age = 999.0

    print(
        f"env ages: wind={wind_age:.0f} min formation={form_age:.0f} min "
        f"(refresh form>{FORMATION_REFRESH_MIN:.0f} wind>{WIND_REFRESH_MIN:.0f})",
        flush=True,
    )

    if form_age > FORMATION_REFRESH_MIN:
        print("  -> formation --force (writes wind too)", flush=True)
        r = subprocess.run(
            [sys.executable, "scripts/fetch_formation.py", "--force"], cwd="."
        )
        return 0 if r.returncode == 0 else r.returncode

    if wind_age > WIND_REFRESH_MIN:
        print("  -> wind --force", flush=True)
        r = subprocess.run(
            [sys.executable, "scripts/fetch_wind.py", "--force"], cwd="."
        )
        return 0 if r.returncode == 0 else r.returncode

    print("  env fresh — skip Open-Meteo", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
