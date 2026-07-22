import {
  predictedDbzAt,
  type CellIntensification,
  type IntensTrackCell,
} from "../storm/intensification";
import { stormConfig } from "../storm/config";
import type { RadarProgressFeature } from "../storm/radarCells";
import type { RadarRasterMeta } from "./radarRaster";

export type StormEvolution = {
  /** Vážený průměr (pred − current) dBZ. */
  meanDeltaDbz: number;
  /** MapLibre raster-opacity (základ ~1). */
  rasterOpacity: number;
  /** Škála stopy srážek kolem středu (0.94–1.08). */
  footprintScale: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Predikované dBZ v čase T — predictedDbzAt + pozorovaný growthDbz trend.
 * Konstanty: stormConfig.evolution (kalibrovatelné z learning).
 */
export function evolveDbzAt(
  feature: IntensTrackCell,
  intens: CellIntensification | undefined,
  minutes: number,
): number {
  if (minutes <= 0.05) return feature.maxDbz;
  const evo = stormConfig.evolution;
  let pred = predictedDbzAt(feature, intens, minutes);
  if (!intens?.willIntensify && feature.growthDbz != null) {
    const trend =
      feature.maxDbz +
      clamp((feature.growthDbz * minutes) / 15, -10, 10) * evo.trendGain;
    pred =
      evo.blendPred * pred + evo.blendTrend * clamp(trend, 26, 65);
  }
  return pred;
}

/**
 * Hrubý vývoj síly/plochy z predikce dBZ (ne nový déšť).
 * minutes=0 → neutrální.
 */
export function stormEvolutionAt(
  features: RadarProgressFeature[],
  intensByCell: Map<string, CellIntensification> | undefined,
  minutes: number,
): StormEvolution {
  if (minutes <= 0.05 || features.length === 0) {
    return { meanDeltaDbz: 0, rasterOpacity: 1, footprintScale: 1 };
  }

  const evo = stormConfig.evolution;
  let wSum = 0;
  let dSum = 0;
  for (const f of features) {
    const w = Math.max(1, f.maxDbz - 20);
    const pred = evolveDbzAt(f, intensByCell?.get(f.id), minutes);
    dSum += (pred - f.maxDbz) * w;
    wSum += w;
  }
  const meanDeltaDbz = wSum > 0 ? dSum / wSum : 0;

  const rasterOpacity = clamp(1 + meanDeltaDbz * evo.opacityPerDbz, 0.7, 1);
  const footprintScale = clamp(
    1 + meanDeltaDbz * evo.footprintPerDbz,
    evo.footprintMin,
    evo.footprintMax,
  );

  return { meanDeltaDbz, rasterOpacity, footprintScale };
}

/** Poloměr tečky jádra (px) — těsně na peak, ne „zóna“. */
export function coreRadiusForDbz(dbz: number): number {
  return clamp(2 + (dbz - 30) * 0.07, 2, 4.2);
}

/**
 * Zvětší/zmenší rohy PNG kolem středu (tvarový odhad vývoje).
 * Volat až po shiftRadarRaster.
 */
export function scaleRadarRaster(
  meta: RadarRasterMeta,
  scale: number,
): RadarRasterMeta {
  if (Math.abs(scale - 1) < 0.002) return meta;
  const coords = meta.coordinates;
  const cLon =
    (coords[0][0] + coords[1][0] + coords[2][0] + coords[3][0]) / 4;
  const cLat =
    (coords[0][1] + coords[1][1] + coords[2][1] + coords[3][1]) / 4;
  return {
    ...meta,
    coordinates: coords.map(([lon, lat]) => [
      cLon + (lon - cLon) * scale,
      cLat + (lat - cLat) * scale,
    ]) as RadarRasterMeta["coordinates"],
  };
}
