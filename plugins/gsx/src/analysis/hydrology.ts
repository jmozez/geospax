// Hydrology helpers — thin client-side wrappers around Whitebox hydrology.
// Provides flow-direction encoding check and sink-fill guard (no silent fallback).

export type D8Direction = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128; // E, SE, S, SW, W, NW, N, NE

export function isD8(value: number): boolean {
  return (
    value === 1 ||
    value === 2 ||
    value === 4 ||
    value === 8 ||
    value === 16 ||
    value === 32 ||
    value === 64 ||
    value === 128
  );
}

/** Percentage of valid flow-direction cells in a sampled D8 grid. */
export function d8Coverage(
  values: number[],
  nodata: number | null = null,
): { valid: number; total: number; coverage: number } {
  let valid = 0;
  for (const v of values) {
    if (nodata !== null && v === nodata) continue;
    if (!Number.isFinite(v)) continue;
    if (isD8(v)) valid++;
  }
  return { valid, total: values.length, coverage: values.length ? valid / values.length : 0 };
}

export interface BasinStats {
  count: number;
  totalCells: number;
  meanSize: number;
  maxSize: number;
}
export function basinStats(cellCounts: number[]): BasinStats {
  if (!cellCounts || cellCounts.length === 0)
    return { count: 0, totalCells: 0, meanSize: 0, maxSize: 0 };
  const totalCells = cellCounts.reduce((s, v) => s + v, 0);
  return {
    count: cellCounts.length,
    totalCells,
    meanSize: totalCells / cellCounts.length,
    maxSize: Math.max(...cellCounts),
  };
}
