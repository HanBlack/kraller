import argparse
import datetime as dt
import json
import math
import os
import re
import xml.etree.ElementTree as ET

import h5py
import numpy as np
import requests
from pyproj import Transformer
from scipy.ndimage import center_of_mass, gaussian_filter, label, map_coordinates
from skimage import measure
from PIL import Image

S3_ENDPOINT = "https://s3.waw3-1.cloudferro.com"
BUCKET = "openradar-24h"

CZ_BBOX = (12.0, 48.5, 19.0, 51.1)


def s3_list(prefix: str) -> list[str]:
    url = f"{S3_ENDPOINT}/{BUCKET}"
    params = {"list-type": "2", "prefix": prefix}
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    ns = {"s3": root.tag.split("}")[0].strip("{")} if "}" in root.tag else {}
    keys: list[str] = []
    tag = ".//s3:Contents" if ns else ".//Contents"
    key_tag = "s3:Key" if ns else "Key"
    for contents in root.findall(tag, ns):
        k_el = contents.find(key_tag, ns) if ns else contents.find(key_tag)
        if k_el is not None and k_el.text:
            keys.append(k_el.text)
    return keys


def s3_download(key: str, out_path: str) -> None:
    url = f"{S3_ENDPOINT}/{BUCKET}/{key}"
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if chunk:
                    f.write(chunk)


def find_latest_opera_dbzh_key(date: dt.date) -> str:
    prefix = f"{date:%Y/%m/%d}/OPERA/COMP/"
    keys = s3_list(prefix)
    candidates = [k for k in keys if k.endswith("DBZH.h5") and "OPERA@" in k]
    if not candidates:
        raise RuntimeError(f"No DBZH.h5 found under prefix {prefix}")
    candidates.sort()
    return candidates[-1]


def list_opera_dbzh_keys(date: dt.date) -> list[str]:
    prefix = f"{date:%Y/%m/%d}/OPERA/COMP/"
    keys = s3_list(prefix)
    candidates = [k for k in keys if k.endswith("DBZH.h5") and "OPERA@" in k]
    candidates.sort()
    return candidates


def _attr_str(val) -> str:
    if isinstance(val, bytes):
        return val.decode("utf-8", "ignore")
    return str(val)


def read_odim_dbzh(path: str) -> tuple[np.ndarray, dict]:
    with h5py.File(path, "r") as f:
        chosen = None
        for ds_name in f.keys():
            if not re.match(r"dataset\d+", ds_name):
                continue
            for data_name in f[ds_name].keys():
                if not re.match(r"data\d+", data_name):
                    continue
                what_path = f"{ds_name}/{data_name}/what"
                if what_path not in f:
                    continue
                what = f[what_path]
                qty = _attr_str(what.attrs.get("quantity", "")).strip().upper()
                if qty == "DBZH":
                    chosen = (ds_name, data_name)
                    break
            if chosen:
                break

        if not chosen:
            raise RuntimeError("Could not find DBZH dataset in ODIM file")

        ds_name, data_name = chosen
        data = f[f"{ds_name}/{data_name}/data"][()].astype(np.float32)
        what = f[f"{ds_name}/{data_name}/what"]

        nodata = float(what.attrs.get("nodata", -9999))
        undetect = float(what.attrs.get("undetect", -8888))
        data[data == nodata] = np.nan
        data[data == undetect] = np.nan
        gain = float(what.attrs.get("gain", 1.0))
        offset = float(what.attrs.get("offset", 0.0))
        dbz = offset + gain * data

        where = f.get("where") or f.get(f"{ds_name}/where")
        if where is None:
            raise RuntimeError("Missing /where georeferencing")

        meta: dict = {
            "gain": gain,
            "offset": offset,
            "shape": dbz.shape,
            "xsize": int(where.attrs["xsize"]),
            "ysize": int(where.attrs["ysize"]),
            "xscale": float(where.attrs.get("xscale", 1000)),
            "yscale": float(where.attrs.get("yscale", 1000)),
        }
        for corner in ["UL", "UR", "LL", "LR"]:
            meta[f"{corner}_lon"] = float(where.attrs[f"{corner}_lon"])
            meta[f"{corner}_lat"] = float(where.attrs[f"{corner}_lat"])

        if "projdef" in where.attrs:
            meta["projdef"] = _attr_str(where.attrs["projdef"])

        if "what" in f:
            for k in ["date", "time"]:
                if k in f["what"].attrs:
                    meta[k] = _attr_str(f["what"].attrs[k])

        return dbz, meta


