/**
 * Round-trip slider: Teď → −30 → Teď musí vrátit live URL.
 * node scripts/bench-time-slider.mjs
 */
import { chromium } from "playwright";

const URL = process.env.RADAR_URL ?? "http://localhost:5173/";

async function waitReady(page) {
  await page.waitForFunction(
    () => !document.querySelector(".boot-screen"),
    { timeout: 180_000 },
  );
  await page.waitForSelector("input.time-slider", {
    state: "attached",
    timeout: 60_000,
  });
  await page.evaluate(() => {
    document.querySelectorAll(".collapsible-section-toggle").forEach((btn) => {
      if (btn.getAttribute("aria-expanded") === "false") btn.click();
    });
  });
  await page.waitForTimeout(2500);
  await page
    .waitForFunction(() => (window.__radarDebug?.(0)?.cacheSize ?? 0) >= 4, {
      timeout: 90_000,
    })
    .catch(() => {});
}

async function scrub(page, offset) {
  await page.evaluate((v) => {
    const input = document.querySelector("input.time-slider");
    if (!input) throw new Error("no slider");
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, offset);
  await page.waitForTimeout(150);
  return page.evaluate((v) => window.__radarDebug?.(v) ?? null, offset);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await waitReady(page);

  const at0 = await scrub(page, 0);
  const liveUrl = at0?.active;
  console.log("Teď start:", liveUrl?.slice(0, 48), "cache", at0?.cacheSize);

  const down = [-5, -10, -15, -20, -25, -30];
  let prev = liveUrl;
  for (const o of down) {
    const d = await scrub(page, o);
    const url = d?.active;
    const changed = url && url !== prev;
    console.log(`→ ${o}: changed=${changed} ${url?.slice(0, 40)}`);
    if (!changed) {
      console.error("FAIL: no change going into past");
      process.exit(1);
    }
    prev = url;
  }

  const up = [-25, -20, -15, -10, -5, 0];
  for (const o of up) {
    const d = await scrub(page, o);
    const url = d?.active;
    const changed = url && url !== prev;
    console.log(`← ${o}: changed=${changed} ${url?.slice(0, 40)}`);
    if (!url) {
      console.error("FAIL: missing url on return");
      process.exit(1);
    }
    if (o === 0) {
      if (url !== liveUrl) {
        console.error("FAIL: Teď did not restore live URL");
        console.error(" expected", liveUrl);
        console.error(" got     ", url);
        process.exit(1);
      }
      console.log("OK: Teď restored live URL");
    } else if (!changed) {
      console.error("FAIL: stuck on return path at", o);
      process.exit(1);
    }
    prev = url;
  }

  // second round-trip
  await scrub(page, -30);
  const back = await scrub(page, 0);
  if (back?.active !== liveUrl) {
    console.error("FAIL: second return to Teď");
    process.exit(1);
  }
  console.log("OK: second round-trip Teď");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
