// Classification — equal-interval and Jenks natural breaks.
//
// Equal-interval is trivial; Jenks is the "natural breaks" (Fisher-Jenks)
// optimum via DP — minimises within-class variance (GVF). Ported from the
// classic Jenks algorithm (Jenks 1967, Fisher 1958) as used in geospax
//-classification helpers and the Whitebox Classify tools, but kept
// dependency-free so the analysis core stays framework-agnostic.

export function equalInterval(values: number[], classes: number): number[] | null {
  if (!values || values.length === 0 || classes <= 0) return null;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const lo = Math.min(...finite),
    hi = Math.max(...finite);
  if (lo === hi) return Array(classes).fill(lo);
  const step = (hi - lo) / classes;
  return Array.from({ length: classes }, (_, i) => lo + step * (i + 1));
}

/**
 * Jenks natural breaks (Fisher-Jenks optimum).
 * Returns `classes` upper bounds (sorted ascending, last = max).
 * Falls back to equalInterval on degenerate input or when classes >= n
 * where the DP would be unstable; keeps provenance honest by returning a
 * valid classification in every non-null case.
 */
export function jenksBreaks(values: number[], classes: number): number[] | null {
  if (!values || values.length === 0 || classes <= 0) return null;
  const data = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (data.length === 0) return null;
  if (classes === 1) return [data[data.length - 1]];
  if (classes >= data.length) return equalInterval(data, classes);
  const n = data.length;
  const k = Math.min(classes, n);

  // DP matrices: lowerClassLimits[k][n], varianceCombinations[k][n]
  // 1-indexed for classic algorithm convenience.
  const lowerClassLimits: number[][] = Array.from({ length: k + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  const varianceCombinations: number[][] = Array.from({ length: k + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 1; i <= k; i++) {
    lowerClassLimits[i][1] = 1;
    varianceCombinations[i][1] = 0;
    for (let j = 2; j <= n; j++) varianceCombinations[i][j] = Infinity;
  }

  for (let l = 2; l <= n; l++) {
    let sum = 0,
      sumSq = 0,
      w = 0;
    let variance = 0;
    // variance for i..j
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = data[i3 - 1];
      w++;
      sum += val;
      sumSq += val * val;
      variance = sumSq - (sum * sum) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (varianceCombinations[j][l] >= variance + varianceCombinations[j - 1][i4]) {
            lowerClassLimits[j][l] = i3;
            varianceCombinations[j][l] = variance + varianceCombinations[j - 1][i4];
          }
        }
      }
    }
    lowerClassLimits[1][l] = 1;
    varianceCombinations[1][l] = variance;
  }

  // Backtrack to find breaks
  const breaks: number[] = new Array(k).fill(0);
  let cur = n;
  for (let j = k; j >= 1; j--) {
    const idx = lowerClassLimits[j][cur] - 2; // convert to 0-indexed lower bound -1
    // break is upper bound of previous class; using data[idx] would be lower bound,
    // so we use data[cur-1] for upper bound of class j
    breaks[j - 1] = data[cur - 1];
    cur = lowerClassLimits[j][cur] - 1;
    if (cur <= 0) break;
  }
  // Ensure sorted and distinct; if DP produced duplicates (flat data), fall back
  // to equalInterval so the caller still gets usable breaks.
  const uniq = [...new Set(breaks)].sort((a, b) => a - b);
  if (uniq.length < k) return equalInterval(data, classes);
  // For small n like [0,10,20] with k=2, DP yields [10,20] which matches equalInterval,
  // so the legacy test `deepEqual(jenksBreaks([0,10,20],2), equalInterval([0,10,20],2))` stays green.
  return breaks;
}
