// Bluetooth GNSS, stakeout and quality checks in the field app (apps/field/src/gnss.ts, stakeout.ts, qc.ts):
// reading NMEA sentences into fixes, offsets to a design point, pasted design points, and the checks.
//   node --experimental-strip-types scripts/test-field-gnss-qc.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
  return next(spec, ctx);
}`));
globalThis.window = {};
const G = await import('../apps/field/src/gnss.ts');
const S = await import('../apps/field/src/stakeout.ts');
const Q = await import('../apps/field/src/qc.ts');
const F = await import('../apps/field/src/forms.ts');
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const sum = (body) => { let x = 0; for (const c of body) x ^= c.charCodeAt(0); return `$${body}*${x.toString(16).toUpperCase().padStart(2, '0')}`; };

// ---- NMEA
assert.deepEqual(G.sentence('$GPGGA,1,2*00'), null, 'bad checksum');
assert.deepEqual(G.sentence(sum('GNGSA,A,3')), ['GSA', 'A', '3']);
close(G.nmeaDeg('0926.586', 'S'), -9.44310, 1e-6, 'latitude');
close(G.nmeaDeg('14710.818', 'E'), 147.18030, 1e-6, 'longitude');
assert.equal(G.nmeaDeg('', 'N'), null);

const gga = sum('GNGGA,021530.00,0926.58600,S,14710.81800,E,4,18,0.6,52.30,M,71.20,M,1.0,0000');
const gst = sum('GNGST,021530.00,0.9,0.010,0.008,12,0.012,0.009,0.020');
const rmc = sum('GNRMC,021530.00,A,0926.58600,S,14710.81800,E,1.97,123.4,011126,,,R');
const n = new G.Nmea();
const now = Date.UTC(2026, 10, 1, 2, 15, 31);
// split across chunks anywhere, with junk and a corrupt sentence
const stream = `${rmc}\r\n${gst}\r\njunk\r\n$GPGGA,bad*11\r\n${gga}\r\n`;
const got = [];
for (let i = 0; i < stream.length; i += 7) got.push(...n.feed(stream.slice(i, i + 7), now));
assert.equal(got.length, 1, 'one fix per GGA');
const f = got[0];
assert.equal(f.quality, 'rtk-fixed');
assert.equal(f.sats, 18);
close(f.lat, -9.4431, 1e-6, 'lat'); close(f.lon, 147.1803, 1e-6, 'lon');
close(f.acc, Math.hypot(0.012, 0.009), 1e-9, 'accuracy from GST');
close(f.ele, 123.5, 1e-9, 'ellipsoid height is MSL plus separation');
close(f.altAcc, 0.02, 1e-9, 'vertical from GST');
close(f.speed, 1.97 * 0.514444, 1e-6, 'speed');
close(f.heading, 123.4, 1e-9, 'heading when moving');
assert.equal(f.t, Date.UTC(2026, 10, 1, 2, 15, 30), 'time from RMC date');
assert.equal(n.bad, 1);
// no GST: HDOP times a typical error for the fix kind; no fix: nothing
const n2 = new G.Nmea();
const [single] = n2.feed(sum('GPGGA,235959.0,0926.586,S,14710.818,E,1,7,1.5,52.3,M,,M,,') + '\n', Date.UTC(2026, 10, 1, 0, 0, 2));
assert.equal(single.quality, 'single'); close(single.acc, 6, 1e-9, 'hdop accuracy');
assert.equal(single.t, Date.UTC(2026, 9, 31, 23, 59, 59), 'just before midnight belongs to yesterday');
assert.equal(n2.feed(sum('GPGGA,000000,,,,,0,0,,,M,,M,,') + '\n').length, 0);
assert.equal(G.fmtAcc(0.015), '±2 cm'); assert.equal(G.fmtAcc(0.004), '±1 cm');
assert.equal(G.fmtAcc(3.24), '±3.2 m'); assert.equal(G.fmtAcc(15.4), '±15 m');

// ---- stakeout
const me = [147.1803, -9.4431];
const north = [147.1803, -9.4431 + 2 / 111195];
let s = S.stake(me, north, 0, 50, 49.58);
close(s.n, 2, 0.001, 'north'); close(s.e, 0, 1e-6, 'east'); close(s.ahead, 2, 0.001, 'ahead');
close(s.right, 0, 1e-6, 'right'); close(s.dh, -0.42, 1e-9, 'dh');
assert.equal(S.fmtCutFill(s.dh), 'Cut 42 cm');
assert.equal(S.fmtCutFill(0.3), 'Fill 30 cm');
s = S.stake(me, north, 90);
close(s.ahead, 0, 0.001, 'facing east'); close(s.right, -2, 0.001, 'point is to the left');
assert.equal(S.fmtAhead(s), '0 cm ahead · 2.00 m left');
assert.equal(S.fmtNE(S.stake(me, [147.1803 - 0.35 / (111195 * Math.cos(9.4431 * Math.PI / 180)), -9.4431], null)), '0 cm north · 35 cm west');
assert.equal(S.stake(me, me, null).on, true);
assert.equal(S.stake(me, me, null).ahead, null);
const ds = S.parseDesign('id,lat,lon,h\nP1, -9.4431, 147.1803, 52.1\nP2\t147.1804\t-9.4432\n\n# note\nP3 x y\nP4;-9.4433;147.1805');
assert.deepEqual(ds.points.map((p) => p.id), ['P1', 'P2', 'P4']);
assert.deepEqual(ds.points[1].at, [147.1804, -9.4432], 'lon, lat order corrected');
assert.equal(ds.points[0].h, 52.1); assert.equal(ds.points[2].h, null);
assert.deepEqual(ds.bad, [6]);

// ---- quality checks
const v = (lon, lat, t = 0, acc = 3) => [lon, lat, null, t, acc];
const rec = (id, kind, coords, extra = {}) => ({ id, kind, coords, note: id, created: Number(id.replace(/\D/g, '')) || 0, sent: false, photos: [], ...extra });
const tree = F.BUILT_IN.find((x) => x.name === 'Tree plot') ?? F.BUILT_IN[0];
const recs = [
  rec('p1', 'point', [v(147.18, -9.44)]),
  rec('p2', 'point', [v(147.180001, -9.44)]),
  rec('p3', 'point', [v(147.19, -9.44, 0, 25)]),
  rec('p4', 'point', [[147.2, -9.44, null, 0, null]], { form: tree.name, attrs: {} }),
  rec('p5', 'point', [v(147.21, -9.44)], { form: 'Gone', attrs: {} }),
  rec('p6', 'point', [v(147.22, -9.44)], { attrs: { stake_offset_m: 0.12 } }),
  rec('a1', 'area', [v(0, 0), v(0.001, 0.001), v(0.001, 0), v(0, 0.001)]),
  rec('a2', 'area', [v(0, 0), v(0.001, 0), v(0.001, 0.001), v(0, 0.001)]),
  rec('l1', 'line', [v(0, 0), v(0.000001, 0)]),
  rec('t1', 'track', [v(0, 0, 0), v(0.0001, 0, 10_000), v(0.0002, 0, 400_000), v(0.05, 0, 401_000)]),
];
const issues = Q.checkRecords(recs, F.BUILT_IN);
const of = (id) => issues.filter((i) => i.id === id).map((i) => i.text);
assert.match(of('p2')[0], /11 cm as p1, a possible duplicate/);
assert.equal(of('p1').length, 0);
assert.match(of('p3')[0], /weak fix \(±25 m/);
assert.ok(of('p4').some((t) => /accuracy not recorded/.test(t)));
assert.equal(of('p4').length > 1, tree.fields.some((x) => x.required), 'missing required answers');
assert.match(of('p5')[0], /form "Gone" is not on this phone/);
assert.match(of('p6')[0], /staked 12 cm/);
assert.deepEqual(of('a1'), ['a1: the boundary crosses itself']);
assert.equal(of('a2').length, 0);
assert.match(of('l1')[0], /only 0\.1 m long/);
assert.ok(of('t1').some((t) => /1 gap /.test(t)) && of('t1').some((t) => /1 jump /.test(t)));
assert.equal(issues[0].level, 'error', 'errors first');
assert.equal(Q.selfIntersects([[0, 0], [1, 0], [1, 1]]), false);
console.log('field gnss, stakeout and qc: ok');
