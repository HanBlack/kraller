import type maplibregl from "maplibre-gl";
import type { RadarRasterMeta } from "./radarRaster";

type RasterLookup = (offsetMinutes: number) => RadarRasterMeta | null;
type RasterSync = (
  map: maplibregl.Map,
  meta: RadarRasterMeta | null,
) => Promise<boolean>;

let map: maplibregl.Map | null = null;
let lookup: RasterLookup | null = null;
let syncFn: RasterSync | null = null;
let lastAppliedUrl: string | null = null;
let lastAppliedOffset: number | null = null;
let pendingOffset: number | null = null;
let rafId = 0;
let applySeq = 0;

export function registerRadarMapBridge(
  nextMap: maplibregl.Map | null,
  nextLookup: RasterLookup | null,
  nextSync: RasterSync | null,
): void {
  map = nextMap;
  lookup = nextLookup;
  syncFn = nextSync;
  if (!nextMap) {
    lastAppliedUrl = null;
    lastAppliedOffset = null;
  }
}

/** Okamžitě (rAF) aplikuje PNG pro offset — mimo React render. */
export function applyTimeOffsetRaster(offsetMinutes: number): void {
  pendingOffset = offsetMinutes;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const offset = pendingOffset;
    pendingOffset = null;
    if (offset == null || !map || !lookup || !syncFn) return;
    const meta = lookup(offset);
    if (!meta?.url) return;

    // Stejný offset + URL = nic; jinak vždy sync (návrat Teď po historii).
    if (offset === lastAppliedOffset && meta.url === lastAppliedUrl) {
      try {
        const src = map.getSource("opera-radar-raster") as
          | { setCoordinates?: (c: unknown) => void }
          | undefined;
        src?.setCoordinates?.(meta.coordinates);
        map.triggerRepaint();
      } catch {
        /* ignore */
      }
      return;
    }

    const seq = ++applySeq;
    const targetUrl = meta.url;
    const targetOffset = offset;
    void syncFn(map, meta).then((ok) => {
      if (seq !== applySeq) return;
      if (ok) {
        lastAppliedUrl = targetUrl;
        lastAppliedOffset = targetOffset;
      }
    });
  });
}

export function getLastAppliedRasterUrl(): string | null {
  return lastAppliedUrl;
}

export function resetRasterBridgeApplied(): void {
  lastAppliedUrl = null;
  lastAppliedOffset = null;
}

export function bridgeDebug(offsetMinutes: number): {
  activeUrl: string | null;
  lastAppliedUrl: string | null;
  lastAppliedOffset: number | null;
} {
  const meta = lookup?.(offsetMinutes) ?? null;
  return {
    activeUrl: meta?.url ?? null,
    lastAppliedUrl,
    lastAppliedOffset,
  };
}
