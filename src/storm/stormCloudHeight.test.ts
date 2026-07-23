import { describe, expect, it } from "vitest";
import {
  formatCloudHeightKm,
  resolveCloudHeight,
  roundCloudHeightKm,
} from "./stormCloudHeight";

describe("stormCloudHeight", () => {
  it("preferuje satelitní CTH", () => {
    const h = resolveCloudHeight({
      cloudTopHeightM: 15200,
      echoTopKm: 11,
    });
    expect(h).toEqual({ km: 15.2, source: "satellite" });
  });

  it("padá na radar echo top", () => {
    const h = resolveCloudHeight({ echoTopKm: 12.34 });
    expect(h).toEqual({ km: 12.3, source: "radar" });
  });

  it("formátuje ~X.X km", () => {
    expect(formatCloudHeightKm(15.24)).toBe("~15.2 km");
    expect(roundCloudHeightKm(15.26)).toBe(15.3);
  });

  it("ignoruje příliš nízké hodnoty", () => {
    expect(resolveCloudHeight({ cloudTopHeightM: 2500 })).toBeNull();
    expect(resolveCloudHeight({ echoTopKm: 3.5 })).toBeNull();
  });
});
