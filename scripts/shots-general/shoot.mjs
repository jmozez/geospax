// General GeoSpaX screenshots (tour-*, plugin-*, ribbon-*). GS_WORK=<work dir with data/ and state/ of a seeded server on :18300>.
// Usage: GS_WORK=/tmp/gs node scripts/shots-general/shoot.mjs $PWD/scripts/shots-general/specs.mjs <outdir> [names]
// node shoot.mjs specs.json outdir [only]
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { api, base } from './lib.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright');
const [specFile, out, only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const specs = (await import('file://' + specFile)).default;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const s of specs) {
  if (only && !only.split(',').includes(s.file)) continue;
  const pr = (await api('GET', '/api/project')) ?? {};
  const L = await api('GET', '/api/layers'); const R = await api('GET', '/api/rasters');
  const ids = [...(Array.isArray(L) ? L : L.layers ?? []).map((l) => l.id), ...(Array.isArray(R) ? R : R.rasters ?? []).map((l) => 'r:' + l.id)];
  const all = new Set([...ids, ...(pr.order ?? []), ...(pr.removed ?? []), ...s.keep]);
  pr.order = s.keep; pr.removed = [...all].filter((x) => !s.keep.includes(x));
  pr.layers = pr.layers ?? {};
  for (const k of s.keep) pr.layers[k] = { ...(pr.layers[k] ?? {}), visible: true, ...(s.style?.[k] ?? {}) };
  pr.view = s.view;
  await api('PUT', '/api/project', pr);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { const l = JSON.parse(localStorage.getItem('geospax.workbench.v1') || '{}'); localStorage.setItem('geospax.workbench.v1', JSON.stringify({ ...l, collapsed: ['bottom'] })); } catch {} });
  await page.goto(`${base}/?mode=${s.mode ?? 'pro'}&theme=dark&basemap=${s.basemap ?? 'esri-imagery'}`);
  await page.waitForFunction(() => window.map && window.map.loaded(), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  for (const cb of await page.$$('#contents .layer.raster input[type=checkbox]:not(:checked)')) { await cb.click().catch(() => {}); await page.waitForTimeout(300); }
  if (s.focus) { const row = page.locator(`#contents [data-id="${s.focus}"] .name, #contents [data-layer="${s.focus}"] .name`).first(); if (await row.count()) await row.click().catch(() => {}); await page.waitForTimeout(1200); }
  if (s.ropacity) await page.evaluate((o) => { for (const l of window.map.getStyle().layers) for (const [k, v] of Object.entries(o)) if (l.type === 'raster' && l.id.includes(k)) window.map.setPaintProperty(l.id, 'raster-opacity', v); }, s.ropacity);
  if (s.extra) await s.extra(page, api);
  await page.waitForTimeout(s.wait ?? 6000);
  await page.screenshot({ path: `${out}/${s.file}.png` });
  console.log('shot', s.file);
  await ctx.close();
}
await browser.close();
