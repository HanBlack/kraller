import { czechRegionLabel } from "./czechRegion";

type ReverseResult = {
  display_name: string;
  address?: {
    village?: string;
    town?: string;
    city?: string;
    municipality?: string;
    suburb?: string;
    county?: string;
  };
};

function shortFromReverse(hit: ReverseResult): string {
  const a = hit.address;
  return (
    a?.village ||
    a?.town ||
    a?.city ||
    a?.municipality ||
    a?.suburb ||
    a?.county ||
    hit.display_name.split(",")[0]?.trim() ||
    czechRegionLabel(0, 0)
  );
}

/** Reverzní geokód — fallback na region při chybě / rate limitu. */
export async function reverseGeocodePlace(
  lat: number,
  lon: number,
): Promise<string> {
  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: "json",
      addressdetails: "1",
      zoom: "10",
    });
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return czechRegionLabel(lat, lon);
    const data = (await res.json()) as ReverseResult;
    return shortFromReverse(data);
  } catch {
    return czechRegionLabel(lat, lon);
  }
}
