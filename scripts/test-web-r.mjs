// The R tab: R setup lists R and the package kits; the R console runs real R (needs R with sf,
// terra and ggplot2) and shows what comes back: layers and rasters on the map, figures, tables,
// printed output, and an "Install …" button when a package is missing.
//   PW=/path/to/node_modules/playwright node scripts/test-web-r.mjs [base]
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
const r = await (await fetch(`${base}/api/r`)).json();
if (!r.installed || !r.packages.terra || !r.packages.ggplot2) {
  console.log('R with terra and ggplot2 is not installed here: skipped');
  process.exit(0);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?mode=pro`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

await page.click('#ribbon-tabs .rb-tab[data-tab="r"]');
const cmds = await page.locator('#ribbon [data-cmd^="r."]').evaluateAll((els) => els.map((e) => e.getAttribute('data-cmd')));
ok('the R tab has its commands', ['r.console', 'r.setup', 'r.tmap', 'r.ggplot', 'r.rayshader', 'r.terrain', 'r.biomod2', 'r.maxent', 'r.tidymodels', 'r.dbplyr', 'r.gee'].every((c) => cmds.includes(c)), `${cmds.length}`);

// R setup
await page.click('[data-cmd="r.setup"]');
await page.waitForSelector('#rconsole .rc-kit', { timeout: 30000 });
const lead = await page.locator('#rconsole .fin-lead').innerText();
ok('R setup finds R', /R \d/.test(lead), lead.slice(0, 60));
ok('R setup lists the kits', (await page.locator('#rconsole .rc-kit').count()) >= 8);
ok('installed packages are marked', (await page.locator('#rconsole .rc-have', { hasText: 'terra' }).count()) === 1);
await page.click('#rconsole footer [data-close]');

const run = async (template, code, layer, raster) => {
  if (await page.locator('#rconsole').isVisible()) await page.click('#rconsole footer [data-close]');
  await page.click('#ribbon-tabs .rb-tab[data-tab="r"]');
  await page.click('[data-cmd="r.console"]');
  await page.waitForSelector('#rconsole textarea');
  if (template !== 'blank') {
    await page.selectOption('#rconsole [name=template]', template);
    await page.waitForTimeout(300);
  }
  if (code != null) await page.fill('#rconsole textarea', code);
  if (layer !== undefined) await page.selectOption('#rconsole [name=layer]', layer);
  if (raster !== undefined) await page.selectOption('#rconsole [name=raster]', raster);
  if (template === 'blank' && code != null) await page.fill('#rconsole [name=packages]', '');
  await page.click('#rconsole button[type=submit]');
  await page.waitForFunction(() => /Done|Failed|rror/.test(document.querySelector('#rc-msg')?.textContent ?? ''), null, { timeout: 120000 });
  return page.locator('#rconsole .rc-out');
};

// printed output from a layer
let out = await run('blank', 'print(nrow(layer))\nresult(features = nrow(layer))', 'settlements.geojson');
ok('the console prints R output', /\[1\]/.test(await out.innerText()), (await out.innerText()).slice(0, 40));
ok('results are shown', /features = /.test(await out.innerText()));

// a raster back to the map
out = await run('blank', `dem <- terra::rast(nrows = 60, ncols = 60, xmin = 144, xmax = 145, ymin = -6, ymax = -5, crs = "EPSG:4326")
terra::values(dem) <- outer(1:60, 1:60, function(i, j) 500 + 300 * sin(i / 9) * cos(j / 11))
list(dem = dem)`, '');
ok('a SpatRaster comes back as a raster', /r-console\.dem/.test(await out.innerText()));

// terra terrain template on that raster: rasters + a table
out = await run('terrain', null, undefined, 'r-console.dem');
const t = await out.innerText();
ok('terrain returns four rasters', ['slope', 'aspect', 'ruggedness', 'hillshade'].every((n) => t.includes(`r-console.${n}`)), t.slice(0, 120));
ok('and a table', (await page.locator('#rconsole .rc-table').count()) === 1);

// a ggplot figure
out = await run('blank', `library(ggplot2)
d <- sf::st_drop_geometry(layer)
p <- ggplot(layer) + geom_sf() + theme_minimal()
save_figure("settlements", p, width = 100, height = 80, formats = c("png", "pdf"))`, 'settlements.geojson');
await page.waitForTimeout(500);
const img = page.locator('#rconsole .rc-out img');
await page.screenshot({ path: 'bench/screenshots/r-console.png' });
ok('a ggplot figure is shown', (await img.count()) === 1 && (await img.evaluate((i) => i.naturalWidth)) > 100);
ok('with PNG and PDF links', (await page.locator('#rconsole figcaption a').allInnerTexts()).join(',') === 'PNG,PDF');

// a missing package offers to install it
out = await run('blank', 'library(notapackagexyz)', '');
await page.fill('#rconsole [name=packages]', 'notapackagexyz');
await page.click('#rconsole button[type=submit]');
await page.waitForFunction(() => document.querySelector('#rconsole [data-install]'), null, { timeout: 60000 }).catch(() => {});
ok('a missing package offers Install', (await page.locator('#rconsole [data-install]').count()) === 1);
await page.click('#rconsole [data-install]');
await page.waitForSelector('#rconsole .rc-kits', { timeout: 30000 });
ok('which opens R setup with it ticked', (await page.locator('#rconsole input[name=pkg][value="notapackagexyz"]').isChecked().catch(() => false)));
await page.screenshot({ path: 'bench/screenshots/r-setup.png' });
await page.click('#rconsole footer [data-close]');

ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
