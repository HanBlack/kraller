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

async function fetchDecodePng(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
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
    return objectUrl;
  } catch {
    return null;
  }
}

/**
 * Stáhne a dekóduje latest.png během bootu / refresh —
 * mapa pak dostane blob:URL a radar je hned vidět.
 */
export async function preloadRadarRaster(
  meta: RadarRasterMeta | null,
): Promise<RadarRasterMeta | null> {
  if (!meta?.url) return null;

  const objectUrl = await fetchDecodePng(meta.url);
  if (!objectUrl) return meta;

  // Revoke až po commitLiveRasterBlobSwap — jinak problikne prázdný frame.
  return { ...meta, url: objectUrl };
}

/**
 * History frame PNG — bez mazání live blobu (více framů najednou).
 */
export async function preloadRadarRasterKeep(
  meta: RadarRasterMeta | null,
): Promise<RadarRasterMeta | null> {
  if (!meta?.url) return null;
  const objectUrl = await fetchDecodePng(meta.url);
  if (!objectUrl) return meta;
  return { ...meta, url: objectUrl };
}
