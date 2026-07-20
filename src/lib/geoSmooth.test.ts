import { describe, expect, it } from "vitest";
import { chaikinSmoothRing, smoothPolygon } from "./geoSmooth";
import type { Polygon } from "geojson";

describe("geoSmooth", () => {
  it("chaikin adds midpoints and keeps ring closed", () => {
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const out = chaikinSmoothRing(square, 1);
    expect(out.length).toBeGreaterThan(square.length);
    expect(out[0]).toEqual(out[out.length - 1]);
  });

  it("smoothPolygon preserves Polygon type", () => {
    const poly: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [18, 49],
          [18.1, 49],
          [18.1, 49.1],
          [18, 49.1],
          [18, 49],
        ],
      ],
    };
    const smoothed = smoothPolygon(poly, 1);
    expect(smoothed.type).toBe("Polygon");
    expect(smoothed.coordinates[0]!.length).toBeGreaterThan(5);
  });
});
