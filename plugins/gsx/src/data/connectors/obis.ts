import type { Citation, ConnectorMeta, FetchParams } from "../types";

export const OBIS_META: ConnectorMeta = {
  id: "obis",
  tier: "live",
  label: "OBIS Marine Occurrences",
  citation: {
    title: "Ocean Biodiversity Information System",
    publisher: "OBIS",
    year: 2024,
    url: "https://obis.org",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};

export function obisSearchUrl(
  taxon: string,
  bbox?: [number, number, number, number],
  limit = 100,
): string {
  const u = new URL("https://api.obis.org/v3/occurrence");
  if (taxon) u.searchParams.set("scientificname", taxon);
  if (bbox)
    u.searchParams.set(
      "geometry",
      `POLYGON((${bbox[0]} ${bbox[1]},${bbox[2]} ${bbox[1]},${bbox[2]} ${bbox[3]},${bbox[0]} ${bbox[3]},${bbox[0]} ${bbox[1]}))`,
    );
  u.searchParams.set("size", String(Math.max(1, Math.min(1000, limit))));
  return u.toString();
}

export async function fetchObisOccurrences(
  params: FetchParams & { taxon: string },
): Promise<{ url: string; citation: Citation; geojson: GeoJSON.FeatureCollection }> {
  const url = obisSearchUrl(params.taxon, params.bbox, params.limit ?? 100);
  const res = await fetch(url, { signal: params.signal, headers: { Accept: "application/json" } });
  if (!res.ok)
    throw new Error(`OBIS ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const data = (await res.json()) as {
    results: Array<{
      decimalLongitude: number;
      decimalLatitude: number;
      scientificName?: string;
      eventDate?: string;
    }>;
  };
  const features: GeoJSON.Feature[] = (data.results ?? [])
    .filter((r) => Number.isFinite(r.decimalLongitude) && Number.isFinite(r.decimalLatitude))
    .map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.decimalLongitude, r.decimalLatitude] },
      properties: {
        scientificName: r.scientificName ?? params.taxon,
        eventDate: r.eventDate ?? null,
        source: "OBIS",
      },
    }));
  return { url, citation: OBIS_META.citation, geojson: { type: "FeatureCollection", features } };
}
