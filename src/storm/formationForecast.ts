import { headingLabel, headingShort } from "../lib/direction";
import { czechRegionLabel } from "../lib/czechRegion";
import { t, type Locale } from "../i18n";
import {
  angleDiffDeg,
  bearingDeg,
  destinationPoint,
  distanceKm,
} from "../lib/geo";
import { stormSteeringMotion, type WindGrid } from "../lib/windField";
import { stormConfig } from "./config";
import type { EnvironmentSignals, FormationAssessment } from "./types";

/** Pod tímto skóre neukazuj konkrétní ETA/sílu — jen „zatím nečekáme“. */
export const FORMATION_FORECAST_MIN_SCORE = 28;

export type FormationForecast = {
  /** Odhad do kdy se může objevit echo na radaru (minuty). */
  initEtaMin: number;
  initEtaMax: number;
  /** Očekávané max. odražení po zrodu (dBZ). */
  expectedMaxDbz: number;
  /** Typ bouřky po zrodu (klíč pro překlad). */
  stormType: StormTypeKey;
  /** Směr pohybu po zrodu (stupně). */
  headingDeg: number;
  speedKmh: number;
  /** Kam do ~60 min [lon, lat]. */
  trackEnd: [number, number];
  /** Odhad příletu k uživateli (min od teď), null pokud nesměřuje. */
  arrivalEtaMin: number | null;
  threatensUser: boolean;
};

