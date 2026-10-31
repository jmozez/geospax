// Photo bearings and voice notes in the field app (apps/field/src/capture.ts), and that both travel with the
// records: in the GeoJSON sent to GeoSpaX, the upload of each photo (its bearing) and of each voice note,
// and in the full backup and restore.
//   node --experimental-strip-types scripts/test-field-capture.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';

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
class FR { readAsDataURL(b) { b.arrayBuffer().then((a) => { this.result = `data:${b.type};base64,${Buffer.from(a).toString('base64')}`; this.onload(); }); } }
globalThis.FileReader = FR;

const C = await import('../apps/field/src/capture.ts');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// the compass: iOS gives the heading directly; Android an absolute alpha counted the other way round
near(C.headingFrom({ webkitCompassHeading: 237 }), 237, 'iOS heading');
near(C.headingFrom({ alpha: 90, absolute: true }), 270, 'Android alpha 90 faces west');
near(C.headingFrom({ alpha: 0, absolute: true }), 0, 'north');
near(C.headingFrom({ alpha: 350, absolute: true }, 90), 100, 'landscape turns the camera 90°');
assert.equal(C.headingFrom({ alpha: 90, absolute: false }), null, 'a relative alpha is not a bearing');
assert.equal(C.headingFrom({}), null);

// averaging across north does not point south
near(C.meanAngle([350, 10]), 0, 'across north');
near(C.meanAngle([80, 100]), 90, 'east');
assert.equal(C.meanAngle([]), null);
assert.equal(C.meanAngle([0, 180]), null, 'opposite readings say nothing');
assert.equal(C.fmtBearing(237), '237° WSW');
assert.equal(C.fmtBearing(225), '225° SW');
assert.equal(C.fmtBearing(359.7), '0° N');
assert.equal(C.fmtBearing(null), 'no compass');

// readings older than two seconds drop out; a shaky hand is smoothed
const k = new C.Compass();
k.add(10, 0); k.add(200, 1000); k.add(210, 2500); k.add(null, 2600);
near(k.bearing(2600), 205, 'only the last two seconds');
assert.equal(k.bearing(9000), null, 'stale compass gives no bearing');

// voice notes: the first format the phone supports, a name with the time, and the length shown
assert.equal(C.pickMime((m) => m === 'audio/mp4'), 'audio/mp4', 'iOS records AAC');
assert.equal(C.pickMime((m) => m.startsWith('audio/webm')), 'audio/webm;codecs=opus', 'Android records Opus');
assert.equal(C.pickMime(() => { throw new Error('old phone'); }), '');
assert.equal(C.voiceName(Date.UTC(2026, 10, 1, 3, 4, 5), 'audio/mp4'), 'voice-2026-11-01-03-04-05.m4a');
assert.equal(C.voiceExt('audio/webm;codecs=opus'), 'webm');
assert.equal(C.fmtDur(75_000), '1:15');
assert.equal(C.fmtDur(4_400), '0:04');
assert.equal(C.MAX_VOICE_MS, 300_000);

// a photo point with a bearing and a voice note, as sent to GeoSpaX
const S = await import('../apps/field/src/sync.ts');
const B = await import('../apps/field/src/basics.ts');
const rec = {
  id: 'r1', kind: 'point', coords: [[147.18, -9.44, 41.2, 1_793_000_000_000, 4]], note: 'Culvert outlet', created: 1_793_000_000_000, sent: false,
  photos: [{ id: 'p1', name: 'photo-1.jpg', blob: new Blob(['jpeg'], { type: 'image/jpeg' }), lon: 147.18, lat: -9.44, acc: 4, ts: 1_793_000_000_000, bearing: 237.44 },
           { id: 'p2', name: 'photo-2.jpg', blob: new Blob(['jpeg2'], { type: 'image/jpeg' }), lon: 147.18, lat: -9.44, acc: 4, ts: 1_793_000_001_000, bearing: null }],
  voice: [{ id: 'v1', name: 'voice-1.webm', blob: new Blob(['opus'], { type: 'audio/webm' }), ts: 1_793_000_002_000, ms: 12_000, lon: 147.18, lat: -9.44 }],
};
const props = JSON.parse(S.geojson([rec])).features[0].properties;
assert.equal(props.photo_bearings, '237;', 'one bearing per photo, blank where there was no compass');
assert.equal(props.voice_notes, 'voice-1.webm');
assert.equal(JSON.parse(S.geojson([{ ...rec, photos: [], voice: undefined }])).features[0].properties.voice_notes, null, 'older records have no voice notes');

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { calls.push({ url: new URL(url), body: init.body }); return new Response('{"ok":true}', { status: 200 }); };
const n = await S.send({ base: 'http://pc:8765', token: 'tok' }, [rec], () => {});
assert.equal(n, 4, 'GeoJSON, two photos and the voice note');
const up = calls.filter((c) => c.url.pathname === '/api/phone/upload');
assert.equal(up.find((c) => c.url.searchParams.get('name') === 'photo-1.jpg').url.searchParams.get('dir'), '237.4', 'the bearing goes with the photo');
assert.equal(up.find((c) => c.url.searchParams.get('name') === 'photo-2.jpg').url.searchParams.get('dir'), null);
const vc = up.find((c) => c.url.searchParams.get('name') === 'voice-1.webm');
assert.ok(vc, 'the voice note is uploaded');
assert.equal(await vc.body.text(), 'opus');

// the full backup keeps the voice notes and bearings; restoring brings them back as files
globalThis.fetch = realFetch;
const back = await B.restoreJson(await B.backupJson([rec]));
assert.equal(back[0].photos[0].bearing, 237.44);
assert.equal(back[0].voice[0].name, 'voice-1.webm');
assert.equal(await back[0].voice[0].blob.text(), 'opus');
const old = await B.restoreJson(JSON.stringify({ app: 'geospax-field', records: [{ ...rec, photos: [], voice: undefined }] }));
assert.deepEqual(old[0].voice, [], 'a backup from before voice notes restores');
assert.equal(B.toGeoJson([rec]).features[0].properties.photo_bearings, '237;');

console.log('field capture: photo bearings and voice notes OK');
