"""
Sestaví živou mapovou mozaiku: národní compositý + OPERA fill + feather na hranicích.

Přepisuje public/data/opera/latest.png (+ latest-raster.json).
Tracking buněk zůstává z OPERA (opera_fetch_convert).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from odim_io import build_geo, nominal_time_iso, read_odim_grid  # noqa: E402
from opera_fetch_convert import _dbz_to_rgba  # noqa: E402

# Přibližné bboxy (W, S, E, N) — feather uvnitř
COUNTRY_BBOX: dict[str, tuple[float, float, float, float]] = {
    "chmi": (12.09, 48.55, 18.86, 51.06),
    "dwd": (5.85, 47.25, 15.05, 55.05),
    "shmu": (16.82, 47.72, 22.57, 49.62),
    "imgw": (14.05, 49.00, 24.15, 54.90),
    "mch": (5.92, 45.80, 10.55, 47.85),
}

# Feather šířka ve stupních (~40 km)
FEATHER_DEG = 0.45
MAX_NATIONAL_AGE_MIN = 10.0
OPERA_BASE_WEIGHT = 0.18

DEFAULT_BBOX = (5.5, 45.5, 24.5, 55.2)  # DE–PL–CH–SK + CZ
DEFAULT_WIDTH = 900
DEFAULT_HEIGHT = 700


def _parse_iso(iso: str | None) -> dt.datetime | None:
    if not iso:
        return None
    try:
        return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(
            dt.timezone.utc
        )
    except ValueError:
        return None


def _age_min(iso: str | None, now: dt.datetime) -> float | None:
    t = _parse_iso(iso)
    if t is None:
        return None
    return max(0.0, (now - t).total_seconds() / 60.0)


def _time_str_compact(iso: str | None) -> str:
    t = _parse_iso(iso)
    if t is None:
        return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    return t.strftime("%Y%m%d%H%M%S")


def build_target_grid(
    coordinates: list[list[float]] | None,
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray, list[list[float]]]:
    """Lon/lat mřížka lineární ve Web Mercator + rohy MapLibre."""
    if coordinates and len(coordinates) == 4:
        west = min(c[0] for c in coordinates)
        east = max(c[0] for c in coordinates)
        south = min(c[1] for c in coordinates)
        north = max(c[1] for c in coordinates)
    else:
        west, south, east, north = DEFAULT_BBOX

    wgs_to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    merc_to_wgs = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    corners = [(west, north), (east, north), (east, south), (west, south)]
    merc = [wgs_to_merc.transform(lon, lat) for lon, lat in corners]
    mx0 = min(p[0] for p in merc)
    mx1 = max(p[0] for p in merc)
    my0 = min(p[1] for p in merc)
    my1 = max(p[1] for p in merc)

    mx = mx0 + (np.arange(width, dtype=np.float64) + 0.5) / width * (mx1 - mx0)
    my = my1 - (np.arange(height, dtype=np.float64) + 0.5) / height * (my1 - my0)
    mx_g, my_g = np.meshgrid(mx, my)
    lon_g, lat_g = merc_to_wgs.transform(mx_g, my_g)
    coords = [[west, north], [east, north], [east, south], [west, south]]
    return np.asarray(lon_g, dtype=np.float64), np.asarray(lat_g, dtype=np.float64), coords


def feather_weight(
    lon: np.ndarray,
    lat: np.ndarray,
    bbox: tuple[float, float, float, float],
    feather: float = FEATHER_DEG,
) -> np.ndarray:
    west, south, east, north = bbox
    inside = (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
    d_edge = np.minimum(
        np.minimum(lon - west, east - lon),
        np.minimum(lat - south, north - lat),
    )
    w = np.zeros(lon.shape, dtype=np.float64)
    w[inside] = np.clip(d_edge[inside] / max(1e-6, feather), 0.0, 1.0)
    return w


def sample_layer_to_grid(
    grid: np.ndarray,
    meta: dict,
    lon_g: np.ndarray,
    lat_g: np.ndarray,
) -> np.ndarray:
    if "projdef" not in meta:
        raise RuntimeError("ODIM missing projdef")
    geo = build_geo(meta)
    h, w = grid.shape
    flat_lon = lon_g.ravel()
    flat_lat = lat_g.ravel()
    x, y = geo["wgs_to_proj"].transform(flat_lon, flat_lat)
    ul_x, ul_y = geo["ul"]
    col = (np.asarray(x, dtype=np.float64) - ul_x) / geo["xscale"] - 0.5
    row = (ul_y - np.asarray(y, dtype=np.float64)) / geo["yscale"] - 0.5
    row_2d = row.reshape(lon_g.shape)
    col_2d = col.reshape(lon_g.shape)
    filled = np.where(np.isfinite(grid), grid, 0.0).astype(np.float64)
    sampled = map_coordinates(
        filled,
        [row_2d, col_2d],
        order=1,
        mode="constant",
        cval=0.0,
        prefilter=False,
    )
    row_i = np.floor(row_2d + 0.5).astype(int)
    col_i = np.floor(col_2d + 0.5).astype(int)
    inb = (row_i >= 0) & (row_i < h) & (col_i >= 0) & (col_i < w)
    src_ok = np.zeros(lon_g.shape, dtype=bool)
    ri = np.clip(row_i, 0, h - 1)
    ci = np.clip(col_i, 0, w - 1)
    src_ok[inb] = np.isfinite(grid[ri[inb], ci[inb]])
    return np.where(src_ok, sampled, np.nan).astype(np.float64)


def resample_dbz_onto_grid(
    src: np.ndarray,
    src_coordinates: list[list[float]],
    lon_g: np.ndarray,
    lat_g: np.ndarray,
) -> np.ndarray:
    """Převzorkuje OPERA crop dBZ na širší mozaikovou mřížku."""
    wgs_to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    mercs = [wgs_to_merc.transform(c[0], c[1]) for c in src_coordinates]
    mx0 = min(p[0] for p in mercs)
    mx1 = max(p[0] for p in mercs)
    my0 = min(p[1] for p in mercs)
    my1 = max(p[1] for p in mercs)
    h, w = src.shape
    mx, my = wgs_to_merc.transform(lon_g.ravel(), lat_g.ravel())
    col = (np.asarray(mx) - mx0) / max(1e-9, mx1 - mx0) * w - 0.5
    row = (my1 - np.asarray(my)) / max(1e-9, my1 - my0) * h - 0.5
    row_2d = row.reshape(lon_g.shape)
    col_2d = col.reshape(lon_g.shape)
    filled = np.where(np.isfinite(src), src, 0.0).astype(np.float64)
    sampled = map_coordinates(
        filled,
        [row_2d, col_2d],
        order=1,
        mode="constant",
        cval=0.0,
        prefilter=False,
    )
    inb = (
        (row_2d >= 0)
        & (row_2d <= h - 1)
        & (col_2d >= 0)
        & (col_2d <= w - 1)
    )
    return np.where(inb & (sampled > 0), sampled, np.nan).astype(np.float64)


def load_opera_base(
    lon_g: np.ndarray,
    lat_g: np.ndarray,
    opera_png: Path,
    opera_raster: Path,
) -> np.ndarray:
    npy = ROOT / "public" / "data" / "opera" / "latest-dbz.npy"
    coords = None
    if opera_raster.is_file():
        try:
            meta_r = json.loads(opera_raster.read_text(encoding="utf-8"))
            coords = meta_r.get("coordinates")
        except (OSError, json.JSONDecodeError):
            coords = None
    if npy.is_file():
        arr = np.load(npy)
        if arr.shape == lon_g.shape:
            return arr.astype(np.float64)
        if coords and len(coords) == 4:
            print(
                f"mosaic: resampling OPERA {arr.shape} → {lon_g.shape}",
                flush=True,
            )
            return resample_dbz_onto_grid(arr, coords, lon_g, lat_g)
    return np.full(lon_g.shape, np.nan, dtype=np.float64)


def save_opera_dbz_sidecar(dbz: np.ndarray) -> None:
    path = ROOT / "public" / "data" / "opera" / "latest-dbz.npy"
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, dbz.astype(np.float32))


def load_national(source: str) -> tuple[np.ndarray, dict, str] | None:
    meta_path = ROOT / ".cache" / "national" / source / "latest.json"
    h5_path = ROOT / ".cache" / "national" / source / "latest.h5"
    if not h5_path.is_file():
        # try pointer in public/data/national
        pub = ROOT / "public" / "data" / "national" / f"{source}.json"
        if pub.is_file():
            try:
                info = json.loads(pub.read_text(encoding="utf-8"))
                p = ROOT / info["path"]
                if p.is_file():
                    h5_path = p
            except (OSError, json.JSONDecodeError, KeyError):
                pass
    if not h5_path.is_file():
        print(f"mosaic: {source} missing — skip", flush=True)
        return None
    try:
        qty = None
        if source == "mch":
            qty = "RATE"
        grid, meta = read_odim_grid(str(h5_path), qty)
        if "projdef" not in meta or "UL_lon" not in meta:
            print(f"mosaic: {source} missing georef — skip", flush=True)
            return None
        t = nominal_time_iso(meta)
        return grid, meta, t or ""
    except Exception as exc:
        print(f"mosaic: {source} read failed ({exc}) — skip", flush=True)
        return None


def blend_layers(
    opera: np.ndarray,
    nationals: list[tuple[str, np.ndarray, np.ndarray, str]],
    lon_g: np.ndarray,
    lat_g: np.ndarray,
    now: dt.datetime,
) -> tuple[np.ndarray, dict[str, Any]]:
    """nationals: (source, dbz, weight_mask, time_iso)"""
    h, width = lon_g.shape
    base = np.where(np.isfinite(opera), opera, 0.0)
    base_w = np.where(np.isfinite(opera), OPERA_BASE_WEIGHT, 0.0)
    acc = base * base_w
    wsum = base_w.copy()
    used: dict[str, Any] = {"opera": True}
    times: list[str] = []

    for source, dbz, _, time_iso in nationals:
        age = _age_min(time_iso, now) if time_iso else None
        if age is not None and age > MAX_NATIONAL_AGE_MIN:
            print(
                f"mosaic: {source} stale ({age:.1f} min) — skip national",
                flush=True,
            )
            used[source] = {"ok": False, "reason": "stale", "ageMin": age}
            continue
        bbox = COUNTRY_BBOX.get(source)
        if not bbox:
            continue
        fw = feather_weight(lon_g, lat_g, bbox)
        valid = np.isfinite(dbz)
        # i slabý déšť / coverage — weight jen kde má národní data nebo uvnitř bbox
        layer_w = fw * np.where(valid, 1.0, 0.0)
        # mírná váha i na „clear air“ uvnitř státu (přepíše OPERA díry)
        clear = fw * np.where((~valid) & (fw > 0.4), 0.35, 0.0)
        layer_w = np.maximum(layer_w, clear)
        nat_vals = np.where(valid, dbz, 0.0)
        acc += nat_vals * layer_w
        wsum += layer_w
        used[source] = {
            "ok": True,
            "time": time_iso or None,
            "ageMin": age,
        }
        if time_iso:
            times.append(time_iso)

    out = np.divide(
        acc,
        wsum,
        out=np.zeros((h, width), dtype=np.float64),
        where=wsum > 1e-6,
    )
    out = np.where(wsum > 1e-6, out, np.nan)
    mosaic_time = None
    if times:
        mosaic_time = max(times)
    return out, {"layers": used, "mosaicTime": mosaic_time}


def main() -> int:
    ap = argparse.ArgumentParser(description="Build national+OPERA radar mosaic PNG")
    ap.add_argument(
        "--sources",
        default="chmi,dwd,shmu,imgw,mch",
        help="National sources to blend",
    )
    ap.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    ap.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
    args = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    raster_path = ROOT / "public" / "data" / "opera" / "latest-raster.json"
    png_path = ROOT / "public" / "data" / "opera" / "latest.png"
    coords = None
    if raster_path.is_file():
        try:
            meta_r = json.loads(raster_path.read_text(encoding="utf-8"))
            coords = meta_r.get("coordinates")
        except (OSError, json.JSONDecodeError):
            coords = None

    # Širší mozaika (DE/PL/CH/SK), ne jen OPERA crop nad ČR
    lon_g, lat_g, coordinates = build_target_grid(None, args.width, args.height)

    # OPERA base from sidecar written by opera_fetch, or empty
    opera = load_opera_base(lon_g, lat_g, png_path, raster_path)
    # If OPERA PNG exists but no sidecar, try to leave opera nan — nationals still work

    nationals: list[tuple[str, np.ndarray, np.ndarray, str]] = []
    for src in [s.strip() for s in args.sources.split(",") if s.strip()]:
        loaded = load_national(src)
        if not loaded:
            continue
        grid, meta, t_iso = loaded
        try:
            sampled = sample_layer_to_grid(grid, meta, lon_g, lat_g)
        except Exception as exc:
            print(f"mosaic: {src} sample failed ({exc})", flush=True)
            continue
        nationals.append((src, sampled, np.ones_like(sampled), t_iso))
        print(
            f"mosaic: {src} ok time={t_iso or '?'} "
            f"finite={int(np.isfinite(sampled).sum())}",
            flush=True,
        )

    if not nationals and not np.isfinite(opera).any():
        print("mosaic: nothing to blend — keep existing PNG", flush=True)
        return 0

    blended, info = blend_layers(opera, nationals, lon_g, lat_g, now)
    save_opera_dbz_sidecar(np.where(np.isfinite(blended), blended, 0.0))

    rgba = _dbz_to_rgba(np.nan_to_num(blended, nan=0.0))
    png_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(png_path, optimize=True)

    mosaic_time = info.get("mosaicTime")
    # fallback: max of layer times already in info; else now
    if not mosaic_time:
        mosaic_time = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    raster_meta = {
        "url": "data/opera/latest.png",
        "coordinates": coordinates,
        "time": _time_str_compact(mosaic_time),
        "minDbz": 18,
        "blurSigma": 0.0,
        "crs": "EPSG:3857",
        "uv": "web-mercator",
        "radarSource": "mosaic",
        "mosaicTime": mosaic_time,
        "layers": info.get("layers"),
        "attribution": [
            s
            for s, v in (info.get("layers") or {}).items()
            if s != "opera" and isinstance(v, dict) and v.get("ok")
        ],
    }
    with open(raster_path, "w", encoding="utf-8") as f:
        json.dump(raster_meta, f, indent=2)

    mosaic_meta_path = ROOT / "public" / "data" / "opera" / "mosaic-meta.json"
    with open(mosaic_meta_path, "w", encoding="utf-8") as f:
        json.dump(raster_meta, f, indent=2)

    print(
        f"mosaic: wrote {png_path.name} time={mosaic_time} "
        f"layers={raster_meta['attribution']}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
