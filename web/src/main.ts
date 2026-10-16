import * as maplibregl from 'maplibre-gl';
import { AutomatePane, type RunInfo } from './automate';
import { DevicesPane, type LiveGeoJSON } from './devices';
import { PhoneCard } from './phone';
import { RasterPane } from './rasters';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Deck, MapView } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { tableFromIPC } from 'apache-arrow';
import { createBackend, clientTileTimings, type EngineStats, type Job, type LayerInfo, type Transport } from './backend';
import { runBenchmark, type BenchReport } from './bench';
import { SymbologyPanel } from './panel';
import { AttributesPane } from './attributes';
import { Workbench } from './workbench';
import { PluginsPane } from './plugins';
import {
  colorExpression,
  fmtNum,
  legendItems,
  primaryColor,
  symbologyField,
  type LayerStyle,
  type Project,
} from './symbology';
import './style.css';

maplibregl.setWorkerUrl(workerUrl);

const backend = createBackend();

// Forward client errors/warnings to the engine log: release webviews (Tauri)
// have no devtools, and headless smoke tests read the engine's stderr.
{
  let budget = 40;
  const send = (level: string, msg: unknown) => {
    if (budget-- <= 0) return;
    const text = `${backend.edition}/${backend.transport} ${level}: ${msg instanceof Error ? `${msg.message}\n${msg.stack ?? ''}` : String(msg)}`;
    void backend.json('api/log', { method: 'POST', body: text.slice(0, 4000) }).catch(() => {});
  };
  window.addEventListener('error', (e) => send('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => send('rejection', e.reason));
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      send(level, args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '));
    };
  }
  (window as unknown as { __clientLog: typeof send }).__clientLog = send;
}
const params = new URLSearchParams(location.search);
const wanted = params.get('transport') as Transport | null;
if (wanted && backend.transports.includes(wanted)) backend.transport = wanted;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fmt = (n: number) => n.toLocaleString('en-US');
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MAX_LAT = 85.0511;

// ---------------------------------------------------------------- state
const PALETTE: Record<string, string> = {
  'natural_earth.countries': '#2c4a3a',
  'natural_earth.rivers': '#4f8fd1',
  'natural_earth.roads': '#c9a46b',
  'natural_earth.places': '#ffd166',
  'synthetic.buildings': '#ef7b55',
  'synthetic.points': '#2ec4b6',
  'synthetic_buildings.fgb': '#b388ff',
  'synthetic_buildings.shp': '#80cbc4',
};
// Device-hub layers (docs/DEVICES.md) get recognisable colours: photos, tracks, waypoints.
const DEVICE_COLORS: Record<string, string> = { photos: '#ff8c42', tracks: '#e040fb', waypoints: '#40c4ff' };
const colorFor = (id: string) => PALETTE[id] ?? DEVICE_COLORS[id.split('.').pop() ?? ''] ?? '#9aa5b1';
const isDeviceLayer = (id: string) => (id.split('.').pop() ?? '') in DEVICE_COLORS;
let liveData: LiveGeoJSON = { type: 'FeatureCollection', features: [] };
const defaultVisible = (l: LayerInfo) => !l.id.endsWith('.fgb') && !l.id.endsWith('.shp') && l.id !== 'synthetic.points';
const GEOM_ORDER: Record<string, number> = { polygon: 0, line: 1, point: 2, unknown: 3 };
const isLand = (id: string) => id === 'natural_earth.countries';

let layers: LayerInfo[] = [];
let project: Project = { version: 1, order: [], layers: {} };
const jobs = new Map<string, Job>(); // layer id -> latest job
let map: maplibregl.Map;
let rasterPane: RasterPane | null = null;
let panel: SymbologyPanel;
let automatePane: AutomatePane | null = null;
let attributesPane: AttributesPane | null = null;
let workbench: Workbench | null = null;
let pluginsPane: PluginsPane | null = null;

const layerById = (id: string) => layers.find((l) => l.id === id);

function defaultStyle(l: LayerInfo): LayerStyle {
  return {
    visible: defaultVisible(l),
    opacity: isLand(l.id) ? 1 : l.geometry === 'polygon' ? 0.85 : 1,
    minzoom: 0,
    maxzoom: 24,
    outline: l.geometry === 'polygon',
    symbology: { kind: 'single', color: colorFor(l.id) },
  };
}

/** Saved project + layers discovered now (new layers get defaults, vanished ones are dropped). */
function mergeProject(saved: Project | null): Project {
  const defaultOrder = [...layers]
    .sort((a, b) => (isLand(a.id) ? -1 : 0) - (isLand(b.id) ? -1 : 0) || GEOM_ORDER[a.geometry] - GEOM_ORDER[b.geometry])
    .map((l) => l.id);
  const known = new Set(defaultOrder);
  const order = (saved?.order ?? []).filter((id) => known.has(id));
  for (const id of defaultOrder) if (!order.includes(id)) order.push(id);
  const styles: Record<string, LayerStyle> = {};
  for (const l of layers) styles[l.id] = { ...defaultStyle(l), ...(saved?.layers?.[l.id] ?? {}) };
  return { version: 1, order, layers: styles, view: saved?.view };
}

let saveTimer: number | undefined;
function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (map) project.view = { center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() };
    try {
      await backend.json('api/project', {
        method: 'PUT',
        body: JSON.stringify(project),
        headers: { 'content-type': 'application/json' },
      });
      document.body.dataset.saved = String(Date.now());
    } catch (e) {
      console.warn('project save failed', e);
    }
  }, 600);
}

