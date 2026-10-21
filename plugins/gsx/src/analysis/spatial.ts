// Spatial pattern and weighted hotspot-grid workflows used by conservation,
// biodiversity and marine panels.
//
// The weighted grid is descriptive multi-criteria aggregation, not inferential
// Getis-Ord Gi*. That distinction is part of the returned method note and
// provenance so a density surface cannot be misreported as a significance test.

import turfBbox from "@turf/bbox";
import booleanIntersects from "@turf/boolean-intersects";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import hexGrid from "@turf/hex-grid";
import squareGrid from "@turf/square-grid";
import type { Feature, MultiPolygon, Point, Polygon } from "geojson";
import { areaM2 } from "./units";
import { fc, haversineM, type AnyFeature } from "./geometry";
import { makeProvenance, type ProvenanceStamp } from "./provenance";

export type HotspotGridType = "hex" | "square";
export type HotspotScoreMethod = "count" | "presence" | "density";

export interface HotspotLayerInput {
  id: string;
  name: string;
  features: AnyFeature[];
  weight: number;
}

export interface HotspotGridOptions {
  cellSizeKm: number;
  gridType?: HotspotGridType;
  scoreMethod?: HotspotScoreMethod;
  maxCells?: number;
}

export interface HotspotGridResult {
  ok: true;
  grid: ReturnType<typeof fc>;
  cellCount: number;
  maxRawScore: number;
  nonEmptyCells: number;
  inputFeatureCount: number;
  methodNote: string;
  provenance: ProvenanceStamp;
}

