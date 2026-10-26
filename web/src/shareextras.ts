// Share and Design tools that make files or read them (Share › Export data / Publish / Package / Print,
// Design › Survey points / Area table / Hatch, Help › Tutorials):
//
//   - Export data: the selected layer as GeoPackage, Shapefile (zip), KML, CSV, GeoJSON or GeoParquet,
//     written by the engine (GET api/layers/{id}/download)
//   - Publish web map: one self-contained HTML page with the map's visible layers (GeoJSON), their
//     colours, a legend, layer switches and pop-ups. It opens in any browser and can be put on any web
//     host (GitHub Pages, a USB stick, an intranet): an interactive map to share
//   - Package project: a .gspx file with every visible vector layer embedded and the project's styles,
//     which GeoSpaX's Open… reads back
//   - Survey points: a CSV of point id, easting, northing (and height, code) in any EPSG system becomes
//     a labelled point layer
//   - Area table: area and perimeter (geodesic) of each polygon of a layer, as a table to copy or save
import proj4 from 'proj4';
import type { Backend, LayerInfo } from './backend';
import type { Project, LayerStyle } from './symbology';
import { HATCHES } from './symbols';
import { dialog } from './editing';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ShareHost {
  backend: Backend;
  layers: () => LayerInfo[];
  activeId: () => string | null;
  project: () => Project;
  /** layer ids shown on the map, bottom first */
  visible: () => string[];
  view: () => { center: [number, number]; zoom: number };
  setStatus: (text: string, ms?: number) => void;
  applyStyle: () => void;
  saveProject: () => void;
  reload: () => Promise<void>;
  openUrl: (path: string) => void;
}

