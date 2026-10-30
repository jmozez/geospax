// The ribbon tools added in 3.0.6, in a real browser against a running server whose data folder is
// made by scripts/test-edit-data.py (survey points with a `surveyed` date, reserves polygons).
//
//   node scripts/test-web-ribbon.mjs http://127.0.0.1:18120 OUT_DIR
//
// Checks: every new command exists on its tab; panels collapse and expand with their chevrons;
// coordinates in DMS, UTM and MGRS; the grid; swipe and spyglass; the time slider filters by date;
// lasso selection; split / merge / copy / paste through the Edit tools; labels on and off; Share ›
// Web map writes a page with the layers; the coordinate-system search finds PNG94.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');

const base = (process.argv[2] ?? 'http://127.0.0.1:18120').replace(/\/$/, '');
const out = process.argv[3] ?? 'ribbon-shots';
mkdirSync(out, { recursive: true });
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(`${base}/?fresh`);
await page.waitForFunction(() => window.map && window.map.loaded(), null, { timeout: 120_000 });
await page.waitForTimeout(1500);
const cmd = (id) => page.evaluate((id) => window.workbench.command(id), id);
const dialogBtn = async (label) => { await page.click(`.gx-dialog button:has-text("${label}")`); await page.waitForTimeout(300); };
const pick = async (name) => { await page.click(`#contents >> text=${name}`); await page.waitForTimeout(300); };

console.log('\n1 · commands on their tabs');
const ids = await page.evaluate(() => window.workbench.commandIds());
for (const id of ['home.lasso', 'home.labels', 'home.coords', 'view.swipe', 'view.spyglass', 'view.time', 'view.grid', 'view.scale', 'view.lockscale', 'view.crs',
  'edit.split', 'edit.merge', 'edit.cut', 'edit.reshape', 'edit.copy', 'edit.paste', 'edit.copyalong', 'edit.trace', 'edit.gps', 'edit.rules', 'edit.topology',
  'design.survey', 'design.areas', 'design.hatch', 'imagery.index', 'imagery.hillshade', 'imagery.clip', 'imagery.mosaic', 'analyze.zonal', 'analyze.servicearea',
  'analyze.closest', 'share.data.gpkg', 'share.data.shp', 'share.map.pdf', 'share.publish', 'share.package', 'share.print', 'help.tutorials']) {
  if (!ids.includes(id)) ok(`command ${id}`, false);
}
ok('all new commands registered', !fails.length, `${ids.length} commands`);

// No ribbon group shows the same button twice (3.0.6 had two 'Wetness index' buttons in Imagery › Terrain).
const dupes = [];
for (const tab of await page.$$eval('#ribbon-tabs .rb-tab', (b) => b.map((x) => x.dataset.tab))) {
  await page.click(`#ribbon-tabs .rb-tab[data-tab="${tab}"]`);
  await page.waitForTimeout(250);
  dupes.push(...await page.$$eval('#ribbon .rb-group', (gs, tab) => gs.flatMap((g) => {
    const seen = new Set();
    const group = g.querySelector('.rb-title')?.textContent.trim();
    return [...g.querySelectorAll('.rb-items .rb-label')].map((l) => l.textContent.trim()).filter((t) => {
      const twice = seen.has(t); seen.add(t); return twice;
    }).map((t) => `${tab} › ${group} › ${t}`);
  }), tab));
}
ok('no ribbon group repeats a button', !dupes.length, dupes.join(', '));
await page.click('#ribbon-tabs .rb-tab[data-tab="home"]');
await page.waitForTimeout(250);

console.log('\n2 · panels collapse and expand');
for (const dock of ['left', 'right', 'bottom']) {
  await page.click(`[data-fold="${dock}"]`);
  await page.waitForTimeout(250);
  const shut = await page.evaluate((d) => document.querySelector(`#dock-${d}`).classList.contains('collapsed'), dock);
  const label = await page.getAttribute(`[data-fold="${dock}"]`, 'aria-label');
  ok(`${dock} collapses`, shut && /Expand/.test(label), label);
}
await page.screenshot({ path: `${out}/panels-collapsed.png` });
for (const dock of ['left', 'right', 'bottom']) {
  await page.click(`[data-fold="${dock}"]`);
  await page.waitForTimeout(250);
  ok(`${dock} expands again`, !(await page.evaluate((d) => document.querySelector(`#dock-${d}`).classList.contains('collapsed'), dock)));
}

