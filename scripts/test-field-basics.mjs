// The field app's screens behind the ⋯ menu (apps/field/src/basics.ts): the GPS status rows (with the
// heights and their sources), settings, GeoJSON export, backup and restore, and the feedback link.
//   node --experimental-strip-types scripts/test-field-basics.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';

// the app's own imports leave out ".ts" (Vite adds it), and the map library needs a browser: stand-ins here
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'maplibre-gl') return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  if (spec.startsWith('.') && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
  return next(spec, ctx);
}`));
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
globalThis.window = {};
globalThis.__APP_VERSION__ = '3.1.0-test';
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'TestPhone/1.0' }, configurable: true });
class FR { readAsDataURL(b) { b.arrayBuffer().then((a) => { this.result = `data:${b.type};base64,${Buffer.from(a).toString('base64')}`; this.onload(); }); } }
globalThis.FileReader = FR;

const B = await import('../apps/field/src/basics.ts');

// settings: defaults, then saved ones; the terrain model is off unless switched on (it sends the position)
assert.deepEqual(B.settings(), { basemap: 'imagery', warnAcc: 30, keepAwake: false, tourDone: false, dem: false, batterySaver: 'auto' });
B.saveSettings({ dem: true, warnAcc: 10 });
assert.equal(B.settings().dem, true);
assert.equal(B.settings().warnAcc, 10);
store.set('geospax-field.settings', '{not json');
assert.equal(B.settings().dem, false, 'a broken setting falls back to the defaults');

// GPS status
const T = 1_700_000_000_000;
const fix = { lon: 146.9963, lat: -6.7275, acc: 4.2, ele: 100, altAcc: 6, t: T, speed: 1.5, heading: 90 };
const raw = { fix, count: 7, error: null, since: T - 60_000 };
const hs = { gnss: { value: 28, source: 'gnss', acc: 6 }, baro: { value: 29.5, source: 'baro', acc: 2 }, dem: null, best: { value: 28, source: 'gnss', acc: 6 } };
const rows = Object.fromEntries(B.gpsRows(fix, raw, T + 3000, hs));
assert.equal(rows.Quality, 'Good (±10 m or better)');
assert.equal(rows.Accuracy, '±4.2 m');
assert.equal(rows['Height above sea level'], '28.0 m (±6 m, GPS and EGM2008 geoid)');
assert.equal(rows['GPS height'], '100.0 m above the ellipsoid (±6 m)');
assert.equal(rows['From the barometer'], '29.5 m (±2 m, barometer, set from GPS)');
assert.equal(rows['From the terrain model'], 'off (see Settings)');
assert.equal(rows.Speed, '5.4 km/h');
assert.equal(rows.Heading, '90°');
assert.equal(rows['Last fix'], '3 s ago');
assert.equal(rows['Fixes received'], '7');
const none = Object.fromEntries(B.gpsRows(null, { fix: null, count: 0, error: 'Location is off', since: T }, T));
assert.equal(none.Quality, 'No usable fix yet');
assert.equal(none['Height above sea level'], 'not known');
assert.equal(none['From the barometer'], 'no barometer');
assert.equal(none['GPS height'], 'not reported');
assert.equal(none.Problem, 'Location is off');

// GeoJSON export: heights above sea level in the coordinates, the source in the properties
const pt = { id: 'a', kind: 'point', coords: [[146.99, -6.72, 28, T, 4]], note: 'peg', created: T, sent: false, photos: [], height: { value: 28, source: 'gnss', acc: 6 } };
const area = { id: 'b', kind: 'area', coords: [[0, 0, null, T, 5], [1, 0, null, T, 5], [1, 1, null, T, 5]], note: '', created: T, sent: true, photos: [] };
const fc = B.toGeoJson([pt, area]);
assert.deepEqual(fc.features[0].geometry, { type: 'Point', coordinates: [146.99, -6.72, 28] });
assert.equal(fc.features[0].properties.height_source, 'gnss');
assert.equal(fc.features[0].properties.height_acc_m, 6);
assert.equal(fc.features[1].geometry.type, 'Polygon');
assert.deepEqual(fc.features[1].geometry.coordinates[0].at(-1), [0, 0], 'the ring is closed');
assert.equal(fc.features[1].properties.height_m, null);

// backup and restore keep everything, photos included
const photo = { id: 'p', name: 'p.jpg', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), lon: 1, lat: 2, acc: 3, ts: T };
const text = await B.backupJson([{ ...pt, photos: [photo] }]);
const back = await B.restoreJson(text);
assert.equal(back[0].height.source, 'gnss');
assert.deepEqual([...new Uint8Array(await back[0].photos[0].blob.arrayBuffer())], [1, 2, 3]);
await assert.rejects(B.restoreJson('{"app":"other"}'), /not a GeoSpaX Field backup/);

// feedback opens the user's own mail app with the details filled in
const m = B.feedbackMailto('Hello');
assert.ok(m.startsWith(`mailto:${B.FEEDBACK_EMAIL}?subject=`));
assert.ok(decodeURIComponent(m).includes('GeoSpaX Field 3.1.0-test') && decodeURIComponent(m).includes('TestPhone/1.0'));
assert.ok(B.WHATS_NEW[0].version === '3.1.0' && B.WHATS_NEW[0].items.some((i) => i.includes('sea level')));
assert.equal(B.fmtBytes(2048), '2 KB');

console.log('field basics: all checks passed');
