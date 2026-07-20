"""Append-only learning store — JSONL pro pozdější kalibraci (směr, síla, zrod, zánik, vznik)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LEARNING_DIR = ROOT / "public" / "data" / "learning"
STATE_PATH = LEARNING_DIR / "state.json"
SCHEMA_VERSION = 2


def month_tag(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y-%m")


def events_path(now: datetime | None = None) -> Path:
    return LEARNING_DIR / f"events-{month_tag(now)}.jsonl"


def samples_path(now: datetime | None = None) -> Path:
    return LEARNING_DIR / f"samples-{month_tag(now)}.jsonl"


def ensure_dir() -> None:
    LEARNING_DIR.mkdir(parents=True, exist_ok=True)


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    ensure_dir()
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            row.setdefault("v", SCHEMA_VERSION)
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    return len(rows)


def load_state() -> dict[str, Any]:
    if not STATE_PATH.is_file():
        return {
            "tracks": {},
            "formationPending": {},
            "intensityPending": {},
            "updatedAt": None,
        }
    try:
        with STATE_PATH.open(encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {
                "tracks": {},
                "formationPending": {},
                "intensityPending": {},
                "updatedAt": None,
            }
        data.setdefault("tracks", {})
        data.setdefault("formationPending", {})
        data.setdefault("intensityPending", {})
        return data
    except (OSError, json.JSONDecodeError):
        return {
            "tracks": {},
            "formationPending": {},
            "intensityPending": {},
            "updatedAt": None,
        }


def save_state(state: dict[str, Any]) -> None:
    ensure_dir()
    state["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with STATE_PATH.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def track_key(lat: float, lon: float, birth_ts: str | None = None) -> str:
    """Stabilní klíč tracku (zaokrouhlený birth peak)."""
    base = f"{lat:.2f}:{lon:.2f}"
    if birth_ts:
        return f"t:{birth_ts}:{base}"
    return f"t:{base}"


def count_lines(path: Path) -> int:
    if not path.is_file():
        return 0
    n = 0
    with path.open(encoding="utf-8") as f:
        for _ in f:
            n += 1
    return n
