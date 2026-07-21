import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FeatureCollection, Point } from "geojson";
import {
  buildRadarProgressFeatures,
  meanForecastDelta,
  parseTrackedCells,
  peakAtForecastMinutes,
  radarPointsGeoJSONAt,
  type RadarProgressFeature,
} from "./radarCells";

function feat(
  overrides: Partial<RadarProgressFeature> = {},
): RadarProgressFeature {
  return {
    id: "c1",
    maxDbz: 48,
    peak: [16, 50],
    polygon: { type: "Polygon", coordinates: [[]] },
    headingDeg: 90,
    speedKmh: 36,
    severity: "moderate",
    rank: 2,
    threatens: 0,
    label: "x",
    trackEnd: [16.3, 50],
    motionSource: "radar-track",
    historyMinutes: 20,
    birth: [16, 50],
    birthDbz: 40,
    ageMinutes: 20,
    isNewborn: false,
    trueBirth: false,
    growthDbz: 2,
    phase: "mature",
    history: [],
    placeLabel: "x",
    ...overrides,
  };
}

describe("peakAtForecastMinutes", () => {
  it("posune jádro při radar-track", () => {
    const at0 = peakAtForecastMinutes(feat(), 0);
    const at30 = peakAtForecastMinutes(feat(), 30);
    expect(at0).toEqual([16, 50]);
    expect(at30[0]).toBeGreaterThan(at0[0]);
  });

  it("posune jádro i při wind-fallback s rychlostí", () => {
    const at0 = peakAtForecastMinutes(
      feat({ motionSource: "wind-fallback", speedKmh: 24, headingDeg: 90 }),
      0,
    );
    const at30 = peakAtForecastMinutes(
      feat({ motionSource: "wind-fallback", speedKmh: 24, headingDeg: 90 }),
      30,
    );
    expect(at30[0]).toBeGreaterThan(at0[0]);
  });

  it("bez vlastní rychlosti použije systémový posun", () => {
    const delta = meanForecastDelta([feat()], 30);
    const moved = peakAtForecastMinutes(
      feat({ motionSource: "wind-fallback", speedKmh: 0 }),
      30,
      delta,
    );
    expect(moved[0]).toBeGreaterThan(16);
  });

  it("systémový posun sedí s meanForecastDelta", () => {
    const features = [feat(), feat({ id: "c2", peak: [17, 50.2] })];
    const delta = meanForecastDelta(features, 20);
    const moved = peakAtForecastMinutes(
      feat({ motionSource: "wind-fallback", speedKmh: 0 }),
      20,
      delta,
    );
    expect(moved[0]).toBeCloseTo(16 + delta.dLon, 5);
    expect(moved[1]).toBeCloseTo(50 + delta.dLat, 5);
  });
});

describe("real OPERA cells", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "public/data/opera/cells.geojson"),
    "utf8",
  );
  const fc = JSON.parse(raw) as FeatureCollection;
  const cells = parseTrackedCells(fc);
  const features = buildRadarProgressFeatures(cells, null, null, [], null);

  it("peak sedí na kind=peak, ne centroid", () => {
    const cell4 = cells.find((c) => c.id === "cell-4");
    expect(cell4).toBeDefined();
    const f4 = features.find((f) => f.id === "cell-4");
    expect(f4?.peak).toEqual(cell4!.peak);
    expect(f4!.peak[0]).not.toBeCloseTo(12.25347, 3);
  });

  it("cell-4 má pozorovaný pohyb a posune se v +30 min", () => {
    const f4 = features.find((f) => f.id === "cell-4");
    expect(f4?.speedKmh).toBeGreaterThanOrEqual(5);
    const at0 = peakAtForecastMinutes(f4!, 0);
    const at30 = peakAtForecastMinutes(f4!, 30);
    const dist =
      Math.hypot(at30[0] - at0[0], at30[1] - at0[1]) * 111;
    expect(dist).toBeGreaterThan(8);
  });

  it("GeoJSON jader se mění se sliderem +min", () => {
    const at0 = radarPointsGeoJSONAt(features, 0);
    const at15 = radarPointsGeoJSONAt(features, 15);
    const at30 = radarPointsGeoJSONAt(features, 30);
    const p0 = at0.features.find((f) => f.properties?.id === "cell-4");
    const p15 = at15.features.find((f) => f.properties?.id === "cell-4");
    const p30 = at30.features.find((f) => f.properties?.id === "cell-4");
    expect(p0?.geometry.type).toBe("Point");
    expect(p15?.geometry.type).toBe("Point");
    expect(p30?.geometry.type).toBe("Point");
    const c0 = (p0!.geometry as Point).coordinates;
    const c15 = (p15!.geometry as Point).coordinates;
    const c30 = (p30!.geometry as Point).coordinates;
    expect(c15[0]).not.toBeCloseTo(c0[0], 5);
    expect(c30[0]).toBeGreaterThan(c15[0]);
  });
});
