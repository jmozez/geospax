// The four things the ribbon must get right, checked in headless Chromium against a real server:
//   1. View › Swipe: the divider drags and the map either side of it differs
//   2. View › Spyglass: the lens follows the pointer and shows the map without the layer
//   3. Home › Project: New (name dialog with checks), Save, Save as, Rename, Open; the name in the
//      title bar and the status bar
//   4. Pressed state: tools stay pressed until clicked again, one map tool at a time, Esc ends it,
//      commands never stay pressed; split buttons open their menu from the keyboard
//
//   node scripts/test-ribbon-critical.mjs <base-url> <out-dir>
// The project steps write to the server's state folder: use a server with its own --state-dir.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const base = (process.argv[2] || 'http://127.0.0.1:18122').replace(/\/$/, '');
const out = process.argv[3] || '/tmp/ribbon-critical';
fs.mkdirSync(out, { recursive: true });

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
// the full ribbon (Pro mode) also after New and Open reload the page without ?fresh
await page.addInitScript(() => { try { localStorage.setItem('geospax.mode', 'pro'); } catch { /* ignore */ } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ready = async () => {
  await page.waitForFunction(() => window.map && window.workbench && window.map.loaded(), null, { timeout: 120000 });
  await page.waitForTimeout(1200);
};
await page.goto(`${base}/?fresh`);
await ready();
// start from no saved projects and an untitled open project
await page.evaluate(async () => {
  const l = await fetch('api/projects').then((r) => r.json());
  for (const p of l.projects) await fetch(`api/projects/${p.id}`, { method: 'DELETE' });
  const cur = await fetch('api/project').then((r) => r.json());
  if (cur.name || cur.slug) {
    delete cur.name; delete cur.slug; cur.removed = [];
    await fetch('api/project', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cur) });
  }
});
await page.reload();
await ready();

const tab = async (t) => { await page.click(`#ribbon-tabs [data-tab="${t}"]`); await page.waitForTimeout(250); };
const cmd = async (id) => {
  const el = await page.$(`#ribbon-body [data-cmd="${id}"]`);
  if (el && await el.isVisible()) await el.click();
  else await page.evaluate((id) => window.workbench.command(id), id);
  await page.waitForTimeout(500);
};
const pressed = (id) => page.evaluate((id) => [...document.querySelectorAll(`#ribbon-body [data-cmd="${id}"]`)]
  .some((b) => b.getAttribute('aria-pressed') === 'true' && b.classList.contains('on')), id);
