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

/** Poslední blob:URL — revoke při dalším preloadu (bez memory leaku). */
let lastRasterBlobUrl: string | null = null;

/**
 * Stáhne a dekóduje latest.png během bootu / refresh —
 * mapa pak dostane blob:URL a radar je hned vidět.
 */
export async function preloadRadarRaster(
  meta: RadarRasterMeta | null,
): Promise<RadarRasterMeta | null> {
  if (!meta?.url) return null;

  try {
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return meta;

    const blob = await res.blob();
    if (blob.size < 32) return meta;

    if (lastRasterBlobUrl) {
      URL.revokeObjectURL(lastRasterBlobUrl);
      lastRasterBlobUrl = null;
    }

    const objectUrl = URL.createObjectURL(blob);
    lastRasterBlobUrl = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("radar png decode failed"));
      img.src = objectUrl;
    });

    return { ...meta, url: objectUrl };
  } catch {
    return meta;
  }
}
