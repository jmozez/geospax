// Marine QC: records on land (DEM with coastal tolerance, land polygons) and dropping them before DBSCAN.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Feature } from 'geojson';
import { flagOnLand } from '../src/analysis/index';
import { TOOLS } from '../src/tools';
import type { Ctx, Grid } from '../src/tools';

// 0.01° cells over 147–148 E, 6–7 S: land (500 m) west of 147.5 E, sea (−200 m) east of it
const W = 100, H = 100;
const dem: Grid = {
  id: 'dem', title: 'dem', kind: 'raster', units: 'm', width: W, height: H, transform: [147, 0.01, 0, -6, 0, -0.01], crs: '', geographic: true,
  bandNames: ['b1'], bands: [Float32Array.from({ length: W * H }, (_, i) => (i % W < 50 ? 500 : -200))],
};
const pt = (lon: number, lat: number, id: number): Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id } });
// far inland, at sea, and 300 m inside the coast (kept by the 1 km coastal tolerance)
const pts = [pt(147.1, -6.5, 1), pt(147.8, -6.5, 2), pt(147.497, -6.5, 3)];

describe('records on land', () => {
  it('flags inland records but keeps coastal ones within the tolerance', () => {
    const r = flagOnLand(pts, { dem, coastalM: 1000 });
    assert.equal(r.onLand, 1);
    assert.deepEqual(r.features.map((f) => f.properties!.on_land), [true, false, false]);
    assert.equal(r.maxElevationOnLand, 500);
  });
  it('with no tolerance the coastal record counts as on land', () => {
    assert.equal(flagOnLand(pts, { dem, coastalM: 0 }).onLand, 2);
  });
  it('drops records on land', () => {
    const r = flagOnLand(pts, { dem, drop: true });
    assert.equal(r.removed, 1);
    assert.deepEqual(r.features.map((f) => f.properties!.id), [2, 3]);
  });
  it('uses land polygons', () => {
    const land: Feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[147, -7], [147.3, -7], [147.3, -6], [147, -6], [147, -7]]] } };
    assert.equal(flagOnLand(pts, { land: [land] }).onLand, 1);
  });
  it('needs a mask', () => assert.throws(() => flagOnLand(pts, {})));
});

describe('DBSCAN with a land mask', () => {
  const inland = Array.from({ length: 6 }, (_, i) => pt(147.1 + i * 0.001, -6.5, 10 + i));
  const sea = Array.from({ length: 6 }, (_, i) => pt(147.8 + i * 0.001, -6.5, 20 + i));
  const ctx = (params: Record<string, unknown>): Ctx => ({
    params, layer: (n) => (n === 'points' ? [...inland, ...sea] : null), layerName: () => 'fish',
    raster: (n) => (params[n] ? dem : null), rasters: () => [],
  });
  const tool = TOOLS.find((t) => t.id === 'dbscan')!;
  it('drops records on land before clustering', async () => {
    const out = await tool.run(ctx({ points: 'p', min_points: 4, epsilon_m: 500, land_dem: 'dem' }));
    assert.equal(out.layers![0].features.length, 6);
    assert.match(out.message!, /6 of 12 record\(s\) on land, removed/);
  });
  it('clusters everything when no mask is given', async () => {
    const out = await tool.run(ctx({ points: 'p', min_points: 4, epsilon_m: 500 }));
    assert.equal(out.layers![0].features.length, 12);
  });
  it('the on-land tool reports counts', async () => {
    const out = await TOOLS.find((t) => t.id === 'on-land')!.run(ctx({ points: 'p', land_dem: 'dem', drop: true }));
    assert.equal(out.layers![0].features.length, 6);
  });
});
