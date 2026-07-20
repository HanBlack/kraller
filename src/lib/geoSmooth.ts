import type { Feature, FeatureCollection, Polygon, Position } from "geojson";

/** Chaikin corner-cutting — 1 iterace = jemnější obrys bez velké změny plochy. */
export function chaikinSmoothRing(
  ring: Position[],
  iterations = 1,
): Position[] {
  if (ring.length < 4) return ring;
  let pts = ring.slice();
  // Uzavřený ring: poslední = první
  if (
    pts.length > 1 &&
    pts[0]![0] === pts[pts.length - 1]![0] &&
    pts[0]![1] === pts[pts.length - 1]![1]
  ) {
    pts = pts.slice(0, -1);
  }
  for (let iter = 0; iter < iterations; iter++) {
    const next: Position[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      next.push([
        0.75 * a[0]! + 0.25 * b[0]!,
        0.75 * a[1]! + 0.25 * b[1]!,
      ]);
      next.push([
        0.25 * a[0]! + 0.75 * b[0]!,
        0.25 * a[1]! + 0.75 * b[1]!,
      ]);
    }
    pts = next;
  }
  const first = pts[0]!;
  return [...pts, [first[0]!, first[1]!]];
}

export function smoothPolygon(polygon: Polygon, iterations = 1): Polygon {
  return {
    type: "Polygon",
    coordinates: polygon.coordinates.map((ring) =>
      chaikinSmoothRing(ring, iterations),
    ),
  };
}

/** Vyhladí polygon features — Point/LineString nechá. */
export function smoothPolygonFeatures(
  fc: FeatureCollection,
  iterations = 1,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: fc.features.map((f): Feature => {
      if (f.geometry?.type !== "Polygon") return f;
      return {
        ...f,
        geometry: smoothPolygon(f.geometry, iterations),
      };
    }),
  };
}
