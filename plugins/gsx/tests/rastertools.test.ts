// Phase B tools against synthetic grids with known answers: an image whose west half is
// vegetated, a planted loss strip, a constant-slope ramp, and a species confined to one corner of
// a two-variable climate space.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Feature } from 'geojson';
import { RASTER_TOOLS } from '../src/rastertools';
import type { Ctx, Grid } from '../src/tools';

const W = 100;
const H = 100;
// 0.01° cells over 145–146 E, 6–5 S (geographic)
const T = [145, 0.01, 0, -5, 0, -0.01];
const grid = (title: string, ...bands: ((x: number, y: number) => number)[]): Grid => ({
  id: title, title, kind: 'raster', units: '', width: W, height: H, transform: T, crs: '', geographic: true,
  bandNames: bands.map((_, i) => `b${i + 1}`),
  bands: bands.map((f) => Float32Array.from({ length: W * H }, (_, i) => f(i % W, Math.floor(i / W)))),
});
const ctx = (params: Record<string, unknown>, rasters: Record<string, Grid>, layers: Record<string, Feature[]> = {}): Ctx => ({
  params,
  layer: (n) => layers[String(params[n])] ?? null,
  layerName: (n) => String(params[n]),
  raster: (n) => (params[n] ? rasters[String(params[n])] : null),
  rasters: (n) => (params[n] as string[]).map((id) => rasters[id]),
});
const tool = (id: string) => RASTER_TOOLS.find((t) => t.id === id)!;
const row = (table: [string, string | number][] | undefined, key: string) => String(table?.find(([k]) => k.startsWith(key))?.[1]);

describe('spectral index', () => {
  it('finds the vegetated half with Otsu', async () => {
    const img = grid('img', () => 0.05, () => 0.06, (x) => (x < 50 ? 0.05 : 0.2), (x) => (x < 50 ? 0.5 : 0.22));
    const out = await tool('spectral-index').run(ctx({ image: 'img', index: 'NDVI', band_a: 4, band_b: 3 }, { img }));
    assert.equal(row(out.table, 'Share'), '50.0 %');
    const t = Number(row(out.table, 'Threshold').split(' ')[0]);
    assert.ok(t > 0.05 && t < 0.8, `threshold ${t}`);
    assert.equal(out.rasters?.length, 2);
    assert.ok(out.notes?.[0].startsWith('Band-assignment caveat'));
  });
  it('says when a band does not exist', async () => {
    const img = grid('img', () => 1);
    await assert.rejects(Promise.resolve().then(() => tool('spectral-index').run(ctx({ image: 'img', band_a: 4, band_b: 3 }, { img }))), /has 1 band/);
  });
});

describe('raster change', () => {
  it('finds a planted loss strip and no gain', async () => {
    const before = grid('before', () => 0.7);
    const after = grid('after', (x) => (x >= 20 && x < 40 ? 0.1 : 0.7));
    const out = await tool('raster-change').run(ctx({ before: 'before', after: 'after' }, { before, after }));
    const classes = out.rasters![1].data;
    let loss = 0;
    for (const v of classes) loss += +(v === 0);
    assert.equal(loss, 20 * H);
    assert.equal(row(out.table, 'Gain threshold'), '—');
  });
});

describe('slope zones', () => {
  it('a 10° ramp is all moderate', async () => {
    const cellM = 0.01 * 111320; // N–S cell size in metres; the ramp rises along y
    const dem = grid('dem', (_x, y) => (H - y) * cellM * Math.tan((10 * Math.PI) / 180));
    const out = await tool('slope-zones').run(ctx({ dem: 'dem', breaks: '8, 20' }, { dem }));
    const slope = out.rasters![0].data.filter(Number.isFinite);
    const mean = slope.reduce((a, b) => a + b, 0) / slope.length;
    assert.ok(Math.abs(mean - 10) < 0.2, `mean slope ${mean}`);
    assert.match(row(out.table, '8–20°'), /100\.0 %/);
  });
});

describe('species distribution model', () => {
  // temperature falls east→west, rain rises south→north; the species lives where both are high
  const clim = grid('clim', (x) => 30 - x * 0.15, (_x, y) => 3000 - y * 20);
  const pts: Feature[] = [];
  for (let i = 0; i < 80; i++) {
    const x = (i * 7) % 25;
    const y = (i * 11) % 25;
    pts.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [145 + (x + 0.5) * 0.01, -5 - (y + 0.5) * 0.01] } });
  }
  for (const method of ['logistic', 'bioclim', 'mahalanobis']) {
    it(`${method}: high cross-validated AUC, suitability highest in the occupied corner`, async () => {
      const out = await tool('sdm').run(ctx({ occurrences: 'occ', covariates: ['clim'], method, background: 2000 }, { clim }, { occ: pts }));
      const auc = Number(row(out.table, 'AUC, spatial CV').split(' ')[0]);
      // BIOCLIM scores in a few steps (the share of variables inside the envelope), so it ranks less finely
      assert.ok(auc > (method === 'bioclim' ? 0.7 : 0.85), `${method} CV AUC ${auc}`);
      const s = out.rasters![0].data;
      assert.ok(s[10 * W + 10] > s[90 * W + 90], 'occupied corner beats the far corner');
      assert.ok(!(out.notes ?? []).some((n) => /^Fold \d+:/.test(n)), 'no empty folds');
    });
  }
  it('projects onto a warmer future: the range moves and the table says how much', async () => {
    const future = grid('future', (x) => 33 - x * 0.15, (_x, y) => 3000 - y * 20); // +3 °C everywhere
    const r = { clim, future };
    const out = await tool('sdm').run(ctx({ occurrences: 'occ', covariates: ['clim'], future: ['future'], method: 'mahalanobis', background: 2000 }, r, { occ: pts }));
    assert.equal(out.rasters?.length, 4);
    const change = out.rasters![3].data;
    let lost = 0, gained = 0;
    for (const v of change) { lost += +(v === 1); gained += +(v === 2 ? 0 : v === 3); }
    assert.ok(lost > 0 && gained > 0, `lost ${lost}, gained ${gained}`);
    assert.match(row(out.table, 'Net change'), /%/);
  });
  it('refuses future rasters with other variables', async () => {
    const future = grid('future', (x) => 33 - x * 0.15);
    await assert.rejects(Promise.resolve().then(() => tool('sdm').run(ctx({ occurrences: 'occ', covariates: ['clim'], future: ['future'] }, { clim, future }, { occ: pts }))), /same variables/);
  });
  it('needs at least 5 usable occurrences', async () => {
    await assert.rejects(
      Promise.resolve().then(() => tool('sdm').run(ctx({ occurrences: 'occ', covariates: ['clim'] }, { clim }, { occ: pts.slice(0, 3) }))),
      /at least 5/,
    );
  });
});
