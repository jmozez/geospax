// Shared helpers for the industry tools (surveying, energy, mining, maritime, aviation, transport,
// planning, assets, climate outlook): parameters, local metric projections, a road graph and a
// least-cost grid search. Inputs arrive as WGS84 GeoJSON (GeoSpaX hands layers that way).
import proj4 from 'proj4';
import type { Feature, Geometry, LineString, Position } from 'geojson';
import type { Ctx, Grid, Param } from '../tools';

export const num = (ctx: Ctx, name: string, dflt?: number): number => {
  const v = ctx.params[name];
  if (v === undefined || v === null || v === '') {
    if (dflt === undefined) throw new Error(`'${name}' is required`);
    return dflt;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${name}' must be a number`);
  return n;
};
export const optNum = (ctx: Ctx, name: string): number | null => {
  const v = ctx.params[name];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${name}' must be a number`);
  return n;
};
export const str = (ctx: Ctx, name: string, dflt = ''): string => String(ctx.params[name] ?? dflt).trim() || dflt;
export const bool = (ctx: Ctx, name: string, dflt = false): boolean => {
  const v = ctx.params[name];
  if (v === undefined || v === null || v === '') return dflt;
  return v === true || /^(true|yes|1|on)$/i.test(String(v));
};
export const need = (ctx: Ctx, name: string, what: string): Feature[] => {
  const f = ctx.layer(name);
  if (!f) throw new Error(`Choose ${what}`);
  if (!f.length) throw new Error(`${ctx.layerName(name)} has no features`);
  return f;
};
export const needRaster = (ctx: Ctx, name: string, what: string): Grid => {
  const g = ctx.raster(name);
  if (!g) throw new Error(`Choose ${what}`);
  return g;
};
export const fix = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '-' : Number(v.toFixed(d)));
export const haText = (m2: number) => `${(m2 / 10000).toFixed(2)} ha`;
export const layerP = (name: string, label: string, required = true, description?: string): Param => ({ name, label, kind: 'layer', required, description });
export const fieldP = (name: string, label: string, required = false, description?: string): Param => ({ name, label, kind: 'field', required, description });
export const numP = (name: string, label: string, dflt: number, description?: string): Param => ({ name, label, kind: 'number', default: dflt, description });
export const textP = (name: string, label: string, dflt: string, description?: string): Param => ({ name, label, kind: 'text', default: dflt, description });
export const rasterP = (name: string, label: string, required = true, description?: string): Param => ({ name, label, kind: 'raster', required, description });
export const choiceP = (name: string, label: string, choices: string[], description?: string): Param => ({ name, label, kind: 'choice', default: choices[0], choices, description });

/** every coordinate of a geometry */
export function coordsOf(g: Geometry | null | undefined): Position[] {
  if (!g) return [];
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'MultiPoint': case 'LineString': return g.coordinates;
    case 'MultiLineString': case 'Polygon': return g.coordinates.flat();
    case 'MultiPolygon': return g.coordinates.flat(2);
    case 'GeometryCollection': return g.geometries.flatMap(coordsOf);
  }
}
/** the line strings of a geometry */
export function linesOf(g: Geometry | null | undefined): Position[][] {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}
/** a representative point: the point itself, or the mean of the vertices */
export function pointOf(f: Feature): Position | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  const c = coordsOf(g);
  if (!c.length) return null;
  return [c.reduce((a, p) => a + p[0], 0) / c.length, c.reduce((a, p) => a + p[1], 0) / c.length];
}

/** A local azimuthal equidistant projection centred on the data: metres, accurate to well under
 *  0.1 % within a few hundred kilometres of the centre. */
export function localMetric(features: Feature[] | Position[]) {
  const pts = (features as unknown[]).flatMap((x) => (Array.isArray(x) ? [x as Position] : coordsOf((x as Feature).geometry)));
  if (!pts.length) throw new Error('The layer has no coordinates');
  const lon0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const conv = proj4('EPSG:4326', `+proj=aeqd +lat_0=${lat0} +lon_0=${lon0} +datum=WGS84 +units=m +no_defs`);
  return {
    lon0, lat0,
    fwd: (p: Position): [number, number] => conv.forward([p[0], p[1]]) as [number, number],
    inv: (p: Position): [number, number] => conv.inverse([p[0], p[1]]) as [number, number],
  };
}
export type Metric = ReturnType<typeof localMetric>;

