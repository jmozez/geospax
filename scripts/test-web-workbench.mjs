// Headless check of the workbench shell (ribbon + docks + attribute table + palette).
//   PW=/path/to/node_modules/playwright node scripts/test-web-workbench.mjs [base] [out-dir]
// Verifies the desktop-GIS structure is really on screen and that no console error
// fires while using it: ribbon tabs, dock tabs, splitters, attribute table rows,
// command palette, catalog tree, history rows and the status bar.
import { runCmd, commandIds, openPluginTool } from './lib/ui.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const problems = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

await page.goto(`${base}/?fresh`);
await page.waitForFunction(() => window.map && (typeof window.map?.loaded === 'function' && window.map.loaded()) && window.map.areTilesLoaded(), null, { timeout: 120_000, polling: 500 });
await page.waitForTimeout(1200);

console.log('\n1 · shell');
ok('ribbon tabs', (await page.$$('#ribbon-tabs .rb-tab')).length >= 8, `${(await page.$$('#ribbon-tabs .rb-tab')).length} tabs`);
ok('ribbon buttons', (await page.$$('#ribbon-body .rb-btn')).length >= 8, `${(await page.$$('#ribbon-body .rb-btn')).length} buttons`);
ok('three docks', (await page.$$('.dock')).length === 3);
ok('three splitters', (await page.$$('.splitter')).length === 3);
ok('status bar', (await page.textContent('#sb-scale')).includes('1:'), await page.textContent('#sb-scale'));
ok('map is the largest pane', await page.evaluate(() => {
  const m = document.querySelector('#map').getBoundingClientRect();
  return m.width > 700 && m.height > 400;
}));
await page.screenshot({ path: `${out}/workbench-01-home.png` });

console.log('\n2 · ribbon tabs');
for (const [tab, min] of [['analyze', 4], ['view', 5], ['edit', 8], ['imagery', 4], ['share', 3], ['help', 4]]) {
  await page.click(`#ribbon-tabs [data-tab="${tab}"]`);
  await page.waitForTimeout(250);
  const n = (await page.$$('#ribbon-body .rb-btn')).length;
  ok(`tab ${tab} renders`, n >= min, `${n} buttons`);
}
await page.click('#ribbon-tabs [data-tab="analyze"]');
await page.waitForTimeout(400);
const behindButton = Number((await page.textContent('#ribbon-body .rb-combo-count')) ?? 0);
ok('analyze carries the recipes behind one dropdown', behindButton > 5, `${behindButton} recipes, one button`);
await page.screenshot({ path: `${out}/workbench-02-analyze.png` });

console.log('\n3 · dock tabs');
for (const [dock, tab] of [['left', 'catalog'], ['right', 'toolbox'], ['right', 'layer'], ['bottom', 'attributes'], ['bottom', 'history'], ['bottom', 'log']]) {
  await page.click(`#dock-${dock} .dock-tabs [data-tab="${tab}"]`);
  await page.waitForTimeout(300);
  const visible = await page.$eval(`#dock-${dock} .dock-body section[data-tab="${tab}"]`, (el) => el.classList.contains('on'));
  ok(`${dock} › ${tab} activates`, visible);
}
ok('catalog lists layers', (await page.$$('#catalog .node.layer')).length >= 3, `${(await page.$$('#catalog .node.layer')).length} nodes`);
await page.screenshot({ path: `${out}/workbench-03-catalog.png` });

