"""Společné čtení ODIM HDF5 gridů (OPERA / ČHMÚ)."""

from __future__ import annotations

import re
from typing import Any

import h5py
import numpy as np
from pyproj import Transformer


def _attr_str(val: Any) -> str:
    if isinstance(val, bytes):
        return val.decode("utf-8", "ignore")
    return str(val)


def read_odim_grid(path: str, quantity: str) -> tuple[np.ndarray, dict]:
    """Načte první dataset s danou quantity (DBZH, HGHT, …)."""
    qty_want = quantity.strip().upper()
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
                if qty == qty_want:
                    chosen = (ds_name, data_name)
                    break
            if chosen:
                break

        if not chosen:
            raise RuntimeError(f"Could not find {quantity} in {path}")

        ds_name, data_name = chosen
        raw = f[f"{ds_name}/{data_name}/data"][()]
        what = f[f"{ds_name}/{data_name}/what"]
        nodata = float(what.attrs.get("nodata", -9999))
        undetect = float(what.attrs.get("undetect", -8888))
        gain = float(what.attrs.get("gain", 1.0))
        offset = float(what.attrs.get("offset", 0.0))

        data = raw.astype(np.float32)
        data[data == nodata] = np.nan
        if undetect != nodata:
            data[data == undetect] = np.nan
        values = offset + gain * data

        where = f.get("where") or f.get(f"{ds_name}/where")
        if where is None:
            raise RuntimeError("Missing /where georeferencing")

        meta: dict = {
            "gain": gain,
            "offset": offset,
            "nodata": nodata,
            "undetect": undetect,
            "shape": values.shape,
            "xsize": int(where.attrs["xsize"]),
            "ysize": int(where.attrs["ysize"]),
            "xscale": float(where.attrs.get("xscale", 1000)),
            "yscale": float(where.attrs.get("yscale", 1000)),
            "quantity": qty_want,
        }
        for corner in ("UL", "UR", "LL", "LR"):
            meta[f"{corner}_lon"] = float(where.attrs[f"{corner}_lon"])
            meta[f"{corner}_lat"] = float(where.attrs[f"{corner}_lat"])
        if "projdef" in where.attrs:
            meta["projdef"] = _attr_str(where.attrs["projdef"])

        if "what" in f:
            for k in ("date", "time"):
                if k in f["what"].attrs:
                    meta[k] = _attr_str(f["what"].attrs[k])

        return values, meta


def build_geo(meta: dict) -> dict:
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
    return {
        "proj_to_wgs": proj_to_wgs,
        "wgs_to_proj": wgs_to_proj,
        "ul": (ul_x, ul_y),
        "ur": (ur_x, ur_y),
        "ll": (ll_x, ll_y),
        "lr": (lr_x, lr_y),
        "xscale": meta["xscale"],
        "yscale": meta["yscale"],
    }


def lonlat_to_rowcol(
    lon: float,
    lat: float,
    meta: dict,
    geo: dict,
) -> tuple[float, float] | None:
    x, y = geo["wgs_to_proj"].transform(lon, lat)
    ul_x, ul_y = geo["ul"]
    col = (x - ul_x) / geo["xscale"] - 0.5
    row = (ul_y - y) / geo["yscale"] - 0.5
    if row < 0 or col < 0 or row >= meta["ysize"] or col >= meta["xsize"]:
        return None
    return float(row), float(col)


def sample_grid(
    grid: np.ndarray,
    lon: float,
    lat: float,
    meta: dict,
    geo: dict,
) -> float | None:
    rc = lonlat_to_rowcol(lon, lat, meta, geo)
    if rc is None:
        return None
    row, col = rc
    r0, c0 = int(row), int(col)
    if r0 < 0 or c0 < 0 or r0 >= grid.shape[0] or c0 >= grid.shape[1]:
        return None
    val = float(grid[r0, c0])
    if not np.isfinite(val):
        return None
    return val


def sample_grid_max(
    grid: np.ndarray,
    lon: float,
    lat: float,
    meta: dict,
    geo: dict,
    radius_px: int = 1,
) -> float | None:
    rc = lonlat_to_rowcol(lon, lat, meta, geo)
    if rc is None:
        return None
    row, col = rc
    r0 = int(round(row))
    c0 = int(round(col))
    best: float | None = None
    for dr in range(-radius_px, radius_px + 1):
        for dc in range(-radius_px, radius_px + 1):
            r, c = r0 + dr, c0 + dc
            if r < 0 or c < 0 or r >= grid.shape[0] or c >= grid.shape[1]:
                continue
            val = float(grid[r, c])
            if not np.isfinite(val):
                continue
            if best is None or val > best:
                best = val
    return best


def pixel_to_lonlat(row: float, col: float, meta: dict, geo: dict) -> tuple[float, float]:
    ul_x, ul_y = geo["ul"]
    x = ul_x + (col + 0.5) * geo["xscale"]
    y = ul_y - (row + 0.5) * geo["yscale"]
    lon, lat = geo["proj_to_wgs"].transform(x, y)
    return float(lon), float(lat)


def nominal_time_iso(meta: dict) -> str | None:
    date_s = str(meta.get("date", "")).strip()
    time_s = str(meta.get("time", "")).strip()
    if len(date_s) != 8 or len(time_s) < 4:
        return None
    if len(time_s) == 4:
        time_s = f"{time_s}00"
    time_s = (time_s + "000000")[:6]
    return (
        f"{date_s[0:4]}-{date_s[4:6]}-{date_s[6:8]}T"
        f"{time_s[0:2]}:{time_s[2:4]}:{time_s[4:6]}Z"
    )
