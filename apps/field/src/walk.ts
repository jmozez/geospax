// Tracks, walk-to-measure and navigate to a point: the sums behind them, kept apart from the screen so they can
// be tested. Distances are on the sphere (good to well under 1% for field distances); areas use the spherical
// polygon formula, the same approach QGIS and Google Earth use for ellipsoid-free areas.
import type { Vertex } from './db';
import { metres } from './geo';

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Area of a ring of [lon, lat] (closed or not), square metres. */
export function areaM2(ring: [number, number][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    s += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs((s * R * R) / 2);
}
/** Length along points, metres; closed adds the side back to the start. */
export function lengthM(pts: [number, number][], closed = false): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += metres(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) m += metres(pts[pts.length - 1], pts[0]);
  return m;
}
export const xy = (v: Vertex): [number, number] => [v[0], v[1]];

export function fmtLen(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
/** under a hectare in m², then hectares; over 100 ha also km² */
export function fmtArea(m2: number): string {
  if (m2 < 10_000) return `${Math.round(m2)} m²`;
  if (m2 < 1_000_000) return `${(m2 / 10_000).toFixed(2)} ha`;
  return `${(m2 / 10_000).toFixed(0)} ha (${(m2 / 1_000_000).toFixed(2)} km²)`;
}
/** 3725000 → "1:02:05"; 125000 → "2:05" */
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface TrackStats { distance: number; duration: number; moving: number; speed: number | null; gain: number; loss: number }
/**
 * Distance, time, moving time (legs slower than 0.3 m/s or with gaps longer than two minutes, such as a pause,
 * do not count), average moving speed (m/s) and height gained and lost (ignoring changes under 3 m, which are
 * GPS noise).
 */
export function trackStats(coords: Vertex[]): TrackStats {
  let distance = 0, moving = 0, gain = 0, loss = 0;
  let ref: number | null = null;
  for (let i = 0; i < coords.length; i++) {
    const v = coords[i];
    if (i) {
      const p = coords[i - 1];
      const d = metres(xy(p), xy(v));
      const dt = v[3] - p[3];
      distance += d;
      if (dt > 0 && dt <= 120_000 && d / (dt / 1000) >= 0.3) moving += dt;
    }
    if (v[2] != null) {
      if (ref == null) ref = v[2];
      else if (v[2] - ref >= 3) { gain += v[2] - ref; ref = v[2]; }
      else if (ref - v[2] >= 3) { loss += ref - v[2]; ref = v[2]; }
    }
  }
  const duration = coords.length > 1 ? coords[coords.length - 1][3] - coords[0][3] : 0;
  return { distance, duration, moving, speed: moving > 0 ? distance / (moving / 1000) : null, gain, loss };
}

/**
 * Whether a walked fix becomes the next vertex: good enough (±20 m or better for measuring, ±50 m for a track)
 * and at least `step` metres from the last one, so standing still does not pile up points.
 */
export function takeFix(last: Vertex | undefined, lon: number, lat: number, acc: number, step = 3, maxAcc = 20): boolean {
  if (!(acc <= maxAcc)) return false;
  return !last || metres(xy(last), [lon, lat]) >= step;
}

// ------------------------------------------------------------------ navigation
/** Initial great-circle bearing from a to b, degrees from true north. */
export function bearingTo(a: [number, number], b: [number, number]): number {
  const [l1, p1] = [rad(a[0]), rad(a[1])], [l2, p2] = [rad(b[0]), rad(b[1])];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
/** Which way the arrow points on screen: the target's bearing less the way the phone faces, −180..180. */
export function turn(bearing: number, heading: number): number {
  return ((bearing - heading + 540) % 360) - 180;
}
/** Close enough to call it arrived: 5 m, or the GPS accuracy when that is worse. */
export const arrived = (dist: number, acc: number) => dist <= Math.max(5, acc);

export interface Nav { distance: number; bearing: number; eta: number | null; arrived: boolean }
export function navTo(from: { lon: number; lat: number; acc: number; speed?: number | null }, to: [number, number]): Nav {
  const distance = metres([from.lon, from.lat], to);
  const eta = from.speed != null && from.speed > 0.3 ? (distance / from.speed) * 1000 : null;
  return { distance, bearing: bearingTo([from.lon, from.lat], to), eta, arrived: arrived(distance, from.acc) };
}

/**
 * Coordinates typed or pasted: "-9.4431, 147.1803" (lat, lon), "147.1803 -9.4431" when the first can only be a
 * longitude, or degrees, minutes and seconds such as 9°26'35"S 147°10'49"E. Returns [lon, lat] or null.
 */
export function parseCoords(text: string): [number, number] | null {
  const t = text.trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  const dms = [...t.matchAll(/(-?\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*'\s*)?(?:(\d+(?:\.\d+)?)\s*"\s*)?([NSEWnsew])?/g)];
  if (dms.length === 2) {
    let lat: number | null = null, lon: number | null = null;
    for (const [i, m] of dms.entries()) {
      let v = Math.abs(Number(m[1])) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
      const h = (m[4] ?? '').toUpperCase();
      if (h === 'S' || h === 'W' || m[1].startsWith('-')) v = -v;
      if (h === 'N' || h === 'S' || (!h && i === 0)) lat = v; else lon = v;
    }
    return lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
  }
  const nums = t.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return null;
  let [lat, lon] = nums;
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}
