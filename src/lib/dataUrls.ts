/** Interval obnovy dat v prohlížeči. */
export const DATA_REFRESH_MS = 30 * 1000;

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");

/**
 * Produkce: VITE_DATA_ROOT (Cloudflare R2), pak raw.githubusercontent.com fallback.
 * Dev: lokální public/data.
 */
const PROD_FALLBACK =
  "https://raw.githubusercontent.com/HanBlack/kraller/main/public/";

const envRoot = import.meta.env.VITE_DATA_ROOT as string | undefined;

function normalizeRoot(root: string): string {
  return root.replace(/\/?$/, "/");
}

/** Kořeny v pořadí priority — při CORS/network chybě zkusí další. */
export function dataRoots(): string[] {
  if (!import.meta.env.PROD) return [BASE];
  const roots: string[] = [];
  const primary = envRoot?.trim();
  if (primary) roots.push(normalizeRoot(primary));
  const fallback = normalizeRoot(PROD_FALLBACK);
  if (!roots.includes(fallback)) roots.push(fallback);
  return roots.length ? roots : [fallback];
}

const DATA_ROOT = dataRoots()[0] ?? BASE;

/** Statické JSON/GeoJSON — cache-bust při každém fetchi. */
export function dataUrl(
  path: string,
  cacheBust?: number | string,
  root: string = DATA_ROOT,
): string {
  const clean = path.replace(/^\//, "");
  const url = `${root}${clean}`;
  if (cacheBust == null) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${cacheBust}`;
}

/** Fetch s fallbackem — R2 může mít CORS problém, raw.github má Access-Control-Allow-Origin: * */
export async function fetchData(
  path: string,
  cacheBust?: number | string,
): Promise<Response | null> {
  for (const root of dataRoots()) {
    try {
      const res = await fetch(dataUrl(path, cacheBust, root), {
        cache: "no-store",
      });
      if (res.ok) return res;
    } catch {
      // CORS nebo síť — zkus další kořen
    }
  }
  return null;
}

export async function fetchDataJson<T>(
  path: string,
  cacheBust?: number | string,
): Promise<T | null> {
  const res = await fetchData(path, cacheBust);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
