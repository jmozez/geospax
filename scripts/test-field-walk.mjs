// Tracks, walk-to-measure and navigate to a point in the field app (apps/field/src/walk.ts): areas, lengths,
// track statistics, which walked fixes become vertices, bearings, the arrow's turn, arrival and typed
// coordinates.
//   node --experimental-strip-types scripts/test-field-walk.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
  return next(spec, ctx);
}`));
globalThis.window = {};
const W = await import('../apps/field/src/walk.ts');
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// a 100 m by 100 m square near Port Moresby is one hectare (metres of longitude shrink with latitude)
const lat0 = -9.44, lon0 = 147.18;
const dLat = 100 / 111_195, dLon = 100 / (111_195 * Math.cos((lat0 * Math.PI) / 180));
const sq = [[lon0, lat0], [lon0 + dLon, lat0], [lon0 + dLon, lat0 + dLat], [lon0, lat0 + dLat]];
close(W.areaM2(sq), 10_000, 30, 'one hectare');
close(W.areaM2([...sq].reverse()), 10_000, 30, 'either way round');
close(W.areaM2([...sq, sq[0]]), 10_000, 30, 'closed ring');
assert.equal(W.areaM2(sq.slice(0, 2)), 0);
close(W.lengthM(sq), 300, 1, 'three sides');
close(W.lengthM(sq, true), 400, 1, 'perimeter');
assert.equal(W.fmtArea(8_421.4), '8421 m²');
assert.equal(W.fmtArea(42_000), '4.20 ha');
assert.equal(W.fmtArea(2_500_000), '250 ha (2.50 km²)');
assert.equal(W.fmtLen(268.4), '268 m');
assert.equal(W.fmtLen(1_240), '1.24 km');
assert.equal(W.fmtTime(125_000), '2:05');
assert.equal(W.fmtTime(3_725_000), '1:02:05');

// a track: 10 legs of 50 m a minute apart, then a 20-minute break, then one more leg; heights with noise
const t0 = 1_793_000_000_000;
const coords = [];
for (let i = 0; i <= 10; i++) coords.push([lon0 + (i * 50) / 111_195 / Math.cos((lat0 * Math.PI) / 180), lat0, 40 + (i % 2) + i * 2, t0 + i * 60_000, 5]);
const last = coords[10];
coords.push([last[0] + 50 / 109_700, lat0, last[2], last[3] + 20 * 60_000, 5]);
const s = W.trackStats(coords);
close(s.distance, 550, 3, 'distance');
assert.equal(s.duration, 30 * 60_000, 'start to end, break included');
assert.equal(s.moving, 10 * 60_000, 'the break does not count as moving');
close(s.speed, 550 / 600, 0.01, 'moving speed');
close(s.gain, 20, 2, 'height gained, 1 m wobbles ignored');
assert.equal(s.loss, 0);
assert.deepEqual(W.trackStats([]), { distance: 0, duration: 0, moving: 0, speed: null, gain: 0, loss: 0 });

// walking a boundary: a vertex only from good fixes, and only after 3 m
const v = [lon0, lat0, null, t0, 4];
assert.equal(W.takeFix(undefined, lon0, lat0, 4), true, 'the first good fix');
assert.equal(W.takeFix(v, lon0 + 1 / 109_700, lat0, 4), false, '1 m: standing still');
assert.equal(W.takeFix(v, lon0 + 5 / 109_700, lat0, 4), true, '5 m on');
assert.equal(W.takeFix(v, lon0 + 5 / 109_700, lat0, 35), false, '±35 m is too rough to measure with');
assert.equal(W.takeFix(v, lon0 + 5 / 109_700, lat0, 35, 3, 50), true, 'but fine for a track');
assert.equal(W.takeFix(v, lon0 + 5 / 109_700, lat0, NaN), false, 'no accuracy, no vertex');

// navigation: bearings, the arrow, arrival, time to go
close(W.bearingTo([lon0, lat0], [lon0, lat0 + 0.01]), 0, 0.01, 'north');
close(W.bearingTo([lon0, lat0], [lon0 + 0.01, lat0]), 90, 0.01, 'east');
close(W.bearingTo([lon0, lat0], [lon0, lat0 - 0.01]), 180, 0.01, 'south');
close(W.bearingTo([lon0, lat0], [lon0 - 0.01, lat0 - 0.01]), 224.7, 0.3, 'south-west');
assert.equal(W.turn(10, 350), 20, 'target just right of north while facing just left of it');
assert.equal(W.turn(350, 10), -20);
assert.equal(W.turn(180, 0), -180);
assert.equal(W.arrived(4, 3), true);
assert.equal(W.arrived(8, 3), false);
assert.equal(W.arrived(8, 12), true, 'within the GPS accuracy');
const n = W.navTo({ lon: lon0, lat: lat0, acc: 4, speed: 1.25 }, [lon0, lat0 + 1000 / 111_195]);
close(n.distance, 1000, 2, 'one kilometre');
close(n.eta, 800_000, 2_000, 'at walking pace');
assert.equal(n.arrived, false);
assert.equal(W.navTo({ lon: lon0, lat: lat0, acc: 4, speed: 0 }, [lon0, lat0 + 0.001]).eta, null, 'standing: no time to go');

// typed coordinates
assert.deepEqual(W.parseCoords('-9.4431, 147.1803'), [147.1803, -9.4431]);
assert.deepEqual(W.parseCoords('147.1803 -9.4431'), [147.1803, -9.4431], 'longitude first when it can only be one');
const dms = W.parseCoords(`9°26'35"S 147°10'49"E`);
close(dms[1], -9.443056, 1e-5, 'DMS latitude');
close(dms[0], 147.180278, 1e-5, 'DMS longitude');
const dm = W.parseCoords('9° 26.5′ S, 147° 10.8′ E');
close(dm[1], -9.441667, 1e-5, 'degrees and decimal minutes');
assert.equal(W.parseCoords('hello'), null);
assert.equal(W.parseCoords('95, 200'), null);
assert.equal(W.parseCoords('1 2 3'), null);

console.log('field walk: tracks, measuring and navigation OK');
