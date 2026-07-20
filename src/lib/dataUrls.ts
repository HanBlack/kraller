/** Interval obnovy dat v prohlížeči. */
export const DATA_REFRESH_MS = 30 * 1000;

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");

/**
 * Produkce: VITE_DATA_ROOT (Cloudflare R2) nebo raw.githubusercontent.com fallback.
 * Dev: lokální public/data.
 */
const PROD_FALLBACK =
  "https://raw.githubusercontent.com/HanBlack/kraller/main/public/";

const envRoot = import.meta.env.VITE_DATA_ROOT as string | undefined;

const DATA_ROOT = import.meta.env.PROD
  ? (envRoot?.trim() ? envRoot.replace(/\/?$/, "/") : PROD_FALLBACK)
  : BASE;

/** Statické JSON/GeoJSON — cache-bust při každém fetchi. */
export function dataUrl(path: string, cacheBust?: number | string): string {
  const clean = path.replace(/^\//, "");
  const url = `${DATA_ROOT}${clean}`;
  if (cacheBust == null) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${cacheBust}`;
}
