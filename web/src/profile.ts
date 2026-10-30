// Elevation profile chart (Analysis › Spatial statistics › Profile chart): the cross-section of a
// profile-points layer (the Elevation profile tool's output, or any points with a distance and an
// elevation field) as distance (km) against elevation (m), with length, min, max, total climb and
// descent, the A and B ends and km ticks marked on the map, and a hover marker linking chart and map.
// The maths and the SVG are pure functions (tested by scripts/test-profile.mjs).
import type * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';

export interface ProfileRow { d: number; z: number; lon: number; lat: number }
export interface Profile {
  samples: ProfileRow[]; // d in metres from A, ascending
  length: number; min: number; max: number; minAt: number; maxAt: number; climb: number; descent: number;
}

const DIST = /^(dist|distance|dist_m|dist_km|chainage|station|along|d_m|m)$/i;
const ELEV = /^(elev|elevation|elev_m|z|height|alt|altitude|dem|value)$/i;
/** The distance and elevation fields of a layer, or null when it has none. */
export function profileFields(fields: { name: string; kind?: string }[]): { dist: string; elev: string } | null {
  const dist = fields.find((f) => DIST.test(f.name))?.name ?? fields.find((f) => /dist|chainage/i.test(f.name))?.name;
  const elev = fields.find((f) => ELEV.test(f.name))?.name ?? fields.find((f) => /elev|height|alt/i.test(f.name))?.name;
  return dist && elev ? { dist, elev } : null;
}

/** A profile from samples; `reverse` swaps the ends so A is the far end; distances in km fields are scaled to metres. */
export function buildProfile(rows: ProfileRow[], reverse = false, km = false): Profile {
  const ok = rows.filter((r) => Number.isFinite(r.d) && Number.isFinite(r.z)).map((r) => ({ ...r, d: km ? r.d * 1000 : r.d }));
  if (!ok.length) throw new Error('no samples with a distance and an elevation');
  ok.sort((a, b) => a.d - b.d);
  const d0 = ok[0].d, d1 = ok[ok.length - 1].d;
  // the line starts at the first sample position, so distances are kept as measured (a 31 m first sample stays 31 m)
  const s = reverse ? ok.map((r) => ({ ...r, d: d1 - r.d + Math.min(d0, 0) })).reverse() : ok;
  let min = Infinity, max = -Infinity, minAt = 0, maxAt = 0, climb = 0, descent = 0;
  s.forEach((r, i) => {
    if (r.z < min) { min = r.z; minAt = r.d; }
    if (r.z > max) { max = r.z; maxAt = r.d; }
    if (i) { const dz = r.z - s[i - 1].z; if (dz > 0) climb += dz; else descent -= dz; }
  });
  return { samples: s, length: Math.max(...s.map((r) => r.d)), min, max, minAt, maxAt, climb, descent };
}

/** A tidy axis step (1, 2, 2.5 or 5 × 10^n) for about `n` ticks over `range`. */
export function niceStep(range: number, n = 5): number {
  const raw = range / Math.max(1, n), p = 10 ** Math.floor(Math.log10(raw || 1)), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** The sample nearest to distance d (metres). */
export function nearest(p: Profile, d: number): ProfileRow {
  let lo = 0, hi = p.samples.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.samples[m].d < d) lo = m; else hi = m; }
  return Math.abs(p.samples[lo].d - d) <= Math.abs(p.samples[hi].d - d) ? p.samples[lo] : p.samples[hi];
}

