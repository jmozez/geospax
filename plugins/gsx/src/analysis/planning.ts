// Conservation-planning workflows shared by the domain plugins.
//
// These are the framework-free ports of the original GeoSpaX conservation
// drawer's vector overlay, priority-area and feature-based WLC tools.  Every
// result reports skipped/missing data and carries the method that actually ran;
// no workflow silently changes to an unweighted or geographic proxy model.

import booleanIntersects from "@turf/boolean-intersects";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Geometry, MultiPolygon, Point, Polygon } from "geojson";
import { areaM2 } from "./units";
import { fc, isPolygonal, polygonsOnly, prefixProps, type AnyFeature } from "./geometry";
import { differencePair, intersectPair, unionAll } from "./overlay";
import { makeProvenance, type ProvenanceStamp } from "./provenance";
import { wlc, type WlcCriterion } from "./suitability";

type PolyFeature = Feature<Polygon | MultiPolygon>;

export type OverlayMode = "intersect" | "difference" | "union";

export interface VectorOverlayResult {
  ok: true;
  mode: OverlayMode;
  features: PolyFeature[];
  featureCount: number;
  totalAreaM2: number;
  pairsTested: number;
  pairsConstructed: number;
  skippedA: number;
  skippedB: number;
  provenance: ProvenanceStamp;
}

export interface PlanningFailure {
  ok: false;
  error: string;
}

/**
 * Polygon overlay with the original GeoSpaX semantics:
 * - intersect: pairwise pieces, with `a_` / `b_` prefixed properties;
 * - difference: A minus the dissolved union of B;
 * - union: dissolved A and B together.
 */
export function vectorOverlay(
  featuresA: AnyFeature[] | null | undefined,
  featuresB: AnyFeature[] | null | undefined,
  mode: OverlayMode,
): VectorOverlayResult | PlanningFailure {
  const a = polygonsOnly(featuresA);
  const b = polygonsOnly(featuresB);
  if (a.polys.length === 0 || b.polys.length === 0) {
    return { ok: false, error: "Both layers must contain polygons." };
  }

  const out: PolyFeature[] = [];
  let pairsTested = 0;
  let pairsConstructed = 0;

  if (mode === "intersect") {
    for (const left of a.polys) {
      for (const right of b.polys) {
        pairsTested++;
        let hit = true;
        try {
          hit = booleanIntersects(left, right);
        } catch {
          // Let the constructive operation make the final decision.
        }
        if (!hit) continue;
        const piece = intersectPair(left, right);
        if (!piece) continue;
        pairsConstructed++;
        piece.properties = {
          ...prefixProps(left.properties, "a"),
          ...prefixProps(right.properties, "b"),
          area_m2: areaM2(piece),
        };
        out.push(piece);
      }
    }
  } else if (mode === "difference") {
    const mask = unionAll(b.polys);
    for (const left of a.polys) {
      pairsTested++;
      const piece = mask ? differencePair(left, mask) : left;
      if (!piece) continue;
      pairsConstructed++;
      piece.properties = {
        ...prefixProps(left.properties, "a"),
        area_m2: areaM2(piece),
      };
      out.push(piece);
    }
  } else if (mode === "union") {
    pairsTested = a.polys.length + b.polys.length;
    const dissolved = unionAll([...a.polys, ...b.polys]);
    if (dissolved) {
      dissolved.properties = {
        operation: "union",
        area_m2: areaM2(dissolved),
      };
      out.push(dissolved);
      pairsConstructed = 1;
    }
  } else {
    return { ok: false, error: `Unknown overlay mode: ${String(mode)}` };
  }

  const totalAreaM2 = out.reduce((sum, feature) => sum + areaM2(feature), 0);
  const provenance = makeProvenance(
    "vector-overlay",
    mode === "intersect"
      ? "Pairwise polygon intersection"
      : mode === "difference"
        ? "Polygon difference (A minus dissolved B)"
        : "Dissolved polygon union",
    "EPSG:4326",
    {
      mode,
      inputFeaturesA: a.polys.length,
      inputFeaturesB: b.polys.length,
      skippedA: a.skipped,
      skippedB: b.skipped,
    },
  );
  for (const feature of out) {
    feature.properties = { ...(feature.properties ?? {}), _geospax: provenance };
  }

  return {
    ok: true,
    mode,
    features: out,
    featureCount: out.length,
    totalAreaM2,
    pairsTested,
    pairsConstructed,
    skippedA: a.skipped,
    skippedB: b.skipped,
    provenance,
  };
}

export interface PriorityAreaOptions {
  scoreField?: string;
  minScore?: number;
}

export interface PriorityAreaResult {
  ok: true;
  priorityFeatures: Feature<Point>[];
  protectedHighFeatures: Feature<Point>[];
  lowScoreFeatures: Feature<Point>[];
  totalPoints: number;
  priorityCount: number;
  protectedHighCount: number;
  lowScoreCount: number;
  invalidScoreCount: number;
  scoreField: string;
  minScore: number;
  provenance: ProvenanceStamp;
}

