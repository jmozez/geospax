import { wireProjects } from './projects';
import { startupCheck } from './updates';
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
import { MapExtras } from './mapextras';
import { ShareExtras, saveBlob } from './shareextras';
import { Tutorials } from './tutorials';
import { Editor } from './editing';
import { Measure } from './measure';
import { toolStateChanged } from './toolstate';
import { onContextMenu, showMenu, type MenuItem } from './contextmenu';
import { BASEMAPS, basemapDef, checkTileUrl, onlineBasemap } from './basemaps';
import { Workbench } from './workbench';
import { ProjectPane } from './projectpane';
import { AskPane } from './ask';
import { openEmbeddings } from './embeddings';
import { openDetect, openModels } from './models';
import { openWorms } from './taxa';
import { PluginsPane } from './plugins';
import { inspectorHtml } from './inspector';
import { Toolbox } from './toolbox';
import { StartScreen } from './start';
import { FinishMap, FINISH_RECIPE } from './finish';
import { OnlineData } from './online';
import { StacSearch } from './stac';
import { CadDesigner } from './cad';
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
import { defaultLabels, GLYPHS, HATCH_PREFIX, hatchImage, ICON_PREFIX, labelLayer, sdfImage, symbolFields, symbolLayers, type Shape } from './symbols';
import { DownloadGauge } from './downloads';
import { ProfilePanel } from './profile';
import { isElevation, mountRasterCharts, rasterAttributesHtml, rasterStoryHtml, valueHtml, type Histogram, type RasterValue } from './rasterview';
import './style.css';

maplibregl.setWorkerUrl(workerUrl);

