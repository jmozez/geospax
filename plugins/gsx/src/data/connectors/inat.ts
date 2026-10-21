import type { Citation, ConnectorMeta, FetchParams } from "../types";
export const INAT_META: ConnectorMeta = {
  id: "inat",
  tier: "live",
  label: "iNaturalist Observations",
  citation: {
    title: "iNaturalist Research-grade Observations",
    publisher: "iNaturalist",
    year: 2024,
    url: "https://www.inaturalist.org",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export function inatSearchUrl(
  taxon: string,
  bbox?: [number, number, number, number],
  limit = 100,
): string {
  const u = new URL("https://api.inaturalist.org/v1/observations");
  if (taxon) u.searchParams.set("taxon_name", taxon);
  if (bbox)
    (u.searchParams.set("nelat", String(bbox[3])),
      u.searchParams.set("nelng", String(bbox[2])),
      u.searchParams.set("swlat", String(bbox[1])),
      u.searchParams.set("swlng", String(bbox[0])));
  u.searchParams.set("per_page", String(Math.max(1, Math.min(200, limit))));
  u.searchParams.set("quality_grade", "research");
  return u.toString();
}
export async function fetchInatObservations(
  params: FetchParams & { taxon: string },
): Promise<{ url: string; citation: Citation; geojson: GeoJSON.FeatureCollection }> {
  const url = inatSearchUrl(params.taxon, params.bbox, params.limit ?? 100);
  const res = await fetch(url, { signal: params.signal, headers: { Accept: "application/json" } });
  if (!res.ok)
    throw new Error(`iNat ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const data = (await res.json()) as {
    results: Array<{
      geojson?: { coordinates: [number, number] };
      location?: string;
      taxon?: { name: string };
      observed_on?: string;
    }>;
  };
  const features: GeoJSON.Feature[] = (data.results ?? [])
    .map((r) => {
      let lon: number | null = null,
        lat: number | null = null;
      if (r.geojson?.coordinates) {
        [lon, lat] = r.geojson.coordinates;
      } else if (r.location) {
        const p = r.location.split(",");
        lat = Number(p[0]);
        lon = Number(p[1]);
      }
      if (!Number.isFinite(lon!) || !Number.isFinite(lat!)) return null;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon!, lat!] },
        properties: {
          scientificName: r.taxon?.name ?? params.taxon,
          observed_on: r.observed_on ?? null,
          source: "iNaturalist",
        },
      } as GeoJSON.Feature;
    })
    .filter(Boolean) as GeoJSON.Feature[];
  return { url, citation: INAT_META.citation, geojson: { type: "FeatureCollection", features } };
}
