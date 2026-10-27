// Automation end-to-end check of the web edition (needs `playwright` + Chromium):
//   PW=/path/to/node_modules/playwright node scripts/test-web-automation.mjs [http://127.0.0.1:8080] [out-dir]
// Expects a server with the sample devices (scripts/data-sample-devices.py), a fresh state dir and
// recipes not yet run (scripts/test-all.sh starts one).
// Steps: the Automate pane lists the gallery -> Run "photos-to-map" -> progress -> the phone's
// layers appear on the map with AutoMap styles and the view moves there -> the finished map and the
// report open in the viewer -> the Auto switch persists -> "Save this map as a recipe" -> run it ->
// "terrain-report" puts shaded relief on the map and fills the Rasters pane -> its 3D button opens
// the scene in the app (sandboxed WebGL viewer).
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
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const fail = async (msg) => {
  console.error('FAIL:', msg);
  await page.screenshot({ path: `${out}/automation-failure.png` }).catch(() => {});
  process.exit(1);
};
const t = Date.now();
const secs = () => ((Date.now() - t) / 1000).toFixed(1);

// 1. Gallery
await page.goto(`${base}/?fresh&view=6/-6/145`);
await page.locator('#automate .recipe').first().waitFor({ timeout: 30000 }).catch(() => fail('Automate pane did not list recipes'));
const ids = await page.$$eval('#automate .recipe', (els) => els.map((e) => e.dataset.recipe));
console.log(`gallery: ${ids.length} recipes: ${ids.join(', ')}`);
for (const want of ['photos-to-map', 'track-to-map', 'drone-flight-report', 'points-to-hexbins', 'points-to-hotspots', 'interpolate-samples', 'python-spatial-stats']) {
  if (!ids.includes(want)) await fail(`recipe ${want} missing from the gallery`);
}

// 2. One click: Run photos-to-map (source auto = the connected phone)
const card = page.locator('#automate .recipe[data-recipe="photos-to-map"]');
await card.locator('button[data-run]').click();
await page.waitForFunction(() => ['done', 'failed', 'cancelled'].includes(document.body.dataset.recipeRun ?? ''), null, { timeout: 90000 }).catch(() => fail('run did not finish'));
const status = await page.evaluate(() => document.body.dataset.recipeRun);
if (status !== 'done') await fail(`run finished with status ${status}: ${await card.innerText()}`);
await page.waitForFunction(() => document.body.dataset.runApplied, null, { timeout: 30000 }).catch(() => fail('run result was not applied to the map'));
await page.evaluate(() => new Promise((r) => (window.map.loaded() ? r() : window.map.once('idle', r))));
await page.waitForTimeout(1200);
const mapState = await page.evaluate(() => ({
  zoom: window.map.getZoom(),
  layers: window.map.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith('test-phone')),
}));
console.log(`run done in ${secs()} s; map layers ${JSON.stringify(mapState.layers)}; zoom ${mapState.zoom.toFixed(1)}`);
if (mapState.layers.length < 3) await fail('expected the phone photos, track and waypoints on the map');
if (mapState.zoom < 13) await fail('map did not move to the run result');
const cardText = (await card.innerText()).replace(/\s+/g, ' ');
console.log('card:', cardText.slice(0, 260));
if (!/Done/.test(cardText)) await fail('card does not show the finished run');
await page.screenshot({ path: `${out}/15-automate-run.png` });
console.log('screenshot 15-automate-run.png');

