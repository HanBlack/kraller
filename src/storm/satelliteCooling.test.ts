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
      hasCloudTop: true,
      cloudTopTempC: -12,
      cloudTopCoolingCPer15min: -3.2,
      cloudTopCoolingCPer45min: -6.5,
      cloudTopHeightM: 9000,
      cloudTopHeightDeltaMPer15min: 1800,
      cloudTypeCode: 8,
      cloudLevel: "high",
      deepIceTop: true,
      lightningFlashes15min: 12,
      sampleSource: "cell",
    },
    {
      lat: 50.0,
      lon: 16.0,
      hasCloudTop: true,
      cloudTopTempC: -18,
      cloudTopCoolingCPer15min: 0,
      sampleSource: "grid",
    },
    {
      lat: 49.83,
      lon: 18.29,
      hasCloudTop: false,
      sampleSource: "cell",
    },
    {
      lat: 49.9,
      lon: 18.35,
      hasCloudTop: true,
      cloudTopTempC: -28,
      cloudTopCoolingCPer15min: -1.2,
      cloudTopHeightM: 8500,
      sampleSource: "grid",
    },
    {
      lat: 48.5,
      lon: 17.0,
      hasCloudTop: true,
      cloudTopTempC: -20,
      cloudTopCoolingCPer15min: -0.5,
      cloudTopCoolingCPer45min: -5.2,
      deepIceTop: true,
      sampleSource: "cell",
    },
    {
      lat: 46.7,
      lon: 7.2,
      hasCloudTop: false,
      lightningFlashes15min: 8,
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
    expect(s?.deepIceTop).toBe(true);
    expect(s?.lightningFlashes15min).toBe(12);
  });

  it("exact cell clear — fallback na blízký cloudy grid", () => {
    const s = sampleSatelliteCooling(grid, 49.83, 18.29);
    expect(s).not.toBeNull();
    expect(s?.cloudTopTempC).toBe(-28);
    expect(s?.exactMatch).toBe(false);
  });

  it("explainSatelliteStatus — nearby cloudy after clear marker", () => {
    const line = explainSatelliteStatus(grid, 49.83, 18.29);
    expect(line.detail).not.toMatch(/bez detekovaného vrcholu/i);
  });

  it("classify cold top", () => {
    expect(
      classifySatelliteTrend({
        coolingPer15min: 0,
        cloudTopTempC: -35,
      }),
    ).toBe("cold_top");
  });

  it("classify growing_long when 15min weak but 45min strong", () => {
    expect(
      classifySatelliteTrend({
        coolingPer15min: -0.5,
        coolingPer45min: -5.2,
        cloudTopTempC: -20,
      }),
    ).toBe("growing_long");
  });

  it("sample long cooling trend", () => {
    const s = sampleSatelliteCooling(grid, 48.5, 17.0);
    expect(s?.trend).toBe("growing_long");
    expect(s?.deepIceTop).toBe(true);
  });

  it("clear cell with lightning only", () => {
    const s = sampleSatelliteCooling(grid, 46.7, 7.2);
    expect(s?.lightningFlashes15min).toBe(8);
    expect(s?.cloudTopTempC).toBeUndefined();
    expect(s?.exactMatch).toBe(true);
  });

  it("explainSatelliteStatus includes lightning / ice extras when growing", () => {
    const line = explainSatelliteStatus(grid, 49.0, 14.0);
    expect(line.detail).toMatch(/ochlazuje|blesky|ice/i);
  });

  it("explainSatelliteStatus — stabilní", () => {
    const line = explainSatelliteStatus(grid, 50.0, 16.0);
    expect(line.detail).toMatch(/bez výrazného růstu/i);
  });

  it("explainSatelliteStatus — empty → model fallback", () => {
    const empty: SatelliteCoolingGrid = {
      ...grid,
      status: "empty",
      points: [],
      message: "0 cloudy",
    };
    const line = explainSatelliteStatus(empty, 49.0, 14.0);
    expect(line.detail).toMatch(/používáme model/i);
    expect(line.detail).not.toMatch(/příští kolo|geometrie/i);
  });

  it("explainSatelliteStatus — bez mraku mimo vzorek", () => {
    const line = explainSatelliteStatus(grid, 46.6, 7.1);
    expect(line.detail).toMatch(/nevidíme vrchol/i);
  });
});
