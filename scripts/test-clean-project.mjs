#!/usr/bin/env node
// A clean start, end to end on a server of its own: no layers even when the data folder has data;
// New project gives zero layers in 2D, globe and 3D; a restart is still clean; Settings › "Reopen last
// project" off starts empty and keeps the last one; samples come only from Help › Open sample project.
//   node scripts/test-clean-project.mjs [target/release/geospax-server] [screenshot dir]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const bin = process.argv[2] ?? 'target/release/geospax-server';
const shots = process.argv[3] ?? '';
if (shots) mkdirSync(shots, { recursive: true });
let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (cond) passed++;
  else failed.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'gx-ws-'));
const data = join(tmp, 'data');
mkdirSync(data);
writeFileSync(join(data, 'villages.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'Goroka' }, geometry: { type: 'Point', coordinates: [145.39, -6.08] } },
  { type: 'Feature', properties: { name: 'Lae' }, geometry: { type: 'Point', coordinates: [147.0, -6.73] } },
] }));
const port = 18131;
const base = `http://127.0.0.1:${port}`;
let srv;
async function health() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error('the server did not start');
}
async function start(state, { perUser = false, user = 'alice' } = {}) {
  const args = ['--data', data, '--state-dir', state, '--port', String(port), '--web', 'web/dist', '--no-device-mounts', '--no-triggers'];
  if (perUser) args.push('--per-user-workspace');
  srv = spawn(bin, args, { stdio: 'ignore', env: { ...process.env, USER: user, LOGNAME: user, USERNAME: user, GEOSPAX_MACHINE_ID: 'ci-test-machine-0001' } });
  await health();
}
async function stop() {
  if (!srv || srv.exitCode !== null) return;
  srv.kill();
  await new Promise((r) => srv.once('exit', r));
}
const api = async (path, method = 'GET', body) => {
  const r = await fetch(`${base}/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, json: j, text: t };
};

const browser = await chromium.launch();
let code = 1;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const layers = () => page.$$eval('#contents .layer', (a) => a.length);

  // ------------------------------------------------------------ clean start
  console.log('clean start');
  const s1 = join(tmp, 'state1');
  await start(s1);
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(2500);
  ok('a first start has no layers although the data folder has data', (await layers()) === 0);
  const proj = await api('api/project');
  ok('the first start saves an explicit empty project', proj.json?.explicit === true && (proj.json?.order?.length ?? 0) === 0, JSON.stringify(proj.json)?.slice(0, 80));
  // put the data layer on the map (as Add to map does) and check it comes back
  const all = (await api('api/layers')).json;
  const ids = (Array.isArray(all) ? all : all?.layers ?? []).map((l) => l.id);
  ok('the data folder layer is in the Catalog', ids.length >= 1, ids.join(','));
  await api('api/project', 'PUT', { ...proj.json, order: ids, explicit: true });
  await page.reload();
  await page.waitForTimeout(2500);
  ok('a layer added on purpose stays after a reload', (await layers()) >= 1);

  console.log('New project');
  await page.click('#ribbon-tabs [data-tab="home"]');
  await page.click('[data-cmd="home.new"]');
  await page.waitForTimeout(400);
  await page.keyboard.type('Survey 2026');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  // "keep the current project?" may ask first
  for (let i = 0; i < 2; i++) {
    const btn = await page.$('.modal button.primary, .modal [data-b="ok"]');
    if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(500); }
  }
  await page.waitForLoadState('load');
  await page.waitForTimeout(3000);
  ok('New project: zero layers in Contents', (await layers()) === 0);
  for (const [name, proj3] of [['2D', 'mercator'], ['globe', 'globe']]) {
    await page.evaluate((p) => window.map.setProjection({ type: p }), proj3);
    await page.waitForTimeout(300);
    const n = await page.evaluate(() => window.map.getStyle().layers.filter((l) => l.source && !/^(basemap|bm-|osm|esri|carto|background|terrain|hillshade|sky|globe)/i.test(String(l.source)) && !/^(basemap|bm-)/.test(l.id)).filter((l) => /^(gx|lyr|layer|r-|v-)/.test(l.id)).length);
    ok(`New project: no data layers drawn in ${name}`, n === 0, String(n));
  }
  const scene = await page.evaluate(() => (window.deck?.props?.layers ?? []).length ?? 0).catch(() => 0);
  ok('New project: no 3D (deck.gl) layers', scene === 0, String(scene));
  const newp = (await api('api/project')).json;
  ok('New project is explicit and empty', newp?.explicit === true && newp?.order?.length === 0 && newp?.name === 'Survey 2026');
  ok('New project: no selection', await page.evaluate(() => !document.querySelector('#contents .layer.selected, #contents .layer.sel')));

  console.log('restart');
  await stop();
  await start(s1);
  await page.reload();
  await page.waitForTimeout(2500);
  ok('after a restart the empty project is still empty', (await layers()) === 0);

  console.log('Reopen last project off');
  await api('api/project', 'PUT', { version: 1, order: ids, layers: {}, explicit: true });
  await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => /prefs/i.test(x)); const v = k ? JSON.parse(localStorage.getItem(k)) : {}; v.reopenLast = false; localStorage.setItem(k ?? 'geospax.prefs', JSON.stringify(v)); });
  await page.reload();
  await page.waitForTimeout(2500);
  ok('with "Reopen last project" off the map starts empty', (await layers()) === 0);
  const ls = await api('api/projects/last-session');
  ok('the previous project is kept as "Last session"', ls.status === 200 && ls.json?.order?.length >= 1, String(ls.status));
  await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => /prefs/i.test(x)); if (k) { const v = JSON.parse(localStorage.getItem(k)); v.reopenLast = true; localStorage.setItem(k, JSON.stringify(v)); } });

  console.log('Help › Open sample project');
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(2500);
  ok('samples are not on the map by themselves', (await layers()) === 0);
  await page.click('#ribbon-tabs [data-tab="help"]');
  await page.click('[data-cmd="help.sample"]');
  await page.waitForTimeout(1500);
  ok('Help › Open sample project offers the sample sets', !!(await page.$('input[name="set"]')) || /no sample data/i.test((await page.textContent('#sb-msg').catch(() => '')) ?? ''));
  if (shots) await page.screenshot({ path: join(shots, 'clean-start-sample-project.png') });
  await page.keyboard.press('Escape');

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  code = failed.length ? 1 : 0;
} catch (e) {
  console.error(e);
  failed.push(String(e));
} finally {
  await browser.close();
  await stop();
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
}
console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
process.exit(code);
