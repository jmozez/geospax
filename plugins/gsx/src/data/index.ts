// @geospax/data — tiered citation-carrying connectors and catalogue tiers.

export * from "./types";
export * from "./connectors/gbif";
export * from "./connectors/obis";
export * from "./connectors/inat";
export * from "./connectors/worms";
export * from "./connectors/worldbank";
export * from "./catalogue/sprep";
export * from "./catalogue/gebco";
export * from "./catalogue/ecoregion";
export * from "./catalogue/forest";
export * from "./catalogue/marine";

import { GBIF_META } from "./connectors/gbif";
import { OBIS_META } from "./connectors/obis";
import { INAT_META } from "./connectors/inat";
import { WORMS_META } from "./connectors/worms";
import { WORLDBANK_META } from "./connectors/worldbank";
import { GEBCO_META } from "./catalogue/gebco";
import { ECOREGION_META } from "./catalogue/ecoregion";
import { FOREST_META } from "./catalogue/forest";
import { MARINE_META } from "./catalogue/marine";
import { SPREP_META } from "./catalogue/sprep";
import type { ConnectorMeta } from "./types";

export const CONNECTORS: ConnectorMeta[] = [
  GBIF_META,
  OBIS_META,
  INAT_META,
  WORMS_META,
  WORLDBANK_META,
];
export const CATALOGUE_TIERS: ConnectorMeta[] = [
  GEBCO_META,
  ECOREGION_META,
  FOREST_META,
  MARINE_META,
  SPREP_META,
];
export const ALL_SOURCES: ConnectorMeta[] = [...CONNECTORS, ...CATALOGUE_TIERS];
