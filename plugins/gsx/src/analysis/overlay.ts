// Polygon overlay primitives shared by the conservation tools.
//
// Ported from GeoSpaX v1 (js/geospax-conservation.js GSX.unionAll and the
// pairwise overlay helpers). v1 targeted Turf 6 (pairwise signatures); this
// port targets the workspace's Turf 7, where intersect/difference/union take
// a FeatureCollection. Failure semantics are unchanged: malformed geometry is
// skipped (result null), never fatal, and callers report what was skipped.

import difference from "@turf/difference";
import intersect from "@turf/intersect";
import union from "@turf/union";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { fc, polygonsOnly, type AnyFeature } from "./geometry";

type PolyFeature = Feature<Polygon | MultiPolygon>;

function pair(
  op: (fcs: never) => Feature<Polygon | MultiPolygon> | null,
  a: AnyFeature,
  b: AnyFeature,
): PolyFeature | null {
  try {
    // Turf 7: the constructive ops take a FeatureCollection of the inputs.
    return op(fc([a, b]) as never) as PolyFeature | null;
  } catch {
    return null;
  }
}

/** Intersection of two polygonal features, or null on no/invalid overlap. */
export function intersectPair(a: AnyFeature, b: AnyFeature): PolyFeature | null {
  return pair(intersect as never, a, b);
}

/** `a` minus `b`, or null when `a` is fully consumed / inputs invalid. */
export function differencePair(a: AnyFeature, b: AnyFeature): PolyFeature | null {
  return pair(difference as never, a, b);
}

/**
 * Dissolve a polygon list into a single (Multi)Polygon, or null when the
 * list holds no polygons. Pairwise reduce with per-step tolerance: one
 * malformed geometry is skipped rather than aborting the whole union
 * (identical semantics to v1 GSX.unionAll).
 */
export function unionAll(features: AnyFeature[] | null | undefined): PolyFeature | null {
  const polys = polygonsOnly(features).polys;
  if (polys.length === 0) return null;
  let acc: PolyFeature = polys[0];
  for (let i = 1; i < polys.length; i++) {
    try {
      const u = union(fc([acc, polys[i]]) as never) as PolyFeature | null;
      if (u) acc = u;
    } catch {
      // skip malformed geometry rather than abort
    }
  }
  return acc;
}