const backend = createBackend();
// the chart look (ggplot2 theme and palette) chosen in Settings, for the charts drawn in the app
void import("./ggchart").then((m) => m.loadChartStyle(backend));

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
  // anything the Content Security Policy blocks goes to the log (it would otherwise fail silently)
  document.addEventListener('securitypolicyviolation', (e) => send('warn', `CSP blocked ${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
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
// Public guest demo (geospax-server --public): each visitor has a project of their own, and the server
// lists only the layers and rasters this visitor made (guest.rs).
let guestMode = false;
const jobs = new Map<string, Job>(); // layer id -> latest job
let map: maplibregl.Map;
let rasterPane: RasterPane | null = null;
let panel: SymbologyPanel;
let automatePane: AutomatePane | null = null;
let attributesPane: AttributesPane | null = null;
/** Editing and selection (web/src/editing.ts) */
let editor: Editor | null = null;
/** View › Projection: 'globe' (the start, as GeoLibre) or 'mercator' (remembered in this browser) */
let mapProjection: 'mercator' | 'globe' = (() => {
  try { return localStorage.getItem('geospax.projection') === 'mercator' ? 'mercator' : 'globe'; } catch { return 'globe'; }
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
  // rasters are in the same draw order as "r:<id>"; until the raster list has loaded, keep them all
  const rasterIds = rasterPane ? new Set(rasterPane.rasters.map((r) => `r:${r.id}`)) : null;
  const order = (saved?.order ?? []).filter((id) => known.has(id) || (id.startsWith('r:') && (!rasterIds || rasterIds.has(id))));
  for (const id of defaultOrder) if (!order.includes(id)) order.push(id);
  if (rasterPane) {
    // results (recipe or tool outputs, "<recipe>.<name>") go on top like any new layer, hillshades above
    // their colour raster; rasters found in the data folders go just above the land polygons
    const fresh = rasterPane.rasters.filter((r) => !order.includes(`r:${r.id}`));
    const isResult = (id: string) => id.includes('.');
    const top = fresh.filter((r) => isResult(r.id)).sort((a, b) => +(a.kind === 'hillshade') - +(b.kind === 'hillshade'));
    const bottom = fresh.filter((r) => !isResult(r.id));
    const afterLand = order.reduce((at, id, i) => (isLand(id) ? i + 1 : at), 0);
    order.splice(afterLand, 0, ...bottom.map((r) => `r:${r.id}`));
    order.push(...top.map((r) => `r:${r.id}`));
  }
  // layers and rasters the user removed stay off the map
  if (saved?.removed?.length) order.splice(0, order.length, ...order.filter((id) => !saved.removed!.includes(id)));
  const styles: Record<string, LayerStyle> = {};
  for (const l of layers) styles[l.id] = { ...defaultStyle(l), ...(saved?.layers?.[l.id] ?? {}) };
  const groups = saved?.groups ?? [];
  const member = Object.fromEntries(Object.entries(saved?.member ?? {}).filter(([id, g]) => known.has(id) && groups.some((x) => x.id === g)));
  // keep everything else the project holds (custom basemap, bookmarks…)
  return { ...(saved ?? {}), version: 1, order, layers: styles, view: saved?.view, basemap: saved?.basemap, groups, member };
}

let saveTimer: number | undefined;
/** true while New or Open switches projects: nothing may overwrite the one about to load */
let saveHeld = false;
/** Write the open project now (Home › Save, Save as, Rename, before New and Open). */
async function flushProject() {
  clearTimeout(saveTimer);
  if (map) project.view = { center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() };
  await backend.json('api/project', { method: 'PUT', body: JSON.stringify(project), headers: { 'content-type': 'application/json' } });
  document.body.dataset.saved = String(Date.now());
  projectPane?.touchSaved();
}
/** Finish my map, once the UI is up: a live layout window follows every change saved here */
let finishMap: FinishMap | null = null;
function saveProject() {
  finishMap?.mapChanged();
  clearTimeout(saveTimer);
  if (saveHeld) return;
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
    // dark is the default; a theme the user picked is kept
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch {
    return 'dark';
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

let footprint: GeoJSON.Feature | null = null;
let stacFootprints: GeoJSON.FeatureCollection | null = null;

/** 3D terrain from an elevation raster (View › 3D terrain, or 3D view on the raster), or null for the flat map */
let terrain3d: { id: string; exaggeration: number } | null = null;

function buildStyle(): maplibregl.StyleSpecification {
  const sources: maplibregl.StyleSpecification['sources'] = {};
  const out: maplibregl.LayerSpecification[] = [{ id: 'background', type: 'background', paint: { 'background-color': css('map-bg') || '#0b0b0b' } }];
  const labelLayers: maplibregl.LayerSpecification[] = [];
  addBasemap(sources, out);
  // web map images (WMS, WMTS, XYZ, ArcGIS MapServer) over the basemap, through the engine's relay
  for (const w of project.web ?? []) {
    if (!w.visible) continue;
    const sid = `web:${w.id}`;
    sources[sid] = { type: 'raster', tileSize: 256, tiles: [backend.url(`api/services/${encodeURIComponent(w.sid)}/tile/{z}/{x}/{y}.png?layer=${encodeURIComponent(w.layer)}`)] };
    out.push({ id: sid, type: 'raster', source: sid, paint: { 'raster-opacity': w.opacity, 'raster-fade-duration': 0 } } as maplibregl.LayerSpecification);
  }
  for (const id of project.order) {
    if (id.startsWith('r:')) {
      if (groupOf_(id) && !groupOf_(id)!.visible) continue;
      const p = rasterPane?.partsFor(id.slice(2));
      if (p) {
        sources[p.sid] = p.source;
        out.push(p.layer);
      }
      continue;
    }
    const l = layerById(id);
    if (!l) continue;
    // a switched-off group hides its layers without touching their own switches
    const st = { ...project.layers[id], visible: shownOnMap(id) };
    const [w, s, e, n] = l.bounds;
    // the attributes the colours, sizes and labels need, beyond the layer's tile fields
    const need = [symbologyField(st.symbology), ...symbolFields(st)].filter((f): f is string => !!f && !l.tile_fields.includes(f));
    const fields = need.length ? [...l.tile_fields, ...new Set(need)] : undefined;
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
    // points, lines and polygons as their symbols say (symbols.ts); labels go on top of everything
    out.push(...symbolLayers({ id, geometry: l.geometry, st, color, base, outlineColor: isLand(id) ? css('map-border') : css('map-outline'), device: isDeviceLayer(id), land: isLand(id) }));
    const lab = labelLayer(id, l.geometry, st, base);
    if (lab) labelLayers.push(lab);
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
  // the file selected in the Explorer: its outline
  if (stacFootprints) {
    sources['stac-footprints'] = { type: 'geojson', data: stacFootprints };
    out.push({ id: 'stac-footprints-fill', type: 'fill', source: 'stac-footprints', paint: { 'fill-color': '#4cc2ff', 'fill-opacity': ['case', ['==', ['get', 'hl'], 1], 0.18, 0.03] } } as maplibregl.LayerSpecification,
      { id: 'stac-footprints', type: 'line', source: 'stac-footprints', paint: { 'line-color': ['case', ['==', ['get', 'hl'], 1], '#ffd166', '#4cc2ff'], 'line-width': ['case', ['==', ['get', 'hl'], 1], 2.5, 1] } } as maplibregl.LayerSpecification);
  }
  if (footprint) {
    sources['explorer-footprint'] = { type: 'geojson', data: footprint };
    out.push({ id: 'explorer-footprint-fill', type: 'fill', source: 'explorer-footprint', paint: { 'fill-color': '#ff7a45', 'fill-opacity': 0.08 } } as maplibregl.LayerSpecification,
      { id: 'explorer-footprint', type: 'line', source: 'explorer-footprint', paint: { 'line-color': '#ff7a45', 'line-width': 2, 'line-dasharray': [2, 2] } } as maplibregl.LayerSpecification);
  }
  // Live GNSS devices (phone page, NMEA, gpsd): recent track + current position, always on top.
  sources.live = { type: 'geojson', data: liveData as unknown as GeoJSON.FeatureCollection };
  out.push(
    { id: 'live#track', type: 'line', source: 'live', filter: ['==', ['get', 'role'], 'track'],
      paint: { 'line-color': '#ffd166', 'line-width': 2.5, 'line-dasharray': [2, 1] } } as maplibregl.LayerSpecification,
    { id: 'live#pos', type: 'circle', source: 'live', filter: ['==', ['get', 'role'], 'position'],
      paint: { 'circle-color': '#ffd166', 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } } as maplibregl.LayerSpecification,
  );
  // keep terra-draw's drawing layers (td-*) across restyles, on top (web/src/editing.ts)
  try {
    const cur = map?.getStyle?.();
    for (const [k, v] of Object.entries(cur?.sources ?? {})) if (k.startsWith('td-')) sources[k] = v;
    for (const l of cur?.layers ?? []) if (l.id.startsWith('td-')) out.push(l);
  } catch { /* first style: the map is not ready yet */ }
  // View › Projection (MapLibre's own projections: Web Mercator or a globe)
  out.push(...labelLayers);
  // the globe gets an atmosphere around it (space beyond), fading out as you zoom in, as in GeoLibre
  const sky = {
    'sky-color': css('map-space') || '#000000',
    'horizon-color': css('map-glow') || '#3b6ea8',
    'fog-color': css('map-glow') || '#3b6ea8',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.2,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  } as maplibregl.SkySpecification;
  if (terrain3d) {
    // the heights twice: one source raises the map, the other shades it (MapLibre advises separate sources)
    const tiles = [backend.url(`api/rasters/${encodeURIComponent(terrain3d.id)}/terrain/{z}/{x}/{y}.png`)];
    sources['terrain-dem'] = { type: 'raster-dem', tiles, tileSize: 256, encoding: 'terrarium', maxzoom: 14 };
    sources['terrain-shade'] = { type: 'raster-dem', tiles, tileSize: 256, encoding: 'terrarium', maxzoom: 14 };
    // the hillshade goes just above the basemap, under every data layer
    const at = out.findIndex((l, i) => i > 0 && !l.id.startsWith('basemap'));
    out.splice(at < 0 ? out.length : at, 0, { id: 'terrain-hillshade', type: 'hillshade', source: 'terrain-shade',
      paint: { 'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#0b0d10', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#2b2f36' } } as maplibregl.LayerSpecification);
  }
  return {
    version: 8, glyphs: new URL('fonts/', location.href).href + GLYPHS.slice('fonts/'.length), sources, layers: out,
    // terrain is drawn on the flat map (the globe is for the world view)
    projection: { type: terrain3d ? 'mercator' : mapProjection }, sky,
    ...(terrain3d ? { terrain: { source: 'terrain-dem', exaggeration: terrain3d.exaggeration } } : {}),
  };
}

// ---------------------------------------------------------------- basemap
// A map should never open on an empty void. 'offline' is Natural Earth 1:50m (public domain) shipped
// with the app, so it works with no network; 'osm' is OpenStreetMap's raster tiles (needs internet).
const basemapUrl = (f: string) => new URL(`basemap/${f}.geojson`, location.href).href;
const basemap = (): Basemap => (params.get('basemap') as Basemap | null) ?? project.basemap ?? prefs.basemap ?? 'offline';

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

/** States the ribbon shows as pressed (basemap, theme, 3D terrain, labels of the selected layer). */
function syncStateFlags() {
  const ds = document.body.dataset;
  // not data-basemap: Contents buttons carry that attribute, and a click looks for the nearest one
  ds.baseMap = project.basemap ?? 'offline';
  ds.terrain3d = terrain3d ? 'on' : 'off';
  ds.themePref = theme;
  const id = panel?.current;
  ds.labels = id && project.layers[id]?.labels?.on ? 'on' : 'off';
  toolStateChanged();
}

function applyStyle() {
  syncStateFlags();
  const style = buildStyle();
  // hatch patterns must exist before the layer: a tile parsed while its pattern is missing stays
  // unhatched (styleimagemissing alone races the tiles)
  for (const l of style.layers) {
    const pat = (l as { paint?: Record<string, unknown> }).paint?.['fill-pattern'];
    if (typeof pat === 'string' && pat.startsWith(HATCH_PREFIX) && !map.hasImage(pat)) map.addImage(pat, hatchImage(pat), { pixelRatio: 2 });
  }
  map.setStyle(style); // MapLibre diffs the style: only changed layers/sources update
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
/** The zoom at which the globe fills ~90 % of the map's height (MapLibre's globe is 512·2^z/π px across). */
function globeZoom(): number {
  const h = document.querySelector<HTMLElement>('#map')?.clientHeight || 600;
  return Math.max(0, Math.min(3, Math.log2((h * 0.9 * Math.PI) / 512)));
}

function fitAll(duration = 450) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const id of project.order) {
    const l = layerById(id);
    if (!l || !project.layers[id]?.visible) continue;
    minx = Math.min(minx, l.bounds[0]); miny = Math.min(miny, l.bounds[1]);
    maxx = Math.max(maxx, l.bounds[2]); maxy = Math.max(maxy, l.bounds[3]);
  }
  if (!Number.isFinite(minx)) return;
  map.fitBounds([[minx, miny], [maxx, maxy]], { padding: 60, maxZoom: 17, duration });
}

/** Layers a tool has styled on purpose (the Design tab's drafting looks): AutoMap leaves them alone,
 *  even when its answer for the new layer arrives after the tool's style. */
const styledByTool = new Set<string>();

/** Let the engine choose a style for one layer (AutoMap). */
async function autostyleLayer(id: string, opts: { keepVisibility?: boolean; quiet?: boolean } = {}) {
  const r = await backend.json<{ style: Partial<LayerStyle>; why?: string }>(`api/layers/${encodeURIComponent(id)}/autostyle`).catch(() => null);
  if (!r?.style || !layerById(id) || styledByTool.has(id)) return;
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
// ---------------------------------------------------------------- settings (Home › Settings)
interface Prefs { auto: boolean; autooverviews: boolean; units: 'metric' | 'imperial' | 'nautical'; basemap: Basemap }
const PREFS_KEY = 'geospax.prefs';
const prefs: Prefs = (() => {
  const d: Prefs = { auto: true, autooverviews: true, units: 'metric', basemap: 'offline' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return d; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

/** An automation that is on unless switched off in Settings or the URL (?auto=0); benches and tests opt out. */
const lazyOn = (name: string) => params.has(name) ? params.get(name) !== '0' : !params.has('bench') && !params.has('fresh') && prefs[name as 'auto' | 'autooverviews'] !== false;

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


const webRows = () => {
  const ws = project.web ?? [];
  if (!ws.length) return '';
  const e = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<div class="${uiMode === 'lazy' ? 'lc-group' : 'pr-webhead'}"><span>Web layers</span><span>${ws.length}</span></div>${ws
    .map((w) => `<div class="web-row" data-web="${e(w.id)}"><label class="lc-switch"><input type="checkbox" data-web-vis ${w.visible ? 'checked' : ''} aria-label="Show ${e(w.title)}"></label>
      <span class="web-name" title="${e(w.title)}">${e(w.title)}</span>
      <input type="range" min="0" max="100" step="5" value="${Math.round(w.opacity * 100)}" data-web-op aria-label="Opacity of ${e(w.title)}">
      <button data-web-rm title="Remove from the map" aria-label="Remove ${e(w.title)}">✕</button></div>`)
    .join('')}`;
};

function renderContents() {
  const el = $('#contents');
  document.body.dataset.mode = uiMode;
  // ArcGIS convention: top of the list draws on top (= end of the draw order)
  const list = [...project.order].reverse().filter((id) => layerById(id) || (id.startsWith('r:') && rasterPane?.byId(id.slice(2))));
  const row = (id: string, i: number, depth = 0) => {
    if (id.startsWith('r:')) return rasterRow(id, i === 0, i === list.length - 1, depth);
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
      const g: Group = id.startsWith('r:') ? (id.includes('.') ? 'results' : 'data') : groupOf(layerById(id)!, isDeviceLayer);
      groups.set(g, [...(groups.get(g) ?? []), row(id, i)]);
    });
    for (const g of ['devices', 'data', 'results', 'reference'] as Group[]) {
      const rows = groups.get(g);
      if (rows) body += `<div class="lc-group"><span>${GROUP_TITLE[g]}</span><span>${rows.length}</span></div>${rows.join('')}`;
    }
    body += webRows();
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
    body += webRows();
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

/** A raster in Contents: switch, name, kind, opacity, legend (state shared with the Rasters pane). */
function rasterRow(id: string, first: boolean, last: boolean, depth = 0): string {
  const rid = id.slice(2);
  const r = rasterPane!.byId(rid)!;
  const e = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const on = rasterPane!.isVisible(rid);
  const op = Math.round(rasterPane!.opacity(rid) * 100);
  const open = !closedLegends.has(id);
  const legend = on && open ? rasterPane!.legendHtml(rid) : '';
  if (uiMode === 'lazy') {
    return `<div class="card raster-card${rid === activeRaster ? ' selected' : ''}" data-id="${e(id)}" style="--c:#7a8ea6"><div class="lc-top"><span class="lc-glyph">▦</span>
      <span class="lc-title"><b>${e(r.title)}</b><small>${r.kind === 'raster' ? 'Raster' : `${e(r.kind)} raster`} · ${e(Math.round(r.pixel_m).toLocaleString('en-US'))} m cells</small></span>
      <label class="lc-switch"><input type="checkbox" ${on ? 'checked' : ''} aria-label="Show ${e(r.title)}"> Show</label></div>
      ${legend ? `<div class="rlegend">${legend}</div>` : ''}
      <div class="lc-acts"><button data-act="zoom">Zoom to</button><button data-act="remove" class="lc-remove" title="Remove from the map (the file is kept)" aria-label="Remove from the map">✕</button><button data-act="props" title="Colours and legend" aria-label="Colours and legend">⋯</button></div></div>`;
  }
  return `<div class="layer pro raster${rid === activeRaster ? ' selected' : ''}" data-id="${e(id)}" draggable="true" role="treeitem" aria-level="${depth + 2}" aria-expanded="${open}" aria-selected="${rid === activeRaster}" style="--d:${depth}">
    <button class="pr-tw" data-act="twisty" aria-label="${open ? 'Collapse' : 'Expand'} legend">${open ? '▾' : '▸'}</button>
    <input type="checkbox" ${on ? 'checked' : ''} aria-label="Toggle ${e(r.title)}" />
    <span class="swatch raster" aria-hidden="true"></span>
    <b class="name" title="${e(r.description || r.why || 'Symbology')}">${e(r.title)}</b>
    <span class="pr-n">${e(r.kind)}</span>
    <input class="pr-op" type="range" min="0" max="100" step="5" value="${op}" data-act="opacity" title="Opacity ${op}%" aria-label="Opacity" />
    <span class="tools">
      <button data-act="up" title="Move up" aria-label="Move up" ${first ? 'disabled' : ''}>▲</button>
      <button data-act="down" title="Move down" aria-label="Move down" ${last ? 'disabled' : ''}>▼</button>
      <button data-act="zoom" title="Zoom to" aria-label="Zoom to">⤢</button>
      <button data-act="props" title="Symbology" aria-label="Symbology">⚙</button>
      <button data-act="remove" class="rm" title="Remove from the map (the file is kept)" aria-label="Remove from the map">✕</button>
    </span>
    <small class="pr-sub">${r.kind === 'raster' ? 'raster' : `raster · ${e(r.kind)}`} · ${r.width}×${r.height} cells · ${Math.round(r.pixel_m)} m · ${e(r.crs)}</small>
    ${legend ? `<div class="legend rlegend">${legend}</div>` : ''}
  </div>`;
}

/**
 * Draw a run's map rasters where its exported map draws them (the map composer, cartography.rs): under
 * every vector layer but the land polygons, so a DEM or relief shading does not hide the run's points,
 * lines and contours. Rasters of a run without a map stay on top, like any new result.
 */
function placeUnderVectors(rasterIds: string[]) {
  const move = new Set(rasterIds.map((id) => `r:${id}`));
  const rest = project.order.filter((id) => !move.has(id));
  const moved = project.order.filter((id) => move.has(id));
  if (!moved.length) return;
  const at = rest.findIndex((id) => !id.startsWith('r:') && !!layerById(id) && !isLand(id));
  rest.splice(at < 0 ? rest.length : at, 0, ...moved);
  if (rest.join('|') !== project.order.join('|')) {
    project.order = rest;
    saveProject();
  }
}

/** Rasters loaded or changed (new results, a switch in either pane): keep the draw order and Contents in step. */
let knownRasters: Set<string> | null = null;
function onRastersChanged() {
  if (!rasterPane) return;
  const ids = rasterPane.rasters.map((r) => r.id);
  // a raster that appeared while the app was open (a tool, the assistant, a trigger) is shown, like a new layer
  if (knownRasters) {
    const fresh = ids.filter((id) => !knownRasters!.has(id));
    knownRasters = new Set(ids);
    if (fresh.length) {
      rasterPane.showNew(fresh);
      workbench?.setStatus(`Added to the map: ${fresh.map((id) => rasterPane!.byId(id)?.title ?? id).join(', ')}`, 6000);
    }
  } else knownRasters = new Set(ids);
  const before = project.order.join('|');
  project = mergeProject(project);
  if (project.order.join('|') !== before) saveProject();
  applyStyle();
  renderContents();
}

/** Symbology for a raster (web/src/rasterstyle.ts): renderer, band, ramp, stretch, classes, RGB, opacity. */
async function rasterStyle(rid: string) {
  const r = rasterPane?.byId(rid);
  if (!r) return;
  const { openRasterStyle } = await import('./rasterstyle');
  await openRasterStyle({
    backend,
    updated: (info) => { rasterPane!.replace(info); if (activeRaster === info.id) renderRasterViews(); },
    opacity: (id) => rasterPane!.opacity(id),
    setOpacity: (id, o) => rasterPane!.setOpacity(id, o),
  }, r);
}

/** Right-click on a raster in Contents. */
function rasterMenu(id: string, x: number, y: number): boolean {
  const rid = id.slice(2);
  const r = rasterPane?.byId(rid);
  if (!r) return false;
  const on = rasterPane!.isVisible(rid);
  showMenu(x, y, r.title, [
    { label: on ? 'Hide' : 'Show', run: () => rasterPane!.setVisible(rid, !on) },
    { label: 'Zoom to raster', run: () => void map.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], { padding: 40, maxZoom: 16, duration: 300 }) },
    { sep: true },
    { label: 'Symbology…', hint: 'Renderer, colours, stretch, opacity', run: () => void rasterStyle(rid) },
    ...[100, 75, 50, 25].map((o) => ({ label: `Opacity ${o} %`, disabled: Math.round(rasterPane!.opacity(rid) * 100) === o, run: () => rasterPane!.setOpacity(rid, o / 100) })),
    { sep: true },
    { label: 'Remove from map', danger: true, hint: 'The file is kept; add it again from the Explorer', run: () => void removeLayer(id) },
    { label: 'Properties…', run: async () => {
      const { dialog } = await import('./editing');
      const e = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const rows: [string, string][] = [['Name', r.title], ['Id', r.id], ['Kind', r.kind], ['Size', `${r.width} × ${r.height} px`], ['Pixel', `${r.pixel_m} m`],
        ['Coordinate system', r.crs], ['Extent (WGS 84)', r.bounds.map((v) => v.toFixed(5)).join(', ')], ['About', r.description || r.why]];
      await dialog(`Properties · ${r.title}`, `<table class="props">${rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join('')}</table>`, [['', 'Close']], { wide: true });
    } },
  ]);
  return true;
}

