// Shared connector types — tiered citation-carrying design.

export type ConnectorTier = "live" | "catalogue" | "token";
export type ConnectorId =
  | "gbif"
  | "obis"
  | "inat"
  | "worms"
  | "worldbank"
  | "sprep"
  | "gebco"
  | "ecoregion"
  | "forest"
  | "marine";

export interface Citation {
  title: string;
  publisher: string;
  year?: number;
  doi?: string;
  url?: string;
  accessedAt: string;
}

export interface ConnectorMeta {
  id: ConnectorId;
  tier: ConnectorTier;
  label: string;
  citation: Citation;
  requiresToken?: boolean;
}

export interface FetchParams {
  bbox?: [number, number, number, number]; // W,S,E,N
  taxon?: string;
  limit?: number;
  signal?: AbortSignal;
}

export function citationString(c: Citation): string {
  const doi = c.doi ? ` DOI:${c.doi}` : "";
  const year = c.year ? ` (${c.year})` : "";
  return `${c.publisher}${year}. ${c.title}.${doi} Accessed ${c.accessedAt}.`;
}
