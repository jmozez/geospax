// Staking out: how far to move north and east (or ahead and to the right) to stand on a design point, how
// much to cut or fill to reach its height, and how far the staked mark ended up from it.
import { norm } from './capture';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Metres north and east from a to b (a local plane, good to millimetres over a few hundred metres). */
export function offsetNE(a: [number, number], b: [number, number]): { n: number; e: number } {
  const lat = rad((a[1] + b[1]) / 2);
  let dl = b[0] - a[0];
  if (dl > 180) dl -= 360;
  if (dl < -180) dl += 360;
  return { n: rad(b[1] - a[1]) * R, e: rad(dl) * R * Math.cos(lat) };
}

export interface Stake { n: number; e: number; dist: number; ahead: number | null; right: number | null; dh: number | null; on: boolean }
/** Where the design point is from here; ahead and right when the facing is known; dh is design minus here. */
export function stake(me: [number, number], design: [number, number], facing: number | null, meH: number | null = null, designH: number | null = null, tol = 0.05): Stake {
  const { n, e } = offsetNE(me, design);
  const dist = Math.hypot(n, e);
  let ahead: number | null = null, right: number | null = null;
  if (facing != null) {
    const f = rad(norm(facing));
    ahead = n * Math.cos(f) + e * Math.sin(f);
    right = -n * Math.sin(f) + e * Math.cos(f);
  }
  return { n, e, dist, ahead, right, dh: meH != null && designH != null ? designH - meH : null, on: dist <= tol };
}

const len = (m: number) => (Math.abs(m) < 1 ? `${Math.round(Math.abs(m) * 100)} cm` : `${Math.abs(m).toFixed(2)} m`);
/** "1.24 m north · 35 cm west" */
export const fmtNE = (s: { n: number; e: number }) => `${len(s.n)} ${s.n >= 0 ? 'north' : 'south'} · ${len(s.e)} ${s.e >= 0 ? 'east' : 'west'}`;
/** "2.10 m ahead · 12 cm left" */
export const fmtAhead = (s: Stake) => (s.ahead == null || s.right == null ? '' : `${len(s.ahead)} ${s.ahead >= 0 ? 'ahead' : 'back'} · ${len(s.right)} ${s.right >= 0 ? 'right' : 'left'}`);
/** "Cut 42 cm" when the ground is above the design height, "Fill" when below. */
export const fmtCutFill = (dh: number | null) => (dh == null ? '' : Math.abs(dh) < 0.005 ? 'On grade' : `${dh < 0 ? 'Cut' : 'Fill'} ${len(dh)}`);

export interface Design { id: string; at: [number, number]; h: number | null }
/**
 * Design points pasted as text, one per line: "id, lat, lon[, height]" (commas, tabs, semicolons or spaces).
 * A header line and blank lines are skipped; lines that are not points are reported by number.
 */
export function parseDesign(text: string): { points: Design[]; bad: number[] } {
  const points: Design[] = [], bad: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    const p = l.split(/\s*[,;\t]\s*|\s+/);
    const [id, a, b, h] = p;
    const lat = Number(a), lon = Number(b);
    if (p.length < 3 || !Number.isFinite(lat) || !Number.isFinite(lon)) { if (i > 0 || /\d/.test(l.replace(/^\S+/, ''))) bad.push(i + 1); return; }
    // lon, lat order given by mistake: a latitude cannot be beyond 90
    const [la, lo] = Math.abs(lat) > 90 && Math.abs(lon) <= 90 ? [lon, lat] : [lat, lon];
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return void bad.push(i + 1);
    const hh = h != null && h !== '' && Number.isFinite(Number(h)) ? Number(h) : null;
    points.push({ id: id || `S${points.length + 1}`, at: [lo, la], h: hh });
  });
  return { points, bad };
}
