// Zonal & descriptive statistics — framework-free, tested with golden values.

export interface DescriptiveStats {
  count: number;
  valid: number;
  nodata: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  stddev: number | null;
}

export function descriptiveStats(values: number[], nodata: number | null = null): DescriptiveStats {
  const validVals: number[] = [];
  let nodataCount = 0;
  for (const v of values) {
    if (!Number.isFinite(v) || (nodata !== null && v === nodata)) nodataCount++;
    else validVals.push(v);
  }
  if (validVals.length === 0) {
    return {
      count: values.length,
      valid: 0,
      nodata: nodataCount,
      min: null,
      max: null,
      mean: null,
      median: null,
      stddev: null,
    };
  }
  validVals.sort((a, b) => a - b);
  const min = validVals[0];
  const max = validVals[validVals.length - 1];
  const mean = validVals.reduce((s, v) => s + v, 0) / validVals.length;
  const mid = Math.floor(validVals.length / 2);
  const median =
    validVals.length % 2 === 1 ? validVals[mid] : (validVals[mid - 1] + validVals[mid]) / 2;
  const variance = validVals.reduce((s, v) => s + (v - mean) ** 2, 0) / validVals.length;
  return {
    count: values.length,
    valid: validVals.length,
    nodata: nodataCount,
    min,
    max,
    mean,
    median,
    stddev: Math.sqrt(variance),
  };
}

export function zonalMean(
  zones: Array<{ zoneId: string | number; values: number[] }>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const z of zones) {
    const s = descriptiveStats(z.values);
    out[String(z.zoneId)] = s.mean;
  }
  return out;
}
