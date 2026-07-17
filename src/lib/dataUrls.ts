/** Interval obnovy dat v prohlížeči (1 min). */
export const DATA_REFRESH_MS = 60 * 1000;

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");

/**
 * Produkce: data z raw.githubusercontent.com (Live radar pushne za ~1 min, bez Pages buildu).
 * Dev: lokální public/data.
 */
const DATA_ROOT = import.meta.env.PROD
  ? "https://raw.githubusercontent.com/HanBlack/kraller/main/public/"
  : BASE;

/** Statické JSON/GeoJSON — cache-bust při každém fetchi. */
export function dataUrl(path: string, cacheBust?: number | string): string {
  const clean = path.replace(/^\//, "");
  const url = `${DATA_ROOT}${clean}`;
  if (cacheBust == null) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${cacheBust}`;
}
