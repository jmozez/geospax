// Provenance stamps - the v1 audit's structural guarantee.
//
// Every GeoSpaX analysis result declares the tool, the method that actually
// ran, the CRS it refers to, the parameters used, and when it ran. Stamps
// travel inside result-layer properties (`_geospax`) so exports, reports and
// project files cannot lose the methodology, and a result can never claim a
// method it did not use.

/** Bumped with packages/geospax-analysis/package.json — GeoSpaX v2 lineage (v1.4.3 → 2.0.0 platform rewrite). */
export const GEOSPAX_ANALYSIS_VERSION = "2.0.0";

export interface ProvenanceStamp {
  /** Tool identifier, e.g. "protection-gap". */
  tool: string;
  /** The method that actually ran, e.g. "Equal-area (LAEA)". */
  method: string;
  /** CRS/projection the method refers to. */
  crs: string;
  /** User-visible parameters (cell size, thresholds, layer names, ...). */
  params: Record<string, unknown>;
  /** ISO timestamp of the run. */
  runAt: string;
  /** Engine that produced the result. */
  engine: "@geospax/analysis";
  /** Engine version. */
  version: string;
  /** Source lineage of the ported algorithm. */
  lineage: string;
}

const LINEAGE = "GeoSpaX v1 (jm0535/map-kit) conservation roadmap, audit-fixed implementations";

export function makeProvenance(
  tool: string,
  method: string,
  crs: string,
  params: Record<string, unknown> = {},
): ProvenanceStamp {
  return {
    tool,
    method,
    crs,
    params,
    runAt: new Date().toISOString(),
    engine: "@geospax/analysis",
    version: GEOSPAX_ANALYSIS_VERSION,
    lineage: LINEAGE,
  };
}

/** Property key under which stamps are stored on result features/layers. */
export const PROVENANCE_KEY = "_geospax";
