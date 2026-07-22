import { preloadMapImages } from "./mapImagePreload";
import {
  FORECAST_MAX_OFFSET,
  HISTORY_MIN_OFFSET,
  TIME_STEP_MINUTES,
  cachedHistoryRaster,
  frameForOffset,
  loadRadarHistoryRaster,
  type RadarHistoryManifest,
} from "./radarHistory";
import type { RadarRasterMeta } from "./radarRaster";
import type { RadarViewRasterInput } from "./radarViewRaster";

/** Okamžitý lookup — klíč = offset slideru (−30…0). */
const stepRasterCache = new Map<number, RadarRasterMeta>();
let warmGeneration = 0;
let lastWarmBaseUrl: string | null = null;
const warmListeners = new Set<() => void>();

function notifyWarmListeners() {
  for (const fn of warmListeners) fn();
}

export function subscribeSliderRasterCache(listener: () => void): () => void {
  warmListeners.add(listener);
  return () => warmListeners.delete(listener);
}

export function clearSliderRasterCache(): void {
  warmGeneration += 1;
  stepRasterCache.clear();
  lastWarmBaseUrl = null;
}

function allOffsets(): number[] {
  const out: number[] = [];
  for (
    let offset = HISTORY_MIN_OFFSET;
    offset <= FORECAST_MAX_OFFSET;
    offset += TIME_STEP_MINUTES
  ) {
    out.push(offset);
  }
  return out;
}

function rasterForOffset(
  offset: number,
  input: RadarViewRasterInput,
): RadarRasterMeta | null {
  if (offset >= 0) return input.liveRaster;

  const manifest = input.radarHistory;
  if (!manifest) return null;
  const frame = frameForOffset(manifest, offset);
  if (!frame) return null;

  if (
    input.historyLoad?.framePath === frame.path &&
    input.historyLoad.raster
  ) {
    return input.historyLoad.raster;
  }
  return cachedHistoryRaster(frame) ?? null;
}

/** Sync seed — live + historie už v preload cache. */
export function seedSliderRasterFromArchives(
  input: RadarViewRasterInput,
): number {
  let n = 0;
  for (const offset of allOffsets()) {
    const raster = rasterForOffset(offset, input);
    if (!raster?.url) continue;
    // Záporný offset nikdy neplnit live URL.
    if (offset < 0 && input.liveRaster && raster.url === input.liveRaster.url) {
      continue;
    }
    stepRasterCache.set(offset, raster);
    n += 1;
  }
  if (n > 0) {
    preloadMapImages([...stepRasterCache.values()].map((m) => m.url));
    notifyWarmListeners();
  }
  return n;
}

export function getSliderRaster(
  timeOffsetMinutes: number,
  input: RadarViewRasterInput,
): RadarRasterMeta | null {
  const offset = Math.min(FORECAST_MAX_OFFSET, timeOffsetMinutes);
  const hit = stepRasterCache.get(offset);
  if (hit) {
    if (offset < 0 && input.liveRaster && hit.url === input.liveRaster.url) {
      // otrávený slot — ignoruj
    } else {
      return hit;
    }
  }
  return rasterForOffset(offset, input);
}

/** Načte všechny history PNG a naplní cache. */
export async function warmRadarSliderCache(
  input: RadarViewRasterInput,
  _priorityOffset?: number,
): Promise<void> {
  void _priorityOffset;
  const gen = ++warmGeneration;
  const baseUrl = input.liveRaster?.url ?? "";
  if (baseUrl && baseUrl !== lastWarmBaseUrl) {
    stepRasterCache.clear();
    lastWarmBaseUrl = baseUrl;
  }

  if (input.liveRaster?.url) {
    stepRasterCache.set(0, input.liveRaster);
  }

  const manifest: RadarHistoryManifest | null = input.radarHistory;
  if (manifest?.frames.length) {
    await Promise.all(
      manifest.frames.map(async (frame) => {
        if (frame.offsetMinutes > 0) return;
        const raster = await loadRadarHistoryRaster(frame);
        if (gen !== warmGeneration || !raster) return;
        for (const offset of allOffsets()) {
          if (offset > 0) continue;
          if (offset === 0 && frame.offsetMinutes !== 0) continue;
          const best = frameForOffset(manifest, offset);
          if (offset < 0 && best?.path === frame.path) {
            stepRasterCache.set(offset, raster);
          }
        }
      }),
    );
  }

  if (gen !== warmGeneration) return;
  preloadMapImages([...stepRasterCache.values()].map((m) => m.url));
  notifyWarmListeners();
}

export function seedSliderRasterCache(
  offset: number,
  meta: RadarRasterMeta,
): void {
  stepRasterCache.set(offset, meta);
}

export function sliderCacheSize(): number {
  return stepRasterCache.size;
}

export function sliderCacheUrls(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [k, v] of stepRasterCache) {
    out[k] = v.url.slice(0, 48);
  }
  return out;
}
