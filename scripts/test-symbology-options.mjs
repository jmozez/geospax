// Symbols and labels (web/src/symbols.ts) end to end: every option set through the Symbology pane,
// then checked three ways: the MapLibre layers the map builds, what the map renders (labels drawn
// with the bundled fonts, no missing glyph files), and the exported map (crates/engine cartography:
// shapes, sizes by field, outlines, dashes, casings, fills, label fonts and placement in the SVG).
//
//   node scripts/test-symbology-options.mjs BIN [OUT_DIR]     (starts its own server on test data)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const bin = process.argv[2] ?? 'target/release/geospax-server';
const out = process.argv[3] ?? 'bench/screenshots';
mkdirSync(out, { recursive: true });
let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  if (cond) passed++;
  else failed.push(name);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};

// ---- test data: three villages, two roads, two reserves (around 147.2°E, 9.45°S)
const tmp = mkdtempSync(join(tmpdir(), 'gx-sym-'));
const data = join(tmp, 'data');
mkdirSync(data);
const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features });
const pt = (name, pop, x, y) => ({ type: 'Feature', properties: { name, population: pop }, geometry: { type: 'Point', coordinates: [x, y] } });
writeFileSync(join(data, 'villages.geojson'), fc([pt('Hanuabada', 12000, 147.15, -9.46), pt('Koki', 3000, 147.2, -9.48), pt('Gerehu Junction Market', 600, 147.25, -9.42)]));
writeFileSync(join(data, 'roads.geojson'), fc([
  { type: 'Feature', properties: { road: 'Magi Highway', lanes: 2 }, geometry: { type: 'LineString', coordinates: [[147.1, -9.5], [147.2, -9.47], [147.3, -9.45]] } },
  { type: 'Feature', properties: { road: 'Hubert Murray Highway', lanes: 4 }, geometry: { type: 'LineString', coordinates: [[147.12, -9.4], [147.22, -9.44], [147.28, -9.52]] } },
]));
const sq = (name, x, y, d) => ({ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] } });
writeFileSync(join(data, 'reserves.geojson'), fc([sq('Varirata', 147.13, -9.53, 0.05), sq('Paga Hill', 147.24, -9.5, 0.04)]));
// a small elevation grid (ASCII grid + WGS 84 .prj) for the raster symbology checks
const rows = Array.from({ length: 20 }, (_, r) => Array.from({ length: 20 }, (_, c) => r * 20 + c).join(' '));
writeFileSync(join(data, 'height.asc'), ['ncols 20', 'nrows 20', 'xllcorner 147.1', 'yllcorner -9.55', 'cellsize 0.01', 'NODATA_value -9999', ...rows, ''].join('\n'));
writeFileSync(join(data, 'height.prj'), 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]');

