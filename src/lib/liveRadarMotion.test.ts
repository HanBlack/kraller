import { describe, expect, it } from "vitest";
import {
  LIVE_ADVECT_CAP_MIN,
  liveExtrapolationMinutes,
  motionMinutesForView,
  radarProductAgeMinutes,
} from "./liveRadarMotion";

describe("liveRadarMotion", () => {
  const t0 = Date.parse("2026-07-21T12:00:00Z");

  it("age from product time", () => {
    expect(
      radarProductAgeMinutes("2026-07-21T11:55:00Z", t0),
    ).toBeCloseTo(5, 5);
  });

  it("Teď a historie = 0 motion (přesná data, ne odhad)", () => {
    expect(
      motionMinutesForView({
        timeOffsetMinutes: 0,
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBe(0);
    expect(
      motionMinutesForView({
        timeOffsetMinutes: -15,
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBe(0);
  });

  it("kladný offset = scrub stopy (ne PNG predikce)", () => {
    expect(
      motionMinutesForView({
        timeOffsetMinutes: 10,
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBe(10);
  });

  it("liveExtrapolationMinutes = věk snímku (UI)", () => {
    expect(
      liveExtrapolationMinutes({
        productIso: "2026-07-21T11:50:00Z",
        nowMs: t0,
      }),
    ).toBeCloseTo(10, 5);
    expect(
      liveExtrapolationMinutes({
        productIso: "2026-07-21T11:00:00Z",
        nowMs: t0,
      }),
    ).toBe(LIVE_ADVECT_CAP_MIN);
  });
});
