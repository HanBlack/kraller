"""Obnoví formation (+ wind ze stejného fetch) / wind / sat cooling podle stáří — Live radar každých ~5 min.

Prah (cíl UI ≤ ~15 min):
  formation > 15 min → fetch_formation --force (zapíše i wind) + sat cooling + merge
  jinak wind > 10 min → fetch_wind --force
  sat cooling > 15 min → fetch_sat_cooling + merge (i když formation fresh)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_freshness import age_minutes, read_valid_at  # noqa: E402

FORMATION_REFRESH_MIN = 15.0
WIND_REFRESH_MIN = 10.0
SAT_REFRESH_MIN = 15.0
WIND = "public/data/wind/low.json"
FORM = "public/data/formation/grid.json"
SAT = "public/data/satellite/cooling.json"


def _sat_needs_refresh(sat_age: float) -> bool:
    """Prázdné points = rozbitý ingest — obnov vždy, i když validAt je čerstvé."""
    if sat_age > SAT_REFRESH_MIN:
        return True
    if not os.path.isfile(SAT):
        return True
    try:
        with open(SAT, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("status") != "ok":
            return True
        if not (data.get("points") or []):
            print("  sat cooling empty points — force refresh", flush=True)
            return True
    except (OSError, json.JSONDecodeError, TypeError):
        return True
    return False


def _run(script: str, *args: str) -> int:
    return subprocess.run(
        [sys.executable, f"scripts/{script}", *args], cwd="."
    ).returncode


def main() -> int:
    now = datetime.now(timezone.utc)
    wind_age = age_minutes(read_valid_at(WIND), now) if os.path.isfile(WIND) else 999.0
    form_age = age_minutes(read_valid_at(FORM), now) if os.path.isfile(FORM) else 999.0
    sat_age = age_minutes(read_valid_at(SAT), now) if os.path.isfile(SAT) else 999.0
    if wind_age is None:
        wind_age = 999.0
    if form_age is None:
        form_age = 999.0
    if sat_age is None:
        sat_age = 999.0

    print(
        f"env ages: wind={wind_age:.0f} min formation={form_age:.0f} min "
        f"sat={sat_age:.0f} min "
        f"(refresh form>{FORMATION_REFRESH_MIN:.0f} wind>{WIND_REFRESH_MIN:.0f} "
        f"sat>{SAT_REFRESH_MIN:.0f})",
        flush=True,
    )

    rc = 0
    if form_age > FORMATION_REFRESH_MIN:
        print("  -> formation --force (writes wind too)", flush=True)
        r = _run("fetch_formation.py", "--force")
        if r != 0:
            rc = r
        print("  -> sat cooling + merge", flush=True)
        _run("fetch_sat_cooling.py")
        _run("merge_sat_cooling.py")
        return rc

    if _sat_needs_refresh(sat_age):
        print("  -> sat cooling + merge", flush=True)
        _run("fetch_sat_cooling.py")
        _run("merge_sat_cooling.py")

    if wind_age > WIND_REFRESH_MIN:
        print("  -> wind --force", flush=True)
        r = _run("fetch_wind.py", "--force")
        if r != 0:
            rc = r
        return rc

    if form_age <= FORMATION_REFRESH_MIN and not _sat_needs_refresh(sat_age):
        print("  env fresh — skip Open-Meteo / sat", flush=True)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
