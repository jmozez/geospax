// Screenshots of the ribbon for the docs and the website, in headless Chromium against a running server
// whose data folder is made by scripts/test-edit-data.py:
//
//   PW=/opt/pw/node_modules/playwright node scripts/shots-ribbon.mjs http://127.0.0.1:18120 OUT_DIR
//
// Writes ribbon-<tab>.png (the ribbon of each Pro tab) and ribbon-swipe.png, ribbon-time.png (the map
// with the View tools at work). scripts/shots-ribbon.sh runs this and turns the ones the docs use into WebP in docs/assets and
// site/img.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');

const base = (process.argv[2] ?? 'http://127.0.0.1:18120').replace(/\/$/, '');
const out = process.argv[3] ?? 'ribbon-shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
await page.goto(`${base}/?fresh`);
await page.waitForFunction(() => window.map && window.map.loaded(), null, { timeout: 120_000 });
await page.waitForTimeout(1500);
const cmd = (id) => page.evaluate((id) => window.workbench.command(id), id);

// the Pro ribbon, one tab at a time
for (const tab of ['Home', 'View', 'Edit', 'Design', 'Imagery', 'Analysis', 'Share', 'Help']) {
  await page.click(`#ribbon-tabs >> text="${tab}"`);
  await page.waitForTimeout(400);
  await page.locator('#ribbon').screenshot({ path: `${out}/ribbon-${tab.toLowerCase()}.png` });
}
// the View tools at work on the map
await page.click('#ribbon-tabs >> text="View"');
// a basemap with places on it (online), zoomed in on the survey
await page.click('#ribbon >> text="OpenStreetMap (online)"');
await page.click('#contents >> text=reserves');
await page.waitForTimeout(3000);
await cmd('view.grid');
await cmd('view.swipe');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/ribbon-swipe.png` });
await cmd('view.swipe');
await page.click('#contents >> text=survey.geojson');
await cmd('view.time');
await page.click('.gx-dialog button:has-text("Start")');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/ribbon-time.png` });
await browser.close();
console.log(`ribbon screenshots in ${out}`);
