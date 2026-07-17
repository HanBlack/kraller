import type { FeatureCollection } from "geojson";
import { destinationPoint } from "../lib/geo";
import { headingToCzech } from "../lib/direction";
import type { ScoredFormationPoint } from "./formationData";
import type { CellIntensification } from "./intensification";
import { formatIntensificationSummary } from "./intensification";
import {
  explainGrowthWhy,
  explainSeverityWhy,
} from "./growthWhy";
import type { RadarProgressFeature } from "./radarCells";
import type { EnvironmentSignals } from "./types";
import { dewpointCOr } from "./types";
import { distanceKm } from "../lib/geo";
import { stormConfig } from "./config";

export type LifecycleStepId =
  | "birth"
  | "factors"
  | "path"
  | "intensify"
  | "demise";

export type LifecycleStep = {
  id: LifecycleStepId;
  title: string;
  body: string;
  meta?: string;
  /** Proč se to stane — konkrétní drivěry. */
  reasons?: string[];
  active?: boolean;
};

export type DemiseEstimate = {
  etaMin: number;
  lon: number;
  lat: number;
  reason: string;
  reasons: string[];
};

export type StormLifecycle = {
  title: string;
  summary: string;
  steps: LifecycleStep[];
  demiseAt: [number, number] | null;
  demiseEtaMin: number | null;
  intensifyAt: [number, number] | null;
  intensifyEtaMin: number | null;
};

function nearestPoint(
  lat: number,
  lon: number,
  points: ScoredFormationPoint[],
  maxKm = 55,
): ScoredFormationPoint | null {
  if (!points.length) return null;
  let best: ScoredFormationPoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || bestD > maxKm) return null;
  return best;
}

/** Proč buňka v tomto prostředí zesílí (oproti teď). */
export function explainIntensifyWhy(
  nowDbz: number,
  atEnv: EnvironmentSignals,
  expectedDbz: number,
  nowEnv?: EnvironmentSignals | null,
): { headline: string; reasons: string[] } {
  const reasons: string[] = [];
  const headroom = expectedDbz - nowDbz;
  const atDew = dewpointCOr(atEnv);
  const nowDew = nowEnv ? dewpointCOr(nowEnv) : null;

  if (headroom >= 3) {
    reasons.push(
      `prostředí unese silnější echo (~${Math.round(expectedDbz)} dBZ, teď ${Math.round(nowDbz)})`,
    );
  }
  if (atEnv.capeJkg >= 200) {
    reasons.push(`vyšší energie výstupu (CAPE ~${Math.round(atEnv.capeJkg)} J/kg)`);
  }
  if (atDew >= 13) {
    reasons.push(`vlhký vzduch (rosný bod ${atDew.toFixed(0)} °C)`);
  }
  if (atEnv.shear0to6Ms >= 10) {
    reasons.push(
      `střih větru ${atEnv.shear0to6Ms.toFixed(0)} m/s — pomáhá organizovat buňku`,
    );
  }
  const li = atEnv.liftedIndexC ?? 2;
  if (li <= 0) {
    reasons.push(`nestabilní vrstva (LI ${li.toFixed(1)} °C)`);
  }
  if (nowEnv && atEnv.capeJkg >= nowEnv.capeJkg + 80) {
    reasons.push(
      `CAPE vyšší než v místě teď o ~${Math.round(atEnv.capeJkg - nowEnv.capeJkg)}`,
    );
  }
  if (nowDew != null && atDew >= nowDew + 1.5) {
    reasons.push(
      `vlhčí než teď (+${(atDew - nowDew).toFixed(1)} °C)`,
    );
  }

  if (reasons.length === 0) {
    reasons.push("lokální zlepšení podmínek podél trasy");
  }

  return {
    headline: `Zesílení kvůli lepšímu prostředí na trase — ${reasons[0]}.`,
    reasons: reasons.slice(0, 4),
  };
}

