// Species-distribution model evaluation: discrimination (ROC AUC), threshold
// metrics (sensitivity, specificity, TSS), the continuous Boyce index, and
// spatially blocked k-fold cross-validation.
//
// All metrics take raw suitability scores, so they work for any model in
// ./sdm (or an external one). Background (not true absence) data is assumed:
// AUC then measures presence-vs-background discrimination, and is reported as
// such — it is not an accuracy against confirmed absences.

import { makeProvenance, type ProvenanceStamp } from "./provenance";

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value)
  );
}

/** 1-based ranks with ties given their mid-rank. */
function midRanks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (
      end + 1 < order.length &&
      order[end + 1].value === order[start].value
    )
      end++;
    const rank = (start + end) / 2 + 1;
    for (let i = start; i <= end; i++) ranks[order[i].index] = rank;
    start = end + 1;
  }
  return ranks;
}

/**
 * ROC AUC via the Mann–Whitney U statistic: the probability that a random
 * presence scores higher than a random background point, ties counting ½.
 * Non-finite scores are dropped. Returns null if either class is empty.
 */
export function rocAuc(
  presenceScores: Array<number | null>,
  backgroundScores: Array<number | null>
): number | null {
  const presence = finite(presenceScores);
  const background = finite(backgroundScores);
  if (!presence.length || !background.length) return null;
  const ranks = midRanks([...presence, ...background]);
  let presenceRankSum = 0;
  for (let i = 0; i < presence.length; i++) presenceRankSum += ranks[i];
  const u = presenceRankSum - (presence.length * (presence.length + 1)) / 2;
  return u / (presence.length * background.length);
}

export interface ThresholdMetrics {
  threshold: number;
  /** Presences with score ≥ threshold / all presences. */
  sensitivity: number;
  /** Background with score < threshold / all background. */
  specificity: number;
  /** True skill statistic = sensitivity + specificity − 1, in [−1, 1]. */
  tss: number;
}

/** Sensitivity, specificity and TSS when score ≥ threshold is "predicted present". */
export function thresholdMetrics(
  presenceScores: Array<number | null>,
  backgroundScores: Array<number | null>,
  threshold: number
): ThresholdMetrics | null {
  const presence = finite(presenceScores);
  const background = finite(backgroundScores);
  if (!presence.length || !background.length || !Number.isFinite(threshold))
    return null;
  const sensitivity =
    presence.filter((score) => score >= threshold).length / presence.length;
  const specificity =
    background.filter((score) => score < threshold).length / background.length;
  return {
    threshold,
    sensitivity,
    specificity,
    tss: sensitivity + specificity - 1,
  };
}

/**
 * Threshold maximising TSS (equivalently sensitivity + specificity), searched
 * over every observed score. Ties keep the lowest threshold.
 */
export function maxTssThreshold(
  presenceScores: Array<number | null>,
  backgroundScores: Array<number | null>
): ThresholdMetrics | null {
  const candidates = [
    ...new Set(finite([...presenceScores, ...backgroundScores])),
  ].sort((a, b) => a - b);
  let best: ThresholdMetrics | null = null;
  for (const threshold of candidates) {
    const metrics = thresholdMetrics(
      presenceScores,
      backgroundScores,
      threshold
    );
    if (metrics && (!best || metrics.tss > best.tss)) best = metrics;
  }
  return best;
}

/** Spearman rank correlation (Pearson on mid-ranks). Null when undefined. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  const rx = midRanks(x);
  const ry = midRanks(y);
  const n = x.length;
  const mean = (n + 1) / 2;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mean) * (ry[i] - mean);
    sxx += (rx[i] - mean) ** 2;
    syy += (ry[i] - mean) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Fewest distinct scores for which the continuous Boyce index is meaningful. */
export const BOYCE_MIN_DISTINCT_SCORES = 5;

export interface BoyceOptions {
  /** Moving-window width as a fraction of the score range (default 0.1). */
  windowFraction?: number;
  /** Number of window positions across the range (default 101). */
  steps?: number;
}

export interface BoyceResult {
  /** Spearman correlation between window centre and P/E ratio, in [−1, 1]. */
  index: number | null;
  /** Window centres that had background points. */
  centers: number[];
  /** Predicted-to-expected ratio per window: (presence share) / (background share). */
  ratios: number[];
}