// ---------------------------------------------------------------- style
const rgba = (hex: string, a: number) => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
};

/** ?gldebug: WebGL error flags and per-source tile state (uses MapLibre internals; debugging only). */
function glDebugReport(map: maplibregl.Map, label: string) {
  type DbgTile = { state: string; buckets?: Record<string, unknown>; tileID: { canonical: { z: number; x: number; y: number } } };
  type DbgManager = { _inViewTiles?: { _tiles?: Record<string, DbgTile> }; getRenderableIds(): unknown[] };
  const gl = (map.painter as unknown as { context?: { gl?: WebGL2RenderingContext } }).context?.gl;
  const errs: string[] = [];
  for (let i = 0; gl && i < 8; i++) {
    const e = gl.getError();
    if (!e) break;
    errs.push(`0x${e.toString(16)}`);
  }
  const managers = (map.style as unknown as { tileManagers?: Record<string, DbgManager> }).tileManagers ?? {};
  const parts = Object.entries(managers).map(([id, m]) => {
    const tiles = Object.values(m._inViewTiles?._tiles ?? {}); // MapLibre 6.x internals
    const states: Record<string, number> = {};
    for (const t of tiles) states[t.state] = (states[t.state] ?? 0) + 1;
    const empty = tiles
      .filter((t) => t.state === 'loaded' && Object.keys(t.buckets ?? {}).length === 0)
      .map((t) => `${t.tileID.canonical.z}/${t.tileID.canonical.x}/${t.tileID.canonical.y}`);
    return `${id} ${JSON.stringify(states)} renderable=${m.getRenderableIds().length}${empty.length ? ` no-buckets=[${empty.join(' ')}]` : ''}`;
  });
  const log = (window as unknown as { __clientLog: (l: string, m: unknown) => void }).__clientLog;
  log('info', `${label} after ${Math.round(performance.now())} ms; gl errors: ${errs.join(',') || 'none'}; ${parts.join(' | ')}`);
}

/** Density heatmap over the overview pyramid's `<layer>:density` points. */
function heatmapLayer(l: LayerInfo, st: LayerStyle): maplibregl.LayerSpecification {
  const ov = l.overview!;
  const mz = ov.max_zoom;
  const c = primaryColor(st.symbology);
  // Weight = sqrt(count / p90 of the densest cell at that zoom), measured by
  // the build job. Tiles are per integer zoom, so step (not interpolate).
  const w = (z: number) => {
    const d = Math.max(1, ov.density_p90?.[z] || 4 ** Math.max(0, 12 - z) * 8);
    return ['min', 1, ['sqrt', ['/', ['get', 'count'], d]]];
  };
  const weight: unknown[] = ['step', ['zoom'], w(0)];
  for (let z = 1; z <= mz; z++) weight.push(z, w(z));
  return {
    id: `${l.id}#density`,
    type: 'heatmap',
    source: l.id,
    'source-layer': `${l.id}:density`,
    minzoom: st.minzoom,
    maxzoom: Math.min(mz + 1, st.maxzoom),
    layout: { visibility: st.visible ? 'visible' : 'none' },
    paint: {
      'heatmap-weight': weight,
      // ~ (radius/cell)^2 cells overlap each pixel: keep the kernel sum below 1 except in the densest spots
      'heatmap-intensity': 0.6,
      'heatmap-radius': 9,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)', 0.06, rgba(c, 0.1), 0.25, rgba(c, 0.5), 0.55, c, 0.85, '#ffd27f', 1, '#fff4c2',
      ],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], mz - 1, 0.9 * st.opacity, mz, 0.6 * st.opacity, mz + 1, 0.25 * st.opacity],
    },
  } as unknown as maplibregl.LayerSpecification;
}

