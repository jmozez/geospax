// Stage 2 of the lazy path end to end: the start screen on a server with no data of its own, a file
// chosen from it, the layer styled and zoomed to, "Finish my map" (PNG + PDF + report, opened on
// its own), and the finished map listed on the start screen.
//   PW=/path/to/node_modules/playwright node scripts/test-web-start.mjs BASE FILE.geojson [OUT]
// BASE must be a server started on an empty --data folder.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const [base = 'http://127.0.0.1:8080', file, out = 'bench/screenshots'] = process.argv.slice(2);
if (!file) throw new Error('usage: test-web-start.mjs BASE FILE.geojson [OUT]');
mkdirSync(out, { recursive: true });
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/openstreetmap|favicon|ERR_TUNNEL|ERR_INTERNET/.test(m.text()) && errors.push(m.text()));

await page.goto(`${base}/?mode=lazy`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
ok('the start screen opens when there is no data yet', await page.locator('#start').isVisible());
await page.screenshot({ path: `${out}/start-screen.png` });
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.st-drop')]);
await chooser.setFiles([file]);
await page.waitForFunction(() => document.body.dataset.uploaded, null, { timeout: 60000 });
await page.waitForTimeout(2500);
ok('a chosen file becomes a layer card', (await page.locator('#contents .layer.card').count()) === 1);
ok('the start screen gets out of the way', !(await page.locator('#start').isVisible()));
await page.click('.tk-task[data-cmd="home.finish"]');
await page.waitForTimeout(300);
ok('“Finish my map” asks only for a title in Lazy mode', await page.locator('#finish input[name=title]').isVisible() && !(await page.locator('#finish select[name=size]').isVisible()));
await page.click('#finish button[type=submit]');
await page.waitForFunction(() => document.body.dataset.artifact, null, { timeout: 120000 });
const runs = (await (await page.request.get(`${base}/api/runs`)).json()).runs;
const arts = runs[0]?.artifacts ?? [];
ok('the finished map is a PNG, a PDF and a report', ['.png', '.pdf', 'report.html'].every((x) => arts.some((a) => a.endsWith(x))), arts.join(', '));
ok('the report opens by itself', (await page.evaluate(() => document.body.dataset.artifact)) === 'report.html');
await page.screenshot({ path: `${out}/finished-map-report.png` });
await page.keyboard.press('Escape');
await page.locator('#artifact-modal [data-close]').click().catch(() => {});
await page.evaluate(() => window.geospax.start.show());
await page.waitForTimeout(1500);
ok('the start screen lists the finished map', (await page.locator('.st-map').count()) >= 1);
ok('no page or console errors', !errors.length, errors.join(' | '));
console.log(`\n${pass} passed, ${fails.length} failed`);
await browser.close();
process.exit(fails.length ? 1 : 0);
