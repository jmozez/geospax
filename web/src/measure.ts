// Measure (Map tab and Edit tab › Measure), as ArcGIS Pro's Measure tool: click points on the map
// to measure a distance (each segment and the total) or an area (area and perimeter). Geodesic, on
// the sphere (R = 6,371,008.8 m), the same formulas as Calculate geometry (crates/engine/src/edit.rs);
// metric or imperial. Double-click (or Enter) finishes, Backspace removes the last point, Esc clears.
import type * as maplibregl from 'maplibre-gl';
import { claimMapTool, releaseMapTool } from './toolstate';

const R = 6371008.8;
const SRC = 'measure';

type Mode = 'distance' | 'area';
type Units = 'metric' | 'imperial';

/** Great-circle distance in metres (haversine). */
export function distance(a: [number, number], b: [number, number]): number {
  const [la1, la2] = [(a[1] * Math.PI) / 180, (b[1] * Math.PI) / 180];
  const dla = la2 - la1;
  const dlo = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Area of a ring on the sphere in m² (Chamberlain & Duquette 2007). */
export function area(ring: [number, number][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
    s += ((p3[0] - p1[0]) * Math.PI) / 180 * Math.sin((p2[1] * Math.PI) / 180);
  }
  return Math.abs((s * R * R) / 2);
}

const nf = (v: number, d = 2) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: v < 10 && d ? Math.min(d, 2) : 0 });

export function fmtLength(m: number, u: Units): string {
  if (u === 'imperial') {
    const ft = m / 0.3048;
    return ft < 5280 ? `${nf(ft, 0)} ft` : `${nf(ft / 5280, 3)} mi`;
  }
  return m < 1000 ? `${nf(m, 1)} m` : `${nf(m / 1000, 3)} km`;
}

export function fmtArea(m2: number, u: Units): string {
  if (u === 'imperial') {
    const ac = m2 / 4046.8564224;
    return ac < 640 ? `${nf(ac, 2)} acres` : `${nf(ac / 640, 3)} mi²`;
  }
  if (m2 < 10_000) return `${nf(m2, 1)} m²`;
  if (m2 < 1_000_000) return `${nf(m2 / 10_000, 2)} ha`;
  return `${nf(m2 / 1_000_000, 3)} km² (${nf(m2 / 10_000, 0)} ha)`;
}

export class Measure {
  private mode: Mode | null = null;
  private pts: [number, number][] = [];
  private cursor: [number, number] | null = null;
  private done = false;
  private units: Units = 'metric';
  private box: HTMLElement;

