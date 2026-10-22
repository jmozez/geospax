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
import { Editor } from './editing';
import { Measure } from './measure';
import { onContextMenu, showMenu, type MenuItem } from './contextmenu';
import { BASEMAPS, basemapDef, checkTileUrl, onlineBasemap } from './basemaps';
import { Workbench } from './workbench';
import { ProjectPane } from './projectpane';
import { AskPane } from './ask';
import { openEmbeddings } from './embeddings';
import { PluginsPane } from './plugins';
import { inspectorHtml } from './inspector';
import { Toolbox } from './toolbox';
import { StartScreen } from './start';
import { FinishMap, FINISH_RECIPE } from './finish';
import { OnlineData } from './online';
import { RConsole } from './rconsole';
import { GROUP_TITLE, actionsFor, friendlyName, groupOf, lazyCard, modeSwitch, proGroup, proRow, type Group, type UiMode } from './layercards';
import {
  colorExpression,
  fmtNum,
  legendItems,
  primaryColor,
  symbologyField,
  type Basemap,
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
// the benchmark sample ships the same synthetic data in three formats and a 1M-point layer: start
// with one copy on; every other layer (yours, devices', recipe and plugin results) starts visible
const defaultVisible = (l: LayerInfo) => !/^synthetic[._]/.test(l.id) || l.id === 'synthetic.buildings';
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
/** Editing and selection (web/src/editing.ts) */
let editor: Editor | null = null;
/** View › Projection: 'mercator' or 'globe' (remembered in this browser) */
let mapProjection: 'mercator' | 'globe' = (() => {
  try { return localStorage.getItem('geospax.projection') === 'globe' ? 'globe' : 'mercator'; } catch { return 'mercator'; }
})();
/** Bumped after each edit to a layer, so the map fetches its tiles again */
const tileRev: Record<string, number> = {};
/** Most selected features drawn highlighted per layer (a style filter lists their ids). */
const MAX_HIGHLIGHT = 20000;
let workbench: Workbench | null = null;
let projectPane: ProjectPane | null = null;
let pluginsPane: PluginsPane | null = null;

const layerById = (id: string) => layers.find((l) => l.id === id);

function defaultStyle(l: LayerInfo): LayerStyle {
  return {
    visible: defaultVisible(l),
    opacity: isLand(l.id) ? 1 : l.geometry === 'polygon' ? 0.85 : 1,
    minzoom: 0,
    maxzoom: 24,
    outline: l.geometry === 'polygon',
    // the land layer of the sample data takes the theme's land colour
    symbology: { kind: 'single', color: isLand(l.id) ? css('map-land') || colorFor(l.id) : colorFor(l.id) },
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
  const groups = saved?.groups ?? [];
  const member = Object.fromEntries(Object.entries(saved?.member ?? {}).filter(([id, g]) => known.has(id) && groups.some((x) => x.id === g)));
  // keep everything else the project holds (custom basemap, bookmarks…)
  return { ...(saved ?? {}), version: 1, order, layers: styles, view: saved?.view, basemap: saved?.basemap, groups, member };
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
      projectPane?.touchSaved();
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

const groupOf_ = (id: string) => project.groups?.find((g) => g.id === project.member?.[id]);
/** On the map = its own switch and its group's switch are both on. */
const shownOnMap = (id: string) => !!project.layers[id]?.visible && (groupOf_(id)?.visible ?? true);

// ---------------------------------------------------------------- theme
// Light (default), dark or the system's; the map reads the same CSS tokens as the panes.
type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'geospax.theme';
let theme: Theme = (() => {
  const q = params.get('theme');
  if (q === 'light' || q === 'dark' || q === 'system') return q;
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' || t === 'system' ? t : 'light';
  } catch {
    return 'light';
  }
})();
const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
const effectiveTheme = () => (theme === 'system' ? (systemDark?.matches ? 'dark' : 'light') : theme);
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
function paintTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
  const b = document.querySelector<HTMLElement>('#theme-switch');
  if (b) b.textContent = theme === 'light' ? '☀ Light' : theme === 'dark' ? '☾ Dark' : '◐ System';
}
function setTheme(t: Theme) {
  theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* this session only */
  }
  paintTheme();
  if (map) applyStyle();
  workbench?.setStatus(`Theme: ${t === 'system' ? `follows the system (${effectiveTheme()})` : t}`);
}
paintTheme();
systemDark?.addEventListener?.('change', () => theme === 'system' && setTheme('system'));

function buildStyle(): maplibregl.StyleSpecification {
  const sources: maplibregl.StyleSpecification['sources'] = {};
  const out: maplibregl.LayerSpecification[] = [{ id: 'background', type: 'background', paint: { 'background-color': css('map-bg') || '#0b0b0b' } }];
  addBasemap(sources, out);
  for (const id of project.order) {
    const l = layerById(id);
    if (!l) continue;
    // a switched-off group hides its layers without touching their own switches
    const st = { ...project.layers[id], visible: shownOnMap(id) };
    const [w, s, e, n] = l.bounds;
    const fld = symbologyField(st.symbology);
    const fields = fld && !l.tile_fields.includes(fld) ? [...l.tile_fields, fld] : undefined;
    let url = backend.tileUrl(id, fields);
    // cache-bust the client tile cache when a pyramid is (re)built
    if (l.overview) url += `${url.includes('?') ? '&' : '?'}ov=${l.overview.built_at}`;
    if (tileRev[id]) url += `${url.includes('?') ? '&' : '?'}rev=${tileRev[id]}`;
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
            'line-color': isLand(id) ? css('map-border') : css('map-outline'),
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
          'circle-stroke-color': isDeviceLayer(id) ? '#ffffff' : css('map-outline'),
          'circle-stroke-width': isDeviceLayer(id) ? 1.5 : 0.5,
          'circle-stroke-opacity': st.opacity,
        },
      } as maplibregl.LayerSpecification);
    }
    // the selection, drawn over the layer (ids are feature ids in the tiles)
    const sel = editor?.selected(id) ?? [];
    if (sel.length && st.visible) {
      const filter = ['in', ['id'], ['literal', sel.slice(0, MAX_HIGHLIGHT)]];
      const hi = '#00e5ff';
      if (l.geometry === 'polygon')
        out.push({ ...base, id: `${id}#sel`, type: 'line', filter, minzoom: 0, paint: { 'line-color': hi, 'line-width': 2.5 } } as maplibregl.LayerSpecification);
      else if (l.geometry === 'line')
        out.push({ ...base, id: `${id}#sel`, type: 'line', filter, minzoom: 0, paint: { 'line-color': hi, 'line-width': 4, 'line-opacity': 0.9 } } as maplibregl.LayerSpecification);
      else
        out.push({ ...base, id: `${id}#sel`, type: 'circle', filter, minzoom: 0, paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 7, 'circle-stroke-color': hi, 'circle-stroke-width': 2.5 } } as maplibregl.LayerSpecification);
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
  // rasters sit above the basemap and land polygons and below every other vector layer
  if (rasterPane) {
    const r = rasterPane.styleParts();
    Object.assign(sources, r.sources);
    let at = 1;
    const under = (src: string) => isLand(src) || src.startsWith('basemap:');
    while (at < out.length && 'source' in out[at] && under((out[at] as { source: string }).source)) at++;
    out.splice(at, 0, ...r.layers);
  }
  // keep terra-draw's drawing layers (td-*) across restyles, on top (web/src/editing.ts)
  try {
    const cur = map?.getStyle?.();
    for (const [k, v] of Object.entries(cur?.sources ?? {})) if (k.startsWith('td-')) sources[k] = v;
    for (const l of cur?.layers ?? []) if (l.id.startsWith('td-')) out.push(l);
  } catch { /* first style: the map is not ready yet */ }
  // View › Projection (MapLibre's own projections: Web Mercator or a globe)
  return { version: 8, sources, layers: out, projection: { type: mapProjection } };
}