// ---- drag a box on the map (Online data › A box drawn on the map)
function drawBoxOnMap(): Promise<[number, number, number, number] | null> {
  return new Promise((resolve) => {
    // the start screen covers the map while it is empty: drawing needs the map
    const startEl = document.querySelector<HTMLElement>('#start');
    if (startEl) startEl.hidden = true;
    const canvas = map.getCanvasContainer();
    const tip = document.createElement('div');
    tip.className = 'draw-tip';
    tip.textContent = 'Drag a box over the area you want · Esc to cancel';
    document.body.appendChild(tip);
    const rect = document.createElement('div');
    rect.className = 'draw-box';
    canvas.appendChild(rect);
    map.dragPan.disable();
    map.boxZoom.disable();
    canvas.style.cursor = 'crosshair';
    let start: { x: number; y: number } | null = null;
    const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const done = (b: [number, number, number, number] | null) => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.removeEventListener('keydown', key, true);
      rect.remove();
      tip.remove();
      canvas.style.cursor = '';
      map.dragPan.enable();
      map.boxZoom.enable();
      resolve(b);
    };
    const down = (e: PointerEvent) => { if (e.button === 0) { start = pos(e); e.preventDefault(); } };
    const move = (e: PointerEvent) => {
      if (!start) return;
      const p = pos(e);
      Object.assign(rect.style, { left: `${Math.min(p.x, start.x)}px`, top: `${Math.min(p.y, start.y)}px`, width: `${Math.abs(p.x - start.x)}px`, height: `${Math.abs(p.y - start.y)}px`, display: 'block' });
    };
    const up = (e: PointerEvent) => {
      if (!start) return;
      const p = pos(e);
      if (Math.abs(p.x - start.x) < 6 || Math.abs(p.y - start.y) < 6) { start = null; rect.style.display = 'none'; return; }
      const a = map.unproject([start.x, start.y]);
      const b = map.unproject([p.x, p.y]);
      done([Math.max(-180, Math.min(a.lng, b.lng)), Math.max(-85, Math.min(a.lat, b.lat)), Math.min(180, Math.max(a.lng, b.lng)), Math.min(85, Math.max(a.lat, b.lat))]);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.addEventListener('keydown', key, true);
  });
}

// ---- the selected raster: its story in the Inspector (Lazy) or Symbology (Pro), its statistics in
// Attributes, and the value under a map click (web/src/rasterview.ts)
let activeRaster: string | null = null;
let rasterValue: RasterValue | null = null;
const rasterHist = new Map<string, Histogram>();

async function showRaster(rid: string) {
  const r = rasterPane?.byId(rid);
  if (!r) return;
  if (activeRaster !== rid) rasterValue = null;
  activeRaster = rid;
  panel?.close();
  renderRasterViews();
  workbench?.showTab('right', uiMode === 'lazy' ? 'inspector' : 'symbology');
  workbench?.setStatus(`${r.title}: click the map to read a value`, 4000);
  if (!rasterHist.has(rid)) {
    try {
      rasterHist.set(rid, await backend.json<Histogram>(`api/rasters/${encodeURIComponent(rid)}/histogram?bins=24`));
    } catch { /* the story shows without it */ }
    if (activeRaster === rid) renderRasterViews();
  }
}

function clearRaster() {
  if (!activeRaster) return;
  activeRaster = null;
  rasterValue = null;
  renderRasterViews();
}

function renderRasterViews() {
  const sym = document.querySelector<HTMLElement>('#raster-sym');
  const attr = document.querySelector<HTMLElement>('#raster-attr');
  const r = activeRaster ? rasterPane?.byId(activeRaster) : undefined;
  if (!r) activeRaster = null;
  // Pro: the raster takes the Symbology and Attributes panes' place while it is selected
  $('#panel').hidden = !!r || !panel?.current;
  $('#attributes').hidden = !!r;
  if (sym) {
    sym.hidden = !r;
    sym.innerHTML = r ? rasterStoryHtml(r, rasterHist.get(r.id) ?? null, rasterPane!.opacity(r.id), rasterValue, true) : '';
  }
  if (attr) {
    attr.hidden = !r;
    attr.innerHTML = r ? rasterAttributesHtml(r, rasterHist.get(r.id) ?? null, rasterValue) : '';
    if (r) mountRasterCharts(attr, r, rasterHist.get(r.id) ?? null);
  }
  renderInspector();
  renderContents();
}

