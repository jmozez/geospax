// The Design tab's Modify commands, as plane geometry (metres east, north): move, rotate, scale and
// mirror any geometry; trim and extend lines against other lines; fillet a corner with an arc.
// Pure functions, so cad.ts only picks features and saves results.

export type XY = [number, number];

/** Every coordinate of a GeoJSON geometry through `f` (positions in, positions out). */
export function mapGeometry(g: GeoJSON.Geometry, f: (p: XY) => XY): GeoJSON.Geometry {
  const pt = (c: GeoJSON.Position) => f([c[0], c[1]]) as GeoJSON.Position;
  switch (g.type) {
    case 'Point': return { type: 'Point', coordinates: pt(g.coordinates) };
    case 'MultiPoint': return { type: 'MultiPoint', coordinates: g.coordinates.map(pt) };
    case 'LineString': return { type: 'LineString', coordinates: g.coordinates.map(pt) };
    case 'MultiLineString': return { type: 'MultiLineString', coordinates: g.coordinates.map((l) => l.map(pt)) };
    case 'Polygon': return { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(pt)) };
    case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map((r) => r.map(pt))) };
    case 'GeometryCollection': return { type: 'GeometryCollection', geometries: g.geometries.map((x) => mapGeometry(x, f)) };
  }
}

export const translate = (d: XY) => (p: XY): XY => [p[0] + d[0], p[1] + d[1]];

/** Counter-clockwise by `deg` about `o`, as AutoCAD ROTATE. */
export const rotate = (o: XY, deg: number) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return (p: XY): XY => [o[0] + (p[0] - o[0]) * c - (p[1] - o[1]) * s, o[1] + (p[0] - o[0]) * s + (p[1] - o[1]) * c];
};

export const scale = (o: XY, k: number) => (p: XY): XY => [o[0] + (p[0] - o[0]) * k, o[1] + (p[1] - o[1]) * k];

/** Reflection across the line through a and b. */
export const mirror = (a: XY, b: XY) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
  return (p: XY): XY => {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L;
    const fx = a[0] + t * dx, fy = a[1] + t * dy;
    return [2 * fx - p[0], 2 * fy - p[1]];
  };
};

/** Where segments p→p2 and q→q2 cross: the parameters along each (0..1), or null. */
function cross(p: XY, p2: XY, q: XY, q2: XY): [number, number] | null {
  const r = [p2[0] - p[0], p2[1] - p[1]], s = [q2[0] - q[0], q2[1] - q[1]];
  const d = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(d) < 1e-12) return null;
  const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / d;
  const u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / d;
  return [t, u];
}

/** Distance along a polyline (cumulative) of segment i at fraction t. */
function along(line: XY[], i: number, t: number): number {
  let s = 0;
  for (let k = 0; k < i; k++) s += Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
  return s + t * Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
}

/** The point of a polyline at a distance along it, and the vertices before it. */
function cut(line: XY[], d: number): { at: XY; i: number } {
  let s = 0;
  for (let k = 0; k < line.length - 1; k++) {
    const L = Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
    if (s + L >= d || k === line.length - 2) {
      const t = L > 0 ? Math.min(1, Math.max(0, (d - s) / L)) : 0;
      return { at: [line[k][0] + t * (line[k + 1][0] - line[k][0]), line[k][1] + t * (line[k + 1][1] - line[k][1])], i: k };
    }
    s += L;
  }
  return { at: line[line.length - 1], i: line.length - 2 };
}

function sub(line: XY[], d0: number, d1: number): XY[] {
  const a = cut(line, d0), b = cut(line, d1);
  return [a.at, ...line.slice(a.i + 1, b.i + 1), b.at];
}

/** Nearest position along a polyline to a point. */
function project(line: XY[], p: XY): number {
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    const d = Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    if (d < best.d) best = { d, s: along(line, i, t) };
  }
  return best.s;
}

/** AutoCAD TRIM: the piece of `line` around `at` between its nearest crossings with `cutters` is
 *  removed; returns the pieces that stay (none when nothing crosses it). */
export function trim(line: XY[], cutters: XY[][], at: XY): XY[][] | null {
  const xs: number[] = [];
  for (let i = 0; i < line.length - 1; i++)
    for (const c of cutters)
      for (let j = 0; j < c.length - 1; j++) {
        const h = cross(line[i], line[i + 1], c[j], c[j + 1]);
        if (h && h[0] >= -1e-9 && h[0] <= 1 + 1e-9 && h[1] >= -1e-9 && h[1] <= 1 + 1e-9) xs.push(along(line, i, h[0]));
      }
  if (!xs.length) return null;
  const total = along(line, line.length - 2, 1);
  const s = project(line, at);
  const before = Math.max(0, ...xs.filter((x) => x < s - 1e-6));
  const after = Math.min(total, ...xs.filter((x) => x > s + 1e-6));
  const out: XY[][] = [];
  if (before > 1e-6) out.push(sub(line, 0, before));
  if (after < total - 1e-6) out.push(sub(line, after, total));
  return out;
}

