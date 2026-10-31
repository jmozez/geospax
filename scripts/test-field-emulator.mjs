// GeoSpaX Field on an Android emulator (CI: the android-emulator job). Needs a debug APK installed and
// running, its WebView's devtools forwarded to localhost:9222, and geospax-server on this computer with
// the phone link on (PHONE_URL: its https://10.0.2.2:<port>/#t=<code> address as the emulator sees it).
//
// 1. GPS: sets fixes with `adb emu geo fix` and checks the app's position matches them to a metre. The
//    emulator, like some phones, may only report a fix when the position changes, so the move to the second
//    place is a single fix the app's filter has to take on its own (it holds a jump back for up to 15 s),
//    and the fixes after it are a few centimetres apart so that each one reaches the app.
// 2. Pairing: the app asks the phone link hello through its HTTP plugin (self-signed certificate).
// 3. Sending: a point at the averaged position goes to GeoSpaX and lands in its inbox at those coordinates.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// the EGM2008 grid the app uses (apps/field/public/geoid, see apps/field/src/elevation.ts), bilinear
const G = new Int16Array(new Uint8Array(readFileSync(new URL('../apps/field/public/geoid/egm2008-15m.bin', import.meta.url))).buffer);
function geoid(lat, lon) {
  const r = (90 - lat) / 0.25, c = (((lon % 360) + 360) % 360) / 0.25, r0 = Math.floor(r), c0 = Math.floor(c), fr = r - r0, fc = c - c0;
  const at = (i, j) => G[i * 1441 + j] / 100;
  return at(r0, c0) * (1 - fr) * (1 - fc) + at(r0, c0 + 1) * (1 - fr) * fc + at(r0 + 1, c0) * fr * (1 - fc) + at(r0 + 1, c0 + 1) * fr * fc;
}
const PHONE_URL = process.env.PHONE_URL;
const INBOX = process.env.INBOX;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } console.log(`ok   ${m}`); };
process.on('unhandledRejection', (e) => { console.error(`FAIL ${e?.stack ?? e}`); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metres = (a, b) => {
  const R = 6371008.8, rad = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const geoFix = (lon, lat) => execFileSync('adb', ['emu', 'geo', 'fix', String(lon), String(lat), '40']);
// a fix a few centimetres off (at most 0.25 m), different each time
let jig = 0;
const jitter = (lon, lat) => { jig++; return [lon + ((jig % 5) - 2) * 0.000001, lat + ((jig % 3) - 1) * 0.000001]; };

// The WebView's own DevTools protocol (no Playwright: emulator WebViews can be years older than it supports)
let target;
for (let i = 0; i < 60 && !target; i++) {
  const list = await fetch('http://localhost:9222/json').then((r) => r.json()).catch(() => []);
  target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('about:'));
  if (!target) await sleep(1000);
}
ok(target, `app page found (${target?.url})`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
// the app can be killed under the test (on the emulator Google Play services sometimes restarts, and
// Android stops apps that use its fonts provider): say so rather than wait for ever
ws.onclose = () => { console.error('FAIL the app\'s page went away (app stopped or killed)'); process.exit(1); };
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method}: no answer from the app in 30 s`)); }, 30_000);
  pending.set(id, (d) => { clearTimeout(timer); res(d); });
  ws.send(JSON.stringify({ id, method, params }));
});
/** Run `fn` (a function, given `arg`) in the page and return its JSON result. */
async function evaluate(fn, arg) {
  const r = await cdp('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
const page = { evaluate, textContent: (sel) => evaluate((s) => document.querySelector(s)?.textContent ?? null, sel) };
for (let i = 0; i < 60 && !(await evaluate(() => !!window.__field)); i++) await sleep(1000);
ok(await evaluate(() => !!window.__field), 'app started (window.__field)');

// 1. GPS: two places a few km apart (a real move), each held for some seconds as a phone standing still
for (const [lon, lat] of [[147.1503, -6.7219], [147.1812, -6.7344]]) {
  const t0 = Date.now();
  let fix = null;
  // one fix, then wait: the app must take it without more (again every 20 s in case one got lost)
  for (let i = 0; Date.now() - t0 < 60_000; i++) {
    if (i % 20 === 0) geoFix(...jitter(lon, lat));
    await sleep(1000);
    fix = await page.evaluate(() => window.__field.fix());
    if (fix && metres([fix.lon, fix.lat], [lon, lat]) < 1) break;
  }
  ok(fix && metres([fix.lon, fix.lat], [lon, lat]) < 1, `GPS fix ${lon}, ${lat} → app has ${fix?.lon}, ${fix?.lat} (±${fix?.acc} m) after ${Math.round((Date.now() - t0) / 1000)} s`);
  // standing there: fixes a few centimetres apart, each a new one for the emulator to report
  for (let i = 0; i < 4; i++) { geoFix(...jitter(lon, lat)); await sleep(1000); }
  const here = await page.evaluate(() => window.__field.here());
  ok(here && metres([here[0], here[1]], [lon, lat]) < 1, `point position (averaged) within 1 m: ${here?.[0]}, ${here?.[1]}`);
  // the emulator's 40 m is above the ellipsoid; the app saves the height above sea level (40 m minus the geoid)
  const want = 40 - geoid(lat, lon);
  ok(here[2] != null && Math.abs(here[2] - want) < 1, `height above sea level from the fix: ${here[2]} m, expected ${want.toFixed(2)} m`);
  const hs = await page.evaluate(() => window.__field.heights());
  ok(hs.best?.source === 'gnss', `height source: ${hs.best?.source} (GPS and geoid; the emulator has no barometer: ${hs.baro ? 'has one' : 'none'})`);
}
const blocked = await page.evaluate(() => window.__field.cspBlocked);
ok(blocked.length === 0, `nothing blocked by the content security policy (${blocked.join(', ') || 'none'})`);
const chip = await page.textContent('#gps');
ok(/GPS ±\d+ m/.test(chip ?? ''), `status chip shows the accuracy: "${chip}"`);

// 2 + 3. Pair with the phone link and send a point
if (PHONE_URL) {
  const res = await page.evaluate(async (url) => {
    const f = window.__field;
    const link = f.parseLink(url);
    if (!link) return { error: 'bad link' };
    try {
      const h = await f.hello(link);
      const v = f.here();
      const rec = { id: 'emu-test', kind: 'point', coords: [v], note: 'emulator test', created: Date.now(), sent: false, photos: [] };
      const n = await f.send(link, [rec], () => {});
      return { h, n, v };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }, PHONE_URL);
  ok(!res.error, `paired and sent: ${JSON.stringify(res.error ?? res.h)}`);
  ok(res.n === 1, `1 file sent (${res.n})`);
  if (INBOX) {
    let found = null;
    for (let i = 0; i < 20 && !found; i++) {
      const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
      found = walk(INBOX).find((p) => p.endsWith('.geojson'));
      if (!found) await sleep(500);
    }
    ok(found, `GeoSpaX received the file (${found})`);
    const pt = JSON.parse(readFileSync(found, 'utf8')).features[0].geometry.coordinates;
    ok(metres(pt, [res.v[0], res.v[1]]) < 0.01 && metres(pt, [147.1812, -6.7344]) < 1, `received point at ${pt} (GPS fix 147.1812, -6.7344)`);
  }
}
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync(process.env.SHOT ?? 'field-emulator.png', Buffer.from(shot.result.data, 'base64'));
ws.onclose = null;
ws.close();
console.log('field app on the emulator: all checks passed');
