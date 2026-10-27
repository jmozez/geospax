// Industry kit screenshots: each kit's results in the app, dark theme, Pro mode (one shot per kit).
// Run by scripts/test-domain-plugins.py when GX_SHOTS names a folder, against its own test server:
//   node scripts/shots-industry.mjs <base> <out-dir> <runs.json>
// (runs.json lists each kit run with the layers and rasters it added; PW names the Playwright module)
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const [base, out, list] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const runs = JSON.parse(readFileSync(list, 'utf8'));
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, body: body && JSON.stringify(body), headers: body ? { 'content-type': 'application/json' } : {} });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : {};
};
const view = { center: [146.1012, -5.8753], zoom: 15.2 }; // the 1 km test square (UTM 55S)

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  try {
    const l = JSON.parse(localStorage.getItem('geospax.workbench.v1') || '{}');
    localStorage.setItem('geospax.workbench.v1', JSON.stringify({ ...l, collapsed: ['bottom'] }));
  } catch { /* first start */ }
});
let n = 0;
for (const run of runs) {
  const keep = [...(run.layers ?? []), ...(run.rasters ?? []).map((x) => `r:${x}`)];
  const pr = (await api('GET', '/api/project')) ?? {};
  const all = new Set([...(pr.order ?? []), ...(pr.removed ?? []), ...keep]);
  pr.order = keep;
  pr.removed = [...all].filter((x) => !keep.includes(x));
  pr.layers = pr.layers ?? {};
  for (const k of keep) pr.layers[k] = { ...(pr.layers[k] ?? {}), visible: true };
  pr.view = view;
  await api('PUT', '/api/project', pr);
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(5000);
  for (const cb of await page.$$('#contents .layer.raster input[type=checkbox]:not(:checked)')) {
    await cb.click().catch(() => {});
    await page.waitForTimeout(300);
  }
  const top = keep[0];
  if (top) {
    const row = page.locator(`#contents [data-id="${top}"] .name, #contents [data-layer="${top}"] .name`).first();
    if (await row.count()) await row.click().catch(() => {});
  }
  await page.waitForTimeout(2500);
  const file = `${run.kit.replace(/^kit-/, '')}-pro-dark.png`;
  await page.screenshot({ path: join(out, file) });
  console.log('  shot', file, keep.join(' '));
  n++;
}
await browser.close();
console.log(`${n} app shots in ${out}`);
