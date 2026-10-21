// Map series (atlas) from Finish my map, and keyboard navigation of the Pro layer tree.
//   PW=/path/to/node_modules/playwright node scripts/test-web-series.mjs [base]
// Needs a server with at least one visible layer.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?mode=pro`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// ---- keyboard tree
const first = page.locator('.pr-tree [role=treeitem][tabindex="0"]');
ok('the tree has exactly one tab stop', (await first.count()) === 1);
await first.focus();
const key = () => page.evaluate(() => document.activeElement?.getAttribute('data-id') ?? document.activeElement?.className);
const k0 = await key();
await page.keyboard.press('ArrowDown');
const k1 = await key();
ok('↓ moves to the next row', k1 !== k0, `${k0} → ${k1}`);
await page.keyboard.press('ArrowUp');
ok('↑ moves back', (await key()) === k0);
await page.keyboard.press('End');
await page.keyboard.press('Home');
await page.keyboard.press('ArrowDown');
const id = await key();
const vis = () => page.locator(`.layer.pro[data-id="${id}"] input[type=checkbox]`).isChecked();
const v0 = await vis();
await page.keyboard.press(' ');
await page.waitForTimeout(300);
ok('Space shows/hides the layer and keeps focus', (await vis()) !== v0 && (await key()) === id);
await page.keyboard.press(' ');
await page.waitForTimeout(300);

// ---- map series: a 2 × 2 grid
const before = (await (await page.request.get(`${base}/api/runs`)).json()).runs.length;
await page.click('#ribbon-tabs .rb-tab[data-tab="home"]');
await page.locator('#ribbon-body [data-cmd="home.finish"]').first().click();
await page.waitForTimeout(400);
ok('Finish my map offers a map series', await page.locator('.fin-series').isVisible());
await page.check('input[name=pages][value=grid]');
await page.selectOption('select[name=grid]', '2x1');
await page.fill('input[name=title]', 'Series test');
await page.click('#finish button[type=submit]');
let run = null;
for (let i = 0; i < 120 && !(run && ['done', 'failed'].includes(run.status)); i++) {
  await page.waitForTimeout(1000);
  const runs = (await (await page.request.get(`${base}/api/runs`)).json()).runs;
  if (runs.length > before) run = runs[0];
}
const pngs = (run?.artifacts ?? []).filter((a) => /^series-test-\d\d\.png$/.test(a));
ok('a 2 × 1 series makes two map pages', run?.status === 'done' && pngs.length === 2, `${run?.status} · ${pngs.join(', ')}`);

// ---- one page per feature: too many features is refused with a reason
const idx = await page.evaluate(() => 0);
await page.locator('#ribbon-body [data-cmd="home.finish"]').first().click();
await page.waitForTimeout(400);
const hasIndex = await page.locator('select[name=index]').count();
if (hasIndex) {
  await page.selectOption('select[name=index]', { index: idx });
  await page.waitForTimeout(400);
  ok('choosing a page layer picks “one page per feature”', await page.locator('input[name=pages][value=features]').isChecked());
  await page.click('#finish button[type=submit]');
  await page.waitForTimeout(1500);
  const m = await page.locator('#finish-msg').innerText().catch(() => '');
  const open = await page.locator('#finish').isVisible();
  ok('a page layer either runs or explains why not', !open || /at most|No pages/.test(m), m || 'started');
}
ok('no page errors', !errors.length, errors.join(' | '));
console.log(`\n${pass} passed, ${fails.length} failed`);
await browser.close();
process.exit(fails.length ? 1 : 0);