export const dist = (a: Position, b: Position) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** distance from p to segment ab (planar), with the position along it (0..1) */
export function segDist(p: Position, a: Position, b: Position) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return { d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t };
}
/** distance from p to a set of planar polylines, and the distance along the nearest one */
export function lineDist(p: Position, lines: Position[][]) {
  let best = { d: Infinity, along: 0, line: -1 };
  lines.forEach((ln, li) => {
    let run = 0;
    for (let i = 1; i < ln.length; i++) {
      const s = segDist(p, ln[i - 1], ln[i]);
      const len = dist(ln[i - 1], ln[i]);
      if (s.d < best.d) best = { d: s.d, along: run + s.t * len, line: li };
      run += len;
    }
  });
  return best;
}
/** planar point in polygon (rings: outer first, then holes) */
export function inRings(p: Position, rings: Position[][]): boolean {
  let inside = false;
  rings.forEach((ring) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  });
  return inside;
}
export function polygonsOf(g: Geometry | null | undefined): Position[][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}
/** planar shoelace area of rings (outer minus holes), m² */
export function ringsArea(rings: Position[][]): number {
  const a = (r: Position[]) => {
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(s) / 2;
  };
  return rings.length ? a(rings[0]) - rings.slice(1).reduce((t, r) => t + a(r), 0) : 0;
}
/** distance from p to a polygon (0 inside) in planar metres */
export function polyDist(p: Position, polys: Position[][][]): number {
  let best = Infinity;
  for (const rings of polys) {
    if (inRings(p, rings)) return 0;
    best = Math.min(best, lineDist(p, rings).d);
  }
  return best;
}
export const lineFeature = (coords: Position[], props: Record<string, unknown>): Feature<LineString> => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
export const pointFeature = (c: Position, props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });
export const polyFeature = (ring: Position[], props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });

// ---------------------------------------------------------------- a road graph

/** A graph from line features: vertices shared by two lines (to 0.1 m) are junctions. Edge
 *  weight = length in metres, or minutes when a speed (km/h) is given per line. */
export function buildGraph(lines: Feature[], m: Metric, speedField = '', defaultKmh = 0) {
  const key = (p: [number, number]) => `${Math.round(p[0] * 10)}:${Math.round(p[1] * 10)}`;
  const nodes: [number, number][] = [];
  const ll: Position[] = [];
  const index = new Map<string, number>();
  const adj: { to: number; w: number; len: number; f: number }[][] = [];
  const node = (p: Position) => {
    const xy = m.fwd(p);
    const k = key(xy);
    let i = index.get(k);
    if (i === undefined) { i = nodes.length; index.set(k, i); nodes.push(xy); ll.push(p); adj.push([]); }
    return i;
  };
  lines.forEach((f, fi) => {
    const kmh = Number(speedField ? f.properties?.[speedField] : NaN);
    const speed = Number.isFinite(kmh) && kmh > 0 ? kmh : defaultKmh;
    for (const ln of linesOf(f.geometry)) {
      for (let i = 1; i < ln.length; i++) {
        const a = node(ln[i - 1]), b = node(ln[i]);
        if (a === b) continue;
        const len = dist(nodes[a], nodes[b]);
        const w = speed > 0 ? len / 1000 / speed * 60 : len;
        adj[a].push({ to: b, w, len, f: fi });
        adj[b].push({ to: a, w, len, f: fi });
      }
    }
  });
  if (!nodes.length) throw new Error('The network layer has no lines');
  const nearest = (p: Position) => {
    const xy = m.fwd(p);
    let bi = 0, bd = Infinity;
    nodes.forEach((n, i) => { const d = dist(n, xy); if (d < bd) { bd = d; bi = i; } });
    return { node: bi, snap: bd };
  };
  return { nodes, ll, adj, nearest, timed: defaultKmh > 0 || !!speedField };
}
export type Graph = ReturnType<typeof buildGraph>;

/** Dijkstra from a set of sources (binary heap). */
export function dijkstra(g: Graph, sources: number[], cutoff = Infinity) {
  const n = g.nodes.length;
  const cost = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const origin = new Int32Array(n).fill(-1);
  const heap: [number, number][] = [];
  const push = (c: number, i: number) => {
    heap.push([c, i]);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let s = k;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === k) break;
        [heap[s], heap[k]] = [heap[k], heap[s]];
        k = s;
      }
    }
    return top;
  };
  sources.forEach((s, si) => { cost[s] = 0; origin[s] = si; push(0, s); });
  while (heap.length) {
    const [c, u] = pop();
    if (c > cost[u]) continue;
    for (const e of g.adj[u]) {
      const nc = c + e.w;
      if (nc < cost[e.to] && nc <= cutoff * (1 + 1e-9) + 1e-6) { cost[e.to] = nc; prev[e.to] = u; origin[e.to] = origin[u]; push(nc, e.to); }
    }
  }
  const path = (to: number): number[] => {
    if (!Number.isFinite(cost[to])) return [];
    const out = [to];
    while (prev[out[out.length - 1]] >= 0) out.push(prev[out[out.length - 1]]);
    return out.reverse();
  };
  return { cost, prev, origin, path };
}

