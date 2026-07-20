import { t, type Locale } from "../i18n";
import { stormConfig } from "./config";
import type { FormationZone } from "./demo";
import type { EnvironmentSignals, FormationAssessment } from "./types";

/** @deprecated use formationSeverityLabel from lib/severity */
export const formationSeverityLabelCs: Record<
  FormationAssessment["severity"],
  string
> = {
  weak: "Nízký potenciál",
  moderate: "Střední potenciál",
  strong: "Vysoký potenciál",
};

export function formationPlaceName(zone: FormationZone): string {
  if (zone.placeName) return zone.placeName;
  const parts = zone.name.split("·").map((s) => s.trim());
  return parts[parts.length - 1] ?? zone.name;
}

/** Krátký popis prostředí pro laiky. */
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

/** Hlavní věta panelu Vznik — bez technického balastu. */
export function formatFormationHeadline(
  a: FormationAssessment,
  place: string,
  locale?: Locale,
): string {
  if (a.score < 28) {
    return t("formation.noStormWatch", { place }, locale);
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
  const level =
    a.severity === "weak"
      ? t("severity.formWeak", undefined, locale)
      : a.severity === "moderate"
        ? t("severity.formModerate", undefined, locale)
        : t("severity.formStrong", undefined, locale);
  return `${place}\n${level}`;
}