const pressedTools = () => page.evaluate(() => [...document.querySelectorAll('#ribbon-body [aria-pressed=true][data-maptool]')].map((b) => b.dataset.cmd));
const mapBox = () => page.evaluate(() => { const r = window.map.getContainer().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const shot = async (name, clip) => page.screenshot({ path: path.join(out, name), ...(clip ? { clip } : {}) });
const mapShot = async () => { const b = await mapBox(); return page.screenshot({ clip: { x: b.x, y: b.y, width: b.w, height: b.h } }); };

// a layer on the map, selected and in view
await page.evaluate(() => {
  const row = document.querySelector('#contents [data-id="reserves.geojson"]');
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await tab('home');
await cmd('home.zoomLayer');
await page.waitForTimeout(1500);
const box = await mapBox();

// ------------------------------------------------------------------ 1. swipe
await tab('view');
await cmd('view.swipe');
check(await pressed('view.swipe'), 'Swipe stays pressed while on');
const ov = await page.evaluate(() => { const e = document.querySelector('.gx-compare'); const r = e?.getBoundingClientRect(); return r ? { w: r.width, h: r.height } : null; });
check(!!ov && ov.h > 100 && ov.w > 100, `swipe overlay covers the map (${ov ? `${Math.round(ov.w)}x${Math.round(ov.h)}` : 'none'})`);
const bar = await page.$('.gx-swipe-bar');
check(!!bar, 'swipe divider shown');
const bb = await bar.boundingBox();
const y = box.y + box.h / 2;
// drag the divider to the far right: the whole map shows the layer; to the far left: none of it
await page.mouse.move(bb.x + bb.width / 2, y);
await page.mouse.down();
await page.mouse.move(box.x + box.w * 0.25, y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const left1 = await page.evaluate(() => parseFloat(document.querySelector('.gx-swipe-bar').style.left));
check(Math.abs(left1 - box.w * 0.25) < 6, `drag moves the divider (to ${Math.round(left1)} px, wanted ${Math.round(box.w * 0.25)})`);
const clip1 = await page.evaluate(() => document.querySelector('.gx-compare').style.clipPath);
check(clip1.includes(`${Math.round(left1)}`) || clip1.includes(String(left1)), `overlay clip follows the divider (${clip1})`);
await shot('swipe-drag.png');
const drag = async (to) => {
  const b2 = await (await page.$('.gx-swipe-bar')).boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, y); await page.mouse.down();
  await page.mouse.move(to, y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
};
await drag(box.x + box.w - 1);
const withLayer = await mapShot();
await drag(box.x + 1);
const without = await mapShot();
check(!withLayer.equals(without), 'the map differs either side of the divider (layer shown on one side only)');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(!(await pressed('view.swipe')) && !(await page.$('.gx-compare')), 'Esc ends Swipe and releases the button');

// ------------------------------------------------------------------ 2. spyglass
await page.mouse.move(box.x + 30, box.y + 30);
await cmd('view.spyglass');
check(await pressed('view.spyglass'), 'Spyglass stays pressed while on');
const plain = await mapShot();
await page.mouse.move(box.x + box.w / 2 - 40, box.y + box.h / 2 + 20, { steps: 5 });
await page.waitForTimeout(400);
const lens = await page.evaluate(() => { const e = document.querySelector('.gx-lens'); const r = e?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width } : null; });
check(!!lens && lens.w > 50, `lens shown (${lens ? Math.round(lens.w) : 0} px)`);
check(!!lens && Math.abs(lens.x - (box.x + box.w / 2 - 40)) < 4 && Math.abs(lens.y - (box.y + box.h / 2 + 20)) < 4, 'lens follows the pointer');
const looked = await mapShot();
check(!plain.equals(looked), 'the lens changes what the map shows under it');
await shot('spyglass.png');
// exclusive: Swipe while Spyglass is on swaps tools
await cmd('view.swipe');
const pt = await pressedTools();
check(pt.length === 1 && pt[0] === 'view.swipe', `one map tool at a time (pressed: ${pt.join(', ') || 'none'})`);
await cmd('view.swipe');
check(!(await pressed('view.swipe')) && (await pressedTools()).length === 0, 'clicking Swipe again releases it');

// ------------------------------------------------------------------ 4. pressed state across tabs
await tab('home');
await cmd('measure.distance');
check(await pressed('measure.distance') || await page.evaluate(() => document.body.dataset.mapTool === 'measure:distance'), 'Measure distance stays pressed');
await page.waitForTimeout(1200);
check(await page.evaluate(() => document.body.dataset.mapTool === 'measure:distance'), 'still on after 1.2 s');
await cmd('home.identify');
const pt2 = await pressedTools();
check(pt2.length === 1 && pt2[0] === 'home.identify', `Identify takes over from Measure (pressed: ${pt2.join(', ')})`);
await shot('highlight.png', { x: 0, y: 0, width: 1600, height: 170 });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check((await pressedTools()).length === 0, 'Esc deselects the tool');
await cmd('view.zoomIn');
check(!(await page.evaluate(() => [...document.querySelectorAll('#ribbon-body [data-cmd="view.zoomIn"]')].some((b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('on')))), 'commands (Zoom in) never stay pressed');
await tab('view');
await cmd('view.grid');
check(await pressed('view.grid'), 'Grid toggle stays pressed');
await cmd('view.grid');
check(!(await pressed('view.grid')), 'Grid toggle released on the second click');

// split buttons: the menu opens from the arrow and from the keyboard, stays in the window
await tab('share');
const arrow = await page.$('#ribbon-body [data-split-arrow="share-map"]');
check(!!arrow, 'Share › Export map is a split button');
if (arrow) {
  await arrow.click();
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    const el = document.querySelector('.rb-menu'); const r = el?.getBoundingClientRect();
    return el ? { n: el.querySelectorAll('[data-cmd]').length, inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, focus: document.activeElement?.dataset?.cmd ?? '' } : null;
  });
  check(!!m && m.n === 4 && m.inside, `Export map menu: ${m?.n} entries, inside the window`);
  await shot('share-export-map-menu.png', { x: 0, y: 0, width: 1600, height: 420 });
  await page.keyboard.press('ArrowDown');
  const f2 = await page.evaluate(() => document.activeElement?.dataset?.cmd ?? '');
  check(!!f2 && f2 !== m?.focus, `ArrowDown moves through the menu (${m?.focus} → ${f2})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => !document.querySelector('.rb-menu') && document.activeElement?.dataset?.splitArrow === 'share-map');
  check(closed, 'Esc closes the menu and focus goes back to the arrow');
  await page.focus('#ribbon-body [data-split="share-data"]');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const dm = await page.evaluate(() => [...document.querySelectorAll('.rb-menu [data-cmd]')].map((b) => b.dataset.cmd));
  check(dm.join() === 'share.data.geojson,share.data.shp,share.data.csv,share.data.gpkg,share.data.kml,share.data.parquet', `Export data menu by ArrowDown, most used first (${dm.join(', ')})`);
  await shot('share-export-data-menu.png', { x: 0, y: 0, width: 1600, height: 420 });
  await page.keyboard.press('Escape');
}

// ------------------------------------------------------------------ 3. projects
const title = () => page.title();
const sb = () => page.evaluate(() => document.querySelector('#sb-project')?.textContent ?? '');
check((await title()).endsWith('· GeoSpaX'), `title shows the project (${await title()})`);
await tab('home');
await cmd('home.new');
const input = await page.waitForSelector('.gx-dialog input[name=name]', { timeout: 5000 }).catch(() => null);
check(!!input, 'New project asks for a name');
if (input) {
  await input.fill('');
  const okDisabled = () => page.evaluate(() => document.querySelector('.gx-dialog [data-btn=ok]')?.disabled);
  check(await okDisabled(), 'Create is off while the name is empty');
  await input.fill('Lae/roads');
  const msg = await page.evaluate(() => document.querySelector('.gx-dialog [data-msg]')?.textContent ?? '');
  check(await okDisabled() && /cannot contain/.test(msg), `bad characters refused (${msg})`);
  await shot('new-project-invalid.png');
  await input.fill('Lae roads 2026');
  check(!(await okDisabled()), 'a good name turns Create on');
  await shot('new-project-dialog.png');
  await page.click('.gx-dialog [data-btn=ok]');
  await page.waitForEvent('load', { timeout: 15000 }).catch(() => {});
  await ready();
  check((await title()) === 'Lae roads 2026 · GeoSpaX', `title bar after New (${await title()})`);
  check((await sb()) === 'Lae roads 2026', `status bar after New (${await sb()})`);
  check(await page.evaluate(() => document.querySelectorAll('#contents .layer').length) === 0, 'a new project starts with an empty map');
  await shot('new-project-named.png');
  // add a layer back, then Save
  await page.evaluate(() => window.workbench.command('home.addData')).catch(() => {});
  await page.keyboard.press('Escape');
  await tab('home');
  await cmd('home.save');
  const st = await page.evaluate(() => document.querySelector('#sb-msg')?.textContent ?? '');
  check(/Project saved: Lae roads 2026/.test(st), `Save (${st})`);
  // Save as
  await page.keyboard.press('Control+Shift+S');
  const in2 = await page.waitForSelector('.gx-dialog input[name=name]', { timeout: 5000 }).catch(() => null);
  check(!!in2, 'Ctrl+Shift+S opens Save as');
  if (in2) {
    await in2.fill('Lae roads 2026');
    const dup = await page.evaluate(() => document.querySelector('.gx-dialog [data-msg]')?.textContent ?? '');
    check(/already a project/.test(dup), `duplicate names refused (${dup})`);
    await in2.fill('Lae roads copy');
    await page.click('.gx-dialog [data-btn=ok]');
    await page.waitForTimeout(800);
    check((await title()) === 'Lae roads copy · GeoSpaX' && (await sb()) === 'Lae roads copy', `Save as renames the open project (${await title()})`);
  }
  // Rename
  await cmd('home.rename');
  const in3 = await page.waitForSelector('.gx-dialog input[name=name]', { timeout: 5000 }).catch(() => null);
  if (in3) {
    await in3.fill('Lae roads final');
    await page.click('.gx-dialog [data-btn=ok]');
    await page.waitForTimeout(800);
  }
  const listed = await page.evaluate(() => fetch('api/projects').then((r) => r.json()));
  const ids = listed.projects.map((p) => p.id).sort();
  check((await title()) === 'Lae roads final · GeoSpaX' && ids.includes('lae-roads-final') && !ids.includes('lae-roads-copy'), `Rename (${ids.join(', ')})`);
  // Open the first one again
  await cmd('home.open');
  const radio = await page.waitForSelector('.gx-dialog input[type=radio][value="lae-roads-2026"]', { timeout: 5000 }).catch(() => null);
  check(!!radio, 'Open lists the saved projects');
  await shot('open-project-dialog.png');
  if (radio) {
    await radio.check();
    await page.click('.gx-dialog [data-btn=ok]');
    await page.waitForEvent('load', { timeout: 15000 }).catch(() => {});
    await ready();
    check((await title()) === 'Lae roads 2026 · GeoSpaX' && (await sb()) === 'Lae roads 2026', `Open (${await title()})`);
  }
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(`\n${fails.length ? `${fails.length} check(s) failed` : 'all critical ribbon checks passed'}`);
process.exit(fails.length ? 1 : 0);
