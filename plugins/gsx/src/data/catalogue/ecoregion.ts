import type { ConnectorMeta } from "../types";
export const ECOREGION_META: ConnectorMeta = {
  id: "ecoregion",
  tier: "catalogue",
  label: "WWF Ecoregions (Terrestrial + Marine)",
  citation: {
    title: "Terrestrial Ecoregions of the World + Marine Ecoregions",
    publisher: "WWF/TNC",
    year: 2023,
    url: "https://www.worldwildlife.org/publications/terrestrial-ecoregions-of-the-world",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export const ECOREGION_CATALOGUE = [
  { id: "teow-846", count: 846, realm: "Terrestrial", label: "TEOW 846 ecoregions" },
  { id: "meow-232", count: 232, realm: "Marine", label: "MEOW 232 ecoregions" },
  { id: "ppow-62", count: 62, realm: "Pelagic", label: "PPOW 62 provinces" },
] as const;
export function ecoregionFeatureCount(id: string): number | null {
  return ECOREGION_CATALOGUE.find((c) => c.id === id)?.count ?? null;
}
