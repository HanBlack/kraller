import { t, type Locale } from "../i18n";
import { stormConfig } from "./config";
import {
  formatFormationPrediction,
  formatInitiationWindow,
  stormTypeLabel,
  type FormationForecast,
} from "./formationForecast";
import type { StormAlert } from "../types";
import type {
  ActiveStormAssessment,
  FormationAssessment,
} from "./types";
import type { FormationZone } from "./demo";
import { showSupercellEnvBadge } from "./scoreActive";

export function alertFromActive(
  a: ActiveStormAssessment,
  toPlace: string,
): StormAlert | null {
  if (a.etaMinutes == null) return null;

  const tornado =
    a.hazards.tornado >= stormConfig.tornadoShowThresholdPct
      ? Math.round(a.hazards.tornado)
      : null;

  return {
    severity: a.severity,
    etaMinutes: a.etaMinutes,
    fromPlace: a.fromPlace,
    toPlace,
    maxDbz: a.maxDbz,
    distanceKm: Math.round(a.distanceToUserKm * 10) / 10,
    hailCmMax: a.hailCmMax ?? undefined,
    rainMmPerHour: a.rainMmPerHour ?? undefined,
    hitType: a.hitType,
    missKm: a.missKm,
    atUserDbz: a.atUserDbz,
    tornadoChancePct: tornado,
    supercellEnvRisk: showSupercellEnvBadge(a) || undefined,
  };
}

/** Hlavní text panelu Vznik — predikce kdy, jak silná, kam. */
export function formatFormationMessage(
  a: FormationAssessment,
  zone: FormationZone,
  forecast: FormationForecast,
  userPlace?: string,
  locale?: Locale,
): string {
  const place = zone.placeName ?? zone.name;
  return formatFormationPrediction(place, a, forecast, userPlace, locale);
}

/** Krátký souhrn pro detail pod nadpisem. */
export function formatFormationSummary(
  f: FormationForecast,
  locale?: Locale,
): string {
  return t(
    "formation.summary",
    {
      when: formatInitiationWindow(f),
      type: stormTypeLabel(f.stormType, locale),
      dbz: f.expectedMaxDbz,
      speed: f.speedKmh,
    },
    locale,
  );
}