function buildStyle(): maplibregl.StyleSpecification {
  const sources: maplibregl.StyleSpecification['sources'] = {};
  const out: maplibregl.LayerSpecification[] = [{ id: 'background', type: 'background', paint: { 'background-color': '#0d2233' } }];
  for (const id of project.order) {
    const l = layerById(id);
    if (!l) continue;
    const st = project.layers[id];
    const [w, s, e, n] = l.bounds;
    const fld = symbologyField(st.symbology);
    const fields = fld && !l.tile_fields.includes(fld) ? [...l.tile_fields, fld] : undefined;
    let url = backend.tileUrl(id, fields);
    // cache-bust the client tile cache when a pyramid is (re)built
    if (l.overview) url += `${url.includes('?') ? '&' : '?'}ov=${l.overview.built_at}`;
    sources[id] = {
      type: 'vector',
      tiles: [url],
      minzoom: l.minzoom,
      maxzoom: l.maxzoom,
      bounds: [Math.max(w, -180), Math.max(s, -MAX_LAT), Math.min(e, 180), Math.min(n, MAX_LAT)],
    };
    const vis = st.visible ? 'visible' : 'none';
    const color = colorExpression(st.symbology);
    const zoom = { minzoom: st.minzoom, ...(st.maxzoom < 24 ? { maxzoom: st.maxzoom } : {}) };
    const base = { source: id, 'source-layer': id, layout: { visibility: vis }, ...zoom } as const;
    // ?heatmap=0 is a debug switch (WebKitGTK partial-render investigation)
    if (l.overview && new URLSearchParams(location.search).get('heatmap') !== '0') out.push(heatmapLayer(l, st));
    if (l.geometry === 'polygon') {
      out.push({ ...base, id: `${id}#fill`, type: 'fill', paint: { 'fill-color': color, 'fill-opacity': st.opacity } } as maplibregl.LayerSpecification);
      if (st.outline) {
        out.push({
          ...base,
          id: `${id}#line`,
          type: 'line',
          minzoom: Math.max(isLand(id) ? 0 : 13, st.minzoom),
          paint: {
            'line-color': isLand(id) ? '#5d8a70' : '#0d2233',
            'line-width': isLand(id) ? 0.6 : 0.5,
            'line-opacity': Math.min(1, st.opacity + 0.15),
          },
        } as maplibregl.LayerSpecification);
      }
    } else if (l.geometry === 'line') {
      out.push({
        ...base,
        id: `${id}#line`,
        type: 'line',
        paint: { 'line-color': color, 'line-opacity': st.opacity, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.4, 10, 1.6, 14, 3] },
      } as maplibregl.LayerSpecification);
    } else {
      out.push({
        ...base,
        id: `${id}#circle`,
        type: 'circle',
        paint: {
          'circle-color': color,
          'circle-opacity': st.opacity,
          // device points (photos, waypoints) are few and important: bigger, with a white ring
          'circle-radius': isDeviceLayer(id) ? ['interpolate', ['linear'], ['zoom'], 2, 3, 10, 5, 15, 7] : ['interpolate', ['linear'], ['zoom'], 2, 1.5, 10, 2.5, 15, 4],
          'circle-stroke-color': isDeviceLayer(id) ? '#ffffff' : '#0d2233',
          'circle-stroke-width': isDeviceLayer(id) ? 1.5 : 0.5,
          'circle-stroke-opacity': st.opacity,
        },
      } as maplibregl.LayerSpecification);
    }
  }
  // Live GNSS devices (phone page, NMEA, gpsd): recent track + current position, always on top.
  sources.live = { type: 'geojson', data: liveData as unknown as GeoJSON.FeatureCollection };
  out.push(
    { id: 'live#track', type: 'line', source: 'live', filter: ['==', ['get', 'role'], 'track'],
      paint: { 'line-color': '#ffd166', 'line-width': 2.5, 'line-dasharray': [2, 1] } } as maplibregl.LayerSpecification,
    { id: 'live#pos', type: 'circle', source: 'live', filter: ['==', ['get', 'role'], 'position'],
      paint: { 'circle-color': '#ffd166', 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } } as maplibregl.LayerSpecification,
  );
  // rasters sit above the land polygons and below every other vector layer
  if (rasterPane) {
    const r = rasterPane.styleParts();
    Object.assign(sources, r.sources);
    let at = 1;
    while (at < out.length && 'source' in out[at] && isLand((out[at] as { source: string }).source)) at++;
    out.splice(at, 0, ...r.layers);
  }
  return { version: 8, sources, layers: out };
}

function applyStyle() {
  map.setStyle(buildStyle()); // MapLibre diffs the style: only changed layers/sources update
}

// ---------------------------------------------------------------- workbench actions
/** Fit the map to one layer (Contents double-click, catalog, ribbon "Zoom to layer"). */
function fitLayer(id: string) {
  const l = layerById(id);
  if (!l || !l.bounds.every(Number.isFinite)) return;
  map.fitBounds([[l.bounds[0], l.bounds[1]], [l.bounds[2], l.bounds[3]]], { padding: 60, maxZoom: 17, duration: 450 });
}

