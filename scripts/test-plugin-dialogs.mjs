// Every tool of the default domain plugins, opened from the Plugins tab on the PNG samples and
// run as it opens (inputs pre-selected, web/src/prefill.ts), like a user pressing Run straight away:
// each either runs or asks in plain words for what it lacks (no crash, no stack trace); no earlier
// result is taken as input unasked; and the samples get the inputs they are made for.
//   node scripts/test-plugin-dialogs.mjs BASE_URL [OUT_DIR]   (server on samples/png, fresh state)
import { runCmd, commandIds, openPluginTool } from './lib/ui.mjs';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? 'bench/screenshots';
mkdirSync(out, { recursive: true });
let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  if (cond) passed++;
  else failed.push(name);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?mode=pro&theme=dark`);
await page.waitForSelector('#contents .layer.pro');
await page.waitForTimeout(2000);
const plugins = (await (await fetch(`${base}/api/plugins`)).json()).plugins.filter((p) => p.default);
const RESULT = /-\d{8}-\d{6}/;
const seen = {};
for (const p of plugins) {
  console.log(p.name);
  for (const t of p.tools) {
    // a result the last run opened is the active layer and is meant to chain into the next tool:
    // close it so each tool is judged on how it picks from your own data
    await page.$$eval('[data-k="close"]', (els) => els.forEach((e) => e.offsetParent && e.click()));
    await openPluginTool(page, p.id, t.id);
    await page.waitForSelector('#plugin-modal:not([hidden])');
    const inputs = Object.fromEntries(await page.$$eval('#plugin-modal select[data-p]', (els) => els.map((e) => [e.dataset.p, e.multiple ? [...e.selectedOptions].map((o) => o.value) : e.value])));
    if (p.id === 'geospax-environment' && t.id === 'elevation-profile') await page.screenshot({ path: `${out}/plugin-dialog-prefilled.png` });
    await page.click('#plugin-modal [data-run-tool]');
    let msg = '';
    for (let i = 0; i < 240; i++) {
      msg = await page.$eval('#plugin-msg', (e) => e.textContent.trim());
      if (msg && !/running|…$/i.test(msg)) break;
      await page.waitForTimeout(500);
    }
    await page.click('#plugin-modal [data-close]').catch(() => {});
    const asked = /: (Choose|Give|Add|Select|Pick)\b|has no /.test(msg);
    const ran = !/api\/plugins\//.test(msg);
    const crash = /exited|stack|TypeError|undefined|null|NaN/.test(msg);
    const results = Object.values(inputs).flat().filter((v) => RESULT.test(v));
    ok(`${t.id}: ${ran ? 'ran' : 'asks for its input'}`, (ran || asked) && !crash && !results.length, `${msg.replace(/^api\/plugins\/[^:]+: /, '').slice(0, 90)}${results.length ? ` · took result ${results[0]}` : ''}`);
    seen[t.id] ??= inputs;
  }
}
console.log('inputs chosen for the samples');
ok('diversity: the butterfly records and their species', /^birdwing_butterfly/.test(seen.diversity?.occurrences) && seen.diversity?.species === 'species', JSON.stringify(seen.diversity));
ok('elevation profile: the transects and their elevation field', /^species_richness_transects/.test(seen['elevation-profile']?.layer) && seen['elevation-profile']?.elevation_field === 'elevation_m' && seen['elevation-profile']?.group_field === 'transect', JSON.stringify(seen['elevation-profile']));
ok('species distribution: the two WorldClim rasters as covariates', JSON.stringify((seen.sdm?.covariates ?? []).slice().sort()) === JSON.stringify(['worldclim_bio12_precipitation', 'worldclim_bio1_temperature']), JSON.stringify(seen.sdm?.covariates));
ok('slope zones: no DEM guessed (the samples have none)', seen['slope-zones']?.dem === '');
ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