// 3. The finished map and the report open in the viewer
await card.locator('button[data-art$=".png"]').click();
await page.locator('#artifact-modal img').waitFor({ timeout: 15000 }).catch(() => fail('map image did not open'));
await page.waitForFunction(() => document.querySelector('#artifact-modal img')?.naturalWidth > 0, null, { timeout: 15000 }).catch(() => fail('map image is empty'));
const size = await page.$eval('#artifact-modal img', (i) => [i.naturalWidth, i.naturalHeight]);
console.log(`map.png ${size[0]}×${size[1]}`);
if (size[0] < 1000) await fail('map image too small');
await page.screenshot({ path: `${out}/16-automate-map.png` });
await page.click('#artifact-modal [data-close]');
await card.locator('button[data-art$=".html"]').click();
const frame = page.frameLocator('#artifact-modal iframe');
await frame.locator('h2', { hasText: 'How this map was made' }).waitFor({ timeout: 15000 }).catch(() => fail('report did not open'));
const decisions = await frame.locator('h2', { hasText: 'Automatic decisions' }).count();
if (!decisions) await fail('report has no "Automatic decisions" section');
await page.screenshot({ path: `${out}/17-automate-report.png` });
console.log('screenshots 16-automate-map.png, 17-automate-report.png');
await page.click('#artifact-modal [data-close]');

// 4. Auto switch persists on the server
await card.locator('input[data-auto]').check();
await page.waitForFunction(async () => {
  const r = await fetch('api/recipes').then((x) => x.json());
  return r.recipes.find((x) => x.id === 'photos-to-map')?.auto === true;
}, null, { timeout: 10000 }).catch(() => fail('Auto switch did not persist'));
await page.locator('#automate .recipe[data-recipe="photos-to-map"] input[data-auto]').uncheck();
console.log('auto switch: on -> off persisted');