/** Raise the map on an elevation raster (or back to the flat map with null), and tilt the camera. */
function setTerrain3d(rid: string | null) {
  const r = rid ? rasterPane?.byId(rid) : null;
  terrain3d = r ? { id: r.id, exaggeration: 1.5 } : null;
  // its colours draped on the terrain (the hillshade alone is grey)
  if (r && !rasterPane!.isVisible(r.id)) rasterPane!.setVisible(r.id, true);
  applyStyle();
  renderContents();
  if (r) {
    map.setMaxPitch(80);
    const [w, s, e, n] = r.bounds;
    map.fitBounds([[w, s], [e, n]], { padding: 40, pitch: 62, bearing: -25, duration: 1400 });
    workbench?.setStatus(`3D terrain: ${r.title} (1.5× height). Right-drag or two fingers to tilt and turn; View › 3D terrain again for the flat map`, 8000);
  } else {
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    workbench?.setStatus('Flat map', 3000);
  }
  renderRasterViews();
}

/** Clicks and the opacity slider inside any raster view. */
function wireRasterViews() {
  for (const sel of ['#inspector', '#raster-sym', '#raster-attr']) {
    const el = document.querySelector<HTMLElement>(sel);
    el?.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rv]');
      const rid = activeRaster;
      if (!b || !rid) return;
      e.stopPropagation();
      const r = rasterPane?.byId(rid);
      switch (b.dataset.rv) {
        case 'style': return void rasterStyle(rid);
        case 'zoom': if (r) map.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], { padding: 40, maxZoom: 16, duration: 300 }); return;
        case 'attributes': return void workbench?.showTab(uiMode === 'lazy' ? 'right' : 'right', 'attributes');
        case 'remove': return void removeLayer(`r:${rid}`);
        case '3d': return void setTerrain3d(terrain3d?.id === rid ? null : rid);
      }
    });
    el?.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.rv !== 'opacity' || !activeRaster) return;
      e.stopPropagation();
      rasterPane?.setOpacity(activeRaster, Number(t.value) / 100);
    });
  }
  // a click on the map reads the selected raster's value there
  map.on('click', async (e) => {
    const rid = activeRaster;
    if (!rid || !rasterPane) return;
    try {
      rasterValue = await backend.json<RasterValue>(`api/rasters/${encodeURIComponent(rid)}/value?lon=${e.lngLat.lng}&lat=${e.lngLat.lat}`);
    } catch {
      return;
    }
    if (activeRaster !== rid) return;
    const r = rasterPane.byId(rid)!;
    document.querySelectorAll<HTMLElement>('.rv-value').forEach((b) => (b.innerHTML = valueHtml(rasterValue, r)));
    const v = rasterValue.values[0];
    workbench?.setStatus(rasterValue.inside ? `${r.title}: ${v === null ? 'no data' : `${+v.toPrecision(4)}${r.units ? ` ${r.units}` : ''}`}` : `${r.title}: outside the raster`, 5000);
  });
}

/** Lazy mode's right pane: the selected layer as a story (web/src/inspector.ts). */
function renderInspector() {
  const el = document.querySelector<HTMLElement>('#inspector');
  if (!el) return;
  if (activeRaster) {
    const r = rasterPane?.byId(activeRaster);
    if (r) return void (el.innerHTML = rasterStoryHtml(r, rasterHist.get(r.id) ?? null, rasterPane!.opacity(r.id), rasterValue));
    activeRaster = null;
  }
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
  // web layers: show/hide, opacity, remove (before the layer handlers below)
  const webOf = (t: HTMLElement) => { const id = t.closest<HTMLElement>('[data-web]')?.dataset.web; return id ? project.web?.find((w) => w.id === id) : undefined; };
  $('#contents').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const w = webOf(t);
    if (!w) return;
    e.stopPropagation();
    if (t.closest('[data-web-rm]')) {
      project.web = (project.web ?? []).filter((x) => x !== w);
      workbench?.setStatus(`${w.title} removed from the map`, 4000);
    } else if (t.matches('[data-web-vis]')) w.visible = (t as HTMLInputElement).checked;
    else return;
    applyStyle();
    renderContents();
    saveProject();
  }, true);
  $('#contents').addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const w = webOf(t);
    if (!w || !t.matches('[data-web-op]')) return;
    e.stopPropagation();
    w.opacity = Number(t.value) / 100;
    if (map.getLayer(`web:${w.id}`)) map.setPaintProperty(`web:${w.id}`, 'raster-opacity', w.opacity);
    saveProject();
  }, true);
  const el = $('#contents');
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const gid = t.closest<HTMLElement>('.pr-group')?.dataset.group;
    if (gid && t.dataset.gact === 'visible') return groupAction('visible', gid, t);
    if (t.dataset.tree === 'basemap') return t.value === 'custom' ? void basemapGallery() : setBasemap(t.value as Basemap);
    const id = t.closest<HTMLElement>('.layer, .raster-card')?.dataset.id;
    if (!id) return;
    if (id.startsWith('r:')) {
      if (t.type === 'checkbox') rasterPane?.setVisible(id.slice(2), t.checked);
      else if (t.dataset.act === 'opacity') rasterPane?.setOpacity(id.slice(2), Number(t.value) / 100);
      return;
    }
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
    const id = t.closest<HTMLElement>('.layer, .raster-card')?.dataset.id;
    if (!id) return;
    const actEl = t.closest<HTMLElement>('[data-act]');
    const act = actEl?.dataset.act;
    if (act === 'twisty') {
      if (!closedLegends.delete(id)) closedLegends.add(id);
      saveClosed();
      return renderContents();
    }
    if (act === 'remove') return void removeLayer(id);
    if (act === 'up' || act === 'down') moveLayer(id, act);
    else if (id.startsWith('r:')) {
      const r = rasterPane?.byId(id.slice(2));
      if (act === 'zoom' && r) map.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], { padding: 40, maxZoom: 16, duration: 300 });
      else if (act === 'props') void rasterStyle(id.slice(2));
      else if (t.closest('.name') || !t.closest('button, input, label')) void showRaster(id.slice(2));
    } else if (act === 'zoom') fitLayer(id);
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
    else if (e.key === 'Delete' && id) (go(items[i + 1] ?? items[i - 1]), void removeLayer(id));
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
    // added back on purpose: no longer one of the removed layers
    if (project.removed?.length) project.removed = project.removed.filter((id) => !ids.includes(id) && !rasterIds.includes(id.slice(2)));
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

let scaleControl: maplibregl.ScaleControl | undefined;
let pinMarker: maplibregl.Marker | undefined;

/** Read "lat, lon", "lon lat", or degrees-minutes-seconds with N/S/E/W ("9°26'S 147°11'E"). */
export function parseLatLon(text: string): [number, number] | null {
  const t = text.trim().toUpperCase().replace(/,/g, ' ');
  const dms = [...t.matchAll(/(-?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEW])?/g)].filter((m) => m[0].trim());
  if (dms.length < 2) return null;
  const val = (m: RegExpMatchArray) => {
    const v = Math.abs(Number(m[1])) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
    return (m[1].startsWith('-') || m[4] === 'S' || m[4] === 'W' ? -1 : 1) * v;
  };
  const [a, b] = dms;
  let lat: number, lon: number;
  if (a[4] === 'E' || a[4] === 'W' || b[4] === 'N' || b[4] === 'S') [lon, lat] = [val(a), val(b)];
  else [lat, lon] = [val(a), val(b)];
  // "147.2 -9.4" (lon lat, as GIS people often write it): a latitude cannot be beyond ±90
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

function dropPin(lonlat: [number, number], label: string) {
  pinMarker?.remove();
  pinMarker = new maplibregl.Marker({ color: '#e8590c' }).setLngLat(lonlat).setPopup(new maplibregl.Popup({ offset: 24 }).setText(label)).addTo(map);
  pinMarker.togglePopup();
}

async function goToXY() {
  const { dialog, say } = await import('./editing');
  await dialog('Go To XY', `<label>Coordinates <input name="xy" placeholder="-9.44, 147.18  ·  9°26'S 147°11'E  ·  147.18 -9.44" autofocus></label>
    <p class="hint">Latitude and longitude in decimal degrees or degrees-minutes-seconds, in either order with N/S/E/W.</p><div class="dlg-msg" data-msg></div>`, [['ok', 'Go'], ['', 'Cancel']], {
    onButton: (b, v, root) => {
      if (b !== 'ok') return true;
      const p = parseLatLon(v.xy);
      if (!p) return (say(root, 'Not a coordinate pair I can read', 'err'), false);
      map.flyTo({ center: p, zoom: Math.max(map.getZoom(), 12), duration: 1200 });
      dropPin(p, `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`);
      return true;
    },
  });
}

