"""
Odstraní / seřízne OPERA buňky, které národní radar v místě nepodporuje.

Nepřepisuje latest.png — jen cells.geojson.
Mapa zůstává OPERA; piny musí mít oporu v CHMI/DWD/SHMÚ/IMGW/MCH.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_radar_mosaic import COUNTRY_BBOX, load_national  # noqa: E402
from odim_io import build_geo, sample_grid_max  # noqa: E402

# Národní clear pod tímto → OPERA buňka je ghost
DROP_BELOW_DBZ = 22.0
# OPERA smí být max o tolik dBZ nad národní
CAP_MARGIN_DBZ = 6.0
# Mimo národní pokrytí: jen větší jádra (prťavé 64 dBZ / ~20 px = clutter)
OUTSIDE_MIN_DBZ = 48.0
OUTSIDE_MIN_AREA_PX = 36


def _in_bbox(lon: float, lat: float, bbox: tuple[float, float, float, float]) -> bool:
    west, south, east, north = bbox
    return west <= lon <= east and south <= lat <= north


def _peak_coords(feat: dict[str, Any]) -> tuple[float, float] | None:
    geom = feat.get("geometry") or {}
    props = feat.get("properties") or {}
    if geom.get("type") == "Point" and props.get("kind") == "peak":
        coords = geom.get("coordinates") or []
        if len(coords) >= 2:
            return float(coords[0]), float(coords[1])
    return None


def reconcile(
    cells_path: Path,
    sources: list[str],
) -> int:
    if not cells_path.is_file():
        print(f"reconcile: missing {cells_path}", flush=True)
        return 0

    layers: list[tuple[str, np.ndarray, dict, dict]] = []
    for src in sources:
        loaded = load_national(src)
        if not loaded:
            continue
        grid, meta, _t = loaded
        try:
            geo = build_geo(meta)
        except Exception as exc:
            print(f"reconcile: {src} geo failed ({exc})", flush=True)
            continue
        layers.append((src, grid, meta, geo))
        print(f"reconcile: loaded {src}", flush=True)

    if not layers:
        print("reconcile: no national layers — skip", flush=True)
        return 0

    fc = json.loads(cells_path.read_text(encoding="utf-8"))
    features: list[dict[str, Any]] = list(fc.get("features") or [])

    area_by_id: dict[str, int] = {}
    for feat in features:
        props = feat.get("properties") or {}
        if props.get("kind") not in (None, "cell"):
            continue
        cid = str(props.get("id") or props.get("cellId") or "")
        area = props.get("areaPx")
        if cid and area is not None:
            try:
                area_by_id[cid] = int(area)
            except (TypeError, ValueError):
                pass

    # cellId → (lon, lat, national max dBZ or None if outside coverage)
    support: dict[str, tuple[float, float, float | None, str | None]] = {}
    for feat in features:
        props = feat.get("properties") or {}
        if props.get("kind") != "peak":
            continue
        coords = _peak_coords(feat)
        if not coords:
            continue
        lon, lat = coords
        cid = str(props.get("cellId") or props.get("id") or "")
        if not cid:
            continue

        covering: list[tuple[str, float]] = []
        for src, grid, meta, geo in layers:
            bbox = COUNTRY_BBOX.get(src)
            if not bbox or not _in_bbox(lon, lat, bbox):
                continue
            val = sample_grid_max(grid, lon, lat, meta, geo, radius_px=3)
            if val is None or not np.isfinite(val):
                covering.append((src, 0.0))
            else:
                covering.append((src, float(val)))

        if not covering:
            support[cid] = (lon, lat, None, None)
        else:
            best_src, best_z = max(covering, key=lambda x: x[1])
            support[cid] = (lon, lat, best_z, best_src)

    drop_ids: set[str] = set()
    capped = 0

    for feat in features:
        props = feat.get("properties") or {}
        cid = str(props.get("cellId") or props.get("id") or "")
        if not cid or cid not in support:
            continue
        _lon, _lat, nat_z, nat_src = support[cid]
        opera = float(props.get("maxDbz") or 0)
        area_px = area_by_id.get(cid)

        if nat_z is None:
            # Mimo národní bbox — drž jen větší jádra (ne 18–21 px clutter)
            too_small = area_px is not None and area_px < OUTSIDE_MIN_AREA_PX
            if opera < OUTSIDE_MIN_DBZ or too_small:
                drop_ids.add(cid)
            continue

        props = dict(props)
        props["nationalDbz"] = round(nat_z, 1)
        if nat_src:
            props["nationalSource"] = nat_src

        if nat_z < DROP_BELOW_DBZ and opera >= 35:
            drop_ids.add(cid)
            feat["properties"] = props
            continue

        if opera > nat_z + CAP_MARGIN_DBZ:
            props["maxDbz"] = round(nat_z, 1)
            props["peakDbz"] = round(nat_z, 1)
            props["dbzCappedByNational"] = True
            props["dbzSource"] = (nat_src or "national").upper()
            capped += 1
            if nat_z < 30:
                drop_ids.add(cid)

        feat["properties"] = props

    before = len(features)
    if drop_ids:
        features = [
            feat
            for feat in features
            if str(
                (feat.get("properties") or {}).get("cellId")
                or (feat.get("properties") or {}).get("id")
                or ""
            )
            not in drop_ids
        ]

    fc["features"] = features
    cells_path.write_text(
        json.dumps(fc, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"reconcile: dropped={len(drop_ids)} capped={capped} "
        f"features {before} → {len(features)}",
        flush=True,
    )
    return len(drop_ids) + capped


def main() -> int:
    ap = argparse.ArgumentParser(description="Drop OPERA ghost cells vs national radar")
    ap.add_argument(
        "--cells",
        default=str(ROOT / "public" / "data" / "opera" / "cells.geojson"),
    )
    ap.add_argument(
        "--sources",
        default="chmi,dwd,shmu,imgw,mch",
    )
    args = ap.parse_args()
    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    reconcile(Path(args.cells), sources)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