// ---------------------------------------------------------------- grids

export const cellCentre = (g: Grid, c: number, r: number): [number, number] => {
  const [x0, dx, , y0, , dy] = g.transform;
  return [x0 + (c + 0.5) * dx, y0 + (r + 0.5) * dy];
};
/** raster CRS to lon/lat and back */
export function gridProj(g: Grid) {
  if (g.geographic || !g.crs) return { toLL: (p: Position) => [p[0], p[1]] as [number, number], fromLL: (p: Position) => [p[0], p[1]] as [number, number] };
  const conv = proj4(g.crs, 'EPSG:4326');
  return { toLL: (p: Position) => conv.forward([p[0], p[1]]) as [number, number], fromLL: (p: Position) => conv.inverse([p[0], p[1]]) as [number, number] };
}
/** cell width and height in metres */
export function cellMetres(g: Grid): { w: number; h: number } {
  const dx = Math.abs(g.transform[1]), dy = Math.abs(g.transform[5]);
  if (!g.geographic) return { w: dx, h: dy };
  const lat = g.transform[3] + (g.height / 2) * g.transform[5];
  return { w: dx * 111320 * Math.cos((lat * Math.PI) / 180), h: dy * 110574 };
}
export const sameGrid = (a: Grid, b: Grid) => a.width === b.width && a.height === b.height && a.transform.every((v, i) => Math.abs(v - b.transform[i]) < 1e-9);
export const cellOf = (g: Grid, p: Position) => {
  const [x0, dx, , y0, , dy] = g.transform;
  const c = Math.floor((p[0] - x0) / dx), r = Math.floor((p[1] - y0) / dy);
  return c < 0 || r < 0 || c >= g.width || r >= g.height ? -1 : r * g.width + c;
};

/** 8-neighbour least-cost path over a per-cell cost (NaN or Infinity = impassable). Step cost =
 *  mean of the two cells times the step length in metres. */
export function leastCostPath(g: Grid, cost: Float32Array, from: number, to: number) {
  const { w, h } = cellMetres(g);
  const W = g.width, n = g.width * g.height;
  const acc = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap: [number, number][] = [];
  const push = (c: number, i: number) => { heap.push([c, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let s = k; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === k) break; [heap[s], heap[k]] = [heap[k], heap[s]]; k = s; } } return top; };
  const ok = (i: number) => Number.isFinite(cost[i]);
  if (!ok(from) || !ok(to)) throw new Error('The start or the end is on an impassable cell');
  acc[from] = 0;
  push(0, from);
  const steps: [number, number, number][] = [[-1, 0, w], [1, 0, w], [0, -1, h], [0, 1, h], [-1, -1, Math.hypot(w, h)], [1, -1, Math.hypot(w, h)], [-1, 1, Math.hypot(w, h)], [1, 1, Math.hypot(w, h)]];
  while (heap.length) {
    const [c, u] = pop();
    if (u === to) break;
    if (c > acc[u]) continue;
    const ux = u % W, uy = (u - ux) / W;
    for (const [sx, sy, len] of steps) {
      const x = ux + sx, y = uy + sy;
      if (x < 0 || y < 0 || x >= W || y >= g.height) continue;
      const v = y * W + x;
      if (!ok(v)) continue;
      const nc = c + ((cost[u] + cost[v]) / 2) * len;
      if (nc < acc[v]) { acc[v] = nc; prev[v] = u; push(nc, v); }
    }
  }
  if (!Number.isFinite(acc[to])) throw new Error('No passable route joins the start and the end');
  const cells = [to];
  while (prev[cells[cells.length - 1]] >= 0) cells.push(prev[cells[cells.length - 1]]);
  cells.reverse();
  let length = 0;
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i];
    length += Math.hypot(((a % W) - (b % W)) * w, (Math.floor(a / W) - Math.floor(b / W)) * h);
  }
  return { cells, cost: acc[to], length };
}

/** slope in degrees by central differences (edges one-sided), NaN where a neighbour is missing */
export function slopeDegrees(g: Grid, dem: Float32Array): Float32Array {
  const { w, h } = cellMetres(g);
  const W = g.width, H = g.height;
  const out = new Float32Array(W * H);
  const at = (x: number, y: number) => dem[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dzdx = (at(x + 1, y) - at(x - 1, y)) / ((Math.min(W - 1, x + 1) - Math.max(0, x - 1)) * w || 1);
    const dzdy = (at(x, y + 1) - at(x, y - 1)) / ((Math.min(H - 1, y + 1) - Math.max(0, y - 1)) * h || 1);
    out[y * W + x] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  }
  return out;
}

/** a date field as epoch milliseconds, or NaN */
export const timeOf = (v: unknown): number => {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(String(v));
  return t;
};
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
