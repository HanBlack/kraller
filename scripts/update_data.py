"""
Jedno kolo aktualizace dat — částečný úspěch je OK.

OPERA / vítr / vznik běží samostatně. Meta vždy zapisuje stav po zdrojích.
Radar (OPERA) je kritický: exit 1 jen když OPERA selže.

Použití:
  python scripts/update_data.py
  npm run data:update
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Aby fungoval import write_meta při spuštění z kořene projektu
sys.path.insert(0, str(Path(__file__).resolve().parent))

from write_meta import write_meta  # noqa: E402

FULL_STEPS = [
    ("opera", "OPERA", [sys.executable, "scripts/opera_fetch_convert.py"]),
    ("formation", "vznik", [sys.executable, "scripts/fetch_formation.py"]),
    ("wind", "vítr", [sys.executable, "scripts/fetch_wind.py"]),
]

# Rychlá obnova na produkci — radar + env (vznik/vítr) podle stáří.
RADAR_ONLY_STEPS = [
    (
        "opera",
        "OPERA",
        [sys.executable, "scripts/opera_fetch_convert.py", "--frames", "6"],
    ),
    (
        "chmi",
        "ČHMÚ",
        [sys.executable, "scripts/chmi_radar.py"],
    ),
    (
        "env",
        "env (formation/wind)",
        [sys.executable, "scripts/refresh_env_if_stale.py"],
    ),
]


def run_step(key: str, label: str, cmd: list[str]) -> dict:
    print(f"  -> {label}", flush=True)
    try:
        proc = subprocess.run(cmd, cwd=".")
        if proc.returncode == 0:
            print(f"  OK {label}", flush=True)
            return {"ok": True}
        err = f"exit {proc.returncode}"
        print(f"  FAIL {label} ({err})", flush=True)
        return {"ok": False, "error": err}
    except OSError as e:
        print(f"  FAIL {label} ({e})", flush=True)
        return {"ok": False, "error": str(e)}


def run_update(*, radar_only: bool = False) -> bool:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
    mode = "radar" if radar_only else "full"
    print(f"\n[{stamp}] Aktualizuji storm data ({mode})…", flush=True)
    results: dict[str, dict] = {}
    steps = RADAR_ONLY_STEPS if radar_only else FULL_STEPS
    for key, label, cmd in steps:
        results[key] = run_step(key, label, cmd)

    write_meta(results)

    # Learning store — vždy po úspěšném radaru (sběr pro pozdější kalibraci)
    if results.get("opera", {}).get("ok"):
        print("  -> learning emit", flush=True)
        try:
            subprocess.run(
                [sys.executable, "scripts/emit_learning.py"], cwd=".", check=False
            )
        except OSError:
            pass

    if radar_only:
        return bool(results.get("opera", {}).get("ok"))

    # Guardy zrod/trajektorie — neblokuje update, ale hned ukáže regrese
    print("  -> verify tracks/birth", flush=True)
    try:
        subprocess.run([sys.executable, "scripts/verify_data.py"], cwd=".", check=False)
    except OSError:
        pass

    print("  -> calibrate nowcast", flush=True)
    try:
        subprocess.run(
            [sys.executable, "scripts/calibrate_nowcast.py"], cwd=".", check=False
        )
    except OSError:
        pass

    opera_ok = bool(results.get("opera", {}).get("ok"))
    failed = [k for k, r in results.items() if not r.get("ok")]
    if not failed:
        print(f"[{stamp}] Hotovo — všechny zdroje OK.", flush=True)
        return True
    if opera_ok:
        print(
            f"[{stamp}] Částečný úspěch — radar OK, selhalo: {', '.join(failed)} "
            "(příští kolo zkusí znovu).",
            flush=True,
        )
        return True
    print(f"[{stamp}] Selhalo — OPERA neběží. Selhalo: {', '.join(failed)}.", flush=True)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Aktualizace radarových dat (částečný OK)")
    parser.add_argument(
        "--radar-only",
        action="store_true",
        help="Jen OPERA radar (rychlejší obnova na produkci)",
    )
    args = parser.parse_args()
    ok = run_update(radar_only=args.radar_only)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