/** Positions on the line every `stepKm` km (interpolated between samples), for the km ticks on the map. */
export function kmTicks(p: Profile, stepKm: number): { km: number; lon: number; lat: number }[] {
  const out: { km: number; lon: number; lat: number }[] = [];
  const s = p.samples;
  for (let k = stepKm; k * 1000 < p.length - 1; k += stepKm) {
    const d = k * 1000;
    const i = s.findIndex((r) => r.d >= d);
    if (i <= 0) continue;
    const a = s[i - 1], b = s[i], t = (d - a.d) / (b.d - a.d || 1);
    out.push({ km: Math.round(k * 100) / 100, lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
  }
  return out;
}

const fmt = (x: number) => Math.round(x).toLocaleString('en');
const km = (m: number) => (m / 1000).toLocaleString('en', { maximumFractionDigits: m < 10000 ? 2 : 1 });
/** Hypsometric ramp (sea-level green to high brown), shared by the chart fill and the map legend. */
export const HYPSO = ['#1a9850', '#66bd63', '#a6d96a', '#fee08b', '#fdae61', '#c2803f', '#8c510a'];
/** Elevation classes for the fill and the legend: about 7 tidy steps from the floor (0 at sea level) to the top. */
export function elevClasses(p: Profile): { lo: number; hi: number; color: string }[] {
  const lo0 = Math.min(0, p.min), step = niceStep(p.max - lo0, 7), n = Math.max(1, Math.ceil((p.max - lo0) / step));
  return Array.from({ length: n }, (_, i) => ({ lo: lo0 + i * step, hi: lo0 + (i + 1) * step, color: HYPSO[Math.round((i / Math.max(1, n - 1)) * (HYPSO.length - 1))] }));
}
const PL = 62, PR = 18, PT = 30, PB = 40;

/** The elevation axis: floor, step and top. */
export function zAxis(p: Profile) {
  const zLo = Math.min(0, Math.floor(p.min / niceStep(p.max - p.min)) * niceStep(p.max - p.min));
  const zs = niceStep(p.max - zLo, 4);
  return { zLo, zs, zHi: Math.ceil((p.max + zs * 0.15) / zs) * zs };
}

/** The cross-section as SVG: filled area, labelled axes, A and B, min and max marked. */
export function profileSvg(p: Profile, o: { w?: number; h?: number; a?: string; b?: string } = {}): string {
  const W = o.w ?? 900, H = o.h ?? 230, L = PL, R = PR, T = PT, B = PB;
  const { zLo, zs, zHi } = zAxis(p);
  const ds = niceStep(p.length / 1000, 8) * 1000;
  const x = (d: number) => L + (d / p.length) * (W - L - R), y = (z: number) => T + (1 - (z - zLo) / (zHi - zLo)) * (H - T - B);
  const step = Math.max(1, Math.floor(p.samples.length / 1500));
  const pts = p.samples.filter((_, i) => i % step === 0 || i === p.samples.length - 1).map((r) => `${x(r.d).toFixed(1)},${y(r.z).toFixed(1)}`);
  const area = `M${x(p.samples[0].d).toFixed(1)},${y(zLo)} L${pts.join(' L')} L${x(p.samples[p.samples.length - 1].d).toFixed(1)},${y(zLo)} Z`;
  const grid: string[] = [];
  for (let z = zLo; z <= zHi + 1e-6; z += zs) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(z)}" y2="${y(z)}" class="g"/><text x="${L - 6}" y="${y(z) + 4}" text-anchor="end">${fmt(z)}</text>`);
  for (let d = 0; d <= p.length + 1; d += ds) grid.push(`<line x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${H - B}" class="g"/><text x="${x(d)}" y="${H - B + 15}" text-anchor="middle">${km(d)}</text>`);
  // hard colour stops at the class limits, in elevation (user space), so the fill reads like the map legend
  const span = y(zLo) - y(zHi), off = (z: number) => Math.min(1, Math.max(0, (y(zLo) - y(z)) / span));
  const stops = elevClasses(p).map((c) => `<stop offset="${off(c.lo).toFixed(4)}" stop-color="${c.color}"/><stop offset="${off(c.hi).toFixed(4)}" stop-color="${c.color}"/>`).join('');
  const g0 = y(zLo), g1 = y(zHi);
  const mk = (d: number, z: number, t: string, up: boolean) => `<circle cx="${x(d)}" cy="${y(z)}" r="3.5" class="mk"/><text x="${Math.min(W - R - 4, Math.max(L + 4, x(d)))}" y="${y(z) + (up ? -8 : 16)}" text-anchor="${x(d) > W - 120 ? 'end' : x(d) < L + 60 ? 'start' : 'middle'}" class="ml">${t}</text>`;
  const end = (d: number, t: string, anchor: string) => `<text x="${x(d) + (anchor === 'start' ? 0 : 0)}" y="${T - 10}" text-anchor="${anchor}" class="ab">${t}</text>`;
  return `<svg class="gx-profile-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Elevation profile, ${km(p.length)} km, ${fmt(p.min)} to ${fmt(p.max)} m">
<defs><linearGradient id="gxpf" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${g0}" y2="${g1}">${stops}</linearGradient></defs>
${grid.join('')}
<path d="${area}" fill="url(#gxpf)" fill-opacity="0.85"/><polyline points="${pts.join(' ')}" class="ln"/>
<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="ax"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" class="ax"/>
${mk(p.maxAt, p.max, `Max ${fmt(p.max)} m`, true)}${mk(p.minAt, p.min, `Min ${fmt(p.min)} m`, true)}
${end(0, o.a ? `A · ${o.a}` : 'A', 'start')}${end(p.length, o.b ? `B · ${o.b}` : 'B', 'end')}
<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle" class="t">Distance from A (km)</text>
<text transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" class="t">Elevation (m)</text>
<line class="hv" x1="-10" x2="-10" y1="${T}" y2="${H - B}"/><circle class="hp" cx="-10" cy="-10" r="4.5"/>
</svg>`;
}

/** Stats line of the panel. */
export function profileStats(p: Profile): [string, string][] {
  return [['Length', `${km(p.length)} km`], ['Min', `${fmt(p.min)} m`], ['Max', `${fmt(p.max)} m`], ['Relief', `${fmt(p.max - p.min)} m`], ['Total climb', `${fmt(p.climb)} m`], ['Total descent', `${fmt(p.descent)} m`]];
}

// ------------------------------------------------------------------ the panel
export interface ProfileHost { map: maplibregl.Map; backend: Backend; layers: () => LayerInfo[]; activeId: () => string | null; setStatus: (t: string, ms?: number) => void }
const SRC = 'gx-profile';
const CSS = `.gx-profile{position:absolute;left:12px;right:12px;bottom:30px;z-index:5;background:rgba(17,21,27,.94);color:#e6e9ee;border:1px solid #2c3440;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.45);font:12px system-ui,sans-serif;padding:8px 12px 4px}
.gx-profile header{display:flex;align-items:center;gap:10px;margin-bottom:4px}.gx-profile header b{font-size:13px}.gx-profile header .sp{flex:1}
.gx-profile button{background:#232a33;color:#e6e9ee;border:1px solid #3a4452;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit}
.gx-profile .st{display:flex;gap:18px;flex-wrap:wrap;margin:2px 0 2px}.gx-profile .st span{color:#9aa4b2}.gx-profile .st b{color:#fff;margin-left:4px}.gx-profile .lg{display:flex;align-items:center;gap:4px}.gx-profile .lg span{margin-right:4px}.gx-profile .lg i{width:12px;height:10px;display:inline-block;border:1px solid #0006}.gx-profile .lg em{font-style:normal;color:#c9d1db;margin-right:6px}.gx-profile .rd{color:#ffd166;min-width:210px;text-align:right}
.gx-profile-svg text{fill:#c9d1db;font:11px system-ui,sans-serif}.gx-profile-svg .t{fill:#e6e9ee;font-size:12px}.gx-profile-svg .g{stroke:#ffffff1f}.gx-profile-svg .ax{stroke:#8a96a6}
.gx-profile-svg .ln{fill:none;stroke:#fff;stroke-width:1.4}.gx-profile-svg .mk{fill:#ffd166;stroke:#111}.gx-profile-svg .ml{fill:#ffd166;font-weight:600}.gx-profile-svg .ab{fill:#fff;font-weight:700;font-size:13px}
.gx-profile-svg .hv{stroke:#ffd166;stroke-dasharray:3 3}.gx-profile-svg .hp{fill:#ffd166;stroke:#111}`;

export class ProfilePanel {
  private el: HTMLElement | null = null;
  private p: Profile | null = null;
  private rows: ProfileRow[] = [];
  private reversed = false;
  private km = false;
  private layer: LayerInfo | null = null;
  private h: ProfileHost;
  constructor(h: ProfileHost) { this.h = h; }

  /** Open for the selected layer (or the first layer with a distance and an elevation field); toggles off when open. */
  async toggle(opts: { reverse?: boolean; a?: string; b?: string } = {}) {
    if (this.el) return this.close();
    const all = this.h.layers().filter((l) => l.geometry === 'point' && profileFields(l.fields));
    const l = all.find((x) => x.id === this.h.activeId()) ?? all[all.length - 1];
    if (!l) {
      this.h.setStatus('No profile points yet: run Imagery › Terrain › Elevation profile on a line and a DEM, then open Profile chart.', 8000);
      document.dispatchEvent(new CustomEvent('geospax:open-tool', { detail: { keys: ['p:gsx/elevation-profile'], search: 'Elevation profile' } }));
      return;
    }
    const f = profileFields(l.fields)!;
    const r = await this.h.backend.json<{ fields: string[]; rows: { bbox: number[]; values: unknown[] }[] }>(`api/layers/${encodeURIComponent(l.id)}/table`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 200000, sort: f.dist }) });
    const di = r.fields.indexOf(f.dist), ei = r.fields.indexOf(f.elev);
    this.rows = r.rows.map((x) => ({ d: Number(x.values[di]), z: Number(x.values[ei]), lon: (x.bbox[0] + x.bbox[2]) / 2, lat: (x.bbox[1] + x.bbox[3]) / 2 }));
    this.km = /km/i.test(f.dist);
    this.layer = l;
    this.reversed = !!opts.reverse;
    this.ends = { a: opts.a, b: opts.b };
    this.render();
  }
  private ends: { a?: string; b?: string } = {};

  close() {
    this.el?.remove(); this.el = null; this.p = null;
    const m = this.h.map;
    for (const id of ['gx-profile-tick', 'gx-profile-tick-l', 'gx-profile-end', 'gx-profile-end-l', 'gx-profile-hover']) if (m.getLayer(id)) m.removeLayer(id);
    if (m.getSource(SRC)) m.removeSource(SRC);
  }

  private render(fit = true) {
    this.p = buildProfile(this.rows, this.reversed, this.km);
    const p = this.p;
    if (!document.getElementById('gx-profile-css')) { const s = document.createElement('style'); s.id = 'gx-profile-css'; s.textContent = CSS; document.head.append(s); }
    this.el?.remove();
    const el = document.createElement('div');
    el.className = 'gx-profile';
    el.innerHTML = `<header><b>Elevation profile · ${this.layer!.name.replace(/[<>&]/g, '')}</b><span class="sp"></span><span class="rd">Hover the chart to read a point</span><button data-a="swap" title="Swap the A and B ends">Swap A ↔ B</button><button data-a="close" title="Close">✕</button></header>
      <div class="st">${profileStats(p).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}<span class="sp" style="flex:1"></span><div class="lg"><span>Elevation (m)</span>${elevClasses(p).map((c) => `<i style="background:${c.color}"></i><em>${fmt(c.lo)}–${fmt(c.hi)}</em>`).join('')}</div></div>${profileSvg(p, { w: Math.max(600, (this.h.map.getContainer().clientWidth || 900) - 50), ...this.ends })}`;
    this.h.map.getContainer().append(el);
    this.el = el;
    el.querySelector('[data-a=close]')!.addEventListener('click', () => this.close());
    el.querySelector('[data-a=swap]')!.addEventListener('click', () => { this.reversed = !this.reversed; const { a, b } = this.ends; this.ends = { a: b, b: a }; this.render(false); });
    const svg = el.querySelector<SVGSVGElement>('svg')!;
    svg.addEventListener('mousemove', (e) => {
      const box = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      const vx = ((e.clientX - box.left) / box.width) * vb.width;
      const d = Math.min(p.length, Math.max(0, ((vx - PL) / (vb.width - PL - PR)) * p.length));
      this.hover(nearest(p, d));
    });
    this.mapMarks();
    if (fit) this.fit();
  }

  /** Frame the whole line above the panel. */
  fit() {
    const s = this.p?.samples; if (!s?.length || !this.el) return;
    const xs = s.map((r) => r.lon), ys = s.map((r) => r.lat);
    const pad = 40, m = this.h.map;
    m.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: pad, left: pad, right: pad, bottom: this.el.offsetHeight + 30 + pad }, duration: 0, maxZoom: 14 });
  }

  /** Move the chart cursor and the map marker to a sample. */
  hover(s: ProfileRow) {
    const p = this.p; if (!p || !this.el) return;
    const svg = this.el.querySelector<SVGSVGElement>('svg')!, vb = svg.viewBox.baseVal, H = vb.height;
    const { zLo, zHi } = zAxis(p);
    const x = PL + (s.d / p.length) * (vb.width - PL - PR), y = PT + (1 - (s.z - zLo) / (zHi - zLo)) * (H - PT - PB);
    svg.querySelector('.hv')!.setAttribute('x1', String(x)); svg.querySelector('.hv')!.setAttribute('x2', String(x));
    svg.querySelector('.hp')!.setAttribute('cx', String(x)); svg.querySelector('.hp')!.setAttribute('cy', String(y));
    this.el.querySelector('.rd')!.textContent = `${km(s.d)} km from A · ${fmt(s.z)} m`;
    const src = this.h.map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(this.marks({ lon: s.lon, lat: s.lat }));
  }

  private marks(hv?: { lon: number; lat: number }) {
    const p = this.p!, s = p.samples, f: GeoJSON.Feature[] = [];
    const step = niceStep(p.length / 1000, 8);
    for (const t of kmTicks(p, step)) f.push({ type: 'Feature', properties: { k: 'tick', label: `${t.km} km` }, geometry: { type: 'Point', coordinates: [t.lon, t.lat] } });
    f.push({ type: 'Feature', properties: { k: 'end', label: 'A' }, geometry: { type: 'Point', coordinates: [s[0].lon, s[0].lat] } });
    f.push({ type: 'Feature', properties: { k: 'end', label: 'B' }, geometry: { type: 'Point', coordinates: [s[s.length - 1].lon, s[s.length - 1].lat] } });
    if (hv) f.push({ type: 'Feature', properties: { k: 'hover' }, geometry: { type: 'Point', coordinates: [hv.lon, hv.lat] } });
    return { type: 'FeatureCollection' as const, features: f };
  }

  private mapMarks() {
    const m = this.h.map;
    if (m.getSource(SRC)) { (m.getSource(SRC) as maplibregl.GeoJSONSource).setData(this.marks()); return; }
    m.addSource(SRC, { type: 'geojson', data: this.marks() });
    const font = ['DejaVu Sans Bold'];
    m.addLayer({ id: 'gx-profile-tick', type: 'circle', source: SRC, filter: ['==', ['get', 'k'], 'tick'], paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5 } });
    m.addLayer({ id: 'gx-profile-tick-l', type: 'symbol', source: SRC, filter: ['==', ['get', 'k'], 'tick'], layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-anchor': 'right', 'text-offset': [-0.8, 0], 'text-font': font, 'text-allow-overlap': true }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.6 } });
    m.addLayer({ id: 'gx-profile-end', type: 'circle', source: SRC, filter: ['==', ['get', 'k'], 'end'], paint: { 'circle-radius': 13, 'circle-color': '#ffd166', 'circle-stroke-color': '#111', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'gx-profile-end-l', type: 'symbol', source: SRC, filter: ['==', ['get', 'k'], 'end'], layout: { 'text-field': ['get', 'label'], 'text-size': 15, 'text-font': font, 'text-allow-overlap': true }, paint: { 'text-color': '#111' } });
    m.addLayer({ id: 'gx-profile-hover', type: 'circle', source: SRC, filter: ['==', ['get', 'k'], 'hover'], paint: { 'circle-radius': 8, 'circle-color': '#ffd166', 'circle-stroke-color': '#111', 'circle-stroke-width': 2 } });
  }
}
