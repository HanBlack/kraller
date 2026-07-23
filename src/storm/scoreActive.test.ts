import { describe, expect, it } from "vitest";
import {
  estimateHailCm,
  scoreActiveStorm,
  shouldAlertActive,
} from "./scoreActive";
import type { EnvironmentSignals, RadarCellSignals } from "./types";

function cell(partial: Partial<RadarCellSignals>): RadarCellSignals {
  return {
    id: "x",
    lat: 49.3,
    lon: 18.0,
    maxDbz: 55,
    echoTopKm: 10,
    speedKmh: 40,
    headingDeg: 45,
    distanceToUserKm: 30,
    approachAngleDeg: 5,
    fromPlace: "test",
    ...partial,
  };
}

function env(partial: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return {
    capeJkg: 800,
    capeNowJkg: 600,
    dewpointC: 16,
    shear0to6Ms: 20,
    srh01: 120,
    cloudTopCoolingCPer15min: -1,
    liftedIndexC: -3,
    freezingLevelM: 3200,
    convectiveInhibitionJkg: -20,
    ...partial,
  };
}

describe("scoreActiveStorm — zásah u adresy", () => {
  it("přímý zásah: severity strong + rain z peak dBZ + hitType core", () => {
    const a = scoreActiveStorm(
      cell({
        maxDbz: 58,
        distanceToUserKm: 25,
        approachAngleDeg: 2,
      }),
    );
    expect(a.hitType).toBe("core");
    expect(a.atUserDbz).toBe(58);
    expect(a.severity).toBe("strong");
    expect(a.rainMmPerHour).not.toBeNull();
    expect(a.rainMmPerHour![1]).toBeGreaterThanOrEqual(40);
    expect(a.reasons.some((r) => r.includes("core"))).toBe(true);
  });

  it("okraj: nižší severity/déšť než peak (víkend: jádro minulo)", () => {
    const core = scoreActiveStorm(
      cell({ maxDbz: 58, distanceToUserKm: 25, approachAngleDeg: 2 }),
    );
    const fringe = scoreActiveStorm(
      cell({ maxDbz: 58, distanceToUserKm: 35, approachAngleDeg: 18 }),
    );
    expect(fringe.hitType).toBe("fringe");
    expect(fringe.atUserDbz!).toBeLessThan(core.atUserDbz!);
    expect(fringe.rainMmPerHour![1]).toBeLessThan(core.rainMmPerHour![1]);
  });

  it("ETA null když bouřka nejede k uživateli", () => {
    const a = scoreActiveStorm(
      cell({
        distanceToUserKm: 60,
        approachAngleDeg: 100,
        speedKmh: 35,
      }),
    );
    expect(a.etaMinutes).toBeNull();
    expect(shouldAlertActive(a)).toBe(false);
  });

  it("blízko (≤15 km) má ETA i při horším approach", () => {
    const a = scoreActiveStorm(
      cell({
        distanceToUserKm: 10,
        approachAngleDeg: 50,
        speedKmh: 30,
      }),
    );
    expect(a.etaMinutes).not.toBeNull();
    expect(a.etaMinutes!).toBeLessThanOrEqual(75);
  });

  it("odcházející blízko (≤15 km) → ETA null, bez alertu", () => {
    const a = scoreActiveStorm(
      cell({
        maxDbz: 55,
        distanceToUserKm: 10,
        approachAngleDeg: 110,
        speedKmh: 35,
      }),
    );
    expect(a.etaMinutes).toBeNull();
    expect(shouldAlertActive(a)).toBe(false);
  });

  it("miss: severity podle jádra, bez rain u adresy", () => {
    const a = scoreActiveStorm(
      cell({
        maxDbz: 58,
        distanceToUserKm: 55,
        approachAngleDeg: 35,
        speedKmh: 40,
      }),
    );
    expect(a.hitType).toBe("miss");
    expect(a.atUserDbz).toBeNull();
    expect(a.severity).toBe("strong");
    expect(a.rainMmPerHour).toBeNull();
  });

  it("shouldAlertActive vyžaduje ETA v horizontu", () => {
    const a = scoreActiveStorm(
      cell({
        maxDbz: 50,
        distanceToUserKm: 20,
        approachAngleDeg: 8,
        speedKmh: 45,
      }),
    );
    expect(a.etaMinutes).not.toBeNull();
    expect(shouldAlertActive(a)).toBe(true);
  });
});

describe("estimateHailCm — Waldvogel / FZL", () => {
  it("bez FZL: silné echo + vysoký top → kroupy", () => {
    expect(estimateHailCm(12, 58)).toBe(2);
  });

  it("s FZL: echo málo nad nulovou izotermou → žádné kroupy", () => {
    // echo 11 km, FZL 10 km → excess 1 km < 1.5
    expect(estimateHailCm(11, 60, 10_000)).toBeNull();
  });

  it("s FZL: dostatečná hloubka nad FZL → kroupy", () => {
    // echo 12 km, FZL 3.2 km → excess 8.8 km
    expect(estimateHailCm(12, 58, 3200)).toBeGreaterThanOrEqual(2);
  });

  it("slabé echo → null i s vysokým topem", () => {
    expect(estimateHailCm(14, 48, 3000)).toBeNull();
  });

  it("scoreActiveStorm předá FZL z env", () => {
    const withLid = scoreActiveStorm(
      cell({ maxDbz: 58, echoTopKm: 11 }),
      env({ freezingLevelM: 10_000 }),
    );
    const deep = scoreActiveStorm(
      cell({ maxDbz: 58, echoTopKm: 12 }),
      env({ freezingLevelM: 3200 }),
    );
    expect(withLid.hailCmMax).toBeNull();
    expect(deep.hailCmMax).not.toBeNull();
  });

  it("PseudoCAPPI surfaceDbz snižuje odhad mm/h oproti maxZ", () => {
    const fromMax = scoreActiveStorm(
      cell({ maxDbz: 58, approachAngleDeg: 2 }),
    );
    const fromSurf = scoreActiveStorm(
      cell({ maxDbz: 58, surfaceDbz: 42, approachAngleDeg: 2 }),
    );
    expect(fromSurf.rainMmPerHour).not.toBeNull();
    expect(fromMax.rainMmPerHour).not.toBeNull();
    expect(fromSurf.rainMmPerHour![1]).toBeLessThan(fromMax.rainMmPerHour![1]);
    expect(fromSurf.reasons.some((r) => r.includes("PseudoCAPPI"))).toBe(true);
  });
});
