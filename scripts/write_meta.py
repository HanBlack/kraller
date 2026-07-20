"""Zapíše čas poslední aktualizace dat pro frontend — po zdrojích."""

from __future__ import annotations

import datetime as dt
import json
import os
from typing import Any

OUT = os.path.join("public", "data", "meta.json")
CELLS = os.path.join("public", "data", "opera", "cells.geojson")
LATEST = os.path.join("public", "data", "opera", "latest.geojson")
ARCHIVE_MANIFEST = os.path.join("public", "data", "opera", "archive", "manifest.json")
CHMI_META = os.path.join("public", "data", "chmi", "meta.json")

SOURCE_FILES = {
    "opera": LATEST,
    "chmi": CHMI_META,
    "wind": os.path.join("public", "data", "wind", "low.json"),
    "formation": os.path.join("public", "data", "formation", "grid.json"),
}


def normalize_opera_time(raw: Any) -> str | None:
    """YYYYMMDDHHMMSS / ISO → ISO UTC. Snese i 12 znaků (bez sekund)."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # ISO už hotové
    if "T" in s and len(s) >= 16:
        try:
            return (
                dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
                .astimezone(dt.timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ")
            )
        except ValueError:
            pass
    digits = "".join(ch for ch in s if ch.isdigit())
    if len(digits) < 12:
        return None
    digits = (digits + "00")[:14]
    try:
        return (
            f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}T"
            f"{digits[8:10]}:{digits[10:12]}:{digits[12:14]}Z"
        )
    except (IndexError, ValueError):
        return None


def _time_from_geojson(path: str) -> str | None:
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for feat in data.get("features") or []:
            t = normalize_opera_time((feat.get("properties") or {}).get("time"))
            if t:
                return t
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None
    return None


def _time_from_archive_manifest() -> str | None:
    if not os.path.isfile(ARCHIVE_MANIFEST):
        return None
    try:
        with open(ARCHIVE_MANIFEST, encoding="utf-8") as f:
            data = json.load(f)
        frames = data.get("frames") or []
        if not frames:
            return None
        return normalize_opera_time(frames[-1].get("time"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def chmi_product_time(prev_meta: dict[str, Any] | None = None) -> str | None:
    if os.path.isfile(CHMI_META):
        try:
            with open(CHMI_META, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                t = normalize_opera_time(data.get("validAt") or data.get("productTime"))
                if t:
                    return t
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    if prev_meta:
        return normalize_opera_time(prev_meta.get("chmiTime"))
    return None


def opera_product_time(prev_meta: dict[str, Any] | None = None) -> str | None:
    """Čas snímku OPERA — cells → latest → archive → předchozí meta."""
    for path in (CELLS, LATEST):
        t = _time_from_geojson(path)
        if t:
            return t
    t = _time_from_archive_manifest()
    if t:
        return t
    if prev_meta:
        return normalize_opera_time(prev_meta.get("operaTime"))
    return None


def file_valid_at(path: str) -> str | None:
    """validAt z JSON, jinak mtime souboru (ISO UTC)."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("validAt"):
            return str(data["validAt"])
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass
    try:
        mtime = os.path.getmtime(path)
        return (
            dt.datetime.fromtimestamp(mtime, tz=dt.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ")
        )
    except OSError:
        return None


def load_previous() -> dict[str, Any]:
    if not os.path.isfile(OUT):
        return {}
    try:
        with open(OUT, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_meta(run_results: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """
    run_results: { "opera": {"ok": True}, "wind": {"ok": False, "error": "429"}, ... }
    Při ok aktualizuje timestamp zdroje; při fail zachová starý čas a nastaví ok=false.
    Bez run_results bere validAt přímo ze souborů (Live radar po refresh_env).
    """
    prev = load_previous()
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    prev_sources = prev.get("sources") if isinstance(prev.get("sources"), dict) else {}
    sources: dict[str, Any] = {}

    for name, path in SOURCE_FILES.items():
        exists = os.path.isfile(path)
        old = prev_sources.get(name) if isinstance(prev_sources.get(name), dict) else {}
        result = (run_results or {}).get(name)
        file_ts = file_valid_at(path) if exists else None

        if result is not None:
            if result.get("ok"):
                sources[name] = {
                    "ok": True,
                    "updatedAt": file_ts or now,
                    "error": None,
                }
            else:
                sources[name] = {
                    "ok": False,
                    "updatedAt": file_ts or old.get("updatedAt"),
                    "error": result.get("error") or "failed",
                }
        else:
            sources[name] = {
                "ok": bool(exists),
                "updatedAt": file_ts or old.get("updatedAt") or (now if exists else None),
                "error": None if exists else "missing",
            }

    # refresh_env_if_stale zapisuje formation i wind — mapuj "env" OK na oba
    env_result = (run_results or {}).get("env")
    if env_result is not None and env_result.get("ok"):
        for name in ("wind", "formation"):
            path = SOURCE_FILES[name]
            if os.path.isfile(path):
                sources[name] = {
                    "ok": True,
                    "updatedAt": file_valid_at(path) or now,
                    "error": None,
                }

    meta = {
        "updatedAt": now,
        "operaTime": opera_product_time(prev),
        "chmiTime": chmi_product_time(prev),
        "opera": os.path.isfile(SOURCE_FILES["opera"]),
        "chmi": os.path.isfile(SOURCE_FILES["chmi"]),
        "wind": os.path.isfile(SOURCE_FILES["wind"]),
        "formation": os.path.isfile(SOURCE_FILES["formation"]),
        "sources": sources,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote {OUT} (operaTime={meta.get('operaTime')}, chmiTime={meta.get('chmiTime')})")
    return meta


def main() -> int:
    write_meta(None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
