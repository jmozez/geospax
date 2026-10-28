// ENSO (El Niño Southern Oscillation) indices and climate outlook tools: ONI, weekly Niño 3.4
// and the SOI from NOAA CPC and the Bureau of Meteorology, rainfall anomalies, El Niño drought
// and frost risk, and seasonal outlook classes.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx, Grid, OutGrid, Tool } from '../tools';
import { choiceP, esc, fix, need, needRaster, num, numP, optNum, rasterP, sameGrid, str } from './common';

const CLIM = 'Climate and ENSO';

export const ENSO_SOURCES: Record<string, { url: string; file: string; label: string }> = {
  oni: { url: 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt', file: 'oni.ascii.txt', label: 'Oceanic Niño Index (NOAA CPC, 3-month Niño 3.4 anomaly, °C)' },
  nino34: { url: 'https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for', file: 'wksst9120.for', label: 'Weekly Niño 3.4 SST anomaly (NOAA CPC, °C)' },
  soi: { url: 'https://www.bom.gov.au/clim_data/IDCKGSM000/soi_monthly.txt', file: 'soi_monthly.txt', label: 'Southern Oscillation Index (Bureau of Meteorology, monthly)' },
};

export interface EnsoPoint { label: string; t: number; v: number }

const SEAS = ['DJF', 'JFM', 'FMA', 'MAM', 'AMJ', 'MJJ', 'JJA', 'JAS', 'ASO', 'SON', 'OND', 'NDJ'];
const MON: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

export function parseEnso(kind: string, text: string): EnsoPoint[] {
  const out: EnsoPoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (kind === 'oni') {
      const m = s.match(/^([A-Z]{3})\s+(\d{4})\s+(-?[\d.]+)\s+(-?[\d.]+)/);
      if (m && SEAS.includes(m[1])) out.push({ label: `${m[1]} ${m[2]}`, t: Date.UTC(+m[2], SEAS.indexOf(m[1]), 15), v: +m[4] });
    } else if (kind === 'nino34') {
      const m = s.match(/^(\d{2})([A-Z]{3})(\d{4})\s+(.*)$/);
      if (m) { const n = m[4].trim().split(/\s+/).map(Number); if (n.length >= 8 && Number.isFinite(n[5])) out.push({ label: `${m[1]} ${m[2][0]}${m[2].slice(1).toLowerCase()} ${m[3]}`, t: Date.UTC(+m[3], MON[m[2]], +m[1]), v: n[5] }); }
    } else {
      const m = s.match(/^(\d{4})(\d{2})\s*,\s*(-?[\d.]+)/);
      if (m) out.push({ label: `${m[1]}-${m[2]}`, t: Date.UTC(+m[1], +m[2] - 1, 15), v: +m[3] });
    }
  }
  if (!out.length) throw new Error(`No ${kind.toUpperCase()} values found in the data`);
  return out.sort((a, b) => a.t - b.t);
}