console.log('\n4 · attribute table');
await page.click('#dock-left .dock-tabs [data-tab="catalog"]');
await page.click('#catalog .node.layer');
await page.waitForSelector('#attributes table.attr tbody tr', { timeout: 30_000 });
const rows = (await page.$$('#attributes table.attr tbody tr')).length;
const head = await page.$eval('#attributes .pane-head', (el) => el.textContent.trim().replace(/\s+/g, ' '));
ok('rows rendered', rows > 5, `${rows} rows · ${head}`);
await page.click('#attributes [data-view="fields"]');
await page.waitForTimeout(200);
ok('fields view', (await page.$$('#attributes table.fields tbody tr')).length > 0);
await page.click('#attributes [data-view="chart"]');
await page.waitForTimeout(300);
ok('chart view (ggplot2-style chart)', (await page.$$('#attributes .chart-box svg rect')).length > 0);
await page.click('#attributes [data-view="table"]');
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/workbench-04-attributes.png` });

console.log('\n5 · command palette');
await page.keyboard.press('Control+k');
await page.waitForSelector('#palette:not([hidden])');
await page.fill('#palette-input', 'hot spot');
await page.waitForTimeout(300);
const pal = await page.$$eval('.pal-row .pl', (els) => els.slice(0, 3).map((e) => e.textContent));
ok('palette filters', pal.length > 0 && /hot spot/i.test(pal[0]), pal.join(' | '));
await page.screenshot({ path: `${out}/workbench-05-palette.png` });
await page.keyboard.press('Escape');

console.log('\n6 · splitters and collapse');
const before = await page.$eval('#dock-left', (el) => el.getBoundingClientRect().width);
await page.hover('#splitter-left');
await page.mouse.down();
await page.mouse.move(before + 120, 500, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
const after = await page.$eval('#dock-left', (el) => el.getBoundingClientRect().width);
ok('left pane resizes', Math.abs(after - before) > 60, `${Math.round(before)} → ${Math.round(after)} px`);
await page.dblclick('#splitter-left');
await page.waitForTimeout(200);
ok('double-click resets', Math.abs((await page.$eval('#dock-left', (el) => el.getBoundingClientRect().width)) - 300) < 3);
await page.dblclick('#dock-right .dock-tabs');
await page.waitForTimeout(200);
ok('pane collapses', await page.$eval('#dock-right', (el) => el.classList.contains('collapsed')));
ok('collapsed pane keeps its tabs', await page.$eval('#dock-right .dock-tabs', (el) => el.getBoundingClientRect().height > 40));
await page.dblclick('#dock-right .dock-tabs');
await page.waitForTimeout(200);
ok('pane reopens', !(await page.$eval('#dock-right', (el) => el.classList.contains('collapsed'))));

console.log('\n7 · layout survives a reload');
await page.click('#dock-bottom .dock-tabs [data-tab="attributes"]');
await page.reload();
await page.waitForFunction(() => window.map && (typeof window.map?.loaded === 'function' && window.map.loaded()), null, { timeout: 120_000, polling: 500 });
await page.waitForTimeout(1200);
ok('attributes tab restored', await page.$eval('#attributes', (el) => el.closest('section').classList.contains('on')));
await page.screenshot({ path: `${out}/workbench-06-final.png` });

console.log('\n8 · plugins pane (docs/PLUGINS.md)');
await runCmd(page, 'plugins.manage');
await page.waitForSelector('#plugins .plugin', { timeout: 15_000 });
const cards = await page.$$eval('#plugins .plugin .p-name', (els) => els.map((e) => e.textContent.trim()));
ok('plugins listed', cards.length >= 2, cards.join(' · '));
ok('tools listed', (await page.$$('#plugins .tool-row button')).length >= 2, `${(await page.$$('#plugins .tool-row button')).length} tools`);
ok('source badges shown', (await page.$$('#plugins .badge')).length >= 2);
// an added plugin's tool that runs as it opens (the default domain plugins: test-domain-plugins.py)
// the default domain plugins are installed by the packages; a dev server with --plugins lists them as extras
const defaults = ((await (await fetch(`${base}/api/plugins`)).json()).plugins ?? []).filter((p) => p.default).length;
ok('the default plugins listed first (when installed)', defaults === 0 || (defaults >= 12 && cards[0] === 'Agriculture'), `${defaults} default · ${cards.slice(0, 3).join(' · ')}`);
const firstRun = await page.$('#plugins .plugin:not(:has(.p-keep:text-is("default plugin"))) .tool-row button:not([disabled])');
if (firstRun) {
  await firstRun.click();
  await page.waitForSelector('#plugin-modal:not([hidden])', { timeout: 10_000 });
  ok('tool dialog opens', true, await page.$eval('#plugin-modal header b', (e) => e.textContent.trim()));
  await page.click('#plugin-modal [data-run-tool]');
  await page
    .waitForFunction(
      () => {
        const t = (document.querySelector('#plugin-msg')?.textContent ?? '').trim();
        return t.length > 0 && t !== 'Running…';
      },
      null,
      { timeout: 60_000, polling: 300 },
    )
    .catch(() => {});
  const msg = await page.$eval('#plugin-msg', (e) => e.textContent.trim());
  ok('tool ran from the UI', /report for|Recipe started|ok/.test(msg), msg.slice(0, 70));
  await page.screenshot({ path: `${out}/workbench-07-plugin-tool.png` });
  await page.keyboard.press('Escape');
} else {
  ok('a runnable tool is enabled', false, 'none enabled');
}
await page.screenshot({ path: `${out}/workbench-08-plugins.png` });
await page.click('#plugin-manager [data-close]');

console.log('\n9 · Analyze: recipes collapse into a dropdown instead of eating the ribbon');
await page.click('#ribbon-tabs [data-tab="analyze"]');
await page.waitForSelector('#ribbon-body [data-group="recipes"] .rb-combo', { timeout: 15_000 });
const cardEls = await page.$$('#ribbon-body .rb-recipe');
ok('no big recipe cards in the ribbon', cardEls.length === 0, `${cardEls.length} cards`);
const groupW = await page.$eval('#ribbon-body [data-group="recipes"]', (e) => Math.round(e.getBoundingClientRect().width));
ok('the recipe group is one button wide', groupW <= 220, `${groupW}px`);
const combo = await page.textContent('#ribbon-body .rb-combo');
ok('the button says what it is and how many', /Recipes/.test(combo) && /\d/.test(combo), combo.replace(/\s+/g, ' ').trim());

await page.click('#ribbon-body .rb-combo');
await page.waitForSelector('.rb-menu', { timeout: 5000 });
const menuRows = await page.$$eval('.rb-menu .rb-menu-row', (els) => els.map((e) => ({
  name: e.querySelector('.rm-name')?.textContent?.trim(),
  desc: e.querySelector('.rm-desc')?.textContent?.trim() ?? '',
  icon: e.querySelector('.rm-ico path')?.getAttribute('d') ?? '',
})));
ok('the dropdown lists every recipe', menuRows.length >= 10, `${menuRows.length} rows`);
ok('rows carry an icon and a description',
  menuRows.filter((r) => r.desc.length > 20).length >= 6 && new Set(menuRows.map((r) => r.icon)).size >= 4,
  `${new Set(menuRows.map((r) => r.icon)).size} distinct icons, ${menuRows.filter((r) => r.desc.length > 20).length} described`);
const menuBox = await page.$eval('.rb-menu', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) }; });
ok('the list opens under the button, inside the window', menuBox.left >= 4 && menuBox.w >= 240 && menuBox.h > 100, JSON.stringify(menuBox));
await page.screenshot({ path: `${out}/workbench-09-recipes-dropdown.png` });

// clicking a row runs that recipe
await page.locator('.rb-menu .rb-menu-row').first().click();
await page.waitForFunction(() => !document.querySelector('.rb-menu'), null, { timeout: 5000 });
ok('picking a row closes the list and starts the recipe',
  /Running/.test(await page.textContent('#statusbar')) , (await page.textContent('#statusbar')).slice(0, 60));
await page.waitForTimeout(1500);

// Escape closes it too
await page.click('#ribbon-body .rb-combo');
await page.waitForSelector('.rb-menu');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.rb-menu'), null, { timeout: 3000 });
ok('Escape closes the list', true);

// the gallery is still there for people who want it
await page.click('#ribbon-body [data-gallery="expand"]');
await page.waitForSelector('#ribbon-body .rb-recipe', { timeout: 10_000 });
const paths = await page.$$eval('#ribbon-body .rb-recipe .rr-ico path', (els) => els.map((e) => e.getAttribute('d')));
ok('expanding brings the gallery back', paths.length >= 8, `${paths.length} cards`);
ok('icons differ per recipe', new Set(paths).size >= 4, `${new Set(paths).size} distinct icons of ${paths.length}`);
const play = paths.filter((d) => d.startsWith('M7 4l13 8-13 8z')).length;
ok('the fallback play icon is the exception, not the rule', play <= paths.length / 3, `${play} of ${paths.length} cards`);
await page.screenshot({ path: `${out}/workbench-10-analyze-gallery.png` });
await page.click('#ribbon-body [data-gallery="collapse"]');
await page.waitForSelector('#ribbon-body .rb-combo', { timeout: 5000 });
ok('collapsing again is one click', true);

console.log('\n10 · a plugin with more than three tools collapses too (and can be uninstalled)');
// The fixture lives outside the repo: build it, install it through the API, then take it away again.
const fixture = path.join(os.tmpdir(), 'geospax-webtest-many-tools');
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(
  path.join(fixture, 'plugin.yaml'),
  ['plugin: many-tools', 'title: Many tools', 'version: 0.1.0', 'description: Five tools, none of which take parameters',
   'kind: python', 'run: python3 ${plugin}/tools.py ${tool}', 'tools:',
   '  - { id: one, name: Tool one, summary: First of five, icon: grid }',
   '  - { id: two, name: Tool two, summary: Second of five, icon: grid }',
   '  - { id: three, name: Tool three, summary: Third of five, icon: chart }',
   '  - { id: four, name: Tool four, summary: Fourth of five, icon: chart }',
   '  - { id: five, name: Tool five, summary: Fifth of five, icon: terminal }'].join('\n'),
);
fs.writeFileSync(path.join(fixture, 'tools.py'), 'import json, sys\nreq = json.load(sys.stdin)\nprint(json.dumps({"ok": True, "message": req.get("tool", "?") + " ran"}))\n');

const api = async (method, url, body) => {
  const r = await fetch(`${base}/${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const installed = await api('POST', 'api/plugins/import', { path: fixture });
ok('the engine installs a plugin from a folder', installed.status === 200, installed.json?.plugin?.name ?? installed.status);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.map && (typeof window.map?.loaded === 'function' && window.map.loaded()), null, { timeout: 120_000, polling: 500 });
const toolRows = await page.evaluate(() => window.toolbox.tools?.filter((t) => t.key.startsWith('p:many-tools/')).map((t) => t.key.slice('p:many-tools/'.length)) ?? []);
ok('the Toolbox lists the plugin\'s tools', toolRows.length === 5, `${toolRows.length}: ${toolRows.slice(0, 3).join(', ')}…`);
await openPluginTool(page, 'many-tools', toolRows[0]);
await page.waitForSelector('#plugin-modal:not([hidden])', { timeout: 8000 });
ok('picking a tool opens its dialog', /Run/.test(await page.textContent('#plugin-modal')));
// a tool with no declared parameters used to crash openTool()
ok('a tool with no parameters renders an empty form', /no parameters/.test(await page.textContent('#plugin-modal')));
await page.click('#plugin-modal [data-run-tool]');
await page.waitForFunction(() => {
  const el = document.querySelector('#plugin-modal #plugin-msg');
  return el && el.textContent.trim() && el.textContent.trim() !== 'Running…';
}, null, { timeout: 60_000 }).catch(() => {});
const msg = (await page.textContent('#plugin-modal #plugin-msg')) ?? '';
ok('and it still runs', msg.trim().length > 0 && msg.trim() !== 'Running…', msg.slice(0, 60));
await page.keyboard.press('Escape');
await page.screenshot({ path: `${out}/workbench-11-plugin-dropdown.png` });