/**
 * Continuous Boyce index (Hirzel et al. 2006, Ecol. Model. 199:142–152).
 * Suited to presence-only data: a positive, ideally near-1 value means
 * presences become progressively over-represented as suitability rises.
 * Windows span the background score range; windows without background are
 * skipped (P/E undefined).
 */
export function boyceIndex(
  presenceScores: Array<number | null>,
  backgroundScores: Array<number | null>,
  options: BoyceOptions = {}
): BoyceResult {
  const presence = finite(presenceScores);
  const background = finite(backgroundScores);
  const empty: BoyceResult = { index: null, centers: [], ratios: [] };
  if (!presence.length || !background.length) return empty;
  const fraction = options.windowFraction ?? 0.1;
  const steps = options.steps ?? 101;
  if (!(fraction > 0 && fraction <= 1) || !Number.isInteger(steps) || steps < 2)
    return empty;
  const min = Math.min(...background);
  const max = Math.max(...background);
  if (max === min) return empty;
  // A moving-window P/E curve needs a continuous score. With only a few
  // distinct values (e.g. binary limiting-factor BIOCLIM) the windows collapse
  // and Spearman returns an artefactual ±1, so report it as not computed.
  if (new Set([...presence, ...background]).size < BOYCE_MIN_DISTINCT_SCORES)
    return empty;
  const width = (max - min) * fraction;
  const centers: number[] = [];
  const ratios: number[] = [];
  for (let step = 0; step < steps; step++) {
    const low = min + ((max - min - width) * step) / (steps - 1);
    const high = low + width;
    const inWindow = (score: number) => score >= low && score <= high;
    const expected = background.filter(inWindow).length / background.length;
    if (expected === 0) continue;
    const predicted = presence.filter(inWindow).length / presence.length;
    centers.push(low + width / 2);
    ratios.push(predicted / expected);
  }
  return { index: spearman(centers, ratios), centers, ratios };
}

/** Small deterministic PRNG so fold assignment is reproducible from a seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpatialBlockOptions {
  /** Square block edge in degrees (default 1). Blocks are lon/lat cells, not equal-area. */
  blockSizeDeg?: number;
  /** Number of folds (default 5). */
  k?: number;
  /** Seed for the block shuffle (default 42). */
  seed?: number;
}

export interface SpatialBlockAssignment {
  /** Fold index (0..k−1) per input point, or −1 for invalid coordinates. */
  folds: number[];
  /** Block key ("col:row") per input point, or null. */
  blocks: Array<string | null>;
  blockCount: number;
  k: number;
}

/**
 * Assign [lon, lat] points to k folds by spatial block, so every point in a
 * block lands in the same fold. Holding out whole blocks reduces the optimism
 * that spatial autocorrelation causes under random k-fold (Roberts et al.
 * 2017, Ecography 40:913–929). Blocks are shuffled with a seeded PRNG and
 * dealt round-robin, so results are reproducible.
 */
export function spatialBlockFolds(
  coordinates: Array<[number, number]>,
  options: SpatialBlockOptions = {}
): SpatialBlockAssignment | null {
  const size = options.blockSizeDeg ?? 1;
  const k = options.k ?? 5;
  if (!(size > 0) || !Number.isInteger(k) || k < 2) return null;
  const blocks = coordinates.map(([lon, lat]) =>
    Number.isFinite(lon) && Number.isFinite(lat)
      ? `${Math.floor(lon / size)}:${Math.floor(lat / size)}`
      : null
  );
  const unique = [
    ...new Set(blocks.filter((key): key is string => key !== null)),
  ].sort();
  const random = mulberry32(options.seed ?? 42);
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  const foldOf = new Map(unique.map((key, index) => [key, index % k]));
  return {
    folds: blocks.map((key) =>
      key === null ? -1 : (foldOf.get(key) as number)
    ),
    blocks,
    blockCount: unique.length,
    k,
  };
}

export interface SdmCrossValidationInput<M> {
  presences: number[][];
  presenceCoords: Array<[number, number]>;
  background: number[][];
  backgroundCoords: Array<[number, number]>;
  fit: (presences: number[][], background: number[][]) => M | null;
  predict: (values: number[], model: M) => number | null;
  blocks?: SpatialBlockOptions;
  boyce?: BoyceOptions;
}

