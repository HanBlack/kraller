import { stormConfig } from "./config";
import type {
  EnvironmentSignals,
  FormationAssessment,
  HazardScores,
} from "./types";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function ramp(value: number, lo: number, hi: number) {
  if (hi <= lo) return value >= hi ? 1 : 0;
  return clamp01((value - lo) / (hi - lo));
}

function severityFromScore(score: number): FormationAssessment["severity"] {
  if (score >= 65) return "strong";
  if (score >= 38) return "moderate";
  return "weak";
}

/**
 * Skóre vzniku bouřky z prostředí.
 * Neříká kam to půjde — jen jestli a jak silně se to může zrodit.
 */
export function scoreFormation(
  env: EnvironmentSignals,
): FormationAssessment {
  const cfg = stormConfig.formation;
  const reasons: string[] = [];

  const capeN = ramp(env.capeJkg, cfg.cape.weak, cfg.cape.extreme);
  const dewN = ramp(
    env.dewpointC ?? -40,
    cfg.dewpointC.weak,
    cfg.dewpointC.strong,
  );
  const shearN = ramp(
    env.shear0to6Ms,
    cfg.shear0to6Ms.multicell,
    cfg.shear0to6Ms.supercell,
  );
  const cooling = Math.max(0, -env.cloudTopCoolingCPer15min);
  const satN = ramp(
    cooling,
    cfg.cloudTopCoolingCPer15min.growing,
    cfg.cloudTopCoolingCPer15min.rapid,
  );
  const instabilityN =
    (env.liftedIndexC ?? 0) < 0
      ? ramp(-(env.liftedIndexC ?? 0), 0, 5)
      : 0;
  const growthN = Math.max(satN, instabilityN);
  const srhN = ramp(
    env.srh01,
    cfg.srh01.elevated,
    cfg.srh01.extreme,
  );

  if (env.capeJkg >= cfg.cape.strong) {
    reasons.push(`CAPE ${Math.round(env.capeJkg)} J/kg`);
  }
  if ((env.dewpointC ?? -40) >= cfg.dewpointC.moderate) {
    reasons.push(`rosný bod ${(env.dewpointC ?? 0).toFixed(1)} °C`);
  }
  if (env.shear0to6Ms >= cfg.shear0to6Ms.organized) {
    reasons.push(`shear ${env.shear0to6Ms.toFixed(0)} m/s`);
  }
  if (cooling >= cfg.cloudTopCoolingCPer15min.growing) {
    reasons.push(`rostoucí nestabilita (model)`);
  }
  if ((env.liftedIndexC ?? 0) <= -1) {
    reasons.push(`lifted index ${(env.liftedIndexC ?? 0).toFixed(1)} °C`);
  }

  const cinMag =
    env.convectiveInhibitionJkg != null
      ? Math.abs(env.convectiveInhibitionJkg)
      : 0;
  const cinPenalty = cinMag >= 40 ? clamp01((cinMag - 40) / 160) : 0;

  const w = cfg.weights;
  const srhWeight = 0.12;
  const wSum = w.cape + w.dewpoint + w.shear + w.satelliteGrowth + srhWeight;
  let overall =
    ((capeN * w.cape +
      dewN * w.dewpoint +
      shearN * w.shear +
      growthN * w.satelliteGrowth +
      srhN * srhWeight) /
      wSum) *
    100;

  // Jen reálná nestabilita — ne umělý boost z vlhkosti při CAPE≈0
  if (env.capeJkg >= 40 && (env.liftedIndexC ?? 99) <= 0) {
    overall = Math.max(overall, 18 + capeN * 8 + dewN * 6);
  }

  // Silný záklop (CIN) snižuje šanci vzniku — upřímněji „proč zatím nic“
  if (cinPenalty > 0) {
    overall *= 1 - cinPenalty * 0.4;
    reasons.push(`CIN ~${Math.round(cinMag)} J/kg (záklop)`);
  }

  const supercell =
    env.capeJkg >= cfg.cape.weak
      ? clamp01(capeN * 0.45 + shearN * 0.55) * 100
      : 0;

  const canSevere = env.capeJkg >= cfg.tornadoMinCapeJkg;
  const tornado = canSevere
    ? clamp01(capeN * 0.5 + shearN * 0.3 + srhN * 0.2) * 100
    : 0;

  const hail = canSevere
    ? clamp01(capeN * 0.5 + satN * 0.3 + shearN * 0.2) * 100
    : clamp01(shearN * 0.15 + dewN * 0.1) * 100;
  const rain = clamp01(dewN * 0.55 + capeN * 0.45) * 100;

  const hazards: HazardScores = {
    overall,
    hail,
    rain,
    supercell,
    tornado,
  };

  return {
    kind: "formation",
    score: Math.round(overall),
    severity: severityFromScore(overall),
    hazards,
    reasons,
  };
}

export function shouldAlertFormation(a: FormationAssessment): boolean {
  return a.score >= stormConfig.formation.alertScoreMin;
}

/**
 * Má smysl kreslit zónu Vznik? Ne jen vlhký vzduch / shear bez energie.
 * Prevence falešných kruhů (např. Beskydy při CAPE=0).
 */
export function isViableFormationEnv(env: EnvironmentSignals): boolean {
  const cape = env.capeJkg ?? 0;
  const dew = env.dewpointC ?? -40;
  const li = env.liftedIndexC ?? 99;
  const cinMag =
    env.convectiveInhibitionJkg != null
      ? Math.abs(env.convectiveInhibitionJkg)
      : 0;
  if (dew < 11) return false;
  if (cape < 25) return false;
  // Silný záklop + málo energie → zatím nevykreslovat zónu vzniku
  if (cinMag >= 120 && cape < 250) return false;
  if (cape >= 100) return true;
  if (cape >= 50 && li <= 1) return true;
  if (cape >= 40 && li <= 0 && dew >= 13) return true;
  if (cape >= 25 && li <= -1 && dew >= 14) return true;
  return false;
}
