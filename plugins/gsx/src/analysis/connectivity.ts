// Connectivity — centroid-threshold graph metrics for polygon patch networks.
//
// This is deliberately not a least-cost corridor model.  The method and its
// centroid-distance limitation are carried in provenance and surfaced by every
// domain panel that uses it.

import type { Feature, LineString, MultiPolygon, Polygon } from "geojson";
import { haversineM, polygonsOnly, type AnyFeature } from "./geometry";
import { areaM2 } from "./units";
import { makeProvenance, type ProvenanceStamp } from "./provenance";

function centroidOfPolygon(coords: number[][][]): [number, number] {
  const ring = coords[0] ?? [];
  if (!ring.length) return [Number.NaN, Number.NaN];
  // Ignore the duplicated closing vertex when present.
  const usable =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of usable) {
    sx += x;
    sy += y;
  }
  return [sx / usable.length, sy / usable.length];
}

function centroidCoordinate(feature: Feature<Polygon | MultiPolygon>): [number, number] {
  const geometry = feature.geometry;
  if (geometry.type === "Polygon") return centroidOfPolygon(geometry.coordinates as number[][][]);
  // Choose the largest part rather than the first arbitrary part.
  let best = geometry.coordinates[0] as number[][][];
  let bestArea = -1;
  for (const coordinates of geometry.coordinates as number[][][][]) {
    const candidate: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates },
    };
    const candidateArea = areaM2(candidate);
    if (candidateArea > bestArea) {
      best = coordinates;
      bestArea = candidateArea;
    }
  }
  return centroidOfPolygon(best);
}

export interface ConnectivityEdge {
  from: number;
  to: number;
  distanceM: number;
}

export interface ConnectivityGraph {
  nodes: Array<{ id: number; areaHa: number; centroid: [number, number] }>;
  edges: ConnectivityEdge[];
}

export interface ConnectivityOptions {
  maxDistanceM: number;
}

/** Build a thresholded centroid-proximity graph. */
export function connectivityGraph(
  patches: Feature<Polygon | MultiPolygon>[],
  options: ConnectivityOptions,
): ConnectivityGraph | null {
  if (!patches?.length) return null;
  if (!Number.isFinite(options.maxDistanceM) || options.maxDistanceM <= 0) return null;
  const nodes = patches.map((feature, index) => {
    const centroid = centroidCoordinate(feature);
    const areaHa = areaM2(feature) / 10_000;
    return { id: index, areaHa: Number.isFinite(areaHa) ? areaHa : 0, centroid };
  });
  const edges: ConnectivityEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const distanceM = haversineM(nodes[i].centroid, nodes[j].centroid);
      if (distanceM <= options.maxDistanceM) edges.push({ from: i, to: j, distanceM });
    }
  }
  return { nodes, edges };
}

export interface ConnectivitySummary {
  componentCount: number;
  edgeCount: number;
  isolatedCount: number;
}

export function connectivitySummary(graph: ConnectivityGraph): ConnectivitySummary {
  if (!graph) return { componentCount: 0, edgeCount: 0, isolatedCount: 0 };
  const n = graph.nodes.length;
  const adjacency = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) adjacency.set(i, new Set());
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const visited = new Set<number>();
  let componentCount = 0;
  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    componentCount++;
    const stack = [i];
    visited.add(i);
    while (stack.length) {
      const current = stack.pop() as number;
      for (const neighbour of adjacency.get(current) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          stack.push(neighbour);
        }
      }
    }
  }
  return {
    componentCount,
    edgeCount: graph.edges.length,
    isolatedCount: [...adjacency.values()].filter((neighbours) => neighbours.size === 0).length,
  };
}

export interface ConnectivityAnalysisResult {
  ok: true;
  thresholdM: number;
  numPatches: number;
  componentCount: number;
  largestComponentPatches: number;
  largestComponentAreaM2: number;
  isolatedPatches: number;
  linkCount: number;
  linkFeatures: Feature<LineString>[];
  taggedFeatures: Feature<Polygon | MultiPolygon>[];
  components: number[][];
  skipped: number;
  provenance: ProvenanceStamp;
}

/** Complete output geometry and report for the original connectivity tool. */
export function connectivityAnalysis(
  features: AnyFeature[] | null | undefined,
  thresholdM: number,
): ConnectivityAnalysisResult | { ok: false; error: string } {
  if (!Number.isFinite(thresholdM) || thresholdM <= 0) {
    return { ok: false, error: "Link threshold must be greater than zero metres." };
  }
  const source = polygonsOnly(features);
  if (!source.polys.length) return { ok: false, error: "Layer contains no polygons." };
  const graph = connectivityGraph(source.polys, { maxDistanceM: thresholdM });
  if (!graph) return { ok: false, error: "Could not build a connectivity graph." };

  const parent = graph.nodes.map((node) => node.id);
  const find = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const join = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  for (const edge of graph.edges) join(edge.from, edge.to);

  const groups = new Map<number, number[]>();
  for (const node of graph.nodes) {
    const root = find(node.id);
    groups.set(root, [...(groups.get(root) ?? []), node.id]);
  }
  const components = [...groups.values()].sort((a, b) => b.length - a.length);
  const componentOf = new Map<number, number>();
  components.forEach((members, componentIndex) => {
    for (const member of members) componentOf.set(member, componentIndex);
  });

  const provenance = makeProvenance(
    "connectivity",
    "Centroid-distance threshold graph",
    "EPSG:4326 (haversine distance)",
    {
      thresholdM,
      distanceCaveat:
        "Links use centroid-to-centroid distance; this is not least-cost connectivity.",
      skippedFeatures: source.skipped,
    },
  );
  const linkFeatures: Feature<LineString>[] = graph.edges.map((edge) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [graph.nodes[edge.from].centroid, graph.nodes[edge.to].centroid],
    },
    properties: {
      from: edge.from,
      to: edge.to,
      distance_m: edge.distanceM,
      threshold_m: thresholdM,
      _geospax: provenance,
    },
  }));
  const taggedFeatures = source.polys.map((feature, index) => {
    const component = componentOf.get(index) ?? index;
    return {
      type: "Feature" as const,
      geometry: feature.geometry,
      properties: {
        ...(feature.properties ?? {}),
        patch_index: index,
        component,
        component_size: components[component]?.length ?? 1,
        _geospax: provenance,
      },
    };
  });
  const largest = components[0] ?? [];

  return {
    ok: true,
    thresholdM,
    numPatches: source.polys.length,
    componentCount: components.length,
    largestComponentPatches: largest.length,
    largestComponentAreaM2: largest.reduce(
      (sum, patchIndex) => sum + areaM2(source.polys[patchIndex]),
      0,
    ),
    isolatedPatches: components.filter((members) => members.length === 1).length,
    linkCount: linkFeatures.length,
    linkFeatures,
    taggedFeatures,
    components,
    skipped: source.skipped,
    provenance,
  };
}
