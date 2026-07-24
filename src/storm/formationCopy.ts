import { t, type Locale } from "../i18n";
import { stormConfig } from "./config";
import type { FormationZone } from "./demo";
import { formationShowsForecast } from "./formationForecast";
import type { EnvironmentSignals, FormationAssessment } from "./types";

/** @deprecated use formationSeverityLabel from lib/severity */
export const formationSeverityLabelCs: Record<
  FormationAssessment["severity"],
  string
> = {
  weak: "Nízká šance",
  moderate: "Střední šance",
  strong: "Vysoká šance",
};

export function formationPlaceName(zone: FormationZone): string {
  if (zone.placeName) return zone.placeName;
  const parts = zone.name.split("·").map((s) => s.trim());
  return parts[parts.length - 1] ?? zone.name;
}

export type FormationCoolingSignal = {
  /** satelit | model | none */
  kind: "satellite" | "model" | "none";
  /** Silné ochlazování (pre-echo minutes-ahead). */
  growing: boolean;
  label: string;
  text: string;
};

/**
 * Lidský signál z cloud-top cooling — hlavní „minutes-ahead“ před echom.
 */
export function formationCoolingSignal(
  env: EnvironmentSignals | null | undefined,
  locale?: Locale,
): FormationCoolingSignal {
  if (!env) {
    return {
      kind: "none",
      growing: false,
      label: t("formation.signalLabel", undefined, locale),
      text: t("formation.signalNone", undefined, locale),
    };
  }

  const cooling = env.cloudTopCoolingCPer15min ?? 0;
  const growThr = stormConfig.formation.cloudTopCoolingCPer15min.growing;
  // cooling je záporné při ochlazování; growing threshold je kladná magnituda
  const rate = -cooling;
  const growing = rate >= growThr;
  const source = env.coolingSource;

  if (source === "satellite") {
    if (growing) {
      return {
        kind: "satellite",
        growing: true,
        label: t("formation.signalSatLabel", undefined, locale),
        text: t(
          "formation.signalSatCooling",
          { rate: rate.toFixed(1) },
          locale,
        ),
      };
    }
    if (rate <= -growThr) {
      return {
        kind: "satellite",
        growing: false,
        label: t("formation.signalSatLabel", undefined, locale),
        text: t(
          "formation.signalSatWarming",
          { rate: Math.abs(rate).toFixed(1) },
          locale,
        ),
      };
    }
    return {
      kind: "satellite",
      growing: false,
      label: t("formation.signalSatLabel", undefined, locale),
      text: t("formation.signalSatSteady", undefined, locale),
    };
  }

  if (growing) {
    return {
      kind: "model",
      growing: true,
      label: t("formation.signalModelLabel", undefined, locale),
      text: t("formation.signalModelCooling", undefined, locale),
    };
  }

  return {
    kind: source === "model" ? "model" : "none",
    growing: false,
    label: t("formation.signalLabel", undefined, locale),
    text: t("formation.signalModelQuiet", undefined, locale),
  };
}

/** Krátký popis prostředí pro laiky (bez cooling — to je samostatný signal). */
export function formationEnvironmentSummary(
  env: EnvironmentSignals,
  locale?: Locale,
): string {
  const bits: string[] = [];

  if (env.capeJkg < 150) {
    bits.push(t("formation.envLowCape", undefined, locale));
  } else if (env.capeJkg >= 500) {
    bits.push(
      t("formation.envCape", { cape: Math.round(env.capeJkg) }, locale),
    );
  } else {
    bits.push(
      t(
        "formation.envCapeLimited",
        { cape: Math.round(env.capeJkg) },
        locale,
      ),
    );
  }

  if (env.dewpointC == null) {
    /* skip */
  } else if (env.dewpointC >= 15) bits.push(t("formation.envMoist", undefined, locale));
  else if (env.dewpointC >= 12) {
    bits.push(t("formation.envMoistModerate", undefined, locale));
  } else bits.push(t("formation.envDry", undefined, locale));

  if (env.shear0to6Ms >= 18) {
    bits.push(t("formation.envShearStrong", undefined, locale));
  } else if (env.shear0to6Ms >= 12) {
    bits.push(t("formation.envShearModerate", undefined, locale));
  } else bits.push(t("formation.envShearWeak", undefined, locale));

  const cinMag =
    env.convectiveInhibitionJkg != null
      ? Math.abs(env.convectiveInhibitionJkg)
      : 0;
  if (cinMag >= 80) {
    bits.push(t("formation.envCinStrong", undefined, locale));
  } else if (cinMag >= 40) {
    bits.push(t("formation.envCinModerate", undefined, locale));
  }

  return bits.join(" · ");
}