// ---------------------------------------------------------------- basemap
// A map should never open on an empty void. 'offline' is Natural Earth 1:50m (public domain) shipped
// with the app, so it works with no network; 'osm' is OpenStreetMap's raster tiles (needs internet).
const basemapUrl = (f: string) => new URL(`basemap/${f}.geojson`, location.href).href;
const basemap = (): Basemap => (params.get('basemap') as Basemap | null) ?? project.basemap ?? 'offline';

function addBasemap(sources: maplibregl.StyleSpecification['sources'], out: maplibregl.LayerSpecification[]) {
  const b = basemap();
  const online = b !== 'offline' && b !== 'none' ? onlineBasemap(b, project.customBasemap) : null;
  if (online) {
    sources['basemap:tiles'] = online.source;
    out.push(online.layer);
  } else if (b === 'offline') {
    for (const f of ['land', 'lakes', 'boundaries']) sources[`basemap:${f}`] = { type: 'geojson', data: basemapUrl(f), tolerance: 0.6 };
    out.push(
      { id: 'basemap:land', type: 'fill', source: 'basemap:land', paint: { 'fill-color': css('map-land') } } as maplibregl.LayerSpecification,
      { id: 'basemap:lakes', type: 'fill', source: 'basemap:lakes', paint: { 'fill-color': css('map-bg') } } as maplibregl.LayerSpecification,
      {
        id: 'basemap:boundaries', type: 'line', source: 'basemap:boundaries',
        paint: { 'line-color': css('map-border'), 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1], 'line-dasharray': [3, 2] },
      } as maplibregl.LayerSpecification,
    );
  }
}

/** View › Basemap gallery: every basemap with its terms, and your own XYZ tiles. */
async function basemapGallery() {
  const { dialog, say } = await import('./editing');
  const cur = basemap();
  const e = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const groups = [...new Set(BASEMAPS.map((d) => d.group))];
  const c = project.customBasemap;
  await dialog(
    'Basemap gallery',
    groups
      .map((g) => `<div class="bm-group">${e(g)}</div>` + BASEMAPS.filter((d) => d.group === g)
        .map((d) => `<label class="sample"><input type="radio" name="bm" value="${d.id}"${d.id === cur ? ' checked' : ''}><span><b>${e(d.title)}</b><br><span class="dim">${e(d.terms)}</span></span></label>`)
        .join(''))
      .join('') +
      `<div class="form-grid bm-custom"><label>XYZ URL (for "Your own tiles")<input name="url" value="${e(c?.url ?? '')}" placeholder="https://example.org/tiles/{z}/{x}/{y}.png"></label>
       <label>Credit line<input name="attribution" value="${e(c?.attribution ?? '')}" placeholder="© the data provider"></label></div>
       <div class="dlg-msg" data-msg></div>`,
    [['ok', 'Use basemap'], ['', 'Cancel']],
    {
      wide: true,
      onButton: (b, v, root) => {
        if (b !== 'ok') return true;
        if (v.bm === 'custom') {
          const bad = checkTileUrl(v.url);
          if (bad) { say(root, bad, 'err'); return false; }
          if (!v.attribution.trim()) { say(root, 'Add the credit line the tile provider asks for.', 'err'); return false; }
          project.customBasemap = { url: v.url.trim(), attribution: v.attribution.trim() };
        }
        setBasemap(v.bm);
        return true;
      },
    },
  );
}

function setBasemap(b: Basemap) {
  project.basemap = b;
  applyStyle();
  renderContents();
  saveProject();
  const d = basemapDef(b);
  workbench?.setStatus(d ? `Basemap: ${d.title}${b === 'offline' || b === 'none' ? '' : ` · ${d.terms}`}` : 'Basemap off', 7000);
}

function applyStyle() {
  map.setStyle(buildStyle()); // MapLibre diffs the style: only changed layers/sources update
}

/** Help › Diagnostics: the developer controls live folded away at the foot of the Project pane. */
function openDiagnostics() {
  workbench?.showTab('left', 'project');
  const d = document.querySelector<HTMLDetailsElement>('#diagnostics');
  if (d) { d.open = true; d.scrollIntoView({ block: 'nearest' }); }
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
async function autostyleLayer(id: string, opts: { keepVisibility?: boolean; quiet?: boolean } = {}) {
  const r = await backend.json<{ style: Partial<LayerStyle>; why?: string }>(`api/layers/${encodeURIComponent(id)}/autostyle`).catch(() => null);
  if (!r?.style || !layerById(id)) return;
  const prev = project.layers[id];
  project.layers[id] = { ...prev, ...(r.style as LayerStyle), visible: opts.keepVisibility ? prev.visible : true, auto: r.why || 'chosen by AutoMap' };
  if (opts.quiet) return;
  applyStyle();
  renderContents();
  if (panel?.current === id) panel.refresh();
  saveProject();
}

/** The lazy-mapper automation (auto styles, auto overviews) is on unless ?<name>=0. Benchmarks and the
 *  UI tests (?bench, ?fresh) drive every step themselves, so it is off there unless ?<name>=1. */
const lazyOn = (name: string) => params.has(name) ? params.get(name) !== '0' : !params.has('bench') && !params.has('fresh');

/** Layers seen for the first time get AutoMap's style instead of a grey default (opt out: ?auto=0). */
async function autostyleNew(ids: string[]) {
  if (!ids.length || !lazyOn('auto')) return;
  workbench?.setStatus(`Styling ${ids.length} new layer${ids.length > 1 ? 's' : ''} automatically…`);
  for (const id of ids) await autostyleLayer(id, { keepVisibility: true, quiet: true });
  applyStyle();
  renderContents();
  panel?.refresh();
  saveProject();
  workbench?.setStatus(`Styled ${ids.length} layer${ids.length > 1 ? 's' : ''} automatically · the ⚙ panel says why`, 6000);
}

// ---------------------------------------------------------------- Contents
// Lazy mode: layer cards; Pro mode: a dense layer tree (web/src/layercards.ts). Remembered per browser;
// the UI tests (?fresh, ?bench) get the Pro tree unless ?mode= says otherwise.
const MODE_KEY = 'geospax.mode';
let uiMode: UiMode = (() => {
  const q = params.get('mode');
  if (q === 'lazy' || q === 'pro') return q;
  if (params.has('fresh') || params.has('bench')) return 'pro';
  try {
    return localStorage.getItem(MODE_KEY) === 'pro' ? 'pro' : 'lazy';
  } catch {
    return 'lazy';
  }
})();
let layerFilter = '';
/** Pro tree: layers whose legend is folded away (remembered per browser) */
const closedLegends = new Set<string>((() => {
  try {
    return JSON.parse(localStorage.getItem('geospax.tree.closed') ?? '[]') as string[];
  } catch {
    return [];
  }
})());
const saveClosed = () => {
  try {
    localStorage.setItem('geospax.tree.closed', JSON.stringify([...closedLegends]));
  } catch {
    /* session only */
  }
};

// ---------------------------------------------------------------- Pro tree keyboard focus
let treeFocus = '';
const treeKey = (x: HTMLElement) => (x.dataset.id ? `l:${x.dataset.id}` : x.dataset.group ? `g:${x.dataset.group}` : x.classList.contains('pr-map') ? 'map' : 'base');
const treeItems = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.pr-tree [role=treeitem]')];
/** One tab stop for the whole tree (roving tabindex); a re-render keeps keyboard focus where it was. */
function restoreTreeFocus(root: HTMLElement, refocus: boolean) {
  const items = treeItems(root);
  if (!items.length) return;
  const cur = items.find((x) => treeKey(x) === treeFocus) ?? items.find((x) => x.classList.contains('selected')) ?? items[0];
  items.forEach((x) => (x.tabIndex = x === cur ? 0 : -1));
  if (refocus) cur.focus();
}

/** Pro tree actions on group layers. */
function groupAction(act: string, gid: string, el?: HTMLInputElement) {
  const g = project.groups?.find((x) => x.id === gid);
  if (!g) return;
  if (act === 'twisty') g.expanded = !g.expanded;
  else if (act === 'visible') g.visible = !!el?.checked;
  else if (act === 'rename') {
    const name = prompt('Group name', g.name)?.trim();
    if (!name) return;
    g.name = name;
  } else if (act === 'ungroup') {
    project.groups = project.groups!.filter((x) => x.id !== gid);
    for (const [id, m] of Object.entries(project.member ?? {})) if (m === gid) delete project.member![id];
  }
  applyStyle();
  renderContents();
  saveProject();
}

function newGroup() {
  const id = panel.current;
  if (!id) return workbench?.setStatus('Select a layer first, then group it', 4000);
  const name = prompt('Name of the new group', 'New group')?.trim();
  if (!name) return;
  const gid = `g${Date.now().toString(36)}`;
  project.groups = [...(project.groups ?? []), { id: gid, name, visible: true, expanded: true }];
  project.member = { ...(project.member ?? {}), [id]: gid };
  renderContents();
  saveProject();
}
let recipeIds = new Set<string>();

function setMode(m: UiMode) {
  uiMode = m;
  document.body.dataset.mode = m;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* private window: the choice lasts this session */
  }
  renderContents();
  renderModeSwitch();
  document.dispatchEvent(new CustomEvent('geospax:mode', { detail: m }));
  workbench?.setStatus(m === 'lazy' ? 'Lazy mode: plain tasks and layers that explain themselves' : 'Pro mode: the full ribbon and every setting');
}

