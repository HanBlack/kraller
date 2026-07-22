import { severityLabel } from "../lib/severity";
import { getLocale } from "../i18n";
import type { RadarProgressFeature } from "./radarCells";
import { dewpointCOr } from "./types";
import {
  satelliteGrowthRate,
  satelliteLongGrowthRate,
  satelliteReasonLines,
  type SatelliteSample,
} from "./satelliteCooling";

/**
 * Proč buňka „roste“ / je slabá–střední–silná — text pro mapu i detail.
 */
export function explainGrowthWhy(
  feature: Pick<
    RadarProgressFeature,
    | "phase"
    | "growthDbz"
    | "ageMinutes"
    | "birthDbz"
    | "maxDbz"
    | "history"
    | "birthEnv"
    | "isNewborn"
    | "satAtPeak"
  >,
  satAtPeak?: SatelliteSample | null,
): { headline: string; reasons: string[]; shortLabel: string | null } {
  const reasons: string[] = [];
  const growth = feature.growthDbz;
  const age = Math.max(1, feature.ageMinutes);
  const peakSat = satAtPeak ?? feature.satAtPeak ?? null;

  if (peakSat) {
    for (const line of satelliteReasonLines(peakSat)) {
      if (!reasons.includes(line)) reasons.push(line);
    }
  }

  if (growth >= 3) {
    reasons.push(
      `od zrodu sílí: ${feature.birthDbz.toFixed(0)} → ${feature.maxDbz.toFixed(0)} dBZ (+${growth.toFixed(0)} za ~${age} min)`,
    );
  }

  const hist = feature.history;
  if (hist.length >= 2) {
    const prev = hist[hist.length - 2];
    const last = hist[hist.length - 1];
    const d = last.maxDbz - prev.maxDbz;
    if (d >= 2) {
      reasons.push(`v posledních snímcích radar ukazuje růst o ~${d.toFixed(0)} dBZ`);
    }
  }

  const env = feature.birthEnv?.environment;
  if (env) {
    const dew = dewpointCOr(env);
    if (dew >= 14) {
      reasons.push(
        `vlhký vzduch u země (rosný bod ${dew.toFixed(0)} °C) — palivo pro výstup`,
      );
    }
    if (env.capeJkg >= 80) {
      reasons.push(`energie výstupu CAPE ~${Math.round(env.capeJkg)} J/kg`);
    }
    if (env.shear0to6Ms >= 8) {
      reasons.push(
        `střih ${env.shear0to6Ms.toFixed(0)} m/s pomáhá buňku udržet a organizovat`,
      );
    }
    const cooling = Math.max(0, -env.cloudTopCoolingCPer15min);
    const satRate =
      peakSat?.trend === "growing"
        ? satelliteGrowthRate(peakSat.cloudTopCoolingCPer15min)
        : peakSat?.trend === "growing_long"
          ? satelliteLongGrowthRate(peakSat.cloudTopCoolingCPer45min) * (15 / 45)
          : 0;
    if (satRate < 1.5 && cooling >= 1.5) {
      reasons.push(
        env.coolingSource === "satellite"
          ? `vrchol mraku se ochlazuje (satelit −${cooling.toFixed(1)} °C / 15 min) — konvekce ještě roste`
          : `rostoucí nestabilita v modelu (−${cooling.toFixed(1)} °C proxy) — konvekce může sílit`,
      );
    }
    const li = env.liftedIndexC;
    if (li != null && li <= 0) {
      reasons.push(`nestabilní vrstva (LI ${li.toFixed(1)} °C)`);
    }
  }

  if (feature.isNewborn || feature.phase === "birth") {
    reasons.push("mladé echo — typicky ještě nabírá sílu, pokud prostředí drží");
  }

  if (reasons.length === 0) {
    reasons.push("radarová stopa ukazuje mladší / sílící buňku");
  }

  const primary = reasons[0];
  const headline =
    feature.phase === "growing" || growth >= 3
      ? `Roste, protože ${primary.replace(/^od zrodu sílí: /, "sílí: ")}.`
      : feature.phase === "birth"
        ? `Nový zrod — ${primary}.`
        : primary;

  const shortLabel =
    feature.phase === "growing" || growth >= 3
      ? growth >= 3
        ? `+${growth.toFixed(0)} dBZ`
        : "sílí"
      : feature.phase === "birth"
        ? "nový"
        : null;

  return { headline, reasons: reasons.slice(0, 4), shortLabel };
}

/** Proč je popisek Slabá / Střední / Silná. */
export function explainSeverityWhy(
  maxDbz: number,
  severity: "weak" | "moderate" | "strong",
): { headline: string; reasons: string[] } {
  const label = severityLabel(severity, getLocale());
  const reasons: string[] = [];

  if (severity === "strong") {
    reasons.push(`odrazivost ~${Math.round(maxDbz)} dBZ — silný výstup a intenzivní srážky`);
    if (maxDbz >= 55) {
      reasons.push("nad ~55 dBZ stoupá riziko krup a silných nárazů větru");
    }
  } else if (severity === "moderate") {
    reasons.push(`odrazivost ~${Math.round(maxDbz)} dBZ — klasická bouřková buňka`);
    reasons.push("čekej déšť, blesky a krátké nárazy větru");
  } else {
    reasons.push(`odrazivost ~${Math.round(maxDbz)} dBZ — slabší echo / přeháňka`);
    reasons.push("zatím spíš déšť než silná bouřka");
  }

  return {
    headline: `${label}, protože ${reasons[0]}.`,
    reasons,
  };
}
