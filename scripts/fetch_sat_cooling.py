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
        "cloud_top_temperature",
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


def _is_hdf5(path: Path) -> bool:
    with path.open("rb") as f:
        return f.read(4) == b"\x89HDF"


def _rank_nc_candidates(dest: Path) -> list[Path]:
    """Seřaď .nc soubory z produktu — preferuj datové chunky (_C_) před overview (_O_)."""
    cands = [
        p
        for p in dest.rglob("*.nc")
        if p.is_file() and p.stat().st_size > 10_000
    ]
    if not cands:
        cands = [
            p
            for p in dest.rglob("*")
            if p.is_file() and p.suffix.lower() in (".nc", ".nc4") and p.stat().st_size > 10_000
        ]

    def score(p: Path) -> tuple[int, int, int]:
        name = p.name.upper()
        # _C_ = datový chunk; _O_ = overview/metadata (často nečitelné netCDF4 knihovnou)
        if "_C_" in name:
            disp = 0
        elif "_O_" in name:
            disp = 2
        else:
            disp = 1
        ctth = 0 if "CTTH" in name or "+FCI-2-CT" in name else 1
        return (disp, ctth, -int(p.stat().st_size))

    return sorted(cands, key=score)


def _pick_readable_nc(dest: Path) -> Path | None:
    for path in _rank_nc_candidates(dest):
        if not _is_hdf5(path):
            print(f"  skip {path.name}: not HDF5 ({path.stat().st_size} B)", flush=True)
            continue
        try:
            ds = _open_dataset(path)
            var = _find_temp_var(ds)
            ds.close()
            if var:
                print(f"  using {path.name} (var={var})", flush=True)
                return path
            print(f"  skip {path.name}: no CTT variable", flush=True)
        except Exception as e:
            print(f"  skip {path.name}: {e}", flush=True)
    return None


def _sample_fci_geos(ds, var: str, lat: float, lon: float) -> float | None:
    """Vzorek z MTG FCI L2 geostacionární mřížky (x/y + mtg_geos_projection)."""
    import numpy as np
    from pyproj import CRS, Transformer

    if "mtg_geos_projection" not in ds or "x" not in ds or "y" not in ds:
        return None

    proj = ds["mtg_geos_projection"]
    lon_0 = float(proj.attrs["longitude_of_projection_origin"])
    h = float(proj.attrs["perspective_point_height"])
    a = float(proj.attrs.get("semi_major_axis", 6378137.0))
    rf = float(proj.attrs.get("inverse_flattening", 298.257223563))
    geos = CRS.from_proj4(
        f"+proj=geos +lon_0={lon_0} +h={h} +a={a} +rf={rf} +sweep=y +units=m"
    )
    tf = Transformer.from_crs(CRS.from_epsg(4326), geos, always_xy=True)
    x_m, y_m = tf.transform(lon, lat)

    x = np.asarray(ds["x"].values, dtype=float)
    y = np.asarray(ds["y"].values, dtype=float)
    # Satpy konvence: geos metry ≈ -degrees(x)*h, degrees(y)*h
    x_m_grid = -np.degrees(x) * h
    y_m_grid = np.degrees(y) * h

    xi = int(np.argmin(np.abs(x_m_grid - x_m)))
    yi = int(np.argmin(np.abs(y_m_grid - y_m)))

    data = ds[var]
    vals = np.asarray(data.values)
    while vals.ndim > 2:
        vals = vals[0]
    v = float(vals[yi, xi])
    if not math.isfinite(v):
        return None
    if 150 <= v <= 350:
        return v - 273.15
    if -90 < v < 40:
        return v
    return None


def _sample_field(ds, var: str, lat: float, lon: float) -> float | None:
    if "mtg_geos_projection" in getattr(ds, "variables", ds):
        v = _sample_fci_geos(ds, var, lat, lon)
        if v is not None:
            return v

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
    import xarray as xr

    if not _is_hdf5(path):
        raise RuntimeError(f"{path.name} není HDF5/netCDF (neúplný download?)")

    errors: list[str] = []
    for engine in ("h5netcdf", "netcdf4", "scipy"):
        try:
            return xr.open_dataset(
                path,
                engine=engine,
                decode_cf=True,
                mask_and_scale=True,
            )
        except Exception as e:
            errors.append(f"{engine}: {e}")
    raise RuntimeError(f"Nelze otevřít {path.name}: {'; '.join(errors)}")


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

    # Seřadit od nejstaršího; zkus každou kolekci (MTG → MSG fallback)
    products = list(reversed(products[:4]))
    last_error = "Stažené produkty neobsahují čitelný netCDF s CTT"

    for coll_id in ([used_collection] if used_collection else []) + [
        c for c in COLLECTIONS if c != used_collection
    ]:
        if coll_id != used_collection:
            try:
                collection = datastore.get_collection(coll_id)
                selected = collection.search(
                    dtstart=now - timedelta(hours=2),
                    dtend=now,
                )
                got = list(selected)[:8]
                if len(got) < 2:
                    continue
                products = list(reversed(got[:4]))
                used_collection = coll_id
                print(f"  fallback collection {coll_id}", flush=True)
            except Exception as e:
                print(f"  fallback {coll_id}: {e}", flush=True)
                continue

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
                    try:
                        with prod.open() as src, (dest / "product.bin").open("wb") as dst:
                            dst.write(src.read())
                    except Exception as e:
                        print(f"  download fail: {e}", flush=True)
                        continue
                picked = _pick_readable_nc(dest)
                if picked:
                    paths.append(picked)

            if len(paths) < 2:
                last_error = "Stažené produkty neobsahují čitelný netCDF s CTT"
                continue

            try:
                points = _cooling_from_two_files(paths[0], paths[1], float(DT_MINUTES))
            except Exception as e:
                traceback.print_exc()
                last_error = f"Parse CTT selhal: {e}"
                continue

            if not points:
                last_error = "Žádné validní CTT vzorky na mřížce"
                continue

            write_cooling(
                status="ok",
                source=f"EUMETSAT/{used_collection}",
                message=f"ΔT / {DT_MINUTES} min z cloud-top temperature",
                points=points,
                valid_at=now,
            )
            return 0

    write_cooling(
        status="error",
        source=f"EUMETSAT/{used_collection or 'unknown'}",
        message=last_error,
    )
    return 1


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