/** One switch in the title bar drives the ribbon and the layer list together. */
function renderModeSwitch() {
  const el = document.querySelector<HTMLElement>('#mode-switch');
  if (el) el.innerHTML = modeSwitch(uiMode);
}

function renderContents() {
  const el = $('#contents');
  document.body.dataset.mode = uiMode;
  // ArcGIS convention: top of the list draws on top (= end of the draw order)
  const list = [...project.order].reverse().filter((id) => layerById(id));
  const row = (id: string, i: number, depth = 0) => {
    const l = layerById(id)!;
    const st = project.layers[id];
    const state = {
      layer: l,
      style: st,
      job: jobs.get(id) ?? l.overview_job ?? undefined,
      selected: panel?.current === id,
      first: i === 0,
      last: i === list.length - 1,
      actions: actionsFor(l, st.symbology, recipeIds),
      autoOverviews: autoOverviewsOn(),
      all: layers,
      depth,
      expanded: !closedLegends.has(id),
    };
    return uiMode === 'lazy' ? lazyCard(state) : proRow(state);
  };
  let body = '';
  if (uiMode === 'lazy') {
    // cards grouped by where the data came from; the draw order is kept inside each group
    const groups = new Map<Group, string[]>();
    list.forEach((id, i) => {
      const g = groupOf(layerById(id)!, isDeviceLayer);
      groups.set(g, [...(groups.get(g) ?? []), row(id, i)]);
    });
    for (const g of ['devices', 'data', 'results', 'reference'] as Group[]) {
      const rows = groups.get(g);
      if (rows) body += `<div class="lc-group"><span>${GROUP_TITLE[g]}</span><span>${rows.length}</span></div>${rows.join('')}`;
    }
    const b = basemap();
    body += `<div class="lc-group"><span>Background</span></div>
      <div class="card basemap" style="--c:#4f7468"><div class="lc-top"><span class="lc-glyph">🌍</span>
      <span class="lc-title"><b>${basemapDef(b)?.title ?? 'World map'}</b>
      <small>${b === 'offline' ? 'offline · Natural Earth' : b === 'none' ? 'plain colour' : 'online'}</small></span>
      <button data-basemap="gallery" class="lc-switch">Change</button></div></div>`;
  } else {
    // ArcGIS Pro's Contents: Map ▸ group layers ▸ layers ▸ legend classes, then the basemap
    const f = layerFilter.toLowerCase();
    const total = list.reduce((a, id) => a + (layerById(id)?.feature_count ?? 0), 0);
    body = `<div class="pr-tool"><input type="search" class="pr-filter" placeholder="Filter layers…" value="${layerFilter.replace(/"/g, '&quot;')}" aria-label="Filter layers" />
      <button data-tree="group" title="Put the selected layer in a new group">＋ Group</button>
      <button data-tree="expand" title="Expand all">▾</button><button data-tree="collapse" title="Collapse all">▸</button></div>
      <div class="pr-tree" role="tree" aria-label="Layers">
      <div class="pr-map" role="treeitem" aria-level="1" aria-expanded="true"><span>▾</span> <b>Map</b><small>${list.length} layers · ${total.toLocaleString('en-US')} features</small></div>`;
    if (f) {
      body += list.map((id, i) => (id.toLowerCase().includes(f) ? row(id, i) : '')).join('');
    } else {
      const done = new Set<string>();
      list.forEach((id, i) => {
        const g = groupOf_(id);
        if (!g) return void (body += row(id, i));
        if (done.has(g.id)) return;
        done.add(g.id);
        const members = list.filter((x) => project.member?.[x] === g.id);
        body += proGroup(g, members.length);
        if (g.expanded) body += `<div class="pr-kids${g.visible ? '' : ' off'}">${members.map((m) => row(m, list.indexOf(m), 1)).join('')}</div>`;
      });
    }
    const b = basemap();
    body += `<div class="pr-base" role="treeitem" aria-level="2"><span class="pr-gico">🌍</span><b>Basemap</b>
      <select data-tree="basemap" aria-label="Basemap">${BASEMAPS.map((d) => `<option value="${d.id}" ${b === d.id ? 'selected' : ''}>${d.title}</option>`).join('')}</select>
      <button data-basemap="gallery" title="Basemap gallery">⋯</button></div></div>`;
  }
  // keep the filter box focused while typing
  const focused = document.activeElement?.classList.contains('pr-filter');
  const treeHadFocus = !!document.activeElement?.closest('.pr-tree');
  el.innerHTML = body;
  restoreTreeFocus(el, treeHadFocus);
  renderInspector();
  if (focused) {
    const fi = el.querySelector<HTMLInputElement>('.pr-filter');
    fi?.focus();
    fi?.setSelectionRange(fi.value.length, fi.value.length);
  }
}

/** Lazy mode's right pane: the selected layer as a story (web/src/inspector.ts). */
function renderInspector() {
  const el = document.querySelector<HTMLElement>('#inspector');
  if (!el) return;
  const id = panel?.current;
  const l = id ? layerById(id) : undefined;
  el.innerHTML = inspectorHtml(
    l && id
      ? { layer: l, style: project.layers[id], all: layers, next: actionsFor(l, project.layers[id].symbology, recipeIds).map(([, label]) => ({ label })) }
      : null,
  );
}

function wireInspector() {
  const el = $('#inspector');
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ins]');
    const id = panel.current;
    if (!b || !id) return;
    const l = layerById(id)!;
    switch (b.dataset.ins) {
      case 'auto':
        return void autostyleLayer(id, { keepVisibility: true });
      case 'colour':
        workbench?.setStatus(b.dataset.field ? `Colouring by ${b.dataset.field}…` : 'One colour');
        return void panel.colourBy(id, b.dataset.field || null);
      case 'next': {
        const a = actionsFor(l, project.layers[id].symbology, recipeIds)[Number(b.dataset.i)];
        if (a) void automatePane?.run(a[0], { layer: id });
        return;
      }
      case 'zoom':
        return fitLayer(id);
      case 'table':
        void attributesPane?.open(id);
        return workbench?.showTab('right', 'attributes');
    }
  });
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const id = panel.current;
    if (id && t.dataset.ins === 'opacity') setLayerStyle(id, { ...project.layers[id], opacity: Number(t.value) / 100 });
  });
}

