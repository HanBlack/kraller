import { formatStormAlert, formatStormAlertDetail } from "../lib/formatAlert";
import { t, type Locale } from "../i18n";
import { formatFormationExtras } from "./formationCopy";
import { alertFromActive } from "./buildAlert";
import type { FormationFeature } from "./mapFeatures";
import type { RadarProgressFeature } from "./radarCells";
import type { StormAlert } from "../types";

export type ThreatBannerItem =
  | {
      kind: "radar";
      cellId: string;
      feature: RadarProgressFeature;
      alert: StormAlert;
    }
  | {
      kind: "formation";
      zoneId: string;
      feature: FormationFeature;
      alert: StormAlert;
    };

function alertFromFormation(
  feature: FormationFeature,
  toPlace: string,
): StormAlert | null {
  const { forecast, assessment, zone } = feature;
  if (!forecast.threatensUser || forecast.arrivalEtaMin == null) return null;
  return {
    severity: assessment.severity,
    etaMinutes: forecast.arrivalEtaMin,
    fromPlace: zone.placeName ?? zone.name,
    toPlace,
    maxDbz: forecast.expectedMaxDbz,
  };
}

/**
 * Banner jen při hrozbě k adrese (buňka / predikovaný vznik).
 */
export function pickThreatBanners(
  radarFeatures: RadarProgressFeature[],
  formationFeatures: FormationFeature[],
  placeName: string | null,
): ThreatBannerItem[] {
  if (!placeName) return [];

  const items: ThreatBannerItem[] = [];

  for (const feature of radarFeatures) {
    if (feature.threatens !== 1 || !feature.assessment) continue;
    const alert = alertFromActive(feature.assessment, placeName);
    if (!alert) continue;
    items.push({ kind: "radar", cellId: feature.id, feature, alert });
  }

  for (const feature of formationFeatures) {
    const alert = alertFromFormation(feature, placeName);
    if (!alert) continue;
    items.push({
      kind: "formation",
      zoneId: feature.zone.id,
      feature,
      alert,
    });
  }

  return items.sort((a, b) => a.alert.etaMinutes - b.alert.etaMinutes);
}

export function formatThreatBannerMessage(
  item: ThreatBannerItem,
  locale?: Locale,
): string {
  if (item.kind === "formation") {
    const clock = formatEtaClock(item.alert.etaMinutes);
    const dbz =
      item.alert.maxDbz != null
        ? ` (~${Math.round(item.alert.maxDbz)} dBZ)`
        : "";
    return t(
      "alert.formationMay",
      {
        from: item.alert.fromPlace,
        dbz,
        to: item.alert.toPlace,
        eta: item.alert.etaMinutes,
        clock,
      },
      locale,
    );
  }
  return formatStormAlert(item.alert, locale);
}

function formatEtaClock(etaMinutes: number): string {
  const rounded = Math.round(etaMinutes / 5) * 5;
  const at = new Date(Date.now() + rounded * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function formatThreatExpect(
  item: ThreatBannerItem,
  locale?: Locale,
): string | null {
  if (item.kind === "radar") {
    return formatStormAlertDetail(item.alert, locale);
  }
  const extras = formatFormationExtras(
    item.feature.assessment,
    item.feature.zone.environment,
    locale,
  );
  if (extras) return `${t("alert.expect", undefined, locale)} ${extras}`;
  if (item.alert.maxDbz != null && item.alert.maxDbz >= 40) {
    return t("alert.expectShower", undefined, locale);
  }
  return t("alert.expectEcho", undefined, locale);
}

export function threatBannerTitle(
  item: ThreatBannerItem,
  locale?: Locale,
): string {
  if (item.kind === "formation") {
    return t("alert.titleFormation", undefined, locale);
  }
  if (item.alert.etaMinutes <= 15) {
    return t("alert.titleNear", undefined, locale);
  }
  return t("alert.titleApproaching", undefined, locale);
}
