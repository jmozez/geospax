// The field app's GPS filter (apps/field/src/geo.ts): cached, coarse and jumping fixes are dropped and a
// point is the weighted average of the last seconds' good fixes. A held-back jump becomes the position after
// three agreeing fixes, or after 15 s with nothing contradicting it (phones that only report on a change).
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
// a phone (or the Android emulator) that only reports a fix when the position changes: after a real move
// of 3.5 km there is one fix at the new place and then silence. It is held back at first, then taken.
const h = new FixFilter(T);
assert.ok(h.add(at(1, 147.1503, -6.7219, 5), T + 1000));
assert.ok(h.add(at(2, 147.15031, -6.7219, 5), T + 2000));
const moved = at(3, 147.1812, -6.7344, 5);
assert.equal(h.add(moved, T + 3000), null, 'a lone jump is held back');
assert.equal(h.tick(T + 10_000), null, 'still held after 7 s');
assert.equal(h.last.lon, 147.15031, 'the position stays put while the jump is held');
assert.equal(h.tick(T + 18_000), moved, 'taken after 15 s with nothing contradicting it');
assert.equal(h.tick(T + 19_000), null, 'taken once');
const hb = h.best(T + 18_000);
assert.ok(metres([hb.lon, hb.lat], [147.1812, -6.7344]) < 0.01, 'the average is the new place only');
assert.ok(h.add(at(20, 147.18121, -6.7344, 5), T + 20_000), 'fixes at the new place are used after it');
// a lone glitch on a phone that keeps reporting: the next fixes back at the real spot cancel it
const k = new FixFilter(T);
k.add(at(1, 147.1503, -6.7219, 5), T + 1000);
assert.equal(k.add(at(2, 147.1812, -6.7344, 5), T + 2000), null, 'a glitch is held back');
assert.ok(k.add(at(3, 147.15031, -6.7219, 5), T + 3000), 'a fix back at the real spot is used');
assert.equal(k.tick(T + 30_000), null, 'and the glitch is forgotten');
assert.equal(k.last.lon, 147.15031);
// two different glitches do not add up to a move; nor does a coarse one held for long
const m = new FixFilter(T);
m.add(at(1, 147.1503, -6.7219, 5), T + 1000);
assert.equal(m.add(at(2, 147.1812, -6.7344, 5), T + 2000), null);
assert.equal(m.add(at(3, 147.30, -6.80, 5), T + 3000), null, 'a jump elsewhere restarts the hold');
assert.equal(m.add(at(4, 147.1812, -6.7344, 5), T + 4000), null, 'three jumps that disagree are not a move');
assert.equal(m.tick(T + 16_000), null, 'the hold restarted with the last of them');
const c = new FixFilter(T);
c.add(at(1, 147.1503, -6.7219, 5), T + 1000);
assert.equal(c.add(at(2, 147.1812, -6.7344, 80), T + 2000), null);
assert.equal(c.tick(T + 60_000), null, 'a held jump worse than 50 m is never taken on time alone');
// three agreeing jumps scattered by a few metres are a move at once, averaged
const j = new FixFilter(T);
j.add(at(1, 147.1503, -6.7219, 5), T + 1000);
assert.equal(j.add(at(2, 147.1812, -6.7344, 5), T + 2000), null);
assert.equal(j.add(at(3, 147.18122, -6.7344, 5), T + 3000), null);
assert.ok(j.add(at(4, 147.18118, -6.7344, 5), T + 4000), 'third agreeing jump accepted');
const jb = j.best(T + 4000);
assert.ok(metres([jb.lon, jb.lat], [147.1812, -6.7344]) < 1, 'averaged over the three');
// the vertical accuracy of the averaged point is the best of the fixes that gave it a height
const v = new FixFilter(T);
v.add({ lon: 147, lat: -6, acc: 4, ele: 80, altAcc: 9, t: T + 1000 });
v.add({ lon: 147, lat: -6, acc: 4, ele: 82, altAcc: 6, t: T + 2000 });
assert.equal(v.best(T + 2000).altAcc, 6, 'vertical accuracy: the best single one');
assert.equal(v.best(T + 2000).ele, 81, 'heights averaged');
const nv = new FixFilter(T);
nv.add({ lon: 147, lat: -6, acc: 4, ele: null, t: T + 1000 });
assert.equal(nv.best(T + 1000).altAcc, null, 'no height, no vertical accuracy');
console.log('field GPS filter: all checks passed');
