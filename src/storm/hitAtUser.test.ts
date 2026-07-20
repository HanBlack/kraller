import { describe, expect, it } from "vitest";
import {
  bandRadiiKm,
  classifyHitAtUser,
  dbzAtHit,
  estimateMissKm,
  estimateRainMmH,
  severityFromDbz,
} from "./hitAtUser";

describe("hitAtUser — víkendová realita (jádro vs okraj)", () => {
  it("přímý zásah jádra → silný déšť (mm/h)", () => {
    const hit = classifyHitAtUser({
      maxDbz: 58,
      distanceToUserKm: 25,
      approachAngleDeg: 2,
    });
    expect(hit.hitType).toBe("core");
    expect(hit.atUserDbz).toBe(58);
    const rain = estimateRainMmH(hit.atUserDbz!);
    expect(rain).not.toBeNull();
    // 55 dBZ → 40 mm/h → lo≈28, hi≈46
    expect(rain![0]).toBeGreaterThanOrEqual(25);
    expect(rain![1]).toBeGreaterThanOrEqual(40);
  });

  it("jádro mine → okraj / slabší déšť (víkend: trochu pršelo)", () => {
    const hit = classifyHitAtUser({
      maxDbz: 58,
      distanceToUserKm: 35,
      approachAngleDeg: 18,
    });
    // miss ≈ 35 * sin(18°) ≈ 10.8 km → fringe
    expect(hit.hitType).toBe("fringe");
    expect(hit.atUserDbz).toBeLessThan(58);
    expect(hit.atUserDbz).toBeGreaterThanOrEqual(40);
    const rainCore = estimateRainMmH(58)!;
    const rainHere = estimateRainMmH(hit.atUserDbz!)!;
    expect(rainHere[1]).toBeLessThan(rainCore[1]);
  });

  it("daleko bokem → edge/miss, slabý nebo žádný déšť", () => {
    const hit = classifyHitAtUser({
      maxDbz: 55,
      distanceToUserKm: 50,
      approachAngleDeg: 45,
    });
    expect(["edge", "miss"]).toContain(hit.hitType);
    if (hit.hitType === "miss") {
      expect(hit.atUserDbz).toBeNull();
    } else {
      expect(hit.atUserDbz!).toBeLessThan(45);
    }
  });

  it("blízko peaku (≤8 km) bere vzdálenost k peaku jako miss", () => {
    const hit = classifyHitAtUser({
      maxDbz: 52,
      distanceToUserKm: 4,
      approachAngleDeg: 80,
    });
    expect(hit.missKm).toBeLessThanOrEqual(4);
    expect(hit.hitType).toBe("core");
  });
});

describe("hitAtUser — geometrie a tabulky", () => {
  it("missKm = 0 při approach 0°, max při 90°", () => {
    expect(estimateMissKm(40, 0)).toBeLessThan(0.5);
    expect(estimateMissKm(40, 90)).toBeCloseTo(40, 0);
    expect(estimateMissKm(40, 30)).toBeGreaterThan(estimateMissKm(40, 10));
  });

  it("silnější buňka má větší pásma", () => {
    const weak = bandRadiiKm(40);
    const strong = bandRadiiKm(60);
    expect(strong.coreKm).toBeGreaterThan(weak.coreKm);
    expect(strong.fringeKm).toBeGreaterThan(weak.fringeKm);
  });

  it("dbzAtHit klesá od jádra k okraji", () => {
    expect(dbzAtHit(55, "core")).toBe(55);
    expect(dbzAtHit(55, "fringe")).toBe(45);
    expect(dbzAtHit(55, "edge")).toBe(37);
    expect(dbzAtHit(55, "miss")).toBeNull();
  });

  it("severityFromDbz odděluje slabá / střední / silná", () => {
    expect(severityFromDbz(40)).toBe("weak");
    expect(severityFromDbz(48)).toBe("moderate");
    expect(severityFromDbz(56)).toBe("strong");
  });

  it("estimateRainMmH pod 35 dBZ je null", () => {
    expect(estimateRainMmH(30)).toBeNull();
    expect(estimateRainMmH(35)).not.toBeNull();
  });
});
