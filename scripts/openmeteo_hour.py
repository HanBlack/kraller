"""Sdílený výběr hodinového slotu Open-Meteo (ne index 0 = půlnoc)."""

from __future__ import annotations

from datetime import datetime, timezone


def parse_hourly_time(raw: str) -> datetime:
    s = raw.replace("Z", "+00:00")
    if "+" not in s[10:] and s.count("-") <= 2:
        s = s + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)


def current_hour_index(times: list[str], now: datetime | None = None) -> int:
    """Najdi hodinový slot nejbližší aktuálnímu UTC."""
    if not times:
        return 0
    now = now or datetime.now(timezone.utc)
    best_i = 0
    best_diff = float("inf")
    for i, t in enumerate(times):
        try:
            tt = parse_hourly_time(t)
        except ValueError:
            continue
        diff = abs((tt - now).total_seconds())
        if diff < best_diff:
            best_diff = diff
            best_i = i
    return best_i