  constructor(private map: maplibregl.Map) {
    try { if (localStorage.getItem('geospax.measure.units') === 'imperial') this.units = 'imperial'; } catch { /* private mode */ }
    this.box = document.createElement('div');
    this.box.className = 'measure-box';
    this.box.hidden = true;
    this.box.setAttribute('role', 'status');
    map.getContainer().append(this.box);
    this.box.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-m]')?.dataset.m;
      if (a === 'units') { this.units = this.units === 'metric' ? 'imperial' : 'metric'; try { localStorage.setItem('geospax.measure.units', this.units); } catch { /* ignore */ } this.render(); }
      else if (a === 'new') { this.pts = []; this.done = false; this.render(); }
      else if (a === 'close') this.stop();
    });
    map.on('click', (e) => {
      if (!this.mode) return;
      if (this.done) { this.pts = []; this.done = false; }
      this.pts.push([e.lngLat.lng, e.lngLat.lat]);
      this.render();
    });
    map.on('dblclick', (e) => {
      if (!this.mode) return;
      e.preventDefault(); // no zoom
      this.finish();
    });
    map.on('mousemove', (e) => {
      if (!this.mode || this.done || !this.pts.length) return;
      this.cursor = [e.lngLat.lng, e.lngLat.lat];
      this.render();
    });
    map.on('styledata', () => { if (this.mode) this.draw(); }); // restyles drop our layers
    document.addEventListener('keydown', (e) => {
      if (!this.mode || (e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'Escape') this.stop();
      else if (e.key === 'Enter') this.finish();
      else if (e.key === 'Backspace' && this.pts.length) { e.preventDefault(); this.pts.pop(); this.done = false; this.render(); }
    });
  }

  get active(): Mode | null { return this.mode; }

  start(mode: Mode) {
    if (this.mode === mode) return this.stop();
    if (this.mode) this.stop();
    this.mode = mode;
    claimMapTool(`measure:${mode}`, () => { if (this.mode === mode) this.stop(); });
    this.pts = [];
    this.done = false;
    this.cursor = null;
    document.body.dataset.measure = mode;
    this.map.doubleClickZoom.disable();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.render();
  }

  stop() {
    if (this.mode) releaseMapTool(`measure:${this.mode}`);
    this.mode = null;
    this.pts = [];
    delete document.body.dataset.measure;
    this.map.doubleClickZoom.enable();
    this.map.getCanvas().style.cursor = '';
    this.box.hidden = true;
    for (const id of [`${SRC}-fill`, `${SRC}-line`, `${SRC}-pts`]) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(SRC)) this.map.removeSource(SRC);
  }

  private finish() {
    // a double-click also fired two clicks: drop the duplicate last point
    const n = this.pts.length;
    if (n >= 2 && distance(this.pts[n - 1], this.pts[n - 2]) < 1e-6 * R) this.pts.pop();
    this.done = true;
    this.cursor = null;
    this.render();
  }

  private line(): [number, number][] {
    return !this.done && this.cursor ? [...this.pts, this.cursor] : this.pts;
  }

  private render() {
    this.draw();
    const pts = this.line();
    const u = this.units;
    const head = this.mode === 'area' ? 'Measure area' : 'Measure distance';
    let body = '';
    if (pts.length < 2) {
      body = `<div class="m-hint">Click on the map to start. Double-click or Enter to finish, Backspace removes a point, Esc closes.</div>`;
    } else if (this.mode === 'distance') {
      const segs = pts.slice(1).map((p, i) => distance(pts[i], p));
      const total = segs.reduce((a, b) => a + b, 0);
      body = `<div class="m-big">${fmtLength(total, u)}</div>
        <div class="m-sub">${segs.length} segment${segs.length === 1 ? '' : 's'}${segs.length > 1 ? ` · last ${fmtLength(segs[segs.length - 1], u)}` : ''}</div>`;
    } else {
      const a = area(pts);
      const ring = [...pts, pts[0]];
      const per = ring.slice(1).reduce((s, p, i) => s + distance(ring[i], p), 0);
      body = pts.length < 3
        ? `<div class="m-hint">Add one more point to close an area.</div>`
        : `<div class="m-big">${fmtArea(a, u)}</div><div class="m-sub">perimeter ${fmtLength(per, u)}</div>`;
    }
    this.box.innerHTML = `<div class="m-head"><b>${head}</b><span>
        <button type="button" data-m="units" title="Switch units">${u === 'metric' ? 'Metric' : 'Imperial'}</button>
        <button type="button" data-m="new" title="Start again">New</button>
        <button type="button" data-m="close" aria-label="Close">✕</button></span></div>${body}
      <div class="m-foot">geodesic (on the sphere)</div>`;
    this.box.hidden = false;
  }

  private draw() {
    const pts = this.line();
    const feats: GeoJSON.Feature[] = pts.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
    if (pts.length >= 2) {
      const coords = this.mode === 'area' && pts.length >= 3 ? [...pts, pts[0]] : pts;
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
      if (this.mode === 'area' && pts.length >= 3) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
    }
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: feats };
    const src = this.map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) return src.setData(data);
    if (!this.map.isStyleLoaded()) return;
    this.map.addSource(SRC, { type: 'geojson', data });
    const c = '#ffd166';
    this.map.addLayer({ id: `${SRC}-fill`, type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': c, 'fill-opacity': 0.18 } });
    this.map.addLayer({ id: `${SRC}-line`, type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': c, 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
    this.map.addLayer({ id: `${SRC}-pts`, type: 'circle', source: SRC, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#000', 'circle-stroke-color': c, 'circle-stroke-width': 2 } });
  }
}
