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
MAX_NATIONAL_AGE_MIN = 15.0
# Národní může doplnit / zostřit jádra; OPERA zůstává základ (ukazuje bouřky)
NATIONAL_RAIN_MIN_DBZ = 18.0
OPERA_BASE_WEIGHT = 1.0  # legacy name — blend je max-composite OPERA-first

DEFAULT_BBOX = (5.5, 45.5, 24.5, 55.2)  # DE–PL–CH–SK + CZ
DEFAULT_WIDTH = 1800
DEFAULT_HEIGHT = 1400


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
    filled = np.where(np.isfinite(grid), grid, np.nan).astype(np.float64)
    nan_fill = np.nan_to_num(filled, nan=-999.0)
    sampled = map_coordinates(
        nan_fill,
        [row_2d, col_2d],
        order=0,
        mode="constant",
        cval=-999.0,
        prefilter=False,
    )
    row_i = np.floor(row_2d + 0.5).astype(int)
    col_i = np.floor(col_2d + 0.5).astype(int)
    inb = (row_i >= 0) & (row_i < h) & (col_i >= 0) & (col_i < w)
    src_ok = np.zeros(lon_g.shape, dtype=bool)
    ri = np.clip(row_i, 0, h - 1)
    ci = np.clip(col_i, 0, w - 1)
    src_ok[inb] = np.isfinite(grid[ri[inb], ci[inb]])
    ok = src_ok & (sampled > -900.0)
    return np.where(ok, sampled, np.nan).astype(np.float64)


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
    # Nearest + NaN mimo echo: bilineár přes 0-fill ředí jádra (56→~30 dBZ)
    filled = np.where(np.isfinite(src), src, np.nan).astype(np.float64)
    nan_fill = np.nan_to_num(filled, nan=-999.0)
    sampled = map_coordinates(
        nan_fill,
        [row_2d, col_2d],
        order=0,
        mode="constant",
        cval=-999.0,
        prefilter=False,
    )
    inb = (
        (row_2d >= 0)
        & (row_2d <= h - 1)
        & (col_2d >= 0)
        & (col_2d <= w - 1)
    )
    ok = inb & (sampled > -900.0) & np.isfinite(sampled)
    return np.where(ok, sampled, np.nan).astype(np.float64)


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


def save_mosaic_dbz_sidecar(dbz: np.ndarray) -> None:
    """Mozaikový dBZ — nesmí přepsat OPERA latest-dbz.npy (zdroj pro další blend)."""
    path = ROOT / "public" / "data" / "opera" / "mosaic-dbz.npy"
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
    """
    OPERA first — to je produkt, který umí ukázat bouřky.
    Národní compositý jen doplní / zostří, nikdy OPERA nevymažou.
    """
    out = np.where(np.isfinite(opera), opera.astype(np.float64), np.nan)
    opera_rain = int(np.sum(np.isfinite(out) & (out >= 18.0)))
    opera_max = float(np.nanmax(out)) if np.isfinite(out).any() else float("nan")
    print(
        f"mosaic: OPERA base rain>=18: {opera_rain} maxDbz={opera_max:.1f}",
        flush=True,
    )
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
        # Doplň / zostři — nepřepisuj OPERA clear-air ani undetectem
        nat_rain = valid & (dbz >= NATIONAL_RAIN_MIN_DBZ) & (fw > 0.15)
        take = nat_rain & (~np.isfinite(out) | (dbz > out))
        out = np.where(take, dbz, out)
        used[source] = {
            "ok": True,
            "time": time_iso or None,
            "ageMin": age,
            "painted": int(np.sum(take)),
        }
        if time_iso:
            times.append(time_iso)
        print(
            f"mosaic: {source} painted={int(np.sum(take))}",
            flush=True,
        )

    mosaic_time = None
    if times:
        mosaic_time = max(times)
    # Čas snímku: preferuj OPERA když je čerstvější než národní
    return out, {"layers": used, "mosaicTime": mosaic_time}


