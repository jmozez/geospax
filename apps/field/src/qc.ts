// Quality checks before records leave the phone: weak fixes, duplicate points, areas that cross themselves,
// lines too short to be real, gaps and jumps in tracks, unanswered form questions and stakeout misses.
import type { Rec } from './db';
import { check, type Form } from './forms';
import { offsetNE } from './stakeout';

export interface Issue { id: string; level: 'error' | 'warning'; text: string }
export interface QcOptions { maxAcc: number; dupM: number; gapS: number; minLen: number; stakeTol: number }
export const QC_DEFAULTS: QcOptions = { maxAcc: 10, dupM: 0.5, gapS: 120, minLen: 1, stakeTol: 0.05 };

const d = (a: [number, number], b: [number, number]) => { const o = offsetNE(a, b); return Math.hypot(o.n, o.e); };
const xy = (r: Rec): [number, number][] => r.coords.map((c) => [c[0], c[1]]);

/** Whether segments p1-p2 and p3-p4 cross (touching at shared ends does not count). */
export function crosses(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): boolean {
  const o = (a: [number, number], b: [number, number], c: [number, number]) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p1, p2, p3) * o(p1, p2, p4) < 0 && o(p3, p4, p1) * o(p3, p4, p2) < 0;
}
/** Whether a ring (not closed) has two edges that cross. */
export function selfIntersects(ring: [number, number][]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours through the closing edge
      if (crosses(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}
export const pathLength = (pts: [number, number][]) => pts.slice(1).reduce((s, p, i) => s + d(pts[i], p), 0);

const label = (r: Rec) => (r.note.split('\n')[0].trim() || `${r.kind[0].toUpperCase()}${r.kind.slice(1)}`).slice(0, 40);

/** Every problem found, errors first. */
export function checkRecords(recs: Rec[], forms: Form[], opt: Partial<QcOptions> = {}): Issue[] {
  const o = { ...QC_DEFAULTS, ...opt };
  const out: Issue[] = [];
  const add = (r: Rec, level: Issue['level'], text: string) => out.push({ id: r.id, level, text: `${label(r)}: ${text}` });
  for (const r of recs) {
    const pts = xy(r);
    const accs = r.coords.map((c) => c[4]).filter((a): a is number => a != null);
    if (r.kind === 'point') {
      const a = r.coords[0]?.[4];
      if (a == null) add(r, 'warning', 'accuracy not recorded');
      else if (a > o.maxAcc) add(r, 'warning', `weak fix (±${Math.round(a)} m, limit ${o.maxAcc} m)`);
    } else if (accs.length) {
      const weak = accs.filter((a) => a > o.maxAcc).length;
      if (weak) add(r, 'warning', `${weak} of ${r.coords.length} vertices with a weak fix (over ±${o.maxAcc} m)`);
    }
    if (r.kind === 'line' || r.kind === 'track') {
      if (pts.length < 2) add(r, 'error', 'fewer than 2 vertices');
      else if (pathLength(pts) < o.minLen) add(r, 'warning', `only ${pathLength(pts).toFixed(1)} m long`);
    }
    if (r.kind === 'area') {
      if (pts.length < 3) add(r, 'error', 'fewer than 3 vertices');
      else if (selfIntersects(pts)) add(r, 'error', 'the boundary crosses itself');
    }
    if (r.kind === 'track') {
      let gaps = 0, jumps = 0;
      for (let i = 1; i < r.coords.length; i++) {
        const dt = (r.coords[i][3] - r.coords[i - 1][3]) / 1000;
        if (dt > o.gapS) gaps++;
        else if (dt > 0 && d(pts[i - 1], pts[i]) / dt > 70) jumps++;
      }
      if (gaps) add(r, 'warning', `${gaps} gap${gaps > 1 ? 's' : ''} of over ${o.gapS / 60} min with no fix`);
      if (jumps) add(r, 'warning', `${jumps} jump${jumps > 1 ? 's' : ''} faster than 250 km/h`);
    }
    if (r.form) {
      const f = forms.find((x) => x.name === r.form);
      if (!f) add(r, 'warning', `the form "${r.form}" is not on this phone`);
      else for (const m of check(f, r.attrs ?? {})) add(r, 'error', m);
    }
    const miss = r.attrs?.stake_offset_m;
    if (typeof miss === 'number' && miss > o.stakeTol) add(r, 'warning', `staked ${Math.round(miss * 100)} cm from the design point (tolerance ${Math.round(o.stakeTol * 100)} cm)`);
  }
  // duplicate points: each pair once, against the earlier record
  const points = recs.filter((r) => r.kind === 'point' && r.coords.length).sort((a, b) => a.created - b.created);
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < i; j++) {
      const m = d(xy(points[j])[0], xy(points[i])[0]);
      if (m <= o.dupM) { add(points[i], 'warning', `${m < 0.01 ? 'same place' : `${Math.round(m * 100)} cm`} as ${label(points[j])}, a possible duplicate`); break; }
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}
