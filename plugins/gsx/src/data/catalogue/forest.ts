import type { ConnectorMeta } from "../types";
export const FOREST_META: ConnectorMeta = {
  id: "forest",
  tier: "catalogue",
  label: "Forest Catalogue (Hansen/GFW)",
  citation: {
    title: "Hansen Global Forest Change",
    publisher: "UMD/GLAD",
    year: 2023,
    url: "https://earthenginepartners.appspot.com/science-2013-global-forest",
    accessedAt: new Date().toISOString().slice(0, 10),
  },
};
export const FOREST_LAYERS = [
  { id: "hansen-treecover-2000", year: 2000, res: "30m" },
  { id: "hansen-loss-year", year: null, res: "30m" },
  { id: "gfw-deforestation-alerts", year: null, res: "10m" },
] as const;
