/** Výška vrcholu mraku / echa — satelit CTH preferovaný, jinak radar echo top. */

export type CloudHeightSource = "satellite" | "radar";

export type CloudHeightReading = {
  /** Výška v km (už zaokrouhlená na 0.1). */
  km: number;
  source: CloudHeightSource;
};

const MIN_KM = 4;
const MAX_KM = 22;

/** Zaokrouhli na 0.1 km — rozumná přesnost pro CTH i echo top. */
export function roundCloudHeightKm(km: number): number {
  return Math.round(km * 10) / 10;
}

export function formatCloudHeightKm(km: number): string {
  return `~${roundCloudHeightKm(km).toFixed(1)} km`;
}

/**
 * Primárně satelitní CTH (celý mrak).
 * Jinak radarové echo top (ČHMÚ volume nebo proxy z dBZ) — bez slova „odhad“.
 */
export function resolveCloudHeight(input: {
  cloudTopHeightM?: number | null;
  echoTopKm?: number | null;
}): CloudHeightReading | null {
  const satM = input.cloudTopHeightM;
  if (satM != null && Number.isFinite(satM) && satM >= MIN_KM * 1000) {
    const km = roundCloudHeightKm(
      Math.min(MAX_KM, Math.max(MIN_KM, satM / 1000)),
    );
    return { km, source: "satellite" };
  }

  const echo = input.echoTopKm;
  if (echo != null && Number.isFinite(echo) && echo >= MIN_KM) {
    const km = roundCloudHeightKm(Math.min(MAX_KM, Math.max(MIN_KM, echo)));
    return { km, source: "radar" };
  }

  return null;
}