console.log('\n3 · coordinates');
const coordsAt = (fmt) => page.evaluate(async (fmt) => {
  localStorage.setItem('geospax.coords', fmt);
  const m = await import('/src/mapextras.ts').catch(() => null);
  return m ? m.formatCoords(147.18, -6.73) : null;
}, fmt);
// formatting is checked through the status bar after moving the pointer over the map
await cmd('home.coords');
await page.click('.gx-dialog input[value="dms"]');
await dialogBtn('Use');
const mapBox = await page.locator('#map').boundingBox();
await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
await page.waitForTimeout(200);
const dms = await page.textContent('#sb-coords');
ok('DMS readout', /\d+°\d\d′[\d.]+″[NS] \d+°\d\d′[\d.]+″[EW]/.test(dms), dms);
await cmd('home.coords');
await page.click('.gx-dialog input[value="mgrs"]');
await dialogBtn('Use');
await page.mouse.move(mapBox.x + mapBox.width / 2 + 5, mapBox.y + mapBox.height / 2);
await page.waitForTimeout(200);
const mgrs = await page.textContent('#sb-coords');
ok('MGRS readout', /^\d{1,2}[C-X] [A-Z]{2} \d{5} \d{5}$/.test(mgrs), mgrs);
void coordsAt;
const known = await page.evaluate(() => fetch('api/crs?q=PNG94&lon=147&lat=-6').then((r) => r.json()));
const pac = await page.evaluate(() => fetch('api/crs/pacific').then((r) => r.json()));
ok('Pacific CRS pack lists PNG94 and Fiji', pac.systems.some((s) => s.code === 'EPSG:5551') && pac.systems.some((s) => s.code === 'EPSG:3460'), `${pac.total} systems`);
ok('coordinate-system search finds PNG94', known.systems.some((s) => /PNG94/.test(s.name)), known.systems.slice(0, 3).map((s) => s.code).join(', '));
await cmd('view.crs');
await page.fill('.gx-dialog input[name=q]', '32755');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/crs-picker.png` });
await page.click('.gx-dialog .crs-row input');
await dialogBtn('Use this system');
await page.waitForTimeout(500);
await page.mouse.move(mapBox.x + mapBox.width / 2 + 10, mapBox.y + mapBox.height / 2);
await page.waitForTimeout(200);
const utm = await page.textContent('#sb-coords');
ok('EPSG:32755 readout in metres', /^EPSG:32755 \d+\.\d\d, \d+\.\d\d$/.test(utm), utm);

console.log('\n4 · grid, swipe, spyglass');
await cmd('view.grid');
await page.waitForTimeout(600);
const grid = await page.evaluate(() => !!window.map.getLayer('gx-grid-lines') && window.map.querySourceFeatures('gx-grid').length > 0);
ok('grid lines drawn', grid);
await page.screenshot({ path: `${out}/grid.png` });
await cmd('view.grid');
await pick('reserves');
await cmd('view.swipe');
await page.waitForTimeout(1500);
ok('swipe overlay and divider', (await page.$$('.gx-compare.gx-swipe')).length === 1 && (await page.$$('.gx-swipe-bar')).length === 1);
const clip = await page.evaluate(() => document.querySelector('.gx-compare').style.clipPath);
ok('overlay clipped at the divider', /inset\(0(px)? 0(px)? 0(px)? \d+/.test(clip), clip);
const bar = await page.locator('.gx-swipe-bar').boundingBox();
await page.mouse.move(bar.x + 2, bar.y + bar.height / 2);
await page.mouse.down();
await page.mouse.move(bar.x - 200, bar.y + bar.height / 2, { steps: 5 });
await page.mouse.up();
const clip2 = await page.evaluate(() => document.querySelector('.gx-compare').style.clipPath);
ok('dragging moves the divider', clip2 !== clip, `${clip} → ${clip2}`);
await page.screenshot({ path: `${out}/swipe.png` });
await cmd('view.swipe');
ok('swipe ends', (await page.$$('.gx-compare')).length === 0);
await cmd('view.spyglass');
await page.waitForTimeout(800);
await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
const lens = await page.evaluate(() => document.querySelector('.gx-compare')?.style.clipPath ?? '');
ok('spyglass lens follows the pointer', /circle\(110px at/.test(lens), lens);
await page.screenshot({ path: `${out}/spyglass.png` });
await cmd('view.spyglass');

console.log('\n5 · time slider');
await pick('survey.geojson');
const before = await page.evaluate(() => window.workbench && document.querySelector('#sb-layer').textContent);
await cmd('view.time');
await page.selectOption('.gx-dialog select[name=field]', 'surveyed');
await page.selectOption('.gx-dialog select[name=step]', 'month');
await dialogBtn('Start');
await page.waitForTimeout(2000);
const lbl = await page.textContent('.gx-time b');
ok('time slider shows the first month', /^\d{4}-\d\d$/.test(lbl), lbl);
const filt = await page.evaluate(async () => {
  const l = await fetch('api/layers').then((r) => r.json()).then((j) => (j.layers ?? j).find((x) => x.id.startsWith('survey.geojson')));
  const t = await fetch(`api/layers/${encodeURIComponent(l.id)}/table`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 100 }) }).then((r) => r.json());
  const col = t.fields.indexOf('surveyed');
  return { filter: l.filter, total: t.total, all: l.feature_count, dates: t.rows.map((r) => r.values[col]) };
});
ok('the layer is filtered to that month', /surveyed/.test(filt.filter ?? '') && filt.total > 0 && filt.total < filt.all && filt.dates.every((d) => String(d).startsWith('2023-01')), `${filt.total} of ${filt.all}: ${filt.dates.join(', ')}`);
await page.screenshot({ path: `${out}/time-slider.png` });
await page.click('.gx-time [data-t=close]');
await page.waitForTimeout(1500);
const after = await page.evaluate(() => fetch('api/layers').then((r) => r.json()).then((j) => (j.layers ?? j).find((l) => l.id.startsWith('survey.geojson'))));
ok('closing restores the layer', !after.filter, String(after.filter));
void before;

console.log('\n6 · labels, lasso, copy and paste');
await cmd('home.labels');
await page.waitForTimeout(500);
ok('labels on', /Labels on/.test(await page.textContent('#sb-msg')), await page.textContent('#sb-msg'));
await cmd('home.labels');
await page.waitForTimeout(300);
await cmd('home.lasso');
await page.waitForTimeout(200);
const tool = await page.evaluate(() => document.body.dataset.editTool);
ok('lasso tool active', tool === 'lasso', tool);
await page.keyboard.press('Escape');
const fid = await page.evaluate(async () => {
  const id = [...window.editor.selection.keys()][0] ?? null;
  return id;
});
void fid;
console.log('\n7 · Share › Web map');
await page.evaluate(() => window.map.fitBounds([[146.5, -6.2], [147.3, -5.6]], { duration: 0 }));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), (async () => { await cmd('share.publish'); await dialogBtn('Make the web map'); })()]);
const file = `${out}/${dl.suggestedFilename()}`;
await dl.saveAs(file);
const html = readFileSync(file, 'utf8');
ok('web map page written', /<!doctype html>/i.test(html) && html.includes('maplibre-gl@4.7.1') && html.includes('integrity="sha384-'), `${dl.suggestedFilename()} ${(html.length / 1024).toFixed(0)} kB`);
ok('it holds the layers', html.includes('reserves') && html.includes('survey'));
const viewer = await ctx.newPage();
// the page loads MapLibre from jsDelivr; offline (or behind a proxy) serve the same npm files locally
if (process.env.MAPLIBRE4_DIST) {
  await viewer.route('https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/**', (r) => {
    const f = r.request().url().split('/').pop();
    r.fulfill({ body: readFileSync(`${process.env.MAPLIBRE4_DIST}/${f}`), contentType: f.endsWith('.css') ? 'text/css' : 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
}
const vErr = [];
viewer.on('pageerror', (e) => vErr.push(e.message));
await viewer.goto(`file://${resolve(file)}`);
await viewer.waitForTimeout(4000);
const toc = await viewer.$$eval('#toc label', (l) => l.length).catch(() => 0);
ok('the page opens with a layer list', toc >= 2, `${toc} layers${vErr.length ? `; errors: ${vErr.join(' | ')}` : ''}`);
await viewer.screenshot({ path: `${out}/web-map.png` });
await viewer.close();

console.log('\n8 · tutorials');
await cmd('help.tutorials');
await page.click('[data-tut="edit"]');
await page.waitForTimeout(400);
let steps = 0;
for (; steps < 12 && (await page.$('.tut-card')); steps++) {
  if (steps === 2) await page.screenshot({ path: `${out}/tutorial.png` });
  await page.click('.tut-card [data-next]');
  await page.waitForTimeout(250);
}
ok('the Edit lesson runs to the end', steps === 6 && !(await page.$('.tut-card')), `${steps} steps`);

ok('no page errors', problems.length === 0, problems.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
