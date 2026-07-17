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

STEPS = [
    ("opera", "OPERA", [sys.executable, "scripts/opera_fetch_convert.py"]),
    ("formation", "vznik", [sys.executable, "scripts/fetch_formation.py"]),
    ("wind", "vítr", [sys.executable, "scripts/fetch_wind.py"]),
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


def run_update() -> bool:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
    print(f"\n[{stamp}] Aktualizuji storm data…", flush=True)
    results: dict[str, dict] = {}
    for key, label, cmd in STEPS:
        results[key] = run_step(key, label, cmd)

    write_meta(results)

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
    parser.parse_args()
    ok = run_update()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