def _build_geo(meta: dict) -> tuple[Transformer, dict]:
    """Přesný převod pixel → WGS84 přes LAEA (ne bilinear v lat/lon)."""
    wgs_to_proj = Transformer.from_crs(
        "EPSG:4326",
        meta["projdef"],
        always_xy=True,
    )
    proj_to_wgs = Transformer.from_crs(
        meta["projdef"],
        "EPSG:4326",
        always_xy=True,
    )

    ul_x, ul_y = wgs_to_proj.transform(meta["UL_lon"], meta["UL_lat"])
    ur_x, ur_y = wgs_to_proj.transform(meta["UR_lon"], meta["UR_lat"])
    ll_x, ll_y = wgs_to_proj.transform(meta["LL_lon"], meta["LL_lat"])
    lr_x, lr_y = wgs_to_proj.transform(meta["LR_lon"], meta["LR_lat"])

    geo = {
        "proj_to_wgs": proj_to_wgs,
        "ul": (ul_x, ul_y),
        "ur": (ur_x, ur_y),
        "ll": (ll_x, ll_y),
        "lr": (lr_x, lr_y),
        "xscale": meta["xscale"],
        "yscale": meta["yscale"],
    }
    return proj_to_wgs, geo


def parse_nominal_time(meta: dict) -> dt.datetime:
    date_s = str(meta.get("date", ""))
    time_s = str(meta.get("time", ""))
    if len(time_s) == 4:
        time_s = f"{time_s}00"
    elif len(time_s) == 5:
        time_s = f"0{time_s}" if len(time_s) < 6 else time_s
    if len(time_s) < 6:
        time_s = (time_s + "000000")[:6]
    return dt.datetime.strptime(f"{date_s}{time_s}", "%Y%m%d%H%M%S")


def opera_time_str(meta: dict) -> str:
    """Vždy YYYYMMDDHHMMSS (14 znaků) — kvůli meta.operaTime a historii."""
    return parse_nominal_time(meta).strftime("%Y%m%d%H%M%S")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def heading_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def pixel_to_lonlat(row: float, col: float, meta: dict, geo: dict) -> tuple[float, float]:
    xsize = meta["xsize"]
    ysize = meta["ysize"]

    # Preferuj xscale/yscale od UL rohu (přesnější než bilinear v lat/lon)
    ul_x, ul_y = geo["ul"]
    x = ul_x + (col + 0.5) * geo["xscale"]
    y = ul_y - (row + 0.5) * geo["yscale"]

    lon, lat = geo["proj_to_wgs"].transform(x, y)
    return float(lon), float(lat)


def find_cz_pixel_bounds(meta: dict, geo: dict, step: int = 12) -> tuple[int, int, int, int]:
    rows: list[int] = []
    cols: list[int] = []
    for row in range(0, meta["ysize"], step):
        for col in range(0, meta["xsize"], step):
            lon, lat = pixel_to_lonlat(row, col, meta, geo)
            if CZ_BBOX[0] <= lon <= CZ_BBOX[2] and CZ_BBOX[1] <= lat <= CZ_BBOX[3]:
                rows.append(row)
                cols.append(col)
    if not rows:
        raise RuntimeError("Could not locate Czechia in OPERA grid")
    margin = 50
    return (
        max(0, min(rows) - margin),
        min(meta["ysize"] - 1, max(rows) + margin),
        max(0, min(cols) - margin),
        min(meta["xsize"] - 1, max(cols) + margin),
    )


