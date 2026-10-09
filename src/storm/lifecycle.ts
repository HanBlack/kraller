import type { FeatureCollection } from "geojson";
import { t } from "../i18n";
import { destinationPoint } from "../lib/geo";
import { headingLabel } from "../lib/direction";
import { evolveDbzAt } from "../lib/stormEvolution";
import type { ScoredFormationPoint } from "./formationData";
import type { CellIntensification } from "./intensification";
import { formationEnvironmentSummary } from "./formationCopy";
import {
  meanForecastDelta,
  peakAtForecastMinutes,
  type RadarProgressFeature,
} from "./radarCells";
import type { EnvironmentSignals } from "./types";
import { dewpointCOr } from "./types";
import { distanceKm } from "../lib/geo";
import { stormConfig } from "./config";
import {
  sampleSatelliteCooling,
  satelliteWarmingRate,
  towerFallRate,
  type SatelliteCoolingGrid,
  type SatelliteSample,
} from "./satelliteCooling";

export type BuildLifecycleOpts = {
  /** Minuty od času snímku (Teď / +N) — stejné jako posun PNG a jádra. */
  forecastMinutes?: number;
  systemDelta?: { dLon: number; dLat: number };
  /** Pro výpočet systémového posunu, když systemDelta není předané. */
  allFeatures?: RadarProgressFeature[];
};

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
  /** Badge u zániku: z radaru / trend / odhad */
  badge?: string;
};

export type DemiseConfidence = "observed" | "trending" | "climatology";

export type DemiseEstimate = {
  etaMin: number;
  etaMinLo: number;
  etaMinHi: number;
  lon: number;
  lat: number;
  reason: string;
  reasons: string[];
  confidence: DemiseConfidence;
};

export type StormLifecycle = {
  title: string;
  summary: string;
  steps: LifecycleStep[];
  /** Jádro v čase forecastMinutes (souřadnice pro mapu). */
  anchorPeak: [number, number];
  /** Zobrazit zánik na mapě (skrýt při růstu + slabý odhad). */
  showDemiseOnMap: boolean;
  demiseAt: [number, number] | null;
  demiseEtaMin: number | null;
  demiseEtaMinLo: number | null;
  demiseEtaMinHi: number | null;
  demiseConfidence: DemiseConfidence | null;
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
    reasons.push(t("storm.lifecycleReasonRouteStrength"));
  }
  if (atEnv.capeJkg >= 200) {
    reasons.push(t("storm.lifecycleReasonEnergy"));
  }
  if (atDew >= 13) {
    reasons.push(t("storm.lifecycleReasonMoist", { dewpoint: atDew.toFixed(0) }));
  }
  if (atEnv.shear0to6Ms >= 10) {
    reasons.push(t("storm.lifecycleReasonShear"));
  }
  const li = atEnv.liftedIndexC ?? 2;
  if (li <= 0) {
    reasons.push(t("storm.lifecycleReasonUnstable"));
  }
  if (nowEnv && atEnv.capeJkg >= nowEnv.capeJkg + 80) {
    reasons.push(t("storm.lifecycleReasonMoreEnergy"));
  }
  if (nowDew != null && atDew >= nowDew + 1.5) {
    reasons.push(
      t("storm.lifecycleReasonMoreMoist", {
        delta: (atDew - nowDew).toFixed(1),
      }),
    );
  }

  if (reasons.length === 0) {
    reasons.push(t("storm.lifecycleReasonLocalImprovement"));
  }

  return {
    headline: t("storm.lifecycleMayIntensify", { reason: reasons[0] }),
    reasons: reasons.slice(0, 3),
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

  if (feature.severity === "strong") {
    reasons.push(t("storm.lifecycleReasonAlreadyStrong"));
  }

  if (here && ahead) {
    const dCape = ahead.environment.capeJkg - here.environment.capeJkg;
    const dDew = dewpointCOr(ahead.environment) - dewpointCOr(here.environment);
    if (dCape <= -40) {
      reasons.push(t("storm.lifecycleReasonEnergyFalling"));
    } else if (Math.abs(dCape) < 40 && Math.abs(dDew) < 1) {
      reasons.push(t("storm.lifecycleReasonEnvironmentSimilar"));
    } else if (dDew <= -1) {
      reasons.push(
        t("storm.lifecycleReasonDrierAhead", {
          dewpoint: dewpointCOr(ahead.environment).toFixed(0),
        }),
      );
    } else if (dCape >= 40 || dDew >= 1) {
      reasons.push(t("storm.lifecycleReasonSlightImprovement"));
    }
  } else if (!points.length) {
    reasons.push(t("storm.lifecycleReasonNoEnvironment"));
  }

  if (
    timelinePeak != null &&
    timelinePeak <= feature.maxDbz + 1 &&
    feature.severity !== "strong"
  ) {
    reasons.push(t("storm.lifecycleReasonStrengthCeiling"));
  }

  if (reasons.length === 0) {
    reasons.push(t("storm.lifecycleReasonNoIntensification"));
  }

  let headline: string;
  if (feature.severity === "strong") {
    headline = t("storm.lifecycleNoIntensificationStrong");
  } else if (here && ahead && ahead.environment.capeJkg < here.environment.capeJkg - 40) {
    headline = t("storm.lifecycleNoIntensificationFalling");
  } else {
    headline = t("storm.lifecycleNoIntensification");
  }

  return { headline, reasons: reasons.slice(0, 3) };
}

