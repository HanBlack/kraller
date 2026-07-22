import { describe, expect, it } from "vitest";
import type { RadarProgressFeature } from "../storm/radarCells";
import type { RadarHistoryManifest } from "./radarHistory";
import { resolveRadarViewRaster } from "./radarViewRaster";
import type { RadarRasterMeta } from "./radarRaster";

const manifest: RadarHistoryManifest = {
  frameMinutes: 5,
  frames: [
    {
      index: 0,
      offsetMinutes: -30,
      time: "20260721121500",
      path: "data/opera/history/frame-0.geojson",
      rasterPath: "data/opera/history/frame-0-raster.json",
    },
    {
      index: 5,
      offsetMinutes: -5,
      time: "20260721124000",
      path: "data/opera/history/frame-5.geojson",
      rasterPath: "data/opera/history/frame-5-raster.json",
    },
  ],
};

const liveRaster: RadarRasterMeta = {
  url: "blob:live",
  coordinates: [
    [11, 52],
    [20, 52],
    [20, 48],
    [11, 48],
  ],
  time: "20260721124500",
};

const histRaster5: RadarRasterMeta = {
  url: "blob:hist-5",
  coordinates: liveRaster.coordinates,
  time: "20260721124000",
};

function cell(id: string): RadarProgressFeature {
  return {
    id,
    peak: [15, 50],
    headingDeg: 90,
    speedKmh: 60,
    maxDbz: 50,
    motionSource: "radar-track",
  } as RadarProgressFeature;
}

describe("resolveRadarViewRaster", () => {
  it("Teď = přesný live PNG, bez evolve", () => {
    const out = resolveRadarViewRaster({
      timeOffsetMinutes: 0,
      productIso: "2026-07-21T12:20:00Z",
      nowMs: Date.parse("2026-07-21T12:30:00Z"),
      liveRaster,
      radarHistory: manifest,
      historyLoad: null,
      radarProgress: [cell("c1")],
      intensForecasts: new Map(),
    });
    expect(out.needsAlgorithmicEvolve).toBe(false);
    expect(out.displayRaster?.url).toBe("blob:live");
    expect(out.motionMinutes).toBe(0);
  });

  it("+5 neevoluje raster (predikce vzhledu vypnutá)", () => {
    const out = resolveRadarViewRaster({
      timeOffsetMinutes: 5,
      productIso: "2026-07-21T12:20:00Z",
      nowMs: Date.parse("2026-07-21T12:30:00Z"),
      liveRaster,
      radarHistory: manifest,
      historyLoad: null,
      radarProgress: [cell("c1")],
      intensForecasts: new Map(),
    });
    expect(out.needsAlgorithmicEvolve).toBe(false);
    expect(out.displayRaster?.url).toBe("blob:live");
  });

  it("−5 = archivní PNG", () => {
    const out = resolveRadarViewRaster({
      timeOffsetMinutes: -5,
      productIso: "2026-07-21T12:20:00Z",
      nowMs: Date.parse("2026-07-21T12:30:00Z"),
      liveRaster,
      radarHistory: manifest,
      historyLoad: {
        framePath: manifest.frames[1].path,
        radar: { type: "FeatureCollection", features: [] },
        raster: histRaster5,
      },
      radarProgress: [cell("c1")],
      intensForecasts: new Map(),
    });
    expect(out.useHistoricalRaster).toBe(true);
    expect(out.displayRaster?.url).toBe("blob:hist-5");
  });
});