export function hotspotGrid(
  layers: HotspotLayerInput[],
  options: HotspotGridOptions,
): HotspotGridResult | { ok: false; error: string } {
  const active = (layers ?? []).filter(
    (layer) => layer.features?.length && Number.isFinite(layer.weight) && layer.weight >= 0,
  );
  if (!active.length) return { ok: false, error: "Select at least one non-empty layer." };
  if (!Number.isFinite(options.cellSizeKm) || options.cellSizeKm <= 0) {
    return { ok: false, error: "Cell size must be greater than zero kilometres." };
  }
  const weightTotal = active.reduce((sum, layer) => sum + layer.weight, 0);
  if (weightTotal <= 0) return { ok: false, error: "Layer weights must sum to more than zero." };

  const allFeatures = active
    .flatMap((layer) => layer.features)
    .filter((feature) => feature.geometry);
  let bounds: [number, number, number, number];
  try {
    bounds = turfBbox(fc(allFeatures) as never) as [number, number, number, number];
  } catch {
    return { ok: false, error: "Could not derive a finite extent from the selected layers." };
  }
  if (!bounds.every(Number.isFinite)) {
    return { ok: false, error: "Could not derive a finite extent from the selected layers." };
  }
  // Give boundary points a cell on each side. This is only grid padding; Turf
  // performs the actual geodesic-kilometre grid construction.
  // Turf's hex `cellSide` is the hex side/radius, so a one-cell frame needs
  // more than half a side around a small/degenerate input bbox. Two sides of
  // padding guarantees at least one square or hex cell for point-only inputs.
  const padDegrees = (options.cellSizeKm / 111.32) * 2;
  const padded: [number, number, number, number] = [
    bounds[0] - padDegrees,
    bounds[1] - padDegrees,
    bounds[2] + padDegrees,
    bounds[3] + padDegrees,
  ];

  let grid: ReturnType<typeof squareGrid>;
  try {
    grid =
      (options.gridType ?? "hex") === "hex"
        ? (hexGrid(padded, options.cellSizeKm, { units: "kilometers" }) as ReturnType<
            typeof squareGrid
          >)
        : squareGrid(padded, options.cellSizeKm, { units: "kilometers" });
  } catch (error) {
    return {
      ok: false,
      error: `Grid generation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const maxCells = options.maxCells ?? 25_000;
  if (grid.features.length > maxCells) {
    return {
      ok: false,
      error: `The requested grid has ${grid.features.length.toLocaleString()} cells, above the ${maxCells.toLocaleString()} browser limit. Increase the cell size.`,
    };
  }

  const scoreMethod = options.scoreMethod ?? "count";
  let maxRawScore = 0;
  let nonEmptyCells = 0;
  for (const cell of grid.features) {
    const breakdown: Record<string, number> = {};
    let weighted = 0;
    for (const layer of active) {
      let count = 0;
      for (const feature of layer.features) {
        if (!feature.geometry) continue;
        try {
          if (feature.geometry.type === "Point") {
            if (booleanPointInPolygon(feature as Feature<Point>, cell)) count++;
          } else if (booleanIntersects(cell, feature as never)) {
            count++;
          }
        } catch {
          // Malformed geometry contributes nothing; input counts remain visible.
        }
      }
      let score = count;
      if (scoreMethod === "presence") score = count > 0 ? 1 : 0;
      if (scoreMethod === "density") {
        const areaKm2 = areaM2(cell as AnyFeature) / 1_000_000;
        score = areaKm2 > 0 ? count / areaKm2 : 0;
      }
      breakdown[layer.name] = score;
      weighted += score * layer.weight;
    }
    const rawScore = weighted / weightTotal;
    cell.properties = {
      ...(cell.properties ?? {}),
      hotspot_score: rawScore,
      hotspot_breakdown: breakdown,
    };
    maxRawScore = Math.max(maxRawScore, rawScore);
    if (rawScore > 0) nonEmptyCells++;
  }

  const provenance = makeProvenance(
    "weighted-hotspot-grid",
    `Descriptive weighted ${scoreMethod} grid (not Getis-Ord Gi*)`,
    "EPSG:4326 grid; cell size specified geodesically in kilometres",
    {
      gridType: options.gridType ?? "hex",
      cellSizeKm: options.cellSizeKm,
      scoreMethod,
      layers: active.map((layer) => ({ id: layer.id, name: layer.name, weight: layer.weight })),
      statisticalSignificance: false,
    },
  );
  for (const cell of grid.features) {
    const rawScore = Number(cell.properties?.hotspot_score ?? 0);
    cell.properties = {
      ...(cell.properties ?? {}),
      hotspot_normalized: maxRawScore > 0 ? rawScore / maxRawScore : 0,
      _geospax: provenance,
    };
  }

  return {
    ok: true,
    grid: grid as ReturnType<typeof fc>,
    cellCount: grid.features.length,
    maxRawScore,
    nonEmptyCells,
    inputFeatureCount: allFeatures.length,
    methodNote:
      "Weighted grid scores are descriptive density/count summaries. They are not p-values and are not Getis-Ord Gi* hotspot significance.",
    provenance,
  };
}

export interface NearestNeighbourResult {
  ok: true;
  pointCount: number;
  studyAreaM2: number;
  observedMeanM: number;
  expectedMeanM: number;
  ratio: number;
  zScore: number | null;
  interpretation: "clustered" | "random-like" | "dispersed";
  methodNote: string;
  provenance: ProvenanceStamp;
}

/** Clark-Evans nearest-neighbour ratio using the points' bounding box as area. */
export function nearestNeighbourIndex(
  features: AnyFeature[] | null | undefined,
): NearestNeighbourResult | { ok: false; error: string } {
  const points = (features ?? []).filter(
    (feature): feature is Feature<Point> => feature.geometry?.type === "Point",
  );
  if (points.length < 2)
    return { ok: false, error: "Nearest-neighbour analysis needs at least two points." };
  const coordinates = points.map((point) => point.geometry.coordinates as [number, number]);
  const nearest: number[] = [];
  for (let i = 0; i < coordinates.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < coordinates.length; j++) {
      if (i === j) continue;
      best = Math.min(best, haversineM(coordinates[i], coordinates[j]));
    }
    nearest.push(best);
  }

  const minX = Math.min(...coordinates.map((coordinate) => coordinate[0]));
  const minY = Math.min(...coordinates.map((coordinate) => coordinate[1]));
  const maxX = Math.max(...coordinates.map((coordinate) => coordinate[0]));
  const maxY = Math.max(...coordinates.map((coordinate) => coordinate[1]));
  const studyPolygon: Feature<Polygon> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ],
      ],
    },
  };
  const studyAreaM2 = areaM2(studyPolygon);
  if (!(studyAreaM2 > 0)) {
    return {
      ok: false,
      error: "The points have a zero-area bounding box; a 2D study area is required.",
    };
  }
  const observedMeanM = nearest.reduce((sum, distance) => sum + distance, 0) / nearest.length;
  const density = points.length / studyAreaM2;
  const expectedMeanM = 0.5 / Math.sqrt(density);
  const standardError = 0.26136 / Math.sqrt(points.length * density);
  const ratio = observedMeanM / expectedMeanM;
  const zScore = standardError > 0 ? (observedMeanM - expectedMeanM) / standardError : null;
  const provenance = makeProvenance(
    "nearest-neighbour-index",
    "Clark-Evans nearest-neighbour ratio under CSR",
    "EPSG:4326 coordinates with haversine distances; Turf spherical bounding-box area",
    {
      pointCount: points.length,
      studyArea: "axis-aligned bounding box of input points",
      edgeCorrection: "none",
    },
  );

  return {
    ok: true,
    pointCount: points.length,
    studyAreaM2,
    observedMeanM,
    expectedMeanM,
    ratio,
    zScore,
    interpretation: ratio < 0.9 ? "clustered" : ratio > 1.1 ? "dispersed" : "random-like",
    methodNote:
      "Clark-Evans R uses the input bounding box as the study area and no edge correction; interpret cautiously near irregular boundaries.",
    provenance,
  };
}

export interface DbscanOptions {
  /** Neighbourhood radius in metres. Omit to derive it from nearest neighbours. */
  epsilonM?: number;
  /** Multiplier applied to the median nearest-neighbour distance (default 1.5). */
  epsilonMultiplier?: number;
  /** Minimum points in a core neighbourhood, including the point itself (default 4). */
  minPoints?: number;
  /** Browser safety bound (default 2,000 points). */
  maxPoints?: number;
}

export interface DbscanResult {
  ok: true;
  features: Feature<Point>[];
  pointCount: number;
  clusterCount: number;
  noiseCount: number;
  corePointCount: number;
  clusterSizes: number[];
  epsilonM: number;
  epsilonWasAutomatic: boolean;
  epsilonMultiplier: number;
  medianNearestNeighbourM: number;
  automaticEpsilonFloorApplied: boolean;
  minPoints: number;
  provenance: ProvenanceStamp;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Density-based point clustering with haversine distances. Cluster IDs are
 * deterministic for a fixed input order; noise is retained with ID -1 rather
 * than silently dropped from the result layer.
 */
export function dbscanClusters(
  features: AnyFeature[] | null | undefined,
  options: DbscanOptions = {},
): DbscanResult | { ok: false; error: string } {
  const points = (features ?? []).filter(
    (feature): feature is Feature<Point> => feature.geometry?.type === "Point",
  );
  if (points.length < 2) return { ok: false, error: "DBSCAN needs at least two point features." };
  const maxPoints = options.maxPoints ?? 2_000;
  if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 2_000) {
    return { ok: false, error: "DBSCAN maxPoints must be an integer from two to 2,000." };
  }
  if (points.length > maxPoints) {
    return {
      ok: false,
      error: `DBSCAN is bounded to ${maxPoints.toLocaleString()} points in-browser; filter or sample the ${points.length.toLocaleString()} input points.`,
    };
  }
  const minPoints = options.minPoints ?? 4;
  if (!Number.isInteger(minPoints) || minPoints < 2) {
    return { ok: false, error: "DBSCAN minimum points must be an integer of at least two." };
  }
  const epsilonMultiplier = options.epsilonMultiplier ?? 1.5;
  if (!Number.isFinite(epsilonMultiplier) || epsilonMultiplier <= 0) {
    return { ok: false, error: "DBSCAN epsilon multiplier must be greater than zero." };
  }

  const coordinates = points.map((point) => point.geometry.coordinates as [number, number]);
  if (
    coordinates.some(
      ([longitude, latitude]) =>
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90,
    )
  ) {
    return {
      ok: false,
      error: "DBSCAN point coordinates must contain finite longitude/latitude values.",
    };
  }
  const nearest = new Array(points.length).fill(Number.POSITIVE_INFINITY);
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      const distance = haversineM(coordinates[left], coordinates[right]);
      if (distance < nearest[left]) nearest[left] = distance;
      if (distance < nearest[right]) nearest[right] = distance;
    }
  }

  const epsilonWasAutomatic = options.epsilonM === undefined;
  const medianNearestNeighbourM = median(nearest);
  let epsilonM = options.epsilonM ?? medianNearestNeighbourM * epsilonMultiplier;
  // Coincident-only inputs have a zero nearest-neighbour median. One metre is
  // an explicit deterministic floor, not a change of distance method.
  const automaticEpsilonFloorApplied = epsilonWasAutomatic && epsilonM === 0;
  if (automaticEpsilonFloorApplied) epsilonM = 1;
  if (!Number.isFinite(epsilonM) || epsilonM <= 0) {
    return { ok: false, error: "DBSCAN epsilon must be a finite distance greater than zero." };
  }

  const neighbourhoodCache = new Map<number, number[]>();
  const neighbours = (index: number): number[] => {
    const cached = neighbourhoodCache.get(index);
    if (cached) return cached;
    const matches: number[] = [];
    for (let candidate = 0; candidate < points.length; candidate++) {
      if (
        candidate === index ||
        haversineM(coordinates[index], coordinates[candidate]) <= epsilonM
      ) {
        matches.push(candidate);
      }
    }
    neighbourhoodCache.set(index, matches);
    return matches;
  };

  const unclassified = -2;
  const noise = -1;
  const labels = new Array(points.length).fill(unclassified);
  const visited = new Uint8Array(points.length);
  const core = new Uint8Array(points.length);
  let clusterCount = 0;

  for (let index = 0; index < points.length; index++) {
    if (visited[index]) continue;
    visited[index] = 1;
    const seedNeighbours = neighbours(index);
    if (seedNeighbours.length < minPoints) {
      labels[index] = noise;
      continue;
    }

    core[index] = 1;
    labels[index] = clusterCount;
    const queue = [...seedNeighbours];
    const queued = new Set(seedNeighbours);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const candidate = queue[cursor];
      if (!visited[candidate]) {
        visited[candidate] = 1;
        const candidateNeighbours = neighbours(candidate);
        if (candidateNeighbours.length >= minPoints) {
          core[candidate] = 1;
          for (const neighbour of candidateNeighbours) {
            if (!queued.has(neighbour)) {
              queued.add(neighbour);
              queue.push(neighbour);
            }
          }
        }
      }
      if (labels[candidate] === unclassified || labels[candidate] === noise) {
        labels[candidate] = clusterCount;
      }
    }
    clusterCount++;
  }

  const clusterSizes = new Array(clusterCount).fill(0);
  labels.forEach((label) => {
    if (label >= 0) clusterSizes[label]++;
  });
  const noiseCount = labels.filter((label) => label === noise).length;
  const corePointCount = core.reduce((sum, value) => sum + value, 0);
  const provenance = makeProvenance(
    "dbscan-clustering",
    "DBSCAN with haversine neighbourhood distances",
    "EPSG:4326 point coordinates; great-circle distances in metres",
    {
      pointCount: points.length,
      epsilonM,
      epsilonWasAutomatic,
      epsilonMultiplier: epsilonWasAutomatic ? epsilonMultiplier : null,
      medianNearestNeighbourM,
      automaticEpsilonRule: epsilonWasAutomatic
        ? "median nearest-neighbour distance × multiplier; 1 m floor when the median is zero"
        : null,
      automaticEpsilonFloorApplied,
      minPoints,
      minPointsIncludesSelf: true,
      clusterCount,
      noiseCount,
      browserPointLimit: maxPoints,
    },
  );
  const output = points.map((point, index) => ({
    type: "Feature" as const,
    id: point.id,
    bbox: point.bbox,
    geometry: point.geometry,
    properties: {
      ...(point.properties ?? {}),
      dbscan_cluster: labels[index] >= 0 ? labels[index] + 1 : -1,
      dbscan_noise: labels[index] === noise,
      dbscan_core: Boolean(core[index]),
      _geospax: provenance,
    },
  }));

  return {
    ok: true,
    features: output,
    pointCount: points.length,
    clusterCount,
    noiseCount,
    corePointCount,
    clusterSizes,
    epsilonM,
    epsilonWasAutomatic,
    epsilonMultiplier,
    medianNearestNeighbourM,
    automaticEpsilonFloorApplied,
    minPoints,
    provenance,
  };
}

void (null as MultiPolygon | null);
