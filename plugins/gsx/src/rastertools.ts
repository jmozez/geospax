import { maxOf, minOf } from './analysis/extent';
// Raster and species-distribution tools (GSX phase B, from GeoSpaX 2.0): spectral index with an
// Otsu threshold, two-date raster change, slope zones and species distribution models (BIOCLIM,
// Mahalanobis, presence-background logistic) with spatially blocked cross-validation. The maths is
// GeoSpaX 2.0's src/analysis, unchanged; this file reads GeoSpaX rasters (Grid) and writes results.
import proj4 from 'proj4';
import type { Point } from 'geojson';
import * as A from './analysis';
import type { Ctx, Grid, OutGrid, Param, Tool } from './tools';

const WGS84 = 'EPSG:4326';
const SPECTRAL = 'Image Analysis › Spectral indices';
const CHANGE = 'Image Analysis › Change detection';
const SLOPE = 'Terrain › Slope zones';
const SDM = 'Species Distribution';

// ---------------------------------------------------------------- grid helpers

const cellCount = (g: Grid) => g.width * g.height;
/** cell centre in the raster's CRS */
const centre = (g: Grid, i: number): [number, number] => {
  const [x0, dx, , y0, , dy] = g.transform;
  return [x0 + ((i % g.width) + 0.5) * dx, y0 + (Math.floor(i / g.width) + 0.5) * dy];
};
/** raster CRS ⇄ lon/lat (geographic rasters need no projection) */
export const projector = (g: Grid) => {
  if (g.geographic || !g.crs) return { toLonLat: (p: [number, number]) => p, fromLonLat: (p: [number, number]) => p };
  try {
    const conv = proj4(g.crs, WGS84);
    return { toLonLat: (p: [number, number]) => conv.forward(p) as [number, number], fromLonLat: (p: [number, number]) => conv.inverse(p) as [number, number] };
  } catch {
    throw new Error(`the CRS of ${g.title} could not be read; reproject it to WGS84 (EPSG:4326) or UTM first`);
  }
};
/** the cell under a point given in the raster's CRS, or -1 */
const cellAt = (g: Grid, [x, y]: [number, number]) => {
  const [x0, dx, , y0, , dy] = g.transform;
  const c = Math.floor((x - x0) / dx);
  const r = Math.floor((y - y0) / dy);
  return c < 0 || r < 0 || c >= g.width || r >= g.height ? -1 : r * g.width + c;
};
/** lon/lat bounds [w, s, e, n] of the grid */
const lonLatBounds = (g: Grid): [number, number, number, number] => {
  const { toLonLat } = projector(g);
  const [x0, dx, , y0, , dy] = g.transform;
  const xs = [x0, x0 + dx * g.width];
  const ys = [y0, y0 + dy * g.height];
  const pts = xs.flatMap((x) => ys.map((y) => toLonLat([x, y])));
  return [minOf(pts.map((p) => p[0])), minOf(pts.map((p) => p[1])), maxOf(pts.map((p) => p[0])), maxOf(pts.map((p) => p[1]))];
};
/** ground size of one cell in metres */
export const cellSize = (g: Grid): { w: number; h: number; area: number } => {
  if (!g.geographic) {
    const w = Math.abs(g.transform[1]);
    const h = Math.abs(g.transform[5]);
    return { w, h, area: w * h };
  }
  const p = A.pixelSizeAtCentre(lonLatBounds(g), g.width, g.height);
  if (!p) throw new Error(`${g.title}: its extent is degenerate`);
  return { w: p.pixelWidthM, h: p.pixelHeightM, area: p.pixelAreaM2 };
};
const band = (g: Grid, oneBased: number, what: string) => {
  const b = g.bands[oneBased - 1];
  if (!b) throw new Error(`${g.title} has ${g.bands.length} band(s); ${what} is band ${oneBased}`);
  return b;
};
const num = (ctx: Ctx, name: string, dflt: number) => {
  const v = ctx.params[name];
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${name}' must be a number`);
  return n;
};
const needRaster = (ctx: Ctx, name: string, what: string) => {
  const g = ctx.raster(name);
  if (!g) throw new Error(`Choose ${what}`);
  return g;
};
const ha = (m2: number) => A.formatArea(m2, 'ha').display;
const fix = (v: number | null | undefined, d = 3) => (v == null || !Number.isFinite(v) ? '—' : Number(v.toFixed(d)));
const arr = (f: Float32Array) => Array.from(f);

