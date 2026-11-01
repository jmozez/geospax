// Custom forms, scanned codes, plots and transects in the field app (apps/field/src/forms.ts and plots.ts):
// reading and checking forms, turning typed answers into values, what a QR code holds, plot outlines and
// areas, and transect stations.
//   node --experimental-strip-types scripts/test-field-forms.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
  return next(spec, ctx);
}`));
globalThis.window = {};
const F = await import('../apps/field/src/forms.ts');
const P = await import('../apps/field/src/plots.ts');
const W = await import('../apps/field/src/walk.ts');
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ---- forms
for (const f of F.BUILT_IN) assert.deepEqual(F.parseForm(JSON.stringify(f)), f, `${f.name} reads back as itself`);
assert.equal(F.keyOf('Tree tag'), 'tree_tag');
assert.equal(F.keyOf('2nd visit?'), 'f_2nd_visit');
assert.equal(F.keyOf('Māori name'), 'maori_name');
const wp = F.parseForm({ name: ' Water point ', fields: [
  { label: 'Source', type: 'choice', options: ['Tank', ' Well', 'Tank', '', 'River'] },
  { label: 'Working', type: 'yesno', required: true },
  { label: 'Flow', type: 'number', unit: 'L/min', min: 0, max: 500 },
  { label: 'Source' },
  { label: 'Pump tag', type: 'code' },
] });
assert.equal(wp.name, 'Water point');
assert.deepEqual(wp.fields[0].options, ['Tank', 'Well', 'River'], 'choices are tidied');
assert.deepEqual(wp.fields.map((f) => f.key), ['source', 'working', 'flow', 'source_2', 'pump_tag'], 'keys are unique');
assert.equal(wp.fields[3].type, 'text', 'text by default');
assert.throws(() => F.parseForm('not json'), /not JSON/);
assert.throws(() => F.parseForm({ name: 'x', fields: [] }), /at least one field/);
assert.throws(() => F.parseForm({ fields: [{ label: 'a' }] }), /needs a name/);
assert.throws(() => F.parseForm({ name: 'x', fields: [{ label: 'a', type: 'photo' }] }), /unknown type/);
assert.throws(() => F.parseForm({ name: 'x', fields: [{ label: 'a', type: 'choice' }] }), /needs some choices/);
assert.throws(() => F.parseForm({ name: 'x', fields: [{ type: 'text' }] }), /Field 1 needs a label/);

const v = F.coerce(wp, { source: 'Well', working: 'yes', flow: '12,5', source_2: '  ', pump_tag: 'PNG-0042' });
assert.deepEqual(v, { source: 'Well', working: true, flow: 12.5, source_2: null, pump_tag: 'PNG-0042' });
assert.deepEqual(F.check(wp, v), []);
assert.deepEqual(F.check(wp, { ...v, working: null }), ['Working is needed.']);
assert.deepEqual(F.check(wp, { ...v, flow: 900 }), ['Flow must be at most 500 L/min.']);
assert.deepEqual(F.check(wp, { ...v, flow: NaN }), ['Flow must be a number.']);
assert.deepEqual(F.check(wp, { ...v, source: 'Lake' }), ['Source must be one of the choices.']);
const tree = F.BUILT_IN.find((f) => f.name === 'Tree plot');
assert.deepEqual(F.check(tree, F.coerce(tree, { dbh_cm: '0.5' })), ['Species is needed.', 'Diameter at breast height must be at least 1 cm.']);
assert.deepEqual(F.check(tree, F.coerce(tree, { species: 'Kwila', dbh_cm: '64', planted: 'x' })), []);
assert.equal(F.summary(wp, v), 'Well · Working: yes · Flow: 12.5 L/min');
assert.equal(F.summary(undefined, { plot_id: 'P1' }), 'P1');
assert.equal(F.summary(wp, undefined), '');

assert.equal(F.qrKind(JSON.stringify(wp)), 'form');
assert.equal(F.qrKind('https://192.168.1.20:8765/#t=abc'), 'link');
assert.equal(F.qrKind('PNG-0042'), 'code');
assert.equal(F.qrKind('{"tag": 1}'), 'code');

// ---- plots: standard sizes cover 100, 400, 500 and 1000 m² (circles) and 1 ha for a 100 m square
const lon = 147.1803, lat = -9.4431;
const circ = P.plot(lon, lat, 'circle', 11.28);
assert.equal(circ.length, 48);
for (const p of circ) close(W.lengthM([[lon, lat], p]), 11.28, 0.01, 'on the circle');
close(W.areaM2(circ), P.plotArea('circle', 11.28), 3, 'circle area near 400 m²');
close(P.plotArea('circle', 17.84), 1000, 1, '17.84 m radius');
const sq = P.plot(lon, lat, 'square', 100);
assert.equal(sq.length, 4);
close(W.areaM2(sq), 10_000, 5, 'one hectare square');
close(W.lengthM(sq, true), 400, 0.5, 'its perimeter');
close(sq[0][1], sq[3][1], 1e-6, 'the north side runs east to west');
close(W.areaM2(P.plot(lon, lat, 'square', 20, 30)), 400, 0.5, 'turned square keeps its area');
assert.throws(() => P.plot(lon, lat, 'circle', 0), /needs a size/);
const [ex, ey] = P.dest(lon, lat, 90, 1000);
close(ey, lat, 1e-4, 'east keeps the latitude');
close(W.lengthM([[lon, lat], [ex, ey]]), 1000, 0.01, '1 km east');
close(W.bearingTo([lon, lat], P.dest(lon, lat, 237, 500)), 237, 0.01, 'bearing round trip');
close(P.dest(179.999, 0, 90, 1000)[0], -179.992, 0.001, 'across the date line');

// ---- transects
const t = P.transect(lon, lat, 45, 100, 20);
assert.deepEqual(t.stations.map((s) => s.m), [0, 20, 40, 60, 80, 100]);
assert.deepEqual(t.stations[0].at, [lon, lat]);
for (const s of t.stations) close(W.lengthM([[lon, lat], s.at]), s.m, 0.01, `station ${s.m} m`);
close(W.bearingTo(t.line[0], t.line[1]), 45, 0.01, 'on its bearing');
assert.deepEqual(P.transect(lon, lat, 0, 25, 10).stations.map((s) => s.m), [0, 10, 20, 25], 'a short last leg ends at the end');
assert.deepEqual(P.transect(lon, lat, 0, 30, 10).stations.map((s) => s.m), [0, 10, 20, 30]);
assert.throws(() => P.transect(lon, lat, 0, 1000, 1), /more than 500/);
assert.throws(() => P.transect(lon, lat, 0, 0, 10), /needs a length/);
assert.throws(() => P.transect(lon, lat, 0, 10, 0), /spacing/);

console.log('field forms: custom forms, codes, plots and transects OK');
