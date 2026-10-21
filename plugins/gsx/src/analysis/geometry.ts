// Geometry helpers shared across the GeoSpaX analysis modules.
//
// Ported from GeoSpaX v1 (jm0535/map-kit, js/geospax-conservation.js) with the
// same failure philosophy: bad geometry is skipped and reported, never fatal,
// and never silently changes the method that ran.

import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";

/**
 * The loose feature type GeoLibre's store APIs hand out
 * (`Feature<Geometry | null>`); every public signature here accepts it so
 * plugin code never needs casts. Null geometries are filtered by
 * {@link polygonsOnly} / handled as zero-area by the measurement functions.
 */
export type AnyFeature = Feature<Geometry | null>;

/** Wrap a feature list in a FeatureCollection (null geometries allowed). */
export function fc(features: AnyFeature[] | null | undefined): FeatureCollection<Geometry | null> {
  return { type: "FeatureCollection", features: features ?? [] };
}

/** Whether a feature carries a Polygon or MultiPolygon geometry. */
export function isPolygonal(
  f: AnyFeature | null | undefined,
): f is Feature<Polygon | MultiPolygon> {
  return (
    !!f && !!f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );
}

export interface PolygonFilterResult {
  /** The polygonal features, in input order. */
  polys: Feature<Polygon | MultiPolygon>[];
  /** How many input features were dropped for not being polygonal. */
  skipped: number;
}

/** Keep only polygonal features; count what was dropped (v1 GSX.polygonsOnly). */
export function polygonsOnly(features: AnyFeature[] | null | undefined): PolygonFilterResult {
  const polys: Feature<Polygon | MultiPolygon>[] = [];
  let skipped = 0;
  for (const f of features ?? []) {
    if (isPolygonal(f)) polys.push(f);
    else skipped++;
  }
  return { polys, skipped };
}

/** Prefix a feature's property keys to avoid collisions in overlay outputs. */
export function prefixProps(
  props: Record<string, unknown> | null | undefined,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k.startsWith("_")) continue; // internal keys stay internal
    out[`${prefix}_${k}`] = v;
  }
  return out;
}

/** Mean Earth radius in metres used by Turf's haversine helpers. */
export const EARTH_RADIUS_M = 6371008.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine distance between two [lon, lat] positions, in metres. Matches
 * Turf's `distance(..., {units: "metres"})` (same radius, same formula), so
 * perimeters computed here agree with v1's `turf.length(polygonToLine(f))`.
 */
export function haversineM(a: number[], b: number[]): number {
  const dLon = toRad(b[0] - a[0]);
  const dLat = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Haversine length of a linear ring or line, in metres. */
export function ringLengthM(ring: number[][]): number {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) total += haversineM(ring[i], ring[i + 1]);
  return total;
}

/** Every ring of a polygonal geometry (outer rings and holes). */
export function allRings(geometry: Geometry | null | undefined): number[][][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates as number[][][];
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as number[][][][]).flat();
  }
  return [];
}
