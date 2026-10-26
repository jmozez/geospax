// Map tools on the Home and View tabs that work on the map itself rather than on data:
//
//   - coordinates in the status bar as decimal degrees, degrees-minutes-seconds, UTM, MGRS or any EPSG
//     system (View › Coordinate system; PROJ's own definitions, converted in the browser by proj4js)
//   - Swipe and Spyglass (View › Compare): a second, synchronised map without the selected layer laid
//     over the first and clipped to one side of a divider, or to a circle around the pointer
//   - Time slider (View › Time): a layer with a date or year field shown one period at a time, or
//     accumulating, through a definition query (so exports and tools see the same features)
//   - Grid (View › Map grid): a graticule with labels whose spacing follows the zoom
//   - Scale: go to 1:N, and lock the map at the current scale
import * as maplibregl from 'maplibre-gl';
import proj4 from 'proj4';
import type { Backend, LayerInfo } from './backend';
import { dialog } from './editing';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ExtrasHost {
  map: maplibregl.Map;
  backend: Backend;
  layers: () => LayerInfo[];
  activeId: () => string | null;
  setStatus: (text: string, ms?: number) => void;
  /** a layer's data changed (definition query): re-read it and redraw */
  changed: (id: string) => Promise<void>;
}

// ------------------------------------------------------------------ coordinates

export type CoordFormat = 'dd' | 'dms' | 'utm' | 'mgrs' | 'crs';
const FMT_KEY = 'geospax.coords';
const CRS_KEY = 'geospax.coords.crs';

interface DisplayCrs { code: string; name: string; proj4: string; units: string }

let format: CoordFormat = 'dd';
let display: DisplayCrs | null = null;
try {
  format = (localStorage.getItem(FMT_KEY) as CoordFormat) || 'dd';
  display = JSON.parse(localStorage.getItem(CRS_KEY) ?? 'null');
  if (format === 'crs' && !display) format = 'dd';
} catch { /* private mode */ }

