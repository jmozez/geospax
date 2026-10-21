// Biodiversity — richness and diversity indices.

export function richness(presences: Array<Set<string> | string[]>): number {
  const all = new Set<string>();
  for (const s of presences) for (const sp of s) all.add(sp);
  return all.size;
}

export function shannon(counts: number[]): number | null {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total <= 0 || counts.length === 0) return null;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h;
}

export function simpson(counts: number[]): number | null {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total <= 1 || counts.length === 0) return null;
  let sum = 0;
  for (const c of counts) sum += (c * (c - 1)) / (total * (total - 1));
  return 1 - sum;
}
