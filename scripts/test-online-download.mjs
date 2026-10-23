#!/usr/bin/env node
// Online data end to end, against a local mirror served over HTTP with byte ranges and a speed
// limit (scripts/test-range-server.py), the way GDAL reads WorldClim from geodata.ucdavis.edu:
//   - the .zip source opens over HTTP (a remote .zip was refused before 3.0.2);
//   - a box drawn on the map is the area;
//   - the download gauge shows bytes, the estimated total, the speed and the time left;
//   - the rasters land in Contents, and the details say where the file is saved.
//
//   node scripts/test-online-download.mjs [target/release/geospax-server]
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const bin = process.argv[2] ?? 'target/release/geospax-server';
let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (cond) passed++;
  else failed.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'gx-online-'));
const mport = 18711;
const port = 18712;
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const data = join(tmp, 'data');
mkdirSync(data);
const state = join(tmp, 'state');
const srv = spawn(bin, ['--data', data, '--state-dir', state, '--port', String(port), '--web', 'web/dist', '--no-device-mounts', '--no-triggers'], { stdio: 'ignore', env });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
  await sleep(500);
}
// the mirror: WorldClim's layout, with two "bioclim" GeoTIFFs (a sample raster) in the zip
await fetch(`${base}/api/samples/png`, { method: 'POST' });
const sample = join(state, 'samples', 'png');
const tif = readdirSync(sample).find((f) => /bio1.*\.tif$/.test(f));
const mirror = join(tmp, 'mirror');
mkdirSync(join(mirror, 'climate/worldclim/2_1/base'), { recursive: true });
for (const n of [1, 12]) copyFileSync(join(sample, tif), join(mirror, `wc2.1_10m_bio_${n}.tif`));
execFileSync('python3', ['-c', `import zipfile,os;os.chdir(${JSON.stringify(mirror)});z=zipfile.ZipFile('climate/worldclim/2_1/base/wc2.1_10m_bio.zip','w',zipfile.ZIP_DEFLATED);[z.write(f'wc2.1_10m_bio_{n}.tif') for n in (1,12)];z.close()`]);
const ms = spawn('python3', ['scripts/test-range-server.py', String(mport), mirror], { stdio: 'ignore' });
await sleep(800);

const browser = await chromium.launch();
let code = 1;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // the form sends no mirror: add one to the recipe it posts
  await page.addInitScript((m) => {
    const f = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes('api/recipes') && o?.method === 'POST' && typeof o.body === 'string') o = { ...o, body: o.body.replace('"source":"worldclim"', `"base":"${m}","source":"worldclim"`) };
      return f(u, o);
    };
  }, `http://127.0.0.1:${mport}`);
  await page.goto(`${base}/?mode=lazy&theme=dark#view=5/-6/145`);
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('geospax:online', { detail: 'worldclim' })));
  await page.waitForTimeout(500);
  await page.click('#online [data-draw]');
  await page.waitForTimeout(400);
  const m = await page.locator('#map').boundingBox();
  await page.mouse.move(m.x + m.width * 0.35, m.y + m.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(m.x + m.width * 0.6, m.y + m.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  ok('a box drawn on the map becomes the area', await page.isChecked('#online input[name=area][value=box]'), (await page.textContent('#online .ol-area')).replace(/\s+/g, ' ').match(/drawn on the map \(([^)]*)\)/)?.[1]);
  await page.click('#online button[type=submit]');
  const seen = [];
  let end = '';
  for (let i = 0; i < 80 && !end; i++) {
    await page.waitForTimeout(250);
    const g = await page.$eval('.dl-gauge', (e) => (e.hidden ? '' : `${e.className}|${e.textContent.replace(/\s+/g, ' ')}`)).catch(() => '');
    if (g.includes('running')) seen.push(g);
    if (/\bdone\b|failed/.test(g.split('|')[0])) end = g;
  }
  ok('the gauge shows the bytes and the estimated total', seen.some((g) => /of about [\d.]+ MB/.test(g)), seen.at(-1)?.slice(0, 120));
  ok('the gauge shows the speed and the time left', seen.some((g) => /\/s/.test(g) && /left/.test(g)));
  ok('the download finishes', /\bdone\b/.test(end), end.slice(0, 160));
  await page.waitForTimeout(1500);
  const cards = await page.$$eval('#contents .raster-card .lc-title b', (a) => a.map((x) => x.textContent));
  ok('both rasters are in Contents', cards.filter((t) => /BIO(1|12) /.test(t)).length === 2, cards.join(', '));
  await page.locator('#contents .raster-card', { hasText: 'BIO1 Annual' }).locator('.lc-title').first().click();
  await page.waitForTimeout(1500);
  ok('the details say where the file is saved', /Saved in.*online-data/.test((await page.textContent('#inspector')).replace(/\s+/g, ' ')));
  ok('no page errors', !errors.length, errors.slice(0, 2).join(' | '));
  code = failed.length ? 1 : 0;
} finally {
  await browser.close();
  srv.kill();
  ms.kill();
  if (!failed.length) rmSync(tmp, { recursive: true, force: true });
  else console.log('kept', tmp);
}
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(code);
