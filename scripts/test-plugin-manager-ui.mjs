// UI test for the QGIS-style plugin manager.
// Usage: PW=/path/to/playwright node scripts/test-plugin-manager-ui.mjs BASE_URL [OUT_DIR]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCmd } from './lib/ui.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');
const base = (process.argv[2] ?? 'http://127.0.0.1:18126/').replace(/\/?$/, '/');
const out = process.argv[3] ?? tmpdir();
mkdirSync(out, { recursive: true });

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

// a local repository of demo packages
const repo = mkdtempSync(join(tmpdir(), 'gsx-pm-repo-'));
// realistic demo packages: a (minimal, valid) WebAssembly module and a tool icon, so nothing is flagged
const DEMO = {
  'demo-repo': { name: 'Contour labeller for survey plans', icon: 'gp-contour', tool: 'Label contours' },
  'demo-zip': { name: 'Traverse misclosure checker', icon: 'ruler', tool: 'Check traverse' },
};
function pkg(id, version) {
  const file = join(repo, `${id}-${version}.zip`);
  const d = DEMO[id];
  const manifest = JSON.stringify({ id, name: d.name, version, description: `${d.name}: a demo plugin.`, author: 'GeoSpax tests', license: 'MIT', entry: 'plugin.wasm', tools: [{ id: 't', name: d.tool, summary: d.tool, icon: d.icon }] });
  execFileSync('python3', ['-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("plugin.json",sys.argv[2])\nz.writestr("plugin.wasm",bytes([0,97,115,109,1,0,0,0]))\nz.close()', file, manifest]);
  return file;
}
function writeIndex(version) {
  const download = pkg('demo-repo', version);
  writeFileSync(join(repo, 'plugins.json'), JSON.stringify({ plugins: [{ id: 'demo-repo', name: DEMO['demo-repo'].name, version, description: 'Labels contour lines on survey plans.', author: 'GeoSpax tests', download }] }));
}
writeIndex('1.0');
const zipFile = pkg('demo-zip', '2.0');

const api = async (page, path) => page.evaluate(async (u) => (await fetch(u)).json(), base + path);
const enabledIds = async (page) => (await api(page, 'api/plugins')).plugins.map((p) => p.id);
const until = async (page, fn, msg, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(200); }
  fail(msg);
};

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base + '?theme=dark');
await page.waitForFunction(() => window.workbench?.command, null, { timeout: 30000 });

await runCmd(page, 'plugins.manage');
const dlg = page.locator('#plugin-manager');
await dlg.locator('.pm-tab[data-pm-tab="all"]').waitFor({ timeout: 10000 });
for (const t of ['all', 'installed', 'not-installed', 'upgradeable', 'zip', 'settings'])
  ok(await dlg.locator(`.pm-tab[data-pm-tab="${t}"]`).count() === 1, `tab ${t} missing`);
console.log('ok: tabs');

// add the repository in Settings
await dlg.locator('[data-pm-tab="settings"]').click();
await dlg.locator('#pm-repo-name').fill('Test repo');
await dlg.locator('#pm-repo-url').fill(join(repo, 'plugins.json'));
await dlg.locator('[data-act="repo-add"]').click();
await dlg.locator('tr[data-repo]').first().waitFor();
await dlg.locator('[data-act="repo-refresh"]').click();
await until(page, async () => (await api(page, 'api/plugins/manager')).index.plugins.length === 1, 'repository index not loaded');
console.log('ok: repository added');

// install from Not installed
await dlg.locator('[data-pm-tab="not-installed"]').click();
await dlg.locator('[data-pm-row="demo-repo"]').click();
await dlg.locator('[data-act="install"][data-id="demo-repo"]').click();
await until(page, async () => (await enabledIds(page)).includes('demo-repo'), 'repository install failed');
console.log('ok: installed from repository');

// search
await dlg.locator('[data-pm-tab="all"]').click();
await dlg.locator('#pm-search').fill('demo-repo');
await until(page, async () => (await dlg.locator('[data-pm-row]').count()) === 1, 'search did not filter');
await dlg.locator('#pm-search').fill('');
console.log('ok: search');

// switch off and on
await dlg.locator('[data-pm-tab="installed"]').click();
await dlg.locator('[data-act="toggle"][data-id="demo-repo"]').click();
await until(page, async () => !(await enabledIds(page)).includes('demo-repo'), 'switch-off did not hide the plugin');
ok((await api(page, 'api/plugins')).disabled.includes('demo-repo'), 'not listed as disabled');
await dlg.locator('[data-act="toggle"][data-id="demo-repo"]').click();
await until(page, async () => (await enabledIds(page)).includes('demo-repo'), 'switch-on failed');
console.log('ok: switch off and on');

// upgrade
writeIndex('1.1');
await dlg.locator('[data-pm-tab="settings"]').click();
await dlg.locator('[data-act="repo-refresh"]').click();
await until(page, async () => (await api(page, 'api/plugins/manager')).index.plugins[0]?.version === '1.1', 'refresh did not see 1.1');
await dlg.locator('[data-pm-tab="upgradeable"]').click();
await dlg.locator('[data-pm-row="demo-repo"]').click();
await dlg.locator('[data-act="upgrade"][data-id="demo-repo"]').click();
await until(page, async () => (await api(page, 'api/plugins')).all.find((p) => p.id === 'demo-repo')?.version === '1.1', 'upgrade failed');
console.log('ok: upgrade');

// install from ZIP
await dlg.locator('[data-pm-tab="zip"]').click();
await dlg.locator('#pm-zip-file').setInputFiles(zipFile);
await dlg.locator('[data-act="upload"]').click();
await until(page, async () => (await enabledIds(page)).includes('demo-zip'), 'ZIP install failed');
console.log('ok: install from ZIP');
ok((await api(page, 'api/plugins')).all.find((p) => p.id === 'demo-zip')?.tools[0]?.icon === 'ruler', 'plugin.json tool icon was not read');
console.log('ok: tool icon read from plugin.json');

// screenshot before uninstall
await dlg.locator('[data-pm-tab="installed"]').click();
await dlg.locator('[data-pm-row="demo-repo"]').click();
await page.waitForTimeout(300);
for (const id of ['demo-repo', 'demo-zip']) {
  const row = dlg.locator(`[data-pm-row="${id}"]`);
  ok((await row.locator('.badge.warn').count()) === 0, `${id} shows a warning badge`);
  const full = await row.locator('.p-name').evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && !e.textContent.includes('…'));
  ok(full, `${id} name is truncated`);
}
console.log('ok: names shown in full, no warnings');
const ico = await dlg.locator('[data-pm-row="demo-repo"] .p-ico path').getAttribute('d');
ok(ico?.startsWith('M2 18c3-6'), 'the plugin row does not show its tool icon');
console.log('ok: plugin icon shown');
await page.screenshot({ path: join(out, 'plugin-manager-dark.png') });

// two-click uninstall
await dlg.locator('[data-pm-row="demo-zip"]').click();
const del = dlg.locator('[data-act="uninstall"][data-id="demo-zip"]');
await del.click();
await page.waitForTimeout(300);
ok((await enabledIds(page)).includes('demo-zip'), 'first click removed the plugin');
await dlg.locator('[data-act="uninstall"][data-id="demo-zip"]').click();
await until(page, async () => !(await api(page, 'api/plugins')).all.some((p) => p.id === 'demo-zip'), 'uninstall failed');
console.log('ok: two-click uninstall');

ok(errors.length === 0, 'page errors: ' + errors.join('; '));
await browser.close();
console.log('plugin manager UI: all checks passed');
