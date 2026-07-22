import { describe, expect, it } from "vitest";
import {
  classifySatelliteTrend,
  explainSatelliteStatus,
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
    {
      lat: 49.0,
      lon: 14.0,
      cloudTopTempC: -12,
      cloudTopCoolingCPer15min: -3.2,
      cloudTopHeightM: 9000,
      cloudTopHeightDeltaMPer15min: 1800,
      sampleSource: "cell",
    },
    {
      lat: 50.0,
      lon: 16.0,
      cloudTopTempC: -8,
      cloudTopCoolingCPer15min: 2.1,
      sampleSource: "grid",
    },
    {
      lat: 49.83,
      lon: 18.29,
      cloudTopTempC: 13.5,
      cloudTopCoolingCPer15min: 0,
      sampleSource: "cell",
    },
  ],
};

describe("satelliteCooling", () => {
  it("sample u cell bodu s ochlazováním a věží", () => {
    const s = sampleSatelliteCooling(grid, 49.0, 14.0);
    expect(s?.trend).toBe("growing");
    expect(s?.towerRising).toBe(true);
    expect(s?.exactMatch).toBe(true);
  });

  it("exact cell sample u Ostravy", () => {
    const s = sampleSatelliteCooling(grid, 49.83, 18.29);
    expect(s?.exactMatch).toBe(true);
    expect(s?.distanceKm).toBeLessThan(1);
  });

  it("classify cold top", () => {
    expect(
      classifySatelliteTrend({
        coolingPer15min: 0,
        cloudTopTempC: -35,
      }),
    ).toBe("cold_top");
  });

  it("explainSatelliteStatus — stabilní", () => {
    const line = explainSatelliteStatus(grid, 49.83, 18.29);
    expect(line.detail).toMatch(/stabilní/i);
  });

  it("explainSatelliteStatus — bez mraku", () => {
    const line = explainSatelliteStatus(grid, 46.6, 7.1);
    expect(line.detail).toMatch(/bez detekovaného vrcholu/i);
  });
});
