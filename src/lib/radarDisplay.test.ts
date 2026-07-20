import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import { filterRadarForCzFocus } from "./radarDisplay";

function poly(
  lon: number,
  lat: number,
  dbz: number,
): FeatureCollection["features"][0] {
  return {
    type: "Feature",
    properties: { dbz, band: dbz <= 30 ? "light" : "rain" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon - 0.05, lat - 0.05],
          [lon + 0.05, lat - 0.05],
          [lon + 0.05, lat + 0.05],
          [lon - 0.05, lat + 0.05],
          [lon - 0.05, lat - 0.05],
        ],
      ],
    },
  };
}

describe("filterRadarForCzFocus", () => {
  it("v ČR nechá slabé echo", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [poly(16.6, 49.2, 30)],
    };
    expect(filterRadarForCzFocus(fc).features).toHaveLength(1);
  });

  it("mimo ČR schová slabé echo, nechá déšť+", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        poly(19.9, 50.1, 30), // Kraków — mimo bbox ČR
        poly(19.9, 50.1, 45),
        poly(16.4, 48.2, 30), // Vídeň
      ],
    };
    const out = filterRadarForCzFocus(fc);
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties?.dbz).toBe(45);
  });
});
