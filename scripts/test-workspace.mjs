#!/usr/bin/env node
// Workspaces, local profiles and the desktop tours, end to end on servers of their own:
//   - per-computer workspaces: two OS users on one computer get separate workspaces, ids are SHA-256;
//     Home › Workspace, tool switches, Restricted mode with a PIN, export and import;
//   - tours: the first-start tour (6 to 8 steps, keys, Back, Skip), not on the second run, Help › Take
//     the tour, What's new after a version change, "Don't show again";
//   - profiles: the single-profile skip, "Who's working?", PIN (salted hash, wrong PIN refused),
//     isolation, admin-only changes, per-profile Restricted mode and the PIN lock after a restart;
//
//   node scripts/test-workspace.mjs [target/release/geospax-server] [screenshot dir]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const bin = process.argv[2] ?? 'target/release/geospax-server';
const shots = process.argv[3] ?? '';
if (shots) mkdirSync(shots, { recursive: true });
let passed = 0;
const failed = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (cond) passed++;
  else failed.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'gx-ws-'));
const data = join(tmp, 'data');
mkdirSync(data);
writeFileSync(join(data, 'villages.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'Goroka' }, geometry: { type: 'Point', coordinates: [145.39, -6.08] } },
  { type: 'Feature', properties: { name: 'Lae' }, geometry: { type: 'Point', coordinates: [147.0, -6.73] } },
] }));
const port = 18131;
const base = `http://127.0.0.1:${port}`;
let srv;
async function health() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error('the server did not start');
}
async function start(state, { perUser = false, user = 'alice' } = {}) {
  const args = ['--data', data, '--state-dir', state, '--port', String(port), '--web', 'web/dist', '--no-device-mounts', '--no-triggers'];
  if (perUser) args.push('--per-user-workspace');
  srv = spawn(bin, args, { stdio: 'ignore', env: { ...process.env, USER: user, LOGNAME: user, USERNAME: user, GEOSPAX_MACHINE_ID: 'ci-test-machine-0001' } });
  await health();
}
async function stop() {
  if (!srv || srv.exitCode !== null) return;
  srv.kill();
  await new Promise((r) => srv.once('exit', r));
}
const api = async (path, method = 'GET', body) => {
  const r = await fetch(`${base}/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, json: j, text: t };
};
// a profile switch restarts the engine: wait for it to go away and come back
const afterRestart = async () => { await sleep(1200); await health(); };

const browser = await chromium.launch();
let code = 1;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const layers = () => page.$$eval('#contents .layer', (a) => a.length);

  // ------------------------------------------------------------ tours
  const s1 = join(tmp, 'state1');
  await start(s1);
  console.log('tours');
  await page.goto(`${base}/?mode=pro&theme=dark&tour=1`);
  await page.waitForSelector('.gx-tour', { timeout: 8000 }).catch(() => {});
  ok('the first-start tour shows on the first run', !!(await page.$('.gx-tour')));
  const count = await page.textContent('.gx-tour-count').catch(() => '');
  const n = Number(/of (\d+)/.exec(count ?? '')?.[1] ?? 0);
  ok('the tour has 6 to 8 steps', n >= 6 && n <= 8, count);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  ok('the arrow keys move the tour on', /Step 2 of/.test((await page.textContent('.gx-tour-count')) ?? ''));
  await page.click('[data-back]');
  await page.waitForTimeout(200);
  ok('Back works', /Step 1 of/.test((await page.textContent('.gx-tour-count')) ?? ''));
  await page.click('[data-next]');
  await page.click('[data-next]');
  await page.waitForTimeout(500);
  if (shots) await page.screenshot({ path: join(shots, 'tour.png') });
  await page.click('[data-skip]');
  await page.waitForTimeout(300);
  ok('Skip closes the tour', !(await page.$('.gx-tour')));
  await page.reload();
  await page.waitForTimeout(3000);
  ok('the tour does not show on the second run', !(await page.$('.gx-tour')));
  ok("no What's new on the second run of the same version", !(await page.$('.gx-whatsnew')));
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('geospax:tour')));
  await page.waitForTimeout(500);
  ok('Help › Take the tour replays it', !!(await page.$('.gx-tour')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok('Esc closes the tour', !(await page.$('.gx-tour')));
  await api('api/ui-state', 'PUT', { lastVersion: '3.0.8' });
  await page.reload();
  await page.waitForSelector('.gx-whatsnew', { timeout: 8000 }).catch(() => {});
  ok("What's new opens after a version change", !!(await page.$('.gx-whatsnew')));
  const ver = (await api('api/health')).json?.version ?? '';
  ok("What's new shows this version's highlights", ((await page.textContent('.gx-whatsnew')) ?? '').includes(ver), ver);
  await page.click('.gx-whatsnew [data-x]');
  ok('the last version run is recorded', (await api('api/ui-state')).json?.lastVersion === ver);
  await api('api/ui-state', 'PUT', { tourSeen: false, tourOff: true });
  await page.reload();
  await page.waitForTimeout(2500);
  ok('"Don\'t show again" keeps the tour away', !(await page.$('.gx-tour')));
  await stop();

  // ------------------------------------------------------------ two OS users
  console.log('per-computer workspaces');
  const s2 = join(tmp, 'state2');
  await start(s2, { perUser: true, user: 'alice' });
  const wa = (await api('api/workspace')).json;
  await api('api/project', 'PUT', { version: 1, order: [], layers: {}, explicit: true, name: 'alice' });
  ok('the workspace lists storage and workflows', typeof wa?.storage === 'object' && Array.isArray(wa?.workflows), Object.keys(wa ?? {}).join(','));
  // Home › Workspace panel
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(2500);
  await page.click('#ribbon-tabs [data-tab="home"]');
  await page.click('[data-cmd="home.workspace"]');
  await page.waitForTimeout(800);
  ok('Home › Workspace opens the panel', /Restricted mode/.test((await page.textContent('body')) ?? '') && !!(await page.$('[data-export]')));
  if (shots) await page.screenshot({ path: join(shots, 'workspace.png') });
  await page.keyboard.press('Escape');
  // tool switches and Restricted mode with a PIN
  let t = await api('api/workspace/tools', 'PUT', { disabledGroups: ['ai'], disabledPlugins: [] });
  ok('a tool group can be switched off for this workspace', t.status === 200 && (await api('api/workspace/tools')).json?.disabledGroups?.includes('ai'), t.text.slice(0, 80));
  t = await api('api/workspace/restricted', 'POST', { on: true, pin: '1357' });
  ok('Restricted mode turns on with a PIN', t.status === 200 && t.json?.restricted === true, t.text.slice(0, 80));
  ok('Restricted mode stops tool changes', (await api('api/workspace/tools', 'PUT', { disabledGroups: [] })).status === 403);
  ok('Restricted mode stops workspace export', (await api('api/workspace/export')).status >= 400);
  ok('a wrong PIN does not lift Restricted mode', (await api('api/workspace/restricted', 'POST', { on: false, pin: '0000' })).status === 403);
  ok('the right PIN lifts Restricted mode', (await api('api/workspace/restricted', 'POST', { on: false, pin: '1357' })).json?.restricted === false);
  const wsSettings = readFileSync(join(wa.folder, 'tools.json'), 'utf8');
  ok('the Restricted mode PIN is stored only as a salted hash', !wsSettings.includes('1357') && /pinSalt/.test(wsSettings));
  // export, then import into another OS user's workspace
  const ex = await fetch(`${base}/api/workspace/export`);
  const zip = Buffer.from(await ex.arrayBuffer());
  ok('Export workspace gives a zip', ex.ok && zip.subarray(0, 2).toString() === 'PK', String(zip.length));
  await stop();
  await start(s2, { perUser: true, user: 'bob' });
  const wb = (await api('api/workspace')).json;
  ok("bob does not see alice's project", (await api('api/project')).json?.name !== 'alice');
  const im = await fetch(`${base}/api/workspace/import`, { method: 'POST', body: zip });
  ok('Import workspace restores it for another OS user', im.ok && (await api('api/project')).json?.name === 'alice', String(im.status));
  ok('two OS users get separate workspaces', wa?.id && wb?.id && wa.id !== wb.id && wa.folder !== wb.folder);
  ok('workspace ids are SHA-256 with no raw machine id or user name', /^[0-9a-f]{64}$/.test(wa?.id ?? '') && !String(wa.folder).includes('alice') && !String(wa.folder).includes('ci-test-machine'));
  await stop();

  // ------------------------------------------------------------ profiles
  console.log('profiles');
  const s3 = join(tmp, 'state3');
  await start(s3, { perUser: true, user: 'carol' });
  let pr = (await api('api/profiles')).json;
  ok('profiles are available, none yet', pr?.available === true && pr.profiles.length === 0);
  ok('profiles carry the convenience note', /not OS-level security/.test(pr?.note ?? ''));
  let r = await api('api/profiles', 'POST', { name: 'Jimmy' });
  ok('the first profile is the admin', r.status === 201 && r.json?.profile?.admin === true, r.text.slice(0, 100));
  if (r.json?.restart) await afterRestart();
  pr = (await api('api/profiles')).json;
  ok('single profile: no "Who\'s working?"', pr?.showPicker === false);
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(2500);
  ok('single profile: the picker is skipped in the app', !(await page.$('.gx-picker')));
  await api('api/project', 'PUT', { version: 1, order: [], layers: {}, explicit: true, name: 'jimmy' });
  r = await api('api/profiles', 'POST', { name: 'Kila', pin: '4321' });
  ok('the admin adds a profile with a PIN', r.status === 201, r.text.slice(0, 100));
  const kila = r.json?.profile?.id;
  r = await api('api/profiles', 'POST', { name: 'kila' });
  ok('profile names are unique', r.status >= 400);
  const wsFolder = (await api('api/workspace')).json?.folder;
  const pfile = JSON.parse(readFileSync(join(wsFolder, 'profiles.json'), 'utf8'));
  const kp = (pfile.profiles ?? pfile).find?.((x) => x.id === kila);
  ok('the PIN is stored as a salted hash, never in clear', !!kp && !JSON.stringify(pfile).includes('4321') && Object.values(kp).some((v) => /^[0-9a-f]{64}$/.test(String(v))) && Object.keys(kp).some((k) => /salt/i.test(k)));
  // the picker shows at startup: start again
  await stop();
  await start(s3, { perUser: true, user: 'carol' });
  await page.reload();
  await page.waitForSelector('.gx-picker', { timeout: 6000 }).catch(() => {});
  ok('"Who\'s working?" shows with two profiles', !!(await page.$('.gx-picker')));
  if (shots) await page.screenshot({ path: join(shots, 'profiles.png') });
  await page.click(`.gx-picker .gx-prof[data-id="${kila}"]`);
  await page.fill('.gx-picker .gx-pin input', '1111');
  await page.click('.gx-picker .gx-pin button');
  await page.waitForTimeout(800);
  ok('a wrong PIN is refused', /PIN/i.test((await page.textContent('.gx-picker [data-msg]')) ?? ''));
  r = await api('api/profiles/choose', 'POST', { id: kila, pin: '4321' });
  ok('the right PIN opens the profile', r.status === 200 && r.json?.restart === true, r.text.slice(0, 100));
  await afterRestart();
  pr = (await api('api/profiles')).json;
  ok('the last profile used is remembered', pr?.current?.id === kila && pr.unlocked === true);
  ok("profiles are isolated (Kila does not see Jimmy's state)", (await api('api/project')).json?.name !== 'jimmy');
  ok('a new profile sees the tour', !(await api('api/ui-state')).json?.tourSeen);
  r = await api('api/profiles', 'POST', { name: 'Third' });
  ok('only the admin adds profiles', r.status === 403);
  r = await api(`api/profiles/${kila}/rename`, 'POST', { name: 'Boss' });
  ok('only the admin renames profiles', r.status === 403);
  console.log('PIN lock after a restart');
  await stop();
  await start(s3, { perUser: true, user: 'carol' });
  r = await api('api/layers');
  ok('a profile with a PIN opens locked', r.status === 423, String(r.status));
  ok('the profiles list stays open while locked', (await api('api/profiles')).status === 200);
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForSelector('.gx-picker', { timeout: 6000 }).catch(() => {});
  ok('the app asks "Who\'s working?" while locked', !!(await page.$('.gx-picker')) && !(await page.$('.gx-picker [data-x]')));
  const admin = pr.profiles.find((x) => x.admin).id;
  r = await api('api/profiles/choose', 'POST', { id: admin, pin: '' });
  ok('switch to the admin profile', r.status === 200, r.text.slice(0, 100));
  if (r.json?.restart) await afterRestart();
  ok('the admin is back in its own workspace', (await api('api/project')).json?.name === 'jimmy');
  r = await api(`api/profiles/${kila}/restricted`, 'POST', { on: true });
  ok('the admin restricts a profile', r.status === 200, r.text.slice(0, 100));
  r = await api(`api/profiles/${admin}/restricted`, 'POST', { on: true });
  ok('the admin profile cannot be restricted', r.status >= 400);
  r = await api(`api/profiles/${admin}/remove`, 'POST', {});
  ok('the admin profile cannot be removed', r.status >= 400);
  r = await api(`api/profiles/${kila}/pin`, 'POST', { pin: '2468' });
  ok('the admin resets a PIN', r.status === 200, r.text.slice(0, 100));
  r = await api('api/profiles/choose', 'POST', { id: kila, pin: '4321' });
  ok('the old PIN no longer works', r.status >= 400);
  r = await api('api/profiles/choose', 'POST', { id: kila, pin: '2468' });
  if (r.json?.restart) await afterRestart();
  const tools = (await api('api/workspace/tools')).json;
  ok('a restricted profile is in Restricted mode', tools?.restricted === true && tools?.byAdmin === true);
  r = await api('api/workspace/tools', 'PUT', { disabledGroups: [] });
  ok('a restricted profile cannot change the tools', r.status === 403);
  r = await api('api/workspace/restricted', 'POST', { on: false, pin: '2468' });
  ok('a restricted profile cannot lift Restricted mode itself', r.status === 403);
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(3000);
  ok('Restricted mode hides editing in the app', await page.evaluate(() => document.body.dataset.restricted === '1' && (() => { const e = document.querySelector('#ribbon-tabs [data-tab="edit"]'); return !!e && getComputedStyle(e).display === 'none'; })()));
  ok('the title bar shows the profile', ((await page.textContent('#profile-btn').catch(() => '')) ?? '').includes('Kila'));

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  code = failed.length ? 1 : 0;
} catch (e) {
  console.error(e);
  failed.push(String(e));
} finally {
  await browser.close();
  await stop();
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
}
console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
process.exit(code);
