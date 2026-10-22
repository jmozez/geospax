// LISA and elevation profiles against known answers: a two-block pattern (strong clustering), a
// checkerboard (Moran's I = -1 with rook neighbours), the global I against the textbook double sum, a
// ramp DEM whose profile length and climb are known, and points grouped into transects.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Feature } from 'geojson';
import { LEGACY_TOOLS, lisa } from '../src/legacytools';
import type { Ctx, Grid } from '../src/tools';

const tool = (id: string) => LEGACY_TOOLS.find((t) => t.id === id)!;
const ctx = (params: Record<string, unknown>, layers: Record<string, Feature[]>, rasters: Record<string, Grid> = {}): Ctx => ({
  params,
  layer: (n) => layers[String(params[n])] ?? null,
  layerName: (n) => String(params[n]),
  raster: (n) => (params[n] ? rasters[String(params[n])] : null),
  rasters: () => [],
});
const row = (t: [string, string | number][] | undefined, k: string) => t?.find(([a]) => a.startsWith(k))?.[1];

/** n × n square polygons of 0.01°, value from f(col, row) */
function grid(n: number, f: (c: number, r: number) => number): Feature[] {
  const out: Feature[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const x = 146 + c * 0.01, y = -6 - r * 0.01;
      out.push({ type: 'Feature', properties: { v: f(c, r), c, r }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.01, y], [x + 0.01, y - 0.01], [x, y - 0.01], [x, y]]] } });
    }
  return out;
}

describe("local Moran's I", () => {
  it('two blocks: strong clustering, HH in the high half, LL in the low half, no outliers', async () => {
    let s = 7;
    const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const feats = grid(10, (c) => (c < 5 ? 80 : 20) + noise());
    const out = await tool('local-moran').run(ctx({ layer: 'g', field: 'v', permutations: 499, seed: 1 }, { g: feats }));
    const I = Number(row(out.table, "Global Moran's I"));
    assert.ok(I > 0.6, `I ${I}`);
    assert.ok(Number(row(out.table, 'Pseudo p')) <= 0.01);
    const cls = out.layers![0].features.map((f) => [f.properties!.c, f.properties!.lisa_cluster] as [number, string]);
    assert.ok(cls.filter(([c, k]) => c < 5 && k === 'High-High cluster').length >= 15, 'HH on the left');
    assert.ok(cls.filter(([c, k]) => c >= 5 && k === 'Low-Low cluster').length >= 15, 'LL on the right');
    assert.equal(cls.filter(([c, k]) => (c < 5 && k === 'Low-Low cluster') || (c >= 5 && k === 'High-High cluster')).length, 0);
    assert.equal(out.figures?.length, 1);
  });

  it('checkerboard with rook neighbours: I = -1', () => {
    const n = 8;
    const x: number[] = [];
    const nb: number[][] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        x.push((r + c) % 2);
        nb.push([[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < n && b < n).map(([a, b]) => b * n + a));
      }
    const res = lisa(x, nb, 199, 0.05, false, 3);
    assert.ok(Math.abs(res.I + 1) < 1e-12, `I ${res.I}`);
    assert.ok(res.pGlobal <= 0.01);
  });

  it('global I equals the textbook double sum (row-standardised W)', () => {
    const x = [3, 7, 1, 9, 4, 6, 2, 8, 5, 10, 0, 7];
    const nb = x.map((_, i) => [(i + 1) % x.length, (i + x.length - 1) % x.length, (i + 3) % x.length]);
    const n = x.length;
    const m = x.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      den += (x[i] - m) ** 2;
      for (const j of nb[i]) num += (1 / nb[i].length) * (x[i] - m) * (x[j] - m);
    }
    const expected = (n / n) * (num / den); // S0 = n with row standardisation
    assert.ok(Math.abs(lisa(x, nb, 99, 0.05, false, 1).I - expected) < 1e-12);
  });

  it('the same seed gives the same p-values; FDR never adds clusters', async () => {
    const feats = grid(8, (c, r) => Math.sin(c) * 10 + r);
    const a = await tool('local-moran').run(ctx({ layer: 'g', field: 'v', seed: 9 }, { g: feats }));
    const b = await tool('local-moran').run(ctx({ layer: 'g', field: 'v', seed: 9 }, { g: feats }));
    assert.deepEqual(a.layers![0].features.map((f) => f.properties!.lisa_p), b.layers![0].features.map((f) => f.properties!.lisa_p));
    const f = await tool('local-moran').run(ctx({ layer: 'g', field: 'v', seed: 9, fdr: true }, { g: feats }));
    const sig = (o: typeof a) => o.layers![0].features.filter((x) => x.properties!.lisa_cluster !== 'Not significant').length;
    assert.ok(sig(f) <= sig(a));
  });

  it('refuses too few values and constant fields', async () => {
    await assert.rejects(Promise.resolve().then(() => tool('local-moran').run(ctx({ layer: 'g', field: 'v' }, { g: grid(2, () => 1) }))), /at least 8/);
    await assert.rejects(Promise.resolve().then(() => tool('local-moran').run(ctx({ layer: 'g', field: 'v' }, { g: grid(4, () => 5) }))), /same/);
  });
});

describe('elevation profile', () => {
  // geographic DEM, 0.001° cells; elevation rises 100 m per 0.01° northwards
  const W = 200, H = 200;
  const dem: Grid = {
    id: 'dem', title: 'dem', kind: 'dem', units: 'm', width: W, height: H, transform: [146, 0.001, 0, -6, 0, -0.001], crs: '', geographic: true,
    bandNames: ['b1'], bands: [Float32Array.from({ length: W * H }, (_, i) => 1000 + (H - Math.floor(i / W)) * 10)],
  };
  it('a straight line uphill: length and climb are right', async () => {
    const line: Feature = { type: 'Feature', properties: { name: 'up' }, geometry: { type: 'LineString', coordinates: [[146.1, -6.15], [146.1, -6.05]] } };
    const out = await tool('elevation-profile').run(ctx({ layer: 'l', dem: 'dem' }, { l: [line] }, { dem }));
    const len = String(row(out.table, 'Length'));
    assert.match(len, /^11\.1\d km$/, len); // 0.1° of latitude = 11.12 km
    const climb = parseFloat(String(row(out.table, 'Total climb')));
    assert.ok(Math.abs(climb - 1000) < 15, `climb ${climb}`); // 0.1° × 100 m per 0.01°
    assert.equal(parseFloat(String(row(out.table, 'Total descent'))), 0);
    assert.ok(out.figures![0].svg.startsWith('<svg'));
  });
  it('points with an elevation field, one profile per transect', async () => {
    const pts: Feature[] = [0, 1, 2, 0, 1].map((k, i) => ({ type: 'Feature', properties: { t: i < 3 ? 'A' : 'B', z: 100 + k * 50 }, geometry: { type: 'Point', coordinates: [146 + k * 0.01, -6] } }));
    const out = await tool('elevation-profile').run(ctx({ layer: 'p', elevation_field: 'z', group_field: 't' }, { p: pts }));
    assert.equal(out.table?.length, 2);
    assert.match(String(row(out.table, 'A')), /100–200 m · climb 100/);
  });
  it('lines without a DEM are refused with a reason', async () => {
    const line: Feature = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[146, -6], [146.1, -6]] } };
    await assert.rejects(Promise.resolve().then(() => tool('elevation-profile').run(ctx({ layer: 'l' }, { l: [line] }))), /need an elevation raster/);
  });
});