function dms(v: number, pos: string, neg: string): string {
  const h = v < 0 ? neg : pos;
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = (a - d - m / 60) * 3600;
  if (s >= 59.995) { s = 0; m += 1; }
  if (m >= 60) { m = 0; d += 1; }
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(2).padStart(5, '0')}″${h}`;
}

/** UTM zone, hemisphere, easting and northing (WGS 84; Norway and Svalbard exceptions included). */
export function toUtm(lon: number, lat: number): { zone: number; band: string; south: boolean; e: number; n: number } {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  const south = lat < 0;
  const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
  const [e, n] = proj4('EPSG:4326', def, [lon, lat]);
  const bands = 'CDEFGHJKLMNPQRSTUVWXX';
  const band = bands[Math.max(0, Math.min(20, Math.floor((lat + 80) / 8)))];
  return { zone, band, south, e, n };
}

/** MGRS reference at 1 m (e.g. 55L GR 12345 67890). */
export function toMgrs(lon: number, lat: number): string {
  if (lat < -80 || lat > 84) return 'outside MGRS (polar)';
  const u = toUtm(lon, lat);
  const set = ((u.zone - 1) % 6) + 1;
  const colLetters = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(set - 1) % 3];
  const col = colLetters[Math.floor(u.e / 100000) - 1];
  const rowLetters = 'ABCDEFGHJKLMNPQRSTUV';
  const rowOffset = set % 2 === 0 ? 5 : 0;
  const row = rowLetters[(Math.floor(u.n / 100000) + rowOffset) % 20];
  const e = String(Math.floor(u.e % 100000)).padStart(5, '0');
  const n = String(Math.floor(u.n % 100000)).padStart(5, '0');
  return `${u.zone}${u.band} ${col}${row} ${e} ${n}`;
}

/** The status-bar text for a position in the chosen format. */
export function formatCoords(lon: number, lat: number): string {
  try {
    switch (format) {
      case 'dms': return `${dms(lat, 'N', 'S')} ${dms(lon, 'E', 'W')}`;
      case 'utm': {
        const u = toUtm(lon, lat);
        return `UTM ${u.zone}${u.south ? 'S' : 'N'} ${u.e.toFixed(1)} E ${u.n.toFixed(1)} N`;
      }
      case 'mgrs': return toMgrs(lon, lat);
      case 'crs': {
        if (!display) break;
        const [x, y] = proj4('EPSG:4326', display.proj4, [lon, lat]);
        const d = display.units === 'degrees' ? 6 : 2;
        return `${display.code} ${x.toFixed(d)}, ${y.toFixed(d)}`;
      }
    }
  } catch { /* outside the projection's domain */ }
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** Coordinates typed in the display system → lon/lat (Go To XY). */
export function fromDisplay(x: number, y: number): [number, number] | null {
  if (format !== 'crs' || !display) return null;
  try {
    const [lon, lat] = proj4(display.proj4, 'EPSG:4326', [x, y]);
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
  } catch {
    return null;
  }
}

export class MapExtras {
  constructor(private h: ExtrasHost) {}

  /** Home › Coordinates: choose how the status bar shows the pointer's position. */
  async coordinates() {
    const opts: [CoordFormat, string][] = [['dd', 'Decimal degrees (lat, lon)'], ['dms', 'Degrees, minutes, seconds'], ['utm', 'UTM (zone, easting, northing)'], ['mgrs', 'MGRS grid reference'], ['crs', display ? `${display.code} · ${display.name}` : 'A coordinate system… (EPSG)']];
    const v = await dialog('Coordinates', `<p class="dim">How the status bar shows the position under the pointer.</p>
      ${opts.map(([k, t]) => `<label class="ck"><input type="radio" name="fmt" value="${k}" ${k === format ? 'checked' : ''}> ${esc(t)}</label>`).join('')}`, [['ok', 'Use'], ['', 'Cancel']]);
    if (v.button !== 'ok') return;
    const chosen = (v.root.querySelector<HTMLInputElement>('input[name=fmt]:checked')?.value ?? 'dd') as CoordFormat;
    if (chosen === 'crs' && !display) return this.coordinateSystem();
    this.setFormat(chosen);
  }

  private setFormat(f: CoordFormat) {
    format = f;
    try { localStorage.setItem(FMT_KEY, f); } catch { /* private mode */ }
    const c = this.h.map.getCenter();
    const el = document.querySelector<HTMLElement>('#sb-coords');
    if (el) el.textContent = formatCoords(c.lng, c.lat);
    this.h.setStatus(`Coordinates: ${f === 'crs' && display ? display.code : f.toUpperCase()}`);
  }

  /** View › Coordinate system: search PROJ's EPSG list (systems for this place first). */
  async coordinateSystem() {
    const c = this.h.map.getCenter();
    const listHtml = (rows: { code: string; name: string; kind: string; area: string }[]) =>
      rows.map((r, i) => `<label class="crs-row"><input type="radio" name="crs" value="${esc(r.code)}" ${i === 0 ? 'checked' : ''}><b>${esc(r.code)}</b> ${esc(r.name)} <small class="dim">${esc(r.kind)} · ${esc(r.area)}</small></label>`).join('') || '<p class="dim">No match.</p>';
    const search = async (q: string) => this.h.backend.json<{ systems: { code: string; name: string; kind: string; area: string }[]; total: number }>(`api/crs?q=${encodeURIComponent(q)}&lon=${c.lng}&lat=${c.lat}`).catch(() => ({ systems: [], total: 0 }));
    const first = await search('');
    const pending = dialog('Coordinate system', `<p class="dim">Show coordinates in a projected or geographic system from the EPSG registry. Systems whose area of use includes the map's centre come first.</p>
      <input name="q" placeholder="Search: code, name or area (e.g. PNG94, 32755, Lae)" autocomplete="off" style="width:100%">
      <div class="crs-list" style="max-height:300px;overflow:auto;margin-top:8px">${listHtml(first.systems)}</div>`, [['ok', 'Use this system'], ['dd', 'Back to degrees'], ['', 'Cancel']]);
    // live search while the dialog is open
    setTimeout(() => {
      const root = document.querySelector<HTMLElement>('.crs-list')?.closest<HTMLElement>('dialog, .modal, .dialog') ?? document.body;
      const q = root.querySelector<HTMLInputElement>('input[name=q]');
      const list = root.querySelector<HTMLElement>('.crs-list');
      let timer = 0;
      q?.addEventListener('input', () => {
        clearTimeout(timer);
        timer = window.setTimeout(async () => {
          const r = await search(q.value);
          if (list) list.innerHTML = listHtml(r.systems);
        }, 200);
      });
      q?.focus();
    }, 0);
    const v = await pending;
    if (v.button === 'dd') return this.setFormat('dd');
    if (v.button !== 'ok') return;
    const code = v.root.querySelector<HTMLInputElement>('input[name=crs]:checked')?.value;
    if (!code) return;
    try {
      const d = await this.h.backend.json<DisplayCrs>(`api/crs/${encodeURIComponent(code)}`);
      display = d;
      try { localStorage.setItem(CRS_KEY, JSON.stringify(d)); } catch { /* private mode */ }
      this.setFormat('crs');
      this.h.setStatus(`Coordinates in ${d.code} · ${d.name}`, 5000);
    } catch (e) {
      this.h.setStatus(`Could not use ${code}: ${(e as Error).message}`, 6000);
    }
  }

  // ------------------------------------------------------------------ swipe and spyglass

  private compare: { map: maplibregl.Map; el: HTMLElement; bar?: HTMLElement; off: () => void; mode: 'swipe' | 'spyglass' } | null = null;

  /** View › Swipe / Spyglass. The selected layer is hidden in the overlay, so the divider or lens
   *  shows what is under it. Clicking the same button again ends it. */
  toggleCompare(mode: 'swipe' | 'spyglass') {
    const was = this.compare?.mode;
    this.endCompare();
    if (was === mode) return;
    const id = this.h.activeId();
    const l = id ? this.h.layers().find((x) => x.id === id) : undefined;
    if (!id || !l) return this.h.setStatus('Pick the layer to compare in Contents first: the divider shows the map without it.', 6000);
    const main = this.h.map;
    const host = main.getContainer();
    const el = document.createElement('div');
    el.className = `gx-compare gx-${mode}`;
    host.append(el);
    const style = structuredClone(main.getStyle());
    style.layers = style.layers.filter((x) => !(x.id === id || x.id.startsWith(`${id}#`)));
    const map = new maplibregl.Map({ container: el, style, center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch(), interactive: false, attributionControl: false });
    const sync = () => map.jumpTo({ center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch() });
    main.on('move', sync);
    let bar: HTMLElement | undefined;
    let offExtra = () => {};
    if (mode === 'swipe') {
      bar = document.createElement('div');
      bar.className = 'gx-swipe-bar';
      bar.setAttribute('role', 'slider');
      bar.setAttribute('aria-label', 'Swipe divider');
      bar.tabIndex = 0;
      host.append(bar);
      let x = host.clientWidth / 2;
      const place = () => {
        x = Math.max(0, Math.min(host.clientWidth, x));
        el.style.clipPath = `inset(0 0 0 ${x}px)`;
        bar!.style.left = `${x}px`;
        bar!.setAttribute('aria-valuenow', String(Math.round((x / host.clientWidth) * 100)));
      };
      place();
      const move = (e: PointerEvent) => { x = e.clientX - host.getBoundingClientRect().left; place(); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      bar.addEventListener('pointerdown', (e) => { e.preventDefault(); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); });
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { x -= 20; place(); }
        if (e.key === 'ArrowRight') { x += 20; place(); }
      });
      const resize = () => place();
      window.addEventListener('resize', resize);
      offExtra = () => window.removeEventListener('resize', resize);
      this.h.setStatus(`Swipe: left of the divider shows ${l.name}, right of it the map without it. Drag the divider; Swipe again ends it.`, 8000);
    } else {
      let r = 110;
      el.style.clipPath = 'circle(0px at 0 0)';
      const move = (e: MouseEvent) => {
        const b = host.getBoundingClientRect();
        el.style.clipPath = `circle(${r}px at ${e.clientX - b.left}px ${e.clientY - b.top}px)`;
      };
      const wheel = (e: WheelEvent) => {
        if (!e.shiftKey) return;
        e.preventDefault();
        r = Math.max(40, Math.min(400, r - Math.sign(e.deltaY) * 15));
        move(e);
      };
      host.addEventListener('mousemove', move);
      host.addEventListener('wheel', wheel, { passive: false });
      offExtra = () => { host.removeEventListener('mousemove', move); host.removeEventListener('wheel', wheel); };
      this.h.setStatus(`Spyglass: the lens shows the map without ${l.name}. Shift+wheel sizes it; Spyglass again ends it.`, 8000);
    }
    this.compare = { map, el, bar, mode, off: () => { main.off('move', sync); offExtra(); } };
  }

  endCompare() {
    if (!this.compare) return;
    this.compare.off();
    this.compare.map.remove();
    this.compare.el.remove();
    this.compare.bar?.remove();
    this.compare = null;
  }

  // ------------------------------------------------------------------ time slider

  private time: { id: string; field: string; before: string | null; el: HTMLElement; timer: number } | null = null;

  /** View › Time slider: step a layer through time by a date, date-time or year field. */
  async timeSlider() {
    if (this.time) return this.endTime();
    const id = this.h.activeId();
    const l = id ? this.h.layers().find((x) => x.id === id) : undefined;
    if (!id || !l) return this.h.setStatus('Pick a layer with a date or year field first.', 5000);
    const dateFields = l.fields.filter((f) => /date|time/i.test(f.kind) || /(^|_)(date|time|year|yr|datetime|timestamp|observed|eventdate|recorded)(_|$)/i.test(f.name));
    if (!dateFields.length) return this.h.setStatus(`${l.name} has no date, time or year field for the time slider.`, 6000);
    const v = await dialog(`Time slider · ${l.name}`, `<label class="row"><span>Time field</span><select name="field">${dateFields.map((f) => `<option>${esc(f.name)}</option>`).join('')}</select></label>
      <label class="row"><span>Step</span><select name="step"><option value="year">Year</option><option value="month">Month</option><option value="day">Day</option></select></label>
      <label class="ck"><input type="checkbox" name="acc"> Accumulate (show everything up to the date)</label>`, [['ok', 'Start'], ['', 'Cancel']]);
    if (v.button !== 'ok') return;
    const field = v.values.field;
    const step = v.values.step as 'year' | 'month' | 'day';
    const acc = v.root.querySelector<HTMLInputElement>('[name=acc]')?.checked ?? false;
    const q = (desc: boolean) => this.h.backend.json<{ rows: { values: unknown[] }[]; fields: string[] }>(`api/layers/${encodeURIComponent(id)}/table`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort: field, desc, limit: 1, where: `"${field.replace(/"/g, '""')}" IS NOT NULL` }) });
    const [lo, hi] = await Promise.all([q(false), q(true)]).catch(() => [null, null]);
    const val = (r: { rows: { values: unknown[] }[]; fields: string[] } | null) => (r?.rows[0] ? r.rows[0].values[r.fields.indexOf(field)] : null);
    const a = val(lo), b = val(hi);
    if (a == null || b == null) return this.h.setStatus(`${field} has no values.`, 5000);
    const numeric = typeof a === 'number';
    const toDate = (x: unknown) => (numeric ? new Date(Date.UTC(Number(x), 0, 1)) : new Date(String(x)));
    const d0 = toDate(a), d1 = toDate(b);
    if (Number.isNaN(d0.getTime()) || Number.isNaN(d1.getTime())) return this.h.setStatus(`${field} does not hold dates or years.`, 6000);
    const periods: Date[] = [];
    const cur = new Date(Date.UTC(d0.getUTCFullYear(), step === 'year' ? 0 : d0.getUTCMonth(), step === 'day' ? d0.getUTCDate() : 1));
    while (cur <= d1 && periods.length < 2000) {
      periods.push(new Date(cur));
      if (step === 'year') cur.setUTCFullYear(cur.getUTCFullYear() + 1);
      else if (step === 'month') cur.setUTCMonth(cur.getUTCMonth() + 1);
      else cur.setUTCDate(cur.getUTCDate() + 1);
    }
    const label = (d: Date) => (step === 'year' ? String(d.getUTCFullYear()) : step === 'month' ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10));
    const next = (d: Date) => { const x = new Date(d); if (step === 'year') x.setUTCFullYear(x.getUTCFullYear() + 1); else if (step === 'month') x.setUTCMonth(x.getUTCMonth() + 1); else x.setUTCDate(x.getUTCDate() + 1); return x; };
    const lit = (d: Date) => (numeric ? String(d.getUTCFullYear()) : `'${d.toISOString().slice(0, step === 'day' ? 10 : 10)}'`);
    const f = `"${field.replace(/"/g, '""')}"`;
    const before = l.filter ?? null;
    const el = document.createElement('div');
    el.className = 'gx-time';
    el.innerHTML = `<button data-t="play" aria-label="Play">▶</button><input type="range" min="0" max="${periods.length - 1}" value="0" aria-label="Time"><b data-t="lbl">${label(periods[0])}</b><button data-t="close" aria-label="Close the time slider">✕</button>`;
    this.h.map.getContainer().append(el);
    const range = el.querySelector<HTMLInputElement>('input')!;
    const lbl = el.querySelector<HTMLElement>('[data-t=lbl]')!;
    let busy = false, queued = false;
    const apply = async () => {
      if (busy) { queued = true; return; }
      busy = true;
      const i = Number(range.value);
      const start = periods[i], end = next(periods[i]);
      lbl.textContent = acc ? `≤ ${label(start)}` : label(start);
      const cond = numeric
        ? (acc ? `${f} < ${lit(end)}` : `${f} >= ${lit(start)} AND ${f} < ${lit(end)}`)
        : (acc ? `${f} < ${lit(end)}` : `${f} >= ${lit(start)} AND ${f} < ${lit(end)}`);
      const where = before ? `(${before}) AND ${cond}` : cond;
      try {
        await this.h.backend.json(`api/layers/${encodeURIComponent(id)}/filter`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ where }) });
        await this.h.changed(id);
      } catch (e) {
        this.h.setStatus(`Time slider: ${(e as Error).message}`, 6000);
      }
      busy = false;
      if (queued) { queued = false; void apply(); }
    };
    range.addEventListener('input', () => void apply());
    el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).dataset.t;
      if (t === 'close') this.endTime();
      if (t === 'play') {
        const btn = e.target as HTMLButtonElement;
        if (this.time?.timer) { clearInterval(this.time.timer); this.time.timer = 0; btn.textContent = '▶'; return; }
        btn.textContent = '❚❚';
        this.time!.timer = window.setInterval(() => {
          if (Number(range.value) >= periods.length - 1) range.value = '0';
          else range.value = String(Number(range.value) + 1);
          void apply();
        }, 1200);
      }
    });
    this.time = { id, field, before, el, timer: 0 };
    void apply();
    this.h.setStatus(`Time slider on ${l.name}: ${periods.length} ${step}s from ${label(periods[0])} to ${label(periods[periods.length - 1])}.`, 6000);
  }

  endTime() {
    const t = this.time;
    if (!t) return;
    clearInterval(t.timer);
    t.el.remove();
    this.time = null;
    void this.h.backend.json(`api/layers/${encodeURIComponent(t.id)}/filter`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ where: t.before }) }).then(() => this.h.changed(t.id)).catch(() => {});
  }

  // ------------------------------------------------------------------ grid

  private grid = false;

  /** View › Grid: latitude / longitude lines with labels, spacing by zoom. */
  toggleGrid() {
    this.grid = !this.grid;
    const map = this.h.map;
    if (this.grid) {
      this.drawGrid();
      map.on('moveend', this.drawGrid);
      map.on('styledata', this.ensureGrid);
    } else {
      map.off('moveend', this.drawGrid);
      map.off('styledata', this.ensureGrid);
      for (const l of ['gx-grid-labels', 'gx-grid-lines']) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource('gx-grid')) map.removeSource('gx-grid');
    }
    this.h.setStatus(this.grid ? 'Grid on' : 'Grid off');
  }

  private ensureGrid = () => {
    if (this.grid && !this.h.map.getLayer('gx-grid-lines')) setTimeout(this.drawGrid, 0);
  };

  private drawGrid = () => {
    const map = this.h.map;
    const b = map.getBounds();
    const span = Math.max(b.getEast() - b.getWest(), b.getNorth() - b.getSouth());
    const steps = [90, 45, 30, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01, 0.005, 0.0025, 0.001, 0.0005, 0.00025, 0.0001];
    const step = steps.find((s) => span / s >= 4 && span / s <= 12) ?? steps[steps.length - 1];
    const feats: GeoJSON.Feature[] = [];
    const w = Math.max(-180, Math.floor(b.getWest() / step) * step), e = Math.min(180, Math.ceil(b.getEast() / step) * step);
    const s = Math.max(-85, Math.floor(b.getSouth() / step) * step), n = Math.min(85, Math.ceil(b.getNorth() / step) * step);
    const dec = Math.max(0, -Math.floor(Math.log10(step)) + (step < 1 && String(step).includes('5') ? 1 : 0));
    const lab = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(dec)}°${v === 0 ? '' : v > 0 ? pos : neg}`;
    for (let x = w; x <= e + 1e-9; x += step) {
      const coords: number[][] = [];
      for (let y = s; y <= n + 1e-9; y += (n - s) / 50) coords.push([x, y]);
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { label: lab(x, 'E', 'W'), axis: 'x' } });
    }
    for (let y = s; y <= n + 1e-9; y += step) {
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[w, y], [e, y]] }, properties: { label: lab(y, 'N', 'S'), axis: 'y' } });
    }
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: feats };
    const src = map.getSource('gx-grid') as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
    else map.addSource('gx-grid', { type: 'geojson', data });
    if (!map.getLayer('gx-grid-lines')) map.addLayer({ id: 'gx-grid-lines', type: 'line', source: 'gx-grid', paint: { 'line-color': '#94a3b8', 'line-width': 0.8, 'line-opacity': 0.8, 'line-dasharray': [4, 3] } });
    if (!map.getLayer('gx-grid-labels') && map.getStyle().glyphs) {
      map.addLayer({ id: 'gx-grid-labels', type: 'symbol', source: 'gx-grid', layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 11, 'symbol-spacing': 350, 'text-keep-upright': true }, paint: { 'text-color': '#334155', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
    }
  };

  // ------------------------------------------------------------------ scale

  /** Map scale (1:N) at the centre, at 96 dpi. */
  scaleNow(): number {
    const map = this.h.map;
    const mpp = (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    return mpp * 3779.5275590551;
  }

  async goToScale() {
    const v = await dialog('Go to scale', `<label class="row"><span>Scale 1:</span><input name="n" type="number" min="1" value="${Math.round(this.scaleNow())}" list="gx-scales"></label>
      <datalist id="gx-scales">${[500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000].map((n) => `<option value="${n}">`).join('')}</datalist>`, [['ok', 'Go'], ['', 'Cancel']]);
    if (v.button !== 'ok') return;
    const n = Number(v.values.n);
    if (!(n > 0)) return;
    const map = this.h.map;
    const mpp = n / 3779.5275590551;
    const z = Math.log2((156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / mpp);
    map.easeTo({ zoom: Math.max(0, Math.min(24, z)) });
  }

  private locked: [number, number] | null = null;

  toggleScaleLock() {
    const map = this.h.map;
    if (this.locked) {
      map.setMinZoom(this.locked[0]);
      map.setMaxZoom(this.locked[1]);
      this.locked = null;
      document.body.dataset.scaleLock = 'off';
      return this.h.setStatus('Scale unlocked');
    }
    this.locked = [map.getMinZoom(), map.getMaxZoom()];
    const z = map.getZoom();
    map.setMinZoom(z);
    map.setMaxZoom(z);
    document.body.dataset.scaleLock = 'on';
    this.h.setStatus(`Scale locked at 1:${Math.round(this.scaleNow()).toLocaleString()} (pan still works). Lock scale again unlocks it.`, 6000);
  }
}
