"""Unit testy výběru CAPE / hodiny (bez sítě)."""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fetch_formation import cape_for_formation
from openmeteo_hour import current_hour_index


class CapeHourTests(unittest.TestCase):
    def test_not_midnight_index(self) -> None:
        times = [f"2026-07-17T{h:02d}:00" for h in range(24)]
        now = datetime(2026, 7, 17, 5, 20, tzinfo=timezone.utc)
        idx = current_hour_index(times, now)
        self.assertEqual(idx, 5)

    def test_peak_uses_next_hours_not_night(self) -> None:
        # noc 0, ráno 10, dopoledne 200, poledne 800
        series = [0.0, 0.0, 0.0, 0.0, 10.0, 50.0, 200.0, 500.0, 800.0] + [100.0] * 15
        now_c, peak = cape_for_formation(series, 5)
        self.assertEqual(now_c, 50.0)
        self.assertEqual(peak, 800.0)  # max v 5…11


if __name__ == "__main__":
    unittest.main()
