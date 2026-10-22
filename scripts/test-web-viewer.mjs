// Headless end-to-end check of the web edition (needs `playwright` + Chromium):
//   PW=/path/to/node_modules/playwright node scripts/test-web-viewer.mjs [http://127.0.0.1:8080] [out-dir]
// Renders the map, screenshots it, checks for console errors, runs the
// Arrow -> deck.gl path and the camera-tour benchmark, prints the results.
// NOTE: headless Chromium renders WebGL in software (SwiftShader), so FPS and
// settle times here are NOT representative of a GPU desktop; use the in-app
// "Run benchmark" button on real hardware for those.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? 'bench/screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const settled = () =>
  page.waitForFunction(() => typeof window.map?.loaded === 'function' && window.map.loaded() && window.map.areTilesLoaded(), null, { timeout: 120_000, polling: 500 });

async function shot(name, hash) {
  await page.goto(`${base}/?fresh#view=${hash}`);
  await settled();
  await page.waitForTimeout(1500); // let the HUD poll engine stats
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`screenshot ${name}.png`);
}

await shot('01-mt-hagen-z14', '14.2/-5.862/144.235');
await shot('02-highlands-z11', '11/-5.95/144.6');
await shot('03-world-z1', '1.6/10/30');

// Arrow -> deck.gl: 1M points in one binary payload.
await page.goto(`${base}/?fresh#view=9/-5.95/144.6`);
await settled();
await page.evaluate(() => { document.querySelector('[data-tab="project"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); document.querySelector('#diagnostics').open = true; });
await page.click('#arrow');
await page.waitForSelector('body[data-arrow="done"]', { timeout: 180_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/04-arrow-deckgl-1M-points.png`, timeout: 240_000 }); // software WebGL: 1M points are slow to draw
console.log('arrow:', (await page.textContent('#results')).replace(/\s+/g, ' ').trim());

// Camera-tour benchmark (auto-starts with ?bench=1, posts its report to /api/bench).
await page.goto(`${base}/?bench=1`); // fresh page: drops the 1M-point deck.gl layer
await page.waitForSelector('body[data-bench="done"]', { timeout: 300_000 });
await page.screenshot({ path: `${out}/05-benchmark.png`, timeout: 240_000 });
const report = await (await page.request.get(`${base}/api/bench`)).json();
console.log('bench summary:', JSON.stringify(report.summary));
for (const s of report.stops) console.log(`  ${s.name.padEnd(15)} z${String(s.zoom).padEnd(5)} settle ${s.settle_ms.toFixed(0).padStart(6)} ms  tiles ${String(s.tiles_rendered).padStart(4)}  engine ${s.render_ms_mean.toFixed(1)} ms/tile  fps ${s.fps_avg.toFixed(0)}`);

console.log(problems.length ? `console problems:\n  ${problems.join('\n  ')}` : 'console: clean (no errors or warnings)');
await browser.close();
