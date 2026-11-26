// Accessibility basics on every ribbon tab: named controls, a skip link, keyboard focus, language.
//   node scripts/test-a11y.mjs [base-url]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');
const base = (process.argv[2] ?? 'http://127.0.0.1:18120').replace(/\/$/, '');
let pass = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}${x ? ` (${x})` : ''}`); } else { fails.push(n); console.log(`  FAIL ${n}${x ? ` (${x})` : ''}`); } };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/?fresh`);
await page.waitForFunction(() => window.workbench && typeof window.map?.loaded === 'function' && window.map.loaded(), null, { timeout: 120_000 });
await page.waitForTimeout(1500);
for (const s of ['[data-tour-skip]', '.tut-card [data-x]', '#start [data-close]']) { const e = await page.$(s); if (e && await e.isVisible()) await e.click().catch(() => {}); }
const unnamed = () => page.evaluate(() => [...document.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select')]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })
  .filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent?.trim() || el.getAttribute('title') || el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.getAttribute('placeholder')))
  .map((el) => el.outerHTML.slice(0, 90)));
for (const t of await page.$$eval('#ribbon-tabs [data-tab]', (b) => b.map((x) => x.dataset.tab))) {
  await page.click(`#ribbon-tabs [data-tab="${t}"]`);
  await page.waitForTimeout(250);
  const u = await unnamed();
  ok(`${t} tab: every visible control has a name`, u.length === 0, u.slice(0, 3).join(' | '));
}
ok('the page says its language', await page.evaluate(() => !!document.documentElement.lang));
const first = await page.evaluate(() => {
  const f = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].find((e) => !e.disabled);
  f?.focus();
  return { cls: f?.className, top: f?.getBoundingClientRect().top };
});
ok('the first focusable element is "Skip to the map", shown when focused', first.cls === 'skip-link' && first.top >= 0, JSON.stringify(first));
await page.keyboard.press("Tab");
const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
ok('keyboard focus is visible', ring !== 'none', ring);
await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