function setLayerStyle(id: string, st: LayerStyle) {
  const prev = project.layers[id];
  if (prev && JSON.stringify(prev.symbology) !== JSON.stringify(st.symbology)) delete st.auto;
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
    const gid = t.closest<HTMLElement>('.pr-group')?.dataset.group;
    if (gid && t.dataset.gact === 'visible') return groupAction('visible', gid, t);
    if (t.dataset.tree === 'basemap') return t.value === 'custom' ? void basemapGallery() : setBasemap(t.value as Basemap);
    const id = t.closest<HTMLElement>('.layer')?.dataset.id;
    if (!id) return;
    if (t.type === 'checkbox') {
      setLayerStyle(id, { ...project.layers[id], visible: t.checked });
      if (t.checked) void queueAutoOverviews();
    }
    else if (t.dataset.act === 'opacity') setLayerStyle(id, { ...project.layers[id], opacity: Number(t.value) / 100 });
  });
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('pr-filter')) {
      layerFilter = t.value;
      renderContents();
    }
  });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const bm = t.closest<HTMLElement>('[data-basemap]')?.dataset.basemap;
    if (bm) return bm === 'gallery' ? void basemapGallery() : setBasemap(bm as Basemap);
    const tree = t.closest<HTMLElement>('button[data-tree]')?.dataset.tree;
    if (tree === 'group') return newGroup();
    if (tree === 'expand' || tree === 'collapse') {
      for (const g of project.groups ?? []) g.expanded = tree === 'expand';
      if (tree === 'expand') closedLegends.clear();
      else for (const id of project.order) closedLegends.add(id);
      saveClosed();
      renderContents();
      return saveProject();
    }
    const gEl = t.closest<HTMLElement>('.pr-group');
    if (gEl) {
      const ga = t.closest<HTMLElement>('button[data-gact]')?.dataset.gact;
      if (ga) groupAction(ga, gEl.dataset.group!);
      return;
    }
    const id = t.closest<HTMLElement>('.layer')?.dataset.id;
    if (!id) return;
    const actEl = t.closest<HTMLElement>('[data-act]');
    const act = actEl?.dataset.act;
    if (act === 'twisty') {
      if (!closedLegends.delete(id)) closedLegends.add(id);
      saveClosed();
      return renderContents();
    }
    if (act === 'up' || act === 'down') moveLayer(id, act);
    else if (act === 'zoom') fitLayer(id);
    else if (act === 'recipe' && actEl?.dataset.recipe) void automatePane?.run(actEl.dataset.recipe, { layer: id });
    else if (act === 'props' || t.classList.contains('name') || t.closest('.name')) {
      panel.open(id);
      // Lazy: the layer's story; Pro: its full symbology
      workbench?.showTab('right', uiMode === 'lazy' ? 'inspector' : 'symbology');
      renderContents();
      document.dispatchEvent(new CustomEvent('geospax:active', { detail: id }));
    } else if (!t.closest('button, input, label')) {
      // a click anywhere else on a card selects the layer: the ribbon offers its next steps
      panel.open(id);
      if (uiMode === 'lazy') workbench?.showTab('right', 'inspector');
      renderContents();
      document.dispatchEvent(new CustomEvent('geospax:active', { detail: id }));
    }
  });
  // Pro tree keyboard (WAI-ARIA tree pattern): ↑/↓ move, →/← expand/collapse (or go to the parent),
  // Home/End, Space shows/hides, Enter opens symbology, Alt+↑/↓ moves the layer in the draw order
  el.addEventListener('keydown', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.pr-tree [role=treeitem]');
    if (!item || e.target !== item) return;
    const items = treeItems(el);
    const i = items.indexOf(item);
    const id = item.dataset.id;
    const gid = item.dataset.group;
    const go = (to: HTMLElement | undefined) => {
      if (!to) return;
      treeFocus = treeKey(to);
      items.forEach((x) => (x.tabIndex = x === to ? 0 : -1));
      to.focus();
    };
    const open = item.getAttribute('aria-expanded') === 'true';
    let done = true;
    if (e.altKey && id && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) moveLayer(id, e.key === 'ArrowUp' ? 'up' : 'down');
    else if (e.key === 'ArrowDown') go(items[i + 1]);
    else if (e.key === 'ArrowUp') go(items[i - 1]);
    else if (e.key === 'Home') go(items[0]);
    else if (e.key === 'End') go(items[items.length - 1]);
    else if (e.key === 'ArrowRight') {
      if (gid && !open) groupAction('twisty', gid);
      else if (id && !open && closedLegends.delete(id)) (saveClosed(), renderContents());
      else go(items[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      if (gid && open) groupAction('twisty', gid);
      else if (id && open && item.querySelector('.legend')) (closedLegends.add(id), saveClosed(), renderContents());
      else if (id && project.member?.[id]) go(items.find((x) => x.dataset.group === project.member![id]));
      else go(items[0]);
    } else if (e.key === ' ') item.querySelector<HTMLInputElement>('input[type=checkbox]')?.click();
    else if (e.key === 'Enter' && id) item.querySelector<HTMLElement>('.name')?.click();
    else if (e.key === 'F2' && gid) groupAction('rename', gid);
    else done = false;
    if (done) e.preventDefault();
  });
  el.addEventListener('focusin', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.pr-tree [role=treeitem]');
    if (item) treeFocus = treeKey(item);
  });
  el.addEventListener('dblclick', (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>('.pr-gname')?.closest<HTMLElement>('.pr-group');
    if (g) groupAction('rename', g.dataset.group!);
  });
  // Pro tree: drag a row onto another to put it there (Pro's Contents drag-and-drop); onto a group
  // to put it in the group
  let dragId: string | null = null;
  el.addEventListener('dragstart', (e) => {
    dragId = (e.target as HTMLElement).closest<HTMLElement>('.layer.pro')?.dataset.id ?? null;
    if (dragId) e.dataTransfer?.setData('text/plain', dragId);
  });
  const clearDrop = () => el.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
  el.addEventListener('dragover', (e) => {
    const over = (e.target as HTMLElement).closest('.layer.pro, .pr-group, .pr-map');
    if (!dragId || !over) return;
    e.preventDefault();
    clearDrop();
    over.classList.add('drop');
  });
  el.addEventListener('dragend', clearDrop);
  el.addEventListener('drop', (e) => {
    const target = e.target as HTMLElement;
    e.preventDefault();
    const gid = target.closest<HTMLElement>('.pr-group')?.dataset.group;
    if (dragId && (gid || target.closest('.pr-map'))) {
      // onto a group: join it; onto the Map node: leave any group
      project.member = { ...(project.member ?? {}) };
      if (gid) project.member[dragId] = gid;
      else delete project.member[dragId];
      dragId = null;
      applyStyle();
      renderContents();
      return saveProject();
    }
    const to = target.closest<HTMLElement>('.layer.pro')?.dataset.id;
    if (!dragId || !to || to === dragId) return;
    // dropped on a layer: take its place and its group
    project.member = { ...(project.member ?? {}) };
    if (project.member[to]) project.member[dragId] = project.member[to];
    else delete project.member[dragId];
    const o = project.order.filter((x) => x !== dragId);
    // dropped on a row = takes that row's place in the list (list is top-first, order is bottom-first)
    const at = o.indexOf(to);
    o.splice(project.order.indexOf(dragId) > project.order.indexOf(to) ? at : at + 1, 0, dragId);
    project.order = o;
    dragId = null;
    applyStyle();
    renderContents();
    saveProject();
  });
}

