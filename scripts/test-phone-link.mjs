// Phone link end to end (docs/DEVICES.md §3a), needs `playwright` + Chromium and gdal-bin:
//   PW=/path/to/node_modules/playwright node scripts/test-phone-link.mjs [server-binary] [samples-dir] [out-dir]
// Starts its own server (fresh state, TZ=UTC, ports $PORT and $PORT+1; default 18120). Then:
//   main UI: Devices → "Send from phone" → Turn on → QR code;
//   phone (mobile viewport, HTTPS with the self-signed certificate, mocked GPS): opens the QR address, is paired,
//   shares live location, sends a geotagged photo + a photo without GPS taken "now" from the gallery → the
//   finished map shows up on the phone; takes a photo in camera mode (no GPS of its own) → placed with the
//   phone's position; the device then has 3 geotagged photos, 2 of them placed (live track, sidecar);
//   an unpaired phone is refused; http:// redirects to https://; Turn off closes the port; the pairing code survives
//   a restart.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const bin = process.argv[2] ?? 'target/release/geospax-server';
const samples = process.argv[3] ?? '/tmp/geospax-devices';
const out = process.argv[4] ?? 'bench/screenshots';
const port = Number(process.env.PORT ?? 18120);
const phonePort = port + 1;
const base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'gx-phone-test-'));
const files = join(work, 'files');
mkdirSync(join(work, 'data'), { recursive: true });
mkdirSync(files, { recursive: true });
const gdal = (...args) => {
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${args[0]} failed: ${r.stderr}`);
};
// a geotagged phone photo from the samples, and blank JPEGs without GPS
copyFileSync(join(samples, 'TEST-PHONE/DCIM/Camera/PXL_20261013_080500.jpg'), join(files, 'PXL_20261013_080500.jpg'));
gdal('gdal_create', '-q', '-of', 'GTiff', '-outsize', '64', '48', '-bands', '3', '-ot', 'Byte', '-burn', '60', '-burn', '120', '-burn', '190', join(work, 'blank.tif'));
const jpeg = (name, exifTime) =>
  gdal('gdal_translate', '-q', '-of', 'JPEG', ...(exifTime ? ['-mo', `EXIF_DateTimeOriginal=${exifTime}`] : []), '-mo', 'EXIF_Make=TestPhone', join(work, 'blank.tif'), join(files, name));
jpeg('camera.jpg', null);

const results = [];
const ok = (msg) => { results.push(msg); console.log('PASS ', msg); };
let server;
const fail = (msg) => {
  console.error('FAIL:', msg);
  server?.kill();
  process.exit(1);
};
const api = async (path, init) => {
  const r = await fetch(base + path, init);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};
const portOpen = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});

server = spawn(bin, ['--data', join(work, 'data'), '--state-dir', join(work, 'state'), '--host', '127.0.0.1', '--port', String(port),
  '--web', 'web/dist', '--no-device-mounts', '--phone-port', String(phonePort)], { env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let exited = null;
server.on('exit', (code) => (exited = code ?? 'signal'));
process.on('exit', () => server.kill()); // also when a step throws
await new Promise((r) => setTimeout(r, 300));
if (exited !== null) fail(`the server exited at start (${exited}): ${log.slice(-400)}`);
for (let i = 0; i < 60; i++) {
  try { await api('/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
const watch = (page, label) => {
  page.on('console', (m) => m.type() === 'error' && problems.push(`${label}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
};

// 1. main UI: switch the phone link on, QR code appears
const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
watch(desk, 'main');
await desk.goto(`${base}/?fresh`);
// the Devices pane lives in the Explorer (hidden until shown); showTab finds it wherever it is docked
await desk.waitForFunction(() => !!window.workbench, null, { timeout: 30000 });
await desk.evaluate(() => window.workbench.showTab('right', 'devices'));
const card = desk.locator('#phone-link .phone-card');
await card.waitFor({ timeout: 30000 }).catch(() => fail('no "Send from phone" card in the Devices panel'));
if ((await card.getAttribute('data-state')) !== 'off') fail('the phone link should start switched off');
await card.locator('button[data-phone="enable"]').click();
await desk.locator('#phone-link .phone-card[data-state="on"] .phone-qr svg').waitFor({ timeout: 15000 }).catch(() => fail('no QR code after Turn on'));
const state = await api('/api/phone');
if (!state.running || !state.url?.includes(`:${phonePort}/#t=`)) fail(`phone link state: ${JSON.stringify(state).slice(0, 300)}`);
await desk.locator('#phone-link').scrollIntoViewIfNeeded();
await desk.locator('#sidebar').screenshot({ path: join(out, '39-phone-link-card.png') }).catch(() => desk.locator('#phone-link').screenshot({ path: join(out, '39-phone-link-card.png') }));
ok(`Turn on → QR code for ${state.url.split('#')[0]} (computer "${state.computer}")`);
const phoneUrl = state.url.replace(/^https:\/\/[^/]+/, `https://127.0.0.1:${phonePort}`); // same page, local address

