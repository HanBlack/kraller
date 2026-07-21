import {
  predictedDbzAt,
  type CellIntensification,
} from "../storm/intensification";
import type { RadarProgressFeature } from "../storm/radarCells";
import type { RadarRasterMeta } from "./radarRaster";

export type StormEvolution = {
  /** Vážený průměr (pred − current) dBZ. */
  meanDeltaDbz: number;
  /** MapLibre raster-opacity (základ ~0.9). */
  rasterOpacity: number;
  /** Škála stopy srážek kolem středu (0.94–1.08). */
  footprintScale: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Predikované dBZ v čase T — predictedDbzAt + pozorovaný growthDbz trend.
 */
export function evolveDbzAt(
  feature: Pick<RadarProgressFeature, "maxDbz" | "growthDbz" | "id">,
  intens: CellIntensification | undefined,
  minutes: number,
): number {
  if (minutes <= 0.05) return feature.maxDbz;
  let pred = predictedDbzAt(feature, intens, minutes);
  if (!intens?.willIntensify && feature.growthDbz != null) {
    const trend =
      feature.maxDbz +
      clamp((feature.growthDbz * minutes) / 15, -10, 10) * 0.55;
    pred = 0.55 * pred + 0.45 * clamp(trend, 26, 65);
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
    return { meanDeltaDbz: 0, rasterOpacity: 0.9, footprintScale: 1 };
  }

  let wSum = 0;
  let dSum = 0;
  for (const f of features) {
    const w = Math.max(1, f.maxDbz - 20);
    const pred = evolveDbzAt(f, intensByCell?.get(f.id), minutes);
    dSum += (pred - f.maxDbz) * w;
    wSum += w;
  }
  const meanDeltaDbz = wSum > 0 ? dSum / wSum : 0;

  // Slábnutí → nižší opacity; růst → drží / lehce silnější
  const rasterOpacity = clamp(0.9 + meanDeltaDbz * 0.025, 0.55, 0.95);
  // Stopa: pomalý růst/smrštění (ne dramatické)
  const footprintScale = clamp(1 + meanDeltaDbz * 0.01, 0.94, 1.08);

  return { meanDeltaDbz, rasterOpacity, footprintScale };
}

/** Poloměr tečky jádra podle predikovaného dBZ. */
export function coreRadiusForDbz(dbz: number): number {
  return clamp(3.2 + (dbz - 30) * 0.16, 3.2, 9);
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