def contour_coords(
    contour: np.ndarray,
    r0: int,
    c0: int,
    meta: dict,
    geo: dict,
    scale: float = 1.0,
) -> list[list[float]]:
    """Hustší vzorkování (~120 bodů) + Chaikin → méně hranaté, pořád přesné kontury."""
    coords: list[list[float]] = []
    step_pts = max(1, contour.shape[0] // 120)
    for row_f, col_f in contour[::step_pts]:
        row_px = r0 + row_f * scale
        col_px = c0 + col_f * scale
        lon, lat = pixel_to_lonlat(row_px, col_px, meta, geo)
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


# Profesionální radarová paleta (RainViewer-ish) — spojité RGB, ne kontury.
_DBZ_STOPS = np.array([18, 25, 30, 35, 40, 45, 50, 55, 60, 65, 75], dtype=np.float64)
_DBZ_RGB = np.array(
    [
        [35, 50, 120],
        [40, 90, 210],
        [25, 175, 210],
        [20, 200, 85],
        [170, 230, 30],
        [255, 230, 25],
        [255, 145, 15],
        [245, 40, 35],
        [220, 20, 130],
        [195, 35, 220],
        [255, 210, 255],
    ],
    dtype=np.float64,
)


def _dbz_to_rgba(dbz: np.ndarray) -> np.ndarray:
    """Spojité barvy + silnější alfa — echo musí jít dobře číst na mapě."""
    z = np.nan_to_num(dbz, nan=0.0).astype(np.float64)
    rgb = np.zeros(z.shape + (3,), dtype=np.float64)
    for c in range(3):
        rgb[..., c] = np.interp(z, _DBZ_STOPS, _DBZ_RGB[:, c])

    alpha = np.zeros_like(z, dtype=np.float64)
    # Silnější než dřív — soft déšť i jádra musí být vidět přes basemap
    soft = (z >= 18) & (z < 28)
    mid = (z >= 28) & (z < 45)
    hard = z >= 45
    alpha[soft] = 0.28 + 0.42 * ((z[soft] - 18) / 10.0)
    alpha[mid] = 0.72 + 0.16 * ((z[mid] - 28) / 17.0)
    alpha[hard] = np.clip(0.90 + 0.10 * ((z[hard] - 45) / 25.0), 0.0, 0.98)
    alpha[z < 18] = 0.0

    out = np.zeros(z.shape + (4,), dtype=np.uint8)
    out[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    return out


def crop_corner_coordinates(frame: dict) -> list[list[float]]:
    """4 rohy cropu v WGS84 (pro bbox; MapLibre image chce obdélník — viz warp)."""
    r0, r1, c0, c1 = frame["bounds"]
    meta = frame["meta"]
    geo = frame["geo"]
    tl = pixel_to_lonlat(r0 - 0.5, c0 - 0.5, meta, geo)
    tr = pixel_to_lonlat(r0 - 0.5, c1 + 0.5, meta, geo)
    br = pixel_to_lonlat(r1 + 0.5, c1 + 0.5, meta, geo)
    bl = pixel_to_lonlat(r1 + 0.5, c0 - 0.5, meta, geo)
    return [
        [tl[0], tl[1]],
        [tr[0], tr[1]],
        [br[0], br[1]],
        [bl[0], bl[1]],
    ]


def warp_crop_to_web_mercator(
    frame: dict,
    blur_sigma: float = 0.9,
) -> tuple[np.ndarray, list[list[float]]]:
    """
    LAEA crop → grid lineární ve Web Mercator (EPSG:3857).

    MapLibre image source mapuje texturu bilineárně v mercator prostoru.
    Equirectangular (lineární lat) PNG → jádra systematicky ujíždějí od peaků.
    """
    crop = frame["crop"].astype(np.float64)
    h, w = crop.shape
    r0, _, c0, _ = frame["bounds"]
    meta = frame["meta"]
    geo = frame["geo"]
    ul_x, ul_y = geo["ul"]
    xscale = float(geo["xscale"])
    yscale = float(geo["yscale"])

    filled = np.where(np.isfinite(crop), crop, 0.0)
    if blur_sigma > 0:
        filled = gaussian_filter(filled, sigma=blur_sigma, mode="nearest")
        filled = np.where(np.isfinite(crop) & (crop >= 15), filled, 0.0)

    corners = crop_corner_coordinates(frame)
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    west, east = min(lons), max(lons)
    south, north = min(lats), max(lats)

    wgs_to_merc = Transformer.from_crs(
        "EPSG:4326", "EPSG:3857", always_xy=True
    )
    merc_to_wgs = Transformer.from_crs(
        "EPSG:3857", "EPSG:4326", always_xy=True
    )
    wgs_to_laea = Transformer.from_crs(
        "EPSG:4326",
        meta["projdef"],
        always_xy=True,
    )

    corner_ll = [
        (west, north),
        (east, north),
        (east, south),
        (west, south),
    ]
    merc_xy = [wgs_to_merc.transform(lon, lat) for lon, lat in corner_ll]
    mx_left = min(p[0] for p in merc_xy)
    mx_right = max(p[0] for p in merc_xy)
    my_bot = min(p[1] for p in merc_xy)
    my_top = max(p[1] for p in merc_xy)

    out_w = max(32, w)
    out_h = max(32, h)
    mx_1d = mx_left + (np.arange(out_w, dtype=np.float64) + 0.5) / out_w * (
        mx_right - mx_left
    )
    # řádek 0 = sever = větší mercator Y
    my_1d = my_top - (np.arange(out_h, dtype=np.float64) + 0.5) / out_h * (
        my_top - my_bot
    )
    mx_grid, my_grid = np.meshgrid(mx_1d, my_1d)
    lon_grid, lat_grid = merc_to_wgs.transform(mx_grid, my_grid)

    px, py = wgs_to_laea.transform(lon_grid, lat_grid)
    col_full = (np.asarray(px, dtype=np.float64) - ul_x) / xscale - 0.5
    row_full = (ul_y - np.asarray(py, dtype=np.float64)) / yscale - 0.5
    row_c = row_full - r0
    col_c = col_full - c0

    sampled = map_coordinates(
        filled,
        [row_c, col_c],
        order=1,
        mode="constant",
        cval=0.0,
        prefilter=False,
    )
    valid = (
        (row_c >= 0)
        & (row_c <= h - 1)
        & (col_c >= 0)
        & (col_c <= w - 1)
    )
    sampled = np.where(valid, sampled, 0.0)

    # Rohy pořád v lon/lat — MapLibre je převede do mercator stejně jako náš grid
    coordinates = [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
    ]
    return sampled, coordinates


def _mercator_pixel_from_lonlat(
    lon: float,
    lat: float,
    coordinates: list[list[float]],
    width: int,
    height: int,
) -> tuple[float, float]:
    wgs_to_merc = Transformer.from_crs(
        "EPSG:4326", "EPSG:3857", always_xy=True
    )
    mx, my = wgs_to_merc.transform(lon, lat)
    mercs = [wgs_to_merc.transform(c[0], c[1]) for c in coordinates]
    mx_left = min(p[0] for p in mercs)
    mx_right = max(p[0] for p in mercs)
    my_bot = min(p[1] for p in mercs)
    my_top = max(p[1] for p in mercs)
    u = (mx - mx_left) / max(1e-9, mx_right - mx_left)
    v = (my_top - my) / max(1e-9, my_top - my_bot)
    return u * width, v * height


def _lonlat_from_mercator_pixel(
    px: float,
    py: float,
    coordinates: list[list[float]],
    width: int,
    height: int,
) -> tuple[float, float]:
    wgs_to_merc = Transformer.from_crs(
        "EPSG:4326", "EPSG:3857", always_xy=True
    )
    merc_to_wgs = Transformer.from_crs(
        "EPSG:3857", "EPSG:4326", always_xy=True
    )
    mercs = [wgs_to_merc.transform(c[0], c[1]) for c in coordinates]
    mx_left = min(p[0] for p in mercs)
    mx_right = max(p[0] for p in mercs)
    my_bot = min(p[1] for p in mercs)
    my_top = max(p[1] for p in mercs)
    u = (px + 0.5) / max(1, width)
    v = (py + 0.5) / max(1, height)
    mx = mx_left + u * (mx_right - mx_left)
    my = my_top - v * (my_top - my_bot)
    lon, lat = merc_to_wgs.transform(mx, my)
    return float(lon), float(lat)


def snap_peak_to_warped_raster(
    dbz: np.ndarray,
    coordinates: list[list[float]],
    peak_lon: float,
    peak_lat: float,
    search_radius: int = 20,
    min_dbz: float = 28.0,
) -> tuple[float, float]:
    """Posune peak na vizuální maximum warped PNG (MapLibre mercator UV)."""
    h, w = dbz.shape
    px, py = _mercator_pixel_from_lonlat(peak_lon, peak_lat, coordinates, w, h)
    cx, cy = int(round(px)), int(round(py))
    r = search_radius
    x0, x1 = max(0, cx - r), min(w, cx + r + 1)
    y0, y1 = max(0, cy - r), min(h, cy + r + 1)
    sub = dbz[y0:y1, x0:x1]
    if sub.size == 0 or float(np.nanmax(sub)) < min_dbz:
        return peak_lon, peak_lat
    ly, lx = np.unravel_index(int(np.nanargmax(sub)), sub.shape)
    snap_px = x0 + lx
    snap_py = y0 + ly
    return _lonlat_from_mercator_pixel(snap_px, snap_py, coordinates, w, h)


def write_radar_raster(
    frame: dict,
    png_path: str,
    meta_path: str,
    blur_sigma: float = 0.9,
) -> dict:
    """PNG heatmap v Web Mercator UV — peaky sedí ve vizuálním jádru."""
    dbz_ll, coordinates = warp_crop_to_web_mercator(
        frame, blur_sigma=blur_sigma
    )
    rgba = _dbz_to_rgba(dbz_ll)
    os.makedirs(os.path.dirname(png_path) or ".", exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(png_path, optimize=True)
    # Sidecar jen pro live latest.png (mozaika), ne do history/
    base = os.path.basename(png_path).lower()
    if base == "latest.png":
        try:
            npy_path = os.path.join(os.path.dirname(png_path) or ".", "latest-dbz.npy")
            np.save(npy_path, dbz_ll.astype(np.float32))
        except OSError as exc:
            print(f"WARN: could not write latest-dbz.npy ({exc})", flush=True)

    rel_png = png_path.replace("\\", "/")
    if "public/" in rel_png:
        rel_png = rel_png.split("public/", 1)[1]
    elif not rel_png.startswith("data/"):
        rel_png = f"data/opera/{os.path.basename(png_path)}"

    meta_out = {
        "url": rel_png,
        "coordinates": coordinates,
        "time": frame["time_str"],
        "minDbz": 18,
        "blurSigma": blur_sigma,
        "crs": "EPSG:3857",
        "uv": "web-mercator",
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_out, f, indent=2)
    print(
        f"Radar raster (WebMercator UV): {png_path} "
        f"({rgba.shape[1]}x{rgba.shape[0]})"
    )
    return meta_out


def track_cells(
    crop: np.ndarray,
    r0: int,
    c0: int,
    meta: dict,
    geo: dict,
    min_dbz: float = 35.0,
    min_area: int = 8,
) -> list[dict]:
    """Segmentace buněk + epicentrum = argmax dBZ uvnitř buňky.
    min_area=8 zachytí i malý začátek echa (zrod přeháňky/bouřky).
    """
    mask = np.isfinite(crop) & (crop >= min_dbz)
    labeled, n = label(mask)
    cells: list[dict] = []

    for cell_id in range(1, n + 1):
        cell_mask = labeled == cell_id
        area = int(cell_mask.sum())
        if area < min_area:
            continue

        masked = np.where(cell_mask, crop, -np.inf)
        peak_flat = int(np.nanargmax(masked))
        peak_r, peak_c = np.unravel_index(peak_flat, crop.shape)
        max_dbz = float(crop[peak_r, peak_c])

        peak_lon, peak_lat = pixel_to_lonlat(r0 + peak_r, c0 + peak_c, meta, geo)
        cy, cx = center_of_mass(cell_mask)
        cen_lon, cen_lat = pixel_to_lonlat(r0 + cy, c0 + cx, meta, geo)

        # Obrys buňky (>= min_dbz)
        contours = measure.find_contours(cell_mask.astype(float), 0.5)
        if not contours:
            continue
        outline = max(contours, key=lambda c: c.shape[0])
        polygon = contour_coords(outline, r0, c0, meta, geo, scale=1.0)
        if len(polygon) < 4:
            continue

        cells.append(
            {
                "id": f"cell-{cell_id}",
                "maxDbz": round(max_dbz, 1),
                "areaPx": area,
                "peakLon": peak_lon,
                "peakLat": peak_lat,
                "centroidLon": cen_lon,
                "centroidLat": cen_lat,
                "polygon": polygon,
            }
        )

    cells.sort(key=lambda c: c["maxDbz"], reverse=True)
    return cells


def build_frame(dbz: np.ndarray, meta: dict) -> dict:
    _, geo = _build_geo(meta)
    r0, r1, c0, c1 = find_cz_pixel_bounds(meta, geo)
    crop = dbz[r0 : r1 + 1, c0 : c1 + 1]
    cells = track_cells(crop, r0, c0, meta, geo)
    return {
        "meta": meta,
        "geo": geo,
        "crop": crop,
        "bounds": (r0, r1, c0, c1),
        "time": parse_nominal_time(meta),
        "time_str": opera_time_str(meta),
        "cells": cells,
    }


def track_cells_over_time(frames: list[dict]) -> list[dict]:
    if not frames:
        return []

    latest_idx = len(frames) - 1
    latest_cells = [dict(cell) for cell in frames[latest_idx]["cells"]]
    prev_cells = frames[latest_idx - 1]["cells"] if latest_idx > 0 else []
    next_track_id = 1

    for latest in latest_cells:
        latest["trackId"] = f"track-{next_track_id}"
        next_track_id += 1
        latest["history"] = [
            {
                "time": frames[latest_idx]["time_str"],
                "peakLon": latest["peakLon"],
                "peakLat": latest["peakLat"],
                "maxDbz": latest["maxDbz"],
            }
        ]

        best = None
        best_score = float("inf")
        for prev in prev_cells:
            dist_km = haversine_km(
                prev["peakLat"],
                prev["peakLon"],
                latest["peakLat"],
                latest["peakLon"],
            )
            dbz_diff = abs(prev["maxDbz"] - latest["maxDbz"])
            score = dist_km + dbz_diff * 0.7
            if dist_km <= 12.0 and score < best_score:
                best = prev
                best_score = score

        if best is not None:
            latest["id"] = best["id"]

    active_tracks = {cell["id"]: cell for cell in latest_cells}
    for frame_idx in range(latest_idx - 1, -1, -1):
        frame = frames[frame_idx]
        current_time = frame["time"]
        current_cells = frame["cells"]
        unmatched = {idx for idx in range(len(current_cells))}

        for track in list(active_tracks.values()):
            last_hist = track["history"][-1]
            ref_time = dt.datetime.strptime(last_hist["time"], "%Y%m%d%H%M%S")
            dt_min = max(1.0, (ref_time - current_time).total_seconds() / 60.0)
            # Přísnější match: ~55 km/h + jitter — proti falešným skokům identity
            max_dist = min(12.0, 2.5 + (dt_min / 60.0) * 55.0)

            best_idx = None
            best_score = float("inf")
            for idx in list(unmatched):
                cand = current_cells[idx]
                dist_km = haversine_km(
                    cand["peakLat"],
                    cand["peakLon"],
                    last_hist["peakLat"],
                    last_hist["peakLon"],
                )
                if dist_km > max_dist:
                    continue

                dbz_diff = abs(cand["maxDbz"] - last_hist["maxDbz"])
                area_ratio = cand["areaPx"] / max(1.0, track["areaPx"])
                area_penalty = abs(math.log(area_ratio)) * 4.0
                score = dist_km + dbz_diff * 0.6 + area_penalty
                if score < best_score:
                    best_idx = idx
                    best_score = score

            if best_idx is None:
                continue

            cand = current_cells[best_idx]
            unmatched.remove(best_idx)
            track["history"].append(
                {
                    "time": frame["time_str"],
                    "peakLon": cand["peakLon"],
                    "peakLat": cand["peakLat"],
                    "maxDbz": cand["maxDbz"],
                }
            )

    for track in latest_cells:
        hist = list(reversed(track["history"]))
        track["history"] = hist
        if len(hist) >= 2:
            # Nowcast: poslední 2–3 framy (~10–15 min), ne birth→teď
            recent = hist[-3:] if len(hist) >= 3 else hist
            first = recent[0]
            last = recent[-1]
            first_t = dt.datetime.strptime(first["time"], "%Y%m%d%H%M%S")
            last_t = dt.datetime.strptime(last["time"], "%Y%m%d%H%M%S")
            dt_h = max(1 / 60, (last_t - first_t).total_seconds() / 3600.0)
            dist_km = haversine_km(
                first["peakLat"], first["peakLon"], last["peakLat"], last["peakLon"]
            )
            speed = dist_km / dt_h
            heading = heading_deg(
                first["peakLat"], first["peakLon"], last["peakLat"], last["peakLon"]
            )
            # Divoké skoky = špatný match buněk → nechat frontend použít vítr
            if speed > 70 and len(hist) >= 2:
                a, b = hist[-2], hist[-1]
                a_t = dt.datetime.strptime(a["time"], "%Y%m%d%H%M%S")
                b_t = dt.datetime.strptime(b["time"], "%Y%m%d%H%M%S")
                dt2 = max(1 / 60, (b_t - a_t).total_seconds() / 3600.0)
                speed2 = (
                    haversine_km(a["peakLat"], a["peakLon"], b["peakLat"], b["peakLon"])
                    / dt2
                )
                if speed2 <= 70:
                    speed = speed2
                    heading = heading_deg(
                        a["peakLat"], a["peakLon"], b["peakLat"], b["peakLon"]
                    )
                else:
                    speed = None
                    heading = None

            track["trackSpeedKmh"] = None if speed is None else round(speed, 1)
            track["trackHeadingDeg"] = None if heading is None else round(heading, 1)
            birth_t = dt.datetime.strptime(hist[0]["time"], "%Y%m%d%H%M%S")
            end_t = dt.datetime.strptime(hist[-1]["time"], "%Y%m%d%H%M%S")
            track["historyMinutes"] = int((end_t - birth_t).total_seconds() / 60)
        else:
            track["trackSpeedKmh"] = None
            track["trackHeadingDeg"] = None
            track["historyMinutes"] = 0

        # První detekce v historii — trueBirth jen když echo bylo slabé
        birth = hist[0]
        track["birthLon"] = birth["peakLon"]
        track["birthLat"] = birth["peakLat"]
        track["birthDbz"] = birth["maxDbz"]
        track["ageMinutes"] = int(track["historyMinutes"])
        track["growthDbz"] = round(track["maxDbz"] - birth["maxDbz"], 1)
        birth_dbz = float(birth["maxDbz"])
        age = int(track["ageMinutes"])
        growth = float(track["growthDbz"])
        true_birth = (
            birth_dbz <= 38.0
            and age <= 18
            and age < 25
            and (age <= 10 or growth >= 2.0)
        )
        track["trueBirth"] = true_birth
        track["isNewborn"] = bool(true_birth and age <= 10)

    return latest_cells


def build_radar_contour_features(frame: dict) -> list[dict]:
    """Echo kontury — nested ≥ prahy (celistvá skvrna), ne prstence.

    Prstence (pás mezi prahy) na slabém echu dělají desítky oddělených
    „pilulek“. Nested + neprůhledný fill na mapě = jedna bouře se stupni.
    """
    levels = [30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0]
    band_for = {
        30.0: "light",
        35.0: "echo",
        40.0: "rain",
        45.0: "moderate",
        50.0: "strong",
        55.0: "heavy",
        60.0: "extreme",
    }
    crop = frame["crop"]
    meta = frame["meta"]
    geo = frame["geo"]
    r0, _, c0, _ = frame["bounds"]
    time_str = frame["time_str"]
    features: list[dict] = []

    for lvl in levels:
        mask = np.isfinite(crop) & (crop >= lvl)
        if not mask.any():
            continue
        contours = measure.find_contours(mask.astype(float), 0.5)
        for c in contours:
            if c.shape[0] < 8:
                continue
            coords = contour_coords(c, r0, c0, meta, geo, scale=1.0)
            if len(coords) < 4:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "band": band_for[lvl],
                        "dbz": lvl,
                        "source": "OPERA-ORD",
                        "time": time_str,
                    },
                    "geometry": {"type": "Polygon", "coordinates": [coords]},
                }
            )
    return features


