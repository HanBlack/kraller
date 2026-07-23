"""
ČHMÚ dual-pol volume (Z + ZDR) → obohacení OPERA buněk.

Živě stahuje ~5min volume z CZ radarů, nad peakem spočítá:
echo top, ZDR column, hail hint, strukturální label.

Veřejný JSON neobsahuje identifikátory lokalit — jen signály pro UI.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import h5py
import numpy as np
import requests

# Interní URL path (nutné pro download). Ve výstupu se neobjeví.
_SITES = (
    {
        "id": "cz1",
        "z": "https://opendata.chmi.cz/meteorology/weather/radar/sites/brd/vol_z/hdf5/",
        "zdr": "https://opendata.chmi.cz/meteorology/weather/radar/sites/brd/vol_zdr/hdf5/",
        "z_prefix": "T_PAGZ60",
        "zdr_prefix": "T_PAKZ60",
    },
    {
        "id": "cz2",
        "z": "https://opendata.chmi.cz/meteorology/weather/radar/sites/ska/vol_z/hdf5/",
        "zdr": "https://opendata.chmi.cz/meteorology/weather/radar/sites/ska/vol_zdr/hdf5/",
        "z_prefix": "T_PAGZ50",
        "zdr_prefix": "T_PAKZ50",
    },
)

MAX_RANGE_KM = 250.0  # Brdy + Skalky → celé území ČR (+ okraj)
DEFAULT_FZL_KM = 3.5


class _HrefParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if href and href.endswith(".hdf"):
            self.hrefs.append(href)


def list_hdf(url: str) -> list[str]:
    r = requests.get(url, timeout=45)
    r.raise_for_status()
    p = _HrefParser()
    p.feed(r.text)
    return p.hrefs


def _nearest_file(files: list[str], prefix: str, time_str: str | None = None) -> str:
    cand = [f for f in files if f.startswith(prefix)]
    if not cand:
        raise RuntimeError(f"No HDF with prefix {prefix}")

    def ts(f: str) -> str:
        m = re.search(r"(\d{14})", f)
        return m.group(1) if m else ""

    if time_str is None:
        return sorted(cand, key=ts)[-1]
    target = int(time_str)
    exact = f"{prefix}_C_OKPR_{time_str}.hdf"
    if exact in cand:
        return exact
    return min(cand, key=lambda f: abs(int(ts(f) or "0") - target))


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 10_000:
        return dest
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=256 * 1024):
                if chunk:
                    f.write(chunk)
    return dest


def _attr_str(v: object) -> str:
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return str(v)


def decode_odim(raw: np.ndarray, what) -> np.ndarray:
    gain = float(what.attrs.get("gain", 1.0))
    offset = float(what.attrs.get("offset", 0.0))
    nodata = float(what.attrs.get("nodata", 255))
    undetect = float(what.attrs.get("undetect", 0))
    data = raw.astype(np.float64) * gain + offset
    mask = (raw.astype(np.float64) == nodata) | (raw.astype(np.float64) == undetect)
    data[mask] = np.nan
    return data


@dataclass
class VolumeScan:
    elangle_deg: float
    quantity: str
    values: np.ndarray
    rscale_m: float
    rstart_m: float
    # start azimuth per ray (deg), if present in ODIM
    startaz_deg: np.ndarray | None


@dataclass
class PolarVolume:
    lat: float
    lon: float
    height_m: float
    time: str
    scans: list[VolumeScan]


def load_pvol(path: Path) -> PolarVolume:
    with h5py.File(path, "r") as f:
        lat = float(f["where"].attrs["lat"])
        lon = float(f["where"].attrs["lon"])
        height = float(f["where"].attrs["height"])
        date = _attr_str(f["what"].attrs["date"])
        time = _attr_str(f["what"].attrs["time"])
        scans: list[VolumeScan] = []
        for key in sorted(
            (k for k in f.keys() if k.startswith("dataset")),
            key=lambda k: int(k[7:]),
        ):
            g = f[key]
            el = float(g["where"].attrs["elangle"])
            rscale = float(g["where"].attrs["rscale"])
            rstart = float(g["where"].attrs.get("rstart", 0.0))
            qty = _attr_str(g["data1/what"].attrs["quantity"])
            vals = decode_odim(g["data1/data"][:], g["data1/what"])
            startaz = None
            if "startazA" in g["how"].attrs:
                raw_az = g["how"].attrs["startazA"]
                if hasattr(raw_az, "__len__") and len(raw_az) == vals.shape[0]:
                    startaz = np.asarray(raw_az, dtype=np.float64)
            scans.append(
                VolumeScan(
                    elangle_deg=el,
                    quantity=qty,
                    values=vals,
                    rscale_m=rscale,
                    rstart_m=rstart,
                    startaz_deg=startaz,
                )
            )
    return PolarVolume(
        lat=lat,
        lon=lon,
        height_m=height,
        time=f"{date}{time}",
        scans=scans,
    )


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def sample_column(
    vol: PolarVolume, lat: float, lon: float, neighborhood: int = 1
) -> list[dict[str, float]]:
    dist_km = haversine_km(vol.lat, vol.lon, lat, lon)
    if dist_km > MAX_RANGE_KM:
        return []
    az = bearing_deg(vol.lat, vol.lon, lat, lon)
    out: list[dict[str, float]] = []
    for scan in vol.scans:
        nrays, nbins = scan.values.shape
        if scan.startaz_deg is not None and len(scan.startaz_deg) == nrays:
            diff = np.abs(((scan.startaz_deg - az + 180.0) % 360.0) - 180.0)
            ray = int(np.argmin(diff))
        else:
            ray = int(round(az)) % nrays
        range_m = dist_km * 1000.0
        bin_i = int(round((range_m - scan.rstart_m) / scan.rscale_m))
        if bin_i < 0 or bin_i >= nbins:
            continue
        vals: list[float] = []
        for dr in range(-neighborhood, neighborhood + 1):
            for db in range(-neighborhood, neighborhood + 1):
                r = (ray + dr) % nrays
                b = bin_i + db
                if 0 <= b < nbins:
                    v = scan.values[r, b]
                    if np.isfinite(v):
                        vals.append(float(v))
        if not vals:
            continue
        el = math.radians(scan.elangle_deg)
        re = 6371000.0 * 4.0 / 3.0
        h = vol.height_m + range_m * math.sin(el) + (range_m**2) / (2.0 * re)
        out.append(
            {
                "el": scan.elangle_deg,
                "value": float(np.median(vals)),
                "height_km": h / 1000.0,
            }
        )
    return out


def analyze_peak(
    z_vol: PolarVolume,
    zdr_vol: PolarVolume,
    lat: float,
    lon: float,
    freezing_level_km: float = DEFAULT_FZL_KM,
) -> dict[str, Any] | None:
    z_col = sample_column(z_vol, lat, lon)
    if not z_col:
        return None
    zdr_by_el = {
        round(s["el"], 1): s for s in sample_column(zdr_vol, lat, lon)
    }
    rows = []
    for z in z_col:
        zdr = zdr_by_el.get(round(z["el"], 1))
        rows.append(
            {
                "height_km": z["height_km"],
                "dbz": z["value"],
                "zdr": None if zdr is None else zdr["value"],
            }
        )

    max_dbz = max(r["dbz"] for r in rows)
    echo_top_30 = max(
        (r["height_km"] for r in rows if r["dbz"] >= 30), default=None
    )
    echo_top_50 = max(
        (r["height_km"] for r in rows if r["dbz"] >= 50), default=None
    )
    zdr_above = [
        r
        for r in rows
        if r["zdr"] is not None
        and r["height_km"] >= freezing_level_km
        and r["zdr"] >= 1.0
        and r["dbz"] >= 20
    ]
    zdr_column = len(zdr_above) >= 2
    zdr_column_top_km = max((r["height_km"] for r in zdr_above), default=None)
    hail_likely = bool(
        echo_top_50 is not None
        and echo_top_50 >= freezing_level_km + 1.5
        and max_dbz >= 50
    )

    if hail_likely:
        label = "possible_hail"
    elif zdr_column:
        label = "strong_updraft"
    elif max_dbz < 30 or (
        echo_top_30 is not None and echo_top_30 < freezing_level_km
    ):
        label = "weakening_or_shallow"
    else:
        label = "rain"

    return {
        "dualpolOk": True,
        "dualpolTime": z_vol.time,
        "dualpolLabel": label,
        "dualpolZdrColumn": zdr_column,
        "dualpolHailLikely": hail_likely,
        "dualpolMaxDbz": round(float(max_dbz), 1),
        "dualpolEchoTop30Km": None
        if echo_top_30 is None
        else round(float(echo_top_30), 2),
        "dualpolEchoTop50Km": None
        if echo_top_50 is None
        else round(float(echo_top_50), 2),
        "dualpolZdrColumnTopKm": None
        if zdr_column_top_km is None
        else round(float(zdr_column_top_km), 2),
    }


def fetch_site_volumes(
    site: dict[str, str], cache_dir: Path, time_str: str | None = None
) -> tuple[PolarVolume, PolarVolume]:
    z_name = _nearest_file(list_hdf(site["z"]), site["z_prefix"], time_str)
    ts = re.search(r"(\d{14})", z_name)
    zdr_name = _nearest_file(
        list_hdf(site["zdr"]),
        site["zdr_prefix"],
        ts.group(1) if ts else time_str,
    )
    z_path = download(site["z"] + z_name, cache_dir / f"{site['id']}_z_{z_name}")
    zdr_path = download(
        site["zdr"] + zdr_name, cache_dir / f"{site['id']}_zdr_{zdr_name}"
    )
    return load_pvol(z_path), load_pvol(zdr_path)


def enrich_cells(
    cells_path: str,
    cache_dir: str,
    out_meta: str | None = None,
    fzl_km: float = DEFAULT_FZL_KM,
) -> dict[str, Any]:
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)

    volumes: list[tuple[PolarVolume, PolarVolume]] = []
    for site in _SITES:
        try:
            volumes.append(fetch_site_volumes(site, cache))
            print(f"dualpol site {site['id']}: ok time={volumes[-1][0].time}")
        except Exception as e:
            print(f"dualpol site {site['id']}: skip ({e})")

    if not volumes:
        return {"ok": False, "enriched": 0, "reason": "no volumes"}

    with open(cells_path, encoding="utf-8") as f:
        fc = json.load(f)

    peaks: dict[str, tuple[float, float]] = {}
    for feat in fc.get("features", []):
        props = feat.get("properties") or {}
        if props.get("kind") != "peak":
            continue
        cid = props.get("cellId") or props.get("id")
        geom = feat.get("geometry") or {}
        if cid and geom.get("type") == "Point":
            lon, lat = geom["coordinates"][:2]
            peaks[str(cid)] = (float(lon), float(lat))

    enriched = 0
    for feat in fc.get("features", []):
        props = feat.get("properties") or {}
        if props.get("kind") != "cell":
            continue
        cid = str(props.get("id") or "")
        peak = peaks.get(cid)
        if not peak:
            continue
        lon, lat = peak

        best: dict[str, Any] | None = None
        best_dist = 1e9
        for z_vol, zdr_vol in volumes:
            dist = haversine_km(z_vol.lat, z_vol.lon, lat, lon)
            if dist > MAX_RANGE_KM or dist >= best_dist:
                continue
            res = analyze_peak(z_vol, zdr_vol, lat, lon, freezing_level_km=fzl_km)
            if res is None:
                continue
            best = res
            best_dist = dist

        if best is None:
            continue
        props.update(best)
        # Prefer volume echo top when taller / missing
        et50 = best.get("dualpolEchoTop50Km")
        et30 = best.get("dualpolEchoTop30Km")
        et = et50 or et30
        if et is not None:
            prev = props.get("echoTopKm")
            if prev is None or float(et) > float(prev):
                props["echoTopKm"] = et
                props["echoTopSource"] = "CHMI"
        if best.get("dualpolHailLikely"):
            props["hailLikely"] = True
        enriched += 1

    with open(cells_path, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)

    meta = {
        "ok": True,
        "enriched": enriched,
        "peaks": len(peaks),
        "volumes": len(volumes),
        "time": volumes[0][0].time if volumes else None,
        "source": "CHMI-dualpol",
    }
    if out_meta:
        os.makedirs(os.path.dirname(out_meta) or ".", exist_ok=True)
        with open(out_meta, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    print(f"dualpol enriched {enriched}/{len(peaks)} cells")
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(description="CHMI dual-pol enrich cells")
    ap.add_argument(
        "--cells",
        default=os.path.join("public", "data", "opera", "cells.geojson"),
    )
    ap.add_argument("--cache", default=os.path.join(".cache", "chmi_dualpol"))
    ap.add_argument(
        "--meta",
        default=os.path.join("public", "data", "chmi", "dualpol-meta.json"),
    )
    ap.add_argument("--fzl-km", type=float, default=DEFAULT_FZL_KM)
    args = ap.parse_args()
    enrich_cells(args.cells, args.cache, args.meta, fzl_km=args.fzl_km)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
