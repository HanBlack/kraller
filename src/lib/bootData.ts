import type { StormDataBundle } from "./loadStormData";
import type { DataSourceStatus } from "./loadStormData";
import { loadStormData } from "./loadStormData";
import { requestServerDataRefresh } from "./refreshServerData";
import type { FormationZone } from "../storm/demo";

/** Při bootu v dev akceptuj data starší než 25 min (po pokusu o obnovu). */
export const BOOT_MAX_DATA_AGE_MS = 25 * 60 * 1000;
/** Na produkci (GitHub Pages) stačí soubory z deploye — GH Actions je obnoví. */
export const PROD_BOOT_MAX_DATA_AGE_MS = 6 * 60 * 60 * 1000;
const BOOT_POLL_MS = 2500;
const BOOT_MAX_POLLS = 8;

export function dataAgeMs(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - new Date(iso).getTime());
}

function isSourceFresh(
  source: DataSourceStatus | null | undefined,
  maxMs: number,
): boolean {
  if (!source) return true;
  if (source.ok === false) return false;
  if (!source.updatedAt) return true;
  return dataAgeMs(source.updatedAt) <= maxMs;
}

/**
 * Jsou data dostatečně čerstvá?
 * Stránka jen čte public/data — nevolá OPERA/Open-Meteo sama.
 */
export function isBootDataReady(
  data: StormDataBundle,
  maxAgeMs = import.meta.env.DEV
    ? BOOT_MAX_DATA_AGE_MS
    : PROD_BOOT_MAX_DATA_AGE_MS,
): boolean {
  if (dataAgeMs(data.metaUpdatedAt) > maxAgeMs) return false;
  if (!isSourceFresh(data.dataSources?.opera, maxAgeMs)) return false;
  if (!isSourceFresh(data.dataSources?.wind, maxAgeMs)) return false;
  if (!isSourceFresh(data.dataSources?.formation, maxAgeMs)) {
    return false;
  }
  if (!data.windReal) return false;
  if (
    data.dataSources?.opera?.ok === false &&
    data.radarData.features.length === 0 &&
    !data.radarRaster
  ) {
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export type BootRefreshPhase = "poll" | "fetch";

/**
 * Načte data pro boot.
 * V dev: při zastaralých souborech jednou spustí update_data.py na serveru.
 */
export async function loadStormDataForBoot(
  fallbackFormation: FormationZone[],
  onPhase?: (phase: BootRefreshPhase) => void,
): Promise<StormDataBundle> {
  let last = await loadStormData(Date.now(), fallbackFormation);
  if (isBootDataReady(last)) return last;

  // Produkce: statické soubory z deploye — nečekat na „fresh“ polling.
  if (!import.meta.env.DEV) return last;

  onPhase?.("fetch");
  await requestServerDataRefresh();
  last = await loadStormData(Date.now(), fallbackFormation);
  if (isBootDataReady(last)) return last;

  for (let attempt = 0; attempt < BOOT_MAX_POLLS; attempt++) {
    onPhase?.("poll");
    await sleep(BOOT_POLL_MS);
    last = await loadStormData(Date.now(), fallbackFormation);
    if (isBootDataReady(last)) return last;
  }

  return last;
}