export interface FoldResult {
  fold: number;
  trainPresences: number;
  trainBackground: number;
  testPresences: number;
  testBackground: number;
  auc: number | null;
  maxTss: ThresholdMetrics | null;
  boyce: number | null;
  /** Why the fold produced no metrics, if it did not. */
  skipped?: string;
}

export interface MetricSummary {
  mean: number | null;
  sd: number | null;
  n: number;
}

export interface SdmCrossValidationResult {
  folds: FoldResult[];
  auc: MetricSummary;
  tss: MetricSummary;
  boyce: MetricSummary;
  blockCount: number;
  provenance: ProvenanceStamp;
}

function summarise(values: Array<number | null | undefined>): MetricSummary {
  const xs = finite(values);
  if (!xs.length) return { mean: null, sd: null, n: 0 };
  const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const sd =
    xs.length > 1
      ? Math.sqrt(
          xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (xs.length - 1)
        )
      : null;
  return { mean, sd, n: xs.length };
}

/**
 * Spatially blocked k-fold cross-validation of any presence-background SDM.
 * Presences and background share one block grid; each fold trains on the
 * other folds and is tested on its own held-out presences against its own
 * held-out background, so test points are spatially separated from training.
 * Folds lacking presences or background on either side are reported as
 * skipped rather than silently dropped.
 */
export function crossValidateSdm<M>(
  input: SdmCrossValidationInput<M>
): SdmCrossValidationResult | null {
  const {
    presences,
    presenceCoords,
    background,
    backgroundCoords,
    fit,
    predict,
  } = input;
  if (
    presences.length !== presenceCoords.length ||
    background.length !== backgroundCoords.length
  ) {
    return null;
  }
  const assignment = spatialBlockFolds(
    [...presenceCoords, ...backgroundCoords],
    input.blocks
  );
  if (!assignment) return null;
  const presenceFolds = assignment.folds.slice(0, presences.length);
  const backgroundFolds = assignment.folds.slice(presences.length);

  const folds: FoldResult[] = [];
  for (let fold = 0; fold < assignment.k; fold++) {
    const pick = (rows: number[][], labels: number[], test: boolean) =>
      rows.filter((_, i) => labels[i] !== -1 && (labels[i] === fold) === test);
    const trainP = pick(presences, presenceFolds, false);
    const trainB = pick(background, backgroundFolds, false);
    const testP = pick(presences, presenceFolds, true);
    const testB = pick(background, backgroundFolds, true);
    const result: FoldResult = {
      fold,
      trainPresences: trainP.length,
      trainBackground: trainB.length,
      testPresences: testP.length,
      testBackground: testB.length,
      auc: null,
      maxTss: null,
      boyce: null,
    };
    if (!testP.length || !testB.length) {
      result.skipped = "held-out fold has no presences or no background";
    } else if (!trainP.length || !trainB.length) {
      result.skipped = "training folds have no presences or no background";
    } else {
      const model = fit(trainP, trainB);
      if (model === null) {
        result.skipped = "model could not be fitted on training folds";
      } else {
        const pScores = testP.map((row) => predict(row, model));
        const bScores = testB.map((row) => predict(row, model));
        result.auc = rocAuc(pScores, bScores);
        result.maxTss = maxTssThreshold(pScores, bScores);
        result.boyce = boyceIndex(pScores, bScores, input.boyce).index;
      }
    }
    folds.push(result);
  }

  return {
    folds,
    auc: summarise(folds.map((f) => f.auc)),
    tss: summarise(folds.map((f) => f.maxTss?.tss)),
    boyce: summarise(folds.map((f) => f.boyce)),
    blockCount: assignment.blockCount,
    provenance: makeProvenance(
      "sdm-cross-validation",
      "Spatially blocked k-fold CV; ROC AUC (Mann–Whitney, presence vs background), max-TSS threshold, continuous Boyce index",
      "Blocks on WGS84 lon/lat degrees (not equal-area)",
      {
        k: assignment.k,
        blockSizeDeg: input.blocks?.blockSizeDeg ?? 1,
        seed: input.blocks?.seed ?? 42,
      }
    ),
  };
}
