// Native Bluetooth GNSS in the Android app (apps/field/src/btnative.ts and src-tauri/plugins/gnss): the
// permission flow, the device list and a receiver streaming NMEA through a stand-in for the plugin, and
// that the plugin's commands, permissions and manifest agree. Real receivers need a phone (see the PR).
//   node --experimental-strip-types scripts/test-field-btnative.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
  return next(spec, ctx);
}`));
globalThis.window = {};
const B = await import('../apps/field/src/btnative.ts');
const sum = (body) => { let x = 0; for (const c of body) x ^= c.charCodeAt(0); return `$${body}*${x.toString(16).toUpperCase().padStart(2, '0')}`; };

// a stand-in for the plugin
function fake({ granted = true, allow = true, devices = [], name = 'R10' } = {}) {
  const calls = [];
  let on = null;
  const b = {
    calls,
    push: (m) => on(m),
    channel: (f) => { on = f; return { id: 1 }; },
    async invoke(cmd, args) {
      calls.push([cmd, args]);
      if (cmd === 'plugin:gnss|check_permissions') return { bluetooth: granted ? 'granted' : 'prompt' };
      if (cmd === 'plugin:gnss|request_permissions') return { bluetooth: allow ? 'granted' : 'denied' };
      if (cmd === 'plugin:gnss|devices') return { devices };
      if (cmd === 'plugin:gnss|connect') return { name };
      if (cmd === 'plugin:gnss|disconnect') return null;
      throw new Error(`unknown ${cmd}`);
    },
  };
  return b;
}

// ---- modes and sorting
assert.equal(B.modeFor({ type: 'classic' }), 'spp');
assert.equal(B.modeFor({ type: 'dual' }), 'spp');
assert.equal(B.modeFor({ type: 'ble' }), 'ble');
const ds = [
  { name: 'Zeta BLE', address: 'C', type: 'ble', paired: false },
  { name: 'Emlid Reach', address: 'A', type: 'classic', paired: true },
  { name: 'Alpha BLE', address: 'B', type: 'ble', paired: false },
];
assert.deepEqual(B.sortDevices(ds).map((d) => d.address), ['A', 'B', 'C'], 'paired first, then by name');

// ---- permissions
let b = fake();
await B.ensurePermission(b);
assert.deepEqual(b.calls.map((c) => c[0]), ['plugin:gnss|check_permissions'], 'granted: no prompt');
b = fake({ granted: false });
await B.ensurePermission(b);
assert.deepEqual(b.calls[1], ['plugin:gnss|request_permissions', { permissions: ['bluetooth'] }], 'asks for the bluetooth alias');
b = fake({ granted: false, allow: false });
await assert.rejects(B.ensurePermission(b), /Nearby devices/);
await assert.rejects(B.listDevices(4000, b), /Nearby devices/, 'no list without permission');

// ---- device list
b = fake({ devices: ds });
const list = await B.listDevices(2500, b);
assert.equal(list[0].name, 'Emlid Reach');
assert.deepEqual(b.calls.at(-1), ['plugin:gnss|devices', { scanMs: 2500 }]);

// ---- a receiver streaming NMEA in odd chunks
const gga = sum('GNGGA,021530.00,0926.58600,S,14710.81800,E,4,18,0.6,52.30,M,71.20,M,1.0,0000');
const gga2 = sum('GNGGA,021531.00,0926.58610,S,14710.81810,E,5,17,0.7,52.40,M,71.20,M,1.0,0000');
for (const [dev, mode] of [[ds[1], 'spp'], [ds[0], 'ble']]) {
  b = fake({ name: '' });
  const fixes = [];
  const gone = [];
  const rx = await B.connectNative(dev, (f) => fixes.push(f), (e) => gone.push(e), b);
  const c = b.calls.find((x) => x[0] === 'plugin:gnss|connect');
  assert.equal(c[1].address, dev.address);
  assert.equal(c[1].mode, mode, `${dev.type} connects over ${mode}`);
  assert.ok(c[1].onData, 'data channel passed');
  assert.equal(rx.name, dev.name, 'falls back to the device name');
  const stream = `noise\r\n${gga}\r\n${gga2}\r\n`;
  for (let i = 0; i < stream.length; i += 5) b.push({ text: stream.slice(i, i + 5) });
  assert.equal(fixes.length, 2, 'two fixes from two GGA sentences split in 5-byte chunks');
  assert.equal(fixes[0].quality, 'rtk-fixed');
  assert.equal(fixes[1].quality, 'rtk-float');
  assert.equal(fixes[0].sats, 18);
  assert.ok(Math.abs(fixes[0].lat + 9.4431) < 1e-6 && Math.abs(fixes[0].lon - 147.1803) < 1e-6);
  b.push({ closed: true, error: 'Connection lost' });
  b.push({ closed: true, error: 'again' });
  assert.deepEqual(gone, ['Connection lost'], 'gone reported once, with the reason');
}
// disconnecting ourselves is not reported as a loss
b = fake();
const gone = [];
const rx = await B.connectNative(ds[1], () => {}, (e) => gone.push(e), b);
assert.equal(rx.name, 'R10');
rx.disconnect();
await new Promise((r) => setTimeout(r, 0));
assert.equal(b.calls.at(-1)[0], 'plugin:gnss|disconnect');
b.push({ closed: true, error: null });
assert.deepEqual(gone, [], 'own disconnect is quiet');

// ---- the plugin agrees with itself and the app
const P = 'apps/field/src-tauri/plugins/gnss/';
const read = (p) => readFileSync(p, 'utf8');
const cmds = [...read(P + 'build.rs').split('];')[0].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
assert.deepEqual(cmds.sort(), ['check_permissions', 'connect', 'devices', 'disconnect', 'request_permissions']);
const perms = read(P + 'permissions/default.toml');
for (const c of cmds) assert.ok(perms.includes(`allow-${c.replace(/_/g, '-')}`), `default permission allows ${c}`);
const kt = read(P + 'android/src/main/java/GnssPlugin.kt');
for (const c of ['devices', 'connect', 'disconnect']) assert.match(kt, new RegExp(`@Command\\s+fun ${c}\\(`), `Kotlin command ${c}`);
assert.match(kt, /00001101-0000-1000-8000-00805F9B34FB/i, 'serial port profile UUID');
assert.match(kt, /6e400003-b5a3-f393-e0a9-e50e24dcca9e/i, 'Nordic UART TX');
assert.match(kt, /0000ffe1-0000-1000-8000-00805f9b34fb/i, 'HM-10 characteristic');
const mf = read(P + 'android/src/main/AndroidManifest.xml');
assert.match(mf, /BLUETOOTH_CONNECT/);
assert.match(mf, /BLUETOOTH_SCAN"[^>]*neverForLocation/, 'scan does not claim location');
assert.match(mf, /"android.permission.BLUETOOTH"[^>]*maxSdkVersion="30"/, 'legacy permission up to Android 11');
assert.match(read(P + 'src/lib.rs'), /register_android_plugin\("app\.geospax\.gnss", "GnssPlugin"\)/);
assert.match(read('apps/field/src-tauri/src/lib.rs'), /tauri_plugin_gnss::init\(\)/);
assert.ok(JSON.parse(read('apps/field/src-tauri/capabilities/mobile.json')).permissions.includes('gnss:default'));
console.log('field app native Bluetooth GNSS: all checks passed');
