// Fragmentation and patch metrics, ported from GeoSpaX v1's landscape module.
//
// The compact patchMetrics/summarizeFragmentation API is retained for existing
// callers. fragmentationAnalysis exposes the complete original report: NP, CA,
// LPI, TE, ED, MSI, core area / CAI and centroid nearest-neighbour distance.

import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import type { Feature, MultiPolygon, Point, Polygon } from "geojson";
import { haversineM, polygonsOnly, type AnyFeature } from "./geometry";
import {
  areaEqualAreaM2,
  areaM2,
  laeaFor,
  measureArea,
  perimeterM,
  type AreaMethod,
} from "./units";
import { makeProvenance, type ProvenanceStamp } from "./provenance";

export interface PatchMetric {
  id: string;
  areaM2: number;
  areaHa: number;
  perimeterM: number;
  shapeIndex: number;
  edgeDensity: number;
  isCore?: boolean;
}

/** Metrics for a single polygonal patch. */
export function patchMetrics(
  feature: Feature<Polygon | MultiPolygon>,
  id = "patch",
): PatchMetric | null {
  if (!feature?.geometry) return null;
  const area = areaM2(feature);
  const perimeter = perimeterM(feature);
  if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(perimeter) || perimeter <= 0) {
    return null;
  }
  const shapeIndex = perimeter / (2 * Math.sqrt(Math.PI * area));
  return {
    id,
    areaM2: area,
    areaHa: area / 10_000,
    perimeterM: perimeter,
    shapeIndex,
    edgeDensity: perimeter / area,
  };
}

export interface FragmentationSummary {
  patchCount: number;
  totalAreaM2: number;
  totalAreaHa: number;
  meanAreaHa: number;
  meanShapeIndex: number;
  totalPerimeterM: number;
}

export function summarizeFragmentation(patches: PatchMetric[]): FragmentationSummary {
  if (!patches?.length) {
    return {
      patchCount: 0,
      totalAreaM2: 0,
      totalAreaHa: 0,
      meanAreaHa: 0,
      meanShapeIndex: 0,
      totalPerimeterM: 0,
    };
  }
  const totalAreaM2 = patches.reduce((sum, patch) => sum + patch.areaM2, 0);
  const totalPerimeterM = patches.reduce((sum, patch) => sum + patch.perimeterM, 0);
  return {
    patchCount: patches.length,
    totalAreaM2,
    totalAreaHa: totalAreaM2 / 10_000,
    meanAreaHa: totalAreaM2 / patches.length / 10_000,
    meanShapeIndex: patches.reduce((sum, patch) => sum + patch.shapeIndex, 0) / patches.length,
    totalPerimeterM,
  };
}

type PolyFeature = Feature<Polygon | MultiPolygon>;

