import { describe, expect, it } from "vitest";
import type { FeatureCollection, Point } from "geojson";
import {
  buildRadarProgressFeatures,
  effectivePeakDbz,
  meanForecastDelta,
  parseTrackedCells,
  peakAtForecastMinutes,
  radarPointsGeoJSONAt,
  type RadarProgressFeature,
} from "./radarCells";

describe("effectivePeakDbz", () => {
  it("věří ČHMÚ když OPERA je nafouklý ghost", () => {
    expect(
      effectivePeakDbz({ maxDbz: 54, peakDbz: 35, chmiDbz: 35 }),
    ).toBe(35);
  });

  it("vezme vyšší ČHMÚ když je silnější než OPERA", () => {
    expect(
      effectivePeakDbz({ maxDbz: 48, peakDbz: 56, chmiDbz: 56 }),
    ).toBe(56);
  });
});

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
  it("posune jádro při radar-track (track mode)", () => {
    const at0 = peakAtForecastMinutes(feat(), 0);
    const at30 = peakAtForecastMinutes(feat(), 30, undefined, "track");
    expect(at0).toEqual([16, 50]);
    expect(at30[0]).toBeGreaterThan(at0[0]);
  });

  it("raster mode má prioritu před vlastní rychlostí", () => {
    const delta = meanForecastDelta([feat()], 20);
    const moved = peakAtForecastMinutes(feat(), 20, delta, "raster");
    expect(moved[0]).toBeCloseTo(16 + delta.dLon, 5);
    expect(moved[1]).toBeCloseTo(50 + delta.dLat, 5);
  });

  it("posune jádro i při wind-fallback s rychlostí", () => {
    const at0 = peakAtForecastMinutes(
      feat({ motionSource: "wind-fallback", speedKmh: 24, headingDeg: 90 }),
      0,
    );
    const at30 = peakAtForecastMinutes(
      feat({ motionSource: "wind-fallback", speedKmh: 24, headingDeg: 90 }),
      30,
      undefined,
      "track",
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

describe("tracked cells fixture", () => {
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          kind: "peak",
          cellId: "cell-3",
          id: "cell-3",
          maxDbz: 48,
        },
        geometry: { type: "Point", coordinates: [16.2, 49.8] },
      },
      {
        type: "Feature",
        properties: {
          kind: "cell",
          id: "cell-3",
          maxDbz: 48,
          trackHeadingDeg: 90,
          trackSpeedKmh: 36,
          historyMinutes: 30,
          history: [
            {
              time: "a",
              peakLon: 15.9,
              peakLat: 49.8,
              maxDbz: 42,
            },
            {
              time: "b",
              peakLon: 16.05,
              peakLat: 49.8,
              maxDbz: 45,
            },
            {
              time: "c",
              peakLon: 16.2,
              peakLat: 49.8,
              maxDbz: 48,
            },
          ],
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [16.1, 49.7],
              [16.3, 49.7],
              [16.3, 49.9],
              [16.1, 49.9],
              [16.1, 49.7],
            ],
          ],
        },
      },
      // duplicitní polygon se stejným id — parse má nechat jeden
      {
        type: "Feature",
        properties: {
          kind: "cell",
          id: "cell-3",
          maxDbz: 40,
          history: [
            { time: "a", peakLon: 16.2, peakLat: 49.8, maxDbz: 40 },
          ],
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [16.15, 49.75],
              [16.25, 49.75],
              [16.25, 49.85],
              [16.15, 49.85],
              [16.15, 49.75],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: {
          kind: "peak",
          cellId: "cell-7",
          id: "cell-7",
          maxDbz: 41,
        },
        geometry: { type: "Point", coordinates: [17.1, 50.1] },
      },
      {
        type: "Feature",
        properties: {
          kind: "cell",
          id: "cell-7",
          maxDbz: 41,
          trackHeadingDeg: 45,
          trackSpeedKmh: 20,
          history: [
            { time: "a", peakLon: 17.0, peakLat: 50.0, maxDbz: 38 },
            { time: "b", peakLon: 17.1, peakLat: 50.1, maxDbz: 41 },
          ],
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [17.0, 50.0],
              [17.2, 50.0],
              [17.2, 50.2],
              [17.0, 50.2],
              [17.0, 50.0],
            ],
          ],
        },
      },
    ],
  };
  const cells = parseTrackedCells(fc);
  const features = buildRadarProgressFeatures(cells, null, null, [], null);

  it("peak sedí na kind=peak, ne centroid", () => {
    const cell = cells.find((c) => c.id === "cell-3");
    expect(cell).toBeDefined();
    const f = features.find((x) => x.id === "cell-3");
    expect(f?.peak).toEqual(cell!.peak);
    expect(f?.peak).toEqual([16.2, 49.8]);
  });

  it("cell-3 má pozorovaný pohyb a posune se v +30 min", () => {
    const f = features.find((x) => x.id === "cell-3");
    expect(f?.speedKmh).toBeGreaterThanOrEqual(5);
    const at0 = peakAtForecastMinutes(f!, 0);
    const at30 = peakAtForecastMinutes(f!, 30);
    const dist =
      Math.hypot(at30[0] - at0[0], at30[1] - at0[1]) * 111;
    expect(dist).toBeGreaterThan(5);
  });

  it("duplicitní cell id — jedna buňka na id", () => {
    const dupes = cells.filter((c) => c.id === "cell-3");
    expect(dupes).toHaveLength(1);
  });

  it("GeoJSON jader se mění se sliderem +min", () => {
    const at0 = radarPointsGeoJSONAt(features, 0);
    const at15 = radarPointsGeoJSONAt(features, 15);
    const at30 = radarPointsGeoJSONAt(features, 30);
    const p0 = at0.features.find((f) => f.properties?.id === "cell-3");
    const p15 = at15.features.find((f) => f.properties?.id === "cell-3");
    const p30 = at30.features.find((f) => f.properties?.id === "cell-3");
    expect(p0?.geometry.type).toBe("Point");
    expect(p15?.geometry.type).toBe("Point");
    expect(p30?.geometry.type).toBe("Point");
    const c0 = (p0!.geometry as Point).coordinates;
    const c15 = (p15!.geometry as Point).coordinates;
    const c30 = (p30!.geometry as Point).coordinates;
    const d15 = Math.hypot(c15[0] - c0[0], c15[1] - c0[1]);
    const d30 = Math.hypot(c30[0] - c0[0], c30[1] - c0[1]);
    expect(d15).toBeGreaterThan(0.01);
    expect(d30).toBeGreaterThan(d15);
  });

  it("slabé / ghost ČHMÚ buňky nejdou na mapu", () => {
    const ghostFc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            kind: "peak",
            cellId: "ghost",
            id: "ghost",
            maxDbz: 52,
            chmiDbz: 18,
            peakDbz: 18,
          },
          geometry: { type: "Point", coordinates: [15, 50] },
        },
        {
          type: "Feature",
          properties: {
            kind: "cell",
            id: "ghost",
            maxDbz: 52,
            chmiDbz: 18,
            peakDbz: 18,
            history: [
              { time: "a", peakLon: 15, peakLat: 50, maxDbz: 52 },
            ],
          },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [14.9, 49.9],
                [15.1, 49.9],
                [15.1, 50.1],
                [14.9, 50.1],
                [14.9, 49.9],
              ],
            ],
          },
        },
      ],
    };
    const gCells = parseTrackedCells(ghostFc);
    const gFeatures = buildRadarProgressFeatures(gCells, null, null, [], null);
    expect(gFeatures.find((f) => f.id === "ghost")).toBeUndefined();
  });
});
