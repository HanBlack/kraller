import { useEffect, useMemo, useState } from "react";
import type { CellIntensification } from "../storm/intensification";
import type { RadarProgressFeature } from "../storm/radarCells";
import {
  peekEvolvedRadarRaster,
  renderEvolvedRadarRaster,
} from "./evolveRadarRaster";
import type { RadarRasterMeta } from "./radarRaster";

export type EvolvedRasterState = {
  meta: RadarRasterMeta;
  baseUrl: string;
  minutes: number;
} | null;

/**
 * Algoritmická predikce PNG — pixel advekce + vývoj/zánik dBZ u jader.
 * Nepoužívá posun rohů (shiftRadarRaster).
 */
export function useAlgorithmicRadarEvolve(
  baseRaster: RadarRasterMeta | null,
  enabled: boolean,
  minutes: number,
  features: RadarProgressFeature[],
  intensByCell: Map<string, CellIntensification>,
): EvolvedRasterState {
  const motionKey = useMemo(() => {
    const moving = features.filter((f) => f.speedKmh >= 5);
    return moving
      .map(
        (f) =>
          `${f.id}:${f.maxDbz.toFixed(0)}:${f.speedKmh.toFixed(0)}:${f.headingDeg.toFixed(0)}`,
      )
      .join("|");
  }, [features]);

  const [evolved, setEvolved] = useState<EvolvedRasterState>(null);

  useEffect(() => {
    if (!baseRaster?.url || !enabled || minutes <= 0.05) {
      setEvolved(null);
      return;
    }

    const baseUrl = baseRaster.url;
    const qMin = Math.round(minutes * 2) / 2;

    const cached = peekEvolvedRadarRaster(
      baseRaster,
      features,
      intensByCell,
      qMin,
    );
    if (cached && cached.url !== baseUrl) {
      setEvolved({ meta: cached, baseUrl, minutes: qMin });
      return;
    }

    let cancelled = false;
    void renderEvolvedRadarRaster(
      baseRaster,
      features,
      intensByCell,
      qMin,
    ).then((next) => {
      if (cancelled || !next || next.url === baseUrl) return;
      setEvolved({ meta: next, baseUrl, minutes: qMin });
    });

    return () => {
      cancelled = true;
    };
  }, [baseRaster, enabled, minutes, motionKey, features, intensByCell]);

  return evolved;
}

export function pickActiveRadarRaster(
  displayRaster: RadarRasterMeta | null,
  needsEvolve: boolean,
  evolved: EvolvedRasterState,
  evolveMinutes: number,
): RadarRasterMeta | null {
  if (!displayRaster) return null;
  if (!needsEvolve) return displayRaster;
  if (
    evolved &&
    evolved.baseUrl === displayRaster.url &&
    evolved.minutes === evolveMinutes
  ) {
    return evolved.meta;
  }
  if (evolved && evolved.baseUrl === displayRaster.url) {
    return evolved.meta;
  }
  return displayRaster;
}
