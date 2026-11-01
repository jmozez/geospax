// The field sheet PDF and battery saver in the field app (apps/field/src/pdf.ts and battery.ts): text
// encoding and wrapping, JPEG sizes, a well-formed PDF with a correct cross-reference table, and when the
// battery saver is on and what it changes.
//   node --experimental-strip-types scripts/test-field-sheet.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
  return next(spec, ctx);
}`));
globalThis.window = {};
const P = await import('../apps/field/src/pdf.ts');
const B = await import('../apps/field/src/battery.ts');
const JPEG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCtRRRXmHvH/9k=', 'base64'));

// ---- text
assert.equal(P.winAnsi('±3 m · 45°'), '\xb13 m \xb7 45\xb0');
assert.equal(P.winAnsi('Māori ✓ ➜ 漢'), 'Maori v > ?');
assert.equal(P.winAnsi('café'), 'caf\xe9');
assert.equal(Math.round(P.textWidth('Hello', 10)), 23);
const lines = P.wrap('The quick brown fox jumps over the lazy dog', 10, 80);
assert.ok(lines.length > 1 && lines.every((l) => P.textWidth(l, 10) <= 80), 'wrapped to fit');
assert.equal(lines.join(' '), 'The quick brown fox jumps over the lazy dog');
assert.ok(P.wrap('a'.repeat(60), 10, 50).every((l) => P.textWidth(l, 10) <= 50), 'long words cut');
assert.deepEqual(P.wrap('one\ntwo', 10, 200), ['one', 'two']);

// ---- JPEG
assert.deepEqual(P.jpegInfo(JPEG), { w: 8, h: 6, c: 3 });
assert.equal(P.jpegInfo(new Uint8Array([0x89, 0x50])), null);
assert.equal(P.scaleBar(1, 500), 100);
assert.equal(P.scaleBar(0.05, 500), 2000);

// ---- the sheet
const v = (lon, lat, acc = 3) => [lon, lat, 50.2, 0, acc];
const t0 = Date.UTC(2026, 10, 1, 2, 0);
const recs = [
  { id: 'a', kind: 'area', coords: [v(147.18, -9.443), v(147.181, -9.443), v(147.181, -9.444)], note: 'Garden (Kaukau)', created: t0 + 2, sent: false, photos: [] },
  { id: 'p', kind: 'point', coords: [v(147.1803, -9.4431, 0.012)], note: 'Tree ±2 cm, 45° slope', created: t0, sent: false, photos: [{ id: 'x', name: 'IMG_1.jpg', blob: null, lon: 0, lat: 0, acc: 0, ts: 0, bearing: 30 }, { id: 'y', name: 'v.png', blob: null, lon: 0, lat: 0, acc: 0, ts: 0 }], height: { value: 52.3, source: 'gnss', acc: 0.03 }, form: 'Tree plot', attrs: { species: 'Kwila' } },
  ...Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, kind: 'point', coords: [v(147.1802 + i * 1e-5, -9.4432)], note: 'Station ' + i + ' with a long note that has to wrap onto a second line in the table', created: t0 + 10 + i, sent: true, photos: [] })),
];
const bytes = await P.fieldSheet(recs, { title: 'Field sheet: Bomana', now: t0, measure: (r) => (r.kind === 'area' ? '1.2 ha' : ''), answers: (r) => (r.attrs ? 'Species: Kwila' : ''), photo: async (r, i) => (r.photos[i].name.endsWith('.jpg') ? JPEG : new Uint8Array([1, 2])) });
const s = Buffer.from(bytes).toString('latin1');
assert.ok(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'));
// every xref entry points at its object
const xref = Number(s.match(/startxref\n(\d+)/)[1]);
assert.ok(s.slice(xref).startsWith('xref'));
const [, first, count] = s.slice(xref).match(/xref\n(\d+) (\d+)/);
const entries = [...s.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
assert.equal(entries.length, Number(count) - 1);
entries.forEach((o, i) => assert.ok(s.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1} at ${o}`));
// stream lengths match
for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n/g)) assert.equal(s.slice(m.index + m[0].length + Number(m[1]), m.index + m[0].length + Number(m[1]) + 10), '\nendstream');
const pages = Number(s.match(/\/Count (\d+)/)[1]);
assert.ok(pages >= 2, 'the table runs onto more pages');
assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 1, 'only the JPEG photo');
assert.ok(s.includes('(Field sheet: Bomana) Tj') && s.includes(`(GeoSpaX Field \xb7 page ${pages} of ${pages}) Tj`));
assert.ok(s.includes('(Tree \xb12 cm, 45\xb0 slope \xb7 Species: Kwila) Tj') || s.includes('(Tree \xb12 cm, 45\xb0 slope \xb7) Tj'), 'note with answers');
assert.ok(s.includes('(\xb112 cm)') === false && s.includes('(\xb11 cm) Tj'), 'centimetre accuracy');
assert.ok(s.indexOf('Tree') < s.indexOf('Garden'), 'oldest first');
assert.ok(s.includes('(#1 facing 30\xb0) Tj'));
writeFileSync('/tmp/field-sheet-test.pdf', bytes);
// nothing recorded
assert.ok(Buffer.from(await P.fieldSheet([], { title: 'Empty', measure: () => '', answers: () => '', photo: async () => null })).toString('latin1').includes('Nothing recorded yet.'));

// ---- battery saver
assert.equal(B.saverOn('on', null), true);
assert.equal(B.saverOn('off', { level: 0.05, charging: false }), false);
assert.equal(B.saverOn('auto', null), false, 'no battery reading: off');
assert.equal(B.saverOn('auto', { level: 0.2, charging: false }), true);
assert.equal(B.saverOn('auto', { level: 0.1, charging: true }), false, 'charging');
assert.equal(B.saverOn('auto', { level: 0.5, charging: false }), false);
assert.equal(B.gpsWanted(true, true, false), false);
assert.equal(B.gpsWanted(true, true, true), true, 'recording a track in the background');
assert.equal(B.gpsWanted(false, true, false), true);
assert.deepEqual(B.plan(true, true, 2.6), { pixelRatio: 1, navMs: 1000, keepAwake: false });
assert.deepEqual(B.plan(false, true, 2.6), { pixelRatio: null, navMs: 300, keepAwake: true });
assert.equal(B.fmtBattery({ level: 0.183, charging: true }), '18%, charging');
console.log('field sheet and battery saver: ok');
