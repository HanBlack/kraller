"""
ČHMÚ radar — přesnější Z, echo top, PseudoCAPPI (déšť u země) a FCT check.

Stáhne composite maxz + echotop (+ volitelně PseudocAPPI 2 km, FCT_MAX_Z),
obohatí cells.geojson a zapíše public/data/chmi/latest.geojson + meta.json.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import tarfile
from html.parser import HTMLParser
from typing import Any

import numpy as np
import requests
from skimage import measure

from odim_io import (
    build_geo,
    lonlat_to_rowcol,
    nominal_time_iso,
    pixel_to_lonlat,
    read_odim_grid,
    sample_grid,
    sample_grid_max,
)

CHMI_BASE = "https://opendata.chmi.cz/meteorology/weather/radar/composite"
PRODUCTS = {
    "maxz": f"{CHMI_BASE}/maxz/hdf5/",
    "echotop": f"{CHMI_BASE}/echotop/hdf5/",
    "pseudocappi2km": f"{CHMI_BASE}/pseudocappi2km/hdf5/",
}
FCT_MAXZ_URL = f"{CHMI_BASE}/fct_maxz/hdf5/"

# Mírně širší než grid — okolí CZ
CZ_LON = (11.0, 19.8)
CZ_LAT = (48.0, 51.5)

CONTOUR_LEVELS = [30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0]
BAND_FOR = {
    30.0: "light",
    35.0: "echo",
    40.0: "rain",
    45.0: "moderate",
    50.0: "strong",
    55.0: "heavy",
    60.0: "extreme",
}

# FCT +30 min — shoda se stopou (úhel)
FCT_LEAD_MIN = 30
FCT_AGREE_MAX_DEG = 35.0
FCT_SEARCH_RADIUS_PX = 28  # ~28 km
FCT_MIN_DBZ = 25.0


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.files: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        for k, v in attrs:
            if k == "href" and v:
                self.files.append(v)


def list_latest_hdf(url: str) -> str | None:
    r = requests.get(url, timeout=45)
    r.raise_for_status()
    parser = _LinkParser()
    parser.feed(r.text)
    hdf = [f for f in parser.files if f.endswith(".hdf")]
    return hdf[-1] if hdf else None


def list_latest_tar(url: str) -> str | None:
    r = requests.get(url, timeout=45)
    r.raise_for_status()
    parser = _LinkParser()
    parser.feed(r.text)
    tars = [f for f in parser.files if f.endswith(".tar")]
    return tars[-1] if tars else None


def download(url: str, out_path: str) -> None:
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=256 * 1024):
                if chunk:
                    f.write(chunk)


def in_cz(lon: float, lat: float) -> bool:
    return CZ_LON[0] <= lon <= CZ_LON[1] and CZ_LAT[0] <= lat <= CZ_LAT[1]


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlon = math.radians(lon2 - lon1)
    a = math.radians(lat1)
    b = math.radians(lat2)
    y = math.sin(dlon) * math.cos(b)
    x = math.cos(a) * math.sin(b) - math.sin(a) * math.cos(b) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angle_diff_deg(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def destination_lonlat(
    lat: float, lon: float, heading_deg: float, dist_km: float
) -> tuple[float, float]:
    """Přibližný posun (km) — stačí pro FCT okno."""
    R = 6371.0
    br = math.radians(heading_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    lat2 = math.asin(
        math.sin(lat1) * math.cos(dist_km / R)
        + math.cos(lat1) * math.sin(dist_km / R) * math.cos(br)
    )
    lon2 = lon1 + math.atan2(
        math.sin(br) * math.sin(dist_km / R) * math.cos(lat1),
        math.cos(dist_km / R) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), (math.degrees(lon2) + 540.0) % 360.0 - 180.0


def local_max_near(
    grid: np.ndarray,
    lon: float,
    lat: float,
    meta: dict,
    geo: dict,
    *,
    radius_px: int = FCT_SEARCH_RADIUS_PX,
    min_dbz: float = FCT_MIN_DBZ,
) -> tuple[float, float, float] | None:
    """Nejsilnější pixel v okolí — (lon, lat, dbz)."""
    rc = lonlat_to_rowcol(lon, lat, meta, geo)
    if rc is None:
        return None
    r0, c0 = int(round(rc[0])), int(round(rc[1]))
    best: float | None = None
    best_rc: tuple[int, int] | None = None
    for dr in range(-radius_px, radius_px + 1):
        for dc in range(-radius_px, radius_px + 1):
            if dr * dr + dc * dc > radius_px * radius_px:
                continue
            r, c = r0 + dr, c0 + dc
            if r < 0 or c < 0 or r >= grid.shape[0] or c >= grid.shape[1]:
                continue
            val = float(grid[r, c])
            if not np.isfinite(val) or val < min_dbz:
                continue
            if best is None or val > best:
                best = val
                best_rc = (r, c)
    if best is None or best_rc is None:
        return None
    olon, olat = pixel_to_lonlat(float(best_rc[0]), float(best_rc[1]), meta, geo)
    return olon, olat, best


def contour_coords(
    contour: np.ndarray,
    meta: dict,
    geo: dict,
) -> list[list[float]]:
    coords: list[list[float]] = []
    step_pts = max(1, contour.shape[0] // 120)
    for row_f, col_f in contour[::step_pts]:
        lon, lat = pixel_to_lonlat(float(row_f), float(col_f), meta, geo)
        coords.append([lon, lat])
    if len(coords) >= 4:
        coords = _chaikin_closed(coords, iterations=1)
    if coords and coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def _chaikin_closed(ring: list[list[float]], iterations: int = 1) -> list[list[float]]:
    pts = ring[:-1] if ring and ring[0] == ring[-1] else list(ring)
    if len(pts) < 3:
        return ring
    for _ in range(iterations):
        nxt: list[list[float]] = []
        n = len(pts)
        for i in range(n):
            a = pts[i]
            b = pts[(i + 1) % n]
            nxt.append([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]])
            nxt.append([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]])
        pts = nxt
    return pts


def build_contour_features(
    grid: np.ndarray,
    meta: dict,
    geo: dict,
    time_str: str,
) -> list[dict]:
    """Nested ≥ prahy — celistvá skvrna (prstence na slabém echu = pilulky)."""
    features: list[dict] = []
    for lvl in CONTOUR_LEVELS:
        mask = np.isfinite(grid) & (grid >= lvl)
        if not mask.any():
            continue
        contours = measure.find_contours(mask.astype(float), 0.5)
        for c in contours:
            if c.shape[0] < 8:
                continue
            coords = contour_coords(c, meta, geo)
            if len(coords) < 4:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "band": BAND_FOR[lvl],
                        "dbz": lvl,
                        "source": "CHMI",
                        "time": time_str,
                    },
                    "geometry": {"type": "Polygon", "coordinates": [coords]},
                }
            )
    return features


def fetch_optional_hdf(product: str, base_url: str, cache_dir: str) -> str | None:
    try:
        fname = list_latest_hdf(base_url)
        if not fname:
            print(f"CHMI {product}: žádný HDF — přeskočeno", flush=True)
            return None
        local = os.path.join(cache_dir, fname)
        if not os.path.isfile(local):
            print(f"Downloading CHMI {product}: {fname}", flush=True)
            download(base_url + fname, local)
        else:
            print(f"Using cached CHMI {product}: {fname}", flush=True)
        return local
    except Exception as e:
        print(f"CHMI {product}: chyba ({e}) — přeskočeno", flush=True)
        return None


def fetch_fct_ft30(cache_dir: str) -> str | None:
    """Stáhne TAR FCT_MAX_Z a vrátí cestu k +30 min HDF."""
    try:
        fname = list_latest_tar(FCT_MAXZ_URL)
        if not fname:
            print("CHMI fct_maxz: žádný TAR — přeskočeno", flush=True)
            return None
        tar_path = os.path.join(cache_dir, fname)
        if not os.path.isfile(tar_path):
            print(f"Downloading CHMI fct_maxz: {fname}", flush=True)
            download(FCT_MAXZ_URL + fname, tar_path)
        else:
            print(f"Using cached CHMI fct_maxz: {fname}", flush=True)

        extract_dir = os.path.join(cache_dir, "fct", os.path.splitext(fname)[0])
        os.makedirs(extract_dir, exist_ok=True)
        ft30: str | None = None
        with tarfile.open(tar_path, "r") as tar:
            for m in tar.getmembers():
                base = os.path.basename(m.name)
                if not base.endswith(f"_ft{FCT_LEAD_MIN}.hdf"):
                    continue
                out = os.path.join(extract_dir, base)
                if not os.path.isfile(out):
                    src = tar.extractfile(m)
                    if src is None:
                        continue
                    with open(out, "wb") as f:
                        f.write(src.read())
                ft30 = out
                break
        if not ft30:
            print("CHMI fct_maxz: v TAR chybí ft30 — přeskočeno", flush=True)
            return None
        return ft30
    except Exception as e:
        print(f"CHMI fct_maxz: chyba ({e}) — přeskočeno", flush=True)
        return None


def apply_enrichment(
    props: dict[str, Any],
    lon: float,
    lat: float,
    *,
    maxz: np.ndarray,
    maxz_meta: dict,
    maxz_geo: dict,
    echotop: np.ndarray,
    echotop_meta: dict,
    echotop_geo: dict,
    surface: np.ndarray | None,
    surface_meta: dict | None,
    surface_geo: dict | None,
    fct: np.ndarray | None,
    fct_meta: dict | None,
    fct_geo: dict | None,
    time_str: str,
) -> bool:
    """Obohatí props na peaku. Vrací True pokud přidal nějaké ČHMÚ pole."""
    touched = False

    chmi_dbz = sample_grid_max(maxz, lon, lat, maxz_meta, maxz_geo, radius_px=2)
    echo_m = sample_grid(echotop, lon, lat, echotop_meta, echotop_geo)

    if chmi_dbz is not None and chmi_dbz >= 20:
        props["chmiDbz"] = round(chmi_dbz, 1)
        opera = float(props.get("maxDbz") or 0)
        # Nikdy nesnižovat OPERA max — ČHMÚ sample může minout jádro / být starší.
        peak = max(chmi_dbz, opera) if opera > 0 else chmi_dbz
        props["peakDbz"] = round(peak, 1)
        props["dbzSource"] = "CHMI" if chmi_dbz >= opera else "OPERA-ORD"
        touched = True

    if echo_m is not None and echo_m >= 500:
        props["echoTopKm"] = round(echo_m / 1000.0, 2)
        props["echoTopSource"] = "CHMI"
        touched = True

    if surface is not None and surface_meta is not None and surface_geo is not None:
        surf = sample_grid_max(
            surface, lon, lat, surface_meta, surface_geo, radius_px=2
        )
        if surf is not None and surf >= 15:
            props["chmiSurfaceDbz"] = round(surf, 1)
            touched = True

    if fct is not None and fct_meta is not None and fct_geo is not None:
        our_h = props.get("trackHeadingDeg")
        our_s = props.get("trackSpeedKmh")
        # Predikovaná pozice naší stopy za +30 min (nebo jen okolí peaku)
        search_lon, search_lat = lon, lat
        if isinstance(our_h, (int, float)) and isinstance(our_s, (int, float)):
            if float(our_s) >= 5:
                dist_km = float(our_s) * (FCT_LEAD_MIN / 60.0)
                plat, plon = destination_lonlat(lat, lon, float(our_h), dist_km)
                search_lat, search_lon = plat, plon

        hit = local_max_near(
            fct, search_lon, search_lat, fct_meta, fct_geo
        )
        if hit is not None:
            flon, flat, fdbz = hit
            fct_h = bearing_deg(lat, lon, flat, flon)
            props["chmiFctHeadingDeg"] = round(fct_h, 1)
            props["chmiFctDbz"] = round(fdbz, 1)
            props["chmiFctPeakLon"] = round(flon, 4)
            props["chmiFctPeakLat"] = round(flat, 4)
            props["chmiFctLeadMin"] = FCT_LEAD_MIN
            touched = True
            if isinstance(our_h, (int, float)):
                diff = angle_diff_deg(float(our_h), fct_h)
                props["chmiFctAngleDiffDeg"] = round(diff, 1)
                props["chmiFctAgree"] = bool(diff <= FCT_AGREE_MAX_DEG)

    props["chmiTime"] = time_str
    return touched


def enrich_cells(
    cells_path: str,
    maxz: np.ndarray,
    maxz_meta: dict,
    maxz_geo: dict,
    echotop: np.ndarray,
    echotop_meta: dict,
    echotop_geo: dict,
    time_str: str,
    *,
    surface: np.ndarray | None = None,
    surface_meta: dict | None = None,
    surface_geo: dict | None = None,
    fct: np.ndarray | None = None,
    fct_meta: dict | None = None,
    fct_geo: dict | None = None,
) -> int:
    with open(cells_path, encoding="utf-8") as f:
        fc = json.load(f)

    enriched = 0
    for feat in fc.get("features") or []:
        props = feat.get("properties") or {}
        kind = props.get("kind")
        if kind not in ("cell", "peak"):
            continue

        lon = lat = None
        if feat.get("geometry", {}).get("type") == "Point":
            lon, lat = feat["geometry"]["coordinates"]
        elif kind == "cell" and props.get("id"):
            continue

        if lon is None or lat is None:
            continue
        if not in_cz(float(lon), float(lat)):
            continue

        if apply_enrichment(
            props,
            float(lon),
            float(lat),
            maxz=maxz,
            maxz_meta=maxz_meta,
            maxz_geo=maxz_geo,
            echotop=echotop,
            echotop_meta=echotop_meta,
            echotop_geo=echotop_geo,
            surface=surface,
            surface_meta=surface_meta,
            surface_geo=surface_geo,
            fct=fct,
            fct_meta=fct_meta,
            fct_geo=fct_geo,
            time_str=time_str,
        ):
            enriched += 1
        feat["properties"] = props

    # Druhý průchod — cell polygon features (peak z peak feature)
    peaks: dict[str, tuple[float, float]] = {}
    peak_track: dict[str, dict[str, Any]] = {}
    for feat in fc.get("features") or []:
        props = feat.get("properties") or {}
        if props.get("kind") != "peak":
            continue
        cid = str(props.get("cellId") or props.get("id") or "")
        if not cid or feat.get("geometry", {}).get("type") != "Point":
            continue
        peaks[cid] = tuple(feat["geometry"]["coordinates"])
        peak_track[cid] = {
            "trackHeadingDeg": props.get("trackHeadingDeg"),
            "trackSpeedKmh": props.get("trackSpeedKmh"),
        }

    for feat in fc.get("features") or []:
        props = feat.get("properties") or {}
        if props.get("kind") != "cell":
            continue
        cid = str(props.get("id") or "")
        peak = peaks.get(cid)
        if not peak:
            continue
        lon, lat = peak
        if not in_cz(lon, lat):
            continue

        # track z peak / cell props
        tr = peak_track.get(cid) or {}
        if props.get("trackHeadingDeg") is None and tr.get("trackHeadingDeg") is not None:
            props["trackHeadingDeg"] = tr["trackHeadingDeg"]
        if props.get("trackSpeedKmh") is None and tr.get("trackSpeedKmh") is not None:
            props["trackSpeedKmh"] = tr["trackSpeedKmh"]

        if apply_enrichment(
            props,
            lon,
            lat,
            maxz=maxz,
            maxz_meta=maxz_meta,
            maxz_geo=maxz_geo,
            echotop=echotop,
            echotop_meta=echotop_meta,
            echotop_geo=echotop_geo,
            surface=surface,
            surface_meta=surface_meta,
            surface_geo=surface_geo,
            fct=fct,
            fct_meta=fct_meta,
            fct_geo=fct_geo,
            time_str=time_str,
        ):
            enriched += 1
        feat["properties"] = props

    with open(cells_path, "w", encoding="utf-8") as f:
        json.dump(fc, f)

    return enriched


def run(
    *,
    cells_path: str,
    out_dir: str,
    cache_dir: str,
) -> dict[str, Any]:
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)

    paths: dict[str, str] = {}
    for product, base_url in PRODUCTS.items():
        if product == "pseudocappi2km":
            local = fetch_optional_hdf(product, base_url, cache_dir)
            if local:
                paths[product] = local
            continue
        fname = list_latest_hdf(base_url)
        if not fname:
            raise RuntimeError(f"No CHMI {product} HDF5 found")
        local = os.path.join(cache_dir, fname)
        url = base_url + fname
        if not os.path.isfile(local):
            print(f"Downloading CHMI {product}: {fname}")
            download(url, local)
        else:
            print(f"Using cached CHMI {product}: {fname}")
        paths[product] = local

    fct_path = fetch_fct_ft30(cache_dir)

    maxz, maxz_meta = read_odim_grid(paths["maxz"], "DBZH")
    echotop, echotop_meta = read_odim_grid(paths["echotop"], "HGHT")
    maxz_geo = build_geo(maxz_meta)
    echotop_geo = build_geo(echotop_meta)

    surface = surface_meta = surface_geo = None
    if "pseudocappi2km" in paths:
        surface, surface_meta = read_odim_grid(paths["pseudocappi2km"], "DBZH")
        surface_geo = build_geo(surface_meta)

    fct = fct_meta = fct_geo = None
    if fct_path:
        fct, fct_meta = read_odim_grid(fct_path, "DBZH")
        fct_geo = build_geo(fct_meta)

    time_iso = nominal_time_iso(maxz_meta) or nominal_time_iso(echotop_meta)
    time_str = (
        time_iso.replace("-", "").replace(":", "").replace("T", "").replace("Z", "")
        if time_iso
        else ""
    )
    if len(time_str) >= 14:
        time_str = time_str[:14]

    features = build_contour_features(maxz, maxz_meta, maxz_geo, time_str)
    radar_out = os.path.join(out_dir, "latest.geojson")
    with open(radar_out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)

    products_used = ["maxz", "echotop"]
    if surface is not None:
        products_used.append("pseudocappi2km")
    if fct is not None:
        products_used.append(f"fct_maxz_ft{FCT_LEAD_MIN}")

    enriched = 0
    if os.path.isfile(cells_path):
        enriched = enrich_cells(
            cells_path,
            maxz,
            maxz_meta,
            maxz_geo,
            echotop,
            echotop_meta,
            echotop_geo,
            time_str,
            surface=surface,
            surface_meta=surface_meta,
            surface_geo=surface_geo,
            fct=fct,
            fct_meta=fct_meta,
            fct_geo=fct_geo,
        )

    meta_out = os.path.join(out_dir, "meta.json")
    meta_doc = {
        "validAt": time_iso,
        "productTime": time_str,
        "source": "CHMI",
        "products": products_used,
        "cellsEnriched": enriched,
    }
    with open(meta_out, "w", encoding="utf-8") as f:
        json.dump(meta_doc, f, indent=2)

    print(f"CHMI contours: {len(features)} features -> {radar_out}")
    print(f"CHMI products: {', '.join(products_used)}")
    print(f"CHMI enriched {enriched} cell(s) in {cells_path}")
    return meta_doc


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch CHMI radar and enrich cells")
    ap.add_argument(
        "--cells",
        default=os.path.join("public", "data", "opera", "cells.geojson"),
    )
    ap.add_argument(
        "--out-dir",
        default=os.path.join("public", "data", "chmi"),
    )
    ap.add_argument("--cache", default=os.path.join(".cache", "chmi"))
    args = ap.parse_args()
    run(cells_path=args.cells, out_dir=args.out_dir, cache_dir=args.cache)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
