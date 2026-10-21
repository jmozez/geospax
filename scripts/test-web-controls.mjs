// Clicks every control of the web UI in both modes and fails on any page error, console error or
// failed request, plus a few checks that a click did what its label says.
//   PW=/path/to/node_modules/playwright node scripts/test-web-controls.mjs [base] [out-dir]
// Needs a server with at least one point layer that has a numeric field (scripts/data-sample-field.py).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? 'bench/screenshots';
mkdirSync(out, { recursive: true });

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};
// long or environment-bound: run separately (bench, deck, full screen, docs in new tabs)
const SKIP = new Set(['analyze.bench', 'analyze.deck', 'view.fullscreen', 'home.exportPng', 'home.copyLink']);
// switches: clicked twice, so the next command finds the window as it was
const TOGGLES = new Set(['view.dockLeft', 'view.dockRight', 'view.dockBottom', 'view.ribbonAutoHide', 'home.contents']);
// online basemap tiles fail where the network is closed (CI, sandboxes): not a UI fault
const OFFLINE = /tile\.openstreetmap\.org|ERR_TUNNEL_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
const page = await ctx.newPage();
const problems = [];
let where = 'load';
page.on('pageerror', (e) => problems.push(`[${where}] pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !OFFLINE.test(m.text()) && !/favicon/.test(m.text()) && problems.push(`[${where}] console: ${m.text()}`));
page.on('response', (r) => r.status() >= 500 && problems.push(`[${where}] HTTP ${r.status()} ${r.url()}`));
page.on('dialog', (d) => d.accept('Test group'));
page.on('popup', (p) => p.close().catch(() => {}));
page.on('filechooser', () => {}); // “Add files”: the chooser opens; nothing is picked here
const settle = (ms = 250) => page.waitForTimeout(ms);
const tidy = async () => {
  await page.keyboard.press('Escape');
  for (const sel of ['.sheet [data-close]', '#palette.open .close', '.rb-menu']) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) await page.locator(sel).first().click({ timeout: 1000 }).catch(() => {});
  }
  await page.evaluate(() => document.querySelectorAll('.rb-menu').forEach((m) => m.remove()));
};
const clickAll = async (label, selector) => {
  const n = await page.locator(selector).count();
  let clicked = 0;
  for (let i = 0; i < n; i++) {
    const el = page.locator(selector).nth(i);
    if (!(await el.isVisible().catch(() => false)) || !(await el.isEnabled().catch(() => false))) continue;
    where = `${label} #${i} ${((await el.innerText().catch(() => '')) || (await el.getAttribute('title')) || '').replace(/\s+/g, ' ').slice(0, 40)}`;
    const before = problems.length;
    await el.click({ timeout: 3000 }).catch((e) => problems.push(`[${where}] click failed: ${e.message.split('\n')[0]}`));
    await settle();
    await tidy();
    clicked++;
    if (problems.length > before) console.log(`  !    ${where}: ${problems.slice(before).join(' | ')}`);
  }
  return clicked;
};

// ------------------------------------------------------------------ Pro
console.log('\nPro mode');
await page.goto(`${base}/?mode=pro`, { waitUntil: 'networkidle' });
await settle(2500);
const tabs = await page.locator('#ribbon-tabs .rb-tab').evaluateAll((b) => b.map((x) => x.dataset.tab));
let total = 0;
for (const tab of tabs) {
  await page.click(`#ribbon-tabs .rb-tab[data-tab="${tab}"]`);
  await settle(400);
  const ids = await page.locator('#ribbon-body [data-cmd]').evaluateAll((b) => b.map((x) => x.dataset.cmd));
  for (const id of ids) {
    if (SKIP.has(id)) continue;
    await page.click(`#ribbon-tabs .rb-tab[data-tab="${tab}"]`).catch(() => {});
    await settle(150);
    where = `ribbon ${tab} › ${id}`;
    const before = problems.length;
    for (let k = 0; k < (TOGGLES.has(id) ? 2 : 1); k++) {
      if (k) await page.click(`#ribbon-tabs .rb-tab[data-tab="${tab}"]`).catch(() => {});
      await page.locator(`#ribbon-body [data-cmd="${id}"]`).first().click({ timeout: 3000 }).catch((e) => problems.push(`[${where}] ${e.message.split('\n')[0]}`));
      await settle(300);
    }
    await tidy();
    total++;
    if (problems.length > before) console.log(`  !    ${where}: ${problems.slice(before).join(' | ')}`);
  }
}
ok('every Pro ribbon command runs without an error', !problems.length, `${total} commands on ${tabs.length} tabs`);

const layerId = await page.locator('#contents .layer.pro').first().getAttribute('data-id');
await page.locator('#contents .layer.pro .name').first().click();
await settle(300);
ok('contextual Layer tab appears for a selected layer', await page.locator('#ribbon-tabs .rb-ctx').isVisible());
await page.click('#ribbon-tabs .rb-ctx');
await settle(300);
total = await clickAll('Layer tab', '#ribbon-body [data-cmd], #ribbon-body [data-next]');
ok('Layer tab commands run', !problems.length, `${total} buttons`);

