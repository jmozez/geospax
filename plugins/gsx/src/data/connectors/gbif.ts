import type { Citation, ConnectorMeta, FetchParams } from "../types";

export const GBIF_META: ConnectorMeta = {
  id: "gbif",
  tier: "live",
  label: "GBIF Occurrences",
  citation: {
    title: "GBIF Occurrence Download",
    publisher: "GBIF",
    year: 2024,
    doi: "10.15468/dl.example",
    url: "https://www.gbif.org/occurrence/search",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};

export function gbifSearchUrl(
  taxon: string,
  bbox?: [number, number, number, number],
  limit = 100,
): string {
  const u = new URL("https://api.gbif.org/v1/occurrence/search");
  if (taxon) u.searchParams.set("scientificName", taxon);
  if (bbox) {
    const [w, s, e, n] = bbox;
    u.searchParams.set("decimalLongitude", `${w},${e}`);
    u.searchParams.set("decimalLatitude", `${s},${n}`);
  }
  u.searchParams.set("limit", String(Math.max(1, Math.min(300, limit))));
  u.searchParams.set("hasCoordinate", "true");
  return u.toString();
}

export function gbifCitation(): string {
  return `${GBIF_META.citation.publisher} (${GBIF_META.citation.year}). ${GBIF_META.citation.title}.`;
}

/** Live fetch — GBIF occurrence search → GeoJSON points, citation-carried. */
export async function fetchGbifOccurrences(
  params: FetchParams & { taxon: string },
): Promise<{ url: string; citation: Citation; geojson: GeoJSON.FeatureCollection }> {
  const url = gbifSearchUrl(params.taxon, params.bbox, params.limit ?? 100);
  const res = await fetch(url, { signal: params.signal, headers: { Accept: "application/json" } });
  if (!res.ok)
    throw new Error(`GBIF ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const data = (await res.json()) as {
    results: Array<{
      decimalLongitude: number;
      decimalLatitude: number;
      scientificName?: string;
      basisOfRecord?: string;
      eventDate?: string;
      datasetKey?: string;
    }>;
  };
  const features: GeoJSON.Feature[] = (data.results ?? [])
    .filter((r) => Number.isFinite(r.decimalLongitude) && Number.isFinite(r.decimalLatitude))
    .map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.decimalLongitude, r.decimalLatitude] },
      properties: {
        scientificName: r.scientificName ?? params.taxon,
        basisOfRecord: r.basisOfRecord ?? null,
        eventDate: r.eventDate ?? null,
        datasetKey: r.datasetKey ?? null,
        source: "GBIF",
      },
    }));
  return { url, citation: GBIF_META.citation, geojson: { type: "FeatureCollection", features } };
}
