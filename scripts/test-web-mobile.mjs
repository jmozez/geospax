// The web app on phones and tablets (Playwright device emulation: touch, screen size, pixel ratio).
//
//   node scripts/test-web-mobile.mjs [base-url] [out-dir]
//
// Phone (Pixel 7, iPhone 13): nothing wider than the screen; a compact one-row header; the ribbon's tools
// closed until a tab is tapped, then over the map (the map keeps its size) and closed again after a
// command; a one-line status bar; a bottom bar with 44 px targets that opens Layers, Tools and Activity.
// Tablet (iPad portrait and landscape): no overflow, the panes over the map in portrait.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium, devices } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');

const base = (process.argv[2] ?? 'http://127.0.0.1:18120').replace(/\/$/, '');
const out = process.argv[3] ?? 'mobile-shots';
mkdirSync(out, { recursive: true });
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function open(dev) {
  const ctx = await browser.newContext({ ...dev });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/?fresh`);
  await page.waitForFunction(() => window.map && window.map.loaded(), null, { timeout: 120_000 });
  await page.waitForTimeout(1200);
  // a first-start tour or welcome card would cover the screen: close it as a user would
  for (const sel of ['[data-tour-skip]', '.tour [data-skip]', '.tut-card [data-x]', '#start [data-close]']) {
    const b = await page.$(sel);
    if (b && (await b.isVisible())) await b.click().catch(() => {});
  }
  return { ctx, page, errs };
}
const box = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, shown: getComputedStyle(e).display !== 'none' && r.width > 0 }; }, sel);
const overflow = (page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);

for (const [name, dev] of [['phone-pixel7', devices['Pixel 7']], ['phone-iphone13', devices['iPhone 13']]]) {
  console.log(`\n${name}`);
  const { ctx, page, errs } = await open(dev);
  ok('nothing wider than the screen', (await overflow(page)) <= 1, `${await overflow(page)} px`);
  const head = await box(page, '#titlebar');
  ok('header is one compact row', head && head.h <= 52, `${head?.h} px`);
  const map0 = await box(page, '#map');
  ok('ribbon tools closed at start', !(await box(page, '#ribbon-body'))?.shown);
  ok('map fills most of the screen', map0.h > 0.6 * dev.viewport.height, `${Math.round(map0.h)} of ${dev.viewport.height} px`);
  const status = await box(page, '#statusbar');
  ok('status bar is one line', status && status.h <= 30, `${status?.h} px`);
  const bar = await page.$$eval('.mobile-bar button', (bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return { h: r.height, w: r.width, t: b.textContent.trim() }; }));
  ok('bottom bar: Layers, Tools, Activity, 44 px targets', bar.length === 3 && bar.every((b) => b.h >= 44), bar.map((b) => `${b.t} ${Math.round(b.h)}px`).join(', '));
  await page.screenshot({ path: `${out}/${name}-map.png` });

  await page.click('#ribbon-tabs [data-tab="analyze"]');
  await page.waitForTimeout(600);
  const body = await box(page, '#ribbon-body');
  const map1 = await box(page, '#map');
  ok('a tab tap opens its tools', body?.shown);
  ok('the tools open over the map (map keeps its size)', Math.abs(map1.h - map0.h) < 5 && Math.abs(map1.y - map0.y) < 5, `map ${Math.round(map0.h)} → ${Math.round(map1.h)} px`);
  ok('tools sheet no taller than half the screen', body && body.h <= 0.5 * dev.viewport.height, `${Math.round(body?.h)} px`);
  ok('still nothing wider than the screen', (await overflow(page)) <= 1);
  await page.screenshot({ path: `${out}/${name}-ribbon.png` });
  await page.evaluate(() => window.workbench.command('view.grid'));
  await page.waitForTimeout(500);
  ok('the tools close after a command', !(await box(page, '#ribbon-body'))?.shown);

  await page.click('.mobile-bar [data-m="left"]');
  await page.waitForTimeout(500);
  const left = await box(page, '#dock-left');
  ok('Layers opens the full-width pane', left?.shown && left.w >= dev.viewport.width - 2, `${Math.round(left?.w)} px`);
  await page.screenshot({ path: `${out}/${name}-layers.png` });
  await page.click('.mobile-bar [data-m="left"]');
  await page.waitForTimeout(300);
  await page.click('.mobile-bar [data-m="right"]');
  await page.waitForTimeout(500);
  ok('Tools opens the right pane', (await box(page, '#dock-right'))?.shown);
  await page.screenshot({ path: `${out}/${name}-tools.png` });
  await page.click('.mobile-bar [data-m="right"]');
  await page.evaluate(() => window.workbench.command('help.tutorials'));
  await page.waitForTimeout(400);
  const dlg = await box(page, '.gx-dialog .sheet');
  ok('dialogs fit the screen width', dlg && dlg.x >= 0 && dlg.x + dlg.w <= dev.viewport.width + 1, `${Math.round(dlg?.w)} px`);
  await page.keyboard.press('Escape');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

for (const [name, dev] of [['tablet-portrait', devices['iPad (gen 7)']], ['tablet-landscape', devices['iPad (gen 7) landscape']]]) {
  console.log(`\n${name}`);
  const { ctx, page, errs } = await open(dev);
  ok('nothing wider than the screen', (await overflow(page)) <= 1, `${await overflow(page)} px`);
  ok('ribbon tools shown (pinned) on a tablet', (await box(page, '#ribbon-body'))?.shown);
  const map = await box(page, '#map');
  ok('map is large', map.w * map.h > 0.3 * dev.viewport.width * dev.viewport.height, `${Math.round(map.w)}×${Math.round(map.h)}`);
  await page.screenshot({ path: `${out}/${name}.png` });
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