/** High-value point sites outside the current protected-area network. */
export function priorityAreas(
  habitatFeatures: AnyFeature[] | null | undefined,
  protectedAreaFeatures: AnyFeature[] | null | undefined,
  options: PriorityAreaOptions = {},
): PriorityAreaResult | PlanningFailure {
  const scoreField = options.scoreField ?? "habitat_score";
  const minScore = options.minScore ?? 1;
  if (!Number.isFinite(minScore)) {
    return { ok: false, error: "Minimum score must be a finite number." };
  }
  const points = (habitatFeatures ?? []).filter(
    (feature): feature is Feature<Point> => feature.geometry?.type === "Point",
  );
  if (points.length === 0) return { ok: false, error: "Habitat layer contains no points." };
  const pas = polygonsOnly(protectedAreaFeatures);
  if (pas.polys.length === 0) {
    return { ok: false, error: "Protected-area layer contains no polygons." };
  }

  const priorityFeatures: Feature<Point>[] = [];
  const protectedHighFeatures: Feature<Point>[] = [];
  const lowScoreFeatures: Feature<Point>[] = [];
  let invalidScoreCount = 0;

  for (const point of points) {
    const raw = point.properties?.[scoreField];
    const score = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(score)) {
      invalidScoreCount++;
      lowScoreFeatures.push(point);
      continue;
    }
    if (score < minScore) {
      lowScoreFeatures.push(point);
      continue;
    }
    let inside = false;
    for (const pa of pas.polys) {
      try {
        if (booleanPointInPolygon(point, pa)) {
          inside = true;
          break;
        }
      } catch {
        // Invalid PA geometry is ignored; the skipped count remains visible.
      }
    }
    if (inside) {
      protectedHighFeatures.push(point);
    } else {
      priorityFeatures.push({
        type: "Feature",
        geometry: point.geometry,
        properties: {
          ...(point.properties ?? {}),
          priority: true,
          protected: false,
          priority_score: score,
        },
      });
    }
  }

  const provenance = makeProvenance(
    "priority-areas",
    "Score threshold plus point-in-polygon protection exclusion",
    "EPSG:4326",
    {
      scoreField,
      minScore,
      pointCount: points.length,
      protectedAreaCount: pas.polys.length,
      skippedProtectedAreaFeatures: pas.skipped,
    },
  );
  for (const feature of priorityFeatures) {
    feature.properties = { ...(feature.properties ?? {}), _geospax: provenance };
  }

  return {
    ok: true,
    priorityFeatures,
    protectedHighFeatures,
    lowScoreFeatures,
    totalPoints: points.length,
    priorityCount: priorityFeatures.length,
    protectedHighCount: protectedHighFeatures.length,
    lowScoreCount: lowScoreFeatures.length,
    invalidScoreCount,
    scoreField,
    minScore,
    provenance,
  };
}

export type CriterionDirection = "benefit" | "cost";

export interface FeatureSuitabilityCriterion {
  id?: string;
  field: string;
  weight: number;
  direction: CriterionDirection;
  /** Optional fixed lower bound. Omit to derive it from valid feature values. */
  min?: number;
  /** Optional fixed upper bound. Omit to derive it from valid feature values. */
  max?: number;
}

export interface FeatureSuitabilityOptions {
  constraintField?: string;
  /** When true (default), truthy constraint values force suitability to zero. */
  constraintTruthy?: boolean;
}

export interface FeatureSuitabilityResult {
  ok: true;
  features: AnyFeature[];
  scoredCount: number;
  missingCount: number;
  constrainedCount: number;
  criteria: Array<FeatureSuitabilityCriterion & { min: number; max: number }>;
  warnings: string[];
  minSuitability: number | null;
  maxSuitability: number | null;
  meanSuitability: number | null;
  provenance: ProvenanceStamp;
}

/**
 * Weighted linear combination over numeric feature attributes. Values are
 * min-max standardised per criterion, cost criteria are inverted, and the
 * scalar {@link wlc} engine performs the weight normalisation.
 */
