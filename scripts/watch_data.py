"""
Lokální watchdog: každých N minut stáhne OPERA / vítr / vznik.

Použití:
  python scripts/watch_data.py
  npm run data:watch
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from update_data import run_update  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Watchdog pro aktualizaci radarových dat")
    parser.add_argument(
        "--interval",
        type=int,
        default=5,
        help="Interval v minutách (default 5)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Jen jedno kolo a konec",
    )
    args = parser.parse_args()
    interval_s = max(60, args.interval * 60)

    print(
        f"Data watchdog běží · interval {args.interval} min · Ctrl+C ukončí",
        flush=True,
    )

    while True:
        run_update()
        if args.once:
            return 0
        print(f"Další update za {args.interval} min…", flush=True)
        time.sleep(interval_s)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nWatchdog ukončen.", flush=True)
        raise SystemExit(0)
