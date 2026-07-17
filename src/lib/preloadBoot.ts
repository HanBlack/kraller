export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

/** Zahřeje styl mapy (JSON + sprite) — rychlejší první vykreslení MapLibre. */
export async function preloadMapStyle(
  styleUrl = MAP_STYLE_URL,
): Promise<void> {
  try {
    const res = await fetch(styleUrl, { cache: "force-cache" });
    if (!res.ok) return;
    const style = (await res.json()) as { sprite?: string };
    if (!style.sprite) return;
    await Promise.all([
      fetch(`${style.sprite}.json`, { cache: "force-cache" }).catch(() => {}),
      fetch(`${style.sprite}.png`, { cache: "force-cache" }).catch(() => {}),
    ]);
  } catch {
    /* volitelné zahřátí */
  }
}
