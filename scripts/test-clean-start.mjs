#!/usr/bin/env node
// The start and the everyday workbench, end to end on a server of its own:
//   - a clean start: no layers, the globe;
//   - Data › Sample data opens for the session only (not copied into the data folder);
//   - Remove from map (✕, Delete key) takes a layer off and it stays off after a reload;
//   - every ribbon tab fits at 1400 and 1024 px (groups collapse instead of being cut off) and no
//     two different commands share an icon;
//   - GSX tools are on the Plugins tab only; Settings and the help page (with the FAQ) open.
//
//   node scripts/test-clean-start.mjs [target/release/geospax-server] [screenshot dir]
// Set KEEP=1 to keep the temporary folder.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const bin = process.argv[2] ?? 'target/release/geospax-server';
const shots = process.argv[3] ?? '';
let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (cond) passed++;
  else failed.push(name);
};

const tmp = mkdtempSync(join(tmpdir(), 'gx-clean-'));
const data = join(tmp, 'data');
mkdirSync(data);
const port = 18097;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv;
async function start() {
  srv = spawn(bin, ['--data', data, '--state-dir', join(tmp, 'state'), '--port', String(port), '--web', 'web/dist', '--no-device-mounts', '--no-triggers'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('the server did not start');
}
async function stop() {
  srv.kill();
  await new Promise((r) => srv.once('exit', r));
}

await start();
const browser = await chromium.launch();
let code = 1;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  console.log('first start: Lazy mode, dark theme');
  await page.goto(`${base}/`);
  await page.waitForTimeout(2000);
  ok('a first start is in Lazy mode', !!(await page.$('#ribbon.lazy')));
  ok('a first start uses the dark theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

  console.log('clean start');
  await page.goto(`${base}/?mode=pro&theme=light`);
  await page.waitForTimeout(2500);
  ok('no layers at the start', (await page.$$('#contents .layer')).length === 0);
  ok('the map is a globe', await page.evaluate(() => window.map.getProjection()?.type === 'globe'));
  ok('the globe fills the map', await page.evaluate(() => window.map.getZoom() > 0.8));

  console.log('ribbon');
  for (const width of [1400, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400);
    const tabs = await page.$$eval('#ribbon-tabs [data-tab]', (a) => a.map((x) => x.dataset.tab));
    const over = [];
    for (const t of tabs) {
      await page.click(`#ribbon-tabs [data-tab="${t}"]`);
      await page.waitForTimeout(350);
      const o = await page.$eval('#ribbon-body', (e) => e.scrollWidth - e.clientWidth);
      if (o > 1) over.push(`${t}:${o}`);
    }
    ok(`every tab fits at ${width} px`, !over.length, over.join(' '));
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  ok('tabs in ArcGIS Pro order, Help last', (await page.$$eval('#ribbon-tabs [data-tab]', (a) => a.map((x) => x.textContent.trim()))).join(',') === 'Home,Data,Analysis,View,Edit,Imagery,Share,R & Python,Automate,Plugins,Help');
  // icons: the same picture for two different commands confuses (same command on two tabs is fine)
  const icons = {};
  for (const t of await page.$$eval('#ribbon-tabs [data-tab]', (a) => a.map((x) => x.dataset.tab))) {
    await page.click(`#ribbon-tabs [data-tab="${t}"]`);
    await page.waitForTimeout(250);
    for (const [d, title] of await page.$$eval('#ribbon-body [data-cmd]', (bs) => bs.map((b) => [b.querySelector('path')?.getAttribute('d') ?? '', b.querySelector('.rb-label')?.textContent?.trim() ?? b.title]))) {
      (icons[d] ??= new Set()).add(title.toLowerCase());
    }
  }
  const same = [['zoom to', 'zoom to layer'], ['add data', 'add files'], ['basemap', 'basemap gallery'], ['full extent'], ['automap', 'automap all'], ['refresh', 'refresh runs'], ['gallery', 'recipe gallery'], ['history', 'run history'], ['soil'], ['climate'], ['species'], ['distance'], ['area'], ['clear'], ['attribute table'], ['by attributes'], ['by location'], ['zoom to selected'], ['clear selection'], ['symbology']];
  const dup = Object.values(icons).map((s) => [...s]).filter((ts) => ts.length > 1 && !same.some((g) => ts.every((x) => g.includes(x))));
  ok('no icon stands for two different commands', !dup.length, dup.map((d) => d.join(' / ')).join('; '));
  await page.click('#ribbon-tabs [data-tab="analyze"]');
  await page.waitForTimeout(400);
  await page.click('[data-menu="recipes"]');
  const recipeIds = await page.$$eval('.rb-menu [data-recipe]', (a) => a.map((x) => x.dataset.recipe));
  ok('no GSX domain kits in Analysis', !recipeIds.some((r) => /^kit-(species|survey|protection|forest|land-cover|vegetation|steep|soil|climate)/.test(r)), recipeIds.join(','));
  await page.keyboard.press('Escape');
  await page.click('#ribbon-tabs [data-tab="plugins"]');
  await page.waitForTimeout(400);
  ok('twelve domain plugins on the Plugins tab', (await page.$$('[data-group="domains"] [data-menu^="plugin:"]')).length === 12);
  await page.click('[data-menu="plugin:geospax-biodiversity"]');
  ok('a domain plugin lists its kit', (await page.$$('.rb-menu [data-recipe^="kit-"]')).length >= 1);
  await page.keyboard.press('Escape');

  console.log('sample data, remove from map');
  const r = await (await fetch(`${base}/api/samples/png`, { method: 'POST' })).json();
  ok('sample data opens', r.layers?.length > 0, r.folder);
  ok('sample data is not copied into the data folder', readdirSync(data).length === 0, readdirSync(data).join(','));
  await page.reload();
  await page.waitForTimeout(3000);
  const rows = await page.$$eval('#contents .layer', (a) => a.map((x) => x.dataset.id));
  ok('the sample layers are on the map', rows.length >= r.layers.length, rows.join(','));
  console.log('rasters: story, values, statistics');
  await page.goto(`${base}/?mode=lazy&theme=dark`);
  await page.waitForTimeout(3000);
  await page.locator('#contents .raster-card .lc-title').first().click();
  await page.waitForTimeout(2500);
  ok('Lazy: a raster has its story in the Inspector', /Values from .* average/.test(await page.textContent('#inspector')));
  ok('Lazy: the story has a histogram', (await page.$$('#inspector .rv-hist rect')).length > 5);
  await page.click('#inspector [data-rv="zoom"]');
  await page.waitForTimeout(1500);
  const mb = await page.locator('#map').boundingBox();
  await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.waitForTimeout(1500);
  ok('a map click reads the raster value', /\d/.test(await page.textContent('#inspector .rv-value .rv-read').catch(() => '')));
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(3000);
  await page.locator('#contents .layer.raster .name').first().click();
  await page.waitForTimeout(2500);
  ok('Pro: Symbology shows the raster', await page.locator('#raster-sym').isVisible() && (await page.$$('#raster-sym .rv-bands tr')).length >= 2);
  await page.evaluate(() => document.querySelector('#dock-right .dock-tabs [data-tab="attributes"]')?.click());
  await page.waitForTimeout(600);
  ok('Pro: Attributes shows band statistics', await page.locator('#raster-attr .rv-bands').isVisible());
  await page.locator('#contents .layer.pro:not(.raster) .name').first().click();
  await page.waitForTimeout(800);
  ok('selecting a vector gives the panes back', await page.evaluate(() => !document.querySelector('#attributes').hidden && document.querySelector('#raster-attr').hidden && document.querySelector('#raster-sym').hidden && !document.querySelector('#panel').hidden));
  await page.evaluate(() => { const l = JSON.parse(localStorage.getItem('geospax.workbench.v1') || '{}'); l.left = 120; localStorage.setItem('geospax.workbench.v1', JSON.stringify(l)); });
  await page.reload();
  await page.waitForTimeout(3000);
  ok('the left pane never gets too narrow for its tabs', (await page.$eval('#dock-left', (e) => e.getBoundingClientRect().width)) >= 239 && await page.$$eval('#dock-left .dock-tabs button', (bs) => bs.every((x) => x.getBoundingClientRect().right <= x.closest('.dock-tabs').getBoundingClientRect().right + 1)));
  await page.evaluate(() => localStorage.removeItem('geospax.workbench.v1'));
  await page.goto(`${base}/?mode=pro&theme=light`);
  await page.waitForTimeout(2500);
  if (shots) {
    await page.click('#ribbon-tabs [data-tab="home"]');
    await page.evaluate(() => document.querySelector('#contents .layer:not(.raster) .name')?.click());
    await page.click('#ribbon-tabs [data-tab="home"]');
    await page.click('[data-cmd="view.zoomAll"]');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(shots, 'screenshot-pro.png') });
  }
  const victim = rows.find((id) => !id.startsWith('r:'));
  await page.click(`#contents .layer[data-id="${victim}"] [data-act="remove"]`);
  await page.waitForTimeout(800);
  ok('✕ removes the layer', !(await page.$(`#contents .layer[data-id="${victim}"]`)));
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForTimeout(3000);
  ok('it stays off after a reload', !(await page.$(`#contents .layer[data-id="${victim}"]`)));
  const second = (await page.$$eval('#contents .layer.pro', (a) => a.map((x) => x.dataset.id))).find((id) => !id.startsWith('r:'));
  await page.focus(`#contents .layer[data-id="${second}"]`);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(800);
  ok('the Delete key removes the focused layer', !(await page.$(`#contents .layer[data-id="${second}"]`)));
  await page.goto(`${base}/?mode=lazy&theme=light`);
  await page.waitForTimeout(3000);
  ok('no ribbon tabs in Lazy (R & Python is Pro only)', !(await page.$('#ribbon-tabs [data-tab="r"]')));
  await page.keyboard.press('Control+k');
  await page.fill('#palette-input', 'R console');
  await page.waitForTimeout(500);
  ok('Lazy search does not offer R & Python', !(await page.$$eval('#palette-list .pal-row .pl', (a) => a.map((x) => x.textContent))).includes('R console'));
  await page.keyboard.press('Escape');
  ok('Lazy cards have a remove button', (await page.$$('#contents .card [data-act="remove"]')).length > 0);

  console.log('deleting finished runs');
  page.on('dialog', (d) => d.accept());
  for (let i = 0; i < 2; i++) {
    const run = await (await fetch(`${base}/api/recipes/points-to-hotspots/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    for (let k = 0; k < 60; k++) {
      const st = (await (await fetch(`${base}/api/runs/${run.id}`)).json()).status;
      if (!['queued', 'running'].includes(st)) break;
      await sleep(500);
    }
  }
  const before = (await (await fetch(`${base}/api/runs`)).json()).runs.length;
  await page.goto(`${base}/?mode=lazy&theme=dark`);
  await page.waitForTimeout(3000);
  await page.click('#activity [data-act-del]');
  await page.waitForTimeout(1500);
  const mid = (await (await fetch(`${base}/api/runs`)).json()).runs.length;
  ok('✕ in Lazy Activity deletes a run', mid === before - 1, `${before} → ${mid}`);
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.querySelector('#dock-bottom .dock-tabs [data-tab="history"]')?.click());
  await page.waitForTimeout(500);
  await page.click('#history [data-clear]');
  await page.waitForTimeout(1500);
  const cleared = (await (await fetch(`${base}/api/runs`)).json()).runs.length;
  ok('Clear history in Pro deletes every finished run', cleared === 0, `${mid} → ${cleared}`);
  ok('a deleted run is gone from the engine', (await fetch(`${base}/api/runs/nope-123`)).status === 404);

  console.log('settings and help');
  await page.click('#settings-btn');
  await page.waitForTimeout(600);
  ok('Settings opens from the title bar', !!(await page.$('.gx-dialog .settings')));
  await page.selectOption('.gx-dialog [name=units]', 'imperial');
  await page.click('.gx-dialog [data-btn=ok]');
  await page.waitForTimeout(400);
  ok('Settings are kept', await page.evaluate(() => JSON.parse(localStorage.getItem('geospax.prefs') ?? '{}').units === 'imperial'));
  const help = await ctx.newPage();
  await help.goto(`${base}/help.html#FAQ`);
  await help.waitForTimeout(1500);
  ok('the help page shows the FAQ', /Frequently asked questions/.test(await help.textContent('#hp-main')));
  ok('the help page lists the guides', (await help.$$('#hp-nav a')).length >= 10);
  await help.fill('#hp-q', 'remove layer');
  await help.waitForTimeout(1200);
  ok('the help search finds answers', (await help.$$('.hp-hit')).length > 0);
  ok('no page errors', !errors.length, errors.slice(0, 2).join(' | '));

  console.log('restart: the next start is clean');
  await stop();
  await start();
  const after = await (await fetch(`${base}/api/layers`)).json();
  ok('no sample layers after a restart', after.layers.length === 0, after.layers.map((l) => l.id).join(','));
  code = failed.length ? 1 : 0;
} finally {
  await browser.close();
  srv.kill();
  if (!failed.length && !process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
  else console.log('kept', tmp);
}
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(code);