/** Fit every visible layer — Pro's "Full extent". */
function fitAll() {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const id of project.order) {
    const l = layerById(id);
    if (!l || !project.layers[id]?.visible) continue;
    minx = Math.min(minx, l.bounds[0]); miny = Math.min(miny, l.bounds[1]);
    maxx = Math.max(maxx, l.bounds[2]); maxy = Math.max(maxy, l.bounds[3]);
  }
  if (!Number.isFinite(minx)) return;
  map.fitBounds([[minx, miny], [maxx, maxy]], { padding: 60, maxZoom: 17, duration: 450 });
}

/** Let the engine choose a style for one layer (AutoMap). */
async function autostyleLayer(id: string) {
  const r = await backend.json<{ style: Partial<LayerStyle> }>(`api/layers/${encodeURIComponent(id)}/autostyle`).catch(() => null);
  if (!r?.style || !layerById(id)) return;
  project.layers[id] = { ...project.layers[id], ...(r.style as LayerStyle), visible: true };
  applyStyle();
  renderContents();
  saveProject();
}

// ---------------------------------------------------------------- Contents
function renderContents() {
  const el = $('#contents');
  el.innerHTML = '';
  // ArcGIS convention: top of the list draws on top (= end of the draw order)
  const list = [...project.order].reverse();
  list.forEach((id, i) => {
    const l = layerById(id);
    if (!l) return;
    const st = project.layers[id];
    const job = jobs.get(id) ?? l.overview_job ?? undefined;
    const running = job && (job.status === 'queued' || job.status === 'running');
    const items = legendItems(st.symbology);
    const row = document.createElement('div');
    row.className = 'layer' + (panel?.current === id ? ' selected' : '');
    row.dataset.id = id;
    row.innerHTML = `
      <input type="checkbox" ${st.visible ? 'checked' : ''} aria-label="Toggle ${esc(id)}" />
      <span class="swatch ${l.geometry}" style="--c:${esc(primaryColor(st.symbology))}"></span>
      <span class="meta"><b class="name" title="Open symbology">${esc(id)}</b>
        <small>${l.geometry} · ${fmt(l.feature_count)} features · z${l.minzoom}–${l.maxzoom} · ${esc(l.driver)}</small>
        ${l.overview ? `<small class="badge ok">pyramid z0–${l.overview.max_zoom} · ${(l.overview.bytes / 1e6).toFixed(1)} MB</small>` : ''}
        ${running ? `<small class="badge busy">building overviews ${(job!.progress * 100).toFixed(0)}%</small>` : ''}
        ${!l.overview && !running && l.overview_suggested != null ? `<small class="badge warn">live from z${l.live_minzoom} · overviews suggested</small>` : ''}
      </span>
      <span class="tools">
        <button data-act="up" title="Move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button data-act="down" title="Move down" aria-label="Move down" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
        <button data-act="props" title="Symbology" aria-label="Symbology">⚙</button>
      </span>
      ${
        items.length
          ? `<div class="legend"><small>${esc(st.symbology.kind === 'single' ? '' : (st.symbology as { field: string }).field)}</small>${items
              .slice(0, 10)
              .map((it) => `<div><i style="background:${esc(it.color)}"></i>${esc(it.label)}</div>`)
              .join('')}${items.length > 10 ? `<div class="more">… ${items.length - 10} more</div>` : ''}</div>`
          : ''
      }`;
    el.appendChild(row);
  });
}

function setLayerStyle(id: string, st: LayerStyle) {
  project.layers[id] = st;
  applyStyle();
  renderContents();
  saveProject();
}

function moveLayer(id: string, dir: 'up' | 'down') {
  const o = project.order;
  const i = o.indexOf(id);
  const j = dir === 'up' ? i + 1 : i - 1; // up in the list = later in draw order
  if (i < 0 || j < 0 || j >= o.length) return;
  [o[i], o[j]] = [o[j], o[i]];
  applyStyle();
  renderContents();
  saveProject();
}

function wireContents() {
  const el = $('#contents');
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const id = t.closest<HTMLElement>('.layer')?.dataset.id;
    if (!id || t.type !== 'checkbox') return;
    setLayerStyle(id, { ...project.layers[id], visible: t.checked });
  });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const id = t.closest<HTMLElement>('.layer')?.dataset.id;
    if (!id) return;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'up' || act === 'down') moveLayer(id, act);
    else if (act === 'props' || t.classList.contains('name')) {
      panel.open(id);
      renderContents();
    }
  });
}

// ---------------------------------------------------------------- overview jobs
async function reloadLayers() {
  const r = await backend.json<{ layers: LayerInfo[] }>('api/layers');
  layers = r.layers;
  // Layers that appeared at runtime (device imports) join the project with default styles, on top.
  const before = project.order.length;
  project = mergeProject(project);
  if (project.order.length !== before) saveProject();
  applyStyle();
  renderContents();
  panel.refresh();
  document.dispatchEvent(new CustomEvent('geospax:reload-views'));
}

