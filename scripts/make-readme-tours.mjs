// README tour screenshots: real analyses on real data, in Pro mode with the dark theme.
//
// Against a GeoSpaX web edition started on an empty state folder, this downloads and computes everything
// through the same API the app uses, then photographs each result:
//   1 elevation   Copernicus GLO-30 DEM (downloaded) on a hillshade, with contours   (Geoscience)
//   2 sdm         birdwing butterfly species distribution model, WorldClim + tree cover (Biodiversity)
//   3 slope       slope zones from the DEM                                          (Disaster: landslides)
//   4 forest      Hansen tree cover 2000 and forest loss 2001–2025 (downloaded)     (Forestry)
//   5 marine      GEBCO 2026 sea depth (downloaded) with contours                   (Marine)
//   6 hotspots    hexagon hot-spot grid of birdwing presences and host vines        (Conservation)
//   7 clusters    Local Moran's I clusters of vegetation (NDVI) survey plots        (Environment)
//   8 buildings   Overture Maps buildings of Lae (downloaded), Explorer open        (Land use)
//   9 r-3d        the DEM in 3D from an R step (terra + persp), in the run report
//  10 python-3d   the DEM in 3D from a Python step (rasterio + matplotlib), in the run report
//
//   node scripts/make-readme-tours.mjs [base] [out-dir]
// (needs internet access to the Copernicus DEM, Hansen, GEBCO and Overture buckets, R with terra, and the
// server started with GEOSPAX_PYTHON naming a Python that has numpy, matplotlib and rasterio)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const out = process.argv[3] ?? 'docs/assets/tour';
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, type = 'application/json') {
  const r = await fetch(base + path, { method, body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body, headers: body === undefined ? {} : { 'content-type': type } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

/** Save a one-step-or-more recipe and run it to the end; returns the run (layers, rasters). */
async function recipe(id, title, steps) {
  const yaml = [`recipe: ${id}`, 'version: 1', `title: ${JSON.stringify(title)}`, 'steps:',
    ...steps.flatMap((s) => [`  - id: ${s.id}`, `    use: ${s.use}`, `    with: ${JSON.stringify(s.with)}`]),
    `outputs: [${steps.map((s) => s.id).join(', ')}]`, ''].join('\n');
  // R and Python steps run code: this script wrote it, so it approves it (the app asks the user)
  const code = steps.some((s) => s.use === 'r' || s.use === 'python');
  await api('POST', `/api/recipes${code ? '?approve=code' : ''}`, yaml, 'text/yaml');
  const run = await api('POST', `/api/recipes/${id}/run`);
  for (;;) {
    const r = await api('GET', `/api/runs/${run.id}`);
    if (r.status === 'done') return r;
    if (r.status === 'failed' || r.status === 'cancelled') throw new Error(`${title}: ${r.error}`);
    await sleep(2000);
  }
}

const tool = (plugin, id, params) => api('POST', `/api/plugins/${plugin}/tools/${id}/run`, { params });

console.log('data …');
await api('POST', '/api/samples/png');
const highlands = [144.9, -6.3, 145.6, -5.7]; // around Mount Wilhelm, Papua New Guinea's highest peak
const dem = await recipe('tour-elevation', 'Elevation, hillshade and contours', [
  { id: 'dem', use: 'dem.fetch', with: { aoi: highlands, source: 'copernicus', name: 'copernicus_dem_30m' } },
  { id: 'terrain', use: 'terrain.derive', with: { dem: '${dem.raster}', products: ['hillshade', 'slope'] } },
  { id: 'contours', use: 'terrain.contours', with: { dem: '${dem.raster}', interval: 200, index: 5 } },
]);
console.log('  elevation:', dem.rasters, dem.layers);
const demId = dem.rasters.find((r) => !/hillshade|slope/.test(r));
const huon = [146.8, -7.4, 148.2, -6.2]; // Huon Gulf: Lae and the deep trench off the Huon Peninsula
const sea = await recipe('tour-marine', 'Sea depth (GEBCO 2026)', [
  { id: 'gebco', use: 'data.fetch', with: { source: 'gebco', aoi: huon, layers: ['elevation'] } },
  { id: 'contours', use: 'terrain.contours', with: { dem: '${gebco.raster}', interval: 500, index: 4 } },
]);
console.log('  marine:', sea.rasters, sea.layers);
const forestArea = [146.6, -7.3, 147.2, -6.8]; // lowland forest south-west of Lae
const forest = await recipe('tour-forest', 'Forest cover and loss (Hansen)', [
  { id: 'hansen', use: 'data.fetch', with: { source: 'hansen', aoi: forestArea, layers: ['treecover', 'loss'] } },
]);
console.log('  forest:', forest.rasters);

console.log('analyses …');
const sdm = await tool('geospax-biodiversity', 'sdm', { occurrences: 'birdwing_butterfly_presences.geojson', covariates: ['worldclim_bio1_temperature', 'worldclim_bio12_precipitation', 'tree_cover_pct'], method: 'logistic' });
console.log('  sdm:', sdm.result.message);
const slope = await tool('geospax-disaster', 'slope-zones', { dem: demId });
console.log('  slope zones:', slope.added);
const hot = await tool('geospax-conservation', 'hotspot-grid', { layer: 'birdwing_butterfly_presences.geojson', layer2: 'birdwing_host_vines.geojson', cell_km: 4, shape: 'hex', score: 'count' });
console.log('  hot spots:', hot.added);
const moran = await tool('geospax-biodiversity', 'local-moran', { layer: 'habitat_survey_grid.geojson', field: 'ndvi', neighbours: 'k-nearest', k: 8 });
console.log('  local Moran:', moran.result?.message ?? moran.added);
// R and Python: the same DEM in 3D, as recipe steps (GEOSPAX_PYTHON names a Python with rasterio + matplotlib)
const rRun = await recipe('tour-r-3d', 'Mount Wilhelm in 3D (R)', [
  { id: 'relief', use: 'r', with: { inputs: { dem: demId }, packages: ['terra'], code: "library(terra)\ncell <- mean(res(dem)) * if (is.lonlat(dem)) 111320 else 1\nf <- max(1, ceiling(max(dim(dem)[1:2]) / 320))\nd <- if (f > 1) aggregate(dem, fact = f) else dem\nm <- as.matrix(d, wide = TRUE)\nz <- t(m[nrow(m):1, ])\nz[is.na(z)] <- min(z, na.rm = TRUE)\nnr <- nrow(z); nc <- ncol(z)\nzf <- (z[-1, -1] + z[-1, -nc] + z[-nr, -1] + z[-nr, -nc]) / 4\npal <- hcl.colors(120, \"Earth\")\ncol <- pal[cut(zf, 120)]\nexaggeration <- 2\nsave_figure(\"mount_wilhelm_3d\", function() {\n  par(mar = c(0, 0, 2.5, 0), bg = \"#0b0d10\")\n  persp(seq_len(nr), seq_len(nc), z, theta = 35, phi = 30, expand = exaggeration / (cell * f), col = col,\n        border = NA, shade = 0.55, ltheta = -70, lphi = 35, box = FALSE, scale = FALSE,\n        main = \"Mount Wilhelm, Papua New Guinea \u00b7 Copernicus 30 m \u00b7 R (terra + persp)\", col.main = \"#e8e8e8\", cex.main = 1)\n}, width = 260, height = 170, formats = \"png\")\nlist(relief_stats = data.frame(peak_m = max(values(dem), na.rm = TRUE), cells_drawn = nr * nc))" } },
]);
console.log('  R 3D:', rRun.status, rRun.artifacts?.filter((a) => a.endsWith('.png')));
const pyRun = await recipe('tour-python-3d', 'Mount Wilhelm in 3D (Python)', [
  { id: 'relief', use: 'python', with: { inputs: { dem: demId }, packages: ['numpy', 'matplotlib', 'rasterio'], code: "import numpy as np\nimport matplotlib\nmatplotlib.use(\"Agg\")\nimport matplotlib.pyplot as plt\nfrom matplotlib.colors import LightSource\nstep = max(1, max(dem.width, dem.height) // 420)\nz = dem.read(1, out_shape=(dem.height // step, dem.width // step), masked=True).astype(float).filled(np.nan)\nz = np.where(np.isnan(z), np.nanmin(z), z)\ncell = abs(dem.res[0]) * step * (111320 if dem.crs and dem.crs.is_geographic else 1)\nrgb = LightSource(azdeg=315, altdeg=35).shade(z, cmap=plt.cm.gist_earth, vert_exag=2, dx=cell, dy=cell, blend_mode=\"soft\")\nfig = plt.figure(figsize=(13, 8), facecolor=\"#0b0d10\")\nax = fig.add_subplot(projection=\"3d\", facecolor=\"#0b0d10\")\ny, x = np.mgrid[0:z.shape[0], 0:z.shape[1]]\nax.plot_surface(x, -y, z, facecolors=rgb, rstride=1, cstride=1, linewidth=0, antialiased=False, shade=False)\nax.set_box_aspect((z.shape[1], z.shape[0], 2 * (np.nanmax(z) - np.nanmin(z)) / cell))\nax.view_init(elev=38, azim=-58)\nax.set_axis_off()\nax.set_title(\"Mount Wilhelm, Papua New Guinea \u00b7 Copernicus 30 m \u00b7 Python (rasterio + matplotlib)\", color=\"#e8e8e8\")\nplt.savefig(figure_path(\"mount_wilhelm_3d\"), dpi=140, bbox_inches=\"tight\", facecolor=\"#0b0d10\")\nresult(peak_m=round(float(np.nanmax(z))), cells=int(z.size))" } },
]);
console.log('  Python 3D:', pyRun.status, pyRun.artifacts?.filter((a) => a.endsWith('.png')));
const lae = [146.97, -6.75, 147.03, -6.70];
const ov = await api('POST', `/api/overture?theme=buildings&bbox=${lae.join(',')}`);
let ovJob;
for (;;) {
  ovJob = await api('GET', `/api/jobs/${ov.job}`);
  if (ovJob.status === 'done' || ovJob.status === 'failed') break;
  await sleep(2000);
}
console.log('  Overture:', ovJob.status, ovJob.message);

// --------------------------------------------------------------- photographs
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
// the bottom dock (Automate, History, Log) folded away: the map gets the room
await page.addInitScript(() => {
  try {
    const l = JSON.parse(localStorage.getItem('geospax.workbench.v1') || '{}');
    localStorage.setItem('geospax.workbench.v1', JSON.stringify({ ...l, collapsed: ['bottom'] }));
  } catch { /* first start */ }
});
await page.goto(`${base}/?mode=pro&theme=dark`);
await page.waitForTimeout(6000);

/** Show only `keep` (bottom first), the map at `view`, and select `focus` (its symbology on the right). */
async function shot(file, keep, view, focus, extra) {
  const pr = await api('GET', '/api/project');
  const all = new Set([...(pr.order ?? []), ...(pr.removed ?? [])]);
  const keepIds = keep.filter((k) => all.has(k));
  pr.removed = [...all].filter((x) => !keepIds.includes(x));
  pr.order = keepIds;
  // rasters come in switched off: every kept layer is shown
  pr.layers = pr.layers ?? {};
  for (const k of keepIds) pr.layers[k] = { ...(pr.layers[k] ?? {}), visible: true };
  pr.view = view;
  await api('PUT', '/api/project', pr);
  await page.goto(`${base}/?mode=pro&theme=dark`);
  await page.waitForTimeout(5000);
  // rasters start switched off: tick them, as a user would
  for (const cb of await page.$$('#contents .layer.raster input[type=checkbox]:not(:checked)')) {
    await cb.click().catch(() => {});
    await page.waitForTimeout(400);
  }
  if (focus) {
    const row = page.locator(`#contents [data-id="${focus}"] .name, #contents [data-layer="${focus}"] .name`).first();
    if (await row.count()) await row.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (extra) await extra();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, file) });
  console.log('  ', file, keepIds.length, 'layers');
}

const r = (id) => `r:${id}`;
const added = (t, re) => (t.added ?? []).find((x) => re.test(x));
const hs = dem.rasters.find((x) => /hillshade/.test(x));
const contours = dem.layers[0];
console.log('photographs …');
await shot('tour-elevation.png', [r(hs), r(demId), contours], { center: [145.2, -5.95], zoom: 10.4 }, r(demId));
await shot('tour-sdm.png', [r(added(sdm, /^suitability/)), 'birdwing_butterfly_presences.geojson'], { center: [145.9, -6.4], zoom: 8.2 }, r(added(sdm, /^suitability/)));
await shot('tour-slope.png', [r(hs), r(added(slope, /.*/)), contours], { center: [145.2, -5.95], zoom: 10.4 }, r(added(slope, /.*/)));
await shot('tour-forest.png', forest.rasters.map(r), { center: [146.9, -7.05], zoom: 10 }, r(forest.rasters.find((x) => /loss/.test(x)) ?? forest.rasters[0]));
await shot('tour-marine.png', [r(sea.rasters[0]), ...sea.layers], { center: [147.5, -6.8], zoom: 8.6 }, r(sea.rasters[0]));
await shot('tour-hotspots.png', [added(hot, /.*/), 'birdwing_host_vines.geojson', 'birdwing_butterfly_presences.geojson'], { center: [145.9, -6.4], zoom: 8.4 }, added(hot, /.*/));
await shot('tour-clusters.png', [added(moran, /.*/)], { center: [145.9, -6.4], zoom: 8.4 }, added(moran, /.*/));
const ovLayer = ovJob.result?.layers?.[0];
await shot('tour-buildings.png', [ovLayer], { center: [147.0, -6.725], zoom: 14.5 }, ovLayer, async () => {
  await page.click('#dock-left .dock-tabs [data-tab="catalog"]').catch(() => {});
  await page.waitForTimeout(500);
  await page.click('[data-gx="overture"]').catch(() => {});
});
// the R and Python figures, in the run report (Explorer › GeoSpaX › Results)
for (const [file, run] of [['tour-r-3d.png', rRun], ['tour-python-3d.png', pyRun]]) {
  await shot(file, [r(hs), r(demId)], { center: [145.2, -5.95], zoom: 10.4 }, r(demId), async () => {
    // the run's figure, opened from its files in the Automate pane
    await page.evaluate(() => document.querySelector('#dock-bottom .dock-tabs [data-tab="automate"]')?.click());
    await page.waitForTimeout(1500);
    const fig = page.locator(`[data-runid="${run.id}"][data-art$=".png"]`).first();
    if (await fig.count()) await fig.click();
    else console.log('   (no figure button for', run.id, ')');
    await page.waitForTimeout(3000);
  });
}
await browser.close();
console.log('done');