// 2. the phone: pairs from the QR address
const phoneCtx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  permissions: ['geolocation'], geolocation: { latitude: -5.8400, longitude: 144.2100, accuracy: 6 },
});
const phone = await phoneCtx.newPage();
watch(phone, 'phone');
await phone.goto(phoneUrl);
await phone.waitForFunction(() => document.body.dataset.link, null, { timeout: 15000 }).catch(() => fail('phone page never asked GeoSpaX who it is'));
const link = await phone.evaluate(() => document.body.dataset.link);
if (link !== 'paired') fail(`phone page state "${link}" (expected paired)`);
if (!(await phone.evaluate(() => window.isSecureContext))) fail('phone page is not a secure context (needed for location)');
if (await phone.evaluate(() => location.hash)) fail('the pairing code should be removed from the address bar');
await phone.screenshot({ path: join(out, '40-phone-link-page.png') });
ok(`phone paired over HTTPS (secure context, so location works), page title "${await phone.title()}"`);

// 3. live location, then a gallery send: a geotagged photo + a photo without GPS taken "now"
await phone.click('#toggle');
await phone.waitForFunction(() => Number(document.body.dataset.sent || 0) >= 1, null, { timeout: 20000 }).catch(() => fail('no live fix sent'));
await phoneCtx.setGeolocation({ latitude: -5.8410, longitude: 144.2112, accuracy: 6 });
await phone.waitForFunction(() => Number(document.body.dataset.sent || 0) >= 2, null, { timeout: 4000 }).catch(() => {});
const now = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');
jpeg('now_no_gps.jpg', now);
await phoneCtx.setGeolocation({ latitude: -5.8420, longitude: 144.2124, accuracy: 6 });
await phone.waitForFunction(() => Number(document.body.dataset.sent || 0) >= 3, null, { timeout: 4000 }).catch(() => {});
const fixes = await phone.evaluate(() => Number(document.body.dataset.sent || 0));
const [chooser] = await Promise.all([phone.waitForEvent('filechooser'), phone.click('#pick')]);
const t0 = Date.now();
await chooser.setFiles([join(files, 'PXL_20261013_080500.jpg'), join(files, 'now_no_gps.jpg')]);
await phone.waitForFunction(() => document.body.dataset.map, null, { timeout: 90000 }).catch(() => fail(`no map on the phone after sending (${(log.match(/automation: .*/g) || []).slice(-3).join(' | ')})`));
const firstMap = await phone.evaluate(() => document.body.dataset.map);
const mapSecs = ((Date.now() - t0) / 1000).toFixed(1);
await phone.waitForFunction(() => { const i = document.querySelector('#result img'); return i && i.complete && i.naturalWidth > 100; }, null, { timeout: 15000 }).catch(() => fail('the map image did not load on the phone'));
await phone.evaluate(() => document.querySelector('#result').scrollIntoView());
await phone.screenshot({ path: join(out, '41-phone-link-map-on-phone.png') });
ok(`gallery send (2 photos, ${fixes} live fixes) → map ready on the phone in ${mapSecs} s (run ${firstMap})`);

// 4. camera mode: a photo without GPS gets the phone's position
await phoneCtx.setGeolocation({ latitude: -5.8433, longitude: 144.2141, accuracy: 5 });
await phone.waitForTimeout(1500);
await phone.setInputFiles('#camera', join(files, 'camera.jpg'));
await phone.waitForFunction((prev) => document.body.dataset.map && document.body.dataset.map !== prev, firstMap, { timeout: 90000 }).catch(() => fail('no new map after the camera photo'));
ok('camera photo (no GPS of its own) sent → new map');

