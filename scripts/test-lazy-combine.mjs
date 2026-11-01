// Lazy mode across layers: with a point and a polygon layer on the map, selecting the polygons offers
// "Count <points> in each area" (and the points offer "Which <areas> each is in"); pressing it runs the
// combine-layers recipe and a new layer with the counts joins the map.
//   node scripts/test-lazy-combine.mjs [base-url] [out-dir]   (data: scripts/test-edit-data.py)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');
const base = (process.argv[2] ?? 'http://127.0.0.1:18120').replace(/\/$/, '');
const out = process.argv[3] ?? 'lazy-shots';
mkdirSync(out, { recursive: true });
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?fresh`);
await page.waitForFunction(() => window.map && window.map.loaded(), null, { timeout: 120_000 });
await page.waitForTimeout(1200);
await page.click('#mode-switch >> text=Lazy');
await page.waitForTimeout(600);
// select the reserves (polygons): the task bar's Next shows cross-layer steps
await page.locator('#contents').getByText(/reserves/i).first().click();
await page.waitForTimeout(800);
const next = await page.$$eval('.tk-next-btn', (bs) => bs.map((b) => b.textContent.trim()));
ok('polygons offer a count of the points', next.some((t) => /Count .*survey.* in each area/i.test(t)), next.join(' | '));
await page.screenshot({ path: `${out}/lazy-next.png` });
const before = await page.evaluate(() => fetch('api/layers').then((r) => r.json()).then((j) => (j.layers ?? j).length));
await page.locator('.tk-next-btn', { hasText: /Count .* in each area/ }).first().click();
let after = before;
for (let i = 0; i < 60 && after === before; i++) {
  await page.waitForTimeout(500);
  after = await page.evaluate(() => fetch('api/layers').then((r) => r.json()).then((j) => (j.layers ?? j).length));
}
ok('the combined layer joins the map', after === before + 1, `${before} → ${after} layers`);
const combined = await page.evaluate(() => fetch('api/layers').then((r) => r.json()).then((j) => (j.layers ?? j).find((l) => /_with_/.test(l.id))));
ok('it has the point counts', !!combined?.fields?.some((f) => /^n_/.test(f.name)), combined?.fields?.map((f) => f.name).join(', '));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/lazy-combined.png` });
await page.locator('#contents').getByText(/^survey/i).first().click().catch(() => {});
await page.waitForTimeout(600);
const next2 = await page.$$eval('.tk-next-btn', (bs) => bs.map((b) => b.textContent.trim()));
ok('points offer "which area each is in"', next2.some((t) => /Which .* each is in/i.test(t)), next2.join(' | '));
ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
