"""Radar QC — potlačení šumu/clutteru (drobná vysoce-intenzní zrna).

OPERA compositý (a částečně i národní) obsahují bodový šum / clutter: izolované
1–9px skvrnky s peakem klidně 60+ dBZ, kde ve skutečnosti nic není.

DŮLEŽITÉ: filtr NIKDY nedělá NaN uprostřed echa (to by po vyhlazení dělalo
„deravé mraky" — průhledné čtverečky). Místo mazání **srazí** podezřelé pixely
na lokální medián okolí:
  - osamocená skvrnka v čistém vzduchu → medián je čisto → zmizí,
  - špička/parazit uvnitř mraku → medián je okolní echo → zůstane plynulé.

Kroky:
  1) malé komponenty (nízká i vysoká hladina) srazit na lokální medián,
  2) osamocené špičky (vysoko nad mediánem okolí) srazit na medián.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import label, median_filter

# Vysoký pixel musí být aspoň o tolik dBZ nad mediánem okolí, aby byl špička.
SPIKE_DELTA_DBZ = 12.0
# Mediánové okno (px).
SPIKE_SIZE = 7
# Pod touto hladinou špičky neřešíme (slabý déšť necháme).
SPIKE_MIN_DBZ = 35.0
# Malé komponenty na nízké hladině (osamocený bodový šum).
BASE_DBZ = 18.0
BASE_MIN_AREA = 12
# (hladina dBZ, minimální plocha px) pro vysoká jádra.
HIGH_MIN_AREA = ((40.0, 6), (45.0, 5), (50.0, 4), (55.0, 3), (60.0, 2))


def despeckle_dbz(
    dbz: np.ndarray,
    *,
    spike_size: int = SPIKE_SIZE,
    spike_delta: float = SPIKE_DELTA_DBZ,
    spike_min_dbz: float = SPIKE_MIN_DBZ,
    base_dbz: float = BASE_DBZ,
    base_min_area: int = BASE_MIN_AREA,
    high_min_area=HIGH_MIN_AREA,
) -> np.ndarray:
    """Vrátí kopii dBZ pole bez drobných vysoce-intenzních špiček (bez děr)."""
    out = np.array(dbz, dtype=np.float64, copy=True)
    finite = np.isfinite(out)
    med = median_filter(
        np.nan_to_num(out, nan=-40.0), size=spike_size, mode="nearest"
    )

    def _cap(mask: np.ndarray) -> None:
        out[mask] = np.minimum(out[mask], med[mask])

    # 1a) malé komponenty na nízké hladině (osamocený bodový šum)
    if base_min_area > 1:
        mask = finite & (out >= base_dbz)
        if mask.any():
            lab, n = label(mask)
            if n:
                sizes = np.bincount(lab.ravel())
                small = np.where((sizes > 0) & (sizes < base_min_area))[0]
                small = small[small != 0]
                if small.size:
                    _cap(np.isin(lab, small))

    # 1b) malá kompaktní vysoká jádra
    for lvl, min_area in high_min_area:
        mask = finite & (out >= lvl)
        if not mask.any():
            continue
        lab, n = label(mask)
        if n == 0:
            continue
        sizes = np.bincount(lab.ravel())
        small = np.where((sizes > 0) & (sizes < min_area))[0]
        small = small[small != 0]
        if small.size:
            _cap(np.isin(lab, small))

    # 2) osamocené špičky (vysoký pixel vysoko nad mediánem okolí)
    strong = finite & (out >= spike_min_dbz)
    if strong.any():
        _cap(strong & ((out - med) >= spike_delta))

    return out