export function saveBlob(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** Colour expression for MapLibre from a layer's symbology (single, unique values, graduated). */
export function colorExpr(st: LayerStyle | undefined): unknown {
  const s = st?.symbology;
  if (!s) return '#3b82f6';
  if (s.kind === 'single') return s.color;
  if (s.kind === 'unique') {
    if (!s.classes.length) return s.other;
    return ['match', ['to-string', ['get', s.field]], ...s.classes.flatMap((c) => [String(c.value), c.color]), s.other];
  }
  const out: unknown[] = ['step', ['to-number', ['get', s.field], s.min], s.colors[0]];
  s.breaks.slice(0, -1).forEach((b, i) => out.push(b, s.colors[i + 1] ?? s.colors[s.colors.length - 1]));
  return out;
}

function legendHtml(name: string, st: LayerStyle | undefined): string {
  const s = st?.symbology;
  const sw = (c: string) => `<i style="background:${esc(c)}"></i>`;
  if (!s || s.kind === 'single') return `<div class="lg">${sw(s?.kind === 'single' ? s.color : '#3b82f6')}${esc(name)}</div>`;
  if (s.kind === 'unique') return `<div class="lg-h">${esc(name)} · ${esc(s.field)}</div>${s.classes.slice(0, 12).map((c) => `<div class="lg">${sw(c.color)}${esc(c.value)}</div>`).join('')}`;
  return `<div class="lg-h">${esc(name)} · ${esc(s.field)}</div>${s.colors.map((c, i) => `<div class="lg">${sw(c)}${esc(s.labels?.[i] ?? `≤ ${s.breaks[i]}`)}</div>`).join('')}`;
}

export class ShareExtras {
  constructor(private h: ShareHost) {}

  private active(): LayerInfo | undefined {
    const id = this.h.activeId();
    return id ? this.h.layers().find((l) => l.id === id) : undefined;
  }

  /** Share › Export data › <format>: the selected layer as a file. */
  async download(fmt: string) {
    const l = this.active();
    if (!l) return this.h.setStatus('Pick the layer to export in Contents first.', 5000);
    this.h.setStatus(`Writing ${l.name} as ${fmt.toUpperCase()}…`);
    try {
      const { bytes, headers } = await this.h.backend.binary(`api/layers/${encodeURIComponent(l.id)}/download?format=${fmt}`);
      const name = /filename="([^"]+)"/.exec(headers.get('Content-Disposition') ?? '')?.[1] ?? `${l.name}.${fmt}`;
      saveBlob(name, new Blob([bytes], { type: headers.get('Content-Type') ?? 'application/octet-stream' }));
      this.h.setStatus(`${name} saved (${(bytes.byteLength / 1024).toFixed(0)} kB)`, 5000);
    } catch (e) {
      this.h.setStatus(`Export failed: ${(e as Error).message}`, 8000);
    }
  }

  /** The visible vector layers as GeoJSON (bottom first), up to `maxBytes` in all. */
  private async visibleGeojson(maxBytes: number) {
    const out: { l: LayerInfo; st: LayerStyle | undefined; fc: GeoJSON.FeatureCollection }[] = [];
    let total = 0;
    const skipped: string[] = [];
    for (const id of this.h.visible()) {
      const l = this.h.layers().find((x) => x.id === id);
      if (!l) continue;
      try {
        const { bytes } = await this.h.backend.binary(`api/layers/${encodeURIComponent(id)}/download?format=geojson`);
        if (total + bytes.byteLength > maxBytes) { skipped.push(l.name); continue; }
        total += bytes.byteLength;
        out.push({ l, st: this.h.project().layers[id], fc: JSON.parse(new TextDecoder().decode(bytes)) });
      } catch {
        skipped.push(l.name);
      }
    }
    return { out, skipped, total };
  }

  /** The top visible layer's name, as Finish my map suggests. */
  private suggestTitle(): string {
    const top = [...this.h.visible()].reverse().map((id) => this.h.layers().find((l) => l.id === id)).find(Boolean);
    return top ? top.name.replace(/\.(geojson|gpkg|shp|csv|kml)$/i, '').replace(/[_.]+/g, ' ') : 'My map';
  }

  /** Share › Publish web map: an interactive map in one HTML file. */
  async publishWebMap() {
    if (!this.h.visible().length) return this.h.setStatus('Switch on the layers to publish first: the web map shows what is on the map.', 6000);
    const v = await dialog('Publish an interactive web map', `<p class="dim">One HTML file with the visible layers, their colours, a legend, layer switches and pop-ups. Open it in any browser, or put it on any web host (GitHub Pages, your organisation's site, a USB stick).</p>
      <label class="row"><span>Title</span><input name="title" value="${esc(this.suggestTitle())}"></label>
      <label class="row"><span>Basemap</span><select name="basemap"><option value="osm">OpenStreetMap</option><option value="imagery">Satellite imagery (Esri)</option><option value="none">None</option></select></label>`, [['ok', 'Make the web map'], ['', 'Cancel']]);
    if (v.button !== 'ok') return;
    this.h.setStatus('Collecting the layers…');
    const { out, skipped } = await this.visibleGeojson(40 * 1024 * 1024);
    if (!out.length) return this.h.setStatus('No vector layers could be read for the web map.', 6000);
    const title = v.values.title.trim() || 'My map';
    const html = webMapHtml(title, out.map(({ l, st, fc }) => ({ id: l.id, name: l.name, geometry: l.geometry, fc, color: colorExpr(st), opacity: st?.opacity ?? 0.8, legend: legendHtml(l.name, st) })), this.h.view(), v.values.basemap);
    const file = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map'}.html`;
    saveBlob(file, new Blob([html], { type: 'text/html' }));
    this.h.setStatus(`${file} saved: ${out.length} layer${out.length === 1 ? '' : 's'}${skipped.length ? ` (left out, too big: ${skipped.join(', ')})` : ''}. Open it in a browser or upload it to a web host.`, 10000);
  }

  /** Share › Package project: a .gspx with the visible vector layers embedded and the styles. */
  async packageProject() {
    if (!this.h.visible().length) return this.h.setStatus('Switch on the layers to package first.', 5000);
    this.h.setStatus('Packaging the project…');
    const { out, skipped } = await this.visibleGeojson(200 * 1024 * 1024);
    const name = this.suggestTitle();
    const v = this.h.view();
    const doc = {
      format: 'geospax-project',
      version: 3,
      name,
      saved: new Date().toISOString(),
      mapView: { center: v.center, zoom: v.zoom },
      layers: out.map(({ l, st, fc }) => ({ name: l.name, id: l.id, geometry: l.geometry, crs: l.crs, style: st, geojson: fc })),
      project: this.h.project(),
    };
    const file = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'project'}.gspx`;
    saveBlob(file, new Blob([JSON.stringify(doc)], { type: 'application/json' }));
    this.h.setStatus(`${file} saved with ${out.length} layer${out.length === 1 ? '' : 's'}${skipped.length ? ` (left out: ${skipped.join(', ')})` : ''}. Project › Open… reads it back.`, 9000);
  }

  /** Share › Print: the map as it is on screen, on paper (the browser's print dialog). */
  print() {
    document.body.classList.add('gx-printing');
    const done = () => { document.body.classList.remove('gx-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 50);
  }

  // ------------------------------------------------------------------ Design

  /** Design › Survey points: a CSV of point, easting, northing [, height, code] in any EPSG system. */
  async surveyPoints() {
    const v = await dialog('Survey points from a CSV', `<p class="dim">One point per line: <b>point id, easting (x), northing (y)</b>, then optionally height and a code. A header line is skipped. Paste the text or choose a file.</p>
      <label class="row"><span>File</span><input type="file" name="file" accept=".csv,.txt"></label>
      <textarea name="text" rows="6" style="width:100%" placeholder="P1, 491234.56, 9254321.12, 23.4, BM&#10;P2, 491250.00, 9254300.75, 22.9, FENCE"></textarea>
      <label class="row"><span>Coordinate system</span><input name="crs" value="EPSG:32755" placeholder="EPSG code (UTM 55S = 32755, PNG94 / PNGMG94 = 5552)"></label>
      <label class="row"><span>Layer name</span><input name="name" value="Survey points"></label>`, [['ok', 'Make the layer'], ['', 'Cancel']]);
    if (v.button !== 'ok') return;
    let text = v.values.text ?? '';
    const file = v.root.querySelector<HTMLInputElement>('input[name=file]')?.files?.[0];
    if (file) text = await file.text();
    const code = v.values.crs.trim().toUpperCase().replace(/^(\d+)$/, 'EPSG:$1');
    let def: string;
    try {
      def = (await this.h.backend.json<{ proj4: string }>(`api/crs/${encodeURIComponent(code)}`)).proj4;
    } catch (e) {
      return this.h.setStatus(`Unknown coordinate system ${code}: ${(e as Error).message}`, 6000);
    }
    const rows = parseSurvey(text);
    if (!rows.length) return this.h.setStatus('No points found: each line needs an id, an easting and a northing.', 6000);
    const name = v.values.name.trim() || 'Survey points';
    try {
      const r = await this.h.backend.json<{ layer: LayerInfo }>('api/layers/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, geometry: 'point', fields: [{ name: 'point', kind: 'text' }, { name: 'easting', kind: 'real' }, { name: 'northing', kind: 'real' }, { name: 'height', kind: 'real' }, { name: 'code', kind: 'text' }] }) });
      const id = r.layer.id;
      for (const p of rows) {
        const [lon, lat] = proj4(def, 'EPSG:4326', [p.e, p.n]);
        await this.h.backend.json(`api/layers/${encodeURIComponent(id)}/features`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { point: p.id, easting: p.e, northing: p.n, height: p.h, code: p.code } }) });
      }
      await this.h.reload();
      const st = this.h.project().layers[id];
      if (st) {
        st.labels = { ...(st.labels ?? {}), field: 'point', on: true } as LayerStyle['labels'];
        this.h.applyStyle();
        this.h.saveProject();
      }
      this.h.setStatus(`${rows.length} survey points in ${name} (${code}), labelled by point id.`, 6000);
    } catch (e) {
      this.h.setStatus(`Survey points: ${(e as Error).message}`, 8000);
    }
  }

  /** Design › Area table: geodesic area and perimeter of each polygon of the selected layer. */
  async areaTable() {
    const l = this.active();
    if (!l) return this.h.setStatus('Pick a polygon layer first.', 5000);
    if (l.geometry !== 'polygon') return this.h.setStatus(`${l.name} holds ${l.geometry}s: the area table needs polygons.`, 5000);
    const t = await this.h.backend.json<{ rows: { fid: number }[]; total: number }>(`api/layers/${encodeURIComponent(l.id)}/table`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 500 }) });
    const rows: { fid: number; a: number; p: number }[] = [];
    for (const r of t.rows) {
      const f = await this.h.backend.json<GeoJSON.Feature>(`api/layers/${encodeURIComponent(l.id)}/features/${r.fid}`).catch(() => null);
      if (!f?.geometry) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      let a = 0, p = 0;
      for (const poly of polys) poly.forEach((ring, i) => { a += (i ? -1 : 1) * ringArea(ring); p += ringLength(ring); });
      rows.push({ fid: r.fid, a, p });
    }
    const tot = rows.reduce((s, r) => s + r.a, 0);
    const csv = ['fid,area_m2,area_ha,perimeter_m', ...rows.map((r) => `${r.fid},${r.a.toFixed(2)},${(r.a / 1e4).toFixed(4)},${r.p.toFixed(2)}`)].join('\n');
    const v = await dialog(`Area table · ${l.name}`, `<p class="dim">Geodesic (on the ellipsoid's mean sphere), ${rows.length}${t.total > rows.length ? ` of ${t.total}` : ''} polygons. Total ${(tot / 1e4).toFixed(4)} ha.</p>
      <div style="max-height:320px;overflow:auto"><table class="rules"><tr><th>Feature</th><th>Area (m²)</th><th>Area (ha)</th><th>Perimeter (m)</th></tr>
      ${rows.map((r) => `<tr><td>${r.fid}</td><td>${r.a.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td>${(r.a / 1e4).toFixed(4)}</td><td>${r.p.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td></tr>`).join('')}</table></div>`, [['csv', 'Save as CSV'], ['', 'Close']]);
    if (v.button === 'csv') saveBlob(`${l.name}-areas.csv`, new Blob([csv], { type: 'text/csv' }));
  }

  /** Design › Hatch: a fill pattern for the selected polygon layer. */
  async hatch() {
    const l = this.active();
    const st = l ? this.h.project().layers[l.id] : undefined;
    if (!l || !st) return this.h.setStatus('Pick a polygon layer first.', 5000);
    if (l.geometry !== 'polygon') return this.h.setStatus('Hatching fills polygons.', 5000);
    const cur = st.fill?.pattern ?? '';
    const v = await dialog(`Hatch · ${l.name}`, `<label class="row"><span>Pattern</span><select name="p"><option value="">Solid fill</option>${HATCHES.map(([k, t]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`, [['ok', 'Apply'], ['', 'Cancel']]);
    if (v.button !== 'ok') return;
    st.fill = { ...(st.fill ?? { fill: true, strokeColor: '#ffffff', strokeWidth: 1 }), pattern: (v.values.p || undefined) as never, fill: true } as LayerStyle['fill'];
    this.h.applyStyle();
    this.h.saveProject();
    this.h.setStatus(v.values.p ? `${l.name}: ${v.values.p} hatch` : `${l.name}: solid fill`);
  }
}

// ------------------------------------------------------------------ helpers

export function parseSurvey(text: string): { id: string; e: number; n: number; h: number | null; code: string | null }[] {
  const out: { id: string; e: number; n: number; h: number | null; code: string | null }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(/[,;\t]| {2,}/).map((x) => x.trim()).filter((x) => x !== '');
    if (c.length < 3) continue;
    const e = Number(c[1]), n = Number(c[2]);
    if (!Number.isFinite(e) || !Number.isFinite(n)) continue; // a header line
    const h = c[3] !== undefined && Number.isFinite(Number(c[3])) ? Number(c[3]) : null;
    const code = c[h === null ? 3 : 4] ?? null;
    out.push({ id: c[0], e, n, h, code });
  }
  return out;
}

const R = 6371008.8;
function ringArea(r: number[][]): number {
  // spherical excess (as Calculate geometry in the engine)
  let s = 0;
  const n = r.length;
  for (let i = 0; i < n; i++) {
    const p1 = r[i], p2 = r[(i + 1) % n], p3 = r[(i + 2) % n];
    s += ((p3[0] - p1[0]) * Math.PI) / 180 * Math.sin((p2[1] * Math.PI) / 180);
  }
  return Math.abs((s * R * R) / 2);
}
function ringLength(r: number[][]): number {
  let m = 0;
  const rad = Math.PI / 180;
  for (let i = 1; i < r.length; i++) {
    const a = r[i - 1], b = r[i];
    const h = Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
    m += 2 * R * Math.asin(Math.sqrt(h));
  }
  return m;
}

interface WebLayer { id: string; name: string; geometry: string; fc: GeoJSON.FeatureCollection; color: unknown; opacity: number; legend: string }

/** The published page: MapLibre GL JS from a CDN, the data inline, nothing else needed. */
export function webMapHtml(title: string, layers: WebLayer[], view: { center: [number, number]; zoom: number }, basemap: string): string {
  const bm = basemap === 'imagery'
    ? { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }
    : basemap === 'osm' ? { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap contributors' } : null;
  const data = JSON.stringify({ layers: layers.map(({ legend, ...l }) => ({ ...l, legend })), view, basemap: bm }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" integrity="sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V" crossorigin="anonymous">
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js" integrity="sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj" crossorigin="anonymous"></script>
<style>
html,body{margin:0;height:100%;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}
#map{position:absolute;inset:0}
.panel{position:absolute;top:12px;left:12px;max-width:min(320px,calc(100% - 24px));max-height:calc(100% - 48px);overflow:auto;background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.18);padding:12px 14px}
.panel h1{font-size:16px;margin:0 0 8px}
.panel label{display:flex;gap:6px;align-items:center;margin:4px 0;font-weight:600}
.lg{display:flex;gap:6px;align-items:center;margin:2px 0 2px 22px;font-size:12px}.lg-h{margin:2px 0 2px 22px;font-size:12px;color:#475569}
.lg i{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.2)}
.maplibregl-popup-content{max-height:260px;overflow:auto;font-size:12px}.maplibregl-popup-content table td{padding:1px 6px;vertical-align:top}
.made{position:absolute;bottom:4px;left:8px;font-size:11px;color:#475569;background:rgba(255,255,255,.7);padding:1px 6px;border-radius:4px}
@media (max-width:600px){.panel{top:auto;bottom:24px;max-height:40%}}
</style></head><body>
<div id="map"></div>
<div class="panel"><h1>${esc(title)}</h1><div id="toc"></div></div>
<div class="made">Made with GeoSpaX</div>
<script>
const D = ${data};
const style = { version: 8, sources: {}, layers: [] };
if (D.basemap) { style.sources.base = { type: 'raster', tiles: D.basemap.tiles, tileSize: 256, attribution: D.basemap.attribution, maxzoom: 19 }; style.layers.push({ id: 'base', type: 'raster', source: 'base' }); }
else style.layers.push({ id: 'bg', type: 'background', paint: { 'background-color': '#f1f5f9' } });
const map = new maplibregl.Map({ container: 'map', style, center: D.view.center, zoom: D.view.zoom });
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
const ids = [];
// style.load, not load: the layers go on as soon as the style is ready, even before (or without)
// basemap tiles
map.once('style.load', () => {
  const bounds = new maplibregl.LngLatBounds();
  for (const l of D.layers) {
    map.addSource(l.id, { type: 'geojson', data: l.fc });
    const kind = l.geometry;
    const lid = (s) => l.id + '#' + s;
    if (kind === 'polygon') {
      map.addLayer({ id: lid('fill'), type: 'fill', source: l.id, paint: { 'fill-color': l.color, 'fill-opacity': l.opacity * 0.75 } });
      map.addLayer({ id: lid('line'), type: 'line', source: l.id, paint: { 'line-color': '#ffffff', 'line-width': 0.8 } });
      ids.push(lid('fill'));
    } else if (kind === 'line') {
      map.addLayer({ id: lid('line'), type: 'line', source: l.id, paint: { 'line-color': l.color, 'line-width': 2.2, 'line-opacity': l.opacity } });
      ids.push(lid('line'));
    } else {
      map.addLayer({ id: lid('circle'), type: 'circle', source: l.id, paint: { 'circle-color': l.color, 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-opacity': l.opacity } });
      ids.push(lid('circle'));
    }
    const walk = (c) => typeof c[0] === 'number' ? bounds.extend(c) : c.forEach(walk);
    for (const f of l.fc.features) if (f.geometry) walk(f.geometry.coordinates);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40, maxZoom: 16, duration: 0 });
  const toc = document.getElementById('toc');
  for (const l of [...D.layers].reverse()) {
    const wrap = document.createElement('div');
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.onchange = () => ['fill', 'line', 'circle'].forEach((s) => map.getLayer(l.id + '#' + s) && map.setLayoutProperty(l.id + '#' + s, 'visibility', cb.checked ? 'visible' : 'none'));
    lab.append(cb, document.createTextNode(l.name));
    const lg = document.createElement('div');
    lg.innerHTML = l.legend; // built by GeoSpaX with every value escaped
    wrap.append(lab, lg);
    toc.append(wrap);
  }
  map.on('click', (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ids })[0];
    if (!f) return;
    const t = document.createElement('table');
    for (const [k, v] of Object.entries(f.properties || {})) {
      if (v === null || v === '') continue;
      const tr = t.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = String(v);
    }
    new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(t).addTo(map);
  });
  for (const id of ids) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
});
</script></body></html>`;
}
