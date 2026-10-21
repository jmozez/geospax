// Raster / spectral-index helpers — normalized difference, stats, histogram
// and Otsu threshold. Ported logic from GeoSpaX v1 js/geospax-raster.js
// (Otsu, reclassification) but engineered as pure functions over sampled
// raster windows so they run without any map SDK.
//
// The Environment plugin samples rasters through `app.readRasterWindow` over
// the current view (`app.getViewBounds()`); this module consumes the flat
// value arrays it returns.

import { formatArea } from "./units";

// ---------------------------------------------------------------------------
// Index presets + band-assignment caveat (printed on every result per spec)
// ---------------------------------------------------------------------------

export type IndexPresetId = "NDVI" | "NDWI" | "NDBI" | "NBR" | "CUSTOM";

export interface IndexPreset {
  id: IndexPresetId;
  label: string;
  formula: string;
  aLabel: string;
  bLabel: string;
  description: string;
}

export const INDEX_PRESETS: Record<IndexPresetId, IndexPreset> = {
  NDVI: {
    id: "NDVI",
    label: "NDVI — vegetation vigour",
    formula: "(NIR − Red) / (NIR + Red)",
    aLabel: "NIR",
    bLabel: "Red",
    description: "High NDVI (≈0.3 to 1) tracks photosynthetic vegetation.",
  },
  NDWI: {
    id: "NDWI",
    label: "NDWI — water / wetness (Gao)",
    formula: "(NIR − SWIR) / (NIR + SWIR)  or  (Green − NIR)/(Green+NIR)",
    aLabel: "NIR",
    bLabel: "SWIR",
    description: "Positive NDWI emphasises open water / canopy wetness (Gao 1996).",
  },
  NDBI: {
    id: "NDBI",
    label: "NDBI — built-up / bare",
    formula: "(SWIR − NIR) / (SWIR + NIR)",
    aLabel: "SWIR",
    bLabel: "NIR",
    description: "Positive NDBI highlights built/bare surfaces (Zha et al. 2003).",
  },
  NBR: {
    id: "NBR",
    label: "NBR — burn / moisture ratio",
    formula: "(NIR − SWIR2) / (NIR + SWIR2)",
    aLabel: "NIR",
    bLabel: "SWIR2",
    description: "Low NBR flags burns / low moisture; dNBR differences track severity.",
  },
  CUSTOM: {
    id: "CUSTOM",
    label: "Custom band pair",
    formula: "(A − B) / (A + B)",
    aLabel: "Band A",
    bLabel: "Band B",
    description: "Any two bands from the same raster — apply the same formula.",
  },
};

/**
 * MUST be printed on every index-extent result (spec: "with the band-
 * assignment caveat printed on every result"). Keep it verbatim so tests
 * and audits can assert its presence.
 */
export const BAND_ASSIGNMENT_CAVEAT =
  "Band-assignment caveat: presets label typical sensor bands (e.g. NDVI: NIR vs Red) but do not auto-detect them. " +
  "Verify the two Band numbers you entered actually point to the intended wavelengths for your raster — swapping them " +
  "inverts the index sign and the suggested threshold is meaningless until the assignment is correct.";

// ---------------------------------------------------------------------------
// Normalized-difference grid
// ---------------------------------------------------------------------------

export interface NormalizedDifferenceGrid {
  /** float32 array length width*height, NaN = nodata / zero denominator */
  nd: Float32Array;
  width: number;
  height: number;
  validCells: number;
  nodataCells: number;
  /** stats over valid cells only */
  min: number;
  max: number;
  mean: number;
  /** pass-through nodata sentinel for polygonization */
  rawNodata: null;
}

function isNDNoData(a: number, b: number, nodataA: number | null, nodataB: number | null): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  if (nodataA !== null && a === nodataA) return true;
  if (nodataB !== null && b === nodataB) return true;
  return false;
}

/**
 * Compute (A−B)/(A+B) over two aligned windows.
 *
 * `aValues`/`bValues` must be the same width/height and in row-major order
 * (row 0 = north). Returns a dense Float32Array where invalid cells are NaN.
 * Valid range is mathematically [−1, 1]; values outside arise only from
 * numerical edge cases and are clamped by the caller if needed.
 */