function pollJob(layerId: string, jobId: number) {
  const tick = async () => {
    let j: Job;
    try {
      j = await backend.json<Job>(`api/jobs/${jobId}`);
    } catch {
      return void setTimeout(tick, 2000);
    }
    jobs.set(layerId, j);
    if (j.status === 'queued' || j.status === 'running') {
      renderContents();
      if (panel.current === layerId) panel.refresh();
      setTimeout(tick, 1000);
    } else {
      document.body.dataset.job = j.status;
      await reloadLayers();
    }
  };
  void tick();
}

async function buildOverviews(id: string) {
  const j = await backend.json<Job>(`api/layers/${id}/overviews`, { method: 'POST' });
  jobs.set(id, j);
  renderContents();
  pollJob(id, j.id);
}

// ---------------------------------------------------------------- HUD
function startHud() {
  let frames = 0;
  let fps = 0;
  let last = performance.now();
  const tick = (t: number) => {
    frames++;
    if (t - last >= 500) {
      fps = (frames * 1000) / (t - last);
      frames = 0;
      last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // version tag in the header, from the engine (single source: the Cargo workspace version)
  void backend
    .json<{ version?: string }>('api/health')
    .then((h) => {
      const tag = document.querySelector('h1 .tag');
      if (tag && h.version) tag.textContent = `v${h.version}`;
    })
    .catch(() => {});
  const hud = $('#hud');
  // developer stats (FPS, tiles, cache) stay out of the way: ?hud=1 or a benchmark run shows them
  if (!(params.get('hud') === '1' || params.has('bench') || params.has('gldebug'))) {
    hud.style.display = 'none';
    return;
  }
  const update = async () => {
    let s: EngineStats | null = null;
    try {
      s = await backend.json<EngineStats>('api/stats');
    } catch {
      /* engine busy or restarting */
    }
    const ct = clientTileTimings.slice(-200).sort((a, b) => a - b);
    const cp = (p: number) => (ct.length ? ct[Math.round((ct.length - 1) * p)].toFixed(1) : '–');
    hud.innerHTML = `
      <div><span>FPS</span><b>${fps.toFixed(0)}</b></div>
      <div><span>zoom</span><b>${map.getZoom().toFixed(2)}</b></div>
      <div><span>edition</span><b>${backend.edition} · ${backend.transport}</b></div>
      ${s ? `
      <div><span>reader</span><b>${s.reader} · gpkg ${s.gpkg_filtered}</b></div>
      <div><span>tiles live / pyramid</span><b>${fmt(s.tiles_rendered)} / ${fmt(s.overview_tiles)}</b></div>
      <div><span>cache hits</span><b>${fmt(s.cache_hits)}</b></div>
      <div><span>render p50 / p95</span><b>${s.render_ms_p50.toFixed(1)} / ${s.render_ms_p95.toFixed(1)} ms</b></div>
      <div><span>MB served</span><b>${(s.bytes_served / 1e6).toFixed(1)}</b></div>` : ''}
      ${backend.transport === 'invoke' ? `<div><span>invoke p50 / p95</span><b>${cp(0.5)} / ${cp(0.95)} ms</b></div>` : ''}`;
  };
  setInterval(update, 1000);
  void update();
}

// ---------------------------------------------------------------- Arrow -> deck.gl
// deck.gl 9.4's MapboxOverlay (interleaved mode; overlaid mode with terrain)
// reads map.transform, which MapLibre GL JS 6 removed, so it throws on v6. Instead we run a standalone
// Deck on its own canvas, synced through MapLibre's *public* camera API.
// (Both use the same 512 px Web Mercator zoom convention, so this is exact.)
let deck: Deck<MapView> | null = null;

function ensureDeck(): Deck<MapView> {
  if (deck) return deck;
  const canvas = document.createElement('canvas');
  canvas.id = 'deck-canvas';
  map.getCanvasContainer().after(canvas);
  const viewState = () => {
    const c = map.getCenter();
    return { longitude: c.lng, latitude: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  };
  const d = new Deck({ canvas, views: new MapView({ repeat: true }), viewState: viewState(), controller: false, layers: [] });
  map.on('move', () => d.setProps({ viewState: viewState() }));
  map.on('resize', () => d.setProps({ viewState: viewState() }));
  deck = d;
  return d;
}

async function loadArrowPoints(layerId: string) {
  const out = $('#results');
  out.innerHTML = `<p>Loading <b>${esc(layerId)}</b> as Arrow IPC…</p>`;
  const t0 = performance.now();
  const { bytes, headers } = await backend.binary(`api/layers/${layerId}/arrow`);
  const t1 = performance.now();
  const table = tableFromIPC(new Uint8Array(bytes));
  const child = table.getChild('geometry')!.data[0].children[0];
  const coords = (child.values as Float64Array).subarray(child.offset, child.offset + child.length);
  const n = coords.length / 2;
  const t2 = performance.now();
  const d = ensureDeck();
  // First frame after the data is set = GPU upload of all 1M positions + draw.
  await new Promise<void>((resolve) => {
    d.setProps({
      onAfterRender: () => resolve(),
      layers: [
        new ScatterplotLayer({
          id: 'arrow-points',
          data: { length: n, attributes: { getPosition: { value: coords, size: 2 } } },
          getRadius: 2,
          radiusUnits: 'pixels',
          getFillColor: [46, 196, 182, 200],
        }),
      ],
    });
  });
  const t3 = performance.now();
  const server = headers.get('server-timing') ?? '';
  const res = {
    layer: layerId,
    rows: n,
    mb: bytes.byteLength / 1e6,
    fetch_ms: t1 - t0,
    parse_ms: t2 - t1,
    first_render_ms: t3 - t2,
    total_ms: t3 - t0,
    server_timing: server,
  };
  out.innerHTML = `<h3>Arrow → deck.gl</h3>
    <table>
      <tr><td>rows</td><td>${fmt(n)}</td></tr>
      <tr><td>payload</td><td>${res.mb.toFixed(1)} MB</td></tr>
      <tr><td>fetch (engine + transport)</td><td>${res.fetch_ms.toFixed(0)} ms</td></tr>
      <tr><td>engine (Server-Timing)</td><td>${esc(server.replace(/;dur=/g, ' ').replace(/,/g, ' ms,'))} ms</td></tr>
      <tr><td>Arrow parse (zero-copy)</td><td>${res.parse_ms.toFixed(1)} ms</td></tr>
      <tr><td>deck.gl first render</td><td>${res.first_render_ms.toFixed(0)} ms</td></tr>
      <tr><td><b>total</b></td><td><b>${res.total_ms.toFixed(0)} ms</b></td></tr>
    </table>`;
  return res;
}

function showBench(r: BenchReport) {
  const rows = r.stops
    .map(
      (s) => `<tr><td>${s.name}</td><td>${s.zoom}</td><td>${s.fps_avg.toFixed(0)}</td><td>${s.fps_min.toFixed(0)}</td>
      <td>${s.settle_ms.toFixed(0)}</td><td>${s.tiles_rendered}</td><td>${s.render_ms_mean.toFixed(1)}</td></tr>`,
    )
    .join('');
  $('#results').innerHTML = `<h3>Benchmark · ${r.edition} · ${r.transport}</h3>
    <table class="bench">
      <tr><th>stop</th><th>z</th><th>fps avg</th><th>fps min</th><th>settle ms</th><th>tiles</th><th>render ms</th></tr>${rows}
    </table>
    <p class="summary">mean FPS <b>${r.summary.fps_avg.toFixed(0)}</b> · p95 settle <b>${r.summary.settle_p95_ms.toFixed(0)} ms</b>
      · tiles <b>${r.summary.tiles_rendered}</b> · engine p95 <b>${r.summary.engine_p95_ms.toFixed(1)} ms</b></p>
    <a id="dl" href="#">Download JSON</a>`;
  $('#dl').onclick = (e) => {
    e.preventDefault();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    a.download = `bench-${r.edition}-${r.transport}-${Date.now()}.json`;
    a.click();
  };
}

// ---------------------------------------------------------------- boot
async function main() {
  const [{ layers: ls }, saved] = await Promise.all([
    backend.json<{ layers: LayerInfo[] }>('api/layers'),
    backend.json<Project | null>('api/project').catch(() => null),
  ]);
  layers = ls;
  // ?fresh ignores the saved project (benchmarks, smoke tests)
  project = mergeProject(params.has('fresh') || params.has('bench') ? null : saved);
  $('#edition').textContent = backend.edition === 'web' ? 'Web edition · Axum' : 'Desktop edition · Tauri';

  const hasHashView = /[#&]view=/.test(location.hash);
  const pv = (params.get('view') ?? '').split('/').map(Number);
  const urlView = pv.length === 3 && pv.every(Number.isFinite) ? { zoom: pv[0], center: [pv[2], pv[1]] as [number, number] } : null;
  const view = urlView ?? (!hasHashView && project.view ? project.view : { center: [144.25, -5.87] as [number, number], zoom: 12.5 });
  const ua = navigator.userAgent;
  const webkitGtk = /Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrom/.test(ua);
  const preserveBuffer = params.has('glpdb') ? params.get('glpdb') === '1' : webkitGtk;
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: view.center,
    zoom: view.zoom,
    hash: params.has('bench') ? false : 'view',
    attributionControl: { compact: true, customAttribution: 'GeoSpaX · Natural Earth (public domain) · synthetic buildings' },
    // WebKitGTK (Tauri on Linux) randomly drops whole tiles with the default drawing buffer:
    // MapLibre's tile state is complete and WebGL reports no errors, but some tiles never reach
    // the screen (README finding 17). preserveDrawingBuffer (or MSAA) avoids it. Elsewhere it stays
    // off (it costs a frame copy, more on tile-based GPUs). Override with ?glpdb=0|1, ?glaa=1.
    canvasContextAttributes: { antialias: params.get('glaa') === '1', preserveDrawingBuffer: preserveBuffer },
  });
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({}), 'bottom-left');
  (window as unknown as { map: maplibregl.Map }).map = map;
  map.on('moveend', () => saveProject());
  map.on('error', (e) => console.error('map error:', (e as unknown as { error?: Error }).error ?? e));
  map.once('load', () => {
    const gl = (map.painter as unknown as { context?: { gl?: WebGL2RenderingContext } }).context?.gl;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const exts = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear'].filter((x) => gl.getExtension(x));
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const attrs = gl.getContextAttributes();
      document.body.dataset.gl = `${renderer} | ${exts.join(',')} | antialias=${attrs?.antialias} preserveDrawingBuffer=${attrs?.preserveDrawingBuffer}`;
      if (params.has('gldebug')) (window as unknown as { __clientLog: (l: string, m: unknown) => void }).__clientLog('info', `GL: ${document.body.dataset.gl}`);
    }
  });
  // Headless smoke tests screenshot on the "map idle" line: all tiles loaded, no transitions.
  if (params.has('gldebug')) map.once('idle', () => glDebugReport(map, 'map idle'));
  if (params.has('gldebug')) map.once('idle', () => setTimeout(() => glDebugReport(map, 'idle+8s'), 8000));

  panel = new SymbologyPanel($('#panel'), {
    backend,
    layer: layerById,
    style: (id) => project.layers[id],
    setStyle: setLayerStyle,
    job: (id) => jobs.get(id),
    buildOverviews,
    cancelJob: async (jobId) => {
      await backend.json(`api/jobs/${jobId}/cancel`, { method: 'POST' });
    },
    deleteOverviews: async (id) => {
      await backend.json(`api/layers/${id}/overviews`, { method: 'DELETE' });
      jobs.delete(id);
      await reloadLayers();
    },
  });
  wireContents();
  renderContents();
  startHud();
  // resume polling jobs started in another session/window
  for (const l of layers) if (l.overview_job) pollJob(l.id, l.overview_job.id);

  void new PhoneCard($('#phone-link'), backend).start();
  new DevicesPane($('#devices'), backend, {
    onImported: async (ids, b) => {
      await reloadLayers();
      // one click = a finished look: AutoMap styles the imported layers like a recipe would
      // (photo wedges, track casing, readings coloured by the main measurement / WHO classes)
      for (const id of ids) await autostyleLayer(id);
      applyStyle();
      renderContents();
      saveProject();
      if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 16, duration: 0 });
    },
    onAutoImported: reloadLayers,
    onLive: (d) => {
      liveData = d;
      (map.getSource('live') as maplibregl.GeoJSONSource | undefined)?.setData(d as unknown as GeoJSON.FeatureCollection);
    },
  }).start();

  // Rasters (DEMs, hillshades, NDVI…): server-rendered Web Mercator overlays with AutoMap styles.
  rasterPane = new RasterPane($('#rasters'), backend, {
    restyle: applyStyle,
    fit: (b) => map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, maxZoom: 16, duration: 0 }),
  });
  rasterPane.reload().then(applyStyle);

  // Automation (docs/AUTOMATION.md): when a recipe run finishes, its layers and the styles AutoMap
  // chose appear on the map, and the view moves to them.
  const automate = new AutomatePane($('#automate'), backend, {
    onRunFinished: async (run: RunInfo) => {
      await reloadLayers();
      if (rasterPane && run.rasters?.length) {
        await rasterPane.reload();
        // the main (first) map of the run decides which rasters are shown, like the report
        const steps = (run as unknown as { steps?: { outputs?: { svg?: string; rasters?: string[] } }[] }).steps ?? [];
        const main = steps.find((s) => s.outputs?.svg && Array.isArray(s.outputs?.rasters))?.outputs?.rasters;
        if (run.status === 'done') rasterPane.showRun(run.rasters, main);
      }
      for (const [id, st] of Object.entries(run.styles ?? {})) {
        if (layerById(id)) project.layers[id] = { ...project.layers[id], ...(st as LayerStyle), visible: true };
      }
      applyStyle();
      renderContents();
      saveProject();
      const b = run.extent;
      if (b && run.status === 'done' && b.every(Number.isFinite)) {
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 16, duration: 0 });
      }
      document.body.dataset.runApplied = run.id;
    },
    snapshot: () => {
      const visible = project.order.filter((id) => project.layers[id]?.visible && layerById(id));
      return {
        layers: visible.map((id) => ({ id, style: project.layers[id] })),
        title: `My map · ${new Date().toLocaleDateString()}`,
      };
    },
  });
  automatePane = automate;
  automate.start();

  const tsel = $('#transport') as HTMLSelectElement;
  tsel.innerHTML = backend.transports.map((t) => `<option ${t === backend.transport ? 'selected' : ''}>${t}</option>`).join('');
  tsel.disabled = backend.transports.length < 2;
  tsel.onchange = () => {
    backend.transport = tsel.value as Transport;
    applyStyle();
  };

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-goto]')) {
    b.onclick = () => {
      const [lon, lat, z] = b.dataset.goto!.split(',').map(Number);
      map.flyTo({ center: [lon, lat], zoom: z, duration: 1500 });
    };
  }
  $('#clear').onclick = async () => {
    await backend.json('api/cache/clear', { method: 'POST' });
  };
  const runBench = async () => {
    $('#results').innerHTML = '<p>Running benchmark… (camera tour, ~30 s)</p>';
    await backend.json('api/cache/clear', { method: 'POST' });
    const report = await runBenchmark(map, backend);
    showBench(report);
    await backend.json('api/bench', { method: 'POST', body: JSON.stringify(report), headers: { 'content-type': 'application/json' } });
    document.body.dataset.bench = 'done';
  };
  $('#bench').onclick = runBench;
  const arrowLayer = layers.find((l) => l.geometry === 'point' && l.feature_count >= 100_000);
  const ab = $('#arrow') as HTMLButtonElement;
  if (arrowLayer) {
    ab.textContent = `Arrow → deck.gl (${fmtNum(arrowLayer.feature_count)} pts)`;
    ab.onclick = async () => {
      const r = await loadArrowPoints(arrowLayer.id);
      await backend.json('api/bench', { method: 'POST', body: JSON.stringify({ kind: 'arrow', edition: backend.edition, transport: backend.transport, ...r }) });
      document.body.dataset.arrow = 'done';
    };
  } else ab.disabled = true;

  // ---------------------------------------------------------------- workbench shell
  // Ribbon + dockable panes (see web/src/workbench.ts). Everything below only *renders*
  // what already exists: the same panes, the same engine calls.
  attributesPane = new AttributesPane($('#attributes'), backend, {
    map,
    layers: () => layers,
    log: (line) => workbench?.log(line),
    setStatus: (t) => workbench?.setStatus(t),
  });
  // Plugins (docs/PLUGINS.md): tools from GeoSpaX, RustGIS, GeoLibre, QGIS and ArcGIS Pro.
  pluginsPane = new PluginsPane($('#plugins'), backend, {
    log: (line) => workbench?.log(line),
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
    layers: () => layers.map((l) => ({ id: l.id, name: l.name, fields: l.fields })),
    onChanged: () => document.dispatchEvent(new CustomEvent('geospax:plugins-changed')),
  });
  void pluginsPane.reload();

  workbench = new Workbench({
    backend,
    map,
    edition: `${backend.edition} · ${backend.transport}`,
    layers: () => layers,
    layerById,
    activeId: () => panel.current,
    setActive: (id) => {
      if (id) panel.open(id);
      renderContents();
    },
    fitLayer,
    fitAll,
    autostyle: autostyleLayer,
    reload: reloadLayers,
    save: saveProject,
    runRecipe: (id) => automatePane!.run(id),
    openRun: async (runId) => {
      try {
        const run = await backend.json<{ artifacts?: string[] }>(`api/runs/${runId}`);
        const arts = run.artifacts ?? [];
        const report = arts.find((f) => f.endsWith('report.html')) ?? arts.find((f) => f.endsWith('.html'));
        if (report && automatePane) await automatePane.openArtifact(runId, report);
        else window.open(backend.url(`api/runs/${runId}/files/${report ?? 'report.html'}`), '_blank', 'noopener');
      } catch (e) {
        workbench?.log(`open run failed: ${e}`, 'error');
      }
    },
    bench: () => void runBench(),
    deck: () => ab.click(),
    refreshContents: renderContents,
    plugins: () => pluginsPane,
    layersWithFields: () => layers.map((l) => ({ id: l.id, name: l.name, fields: l.fields })),
    openAttributes: (id) => {
      void attributesPane?.open(id);
      workbench?.showTab('right', 'attributes');
    },
  });
  workbench.mount();
  // open on something useful: the top layer's symbology, ready to edit
  if (project.order.length) {
    panel.open(project.order[project.order.length - 1]);
    renderContents();
  }
  (window as unknown as { workbench: Workbench | null }).workbench = workbench;

  if (params.has('bench')) map.once('idle', () => void runBench());
}

main().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${esc(e)}</pre>`);
  console.error(e);
});