// uninstall, from the pane (two-step) and from the API
await runCmd(page, 'plugins.manage');
await page.waitForSelector('.plugin .p-del');
const del = page.locator('.plugin', { hasText: 'Many tools' }).locator('.p-del');
await del.click();
ok('uninstall asks twice before deleting', /again/.test(await del.textContent()));
await del.click();
await page.waitForFunction(
  () => ![...document.querySelectorAll('.plugin .p-name')].some((e) => (e.textContent ?? '').includes('Many tools')),
  null,
  { timeout: 10_000 },
);
ok('the pane removes it after the second click', true);
const gone = await api('GET', 'api/plugins');
const leftIds = (gone.json.plugins ?? []).map((p) => p.id);
ok('and it is really gone from the engine', !leftIds.includes('many-tools'), `left: ${leftIds.join(', ')}`);
const refused = await api('DELETE', 'api/plugins/example-python');
ok('a plugin in a --plugins folder cannot be deleted from here', refused.status >= 400, `${refused.status} ${refused.json?.error ?? ''}`.slice(0, 70));
fs.rmSync(fixture, { recursive: true, force: true });
await page.click('#plugin-manager [data-close]');

console.log('\n11 · the ribbon gets out of the way when you do not need it');
const mapH = () => page.$eval('#map', (e) => Math.round(e.getBoundingClientRect().height));
const bodyHidden = () => page.$eval('#ribbon-body', (e) => e.hidden);
const mapBefore = await mapH();
await page.click('#ribbon-tabs [data-ribbon-pin]');
await page.waitForFunction(() => document.querySelector('#ribbon-body')?.hidden === true, null, { timeout: 5000 });
const mapAfter = await mapH();
ok('auto-hide hands the ribbon height to the map', mapAfter - mapBefore >= 60, `${mapBefore}px → ${mapAfter}px of map`);
ok('the tabs stay put', (await page.$$('#ribbon-tabs [data-tab]')).length >= 7);
await page.screenshot({ path: `${out}/workbench-12-ribbon-autohide.png` });

