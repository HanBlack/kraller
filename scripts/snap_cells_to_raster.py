#!/usr/bin/env python3
"""Zarovná peaky v cells.geojson na vizuální maximum warped PNG (bez nového OPERA fetch)."""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from opera_fetch_convert import snap_peak_to_warped_raster  # noqa: E402


def alpha_to_dbz_proxy(alpha: np.ndarray) -> np.ndarray:
    """Hrubý odhad dBZ z PNG alfa — stačí pro lokální maximum."""
    a = alpha.astype(np.float64) / 255.0
    dbz = np.where(a <= 0, 0.0, 18.0 + a * 40.0)
    return dbz


def main() -> int:
    root = os.path.join("public", "data", "opera")
    cells_path = os.path.join(root, "cells.geojson")
    raster_path = os.path.join(root, "latest-raster.json")
    png_path = os.path.join(root, "latest.png")

    with open(cells_path, encoding="utf-8") as f:
        fc = json.load(f)
    with open(raster_path, encoding="utf-8") as f:
        raster = json.load(f)

    img = np.array(Image.open(png_path).convert("RGBA"))
    dbz = alpha_to_dbz_proxy(img[:, :, 3])
    coordinates = raster["coordinates"]
    h, w = dbz.shape

    peaks: dict[str, list[float]] = {}
    for feat in fc["features"]:
        props = feat.get("properties") or {}
        if props.get("kind") != "peak":
            continue
        cid = props.get("id") or props.get("cellId")
        if not cid:
            continue
        lon, lat = feat["geometry"]["coordinates"]
        plon, plat = snap_peak_to_warped_raster(dbz, coordinates, lon, lat)
        peaks[cid] = [plon, plat]
        print(f"  {cid}: {lat:.4f},{lon:.4f} -> {plat:.4f},{plon:.4f}")

    for feat in fc["features"]:
        props = feat.get("properties") or {}
        cid = props.get("id") or props.get("cellId")
        if not cid or cid not in peaks:
            continue
        if props.get("kind") in ("peak", "centroid"):
            if feat["geometry"]["type"] == "Point" and props.get("kind") == "peak":
                feat["geometry"]["coordinates"] = peaks[cid]
        if props.get("kind") == "cell":
            hist = props.get("history")
            if hist:
                hist[-1]["peakLon"] = peaks[cid][0]
                hist[-1]["peakLat"] = peaks[cid][1]

    with open(cells_path, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ": "))

    print(f"Snapped {len(peaks)} peaks -> {cells_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
