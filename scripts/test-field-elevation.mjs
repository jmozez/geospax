// The field app's heights (apps/field/src/elevation.ts): the EGM2008 geoid grid against known values, the
// barometer formula and calibration, the choice of the best source, and the terrain model's answer.
//   node --experimental-strip-types scripts/test-field-elevation.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const E = await import('../apps/field/src/elevation.ts');
const buf = readFileSync(new URL('../apps/field/public/geoid/egm2008-15m.bin', import.meta.url));
assert.equal(buf.length, E.GEOID.rows * E.GEOID.cols * 2, 'the geoid grid is 721 x 1441 int16');
const grid = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(2)}, expected ${b} ±${tol}`);

// GeographicLib's reference values (GeoidEval with egm2008-1)
near(E.geoidAt(grid, -6.7275, 146.9963), 72.0, 1.5, 'geoid at Lae');
near(E.geoidAt(grid, 16 + 46 / 60 + 33 / 3600, -(3 + 34 / 3600)), 28.71, 1.5, 'geoid at Timbuktu');
// west longitudes, east longitudes past 180 and the 0/360 seam give the same answer
near(E.geoidAt(grid, 10, -10), E.geoidAt(grid, 10, 350), 1e-9, 'lon -10 = 350');
near(E.geoidAt(grid, 0, 359.99), E.geoidAt(grid, 0, -0.01), 1e-9, 'the seam');
assert.ok(Number.isFinite(E.geoidAt(grid, 90, 0)) && Number.isFinite(E.geoidAt(grid, -90, 179.9)), 'the poles');
assert.ok(E.geoidAt(grid, -90, 0) < -20, 'Antarctica: the geoid is below the ellipsoid');
// the grid's own nodes come back exactly
assert.equal(E.geoidAt(grid, 90, 0), grid[0] / 100, 'a grid node');
// a GPS ellipsoid height of 100 m at Lae is about 28 m above the sea
near(E.orthometric(100, E.geoidAt(grid, -6.7275, 146.9963)), 28, 1.5, 'height above sea level');

// the barometer: 1 hPa is about 8.3 m near sea level
near(E.baroDelta(1013.25, 1013.25), 0, 1e-9, 'no change');
near(E.baroDelta(1012.25, 1013.25), 8.3, 0.2, '1 hPa');
near(E.baroDelta(898.75, 1013.25), 1000, 15, '1000 m (standard atmosphere)');
const t0 = 1_700_000_000_000;
const cal = { p0: 1000, h0: 120, t: t0 };
const b = E.baroHeight(999, cal, t0);
assert.equal(b.source, 'baro');
near(b.value, 128.4, 0.3, 'calibrated barometer');
assert.ok(E.baroHeight(999, cal, t0 + 3 * 3_600_000).acc > b.acc, 'a calibration gets less trusted with age');
const s = E.baroHeight(1013.25, null);
assert.equal(s.source, 'baro-std');
near(s.value, 0, 1e-9, 'standard air');

// choosing the best height
const g = (acc) => ({ value: 50, source: 'gnss', acc });
const baro = { value: 52, source: 'baro', acc: 3 };
const dem = { value: 49, source: 'dem', acc: 8 };
const std = { value: 30, source: 'baro-std', acc: 50 };
assert.equal(E.bestHeight({ gnss: g(5), baro, dem }).source, 'gnss', 'good GPS wins');
assert.equal(E.bestHeight({ gnss: g(15), baro, dem }).source, 'gnss', '15 m vertical is still good');
assert.equal(E.bestHeight({ gnss: g(30), baro, dem }).source, 'baro', 'poor GPS: the calibrated barometer');
assert.equal(E.bestHeight({ gnss: g(null), baro: null, dem }).source, 'dem', 'unknown GPS accuracy: the terrain model');
assert.equal(E.bestHeight({ gnss: g(30), baro: std, dem: null }).source, 'gnss', 'poor GPS beats standard air');
assert.equal(E.bestHeight({ baro: std }).source, 'baro-std', 'standard air when there is nothing else');
assert.equal(E.bestHeight({}), null, 'nothing');
assert.ok(E.canCalibrate(g(8)) && !E.canCalibrate(g(12)) && !E.canCalibrate(g(null)) && !E.canCalibrate(null), 'calibrate only from a good GPS height');

// the text and the terrain model
assert.equal(E.fmtHeight({ value: 412.34, source: 'gnss', acc: 4.2 }), '412.3 m (±4 m, GPS and EGM2008 geoid)');
assert.equal(E.fmtHeight({ value: 10, source: 'dem', acc: null }), '10.0 m (terrain model (GLO-90))');
assert.equal(E.fmtHeight(null), 'not known');
assert.equal(E.demKey(-6.72749, 146.99631), '-6.727,146.996', 'a ~100 m cell');
assert.equal(E.demKey(-6.72749, 146.99631), E.demKey(-6.72710, 146.99640), 'nearby positions share a cell');
assert.match(E.demUrl(-6.7275, 146.9963), /^https:\/\/api\.open-meteo\.com\/v1\/elevation\?latitude=-6\.72750&longitude=146\.99630$/);
assert.equal(E.parseDem({ elevation: [412] }), 412);
assert.equal(E.parseDem({ elevation: [] }), null);
assert.equal(E.parseDem({ error: true, reason: 'x' }), null);
assert.equal(E.parseDem({ elevation: [-9999] }), null, 'no data');
assert.equal(E.parseDem(null), null);

console.log('field elevation: all checks passed');
