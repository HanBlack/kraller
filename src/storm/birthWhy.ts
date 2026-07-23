import type { EnvironmentSignals, FormationAssessment } from "./types";
import { dewpointCOr } from "./types";
import type { ScoredFormationPoint } from "./formationData";
import { scoreFormation } from "./scoreFormation";
import { distanceKm } from "../lib/geo";
import {
  explainSatelliteColdTop,
  explainSatelliteDeepIce,
  explainSatelliteGrowth,
  explainSatelliteLightning,
  explainSatelliteLongGrowth,
  explainSatelliteTowerRising,
  explainSatelliteWarming,
  satelliteGrowthRate,
  satelliteLongGrowthRate,
  satelliteReasonLines,
  type SatelliteSample,
} from "./satelliteCooling";
import { stormConfig } from "./config";

export type BirthFactorKey =
  | "moisture"
  | "cape"
  | "shear"
  | "cooling"
  | "lift"
  | "local"
  | "other";

export type BirthFactor = {
  key: BirthFactorKey;
  label: string;
  detail: string;
  weight: number;
};

export type BirthWhyResult = {
  headline: string;
  primary: string;
  reasons: string[];
  factors: BirthFactor[];
  score: number;
  uncertain: boolean;
  shearMs: number | null;
};

type Driver = BirthFactor & { sortKey: string };

function neighborStats(
  lat: number,
  lon: number,
  points: ScoredFormationPoint[],
  radiusKm = 80,
): {
  avgCape: number;
  avgDew: number;
  avgCooling: number;
  avgScore: number;
  avgShear: number;
  n: number;
} | null {
  const near = points.filter(
    (p) => distanceKm(lat, lon, p.lat, p.lon) <= radiusKm,
  );
  if (near.length < 3) return null;
  const avgCape = near.reduce((s, p) => s + p.environment.capeJkg, 0) / near.length;
  const avgDew =
    near.reduce((s, p) => s + dewpointCOr(p.environment), 0) / near.length;
  const avgCooling =
    near.reduce(
      (s, p) => s + Math.max(0, -p.environment.cloudTopCoolingCPer15min),
      0,
    ) / near.length;
  const avgScore = near.reduce((s, p) => s + p.assessment.score, 0) / near.length;
  const avgShear =
    near.reduce((s, p) => s + p.environment.shear0to6Ms, 0) / near.length;
  return { avgCape, avgDew, avgCooling, avgScore, avgShear, n: near.length };
}

/**
 * Proč vzniklo echo — faktory prostředí (vlhkost, CAPE, střih, …).
 * Texty pro produkt, bez interních frází typu „setup“.
 */
