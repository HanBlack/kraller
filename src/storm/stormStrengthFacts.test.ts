import { describe, expect, it } from "vitest";
import {
  buildStormStrengthFacts,
  lightningActivityFromFlashes15min,
  recentDbzTrend,
} from "./stormStrengthFacts";
import type { CellHistoryPoint } from "./radarCells";

function hist(
  points: { min: number; dbz: number }[],
): CellHistoryPoint[] {
  return points.map((p) => ({
    time: "",
    peak: [0, 0] as [number, number],
    maxDbz: p.dbz,
    minutesFromBirth: p.min,
  }));
}

describe("recentDbzTrend", () => {
  it("počítá Δ dBZ přes ~20 min", () => {
    const t = recentDbzTrend(
      hist([
        { min: 0, dbz: 35 },
        { min: 5, dbz: 38 },
        { min: 10, dbz: 42 },
        { min: 15, dbz: 45 },
        { min: 20, dbz: 48 },
      ]),
      48,
      20,
    );
    expect(t).not.toBeNull();
    expect(t!.windowMin).toBeGreaterThanOrEqual(15);
    expect(t!.deltaDbz).toBe(13);
  });

  it("vrací null při krátké historii", () => {
    expect(
      recentDbzTrend(hist([{ min: 0, dbz: 40 }, { min: 5, dbz: 42 }]), 42),
    ).toBeNull();
  });

  it("zachytí pokles", () => {
    const t = recentDbzTrend(
      hist([
        { min: 0, dbz: 52 },
        { min: 10, dbz: 50 },
        { min: 20, dbz: 44 },
        { min: 25, dbz: 40 },
      ]),
      40,
      20,
    );
    expect(t!.deltaDbz).toBeLessThan(0);
  });
});

describe("lightningActivityFromFlashes15min", () => {
  it("mapuje prahy na lidské stupně", () => {
    expect(lightningActivityFromFlashes15min(0)?.level).toBe("none");
    expect(lightningActivityFromFlashes15min(8)?.level).toBe("occasional");
    expect(lightningActivityFromFlashes15min(18)?.level).toBe("frequent");
    expect(lightningActivityFromFlashes15min(90)?.level).toBe("very_frequent");
  });

  it("počítá ~/min z 15min součna", () => {
    expect(lightningActivityFromFlashes15min(45)?.ratePerMin).toBe(3);
    expect(lightningActivityFromFlashes15min(3)?.ratePerMin).toBe(1);
  });
});

describe("buildStormStrengthFacts", () => {
  it("skládá sat blesky a výšku", () => {
    const f = buildStormStrengthFacts({
      maxDbz: 55,
      echoTopKm: 12,
      ageMinutes: 40,
      satAtPeak: {
        available: true,
        distanceKm: 0,
        exactMatch: true,
        cloudTopTempC: -58,
        cloudTopHeightM: 14_200,
        cloudTopCoolingCPer15min: -3,
        trend: "growing",
        coldTop: true,
        deepIceTop: true,
        towerRising: false,
        towerFalling: false,
        lightningFlashes15min: 18,
      },
      satLive: true,
      dualpolLabel: "strong_updraft",
      dualpolHailLikely: false,
      history: hist([
        { min: 0, dbz: 40 },
        { min: 10, dbz: 48 },
        { min: 20, dbz: 52 },
        { min: 30, dbz: 55 },
      ]),
    });
    expect(f.cloudHeight?.km).toBe(14.2);
    expect(f.cloudTopTempC).toBe(-58);
    expect(f.lightningFlashes15min).toBe(18);
    expect(f.lightningActivity?.level).toBe("frequent");
    expect(f.lightningActivity?.ratePerMin).toBe(1);
    expect(f.dbzTrend?.deltaDbz).toBeGreaterThan(0);
    expect(f.dualpolLabel).toBe("strong_updraft");
  });
});
