// Area units and equal-area measurement - GeoSpaX v1 P0-3 ("hectares as a
// first-class unit") and P1-4b ("equal-area reporting mode"), ported from
// js/geospax-conservation.js and js/geospax-conservation-m2.js.
//
// Rigour rules carried over from the v1 audit:
//  - every measurement result declares the method that actually ran (no
//    silent fallbacks: if an equal-area projection cannot be derived, the
//    result says "Spherical (WGS84)", it does not pretend to be LAEA);
//  - formatting never rounds a sub-10 ha figure to an integer, which would
//    hide real change.

import turfArea from "@turf/area";
import turfBbox from "@turf/bbox";
import proj4 from "proj4";
import type { Feature, Geometry, MultiPolygon, Polygon } from "geojson";
import { allRings, fc, ringLengthM, type AnyFeature } from "./geometry";

const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

export type AreaUnitId = "ha" | "km2" | "m2";

export const AREA_UNITS: Record<AreaUnitId, { label: string; factor: number }> = {
  ha: { label: "ha", factor: 1 / 10000 },
  km2: { label: "km\u00b2", factor: 1 / 1e6 },
  m2: { label: "m\u00b2", factor: 1 },
};

export interface FormattedArea {
  /** The area converted to the requested unit (full precision). */
  value: number;
  /** Significant-figure text: 3 s.f. behaviour, sub-10 keeps 2 decimals. */
  text: string;
  /** Unit label ("ha", "km\u00b2", "m\u00b2"). */
  unit: string;
  /** `text` + " " + `unit`. */
  display: string;
}

/**
 * Deterministic thousands grouping (v1 used `toLocaleString`, which is
 * locale-dependent; reports must render identically everywhere).
 */
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Significant-figure area formatter (v1 GSX.formatArea). */
export function formatArea(m2: number, unit: AreaUnitId = "ha"): FormattedArea {
  const u = AREA_UNITS[unit] ?? AREA_UNITS.ha;
  const v = m2 * u.factor;
  let s: string;
  if (v === 0) s = "0";
  else if (v < 10) s = v.toFixed(2);
  else if (v < 1000) s = v.toFixed(1);
  else s = groupThousands(Math.round(v));
  return { value: v, text: s, unit: u.label, display: `${s} ${u.label}` };
}

/**
 * Spherical (WGS84) area of a Feature, FeatureCollection or geometry in m\u00b2,
 * via Turf's spherical-excess computation. Returns 0 for null/invalid input.
 */
export function areaM2(
  gj: AnyFeature | FeatureCollectionLike | Geometry | null | undefined,
): number {
  if (!gj) return 0;
  try {
    return turfArea(gj as never);
  } catch {
    return 0;
  }
}

type FeatureCollectionLike = ReturnType<typeof fc>;

export interface EqualAreaProjection {
  /** proj4 definition string (LAEA centred on the data). */
  proj: string;
  /** Human-readable label for reports ("LAEA centred -6.0000, 145.0000"). */
  label: string;
}

/**
 * Lambert Azimuthal Equal-Area projection centred on the data's bbox
 * (v1 GSX.laeaFor). Returns null when no finite bbox can be derived, which
 * callers must treat as "equal-area unavailable" rather than substituting a
 * different method silently.
 */
export function laeaFor(features: AnyFeature[] | null | undefined): EqualAreaProjection | null {
  let bbox: [number, number, number, number];
  try {
    bbox = turfBbox(fc(features) as never) as [number, number, number, number];
  } catch {
    return null;
  }
  if (!bbox || !Number.isFinite(bbox[0]) || !Number.isFinite(bbox[1])) return null;
  const lat0 = ((bbox[1] + bbox[3]) / 2).toFixed(4);
  const lon0 = ((bbox[0] + bbox[2]) / 2).toFixed(4);
  return {
    proj: `+proj=laea +lat_0=${lat0} +lon_0=${lon0} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`,
    label: `LAEA centred ${lat0}, ${lon0}`,
  };
}

/** Planar (shoelace) area of a projected ring, in m\u00b2. */
function ringAreaShoelace(ring: number[][]): number {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

function projectRing(ring: number[][], projDef: string): number[][] {
  return ring.map((c) => proj4(WGS84, projDef, [c[0], c[1]]));
}

/**
 * Area of one polygonal feature under an equal-area projection (v1
 * GSX.areaEqualAreaM2): outer ring minus interior rings, per polygon part.
 */
export function areaEqualAreaM2(feature: AnyFeature | null | undefined, projDef: string): number {
  if (!feature || !feature.geometry) return 0;
  const g = feature.geometry;
  // Polygon: one polygon part; MultiPolygon: the parts themselves. Either
  // way `polys` is a list of ring-lists (number[][][] per part).
  const polys: number[][][][] =
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  let total = 0;
  for (const rings of polys) {
    rings.forEach((ring, ri) => {
      const a = ringAreaShoelace(projectRing(ring, projDef));
      total += ri === 0 ? a : -a; // subtract interior rings
    });
  }
  return Math.max(0, total);
}

/**
 * Perimeter of a polygonal feature in metres (haversine over every ring,
 * matching v1 GSX.perimeterM which summed turf.length over polygonToLine
 * output - holes included).
 */
export function perimeterM(feature: AnyFeature | null | undefined): number {
  if (!feature) return 0;
  try {
    return allRings(feature.geometry).reduce((s, ring) => s + ringLengthM(ring), 0);
  } catch {
    return 0;
  }
}

/** The area method a measurement actually used. */
export type AreaMethod = "spherical" | "equalarea";

export interface AreaMeasurement {
  /** Total area in m\u00b2. */
  m2: number;
  /** The method that actually ran ("Equal-area (LAEA)" | "Spherical (WGS84)"). */
  method: string;
  /** CRS/projection the method refers to. */
  crs: string;
}

/**
 * Total area of a feature list under the chosen method (v1 GSX.measureArea).
 *
 * `equalarea` derives a data-centred LAEA projection; when that is impossible
 * (e.g. no finite bbox) the returned measurement honestly reports the
 * spherical method instead of claiming equal-area.
 */
export function measureArea(
  features: AnyFeature[],
  mode: AreaMethod = "spherical",
): AreaMeasurement {
  const list = [...(features ?? [])];
  if (mode === "equalarea") {
    const p = laeaFor(list);
    if (p) {
      const m2 = list.reduce((s, f) => s + areaEqualAreaM2(f, p.proj), 0);
      return { m2, method: "Equal-area (LAEA)", crs: p.label };
    }
  }
  return { m2: areaM2(fc(list)), method: "Spherical (WGS84)", crs: "EPSG:4326" };
}

/** Convenience: measurement rendered in hectares with the method declared. */
export function measurementHectares(
  m: AreaMeasurement,
): FormattedArea & { method: string; crs: string } {
  return { ...formatArea(m.m2, "ha"), method: m.method, crs: m.crs };
}
