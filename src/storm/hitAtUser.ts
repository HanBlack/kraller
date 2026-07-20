/**
 * Odhad zásahu u sledované adresy: jádro vs okraj vs mimo.
 * Miss = kolmá vzdálenost k předpokládané dráze (heading), ne jen peak→user.
 */

import { stormConfig } from "./config";

export type HitType = "core" | "fringe" | "edge" | "miss";

export type HitAtUser = {
  hitType: HitType;
  /** Odhad kolmé vzdálenosti k dráze jádra (km). */
  missKm: number;
  /** Odhad dBZ u adresy (ne peak buňky). */
  atUserDbz: number | null;
  /** Poloměry pásem (km) použité pro klasifikaci. */
  coreKm: number;
  fringeKm: number;
  echoKm: number;
};

function sizeScale(maxDbz: number): number {
  return Math.max(0.65, Math.min(1.35, (maxDbz - 35) / 28));
}

/**
 * Poloměry pásem pro zásah u adresy.
 * Širší než tvrdé radarové jádro — peak skáče; víkend: ~10 km miss = okraj s deštěm.
 */
export function bandRadiiKm(maxDbz: number): {
  coreKm: number;
  fringeKm: number;
  echoKm: number;
} {
  const s = sizeScale(maxDbz);
  const coreKm = Math.max(3.5, (maxDbz >= 55 ? 4.5 : 3.8) * s);
  const fringeKm = Math.max(11, (maxDbz >= 50 ? 14 : 11) * s);
  const echoKm = Math.max(16, 20 * s);
  return { coreKm, fringeKm, echoKm };
}

/**
 * Přibližná miss distance: |sin(approach)| × vzdálenost.
 * approach 0° = přímo na tebe → miss ~0; 90° = kolem → miss ≈ dist.
 */
export function estimateMissKm(
  distanceToUserKm: number,
  approachAngleDeg: number,
): number {
  const a = Math.abs(approachAngleDeg) % 180;
  const acute = a > 90 ? 180 - a : a;
  return Math.abs(Math.sin((acute * Math.PI) / 180)) * distanceToUserKm;
}

export function dbzAtHit(maxDbz: number, hitType: HitType): number | null {
  if (hitType === "core") return maxDbz;
  if (hitType === "fringe") return Math.max(28, maxDbz - 10);
  if (hitType === "edge") return Math.max(25, maxDbz - 18);
  return null;
}

export function classifyHitAtUser(input: {
  maxDbz: number;
  distanceToUserKm: number;
  approachAngleDeg: number;
}): HitAtUser {
  const { coreKm, fringeKm, echoKm } = bandRadiiKm(input.maxDbz);
  let missKm = estimateMissKm(input.distanceToUserKm, input.approachAngleDeg);

  // Už skoro nad tebou — miss z úhlu podhodnocuje; ber vzdálenost k peaku
  if (input.distanceToUserKm <= 8) {
    missKm = Math.min(missKm, input.distanceToUserKm);
  }

  let hitType: HitType;
  // Peak v dosahu jádra = jsi v buňce (i při špatném approach úhlu)
  if (input.distanceToUserKm <= Math.max(coreKm, 5)) {
    hitType = "core";
    missKm = Math.min(missKm, input.distanceToUserKm);
  } else if (missKm <= coreKm) {
    hitType = "core";
  } else if (missKm <= fringeKm) {
    hitType = "fringe";
  } else if (missKm <= echoKm) {
    hitType = "edge";
  } else {
    hitType = "miss";
  }

  return {
    hitType,
    missKm: Math.round(missKm * 10) / 10,
    atUserDbz: dbzAtHit(input.maxDbz, hitType),
    coreKm: Math.round(coreKm * 10) / 10,
    fringeKm: Math.round(fringeKm * 10) / 10,
    echoKm: Math.round(echoKm * 10) / 10,
  };
}

/** Marshall–Palmer-ish mm/h z dBZ — export pro hit u adresy. */
export function estimateRainMmH(maxDbz: number): [number, number] | null {
  const table = stormConfig.active.rain.dbzToMmH;
  if (maxDbz < table[0].dbz) return null;

  let mm = table[0].mmH as number;
  for (const row of table) {
    if (maxDbz >= row.dbz) mm = row.mmH;
  }
  const lo = Math.round(mm * 0.7);
  const hi = Math.round(mm * 1.15);
  return [lo, hi];
}

/** Severity podle dBZ u adresy (ne peak). */
export function severityFromDbz(
  dbz: number,
): "weak" | "moderate" | "strong" {
  const z = stormConfig.active.reflectivityDbz;
  if (dbz >= z.strong) return "strong";
  if (dbz >= z.moderate) return "moderate";
  return "weak";
}