export function explainBirthWhy(
  env: EnvironmentSignals | null | undefined,
  assessment?: FormationAssessment | null,
  opts?: {
    lat?: number;
    lon?: number;
    nearbyPoints?: ScoredFormationPoint[];
    /** Satelit přímo u jádra / zrodu — má prioritu před grid proxy. */
    satellite?: SatelliteSample | null;
  },
): BirthWhyResult {
  if (!env) {
    return {
      headline: "V místě zrodu chybí data prostředí.",
      primary: "chybí modelové prostředí",
      reasons: [],
      factors: [],
      score: 0,
      uncertain: true,
      shearMs: null,
    };
  }

  const a = assessment ?? scoreFormation(env);
  const drivers: Driver[] = [];
  const sat = opts?.satellite;
  const satGrowth15 =
    sat?.trend === "growing"
      ? satelliteGrowthRate(sat.cloudTopCoolingCPer15min)
      : 0;
  const satGrowth45 =
    sat?.trend === "growing_long"
      ? satelliteLongGrowthRate(sat.cloudTopCoolingCPer45min)
      : 0;
  const satGrowth =
    satGrowth15 > 0
      ? satGrowth15
      : satGrowth45 > 0
        ? satGrowth45 * (15 / 45)
        : 0;
  const cooling = satGrowth > 0 ? satGrowth : Math.max(0, -env.cloudTopCoolingCPer15min);
  const coolingFromSat = satGrowth > 0;
  const li = env.liftedIndexC ?? 2;
  const shear = env.shear0to6Ms;
  const dew = dewpointCOr(env);

  if (dew >= 14) {
    drivers.push({
      sortKey: "moisture",
      key: "moisture",
      label: "Vlhkost u země",
      detail: `rosný bod ${dew.toFixed(0)} °C — palivo pro první echo`,
      weight: 18 + Math.min(22, (dew - 12) * 4),
    });
  } else if (dew >= 11) {
    drivers.push({
      sortKey: "moisture",
      key: "moisture",
      label: "Vlhkost u země",
      detail: `rosný bod ${dew.toFixed(0)} °C`,
      weight: 10,
    });
  }

  if (env.capeJkg >= 300) {
    drivers.push({
      sortKey: "cape",
      key: "cape",
      label: "Energie ve vzduchu",
      detail: "dost na silnější bouřku",
      weight: 22 + Math.min(30, env.capeJkg / 50),
    });
  } else if (env.capeJkg >= 80) {
    drivers.push({
      sortKey: "cape",
      key: "cape",
      label: "Energie ve vzduchu",
      detail: "stačí na slabší echo",
      weight: 12,
    });
  }

  // Střih = klíčová složka organizace / života buňky — ukazovat dřív
  if (shear >= 10) {
    drivers.push({
      sortKey: "shear",
      key: "shear",
      label: "Vítr s výškou",
      detail: "mění se dost — pomáhá vzniku a vydržení buňky",
      weight: 16 + Math.min(20, shear),
    });
  } else if (shear >= 7) {
    drivers.push({
      sortKey: "shear",
      key: "shear",
      label: "Vítr s výškou",
      detail: "mírná změna — buňka může krátce vydržet",
      weight: 11,
    });
  } else if (shear > 0 && shear < 6) {
    drivers.push({
      sortKey: "shear-weak",
      key: "shear",
      label: "Vítr s výškou",
      detail: "málo se mění — typicky krátký život buňky",
      weight: 5,
    });
  }

  if (cooling >= 2) {
    const fromSat = coolingFromSat || env.coolingSource === "satellite";
    const longDetail =
      sat?.trend === "growing_long"
        ? explainSatelliteLongGrowth(sat).replace(/^vrchol mraku /i, "")
        : null;
    drivers.push({
      sortKey: "cooling",
      key: "cooling",
      label: fromSat ? "Vrchol mraku chladne" : "Rostoucí nestabilita",
      detail: longDetail
        ? longDetail
        : fromSat
          ? "satelit u jádra — bouřka nahoře ještě roste"
          : "model — může zesílit (ne přímý satelit)",
      weight: 30 + Math.min(25, cooling * 4),
    });
  } else if (sat?.towerRising) {
    drivers.push({
      sortKey: "cooling-tower",
      key: "cooling",
      label: "Mrak roste do výšky",
      detail: explainSatelliteTowerRising(sat),
      weight: 28,
    });
  } else if (sat?.coldTop) {
    drivers.push({
      sortKey: "cooling-cold",
      key: "cooling",
      label: "Studený vrchol",
      detail: explainSatelliteColdTop(sat),
      weight: 22,
    });
  } else if (sat?.deepIceTop) {
    drivers.push({
      sortKey: "cooling-ice",
      key: "cooling",
      label: "Hluboká ledová vrstva",
      detail: explainSatelliteDeepIce(sat),
      weight: 18,
    });
  } else if (sat?.trend === "warming") {
    drivers.push({
      sortKey: "cooling-warm",
      key: "cooling",
      label: "Vrchol mraku",
      detail: explainSatelliteWarming(sat),
      weight: 6,
    });
  }

  if (
    sat &&
    sat.lightningFlashes15min >= stormConfig.satellite.lightningActiveMin
  ) {
    drivers.push({
      sortKey: "lightning",
      key: "other",
      label: "Blesky",
      detail: explainSatelliteLightning(sat),
      weight: 20 + Math.min(15, sat.lightningFlashes15min),
    });
  }

  if (li <= 0) {
    drivers.push({
      sortKey: "lift",
      key: "lift",
      label: "Nestabilita",
      detail: "vzduch snadno stoupá nahoru",
      weight: li <= -2 ? 22 : 14,
    });
  }

  if (opts?.lat != null && opts?.lon != null && opts.nearbyPoints?.length) {
    const nb = neighborStats(opts.lat, opts.lon, opts.nearbyPoints);
    if (nb) {
      if (env.capeJkg >= nb.avgCape + 80) {
        drivers.push({
          sortKey: "local-cape",
          key: "local",
          label: "Víc energie než okolí",
          detail: "právě tady je vzduch „nabitější“ než kolem",
          weight: 28,
        });
      }
      if (dew >= nb.avgDew + 1.2) {
        drivers.push({
          sortKey: "local-dew",
          key: "local",
          label: "Vlhčí než okolí",
          detail: `rosný bod +${(dew - nb.avgDew).toFixed(1)} °C oproti okolí`,
          weight: 20,
        });
      }
      if (shear >= nb.avgShear + 2.5 && shear >= 8) {
        drivers.push({
          sortKey: "local-shear",
          key: "local",
          label: "Silnější změna větru než okolí",
          detail: "lepší podmínky pro organizovanou buňku právě tady",
          weight: 18,
        });
      }
      if (cooling >= nb.avgCooling + 1.0 && cooling >= 1.5) {
        drivers.push({
          sortKey: "local-cool",
          key: "cooling",
          label:
            coolingFromSat || env.coolingSource === "satellite"
              ? "Silnější růst právě tady"
              : "Aktivnější růst právě tady",
          detail:
            coolingFromSat || env.coolingSource === "satellite"
              ? "vrchol mraku tu chladne víc než v okolí"
              : "modelová nestabilita tu je silnější než v okolí",
          weight: 26,
        });
      }
    }
  }

  drivers.sort((x, y) => y.weight - x.weight);

  // Preferovat smysluplné faktory; slabý střih nechat až na konec
  const ranked = [
    ...drivers.filter((d) => d.sortKey !== "shear-weak"),
    ...drivers.filter((d) => d.sortKey === "shear-weak"),
  ].slice(0, 5);

  const factors: BirthFactor[] = ranked.map(
    ({ key, label, detail, weight }) => ({ key, label, detail, weight }),
  );
  const reasons = factors.map((f) => `${f.label}: ${f.detail}`);
  const primary = factors[0]
    ? `${factors[0].label.toLowerCase()} (${factors[0].detail})`
    : "lokální podmínky v místě zrodu";

  let headline: string;
  let uncertain = false;

  if (factors.length === 0) {
    uncertain = true;
    headline =
      "Model neukazuje výrazný signál. Pravděpodobné je lokální zvednutí vzduchu (terén nebo denní ohřev).";
  } else {
    const top = factors[0];
    const shearFactor = factors.find((f) => f.key === "shear" && f.weight >= 11);
    if (top.key === "shear") {
      headline =
        "Zrod podporuje změna větru s výškou — pomáhá buňce vzniknout a vydržet.";
    } else if (top.key === "cooling" && coolingFromSat) {
      headline = `Satelit u jádra: ${explainSatelliteGrowth(sat!)}`;
    } else if (sat && satelliteReasonLines(sat).length > 0) {
      headline = `Satelit u jádra: ${satelliteReasonLines(sat)[0]}`;
    } else if (shearFactor) {
      headline = `Hlavní faktor: ${top.label.toLowerCase()}. Doplňuje ho změna větru s výškou.`;
    } else if (a.score >= 35 || env.capeJkg >= 250 || cooling >= 3) {
      headline = `Podmínky vzniku: ${top.label.toLowerCase()} — ${top.detail}.`;
    } else {
      headline = `V místě zrodu: ${top.label.toLowerCase()} — ${top.detail}.`;
    }
  }

  return {
    headline,
    primary,
    reasons,
    factors,
    score: a.score,
    uncertain,
    shearMs: shear,
  };
}
