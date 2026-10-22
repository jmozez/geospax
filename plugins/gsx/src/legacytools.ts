// Tools from GeoSpaX 1.4.2 (jm0535/map-kit) rebuilt for GeoSpaX 3: local Moran's I (LISA) with the
// global Moran's I and its scatterplot, and the elevation profile (along lines over a DEM, or through
// points with an elevation field). Same methods as 1.4.2's documentation (Anselin 1995; conditional
// permutation), written for the plugin contract.
import type { Feature, Geometry, Position } from 'geojson';
import centroid from '@turf/centroid';
import type { Ctx, Param, Tool } from './tools';
import { cellSize, projector } from './rastertools';

const STATS = 'Spatial Statistics › Clusters and outliers';
const TERRAIN = 'Terrain › Profiles';
export const TAB_OF_LEGACY: Record<string, string> = { [STATS]: 'analyze', [TERRAIN]: 'imagery' };

const R = 6371008.8;
const rad = Math.PI / 180;
const hav = (a: Position, b: Position) => {
  const dla = (b[1] - a[1]) * rad;
  const dlo = (b[0] - a[0]) * rad;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const num = (ctx: Ctx, name: string, dflt: number) => {
  const v = ctx.params[name];
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${name}' must be a number`);
  return n;
};
const str = (ctx: Ctx, name: string, dflt = '') => String(ctx.params[name] ?? dflt).trim() || dflt;
const f3 = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(4)) : '—');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Seeded PRNG (mulberry32): the same seed gives the same permutations, hence the same p-values. */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- neighbours

type Nb = number[][];

