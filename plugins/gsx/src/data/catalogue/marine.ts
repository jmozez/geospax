import type { ConnectorMeta } from "../types";
export const MARINE_META: ConnectorMeta = {
  id: "marine",
  tier: "catalogue",
  label: "Marine Catalogue (OBIS/Allen Coral)",
  citation: {
    title: "Allen Coral Atlas + OBIS",
    publisher: "ASU/OBIS",
    year: 2024,
    url: "https://allencoralatlas.org",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export const MARINE_LAYERS = [
  { id: "coral-reef-extent", type: "vector" },
  { id: "mangrove-watch", type: "raster" },
] as const;
