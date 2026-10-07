"""Radar QC — potlačení šumu/clutteru (drobná vysoce-intenzní zrna).

OPERA compositý (a částečně i národní) obsahují bodový šum / clutter: izolované
1–9px skvrnky s peakem klidně 60+ dBZ, kde ve skutečnosti nic není. Projevuje se
to jako „malé obláčky s velkou intenzitou" na mapě.

Filtr (aplikuj na dBZ pole před rasterizací i před detekcí buněk/kontur):
  1) mediánový filtr — vysoký pixel, který je výrazně nad mediánem okolí, je špička
     (reálné jádro má vysoký i medián okolí, takže zůstane),
  2) plošný filtr na vysokých hladinách — zahodí i kompaktní pár-pixelová jádra.

Nízké hladiny (slabý déšť) nechává být, ať se neubírá skutečný slabý echo.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import label, median_filter

# Vysoký pixel musí být aspoň o tolik dBZ nad mediánem okolí, aby byl špička.
SPIKE_DELTA_DBZ = 12.0
# Mediánové okno (px). Větší = agresivnější proti malým kompaktním skvrnám.
SPIKE_SIZE = 7
# Pod touto hladinou špičky neřešíme (slabý déšť necháme).
SPIKE_MIN_DBZ = 35.0
# Minimální plocha komponenty na nízké hladině — zahodí osamocené skvrnky.
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
    """Vrátí kopii dBZ pole bez drobných vysoce-intenzních špiček (NaN místo šumu)."""
    out = np.array(dbz, dtype=np.float64, copy=True)

    # 0) osamocené drobné komponenty na nízké hladině (bodový šum)
    if base_min_area > 1:
        mask = np.isfinite(out) & (out >= base_dbz)
        if mask.any():
            lab, n = label(mask)
            if n:
                sizes = np.bincount(lab.ravel())
                small = np.where((sizes > 0) & (sizes < base_min_area))[0]
                small = small[small != 0]
                if small.size:
                    out[np.isin(lab, small)] = np.nan

    # 1) kompaktní vysoká jádra pod min. plochou
    for lvl, min_area in high_min_area:
        mask = np.isfinite(out) & (out >= lvl)
        if not mask.any():
            continue
        lab, n = label(mask)
        if n == 0:
            continue
        sizes = np.bincount(lab.ravel())
        small = np.where((sizes > 0) & (sizes < min_area))[0]
        small = small[small != 0]
        if small.size:
            out[np.isin(lab, small)] = np.nan

    # 2) osamocené špičky (vysoký pixel vysoko nad mediánem okolí)
    strong = np.isfinite(out) & (out >= spike_min_dbz)
    if strong.any():
        med = median_filter(
            np.nan_to_num(out, nan=-40.0), size=spike_size, mode="nearest"
        )
        out[strong & ((out - med) >= spike_delta)] = np.nan

    return out
