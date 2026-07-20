import { describe, expect, it } from "vitest";
import { scoreActiveStorm, shouldAlertActive } from "./scoreActive";
import type { RadarCellSignals } from "./types";

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