function explodeParts(features: PolyFeature[]): Feature<Polygon>[] {
  const parts: Feature<Polygon>[] = [];
  for (const feature of features) {
    if (feature.geometry.type === "Polygon") {
      parts.push(feature as Feature<Polygon>);
      continue;
    }
    for (const coordinates of feature.geometry.coordinates) {
      parts.push({
        type: "Feature",
        properties: { ...(feature.properties ?? {}) },
        geometry: { type: "Polygon", coordinates },
      });
    }
  }
  return parts;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface FragmentationOptions {
  coreDepthM?: number;
  areaMode?: AreaMethod;
  /** Treat every part of a MultiPolygon as an ecological patch (default true). */
  explodeMultiPolygons?: boolean;
}

export interface FragmentationAnalysisResult {
  ok: true;
  numPatches: number;
  totalAreaM2: number;
  meanPatchM2: number;
  medianPatchM2: number;
  largestPatchM2: number;
  largestPatchIndex: number;
  totalEdgeM: number;
  edgeDensityMPerHa: number;
  meanShapeIndex: number;
  coreDepthM: number;
  coreAreaM2: number;
  coreAreaIndex: number;
  patchesWithNoCore: number;
  meanNearestNeighbourM: number | null;
  coreFeatures: PolyFeature[];
  patchFeatures: PolyFeature[];
  areaMethod: string;
  areaCrs: string;
  skipped: number;
  warnings: string[];
  provenance: ProvenanceStamp;
}

/** Complete landscape-fragmentation report from the original application. */
export function fragmentationAnalysis(
  features: AnyFeature[] | null | undefined,
  options: FragmentationOptions = {},
): FragmentationAnalysisResult | { ok: false; error: string } {
  const source = polygonsOnly(features);
  if (!source.polys.length) return { ok: false, error: "Layer contains no polygons." };
  const coreDepthM = options.coreDepthM ?? 100;
  if (!Number.isFinite(coreDepthM) || coreDepthM < 0) {
    return { ok: false, error: "Core-area edge depth must be zero or greater." };
  }

  const patches: PolyFeature[] =
    options.explodeMultiPolygons === false ? source.polys : explodeParts(source.polys);
  const areaMode = options.areaMode ?? "equalarea";
  const projection = areaMode === "equalarea" ? laeaFor(patches) : null;
  const areaOf = (feature: PolyFeature): number =>
    projection ? areaEqualAreaM2(feature, projection.proj) : areaM2(feature);
  const areaInfo = measureArea(patches, areaMode);
  const areas = patches.map(areaOf);
  const totalAreaM2 = areas.reduce((sum, area) => sum + area, 0);
  const perimeters = patches.map(perimeterM);
  const totalEdgeM = perimeters.reduce((sum, value) => sum + value, 0);

  const coreFeatures: PolyFeature[] = [];
  let coreAreaM2 = 0;
  let patchesWithNoCore = 0;
  const warnings: string[] = [];
  for (let i = 0; i < patches.length; i++) {
    if (coreDepthM === 0) {
      const copy: PolyFeature = {
        type: "Feature",
        geometry: patches[i].geometry,
        properties: { ...(patches[i].properties ?? {}) },
      };
      const area = areaOf(copy);
      copy.properties = { ...(copy.properties ?? {}), core_area_m2: area, core_depth_m: 0 };
      coreFeatures.push(copy);
      coreAreaM2 += area;
      continue;
    }
    let core: PolyFeature | null = null;
    try {
      core =
        (buffer(patches[i], -coreDepthM, { units: "meters" }) as PolyFeature | undefined) ?? null;
    } catch {
      core = null;
    }
    if (!core?.geometry) {
      patchesWithNoCore++;
      continue;
    }
    const coreArea = areaOf(core);
    if (!(coreArea > 0)) {
      patchesWithNoCore++;
      continue;
    }
    core.properties = {
      ...(patches[i].properties ?? {}),
      patch_index: i,
      core_area_m2: coreArea,
      core_depth_m: coreDepthM,
    };
    coreFeatures.push(core);
    coreAreaM2 += coreArea;
  }

  const centroids: Array<Feature<Point> | null> = patches.map((patch) => {
    try {
      return centroid(patch) as Feature<Point>;
    } catch {
      return null;
    }
  });
  const nearest: number[] = [];
  for (let i = 0; i < centroids.length; i++) {
    const current = centroids[i]?.geometry.coordinates;
    if (!current) continue;
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < centroids.length; j++) {
      if (i === j) continue;
      const other = centroids[j]?.geometry.coordinates;
      if (!other) continue;
      best = Math.min(best, haversineM(current, other));
    }
    if (Number.isFinite(best)) nearest.push(best);
  }

  const meanShapeIndex = patches.length
    ? patches.reduce((sum, _patch, index) => {
        const area = areas[index];
        return sum + (area > 0 ? perimeters[index] / (2 * Math.sqrt(Math.PI * area)) : 0);
      }, 0) / patches.length
    : 0;
  const largestPatchM2 = areas.length ? Math.max(...areas) : 0;
  const provenance = makeProvenance(
    "fragmentation",
    "Polygon patch metrics with negative-buffer core area",
    areaInfo.crs,
    {
      areaMethod: areaInfo.method,
      coreDepthM,
      explodeMultiPolygons: options.explodeMultiPolygons !== false,
      centroidDistanceCaveat:
        "Nearest-neighbour distance is centroid-to-centroid, not edge-to-edge.",
      skippedFeatures: source.skipped,
    },
  );
  for (const feature of coreFeatures) {
    feature.properties = { ...(feature.properties ?? {}), _geospax: provenance };
  }
  if (patches.length === 1) {
    warnings.push("Nearest-neighbour distance is unavailable for a single patch.");
  }

  return {
    ok: true,
    numPatches: patches.length,
    totalAreaM2,
    meanPatchM2: patches.length ? totalAreaM2 / patches.length : 0,
    medianPatchM2: median(areas),
    largestPatchM2,
    largestPatchIndex: totalAreaM2 > 0 ? (largestPatchM2 / totalAreaM2) * 100 : 0,
    totalEdgeM,
    edgeDensityMPerHa: totalAreaM2 > 0 ? totalEdgeM / (totalAreaM2 / 10_000) : 0,
    meanShapeIndex,
    coreDepthM,
    coreAreaM2,
    coreAreaIndex: totalAreaM2 > 0 ? (coreAreaM2 / totalAreaM2) * 100 : 0,
    patchesWithNoCore,
    meanNearestNeighbourM: nearest.length
      ? nearest.reduce((sum, value) => sum + value, 0) / nearest.length
      : null,
    coreFeatures,
    patchFeatures: patches,
    areaMethod: areaInfo.method,
    areaCrs: areaInfo.crs,
    skipped: source.skipped,
    warnings,
    provenance,
  };
}
