import { describe, expect, it } from "vitest";
import type { RadarProgressFeature } from "../storm/radarCells";
import {
  clearSliderRasterCache,
  getSliderRaster,
  seedSliderRasterCache,
  sliderCacheSize,
} from "./radarSliderCache";
import type { RadarRasterMeta } from "./radarRaster";

const live: RadarRasterMeta = {
  url: "blob:live",
  coordinates: [
    [11, 52],
    [20, 52],
    [20, 48],
    [11, 48],
  ],
};

function cell(): RadarProgressFeature {
  return {
    id: "c1",
    peak: [15, 50],
    headingDeg: 90,
    speedKmh: 60,
    maxDbz: 50,
    motionSource: "radar-track",
  } as RadarProgressFeature;
}

describe("radarSliderCache", () => {
  it("vrátí přednačtený krok okamžitě", () => {
    clearSliderRasterCache();
    const hist: RadarRasterMeta = { ...live, url: "blob:h" };
    seedSliderRasterCache(-25, hist);
    const out = getSliderRaster(-25, {
      timeOffsetMinutes: -25,
      productIso: "2026-07-21T12:20:00Z",
      nowMs: Date.now(),
      liveRaster: live,
      radarHistory: null,
      historyLoad: null,
      radarProgress: [cell()],
      intensForecasts: new Map(),
    });
    expect(out?.url).toBe("blob:h");
    expect(sliderCacheSize()).toBe(1);
  });

  it("nevrací live URL pro historii, když cache chybí", () => {
    clearSliderRasterCache();
    const out = getSliderRaster(-20, {
      timeOffsetMinutes: -20,
      productIso: "2026-07-21T12:20:00Z",
      nowMs: Date.now(),
      liveRaster: live,
      radarHistory: null,
      historyLoad: null,
      radarProgress: [cell()],
      intensForecasts: new Map(),
    });
    expect(out).toBeNull();
  });
});
