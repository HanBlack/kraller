"""Kontrola stáří JSON dat v public/data."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone


def parse_iso(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def read_valid_at(path: str, key: str = "validAt") -> datetime | None:
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return parse_iso(data.get(key))
    except (OSError, json.JSONDecodeError, TypeError):
        return None


def age_minutes(valid_at: datetime | None, now: datetime | None = None) -> float | None:
    if valid_at is None:
        return None
    now = now or datetime.now(timezone.utc)
    return max(0.0, (now - valid_at).total_seconds() / 60.0)


def is_fresh_path(path: str, max_minutes: float, key: str = "validAt") -> bool:
    valid = read_valid_at(path, key)
    age = age_minutes(valid)
    return age is not None and age <= max_minutes
