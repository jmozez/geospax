// Device hub end-to-end check of the web edition (needs `playwright` + Chromium):
//   PW=/path/to/node_modules/playwright node scripts/test-web-devices.mjs [http://127.0.0.1:8080] [out-dir]
// Expects a server started with the sample devices (scripts/data-sample-devices.py), e.g.
//   geospax-server ... --watch /tmp/geospax-devices/DJI-SD --watch /tmp/geospax-devices/GARMIN \
//                      --watch /tmp/geospax-devices/AQ-LOGGER
// with TEST-PHONE on a removable mount (/media/$USER) or also passed with --watch.
// Steps: the Devices pane lists the phone -> "Import & map" -> layers appear and the map zooms to
// them -> the phone page (mobile viewport, mocked GPS) streams a fix -> it shows up as a live device
// -> the air-quality logger is listed with its readings -> a live sensor pushes values -> they show
// in the pane -> the logger's readings are imported and mapped.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? 'bench/screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.grantPermissions(['geolocation'], { origin: base });
await context.setGeolocation({ latitude: -5.8435, longitude: 144.2165, accuracy: 8 });
const problems = [];
const watch = (page, label) => {
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
};
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

// 1. Devices pane lists the phone
const page = await context.newPage();
watch(page, 'map');
await page.goto(`${base}/?fresh&view=12/-5.86/144.25`);
// Devices live in the Explorer (left dock, "Devices & phones"); open it the way the app does,
// so the test follows the pane wherever the layout puts it.
await page.waitForFunction(() => typeof window.map?.loaded === 'function' && window.map.loaded(), null, { timeout: 60000, polling: 300 });
await page.evaluate(() => window.workbench.showTab('right', 'devices'));
const phoneRow = page.locator('#devices .device', { hasText: 'TEST-PHONE' });
await phoneRow.waitFor({ timeout: 30000 }).catch(() => fail('TEST-PHONE not listed in the Devices pane'));
console.log('devices pane:', (await page.locator('#devices').innerText()).replace(/\s+/g, ' ').slice(0, 300));

// 2. One click: Import & map
await phoneRow.locator('button[data-import]').click();
await page.waitForFunction(() => document.body.dataset.deviceImport, null, { timeout: 60000 });
const status = await page.evaluate(() => document.body.dataset.deviceImport);
if (status !== 'done') fail(`import finished with status ${status}`);
await page.waitForFunction(() => document.querySelector('#contents')?.textContent?.includes('test-phone'), null, { timeout: 30000 });
await page.evaluate(() => new Promise((r) => (window.map.loaded() ? r() : window.map.once('idle', r))));
await page.waitForTimeout(1500);
const view = await page.evaluate(() => ({ zoom: window.map.getZoom(), center: window.map.getCenter() }));
const layerIds = await page.evaluate(() => window.map.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith('test-phone')));
console.log(`imported: layers ${JSON.stringify(layerIds)}; zoomed to z${view.zoom.toFixed(1)} at ${view.center.lng.toFixed(4)}, ${view.center.lat.toFixed(4)}`);
if (layerIds.length < 3) fail('expected photo, track and waypoint layers on the map');
if (view.zoom < 13) fail('map did not zoom to the imported device');
await page.screenshot({ path: `${out}/12-device-imported.png` });
console.log('screenshot 12-device-imported.png');

// 3. Phone page: stream one fix from a "phone" (mobile viewport, mocked GPS)
const phone = await context.newPage();
watch(phone, 'phone');
await phone.setViewportSize({ width: 390, height: 780 });
await phone.goto(`${base}/phone.html`);
await phone.fill('#name', 'Field phone (test)');
await phone.click('#toggle');
await phone.waitForFunction(() => Number(document.body.dataset.sent || 0) >= 1, null, { timeout: 30000 }).catch(() => fail('phone page sent no fix'));
await phone.screenshot({ path: `${out}/13-phone-page.png` });
console.log('phone page: sent', await phone.evaluate(() => document.body.dataset.sent), 'fix(es); screenshot 13-phone-page.png');

// 4. The phone appears as a live device on the map
await page.locator('#devices [data-live^="phone-"]').waitFor({ timeout: 20000 }).catch(() => fail('live phone not listed'));
await page.waitForFunction(
  () => (window.map.querySourceFeatures('live') || []).some((f) => f.properties?.name === 'Field phone (test)'),
  null,
  { timeout: 20000 },
).catch(() => fail('live phone not on the map'));
await page.evaluate(() => window.map.jumpTo({ center: [144.2165, -5.8435], zoom: 15 }));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/14-live-phone.png` });
console.log('live phone on the map; screenshot 14-live-phone.png');

// 5. Sensors: a logger with geotagged readings, and a live sensor pushing values over HTTP
const aqRow = page.locator('#devices .device', { hasText: 'AQ-LOGGER' });
await aqRow.waitFor({ timeout: 30000 }).catch(() => fail('AQ-LOGGER not listed in the Devices pane'));
const aqText = (await aqRow.innerText()).replace(/\s+/g, ' ');
if (!aqText.includes('360 sensor readings')) fail(`AQ-LOGGER row: ${aqText}`);
console.log('sensor logger:', aqText.slice(0, 160));
const pushed = await page.evaluate(async () => {
  const r = await fetch('api/devices/live', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'aq-ui', name: 'AQ walker', lat: -5.8437, lon: 144.217, values: { pm2_5: 27.4, temperature: 21.3 } }),
  });
  return r.json();
});
if (pushed.device !== 'sensor-aq-ui') fail(`live sensor push: ${JSON.stringify(pushed)}`);
const liveSensor = page.locator('#devices [data-live="sensor-aq-ui"]', { hasText: 'pm2_5' });
await liveSensor.waitFor({ timeout: 20000 }).catch(() => fail('live sensor values not shown in the Devices pane'));
console.log('live sensor:', (await liveSensor.innerText()).replace(/\s+/g, ' '));
await aqRow.locator('button[data-import]').click();
await page.waitForFunction(() => document.querySelector('#contents')?.textContent?.includes('aq-logger'), null, { timeout: 30000 }).catch(() => fail('AQ-LOGGER layers not added'));
await page.evaluate(() => new Promise((r) => (window.map.loaded() ? r() : window.map.once('idle', r))));
await page.waitForTimeout(2000);
const aqLayers = await page.evaluate(() => window.map.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith('aq-logger')));
if (!aqLayers.some((id) => id.includes('readings'))) fail(`no readings layer on the map: ${JSON.stringify(aqLayers)}`);
await page.screenshot({ path: `${out}/34-ui-sensor-devices.png` });
console.log(`sensor readings on the map (${aqLayers.length} style layers); screenshot 34-ui-sensor-devices.png`);

await browser.close();
if (problems.length) {
  console.log('console problems:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('console: clean (no errors or warnings)');
