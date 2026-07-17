/** Interval obnovy dat na produkci (2 min — soubory na serveru se mění ~každých 5 min). */
export const DATA_REFRESH_MS = 2 * 60 * 1000;

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");

/** Statické JSON/GeoJSON v public/data — cache-bust při každém fetchi. */
export function dataUrl(path: string, cacheBust?: number | string): string {
  const clean = path.replace(/^\//, "");
  const url = `${BASE}${clean}`;
  if (cacheBust == null) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${cacheBust}`;
}
