import { destinationPoint } from "./geo";
import type { CellIntensification } from "../storm/intensification";
import {
  peakAtForecastMinutes,
  type RadarProgressFeature,
} from "../storm/radarCells";
import { evolveDbzAt } from "./stormEvolution";
import type { RadarRasterMeta } from "./radarRaster";
import { lonLatToMercatorPixel } from "./radarMercator";

export type GeoBounds = {
  west: number;
  east: number;
  north: number;
  south: number;
};

export type CellInfluence = {
  px: number;
  py: number;
  maxDbz: number;
  dbzDelta: number;
  radius: number;
};

export function geoBoundsFromCoords(
  coords: RadarRasterMeta["coordinates"],
): GeoBounds {
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return {
    west: Math.min(...lons),
    east: Math.max(...lons),
    north: Math.max(...lats),
    south: Math.min(...lats),
  };
}

export function lonLatToPixel(
  lon: number,
  lat: number,
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
): [number, number] {
  return lonLatToMercatorPixel(lon, lat, coords, width, height);
}

export function lonLatDeltaToPixel(
  dLon: number,
  dLat: number,
  originLon: number,
  originLat: number,
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
): { dx: number; dy: number } {
  const [px, py] = lonLatToMercatorPixel(
    originLon,
    originLat,
    coords,
    width,
    height,
  );
  const [px2, py2] = lonLatToMercatorPixel(
    originLon + dLon,
    originLat + dLat,
    coords,
    width,
    height,
  );
  return { dx: px2 - px, dy: py2 - py };
}

export function pixelRadiusForDbz(dbz: number, width: number): number {
  return Math.max(5, Math.min(width * 0.045, 6 + (dbz - 30) * 0.75));
}

export function buildCellInfluences(
  features: RadarProgressFeature[],
  intensByCell: Map<string, CellIntensification> | undefined,
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
  minutes: number,
): CellInfluence[] {
  const out: CellInfluence[] = [];
  for (const f of features) {
    if (f.speedKmh < 5) continue;
    const [peakLon, peakLat] = peakAtForecastMinutes(
      f,
      minutes,
      undefined,
      "track",
    );
    const [px, py] = lonLatToPixel(
      peakLon,
      peakLat,
      coords,
      width,
      height,
    );
    const predDbz = evolveDbzAt(f, intensByCell?.get(f.id), minutes);
    out.push({
      px,
      py,
      maxDbz: f.maxDbz,
      dbzDelta: predDbz - f.maxDbz,
      radius: pixelRadiusForDbz(f.maxDbz, width),
    });
  }
  return out;
}

/** Nejsilnější pohybující se buňka — stejný směr jako šipka/jádro. */
export function dominantMovingFeature(
  features: RadarProgressFeature[],
): RadarProgressFeature | undefined {
  let best: RadarProgressFeature | undefined;
  for (const f of features) {
    if (f.speedKmh < 5) continue;
    if (!best || f.maxDbz > best.maxDbz) best = f;
  }
  return best;
}

/** Posun celého pole v px — podle nejsilnější buňky (ne průměr více směrů). */
export function globalPixelShift(
  features: RadarProgressFeature[],
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
  minutes: number,
): { dx: number; dy: number } {
  const anchor = dominantMovingFeature(features);
  if (!anchor) return { dx: 0, dy: 0 };
  return cellPixelShift(
    anchor.peak[0],
    anchor.peak[1],
    anchor.headingDeg,
    anchor.speedKmh,
    minutes,
    coords,
    width,
    height,
  );
}

export function pixelAlphaGain(
  x: number,
  y: number,
  influences: CellInfluence[],
): number {
  let delta = 0;
  let wSum = 0;
  for (const inf of influences) {
    const d = Math.hypot(x - inf.px, y - inf.py);
    if (d > inf.radius * 1.75) continue;
    const w =
      Math.max(1, inf.maxDbz - 22) *
      Math.exp(-(d * d) / (inf.radius * inf.radius));
    delta += inf.dbzDelta * w;
    wSum += w;
  }
  if (wSum <= 0) return 1;
  const meanDelta = delta / wSum;
  return Math.max(0.42, Math.min(1.28, 1 + meanDelta * 0.045));
}

export function bilinearSample(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) {
    return [0, 0, 0, 0];
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = (px: number, py: number) => (py * width + px) * 4;
  const c00 = i(x0, y0);
  const c10 = i(x0 + 1, y0);
  const c01 = i(x0, y0 + 1);
  const c11 = i(x0 + 1, y0 + 1);
  const out: number[] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const v00 = data[c00 + k];
    const v10 = data[c10 + k];
    const v01 = data[c01 + k];
    const v11 = data[c11 + k];
    out[k] =
      v00 * (1 - fx) * (1 - fy) +
      v10 * fx * (1 - fy) +
      v01 * (1 - fx) * fy +
      v11 * fx * fy;
  }
  return out as [number, number, number, number];
}

/**
 * Semi-Lagrangian advekce: globální posun z historie + lokální síla u jader.
 */
export function advectRadarPixels(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  shift: { dx: number; dy: number },
  influences: CellInfluence[],
  globalAlpha: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - shift.dx;
      const sy = y - shift.dy;
      let [r, g, b, a] = bilinearSample(src, width, height, sx, sy);
      if (a < 2) continue;

      const gain = pixelAlphaGain(x, y, influences) * globalAlpha;
      a = Math.min(255, a * gain);
      if (gain > 1.04) {
        r = Math.min(255, r * (1 + (gain - 1) * 0.35));
        g = Math.min(255, g * (1 + (gain - 1) * 0.35));
        b = Math.min(255, b * (1 + (gain - 1) * 0.25));
      } else if (gain < 0.92) {
        r *= gain;
        g *= gain;
        b *= gain;
      }

      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

/** Zaokrouhlí minuty pro stabilní cache (méně přepočtů canvasu). */
export function quantizeEvolveMinutes(minutes: number): number {
  return Math.round(minutes * 2) / 2;
}

/** Predikce posunu jedné buňky v px (pro testy). */
export function cellPixelShift(
  peakLon: number,
  peakLat: number,
  headingDeg: number,
  speedKmh: number,
  minutes: number,
  coords: RadarRasterMeta["coordinates"],
  width: number,
  height: number,
): { dx: number; dy: number } {
  const distKm = (speedKmh * minutes) / 60;
  const [endLon, endLat] = destinationPoint(
    peakLat,
    peakLon,
    headingDeg,
    distKm,
  );
  return lonLatDeltaToPixel(
    endLon - peakLon,
    endLat - peakLat,
    peakLon,
    peakLat,
    coords,
    width,
    height,
  );
}
