// Analysis results join Contents by themselves, whatever started them (ArcGIS Pro / QGIS behaviour):
//   1. Analysis › Hot spots on the ribbon                → the hot-spot layer, on top, switched on
//   2. a recipe started through the API (as the Ask assistant, MCP or a trigger would) that makes a
//      classified raster                                  → a raster row in Contents, on top, on the map
//   3. a Toolbox plugin tool run through the API (Local Moran's I) → its layer in Contents
// then: the raster's switch in Contents and in the Rasters pane stay in step and hide it on the map;
// the order and the rows survive a reload; the raster is drawn above the layers below it in Contents.
//
// usage: node scripts/test-results-in-contents.mjs BASE_URL [OUT_DIR]   (server started on the PNG samples)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? 'bench/screenshots';
mkdirSync(out, { recursive: true });
let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  if (cond) passed++;
  else failed.push(name);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};
const api = async (path, opts = {}) => {
  const r = await fetch(`${base}/${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } });
  return r.json();
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?mode=pro`);
await page.waitForSelector('#contents .layer.pro');
await page.waitForTimeout(2500);

/** Contents rows, top first: { id, on } */
const rows = () => page.evaluate(() => [...document.querySelectorAll('#contents .layer.pro')].map((e) => ({ id: e.dataset.id, on: !!e.querySelector('input[type=checkbox]')?.checked })));
const mapLayers = () => page.evaluate(() => window.map?.getStyle().layers.map((l) => l.id) ?? []);
const waitFor = async (cond, ms = 120000) => {
  for (let t = 0; t < ms; t += 1000) {
    if (await cond()) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

console.log('1 · ribbon: Analysis › Hot spots');
const before = await rows();
await page.click('#ribbon-tabs .rb-tab[data-tab="analyze"]');
await page.click('[data-cmd="analyze.hotspots"]');
const hot = await waitFor(async () => (await rows()).some((r) => r.id === 'points-to-hotspots.hotspots'));
let r1 = await rows();
ok('hot spots added to Contents', hot, `${before.length} → ${r1.length} rows`);
ok('…on top and switched on', r1[0]?.id === 'points-to-hotspots.hotspots' && r1[0].on, `top: ${r1[0]?.id}`);

console.log('2 · a recipe started outside the app makes a raster');
const yaml = ['recipe: classify-cover', 'version: 1', 'title: Tree cover classes', 'steps:', '  - id: classes', '    use: raster.classify',
  '    with: {"raster": "tree_cover_pct", "breaks": [20, 50, 80], "labels": ["open", "sparse", "woodland", "forest"], "name": "cover_classes"}', 'outputs: [classes]', ''].join('\n');
await fetch(`${base}/api/recipes`, { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
const run = await api('api/recipes/classify-cover/run', { method: 'POST', body: '{}' });
const rid = 'r:classify-cover.cover_classes';
const appeared = await waitFor(async () => (await rows()).some((r) => r.id === rid), 60000);
const r2 = await rows();
const st = await api(`api/runs/${run.id}`);
ok('the run finished', st.status === 'done', st.error ?? st.status);
ok('classified raster added to Contents without a reload', appeared);
ok('…on top and switched on', r2[0]?.id === rid && r2[0].on, `top: ${r2[0]?.id}`);
const ml = await mapLayers();
ok('…drawn on the map', ml.includes('raster:classify-cover.cover_classes'));
const below = r2.find((r, i) => i > 0 && !r.id.startsWith('r:') && r.on)?.id;
const idx = (id) => ml.findIndex((l) => l === id || l.startsWith(`${id}#`));
ok('…above the layers below it in Contents', below && idx('raster:classify-cover.cover_classes') > idx(below), `${below}`);
ok('legend shown in Contents', await page.locator(`#contents .layer.raster[data-id="${rid}"] .rlegend li`).count() === 4);
await page.screenshot({ path: `${out}/results-1-raster-in-contents.png` });

console.log('3 · a Toolbox tool through the API (Local Moran\'s I)');
const t = await api('api/plugins/gsx/tools/local-moran/run', { method: 'POST', body: JSON.stringify({ params: { layer: 'habitat_survey_grid.geojson', field: 'ndvi', neighbours: 'k-nearest', k: 6, permutations: 199 } }) });
const lisaIds = t.added ?? [];
const lisa = await waitFor(async () => lisaIds.length && (await rows()).some((r) => lisaIds.includes(r.id)), 60000);
const r3 = await rows();
ok('tool result added to Contents', lisa, (lisaIds.join(', ') || JSON.stringify(t).slice(0, 120)));
ok('…switched on', r3.find((r) => lisaIds.includes(r.id))?.on === true);

console.log('4 · switches stay in step');
await page.click(`#contents .layer.raster[data-id="${rid}"] input[type=checkbox]`);
await page.waitForTimeout(800);
ok('unticked in Contents → gone from the map', !(await mapLayers()).includes('raster:classify-cover.cover_classes'));
await page.click('#dock-right .dock-tabs [data-tab="rasters"]');
const paneOn = await page.locator('#rasters .raster[data-id="classify-cover.cover_classes"] input[data-act=visible]').isChecked();
ok('…and unticked in the Rasters pane', paneOn === false);
await page.locator('#rasters .raster[data-id="classify-cover.cover_classes"] input[data-act=visible]').check();
await page.waitForTimeout(800);
ok('ticked in the Rasters pane → ticked in Contents and on the map', (await rows()).find((r) => r.id === rid)?.on === true && (await mapLayers()).includes('raster:classify-cover.cover_classes'));

console.log('5 · after a reload');
const order = (await rows()).map((r) => r.id);
await page.reload();
await page.waitForSelector('#contents .layer.pro');
await page.waitForTimeout(3000);
const after = (await rows()).map((r) => r.id);
ok('same rows in the same order', JSON.stringify(after) === JSON.stringify(order), after.slice(0, 4).join(', '));
ok('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: `${out}/results-2-after-reload.png` });
await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
