// Protection gap analysis - GeoSpaX v1 P0-2 (js/geospax-conservation.js
// GSX.protectionGap), ported with the equal-area reporting mode (P1-4b) as
// the default measurement and provenance stamps on every result.
//
// Quantifies how much of a species' habitat / range falls inside protected
// areas and how much does not, which individual protected areas are
// involved, and a closure check that catches bad geometry instead of letting
// it pass silently.

import booleanIntersects from "@turf/boolean-intersects";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { polygonsOnly, type AnyFeature } from "./geometry";
import { differencePair, intersectPair, unionAll } from "./overlay";
import { makeProvenance, type ProvenanceStamp } from "./provenance";
import { measureArea, type AreaMeasurement, type AreaMethod } from "./units";

/** Property names probed for a protected-area's display name (v1 order). */
export const DEFAULT_PA_NAME_FIELDS = ["name", "NAME", "pa_name", "Name"] as const;

export interface ProtectionGapOptions {
  /**
   * Area measurement method. Defaults to "equalarea" (hectares first-class,
   * data-centred LAEA); falls back to an honestly-declared spherical
   * measurement when no projection can be derived.
   */
  areaMode?: AreaMethod;
  /** Property names probed for PA display names. */
  paNameFields?: readonly string[];
  /** Habitat layer name, recorded in provenance params. */
  habitatLayerName?: string;
  /** Protected-area layer name, recorded in provenance params. */
  paLayerName?: string;
}

export interface ProtectionGapResult {
  ok: true;
  /** habitat AND protected areas, as a single dissolved polygon (may be null on geometry failure). */
  protectedGeom: Feature<Polygon | MultiPolygon> | null;
  /** habitat MINUS protected areas (null when fully protected or on geometry failure). */
  gapGeom: Feature<Polygon | MultiPolygon> | null;
  totalAreaM2: number;
  protectedAreaM2: number;
  gapAreaM2: number;
  protectedPct: number;
  gapPct: number;
  /** How many individual PA polygons touch the habitat. */
  paCount: number;
  /** Display names of those PAs ("(unnamed)" when no name field matched). */
  paNames: string[];
  /**
   * Closure check: |protected + gap - total| / total, in %. Surfaced so bad
   * geometry cannot pass silently (v1 rule).
   */
  residualPct: number;
  /** Non-polygonal features dropped from each input. */
  skipped: { habitat: number; pa: number };
  /** Per-quantity measurements declaring the method that actually ran. */
  measurement: {
    total: AreaMeasurement;
    protected: AreaMeasurement;
    gap: AreaMeasurement;
  };
  provenance: ProvenanceStamp;
}

export interface ProtectionGapError {
  ok: false;
  error: string;
}

export type ProtectionGapOutcome = ProtectionGapResult | ProtectionGapError;

function paName(p: AnyFeature, fields: readonly string[]): string {
  const props = (p.properties ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    const v = props[f];
    if (typeof v === "string" && v.trim().length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return "(unnamed)";
}

/**
 * Run the protection gap analysis.
 *
 * @param habitatFeatures species habitat / range polygons
 * @param paFeatures      protected-area polygons
 */
export function protectionGap(
  habitatFeatures: AnyFeature[],
  paFeatures: AnyFeature[],
  options: ProtectionGapOptions = {},
): ProtectionGapOutcome {
  const areaMode: AreaMethod = options.areaMode ?? "equalarea";
  const nameFields = options.paNameFields ?? DEFAULT_PA_NAME_FIELDS;

  const hab = unionAll(habitatFeatures);
  if (!hab) return { ok: false, error: "Habitat layer contains no polygons." };
  const pas = unionAll(paFeatures);
  if (!pas) return { ok: false, error: "Protected-area layer contains no polygons." };

  const protectedGeom = intersectPair(hab, pas);
  const gapGeom = differencePair(hab, pas);

  // Measure everything under one projection so the closure check is exact.
  const totalM = measureArea([hab], areaMode);
  const protM = protectedGeom
    ? measureArea([protectedGeom], areaMode)
    : { m2: 0, method: totalM.method, crs: totalM.crs };
  const gapM = gapGeom
    ? measureArea([gapGeom], areaMode)
    : protectedGeom
      ? { m2: 0, method: totalM.method, crs: totalM.crs }
      : { ...totalM }; // no intersection computed at all: the gap is everything

  const totalM2 = totalM.m2;
  const protM2 = protM.m2;
  const gapM2 = gapM.m2;

  // Which individual PAs are actually involved - useful in reports (v1).
  const paNames: string[] = [];
  for (const p of polygonsOnly(paFeatures).polys) {
    let hit = false;
    try {
      hit = booleanIntersects(hab as never, p as never);
    } catch {
      hit = false;
    }
    if (hit) paNames.push(paName(p, nameFields));
  }

  if (protectedGeom) {
    protectedGeom.properties = {
      ...(protectedGeom.properties ?? {}),
      class: "protected",
      area_m2: protM2,
    };
  }
  if (gapGeom) {
    gapGeom.properties = { ...(gapGeom.properties ?? {}), class: "gap", area_m2: gapM2 };
  }

  return {
    ok: true,
    protectedGeom,
    gapGeom,
    totalAreaM2: totalM2,
    protectedAreaM2: protM2,
    gapAreaM2: gapM2,
    protectedPct: totalM2 > 0 ? (protM2 / totalM2) * 100 : 0,
    gapPct: totalM2 > 0 ? (gapM2 / totalM2) * 100 : 0,
    paCount: paNames.length,
    paNames,
    residualPct: totalM2 > 0 ? (Math.abs(protM2 + gapM2 - totalM2) / totalM2) * 100 : 0,
    skipped: {
      habitat: polygonsOnly(habitatFeatures).skipped,
      pa: polygonsOnly(paFeatures).skipped,
    },
    measurement: { total: totalM, protected: protM, gap: gapM },
    provenance: makeProvenance("protection-gap", totalM.method, totalM.crs, {
      areaMode,
      habitatLayer: options.habitatLayerName ?? null,
      paLayer: options.paLayerName ?? null,
      habitatFeatures: habitatFeatures.length,
      paFeatures: paFeatures.length,
    }),
  };
}