/** Queen contiguity: polygons sharing at least one vertex (coordinates rounded to ~1 cm). */
function contiguity(feats: Feature[]): Nb {
  const byVertex = new Map<string, number[]>();
  feats.forEach((f, i) => {
    const seen = new Set<string>();
    const visit = (c: Position) => {
      const k = `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
      if (seen.has(k)) return;
      seen.add(k);
      const arr = byVertex.get(k) ?? [];
      arr.push(i);
      byVertex.set(k, arr);
    };
    const g = f.geometry as Geometry;
    if (g.type === 'Polygon') g.coordinates.forEach((r) => r.forEach(visit));
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((r) => r.forEach(visit)));
  });
  const nb: Set<number>[] = feats.map(() => new Set());
  for (const ids of byVertex.values()) for (const a of ids) for (const b of ids) if (a !== b) nb[a].add(b);
  return nb.map((s) => [...s]);
}

function knn(pts: Position[], k: number): Nb {
  return pts.map((p, i) =>
    pts
      .map((q, j) => [j, i === j ? Infinity : hav(p, q)] as [number, number])
      .sort((a, b) => a[1] - b[1])
      .slice(0, k)
      .map(([j]) => j),
  );
}

function band(pts: Position[], km: number): Nb {
  const d = km * 1000;
  return pts.map((p, i) => pts.flatMap((q, j) => (i !== j && hav(p, q) <= d ? [j] : [])));
}

// ---------------------------------------------------------------- Moran

export interface LisaResult {
  I: number;
  expected: number;
  pGlobal: number;
  zSim: number;
  local: { I: number; lag: number; z: number; p: number; cluster: string }[];
}

/** Global and local Moran's I with row-standardised weights and conditional permutations. */
export function lisa(x: number[], nb: Nb, permutations: number, alpha: number, fdr: boolean, seed: number): LisaResult {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const z = x.map((v) => v - mean);
  const m2 = z.reduce((a, b) => a + b * b, 0) / n;
  if (!(m2 > 0)) throw new Error('every value is the same: there is no pattern to test');
  const lagOf = (zz: number[], i: number) => (nb[i].length ? nb[i].reduce((a, j) => a + zz[j], 0) / nb[i].length : 0);
  const lag = z.map((_, i) => lagOf(z, i));
  const withNb = nb.filter((l) => l.length).length;
  const globalI = (zz: number[]) => {
    let num = 0;
    for (let i = 0; i < n; i++) if (nb[i].length) num += zz[i] * lagOf(zz, i);
    return ((n / withNb) * num) / zz.reduce((a, b) => a + b * b, 0);
  };
  const I = globalI(z);
  const rand = rng(seed);
  // global: permute the values over the locations
  const sims: number[] = [];
  const zz = z.slice();
  for (let r = 0; r < permutations; r++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [zz[i], zz[j]] = [zz[j], zz[i]];
    }
    sims.push(globalI(zz));
  }
  const simMean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const simSd = Math.sqrt(sims.reduce((a, b) => a + (b - simMean) ** 2, 0) / Math.max(1, sims.length - 1));
  const extreme = sims.filter((s) => (I >= simMean ? s >= I : s <= I)).length;
  const pGlobal = (extreme + 1) / (permutations + 1);
  // local: hold z_i, draw its neighbours' values from the other n - 1 (conditional permutation)
  const local = z.map((zi, i) => {
    const k = nb[i].length;
    const Ii = (zi * lag[i]) / m2;
    if (!k) return { I: NaN, lag: NaN, z: zi / Math.sqrt(m2), p: NaN, cluster: 'No neighbours' };
    const others = z.filter((_, j) => j !== i);
    let hits = 0;
    let sumI = 0;
    const perm: number[] = [];
    for (let r = 0; r < permutations; r++) {
      let s = 0;
      // partial Fisher–Yates: the first k of a shuffled copy
      for (let t = 0; t < k; t++) {
        const j = t + Math.floor(rand() * (others.length - t));
        [others[t], others[j]] = [others[j], others[t]];
        s += others[t];
      }
      const Ip = (zi * (s / k)) / m2;
      perm.push(Ip);
      sumI += Ip;
    }
    const pm = sumI / permutations;
    for (const Ip of perm) if (Ii >= pm ? Ip >= Ii : Ip <= Ii) hits++;
    return { I: Ii, lag: lag[i] / Math.sqrt(m2), z: zi / Math.sqrt(m2), p: (hits + 1) / (permutations + 1), cluster: '' };
  });
  // significance, optionally with the Benjamini–Hochberg false discovery rate
  const ps = local.map((l, i) => [l.p, i] as [number, number]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const sig = new Set<number>();
  if (fdr) {
    let kmax = -1;
    ps.forEach(([p], r) => { if (p <= ((r + 1) / ps.length) * alpha) kmax = r; });
    for (let r = 0; r <= kmax; r++) sig.add(ps[r][1]);
  } else for (const [p, i] of ps) if (p <= alpha) sig.add(i);
  local.forEach((l, i) => {
    if (l.cluster) return;
    if (!sig.has(i)) l.cluster = 'Not significant';
    else l.cluster = l.z >= 0 ? (l.lag >= 0 ? 'High-High cluster' : 'High-Low outlier') : l.lag >= 0 ? 'Low-High outlier' : 'Low-Low cluster';
  });
  return { I, expected: -1 / (n - 1), pGlobal, zSim: simSd > 0 ? (I - simMean) / simSd : NaN, local };
}

/** Moran scatterplot: standardised value against its spatial lag; the slope is Moran's I. */
function scatterSvg(res: LisaResult, field: string): string {
  const pts = res.local.filter((l) => Number.isFinite(l.lag));
  const W = 520, H = 400, m = 46;
  const ext = Math.max(2, ...pts.map((p) => Math.max(Math.abs(p.z), Math.abs(p.lag)))) * 1.08;
  const sx = (v: number) => m + ((v + ext) / (2 * ext)) * (W - 2 * m);
  const sy = (v: number) => H - m - ((v + ext) / (2 * ext)) * (H - 2 * m);
  const col: Record<string, string> = { 'High-High cluster': '#d7191c', 'Low-Low cluster': '#2c7bb6', 'High-Low outlier': '#fdae61', 'Low-High outlier': '#74add1', 'Not significant': '#b0b0b0' };
  const dots = pts.map((p) => `<circle cx="${sx(p.z).toFixed(1)}" cy="${sy(p.lag).toFixed(1)}" r="3.6" fill="${col[p.cluster] ?? '#b0b0b0'}" stroke="#333" stroke-width="0.4"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="12">
    <rect width="${W}" height="${H}" fill="#fff"/>
    <line x1="${sx(-ext)}" y1="${sy(0)}" x2="${sx(ext)}" y2="${sy(0)}" stroke="#999"/><line x1="${sx(0)}" y1="${sy(-ext)}" x2="${sx(0)}" y2="${sy(ext)}" stroke="#999"/>
    <line x1="${sx(-ext)}" y1="${sy(-ext * res.I)}" x2="${sx(ext)}" y2="${sy(ext * res.I)}" stroke="#222" stroke-width="1.5"/>
    ${dots}
    <text x="${W / 2}" y="${H - 10}" text-anchor="middle" fill="#222">${esc(field)} (standardised)</text>
    <text transform="translate(14 ${H / 2}) rotate(-90)" text-anchor="middle" fill="#222">spatial lag (neighbours' mean)</text>
    <text x="${m + 4}" y="${m - 14}" fill="#222">Moran's I = ${res.I.toFixed(3)} (slope)</text>
    <text x="${sx(ext) - 4}" y="${sy(ext) + 14}" text-anchor="end" fill="#d7191c">High-High</text><text x="${sx(-ext) + 4}" y="${sy(-ext) - 6}" fill="#2c7bb6">Low-Low</text>
  </svg>`;
}

// ---------------------------------------------------------------- profile

function bilinear(g: { width: number; height: number; transform: number[]; bands: Float32Array[] }, x: number, y: number): number {
  const [x0, dx, , y0, , dy] = g.transform;
  const fc = (x - x0) / dx - 0.5;
  const fr = (y - y0) / dy - 0.5;
  const c = Math.floor(fc), r = Math.floor(fr);
  const tx = fc - c, ty = fr - r;
  const at = (cc: number, rr: number) => (cc < 0 || rr < 0 || cc >= g.width || rr >= g.height ? NaN : g.bands[0][rr * g.width + cc]);
  const v = [at(c, r), at(c + 1, r), at(c, r + 1), at(c + 1, r + 1)];
  if (v.some((q) => !Number.isFinite(q))) {
    const near = at(Math.round(fc), Math.round(fr));
    return Number.isFinite(near) ? near : NaN;
  }
  return v[0] * (1 - tx) * (1 - ty) + v[1] * tx * (1 - ty) + v[2] * (1 - tx) * ty + v[3] * tx * ty;
}

interface Profile { name: string; d: number[]; z: number[] }

function profileStats(p: Profile) {
  const ok = p.z.map((z, i) => [p.d[i], z] as [number, number]).filter(([, z]) => Number.isFinite(z));
  let up = 0, down = 0, steep = 0;
  for (let i = 1; i < ok.length; i++) {
    const dz = ok[i][1] - ok[i - 1][1];
    const dd = ok[i][0] - ok[i - 1][0];
    if (dz > 0) up += dz; else down -= dz;
    if (dd > 0) steep = Math.max(steep, Math.abs(Math.atan2(dz, dd)) / rad);
  }
  const zs = ok.map(([, z]) => z);
  return { length: p.d[p.d.length - 1] ?? 0, min: Math.min(...zs), max: Math.max(...zs), up, down, steep, n: ok.length };
}

function profileSvg(profiles: Profile[], unit: string): string {
  const W = 640, H = 300, ml = 56, mr = 16, mt = 18, mb = 40;
  const all = profiles.flatMap((p) => p.z.filter(Number.isFinite));
  const zmin = Math.min(...all), zmax = Math.max(...all);
  const pad = (zmax - zmin) * 0.06 || 1;
  const z0 = zmin - pad, z1 = zmax + pad;
  const dmax = Math.max(...profiles.map((p) => p.d[p.d.length - 1] ?? 0)) || 1;
  const km = dmax >= 2000;
  const sx = (d: number) => ml + (d / dmax) * (W - ml - mr);
  const sy = (z: number) => H - mb - ((z - z0) / (z1 - z0)) * (H - mt - mb);
  const cols = ['#d95f02', '#1b9e77', '#7570b3', '#e7298a', '#66a61e', '#e6ab02'];
  const ticks = (a: number, b: number, n: number) => { const s = Math.pow(10, Math.floor(Math.log10((b - a) / n))); const step = [1, 2, 5, 10].map((k) => k * s).find((k) => (b - a) / k <= n) ?? s * 10; const out = []; for (let v = Math.ceil(a / step) * step; v <= b; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12))); return out; };
  const yt = ticks(z0, z1, 5).map((v) => `<line x1="${ml}" x2="${W - mr}" y1="${sy(v)}" y2="${sy(v)}" stroke="#eee"/><text x="${ml - 6}" y="${sy(v) + 4}" text-anchor="end">${v.toLocaleString()}</text>`).join('');
  const xt = ticks(0, dmax, 6).map((v) => `<text x="${sx(v)}" y="${H - mb + 16}" text-anchor="middle">${km ? (v / 1000).toLocaleString() : v.toLocaleString()}</text>`).join('');
  const lines = profiles.map((p, k) => {
    const pts = p.d.map((d, i) => (Number.isFinite(p.z[i]) ? `${sx(d).toFixed(1)},${sy(p.z[i]).toFixed(1)}` : null)).filter(Boolean);
    const area = pts.length > 1 ? `<polygon points="${sx(p.d[0])},${sy(z0)} ${pts.join(' ')} ${sx(p.d[p.d.length - 1])},${sy(z0)}" fill="${cols[k % cols.length]}" opacity="${profiles.length === 1 ? 0.18 : 0.06}"/>` : '';
    return `${area}<polyline points="${pts.join(' ')}" fill="none" stroke="${cols[k % cols.length]}" stroke-width="2"/>`;
  }).join('');
  const legend = profiles.length > 1 ? profiles.slice(0, 6).map((p, k) => `<text x="${ml + 8 + k * 100}" y="${mt + 2}" fill="${cols[k % cols.length]}">■ ${esc(p.name.slice(0, 14))}</text>`).join('') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="11" fill="#333">
    <rect width="${W}" height="${H}" fill="#fff"/>${yt}${xt}${lines}${legend}
    <line x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}" stroke="#666"/><line x1="${ml}" x2="${ml}" y1="${mt}" y2="${H - mb}" stroke="#666"/>
    <text x="${(ml + W - mr) / 2}" y="${H - 6}" text-anchor="middle">distance (${km ? 'km' : 'm'})</text>
    <text transform="translate(13 ${(mt + H - mb) / 2}) rotate(-90)" text-anchor="middle">elevation (${esc(unit)})</text>
  </svg>`;
}

function lineParts(g: Geometry): Position[][] {
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

// ---------------------------------------------------------------- tools

const FIELD = (name: string, label: string, required: boolean, description: string): Param => ({ name, label, kind: 'field', required, description });

export const LEGACY_TOOLS: Tool[] = [
  {
    id: 'local-moran',
    name: "Local Moran's I (clusters and outliers, LISA)",
    summary: "Where high values sit among high values (hot spots), low among low, and where a feature differs from its neighbours (outliers); with the global Moran's I and its scatterplot. As ArcGIS Pro's Cluster and Outlier Analysis and GeoDa's LISA.",
    group: STATS,
    icon: 'hotspot',
    params: [
      { name: 'layer', label: 'Layer', kind: 'layer', required: true },
      FIELD('field', 'Numeric field', true, 'The value to test, e.g. species richness, count, rate'),
      { name: 'neighbours', label: 'Neighbours', kind: 'choice', default: 'auto', choices: ['auto', 'contiguity', 'k-nearest', 'distance'], description: 'auto: polygons that touch (queen contiguity), points: the 8 nearest' },
      { name: 'k', label: 'k (nearest)', kind: 'number', default: 8 },
      { name: 'distance_km', label: 'Distance band (km)', kind: 'number', default: 0, description: 'For "distance": neighbours within this distance' },
      { name: 'permutations', label: 'Permutations', kind: 'number', default: 999 },
      { name: 'alpha', label: 'Significance level', kind: 'number', default: 0.05 },
      { name: 'fdr', label: 'False discovery rate correction', kind: 'bool', default: false, description: 'Benjamini–Hochberg over all features (fewer, safer clusters)' },
      { name: 'seed', label: 'Random seed', kind: 'number', default: 12345, description: 'Same seed, same p-values' },
    ],
    run(ctx: Ctx) {
      const feats = ctx.layer('layer');
      if (!feats?.length) throw new Error('Choose a layer');
      const field = str(ctx, 'field');
      if (!field) throw new Error('Choose a numeric field');
      const use = feats.filter((f) => f.geometry && Number.isFinite(Number(f.properties?.[field])) && f.properties?.[field] !== null && f.properties?.[field] !== '');
      const dropped = feats.length - use.length;
      if (use.length < 8) throw new Error(`Moran's I needs at least 8 features with a value in ${field} (${use.length} have one)`);
      if (use.length > 5000) throw new Error(`${use.length.toLocaleString()} features: this tool handles up to 5,000; for more, aggregate first (Hexagon density) or use Hot spots (Gi*)`);
      const x = use.map((f) => Number(f.properties![field]));
      const polys = use.every((f) => /Polygon$/.test(f.geometry!.type));
      const pts = use.map((f) => centroid(f as Feature).geometry.coordinates);
      let how = str(ctx, 'neighbours', 'auto');
      if (how === 'auto') how = polys ? 'contiguity' : 'k-nearest';
      if (how === 'contiguity' && !polys) throw new Error('Contiguity needs polygons; choose k-nearest or distance for points and lines');
      const k = Math.max(1, Math.min(use.length - 1, Math.round(num(ctx, 'k', 8))));
      const km = num(ctx, 'distance_km', 0);
      if (how === 'distance' && !(km > 0)) throw new Error('Give the distance band in km');
      const nb = how === 'contiguity' ? contiguity(use) : how === 'distance' ? band(pts, km) : knn(pts, k);
      const isolates = nb.filter((l) => !l.length).length;
      const perms = Math.max(99, Math.min(9999, Math.round(num(ctx, 'permutations', 999))));
      const alpha = num(ctx, 'alpha', 0.05);
      const res = lisa(x, nb, perms, alpha, !!ctx.params.fdr, Math.round(num(ctx, 'seed', 12345)));
      const out = use.map((f, i) => ({
        ...f,
        properties: {
          ...f.properties,
          lisa_i: Number.isFinite(res.local[i].I) ? Number(res.local[i].I.toFixed(5)) : null,
          lisa_z: Number(res.local[i].z.toFixed(4)),
          lisa_lag: Number.isFinite(res.local[i].lag) ? Number(res.local[i].lag.toFixed(4)) : null,
          lisa_p: Number.isFinite(res.local[i].p) ? Number(res.local[i].p.toFixed(4)) : null,
          lisa_cluster: res.local[i].cluster,
        },
      })) as Feature[];
      const count = (c: string) => res.local.filter((l) => l.cluster === c).length;
      const meanNb = nb.reduce((a, l) => a + l.length, 0) / nb.length;
      const verdict = res.pGlobal <= alpha ? (res.I > res.expected ? 'clustered (similar values sit together)' : 'dispersed (neighbours differ more than chance)') : 'no evidence of spatial pattern';
      const notes = [
        `Neighbours: ${how === 'contiguity' ? 'polygons sharing a boundary or corner (queen)' : how === 'distance' ? `within ${km} km` : `${k} nearest`}, row-standardised; ${meanNb.toFixed(1)} on average.`,
        `p-values from ${perms} conditional permutations (seed ${num(ctx, 'seed', 12345)}); ${ctx.params.fdr ? 'false discovery rate controlled (Benjamini–Hochberg)' : 'not corrected for multiple testing: with many features some "clusters" arise by chance; switch on the FDR correction for a stricter map'}.`,
      ];
      if (isolates) notes.push(`${isolates} feature(s) have no neighbours and are marked 'No neighbours'${how === 'contiguity' ? ' (islands, or boundaries that do not share vertices: try k-nearest)' : ''}.`);
      if (dropped) notes.push(`${dropped} feature(s) without a value in ${field} were left out.`);
      return {
        message: `Moran's I = ${res.I.toFixed(3)} (p = ${f3(res.pGlobal)}): ${verdict}. ${count('High-High cluster')} high-high, ${count('Low-Low cluster')} low-low, ${count('High-Low outlier') + count('Low-High outlier')} outliers.`,
        layers: [{ name: `${ctx.layerName('layer')} LISA ${field}`, features: out }],
        table: [
          ["Global Moran's I", f3(res.I)],
          ['Expected under no pattern', f3(res.expected)],
          ['Pseudo p (permutations)', f3(res.pGlobal)],
          ['z (from permutations)', f3(res.zSim)],
          ['Features', use.length],
          ['High-High clusters', count('High-High cluster')],
          ['Low-Low clusters', count('Low-Low cluster')],
          ['High-Low outliers', count('High-Low outlier')],
          ['Low-High outliers', count('Low-High outlier')],
          ['Not significant', count('Not significant')],
        ],
        notes,
        figures: [{ title: `Moran scatterplot of ${field}: points coloured by their LISA class; the slope of the line is Moran's I`, svg: scatterSvg(res, field) }],
      };
    },
  },
  {
    id: 'elevation-profile',
    name: 'Elevation profile',
    summary: 'The terrain along a line over a DEM (each line its own profile), or through points that carry an elevation field (in their order, grouped by a field such as a transect): the chart, length, climb, descent and steepest slope.',
    group: TERRAIN,
    icon: 'chart',
    params: [
      { name: 'layer', label: 'Lines or points', kind: 'layer', required: true },
      { name: 'dem', label: 'Elevation raster (DEM)', kind: 'raster', description: 'For lines; points can use their own elevation field instead' },
      FIELD('elevation_field', 'Elevation field (points)', false, 'e.g. elevation_m; used when no DEM is given'),
      FIELD('group_field', 'One profile per (points)', false, 'e.g. transect'),
      FIELD('order_field', 'Sort points by', false, 'e.g. site or distance along the transect; empty = the order in the layer'),
      { name: 'spacing_m', label: 'Sample every (m)', kind: 'number', default: 0, description: '0 = half the DEM cell size' },
    ],
    run(ctx: Ctx) {
      const feats = ctx.layer('layer');
      if (!feats?.length) throw new Error('Choose a layer');
      const dem = ctx.raster('dem');
      const profiles: Profile[] = [];
      const outPts: Feature[] = [];
      let unit = 'm';
      const nameOf = (f: Feature, i: number) => String(f.properties?.name ?? f.properties?.NAME ?? f.properties?.id ?? `line ${i + 1}`);
      const lines = feats.filter((f) => f.geometry && /LineString$/.test(f.geometry.type));
      if (lines.length) {
        if (!dem) throw new Error('Lines need an elevation raster (DEM): choose one (Data › Elevation fetches the Copernicus DEM)');
        unit = dem.units || 'm';
        const { fromLonLat } = projector(dem);
        const cs = cellSize(dem);
        const step = num(ctx, 'spacing_m', 0) > 0 ? num(ctx, 'spacing_m', 0) : Math.max(1, Math.min(cs.w, cs.h) / 2);
        lines.slice(0, 20).forEach((f, li) => {
          const p: Profile = { name: nameOf(f, li), d: [], z: [] };
          let along = 0;
          for (const part of lineParts(f.geometry!)) {
            for (let s = 1; s < part.length; s++) {
              const a = part[s - 1], b = part[s];
              const seg = hav(a, b);
              const n = Math.max(1, Math.ceil(seg / step));
              for (let t = s === 1 ? 0 : 1; t <= n; t++) {
                const q: Position = [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n];
                const [x, y] = fromLonLat([q[0], q[1]]);
                const z = bilinear(dem, x, y);
                const d = along + (seg * t) / n;
                p.d.push(d);
                p.z.push(z);
                if (p.d.length % Math.max(1, Math.round(50 / step)) === 0 || t === n)
                  outPts.push({ type: 'Feature', properties: { profile: p.name, dist_m: Math.round(d), elev: Number.isFinite(z) ? Number(z.toFixed(2)) : null }, geometry: { type: 'Point', coordinates: q } });
                if (p.d.length > 20000) break;
              }
              along += seg;
            }
          }
          profiles.push(p);
        });
      } else {
        const ef = str(ctx, 'elevation_field');
        const pts = feats.filter((f) => f.geometry?.type === 'Point');
        if (!pts.length) throw new Error('Choose a line layer (with a DEM) or a point layer');
        if (!ef && !dem) throw new Error('Choose the elevation field of the points, or a DEM to read elevations from');
        const gf = str(ctx, 'group_field');
        const groups = new Map<string, Feature[]>();
        for (const f of pts) {
          const k = gf ? String(f.properties?.[gf] ?? '—') : 'profile';
          groups.set(k, [...(groups.get(k) ?? []), f]);
        }
        const fl = dem ? projector(dem).fromLonLat : null;
        const of = str(ctx, 'order_field');
        for (const [name, list] of groups) {
          if (of) {
            const key = (f: Feature) => f.properties?.[of];
            list.sort((a, b) => {
              const x = key(a), y = key(b);
              return typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
            });
          }
          const p: Profile = { name, d: [], z: [] };
          let along = 0;
          list.forEach((f, i) => {
            const c = (f.geometry as { coordinates: Position }).coordinates;
            if (i) along += hav((list[i - 1].geometry as { coordinates: Position }).coordinates, c);
            const z = ef ? Number(f.properties?.[ef]) : bilinear(dem!, ...(fl!([c[0], c[1]]) as [number, number]));
            p.d.push(along);
            p.z.push(Number.isFinite(z) ? z : NaN);
          });
          profiles.push(p);
        }
      }
      const stats = profiles.map((p) => ({ p, s: profileStats(p) })).filter(({ s }) => s.n >= 2);
      if (!stats.length) throw new Error('No elevations along the profile: the line may lie outside the DEM, or the field is empty');
      const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
      const table: [string, string | number][] = stats.length === 1
        ? [
            ['Length', km(stats[0].s.length)], ['Lowest', `${stats[0].s.min.toFixed(1)} ${unit}`], ['Highest', `${stats[0].s.max.toFixed(1)} ${unit}`],
            ['Total climb', `${stats[0].s.up.toFixed(0)} ${unit}`], ['Total descent', `${stats[0].s.down.toFixed(0)} ${unit}`], ['Steepest stretch', `${stats[0].s.steep.toFixed(1)}°`],
          ]
        : stats.map(({ p, s }) => [p.name, `${km(s.length)} · ${s.min.toFixed(0)}–${s.max.toFixed(0)} ${unit} · climb ${s.up.toFixed(0)}`] as [string, string]);
      const notes = [
        lines.length
          ? `Sampled every ${(num(ctx, 'spacing_m', 0) || Math.max(1, Math.min(cellSize(dem!).w, cellSize(dem!).h) / 2)).toFixed(1)} m with bilinear interpolation; the DEM was handed to the tool at ${cellSize(dem!).w.toFixed(0)} m cells, so features smaller than that do not show.`
          : str(ctx, 'order_field')
            ? `Points joined in order of ${str(ctx, 'order_field')}.`
            : 'Points are joined in the order they appear in the layer; choose "Sort points by" if that is not their order along the transect.',
        'Distances are measured on the sphere; the steepest stretch is between consecutive samples.',
      ];
      if (lines.length > 20) notes.push(`Only the first 20 of ${lines.length} lines were profiled.`);
      return {
        message: stats.length === 1 ? `Profile: ${table[0][1]}, ${table[1][1]} to ${table[2][1]}, climb ${table[3][1]}` : `${stats.length} profiles`,
        layers: outPts.length ? [{ name: `${ctx.layerName('layer')} profile points`, features: outPts }] : [],
        table,
        notes,
        figures: [{ title: `Elevation profile${stats.length > 1 ? 's' : ''} of ${ctx.layerName('layer')}`, svg: profileSvg(stats.map(({ p }) => p), unit) }],
      };
    },
  },
];