// tree: group, twisty, visibility, opacity, filter
const p0 = problems.length;
await page.locator(`#contents .layer.pro[data-id="${layerId}"] .name`).click();
await page.click('button[data-tree="group"]');
await settle(300);
ok('“Group” makes a group layer', (await page.locator('.pr-group').count()) >= 1);
await page.locator('.pr-group input[data-gact="visible"]').first().uncheck();
await settle(300);
ok('a group switch hides its layers on the map', await page.evaluate((id) => window.map.getStyle().layers.filter((l) => l.source === id).every((l) => l.layout?.visibility === 'none'), layerId));
await page.locator('.pr-group input[data-gact="visible"]').first().check();
await clickAll('tree buttons', '#contents button[data-tree="expand"], #contents button[data-tree="collapse"], #contents .pr-tw:not([disabled])');
await page.locator('.pr-group [data-gact="ungroup"]').first().click({ force: true });
await settle(300);
await page.fill('.pr-filter', layerId.slice(0, 3));
await settle(200);
await page.fill('.pr-filter', '');
await page.selectOption('select[data-tree="basemap"]', 'none');
await settle(300);
await page.selectOption('select[data-tree="basemap"]', 'offline');
ok('tree controls run without an error', problems.length === p0);

// dock tabs (both docks), Toolbox
total = await clickAll('dock tabs', '.dock-tabs button');
ok('every Pro dock tab opens', !problems.length, `${total} tabs`);
await page.click('#dock-right .dock-tabs [data-tab="toolbox"]');
await settle(300);
await page.fill('.tb-search', 'buffer');
await settle(200);
ok('Toolbox search finds tools', (await page.locator('.tb-tool').count()) > 0);
await page.locator('.tb-tool').first().click();
await settle(200);
ok('a Toolbox tool opens', await page.locator('.tb-detail').isVisible());
await page.click('[data-back]');

// ------------------------------------------------------------------ Lazy
console.log('\nLazy mode');
await page.click('#mode-switch [data-mode="lazy"]');
await settle(800);
ok('mode switch: Lazy shows the task bar', await page.locator('.tk-bar').isVisible());
ok('mode switch: Lazy opens its own panes', ['inspector', 'toolbox'].includes(await page.locator('#dock-right section.on').getAttribute('data-tab')) && (await page.locator('#dock-bottom section.on').getAttribute('data-tab')) === 'activity');
const p1 = problems.length;
total = await clickAll('task bar', '.tk-ask, .tk-task');
ok('every task-bar button runs', problems.length === p1, `${total} buttons`);
await page.screenshot({ path: `${out}/controls-before-card.png` });
await page.click('#dock-left .dock-tabs [data-tab="contents"]').catch(() => {});
await page.locator('#contents .layer.card .lc-sentence').first().click();
await settle(400);
ok('clicking a card selects the layer (Inspector fills in)', await page.locator('#inspector .ins').isVisible());
const p2 = problems.length;
total = await clickAll('inspector chips', '#inspector .ins-chip');
await settle(1500);
total += await clickAll('inspector actions', '#inspector [data-ins="zoom"], #inspector [data-ins="table"]');
ok('every Inspector chip and action runs', problems.length === p2, `${total} controls`);
const p3 = problems.length;
total = await clickAll('card buttons', '#contents .layer.card [data-act="zoom"], #contents .layer.card [data-act="props"], #contents .lc-switch');
total += await clickAll('card eyes', '#contents .lc-eye input');
total += await clickAll('card eyes again', '#contents .lc-eye input');
ok('every card button runs', problems.length === p3, `${total} controls`);
await page.click('#mode-switch [data-mode="lazy"]');
await settle(300);
const p4 = problems.length;
total = await clickAll('lazy dock tabs', '.dock-tabs button');
ok('every Lazy dock tab opens', problems.length === p4, `${total} tabs`);
await page.screenshot({ path: `${out}/controls-lazy.png` });

// one analysis end to end from a card: it must finish and show in Activity
await page.click('#dock-left .dock-tabs [data-tab="contents"]');
// the list is capped (newest first): watch for a new id at the top
const top0 = (await (await page.request.get(`${base}/api/runs`)).json()).runs[0]?.id;
const run = page.locator('#contents .layer.card [data-act="recipe"]').first();
if (await run.count()) {
  where = 'card recipe button';
  await run.click();
  let status = '';
  for (let i = 0; i < 90 && !['done', 'failed'].includes(status); i++) {
    await settle(1000);
    const runs = (await (await page.request.get(`${base}/api/runs`)).json()).runs;
    if (runs[0] && runs[0].id !== top0) status = runs[0].status;
  }
  await page.click('#dock-bottom .dock-tabs [data-tab="activity"]');
  await settle(800);
  ok('a card’s analysis button runs a recipe to the end', status === 'done', status || 'no run');
  ok('the run shows up in Activity with its report', (await page.locator('#activity .act-item.done [data-act-open]').count()) > 0);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (problems.length) console.log(`\nproblems:\n  ${problems.join('\n  ')}`);
await browser.close();
process.exit(fails.length || problems.length ? 1 : 0);