/** AutoCAD EXTEND: the end of `line` nearer `at` runs on along its last segment to the first line it
 *  meets; null when it meets none. */
export function extend(line: XY[], cutters: XY[][], at: XY): XY[] | null {
  const n = line.length;
  const startEnd = Math.hypot(line[0][0] - at[0], line[0][1] - at[1]) < Math.hypot(line[n - 1][0] - at[0], line[n - 1][1] - at[1]);
  const [from, to] = startEnd ? [line[1], line[0]] : [line[n - 2], line[n - 1]];
  const dir: XY = [to[0] - from[0], to[1] - from[1]];
  const far: XY = [to[0] + dir[0] * 1e6, to[1] + dir[1] * 1e6];
  let best = Infinity;
  for (const c of cutters)
    for (let j = 0; j < c.length - 1; j++) {
      const h = cross(to, far, c[j], c[j + 1]);
      if (h && h[0] > 1e-12 && h[1] >= -1e-9 && h[1] <= 1 + 1e-9) best = Math.min(best, h[0]);
    }
  if (!Number.isFinite(best)) return null;
  const end: XY = [to[0] + (far[0] - to[0]) * best, to[1] + (far[1] - to[1]) * best];
  return startEnd ? [end, ...line.slice(1)] : [...line.slice(0, -1), end];
}

/** AutoCAD FILLET on one corner: vertex i of a polyline (or a closed ring) replaced by a tangent arc
 *  of radius r. Null when the corner is straight or the legs are too short for the radius. */
export function fillet(line: XY[], i: number, r: number, closed: boolean): XY[] | null {
  const n = closed ? line.length - 1 : line.length; // a closed ring repeats its first point
  if (!closed && (i <= 0 || i >= n - 1)) return null;
  const A = line[(i - 1 + n) % n], V = line[i], B = line[(i + 1) % n];
  const la = Math.hypot(A[0] - V[0], A[1] - V[1]), lb = Math.hypot(B[0] - V[0], B[1] - V[1]);
  const ua: XY = [(A[0] - V[0]) / la, (A[1] - V[1]) / la], ub: XY = [(B[0] - V[0]) / lb, (B[1] - V[1]) / lb];
  const cosT = ua[0] * ub[0] + ua[1] * ub[1];
  const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return null;
  const t = r / Math.tan(theta / 2);
  if (t > la + 1e-9 || t > lb + 1e-9) return null;
  const T1: XY = [V[0] + ua[0] * t, V[1] + ua[1] * t], T2: XY = [V[0] + ub[0] * t, V[1] + ub[1] * t];
  const bis: XY = [ua[0] + ub[0], ua[1] + ub[1]], bl = Math.hypot(bis[0], bis[1]);
  const h = r / Math.sin(theta / 2);
  const C: XY = [V[0] + (bis[0] / bl) * h, V[1] + (bis[1] / bl) * h];
  let a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
  let a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(d) / (Math.PI / 24)));
  const arc: XY[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = a1 + (d * k) / steps;
    arc.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]);
  }
  const pts = line.slice(0, n);
  pts.splice(i, 1, ...arc);
  return closed ? [...pts, pts[0]] : pts;
}

/** The vertex of a polyline nearest a point. */
export function nearestVertex(line: XY[], p: XY): number {
  let best = 0, bd = Infinity;
  line.forEach((q, i) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) [best, bd] = [i, d];
  });
  return best;
}

/** Points along a polyline at the given distances from its start (AutoCAD DIVIDE and MEASURE). */
export function pointsAlong(line: XY[], ds: number[]): XY[] {
  return ds.map((d) => cut(line, d).at);
}

/** Length of a polyline. */
export function lengthOf(line: XY[]): number {
  return line.length < 2 ? 0 : along(line, line.length - 2, 1);
}

/** DIVIDE into n equal parts: the n − 1 inner points. MEASURE every `step`: the points after the start. */
export function divide(line: XY[], n: number): XY[] {
  const L = lengthOf(line);
  return pointsAlong(line, Array.from({ length: Math.max(0, n - 1) }, (_, i) => (L * (i + 1)) / n));
}

