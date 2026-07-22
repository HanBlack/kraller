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
      cloudTopHeightM: 9000,
      cloudTopHeightDeltaMPer15min: 1800,
      cloudTypeCode: 8,
      cloudLevel: "high",
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
  ],
};

describe("satelliteCooling", () => {
  it("sample u cell bodu s ochlazováním a věží", () => {
    const s = sampleSatelliteCooling(grid, 49.0, 14.0);
    expect(s?.trend).toBe("growing");
    expect(s?.towerRising).toBe(true);
    expect(s?.exactMatch).toBe(true);
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

  it("explainSatelliteStatus — stabilní", () => {
    const line = explainSatelliteStatus(grid, 50.0, 16.0);
    expect(line.detail).toMatch(/stabilní/i);
  });

  it("explainSatelliteStatus — bez mraku mimo vzorek", () => {
    const line = explainSatelliteStatus(grid, 46.6, 7.1);
    expect(line.detail).toMatch(/bez detekovaného vrcholu/i);
  });
});
