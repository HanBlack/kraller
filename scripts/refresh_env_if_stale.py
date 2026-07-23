"""Obnoví formation / wind / sat cooling podle stáří.

Radar refresh musí zůstat rychlý (~2–4 min). Satelit běží odděleně
(workflow live-sat.yml); zde --skip-sat / --sat-only pro lokální / legacy.

Prah (mesoscale ~ stejný takt jako radar */5):
  formation > 6 min → fetch_formation --force (zapíše i wind)
  wind > 6 min → fetch_wind --force (když formation fresh)
  sat > 25 min → fetch_sat_cooling + merge
  sat empty/error → retry max každých 10 min (ne každý live-radar cyklus)

Open-Meteo fail nikdy neblokuje live radar (rc env = 0 při --skip-sat).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_freshness import age_minutes, read_valid_at  # noqa: E402

# Cíl: env na stejném taktu jako Live radar (~5 min), s malou rezervou
FORMATION_REFRESH_MIN = 6.0
WIND_REFRESH_MIN = 6.0
# Sat je drahý — méně často než radar (radar ~5 min, sat ~25 min)
SAT_REFRESH_MIN = 25.0
# Prázdný/broken cooling.json: nespamuj každý cyklus
SAT_EMPTY_RETRY_MIN = 10.0
WIND = "public/data/wind/low.json"
FORM = "public/data/formation/grid.json"
SAT = "public/data/satellite/cooling.json"


def _sat_needs_refresh(sat_age: float) -> bool:
    if not os.path.isfile(SAT):
        return True
    try:
        with open(SAT, encoding="utf-8") as f:
            data = json.load(f)
        status = data.get("status")
        points = data.get("points") or []
        broken = status not in ("ok",) or not points
        if broken:
            # Empty/error: retry, ale ne každou 5min směnu
            if sat_age >= SAT_EMPTY_RETRY_MIN:
                print(
                    f"  sat cooling broken (status={status}, points={len(points)}) "
                    f"age={sat_age:.0f} min — retry",
                    flush=True,
                )
                return True
            print(
                f"  sat cooling broken but age={sat_age:.0f} < {SAT_EMPTY_RETRY_MIN:.0f} "
                f"— skip (keep radar fast)",
                flush=True,
            )
            return False
    except (OSError, json.JSONDecodeError, TypeError):
        return sat_age >= SAT_EMPTY_RETRY_MIN

    return sat_age > SAT_REFRESH_MIN


def _run(script: str, *args: str) -> int:
    try:
        return subprocess.run(
            [sys.executable, f"scripts/{script}", *args], cwd="."
        ).returncode
    except OSError as exc:
        print(f"  WARN: {script} start failed ({exc})", flush=True)
        return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--skip-sat",
        action="store_true",
        help="Jen formation/wind — sat až po R2 uploadu radaru",
    )
    ap.add_argument(
        "--sat-only",
        action="store_true",
        help="Jen sat cooling + merge (pomalejší job po radaru)",
    )
    args = ap.parse_args()

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
        f"sat>{SAT_REFRESH_MIN:.0f} emptyRetry>{SAT_EMPTY_RETRY_MIN:.0f}) "
        f"skip_sat={args.skip_sat} sat_only={args.sat_only}",
        flush=True,
    )

    rc = 0

    if args.sat_only:
        if _sat_needs_refresh(sat_age):
            print("  -> sat cooling + merge", flush=True)
            r = _run("fetch_sat_cooling.py")
            _run("merge_sat_cooling.py")
            if r != 0:
                rc = r
        else:
            print("  sat fresh — skip", flush=True)
        return rc

    if form_age > FORMATION_REFRESH_MIN:
        print("  -> formation --force (writes wind too)", flush=True)
        r = _run("fetch_formation.py", "--force")
        if r != 0:
            print(
                f"  WARN: formation refresh failed (rc={r}) — keep previous grid",
                flush=True,
            )
            if not args.skip_sat:
                rc = r
        if not args.skip_sat and _sat_needs_refresh(sat_age):
            print("  -> sat cooling + merge", flush=True)
            _run("fetch_sat_cooling.py")
            _run("merge_sat_cooling.py")
        # Live radar: Open-Meteo výpadek nesmí zrušit OPERA upload
        return 0 if args.skip_sat else rc

    if not args.skip_sat and _sat_needs_refresh(sat_age):
        print("  -> sat cooling + merge", flush=True)
        _run("fetch_sat_cooling.py")
        _run("merge_sat_cooling.py")

    if wind_age > WIND_REFRESH_MIN:
        print("  -> wind --force", flush=True)
        r = _run("fetch_wind.py", "--force")
        if r != 0:
            print(
                f"  WARN: wind refresh failed (rc={r}) — keep previous wind",
                flush=True,
            )
            if not args.skip_sat:
                rc = r
        return 0 if args.skip_sat else rc

    if form_age <= FORMATION_REFRESH_MIN and (
        args.skip_sat or not _sat_needs_refresh(sat_age)
    ):
        print("  env fresh — skip Open-Meteo / sat", flush=True)
    return 0 if args.skip_sat else rc


if __name__ == "__main__":
    raise SystemExit(main())