/** Layer › Properties: where it comes from and what it holds. */
async function layerProperties(id: string) {
  const l = layerById(id);
  if (!l) return;
  const { dialog } = await import('./editing');
  const e = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows: [string, string][] = [
    ['Name', l.name], ['Id', l.id], ['Source', l.source], ['Format', l.driver], ['Geometry', l.geometry],
    ['Features', l.feature_count.toLocaleString() + (l.filter ? ` (definition query: ${l.filter})` : '')],
    ['Coordinate system', l.crs], ['Extent (WGS 84)', l.bounds.map((v) => v.toFixed(5)).join(', ')],
    ['Edits', l.edited ? 'saved to a GeoPackage copy; the original file is unchanged' : 'none'],
    ['Fields', l.fields.map((f) => `${f.name} (${f.kind})`).join(', ') || 'none'],
  ];
  await dialog(`Properties · ${l.name}`, `<table class="props">${rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join('')}</table>`, [['', 'Close']], { wide: true });
}

/** Data › Sample data: pick a set; it is copied into the data folder and mapped. */
async function openSamples() {
  const { dialog, say } = await import('./editing');
  type Set = { id: string; title: string; description: string; credits: string; files: string[] };
  let sets: Set[] = [];
  try {
    sets = (await backend.json<{ samples: Set[] }>('api/samples')).samples;
  } catch { /* shown below */ }
  if (!sets.length) return workbench?.setStatus('This installation has no sample data.', 6000);
  const e = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  await dialog(
    'Sample data',
    sets
      .map((s, i) => `<label class="sample"><input type="radio" name="set" value="${e(s.id)}"${i ? '' : ' checked'}><span><b>${e(s.title)}</b><br>${e(s.description)}<br><span class="dim">${s.files.filter((f) => !f.endsWith('.md')).length} files · ${e(s.credits)}</span></span></label>`)
      .join('') + '<div class="dlg-msg" data-msg></div>',
    [['ok', 'Open'], ['', 'Cancel']],
    {
      wide: true,
      onButton: async (b, v, root) => {
        if (b !== 'ok') return true;
        say(root, 'Copying into your data folder…');
        const r = await backend.json<{ layers: string[]; rasters: string[]; folder: string }>(`api/samples/${encodeURIComponent(v.set)}`, { method: 'POST' });
        await addedToMap(r.layers, r.rasters);
        workbench?.setStatus(`Sample data: ${r.layers.length} layers and ${r.rasters.length} rasters, saved in ${r.folder}`, 8000);
        return true;
      },
    },
  );
}

/** New layers and rasters joined the map (upload, sample data): show them, fit, select the first. */
async function addedToMap(ids: string[], rasterIds: string[]) {
    await reloadLayers();
    let rb: [number, number, number, number][] = [];
    if (rasterIds.length && rasterPane) {
      await rasterPane.reload();
      try {
        const r = await backend.json<{ rasters: { id: string; bounds: [number, number, number, number] }[] }>('api/rasters');
        rb = r.rasters.filter((x) => rasterIds.includes(x.id)).map((x) => x.bounds);
      } catch {
        /* fit to the vector layers only */
      }
      applyStyle();
    }
    for (const id of ids) if (project.layers[id]) project.layers[id].visible = true;
    applyStyle();
    renderContents();
    fitTo(ids, rb);
    void workbench?.refreshCatalog();
    if (ids[0]) {
      panel.open(ids[0]);
      document.dispatchEvent(new CustomEvent('geospax:active', { detail: ids[0] }));
    }
  }