// 5. Save this map as a recipe, then run it
await page.click('#save-recipe');
await page.waitForFunction(() => document.body.dataset.savedRecipe, null, { timeout: 15000 }).catch(() => fail('recipe was not saved'));
const saved = await page.evaluate(() => document.body.dataset.savedRecipe);
const mine = page.locator(`#automate .recipe[data-recipe="${saved}"]`);
await mine.waitFor({ timeout: 15000 }).catch(() => fail('saved recipe not listed'));
await page.evaluate(() => delete document.body.dataset.recipeRun);
await mine.locator('button[data-run]').click();
await page.waitForFunction(() => ['done', 'failed'].includes(document.body.dataset.recipeRun ?? ''), null, { timeout: 90000 }).catch(() => fail('saved recipe run did not finish'));
const s2 = await page.evaluate(() => document.body.dataset.recipeRun);
if (s2 !== 'done') await fail(`saved recipe run: ${s2}: ${await mine.innerText()}`);
console.log(`saved recipe ${saved} ran: ${(await mine.innerText()).replace(/\s+/g, ' ').slice(0, 160)}`);
// the pane re-renders while polling: scroll by selector, not by a possibly detached element
await page.evaluate((id) => document.querySelector(`#automate .recipe[data-recipe="${id}"]`)?.scrollIntoView({ block: 'center' }), saved);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/18-automate-saved-recipe.png` });

// 4. Rasters: Run terrain-report (Copernicus DEM read over HTTP) -> shaded relief on the map and the
//    Rasters pane lists what it made. Skipped with GEOSPAX_OFFLINE=1.
if (process.env.GEOSPAX_OFFLINE !== '1') {
  // terrain-report's area is "auto" (the most sample-like layer): the 60 soil samples. Without them it
  // picks some other layer (often far wider than the DEM limit), and the checks below mean nothing.
  if (!(await page.evaluate(() => window.map.getStyle().layers.some((l) => l.id.startsWith('field_samples')))))
    await fail('no field_samples layer: the data folder needs scripts/data-sample-field.py DATA');
  const tcard = page.locator('#automate .recipe[data-recipe="terrain-report"]');
  await page.evaluate(() => delete document.body.dataset.runApplied);
  await page.evaluate(() => document.querySelector('#automate .recipe[data-recipe="terrain-report"]')?.scrollIntoView({ block: 'center' }));
  await tcard.locator('button[data-run]').click();
  await page
    .waitForFunction(() => (document.body.dataset.runApplied ?? '').includes('terrain-report'), null, { timeout: 120000 })
    .catch(() => fail('terrain-report did not finish (needs internet for the Copernicus DEM)'));
  await page
    .waitForFunction(() => window.map.getStyle().layers.some((l) => l.id === 'raster:terrain-report.dem'), null, { timeout: 20000 })
    .catch(async () => {
      const run = await page.evaluate(async () => (await (await fetch('api/runs')).json()).runs.find((r) => r.recipe === 'terrain-report'));
      await fail(`the DEM overlay is not on the map (run ${run?.status}: ${run?.error ?? 'no error'})`);
    });
  await page.evaluate(() => new Promise((r) => (window.map.loaded() ? r() : window.map.once('idle', r))));
  await page.waitForTimeout(1500);
  const rs = await page.evaluate(() => {
    const ids = window.map.getStyle().layers.map((l) => l.id);
    return {
      layers: ids.filter((id) => id.startsWith('raster:')),
      below: ids.indexOf('raster:terrain-report.dem') < ids.findIndex((id) => id.startsWith('field_samples')),
      rows: document.querySelectorAll('#rasters .raster').length,
      visible: [...document.querySelectorAll('#rasters .raster input[data-act=visible]:checked')].map((e) => e.closest('.raster').dataset.id),
    };
  });
  console.log(`terrain-report: raster layers ${JSON.stringify(rs.layers)}; pane rows ${rs.rows}; visible ${rs.visible.join(', ')}`);
  if (!rs.layers.includes('raster:terrain-report.hillshade')) await fail('relief shading is not on the map');
  if (!rs.below) await fail('rasters must draw below the sample points');
  if (rs.rows < 5) await fail('the Rasters pane should list the DEM, hillshade, slope, aspect and slope classes');
  await page.evaluate(() => document.querySelector('#rasters')?.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/25-ui-terrain-rasters.png` });
  console.log('screenshot 25-ui-terrain-rasters.png');

  // 5. The run card's 3D button opens the scene in the app (sandboxed viewer, WebGL)
  await page.evaluate(() => document.querySelector('#automate .recipe[data-recipe="terrain-report"]')?.scrollIntoView({ block: 'center' }));
  const btn = tcard.locator('button[data-art$="scene.html"]');
  if (!(await btn.count())) await fail('the terrain-report card has no 3D button');
  if ((await btn.textContent()).trim() !== '🧊 3D') await fail(`3D button reads "${await btn.textContent()}"`);
  await btn.click();
  await page.locator('#artifact-modal iframe.scene3d').waitFor({ timeout: 20000 }).catch(() => fail('the 3D scene did not open'));
  const frame = await (await page.$('#artifact-modal iframe.scene3d')).contentFrame();
  const ready = await frame.waitForFunction(() => document.body.dataset.ready, null, { timeout: 60000 }).then((h) => h.jsonValue()).catch(() => 'timeout');
  if (ready !== '1') await fail(`the 3D viewer inside the app did not start (${ready})`);
  const sc = await frame.evaluate(() => ({ groups: window.geospaxScene.groups, triangles: window.geospaxScene.triangles, sandboxed: (() => { try { return !window.parent.document; } catch { return true; } })() }));
  console.log(`3D scene in the app: ${sc.triangles} triangles, layers ${sc.groups.join('/')}, sandboxed ${sc.sandboxed}`);
  if (!sc.groups.includes('terrain') || sc.triangles < 1000) await fail('the 3D scene is empty');
  if (!sc.sandboxed) await fail('the 3D viewer must not reach the app (sandbox without same-origin)');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/51-ui-scene-3d.png` });
  console.log('screenshot 51-ui-scene-3d.png');
  await page.keyboard.press('Escape');
}

const serious = problems.filter((p) => !/WebGL|GPU stall|swiftshader|Automatic fallback/i.test(p));
if (serious.length) {
  console.error('console problems:\n  ' + serious.join('\n  '));
  process.exit(1);
}
console.log(`PASS (${secs()} s)`);
await browser.close();