export function featureSuitability(
  features: AnyFeature[] | null | undefined,
  criteria: FeatureSuitabilityCriterion[],
  options: FeatureSuitabilityOptions = {},
): FeatureSuitabilityResult | PlanningFailure {
  if (!features?.length) return { ok: false, error: "The input layer has no features." };
  if (!criteria?.length) return { ok: false, error: "Add at least one criterion." };
  if (
    criteria.some(
      (criterion) => !criterion.field || !Number.isFinite(criterion.weight) || criterion.weight < 0,
    )
  ) {
    return { ok: false, error: "Every criterion needs a field and a non-negative finite weight." };
  }
  if (criteria.reduce((sum, criterion) => sum + criterion.weight, 0) <= 0) {
    return { ok: false, error: "Criterion weights must sum to more than zero." };
  }

  const numericProperty = (feature: AnyFeature, field: string): number | null => {
    const raw = feature.properties?.[field];
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  const warnings: string[] = [];
  const resolved = criteria.map((criterion) => {
    const values = features
      .map((feature) => numericProperty(feature, criterion.field))
      .filter((value): value is number => value !== null);
    const min = Number.isFinite(criterion.min)
      ? (criterion.min as number)
      : values.length
        ? Math.min(...values)
        : Number.NaN;
    const max = Number.isFinite(criterion.max)
      ? (criterion.max as number)
      : values.length
        ? Math.max(...values)
        : Number.NaN;
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      warnings.push(`Criterion “${criterion.field}” has no numeric values.`);
    } else if (min === max) {
      warnings.push(
        `Criterion “${criterion.field}” is constant (${min}); it contributes a neutral score of 0.5.`,
      );
    }
    return { ...criterion, id: criterion.id ?? criterion.field, min, max };
  });
  if (
    resolved.some((criterion) => !Number.isFinite(criterion.min) || !Number.isFinite(criterion.max))
  ) {
    return { ok: false, error: "At least one criterion has no numeric values in the input layer." };
  }

  let scoredCount = 0;
  let missingCount = 0;
  let constrainedCount = 0;
  const scores: number[] = [];
  const output = features.map((feature, featureIndex): AnyFeature => {
    const scalarCriteria: WlcCriterion[] = [];
    const criterionScores: Record<string, number> = {};
    let missing = false;
    for (const criterion of resolved) {
      const raw = numericProperty(feature, criterion.field);
      if (raw === null) {
        missing = true;
        break;
      }
      const span = criterion.max - criterion.min;
      const score = span === 0 ? 0.5 : Math.max(0, Math.min(1, (raw - criterion.min) / span));
      criterionScores[criterion.id] = score;
      scalarCriteria.push({
        id: criterion.id,
        weight: criterion.weight,
        score,
        benefit: criterion.direction === "benefit",
      });
    }

    const constraintValue = options.constraintField
      ? feature.properties?.[options.constraintField]
      : undefined;
    const constrained = options.constraintField
      ? (options.constraintTruthy ?? true)
        ? Boolean(constraintValue)
        : !Boolean(constraintValue)
      : false;

    let suitability: number | null = null;
    if (missing) {
      missingCount++;
    } else if (constrained) {
      suitability = 0;
      constrainedCount++;
      scoredCount++;
      scores.push(0);
    } else {
      suitability = wlc(scalarCriteria, { normalizeScores: false })?.suitability ?? null;
      if (suitability === null) missingCount++;
      else {
        scoredCount++;
        scores.push(suitability);
      }
    }

    return {
      type: "Feature",
      id: feature.id,
      bbox: feature.bbox,
      geometry: feature.geometry,
      properties: {
        ...(feature.properties ?? {}),
        suitability,
        suitability_pct: suitability === null ? null : suitability * 100,
        suitability_nodata: suitability === null,
        suitability_constrained: constrained,
        suitability_scores: criterionScores,
        source_feature_index: featureIndex,
      },
    };
  });

  const provenance = makeProvenance(
    "weighted-linear-combination",
    "Min-max standardised weighted linear combination",
    "Input layer CRS (GeoLibre vector store; coordinates exported as EPSG:4326)",
    {
      criteria: resolved.map(({ id, field, weight, direction, min, max }) => ({
        id,
        field,
        weight,
        direction,
        min,
        max,
      })),
      constraintField: options.constraintField ?? null,
      missingCount,
      constrainedCount,
    },
  );
  for (const feature of output) {
    feature.properties = { ...(feature.properties ?? {}), _geospax: provenance };
  }

  return {
    ok: true,
    features: output,
    scoredCount,
    missingCount,
    constrainedCount,
    criteria: resolved,
    warnings,
    minSuitability: scores.length ? Math.min(...scores) : null,
    maxSuitability: scores.length ? Math.max(...scores) : null,
    meanSuitability: scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : null,
    provenance,
  };
}

/** Utility used by panels to discover numeric attributes without guessing. */
export function numericFields(features: AnyFeature[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const feature of features ?? []) {
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      if (typeof value === "number" && Number.isFinite(value) && !key.startsWith("_"))
        seen.add(key);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Return point features only, preserving input order. */
export function pointsOnly(features: AnyFeature[] | null | undefined): Feature<Point>[] {
  return (features ?? []).filter(
    (feature): feature is Feature<Point> => feature.geometry?.type === "Point",
  );
}

/** Guard used by panels that need at least one usable geometry. */
export function hasGeometry(features: AnyFeature[] | null | undefined): boolean {
  return (features ?? []).some((feature) => feature.geometry !== null);
}

// Keep these imports reachable in generated declaration/source maps; they also
// make the accepted result geometry explicit for consumers.
void fc;
void isPolygonal;
void (null as Geometry | null);
