import type { ConnectorMeta } from "../types";
export const GEBCO_META: ConnectorMeta = {
  id: "gebco",
  tier: "catalogue",
  label: "GEBCO Bathymetry",
  citation: {
    title: "GEBCO Gridded Bathymetry",
    publisher: "GEBCO",
    year: 2024,
    url: "https://www.gebco.net",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export function gebcoTileUrl(z: number, x: number, y: number): string {
  return `https://tiles.gebco.net/gebco/${z}/${x}/${y}.png`;
}
export const GEBCO_TIERS = ["gebco-2024", "gebco-polar", "gebco-sub-ice"] as const;
