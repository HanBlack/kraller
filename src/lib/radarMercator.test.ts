import { describe, expect, it } from "vitest";
import {
  lonLatToMercatorPixel,
  mercatorPixelToLonLat,
} from "./radarMercator";

const coords: [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [11.34, 51.88],
  [20.17, 51.88],
  [20.17, 47.65],
  [11.34, 47.65],
];

describe("radarMercator", () => {
  it("roundtrip lon/lat → px → lon/lat", () => {
    const lon = 12.4148;
    const lat = 50.4752;
    const [px, py] = lonLatToMercatorPixel(lon, lat, coords, 400, 300);
    const [lon2, lat2] = mercatorPixelToLonLat(px, py, coords, 400, 300);
    expect(lon2).toBeCloseTo(lon, 4);
    expect(lat2).toBeCloseTo(lat, 4);
  });
});