const port = 18096;
const base = `http://127.0.0.1:${port}`;
const srv = spawn(bin, ['--data', data, '--state-dir', join(tmp, 'state'), '--port', String(port), '--web', 'web/dist', '--no-device-mounts', '--no-triggers'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch { /* starting */ }
  await sleep(500);
}

const browser = await chromium.launch();
let code = 1;
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  const glyphMisses = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.url().includes('/fonts/') && r.status() !== 200) glyphMisses.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForSelector('#contents .layer.pro');
  await page.waitForTimeout(2000);
  ok('the app starts on the globe', await page.evaluate(() => window.map.getProjection?.()?.type === 'globe' || window.map.getStyle().projection?.type === 'globe'));
  const open = async (id) => {
    await page.click(`#contents .layer.pro[data-id="${id}"] [data-act="props"]`);
    await page.waitForTimeout(400);
  };
  const range = async (k, v) => {
    await page.$eval(`[data-k="${k}"]`, (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    await page.waitForTimeout(150);
  };
  const layer = (id) => page.evaluate((id) => window.map.getStyle().layers.find((l) => l.id === id) ?? null, id);
  const style = (id) => page.evaluate(async (id) => (await (await fetch('api/project')).json()).layers?.[id], id);

  console.log('points');
  await open('villages.geojson');
  await page.click('[data-k="pt-shape"][data-v="star"]');
  await range('pt-size', 14);
  await page.$eval('[data-k="pt-stroke"]', (e) => { e.value = '#111111'; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await range('pt-strokew', 2);
  await range('pt-rot', 15);
  await page.selectOption('[data-k="pt-sizeby"]', 'population');
  await page.waitForTimeout(800);
  await page.check('[data-k="lb-on"]');
  await page.waitForTimeout(300);
  await page.selectOption('[data-k="lb-field"]', 'name');
  await page.selectOption('[data-k="lb-font"]', 'bold');
  await page.selectOption('[data-k="lb-case"]', 'uppercase');
  await range('lb-size', 14);
  await page.click('[data-k="lb-anchor"][data-v="right"]');
  await page.waitForTimeout(500);
  let L = await layer('villages.geojson#circle');
  ok('a star is a tinted SDF icon', L?.type === 'symbol' && L.layout['icon-image'] === 'gx-shape-star' && !!L.paint['icon-color'], JSON.stringify(L?.layout ?? {}).slice(0, 120));
  ok('outline as the icon halo', L?.paint['icon-halo-color'] === '#111111' && L.paint['icon-halo-width'] === 2);
  ok('rotation', L?.layout['icon-rotate'] === 15);
  ok('size by population (area-proportional)', JSON.stringify(L?.layout['icon-size']).includes('sqrt') && JSON.stringify(L?.layout['icon-size']).includes('population'));
  ok('the icon exists on the map', await page.evaluate(() => window.map.hasImage('gx-shape-star')));
  let T = await layer('villages.geojson#label');
  ok('labels: field, bold font, uppercase', T?.layout['text-font']?.[0] === 'DejaVu Sans Bold' && JSON.stringify(T.layout['text-field']).includes('upcase') && JSON.stringify(T.layout['text-field']).includes('name'));
  ok('label to the right of the point (text anchored on its left)', T?.layout['text-anchor'] === 'left');
  let st = await style('villages.geojson');
  ok('saved with the project', st?.point?.shape === 'star' && st.point.sizeBy?.field === 'population' && st.labels?.on === true && st.labels.size === 14, JSON.stringify(st?.point ?? {}).slice(0, 100));
  // the Contents row shows the star
  ok('Contents shows the symbol', (await page.locator('#contents .layer.pro[data-id="villages.geojson"] .swatch.sym-sw svg path').getAttribute('d'))?.startsWith('M12 1.5l3.1'));

  console.log('lines');
  await open('roads.geojson');
  await range('ln-width', 3);
  await page.selectOption('[data-k="ln-dash"]', 'dashdot');
  await page.selectOption('[data-k="ln-cap"]', 'butt');
  await range('ln-casing', 1.5);
  await page.check('[data-k="lb-on"]');
  await page.waitForTimeout(300);
  await page.selectOption('[data-k="lb-field"]', 'road');
  await page.waitForTimeout(500);
  L = await layer('roads.geojson#line');
  ok('width, dash-dot, flat ends', L?.paint['line-width'] === 3 && JSON.stringify(L.paint['line-dasharray']) === '[4,2,0.5,2]' && L.layout['line-cap'] === 'butt');
  const C = await layer('roads.geojson#casing');
  ok('a casing underneath', C?.paint['line-width'] === 6);
  T = await layer('roads.geojson#label');
  ok('road names along the line', T?.layout['symbol-placement'] === 'line' && T.layout['text-rotation-alignment'] === 'map');

  console.log('polygons');
  await open('reserves.geojson');
  await page.uncheck('[data-k="pg-fill"]');
  await page.$eval('[data-k="pg-stroke"]', (e) => { e.value = '#ff7f00'; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await range('pg-strokew', 2.5);
  await page.selectOption('[data-k="pg-dash"]', 'dashed');
  await page.check('[data-k="lb-on"]');
  await page.waitForTimeout(300);
  await page.selectOption('[data-k="lb-font"]', 'italic');
  await page.waitForTimeout(500);
  ok('no fill (hollow)', !(await layer('reserves.geojson#fill')));
  L = await layer('reserves.geojson#line');
  ok('orange dashed outline 2.5 px', L?.paint['line-color'] === '#ff7f00' && L.paint['line-width'] === 2.5 && JSON.stringify(L.paint['line-dasharray']) === '[4,2]');
  T = await layer('reserves.geojson#label');
  ok('labels at the centre, italic', T?.layout['text-anchor'] === 'center' && T.layout['text-font']?.[0] === 'DejaVu Sans Oblique');

  // fit, render, read back what is drawn
  await page.evaluate(() => window.map.fitBounds([[147.08, -9.56], [147.32, -9.38]], { duration: 0, padding: 20 }));
  await page.waitForTimeout(3500);
  const drawn = await page.evaluate(() => ['villages.geojson#label', 'roads.geojson#label', 'reserves.geojson#label', 'villages.geojson#circle'].map((id) => window.map.queryRenderedFeatures({ layers: [id] }).length));
  ok('labels and symbols drawn on the map', drawn[0] >= 2 && drawn[1] >= 1 && drawn[2] >= 1 && drawn[3] === 3, drawn.join(' / '));
  ok('every glyph file found', glyphMisses.length === 0, glyphMisses.slice(0, 2).join(' '));
  await page.screenshot({ path: `${out}/symbology-options-dark.png` });

  console.log('raster symbology');
  const rlist = (await (await fetch(`${base}/api/rasters`)).json()).rasters;
  const rr = rlist.find((x) => x.id.startsWith('height'));
  ok('raster found', !!rr, rlist.map((x) => x.id).join(','));
  if (rr) {
    await page.check(`.layer.raster[data-id="r:${rr.id}"] > input[type=checkbox]`);
    await page.waitForTimeout(300);
    await page.click(`.layer.raster[data-id="r:${rr.id}"] [data-act="props"]`);
    await page.waitForSelector('.gx-dialog [name=kind]');
    await page.selectOption('.gx-dialog [name=kind]', 'stretch');
    await page.selectOption('.gx-dialog [name=ramp]', 'magma');
    await page.click('.gx-dialog [data-preset=full]');
    ok('full range preset fills min and max', (await page.inputValue('.gx-dialog [name=min]')) === '0' && (await page.inputValue('.gx-dialog [name=max]')) === '399');
    await page.check('.gx-dialog [name=invert]');
    await page.fill('.gx-dialog [name=clear_below]', '50');
    await page.selectOption('.gx-dialog [name=resampling]', 'nearest');
    await page.fill('.gx-dialog [name=opacity]', '60');
    await page.screenshot({ path: `${out}/raster-symbology-dark.png` });
    await page.click('.gx-dialog [data-btn=ok]');
    await page.waitForSelector('.gx-dialog', { state: 'detached' });
    const after = (await (await fetch(`${base}/api/rasters/${encodeURIComponent(rr.id)}`)).json());
    ok('raster style saved', after.style.ramp === 'magma' && after.style.invert === true && after.style.clear_below === 50 && after.style.max === 399 && after.style.resampling === 'nearest', JSON.stringify(after.style));
    ok('overlay redrawn (new URL)', after.overlay.url !== rr.overlay.url);
    const png = await fetch(`${base}${after.overlay.url}`);
    ok('overlay renders', png.ok && (png.headers.get('content-type') ?? '').includes('png'));
    ok('legend follows (inverted magma)', after.legend.type === 'ramp' && after.legend.colors[0] !== rr.legend.colors?.[0]);
    const lyr = await page.evaluate((id) => { const l = window.map.getStyle().layers.find((x) => x.id === `raster:${id}`); return l ? l.paint : null; }, rr.id);
    ok('map layer uses the opacity and nearest resampling', !!lyr && (lyr['raster-opacity'] === 0.6 && lyr['raster-resampling'] === 'nearest'), JSON.stringify(lyr));
    ok('style kept across restarts', JSON.parse(readFileSync(join(tmp, 'state', 'raster-styles.json'), 'utf8'))[rr.id]?.ramp === 'magma');
    await fetch(`${base}/api/rasters/${encodeURIComponent(rr.id)}/style`, { method: 'DELETE' });
    const reset = (await (await fetch(`${base}/api/rasters/${encodeURIComponent(rr.id)}`)).json());
    ok('reset to automatic', !reset.style.invert && reset.style.ramp === rr.style.ramp);
  }

  console.log('about');
  await page.evaluate(() => document.querySelector('[data-cmd="help.about"]')?.click());
  await page.waitForTimeout(200);
  if (!(await page.$('.about-check'))) {
    await page.click('text=Help').catch(() => {});
    await page.click('[data-cmd="help.about"]').catch(() => {});
  }
  await page.waitForSelector('.about-check', { timeout: 5000 }).catch(() => {});
  ok('about card with version and update check', !!(await page.$('.about-check')) && /\d+\.\d+/.test(await page.textContent('.about-row code').catch(() => '')));
  ok('about links', (await page.$$('.about-link')).length === 6);
  await page.screenshot({ path: `${out}/about-dark.png` });
  await page.keyboard.press('Escape');

  console.log('export');
  const y = ['recipe: sym-export', 'version: 1', 'title: Symbols', 'steps:', '  - id: map', '    use: export.map',
    '    with: {"layers": ["reserves.geojson", "roads.geojson", "villages.geojson"], "name": "symbols", "title": "Symbols and labels", "basemap": "none"}', 'outputs: [map]', ''].join('\n');
  await fetch(`${base}/api/recipes`, { method: 'POST', body: y, headers: { 'content-type': 'text/yaml' } });
  let run = await (await fetch(`${base}/api/recipes/sym-export/run`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  for (let i = 0; i < 120 && ['running', 'queued'].includes(run.status); i++) {
    await sleep(500);
    run = await (await fetch(`${base}/api/runs/${run.id}`)).json();
  }
  ok('export ran', run.status === 'done', run.error ?? '');
  const svg = run.outputs?.map?.svg ? readFileSync(run.outputs.map.svg, 'utf8') : '';
  ok('stars in the export', (svg.match(/M12 1\.5l3\.1/g) ?? []).length >= 3 + 1, `${(svg.match(/M12 1\.5l3\.1/g) ?? []).length} stars (3 + legend)`);
  const scales = [...svg.matchAll(/scale\(([\d.]+)\) rotate\(15/g)].map((m) => Number(m[1]));
  ok('sizes follow population (biggest first)', scales.length >= 3 && scales[0] > scales[2], scales.join(', '));
  ok('dash-dot road with a casing', /stroke-dasharray="[\d.]+ [\d.]+ [\d.]+ [\d.]+"/.test(svg) && /stroke-linecap="butt"/.test(svg));
  ok('hollow reserves with an orange dashed outline', /fill="none"[^>]*stroke="#ff7f00"[^>]*stroke-dasharray/.test(svg));
  ok('bold uppercase village labels', /font-weight="bold"[^>]*>(<tspan[^>]*>)?HANUABADA/.test(svg) || /font-weight="bold".{0,400}HANUABADA/.test(svg));
  ok('italic reserve labels', /font-style="italic".{0,300}Varirata/.test(svg));
  ok('road names follow the road', /<textPath[^>]*>Magi Highway<\/textPath>/.test(svg) || /<textPath[^>]*>Hubert Murray Highway<\/textPath>/.test(svg));
  ok('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  code = failed.length ? 1 : 0;
} finally {
  await browser.close();
  srv.kill();
  if (!failed.length && !process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
  else console.log('kept', tmp);
}
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(code);
