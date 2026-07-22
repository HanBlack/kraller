#!/usr/bin/env python3
"""Satelitní cloud-top cooling (EUMETSAT, zdarma s EO Portal klíči).

Bez EUMETSAT_CONSUMER_KEY / EUMETSAT_CONSUMER_SECRET:
  zapíše cooling.json se statusem no_credentials (formation zůstane na model proxy).

S klíči:
  stáhne 2 snímky Cloud Top Temperature (~15 min od sebe), spočte ΔT na mřížce
  shodné s formation (CZ+AT pás), zapíše public/data/satellite/cooling.json.

Klíče: https://api.eumetsat.int/api-key/ (free EO Portal účet).
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Stejný pás jako fetch_formation.py
WEST, SOUTH, EAST, NORTH = 7.0, 46.5, 22.5, 52.5
COLS, ROWS = 28, 18
OUT_PATH = Path("public/data/satellite/cooling.json")
# Preferuj MTG CTT+CTH (má teplotu); fallback MSG CTH
COLLECTIONS = (
    "EO:EUM:DAT:0681",  # MTG Cloud Top Temperature and Height
    "EO:EUM:DAT:MSG:CTH",
)
DT_MINUTES = 15


def lat_lons() -> tuple[list[float], list[float]]:
    lats = [SOUTH + (NORTH - SOUTH) * j / (ROWS - 1) for j in range(ROWS)]
    lons = [WEST + (EAST - WEST) * i / (COLS - 1) for i in range(COLS)]
    return lats, lons


def write_cooling(
    *,
    status: str,
    source: str,
    message: str,
    points: list[dict] | None = None,
    valid_at: datetime | None = None,
) -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    now = valid_at or datetime.now(timezone.utc)
    payload = {
        "west": WEST,
        "south": SOUTH,
        "east": EAST,
        "north": NORTH,
        "cols": COLS,
        "rows": ROWS,
        "source": source,
        "status": status,
        "message": message,
        "dtMinutes": DT_MINUTES,
        "validAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "points": points or [],
    }
    OUT_PATH.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Wrote {OUT_PATH} status={status} points={len(payload['points'])}", flush=True)


def credentials() -> tuple[str, str] | None:
    key = (
        os.environ.get("EUMETSAT_CONSUMER_KEY")
        or os.environ.get("CONSUMER_KEY_EUMETSAT")
        or ""
    ).strip()
    secret = (
        os.environ.get("EUMETSAT_CONSUMER_SECRET")
        or os.environ.get("CONSUMER_SECRET_EUMETSAT")
        or ""
    ).strip()
    if key and secret:
        return key, secret
    return None


def _find_temp_var(ds) -> str | None:
    """Hledej cloud-top temperature v netCDF/xarray datasetu."""
    prefer = (
        "ctt",
        "CTT",
        "cloud_top_temperature",
        "CloudTopTemperature",
        "t_cloud_top",
        "IR_BT",
        "bt",
        "TB",
    )
    names = list(getattr(ds, "data_vars", ds.variables if hasattr(ds, "variables") else []))
    lower = {str(n).lower(): str(n) for n in names}
    for p in prefer:
        if p.lower() in lower:
            return lower[p.lower()]
    for n in names:
        nl = str(n).lower()
        if "temp" in nl and "surface" not in nl:
            return str(n)
    return None


def _sample_field(ds, var: str, lat: float, lon: float) -> float | None:
    import numpy as np

    data = ds[var]
    # Typické dimenze: (time, lat, lon) nebo (lat, lon)
    vals = np.asarray(data.values)
    while vals.ndim > 2:
        vals = vals[0]

    lat_name = None
    lon_name = None
    for cand in ("lat", "latitude", "y"):
        if cand in ds.coords or cand in getattr(ds, "variables", {}):
            lat_name = cand
            break
    for cand in ("lon", "longitude", "x"):
        if cand in ds.coords or cand in getattr(ds, "variables", {}):
            lon_name = cand
            break
    if not lat_name or not lon_name:
        return None

    lats = np.asarray(ds[lat_name].values).astype(float).ravel()
    lons = np.asarray(ds[lon_name].values).astype(float).ravel()
    # Nejbližší pixel
    if lats.size != vals.shape[0] and lats.size == vals.shape[1]:
        # (lon, lat) layout
        ji = int(np.argmin(np.abs(lons - lon)))
        ii = int(np.argmin(np.abs(lats - lat)))
        v = float(vals[ji, ii]) if vals.shape[0] == lons.size else float(vals[ii, ji])
    else:
        ii = int(np.argmin(np.abs(lats - lat)))
        jj = int(np.argmin(np.abs(lons - lon)))
        v = float(vals[ii, jj])
    if not math.isfinite(v) or v < 150 or v > 350:
        # Kelvin sanity; případně už °C
        if math.isfinite(v) and -90 < v < 40:
            return v
        return None
    return v - 273.15  # K → °C


def _open_dataset(path: Path):
    try:
        import xarray as xr

        return xr.open_dataset(path)
    except Exception:
        pass
    try:
        from netCDF4 import Dataset

        return Dataset(str(path))
    except Exception as e:
        raise RuntimeError(f"Nelze otevřít {path}: {e}") from e


def _cooling_from_two_files(
    older: Path, newer: Path, dt_min: float
) -> list[dict]:
    ds0 = _open_dataset(older)
    ds1 = _open_dataset(newer)
    try:
        var0 = _find_temp_var(ds0)
        var1 = _find_temp_var(ds1)
        if not var0 or not var1:
            raise RuntimeError(
                f"V datech není CTT (vars older={[v for v in getattr(ds0, 'data_vars', [])]})"
            )
        lats, lons = lat_lons()
        points: list[dict] = []
        scale = 15.0 / max(5.0, dt_min)  # normalizuj na °C / 15 min
        for lat in lats:
            for lon in lons:
                t0 = _sample_field(ds0, var0, lat, lon)
                t1 = _sample_field(ds1, var1, lat, lon)
                if t0 is None or t1 is None:
                    continue
                # Záporné = ochlazování (rostoucí věž)
                d_per_15 = (t1 - t0) * scale
                d_per_15 = max(-8.0, min(4.0, d_per_15))
                points.append(
                    {
                        "lat": round(lat, 4),
                        "lon": round(lon, 4),
                        "cloudTopTempC": round(t1, 2),
                        "cloudTopCoolingCPer15min": round(d_per_15, 2),
                    }
                )
        return points
    finally:
        try:
            ds0.close()
        except Exception:
            pass
        try:
            ds1.close()
        except Exception:
            pass


def fetch_with_eumdac(key: str, secret: str) -> int:
    try:
        import eumdac
    except ImportError:
        write_cooling(
            status="error",
            source="EUMETSAT",
            message="Chybí balíček eumdac — pip install eumdac xarray netCDF4",
        )
        return 1

    token = eumdac.AccessToken((key, secret))
    datastore = eumdac.DataStore(token)
    now = datetime.now(timezone.utc)

    products = []
    used_collection = None
    for coll_id in COLLECTIONS:
        try:
            collection = datastore.get_collection(coll_id)
            # Poslední ~2 h produktů
            selected = collection.search(
                dtstart=now - timedelta(hours=2),
                dtend=now,
            )
            got = list(selected)[:8]
            if len(got) >= 2:
                products = got
                used_collection = coll_id
                break
            print(f"  {coll_id}: jen {len(got)} produktů", flush=True)
        except Exception as e:
            print(f"  {coll_id}: {e}", flush=True)
            continue

    if len(products) < 2 or not used_collection:
        write_cooling(
            status="error",
            source="EUMETSAT",
            message="Málo produktů CTT/CTH v Data Store (zkontroluj kolekci / oprávnění)",
        )
        return 1

    # Seřadit od nejstaršího
    products = list(reversed(products[:4]))
    with tempfile.TemporaryDirectory(prefix="sat_cool_") as tmp:
        tmp_path = Path(tmp)
        paths: list[Path] = []
        for i, prod in enumerate(products[-2:]):
            print(f"  download {prod}", flush=True)
            dest = tmp_path / f"frame_{i}"
            dest.mkdir()
            try:
                prod.download(dir=str(dest))
            except Exception:
                # starší API: entries
                for entry in prod.entries:
                    try:
                        with (dest / Path(entry).name).open("wb") as f:
                            prod.entries[entry].download(f) if False else None
                    except Exception:
                        pass
                # Fallback eumdac download via open
                try:
                    with prod.open() as src, (dest / "product.bin").open("wb") as dst:
                        dst.write(src.read())
                except Exception as e:
                    print(f"  download fail: {e}", flush=True)
                    continue
            # Najdi netcdf/grib/nc
            cands = list(dest.rglob("*.nc")) + list(dest.rglob("*.nc4"))
            if not cands:
                cands = list(dest.rglob("*"))
                cands = [p for p in cands if p.is_file() and p.stat().st_size > 1000]
            if cands:
                paths.append(cands[0])

        if len(paths) < 2:
            write_cooling(
                status="error",
                source=f"EUMETSAT/{used_collection}",
                message="Stažené produkty neobsahují čitelný netCDF s CTT",
            )
            return 1

        try:
            points = _cooling_from_two_files(paths[0], paths[1], float(DT_MINUTES))
        except Exception as e:
            traceback.print_exc()
            write_cooling(
                status="error",
                source=f"EUMETSAT/{used_collection}",
                message=f"Parse CTT selhal: {e}",
            )
            return 1

        if not points:
            write_cooling(
                status="error",
                source=f"EUMETSAT/{used_collection}",
                message="Žádné validní CTT vzorky na mřížce",
            )
            return 1

        write_cooling(
            status="ok",
            source=f"EUMETSAT/{used_collection}",
            message=f"ΔT / {DT_MINUTES} min z cloud-top temperature",
            points=points,
            valid_at=now,
        )
        return 0


def main() -> int:
    creds = credentials()
    if not creds:
        write_cooling(
            status="no_credentials",
            source="unavailable",
            message=(
                "Nastav EUMETSAT_CONSUMER_KEY a EUMETSAT_CONSUMER_SECRET "
                "(zdarma: https://api.eumetsat.int/api-key/). "
                "Do té doby formation používá model LI proxy."
            ),
        )
        return 0

    try:
        return fetch_with_eumdac(*creds)
    except Exception as e:
        traceback.print_exc()
        write_cooling(
            status="error",
            source="EUMETSAT",
            message=str(e),
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
