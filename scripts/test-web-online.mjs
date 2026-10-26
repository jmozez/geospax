// Data › Online data: every form opens, and "Get data" saves the right one-step recipe. The recipe
// request is intercepted (no internet needed); data_steps.rs tests the downloads themselves.
//   PW=/path/to/node_modules/playwright node scripts/test-web-online.mjs [base]
import { runCmd } from './lib/ui.mjs';
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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let saved = null;
// keep the recipe from being saved or run: capture it instead
await page.route('**/api/recipes', async (route) => {
  if (route.request().method() === 'POST') {
    saved = route.request().postData();
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'captured by the test' }) });
  } else await route.continue();
});
await page.goto(`${base}/?mode=pro`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const tabs = await page.locator('#ribbon-tabs .rb-tab').allInnerTexts();
ok('the ribbon has its tabs in the order of the work', ['Home', 'View', 'Edit', 'Design', 'Imagery', 'Analysis', 'Share', 'Help'].every((t, i) => tabs[i] === t), tabs.join(' · '));
const submit = async (cmd, fill) => {
  saved = null;
  await runCmd(page, cmd);
  await page.waitForTimeout(300);
  if (fill) await fill();
  await page.click('#online button[type=submit]');
  await page.waitForTimeout(400);
  const msg = await page.locator('#online-msg').innerText().catch(() => '');
  await page.keyboard.press('Escape');
  const m = /with: (\{.*\})/.exec(saved ?? '');
  return { yaml: saved ?? '', w: m ? JSON.parse(m[1]) : null, use: /use: ([\w.]+)/.exec(saved ?? '')?.[1], msg };
};
let r = await submit('data.climate', async () => {
  await page.click('#online [data-bio="prec"]');
});
ok('Climate → data.fetch (automatic source: CHELSA or WorldClim) with BIO12–19 for the map view', r.use === 'data.fetch' && ['climate', 'worldclim'].includes(r.w?.source) && r.w.variables.join() === '12,13,14,15,16,17,18,19' && r.w.aoi.length === 4 && !r.w.variable, JSON.stringify(r.w));
r = await submit('data.climate', async () => {
  await page.selectOption('#online select[name=source]', 'worldclim-monthly');
  await page.fill('#online input[name=months]', '1-3, 12');
});
ok('Monthly climate → months 1,2,3,12', r.w?.source === 'worldclim-monthly' && r.w.months.join() === '1,2,3,12' && !r.w.variables, JSON.stringify(r.w));
r = await submit('data.future', async () => {
  await page.selectOption('#online select[name=ssp]', '585');
  await page.selectOption('#online select[name=period]', '2081-2100');
});
ok('Future climate → SSP5-8.5, 2081–2100', r.w?.source === 'worldclim-future' && r.w.ssp === '585' && r.w.period === '2081-2100' && r.w.gcm, JSON.stringify(r.w));
r = await submit('data.soil', async () => page.selectOption('#online select[name=property]', 'soc'));
ok('Soil → SoilGrids organic carbon', r.w?.source === 'soilgrids' && r.w.property === 'soc', JSON.stringify(r.w));
r = await submit('data.species', async () => {
  await page.selectOption('#online select[name=source]', 'obis');
  await page.fill('#online input[name=species]', 'Chelonia mydas');
});
ok('Species → OBIS Chelonia mydas', r.w?.source === 'obis' && r.w.species === 'Chelonia mydas' && r.w.limit === 2000, JSON.stringify(r.w));
r = await submit('data.boundaries', async () => page.fill('#online input[name=country]', 'png'));
ok('Boundaries → GADM PNG level 1, no area', r.w?.source === 'gadm' && r.w.country === 'PNG' && r.w.level === 1 && !r.w.aoi, JSON.stringify(r.w));
r = await submit('data.elevation');
ok('Elevation → dem.fetch Copernicus', r.use === 'dem.fetch' && r.w?.source === 'copernicus', JSON.stringify(r.w));
r = await submit('data.ocean', async () => page.check('#online input[name=layers][value=tid]'));
ok('Ocean depth → GEBCO elevation and TID', r.use === 'data.fetch' && r.w?.source === 'gebco' && r.w.layers?.join() === 'elevation,tid' && r.w.aoi.length === 4, JSON.stringify(r.w));
r = await submit('data.forest');
ok('Forest change → Hansen tree cover and loss year', r.w?.source === 'hansen' && r.w.layers?.join() === 'treecover,lossyear', JSON.stringify(r.w));
r = await submit('data.forest', async () => { await page.uncheck('#online input[name=layers][value=treecover]'); await page.uncheck('#online input[name=layers][value=lossyear]'); });
ok('no Hansen layer ticked is caught before saving', !r.yaml && /at least one Hansen layer/.test(r.msg), r.msg);
r = await submit('data.ecoregions');
ok('Ecoregions → data.fetch ecoregions for the map view', r.w?.source === 'ecoregions' && r.w.aoi.length === 4, JSON.stringify(r.w));
r = await submit('data.climate', async () => page.click('#online [data-bio="none"]'));
ok('no variable ticked is caught before saving', !r.yaml && /at least one/.test(r.msg), r.msg);
// Lazy mode: the task bar's "Online data" opens a chooser, and a card opens its form
await page.click('#mode-switch [data-mode="lazy"]');
await page.waitForTimeout(800);
await page.locator('.tk-bar [data-cmd="data.online"]').click();
await page.waitForTimeout(300);
ok('Lazy: "Online data" shows the nine sources', (await page.locator('#online .ol-card').count()) === 9);
await page.locator('#online [data-online="gbif"]').click();
await page.waitForTimeout(300);
ok('a source card opens its form', await page.locator('#online input[name=species]').isVisible());
await page.keyboard.press('Escape');
ok('no page errors', !errors.length, errors.join(' | '));
console.log(`\n${pass} passed, ${fails.length} failed`);
await browser.close();
process.exit(fails.length ? 1 : 0);