/** Live sat cooling = minutes-ahead vůči samotnému prostředí. */
function satGrowingAhead(env?: EnvironmentSignals | null): boolean {
  if (!env || env.coolingSource !== "satellite") return false;
  const grow = stormConfig.formation.cloudTopCoolingCPer15min.growing;
  const cooling15 = Math.max(0, -(env.cloudTopCoolingCPer15min ?? 0));
  const cooling45 =
    env.cloudTopCoolingCPer45min != null
      ? Math.max(0, -env.cloudTopCoolingCPer45min)
      : 0;
  const tower = env.cloudTopHeightDeltaMPer15min ?? 0;
  return (
    cooling15 >= grow ||
    cooling45 >= stormConfig.satellite.longCoolingCPer45min ||
    tower >= stormConfig.satellite.towerRisingMPer15min
  );
}

/** Hlavní věta panelu Vznik — bez technického balastu. */
export function formatFormationHeadline(
  a: FormationAssessment,
  place: string,
  locale?: Locale,
  env?: EnvironmentSignals | null,
): string {
  if (!formationShowsForecast(a.score)) {
    return t("formation.noStormWatch", { place }, locale);
  }

  if (satGrowingAhead(env)) {
    return t("formation.satAheadRisk", { place }, locale);
  }

  if (a.severity === "strong") {
    return t("formation.strongRisk", { place }, locale);
  }

  if (a.severity === "moderate") {
    return t("formation.moderateRisk", { place }, locale);
  }

  if (envNeedsEnergy(a) && a.score < 45) {
    return t("formation.weakEnv", { place }, locale);
  }

  return t("formation.weakPossible", { place }, locale);
}

function envNeedsEnergy(a: FormationAssessment): boolean {
  return a.reasons.every((r) => !r.startsWith("CAPE"));
}

/** Doplňkové riziko — jen když dává smysl (ne u CAPE 0). */
export function formatFormationExtras(
  a: FormationAssessment,
  env: EnvironmentSignals,
  locale?: Locale,
): string | null {
  const parts: string[] = [];
  const minCape = stormConfig.formation.tornadoMinCapeJkg;

  if (
    a.severity !== "weak" &&
    env.capeJkg >= minCape &&
    a.hazards.hail >= 65 &&
    (env.capeNowJkg ?? env.capeJkg) >= 200
  ) {
    parts.push(t("formation.hailChance", undefined, locale));
  }

  if (
    a.severity === "strong" &&
    env.capeJkg >= minCape &&
    a.hazards.tornado >= stormConfig.formation.tornadoShowThresholdPct
  ) {
    parts.push(t("alert.organized", undefined, locale));
  }

  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/** Popisek na mapě — jeden řádek místo + síla. */
export function formationMapLabel(
  zone: FormationZone,
  a: FormationAssessment,
  locale?: Locale,
): string {
  const place = formationPlaceName(zone);
  const level = formationShowsForecast(a.score)
    ? a.severity === "weak"
      ? t("severity.formWeak", undefined, locale)
      : a.severity === "moderate"
        ? t("severity.formModerate", undefined, locale)
        : t("severity.formStrong", undefined, locale)
    : t("severity.formNone", undefined, locale);
  return `${place}\n${level}`;
}