/** Proč teď není zóna zesílení — ať to není pořád stejná věta. */
export function explainNoIntensify(
  feature: RadarProgressFeature,
  intens: CellIntensification | null | undefined,
  points: ScoredFormationPoint[],
): { headline: string; reasons: string[] } {
  const reasons: string[] = [];
  const aheadEta = 30;
  const km = (feature.speedKmh * aheadEta) / 60;
  const [alon, alat] = destinationPoint(
    feature.peak[1],
    feature.peak[0],
    feature.headingDeg,
    km,
  );
  const here = nearestPoint(feature.peak[1], feature.peak[0], points);
  const ahead = nearestPoint(alat, alon, points);

  const timelinePeak =
    intens?.timeline?.length
      ? Math.max(...intens.timeline.map((t) => t.expectedDbz))
      : null;

  if (feature.maxDbz >= 52) {
    reasons.push(
      `buňka už je silná (~${Math.round(feature.maxDbz)} dBZ) — další výrazný růst prostředí neukazuje`,
    );
  }

  if (here && ahead) {
    const dCape = ahead.environment.capeJkg - here.environment.capeJkg;
    const dDew = dewpointCOr(ahead.environment) - dewpointCOr(here.environment);
    if (dCape <= -40) {
      reasons.push(
        `na trase CAPE klesá (teď ~${Math.round(here.environment.capeJkg)} → za ~${aheadEta} min ~${Math.round(ahead.environment.capeJkg)})`,
      );
    } else if (Math.abs(dCape) < 40 && Math.abs(dDew) < 1) {
      reasons.push("podél stopy je prostředí podobné jako tady — bez skoku v energii / vlhkosti");
    } else if (dDew <= -1) {
      reasons.push(
        `na trase sušší vzduch (rosný bod ${dewpointCOr(ahead.environment).toFixed(0)} °C)`,
      );
    } else if (dCape >= 40 || dDew >= 1) {
      reasons.push(
        "mírné zlepšení na trase je, ale nestačí na výraznější zónu zesílení",
      );
    }
  } else if (!points.length) {
    reasons.push("chybí modelové prostředí pro porovnání trasy");
  }

  if (
    timelinePeak != null &&
    timelinePeak <= feature.maxDbz + 1 &&
    feature.maxDbz < 52
  ) {
    reasons.push(
      `odhadovaný strop na trase ~${Math.round(timelinePeak)} dBZ (teď ${Math.round(feature.maxDbz)})`,
    );
  }

  if (reasons.length === 0) {
    reasons.push("podél stopy není výrazný nárůst CAPE / vlhkosti oproti místu teď");
  }

  let headline: string;
  if (feature.maxDbz >= 52) {
    headline = "Buňka je už silná — na trase nečekáme další výrazné zesílení.";
  } else if (here && ahead && ahead.environment.capeJkg < here.environment.capeJkg - 40) {
    headline = "Na trase podmínky spíš slábnou než rostou.";
  } else {
    headline = "Na odhadované trase teď nevidíme výraznější zónu zesílení.";
  }

  return { headline, reasons: reasons.slice(0, 4) };
}