/** Odhad poklesu dBZ/min z posledního segmentu historie (ne celého života). */
function recentDecayDbzPerMin(feature: RadarProgressFeature): number | null {
  const hist = feature.history;
  if (!hist || hist.length < 2) return null;
  const prev = hist[hist.length - 2];
  const last = hist[hist.length - 1];
  const dt = last.minutesFromBirth - prev.minutesFromBirth;
  if (dt < 4) return null;
  return (last.maxDbz - prev.maxDbz) / dt;
}

/** Odhad poklesu dBZ/min z historie echa (záporné = slábnutí) — celé okno. */
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
  satAtPeak?: SatelliteSample | null,
): { reason: string; reasons: string[] } {
  const shear =
    feature.birthEnv?.shearMs ??
    feature.birthEnv?.environment.shear0to6Ms ??
    atEnv?.shear0to6Ms ??
    8;
  const dbz = feature.maxDbz;
  const reasons: string[] = [];
  const decayPerMin = decayDbzPerMin(feature);
  const recentDecay = recentDecayDbzPerMin(feature);
  const peakSat = satAtPeak ?? feature.satAtPeak ?? null;
  const willIntensify =
    intens?.willIntensify === true && intens.enterEtaMin != null;

  // Jedna narace: při aktivním zesílení neříkat „už slábne“ / „rychle se rozpadá“
  if (!willIntensify) {
    if (peakSat?.towerFalling && towerFallRate(peakSat.cloudTopHeightDeltaMPer15min) >= stormConfig.satellite.towerFallingMPer15min) {
      reasons.push(t("storm.lifecycleReasonCloudTopFalling"));
    } else if (peakSat?.trend === "warming" && satelliteWarmingRate(peakSat.cloudTopCoolingCPer15min) >= 1.5) {
      reasons.push(t("storm.lifecycleReasonCloudTopWarming"));
    }

    if (recentDecay != null && recentDecay < -0.2) {
      reasons.push(t("storm.lifecycleReasonRadarWeakening"));
    } else if (decayPerMin != null && decayPerMin < -0.15) {
      reasons.push(t("storm.lifecycleReasonHistoryWeakening"));
    }

    if (feature.growthDbz <= -2) {
      reasons.push(t("storm.lifecycleReasonRecentWeakening"));
    }

    if (shear < 6) {
      reasons.push(t("storm.lifecycleReasonLittleShear"));
    } else if (shear < 10) {
      reasons.push(t("storm.lifecycleReasonModerateShear"));
    }

    if (dbz < 40) {
      reasons.push(t("storm.lifecycleReasonWeakEcho"));
    }
  } else {
    reasons.push(
      t("storm.lifecycleReasonWeakeningAfterIntensify", {
        min: intens!.enterEtaMin ?? 0,
      }),
    );
  }

  if (atEnv && !willIntensify) {
    const pot = atEnv.capeJkg;
    if (pot < 100) {
      reasons.push(t("storm.lifecycleReasonLowEnergy"));
    }
    const atDew = dewpointCOr(atEnv);
    if (atDew < 11) {
      reasons.push(t("storm.lifecycleReasonDrier", { dewpoint: atDew.toFixed(0) }));
    }
    const li = atEnv.liftedIndexC ?? 0;
    if (li >= 2) {
      reasons.push(t("storm.lifecycleReasonStableAir"));
    }
  }

  if (
    !willIntensify &&
    (peakSat?.trend === "growing" ||
      peakSat?.trend === "growing_long" ||
      peakSat?.towerRising)
  ) {
    if (!reasons.some((r) => r.includes("satelit"))) {
      reasons.push(t("storm.lifecycleReasonCloudTopGrowing"));
    }
  }

  if (reasons.length === 0) {
    reasons.push(t("storm.lifecycleReasonTypicalLifetime", { min: etaMin }));
  }

  return {
    reason: reasons[0],
    reasons: reasons.slice(0, 4),
  };
}

