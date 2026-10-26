// The field app's GPS filter (apps/field/src/geo.ts): cached, coarse and jumping fixes are dropped and a
// point is the weighted average of the last seconds' good fixes.
//   node --experimental-strip-types scripts/test-field-gps.mjs
import assert from 'node:assert/strict';

globalThis.window = {};
const { FixFilter, metres } = await import('../apps/field/src/geo.ts');

const T = 1_700_000_000_000;
const at = (s, lon, lat, acc) => ({ lon, lat, acc, ele: 10, t: T + s * 1000 });
const f = new FixFilter(T);

assert.equal(f.add(at(-60, 147.15, -6.72, 5)), null, 'a cached fix from before the start is dropped');
assert.equal(f.add(at(1, 147.16, -6.73, 900)), null, 'a cell-tower guess is dropped');
assert.ok(f.add(at(2, 147.15, -6.72, 8)), 'a good fix is used');
assert.equal(f.add(at(2, 147.15, -6.72, 8)), null, 'the same fix twice is used once');
assert.equal(f.add(at(3, 147.20, -6.72, 8)), null, 'a 5 km jump in 1 s is dropped');
assert.ok(f.add(at(4, 147.15001, -6.72, 4)), 'the next good fix is used');
// standing still: fixes scattered around the true spot average back to it
const truth = [147.15, -6.72];
for (let i = 5; i < 15; i++) f.add(at(i, truth[0] + (i % 2 ? 1 : -1) * 0.00003, truth[1] + (i % 3 - 1) * 0.00003, 4));
const b = f.best(T + 15_000);
assert.ok(metres([b.lon, b.lat], truth) < 1.5, `average within 1.5 m (${metres([b.lon, b.lat], truth).toFixed(2)} m)`);
assert.equal(b.acc, 4, 'reported accuracy is the best single fix, not better');
assert.equal(f.best(T + 200_000), null, 'no position 2 minutes after the last fix');
// three jumps in a row are a real move (the earlier fix was the wrong one)
const g = new FixFilter(T);
g.add(at(1, 140, -6, 5));
for (let i = 2; i < 4; i++) assert.equal(g.add(at(i, 147.15, -6.72, 5)), null);
assert.ok(g.add(at(4, 147.15, -6.72, 5)), 'third jump accepted');
assert.ok(metres([g.best(T + 4000).lon, g.best(T + 4000).lat], [147.15, -6.72]) < 1, 'old fixes dropped from the average');
console.log('field GPS filter: all checks passed');
