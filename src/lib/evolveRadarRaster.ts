import type { CellIntensification } from "../storm/intensification";
import type { RadarProgressFeature } from "../storm/radarCells";
import { stormEvolutionAt } from "./stormEvolution";
import type { RadarRasterMeta } from "./radarRaster";
import {
  advectRadarPixels,
  buildCellInfluences,
  geoBoundsFromCoords,
  globalPixelShift,
  quantizeEvolveMinutes,
} from "./radarAdvection";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("radar png load failed"));
    img.src = url;
  });
}

let cachedEvolveKey: string | null = null;
let cachedEvolveUrl: string | null = null;
let displayedEvolveUrl: string | null = null;

/** Uvolni starý evolved blob až po zobrazení nového. */
export function commitEvolvedRasterSwap(activeUrl: string | null | undefined) {
  if (!activeUrl?.startsWith("blob:")) return;
  if (displayedEvolveUrl && displayedEvolveUrl !== activeUrl) {
    URL.revokeObjectURL(displayedEvolveUrl);
  }
  displayedEvolveUrl = activeUrl;
}

/**
 * Plynulá advekce PNG — globální posun z pozorované historie,
 * lokální síla u jader (ne kruhová razítka).
 */
export async function renderEvolvedRadarRaster(
  meta: RadarRasterMeta,
  features: RadarProgressFeature[],
  intensByCell: Map<string, CellIntensification> | undefined,
  minutes: number,
): Promise<RadarRasterMeta | null> {
  if (!meta.url || minutes <= 0.05) return meta;

  const qMin = quantizeEvolveMinutes(minutes);
  const evolution = stormEvolutionAt(features, intensByCell, qMin);
    const moving = features.filter((f) => f.speedKmh >= 5);
  const cacheKey = [
    meta.url,
    qMin.toFixed(1),
    evolution.meanDeltaDbz.toFixed(2),
    evolution.rasterOpacity.toFixed(2),
    moving.map((f) => `${f.id}:${f.maxDbz.toFixed(0)}:${f.speedKmh.toFixed(0)}`).join("|"),
  ].join("::");

  if (cacheKey === cachedEvolveKey && cachedEvolveUrl) {
    return { ...meta, url: cachedEvolveUrl };
  }

  try {
    const img = await loadImage(meta.url);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width < 8 || height < 8) return meta;

    const bounds = geoBoundsFromCoords(meta.coordinates);
    const influences = buildCellInfluences(
      features,
      intensByCell,
      bounds,
      width,
      height,
      qMin,
    );
    const shift = globalPixelShift(
      features,
      bounds,
      width,
      height,
      qMin,
    );

    const hasMotion =
      Math.abs(shift.dx) + Math.abs(shift.dy) > 0.05 || influences.length > 0;
    const hasEvolution = Math.abs(evolution.meanDeltaDbz) > 0.3;

    if (!hasMotion && !hasEvolution) return meta;

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = width;
    srcCanvas.height = height;
    const sctx = srcCanvas.getContext("2d");
    if (!sctx) return meta;
    sctx.drawImage(img, 0, 0, width, height);
    const srcData = sctx.getImageData(0, 0, width, height);

    const globalAlpha = evolution.rasterOpacity / 0.9;
    const outData = advectRadarPixels(
      srcData.data,
      width,
      height,
      shift,
      influences,
      globalAlpha,
    );

    const outCanvas = document.createElement("canvas");
    outCanvas.width = width;
    outCanvas.height = height;
    const octx = outCanvas.getContext("2d");
    if (!octx) return meta;
    const imageData = octx.createImageData(width, height);
    imageData.data.set(outData);
    octx.putImageData(imageData, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => {
      outCanvas.toBlob((b) => resolve(b), "image/png");
    });
    if (!blob || blob.size < 32) return meta;

    cachedEvolveKey = cacheKey;
    const newUrl = URL.createObjectURL(blob);
    cachedEvolveUrl = newUrl;
    return { ...meta, url: newUrl };
  } catch {
    return meta;
  }
}
