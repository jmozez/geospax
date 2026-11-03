// Live teamwork: two windows on one GeoSpaX; an edit in one shows in the other within seconds.
//   node scripts/test-live.mjs [base-url]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');
const base = (process.argv[2] ?? 'http://127.0.0.1:18120').replace(/\/$/, '');
let pass = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}${x ? ` (${x})` : ''}`); } else { fails.push(n); console.log(`  FAIL ${n}${x ? ` (${x})` : ''}`); } };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((n) => { try { localStorage.setItem('geospax.name', n); } catch { /* */ } }, name);
  const p = await ctx.newPage();
  await p.goto(`${base}/?fresh`);
  await p.waitForFunction(() => window.workbench && window.map && window.map.loaded && window.map.loaded(), null, { timeout: 120_000 });
  await p.waitForTimeout(4000);
  return p;
}
const a = await open('Kila');
const b = await open('Mere');
const before = await a.evaluate(async () => (await (await fetch('api/live')).json()).rev);
// Mere adds a layer through the app's own backend (tagged with her window)
await b.evaluate(async () => {
  const n = localStorage.getItem('geospax.name');
  await fetch(`api/layers/new?_c=other-window&_n=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'shared_notes', geometry: 'point', fields: [{ name: 'note', kind: 'text' }] }) });
});
const after = await a.evaluate(async () => (await (await fetch('api/live')).json()));
ok('the change counter moves and names who changed it', after.rev > before && after.by === 'Mere', `${before} → ${after.rev}, by ${after.by}: ${after.what}`);
const seen = await a.waitForFunction(() => /Updated: Mere/.test(document.body.innerText) && /shared_notes/.test(document.querySelector('#dock-left')?.textContent ?? ''), null, { timeout: 20_000 }).then(() => true).catch(() => false);
ok("the other window shows the new layer and who added it, without reloading", seen);
const reads = await a.evaluate(async () => { const r0 = (await (await fetch('api/live')).json()).rev; await fetch('api/layers'); await fetch('api/ogc/collections'); return (await (await fetch('api/live')).json()).rev === r0; });
ok('reading is not a change', reads);
await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
