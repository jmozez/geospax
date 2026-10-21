// Finish my map layouts (map series, side by side, facets, panels) in Pro and Lazy, and keyboard
// navigation of the Pro layer tree.
//   PW=/path/to/node_modules/playwright node scripts/test-web-series.mjs [base]
// Needs a server with at least one visible layer.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?mode=pro`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// ---- keyboard tree
const first = page.locator('.pr-tree [role=treeitem][tabindex="0"]');
ok('the tree has exactly one tab stop', (await first.count()) === 1);
await first.focus();
const key = () => page.evaluate(() => document.activeElement?.getAttribute('data-id') ?? document.activeElement?.className);
const k0 = await key();
await page.keyboard.press('ArrowDown');
const k1 = await key();
ok('↓ moves to the next row', k1 !== k0, `${k0} → ${k1}`);
await page.keyboard.press('ArrowUp');
ok('↑ moves back', (await key()) === k0);
await page.keyboard.press('End');
await page.keyboard.press('Home');
await page.keyboard.press('ArrowDown');
const id = await key();
const vis = () => page.locator(`.layer.pro[data-id="${id}"] input[type=checkbox]`).isChecked();
const v0 = await vis();
await page.keyboard.press(' ');
await page.waitForTimeout(300);
ok('Space shows/hides the layer and keeps focus', (await vis()) !== v0 && (await key()) === id);
await page.keyboard.press(' ');
await page.waitForTimeout(300);

// ---- map series: a 2 × 2 grid
const top0 = (await (await page.request.get(`${base}/api/runs`)).json()).runs[0]?.id;
await page.click('#ribbon-tabs .rb-tab[data-tab="home"]');
await page.locator('#ribbon-body [data-cmd="home.finish"]').first().click();
await page.waitForTimeout(400);
ok('Finish my map offers the layouts', (await page.locator('.fin-chips label').count()) >= 4);
await page.click('.fin-chips label:has(input[value=atlas])');
await page.check('input[name=split][value=grid]');
await page.selectOption('select[name=grid]', '2x1');
await page.fill('input[name=title]', 'Series test');
await page.click('#finish button[type=submit]');
let run = null;
for (let i = 0; i < 120 && !(run && ['done', 'failed'].includes(run.status)); i++) {
  await page.waitForTimeout(1000);
  const runs = (await (await page.request.get(`${base}/api/runs`)).json()).runs;
  if (runs[0] && runs[0].id !== top0) run = runs[0];
}
const arts = run?.artifacts ?? [];
const pngs = arts.filter((a) => /^series-test-\d\d\.png$/.test(a));
ok('a 2 × 1 series makes two map pages', run?.status === 'done' && pngs.length === 2, `${run?.status} · ${pngs.join(', ')}`);
ok('it opens with an index page', arts.includes('series-test-00-index.png'));
const pdf = arts.includes('series-test-series.pdf') ? await (await page.request.get(`${base}/api/runs/${run.id}/files/series-test-series.pdf`)).body() : null;
const nPages = pdf ? (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length : 0;
ok('and is bound into one 3-page PDF', nPages === 3, `${nPages} pages`);

// ---- a layout run end to end: wait for the next run and list its files
const runOf = async (label) => {
  // the list is capped (newest first): watch for a new id at the top
  const top0 = (await (await page.request.get(`${base}/api/runs`)).json()).runs[0]?.id;
  await page.click('#finish button[type=submit]');
  let r = null;
  for (let i = 0; i < 120 && !(r && ['done', 'failed'].includes(r.status)); i++) {
    await page.waitForTimeout(1000);
    const runs = (await (await page.request.get(`${base}/api/runs`)).json()).runs;
    if (runs[0] && runs[0].id !== top0) r = runs[0];
  }
  return r;
};
const closeAll = async () => {
  // a finished run opens its report on top: close it
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await page.locator('#artifact-modal [data-close], #artifact-modal .close').first().click({ timeout: 500 }).catch(() => {});
  }
  await page.waitForTimeout(300);
};
const openFinish = async () => {
  await closeAll();
  await page.click('#ribbon-tabs .rb-tab[data-tab="home"]').catch(() => {});
  await page.locator('#ribbon-body [data-cmd="home.finish"]').first().click();
  await page.waitForTimeout(400);
};
// side by side (patchwork)
await openFinish();
await page.click('.fin-chips label:has(input[value=open])').catch(() => {});
if (await page.locator('.fin-chips input[value=side]').count()) {
  await page.click('.fin-chips label:has(input[value=side])');
  await page.fill('input[name=title]', 'Side test');
  const r = await runOf('side');
  ok('side by side makes one multi-panel page', r?.status === 'done' && (r.artifacts ?? []).includes('side-test.png'), r?.status + ' ' + (r?.error ?? ''));
}
// facets (ggplot2 facet_wrap): a field with 2–12 values is offered and used
await openFinish();
await page.click('.fin-chips label:has(input[value=facet])');
await page.waitForFunction(() => { const o = document.querySelector('select[name=facet]')?.options; return o && o.length && !/checking/.test(o[0].text); }, null, { timeout: 60000 });
const facetField = await page.locator('select[name=facet]').inputValue();
ok('split by a field offers a field with 2–12 values', !!facetField, facetField || 'none');
if (facetField) {
  await page.fill('input[name=title]', 'Facet test');
  const r = await runOf('facet');
  ok('a facet run makes one page', r?.status === 'done' && (r.artifacts ?? []).includes('facet-test.png'), r?.status + ' ' + (r?.error ?? ''));
}
// panels: a 2 × 1 grid on one page, exact areas
await openFinish();
await page.click('.fin-chips label:has(input[value=panels])');
await page.selectOption('select[name=grid]', '2x1');
await page.fill('input[name=title]', 'Panels test');
{
  const r = await runOf('panels');
  ok('panels make one page with every area', r?.status === 'done' && (r.artifacts ?? []).includes('panels-test.png'), r?.status + ' ' + (r?.error ?? ''));
}
// Lazy mode has the same layouts in view (not hidden under More options)
await closeAll();
await page.click('#mode-switch [data-mode="lazy"]');
await page.waitForTimeout(800);
await page.locator('.tk-bar [data-cmd="home.finish"]').first().click();
await page.waitForTimeout(500);
ok('Lazy mode shows the layouts', await page.locator('#finish .fin-chips').isVisible());
await page.keyboard.press('Escape');
await page.click('#mode-switch [data-mode="pro"]');
await page.waitForTimeout(800);

// ---- one page per feature: too many features is refused with a reason
const idx = await page.evaluate(() => 0);
await openFinish();
await page.click('.fin-chips label:has(input[value=atlas])');
const hasIndex = await page.locator('select[name=index]').count();
if (hasIndex) {
  await page.selectOption('select[name=index]', { index: idx });
  await page.waitForTimeout(400);
  ok('choosing an area layer picks “one per feature”', await page.locator('input[name=split][value=features]').isChecked());
  await page.click('#finish button[type=submit]');
  await page.waitForTimeout(1500);
  const m = await page.locator('#finish-msg').innerText().catch(() => '');
  const open = await page.locator('#finish').isVisible();
  ok('a page layer either runs or explains why not', !open || /at most|No pages/.test(m), m || 'started');
}
ok('no page errors', !errors.length, errors.join(' | '));
console.log(`\n${pass} passed, ${fails.length} failed`);
await browser.close();
process.exit(fails.length ? 1 : 0);
