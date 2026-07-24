import { describe, expect, it } from "vitest";
import { forecastFormation } from "./formationForecast";
import type { EnvironmentSignals, FormationAssessment } from "./types";

function env(partial: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return {
    capeJkg: 400,
    capeNowJkg: 280,
    dewpointC: 14,
    shear0to6Ms: 14,
    srh01: 40,
    cloudTopCoolingCPer15min: 0,
    liftedIndexC: -1,
    ...partial,
  };
}

function assessment(score = 42): FormationAssessment {
  return {
    kind: "formation",
    score,
    severity: score >= 65 ? "strong" : score >= 38 ? "moderate" : "weak",
    reasons: [],
    hazards: { hail: 20, supercell: 10, tornado: 5 },
  };
}

describe("forecastFormation — satellite timing", () => {
  it("live sat cooling pulls initiation earlier than model proxy", () => {
    const base = forecastFormation(
      49.3,
      18.1,
      env({ cloudTopCoolingCPer15min: -3, coolingSource: "model" }),
      assessment(45),
      null,
      null,
    );
    const sat = forecastFormation(
      49.3,
      18.1,
      env({
        cloudTopCoolingCPer15min: -3,
        coolingSource: "satellite",
        cloudTopTempC: -40,
        cloudTopHeightDeltaMPer15min: 2000,
      }),
      assessment(45),
      null,
      null,
    );
    expect(sat.initEtaMin).toBeLessThan(base.initEtaMin);
    expect(sat.initEtaMax).toBeLessThanOrEqual(base.initEtaMax);
    expect(sat.expectedMaxDbz).toBeGreaterThan(base.expectedMaxDbz);
  });

  it("sat warming delays initiation vs quiet sat", () => {
    const quiet = forecastFormation(
      49.3,
      18.1,
      env({
        cloudTopCoolingCPer15min: -0.2,
        coolingSource: "satellite",
      }),
      assessment(40),
      null,
      null,
    );
    const warm = forecastFormation(
      49.3,
      18.1,
      env({
        cloudTopCoolingCPer15min: 3,
        coolingSource: "satellite",
      }),
      assessment(40),
      null,
      null,
    );
    expect(warm.initEtaMin).toBeGreaterThan(quiet.initEtaMin);
  });
});
