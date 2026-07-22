#!/usr/bin/env python3
"""Satelitní cloud-top cooling (EUMETSAT, zdarma s EO Portal klíči).

Bez EUMETSAT_CONSUMER_KEY / EUMETSAT_CONSUMER_SECRET:
  zapíše cooling.json se statusem no_credentials (formation zůstane na model proxy).

S klíči (běží v Live radar až PO R2 uploadu radaru):
  stáhne 3 snímky CTTH (~15 + ~30–45 min trend) + cloud mask + cloud type
  + MTG Lightning flashes u vzorků, zapíše cooling.json.

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
LI_COLLECTION = "EO:EUM:DAT:0691"  # MTG LI Lightning Flashes
MSG_TAILOR_CHAIN = {"product": "HRSEVIRI", "format": "netcdf4", "projection": "geographic"}
DT_MINUTES = 15
DT_LONG_MINUTES = 45
LI_RADIUS_KM = 25.0
LI_WINDOW_MIN = 15.0


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


def _sample_temp_c(
    ds, var: str, lat: float, lon: float, *, neighborhood: int = 1
) -> float | None:
    """CTT → °C (K nebo už °C). neighborhood=1 → studenější pixel v 3×3."""
    v = _sample_raw_pixel(ds, var, lat, lon, neighborhood=neighborhood)
    if v is None or not math.isfinite(v):
        return None
    if 150 <= v <= 350:
        return v - 273.15
    if -90 < v < 40:
        return v
    return None


def _sample_height_raw(
    ds, var: str, lat: float, lon: float, *, neighborhood: int = 1
) -> float | None:
    """Surová CTH (m nebo km). neighborhood=1 → max výška v 3×3."""
    import numpy as np

    if neighborhood <= 0:
        v = _sample_raw_pixel(ds, var, lat, lon, neighborhood=0)
        if v is None or not math.isfinite(v) or v <= 0:
            return None
        return float(v)

    # Pro výšku ber maximum v okolí (vyšší věž)
    idx = None
    if "mtg_geos_projection" in getattr(ds, "variables", ds):
        idx = _geos_index(ds, lat, lon)
    if idx is None:
        v = _sample_raw_pixel(ds, var, lat, lon, neighborhood=0)
        if v is None or not math.isfinite(v) or v <= 0:
            return None
        return float(v)
    yi, xi = idx
    vals = np.asarray(ds[var].values, dtype=float)
    while vals.ndim > 2:
        vals = vals[0]
    r = neighborhood
    y0, y1 = max(0, yi - r), min(vals.shape[0], yi + r + 1)
    x0, x1 = max(0, xi - r), min(vals.shape[1], xi + r + 1)
    patch = vals[y0:y1, x0:x1]
    finite = patch[np.isfinite(patch) & (patch > 0)]
    if finite.size == 0:
        return None
    return float(np.max(finite))


# Zpětná kompatibilita
def _sample_field(ds, var: str, lat: float, lon: float) -> float | None:
    return _sample_temp_c(ds, var, lat, lon, neighborhood=0)


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


def _is_deep_ice_top(code: int | None, level: str | None) -> bool:
    """High / opaque ice cloud type ≈ hluboká konvekce nahoře."""
    if level == "high":
        return True
    if code is not None and code in (8, 9, 12, 13, 14, 15):
        return True
    return False


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


def _geos_axes_meters(ds) -> tuple[object, object, float] | None:
    """Převeď FCI x/y (radiany nebo stupně) → metry v geos projekci."""
    import numpy as np

    if "mtg_geos_projection" not in ds or "x" not in ds or "y" not in ds:
        return None
    proj = ds["mtg_geos_projection"]
    h = float(proj.attrs["perspective_point_height"])
    x = np.asarray(ds["x"].values, dtype=float)
    y = np.asarray(ds["y"].values, dtype=float)
    x_units = str(getattr(ds["x"], "attrs", {}).get("units", "radian")).lower()
    y_units = str(getattr(ds["y"], "attrs", {}).get("units", "radian")).lower()
    # FCI L2: x/y = scanning angle v radiánech. Staré -degrees(x)*h bylo ~57× vedle.
    if "deg" in x_units:
        x_rad = np.deg2rad(x)
    else:
        x_rad = x
    if "deg" in y_units:
        y_rad = np.deg2rad(y)
    else:
        y_rad = y
    # sweep=y: x znaménko typicky invertované (satpy / CF geos)
    x_m_grid = -h * x_rad
    y_m_grid = h * y_rad
    return x_m_grid, y_m_grid, h


def _geos_index(ds, lat: float, lon: float) -> tuple[int, int] | None:
    import numpy as np
    from pyproj import CRS, Transformer

    axes = _geos_axes_meters(ds)
    if axes is None:
        return None
    x_m_grid, y_m_grid, _h = axes
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
    if not (math.isfinite(x_m) and math.isfinite(y_m)):
        return None
    xi = int(np.argmin(np.abs(x_m_grid - x_m)))
    yi = int(np.argmin(np.abs(y_m_grid - y_m)))
    return yi, xi


def _sample_raw_pixel(
    ds, var: str, lat: float, lon: float, *, neighborhood: int = 0
) -> float | None:
    """Vzorek pixelu; neighborhood>0 → min v okolí (studenější / vyšší top)."""
    import numpy as np

    if "mtg_geos_projection" in getattr(ds, "variables", ds):
        idx = _geos_index(ds, lat, lon)
        if idx is None:
            return None
        yi, xi = idx
        data = ds[var]
        vals = np.asarray(data.values, dtype=float)
        while vals.ndim > 2:
            vals = vals[0]
        if neighborhood <= 0:
            v = float(vals[yi, xi])
            return v if math.isfinite(v) else None
        # 3×3 (nebo větší) — ber nejnižší finite (CTT studenější = silnější konvekce)
        r = neighborhood
        y0, y1 = max(0, yi - r), min(vals.shape[0], yi + r + 1)
        x0, x1 = max(0, xi - r), min(vals.shape[1], xi + r + 1)
        patch = vals[y0:y1, x0:x1]
        finite = patch[np.isfinite(patch)]
        if finite.size == 0:
            return None
        return float(np.min(finite))

    data = ds[var]
    vals = np.asarray(data.values, dtype=float)
    while vals.ndim > 2:
        vals = vals[0]
    lat_name = None
    lon_name = None
    for cand in ("lat", "latitude"):
        if cand in ds.coords or cand in getattr(ds, "variables", {}):
            lat_name = cand
            break
    for cand in ("lon", "longitude"):
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
    t_mid: float | None,
    t_new: float | None,
    h_mid: float | None,
    h_new: float | None,
    dt_short_min: float,
    source: str,
    *,
    cloudy_now: bool,
    cloud_type_code: int | None = None,
    t_old: float | None = None,
    dt_long_min: float | None = None,
    lightning_flashes: int | None = None,
) -> dict | None:
    if not cloudy_now or t_new is None:
        if source in ("cell", "formation"):
            pt_clear: dict = {
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "hasCloudTop": False,
                "sampleSource": source,
            }
            if lightning_flashes is not None and lightning_flashes > 0:
                pt_clear["lightningFlashes15min"] = lightning_flashes
            return pt_clear
        return None

    scale15 = 15.0 / max(5.0, dt_short_min)
    d_per_15 = (t_new - t_mid) * scale15 if t_mid is not None else 0.0
    d_per_15 = max(-8.0, min(4.0, d_per_15))
    pt: dict = {
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "hasCloudTop": True,
        "cloudTopTempC": round(t_new, 2),
        "cloudTopCoolingCPer15min": round(d_per_15, 2),
        "sampleSource": source,
    }
    if t_old is not None and dt_long_min is not None and dt_long_min >= 20:
        scale45 = 45.0 / max(20.0, dt_long_min)
        d_per_45 = (t_new - t_old) * scale45
        d_per_45 = max(-12.0, min(6.0, d_per_45))
        pt["cloudTopCoolingCPer45min"] = round(d_per_45, 2)
    h1m = _normalize_height_m(h_new)
    h0m = _normalize_height_m(h_mid)
    if h1m is not None:
        pt["cloudTopHeightM"] = round(h1m, 0)
    if h0m is not None and h1m is not None:
        dh = (h1m - h0m) * scale15
        pt["cloudTopHeightDeltaMPer15min"] = round(max(-5000.0, min(5000.0, dh)), 0)
    if cloud_type_code is not None:
        pt["cloudTypeCode"] = cloud_type_code
        level = _cloud_level_from_type(cloud_type_code)
        if level:
            pt["cloudLevel"] = level
        if _is_deep_ice_top(cloud_type_code, level):
            pt["deepIceTop"] = True
    if lightning_flashes is not None:
        pt["lightningFlashes15min"] = int(lightning_flashes)
    return pt


def _count_lightning_near(
    flashes: list[tuple[float, float]],
    lat: float,
    lon: float,
    radius_km: float = LI_RADIUS_KM,
) -> int:
    if not flashes:
        return 0
    n = 0
    for flat, flon in flashes:
        if haversine_km(lat, lon, flat, flon) <= radius_km:
            n += 1
    return n


def _extract_flash_latlons(ds) -> list[tuple[float, float]]:
    """LI Flash NetCDF — lat/lon pole (různé názvy)."""
    import numpy as np

    names = _list_array_vars(ds)
    lower = {str(n).lower(): str(n) for n in names}
    lat_name = None
    lon_name = None
    for cand in ("latitude", "lat", "flash_lat", "flash_latitude"):
        if cand in lower:
            lat_name = lower[cand]
            break
    for cand in ("longitude", "lon", "flash_lon", "flash_longitude"):
        if cand in lower:
            lon_name = lower[cand]
            break
    if not lat_name or not lon_name:
        return []
    lats = np.asarray(ds[lat_name].values, dtype=float).ravel()
    lons = np.asarray(ds[lon_name].values, dtype=float).ravel()
    out: list[tuple[float, float]] = []
    for a, b in zip(lats, lons):
        if math.isfinite(a) and math.isfinite(b) and SOUTH - 1 <= a <= NORTH + 1:
            if WEST - 1 <= b <= EAST + 1:
                out.append((float(a), float(b)))
    return out


def _fetch_lightning_flashes(datastore, dest: Path, *, now: datetime) -> list[tuple[float, float]]:
    """Stáhni poslední LI flashes; vrať (lat, lon) v okně domény."""
    try:
        collection = datastore.get_collection(LI_COLLECTION)
        products = list(
            collection.search(
                dtstart=now - timedelta(minutes=LI_WINDOW_MIN + 5),
                dtend=now + timedelta(minutes=2),
            )
        )
        if not products:
            print(f"  lightning: žádný produkt {LI_COLLECTION}", flush=True)
            return []
        # Vezmi až 2 nejnovější chunky
        flashes: list[tuple[float, float]] = []
        for i, prod in enumerate(products[-2:]):
            print(f"  download lightning {prod}", flush=True)
            frame = dest / f"li_{i}"
            frame.mkdir(parents=True, exist_ok=True)
            _download_product(prod, frame)

            for path in _rank_nc_candidates(frame):
                try:
                    ds = _open_dataset(path)
                    got = _extract_flash_latlons(ds)
                    ds.close()
                    if got:
                        flashes.extend(got)
                        print(f"  lightning: +{len(got)} flashes from {path.name}", flush=True)
                        break
                except Exception as e:
                    print(f"  lightning skip {path.name}: {e}", flush=True)
        print(f"  lightning: total {len(flashes)} flashes in domain window", flush=True)
        return flashes
    except Exception as e:
        print(f"  lightning {LI_COLLECTION}: {e}", flush=True)
        return []


def _cooling_from_frames(
    mid: Path,
    newer: Path,
    dt_short_min: float,
    *,
    oldest: Path | None = None,
    dt_long_min: float | None = None,
    mask_newer: Path | None = None,
    type_newer: Path | None = None,
    lightning: list[tuple[float, float]] | None = None,
) -> list[dict]:
    ds_mid = _open_dataset(mid)
    ds_new = _open_dataset(newer)
    ds_old = _open_dataset(oldest) if oldest else None
    ds_mask1 = _open_dataset(mask_newer) if mask_newer else None
    ds_type1 = _open_dataset(type_newer) if type_newer else None
    try:
        var_mid = _find_temp_var(ds_mid)
        var_new = _find_temp_var(ds_new)
        if not var_mid or not var_new:
            raise RuntimeError(
                f"V datech není CTT (vars newer={[v for v in getattr(ds_new, 'data_vars', [])]})"
            )
        var_old = _find_temp_var(ds_old) if ds_old is not None else None
        hvar_mid = _find_height_var(ds_mid)
        hvar_new = _find_height_var(ds_new)
        mvar1 = _find_mask_var(ds_mask1) if ds_mask1 is not None else None
        tvar1 = _find_type_var(ds_type1) if ds_type1 is not None else None
        if ds_mask1 is not None and not mvar1:
            print("  warn: cloud mask soubor bez cld_mask/cma — fallback cloud type/CTTH", flush=True)

        locations = _collect_sample_locations()
        points: list[dict] = []
        n_none = 0
        n_fill = 0
        n_cold = 0
        n_li = 0
        temps: list[float] = []
        heights: list[float] = []
        print(
            f"  CTTH vars temp={var_new} height={hvar_new} mask={mvar1} type={tvar1} "
            f"long={'yes' if ds_old else 'no'} li={len(lightning or [])} locs={len(locations)}",
            flush=True,
        )
        for lat, lon, source in locations:
            t1 = _sample_temp_c(ds_new, var_new, lat, lon)
            h1_raw = _sample_height_raw(ds_new, hvar_new, lat, lon) if hvar_new else None
            h1m = _normalize_height_m(h1_raw)
            if t1 is None:
                n_none += 1
            else:
                temps.append(t1)
            if h1m is not None:
                heights.append(h1m)
            if t1 is not None and _looks_like_fill_temp(t1, h1m):
                n_fill += 1
            if _looks_like_cloud_top(t1, h1m):
                n_cold += 1
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
                ds_ctth=ds_new,
                t_c=t1,
                h_m=h1m,
            )
            t_mid = None
            h_mid_raw = None
            t_old = None
            if cloudy_now:
                t_mid = _sample_temp_c(ds_mid, var_mid, lat, lon)
                h_mid_raw = (
                    _sample_height_raw(ds_mid, hvar_mid, lat, lon) if hvar_mid else None
                )
                h_mid_m = _normalize_height_m(h_mid_raw)
                if (
                    t_mid is not None
                    and not _looks_like_cloud_top(t_mid, h_mid_m)
                    and _looks_like_fill_temp(t_mid, h_mid_m)
                ):
                    t_mid = None
                    h_mid_raw = None
                if ds_old is not None and var_old:
                    t_old = _sample_temp_c(ds_old, var_old, lat, lon)
                    h_old_m = None
                    if t_old is not None and _looks_like_fill_temp(t_old, h_old_m):
                        if not _looks_like_cloud_top(t_old, None):
                            t_old = None
            flashes = _count_lightning_near(lightning or [], lat, lon)
            if flashes > 0:
                n_li += 1
            pt = _build_sat_point(
                lat,
                lon,
                t_mid,
                t1 if cloudy_now else None,
                h_mid_raw,
                h1_raw if cloudy_now else None,
                dt_short_min,
                source,
                cloudy_now=bool(cloudy_now),
                cloud_type_code=ctype if cloudy_now else None,
                t_old=t_old if cloudy_now else None,
                dt_long_min=dt_long_min if cloudy_now else None,
                lightning_flashes=flashes if flashes > 0 or source in ("cell", "formation") else None,
            )
            if pt:
                points.append(pt)
        t_info = (
            f"t=[{min(temps):.1f}..{max(temps):.1f}]"
            if temps
            else "t=none"
        )
        h_info = (
            f"h=[{min(heights):.0f}..{max(heights):.0f}]m"
            if heights
            else "h=none"
        )
        print(
            f"  CTTH diag: none={n_none} fill={n_fill} cold/tall={n_cold} "
            f"liPts={n_li} out={len(points)} {t_info} {h_info}",
            flush=True,
        )
        return points
    finally:
        for ds in (ds_mid, ds_new, ds_old, ds_mask1, ds_type1):
            if ds is None:
                continue
            try:
                ds.close()
            except Exception:
                pass


# Alias pro starší volání / testy
def _cooling_from_two_files(
    older: Path,
    newer: Path,
    dt_min: float,
    *,
    mask_newer: Path | None = None,
    mask_older: Path | None = None,
    type_newer: Path | None = None,
) -> list[dict]:
    del mask_older  # unused — CTTH-primary
    return _cooling_from_frames(
        older,
        newer,
        dt_min,
        mask_newer=mask_newer,
        type_newer=type_newer,
    )


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

    # Seřadit od nejstaršího; víc snímků = lepší span ~45 min
    products = list(reversed(products[:8]))
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
                products = list(reversed(got[:8]))
                used_collection = coll_id
                print(f"  fallback collection {coll_id}", flush=True)
            except Exception as e:
                print(f"  fallback {coll_id}: {e}", flush=True)
                continue

        use_tailor = coll_id == "EO:EUM:DAT:MSG:HRSEVIRI"
        with tempfile.TemporaryDirectory(prefix="sat_cool_") as tmp:
            tmp_path = Path(tmp)
            # 3 CTTH: ~45 min zpět + ~15 min + teď (při ~10min kadenci)
            if len(products) >= 5:
                frame_prods = [products[-5], products[-2], products[-1]]
            elif len(products) >= 3:
                frame_prods = [products[0], products[-2], products[-1]]
            else:
                frame_prods = products[-2:]
            paths: list[Path] = []
            for i, prod in enumerate(frame_prods):
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

            oldest_path = paths[0] if len(paths) >= 3 else None
            mid_path = paths[-2]
            newer_path = paths[-1]
            dt_long = float(DT_LONG_MINUTES) if oldest_path else None

            mask_newer = None
            type_newer = None
            lightning: list[tuple[float, float]] = []
            if coll_id == "EO:EUM:DAT:0681":
                mask_newer = _fetch_companion_nc(
                    datastore,
                    MASK_COLLECTION,
                    tmp_path / "mask_new",
                    _find_mask_var,
                    now=now,
                    label="cloud_mask",
                )
                # Cloud type default ON (sat běží až po R2 — neblokuje radar)
                skip_type = os.environ.get("SAT_SKIP_CLOUD_TYPE", "").strip().lower() in (
                    "1",
                    "true",
                    "yes",
                )
                if not skip_type:
                    type_newer = _fetch_companion_nc(
                        datastore,
                        TYPE_COLLECTION,
                        tmp_path / "cloud_type",
                        _find_type_var,
                        now=now,
                        label="cloud_type",
                    )
                skip_li = os.environ.get("SAT_SKIP_LIGHTNING", "").strip().lower() in (
                    "1",
                    "true",
                    "yes",
                )
                if not skip_li:
                    lightning = _fetch_lightning_flashes(
                        datastore, tmp_path / "lightning", now=now
                    )

            try:
                points = _cooling_from_frames(
                    mid_path,
                    newer_path,
                    float(DT_MINUTES),
                    oldest=oldest_path,
                    dt_long_min=dt_long,
                    mask_newer=mask_newer,
                    type_newer=type_newer,
                    lightning=lightning,
                )
            except Exception as e:
                traceback.print_exc()
                last_error = f"Parse CTT selhal: {e}"
                continue

            cloudy_pts = [p for p in points if p.get("hasCloudTop") is not False]
            status = "ok" if cloudy_pts else "empty"
            write_cooling(
                status=status,
                source=f"EUMETSAT/{used_collection}",
                message=(
                    f"ΔT15/ΔT45+type+LI (mask, "
                    f"{len(cloudy_pts)} cloudy / {len(points)} sampled, "
                    f"li={len(lightning)})"
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
