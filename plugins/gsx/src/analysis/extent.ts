// Min and max of any number of values. Math.min(...values) passes every value as an argument and
// overflows the call stack beyond about 100,000 (a 400 × 300 raster), so loops replace it; same results.
export function minOf(values: ArrayLike<number>): number {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < m || Number.isNaN(values[i])) m = Number.isNaN(values[i]) ? NaN : values[i];
  return m;
}

export function maxOf(values: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > m || Number.isNaN(values[i])) m = Number.isNaN(values[i]) ? NaN : values[i];
  return m;
}