export function measure(line: XY[], step: number): XY[] {
  const L = lengthOf(line), ds: number[] = [];
  // no point at the very end (1 cm of slack for the local plane's rounding)
  for (let d = step; d < L - 0.01; d += step) ds.push(d);
  return pointsAlong(line, ds);
}

/** JOIN: two polylines whose ends lie within `tol` metres become one (either may be reversed); null
 *  when no end of one is near an end of the other. */
export function join(a: XY[], b: XY[], tol: number): XY[] | null {
  const d = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const A0 = a[0], A1 = a[a.length - 1], B0 = b[0], B1 = b[b.length - 1];
  const options: [number, () => XY[]][] = [
    [d(A1, B0), () => [...a, ...b.slice(1)]],
    [d(A1, B1), () => [...a, ...[...b].reverse().slice(1)]],
    [d(A0, B1), () => [...b, ...a.slice(1)]],
    [d(A0, B0), () => [...[...b].reverse(), ...a.slice(1)]],
  ];
  options.sort((x, y) => x[0] - y[0]);
  return options[0][0] <= tol ? options[0][1]() : null;
}

/** BREAK at a point: the line split where it passes nearest `at` (null at or beyond an end). */
export function breakAt(line: XY[], at: XY): [XY[], XY[]] | null {
  const L = lengthOf(line), d = project(line, at);
  if (d < 1e-3 || d > L - 1e-3) return null;
  return [sub(line, 0, d), sub(line, d, L)];
}

/** LENGTHEN the end of a line nearer `at` by `delta` metres (negative shortens), along its end
 *  segment when growing; null when it would vanish. */
export function lengthen(line: XY[], at: XY, delta: number): XY[] | null {
  const L = lengthOf(line);
  if (L + delta <= 1e-3) return null;
  const n = line.length;
  const atEnd = Math.hypot(line[n - 1][0] - at[0], line[n - 1][1] - at[1]) <= Math.hypot(line[0][0] - at[0], line[0][1] - at[1]);
  const l = atEnd ? line : [...line].reverse();
  let out: XY[];
  if (delta >= 0) {
    const a = l[l.length - 2], b = l[l.length - 1], s = Math.hypot(b[0] - a[0], b[1] - a[1]);
    out = [...l.slice(0, -1), [b[0] + ((b[0] - a[0]) / s) * delta, b[1] + ((b[1] - a[1]) / s) * delta]];
  } else out = sub(l, 0, L + delta);
  return atEnd ? out : out.reverse();
}

/** CHAMFER one corner: vertex i replaced by a straight cut d1 metres back along the incoming leg and
 *  d2 along the outgoing one. Null at an end, on a straight corner, or when a leg is too short. */
export function chamfer(line: XY[], i: number, d1: number, d2: number, closed: boolean): XY[] | null {
  const n = closed ? line.length - 1 : line.length;
  if (!closed && (i <= 0 || i >= n - 1)) return null;
  const A = line[(i - 1 + n) % n], V = line[i], B = line[(i + 1) % n];
  const la = Math.hypot(A[0] - V[0], A[1] - V[1]), lb = Math.hypot(B[0] - V[0], B[1] - V[1]);
  if (d1 <= 0 || d2 <= 0 || d1 > la + 1e-9 || d2 > lb + 1e-9) return null;
  const cross = (A[0] - V[0]) * (B[1] - V[1]) - (A[1] - V[1]) * (B[0] - V[0]);
  if (Math.abs(cross) < 1e-9 * la * lb) return null;
  const P: XY = [V[0] + ((A[0] - V[0]) / la) * d1, V[1] + ((A[1] - V[1]) / la) * d1];
  const Q: XY = [V[0] + ((B[0] - V[0]) / lb) * d2, V[1] + ((B[1] - V[1]) / lb) * d2];
  const pts = line.slice(0, n);
  pts.splice(i, 1, P, Q);
  return closed ? [...pts, pts[0]] : pts;
}

/** STRETCH: the vertices inside the box [x0,y0,x1,y1] moved by d, the rest kept (shared corners of a
 *  ring's closing point move together). */
export function stretch(g: GeoJSON.Geometry, toXY: (p: XY) => XY, toLL: (p: XY) => XY, box: [number, number, number, number], d: XY): { geometry: GeoJSON.Geometry; moved: number } {
  let moved = 0;
  const geometry = mapGeometry(g, (q) => {
    const p = toXY(q);
    if (p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3]) {
      moved++;
      return toLL([p[0] + d[0], p[1] + d[1]]);
    }
    return q;
  });
  return { geometry, moved };
}
