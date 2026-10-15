// 3D viewer check (scene.html written by the scene.3d step; needs `playwright` + Chromium):
//   PW=/path/to/node_modules/playwright node scripts/test-web-scene.mjs OUT_DIR NAME=scene.html [NAME=...]
// For each file: opens it offline (no network at all), waits for the WebGL viewer, checks that the
// model fills the view, then drags to turn, scrolls to zoom, Shift-drags to pan, toggles every
// layer, turns to north with the compass and double-clicks to reset; screenshots
// OUT_DIR/<NAME>.png and <NAME>-points.png. Prints one JSON line per file; exits 1 on a failure.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const [out, ...files] = process.argv.slice(2);
if (!out || !files.length) {
  console.error('usage: test-web-scene.mjs OUT_DIR NAME=scene.html [NAME=scene.html ...]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;

for (const arg of files) {
  const [name, file] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg.replace(/.*\//, '').replace(/\.html$/, ''), arg];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const problems = [];
  const requests = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // the viewer must work offline: block (and count) anything that is not the file itself
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    requests.push(u);
    return r.abort();
  });
  const res = { name, checks: [] };
  const check = (ok, msg) => {
    res.checks.push(`${ok ? 'ok' : 'FAIL'}: ${msg}`);
    if (!ok) failed++;
  };
  const t0 = Date.now();
  await page.goto(pathToFileURL(file).href);
  const ready = await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 60000 }).then((h) => h.jsonValue()).catch(() => 'timeout');
  res.load_s = (Date.now() - t0) / 1000;
  check(ready === '1', `viewer ready (${ready}) in ${res.load_s.toFixed(1)} s`);
  if (ready !== '1') {
    res.error = await page.textContent('#err').catch(() => '');
    await page.screenshot({ path: `${out}/${name}-failure.png` });
    console.log(JSON.stringify(res));
    await page.close();
    continue;
  }
  const info = await page.evaluate(() => ({ ...window.geospaxScene, camera: window.geospaxScene.camera() }));
  res.triangles = info.triangles;
  res.points = info.points;
  res.groups = info.groups;
  check(info.triangles > 1000 && info.textures >= 1, `${info.triangles} triangles, ${info.textures} texture(s), groups ${info.groups.join('/')}`);
  // share of the canvas covered by the model (the sky is the transparent page background)
  const coverage = async () =>
    page.evaluate(() => {
      const c = document.getElementById('c');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
      return n / (c.width * c.height);
    });
  res.coverage = await coverage();
  check(res.coverage > 0.25 && res.coverage < 0.98, `model covers ${(res.coverage * 100).toFixed(0)} % of the view`);
  await page.screenshot({ path: `${out}/${name}.png` });

  // turn: drag right by 200 px
  const box = await page.locator('#c').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 40, { steps: 8 });
  await page.mouse.up();
  let cam = await page.evaluate(() => window.geospaxScene.camera());
  const turned = (cam.bearing - info.camera.bearing + 360) % 360;
  check(turned > 30 && turned < 90 && cam.elevation > info.camera.elevation, `drag turns the view (${turned.toFixed(0)}°, tilt ${info.camera.elevation.toFixed(0)}° → ${cam.elevation.toFixed(0)}°)`);
  // zoom: scroll in
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(100);
  const cam2 = await page.evaluate(() => window.geospaxScene.camera());
  check(cam2.distance < cam.distance * 0.7, `scroll zooms in (${cam.distance.toFixed(0)} → ${cam2.distance.toFixed(0)} m)`);
  // pan: Shift-drag moves the target, not the angle
  await page.keyboard.down('Shift');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 150, cy, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const cam3 = await page.evaluate(() => window.geospaxScene.camera());
  const moved = Math.hypot(cam3.target[0] - cam2.target[0], cam3.target[2] - cam2.target[2]);
  check(moved > 1 && Math.abs(cam3.bearing - cam2.bearing) < 0.01, `Shift-drag pans ${moved.toFixed(1)} m`);
  // compass: face north; double-click: back home
  await page.click('#compass');
  cam = await page.evaluate(() => window.geospaxScene.camera());
  check(Math.abs(cam.bearing - 180) < 0.01, 'compass turns the view to face north');
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(100);
  cam = await page.evaluate(() => window.geospaxScene.camera());
  check(Math.abs(cam.bearing - info.camera.bearing) < 0.01 && Math.abs(cam.distance - info.camera.distance) < 0.01 * info.camera.distance, 'double-click resets the view');
  // layer switches: every group can be hidden; the point cloud (off by default next to a model) can be shown
  const labels = await page.$$eval('#bar label', (ls) => ls.map((l) => ({ g: l.dataset.group, on: l.querySelector('input').checked })));
  res.layers = labels;
  check(labels.length === info.groups.length, `a switch per layer: ${labels.map((l) => `${l.g}${l.on ? '' : ' (off)'}`).join(', ')}`);
  const before = await coverage();
  await page.click('#bar label[data-group="terrain"] input');
  await page.waitForTimeout(50);
  const noTerrain = await coverage();
  check(noTerrain < before * 0.6, `hiding the terrain clears most of the view (${(before * 100).toFixed(0)} % → ${(noTerrain * 100).toFixed(0)} %)`);
  await page.click('#bar label[data-group="terrain"] input');
  if (info.groups.includes('points')) {
    const pts = labels.find((l) => l.g === 'points');
    for (const g of ['buildings', 'trees']) if (info.groups.includes(g)) await page.click(`#bar label[data-group="${g}"] input`);
    if (!pts.on) await page.click('#bar label[data-group="points"] input');
    await page.click('#bar label[data-group="terrain"] input');
    await page.waitForTimeout(50);
    const cloud = await coverage();
    check(cloud > 0.1, `the point cloud alone covers ${(cloud * 100).toFixed(0)} % of the view`);
    await page.screenshot({ path: `${out}/${name}-points.png` });
  }
  check(!problems.length, `no console errors${problems.length ? ': ' + problems.slice(0, 3).join(' | ') : ''}`);
  check(!requests.length, `no network requests${requests.length ? ': ' + requests.slice(0, 3).join(' ') : ''}`);
  console.log(JSON.stringify(res));
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
