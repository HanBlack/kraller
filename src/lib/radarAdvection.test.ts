import { describe, expect, it } from "vitest";
import {
  globalPixelShift,
  lonLatDeltaToPixel,
  pixelAlphaGain,
  quantizeEvolveMinutes,
} from "./radarAdvection";
import type { RadarProgressFeature } from "../storm/radarCells";

const coords: [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [12, 52],
  [20, 52],
  [20, 48],
  [12, 48],
];

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
    trackEnd: [16.4, 50],
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

describe("radarAdvection", () => {
  it("quantizeEvolveMinutes po 0.5 min", () => {
    expect(quantizeEvolveMinutes(7.2)).toBe(7);
    expect(quantizeEvolveMinutes(7.3)).toBe(7.5);
  });

  it("lon/lat delta → pixel shift (mercator)", () => {
    const { dx, dy } = lonLatDeltaToPixel(
      0.2,
      -0.1,
      16,
      50,
      coords,
      400,
      300,
    );
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeGreaterThan(0);
  });

  it("global shift z buněk s rychlostí ≥ 5 km/h", () => {
    const shift = globalPixelShift(
      [feat(), feat({ id: "c2", motionSource: "wind-fallback", speedKmh: 20 })],
      coords,
      400,
      300,
      30,
    );
    expect(Math.abs(shift.dx) + Math.abs(shift.dy)).toBeGreaterThan(0);
    const none = globalPixelShift(
      [feat({ speedKmh: 0, motionSource: "wind-fallback" })],
      coords,
      400,
      300,
      30,
    );
    expect(none.dx).toBe(0);
    expect(none.dy).toBe(0);
  });

  it("alpha gain roste u jádra při růstu dBZ", () => {
    const gain = pixelAlphaGain(200, 150, [
      { px: 200, py: 150, maxDbz: 50, dbzDelta: 6, radius: 40 },
    ]);
    expect(gain).toBeGreaterThan(1);
  });
});
