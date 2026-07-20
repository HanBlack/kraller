"""
ČHMÚ radar — přesnější Z a echo top nad ČR + kontury pro mapu.

Stáhne composite maxz (DBZH) a echotop (HGHT), obohatí cells.geojson
a zapíše public/data/chmi/latest.geojson + meta.json.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from html.parser import HTMLParser
from typing import Any

import numpy as np
import requests
from skimage import measure

from odim_io import (
    build_geo,
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
}

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


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.files: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        for k, v in attrs:
            if k == "href" and v and v.endswith(".hdf"):
                self.files.append(v)


def list_latest_hdf(url: str) -> str | None:
    r = requests.get(url, timeout=45)
    r.raise_for_status()
    parser = _LinkParser()
    parser.feed(r.text)
    hdf = [f for f in parser.files if f.endswith(".hdf")]
    return hdf[-1] if hdf else None


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


def contour_coords(
    contour: np.ndarray,
    meta: dict,
    geo: dict,
) -> list[list[float]]:
    coords: list[list[float]] = []
    step_pts = max(1, contour.shape[0] // 60)
    for row_f, col_f in contour[::step_pts]:
        lon, lat = pixel_to_lonlat(float(row_f), float(col_f), meta, geo)
        coords.append([lon, lat])
    if coords and coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def build_contour_features(
    grid: np.ndarray,
    meta: dict,
    geo: dict,
    time_str: str,
) -> list[dict]:
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


def enrich_cells(
    cells_path: str,
    maxz: np.ndarray,
    maxz_meta: dict,
    maxz_geo: dict,
    echotop: np.ndarray,
    echotop_meta: dict,
    echotop_geo: dict,
    time_str: str,
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
            # peak souřadnice doplníme z peak feature později v druhém průchodu
            continue

        if lon is None or lat is None:
            continue
        if not in_cz(float(lon), float(lat)):
            continue

        chmi_dbz = sample_grid_max(
            maxz, float(lon), float(lat), maxz_meta, maxz_geo, radius_px=2
        )
        echo_m = sample_grid(
            echotop, float(lon), float(lat), echotop_meta, echotop_geo
        )

        if chmi_dbz is not None and chmi_dbz >= 20:
            props["chmiDbz"] = round(chmi_dbz, 1)
            props["peakDbz"] = round(chmi_dbz, 1)
            props["dbzSource"] = "CHMI"
            enriched += 1

        if echo_m is not None and echo_m >= 500:
            props["echoTopKm"] = round(echo_m / 1000.0, 2)
            props["echoTopSource"] = "CHMI"

        props["chmiTime"] = time_str
        feat["properties"] = props

    # Druhý průchod — cell polygon features (peak z peak feature)
    peaks: dict[str, tuple[float, float]] = {}
    for feat in fc.get("features") or []:
        props = feat.get("properties") or {}
        if props.get("kind") != "peak":
            continue
        cid = str(props.get("cellId") or props.get("id") or "")
        if not cid or feat.get("geometry", {}).get("type") != "Point":
            continue
        peaks[cid] = tuple(feat["geometry"]["coordinates"])

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

        chmi_dbz = sample_grid_max(maxz, lon, lat, maxz_meta, maxz_geo, radius_px=2)
        echo_m = sample_grid(echotop, lon, lat, echotop_meta, echotop_geo)

        if chmi_dbz is not None and chmi_dbz >= 20:
            props["chmiDbz"] = round(chmi_dbz, 1)
            props["peakDbz"] = round(chmi_dbz, 1)
            props["dbzSource"] = "CHMI"
            enriched += 1

        if echo_m is not None and echo_m >= 500:
            props["echoTopKm"] = round(echo_m / 1000.0, 2)
            props["echoTopSource"] = "CHMI"

        props["chmiTime"] = time_str
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

    maxz, maxz_meta = read_odim_grid(paths["maxz"], "DBZH")
    echotop, echotop_meta = read_odim_grid(paths["echotop"], "HGHT")
    maxz_geo = build_geo(maxz_meta)
    echotop_geo = build_geo(echotop_meta)

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
        )

    meta_out = os.path.join(out_dir, "meta.json")
    meta_doc = {
        "validAt": time_iso,
        "productTime": time_str,
        "source": "CHMI",
        "products": ["maxz", "echotop"],
        "cellsEnriched": enriched,
    }
    with open(meta_out, "w", encoding="utf-8") as f:
        json.dump(meta_doc, f, indent=2)

    print(f"CHMI contours: {len(features)} features -> {radar_out}")
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
