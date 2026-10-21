import type { Citation, ConnectorMeta } from "../types";
export const WORLDBANK_META: ConnectorMeta = {
  id: "worldbank",
  tier: "live",
  label: "World Bank Indicators",
  citation: {
    title: "World Development Indicators",
    publisher: "World Bank",
    year: 2024,
    url: "https://data.worldbank.org",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export function worldbankUrl(country: string, indicator: string, from = 2015, to = 2024): string {
  const u = new URL(`https://api.worldbank.org/v2/country/${country}/indicator/${indicator}`);
  u.searchParams.set("format", "json");
  u.searchParams.set("date", `${from}:${to}`);
  u.searchParams.set("per_page", "100");
  return u.toString();
}
export async function fetchWorldBankIndicator(
  country: string,
  indicator: string,
  opts: { from?: number; to?: number; signal?: AbortSignal } = {},
): Promise<{ url: string; citation: Citation; rows: unknown[] }> {
  const url = worldbankUrl(country, indicator, opts.from ?? 2015, opts.to ?? 2024);
  const res = await fetch(url, { signal: opts.signal, headers: { Accept: "application/json" } });
  if (!res.ok)
    throw new Error(`WorldBank ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const data = (await res.json()) as unknown[];
  const rows = Array.isArray(data) && Array.isArray(data[1]) ? (data[1] as unknown[]) : [];
  return { url, citation: WORLDBANK_META.citation, rows };
}