await page.click('#ribbon-tabs [data-tab="analyze"]');
await page.waitForFunction(() => document.querySelector('#ribbon-body')?.hidden === false, null, { timeout: 5000 });
ok('clicking a tab opens it again', await page.isVisible('#ribbon-body'));
await page.click('#ribbon-tabs [data-tab="analyze"]');
await page.waitForFunction(() => document.querySelector('#ribbon-body')?.hidden === true, null, { timeout: 5000 });
ok('clicking the same tab puts it back', !(await page.isVisible('#ribbon-body')));

await page.click('#ribbon-tabs [data-tab="analyze"]');
await page.waitForSelector('#ribbon-body .rb-combo');
await page.click('#ribbon-body .rb-combo');
await page.waitForSelector('.rb-menu');
await page.locator('.rb-menu .rb-menu-row').first().click();
await page.waitForFunction(() => document.querySelector('#ribbon-body')?.hidden === true, null, { timeout: 10_000 });
ok('it closes itself once you have run something', true);

await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.map && (typeof window.map?.loaded === 'function' && window.map.loaded()), null, { timeout: 120_000, polling: 500 });
ok('the choice survives a reload', await bodyHidden());
await page.click('#ribbon-tabs [data-ribbon-pin]');
await page.waitForFunction(() => document.querySelector('#ribbon-body')?.hidden === false, null, { timeout: 5000 });
ok('pinning brings it back for good', !(await bodyHidden()));

console.log(`\nconsole problems: ${problems.length}`);
for (const p of problems.slice(0, 10)) console.log(`  ${p}`);
ok('no console errors', problems.length === 0, problems.slice(0, 2).join(' / '));

await browser.close();
console.log(`\n${pass}/${pass + fails.length} checks passed`);
if (fails.length) { console.log(`failed: ${fails.join(', ')}`); process.exit(1); }
