import { describe, expect, it } from "vitest";
import {
  coreRadiusForDbz,
  scaleRadarRaster,
  stormEvolutionAt,
} from "./stormEvolution";
import type { RadarRasterMeta } from "./radarRaster";
import type { RadarProgressFeature } from "../storm/radarCells";

function feat(maxDbz: number, growthDbz = 0): RadarProgressFeature {
  return {
    id: "c1",
    maxDbz,
    peak: [15, 50],
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [15, 50],
          [15.1, 50],
          [15.1, 50.1],
          [15, 50.1],
          [15, 50],
        ],
      ],
    },
    headingDeg: 40,
    speedKmh: 30,
    severity: "moderate",
    rank: 2,
    threatens: 0,
    label: "x",
    trackEnd: [15.2, 50.1],
    motionSource: "wind-fallback",
    historyMinutes: 20,
    birth: [15, 50],
    birthDbz: maxDbz - growthDbz,
    ageMinutes: 20,
    isNewborn: false,
    trueBirth: false,
    growthDbz,
    phase: "mature",
    history: [],
    placeLabel: "x",
  };
}

describe("stormEvolution", () => {
  it("minutes=0 → neutrální", () => {
    const e = stormEvolutionAt([feat(48)], undefined, 0);
    expect(e.footprintScale).toBe(1);
    expect(e.rasterOpacity).toBeCloseTo(1, 2);
  });

  it("slábnutí sníží opacity a scale", () => {
    const e = stormEvolutionAt([feat(40, -4)], undefined, 30);
    expect(e.meanDeltaDbz).toBeLessThan(0);
    expect(e.rasterOpacity).toBeLessThan(1);
    expect(e.footprintScale).toBeLessThan(1);
  });

  it("scaleRadarRaster roztáhne od středu", () => {
    const meta: RadarRasterMeta = {
      url: "x",
      coordinates: [
        [10, 50],
        [20, 50],
        [20, 40],
        [10, 40],
      ],
    };
    const out = scaleRadarRaster(meta, 1.1);
    expect(out.coordinates[0][0]).toBeLessThan(10);
    expect(out.coordinates[1][0]).toBeGreaterThan(20);
  });

  it("coreRadius roste s dBZ", () => {
    expect(coreRadiusForDbz(55)).toBeGreaterThan(coreRadiusForDbz(35));
    expect(coreRadiusForDbz(55)).toBeLessThan(5);
  });
});
