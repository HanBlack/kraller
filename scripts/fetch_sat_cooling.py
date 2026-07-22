#!/usr/bin/env python3
"""Satelitní cloud-top cooling (EUMETSAT, zdarma s EO Portal klíči).

Bez EUMETSAT_CONSUMER_KEY / EUMETSAT_CONSUMER_SECRET:
  zapíše cooling.json se statusem no_credentials (formation zůstane na model proxy).

S klíči:
  stáhne 2 snímky Cloud Top Temperature (~15 min od sebe) + cloud mask + cloud type,
  vzorkuje CTT/CTH jen u pixelů s mrakem (cma), zapíše cooling.json.

Klíče: https://api.eumetsat.int/api-key/ (free EO Portal účet).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import tempfile
import traceback
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Stejný pás jako fetch_formation.py
WEST, SOUTH, EAST, NORTH = 7.0, 46.5, 22.5, 52.5
COLS, ROWS = 28, 18
OUT_PATH = Path("public/data/satellite/cooling.json")
# Preferuj MTG CTT+CTH (má teplotu). MSG CTH je native binary — jen nouzový fallback.
COLLECTIONS = (
    "EO:EUM:DAT:0681",  # MTG Cloud Top Temperature and Height
    "EO:EUM:DAT:MSG:HRSEVIRI",  # IR10.8 via Data Tailor fallback
)
MASK_COLLECTION = "EO:EUM:DAT:0678"  # MTG Cloud Mask (netCDF, cma)
TYPE_COLLECTION = "EO:EUM:DAT:0680"  # MTG Cloud Type (netCDF, ct)
MSG_TAILOR_CHAIN = {"product": "HRSEVIRI", "format": "netcdf4", "projection": "geographic"}
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
        "ir_108",
        "IR_108",
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


def _log_dir(label: str, dest: Path) -> None:
    files = [p for p in dest.rglob("*") if p.is_file()]
    if not files:
        print(f"  {label}: prázdný adresář", flush=True)
        return
    preview = ", ".join(
        f"{p.name}({p.stat().st_size // 1024}KB)" for p in sorted(files)[:6]
    )
    extra = f" +{len(files) - 6} dalších" if len(files) > 6 else ""
    print(f"  {label}: {preview}{extra}", flush=True)


def _extract_zip(zip_path: Path, dest: Path) -> None:
    with zipfile.ZipFile(zip_path, "r") as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            zf.extract(name, dest)


def _download_product(prod, dest: Path) -> None:
    """Stáhni produkt z Data Store — MTG/FCI často přijde jako zip stream."""
    dest.mkdir(parents=True, exist_ok=True)

    try:
        prod.download(dir=str(dest))
    except Exception as e:
        print(f"  download(dir) warn: {e}", flush=True)

    if _rank_nc_candidates(dest):
        _log_dir("download", dest)
        return

    zip_path = dest / "product.zip"
    try:
        with prod.open() as stream, zip_path.open("wb") as out:
            shutil.copyfileobj(stream, out)
        if zipfile.is_zipfile(zip_path):
            _extract_zip(zip_path, dest)
            zip_path.unlink(missing_ok=True)
            print(f"  extracted zip → {len(list(dest.rglob('*')))} souborů", flush=True)
        elif zip_path.stat().st_size > 10_000:
            # Některé produkty jsou single-file stream bez .nc přípony
            raw = dest / "product.bin"
            zip_path.replace(raw)
    except Exception as e:
        print(f"  open() stream warn: {e}", flush=True)

    if not _rank_nc_candidates(dest):
        try:
            for entry in prod.entries:
                en = str(entry)
                out = dest / Path(en).name
                if out.exists() and out.stat().st_size > 10_000:
                    continue
                with prod.open(entry=entry) as stream, out.open("wb") as f:
                    shutil.copyfileobj(stream, f)
                if zipfile.is_zipfile(out):
                    _extract_zip(out, dest)
                    out.unlink(missing_ok=True)
        except Exception as e:
            print(f"  entries warn: {e}", flush=True)

    _log_dir("download", dest)


def _tailor_to_netcdf(prod, dest: Path, token) -> None:
    """MSG HRSEVIRI native → netcdf4 přes Data Tailor (sync wait)."""
    import time

    from eumdac import DataTailor

    dest.mkdir(parents=True, exist_ok=True)
    tailor = DataTailor(token)
    print("  tailor HRSEVIRI → netcdf4 …", flush=True)
    try:
        from eumdac.tailor_models import Chain

        chain = Chain(**MSG_TAILOR_CHAIN)
    except Exception:
        chain = MSG_TAILOR_CHAIN
    with tailor.new_customisation(prod, chain) as job:
        deadline = time.time() + 240
        while str(job.status).upper() in ("QUEUED", "RUNNING", "PROCESSING") and time.time() < deadline:
            time.sleep(5)
        status = str(job.status).upper()
        if status not in ("DONE", "COMPLETED", "SUCCESS"):
            raise RuntimeError(f"Data Tailor status={job.status}")
        job.download(dir=str(dest))


def _rank_nc_candidates(dest: Path) -> list[Path]:
    """Seřaď kandidáty — .nc / HDF5, preferuj datové chunky (_C_, BODY) před overview (_O_)."""
    cands: list[Path] = []
    for p in dest.rglob("*"):
        if not p.is_file() or p.stat().st_size <= 10_000:
            continue
        if p.suffix.lower() in (".nc", ".nc4") or _is_hdf5(p):
            cands.append(p)

    def score(p: Path) -> tuple[int, int, int]:
        name = p.name.upper()
        if "BODY" in name or "_C_" in name:
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


def _sample_temp_c(ds, var: str, lat: float, lon: float) -> float | None:
    """CTT → °C (K nebo už °C)."""
    v = _sample_raw_pixel(ds, var, lat, lon)
    if v is None or not math.isfinite(v):
        return None
    if 150 <= v <= 350:
        return v - 273.15
    if -90 < v < 40:
        return v
    return None


def _sample_height_raw(ds, var: str, lat: float, lon: float) -> float | None:
    """Surová CTH (m nebo km) — bez převodu K→°C."""
    v = _sample_raw_pixel(ds, var, lat, lon)
    if v is None or not math.isfinite(v) or v <= 0:
        return None
    return float(v)


# Zpětná kompatibilita
def _sample_field(ds, var: str, lat: float, lon: float) -> float | None:
    return _sample_temp_c(ds, var, lat, lon)


def _open_dataset(path: Path):
    import xarray as xr

    if not _is_hdf5(path):
        raise RuntimeError(f"{path.name} není HDF5/netCDF (neúplný download?)")

    errors: list[str] = []
    for engine in ("h5netcdf", "netcdf4", "scipy"):
        try:
            kwargs: dict = {
                "decode_cf": True,
                "mask_and_scale": True,
            }
            if engine == "h5netcdf":
                kwargs["invalid_netcdf"] = True
            return xr.open_dataset(path, engine=engine, **kwargs)
        except Exception as e:
            errors.append(f"{engine}: {e}")
    raise RuntimeError(f"Nelze otevřít {path.name}: {'; '.join(errors)}")


def _find_height_var(ds) -> str | None:
    """Hledej cloud-top height v netCDF/xarray datasetu."""
    prefer = (
        "cloud_top_height",
        "cth",
        "CTH",
        "CloudTopHeight",
        "cloud_top_altitude",
        "height",
    )
    names = list(getattr(ds, "data_vars", ds.variables if hasattr(ds, "variables") else []))
    lower = {str(n).lower(): str(n) for n in names}
    for p in prefer:
        if p.lower() in lower:
            return lower[p.lower()]
    for n in names:
        nl = str(n).lower()
        if "height" in nl and "temp" not in nl and "pressure" not in nl:
            return str(n)
    return None


def _normalize_height_m(value: float | None) -> float | None:
    if value is None or not math.isfinite(float(value)):
        return None
    v = float(value)
    if v <= 0:
        return None
    # MTG CTH může být v metrech nebo kilometrech
    if v < 25:
        return v * 1000.0
    if v > 100:
        return v
    return v * 1000.0


def _list_array_vars(ds) -> list[str]:
    names: list[str] = []
    if hasattr(ds, "data_vars"):
        names.extend(str(n) for n in ds.data_vars)
    if hasattr(ds, "variables"):
        names.extend(str(n) for n in ds.variables)
    # uniq, preserve order
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _find_mask_var(ds) -> str | None:
    prefer = ("cld_mask", "cloud_mask", "cma", "clm", "CloudMask", "mask")
    names = _list_array_vars(ds)
    lower = {str(n).lower(): str(n) for n in names}
    for p in prefer:
        if p.lower() in lower:
            return lower[p.lower()]
    for n in names:
        nl = str(n).lower()
        if "mask" in nl and "status" not in nl and "snow" not in nl and "test" not in nl:
            return str(n)
    return None


def _find_type_var(ds) -> str | None:
    prefer = ("cloud_type", "ct", "CloudType", "ctype")
    names = _list_array_vars(ds)
    lower = {str(n).lower(): str(n) for n in names}
    for p in prefer:
        if p.lower() in lower:
            return lower[p.lower()]
    for n in names:
        nl = str(n).lower()
        if nl == "ct" or ("cloud" in nl and "type" in nl):
            return str(n)
    return None


def _decode_attr_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="ignore")
    return str(value)


def _is_cloudy_mask(value: float | None, attrs: dict | None = None) -> bool | None:
    """NWC GEO-CMA: 0=cloud-free, 1=cloudy (MTG). Legacy: 2=contaminated."""
    if value is None or not math.isfinite(float(value)):
        return None
    v = int(round(float(value)))
    attrs = attrs or {}
    fill = attrs.get("_FillValue")
    if fill is not None and v == int(fill):
        return None
    meanings = _decode_attr_str(attrs.get("flag_meanings", "")).lower().split()
    if meanings and 0 <= v < len(meanings):
        m = meanings[v]
        if "free" in m or m in ("clear", "cloud-free", "cloud_free"):
            return False
        if "cloud" in m or "contamin" in m or m == "cloudy":
            return True
    if v == 0:
        return False
    if v == 1:
        return True
    if v >= 2:
        return True
    return None


def _cloud_level_from_type(code: int | None) -> str | None:
    """Zjednodušená vrstva mraku z NWC GEO-CT."""
    if code is None:
        return None
    if code <= 1:
        return None
    if code in (2, 3, 4, 5):
        return "fractional"
    if code in (6, 10, 11):
        return "low"
    if code in (7,):
        return "mid"
    if code in (8, 9, 12, 13, 14, 15):
        return "high"
    return "other"


def _find_ctth_status_var(ds) -> str | None:
    prefer = (
        "ctth_status_flag",
        "ctth_status",
        "cloud_top_status",
        "status_flag",
    )
    names = _list_array_vars(ds)
    lower = {str(n).lower(): str(n) for n in names}
    for p in prefer:
        if p.lower() in lower:
            return lower[p.lower()]
    for n in names:
        nl = str(n).lower()
        if "status" in nl and ("ctth" in nl or "cloud_top" in nl):
            return str(n)
    return None


def _is_valid_ctth_status(value: float | None) -> bool | None:
    """CTTH status: 255 / 0 = bez vrcholu; 1–2 = platný retrieval."""
    if value is None or not math.isfinite(float(value)):
        return None
    v = int(round(float(value)))
    if v in (0, 255):
        return False
    if 1 <= v <= 10:
        return True
    return None


def _looks_like_fill_temp(t_c: float | None, h_m: float | None) -> bool:
    """Flat ~13 °C bez výšky = typický clear/fill, ne cloud-top."""
    if t_c is None:
        return True
    if h_m is not None and h_m >= 1000:
        return False
    return 8.0 <= t_c <= 22.0


def _looks_like_cloud_top(t_c: float | None, h_m: float | None) -> bool:
    """Primární signál z CTTH: studený / vysoký vrchol."""
    if h_m is not None and h_m >= 1500:
        return True
    if t_c is not None and t_c <= 5.0:
        return True
    return False


def _cloudy_from_signals(
    *,
    t_c: float | None,
    h_m: float | None,
    mask_cloudy: bool | None,
    type_code: int | None,
    ctth_status_ok: bool | None,
) -> bool:
    """
    Cloud-top presence: CTTH T/H first, mask/type soft.

    Mask alone must NOT veto a physically cold/tall top (was wiping whole domain).
    """
    if _looks_like_cloud_top(t_c, h_m):
        return True
    if _looks_like_fill_temp(t_c, h_m):
        return False
    if ctth_status_ok is True and t_c is not None:
        return True
    if type_code is not None and type_code > 1 and t_c is not None and t_c < 8.0:
        return True
    if mask_cloudy is True and t_c is not None and not _looks_like_fill_temp(t_c, h_m):
        return True
    return False


def _cloudy_at_point(
    lat: float,
    lon: float,
    *,
    ds_mask,
    mvar: str | None,
    ds_type,
    tvar: str | None,
    ds_ctth,
    t_c: float | None = None,
    h_m: float | None = None,
) -> bool:
    mask_flag = _sample_cloud_flag(ds_mask, mvar, lat, lon) if ds_mask is not None else None
    type_code = (
        _sample_cloud_type_code(ds_type, tvar, lat, lon)
        if ds_type is not None
        else None
    )
    ctth_ok = None
    if ds_ctth is not None:
        svar = _find_ctth_status_var(ds_ctth)
        if svar:
            ctth_ok = _is_valid_ctth_status(_sample_raw_pixel(ds_ctth, svar, lat, lon))
    return _cloudy_from_signals(
        t_c=t_c,
        h_m=h_m,
        mask_cloudy=mask_flag,
        type_code=type_code,
        ctth_status_ok=ctth_ok,
    )


def _sample_raw_pixel(ds, var: str, lat: float, lon: float) -> float | None:
    if "mtg_geos_projection" in getattr(ds, "variables", ds):
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
        return v

    import numpy as np

    data = ds[var]
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
    if lats.size != vals.shape[0] and lats.size == vals.shape[1]:
        ji = int(np.argmin(np.abs(lons - lon)))
        ii = int(np.argmin(np.abs(lats - lat)))
        v = float(vals[ji, ii]) if vals.shape[0] == lons.size else float(vals[ii, ji])
    else:
        ii = int(np.argmin(np.abs(lats - lat)))
        jj = int(np.argmin(np.abs(lons - lon)))
        v = float(vals[ii, jj])
    if not math.isfinite(v):
        return None
    return v


def _sample_cloud_flag(
    ds, var: str | None, lat: float, lon: float, *, cloudy_fn=_is_cloudy_mask
) -> bool | None:
    if not var:
        return None
    raw = _sample_raw_pixel(ds, var, lat, lon)
    if raw is None:
        return None
    attrs = dict(getattr(ds[var], "attrs", {}))
    fill = attrs.get("_FillValue")
    if fill is not None and int(round(float(raw))) == int(fill):
        return None
    return cloudy_fn(raw, attrs)


def _sample_cloud_type_code(ds, var: str | None, lat: float, lon: float) -> int | None:
    if not var:
        return None
    raw = _sample_raw_pixel(ds, var, lat, lon)
    if raw is None or not math.isfinite(float(raw)):
        return None
    code = int(round(float(raw)))
    if code <= 0 or code >= 250:
        return None
    return code


def _pick_readable_nc_for_var(
    dest: Path, find_var, label: str = "var"
) -> Path | None:
    for path in _rank_nc_candidates(dest):
        try:
            ds = _open_dataset(path)
            var = find_var(ds)
            ds.close()
            if var:
                print(f"  using {path.name} ({label}={var})", flush=True)
                return path
        except Exception as e:
            print(f"  skip {path.name}: {e}", flush=True)
    for path in _rank_nc_candidates(dest)[:1]:
        try:
            ds = _open_dataset(path)
            vars_preview = _list_array_vars(ds)[:16]
            print(f"  {label}: no var in {path.name}, vars={vars_preview}", flush=True)
            ds.close()
        except Exception:
            pass
    return None


def _fetch_companion_nc(
    datastore,
    coll_id: str,
    dest: Path,
    find_var,
    *,
    now: datetime,
    label: str,
) -> Path | None:
    try:
        collection = datastore.get_collection(coll_id)
        products = list(
            collection.search(
                dtstart=now - timedelta(minutes=50),
                dtend=now + timedelta(minutes=5),
            )
        )
        if not products:
            products = list(
                collection.search(
                    dtstart=now - timedelta(hours=2),
                    dtend=now,
                )
            )
        if not products:
            print(f"  {label}: žádný produkt v {coll_id}", flush=True)
            return None
        prod = products[-1]
        print(f"  download {label} {prod}", flush=True)
        dest.mkdir(parents=True, exist_ok=True)
        _download_product(prod, dest)
        picked = _pick_readable_nc_for_var(dest, find_var, label=label)
        if not picked:
            print(f"  {label}: nelze přečíst netCDF z {coll_id}", flush=True)
        return picked
    except Exception as e:
        print(f"  {label} {coll_id}: {e}", flush=True)
        return None


def _collect_sample_locations() -> list[tuple[float, float, str]]:
    lats, lons = lat_lons()
    out: list[tuple[float, float, str]] = [(lat, lon, "grid") for lat in lats for lon in lons]

    def far_enough(lat: float, lon: float, min_km: float = 8.0) -> bool:
        return all(haversine_km(lat, lon, a, b) >= min_km for a, b, _ in out)

    cells_path = Path("public/data/opera/cells.geojson")
    if cells_path.is_file():
        try:
            fc = json.loads(cells_path.read_text(encoding="utf-8"))
            for feat in fc.get("features") or []:
                props = feat.get("properties") or {}
                lat = props.get("peakLat")
                lon = props.get("peakLon")
                if lat is None or lon is None:
                    continue
                lat_f, lon_f = float(lat), float(lon)
                if not far_enough(lat_f, lon_f, 6.0):
                    continue
                out.append((lat_f, lon_f, "cell"))
        except Exception as e:
            print(f"  cells.geojson sample skip ({e})", flush=True)

    form_path = Path("public/data/formation/grid.json")
    if form_path.is_file():
        try:
            grid = json.loads(form_path.read_text(encoding="utf-8"))
            for p in grid.get("points") or []:
                lat_f, lon_f = float(p["lat"]), float(p["lon"])
                if not far_enough(lat_f, lon_f, 6.0):
                    continue
                out.append((lat_f, lon_f, "formation"))
        except Exception as e:
            print(f"  formation grid sample skip ({e})", flush=True)

    return out


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def _build_sat_point(
    lat: float,
    lon: float,
    t0: float | None,
    t1: float | None,
    h0: float | None,
    h1: float | None,
    dt_min: float,
    source: str,
    *,
    cloudy_now: bool,
    cloud_type_code: int | None = None,
) -> dict | None:
    if not cloudy_now or t1 is None:
        if source in ("cell", "formation"):
            return {
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "hasCloudTop": False,
                "sampleSource": source,
            }
        return None

    scale = 15.0 / max(5.0, dt_min)
    d_per_15 = (t1 - t0) * scale if t0 is not None else 0.0
    d_per_15 = max(-8.0, min(4.0, d_per_15))
    pt: dict = {
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "hasCloudTop": True,
        "cloudTopTempC": round(t1, 2),
        "cloudTopCoolingCPer15min": round(d_per_15, 2),
        "sampleSource": source,
    }
    h1m = _normalize_height_m(h1)
    h0m = _normalize_height_m(h0)
    if h1m is not None:
        pt["cloudTopHeightM"] = round(h1m, 0)
    if h0m is not None and h1m is not None:
        dh = (h1m - h0m) * scale
        pt["cloudTopHeightDeltaMPer15min"] = round(max(-5000.0, min(5000.0, dh)), 0)
    if cloud_type_code is not None:
        pt["cloudTypeCode"] = cloud_type_code
        level = _cloud_level_from_type(cloud_type_code)
        if level:
            pt["cloudLevel"] = level
    return pt


def _cooling_from_two_files(
    older: Path,
    newer: Path,
    dt_min: float,
    *,
    mask_newer: Path | None = None,
    mask_older: Path | None = None,
    type_newer: Path | None = None,
) -> list[dict]:
    ds0 = _open_dataset(older)
    ds1 = _open_dataset(newer)
    ds_mask0 = _open_dataset(mask_older) if mask_older else None
    ds_mask1 = _open_dataset(mask_newer) if mask_newer else None
    ds_type1 = _open_dataset(type_newer) if type_newer else None
    try:
        var0 = _find_temp_var(ds0)
        var1 = _find_temp_var(ds1)
        if not var0 or not var1:
            raise RuntimeError(
                f"V datech není CTT (vars older={[v for v in getattr(ds0, 'data_vars', [])]})"
            )
        hvar0 = _find_height_var(ds0)
        hvar1 = _find_height_var(ds1)
        mvar0 = _find_mask_var(ds_mask0) if ds_mask0 is not None else None
        mvar1 = _find_mask_var(ds_mask1) if ds_mask1 is not None else None
        tvar1 = _find_type_var(ds_type1) if ds_type1 is not None else None
        if ds_mask1 is not None and not mvar1:
            print("  warn: cloud mask soubor bez cld_mask/cma — fallback cloud type/CTTH", flush=True)

        locations = _collect_sample_locations()
        points: list[dict] = []
        for lat, lon, source in locations:
            # Vždy vzorkuj CTTH — maska nesmí být absolutní veto (dřív: 0 cloudy / 0 sampled)
            t1 = _sample_temp_c(ds1, var1, lat, lon)
            h1_raw = _sample_height_raw(ds1, hvar1, lat, lon) if hvar1 else None
            h1m = _normalize_height_m(h1_raw)
            ctype = (
                _sample_cloud_type_code(ds_type1, tvar1, lat, lon)
                if ds_type1 is not None
                else None
            )
            cloudy_now = _cloudy_at_point(
                lat,
                lon,
                ds_mask=ds_mask1,
                mvar=mvar1,
                ds_type=ds_type1,
                tvar=tvar1,
                ds_ctth=ds1,
                t_c=t1,
                h_m=h1m,
            )
            t0 = None
            h0_raw = None
            if cloudy_now:
                t0 = _sample_temp_c(ds0, var0, lat, lon)
                h0_raw = _sample_height_raw(ds0, hvar0, lat, lon) if hvar0 else None
                # ΔT jen když i předchozí snímek vypadá jako cloud-top
                h0m = _normalize_height_m(h0_raw)
                if t0 is not None and not _looks_like_cloud_top(t0, h0m) and _looks_like_fill_temp(t0, h0m):
                    t0 = None
                    h0_raw = None
            pt = _build_sat_point(
                lat,
                lon,
                t0,
                t1 if cloudy_now else None,
                h0_raw,
                h1_raw if cloudy_now else None,
                dt_min,
                source,
                cloudy_now=bool(cloudy_now),
                cloud_type_code=ctype if cloudy_now else None,
            )
            if pt:
                points.append(pt)
        return points
    finally:
        for ds in (ds0, ds1, ds_mask0, ds_mask1, ds_type1):
            if ds is None:
                continue
            try:
                ds.close()
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

        use_tailor = coll_id == "EO:EUM:DAT:MSG:HRSEVIRI"
        with tempfile.TemporaryDirectory(prefix="sat_cool_") as tmp:
            tmp_path = Path(tmp)
            paths: list[Path] = []
            for i, prod in enumerate(products[-2:]):
                print(f"  download {prod}", flush=True)
                dest = tmp_path / f"frame_{i}"
                try:
                    if use_tailor:
                        _tailor_to_netcdf(prod, dest, token)
                    else:
                        _download_product(prod, dest)
                except Exception as e:
                    print(f"  download fail: {e}", flush=True)
                    continue
                picked = _pick_readable_nc(dest)
                if picked:
                    paths.append(picked)

            if len(paths) < 2:
                last_error = "Stažené produkty neobsahují čitelný netCDF s CTT"
                continue

            mask_newer = None
            mask_older = None
            type_newer = None
            if coll_id == "EO:EUM:DAT:0681":
                mask_newer = _fetch_companion_nc(
                    datastore,
                    MASK_COLLECTION,
                    tmp_path / "mask_new",
                    _find_mask_var,
                    now=now,
                    label="cloud_mask",
                )
                mask_older = _fetch_companion_nc(
                    datastore,
                    MASK_COLLECTION,
                    tmp_path / "mask_old",
                    _find_mask_var,
                    now=now - timedelta(minutes=DT_MINUTES),
                    label="cloud_mask_old",
                )
                type_newer = _fetch_companion_nc(
                    datastore,
                    TYPE_COLLECTION,
                    tmp_path / "cloud_type",
                    _find_type_var,
                    now=now,
                    label="cloud_type",
                )

            try:
                points = _cooling_from_two_files(
                    paths[0],
                    paths[1],
                    float(DT_MINUTES),
                    mask_newer=mask_newer,
                    mask_older=mask_older,
                    type_newer=type_newer,
                )
            except Exception as e:
                traceback.print_exc()
                last_error = f"Parse CTT selhal: {e}"
                continue

            cloudy_pts = [p for p in points if p.get("hasCloudTop") is not False]

            write_cooling(
                status="ok",
                source=f"EUMETSAT/{used_collection}",
                message=(
                    f"ΔT/ΔCTH / {DT_MINUTES} min (mask+type, "
                    f"{len(cloudy_pts)} cloudy / {len(points)} sampled)"
                ),
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