/** Odhad poklesu dBZ/min z historie echa (záporné = slábnutí). */
function decayDbzPerMin(feature: RadarProgressFeature): number | null {
  const hist = feature.history;
  if (!hist || hist.length < 2) return null;
  const sorted = [...hist].sort(
    (a, b) => a.minutesFromBirth - b.minutesFromBirth,
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const dt = last.minutesFromBirth - first.minutesFromBirth;
  if (dt < 8) return null;
  return (last.maxDbz - first.maxDbz) / dt;
}

/** Proč buňka zanikne / zeslábne. */
export function explainDemiseWhy(
  feature: RadarProgressFeature,
  etaMin: number,
  atEnv?: EnvironmentSignals | null,
  intens?: CellIntensification | null,
): { reason: string; reasons: string[] } {
  const shear =
    feature.birthEnv?.shearMs ??
    feature.birthEnv?.environment.shear0to6Ms ??
    atEnv?.shear0to6Ms ??
    8;
  const dbz = feature.maxDbz;
  const reasons: string[] = [];
  const decayPerMin = decayDbzPerMin(feature);

  if (decayPerMin != null && decayPerMin < -0.15) {
    reasons.push(
      `echo už slábne (~${Math.abs(decayPerMin * 15).toFixed(0)} dBZ / 15 min)`,
    );
  }

  if (feature.growthDbz <= -2) {
    reasons.push("echo v posledních snímcích klesá");
  }

  if (shear < 6) {
    reasons.push(
      `slabý střih (~${shear.toFixed(0)} m/s) — buňka se rychle rozpadá`,
    );
  } else if (shear < 10) {
    reasons.push(`mírný střih (~${shear.toFixed(0)} m/s) — omezená životnost`);
  }

  if (dbz < 40) {
    reasons.push(`slabé echo (~${dbz.toFixed(0)} dBZ) bez velké rezervy`);
  }

  if (atEnv) {
    const pot = atEnv.capeJkg;
    if (pot < 100) {
      reasons.push(`slabá energie na trase (CAPE ~${Math.round(pot)} J/kg)`);
    }
    const atDew = dewpointCOr(atEnv);
    if (atDew < 11) {
      reasons.push(`sušší vzduch (rosný bod ${atDew.toFixed(0)} °C)`);
    }
    const li = atEnv.liftedIndexC ?? 0;
    if (li >= 2) {
      reasons.push(`stabilnější vzduch (LI ${li.toFixed(1)} °C)`);
    }
  }

  if (intens?.willIntensify && intens.enterEtaMin != null && etaMin > intens.enterEtaMin + 15) {
    reasons.push("po případném zesílení dojde palivo / podmínky slábnou dál po trase");
  }

  if (reasons.length === 0) {
    reasons.push(
      `typický útlum po ~${etaMin} min při síle ~${dbz.toFixed(0)} dBZ`,
    );
  }

  return {
    reason: reasons[0],
    reasons: reasons.slice(0, 4),
  };
}

/**
 * Odhad, kdy/kde buňka zeslábne pod ~30 dBZ.
 */
export function estimateDemise(
  feature: RadarProgressFeature,
  intens?: CellIntensification | null,
  points: ScoredFormationPoint[] = [],
): DemiseEstimate {
  const shear =
    feature.birthEnv?.shearMs ??
    feature.birthEnv?.environment.shear0to6Ms ??
    8;
  const dbz = feature.maxDbz;
  const decayPerMin = decayDbzPerMin(feature);
  const targetDbz = 30;

  let lifeMin: number | null = null;

  if (decayPerMin != null && decayPerMin < -0.15) {
    const toTarget = (dbz - targetDbz) / Math.abs(decayPerMin);
    lifeMin = Math.round(toTarget);
  }

  if (lifeMin == null) {
    const decayPer15 = stormConfig.intensification.decayDbzPer15Min;
    if (feature.growthDbz <= -2) {
      lifeMin = Math.round(((dbz - targetDbz) / decayPer15) * 15);
    } else if (feature.phase === "mature" || feature.phase === "moving") {
      if (dbz >= 50) lifeMin = 40;
      else if (dbz >= 45) lifeMin = 32;
      else if (dbz >= 40) lifeMin = 25;
      else lifeMin = 18;
    } else if (dbz >= 50) {
      lifeMin = 55;
    } else if (dbz >= 45) {
      lifeMin = 45;
    } else if (dbz >= 40) {
      lifeMin = 35;
    } else {
      lifeMin = 25;
    }
  }

  if (shear >= 15) lifeMin += 15;
  else if (shear >= 12) lifeMin += 10;
  else if (shear >= 8) lifeMin += 4;
  else if (shear < 6) lifeMin -= 8;

  if (feature.phase === "birth" || feature.phase === "growing") {
    lifeMin += 6;
  }

  if (intens?.timeline?.length) {
    for (const t of intens.timeline) {
      if (t.eta > 5 && t.expectedDbz < 30) {
        lifeMin = Math.min(lifeMin, t.eta);
        break;
      }
    }
  }

  if (intens?.willIntensify && intens.enterEtaMin != null) {
    const boost = Math.max(0, (intens.peakExpectedDbz ?? dbz) - dbz) * 0.8;
    lifeMin = Math.max(lifeMin, intens.enterEtaMin + 15 + boost);
  }

  lifeMin = Math.round(Math.max(10, Math.min(75, lifeMin)));

  const [lon, lat] = destinationPoint(
    feature.peak[1],
    feature.peak[0],
    feature.headingDeg,
    (feature.speedKmh * lifeMin) / 60,
  );

  const at = nearestPoint(lat, lon, points);
  const why = explainDemiseWhy(feature, lifeMin, at?.environment ?? null, intens);

  return {
    etaMin: lifeMin,
    lon,
    lat,
    reason: why.reason,
    reasons: why.reasons,
  };
}

function intensifyPoint(
  feature: RadarProgressFeature,
  intens?: CellIntensification | null,
): { at: [number, number]; eta: number } | null {
  if (!intens?.willIntensify || intens.enterEtaMin == null) return null;
  const seg = intens.segments[0];
  if (seg?.center) {
    return { at: seg.center, eta: intens.enterEtaMin };
  }
  const [lon, lat] = destinationPoint(
    feature.peak[1],
    feature.peak[0],
    feature.headingDeg,
    (feature.speedKmh * intens.enterEtaMin) / 60,
  );
  return { at: [lon, lat], eta: intens.enterEtaMin };
}

/** Jedna dokumentace: zrod → faktory → trasa → zesílení → zánik. */
export function buildStormLifecycle(
  feature: RadarProgressFeature,
  intens?: CellIntensification | null,
  points: ScoredFormationPoint[] = [],
): StormLifecycle {
  const dir = headingToCzech(feature.headingDeg);
  const place = feature.placeLabel || "neznámá oblast";
  const demise = estimateDemise(feature, intens, points);
  const env = feature.birthEnv;
  const intensPt = intensifyPoint(feature, intens);

  let intensifyWhy = intens?.whyHeadline
    ? { headline: intens.whyHeadline, reasons: intens.whyReasons ?? [] }
    : null;

  if (!intensifyWhy && intensPt && intens?.willIntensify) {
    const at = nearestPoint(intensPt.at[1], intensPt.at[0], points);
    if (at) {
      intensifyWhy = explainIntensifyWhy(
        feature.maxDbz,
        at.environment,
        intens.peakExpectedDbz,
        env?.environment,
      );
    }
  }

  const growthWhy =
    feature.growthWhy ??
    (feature.phase === "birth" || feature.phase === "growing"
      ? explainGrowthWhy(feature)
      : null);
  const severityWhy = explainSeverityWhy(feature.maxDbz, feature.severity);

  const steps: LifecycleStep[] = [
    {
      id: "birth",
      title: feature.trueBirth
        ? feature.phase === "growing"
          ? "1 · Zrod a růst"
          : "1 · Zrod"
        : "1 · Ve stopě (historie)",
      body: feature.trueBirth
        ? feature.phase === "birth"
          ? `Právě teď u ${place} (~${feature.birthDbz.toFixed(0)} dBZ).`
          : `U ${place} před ~${feature.ageMinutes} min (~${feature.birthDbz.toFixed(0)} dBZ → teď ${feature.maxDbz.toFixed(0)} dBZ).`
        : `První detekce v našem okně u ${place} už měla ~${feature.birthDbz.toFixed(0)} dBZ — to není nutně místo vzniku echa (bouřka sem mohla přijet).`,
      meta: feature.trueBirth
        ? feature.phase === "growing"
          ? `růst +${feature.growthDbz.toFixed(0)} dBZ`
          : undefined
        : "historie radaru, ne Vznik",
      reasons: growthWhy?.reasons,
      active: feature.phase === "birth" || feature.phase === "growing",
    },
    {
      id: "factors",
      title: feature.trueBirth
        ? "2 · Proč právě tady"
        : "2 · Prostředí u první detekce",
      body: env?.whyHeadline
        ?? (feature.trueBirth
          ? "V místě zrodu zatím chybí modelové prostředí."
          : "U první detekce chybí modelové prostředí — neber jako místo vzniku."),
      meta: env?.whyFactors?.[0]
        ? `${env.whyFactors[0].label}: ${env.whyFactors[0].detail}`
        : undefined,
      reasons: env?.whyFactors?.map((f) => `${f.label}: ${f.detail}`),
    },
    {
      id: "path",
      title: "3 · Trasa a síla",
      body: `Teď ${severityWhy.headline.replace(/\.$/, "")}. Směr ${dir} · ~${Math.round(feature.speedKmh)} km/h${
        feature.motionSource === "radar-track"
          ? " (radarová stopa)"
          : " (odhad z větru 850+500)"
      }.`,
      meta: `za ${demise.etaMin} min ~${Math.round((feature.speedKmh * demise.etaMin) / 60)} km dál`,
      reasons: severityWhy.reasons,
    },
  ];

  // If growing, put growth headline into birth body as clearer
  if (growthWhy && (feature.phase === "growing" || feature.phase === "birth")) {
    steps[0].body = growthWhy.headline;
    if (feature.phase === "growing") {
      steps[0].meta = `+${feature.growthDbz.toFixed(0)} dBZ · teď ${feature.maxDbz.toFixed(0)} dBZ`;
    }
  }

  if (intens?.willIntensify && intens.enterEtaMin != null) {
    steps.push({
      id: "intensify",
      title: "4 · Zesílení na cestě",
      body: intensifyWhy?.headline ?? formatIntensificationSummary(intens),
      meta:
        intens.peakExpectedDbz != null
          ? `za ~${intens.enterEtaMin} min · peak ~${Math.round(intens.peakExpectedDbz)} dBZ`
          : `za ~${intens.enterEtaMin} min`,
      reasons: intensifyWhy?.reasons,
      active: true,
    });
  } else {
    const noIntens = explainNoIntensify(feature, intens, points);
    steps.push({
      id: "intensify",
      title: "4 · Zesílení na cestě",
      body: noIntens.headline,
      reasons: noIntens.reasons,
    });
  }

  steps.push({
    id: "demise",
    title: "5 · Odhad zániku",
    body: `Zeslabení pod ~30 dBZ za ~${demise.etaMin} min.`,
    meta: demise.reason,
    reasons: demise.reasons,
  });

  const summary = feature.trueBirth
    ? feature.phase === "birth"
      ? `Nový zrod u ${place}. ${growthWhy?.headline ?? "Sledujeme růst, trasu a kde zeslábne."}`
      : feature.phase === "growing"
        ? `Roste u ${place} (+${feature.growthDbz.toFixed(0)} dBZ). ${growthWhy?.headline ?? ""}`
        : `Buňka u ${place} jde na ${dir}. Od zrodu ~${feature.ageMinutes} min · ${severityWhy.headline}`
    : `Buňka u ${place} jde na ${dir} · ~${Math.round(feature.speedKmh)} km/h. První detekce v historii ≠ zrod.`;

  return {
    title:
      feature.phase === "birth"
        ? "Životní dráha · vznik"
        : feature.phase === "growing"
          ? "Životní dráha · růst"
          : "Životní dráha · buňka",
    summary,
    steps,
    demiseAt: [demise.lon, demise.lat],
    demiseEtaMin: demise.etaMin,
    intensifyAt: intensPt?.at ?? null,
    intensifyEtaMin: intensPt?.eta ?? null,
  };
}

/** Body + trasa životní dráhy pro mapu (vybraná buňka). */
export function lifecycleMapGeoJSON(
  feature: RadarProgressFeature,
  life: StormLifecycle,
): FeatureCollection {
  const features: FeatureCollection["features"] = [];
  // Minulost = reálná historie peaků, budoucnost = peak → zánik
  const past =
    feature.history.length >= 2
      ? feature.history.map((h) => h.peak)
      : feature.trueBirth
        ? [feature.birth, feature.peak]
        : [feature.peak];
  const coords: [number, number][] = [...past];

  if (life.intensifyAt) {
    coords.push(life.intensifyAt);
    features.push({
      type: "Feature",
      properties: {
        kind: "intensify",
        label:
          life.intensifyEtaMin != null && life.intensifyEtaMin <= 0
            ? "↑ zesílení"
            : `↑ zesílení\nza ~${life.intensifyEtaMin} min`,
        reason:
          life.steps.find((s) => s.id === "intensify")?.reasons?.[0] ??
          life.steps.find((s) => s.id === "intensify")?.body ??
          "",
      },
      geometry: { type: "Point", coordinates: life.intensifyAt },
    });
  }

  if (life.demiseAt) {
    coords.push(life.demiseAt);
    features.push({
      type: "Feature",
      properties: {
        kind: "demise",
        label:
          life.demiseEtaMin != null
            ? `zánik\nza ~${life.demiseEtaMin} min`
            : "zánik",
        reason:
          life.steps.find((s) => s.id === "demise")?.reasons?.[0] ??
          life.steps.find((s) => s.id === "demise")?.meta ??
          "",
      },
      geometry: { type: "Point", coordinates: life.demiseAt },
    });
  }

  if (coords.length >= 2) {
    features.unshift({
      type: "Feature",
      properties: { kind: "path" },
      geometry: { type: "LineString", coordinates: coords },
    });
  }

  // Marker zrodu — jen skutečný zrod, ne první snímek silné bouřky
  if (feature.trueBirth) {
    features.push({
      type: "Feature",
      properties: {
        kind: "birth",
        label: "zrod",
        reason: feature.placeLabel ?? "",
      },
      geometry: { type: "Point", coordinates: feature.birth },
    });
  } else if (feature.history.length >= 2) {
    features.push({
      type: "Feature",
      properties: {
        kind: "birth",
        label: "ve stopě",
        reason: "První detekce v historii — ne nutně vznik echa",
      },
      geometry: {
        type: "Point",
        coordinates: feature.history[0].peak,
      },
    });
  }

  return { type: "FeatureCollection", features };
}
