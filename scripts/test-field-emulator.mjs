// GeoSpaX Field on an Android emulator (CI: the android-emulator job). Needs a debug APK installed and
// running, its WebView's devtools forwarded to localhost:9222, and geospax-server on this computer with
// the phone link on (PHONE_URL: its https://10.0.2.2:<port>/#t=<code> address as the emulator sees it).
//
// 1. GPS: sets fixes with `adb emu geo fix` and checks the app's position matches them to a metre.
// 2. Pairing: the app asks the phone link hello through its HTTP plugin (self-signed certificate).
// 3. Sending: a point at the averaged position goes to GeoSpaX and lands in its inbox at those coordinates.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
const cdp = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
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
  while (Date.now() - t0 < 60_000) {
    geoFix(lon, lat);
    await sleep(1000);
    fix = await page.evaluate(() => window.__field.fix());
    if (fix && metres([fix.lon, fix.lat], [lon, lat]) < 1) break;
  }
  ok(fix && metres([fix.lon, fix.lat], [lon, lat]) < 1, `GPS fix ${lon}, ${lat} → app has ${fix?.lon}, ${fix?.lat} (±${fix?.acc} m)`);
  for (let i = 0; i < 4; i++) { geoFix(lon, lat); await sleep(1000); }
  const here = await page.evaluate(() => window.__field.here());
  ok(here && metres([here[0], here[1]], [lon, lat]) < 1, `point position (averaged) within 1 m: ${here?.[0]}, ${here?.[1]}`);
  ok(here[2] != null && Math.abs(here[2] - 40) < 1, `elevation from the fix: ${here[2]} m`);
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
ws.close();
console.log('field app on the emulator: all checks passed');