def stamp_cell_peaks(
    dbz: np.ndarray,
    lon_g: np.ndarray,
    lat_g: np.ndarray,
    cells_path: Path,
    radius_px: int = 3,
) -> int:
    """
    Doostří existující echo u OPERA peaku — nikdy nevytváří déšť z prázdna
    (to by dělalo falešné Silná vs Windy/SHMÚ).
    """
    if not cells_path.is_file():
        return 0
    try:
        fc = json.loads(cells_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    features = fc.get("features") or []
    if not features:
        return 0

    wgs_to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    h, w = dbz.shape
    corners = [
        (float(lon_g[0, 0]), float(lat_g[0, 0])),
        (float(lon_g[0, -1]), float(lat_g[0, -1])),
        (float(lon_g[-1, -1]), float(lat_g[-1, -1])),
        (float(lon_g[-1, 0]), float(lat_g[-1, 0])),
    ]
    merc = [wgs_to_merc.transform(lon, lat) for lon, lat in corners]
    mx0 = min(p[0] for p in merc)
    mx1 = max(p[0] for p in merc)
    my0 = min(p[1] for p in merc)
    my1 = max(p[1] for p in merc)

    stamped = 0
    yy, xx = np.mgrid[-radius_px : radius_px + 1, -radius_px : radius_px + 1]
    dist = np.sqrt(yy.astype(np.float64) ** 2 + xx.astype(np.float64) ** 2)
    kernel = np.clip(1.0 - dist / max(1.0, radius_px), 0.0, 1.0)

    for feat in features:
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        if props.get("kind") not in (None, "peak"):
            continue
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        peak = props.get("maxDbz")
        if peak is None or not np.isfinite(peak) or float(peak) < 18.0:
            continue
        peak_f = float(peak)
        mx, my = wgs_to_merc.transform(lon, lat)
        col = (mx - mx0) / max(1e-9, mx1 - mx0) * w - 0.5
        row = (my1 - my) / max(1e-9, my1 - my0) * h - 0.5
        ci, ri = int(round(col)), int(round(row))
        if ri < 0 or ri >= h or ci < 0 or ci >= w:
            continue
        # Jen pokud mozaika už má v okolí reálné echo (národní/OPERA shoda)
        r0, r1 = max(0, ri - radius_px), min(h, ri + radius_px + 1)
        c0, c1 = max(0, ci - radius_px), min(w, ci + radius_px + 1)
        neighborhood = dbz[r0:r1, c0:c1]
        if not np.any(np.isfinite(neighborhood) & (neighborhood >= 18.0)):
            continue
        for dy in range(-radius_px, radius_px + 1):
            for dx in range(-radius_px, radius_px + 1):
                r2, c2 = ri + dy, ci + dx
                if r2 < 0 or r2 >= h or c2 < 0 or c2 >= w:
                    continue
                wgt = float(kernel[dy + radius_px, dx + radius_px])
                if wgt <= 0:
                    continue
                cur = dbz[r2, c2]
                if not np.isfinite(cur) or cur < 18.0:
                    continue
                val = max(cur, peak_f * (0.55 + 0.45 * wgt))
                if val > cur:
                    dbz[r2, c2] = val
        stamped += 1
    return stamped


def reconcile_cells_with_mosaic(
    dbz: np.ndarray,
    lon_g: np.ndarray,
    lat_g: np.ndarray,
    cells_path: Path,
    min_support_dbz: float = 28.0,
) -> int:
    """
    Sníží/odstraní OPERA buňky, které mozaika (národní) nepodporuje.
    Jinak UI hlásí Silná 28–46 mm/h, zatímco Windy má 0.3 mm/h.
    """
    if not cells_path.is_file():
        return 0
    try:
        fc = json.loads(cells_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    features = fc.get("features") or []
    if not features:
        return 0

    wgs_to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    h, w = dbz.shape
    corners = [
        (float(lon_g[0, 0]), float(lat_g[0, 0])),
        (float(lon_g[0, -1]), float(lat_g[0, -1])),
        (float(lon_g[-1, -1]), float(lat_g[-1, -1])),
        (float(lon_g[-1, 0]), float(lat_g[-1, 0])),
    ]
    merc = [wgs_to_merc.transform(lon, lat) for lon, lat in corners]
    mx0 = min(p[0] for p in merc)
    mx1 = max(p[0] for p in merc)
    my0 = min(p[1] for p in merc)
    my1 = max(p[1] for p in merc)

    def sample_max(lon: float, lat: float, radius_px: int = 4) -> float:
        mx, my = wgs_to_merc.transform(lon, lat)
        col = (mx - mx0) / max(1e-9, mx1 - mx0) * w - 0.5
        row = (my1 - my) / max(1e-9, my1 - my0) * h - 0.5
        ci, ri = int(round(col)), int(round(row))
        r0, r1 = max(0, ri - radius_px), min(h, ri + radius_px + 1)
        c0, c1 = max(0, ci - radius_px), min(w, ci + radius_px + 1)
        patch = dbz[r0:r1, c0:c1]
        if patch.size == 0 or not np.isfinite(patch).any():
            return float("nan")
        return float(np.nanmax(patch))

    # peak id → mosaic support
    support: dict[str, float] = {}
    for feat in features:
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        if geom.get("type") != "Point" or props.get("kind") != "peak":
            continue
        cid = str(props.get("id") or props.get("cellId") or "")
        coords = geom.get("coordinates") or []
        if len(coords) < 2 or not cid:
            continue
        support[cid] = sample_max(float(coords[0]), float(coords[1]))

    kept: list[Any] = []
    demoted = 0
    for feat in features:
        props = feat.get("properties") or {}
        cid = str(props.get("id") or props.get("cellId") or "")
        mosaic_z = support.get(cid)
        if mosaic_z is None or not np.isfinite(mosaic_z):
            # Bez podpory v mozaice — drop (OPERA ghost)
            if props.get("kind") in ("cell", "peak", "centroid"):
                demoted += 1
                continue
            kept.append(feat)
            continue
        if mosaic_z < 25.0:
            demoted += 1
            continue
        peak = props.get("maxDbz")
        if peak is not None and np.isfinite(peak) and float(peak) > mosaic_z + 5:
            props = dict(props)
            props["maxDbz"] = round(float(mosaic_z), 1)
            props["dbzCappedByMosaic"] = True
            feat = {**feat, "properties": props}
            demoted += 1
        if props.get("kind") == "cell" and mosaic_z < min_support_dbz:
            # Slabá podpora — nechat, ale už s capped dBZ
            pass
        kept.append(feat)

    fc["features"] = kept
    cells_path.write_text(
        json.dumps(fc, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return demoted


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
    # Buňky zůstávají z OPERA tracking — nesmazávat podle národní mozaiky
    save_mosaic_dbz_sidecar(np.where(np.isfinite(blended), blended, 0.0))
    rain_n = int(np.sum(np.isfinite(blended) & (blended >= 18.0)))
    print(
        f"mosaic: blended rain>={18}: {rain_n} "
        f"maxDbz={float(np.nanmax(blended)) if np.isfinite(blended).any() else float('nan'):.1f}",
        flush=True,
    )

    # Když mozaika ztratí OPERA déšť (resample/prázdno), nech OPERA PNG z fetch
    opera_rain = int(np.sum(np.isfinite(opera) & (opera >= 18.0)))
    if opera_rain >= 50 and rain_n < max(20, opera_rain // 4):
        print(
            f"mosaic: WARN keep OPERA PNG — blend too empty "
            f"(opera_rain={opera_rain} blended={rain_n})",
            flush=True,
        )
        return 0

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
