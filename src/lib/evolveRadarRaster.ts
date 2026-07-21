import { destinationPoint } from "./geo";
import type { CellIntensification } from "../storm/intensification";
import {
  footprintFactorFromDbz,
  type RadarProgressFeature,
} from "../storm/radarCells";
import { evolveDbzAt, stormEvolutionAt } from "./stormEvolution";
import type { RadarRasterMeta } from "./radarRaster";

type GeoBounds = {
  west: number;
  east: number;
  north: number;
  south: number;
};

function geoBounds(coords: RadarRasterMeta["coordinates"]): GeoBounds {
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return {
    west: Math.min(...lons),
    east: Math.max(...lons),
    north: Math.max(...lats),
    south: Math.min(...lats),
  };
}

function lonLatToPixel(
  lon: number,
  lat: number,
  bounds: GeoBounds,
  width: number,
  height: number,
): [number, number] {
  const x =
    ((lon - bounds.west) / Math.max(1e-9, bounds.east - bounds.west)) * width;
  const y =
    ((bounds.north - lat) / Math.max(1e-9, bounds.north - bounds.south)) *
    height;
  return [x, y];
}

function pixelRadiusForDbz(dbz: number, width: number): number {
  return Math.max(10, Math.min(width * 0.12, 14 + (dbz - 30) * 1.8));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("radar png load failed"));
    img.src = url;
  });
}

let lastEvolveKey: string | null = null;
let lastEvolveUrl: string | null = null;

function revokeEvolveUrl() {
  if (lastEvolveUrl) {
    URL.revokeObjectURL(lastEvolveUrl);
    lastEvolveUrl = null;
  }
}

/**
 * Algoritmický odhad PNG — posun + síla/stopa z pozorované historie a trendu dBZ.
 * Bez pozorovaného pohybu buňka zůstane na místě (jen globální slábnutí).
 */
export async function renderEvolvedRadarRaster(
  meta: RadarRasterMeta,
  features: RadarProgressFeature[],
  intensByCell: Map<string, CellIntensification> | undefined,
  minutes: number,
): Promise<RadarRasterMeta | null> {
  if (!meta.url || minutes <= 0.05) return meta;

  const evolution = stormEvolutionAt(features, intensByCell, minutes);
  const moving = features.filter((f) => f.motionSource === "radar-track");
  const cacheKey = [
    meta.url,
    minutes.toFixed(1),
    evolution.meanDeltaDbz.toFixed(2),
    moving.map((f) => `${f.id}:${f.maxDbz.toFixed(0)}`).join("|"),
  ].join("::");

  if (cacheKey === lastEvolveKey && lastEvolveUrl) {
    return { ...meta, url: lastEvolveUrl };
  }

  try {
    const img = await loadImage(meta.url);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width < 8 || height < 8) return meta;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return meta;

    const bounds = geoBounds(meta.coordinates);

    // Základ — mírně slábnoucí pozadí pro echo bez pozorovaného pohybu
    ctx.globalAlpha = Math.max(0.45, evolution.rasterOpacity);
    ctx.drawImage(img, 0, 0, width, height);

    for (const f of moving) {
      const [peakLon, peakLat] = f.peak;
      const predDbz = evolveDbzAt(f, intensByCell?.get(f.id), minutes);
      const scale = footprintFactorFromDbz(f.maxDbz, predDbz);
      const distKm = (f.speedKmh * minutes) / 60;
      const [endLon, endLat] =
        distKm > 0.01
          ? destinationPoint(peakLat, peakLon, f.headingDeg, distKm)
          : [peakLon, peakLat];

      const [px0, py0] = lonLatToPixel(peakLon, peakLat, bounds, width, height);
      const [px1, py1] = lonLatToPixel(endLon, endLat, bounds, width, height);
      const r0 = pixelRadiusForDbz(f.maxDbz, width);
      const r1 = r0 * scale;

      // Smazat staré jádro (posun = ne kopie)
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.arc(px0, py0, r0 * 1.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Vykreslit evoluci na nové pozici
      const sx = Math.max(0, Math.floor(px0 - r0));
      const sy = Math.max(0, Math.floor(py0 - r0));
      const sw = Math.min(width - sx, Math.ceil(r0 * 2));
      const sh = Math.min(height - sy, Math.ceil(r0 * 2));
      if (sw <= 0 || sh <= 0) continue;

      const stampAlpha =
        predDbz < 24
          ? 0.35
          : predDbz < f.maxDbz - 1.5
            ? 0.55
            : predDbz > f.maxDbz + 1.5
              ? 1
              : 0.88;

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = stampAlpha;
      ctx.drawImage(
        img,
        sx,
        sy,
        sw,
        sh,
        px1 - r1,
        py1 - r1,
        r1 * 2,
        r1 * 2,
      );
      ctx.restore();
    }

    // Globální posílení / útlum podle trendu
    if (Math.abs(evolution.meanDeltaDbz) > 0.5) {
      ctx.save();
      ctx.globalCompositeOperation =
        evolution.meanDeltaDbz > 0 ? "screen" : "multiply";
      ctx.globalAlpha = Math.min(0.22, Math.abs(evolution.meanDeltaDbz) * 0.04);
      ctx.fillStyle =
        evolution.meanDeltaDbz > 0
          ? "rgba(120, 200, 255, 0.35)"
          : "rgba(40, 40, 60, 0.45)";
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });
    if (!blob || blob.size < 32) return meta;

    revokeEvolveUrl();
    lastEvolveKey = cacheKey;
    lastEvolveUrl = URL.createObjectURL(blob);
    return { ...meta, url: lastEvolveUrl };
  } catch {
    return meta;
  }
}