export function formationShowsForecast(score: number): boolean {
  return score >= FORMATION_FORECAST_MIN_SCORE;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function steeringMotion(
  env: EnvironmentSignals,
  windLow: WindGrid | null,
  windUpper: WindGrid | null,
  lon: number,
  lat: number,
): { headingDeg: number; speedKmh: number } {
  if (env.steerSpeedKmh != null && env.steerHeadingDeg != null) {
    // Env steer = deep-layer; jemně smíchej s wind gridem, když je
    const base = {
      headingDeg: env.steerHeadingDeg,
      speedKmh: Math.max(8, env.steerSpeedKmh * 0.82),
    };
    if (!windUpper) return base;
    const deep = stormSteeringMotion(windLow, windUpper, lon, lat);
    const r1 = (base.headingDeg * Math.PI) / 180;
    const r2 = (deep.headingDeg * Math.PI) / 180;
    const u = 0.45 * Math.sin(r1) * base.speedKmh + 0.55 * Math.sin(r2) * deep.speedKmh;
    const v = 0.45 * Math.cos(r1) * base.speedKmh + 0.55 * Math.cos(r2) * deep.speedKmh;
    return {
      headingDeg: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360,
      speedKmh: Math.hypot(u, v),
    };
  }
  return stormSteeringMotion(windLow, windUpper, lon, lat);
}

/** Live sat = minutes-ahead; model cooling je slabší proxy. */
function applySatelliteTiming(
  env: EnvironmentSignals,
  center: number,
): { center: number; satGrowing: boolean; satWarming: boolean } {
  const cfg = stormConfig.formation.cloudTopCoolingCPer15min;
  const satCfg = stormConfig.satellite;
  const cooling15 = Math.max(0, -(env.cloudTopCoolingCPer15min ?? 0));
  const cooling45 =
    env.cloudTopCoolingCPer45min != null
      ? Math.max(0, -env.cloudTopCoolingCPer45min)
      : 0;
  const warming =
    (env.cloudTopCoolingCPer15min ?? 0) >= cfg.growing;
  const towerRise = env.cloudTopHeightDeltaMPer15min ?? 0;
  const coldTop =
    env.cloudTopTempC != null && env.cloudTopTempC <= satCfg.coldTopTempC;
  const lightning =
    (env.lightningFlashes15min ?? 0) >= satCfg.lightningActiveMin;

  if (env.coolingSource !== "satellite") {
    // Model / LI proxy — jen mírný posun, ať se nevydává za live CTT
    if (cooling15 >= 4) return { center: center - 5, satGrowing: false, satWarming: false };
    if (cooling15 >= 2) return { center: center - 3, satGrowing: false, satWarming: false };
    return { center, satGrowing: false, satWarming: false };
  }

  let next = center;
  if (warming) {
    next += 14;
  } else if (cooling15 >= cfg.rapid) {
    next -= 18;
  } else if (cooling15 >= cfg.growing) {
    next -= 14;
  } else if (cooling45 >= satCfg.longCoolingCPer45min) {
    next -= 10;
  } else if (cooling15 >= 1) {
    next -= 5;
  }

  if (towerRise >= satCfg.towerRisingMPer15min) next -= 6;
  if (coldTop && (cooling15 >= 1 || cooling45 >= satCfg.longCoolingCPer45min)) {
    next -= 4;
  }
  if (lightning) next -= 4;

  const satGrowing =
    !warming &&
    (cooling15 >= cfg.growing ||
      cooling45 >= satCfg.longCoolingCPer45min ||
      towerRise >= satCfg.towerRisingMPer15min);

  return { center: next, satGrowing, satWarming: warming };
}

function estimateInitiationWindow(
  env: EnvironmentSignals,
  score: number,
): { min: number; max: number } {
  const capePeak = env.capeJkg;
  const capeNow = env.capeNowJkg ?? capePeak;

  let center = 50;
  if (score >= 55) center = 28;
  else if (score >= 40) center = 38;
  else if (score >= FORMATION_FORECAST_MIN_SCORE) center = 52;

  // Peak CAPE (horizont) vs CAPE teď — ráno peak lže o „za 15 min“
  if (capeNow < 50 && capePeak >= 250) center += 22;
  else if (capeNow < 100 && capePeak >= 400) center += 14;
  else if (capeNow >= 500) center -= 10;
  else if (capeNow >= 250) center -= 5;

  if (capePeak >= 1200 && capeNow >= 200) center -= 8;
  else if (capePeak < 120) center += 18;

  const li = env.liftedIndexC ?? 2;
  if (li <= -2 && capeNow >= 80) center -= 8;
  else if (li <= 0 && capeNow >= 60) center -= 4;
  else if (li >= 2) center += 8;

  const sat = applySatelliteTiming(env, center);
  center = sat.center;

  if ((env.dewpointC ?? -40) >= 16) center -= 3;

  // Když je energie až odpoledne, neříkej „za 15 min“ —
  // live sat cooling ale může oprávněně jít pod CAPE floor (minutes-ahead).
  let minFloor = capeNow < 60 ? 40 : capeNow < 120 ? 25 : 18;
  let spread =
    capeNow < capePeak * 0.35 ? 22 : score >= 42 ? 12 : 18;

  if (sat.satGrowing) {
    minFloor = Math.min(minFloor, capeNow < 80 ? 18 : 12);
    spread = Math.min(spread, 10);
  } else if (sat.satWarming) {
    minFloor = Math.max(minFloor, 35);
    spread = Math.max(spread, 16);
  }

  center = clamp(center, minFloor + 5, 85);
  return {
    min: clamp(center - spread, minFloor, 90),
    max: clamp(center + spread, minFloor + 15, 110),
  };
}

export type StormTypeKey =
  | "shower"
  | "organized"
  | "strong"
  | "moderate"
  | "weak";

const STORM_TYPE_KEYS: Record<StormTypeKey, string> = {
  shower: "formation.typeShower",
  organized: "formation.typeOrganized",
  strong: "formation.typeStrong",
  moderate: "formation.typeModerate",
  weak: "formation.typeWeak",
};

export function stormTypeLabel(key: StormTypeKey, locale?: Locale): string {
  return t(STORM_TYPE_KEYS[key], undefined, locale);
}

function expectedStormType(
  env: EnvironmentSignals,
  a: FormationAssessment,
): StormTypeKey {
  if (env.capeJkg < 120 && a.score < 38) {
    return "shower";
  }
  if (
    env.capeJkg >= 500 &&
    env.shear0to6Ms >= 18 &&
    a.hazards.supercell >= 50
  ) {
    return "organized";
  }
  if (a.severity === "strong") return "strong";
  if (a.severity === "moderate") return "moderate";
  return "weak";
}

function estimateMaxDbz(
  env: EnvironmentSignals,
  a: FormationAssessment,
): number {
  const cfg = stormConfig.formation.cloudTopCoolingCPer15min;
  const satCfg = stormConfig.satellite;
  const cooling15 = Math.max(0, -(env.cloudTopCoolingCPer15min ?? 0));

  let dbz = 30 + a.score * 0.28;
  if (env.capeJkg >= 1500) dbz += 10;
  else if (env.capeJkg >= 700) dbz += 5;
  if (env.shear0to6Ms >= 18) dbz += 4;

  // Live CTT / LI — silnější buňka dřív, než to uvidí radar
  if (env.coolingSource === "satellite") {
    if (cooling15 >= cfg.rapid) dbz += 5;
    else if (cooling15 >= cfg.growing) dbz += 3;
    if (
      env.cloudTopTempC != null &&
      env.cloudTopTempC <= satCfg.coldTopTempC
    ) {
      dbz += 2;
    }
    if ((env.lightningFlashes15min ?? 0) >= satCfg.lightningActiveMin) {
      dbz += 2;
    }
  }

  if (env.capeJkg < 120) dbz = Math.min(dbz, 42);
  return Math.round(clamp(dbz, 32, 62));
}

/** Predikce vzniku: kdy, jak silná, kam půjde. */
export function forecastFormation(
  lat: number,
  lon: number,
  env: EnvironmentSignals,
  assessment: FormationAssessment,
  windLow: WindGrid | null,
  user: { lat: number; lon: number } | null,
  windUpper: WindGrid | null = null,
): FormationForecast {
  const { min: initEtaMin, max: initEtaMax } = estimateInitiationWindow(
    env,
    assessment.score,
  );
  const { headingDeg, speedKmh } = steeringMotion(
    env,
    windLow,
    windUpper,
    lon,
    lat,
  );
  const horizon = stormConfig.alertHorizonMin;
  const trackKm = (speedKmh * horizon) / 60;
  const trackEnd = destinationPoint(lat, lon, headingDeg, trackKm);
  const expectedMaxDbz = estimateMaxDbz(env, assessment);
  const stormType = expectedStormType(env, assessment);

  let arrivalEtaMin: number | null = null;
  let threatensUser = false;

  if (user && formationShowsForecast(assessment.score)) {
    const toUser = bearingDeg(lat, lon, user.lat, user.lon);
    const approach = angleDiffDeg(headingDeg, toUser);
    const distKm = distanceKm(lat, lon, user.lat, user.lon);
    const initMid = (initEtaMin + initEtaMax) / 2;
    if (approach <= 35 && distKm <= 100 && speedKmh >= 8) {
      const travelMin = (distKm / speedKmh) * 60;
      // Zaokrouhli — přesný přílet po zrodu je nejistý
      arrivalEtaMin = Math.round((initMid + travelMin) / 5) * 5;
      threatensUser =
        arrivalEtaMin <= horizon + 30 &&
        assessment.score >= 34 &&
        (env.capeNowJkg ?? env.capeJkg) >= 40;
    }
  }

  return {
    initEtaMin,
    initEtaMax,
    expectedMaxDbz,
    stormType,
    headingDeg,
    speedKmh: Math.round(speedKmh),
    trackEnd,
    arrivalEtaMin,
    threatensUser,
  };
}

export function formatInitiationWindow(f: FormationForecast): string {
  if (f.initEtaMin === f.initEtaMax) return `~${f.initEtaMin} min`;
  return `${f.initEtaMin}–${f.initEtaMax} min`;
}

export function formatFormationPrediction(
  place: string,
  a: FormationAssessment,
  f: FormationForecast,
  userPlace?: string,
  locale?: Locale,
): string {
  if (!formationShowsForecast(a.score)) {
    return t("formation.noStormNear", { place }, locale);
  }

  const when = formatInitiationWindow(f);
  const dir = headingLabel(f.headingDeg, locale);
  const parts = [
    t(
      "formation.mayForm",
      { place, type: stormTypeLabel(f.stormType, locale), when },
      locale,
    ),
    t(
      "formation.afterBirth",
      {
        dir,
        speed: f.speedKmh,
        dbz: f.expectedMaxDbz,
      },
      locale,
    ),
  ];

  if (f.threatensUser && f.arrivalEtaMin != null && userPlace) {
    parts.push(
      t(
        "formation.arrival",
        { place: userPlace, eta: f.arrivalEtaMin },
        locale,
      ),
    );
  }

  return parts.join(" ");
}

export function formationMapLabelWithForecast(
  place: string,
  a: FormationAssessment,
  f: FormationForecast,
  locale?: Locale,
): string {
  if (!formationShowsForecast(a.score)) {
    return `${place}\n${t("formation.noRiskLabel", undefined, locale)}`;
  }
  const [endLon, endLat] = f.trackEnd;
  const dest = czechRegionLabel(endLat, endLon, locale);
  const where = dest !== place ? `${place} → ${dest}` : place;
  const when = formatInitiationWindow(f);
  return `${where}\n≈${when} · ${headingShort(f.headingDeg)}`;
}
