// Tool dialogs pre-select fitting inputs (web/src/prefill.ts), checked on every GSX tool: on the
// known-answer landscape of test-domain-plugins.py the dialog must choose what that test chose by hand.
//   node --experimental-strip-types scripts/test-prefill.mjs
import { execFileSync } from 'node:child_process';
import { pickField, pickLayers, pickRasters } from '../web/src/prefill.ts';

const tools = JSON.parse(execFileSync(process.execPath, ['plugins/gsx/run.mjs', '--manifest'], { encoding: 'utf8' }));
const f = (s) => s.split(' ').map((x) => { const [name, kind] = x.split(':'); return { name, kind }; });
const layers = [
  { id: 'habitat', name: 'habitat', geometry: 'polygon', fields: f('cost:integer cover:integer') },
  { id: 'protected', name: 'protected', geometry: 'polygon', fields: f('name:string') },
  { id: 'habitat_2024', name: 'habitat_2024', geometry: 'polygon', fields: f('cover:integer') },
  { id: 'patches', name: 'patches', geometry: 'polygon', fields: [] },
  { id: 'units', name: 'units', geometry: 'polygon', fields: f('cost:integer forest:integer') },
  { id: 'sites', name: 'sites', geometry: 'point', fields: f('site:integer species:string score:real dist_m:real elev:real') },
  { id: 'transect', name: 'transect', geometry: 'line', fields: f('name:string') },
];
const rasters = [{ id: 'dem', bands: 1 }, { id: 'image', bands: 4 }, { id: 'ndvi_2015', bands: 1 }, { id: 'ndvi_2024', bands: 1 }];
// what each tool should start with (layers and rasters; fields where the tool has one)
const want = {
  overlay: { a: 'habitat', b: ['protected', 'patches', 'units'] }, // B: any other polygon layer
  'protection-gap': { habitat: 'habitat', protected: 'protected' },
  suitability: { layer: 'sites', constraint: '' }, // optional constraint never guessed
  'distance-decay': { layer: 'sites', field: 'dist_m' },
  'priority-sites': { habitat: 'sites', protected: 'protected', score: 'score' },
  representation: { units: 'units', cost: 'cost' },
  'hotspot-grid': { layer: 'sites', layer2: undefined, layer3: undefined },
  fragmentation: { patches: 'patches' },
  connectivity: { patches: 'patches' },
  change: { t1: 'habitat', t2: 'habitat_2024' },
  dbscan: { points: 'sites' },
  'nearest-neighbour': { points: 'sites' },
  diversity: { occurrences: 'sites', areas: undefined, species: 'species' },
  'local-moran': { layer: 'sites', field: 'score' },
  'spectral-index': { image: 'image' },
  'raster-change': { before: 'ndvi_2015', after: 'ndvi_2024' },
  'slope-zones': { dem: 'dem' },
  sdm: { occurrences: 'sites' },
  'elevation-profile': { layer: 'transect', dem: 'dem' },
  // industry and ENSO tools: lines to line inputs, points to point inputs, polygons to areas
  'datum-transform': {},
  'traverse-adjust': {},
  'bearing-distance': { layer: 'transect' },
  'survey-plan': { lots: 'habitat' },
  'map-grid': { layer: 'habitat' },
  'corridor-zones': { lines: 'transect' },
  'lidar-clearance': { lines: 'transect', chm: 'image' },
  'tower-inventory': { towers: 'sites' },
  'tenure-check': { tenures: 'habitat' },
  'well-sites': { wells: 'sites' },
  'route-suitability': { ends: 'sites', surface: 'dem' },
  'volume-change': { before: 'dem' },
  'harvest-coupes': { coupes: 'habitat', dem: 'dem' },
  'ais-density': { pings: 'sites' },
  'ais-loitering': { pings: 'sites' },
  'ols-surfaces': { runway: 'transect' },
  'service-area': { network: 'transect', facilities: 'sites' },
  'route-optimise': { stops: 'sites' },
  'zoning-summary': { zones: 'habitat' },
  'density-grid': { points: 'sites' },
  'green-access': { homes: 'sites', parks: 'protected' },
  'service-access': { settlements: 'sites', services: 'sites' },
  'asset-register': { assets: 'habitat' },
  'change-alert': { before: 'habitat', after: 'habitat_2024' },
  'enso-index': {},
  'rainfall-anomaly': { observed: 'image' },
  'drought-risk': { dem: 'dem' },
  'seasonal-outlook': { probability: 'image' },
};
const generic = new Set(['suitability', 'distance-decay', 'hotspot-grid', 'local-moran']);
let pass = 0;
const fails = [];
for (const t of tools) {
  // a generic "Layer" input follows the layer selected in Contents (here: sites, as a user would)
  const L = pickLayers(t.params, layers, generic.has(t.id) ? 'sites' : null);
  const R = pickRasters(t.params, rasters);
  const first = layers.find((l) => l.id === Object.values(L)[0]);
  const F = Object.fromEntries(t.params.filter((p) => p.kind === 'field').map((p) => [p.name, pickField(p, first)]));
  const got = { ...L, ...R, ...F };
  const exp = want[t.id] ?? {};
  const bad = Object.entries(exp).filter(([k, v]) => (Array.isArray(v) && typeof got[k] === 'string' ? !v.includes(got[k]) : JSON.stringify(got[k]) !== JSON.stringify(v)));
  const good = !!want[t.id] && !bad.length;
  if (good) pass++; else fails.push(t.id);
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${t.id}: ${Object.entries(got).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => `${k}=${v}`).join(', ')}${bad.length ? `  (want ${bad.map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`);
}
// the layer selected in Contents wins when it fits, and only then
const dbs = tools.find((t) => t.id === 'dbscan');
const sel = pickLayers(dbs.params, [...layers, { id: 'birds', name: 'birds', geometry: 'point' }], 'birds').points === 'birds';
const notSel = pickLayers(dbs.params, layers, 'habitat').points === 'sites';
for (const [n, c] of [['the selected layer is used when it fits', sel], ['…and not when it does not (polygons for a points input)', notSel]]) {
  if (c) pass++; else fails.push(n);
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`);
}
// earlier results do not replace your data; a DEM is never guessed from a non-elevation raster; the
// occurrence layer is the one with species names
const T = (id) => tools.find((t) => t.id === id);
const withResults = [{ id: 'hotspot-grid-5-km-20261022-152641', name: 'Hotspot grid 5 km', geometry: 'polygon', fields: [] }, ...layers];
const rRes = [{ id: 'slope-zones-dem-20261022-152630', bands: 1 }, ...rasters];
const more = [
  ['a result is not taken for your data', pickLayers(T('protection-gap').params, withResults, null).habitat === 'habitat'],
  ['…unless you select it', pickLayers(T('hotspot-grid').params, withResults, 'hotspot-grid-5-km-20261022-152641').layer === 'hotspot-grid-5-km-20261022-152641'],
  ['a layer named for the input beats the selection (habitat, not the selected streams)', pickLayers(T('protection-gap').params, [{ id: 'streams', name: 'streams', geometry: 'polygon', fields: [] }, ...layers], 'streams').habitat === 'habitat'],
  ['a raster result is not taken either', pickRasters(T('slope-zones').params, rRes).dem === 'dem'],
  ['no DEM guessed from a temperature raster', pickRasters(T('slope-zones').params, [{ id: 'worldclim_bio1_temperature', bands: 1 }]).dem === undefined],
  ['no dates guessed from undated rasters', pickRasters(T('raster-change').params, [{ id: 'tree_cover_pct', bands: 1 }, { id: 'bio1', bands: 1 }]).before === undefined],
  ['diversity starts from the layer with species names', pickLayers(T('diversity').params, [{ id: 'streams', name: 'streams', geometry: 'point', fields: f('flow:real') }, { id: 'birds', name: 'birds', geometry: 'point', fields: f('count:integer species:string') }], null).occurrences === 'birds'],
];
for (const [n, c] of more) {
  if (c) pass++; else fails.push(n);
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`);
}
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
