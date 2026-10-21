import type { ConnectorMeta } from "../types";
export const SPREP_META: ConnectorMeta = {
  id: "sprep",
  tier: "catalogue",
  label: "SPREP Pacific Environment",
  citation: {
    title: "Inform Data Portal",
    publisher: "SPREP",
    year: 2024,
    url: "https://pacific-data.sprep.org",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export const SPREP_CATALOGUE = [
  { id: "pacific-protected-areas", title: "Pacific Protected Areas", format: "GeoJSON" },
  { id: "pacific-mangroves", title: "Pacific Mangroves", format: "GeoParquet" },
] as const;