const rasterParam = (name: string, label: string, description?: string): Param => ({ name, label, kind: 'raster', required: true, description });

/** Spatially blocked k-fold CV with the blocks that hold presences dealt to the folds first, so
 *  no fold is left without presences when occurrences are clustered (2.0's crossValidateSdm
 *  shuffles all blocks together). Same metrics: ROC AUC, max-TSS, continuous Boyce. */
function blockedCv<M>(o: {
  pres: number[][]; presXY: Array<[number, number]>; bg: number[][]; bgXY: Array<[number, number]>;
  k: number; blockDeg: number; fit: (p: number[][], b: number[][]) => M | null; predict: (v: number[], m: M) => number | null;
}) {
  const key = ([x, y]: [number, number]) => `${Math.floor(x / o.blockDeg)}:${Math.floor(y / o.blockDeg)}`;
  let state = 7;
  const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pBlocks = shuffle([...new Set(o.presXY.map(key))].sort());
  const k = Math.max(2, Math.min(o.k, pBlocks.length));
  const fold = new Map<string, number>(pBlocks.map((b, i) => [b, i % k]));
  shuffle([...new Set(o.bgXY.map(key))].filter((b) => !fold.has(b)).sort()).forEach((b, i) => fold.set(b, i % k));
  const pf = o.presXY.map((p) => fold.get(key(p))!);
  const bf = o.bgXY.map((p) => fold.get(key(p))!);
  const folds = [];
  for (let f = 0; f < k; f++) {
    const trP = o.pres.filter((_, i) => pf[i] !== f), teP = o.pres.filter((_, i) => pf[i] === f);
    const trB = o.bg.filter((_, i) => bf[i] !== f), teB = o.bg.filter((_, i) => bf[i] === f);
    if (!teP.length || !teB.length || !trP.length || !trB.length) { folds.push({ fold: f, skipped: 'a fold has no presences or no background' }); continue; }
    const m = o.fit(trP, trB);
    if (!m) { folds.push({ fold: f, skipped: 'the model could not be fitted on the training folds' }); continue; }
    const ps = teP.map((v) => o.predict(v, m)), bs = teB.map((v) => o.predict(v, m));
    folds.push({ fold: f, auc: A.rocAuc(ps, bs), tss: A.maxTssThreshold(ps, bs)?.tss ?? null, boyce: A.boyceIndex(ps, bs).index });
  }
  const sum = (xs: Array<number | null | undefined>) => {
    const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (!v.length) return { mean: null, sd: null, n: 0 } as A.MetricSummary;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return { mean, sd: v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : null, n: v.length } as A.MetricSummary;
  };
  return {
    folds, k, blockCount: fold.size, presenceBlocks: pBlocks.length,
    auc: sum(folds.map((f) => ('auc' in f ? f.auc : null))), tss: sum(folds.map((f) => ('tss' in f ? f.tss : null))), boyce: sum(folds.map((f) => ('boyce' in f ? f.boyce : null))),
  };
}

// ---------------------------------------------------------------- tools

