// Profile chart maths and SVG (web/src/profile.ts), on a known-answer profile.
//   node --experimental-strip-types scripts/test-profile.mjs
import assert from 'node:assert/strict';
import { buildProfile, elevClasses, kmTicks, nearest, niceStep, profileFields, profileStats, profileSvg } from '../web/src/profile.ts';

// a 10 km line due east, up 0 → 500 m, down to 300 m, up to 800 m (climb 1000, descent 200)
const zs = [0, 250, 500, 400, 300, 550, 800];
const rows = zs.map((z, i) => ({ d: (i * 10000) / 6, z, lon: 147 + i * 0.015, lat: -6.7 }));
const p = buildProfile(rows);
assert.equal(Math.round(p.length), 10000);
assert.equal(p.min, 0); assert.equal(p.max, 800);
assert.equal(p.climb, 1000); assert.equal(p.descent, 200);
assert.equal(Math.round(p.maxAt), 10000);
// swapping the ends: A becomes the 800 m end, climb and descent swap
const r = buildProfile(rows, true);
assert.equal(r.samples[0].z, 800); assert.equal(r.samples.at(-1).z, 0);
assert.equal(r.climb, 200); assert.equal(r.descent, 1000); assert.equal(Math.round(r.maxAt), 0);
// km fields are scaled; samples come back sorted
assert.equal(buildProfile([{ d: 2, z: 5, lon: 0, lat: 0 }, { d: 1, z: 1, lon: 0, lat: 0 }], false, true).length, 2000);
// ticks every 2 km, interpolated along the line
const t = kmTicks(p, 2);
assert.deepEqual(t.map((x) => x.km), [2, 4, 6, 8]);
assert.ok(Math.abs(t[0].lon - (147 + 0.2 * 0.09)) < 1e-9);
assert.equal(nearest(p, 3400).z, 500);
assert.equal(niceStep(39.1, 8), 5);
assert.equal(elevClasses(buildProfile([{ d: 0, z: 0, lon: 0, lat: 0 }, { d: 1, z: 1726, lon: 0, lat: 0 }])).length, 7); assert.equal(niceStep(1730, 4), 500);
assert.deepEqual(profileFields([{ name: 'profile' }, { name: 'dist_m' }, { name: 'elev' }]), { dist: 'dist_m', elev: 'elev' });
assert.equal(profileFields([{ name: 'name' }]), null);
assert.deepEqual(profileStats(p).map(([k]) => k), ['Length', 'Min', 'Max', 'Relief', 'Total climb', 'Total descent']);
const svg = profileSvg(p, { a: 'Coast', b: 'Ridge' });
for (const s of ['Distance from A (km)', 'Elevation (m)', 'A · Coast', 'B · Ridge', 'Max 800 m', 'Min 0 m', '<path d="M']) assert.ok(svg.includes(s), s);
assert.deepEqual(elevClasses(p).map((c) => [c.lo, c.hi]), [[0, 200], [200, 400], [400, 600], [600, 800]]);
assert.equal(elevClasses(p)[0].color, '#1a9850'); assert.equal(elevClasses(p).at(-1).color, '#8c510a');
assert.throws(() => buildProfile([]));
console.log('profile chart: ok');