def export_radar_history(frames: list[dict], history_dir: str) -> str:
    """Uloží historické snímky: PNG raster (+ geojson fallback) + manifest."""
    os.makedirs(history_dir, exist_ok=True)
    if not frames:
        manifest = {"frameMinutes": 5, "frames": []}
        manifest_path = os.path.join(history_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        return manifest_path

    latest_time = frames[-1]["time"]
    manifest_frames: list[dict] = []

    for idx, frame in enumerate(frames):
        offset_min = int((frame["time"] - latest_time).total_seconds() / 60)
        rel_geo = f"frame-{idx}.geojson"
        rel_png = f"frame-{idx}.png"
        rel_meta = f"frame-{idx}-raster.json"
        geo_path = os.path.join(history_dir, rel_geo)
        png_path = os.path.join(history_dir, rel_png)
        meta_path = os.path.join(history_dir, rel_meta)

        features = build_radar_contour_features(frame)
        with open(geo_path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f)

        write_radar_raster(frame, png_path, meta_path)
        manifest_frames.append(
            {
                "index": idx,
                "offsetMinutes": offset_min,
                "time": frame["time_str"],
                "path": f"data/opera/history/{rel_geo}",
                "rasterPath": f"data/opera/history/{rel_meta}",
            }
        )

    manifest = {"frameMinutes": 5, "frames": manifest_frames}
    manifest_path = os.path.join(history_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote {len(manifest_frames)} history frames (+PNG) to {history_dir}")
    return manifest_path


# Rolling archive pro kalibraci (~3 h při 5min krocích) — UI slider to nečte
ARCHIVE_MAX_SLOTS = 72  # 72 × 5 min ≈ 6 h (pro learning + backtest)


def export_radar_archive(
    cells: list[dict],
    time_str: str,
    archive_dir: str,
    *,
    max_slots: int = ARCHIVE_MAX_SLOTS,
) -> str:
    """
    Přidá snapshot peaků buněk do rolling archive (pro backtest stop/ETA/vznik).
    Nemění krátkou history/ pro mapu.
    """
    os.makedirs(archive_dir, exist_ok=True)
    peaks = []
    for cell in cells:
        peaks.append(
            {
                "id": cell["id"],
                "trackId": cell.get("trackId"),
                "lon": cell["peakLon"],
                "lat": cell["peakLat"],
                "maxDbz": cell["maxDbz"],
                "trackHeadingDeg": cell.get("trackHeadingDeg"),
                "trackSpeedKmh": cell.get("trackSpeedKmh"),
                "birthDbz": cell.get("birthDbz"),
                "trueBirth": bool(cell.get("trueBirth", False)),
                "isNewborn": bool(cell.get("isNewborn", False)),
                "ageMinutes": cell.get("ageMinutes"),
                "history": cell.get("history") or [],
            }
        )

    slot_name = f"peaks-{time_str}.json"
    slot_path = os.path.join(archive_dir, slot_name)
    payload = {
        "time": time_str,
        "frameMinutes": 5,
        "peaks": peaks,
    }
    with open(slot_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)

    # Manifest: seřazené sloty, ořízni staré
    existing = sorted(
        [
            n
            for n in os.listdir(archive_dir)
            if n.startswith("peaks-") and n.endswith(".json")
        ]
    )
    while len(existing) > max_slots:
        old = existing.pop(0)
        try:
            os.remove(os.path.join(archive_dir, old))
        except OSError:
            pass

    manifest_frames = []
    for i, name in enumerate(existing):
        t = name[len("peaks-") : -len(".json")]
        manifest_frames.append(
            {
                "index": i,
                "time": t,
                "path": f"data/opera/archive/{name}",
                "peakCount": None,
            }
        )
    # doplň peakCount z aktuálního
    for fr in manifest_frames:
        if fr["time"] == time_str:
            fr["peakCount"] = len(peaks)

    manifest = {
        "frameMinutes": 5,
        "maxSlots": max_slots,
        "frames": manifest_frames,
        "updatedAt": time_str,
    }
    manifest_path = os.path.join(archive_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Archive: {len(existing)}/{max_slots} slots (latest {time_str}, {len(peaks)} peaks)")
    return manifest_path


def convert_to_geojson(
    frames: list[dict],
    radar_out: str,
    cells_out: str,
) -> list[dict]:
    latest = frames[-1]
    radar_features: list[dict] = build_radar_contour_features(latest)
    cells = track_cells_over_time(frames)
    time_str = latest["time_str"]

    dbz_ll, warp_coords = warp_crop_to_web_mercator(latest)
    for cell in cells:
        plon, plat = snap_peak_to_warped_raster(
            dbz_ll, warp_coords, cell["peakLon"], cell["peakLat"]
        )
        cell["peakLon"] = plon
        cell["peakLat"] = plat
        hist = cell.get("history")
        if hist:
            hist[-1]["peakLon"] = plon
            hist[-1]["peakLat"] = plat

    cell_features: list[dict] = []
    for cell in cells:
        cell_features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "cell",
                    "id": cell["id"],
                    "trackId": cell["trackId"],
                    "maxDbz": cell["maxDbz"],
                    "areaPx": cell["areaPx"],
                    "trackHeadingDeg": cell["trackHeadingDeg"],
                    "trackSpeedKmh": cell["trackSpeedKmh"],
                    "historyMinutes": cell["historyMinutes"],
                    "history": cell["history"],
                    "birthLon": cell.get("birthLon", cell["peakLon"]),
                    "birthLat": cell.get("birthLat", cell["peakLat"]),
                    "birthDbz": cell.get("birthDbz", cell["maxDbz"]),
                    "ageMinutes": cell.get("ageMinutes", cell["historyMinutes"]),
                    "isNewborn": bool(cell.get("isNewborn", False)),
                    "trueBirth": bool(cell.get("trueBirth", False)),
                    "growthDbz": cell.get("growthDbz", 0),
                    "source": "OPERA-ORD",
                    "time": time_str,
                },
                "geometry": {"type": "Polygon", "coordinates": [cell["polygon"]]},
            }
        )
        radar_features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "peak",
                    "cellId": cell["id"],
                    "band": "core",
                    "dbz": cell["maxDbz"],
                    "source": "OPERA-ORD",
                    "time": time_str,
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [cell["peakLon"], cell["peakLat"]],
                },
            }
        )
        cell_features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "peak",
                    "id": cell["id"],
                    "cellId": cell["id"],
                    "trackId": cell["trackId"],
                    "maxDbz": cell["maxDbz"],
                    "source": "OPERA-ORD",
                    "time": time_str,
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [cell["peakLon"], cell["peakLat"]],
                },
            }
        )
        cell_features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "centroid",
                    "id": cell["id"],
                    "cellId": cell["id"],
                    "trackId": cell["trackId"],
                    "maxDbz": cell["maxDbz"],
                    "source": "OPERA-ORD",
                    "time": time_str,
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [cell["centroidLon"], cell["centroidLat"]],
                },
            }
        )

    os.makedirs(os.path.dirname(radar_out), exist_ok=True)
    with open(radar_out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": radar_features}, f)
    with open(cells_out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": cell_features}, f)

    raster_dir = os.path.dirname(radar_out) or "."
    write_radar_raster(
        latest,
        os.path.join(raster_dir, "latest.png"),
        os.path.join(raster_dir, "latest-raster.json"),
    )

    print(f"Cells tracked: {len(cells)}")
    for c in cells[:5]:
        print(
            f"  {c['id']}: {c['maxDbz']} dBZ @ "
            f"{c['peakLat']:.3f}N {c['peakLon']:.3f}E"
        )
    return cells


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="", help="YYYY-MM-DD (default: today UTC)")
    ap.add_argument(
        "--radar-out",
        default=os.path.join("public", "data", "opera", "latest.geojson"),
    )
    ap.add_argument(
        "--cells-out",
        default=os.path.join("public", "data", "opera", "cells.geojson"),
    )
    ap.add_argument(
        "--history-dir",
        default=os.path.join("public", "data", "opera", "history"),
    )
    ap.add_argument(
        "--archive-dir",
        default=os.path.join("public", "data", "opera", "archive"),
    )
    ap.add_argument(
        "--frames",
        type=int,
        default=12,
        help="Kolik posledních 5min framů stáhnout pro tracking (delší = lepší stopy)",
    )
    ap.add_argument(
        "--history-frames",
        type=int,
        default=7,
        help="Kolik framů jít do UI history/ (slider −30…Teď po 5 min)",
    )
    ap.add_argument("--cache", default=os.path.join(".cache", "opera"))
    args = ap.parse_args()

    date = dt.date.today() if not args.date else dt.date.fromisoformat(args.date)
    keys = list_opera_dbzh_keys(date)
    if not keys:
        raise RuntimeError(f"No DBZH.h5 found for date {date.isoformat()}")

    keys = keys[-max(1, args.frames) :]
    frames: list[dict] = []
    for key in keys:
        local_h5 = os.path.join(args.cache, os.path.basename(key))
        if not os.path.exists(local_h5):
            print(f"Downloading {key} …")
            s3_download(key, local_h5)
        else:
            print(f"Using cached {local_h5}")

        print(f"Parsing {os.path.basename(local_h5)} …")
        dbz, meta = read_odim_dbzh(local_h5)
        meta["projdef"] = meta.get("projdef") or (
            "+proj=laea +lat_0=55.0 +lon_0=10.0 +x_0=1950000.0 +y_0=-2100000.0 +units=m +ellps=WGS84"
        )
        print(f"DBZH shape={dbz.shape}")
        frames.append(build_frame(dbz, meta))

    cells = convert_to_geojson(frames, args.radar_out, args.cells_out)
    hist_n = max(2, min(args.history_frames, len(frames)))
    export_radar_history(frames[-hist_n:], args.history_dir)
    export_radar_archive(cells, frames[-1]["time_str"], args.archive_dir)
    print(f"Wrote {args.radar_out}")
    print(f"Wrote {args.cells_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