/** text of an index: a file the user gave, then GEOSPAX_ENSO_DIR (an offline mirror), then the web */
export async function ensoText(kind: string, file = ''): Promise<{ text: string; source: string }> {
  const src = ENSO_SOURCES[kind];
  if (!src) throw new Error(`Unknown index ${kind}`);
  if (file) return { text: readFileSync(file, 'utf8'), source: file };
  const dir = process.env.GEOSPAX_ENSO_DIR;
  if (dir && existsSync(join(dir, src.file))) return { text: readFileSync(join(dir, src.file), 'utf8'), source: join(dir, src.file) };
  let res: Response;
  try {
    res = await fetch(src.url, { headers: { 'user-agent': 'GeoSpaX (ENSO index)' }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Could not download ${src.url} (${(e as Error).message}); download it in a browser and choose it as the data file`);
  }
  if (!res.ok) throw new Error(`${src.url} answered ${res.status}; download it in a browser and choose it as the data file`);
  return { text: await res.text(), source: src.url };
}

export function ensoPhase(kind: string, v: number): string {
  if (kind === 'soi') return v <= -7 ? 'El Niño (SOI at or below -7)' : v >= 7 ? 'La Niña (SOI at or above +7)' : 'neutral';
  const a = Math.abs(v);
  const strength = a >= 2 ? 'very strong' : a >= 1.5 ? 'strong' : a >= 1 ? 'moderate' : 'weak';
  return v >= 0.5 ? `El Niño (${strength})` : v <= -0.5 ? `La Niña (${strength})` : 'neutral';
}

function chart(title: string, pts: EnsoPoint[], kind: string): string {
  const W = 760, H = 300, L = 50, R = 12, T = 30, B = 40;
  const lim = Math.max(kind === 'soi' ? 20 : 2.5, ...pts.map((p) => Math.abs(p.v)));
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / pts.length;
  const y = (v: number) => T + ((H - T - B) * (lim - v)) / (2 * lim);
  const thr = kind === 'soi' ? 7 : 0.5;
  const bw = Math.max(1, (W - L - R) / pts.length - 1);
  // El Niño is red in both: positive ONI, negative SOI
  const warm = (v: number) => (kind === 'soi' ? v <= -thr : v >= thr);
  const cool = (v: number) => (kind === 'soi' ? v >= thr : v <= -thr);
  const bars = pts.map((p, i) => `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(y(p.v), y(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(y(p.v) - y(0)).toFixed(1)}" fill="${warm(p.v) ? '#d7301f' : cool(p.v) ? '#2c7fb8' : '#999'}"><title>${esc(p.label)}: ${p.v}</title></rect>`).join('');
  const ticks = pts.map((p, i) => (i % Math.ceil(pts.length / 8) === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - B + 16}" font-size="10" text-anchor="middle">${esc(p.label)}</text>` : '')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif"><text x="${L}" y="18" font-size="13" font-weight="bold">${esc(title)}</text>`
    + `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#333"/>`
    + [thr, -thr].map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#888" stroke-dasharray="4 3"/><text x="${L - 4}" y="${y(t) + 3}" font-size="10" text-anchor="end">${t > 0 ? '+' : ''}${t}</text>`).join('')
    + `<text x="${L - 4}" y="${y(lim) + 8}" font-size="10" text-anchor="end">${lim.toFixed(1)}</text>${bars}${ticks}</svg>`;
}

const classify = (like: Grid, name: string, src: Float32Array, breaks: number[], labels: string[], colours: string[], description: string): OutGrid => {
  const data = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) { const v = src[i]; data[i] = Number.isFinite(v) ? 1 + breaks.filter((b) => v >= b).length : NaN; }
  return { name, like, data, kind: 'classes', description, classes: labels.map((label, i) => ({ value: i + 1, label, color: colours[i] })) };
};

async function latestOni(ctx: Ctx): Promise<{ v: number; label: string; source: string }> {
  const given = optNum(ctx, 'oni');
  if (given != null) return { v: given, label: 'given', source: 'entered value' };
  const { text, source } = await ensoText('oni', str(ctx, 'oni_file'));
  const pts = parseEnso('oni', text);
  const last = pts[pts.length - 1];
  return { v: last.v, label: last.label, source };
}

export const ENSO_TOOLS: Tool[] = [
  {
    id: 'enso-index',
    name: 'ENSO index (ONI, Niño 3.4, SOI)',
    summary: 'The latest El Niño Southern Oscillation index from NOAA CPC or the Bureau of Meteorology, the ENSO phase and strength, and a chart of recent values.',
    group: CLIM,
    icon: 'lineChart',
    params: [choiceP('index', 'Index', ['oni', 'nino34', 'soi'], 'oni: NOAA Oceanic Niño Index (official El Niño measure); nino34: weekly Niño 3.4 SST anomaly; soi: BoM Southern Oscillation Index.'), numP('periods', 'Recent periods to show', 36), { name: 'file', label: 'Data file (optional, instead of downloading)', kind: 'file', description: 'A copy of the NOAA or BoM text file, for offline use.' }],
    async run(ctx) {
      const kind = str(ctx, 'index', 'oni');
      const { text, source } = await ensoText(kind, str(ctx, 'file'));
      const all = parseEnso(kind, text);
      const n = Math.max(3, Math.min(all.length, num(ctx, 'periods', 36)));
      const pts = all.slice(-n);
      const last = pts[pts.length - 1];
      const phase = ensoPhase(kind, last.v);
      const thr = kind === 'soi' ? -7 : 0.5;
      let run = 0;
      for (let i = all.length - 1; i >= 0 && (kind === 'soi' ? all[i].v <= thr : all[i].v >= thr); i--) run++;
      const peak = pts.reduce((b, p) => (kind === 'soi' ? (p.v < b.v ? p : b) : p.v > b.v ? p : b), pts[0]);
      return {
        message: `${ENSO_SOURCES[kind].label}: ${last.label} = ${last.v > 0 ? '+' : ''}${last.v}, ${phase}${run ? `; El Niño threshold met for ${run} period(s) in a row` : ''}`,
        table: [['Latest', `${last.label}: ${last.v}`], ['Phase', phase], ['Periods past the El Niño threshold in a row', run], [kind === 'soi' ? 'Lowest in window' : 'Highest in window', `${peak.label}: ${peak.v}`], ['Source', source], ...pts.slice(-12).reverse().map((p) => [p.label, p.v] as [string, number])],
        figures: [{ title: `${ENSO_SOURCES[kind].label}`, svg: chart(`${ENSO_SOURCES[kind].label}, last ${pts.length}`, pts, kind) }],
        notes: [
          'NOAA declares El Niño when the ONI is +0.5 °C or more for five overlapping seasons; the BoM uses Niño 3.4 at +0.8 °C with a sustained SOI at -7 or below.',
          'In Papua New Guinea, El Niño usually brings below-normal rainfall from about June to the following March, drought in the south and the highlands, and frost above about 2,200 m (as in 1997 and 2015).',
        ],
      };
    },
  },
  {
    id: 'rainfall-anomaly',
    name: 'Rainfall anomaly (percent of normal)',
    summary: 'Observed rainfall as a percentage of the long-term normal (for example CHIRPS month or season against its climatology), in classes from very much below to very much above normal.',
    group: CLIM,
    icon: 'd-hydrology',
    params: [rasterP('observed', 'Observed rainfall (mm)'), rasterP('normal', 'Normal (long-term mean) rainfall (mm)')],
    run(ctx) {
      const o = needRaster(ctx, 'observed', 'observed rainfall'), n = needRaster(ctx, 'normal', 'normal rainfall');
      if (!sameGrid(o, n)) throw new Error('The two rasters must share one grid; resample one to the other first');
      const p = new Float32Array(o.width * o.height);
      const counts = [0, 0, 0, 0, 0];
      const br = [50, 80, 120, 150];
      let k = 0, sum = 0;
      for (let i = 0; i < p.length; i++) {
        const a = o.bands[0][i], b = n.bands[0][i];
        p[i] = Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (a / b) * 100 : NaN;
        if (Number.isFinite(p[i])) { counts[br.filter((x) => p[i] >= x).length]++; k++; sum += p[i]; }
      }
      if (!k) throw new Error('No cells with both values');
      const labels = ['Under 50 % (severe deficit)', '50 to 80 % (below normal)', '80 to 120 % (near normal)', '120 to 150 % (above normal)', 'Over 150 % (well above)'];
      return {
        message: `Mean ${(sum / k).toFixed(0)} % of normal; ${((counts[0] + counts[1]) / k * 100).toFixed(1)} % of the area below 80 %`,
        rasters: [{ name: 'Rainfall (% of normal)', like: o, data: p, units: '%', description: 'Observed rainfall as a percentage of the normal' }, classify(o, 'Rainfall anomaly class', p, br, labels, ['#8c510a', '#d8b365', '#6f7a84', '#5ab4ac', '#01665e'], 'Rainfall percent of normal in five classes')],
        table: labels.map((l, i) => [l, `${(counts[i] / k * 100).toFixed(1)} %`] as [string, string]),
      };
    },
  },
  {
    id: 'drought-risk',
    name: 'El Niño drought and frost risk',
    summary: 'Drought risk classes from a rainfall anomaly (percent of normal) and the current ENSO state (ONI), with highland frost risk above a set elevation during El Niño: for food security and water supply planning in PNG.',
    group: CLIM,
    icon: 'd-disaster',
    params: [rasterP('rain_pct', 'Rainfall (% of normal, optional)', false), rasterP('dem', 'DEM (optional, for frost)', false), { name: 'oni', label: 'ONI (°C, blank = latest from NOAA)', kind: 'number', description: 'Leave blank to download the latest Oceanic Niño Index.' }, { name: 'oni_file', label: 'ONI data file (optional, offline)', kind: 'file' }, numP('frost_m', 'Frost risk above (m)', 2200)],
    async run(ctx) {
      const rain = ctx.raster('rain_pct'), dem = ctx.raster('dem');
      if (!rain && !dem) throw new Error('Give a rainfall anomaly raster, a DEM, or both');
      if (rain && dem && !sameGrid(rain, dem)) throw new Error('The rainfall and DEM rasters must share one grid; resample one to the other first');
      const like = (rain ?? dem)!;
      const oni = await latestOni(ctx);
      const ensoScore = oni.v >= 2 ? 3 : oni.v >= 1.5 ? 2.5 : oni.v >= 1 ? 2 : oni.v >= 0.5 ? 1 : 0;
      const frostM = num(ctx, 'frost_m', 2200);
      const score = new Float32Array(like.width * like.height);
      const cnt = [0, 0, 0, 0];
      let frost = 0, k = 0;
      for (let i = 0; i < score.length; i++) {
        const r = rain ? rain.bands[0][i] : NaN, z = dem ? dem.bands[0][i] : NaN;
        if (rain && !Number.isFinite(r)) { score[i] = NaN; continue; }
        const def = !rain ? 0 : r < 40 ? 3 : r < 60 ? 2 : r < 80 ? 1 : 0;
        const fr = Number.isFinite(z) && z >= frostM && oni.v >= 1 ? (z >= frostM + 300 ? 2 : 1) : 0;
        if (fr) frost++;
        score[i] = Math.min(9, def + ensoScore + fr);
        k++;
      }
      const br = [2, 4, 6];
      for (let i = 0; i < score.length; i++) if (Number.isFinite(score[i])) cnt[br.filter((b) => score[i] >= b).length]++;
      const labels = ['Low', 'Moderate', 'High', 'Severe'];
      return {
        message: `ONI ${oni.v > 0 ? '+' : ''}${oni.v} (${oni.label}, ${ensoPhase('oni', oni.v)}): ${(cnt[2] / k * 100 + cnt[3] / k * 100).toFixed(1)} % of the area at high or severe drought risk${dem ? `; ${(frost / k * 100).toFixed(1)} % at frost risk` : ''}`,
        rasters: [{ name: 'Drought risk score', like, data: score, description: 'Rainfall deficiency (0 to 3) + ENSO state (0 to 3) + highland frost (0 to 2)' }, classify(like, 'El Niño drought risk', score, br, labels, ['#ffffb2', '#fecc5c', '#fd8d3c', '#bd0026'], 'Drought risk class')],
        table: [['ONI', `${oni.v} (${oni.label})`], ['ENSO phase', ensoPhase('oni', oni.v)], ['ONI source', oni.source], ...labels.map((l, i) => [l, `${(cnt[i] / k * 100).toFixed(1)} %`] as [string, string]), ...(dem ? [[`Frost risk (above ${frostM} m)`, `${(frost / k * 100).toFixed(1)} %`] as [string, string]] : [])],
        notes: ['A screening index, not a forecast: combine with the PNG National Weather Service and BoM seasonal outlooks and local reports.'],
      };
    },
  },
  {
    id: 'seasonal-outlook',
    name: 'Seasonal rainfall outlook classes',
    summary: 'Classes from a seasonal outlook probability raster (the chance of rainfall above the median, as from the BoM ACCESS-S, IRI or NOAA forecasts): very likely drier to very likely wetter.',
    group: CLIM,
    icon: 'd-climate',
    params: [rasterP('probability', 'Chance of above-median rainfall (%)'), choiceP('scale', 'The values are', ['percent', 'fraction'])],
    run(ctx) {
      const g = needRaster(ctx, 'probability', 'an outlook probability raster');
      const f = str(ctx, 'scale', 'percent') === 'fraction' ? 100 : 1;
      const p = Float32Array.from(g.bands[0], (v) => (Number.isFinite(v) ? v * f : NaN));
      const br = [20, 40, 60, 80];
      const labels = ['Very likely drier (under 20 %)', 'Likely drier (20 to 40 %)', 'No strong signal (40 to 60 %)', 'Likely wetter (60 to 80 %)', 'Very likely wetter (over 80 %)'];
      const cnt = [0, 0, 0, 0, 0];
      let k = 0;
      p.forEach((v) => { if (Number.isFinite(v)) { cnt[br.filter((b) => v >= b).length]++; k++; } });
      if (!k) throw new Error('The raster has no values');
      return {
        message: `${((cnt[0] + cnt[1]) / k * 100).toFixed(1)} % of the area is likely drier than the median`,
        rasters: [classify(g, 'Seasonal outlook', p, br, labels, ['#8c510a', '#d8b365', '#6f7a84', '#5ab4ac', '#01665e'], 'Chance of above-median rainfall, in classes')],
        table: labels.map((l, i) => [l, `${(cnt[i] / k * 100).toFixed(1)} %`] as [string, string]),
      };
    },
  },
];
export { fix, need };