async function findPlace() {
  const { dialog, say } = await import('./editing');
  await dialog('Find place', `<label>Place or address <input name="q" placeholder="e.g. Port Moresby, or Waigani Drive" autofocus></label>
    <div class="fp-results"></div><p class="hint">Search by OpenStreetMap Nominatim (needs internet). Coordinates work too.</p><div class="dlg-msg" data-msg></div>`, [['ok', 'Search'], ['', 'Close']], {
    onOpen: (root) => root.addEventListener('click', (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-lon]');
      if (!r) return;
      const p: [number, number] = [Number(r.dataset.lon), Number(r.dataset.lat)];
      const bb = r.dataset.bbox?.split(',').map(Number);
      if (bb?.length === 4) map.fitBounds([[bb[2], bb[0]], [bb[3], bb[1]]], { padding: 60, maxZoom: 16, duration: 1200 });
      else map.flyTo({ center: p, zoom: 14 });
      dropPin(p, r.dataset.name ?? '');
      root.closest('.modal')?.remove();
    }),
    onButton: async (b, v, root) => {
      if (b !== 'ok') return true;
      const xy = parseLatLon(v.q);
      if (xy) {
        map.flyTo({ center: xy, zoom: Math.max(map.getZoom(), 12) });
        dropPin(xy, v.q);
        return true;
      }
      say(root, 'Searching…');
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(v.q)}`, { headers: { accept: 'application/json' } });
        const hits = (await r.json()) as { lat: string; lon: string; display_name: string; type: string; boundingbox?: string[] }[];
        const e = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        root.querySelector('.fp-results')!.innerHTML = hits.length
          ? hits.map((h) => `<button type="button" class="fp-hit" data-lon="${e(h.lon)}" data-lat="${e(h.lat)}" data-name="${e(h.display_name)}" data-bbox="${e((h.boundingbox ?? []).join(','))}"><b>${e(h.display_name.split(',')[0])}</b><small>${e(h.display_name)} · ${e(h.type)}</small></button>`).join('')
          : '';
        say(root, hits.length ? `${hits.length} places: click one` : 'Nothing found', hits.length ? 'ok' : 'err');
      } catch {
        say(root, 'The place search needs internet (OpenStreetMap Nominatim)', 'err');
      }
      return false;
    },
  });
}

/** Home › Settings (ArcGIS Pro's Options): appearance, map, automation, and the setup pages. */
async function openSettings() {
  const { dialog } = await import('./editing');
  const e = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const opt = (v: string, label: string, cur: string) => `<option value="${e(v)}"${v === cur ? ' selected' : ''}>${e(label)}</option>`;
  const { loadChartStyle, saveChartStyle, THEMES: CH_THEMES, PALETTES: CH_PALETTES } = await import('./ggchart');
  const chartSt = await loadChartStyle(backend);
  const health = await backend.json<{ version?: string; data?: string[]; state?: string }>('api/about').catch(() => ({} as { version?: string; data?: string[]; state?: string }));
  const body = `
    <div class="settings">
      <section><h3>Appearance</h3>
        <label>Mode <select name="mode">${opt('lazy', 'Lazy: cards, task bar, plain-language steps', uiMode)}${opt('pro', 'Pro: full ribbon, layer tree, every pane', uiMode)}</select></label>
        <label>Theme <select name="theme">${opt('light', 'Light', theme)}${opt('dark', 'Dark', theme)}${opt('system', 'Follow the system', theme)}</select></label>
      </section>
      <section><h3>Map</h3>
        <label>Projection <select name="projection">${opt('globe', 'Globe (zoom out to see the Earth)', mapProjection)}${opt('mercator', 'Flat (Web Mercator)', mapProjection)}</select></label>
        <label>Basemap for new maps <select name="basemap">${BASEMAPS.filter((b) => b.id !== 'custom').map((b) => opt(b.id, b.title, prefs.basemap)).join('')}${opt('none', 'None', prefs.basemap)}</select></label>
        <label>Units (scale bar, measuring) <select name="units">${opt('metric', 'Metric (km, m)', prefs.units)}${opt('imperial', 'Imperial (mi, ft)', prefs.units)}${opt('nautical', 'Nautical (nmi)', prefs.units)}</select></label>
      </section>
      <section><h3>Charts</h3>
        <p class="dim">The look of every chart: in reports, in the Attributes pane and in R (ggplot2 uses the same theme and palette).</p>
        <label>Theme <select name="ch_theme">${CH_THEMES.map(([k, t]) => opt(k, t, chartSt.theme)).join('')}</select></label>
        <label>Colour palette <select name="ch_palette">${CH_PALETTES.map(([k, t]) => opt(k, t, chartSt.palette)).join('')}</select></label>
        <label>Text size (pt) <input name="ch_size" type="number" min="6" max="24" step="1" value="${chartSt.base_size}"></label>
      </section>
      <section><h3>Automation</h3>
        <label class="chk"><input type="checkbox" name="auto" ${prefs.auto ? 'checked' : ''}> Style new layers automatically (AutoMap)</label>
        <label class="chk"><input type="checkbox" name="autooverviews" ${prefs.autooverviews ? 'checked' : ''}> Build overviews for large layers in the background</label>
      </section>
      <section><h3>Setup</h3>
        <div class="settings-btns">
          <button type="button" data-go="ai">AI assistant…</button>${uiMode === 'pro' ? '<button type="button" data-go="r">R and packages…</button>' : ''}
          <button type="button" data-go="plugins">Plugins…</button><button type="button" data-go="layout">Reset window layout</button>
        </div>
      </section>
      <section><h3>About this installation</h3>
        <table class="props"><tr><th>Version</th><td>${e(health.version ?? '')}</td></tr><tr><th>Edition</th><td>${backend.edition === 'web' ? 'Web' : 'Desktop'}</td></tr>
        ${health.data?.length ? `<tr><th>Data folders</th><td>${health.data.map(e).join('<br>')}</td></tr>` : ''}${health.state ? `<tr><th>Projects and results</th><td>${e(health.state)}</td></tr>` : ''}</table>
      </section>
    </div>`;
  await dialog('Settings', body, [['ok', 'Save'], ['', 'Cancel']], {
    wide: true,
    onOpen: (root) => root.addEventListener('click', (ev) => {
      const go = (ev.target as HTMLElement).closest<HTMLElement>('[data-go]')?.dataset.go;
      if (!go) return;
      root.closest('.modal')?.remove();
      if (go === 'ai') { workbench?.showTab('right', 'ask'); document.dispatchEvent(new CustomEvent('geospax:ask-settings')); }
      else if (go === 'r') document.dispatchEvent(new CustomEvent('geospax:r', { detail: 'setup' }));
      else if (go === 'plugins') document.dispatchEvent(new CustomEvent('geospax:plugin-manager'));
      else if (go === 'layout') document.dispatchEvent(new CustomEvent('geospax:reset-layout'));
    }),
    onButton: (b, v) => {
      if (b !== 'ok') return true;
      if (v.mode !== uiMode) setMode(v.mode as UiMode);
      if (v.theme !== theme) setTheme(v.theme as Theme);
      if (v.projection !== mapProjection) document.dispatchEvent(new CustomEvent('geospax:projection', { detail: v.projection }));
      prefs.auto = v.auto === 'on';
      prefs.autooverviews = v.autooverviews === 'on';
      prefs.basemap = v.basemap as Basemap;
      if (v.units !== prefs.units) {
        prefs.units = v.units as Prefs['units'];
        scaleControl?.setUnit(prefs.units);
      }
      savePrefs();
      if (v.ch_theme !== chartSt.theme || v.ch_palette !== chartSt.palette || Number(v.ch_size) !== chartSt.base_size) {
        void saveChartStyle(backend, { theme: v.ch_theme, palette: v.ch_palette, base_size: Number(v.ch_size) || 11 }).then(() => document.dispatchEvent(new CustomEvent('geospax:reload-views')));
      }
      workbench?.setStatus('Settings saved', 4000);
      return true;
    },
  });
}

/** Remove a layer or raster from the map (ArcGIS Pro "Remove"): the file is kept and the layer
 *  stays off at the next start, until it is added back from the Catalog. */
async function removeLayer(id: string) {
  const name = id.startsWith('r:') ? rasterPane?.byId(id.slice(2))?.title ?? id : layerById(id)?.name ?? id;
  project.removed = [...new Set([...(project.removed ?? []), id])];
  project.order = project.order.filter((x) => x !== id);
  if (project.member) delete project.member[id];
  if (id.startsWith('r:')) rasterPane?.setVisible(id.slice(2), false);
  if (id === `r:${activeRaster}`) clearRaster();
  else {
    editor?.clearSelection(id);
    await backend.json(`api/layers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    layers = layers.filter((l) => l.id !== id);
    if (panel.current === id) panel.close();
  }
  saveProject();
  applyStyle();
  renderContents();
  document.dispatchEvent(new CustomEvent('geospax:reload-views'));
  workbench?.setStatus(`${name} removed from the map (the file is kept; add it again from the Explorer)`, 6000);
}

