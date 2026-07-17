import { describe, expect, it } from "vitest";
import {
  czechRegionLabel,
  pathReachesCzechia,
} from "../lib/czechRegion";
import { forecastFormation } from "./formationForecast";
import {
  isViableFormationEnv,
  scoreFormation,
} from "./scoreFormation";
import type { EnvironmentSignals, FormationAssessment } from "./types";

function env(partial: Partial<EnvironmentSignals>): EnvironmentSignals {
  return {
    capeJkg: 0,
    dewpointC: 12,
    shear0to6Ms: 5,
    srh01: 20,
    cloudTopCoolingCPer15min: 0,
    liftedIndexC: 2,
    ...partial,
  };
}

describe("formation viability — Beskydy CAPE=0 case", () => {
  it("vlhký vzduch bez CAPE NENÍ zóna vzniku", () => {
    expect(
      isViableFormationEnv(
        env({ capeJkg: 0, dewpointC: 15.1, shear0to6Ms: 3, liftedIndexC: 1.9 }),
      ),
    ).toBe(false);
  });

  it("CAPE 120 + LI 0 JE kandidát", () => {
    expect(
      isViableFormationEnv(
        env({ capeJkg: 120, dewpointC: 14, liftedIndexC: 0 }),
      ),
    ).toBe(true);
  });

  it("skóre bez CAPE nesmí umělým boostem dojít na práh zóny", () => {
    const a = scoreFormation(
      env({ capeJkg: 0, dewpointC: 15, shear0to6Ms: 4, liftedIndexC: 2 }),
    );
    expect(a.score).toBeLessThan(30);
  });
});

describe("czechRegionLabel", () => {
  it("Beskydy jen v reálném bboxu", () => {
    expect(czechRegionLabel(49.5, 18.4)).toBe("Beskydy");
    expect(czechRegionLabel(50.4, 16.5)).not.toBe("Beskydy");
    expect(czechRegionLabel(50.25, 19.0)).not.toBe("Beskydy");
  });

  it("Vídeň / Dolní Rakousko NENÍ jižní Čechy / Morava", () => {
    // ~jižně od Vídně (screenshot)
    expect(czechRegionLabel(48.05, 16.35)).toMatch(/Vídn|Rakousko/);
    expect(czechRegionLabel(48.05, 16.35)).not.toMatch(/Čech|Morava/);
    expect(czechRegionLabel(48.2, 16.4)).toMatch(/Vídn|Rakousko/);
  });

  it("jižní Morava jen v ČR", () => {
    expect(czechRegionLabel(48.8, 16.6)).toBe("jižní Morava");
  });
});

describe("pathReachesCzechia", () => {
  it("Vídeň na východ do ČR nedojede", () => {
    expect(pathReachesCzechia(48.05, 16.35, 90, 40, 90)).toBe(false);
  });

  it("Vídeň na sever může dorazit", () => {
    expect(pathReachesCzechia(48.2, 16.4, 10, 45, 90)).toBe(true);
  });

  it("bod v ČR je relevantní", () => {
    expect(pathReachesCzechia(49.2, 16.6, 90, 30, 90)).toBe(true);
  });
});

describe("formation timing — capeNow vs peak", () => {
  const assessment: FormationAssessment = {
    kind: "formation",
    score: 48,
    severity: "moderate",
    hazards: { overall: 48, hail: 20, rain: 40, supercell: 30, tornado: 0 },
    reasons: [],
  };

  it("ráno peak CAPE neříká vznik za 15 min", () => {
    const f = forecastFormation(
      49.2,
      16.6,
      env({ capeJkg: 900, capeNowJkg: 0, dewpointC: 16, shear0to6Ms: 10 }),
      assessment,
      null,
      null,
    );
    expect(f.initEtaMin).toBeGreaterThanOrEqual(35);
  });

  it("vysoké CAPE teď zkrátí okno", () => {
    const f = forecastFormation(
      49.2,
      16.6,
      env({ capeJkg: 900, capeNowJkg: 700, dewpointC: 17, shear0to6Ms: 12, liftedIndexC: -2 }),
      assessment,
      null,
      null,
    );
    expect(f.initEtaMax).toBeLessThan(90);
    expect(f.initEtaMin).toBeLessThan(40);
  });
});
