"""
Dev spike / manuální probe dual-pol nad bodem.

  python scripts/spike_chmi_dualpol.py
  python scripts/spike_chmi_dualpol.py --lat 49.35 --lon 18.0
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from chmi_dualpol import (
    DEFAULT_FZL_KM,
    _SITES,
    analyze_peak,
    fetch_site_volumes,
    haversine_km,
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--fzl-km", type=float, default=DEFAULT_FZL_KM)
    ap.add_argument("--cache", default=".cache/chmi_dualpol")
    args = ap.parse_args()

    cache = Path(args.cache)
    best = None
    best_dist = 1e9
    for site in _SITES:
        try:
            z_vol, zdr_vol = fetch_site_volumes(site, cache)
        except Exception as e:
            print(f"site {site['id']}: {e}")
            continue
        dist = haversine_km(z_vol.lat, z_vol.lon, args.lat, args.lon)
        res = analyze_peak(
            z_vol, zdr_vol, args.lat, args.lon, freezing_level_km=args.fzl_km
        )
        if res is None:
            print(f"site {site['id']}: out of range ({dist:.0f} km)")
            continue
        if dist < best_dist:
            best = res
            best_dist = dist
            print(f"site {site['id']}: candidate dist={dist:.0f}km")

    if best is None:
        print("no dual-pol coverage at this point")
        return
    print(json.dumps(best, indent=2))


if __name__ == "__main__":
    main()
