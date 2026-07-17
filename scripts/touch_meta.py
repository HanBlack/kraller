"""Aktualizuje updatedAt v meta.json — udrží git-push smyčku i když radarový snímek nezměnil soubory."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from write_meta import write_meta  # noqa: E402


def main() -> int:
    write_meta({"opera": {"ok": True}, "wind": {"ok": True}, "formation": {"ok": True}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
