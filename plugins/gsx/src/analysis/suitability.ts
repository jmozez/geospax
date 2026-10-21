// Suitability — Weighted Linear Combination (WLC) with constraints.
//
// Ported methodology from GeoSpaX v1 js/geospax-conservation.js WLC engine,
// audit-fixed: graded scoring, metre cell size, distance-decay, cost/benefit
// flags, constraint masks, and no silent fallback on missing weights.

export interface WlcCriterion {
  id: string;
  weight: number; // raw weight — normalised internally (must sum > 0)
  score: number; // graded 0–1 (or 0–100, normalised on entry)
  benefit: boolean; // true = benefit, false = cost (score is inverted)
}

export interface WlcOptions {
  normalizeScores?: boolean; // if true and any score >1, divide by 100
  clamp01?: boolean;
}

export interface WlcResult {
  suitability: number; // 0–1
  weightedSum: number;
  weightTotal: number;
  normalized: boolean;
}

/**
 * Weighted linear combination.
 * Returns null on degenerate input (no criteria, zero weight total, non-finite scores)
 * — audit rule: never silently falls back to an unweighted mean.
 */
export function wlc(criteria: WlcCriterion[], options: WlcOptions = {}): WlcResult | null {
  if (!criteria || criteria.length === 0) return null;
  const normalizeScores = options.normalizeScores ?? true;
  const clamp01 = options.clamp01 ?? true;

  const needsDiv100 = normalizeScores && criteria.some((c) => c.score > 1);
  let sum = 0;
  let weightTotal = 0;
  for (const c of criteria) {
    if (!Number.isFinite(c.weight) || !Number.isFinite(c.score)) return null;
    if (c.weight < 0) return null;
    weightTotal += c.weight;
  }
  if (weightTotal <= 0) return null;
  for (const c of criteria) {
    const w = c.weight / weightTotal;
    let s = needsDiv100 ? c.score / 100 : c.score;
    if (clamp01) s = Math.max(0, Math.min(1, s));
    if (!c.benefit) s = 1 - s;
    sum += w * s;
  }
  return { suitability: sum, weightedSum: sum, weightTotal, normalized: needsDiv100 };
}

/** Distance decay (exponential) — used to turn Euclidean distance rasters into suitability. */
export function distanceDecay(distanceM: number, halfLifeM: number): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(halfLifeM) || halfLifeM <= 0) return 0;
  if (distanceM <= 0) return 1;
  return Math.exp(-Math.log(2) * (distanceM / halfLifeM));
}