/**
 * Odhad, kdy/kde buňka zeslábne pod ~30 dBZ.
 * Confidence odděluje fakt (slábne na radaru) od klimatologického tipu.
 */
export function estimateDemise(
  feature: RadarProgressFeature,
  intens?: CellIntensification | null,
  points: ScoredFormationPoint[] = [],
  opts?: { predictedDbz15?: number; satAtPeak?: SatelliteSample | null },
): DemiseEstimate {
  const peakSat = opts?.satAtPeak ?? feature.satAtPeak ?? null;
  const shear =
    feature.birthEnv?.shearMs ??
    feature.birthEnv?.environment.shear0to6Ms ??
    8;
  const dbz = feature.maxDbz;
  const recentDecay = recentDecayDbzPerMin(feature);
  const longDecay = decayDbzPerMin(feature);
  const targetDbz = 30;
  const predictedDbz15 = opts?.predictedDbz15 ?? dbz;
  const growingForecast = predictedDbz15 > dbz + 1.5;
  const growingPhase =
    feature.phase === "birth" ||
    feature.phase === "growing" ||
    feature.growthDbz > 0;

  let lifeMin: number | null = null;
  let confidence: DemiseConfidence = "climatology";

  if (recentDecay != null && recentDecay < -0.2) {
    const toTarget = (dbz - targetDbz) / Math.abs(recentDecay);
    lifeMin = Math.round(toTarget);
    confidence =
      growingForecast && recentDecay > -0.45 ? "trending" : "observed";
  } else if (
    longDecay != null &&
    longDecay < -0.15 &&
    (recentDecay == null || recentDecay < -0.1)
  ) {
    const toTarget = (dbz - targetDbz) / Math.abs(longDecay);
    lifeMin = Math.round(toTarget);
    confidence = "observed";
  }

  if (lifeMin == null) {
    const decayPer15 = stormConfig.intensification.decayDbzPer15Min;
    if (
      feature.growthDbz <= -2 &&
      (recentDecay == null || recentDecay < -0.12)
    ) {
      lifeMin = Math.round(((dbz - targetDbz) / decayPer15) * 15);
      confidence = "trending";
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
    // Zesílení vyhrálo naraci — ne „observed slábne“ zároveň
    if (confidence === "observed" || confidence === "trending") {
      confidence = "climatology";
    }
  }

  if (peakSat?.trend === "warming" || peakSat?.towerFalling) {
    lifeMin = Math.round(lifeMin * 0.75);
    if (confidence === "climatology") confidence = "trending";
  } else if (
    peakSat?.trend === "growing" ||
    peakSat?.towerRising ||
    peakSat?.coldTop
  ) {
    lifeMin = Math.round(lifeMin * 1.2);
  }

  // Růst / pozitivní vývoj PNG → ne tvrdit brzký zánik (kromě měřeného rozpadu)
  if (
    (growingForecast || growingPhase) &&
    confidence !== "observed"
  ) {
    confidence = "climatology";
    lifeMin = Math.max(lifeMin, growingPhase ? 28 : 22);
    if (intens?.willIntensify) {
      lifeMin = Math.max(lifeMin, (intens.enterEtaMin ?? 15) + 25);
    }
  }

  lifeMin = Math.round(Math.max(10, Math.min(75, lifeMin)));

  // ±30 % rozsah — climatology širší (±40 %)
  const spread =
    confidence === "observed" ? 0.25 : confidence === "trending" ? 0.3 : 0.4;
  const etaMinLo = Math.round(Math.max(8, lifeMin * (1 - spread)));
  const etaMinHi = Math.round(Math.min(90, lifeMin * (1 + spread)));

  const [lon, lat] = destinationPoint(
    feature.peak[1],
    feature.peak[0],
    feature.headingDeg,
    (feature.speedKmh * lifeMin) / 60,
  );

  const at = nearestPoint(lat, lon, points);
  const why = explainDemiseWhy(
    feature,
    lifeMin,
    at?.environment ?? null,
    intens,
    peakSat,
  );

  const reasons = why.reasons.slice(0, 4);

  return {
    etaMin: lifeMin,
    etaMinLo,
    etaMinHi,
    lon,
    lat,
    reason: reasons[0] ?? why.reason,
    reasons,
    confidence,
  };
}

function demiseBodyCopy(
  demise: DemiseEstimate,
  growingForecast: boolean,
  willIntensify: boolean,
): string {
  const range = `~${demise.etaMinLo}–${demise.etaMinHi} min`;
  // Jedna pravda: při zesílení neríkat „už slábne“
  if (willIntensify) {
    return t("storm.lifecycleDemiseAfterIntensify", { range });
  }
  if (demise.confidence === "observed") {
    return t("storm.lifecycleDemiseObserved", { range });
  }
  if (demise.confidence === "trending") {
    return t("storm.lifecycleDemiseTrend", { range });
  }
  if (growingForecast) {
    return t("storm.lifecycleDemiseGrowing", { range });
  }
  return t("storm.lifecycleDemiseEstimate", { range });
}

function demiseBadge(confidence: DemiseConfidence): string {
  if (confidence === "observed") return t("storm.lifecycleObserved");
  if (confidence === "trending") return t("storm.lifecycleTrend");
  return t("storm.lifecycleEstimate");
}

/** Vyhodí důvody, které jen opakují body / sebe navzájem. */
function uniqueReasons(
  reasons: string[] | undefined,
  body: string,
): string[] | undefined {
  if (!reasons?.length) return undefined;
  const bodyNorm = body.toLowerCase();
  const out: string[] = [];
  for (const r of reasons) {
    const n = r.toLowerCase().replace(/\.$/, "");
    if (!n) continue;
    if (bodyNorm.includes(n) || n.includes(bodyNorm.replace(/\.$/, ""))) continue;
    if (out.some((o) => o.toLowerCase() === n || o.toLowerCase().includes(n) || n.includes(o.toLowerCase()))) {
      continue;
    }
    out.push(r);
  }
  return out.length ? out : undefined;
}

function intensifyPoint(
  feature: RadarProgressFeature,
  intens?: CellIntensification | null,
  anchorPeak?: [number, number],
): { at: [number, number]; eta: number } | null {
  if (!intens?.willIntensify || intens.enterEtaMin == null) return null;
  const seg = intens.segments[0];
  if (seg?.center) {
    return { at: seg.center, eta: intens.enterEtaMin };
  }
  const peak = anchorPeak ?? feature.peak;
  const [lon, lat] = destinationPoint(
    peak[1],
    peak[0],
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
  opts: BuildLifecycleOpts = {},
  satelliteGrid?: SatelliteCoolingGrid | null,
): StormLifecycle {
  const forecastMinutes = opts.forecastMinutes ?? 0;
  const systemDelta =
    opts.systemDelta ??
    (opts.allFeatures?.length
      ? meanForecastDelta(opts.allFeatures, forecastMinutes)
      : { dLon: 0, dLat: 0 });
  const anchorPeak = peakAtForecastMinutes(
    feature,
    forecastMinutes,
    systemDelta,
    "raster",
  );
  const anchorFeature: RadarProgressFeature = { ...feature, peak: anchorPeak };
  const predictedDbz15 = evolveDbzAt(
    feature,
    intens ?? undefined,
    forecastMinutes + 15,
  );
  const growingForecast = predictedDbz15 > feature.maxDbz + 1.5;

  const dir = headingLabel(feature.headingDeg);
  const place = feature.placeLabel || t("storm.lifecycleUnknownArea");
  const satAtAnchor =
    feature.satAtPeak ??
    sampleSatelliteCooling(satelliteGrid, anchorPeak[1], anchorPeak[0]);
  const demise = estimateDemise(anchorFeature, intens, points, {
    predictedDbz15,
    satAtPeak: satAtAnchor,
  });
  const env = feature.birthEnv;
  const intensPt = intensifyPoint(feature, intens, anchorPeak);

  const birthBody = feature.trueBirth
    ? feature.phase === "birth"
      ? t("storm.lifecycleBirthNow", { place })
      : t("storm.lifecycleBirthAgo", {
          place,
          min: feature.ageMinutes,
        })
    : t("storm.lifecycleFirstDetection", { place });

  const factorsBody =
    (env?.environment
      ? formationEnvironmentSummary(env.environment)
      : null) ??
    (feature.trueBirth
      ? t("storm.lifecycleNoEnvironmentBirth")
      : t("storm.lifecycleNoEnvironmentDetection"));

  const steps: LifecycleStep[] = [
    {
      id: "birth",
      title: feature.trueBirth
        ? feature.phase === "growing"
          ? `1 · ${t("storm.lifecycleTitleGrowing")}`
          : `1 · ${t("storm.birth")}`
        : `1 · ${t("storm.firstDetection")}`,
      body: birthBody,
      meta: feature.trueBirth
        ? feature.phase === "growing"
          ? t("storm.lifecycleGrowing")
          : undefined
        : undefined,
      active: feature.phase === "birth" || feature.phase === "growing",
    },
    {
      id: "factors",
      title: `2 · ${t("storm.lifecycleFactors")}`,
      body: factorsBody,
    },
    {
      id: "path",
      title: `3 · ${t("storm.lifecyclePath")}`,
      body: t("storm.lifecyclePathSummary", {
        dir,
        speed: Math.round(feature.speedKmh),
        source: t(
          feature.motionSource === "radar-track"
            ? "storm.lifecyclePathRadar"
            : "storm.lifecyclePathWind",
        ),
        lo: demise.etaMinLo,
        hi: demise.etaMinHi,
        distance: Math.round((feature.speedKmh * demise.etaMin) / 60),
      }),
      reasons: feature.fctDisagree
        ? [t("storm.lifecycleTrackDisagreement")]
        : undefined,
    },
  ];

  if (feature.phase === "growing") {
    steps[0].body = t("storm.lifecycleGrowthAt", {
      place,
      min: feature.ageMinutes,
    });
  }

  if (intens?.willIntensify && intens.enterEtaMin != null) {
    steps.push({
      id: "intensify",
      title: `4 · ${t("storm.lifecycleIntensify")}`,
      body: t("storm.lifecycleIntensifyEta", {
        min: intens.enterEtaMin,
      }),
      meta:
        intens.enterEtaMin != null
          ? t("storm.lifecycleEta", { min: intens.enterEtaMin })
          : undefined,
      active: true,
    });
  } else {
    const noIntens = explainNoIntensify(feature, intens, points);
    steps.push({
      id: "intensify",
      title: `4 · ${t("storm.lifecycleIntensify")}`,
      body: noIntens.headline,
      reasons: undefined,
    });
  }

  const willIntensify =
    intens?.willIntensify === true && intens.enterEtaMin != null;

  steps.push({
    id: "demise",
    title: `5 · ${t("storm.lifecycleDemise")}`,
    body: demiseBodyCopy(demise, growingForecast, willIntensify),
    meta: undefined,
    reasons: uniqueReasons(demise.reasons, demiseBodyCopy(demise, growingForecast, willIntensify)),
    badge: willIntensify
      ? t("storm.lifecycleAfterIntensify")
      : demiseBadge(demise.confidence),
  });

  // Mapa: jedna narace — při zesílení nekreslit zánik (konflikt ↑ vs útlum)
  const showDemiseOnMap = willIntensify
    ? false
    : demise.confidence === "observed" ||
      demise.confidence === "trending" ||
      !growingForecast;

  const summary =
    feature.trueBirth && feature.phase === "birth"
      ? t("storm.lifecycleSummaryBirth", { place })
      : feature.trueBirth && feature.phase === "growing"
        ? t("storm.lifecycleSummaryGrowing", { place })
        : t("storm.lifecycleSummaryCell", {
            place,
            dir,
            speed: Math.round(feature.speedKmh),
          });

  return {
    title:
      feature.phase === "birth"
        ? t("storm.lifecycleTitleBirth")
        : feature.phase === "growing"
          ? t("storm.lifecycleTitleGrowing")
          : t("storm.lifecycleTitle"),
    summary,
    steps,
    anchorPeak,
    showDemiseOnMap,
    demiseAt: [demise.lon, demise.lat],
    demiseEtaMin: demise.etaMin,
    demiseEtaMinLo: demise.etaMinLo,
    demiseEtaMinHi: demise.etaMinHi,
    demiseConfidence: demise.confidence,
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
  const anchor = life.anchorPeak;

  // Minulost = historie peaků (bez duplicity s aktuálním jádrem)
  let past: [number, number][] = [];
  if (feature.history.length >= 2) {
    past = feature.history.slice(0, -1).map((h) => h.peak);
  } else if (feature.trueBirth) {
    past = [feature.birth];
  } else if (feature.history.length === 1) {
    past = [feature.history[0].peak];
  }

  const coords: [number, number][] = [...past, anchor];

  if (life.intensifyAt) {
    coords.push(life.intensifyAt);
    const eta = life.intensifyEtaMin;
    features.push({
      type: "Feature",
      properties: {
        kind: "intensify",
        label:
          eta != null && eta <= 0
            ? "↑ může zesílit"
            : `↑ může zesílit\nza ~${eta} min`,
        reason:
          life.steps.find((s) => s.id === "intensify")?.reasons?.[0] ??
          life.steps.find((s) => s.id === "intensify")?.body ??
          "",
      },
      geometry: { type: "Point", coordinates: life.intensifyAt },
    });
  }

  if (life.demiseAt && life.showDemiseOnMap) {
    coords.push(life.demiseAt);
    const lo = life.demiseEtaMinLo ?? life.demiseEtaMin;
    const hi = life.demiseEtaMinHi ?? life.demiseEtaMin;
    const growing =
      life.steps.find((s) => s.id === "demise")?.body?.includes("posílit") ??
      false;
    features.push({
      type: "Feature",
      properties: {
        kind: "demise",
        confidence: life.demiseConfidence ?? "climatology",
        label:
          lo != null && hi != null
            ? growing
              ? `útlum\nza ~${lo}–${hi} min`
              : `útlum\nza ~${lo}–${hi} min`
            : "útlum",
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
        label: "1. detekce",
        reason: feature.placeLabel ?? "",
      },
      geometry: {
        type: "Point",
        coordinates: feature.history[0].peak,
      },
    });
  }

  return { type: "FeatureCollection", features };
}
