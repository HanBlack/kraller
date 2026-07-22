import { describe, expect, it } from "vitest";
import { scoreFormation } from "./scoreFormation";
import type { EnvironmentSignals } from "./types";

function env(partial: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return {
    capeJkg: 500,
    dewpointC: 15,
    shear0to6Ms: 14,
    srh01: 90,
    cloudTopCoolingCPer15min: -3,
    coolingSource: "model",
    liftedIndexC: -2,
    ...partial,
  };
}

describe("scoreFormation — coolingSource", () => {
  it("model proxy neříká satelit", () => {
    const a = scoreFormation(env({ coolingSource: "model" }));
    expect(a.reasons.some((r) => /model/i.test(r))).toBe(true);
    expect(a.reasons.some((r) => /satelit/i.test(r))).toBe(false);
  });

  it("satellite reason poctivě", () => {
    const a = scoreFormation(env({ coolingSource: "satellite" }));
    expect(a.reasons.some((r) => /satelit/i.test(r))).toBe(true);
  });
});