// ---------------------------------------------------------------- overview jobs
async function reloadLayers() {
  const r = await backend.json<{ layers: LayerInfo[] }>('api/layers');
  layers = r.layers;
  // Layers that appeared at runtime (device imports) join the project with default styles, on top.
  const known = new Set(project.order);
  project = mergeProject(project);
  const added = project.order.filter((id) => !known.has(id));
  if (added.length) saveProject();
  void autostyleNew(added);
  applyStyle();
  renderContents();
  panel.refresh();
  document.dispatchEvent(new CustomEvent('geospax:reload-views'));
  void queueAutoOverviews();
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

/** Dense layers get their overview pyramid built in the background, one at a time, without a
 *  click (opt out: ?autooverviews=0). Same job the "Build overviews" button starts. */
const autoOverviewsOn = () => lazyOn('autooverviews');
let autoOverviewBusy = false;
async function queueAutoOverviews() {
  if (!autoOverviewsOn() || autoOverviewBusy) return;
  const busy = (j?: Job | null) => j && (j.status === 'queued' || j.status === 'running');
  if (layers.some((l) => busy(jobs.get(l.id) ?? l.overview_job))) return; // pollJob calls back when it ends
  // a job that failed or was cancelled is not retried until the page reloads
  // only layers that are on the map: hidden ones wait until someone shows them
  const next = layers.find((l) => project.layers[l.id]?.visible && !l.overview && l.overview_suggested != null && !['failed', 'cancelled'].includes(jobs.get(l.id)?.status ?? ''));
  if (!next) return;
  autoOverviewBusy = true;
  try {
    await buildOverviews(next.id);
    workbench?.setStatus(`Preparing the zoomed-out view of ${next.id} in the background`, 5000);
  } catch (e) {
    jobs.set(next.id, { ...(jobs.get(next.id) ?? ({} as Job)), status: 'failed' } as Job);
    console.warn('automatic overviews failed', next.id, e);
  } finally {
    autoOverviewBusy = false;
  }
}

/** A run's report (or its first HTML file) in the viewer. */
async function openRunReport(runId: string) {
  try {
    const run = await backend.json<{ artifacts?: string[] }>(`api/runs/${runId}`);
    const arts = run.artifacts ?? [];
    const report = arts.find((f) => f.endsWith('report.html')) ?? arts.find((f) => f.endsWith('.html'));
    if (report && automatePane) await automatePane.openArtifact(runId, report);
    else window.open(backend.url(`api/runs/${runId}/files/${report ?? 'report.html'}`), '_blank', 'noopener');
  } catch (e) {
    workbench?.log(`open run failed: ${e}`, 'error');
  }
}

/** Fit the map to a set of layers and rasters (what an upload brought in). */
function fitTo(ids: string[], rasterBounds: [number, number, number, number][] = []) {
  const bs = [...ids.map((id) => layerById(id)?.bounds).filter(Boolean), ...rasterBounds] as [number, number, number, number][];
  const ok = bs.filter((b) => b.every(Number.isFinite));
  if (!ok.length) return;
  const w = Math.min(...ok.map((b) => b[0])), s = Math.min(...ok.map((b) => b[1]));
  const e = Math.max(...ok.map((b) => b[2])), n = Math.max(...ok.map((b) => b[3]));
  map.fitBounds([[Math.max(w, -180), Math.max(s, -85)], [Math.min(e, 180), Math.min(n, 85)]], { padding: 60, maxZoom: 16, duration: 500 });
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
  const savedProject = params.has('fresh') || params.has('bench') ? null : saved;
  project = mergeProject(savedProject);
  const firstSeen = layers.map((l) => l.id).filter((id) => !savedProject?.layers?.[id]);
  $('#edition').textContent = backend.edition === 'web' ? 'Web edition · Axum' : 'Desktop edition · Tauri';

  const hasHashView = /[#&]view=/.test(location.hash);
  const pv = (params.get('view') ?? '').split('/').map(Number);
  const urlView = pv.length === 3 && pv.every(Number.isFinite) ? { zoom: pv[0], center: [pv[2], pv[1]] as [number, number] } : null;
  // no saved view: open on the data itself (fitted once the map exists), not on a fixed place
  const fitOnLoad = !urlView && !hasHashView && !project.view && !params.has('bench');
  const view = urlView ?? (!hasHashView && project.view ? project.view : { center: [144.25, -5.87] as [number, number], zoom: fitOnLoad ? 1 : 12.5 });
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
    autostyle: (id) => autostyleLayer(id, { keepVisibility: true }),
    deleteOverviews: async (id) => {
      await backend.json(`api/layers/${id}/overviews`, { method: 'DELETE' });
      jobs.delete(id);
      await reloadLayers();
    },
  });
  wireContents();
  wireInspector();
  renderContents();
  renderModeSwitch();
  document.querySelector('#mode-switch')?.addEventListener('click', (e) => {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as UiMode | undefined;
    if (m && m !== uiMode) setMode(m);
  });
  backend
    .json<{ recipes: { id: string }[] }>('api/recipes')
    .then((r) => {
      recipeIds = new Set(r.recipes.map((x) => x.id));
      renderContents();
      document.dispatchEvent(new CustomEvent('geospax:active', { detail: panel.current }));
    })
    .catch(() => {});
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
      // Finish my map: show the result as soon as it is ready
      if ((run as unknown as { recipe?: string }).recipe === FINISH_RECIPE) {
        if (run.status === 'done') {
          workbench?.setStatus('Your map is finished: the report has the map, the PDF and the files', 8000);
          void openRunReport(run.id);
        } else workbench?.setStatus(`The map could not be finished: ${(run as unknown as { error?: string }).error ?? run.status}`, 10000);
        return;
      }
      await reloadLayers();
      if (rasterPane && run.rasters?.length) {
        await rasterPane.reload();
        // the main (first) map of the run decides which rasters are shown, like the report
        const steps = (run as unknown as { steps?: { outputs?: { svg?: string; rasters?: string[] } }[] }).steps ?? [];
        const main = steps.find((s) => s.outputs?.svg && Array.isArray(s.outputs?.rasters))?.outputs?.rasters;
        if (run.status === 'done') rasterPane.showRun(run.rasters, main);
      }
      // the run's styles dress the layers it made; a layer someone (or AutoMap) already styled keeps its look
      for (const [id, st] of Object.entries(run.styles ?? {})) {
        const cur = project.layers[id];
        if (!layerById(id)) continue;
        const styled = cur && (cur.symbology.kind !== 'single' || cur.auto);
        project.layers[id] = styled ? { ...cur, visible: true } : { ...cur, ...(st as LayerStyle), visible: true };
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

  // Toolbox (web/src/toolbox.ts): recipes, building blocks and every plugin's tools, searchable
  const toolbox = new Toolbox($('#toolbox'), {
    backend,
    layers: () => layers,
    activeId: () => panel.current,
    runRecipe: (id, inputs) => {
      void automatePane?.run(id, inputs);
      workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
    },
    openPluginTool: (p, t) => pluginsPane?.openTool(p, t),
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  void toolbox.reload();
  document.addEventListener('geospax:plugins-changed', () => void toolbox.reload());
  document.addEventListener('geospax:toolbox-search', (e) => toolbox.find((e as CustomEvent<string>).detail));
  document.addEventListener('geospax:plugin-ran', async (e) => {
    const ids = (e as CustomEvent<string[]>).detail;
    await reloadLayers();
    await rasterPane?.reload();
    applyStyle();
    const first = ids.find((id) => layerById(id));
    // a raster result (index, change, suitability …) is shown and framed; the tool lists its main one first
    const raster = ids.find((id) => !layerById(id));
    if (raster) {
      rasterPane?.showRun([raster]);
      applyStyle();
      try {
        const r = (await backend.json<{ rasters: { id: string; bounds: [number, number, number, number] }[] }>('api/rasters')).rasters.find((x) => x.id === raster);
        if (r && !first) map.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], { padding: 40, duration: 600 });
      } catch {
        /* the raster still shows; only the framing is skipped */
      }
    }
    if (first) fitLayer(first);
    workbench?.setStatus(`Added to the map: ${ids.join(', ')}`, 6000);
  });

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
      document.dispatchEvent(new CustomEvent('geospax:active', { detail: id }));
    },
    mode: () => uiMode,
    layerName: (id) => {
      const l = layerById(id);
      return l ? friendlyName(l, layers) : id;
    },
    nextSteps: (id) => {
      const l = layerById(id);
      if (!l) return [];
      return actionsFor(l, project.layers[id].symbology, recipeIds).map(([rid, label]) => ({
        label,
        run: () => void automatePane?.run(rid, { layer: id }),
      }));
    },
    fitLayer,
    fitAll,
    autostyle: autostyleLayer,
    reload: reloadLayers,
    save: saveProject,
    runRecipe: (id) => automatePane!.run(id),
    openRun: openRunReport,
    bench: () => { openDiagnostics(); void runBench(); },
    deck: () => { openDiagnostics(); ab.click(); },
    refreshContents: renderContents,
    plugins: () => pluginsPane,
    layersWithFields: () => layers.map((l) => ({ id: l.id, name: l.name, fields: l.fields })),
    openAttributes: (id) => {
      void attributesPane?.open(id);
      workbench?.showTab('right', 'attributes');
    },
  });
  workbench.mount();
  editor = new Editor({
    map,
    backend,
    layers: () => layers,
    activeId: () => panel.current,
    setActive: (id) => {
      panel.open(id);
      renderContents();
      document.dispatchEvent(new CustomEvent('geospax:active', { detail: id }));
    },
    changed: async (id) => {
      tileRev[id] = (tileRev[id] ?? 0) + 1;
      await reloadLayers();
    },
    selectionChanged: () => applyStyle(),
    openTable: (id) => {
      void attributesPane?.open(id);
      workbench?.showTab('right', 'attributes');
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
    log: (line, level) => workbench?.log(line, level),
  });
  attributesPane?.attachEditor(editor);
  (window as unknown as { editor: Editor }).editor = editor;
  document.addEventListener('geospax:edit', (e) => {
    const ed = editor!;
    const a = (e as CustomEvent<string>).detail;
    const id = panel.current;
    switch (a) {
      case 'point': case 'line': case 'polygon': case 'select': case 'box': case 'vertices':
        return void ed.setTool(ed.tool === a ? 'idle' : a);
      case 'attributes': return void ed.editAttributes();
      case 'delete': return void ed.deleteSelected();
      case 'select-attributes': return void ed.selectByAttributes();
      case 'select-location': return void ed.selectByLocation();
      case 'zoom-selection': return void ed.zoomToSelection();
      case 'clear-selection': return ed.clearSelection(id ?? undefined);
      case 'calculate': return void ed.calculateField();
      case 'add-field': return void ed.addField();
      case 'definition-query': return void ed.definitionQuery();
      case 'table':
        if (!id) return workbench?.setStatus('Pick a layer first.');
        void attributesPane?.open(id);
        return workbench?.showTab('right', 'attributes');
      case 'undo': return void ed.undo();
      case 'redo': return void ed.redo();
      case 'snapping':
        ed.snapping = !ed.snapping;
        document.body.dataset.snapping = ed.snapping ? 'on' : 'off';
        return workbench?.setStatus(`Snapping ${ed.snapping ? 'on' : 'off'}`);
      case 'new-layer': return void ed.newLayer();
      case 'export': return void ed.exportSelection();
      case 'discard': return void ed.discardEdits();
    }
  });
  document.body.dataset.snapping = 'on';
  document.addEventListener('geospax:projection', (e) => {
    mapProjection = (e as CustomEvent<'mercator' | 'globe'>).detail === 'globe' ? 'globe' : 'mercator';
    try { localStorage.setItem('geospax.projection', mapProjection); } catch { /* private mode */ }
    document.body.dataset.projection = mapProjection;
    applyStyle();
    workbench?.setStatus(mapProjection === 'globe' ? 'Globe: zoom out to see the whole Earth' : 'Web Mercator');
  });
  document.body.dataset.projection = mapProjection;
  // ---- phones: the map fills the screen; these open the panes over it (style.css, max-width 900px)
  {
    const bar = document.createElement('div');
    bar.className = 'mobile-bar';
    bar.innerHTML = '<button data-m="left">Layers</button><button data-m="bottom">Tools</button><button data-m="right">Panel</button>';
    $('#center').append(bar);
    const docks: Record<string, HTMLElement | null> = { left: document.querySelector('#dock-left'), right: document.querySelector('#dock-right') };
    const sync = () => {
      bar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        const d = b.dataset.m!;
        b.classList.toggle('on', d === 'bottom' ? $('#center').classList.contains('bottom-open') : !!docks[d]?.classList.contains('mobile-open'));
      });
      map.resize();
    };
    bar.addEventListener('click', (e) => {
      const d = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.m;
      if (!d) return;
      if (d === 'bottom') $('#center').classList.toggle('bottom-open');
      else {
        const open = !docks[d]?.classList.contains('mobile-open');
        Object.values(docks).forEach((x) => x?.classList.remove('mobile-open'));
        if (open) docks[d]?.classList.add('mobile-open');
      }
      sync();
    });
    // a tap on the map closes the side panes
    map.on('click', () => { if (Object.values(docks).some((x) => x?.classList.contains('mobile-open'))) { Object.values(docks).forEach((x) => x?.classList.remove('mobile-open')); sync(); } });
    // opening a pane from the ribbon on a phone slides it in
    document.addEventListener('geospax:show-pane', (e) => {
      if (innerWidth > 900) return;
      const d = (e as CustomEvent<string>).detail;
      if (d === 'bottom') $('#center').classList.add('bottom-open');
      else { Object.values(docks).forEach((x) => x?.classList.remove('mobile-open')); docks[d]?.classList.add('mobile-open'); }
      sync();
    });
  }

  // ---- right-click menus (long press on touch): layers, catalog items, the map (web/src/contextmenu.ts)
  const edit = (a: string): void => void document.dispatchEvent(new CustomEvent('geospax:edit', { detail: a }));
  const layerMenu = (id: string, x: number, y: number) => {
    const l = layerById(id);
    if (!l) return false;
    panel.open(id);
    renderContents();
    document.dispatchEvent(new CustomEvent('geospax:active', { detail: id }));
    const nsel = editor?.selected(id).length ?? 0;
    const items: MenuItem[] = [
      { label: 'Zoom to layer', run: () => fitLayer(id) },
      { label: nsel ? `Zoom to selected (${nsel})` : 'Zoom to selected', disabled: !nsel, run: () => void editor?.zoomToSelection(id) },
      { sep: true },
      { label: 'Attribute table', run: () => edit('table') },
      { label: 'Symbology…', run: () => workbench?.showTab('right', 'symbology') },
      { label: 'Style automatically (AutoMap)', run: () => void autostyleLayer(id, { keepVisibility: true }) },
      { label: 'Ask about this layer…', hint: 'The assistant describes the layer and its fields', run: () => void document.dispatchEvent(new CustomEvent('geospax:ask', { detail: `Describe the layer "${l.name}" (id ${id}): what it holds and what its main fields tell us.` })) },
      { label: project.layers[id]?.visible ? 'Hide' : 'Show', run: () => setLayerStyle(id, { ...project.layers[id], visible: !project.layers[id]?.visible }) },
      { sep: true },
      { label: 'Select by attributes…', run: () => edit('select-attributes') },
      { label: 'Select by location…', run: () => edit('select-location') },
      { label: nsel ? `Clear selection (${nsel})` : 'Clear selection', disabled: !nsel, run: () => editor?.clearSelection(id) },
      { label: l.filter ? 'Definition query (on)…' : 'Definition query…', run: () => edit('definition-query') },
      { sep: true },
      { label: 'Calculate field…', run: () => edit('calculate') },
      { label: 'Add field…', run: () => edit('add-field') },
      { label: 'Export features…', run: () => edit('export') },
      { label: 'Discard edits…', disabled: !l.edited, danger: true, run: () => edit('discard') },
      { sep: true },
      { label: 'Remove from map', danger: true, hint: 'The file is not touched; it opens again at the next start', run: async () => {
        await backend.json(`api/layers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
        editor?.clearSelection(id);
        await reloadLayers();
        workbench?.setStatus(`${l.name} removed from the map (the file is kept)`);
      } },
      { label: 'Properties…', run: () => void layerProperties(id) },
    ];
    showMenu(x, y, l.name, items);
    return true;
  };
  onContextMenu($('#contents'), (t, x, y) => {
    const row = t.closest<HTMLElement>('[data-id]');
    return row?.dataset.id ? layerMenu(row.dataset.id, x, y) : false;
  });
  onContextMenu($('#catalog'), (t, x, y) => {
    const row = t.closest<HTMLElement>('[data-layer]');
    if (row?.dataset.layer) return layerMenu(row.dataset.layer, x, y);
    const file = t.closest<HTMLElement>('[data-file]');
    if (file?.dataset.file) {
      const path = file.dataset.file;
      const on = file.classList.contains('onmap');
      showMenu(x, y, path.split(/[\\/]/).pop() ?? path, [
        { label: on ? 'Already on the map' : 'Add to the map', disabled: on, run: () => void workbench?.addFile(path) },
        { label: 'Copy the file path', run: () => void navigator.clipboard?.writeText(path).then(() => workbench?.setStatus(`Copied ${path}`)) },
        { sep: true },
        { label: 'Refresh', run: () => void workbench?.refreshCatalog() },
      ]);
      return true;
    }
    const folder = t.closest<HTMLElement>('[data-folder]');
    if (folder?.dataset.folder) {
      const path = folder.dataset.folder;
      showMenu(x, y, path.split(/[\\/]/).pop() ?? path, [
        { label: 'Copy the folder path', run: () => void navigator.clipboard?.writeText(path).then(() => workbench?.setStatus(`Copied ${path}`)) },
        { label: 'Add files to it…', hint: 'Files you add are saved in your first data folder', run: () => void document.dispatchEvent(new CustomEvent('geospax:browse')) },
        { label: 'Refresh', run: () => void workbench?.refreshCatalog() },
      ]);
      return true;
    }
    if (t.closest('.node.source')) {
      showMenu(x, y, 'Catalog', [
        { label: 'Add files…', run: () => void document.dispatchEvent(new CustomEvent('geospax:browse')) },
        { label: 'Sample data…', run: () => void openSamples() },
        { label: 'New layer…', run: () => edit('new-layer') },
        { label: 'Refresh', run: () => void reloadLayers() },
      ]);
      return true;
    }
    return false;
  });
  onContextMenu(map.getContainer(), (t, x, y) => {
    if (!t.closest('canvas')) return false;
    const r = map.getCanvas().getBoundingClientRect();
    const ll = map.unproject([x - r.left, y - r.top]);
    const c = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
    const ids = layers.flatMap((l) => [`${l.id}#fill`, `${l.id}#line`, `${l.id}#circle`].filter((x) => map.getLayer(x)));
    const hit = ids.length ? map.queryRenderedFeatures([x - r.left, y - r.top], { layers: ids })[0] : undefined;
    const hitLayer = hit?.layer.id.replace(/#.*$/, '');
    const items: MenuItem[] = [
      { label: `Copy coordinates (${c})`, run: () => void navigator.clipboard?.writeText(c).then(() => workbench?.setStatus(`Copied ${c}`)) },
      { label: 'Centre the map here', run: () => void map.easeTo({ center: ll }) },
      { label: 'Zoom in here', run: () => void map.easeTo({ center: ll, zoom: map.getZoom() + 2 }) },
      { sep: true },
      { label: 'Measure distance', run: () => void document.dispatchEvent(new CustomEvent('geospax:measure', { detail: 'distance' })) },
      { label: 'Measure area', run: () => void document.dispatchEvent(new CustomEvent('geospax:measure', { detail: 'area' })) },
    ];
    if (hit && hitLayer && Number.isFinite(Number(hit.id))) {
      const name = layerById(hitLayer)?.name ?? hitLayer;
      items.push(
        { sep: true },
        { label: `Select this feature (${name})`, run: () => { panel.open(hitLayer); editor?.setSelection(hitLayer, [Number(hit.id)]); } },
        { label: 'Edit its attributes…', run: () => { panel.open(hitLayer); void editor?.editAttributes(hitLayer, Number(hit.id)); } },
        { label: `${name}: layer options…`, run: () => void layerMenu(hitLayer, x, y) },
      );
    }
    showMenu(x, y, c, items);
    return true;
  });

  // Data › Sample data: the sets that ship with GeoSpaX (crates/engine/src/samples.rs)
  document.addEventListener('geospax:samples', () => void openSamples());
  projectPane = new ProjectPane({
    backend,
    project: () => project,
    view: () => ({ center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() }),
    flyTo: (b) => void map.flyTo({ center: b.center, zoom: b.zoom, duration: 1200 }),
    projection: () => mapProjection,
    layerCount: () => layers.length,
    rasterCount: () => rasterPane?.rasters.length ?? 0,
    save: saveProject,
    replace: async (p) => {
      project = mergeProject(p);
      applyStyle();
      renderContents();
      if (p.view) map.jumpTo({ center: p.view.center, zoom: p.view.zoom });
      saveProject();
    },
    importFile: async (f) => {
      const r = await backend.json<{ layers: string[]; rasters: string[] }>(`api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      await addedToMap(r.layers, r.rasters);
      workbench?.setStatus(`Imported ${r.layers.length} layers from ${f.name}`, 8000);
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  }, $('#project-pane'));
  projectPane.render();
  map.on('moveend', () => { if (document.querySelector('#dock-left section[data-tab="project"].on')) projectPane?.render(); });
  const askPane = new AskPane({
    backend,
    select: (layer, fids) => { panel.open(layer); editor?.setSelection(layer, fids); fitLayer(layer); },
    zoom: (layer) => fitLayer(layer),
    showRun: () => workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'history'),
    layerName: (id) => layerById(id)?.name ?? id,
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  }, $('#ask'));
  document.addEventListener('geospax:ask-settings', () => void askPane.openSettings());
  document.addEventListener('geospax:ask', (e) => {
    workbench?.showTab('right', 'ask');
    void askPane.ask((e as CustomEvent<string>).detail);
  });
  document.addEventListener('geospax:bookmark', () => void projectPane?.addBookmark());
  document.addEventListener('geospax:added', (e) => {
    const r = (e as CustomEvent<{ layers: string[]; rasters: string[] }>).detail;
    void addedToMap(r.layers, r.rasters);
  });
  // Map › Measure: distance and area (web/src/measure.ts)
  const measure = new Measure(map);
  document.addEventListener('geospax:measure', (e) => {
    const m = (e as CustomEvent<string>).detail;
    if (m === 'clear') return measure.stop();
    void editor?.setTool('idle'); // one map tool at a time
    measure.start(m as 'distance' | 'area');
  });
  // open on something useful: the top layer's symbology, ready to edit
  if (project.order.length) {
    panel.open(project.order[project.order.length - 1]);
    renderContents();
  }
  (window as unknown as { workbench: Workbench | null }).workbench = workbench;
  if (fitOnLoad) fitAll();

  // Stage 2 of the lazy path: a start screen with a drop zone, drag-and-drop anywhere, and
  // "Finish my map" (web/src/start.ts, web/src/finish.ts)
  const start = new StartScreen({
    backend,
    added: addedToMap,
    devices: () => workbench?.showTab('right', 'devices'),
    toolbox: () => workbench?.showTab('right', 'toolbox'),
    openRun: openRunReport,
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  const finish = new FinishMap({
    backend,
    mode: () => uiMode,
    visible: () => project.order.filter((id) => layerById(id) && shownOnMap(id)).map((id) => ({ id, style: project.layers[id] })),
    suggestTitle: () => {
      const top = [...project.order].reverse().find((id) => layerById(id) && shownOnMap(id));
      return top ? friendlyName(layerById(top)!, layers) : 'My map';
    },
    view: () => map.getBounds().toArray().flat() as [number, number, number, number],
    geometry: (id) => layerById(id)?.geometry ?? '',
    run: async (id) => {
      workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
      await automatePane?.run(id);
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  // Data › Online data: climate, soil, species, boundaries and elevation for the area (online.ts)
  new OnlineData({
    backend,
    view: () => map.getBounds().toArray().flat() as [number, number, number, number],
    layers: () => project.order.filter((id) => layerById(id)).reverse(),
    run: async (id) => {
      workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
      await automatePane?.run(id);
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  // Imagery › Satellite embeddings (embeddings.ts)
  document.addEventListener('geospax:embeddings', (e) => void openEmbeddings({
    backend,
    view: () => map.getBounds().toArray().flat() as [number, number, number, number],
    layers: () => project.order.map((id) => layerById(id)).filter((l): l is LayerInfo => !!l).reverse()
      .map((l) => ({ id: l.id, name: l.name, geometry: l.geometry, fields: l.fields ?? [] })),
    run: async (id) => {
      workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
      await automatePane?.run(id);
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  }, (e as CustomEvent<string>).detail));
  // Plugins › Manage plugins: the plugins pane in a dialog
  const pm = $('#plugin-manager');
  document.addEventListener('geospax:plugin-manager', () => { pm.hidden = false; });
  pm.addEventListener('click', (e) => { const t = e.target as HTMLElement; if (t === pm || t.closest('[data-close]')) pm.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pm.hidden && document.querySelector('#plugin-modal[hidden]')) pm.hidden = true; }, true);
  // R tab: R setup and the R console (rconsole.ts)
  new RConsole({
    backend,
    layers: () => project.order.filter((id) => layerById(id)).reverse(),
    rasters: async () => (await backend.json<{ rasters: { id: string }[] }>('api/rasters')).rasters.map((r) => r.id),
    run: async (id) => {
      workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
      await automatePane?.run(id);
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  document.addEventListener('geospax:start', () => void start.show());
  document.addEventListener('geospax:browse', () => start.browse());
  document.addEventListener('geospax:finish', () => finish.open());
  document.querySelector('#theme-switch')?.addEventListener('click', () => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'));
  document.addEventListener('geospax:theme', (e) => setTheme((e as CustomEvent<Theme>).detail));
  // a lazy mapper with nothing of their own on the map yet starts on the start screen
  const own = layers.filter((l) => !/^(natural_earth|synthetic)[._]/.test(l.id));
  if (uiMode === 'lazy' && !own.length && !params.has('fresh') && !params.has('bench')) void start.show();
  (window as unknown as { geospax: object }).geospax = { start, finish };
  // the lazy path: new layers styled by AutoMap, dense ones get overviews, without a click
  void autostyleNew(firstSeen).then(() => queueAutoOverviews());
  document.addEventListener('geospax:basemap', (e) => {
    const b = (e as CustomEvent<Basemap>).detail;
    if (b === 'gallery' || b === 'custom') void basemapGallery();
    else setBasemap(b);
  });

  if (params.has('bench')) map.once('idle', () => void runBench());
}

main().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${esc(e)}</pre>`);
  console.error(e);
});
