"""
Stáhne národní radarové compositý (soft-fail per source).

Výstup: .cache/national/<source>/latest.h5 (+ latest.json s time/path)
Zdroje: chmi, dwd, shmu, imgw, mch
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin

import requests

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "national"
OUT_DIR = ROOT / "public" / "data" / "national"

TIMEOUT = 45
UA = {"User-Agent": "kraller-national-radar/1.0"}


class _HrefParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        for k, v in attrs:
            if k.lower() == "href" and v:
                self.hrefs.append(v)


def _list_hrefs(url: str) -> list[str]:
    r = requests.get(url, headers=UA, timeout=TIMEOUT)
    r.raise_for_status()
    p = _HrefParser()
    p.feed(r.text)
    return p.hrefs


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, headers=UA, stream=True, timeout=120) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1024 * 256):
                if chunk:
                    f.write(chunk)
        tmp.replace(dest)


def _write_meta(source: str, path: Path, extra: dict[str, Any] | None = None) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": source,
        "path": str(path.relative_to(ROOT)).replace("\\", "/"),
        "fetchedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **(extra or {}),
    }
    out = OUT_DIR / f"{source}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    # copy/symlink pointer for mosaic
    latest = CACHE / source / "latest.h5"
    if path.resolve() != latest.resolve():
        latest.parent.mkdir(parents=True, exist_ok=True)
        try:
            if latest.exists() or latest.is_symlink():
                latest.unlink()
        except OSError:
            pass
        try:
            os.link(path, latest)
        except OSError:
            import shutil

            shutil.copy2(path, latest)
    meta_path = CACHE / source / "latest.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({**meta, "path": str(latest.relative_to(ROOT)).replace("\\", "/")}, f, indent=2)
    return out


def fetch_chmi() -> dict[str, Any]:
    """ČHMÚ maxz HDF5 — stejný feed jako chmi_radar."""
    base = "https://opendata.chmi.cz/meteorology/weather/radar/composite/maxz/hdf5/"
    hrefs = _list_hrefs(base)
    hdf = [h for h in hrefs if h.lower().endswith((".hdf", ".h5", ".hdf5"))]
    if not hdf:
        raise RuntimeError("CHMI: no hdf in listing")
    hdf.sort()
    name = hdf[-1].split("/")[-1]
    url = urljoin(base, hdf[-1])
    dest = CACHE / "chmi" / name
    if not dest.is_file():
        print(f"CHMI: downloading {name}", flush=True)
        _download(url, dest)
    else:
        print(f"CHMI: cached {name}", flush=True)
    _write_meta("chmi", dest, {"url": url, "file": name})
    return {"ok": True, "source": "chmi", "file": name}


def fetch_dwd() -> dict[str, Any]:
    """DWD composite DMAX (ODIM HDF5)."""
    base = "https://opendata.dwd.de/weather/radar/composite/dmax/"
    hrefs = _list_hrefs(base)
    # composite_dmax_yyyymmdd_HHMM-hd5 or .h5 / .hdf5
    cands = [
        h
        for h in hrefs
        if re.search(r"dmax.*\.(h5|hdf5|hd5)$", h, re.I)
        or h.lower().endswith((".h5", ".hdf5", "-hd5"))
    ]
    if not cands:
        # sometimes files without extension pattern — take last hdf-like
        cands = [h for h in hrefs if "dmax" in h.lower() and not h.endswith("/")]
    if not cands:
        raise RuntimeError("DWD: no dmax files")
    cands.sort()
    name = cands[-1].split("/")[-1]
    url = urljoin(base, cands[-1])
    dest = CACHE / "dwd" / name
    if not dest.is_file():
        print(f"DWD: downloading {name}", flush=True)
        _download(url, dest)
    else:
        print(f"DWD: cached {name}", flush=True)
    _write_meta("dwd", dest, {"url": url, "file": name})
    return {"ok": True, "source": "dwd", "file": name}


def fetch_shmu() -> dict[str, Any]:
    """SHMÚ skcomp zmax — denní složky + HDF (HTTP; SSL cert often broken)."""
    bases = [
        "http://opendata.shmu.sk/meteorology/weather/radar/composite/skcomp/zmax/",
        "https://opendata.shmu.sk/meteorology/weather/radar/composite/skcomp/zmax/",
    ]
    last_err: Exception | None = None
    for base in bases:
        try:
            # SHMÚ cert chain je často neúplný — soft verify off na https
            verify = base.startswith("http://")
            session_get = lambda u: requests.get(
                u, headers=UA, timeout=TIMEOUT, verify=verify
            )
            r = session_get(base)
            r.raise_for_status()
            p = _HrefParser()
            p.feed(r.text)
            hrefs = p.hrefs
            days = sorted(
                [
                    h.strip("/").split("/")[-1]
                    for h in hrefs
                    if re.fullmatch(r"\d{8}/?", h.strip("/"))
                ],
            )
            if not days:
                files = [
                    h for h in hrefs if h.lower().endswith((".h5", ".hdf", ".hdf5"))
                ]
                if not files:
                    raise RuntimeError("SHMU: no day folders or files")
                files.sort()
                name = files[-1].split("/")[-1]
                url = urljoin(base, files[-1])
                dest = CACHE / "shmu" / name
                if not dest.is_file():
                    print(f"SHMU: downloading {name}", flush=True)
                    with requests.get(
                        url, headers=UA, stream=True, timeout=120, verify=verify
                    ) as resp:
                        resp.raise_for_status()
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        with open(dest, "wb") as f:
                            for chunk in resp.iter_content(1024 * 256):
                                if chunk:
                                    f.write(chunk)
                else:
                    print(f"SHMU: cached {name}", flush=True)
                _write_meta("shmu", dest, {"url": url, "file": name})
                return {"ok": True, "source": "shmu", "file": name}

            day = days[-1]
            day_url = urljoin(base, day + "/")
            r2 = session_get(day_url)
            r2.raise_for_status()
            p2 = _HrefParser()
            p2.feed(r2.text)
            files = [
                h for h in p2.hrefs if h.lower().endswith((".h5", ".hdf", ".hdf5"))
            ]
            if not files:
                raise RuntimeError(f"SHMU: no files in {day}")
            files.sort()
            name = files[-1].split("/")[-1]
            url = urljoin(day_url, files[-1])
            dest = CACHE / "shmu" / f"{day}_{name}"
            if not dest.is_file():
                print(f"SHMU: downloading {day}/{name}", flush=True)
                with requests.get(
                    url, headers=UA, stream=True, timeout=120, verify=verify
                ) as resp:
                    resp.raise_for_status()
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with open(dest, "wb") as f:
                        for chunk in resp.iter_content(1024 * 256):
                            if chunk:
                                f.write(chunk)
            else:
                print(f"SHMU: cached {day}/{name}", flush=True)
            _write_meta("shmu", dest, {"url": url, "file": name, "day": day})
            return {"ok": True, "source": "shmu", "file": name}
        except Exception as exc:
            last_err = exc
            print(f"SHMU try {base}: {exc}", flush=True)
    raise RuntimeError(f"SHMU failed: {last_err}")


def fetch_imgw() -> dict[str, Any]:
    """IMGW HVD CMAX composite via public datastore API."""
    list_url = "https://danepubliczne.imgw.pl/datastore/getFilesList"
    # Polish + EN endpoints vary — try path query
    product = "Oper/Polrad/Produkty/HVD/HVD_COMPO_CMAX_250.comp.cmax"
    # API often wants POST or GET with path
    candidates = [
        f"{list_url}?path={product}",
        f"https://danepubliczne.imgw.pl/en/datastore/getFilesList?path={product}",
        f"https://danepubliczne.imgw.pl/datastore/getfiledown/{product}",
    ]
    listing: list[str] = []
    for u in candidates[:2]:
        try:
            r = requests.get(u, headers=UA, timeout=TIMEOUT)
            if not r.ok:
                continue
            data = r.json() if "json" in (r.headers.get("content-type") or "") else None
            if isinstance(data, list):
                listing = [str(x.get("fileName") or x.get("name") or x) for x in data if x]
            elif isinstance(data, dict):
                files = data.get("files") or data.get("data") or data.get("list") or []
                listing = [str(x.get("fileName") or x.get("name") or x) for x in files]
            if listing:
                break
            # HTML fallback
            hrefs = _list_hrefs(u) if False else []
            listing = hrefs
        except Exception as exc:
            print(f"IMGW list try failed ({exc})", flush=True)

    if not listing:
        # Direct directory scrape known mirror pattern
        scrape = f"https://danepubliczne.imgw.pl/data/produkty/oper/polrad/hvd_compo_cmax_250/"
        try:
            hrefs = _list_hrefs(scrape)
            listing = [h for h in hrefs if h.lower().endswith((".h5", ".hdf", ".hdf5", ".gz"))]
        except Exception:
            listing = []

    if not listing:
        raise RuntimeError("IMGW: could not list CMAX files")

    listing = [x.split("/")[-1] for x in listing if x]
    listing.sort()
    name = listing[-1]
    down_bases = [
        f"https://danepubliczne.imgw.pl/datastore/getfiledown/{product}/",
        f"https://danepubliczne.imgw.pl/en/datastore/getfiledown/{product}/",
        "https://danepubliczne.imgw.pl/data/produkty/oper/polrad/hvd_compo_cmax_250/",
    ]
    dest = CACHE / "imgw" / name
    if dest.is_file():
        print(f"IMGW: cached {name}", flush=True)
        _write_meta("imgw", dest, {"file": name})
        return {"ok": True, "source": "imgw", "file": name}

    last_err: Exception | None = None
    for b in down_bases:
        url = urljoin(b if b.endswith("/") else b + "/", name)
        try:
            print(f"IMGW: downloading {url}", flush=True)
            _download(url, dest)
            _write_meta("imgw", dest, {"url": url, "file": name})
            return {"ok": True, "source": "imgw", "file": name}
        except Exception as exc:
            last_err = exc
            if dest.exists():
                dest.unlink(missing_ok=True)
    raise RuntimeError(f"IMGW download failed: {last_err}")


def fetch_mch() -> dict[str, Any]:
    """MeteoSwiss RZC (rain rate) via STAC — convert later in mosaic."""
    coll = (
        "https://data.geo.admin.ch/api/stac/v1/collections/"
        "ch.meteoschweiz.ogd-radar-precip/items"
    )
    # newest items first
    r = requests.get(
        coll,
        headers=UA,
        params={"limit": 20, "datetime": "../now"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    features = data.get("features") or []
    asset_url = None
    item_id = None
    for feat in features:
        assets = feat.get("assets") or {}
        # Prefer RZC / PRECIP hdf
        for key, asset in assets.items():
            href = (asset or {}).get("href") or ""
            k = key.lower()
            if href and (
                "rzc" in k
                or "rzc" in href.lower()
                or href.lower().endswith(".h5")
            ):
                if "cpc" in href.lower() and "rzc" not in href.lower():
                    continue
                asset_url = href
                item_id = feat.get("id")
                break
        if asset_url:
            break
    if not asset_url:
        raise RuntimeError("MCH: no RZC asset in STAC")
    name = asset_url.split("/")[-1] or f"{item_id}.h5"
    dest = CACHE / "mch" / name
    if not dest.is_file():
        print(f"MCH: downloading {name}", flush=True)
        _download(asset_url, dest)
    else:
        print(f"MCH: cached {name}", flush=True)
    _write_meta(
        "mch",
        dest,
        {"url": asset_url, "file": name, "quantity": "RATE", "itemId": item_id},
    )
    return {"ok": True, "source": "mch", "file": name}


FETCHERS: dict[str, Callable[[], dict[str, Any]]] = {
    "chmi": fetch_chmi,
    "dwd": fetch_dwd,
    "shmu": fetch_shmu,
    "imgw": fetch_imgw,
    "mch": fetch_mch,
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch national radar composites")
    ap.add_argument(
        "--sources",
        default="chmi,dwd,shmu,imgw,mch",
        help="Comma-separated: chmi,dwd,shmu,imgw,mch",
    )
    args = ap.parse_args()
    wanted = [s.strip().lower() for s in args.sources.split(",") if s.strip()]
    results: dict[str, Any] = {}
    ok_n = 0
    for src in wanted:
        fn = FETCHERS.get(src)
        if not fn:
            print(f"WARN: unknown source {src}", flush=True)
            results[src] = {"ok": False, "error": "unknown"}
            continue
        try:
            results[src] = fn()
            ok_n += 1
        except Exception as exc:
            print(f"WARN: {src} fetch failed: {exc}", flush=True)
            results[src] = {"ok": False, "error": str(exc)}

    summary = OUT_DIR / "fetch-summary.json"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(summary, "w", encoding="utf-8") as f:
        json.dump(
            {
                "fetchedAt": dt.datetime.now(dt.timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "results": results,
            },
            f,
            indent=2,
        )
    print(f"National fetch: {ok_n}/{len(wanted)} ok -> {summary}", flush=True)
    # Soft-fail: exit 0 even if some missing (OPERA fill)
    return 0 if ok_n > 0 or not wanted else 0


if __name__ == "__main__":
    raise SystemExit(main())