export function normalizedDifferenceGrid(
  aValues: number[],
  bValues: number[],
  width: number,
  height: number,
  nodataA: number | null,
  nodataB: number | null,
): NormalizedDifferenceGrid {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const n = w * h;
  const nd = new Float32Array(n);
  let validCells = 0;
  let nodataCells = 0;
  let min = Infinity,
    max = -Infinity,
    sum = 0;

  if (!aValues || !bValues || aValues.length !== n || bValues.length !== n) {
    nd.fill(Number.NaN);
    return {
      nd,
      width: w,
      height: h,
      validCells: 0,
      nodataCells: n,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      rawNodata: null,
    };
  }

  for (let i = 0; i < n; i++) {
    const a = aValues[i];
    const b = bValues[i];
    if (isNDNoData(a, b, nodataA, nodataB)) {
      nd[i] = Number.NaN;
      nodataCells++;
      continue;
    }
    const denom = a + b;
    if (denom === 0) {
      nd[i] = Number.NaN;
      nodataCells++;
      continue;
    }
    const v = (a - b) / denom;
    // Guard: numerical overflow
    if (!Number.isFinite(v)) {
      nd[i] = Number.NaN;
      nodataCells++;
      continue;
    }
    nd[i] = v;
    validCells++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  const mean = validCells > 0 ? sum / validCells : Number.NaN;
  if (validCells === 0) {
    min = Number.NaN;
    max = Number.NaN;
  }
  return { nd, width: w, height: h, validCells, nodataCells, min, max, mean, rawNodata: null };
}

// ---------------------------------------------------------------------------
// Histogram & Otsu
// ---------------------------------------------------------------------------

export interface Histogram {
  /** binCount length */
  counts: number[];
  /** binCount+1 edges; bins are [edges[i], edges[i+1]) except last is closed */
  edges: number[];
  binCount: number;
  range: [number, number];
  totalValid: number;
}

/**
 * Histogram of valid ND values.
 *
 * Default: 64 bins over [-1, 1]; NaN / out-of-range values are dropped
 * (clamped indices are a silent bias).
 */
export function histogramND(
  nd: Float32Array,
  binCount = 64,
  range: [number, number] = [-1, 1],
): Histogram {
  const [lo, hi] = range;
  const n = Math.max(1, Math.floor(binCount));
  const counts = new Array(n).fill(0);
  const edges: number[] = [];
  const binW = (hi - lo) / n;
  for (let i = 0; i <= n; i++) edges.push(lo + i * binW);
  let totalValid = 0;
  for (let i = 0; i < nd.length; i++) {
    const v = nd[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo || v > hi) continue;
    totalValid++;
    let b = Math.floor((v - lo) / binW);
    if (b < 0) b = 0;
    if (b >= n) b = n - 1;
    counts[b]++;
  }
  return { counts, edges, binCount: n, range, totalValid };
}

export interface OtsuResult {
  /** threshold value (centre of the separating bin), or null if degenerate */
  threshold: number | null;
  /** which bin boundary maximised between-class variance */
  binIndex: number | null;
  /** between-class variance at the chosen bin (diagnostic) */
  betweenVariance: number | null;
}

/**
 * Otsu (1979) threshold over a histogram.
 *
 * Maximises between-class variance; robust for bimodal ND distributions.
 * Returns null when fewer than two occupied bins (no bimodality to split).
 */
export function otsuThreshold(hist: Histogram): OtsuResult {
  const { counts, edges, binCount } = hist;
  const total = counts.reduce((s, c) => s + c, 0);
  if (total === 0) return { threshold: null, binIndex: null, betweenVariance: null };

  // Sum of bin-centre × count
  let sum = 0;
  for (let i = 0; i < binCount; i++) {
    const centre = (edges[i] + edges[i + 1]) / 2;
    sum += centre * counts[i];
  }

  let sumB = 0;
  let wB = 0;
  let maxVar = -Infinity;
  let bestIdx: number | null = null;

  const occupied = counts.filter((c) => c > 0).length;
  if (occupied < 2) return { threshold: null, binIndex: null, betweenVariance: null };

  for (let t = 0; t < binCount; t++) {
    wB += counts[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += ((edges[t] + edges[t + 1]) / 2) * counts[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      bestIdx = t;
    }
  }

  if (bestIdx === null || !Number.isFinite(maxVar)) {
    return { threshold: null, binIndex: null, betweenVariance: null };
  }
  // Threshold sits on the upper edge of the chosen bin (classical), return
  // the bin's upper edge / centre. We return the upper edge so that
  // "ND >= threshold" lands in the high class; centre is equivalent modulo
  // one bin width. Use upper edge for reproducibility.
  const threshold = edges[bestIdx + 1];
  return { threshold, binIndex: bestIdx, betweenVariance: maxVar };
}

// ---------------------------------------------------------------------------
// Stats table formatter (range, mean, valid cells) — for the UI's stats table
// ---------------------------------------------------------------------------

export interface IndexStatsRow {
  min: number;
  max: number;
  mean: number;
  validCells: number;
  nodataCells: number;
  totalCells: number;
}

export function indexStatsRow(g: NormalizedDifferenceGrid): IndexStatsRow {
  return {
    min: g.min,
    max: g.max,
    mean: g.mean,
    validCells: g.validCells,
    nodataCells: g.nodataCells,
    totalCells: g.width * g.height,
  };
}

// ---------------------------------------------------------------------------
// Extent polygonization (threshold → dissolve)
// ---------------------------------------------------------------------------

import type { Feature, Polygon } from "geojson";
import { maskToPixelPolygons } from "./terrain";

/**
 * Mask for ND >= threshold (or > if strict). NaN is always false.
 */
export function maskForThreshold(nd: Float32Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(nd.length);
  for (let i = 0; i < nd.length; i++) {
    const v = nd[i];
    if (!Number.isFinite(v)) continue;
    if (v >= threshold) mask[i] = 1;
  }
  return mask;
}

/**
 * Build pixel rectangles where ND meets the threshold, clipped to WGS84.
 * Dissolving is left to the caller (unionAll) so this stays turf-free.
 */
export function extentPolygonsForThreshold(
  nd: Float32Array,
  width: number,
  height: number,
  bounds: [number, number, number, number],
  threshold: number,
): Feature<Polygon>[] {
  const mask = maskForThreshold(nd, threshold);
  return maskToPixelPolygons(mask, width, height, bounds);
}

// ---------------------------------------------------------------------------
// Helpers for the panel's reporting (area via pixel count, formatted)
// ---------------------------------------------------------------------------

/**
 * Area in m² for `cellCount` pixels at a given pixel area.
 */
export function areaM2ForPixelCount(cellCount: number, pixelAreaM2: number): number {
  return Math.max(0, cellCount) * Math.max(0, pixelAreaM2);
}

/**
 * Lightweight area display the slope and index panels both need. Uses the
 * centre-latitude pixel area (honest declaration) rather than pretending it
 * is LAEA.
 */
export function pixelAreaLabel(pixelAreaM2: number): string {
  const ha = pixelAreaM2 / 10000;
  if (ha < 10) return `${ha.toFixed(2)} ha / pixel`;
  if (ha < 1000) return `${ha.toFixed(1)} ha / pixel`;
  return `${Math.round(ha).toLocaleString("en-AU")} ha / pixel`;
}

// pixelSizeAtCentre lives in terrain.ts — import from there directly to
// avoid a duplicate named export when both modules are re-exported via
// `export * from "./..."` in index.ts.

// ---------------------------------------------------------------------------
// Convenience: the raster-tool warning (shared shape with terrain)
// ---------------------------------------------------------------------------

export function rasterResolutionWarning(
  pixelWidthM: number,
  pixelHeightM: number,
  width: number,
  height: number,
): string | null {
  const maxM = Math.max(pixelWidthM, pixelHeightM);
  if (maxM > 100) {
    return `Coarse sampling: pixel ≈ ${maxM.toFixed(0)} m over the current view (${width}×${height}). Histogram and Otsu are derived from this sampled grid — zoom in or raise the sampling for a finer extent.`;
  }
  if (maxM > 50) {
    return `Pixel ≈ ${maxM.toFixed(0)} m: the index grid is view-dependent. Zooming in refines the histogram and the polygonized extent.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Backwards-compat re-exports for geospax-raster.js parity table (spec says
// raster.ts houses reclassify/Otsu/polygonize; keep the name raster.ts as the
// canonical home and provide a thin alias if older imports expected "indices").
// ---------------------------------------------------------------------------

export const RASTER_VERSION = "2.0.0";

// Unused but avoids dead-import warnings in some build setups.
void formatArea;