export const RASTER_TOOLS: Tool[] = [
  {
    id: 'spectral-index',
    name: 'Spectral index and extent (Otsu)',
    summary: 'NDVI, NDWI, NDBI, NBR or any band pair from a multiband image, with an automatic Otsu threshold and the area above it.',
    group: SPECTRAL,
    icon: 'satellite',
    params: [
      rasterParam('image', 'Image', 'A multiband raster (Sentinel-2, Landsat, drone …).'),
      { name: 'index', label: 'Index', kind: 'choice', default: 'NDVI', choices: ['NDVI', 'NDWI', 'NDBI', 'NBR', 'CUSTOM'], description: 'Formula (A − B) / (A + B); the bands below say which band is A and which is B.' },
      { name: 'band_a', label: 'Band A', kind: 'number', default: 4, description: 'NDVI/NDWI/NBR: near infrared; NDBI: SWIR. 1 = first band.' },
      { name: 'band_b', label: 'Band B', kind: 'number', default: 3, description: 'NDVI: red; NDWI/NDBI: NIR or SWIR; NBR: SWIR2.' },
      { name: 'threshold', label: 'Threshold (blank = Otsu)', kind: 'number', description: 'Cells at or above it count as the extent (vegetation, water, built-up, burnt …).' },
    ],
    run(ctx) {
      const g = needRaster(ctx, 'image', 'an image');
      const preset = (String(ctx.params.index ?? 'NDVI').toUpperCase() as A.IndexPresetId) in A.INDEX_PRESETS ? (String(ctx.params.index ?? 'NDVI').toUpperCase() as A.IndexPresetId) : 'NDVI';
      const ia = num(ctx, 'band_a', 4);
      const ib = num(ctx, 'band_b', 3);
      const nd = A.normalizedDifferenceGrid(arr(band(g, ia, 'band A')), arr(band(g, ib, 'band B')), g.width, g.height, null, null);
      if (!nd.validCells) throw new Error('No cell has a value in both bands');
      const otsu = A.otsuThreshold(A.histogramND(nd.nd, 128, [-1, 1]));
      const given = ctx.params.threshold;
      const t = given !== undefined && given !== null && given !== '' ? Number(given) : otsu.threshold;
      if (t === null || !Number.isFinite(t)) throw new Error('Otsu found no threshold (the index has a single value); give one');
      const mask = A.maskForThreshold(nd.nd, t);
      const classes = new Float32Array(cellCount(g)).fill(Number.NaN);
      let above = 0;
      for (let i = 0; i < classes.length; i++) {
        if (!Number.isFinite(nd.nd[i])) continue;
        classes[i] = mask[i];
        above += mask[i];
      }
      const cell = cellSize(g);
      const p = A.INDEX_PRESETS[preset];
      const kind = ['NDVI', 'NDWI', 'NBR'].includes(preset) ? preset.toLowerCase() : 'raster';
      return {
        message: `${preset} of ${g.title}: ${ha(above * cell.area)} at or above ${t.toFixed(3)} (${((100 * above) / nd.validCells).toFixed(1)} % of the image)`,
        rasters: [
          { name: `${preset} ${g.title}`, like: g, data: nd.nd, kind, units: 'index', description: `${p.formula}; band ${ia} as A, band ${ib} as B` },
          {
            name: `${preset} extent ${g.title}`, like: g, data: classes, kind: 'classes',
            classes: [{ value: 0, label: `below ${t.toFixed(2)}`, color: '#d9d9d9' }, { value: 1, label: `${preset} ≥ ${t.toFixed(2)}`, color: preset === 'NDWI' ? '#2c7fb8' : preset === 'NDBI' ? '#d95f0e' : preset === 'NBR' ? '#7a0177' : '#1a9850' }],
          },
        ],
        table: [
          ['Index', `${preset}: ${p.formula}`],
          ['Bands', `A = band ${ia} (${g.bandNames[ia - 1] ?? ''}), B = band ${ib} (${g.bandNames[ib - 1] ?? ''})`],
          ['Minimum', fix(nd.min)], ['Mean', fix(nd.mean)], ['Maximum', fix(nd.max)],
          ['Threshold', `${t.toFixed(3)}${given !== undefined && given !== '' && given !== null ? ' (given)' : ' (Otsu)'}`],
          ['Extent', ha(above * cell.area)],
          ['Share of valid cells', `${((100 * above) / nd.validCells).toFixed(1)} %`],
          ['Cell size', `${cell.w.toFixed(1)} × ${cell.h.toFixed(1)} m`],
        ],
        notes: [A.BAND_ASSIGNMENT_CAVEAT, ...(nd.nodataCells ? [`${nd.nodataCells.toLocaleString('en-US')} cells had no data or a zero denominator and are left out.`] : [])],
      };
    },
  },
  {
    id: 'raster-change',
    name: 'Raster change (two dates)',
    summary: 'After − before for one band of two images or index rasters, with Otsu thresholds for gain and loss and their areas.',
    group: CHANGE,
    icon: 'clock',
    params: [
      rasterParam('before', 'Before', 'The earlier raster (an NDVI from Spectral index, a DEM, a classification score …).'),
      rasterParam('after', 'After', 'The later raster; it is resampled onto the earlier one’s grid.'),
      { name: 'band', label: 'Band', kind: 'number', default: 1 },
    ],
    run(ctx) {
      const a = needRaster(ctx, 'before', 'the earlier raster');
      const b = needRaster(ctx, 'after', 'the later raster');
      const bi = num(ctx, 'band', 1);
      const ch = A.differenceGrid(arr(band(b, bi, 'the band')), arr(band(a, bi, 'the band')), a.width, a.height, null, null);
      if (!ch.validCells) throw new Error('The two rasters do not overlap');
      const o = A.changeOtsu(ch.diff);
      const classes = new Float32Array(cellCount(a)).fill(Number.NaN);
      let gain = 0;
      let loss = 0;
      for (let i = 0; i < classes.length; i++) {
        const d = ch.diff[i];
        if (!Number.isFinite(d)) continue;
        const g = o.otsuGain !== null && d >= o.otsuGain;
        const l = o.otsuLoss !== null && d <= o.otsuLoss;
        classes[i] = g ? 2 : l ? 0 : 1;
        gain += +g;
        loss += +l;
      }
      const cell = cellSize(a);
      return {
        message: `Change from ${a.title} to ${b.title}: ${ha(loss * cell.area)} loss, ${ha(gain * cell.area)} gain`,
        rasters: [
          { name: `Change ${b.title} minus ${a.title}`, like: a, data: ch.diff, kind: 'change', description: 'after − before' },
          {
            name: `Change classes ${a.title} to ${b.title}`, like: a, data: classes, kind: 'classes',
            classes: [{ value: 0, label: 'loss', color: '#d7191c' }, { value: 1, label: 'no clear change', color: '#e0e0e0' }, { value: 2, label: 'gain', color: '#1a9641' }],
          },
        ],
        table: [
          ['Loss threshold (Otsu)', fix(o.otsuLoss)], ['Gain threshold (Otsu)', fix(o.otsuGain)],
          ['Loss', ha(loss * cell.area)], ['Gain', ha(gain * cell.area)],
          ['Cells compared', ch.validCells.toLocaleString('en-US')],
        ],
        notes: [
          'Difference = after − before on the earlier raster’s grid; both dates should come from the same sensor and processing (radiometric differences show up as change).',
          'Otsu splits the negative and positive halves of the difference histogram separately; check the thresholds against known change before reporting areas.',
        ],
      };
    },
  },
  {
    id: 'slope-zones',
    name: 'Slope zones',
    summary: 'Horn slope from a DEM in three zones (gentle, moderate, steep) with their areas; breaks in degrees.',
    group: SLOPE,
    icon: 'image',
    params: [
      rasterParam('dem', 'Elevation (DEM)', 'Metres; geographic or projected.'),
      { name: 'breaks', label: 'Breaks (°)', kind: 'text', default: '8, 20', description: 'Two slopes that split gentle | moderate | steep.' },
    ],
    run(ctx) {
      const g = needRaster(ctx, 'dem', 'a DEM');
      const br = String(ctx.params.breaks ?? '8, 20').split(/[,;\s]+/).map(Number).filter(Number.isFinite);
      if (br.length !== 2) throw new Error('Breaks: give two slopes in degrees, e.g. 8, 20');
      const cell = cellSize(g);
      const horn = A.hornSlopeAndAspect({ values: arr(g.bands[0]), width: g.width, height: g.height, pixelWidthM: cell.w, pixelHeightM: cell.h, nodata: null });
      const cls = A.classifySlope(horn.slopeDeg, br as [number, number], horn);
      const zones = new Float32Array(cellCount(g)).fill(Number.NaN);
      for (let i = 0; i < zones.length; i++) {
        const v = horn.slopeDeg[i];
        if (Number.isFinite(v)) zones[i] = v < cls.breaks[0] ? 0 : v < cls.breaks[1] ? 1 : 2;
      }
      const coarse = Math.max(cell.w, cell.h);
      const warn = coarse > 60 ? `Cells are about ${coarse.toFixed(0)} m: slope is underestimated on coarse DEMs. For slope zones use a finer DEM (Data › Elevation gives Copernicus 30 m).` : A.terrainResolutionWarning(cell.w, cell.h, g.width, g.height);
      return {
        message: `Slope zones of ${g.title}: ${ha(cls.counts[2] * cell.area)} steep (${cls.labels[2]})`,
        rasters: [
          { name: `Slope ${g.title}`, like: g, data: horn.slopeDeg, kind: 'slope', units: '°' },
          {
            name: `Slope zones ${g.title}`, like: g, data: zones, kind: 'classes',
            classes: cls.labels.map((label, i) => ({ value: i, label, color: ['#ffffcc', '#fd8d3c', '#bd0026'][i] })),
          },
        ],
        table: cls.labels.map((l, i) => [l, `${ha(cls.counts[i] * cell.area)} (${cls.totalValid ? ((100 * cls.counts[i]) / cls.totalValid).toFixed(1) : '0'} %)`] as [string, string]),
        notes: [
          `Horn (1981) 3×3 slope on ${cell.w.toFixed(1)} × ${cell.h.toFixed(1)} m cells; ${cls.borderExcluded.toLocaleString('en-US')} border and ${cls.nodataExcluded.toLocaleString('en-US')} no-data cells left out.`,
          ...(warn ? [warn] : []),
        ],
      };
    },
  },
  {
    id: 'sdm',
    name: 'Species distribution model',
    summary: 'BIOCLIM, Mahalanobis or presence-background logistic suitability from occurrences and environmental rasters, with spatially blocked cross-validation (AUC, TSS, Boyce).',
    group: SDM,
    icon: 'pin',
    params: [
      { name: 'occurrences', label: 'Occurrences', kind: 'layer', required: true, description: 'Presence points (e.g. Data › Species from GBIF).' },
      { name: 'covariates', label: 'Environmental rasters', kind: 'rasters', required: true, description: 'One or more rasters (all their bands are used), e.g. WorldClim bioclim from Data › Climate.' },
      { name: 'method', label: 'Method', kind: 'choice', default: 'logistic', choices: ['logistic', 'bioclim', 'mahalanobis'], description: 'logistic: presence vs background (a linear MaxEnt-like model); bioclim: percentile envelope; mahalanobis: distance to the presence mean.' },
      { name: 'background', label: 'Background points', kind: 'number', default: 5000, description: 'Random cells for presence-background fitting and evaluation.' },
      { name: 'folds', label: 'Cross-validation folds', kind: 'number', default: 5 },
      { name: 'future', label: 'Future rasters (optional)', kind: 'rasters', description: 'The same variables for a future climate (e.g. Data › Future climate, CMIP6), in the same order: adds future suitability and range gain / loss.' },
      { name: 'block_deg', label: 'Block size (°, blank = automatic)', kind: 'number', description: 'Spatial blocks for cross-validation, in degrees; automatic: about a sixth of the study area’s width, so every fold gets blocks.' },
    ],
    run(ctx) {
      const occ = ctx.layer('occurrences');
      if (!occ?.length) throw new Error('Choose a layer of occurrence points');
      const covs = ctx.rasters('covariates');
      if (!covs.length) throw new Error('Choose at least one environmental raster');
      const g = covs[0];
      const { toLonLat, fromLonLat } = projector(g);
      const names = covs.flatMap((c) => c.bands.map((_, b) => (c.bands.length > 1 ? `${c.title} ${c.bandNames[b]}` : c.title)));
      const stack = covs.flatMap((c) => c.bands);
      const n = cellCount(g);
      const rowAt = (i: number) => stack.map((b) => b[i]);
      const complete = (i: number) => stack.every((b) => Number.isFinite(b[i]));
      // presences: one per cell, inside the grid, with every variable
      const seen = new Set<number>();
      const pres: number[][] = [];
      const presXY: Array<[number, number]> = [];
      let outside = 0;
      for (const f of occ) {
        if (f.geometry?.type !== 'Point') continue;
        const ll = (f.geometry as Point).coordinates as [number, number];
        const i = cellAt(g, fromLonLat([ll[0], ll[1]]));
        if (i < 0 || !complete(i)) {
          outside++;
          continue;
        }
        if (seen.has(i)) continue;
        seen.add(i);
        pres.push(rowAt(i));
        presXY.push(ll);
      }
      if (pres.length < 5) throw new Error(`Only ${pres.length} occurrence(s) fall on cells with every variable (${outside} outside or on no data); at least 5 are needed`);
      // background: random complete cells, seeded so a run can be repeated
      let state = 42;
      const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
      const want = Math.max(100, Math.min(20000, Math.round(num(ctx, 'background', 5000))));
      const bg: number[][] = [];
      const bgXY: Array<[number, number]> = [];
      for (let tries = 0; bg.length < want && tries < want * 20; tries++) {
        const i = Math.floor(rand() * n);
        if (!complete(i)) continue;
        bg.push(rowAt(i));
        bgXY.push(toLonLat(centre(g, i)));
      }
      if (bg.length < 50) throw new Error('The rasters have too few cells with every variable for background points');
      const method = String(ctx.params.method ?? 'logistic');
      type M = { predict: (v: number[]) => number | null };
      const fit = (p: number[][], b: number[][]): M | null => {
        if (method === 'bioclim') {
          const m = A.fitBioclim(p, names);
          return m && { predict: (v) => A.predictBioclim(v, m, 'proportion').suitability };
        }
        if (method === 'mahalanobis') {
          const m = A.fitMahalanobis(p, names);
          return m && { predict: (v) => A.predictMahalanobis(v, m, 'chisq').suitability };
        }
        const m = A.fitPresenceBackgroundLogistic(p, b, names);
        return m && { predict: (v) => A.predictPresenceBackgroundLogistic(v, m) };
      };
      const model = fit(pres, bg);
      if (!model) throw new Error(method === 'mahalanobis' ? 'Mahalanobis needs at least two variables and enough presences' : 'The model could not be fitted to these data');
      const suit = new Float32Array(n).fill(Number.NaN);
      for (let i = 0; i < n; i++) if (complete(i)) suit[i] = model.predict(rowAt(i)) ?? Number.NaN;
      const pS = pres.map((v) => model.predict(v));
      const bS = bg.map((v) => model.predict(v));
      const tss = A.maxTssThreshold(pS, bS);
      // blocks: given, or about a sixth of the study area (at least 4× as many blocks as folds)
      const k = Math.max(2, Math.round(num(ctx, 'folds', 5)));
      const bb = lonLatBounds(g);
      const blockDeg = ctx.params.block_deg !== undefined && ctx.params.block_deg !== null && ctx.params.block_deg !== ''
        ? num(ctx, 'block_deg', 1)
        : Number(Math.max(0.01, Math.min(bb[2] - bb[0], bb[3] - bb[1]) / 6).toPrecision(2));
      const cv = blockedCv<M>({ pres, presXY, bg, bgXY, k, blockDeg, fit, predict: (v, m) => m.predict(v) });
      const binary = new Float32Array(n).fill(Number.NaN);
      if (tss) for (let i = 0; i < n; i++) if (Number.isFinite(suit[i])) binary[i] = suit[i] >= tss.threshold ? 1 : 0;
      const ms = (s: A.MetricSummary | undefined) => (s && s.mean !== null ? `${s.mean.toFixed(3)}${s.sd !== null ? ` ± ${s.sd.toFixed(3)}` : ''} (${s.n} folds)` : '—');
      const label = method === 'bioclim' ? 'BIOCLIM' : method === 'mahalanobis' ? 'Mahalanobis' : 'Presence-background logistic';
      const rasters: OutGrid[] = [{ name: `Suitability ${label}`, like: g, data: suit, kind: 'suitability', description: `${label} on ${names.length} variables` }];
      if (tss) rasters.push({ name: `Predicted range ${label}`, like: g, data: binary, kind: 'classes', classes: [{ value: 0, label: 'unsuitable', color: '#e0e0e0' }, { value: 1, label: `suitable (≥ ${tss.threshold.toFixed(2)})`, color: '#238b45' }] });
      // projection: the same model on future rasters (same variables, same order)
      const fut = ctx.params.future ? ctx.rasters('future') : [];
      const futRows: string[][] = [];
      const futNotes: string[] = [];
      if (fut.length) {
        const fstack = fut.flatMap((c) => c.bands);
        if (fstack.length !== stack.length) throw new Error(`Future rasters have ${fstack.length} variables, the model ${stack.length}: give the same variables in the same order`);
        const fsuit = new Float32Array(n).fill(Number.NaN);
        const change = new Float32Array(n).fill(Number.NaN);
        const cnt = [0, 0, 0, 0];
        for (let i = 0; i < n; i++) {
          if (!fstack.every((b) => Number.isFinite(b[i]))) continue;
          fsuit[i] = model.predict(fstack.map((b) => b[i])) ?? Number.NaN;
          if (tss && Number.isFinite(suit[i]) && Number.isFinite(fsuit[i])) {
            const now = suit[i] >= tss.threshold;
            const then = fsuit[i] >= tss.threshold;
            const c = now ? (then ? 2 : 1) : then ? 3 : 0;
            change[i] = c;
            cnt[c]++;
          }
        }
        rasters.push({ name: `Future suitability ${label}`, like: g, data: fsuit, kind: 'suitability', description: `${label} projected onto ${fut.map((f) => f.title).join(', ')}` });
        if (tss) {
          rasters.push({
            name: `Range change ${label}`, like: g, data: change, kind: 'classes',
            classes: [
              { value: 0, label: 'unsuitable now and later', color: '#e0e0e0' }, { value: 1, label: 'lost', color: '#d7191c' },
              { value: 2, label: 'stable', color: '#1a9641' }, { value: 3, label: 'gained', color: '#2c7bb6' },
            ],
          });
          const area = cellSize(g).area;
          const km2 = (c: number) => `${Math.round((c * area) / 1e6).toLocaleString('en-US')} km²`;
          const now = cnt[1] + cnt[2];
          futRows.push(['Range now', km2(now)], ['Range in the future', km2(cnt[2] + cnt[3])], ['Lost', km2(cnt[1])], ['Gained', km2(cnt[3])], ['Stable', km2(cnt[2])],
            ['Net change', now ? `${(((cnt[3] - cnt[1]) / now) * 100).toFixed(1)} %` : '—']);
        }
        futNotes.push('Future projection: the same model on the future rasters, thresholded at the same max-TSS value. It assumes the species keeps its present climate niche and ignores dispersal limits; cells with climates outside the training range (extrapolation) are less certain.');
      }
      const prov = A.provenanceForSdm(method === 'bioclim' ? 'bioclim' : method === 'mahalanobis' ? 'mahalanobis' : 'presence-background-logistic', { variables: names, background: bg.length });
      return {
        message: `${label}: ${pres.length} presences, ${bg.length} background; cross-validated AUC ${ms(cv.auc)}`,
        rasters,
        table: [
          ['Method', label], ['Variables', names.join(', ')],
          ['Presences used', `${pres.length} (one per cell; ${outside} outside or on no data)`], ['Background points', bg.length],
          ['AUC, training', fix(A.rocAuc(pS, bS))],
          ['AUC, spatial CV', ms(cv.auc)], ['Max TSS, spatial CV', ms(cv.tss)], ['Boyce index, spatial CV', ms(cv.boyce)],
          ['Threshold (max TSS, training)', tss ? `${tss.threshold.toFixed(3)} (sensitivity ${tss.sensitivity.toFixed(2)}, specificity ${tss.specificity.toFixed(2)})` : '—'],
          ['Spatial blocks', `${cv.blockCount} blocks of ${blockDeg}° (${cv.presenceBlocks} with presences) in ${cv.k} folds`],
          ...(futRows as [string, string][]),
        ],
        notes: [
          prov.method,
          'Suitability is relative (presence-background data have no true absences); report the cross-validated scores, not the training AUC.',
          ...futNotes,
          'Cross-validation: spatial blocks, the ones holding presences dealt evenly to the folds, so each held-out fold is a different part of the range.',
          ...(cv.k < k ? [`Only ${cv.presenceBlocks} blocks hold presences, so ${cv.k} folds were used instead of ${k}; a smaller block size gives more.`] : []),
          ...cv.folds.filter((f) => 'skipped' in f).map((f) => `Fold ${f.fold + 1}: ${'skipped' in f ? f.skipped : ''}.`),
          ...(cv.boyce.n === 0 ? ['Boyce index: not computed (it needs at least 5 distinct scores; BIOCLIM gives only a few levels).'] : []),
        ],
      };
    },
  },
];

export const TAB_OF_RASTER: Record<string, string> = { [SPECTRAL]: 'imagery', [CHANGE]: 'imagery', [SLOPE]: 'imagery', [SDM]: 'modelling' };