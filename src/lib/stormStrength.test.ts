import { describe, expect, it } from "vitest";
import {
  formatCoreStrengthLabel,
  formatWatchStrengthLine,
} from "./stormStrength";

describe("stormStrength", () => {
  it("jádro: lidská síla + mm/h", () => {
    const s = formatCoreStrengthLabel(52, "strong", "cs");
    expect(s).toMatch(/Silná/);
    expect(s).toMatch(/mm\/h/);
    expect(s).not.toMatch(/dBZ/);
  });

  it("slabé echo bez mm/h tabulky → dBZ fallback", () => {
    const s = formatCoreStrengthLabel(32, "weak", "cs");
    expect(s).toMatch(/Slabá/);
  });

  it("watch řádek: síla · zásah · déšť", () => {
    const s = formatWatchStrengthLine({
      severity: "strong",
      hitType: "core",
      atUserDbz: 55,
      rainMmPerHour: [28, 46],
      locale: "cs",
    });
    expect(s).toContain("Silná bouřka");
    expect(s).toContain("zásah jádra");
    expect(s).toContain("28");
    expect(s).toContain("46");
  });
});
