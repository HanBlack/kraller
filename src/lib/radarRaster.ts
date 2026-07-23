import { dataFileCandidateUrls } from "./dataUrls";

/** Meta pro MapLibre image source — spojitý OPERA raster. */
export type RadarRasterMeta = {
  url: string;
  /** TL, TR, BR, BL [lon, lat] */
  coordinates: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  time?: string;
  minDbz?: number;
};

/** Posune rohy PNG o Δlon/Δlat (forecast advekce — stejný obrázek, jiná pozice). */
export function shiftRadarRaster(
  meta: RadarRasterMeta,
  dLon: number,
  dLat: number,
): RadarRasterMeta {
  if (dLon === 0 && dLat === 0) return meta;
  return {
    ...meta,
    coordinates: meta.coordinates.map(([lon, lat]) => [
      lon + dLon,
      lat + dLat,
    ]) as RadarRasterMeta["coordinates"],
  };
}

/** Poslední blob:URL zobrazená na mapě — revoke až po swapu. */
let lastLiveRasterBlobUrl: string | null = null;

/** Uvolni předchozí live blob až když mapa ukazuje nový. */
export function commitLiveRasterBlobSwap(activeUrl: string | null | undefined) {
  if (!activeUrl?.startsWith("blob:")) return;
  if (lastLiveRasterBlobUrl && lastLiveRasterBlobUrl !== activeUrl) {
    URL.revokeObjectURL(lastLiveRasterBlobUrl);
  }
  lastLiveRasterBlobUrl = activeUrl;
}

/** Základní MapLibre raster-opacity (Teď). */
export const RADAR_RASTER_BASE_OPACITY = 1;

/**
 * Zvedne alfa (+ mírně sytost) u existujícího PNG —
 * staré snímky jsou moc průhledné přes basemap.
 */
export async function boostRadarPngVisibility(
  objectUrl: string,
  alphaGain = 1.4,
): Promise<string> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.decoding = "async";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("boost decode failed"));
      el.src = objectUrl;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < 2 || h < 2) return objectUrl;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return objectUrl;
    ctx.drawImage(img, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      // Silnější echo + jemně sytější RGB
      d[i + 3] = Math.min(255, Math.round(a * alphaGain));
      d[i] = Math.min(255, Math.round(d[i] * 1.06));
      d[i + 1] = Math.min(255, Math.round(d[i + 1] * 1.04));
      d[i + 2] = Math.min(255, Math.round(d[i + 2] * 1.05));
    }
    ctx.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });
    if (!blob || blob.size < 32) return objectUrl;
    URL.revokeObjectURL(objectUrl);
    return URL.createObjectURL(blob);
  } catch {
    return objectUrl;
  }
}

async function fetchDecodePng(
  url: string,
  cache: RequestCache = "no-store",
): Promise<string | null> {
  try {
    const res = await fetch(url, { cache });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 32) return null;
    const objectUrl = URL.createObjectURL(blob);
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("radar png decode failed"));
      img.src = objectUrl;
    });
    return boostRadarPngVisibility(objectUrl);
  } catch {
    return null;
  }
}

/**
 * Stáhne a dekóduje latest.png během bootu / refresh —
 * mapa pak dostane blob:URL a radar je hned vidět.
 * Relativní path → R2 / GitHub fallback přes dataRoots.
 */
export async function preloadRadarRaster(
  meta: RadarRasterMeta | null,
  cacheBust?: number | string,
): Promise<RadarRasterMeta | null> {
  if (!meta?.url) return null;
  if (meta.url.startsWith("blob:") || meta.url.startsWith("data:")) {
    return meta;
  }

  for (const url of dataFileCandidateUrls(meta.url, cacheBust)) {
    const objectUrl = await fetchDecodePng(url);
    if (objectUrl) {
      // Revoke až po commitLiveRasterBlobSwap — jinak problikne prázdný frame.
      return { ...meta, url: objectUrl };
    }
  }
  return meta;
}

/**
 * History frame PNG — bez mazání live blobu (více framů najednou).
 */
export async function preloadRadarRasterKeep(
  meta: RadarRasterMeta | null,
  cache: RequestCache = "force-cache",
  cacheBust?: number | string,
): Promise<RadarRasterMeta | null> {
  if (!meta?.url) return null;
  if (meta.url.startsWith("blob:") || meta.url.startsWith("data:")) {
    return meta;
  }
  for (const url of dataFileCandidateUrls(meta.url, cacheBust)) {
    const objectUrl = await fetchDecodePng(url, cache);
    if (objectUrl) return { ...meta, url: objectUrl };
  }
  return meta;
}
