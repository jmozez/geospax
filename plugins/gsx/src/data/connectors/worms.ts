import type { Citation, ConnectorMeta } from "../types";
export const WORMS_META: ConnectorMeta = {
  id: "worms",
  tier: "live",
  label: "WoRMS Taxonomy",
  citation: {
    title: "World Register of Marine Species",
    publisher: "WoRMS",
    year: 2024,
    url: "https://www.marinespecies.org",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export function wormsAphiaUrl(taxon: string): string {
  const u = new URL(
    "https://www.marinespecies.org/rest/AphiaRecordsByName/" + encodeURIComponent(taxon),
  );
  u.searchParams.set("like", "false");
  u.searchParams.set("marine_only", "false");
  return u.toString();
}
export async function fetchWormsAphia(
  taxon: string,
  signal?: AbortSignal,
): Promise<{ url: string; citation: Citation; records: unknown[] }> {
  const url = wormsAphiaUrl(taxon);
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok)
    throw new Error(`WoRMS ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const records = (await res.json()) as unknown[];
  return {
    url,
    citation: WORMS_META.citation,
    records: Array.isArray(records) ? records : [records].filter(Boolean),
  };
}
