import { describe, expect, it } from "vitest";
import {
  radarTrackCorridorsGeoJSONAt,
  type RadarProgressFeature,
} from "./radarCells";

function feature(partial: Partial<RadarProgressFeature> = {}): RadarProgressFeature {
  const peak: [number, number] = [17.5, 49.3];
  return {
    id: "t1",
    peak,
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [17.4, 49.2],
          [17.6, 49.2],
          [17.6, 49.4],
          [17.4, 49.4],
          [17.4, 49.2],
        ],
      ],
    },
    trackEnd: [18.0, 49.6],
    headingDeg: 40,
    speedKmh: 35,
    maxDbz: 55,
    severity: "strong",
    rank: 3,
    threatens: 1,
    label: "test",
    motionSource: "wind-fallback",
    historyMinutes: 20,
    birth: peak,
    birthDbz: 35,
    ageMinutes: 20,
    isNewborn: false,
    trueBirth: false,
    growthDbz: 3,
    phase: "moving",
    history: [],
    placeLabel: "test",
    ...partial,
  };
}

describe("radarTrackCorridors — pás místo přímky", () => {
  it("vyrobí polygon koridoru kolem stopy", () => {
    const fc = radarTrackCorridorsGeoJSONAt([feature()], 0);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.type).toBe("Polygon");
    const ring = (fc.features[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring.length).toBeGreaterThan(4);
    expect(Number(fc.features[0].properties?.halfKm)).toBeGreaterThan(3);
  });

  it("silnější / delší horizont → širší pás", () => {
    const near = radarTrackCorridorsGeoJSONAt([feature({ maxDbz: 40 })], 0);
    const far = radarTrackCorridorsGeoJSONAt([feature({ maxDbz: 60 })], 45);
    const w0 = Number(near.features[0].properties?.halfKm);
    const w1 = Number(far.features[0].properties?.halfKm);
    expect(w1).toBeGreaterThanOrEqual(w0);
  });

  it("FCT nesouhlas → širší koridor", () => {
    const agree = radarTrackCorridorsGeoJSONAt([feature()], 15);
    const disagree = radarTrackCorridorsGeoJSONAt(
      [feature({ fctDisagree: true, fctAngleDiffDeg: 50 })],
      15,
    );
    expect(Number(disagree.features[0].properties?.halfKm)).toBeGreaterThan(
      Number(agree.features[0].properties?.halfKm),
    );
  });

  it("early / growing → širší koridor než mature", () => {
    const mature = radarTrackCorridorsGeoJSONAt(
      [feature({ phase: "moving", ageMinutes: 40, trueBirth: false })],
      0,
    );
    const early = radarTrackCorridorsGeoJSONAt(
      [feature({ phase: "growing", ageMinutes: 8, trueBirth: true })],
      0,
    );
    expect(Number(early.features[0].properties?.halfKm)).toBeGreaterThan(
      Number(mature.features[0].properties?.halfKm),
    );
  });
});