// ---------------------------------------------------------------- overview jobs
async function reloadLayers() {
  const r = await backend.json<{ layers: LayerInfo[] }>('api/layers');
  layers = r.layers.filter((l) => !project.removed?.includes(l.id));
  // Layers that appeared at runtime (device imports) join the project with default styles, on top.
  const known = new Set(project.order);
  project = mergeProject(project);
  const added = project.order.filter((id) => !known.has(id) && !id.startsWith('r:'));
  if (added.length) {
    saveProject();
    // new layers are switched on and listed on top (mergeProject puts them at the end of the draw order)
    for (const id of added) if (project.layers[id] && defaultVisible(layerById(id)!)) project.layers[id].visible = true;
    if (known.size) workbench?.setStatus(`Added to the map: ${added.map((id) => layerById(id)?.name ?? id).join(', ')}`, 6000);
  }
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
      // desktop: once a day, a banner when a newer version is out (Windows installs it in place)
      if (h.version && !params.has('bench')) void startupCheck(h.version);
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
  const about = await backend.json<{ guest?: boolean }>('api/about').catch(() => null);
  if (about?.guest && backend.edition === 'web') {
    guestMode = true;
    // crypto.randomUUID needs HTTPS; getRandomValues works everywhere
    const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    let ws = '';
    try {
      ws = localStorage.getItem('geospax.ws') ?? '';
      if (!/^[a-z0-9-]{8,64}$/.test(ws)) localStorage.setItem('geospax.ws', (ws = newId()));
    } catch {
      ws = newId(); // private window: a workspace for this visit only
    }
    backend.ws = ws;
    // sent with every request (map tiles and images too): the server shows this visitor only their own layers
    document.cookie = `geospax_ws=${ws}; path=/; max-age=${7 * 86400}; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
    document.body.dataset.guest = '1';
  }
  const [{ layers: ls }, saved] = await Promise.all([
    backend.json<{ layers: LayerInfo[] }>('api/layers'),
    backend.json<Project | null>('api/project').catch(() => null),
  ]);
  // ?fresh ignores the saved project (benchmarks, smoke tests)
  const savedProject = params.has('fresh') || params.has('bench') ? null : saved;
  // layers the user took off the map stay off (the file is kept), until they are added back
  layers = ls.filter((l) => !savedProject?.removed?.includes(l.id));
  project = mergeProject(savedProject);
  const firstSeen = layers.map((l) => l.id).filter((id) => !savedProject?.layers?.[id]);
  $('#edition').textContent = backend.edition === 'web' ? 'Web edition · Axum' : 'Desktop edition · Tauri';
  if (guestMode) {
    const e = $('#edition');
    e.textContent = 'Guest demo';
    e.title = 'Your own workspace, kept in this browser for 7 days. R/Python code, installs and folders are in the full app.';
    const a = Object.assign(document.createElement('a'), { href: 'https://geospax.in4metrix.dev/#download', target: '_blank', rel: 'noopener', textContent: 'Get the full app', className: 'guest-cta' });
    e.after(a);
  }

  const hasHashView = /[#&]view=/.test(location.hash);
  const pv = (params.get('view') ?? '').split('/').map(Number);
  const urlView = pv.length === 3 && pv.every(Number.isFinite) ? { zoom: pv[0], center: [pv[2], pv[1]] as [number, number] } : null;
  // no saved view: open on the data itself (fitted once the map exists), not on a fixed place
  const fitOnLoad = !urlView && !hasHashView && !project.view && !params.has('bench');
  const view = urlView ?? (!hasHashView && project.view ? project.view : { center: [144.25, -5.87] as [number, number], zoom: fitOnLoad ? 1 : 12.5 });
  // a fresh start opens on the whole globe, then flies to the project (not for links to a view,
  // reloads, benches or automated tests)
  // an empty map (a clean start) opens on the whole Earth, the globe filling the map
  const startEmpty = !urlView && !hasHashView && !project.view && !project.order.some((id) => layerById(id) || id.startsWith('r:'));
  const intro = !urlView && !hasHashView && !params.has('bench') && !params.has('nointro') && !navigator.webdriver && mapProjection === 'globe';
  const ua = navigator.userAgent;
  const webkitGtk = /Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrom/.test(ua);
  const preserveBuffer = params.has('glpdb') ? params.get('glpdb') === '1' : webkitGtk;
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: view.center,
    zoom: intro ? 1.6 : startEmpty ? globeZoom() : view.zoom,
    hash: params.has('bench') ? false : 'view',
    attributionControl: { compact: true, customAttribution: 'GeoSpaX · Natural Earth (public domain)' },
    // WebKitGTK (Tauri on Linux) randomly drops whole tiles with the default drawing buffer:
    // MapLibre's tile state is complete and WebGL reports no errors, but some tiles never reach
    // the screen (README finding 17). preserveDrawingBuffer (or MSAA) avoids it. Elsewhere it stays
    // off (it costs a frame copy, more on tile-based GPUs). Override with ?glpdb=0|1, ?glaa=1.
    canvasContextAttributes: { antialias: params.get('glaa') === '1', preserveDrawingBuffer: preserveBuffer },
  });
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  scaleControl = new maplibregl.ScaleControl({ unit: prefs.units });
  map.addControl(scaleControl, 'bottom-left');
  (window as unknown as { map: maplibregl.Map }).map = map;
  map.on('moveend', () => saveProject());
  // point shapes other than circles are SDF icons, made when a layer first asks for one
  map.on('styleimagemissing', (e) => {
    const id = (e as unknown as { id: string }).id;
    if (id.startsWith(ICON_PREFIX) && !map.hasImage(id)) map.addImage(id, sdfImage(id.slice(ICON_PREFIX.length) as Shape), { sdf: true, pixelRatio: 2 });
    if (id.startsWith(HATCH_PREFIX) && !map.hasImage(id)) map.addImage(id, hatchImage(id), { pixelRatio: 2 });
  });
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
    layerName: (id) => { const l = layerById(id); return l ? friendlyName(l, layers) : id; },
    zoomTo: (id) => fitLayer(id),
    openTable: (id) => { void attributesPane?.open(id); workbench?.showTab('right', 'attributes'); },
    remove: (id) => void removeLayer(id),
    deleteOverviews: async (id) => {
      await backend.json(`api/layers/${id}/overviews`, { method: 'DELETE' });
      jobs.delete(id);
      await reloadLayers();
    },
  });
  wireContents();
  wireInspector();
  wireRasterViews();
  // a vector layer selected anywhere takes the panes back from the raster
  document.addEventListener('geospax:active', (e) => { if (!String((e as CustomEvent<string>).detail ?? '').startsWith('r:')) clearRaster(); });
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
    changed: () => onRastersChanged(),
    style: (r) => void rasterStyle(r.id),
  });
  rasterPane.reload().then(applyStyle);

  // Automation (docs/AUTOMATION.md): when a recipe run finishes, its layers and the styles AutoMap
  // chose appear on the map, and the view moves to them.
  const automate = new AutomatePane($('#automate'), backend, {
    onRunFinished: async (run: RunInfo) => {
      // Finish my map: show the result as soon as it is ready
      if ((run as unknown as { recipe?: string }).recipe === FINISH_RECIPE) {
        finishMap?.runFinished(run.status === 'done', (run as unknown as { error?: string }).error);
        const want = finishMap?.wanted ?? null;
        if (finishMap) finishMap.wanted = null;
        if (run.status === 'done' && want) {
          // Share › Export map › PDF, PNG, SVG or Word report: save that file straight away
          const ext = { pdf: '.pdf', png: '.png', svg: '.svg', report: '.docx' }[want];
          const name = run.artifacts.find((a) => a.toLowerCase().endsWith(ext));
          if (name) {
            try {
              const { bytes, headers } = await backend.binary(`api/runs/${encodeURIComponent(run.id)}/files/${encodeURIComponent(name)}`);
              saveBlob(name, new Blob([bytes], { type: headers.get('Content-Type') ?? 'application/octet-stream' }));
              workbench?.setStatus(`${name} saved (Share › Export map)`, 8000);
            } catch (e) {
              workbench?.setStatus(`The map was made but ${name} could not be saved: ${e instanceof Error ? e.message : e}`, 10000);
              void openRunReport(run.id);
            }
          } else {
            workbench?.setStatus('The map is finished: the report has the files', 8000);
            void openRunReport(run.id);
          }
        } else if (run.status === 'done') {
          workbench?.setStatus('Your map is finished: the report has the map, the PDF and the files', 8000);
          void openRunReport(run.id);
        } else workbench?.setStatus(`The map could not be finished: ${(run as unknown as { error?: string }).error ?? run.status}`, 10000);
        return;
      }
      if (run.status === 'failed') {
        const why = (run as unknown as { error?: string }).error;
        workbench?.setStatus(`${run.title || run.recipe || 'The run'} did not finish${why ? `: ${why}` : ''}. The run log in Automate has the details`, 10000);
      }
      await reloadLayers();
      if (rasterPane && run.rasters?.length) {
        await rasterPane.reload();
        // the main (first) map of the run decides which rasters are shown, like the report
        const steps = (run as unknown as { steps?: { outputs?: { svg?: string; rasters?: string[] } }[] }).steps ?? [];
        const main = steps.find((s) => s.outputs?.svg && Array.isArray(s.outputs?.rasters))?.outputs?.rasters;
        if (run.status === 'done') {
          rasterPane.showRun(run.rasters, main);
          if (main?.length) placeUnderVectors(main);
        }
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
      // frame the result: the run's extent, else (a run that made only rasters) its rasters
      let b = run.extent;
      if (!(b && b.every(Number.isFinite)) && run.rasters?.length && rasterPane) {
        const bs = run.rasters.map((id) => rasterPane!.byId(id)?.bounds).filter((x): x is [number, number, number, number] => !!x);
        if (bs.length) b = [Math.min(...bs.map((x) => x[0])), Math.min(...bs.map((x) => x[1])), Math.max(...bs.map((x) => x[2])), Math.max(...bs.map((x) => x[3]))];
      }
      if (b && run.status === 'done' && b.every(Number.isFinite)) {
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 19, duration: 0 });
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
  // Results made anywhere (a recipe, a Toolbox tool, the assistant, a trigger, another window) join
  // Contents as they appear, like ArcGIS Pro and QGIS add tool outputs to the map
  {
    let rev = '';
    const poll = async () => {
      try {
        const r = await backend.json<{ rev: string }>('api/rev');
        if (rev && r.rev !== rev) {
          await reloadLayers();
          await rasterPane?.reload();
        }
        rev = r.rev;
      } catch { /* engine busy or restarting */ }
      setTimeout(poll, 2500);
    };
    void poll();
  }

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
    layers: () => layers.map((l) => ({ id: l.id, name: l.name, geometry: l.geometry, fields: l.fields })),
    active: () => panel.current ?? null,
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
    showTab: (d, t) => workbench?.showTab(d, uiMode === 'lazy' && t === 'history' ? 'activity' : t),
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  void toolbox.reload();
  document.addEventListener('geospax:plugins-changed', () => void toolbox.reload());
  document.addEventListener('geospax:run-recipe', (e) => {
    workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
    void automatePane?.run((e as CustomEvent<string>).detail);
  });
  // the selected Explorer file's outline on the map (a dashed box; cleared when nothing is selected)
  // View › 3D terrain: the selected elevation raster, else the first one; again: the flat map
  document.addEventListener('geospax:terrain3d', () => {
    if (terrain3d) return setTerrain3d(null);
    const dems = (rasterPane?.all() ?? []).filter((r) => isElevation(r.kind));
    const pick = dems.find((r) => r.id === activeRaster) ?? dems[0];
    if (!pick) return void workbench?.setStatus('3D terrain needs an elevation raster: Data › Online data › Elevation, or add a DEM', 8000);
    setTerrain3d(pick.id);
  });
  document.addEventListener('geospax:footprint', (e) => {
    const b = (e as CustomEvent<[number, number, number, number] | null>).detail;
    footprint = b ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] } } : null;
    applyStyle();
    if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 14, duration: 400 });
  });
  // STAC search results outlined on the map (the opened item highlighted)
  document.addEventListener('geospax:stac-footprints', (e) => {
    stacFootprints = (e as CustomEvent<GeoJSON.FeatureCollection | null>).detail;
    applyStyle();
  });
  // features from a web service, for the area on the map, become a layer
  document.addEventListener('geospax:ws-fetch', async (e) => {
    const d = (e as CustomEvent<{ sid: string; layer: string; title: string }>).detail;
    const [w, so, ea, n] = map.getBounds().toArray().flat();
    const bbox = [Math.max(-180, w), Math.max(-85, so), Math.min(180, ea), Math.min(85, n)].map((v) => v.toFixed(5)).join(',');
    workbench?.setStatus(`Downloading ${d.title} for the map view…`);
    try {
      const r = await backend.json<{ layers: string[]; features: number }>(`api/services/${encodeURIComponent(d.sid)}/fetch?layer=${encodeURIComponent(d.layer)}&bbox=${bbox}`, { method: 'POST' });
      document.dispatchEvent(new CustomEvent('geospax:added', { detail: { layers: r.layers, rasters: [] } }));
      workbench?.setStatus(`${d.title}: ${r.features.toLocaleString()} features added`, 6000);
    } catch (err) {
      workbench?.setStatus(`${d.title}: ${err instanceof Error ? err.message : err}`, 10000);
    }
  });
  document.addEventListener('geospax:add-web-layer', (e) => {
    const d = (e as CustomEvent<{ sid: string; layer: string; title: string }>).detail;
    project.web = project.web ?? [];
    if (!project.web.some((w) => w.sid === d.sid && w.layer === d.layer)) project.web.push({ id: `${d.sid}-${project.web.length + 1}-${Date.now() % 100000}`, sid: d.sid, layer: d.layer, title: d.title, opacity: 0.85, visible: true });
    applyStyle();
    renderContents();
    saveProject();
    workbench?.setStatus(`${d.title} is on the map (Contents › Web layers)`, 5000);
  });
  // drag a file from the Explorer onto the map to add it
  const mapEl = document.querySelector<HTMLElement>('#map');
  mapEl?.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('application/x-geospax-file')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  mapEl?.addEventListener('drop', (e) => {
    const raw = e.dataTransfer?.getData('application/x-geospax-file');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const f = JSON.parse(raw) as { path: string; layer?: string };
    void workbench?.addFile(f.path, f.layer);
  });
  document.addEventListener('geospax:connect-folder', () => void workbench?.connectFolder());
  document.addEventListener('geospax:delete-runs', (e) => void workbench?.deleteRuns((e as CustomEvent<string[]>).detail));
  document.addEventListener('geospax:toolbox-search', (e) => toolbox.find((e as CustomEvent<string>).detail));
  // map tools of the Home and View tabs (mapextras.ts): coordinates, swipe, spyglass, time, grid, scale
  const extras = new MapExtras({
    map,
    backend,
    layers: () => layers,
    activeId: () => panel.current,
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
    changed: async (id) => {
      tileRev[id] = (tileRev[id] ?? 0) + 1;
      await reloadLayers();
    },
  });
  const profilePanel = new ProfilePanel({ map, backend, layers: () => layers, activeId: () => panel.current, setStatus: (t, ms) => workbench?.setStatus(t, ms) });
  // scripts and tours open it with ends named: geospax:profile { reverse, a, b }
  document.addEventListener('geospax:profile', (e) => { const d = (e as CustomEvent<{ reverse?: boolean; a?: string; b?: string }>).detail ?? {}; profilePanel.close(); void profilePanel.toggle(d); });
  document.addEventListener('geospax:x', (e) => {
    const a = (e as CustomEvent<string>).detail;
    switch (a) {
      case 'coords': return void extras.coordinates();
      case 'crs': return void extras.coordinateSystem();
      case 'swipe': case 'spyglass': return extras.toggleCompare(a);
      case 'time': return void extras.timeSlider();
      case 'grid': return extras.toggleGrid();
      case 'scale': return void extras.goToScale();
      case 'lockscale': return extras.toggleScaleLock();
      case 'labels': return toggleLabels();
      case 'profile': return void profilePanel.toggle();
    }
    if (a.startsWith('download:')) return void share.download(a.slice(9));
    switch (a) {
      case 'publish': return void share.publishWebMap();
      case 'package': return void share.packageProject();
      case 'print': return share.print();
      case 'survey': return void share.surveyPoints();
      case 'areas': return void share.areaTable();
      case 'hatch': return void share.hatch();
    }
    document.dispatchEvent(new CustomEvent('geospax:x2', { detail: a }));
  });
  const tutorials = new Tutorials();
  document.addEventListener('geospax:tutorials', () => tutorials.chooser());
  const share = new ShareExtras({
    backend,
    layers: () => layers,
    activeId: () => panel.current,
    project: () => project,
    visible: () => project.order.filter((id) => layerById(id) && shownOnMap(id)),
    view: () => ({ center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() }),
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
    applyStyle: () => applyStyle(),
    saveProject: () => saveProject(),
    reload: () => reloadLayers(),
    openUrl: (p) => window.open(p, '_blank'),
  });
  /** Home › Labels: the selected layer's labels on or off (first text field when it has none yet). */
  function toggleLabels() {
    const id = panel.current;
    const st = id ? project.layers[id] : undefined;
    const l = id ? layerById(id) : undefined;
    if (!id || !st || !l) return workbench?.setStatus('Pick a layer in Contents first.');
    if (st.labels?.on) st.labels.on = false;
    else {
      const field = st.labels?.field || l.fields.find((f) => f.kind === 'string')?.name || l.fields[0]?.name;
      if (!field) return workbench?.setStatus(`${l.name} has no fields to label with.`);
      st.labels = { ...(st.labels ?? defaultLabels(field)), field, on: true };
    }
    applyStyle();
    saveProject();
    workbench?.setStatus(`Labels ${st.labels?.on ? `on (${st.labels.field})` : 'off'} · ${l.name}`);
  }
  // a ribbon button that opens one tool (commands.ts toolCmd)
  document.addEventListener('geospax:open-tool', (e) => {
    const { keys, search } = (e as CustomEvent<{ keys: string[]; search: string }>).detail;
    workbench?.showTab('right', 'toolbox');
    void toolbox.openTool(keys).then((ok) => { if (!ok) toolbox.find(search); });
  });
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
  wireProjects({
    backend,
    get: () => project,
    layerIds: () => layers.map((l) => l.id),
    flush: flushProject,
    hold: () => { saveHeld = true; clearTimeout(saveTimer); },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
    guest: guestMode,
    // ?fresh (UI tests) ignores the saved project: open the switched-to one without it
    reloadUrl: () => { const u = new URL(location.href); u.searchParams.delete('fresh'); u.hash = ''; return u.toString(); },
  });
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
    rules: (id) => project.attrRules?.[id] ?? {},
    setRules: (id, r) => {
      project.attrRules = { ...(project.attrRules ?? {}), [id]: r };
      saveProject();
    },
  });
  attributesPane?.attachEditor(editor);
  // Ctrl+C / Ctrl+V on the map copy and paste the selected features (Edit › Clipboard)
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable]') || !(e.ctrlKey || e.metaKey) || window.getSelection()?.toString()) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && panel.current && editor!.selected(panel.current).length) { e.preventDefault(); void editor!.copySelected(); }
    else if (k === 'v') { e.preventDefault(); void editor!.paste(); }
  });
  (window as unknown as { editor: Editor }).editor = editor;
  document.addEventListener('geospax:edit', (e) => {
    const ed = editor!;
    const a = (e as CustomEvent<string>).detail;
    const id = panel.current;
    switch (a) {
      case 'point': case 'line': case 'polygon': case 'select': case 'box': case 'vertices': case 'lasso':
        return void ed.setTool(ed.tool === a ? 'idle' : a);
      case 'split': case 'merge': case 'cut': case 'reshape': return void ed.geometryEdit(a);
      case 'copy': return void ed.copySelected();
      case 'paste': return void ed.paste();
      case 'copy-along': return void ed.copyAlongLine();
      case 'gps-point': return void ed.pointFromGps();
      case 'rules': return void ed.attributeRules();
      case 'trace':
        ed.tracing = !ed.tracing;
        document.body.dataset.tracing = ed.tracing ? 'on' : 'off';
        return workbench?.setStatus(ed.tracing ? 'Trace on: snap two vertices of the same feature and the new edge follows it' : 'Trace off');
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
      { label: 'Remove from map', danger: true, hint: 'The file is kept; add it again from the Explorer', run: () => void removeLayer(id) },
      { label: 'Properties…', run: () => void layerProperties(id) },
    ];
    showMenu(x, y, l.name, items);
    return true;
  };
  onContextMenu($('#contents'), (t, x, y) => {
    const rid = t.closest<HTMLElement>('.layer.raster, .raster-card')?.dataset.id;
    if (rid) return rasterMenu(rid, x, y);
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
        { label: workbench?.isFavourite(path) ? 'Remove from Favourites' : 'Add to Favourites', run: () => workbench?.toggleFavourite(path, path.split(/[\\/]/).pop() ?? path, false) },
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
        { label: workbench?.isFavourite(path) ? 'Remove from Favourites' : 'Add to Favourites', run: () => workbench?.toggleFavourite(path, path.split(/[\\/]/).pop() ?? path, true) },
        { label: 'Add files to it…', hint: 'Files you add are saved in your first data folder', run: () => void document.dispatchEvent(new CustomEvent('geospax:browse')) },
        ...(folder.classList.contains('conn') ? [{ label: 'Remove this folder connection', hint: 'The folder and its files are not touched', run: () => void workbench?.disconnectFolder(path) }] : []),
        { label: 'Connect a folder…', run: () => void workbench?.connectFolder() },
        { label: 'Refresh', run: () => void workbench?.refreshCatalog() },
      ]);
      return true;
    }
    if (t.closest('.node.source')) {
      showMenu(x, y, 'Explorer', [
        { label: 'Add files…', run: () => void document.dispatchEvent(new CustomEvent('geospax:browse')) },
        { label: 'Connect a folder…', run: () => void workbench?.connectFolder() },
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
    layerName: (id) => { const l = layerById(id); return l ? friendlyName(l, layers) : id; },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
    activeId: () => panel.current,
  }, $('#ask'));
  document.addEventListener('geospax:ask-settings', () => void askPane.openSettings());
  document.addEventListener('geospax:ask', (e) => {
    workbench?.showTab('right', 'ask');
    void askPane.ask((e as CustomEvent<string>).detail);
  });
  document.addEventListener('geospax:bookmark', () => void projectPane?.addBookmark());
  document.addEventListener('geospax:settings', () => void openSettings());
  document.addEventListener('geospax:basemap-gallery', () => void basemapGallery());
  // Home › Navigate: previous and next extent (as ArcGIS Pro), from the views the map has shown
  {
    const views: { c: [number, number]; z: number }[] = [];
    let at = -1;
    let stepping = false;
    map.on('moveend', () => {
      if (stepping) return void (stepping = false);
      const v = { c: map.getCenter().toArray() as [number, number], z: map.getZoom() };
      const last = views[at];
      if (last && Math.abs(last.z - v.z) < 1e-3 && Math.abs(last.c[0] - v.c[0]) < 1e-7 && Math.abs(last.c[1] - v.c[1]) < 1e-7) return;
      views.splice(at + 1);
      views.push(v);
      if (views.length > 50) views.shift();
      at = views.length - 1;
    });
    const step = (d: -1 | 1) => {
      const to = views[at + d];
      if (!to) return workbench?.setStatus(d < 0 ? 'No previous extent' : 'No next extent', 3000);
      at += d;
      stepping = true;
      map.easeTo({ center: to.c, zoom: to.z, duration: 400 });
    };
    document.addEventListener('geospax:extent', (e) => step((e as CustomEvent<string>).detail === 'back' ? -1 : 1));
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') (e.preventDefault(), step(-1));
      else if (e.key === 'ArrowRight') (e.preventDefault(), step(1));
    });
  }
  // Home › Go To XY and Find place
  document.addEventListener('geospax:goto', () => void goToXY());
  document.addEventListener('geospax:find-place', () => void findPlace());
  document.querySelector('#settings-btn')?.addEventListener('click', () => void openSettings());
  document.addEventListener('geospax:remove-layer', (e) => void removeLayer((e as CustomEvent<string>).detail));
  document.addEventListener('geospax:added', (e) => {
    const r = (e as CustomEvent<{ layers: string[]; rasters: string[] }>).detail;
    void addedToMap(r.layers, r.rasters);
  });
  // Map › Measure: distance and area (web/src/measure.ts)
  const measure = new Measure(map);
  document.addEventListener('geospax:measure', (e) => {
    const m = (e as CustomEvent<string>).detail;
    if (m === 'clear') { measure.stop(); workbench?.setStatus('Measurements cleared', 3000); return; }
    void editor?.setTool('idle'); // one map tool at a time
    measure.start(m as 'distance' | 'area');
  });
  // open on something useful: the top layer's symbology, ready to edit
  if (project.order.length) {
    panel.open(project.order[project.order.length - 1]);
    renderContents();
  }
  (window as unknown as { workbench: Workbench | null }).workbench = workbench;
  (window as unknown as { toolbox: Toolbox }).toolbox = toolbox;
  if (startEmpty) intro && setTimeout(() => map.easeTo({ zoom: globeZoom(), duration: 2000 }), 500);
  else if (fitOnLoad) intro ? setTimeout(() => fitAll(3000), 700) : fitAll();
  else if (intro) setTimeout(() => map.flyTo({ center: view.center, zoom: view.zoom, duration: 3000, essential: true }), 700);

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
  new DownloadGauge(backend, (id) => void openRunReport(id));
  // Design tab: CAD-style drafting into "Design · …" layers, traverse, DXF (cad.ts)
  new CadDesigner({
    map,
    backend,
    layers: () => layers,
    changed: async (id) => {
      tileRev[id] = (tileRev[id] ?? 0) + 1;
      await reloadLayers();
    },
    labels: (id, field, placement) => {
      const st = project.layers[id];
      if (!st) return;
      st.labels = { ...defaultLabels(field), on: true, placement, color: '#ffd166', haloColor: '#0b0d10', haloWidth: 1.5 };
      applyStyle();
      saveProject();
    },
    blocks: () => project.cadBlocks ?? [],
    setBlocks: (b) => {
      project.cadBlocks = b;
      saveProject();
    },
    inserts: () => project.cadInserts ?? [],
    setInserts: (v) => {
      project.cadInserts = v;
      saveProject();
    },
    props: (id) => {
      const st = project.layers[id];
      if (!st) return null;
      const color = st.symbology.kind === 'single' ? st.symbology.color : '#ffffff';
      const dash = (st.line?.dash ?? st.fill?.strokeDash ?? 'solid') as 'solid' | 'dashed' | 'dotted';
      return { color, width: st.line?.width ?? st.fill?.strokeWidth ?? 1, dash: ['dashed', 'dotted'].includes(dash) ? dash : 'solid', visible: !!st.visible, hollow: st.fill?.fill === false };
    },
    setProps: (id, p) => {
      const st = project.layers[id];
      if (!st) return;
      styledByTool.add(id);
      delete st.auto;
      if (p.visible !== undefined) st.visible = p.visible;
      if (p.color) {
        st.symbology = { kind: 'single', color: p.color };
        if (st.fill?.fill === false) st.fill.strokeColor = p.color;
      }
      if (p.width !== undefined) {
        if (st.line) st.line.width = p.width;
        if (st.fill) st.fill.strokeWidth = p.width;
      }
      if (p.dash) {
        if (st.line) st.line.dash = p.dash as typeof st.line.dash;
        if (st.fill) st.fill.strokeDash = p.dash as typeof st.fill.strokeDash;
      }
      if (p.hollow !== undefined && st.fill) {
        st.fill.fill = !p.hollow;
        st.fill.strokeColor = p.hollow ? (st.symbology.kind === 'single' ? st.symbology.color : st.fill.strokeColor) : '#ffffff';
      }
      applyStyle();
      saveProject();
      renderContents();
    },
    locked: () => project.cadLocked ?? [],
    hatch: (id) => { const f = project.layers[id]?.fill; return f?.fill !== false ? f?.pattern : undefined; },
    setLocked: (ids) => {
      project.cadLocked = ids;
      saveProject();
    },
    look: (id, look) => {
      const st = project.layers[id];
      if (!st) return;
      styledByTool.add(id);
      st.symbology = { kind: 'single', color: look.color };
      st.opacity = look.opacity ?? 1;
      st.outline = true;
      delete st.auto;
      const dash = look.dash ?? 'solid';
      st.line = { ...(st.line ?? { cap: 'round', join: 'round' }), width: look.width, dash } as typeof st.line;
      st.fill = { fill: !look.hollow, strokeColor: look.hollow ? look.color : '#ffffff', strokeWidth: look.width, strokeDash: dash } as typeof st.fill;
      applyStyle();
      saveProject();
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  // Explorer › a STAC catalog › a collection: search imagery for the area (stac.ts)
  new StacSearch({
    backend,
    view: () => {
      const [w, so, e, n] = map.getBounds().toArray().flat();
      return [Math.max(-180, w), Math.max(-85, so), Math.min(180, e), Math.min(85, n)];
    },
    drawBox: () => drawBoxOnMap(),
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  new OnlineData({
    backend,
    // a globe zoomed out can report bounds past the poles or the date line: keep them on the Earth
    view: () => {
      const [w, so, e, n] = map.getBounds().toArray().flat();
      return [Math.max(-180, w), Math.max(-85, so), Math.min(180, e), Math.min(85, n)];
    },
    layers: () => project.order.filter((id) => layerById(id)).reverse(),
    layerInfo: (id) => {
      const l = layerById(id);
      const kind = l?.geometry === 'polygon' ? 'polygons' : l?.geometry === 'line' ? 'lines' : 'points';
      return { label: l ? friendlyName(l, layers) : id, kind };
    },
    drawBox: () => drawBoxOnMap(),
    run: async (id) => {
      workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
      await automatePane?.run(id);
    },
    setStatus: (t, ms) => workbench?.setStatus(t, ms),
  });
  // Imagery › Detect objects and Models… (models.ts)
  const modelsHost = {
    backend,
    run: async (id: string) => {
      workbench?.showTab('bottom', uiMode === 'lazy' ? 'activity' : 'automate');
      await automatePane?.run(id);
    },
    setStatus: (t: string, ms?: number) => workbench?.setStatus(t, ms),
  };
  document.addEventListener('geospax:detect', () => void openDetect(modelsHost));
  document.addEventListener('geospax:models', () => void openModels(modelsHost));
  // Data › Check species names (taxa.ts): WoRMS
  document.addEventListener('geospax:worms', () => void openWorms({
    backend,
    layers: () => layers.map((l) => ({ id: l.id, name: l.name, fields: l.fields })),
    active: () => panel.current ?? null,
    run: modelsHost.run,
    setStatus: modelsHost.setStatus,
  }));
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
  document.addEventListener('geospax:finish', (e) => {
    const fmt = (e as CustomEvent<string | null>).detail;
    if (fmt === 'png' || fmt === 'pdf' || fmt === 'svg' || fmt === 'report') finish.openFor(fmt);
    else finish.open();
  });
  document.addEventListener('geospax:layout', () => void finish.openLayout());
  finishMap = finish;
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
