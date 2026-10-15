// Phase 1 end-to-end check of the web edition (needs `playwright` + Chromium):
//   PW=/path/to/node_modules/playwright node scripts/test-web-symbology.mjs [http://127.0.0.1:8080] [out-dir]
// Drives the UI the way a user would: graduated colours (natural breaks) and
// unique values from the Symbology pane, builds the overview pyramid from the
// pane, looks at the density heatmap at low zoom, reorders layers, reloads and
// checks that the project (styles + order) persisted.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? 'bench/screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const settled = () =>
  page.waitForFunction(() => window.map && window.map.loaded() && window.map.areTilesLoaded(), null, { timeout: 180_000, polling: 500 });
const shot = async (name) => {
  await settled();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 240_000 });
  console.log(`screenshot ${name}.png`);
};
const jump = async (z, lat, lon) => {
  await page.evaluate(([z, lat, lon]) => window.map.jumpTo({ center: [lon, lat], zoom: z }), [z, lat, lon]);
  await page.waitForTimeout(300);
};
const classes = () => page.waitForFunction(() => document.querySelectorAll('#panel table.classes tr').length > 2, null, { timeout: 60_000 });
const panelText = async () => (await page.textContent('#panel')).replace(/\s+/g, ' ').trim();
const B = 'synthetic.buildings';

// Start from a clean project
await page.request.put(`${base}/api/project`, { data: { version: 1, order: [], layers: {} } });
await page.request.delete(`${base}/api/layers/${B}/overviews`);
await page.goto(`${base}/?fresh#view=15.2/-5.862/144.235`);
await settled();

// 1) Graduated colours: height, natural breaks, 5 classes
await page.click(`.layer[data-id="${B}"] [data-act="props"]`);
await page.selectOption('#panel select[data-k="kind"]', 'graduated');
await classes();
let t = await panelText();
console.log('graduated:', /n=[\d,]+.*?ms/.exec(t)?.[0]);
await page.selectOption('#panel select[data-k="classes"]', '7');
await page.waitForFunction(() => document.querySelectorAll('#panel table.classes tr').length === 8, null, { timeout: 60_000 });
await shot('06-graduated-height-jenks7');

// 2) Unique values: kind
await page.selectOption('#panel select[data-k="kind"]', 'unique');
await page.selectOption('#panel select[data-k="field"]', 'kind');
await page.waitForFunction(() => /residential/.test(document.querySelector('#panel table.classes')?.textContent ?? ''), null, { timeout: 60_000 });
console.log('unique:', /\d+ distinct values.*?ms/.exec(await panelText())?.[0]);
await shot('07-unique-values-kind');

// 3) Overview pyramid built from the pane (background job), then low zooms
await page.click('#panel [data-k="build"]');
await page.waitForSelector('body[data-job="done"]', { timeout: 300_000 });
const job = (await (await page.request.get(`${base}/api/jobs`)).json()).jobs.find((j) => j.layer === B);
console.log('overview job:', job.status, job.message);
await page.waitForFunction(() => /Pyramid/.test(document.querySelector('#panel')?.textContent ?? ''), null, { timeout: 30_000 });
await page.click('#panel [data-k="close"]');
await jump(9, -5.95, 144.6);
await shot('08-overview-heatmap-z9');
await jump(12, -5.87, 144.25);
await shot('09-overview-z12-polygons-plus-density');

// 4) Back to graduated by height (this is the project the user will see), reorder, reload
await page.click(`.layer[data-id="${B}"] [data-act="props"]`);
await page.selectOption('#panel select[data-k="kind"]', 'graduated');
await page.selectOption('#panel select[data-k="field"]', 'height');
await classes();
await page.selectOption('#panel select[data-k="ramp"]', 'magma');
await page.click('#panel [data-k="close"]');
await page.click(`.layer[data-id="natural_earth.places"] [data-act="down"]`);
const orderBefore = await page.evaluate(() => [...document.querySelectorAll('#contents .layer')].map((e) => e.dataset.id));
await page.waitForTimeout(1500); // debounced project save
const saved = await (await page.request.get(`${base}/api/project`)).json();
await page.goto(`${base}/#view=14/-5.862/144.235`); // no ?fresh: loads the saved project
await settled();
const orderAfter = await page.evaluate(() => [...document.querySelectorAll('#contents .layer')].map((e) => e.dataset.id));
const legend = await page.textContent(`.layer[data-id="${B}"] .legend`);
console.log('persisted:', {
  symbology: saved.layers[B].symbology.kind,
  field: saved.layers[B].symbology.field,
  ramp: saved.layers[B].symbology.ramp,
  orderKept: JSON.stringify(orderBefore) === JSON.stringify(orderAfter),
  legendAfterReload: legend?.replace(/\s+/g, ' ').trim().slice(0, 80),
});
await shot('10-after-reload-z14');

console.log(problems.length ? `console problems:\n  ${problems.join('\n  ')}` : 'console: clean (no errors or warnings)');
await browser.close();
