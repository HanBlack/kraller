import { angleDiffDeg, bearingDeg, destinationPoint, distanceKm } from "../lib/geo";
import type { FormationZone } from "./demo";
import type { RadarProgressFeature } from "./radarCells";

export type FormationCellLink = {
  zoneId: string;
  cellId: string;
  distanceKm: number;
  zoneLat: number;
  zoneLon: number;
  cellLon: number;
  cellLat: number;
  /** Jak vznikl vztah: buňka ještě v zóně / stopa vede ze zóny. */
  reason: "in-zone" | "from-zone";
};

/** Max. vzdálenost: echo ještě „vzniklo tady“ (uvnitř/u okraje zóny). */
const IN_ZONE_MAX_KM = 28;

/**
 * Max. vzdálenost pro „buňka přijela ze zóny“ — zpětná stopa musí
 * projít blízko středu zóny. Ne 95 km „někde po větru“.
 */
const FROM_ZONE_PASS_KM = 22;
const FROM_ZONE_MAX_TRAVEL_KM = 55;
const FROM_ZONE_MAX_ANGLE = 40;

/**
 * Propojí Vznik ↔ radarovou buňku jen když dává smysl:
 *
 * 1) in-zone  — echo je pořád blízko zóny vzniku (právě se tu zrodilo)
 * 2) from-zone — zpětná trajektorie buňky prochází zónou (přišlo ODTUD)
 *
 * Nespojuje vzdálené nesouvisející mračko s cizí zónou „po větru“.
 */
export function linkFormationToRadarCells(
  zones: FormationZone[],
  cells: RadarProgressFeature[],
  _wind?: unknown,
): FormationCellLink[] {
  if (!cells.length || !zones.length) return [];

  const links: FormationCellLink[] = [];
  const usedCells = new Set<string>();

  for (const zone of zones) {
    const zoneR = Math.max(zone.radiusKm ?? 12, 10);
    let best: FormationCellLink | null = null;
    let bestScore = Infinity;

    for (const cell of cells) {
      if (usedCells.has(cell.id)) continue;
      const [cellLon, cellLat] = cell.peak;
      const dist = distanceKm(zone.lat, zone.lon, cellLat, cellLon);

      // 1) Echo ještě v / u zóny vzniku
      if (dist <= Math.max(IN_ZONE_MAX_KM, zoneR * 1.35)) {
        const score = dist;
        if (score < bestScore) {
          bestScore = score;
          best = {
            zoneId: zone.id,
            cellId: cell.id,
            distanceKm: dist,
            zoneLat: zone.lat,
            zoneLon: zone.lon,
            cellLon,
            cellLat,
            reason: "in-zone",
          };
        }
        continue;
      }

      // 2) Zpětná stopa: kam by buňka byla před X min
      const speed = Math.max(cell.speedKmh, 8);
      const lookbackMin = Math.min(
        50,
        Math.max(cell.historyMinutes || 0, 20),
      );
      const travelKm = Math.min(
        FROM_ZONE_MAX_TRAVEL_KM,
        (speed * lookbackMin) / 60,
      );
      if (travelKm < 8) continue;

      // Směr odkud přijela = opačný k aktuálnímu pohybu
      const fromHeading = (cell.headingDeg + 180) % 360;
      const origin = destinationPoint(cellLat, cellLon, fromHeading, travelKm);
      const passDist = distanceKm(zone.lat, zone.lon, origin[1], origin[0]);
      if (passDist > FROM_ZONE_PASS_KM) continue;

      // Buňka musí od zóny zhruba jet směrem svého tracku
      const leaveBearing = bearingDeg(zone.lat, zone.lon, cellLat, cellLon);
      if (angleDiffDeg(leaveBearing, cell.headingDeg) > FROM_ZONE_MAX_ANGLE) {
        continue;
      }

      const score = 40 + passDist + dist * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = {
          zoneId: zone.id,
          cellId: cell.id,
          distanceKm: dist,
          zoneLat: zone.lat,
          zoneLon: zone.lon,
          cellLon,
          cellLat,
          reason: "from-zone",
        };
      }
    }

    if (best) {
      links.push(best);
      usedCells.add(best.cellId);
    }
  }

  return links;
}
