import { describe, expect, it } from "vitest";
import {
  classifySatelliteTrend,
  sampleSatelliteCooling,
  type SatelliteCoolingGrid,
} from "./satelliteCooling";

const grid: SatelliteCoolingGrid = {
  west: 7,
  south: 46.5,
  east: 22.5,
  north: 52.5,
  cols: 28,
  rows: 18,
  status: "ok",
  dtMinutes: 15,
  validAt: "2026-07-22T08:00:00Z",
  points: [
    { lat: 49.0, lon: 14.0, cloudTopTempC: -12, cloudTopCoolingCPer15min: -3.2 },
    { lat: 50.0, lon: 16.0, cloudTopTempC: -8, cloudTopCoolingCPer15min: 2.1 },
  ],
};

describe("satelliteCooling", () => {
  it("sample u bodu s ochlazováním", () => {
    const s = sampleSatelliteCooling(grid, 49.01, 14.01);
    expect(s?.trend).toBe("growing");
    expect(s?.cloudTopCoolingCPer15min).toBe(-3.2);
  });

  it("sample u bodu s oteplováním", () => {
    const s = sampleSatelliteCooling(grid, 50.0, 16.0);
    expect(s?.trend).toBe("warming");
  });

  it("mimo pokrytí vrátí null", () => {
    expect(sampleSatelliteCooling(grid, 46.6, 7.1)).toBeNull();
  });

  it("classifySatelliteTrend", () => {
    expect(classifySatelliteTrend(-2.5)).toBe("growing");
    expect(classifySatelliteTrend(2)).toBe("warming");
    expect(classifySatelliteTrend(0.2)).toBe("steady");
  });
});