// 5. what GeoSpaX made of it
const dev = (await api('/api/devices')).devices.find((d) => String(d.root).endsWith('From phone'));
if (!dev) fail('no "From phone" device');
if (dev.photos_geotagged !== 3 || dev.photos_placed !== 2) fail(`device ${dev.name}: ${dev.photos_geotagged} geotagged of ${dev.photos_total}, ${dev.photos_placed} placed (expected 3 and 2)`);
ok(`device "${dev.name}": ${dev.photos_geotagged} of ${dev.photos_total} photos geotagged, ${dev.photos_placed} placed by GeoSpaX (live track by time + camera position)`);
const runs = (await api('/api/runs')).runs.filter((r) => r.trigger?.device_id === dev.id);
if (runs.length < 2 || runs.some((r) => r.status !== 'done')) fail(`runs: ${runs.map((r) => r.recipe + ' ' + r.status).join(', ')}`);
ok(`${runs.length} runs, all done, with no Auto switch on: ${[...new Set(runs.map((r) => r.recipe))].join(', ')}`);

// 6. an unpaired phone is refused; typing http:// lands on https://
const stranger = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
await stranger.goto(`https://127.0.0.1:${phonePort}/#t=not-the-code`);
await stranger.waitForFunction(() => document.body.dataset.link, null, { timeout: 15000 });
if ((await stranger.evaluate(() => document.body.dataset.link)) !== 'unpaired') fail('a phone with the wrong code was not refused');
const r = await fetch(`https://127.0.0.1:${phonePort}/api/phone/upload?t=wrong&batch=x&name=a.jpg`, { method: 'POST', body: 'x' }).catch((e) => e);
ok('wrong pairing code: page says "not paired"' + (r instanceof Error ? '' : ` (upload HTTP ${r.status})`));
const redirect = await new Promise((res) => http.get(`http://127.0.0.1:${phonePort}/`, (resp) => res(`${resp.statusCode} ${resp.headers.location}`)).on('error', (e) => res(e.message)));
if (!redirect.startsWith('301 https://')) fail(`http:// was not redirected: ${redirect}`);
ok(`http:// → ${redirect}`);

// 7. Turn off closes the port
if (!(await desk.locator('#phone-link button[data-phone="disable"]').count())) await desk.locator('#phone-link button[data-phone="toggle"]').click();
await desk.locator('#phone-link button[data-phone="disable"]').click();
await desk.locator('#phone-link .phone-card[data-state="off"]').waitFor({ timeout: 10000 }).catch(() => fail('card did not switch off'));
await new Promise((res) => setTimeout(res, 600));
if (await portOpen(phonePort)) fail('phone port still open after Turn off');
ok('Turn off → the phone port is closed');

// 8. the pairing code survives a restart (here started with --phone), so a phone's bookmark keeps working
const code = (u) => (u || '').split('#t=')[1];
server.kill();
await new Promise((res) => server.on('exit', res));
server = spawn(bin, ['--data', join(work, 'data'), '--state-dir', join(work, 'state'), '--host', '127.0.0.1', '--port', String(port),
  '--web', 'web/dist', '--no-device-mounts', '--phone', '--phone-port', String(phonePort)], { env: { ...process.env, TZ: 'UTC' }, stdio: 'ignore' });
let again = null;
for (let i = 0; i < 60 && !again?.running; i++) {
  await new Promise((r) => setTimeout(r, 500));
  again = await api('/api/phone').catch(() => null);
}
if (!again?.running || code(again.url) !== code(state.url)) fail(`pairing code after a restart: ${code(again?.url)} (was ${code(state.url)})`);
ok('restart with --phone: same pairing code, so bookmarked phones still work');

const errors = problems.filter((p) => !/Failed to load resource|ERR_CERT|net::ERR_CONNECTION_REFUSED/.test(p));
if (errors.length) console.log('console errors:', errors.slice(0, 5));
await browser.close();
server.kill();
rmSync(work, { recursive: true, force: true });
writeFileSync(join(out, 'phone-link.json'), JSON.stringify({ results, map_seconds: Number(mapSecs), live_fixes: fixes }, null, 1));
console.log(`phone link: ${results.length} checks passed`);
