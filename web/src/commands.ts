// Command registry — every ribbon button, keyboard shortcut and palette entry is a
// command. The shell (workbench.ts) only knows how to render commands, never what they
// do, so the same command can live in the ribbon, the palette, a context menu or a
// script. Pattern borrowed from RustGIS (Apache-2.0, https://github.com/opengeos/RustGIS),
// which registers every action in `crates/engine/src/cmd/`.
import type * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';
import type { RecipeInfo } from './automate';

/** 'layer' is the contextual tab (Pro mode), shown while a layer is selected. */
export type TabId = 'home' | 'data' | 'style' | 'edit' | 'analyze' | 'imagery' | 'modelling' | 'r' | 'view' | 'automate' | 'help' | 'plugins' | 'layer';

/** What a command can reach: the map, layers, the backend and a few host actions. */
export interface CommandHost {
  backend: Backend;
  map: maplibregl.Map;
  layers: () => LayerInfo[];
  activeId: () => string | null;
  setActive: (id: string | null) => void;
  fitLayer: (id: string) => void;
  fitAll: () => void;
  autostyle: (id: string) => Promise<void>;
  reload: () => Promise<void>;
  save: () => void;
  recipes: () => Promise<RecipeInfo[]>;
  runRecipe: (id: string) => Promise<void>;
  openRun: (runId: string) => void;
  showTab: (dock: 'left' | 'right' | 'bottom', tab: string) => void;
  toggleDock: (dock: 'left' | 'right' | 'bottom') => void;
  bench: () => void;
  deck: () => void;
  setStatus: (text: string, ms?: number) => void;
  log: (line: string, level?: 'info' | 'warn' | 'error') => void;
  openUrl: (path: string) => void;
  /** Help › About GeoSpaX */
  about: () => void;
  /** true = big galleries collapse into a single dropdown button (default). */
  setRibbonCompact: (compact: boolean) => void;
  /** Switch between a ribbon that is always open and one that opens on a tab click. */
  toggleRibbon: () => void;
}

export interface Command {
  id: string;
  tab: TabId;
  group: string;
  title: string;
  icon: string;
  hint?: string;
  keys?: string;
  /** Big button (icon over label) instead of a compact row. */
  big?: boolean;
  run: (h: CommandHost) => void | Promise<void>;
}

// 24×24 monochrome glyphs; the ribbon tints them with `currentColor`.
export const ICONS: Record<string, string> = {
  refresh: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7V4M8 14h8v7H8z',
  layers: 'M12 3l9 5-9 5-9-5 9-5zm0 18L3 16l3-1.7 6 3.3 6-3.3L21 16l-9 5z',
  zoomTo: 'M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5',
  zoomIn: 'M10 4a6 6 0 1 0 3.9 10.6L20 21l1-1-5.4-5.4A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-1 3h2v2h2v2h-2v2H9v-2H7v-2h2z',
  zoomOut: 'M10 4a6 6 0 1 0 3.9 10.6L20 21l1-1-5.4-5.4A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM7 9h6v2H7z',
  leaf: 'M4 21c0-1 .2-2 .5-3C3.6 11 9.5 4 20 3c-.5 10.5-7.4 16.5-14.6 15.6-.3 1-.4 1.6-.4 2.4zm3-5c2.5-3 5.5-6 9-8.5C12.5 9 9.5 12 7 16z',
  wave: 'M2 8c2 0 3-2 5-2s3 2 5 2 3-2 5-2 3 2 5 2v2c-2 0-3-2-5-2s-3 2-5 2-3-2-5-2-3 2-5 2zm0 6c2 0 3-2 5-2s3 2 5 2 3-2 5-2 3 2 5 2v2c-2 0-3-2-5-2s-3 2-5 2-3-2-5-2-3 2-5 2z',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.5 2 2.4 4.4 2.4 8S13.5 20 12 22c-1.5-2-2.4-4.4-2.4-8S10.5 4 12 4zM2.6 11h18.8M2.6 14h18.8',
  table: 'M3 4h18v16H3zM3 9h18M3 14h18M9 9v11M15 9v11',
  palette: 'M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2s-.7-1.8-.7-2.6c0-.9.7-1.4 1.7-1.4H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 10.5a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm3 4a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm5-1a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4z',
  wand: 'M5 19L16 8l1.5 1.5L7.5 20H5zM15 3l1.5 3.5L20 8l-3.5 1.5L15 13l-1.5-3.5L10 8l3.5-1.5zM18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  chart: 'M3 19.5h18V21H3zM5 12h3v6.5H5zM10.5 5h3v13.5h-3zM16 9h3v9.5h-3z',
  hotspot: 'M12 2a6 6 0 0 0-3.5 10.9c.5 2.6 1.6 4.4 3.5 6.1 1.9-1.7 3-3.5 3.5-6.1A6 6 0 0 0 12 2zm0 8.5A2.5 2.5 0 1 1 12 7a2.5 2.5 0 0 1 0 5.5z',
  play: 'M7 4l13 8-13 8z',
  history: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.6l4 2.3-1 1.7-5-2.9V7z',
  camera: 'M4 7h4l1.5-2h5L16 7h4v13H4zM12 9a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  phone: 'M7 2h10v20H7zM9 5h6v12H9zM11 19h2',
  satellite: 'M12 3l2.5 4.5L19 8l-3 5 3 5-4.5-1.5L12 21l-2.5-4.5L5 18l3-5-3-5 4.5.5z',
  image: 'M3 5h18v14H3zm2 12h14l-4-5-3 3.5-2-2zM8.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  download: 'M11 3h2v9l3-3 1.5 1.5L12 16 6.5 10.5 8 9l3 3zM5 19h14v2H5z',
  print: 'M7 8V3h10v5h4v8h-4v5H7v-5H3V8zm2 8h6v5H9z',
  layout: 'M3 4h18v16H3zm2 2v12h4V6zm6 0v12h8V6z',
  fullscreen: 'M4 4h7v2H6v5H4zM20 4h-7v2h5v5h2zM4 20h7v-2H6v-5H4zM20 20h-7v-2h5v-5h2z',
  book: 'M4 4h7v16H4zm9 0h7v16h-7zM6 7h3v2H6zm9 0h3v2h-3z',
  terminal: 'M3 4h18v16H3zm3 4l3 3-3 3M11 14h6',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.6l4 2.3-1 1.7-5-2.9V7z',
  search: 'M10 3a7 7 0 1 0 4.2 12.6L20 21l1.4-1.4-5.6-5.6A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z',
  pin: 'M10 2h4a1 1 0 0 1 1 1v.6l-1.4 1.4V15a1 1 0 0 1-1 1H8.4a1 1 0 0 1-1-1V5L6 3.6V3a1 1 0 0 1 1-1h3zm-1 17h6v2H9z',
  caret: 'M6 9.5l6 5.5 6-5.5z',
  gallery: 'M3 4h8v7H3zm10 0h8v7h-8zM3 13h8v7H3zm10 0h8v7h-8z',
  grid: 'M3 3h18v18H3zm2 2v4h4V5zm6 0v4h4V5zm6 0v4h2V5zM5 11v4h4v-4zm6 0v4h4v-4zm6 0v4h2v-4zM5 17v2h4v-2zm6 0v2h4v-2zm6 0v2h2v-2z',
  rlogo: 'M12 3C6.5 3 2 5.9 2 9.6c0 3.1 3.2 5.7 7.5 6.4V21h3v-4.4h1.6l2.6 4.4h3.4l-3-4.9c2.3-.9 3.9-2.6 3.9-4.6 0-3.7-4.5-6.6-10-6.6zm.5 3.2c4.3 0 7.3 1.5 7.3 3.6 0 1.4-1.3 2.5-3.4 3.1V10c0-1.5-1.3-2.4-3.2-2.4H9.5v6.1C6.5 13 4.6 11.5 4.6 9.7c0-2 3.4-3.5 7.9-3.5zm0 4h1.6c.7 0 1.1.3 1.1.9s-.4.9-1.1.9h-1.6z',
  check: 'M4 12l5 5L20 6l-1.5-1.5L9 13.5 5.5 10z',
  // editing
  point: 'M12 2a6 6 0 0 0-6 6c0 4.5 6 12 6 12s6-7.5 6-12a6 6 0 0 0-6-6zm0 8.2A2.2 2.2 0 1 1 12 5.8a2.2 2.2 0 0 1 0 4.4z',
  line: 'M4 18.6L9.2 9l5 5.5L19 5.4l1.7 1-6.2 11.4-5-5.5-3.8 7.3zM4 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm16-14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  polygon: 'M12 2l9 6.5-3.4 11.5H6.4L3 8.5zm0 2.5L5.3 9.3 7.9 18h8.2l2.6-8.7z',
  vertices: 'M5 4h4v4H5zM15 4h4v4h-4zM15 16h4v4h-4zM5 16h4v4H5zM7 8h2v8H7zm2-3h6v2H9zm8 3h2v8h-2zM9 17h6v2H9z',
  select: 'M5 3l13 7.5-5.5 1.6 3.8 6.6-2.4 1.4-3.8-6.6L6 17.5z',
  box: 'M3 3h4v2H5v2H3zm6 0h6v2H9zm8 0h4v4h-2V5h-2zM3 9h2v6H3zm16 0h2v6h-2zM3 17h2v2h2v2H3zm16 0h2v4h-4v-2h2zM9 19h6v2H9z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7zm4 2v9h1.5v-9zm3 0v9h1.5v-9z',
  undo: 'M8 5L3 10l5 5v-3.5h6a4 4 0 0 1 0 8h-3V22h3a6.5 6.5 0 0 0 0-13H8z',
  redo: 'M16 5l5 5-5 5v-3.5h-6a4 4 0 0 0 0 8h3V22h-3a6.5 6.5 0 0 1 0-13h6z',
  magnet: 'M5 3h4v8a3 3 0 0 0 6 0V3h4v8a7 7 0 0 1-14 0zm0 0v3h4V3zm10 0v3h4V3z',
  folder: 'M3 5h7l2 2h9v12H3z',
  chat: 'M4 4h16v11H9l-5 4zm4 4v2h8V8zm0 3v1h5v-1z',
  settings: 'M10.5 2h3l.5 2.6 1.9.8 2.2-1.5 2.1 2.1-1.5 2.2.8 1.9 2.6.5v3l-2.6.5-.8 1.9 1.5 2.2-2.1 2.1-2.2-1.5-1.9.8-.5 2.6h-3l-.5-2.6-1.9-.8-2.2 1.5-2.1-2.1 1.5-2.2-.8-1.9L2 13.5v-3l2.6-.5.8-1.9-1.5-2.2 2.1-2.1 2.2 1.5 1.9-.8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  filter: 'M3 4h18l-7 8.5V19l-4 2v-8.5z',
  calc: 'M5 2h14v20H5zm2 2v4h10V4zm0 6v2h2v-2zm4 0v2h2v-2zm4 0v6h2v-6zM7 14v2h2v-2zm4 0v2h2v-2zm-4 4v2h2v-2zm4 0v2h6v-2z',
  clear: 'M6 5l6 6 6-6 1.4 1.4-6 6 6 6L18 19.8l-6-6-6 6L4.6 18.4l6-6-6-6z',
  export: 'M12 3l5 5h-3.5v7h-3V8H7zM4 17h16v4H4z',
  form: 'M4 3h16v18H4zm3 4v2h10V7zm0 4v2h10v-2zm0 4v2h6v-2z',
  ruler: 'M2 15.5L15.5 2 22 8.5 8.5 22zm3 0l3.5 3.5 1-1-1.5-1.5 1-1 1.5 1.5 1-1-1.5-1.5 1-1L12 15l1-1-1.5-1.5 1-1L14 13l1-1-1.5-1.5 1-1L16 11l1-1-3.5-3.5z',
  area: 'M3 5l7-2 11 4-2 12-9 2-7-6zm2 1.6l1.8 7 5.3 4.6 5.5-1.2 1.4-8.6-8.1-3z',
};

export function icon(name: string, size = 20): string {
  const d = ICONS[name] ?? ICONS.check;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
}

// Ribbon tabs, in ArcGIS Pro's order of work: get data, map it, analyse, imagery, model, automate.
export const TABS: { id: TabId; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'data', label: 'Data' },
  { id: 'style', label: 'Map' },
  { id: 'edit', label: 'Edit' },
  { id: 'analyze', label: 'Analysis' },
  { id: 'imagery', label: 'Imagery' },
  { id: 'modelling', label: 'Modelling' },
  { id: 'r', label: 'R' },
  { id: 'automate', label: 'Automate' },
  { id: 'view', label: 'View' },
  { id: 'help', label: 'Help' },
  { id: 'plugins', label: 'Plugins' },
];

/** A command that runs a gallery recipe by id. */
const recipeCmd = (id: string, tab: TabId, group: string, title: string, icon: string, recipe: string, hint: string, big = false): Command => ({
  id,
  tab,
  group,
  title,
  icon,
  hint,
  big,
  run: async (h) => {
    const r = await h.recipes();
    if (r.some((x) => x.id === recipe)) await h.runRecipe(recipe);
    else h.setStatus(`Recipe '${recipe}' is not installed`, 5000);
  },
});

/** A command that opens the online-data form for a source (web/src/online.ts). */
const onlineCmd = (id: string, title: string, icon: string, source: string, hint: string, big = false): Command => ({
  id,
  tab: 'data',
  group: 'Online data',
  title,
  icon,
  hint,
  big,
  run: () => { document.dispatchEvent(new CustomEvent('geospax:online', { detail: source })); },
});

/** A command on the R tab: R setup or the R console on a template (web/src/rconsole.ts). */
const rCmd = (id: string, group: string, title: string, icon: string, what: string, hint: string, big = false): Command => ({
  id,
  tab: 'r',
  group,
  title,
  icon,
  hint,
  big,
  run: () => { document.dispatchEvent(new CustomEvent('geospax:r', { detail: what })); },
});

// ---------------------------------------------------------------- commands

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface LayerStyleLite { symbology?: { kind?: string } }

/** Editing and selection commands are handled by web/src/editing.ts via this event. */
const editCmd = (action: string) => () => { document.dispatchEvent(new CustomEvent('geospax:edit', { detail: action })); };

const measureCmd = (mode: string) => () => { document.dispatchEvent(new CustomEvent('geospax:measure', { detail: mode })); };
const MEASURE: Command[] = [
  { id: 'measure.distance', tab: 'style', group: 'Measure', title: 'Distance', icon: 'ruler', big: true, hint: 'Click points on the map: total and segment lengths (geodesic)', run: measureCmd('distance') },
  { id: 'measure.area', tab: 'style', group: 'Measure', title: 'Area', icon: 'area', big: true, hint: 'Click points on the map: area and perimeter (geodesic)', run: measureCmd('area') },
  { id: 'measure.clear', tab: 'style', group: 'Measure', title: 'Clear', icon: 'clear', run: measureCmd('clear') },
];

const SELECTION: Command[] = [
  { id: 'sel.attributes', tab: 'edit', group: 'Selection', title: 'By attributes', icon: 'filter', big: true, hint: 'Select features with an SQL query (field, operator, value)', run: editCmd('select-attributes') },
  { id: 'sel.location', tab: 'edit', group: 'Selection', title: 'By location', icon: 'hotspot', big: true, hint: 'Select features that intersect, lie within, contain or are near another layer', run: editCmd('select-location') },
  { id: 'sel.zoom', tab: 'edit', group: 'Selection', title: 'Zoom to selected', icon: 'zoomTo', run: editCmd('zoom-selection') },
  { id: 'sel.clear', tab: 'edit', group: 'Selection', title: 'Clear selection', icon: 'clear', run: editCmd('clear-selection') },
];

export const COMMANDS: Command[] = [
  // ---- Edit (ArcGIS Pro's Edit tab): create, modify, selection, fields, manage edits
  { id: 'edit.point', tab: 'edit', group: 'Create', title: 'Point', icon: 'point', big: true, hint: 'Click to add points to the active layer', run: editCmd('point') },
  { id: 'edit.line', tab: 'edit', group: 'Create', title: 'Line', icon: 'line', big: true, hint: 'Click vertices, double-click to finish', run: editCmd('line') },
  { id: 'edit.polygon', tab: 'edit', group: 'Create', title: 'Polygon', icon: 'polygon', big: true, hint: 'Click vertices, double-click or click the first point to close', run: editCmd('polygon') },
  { id: 'edit.select', tab: 'edit', group: 'Modify', title: 'Select', icon: 'select', big: true, keys: 'S', hint: 'Click features to select them (Shift adds, Ctrl removes)', run: editCmd('select') },
  { id: 'edit.box', tab: 'edit', group: 'Modify', title: 'Select by rectangle', icon: 'box', hint: 'Select the active layer\'s features inside a box', run: editCmd('box') },
  { id: 'edit.vertices', tab: 'edit', group: 'Modify', title: 'Edit vertices', icon: 'vertices', hint: 'Reshape or move the selected feature; Enter saves', run: editCmd('vertices') },
  { id: 'edit.attributes', tab: 'edit', group: 'Modify', title: 'Attributes', icon: 'form', hint: 'Edit the selected feature\'s attributes', run: editCmd('attributes') },
  { id: 'edit.delete', tab: 'edit', group: 'Modify', title: 'Delete', icon: 'trash', keys: 'Del', hint: 'Delete the selected features', run: editCmd('delete') },
  ...SELECTION,
  { id: 'edit.calculate', tab: 'edit', group: 'Fields', title: 'Calculate field', icon: 'calc', big: true, hint: 'Field calculator: SQL expressions and geodesic area, length, x, y', run: editCmd('calculate') },
  { id: 'edit.addField', tab: 'edit', group: 'Fields', title: 'Add field', icon: 'plus', run: editCmd('add-field') },
  { id: 'edit.table', tab: 'edit', group: 'Fields', title: 'Attribute table', icon: 'table', run: editCmd('table') },
  { id: 'edit.defquery', tab: 'edit', group: 'Fields', title: 'Definition query', icon: 'filter', hint: 'Show and analyse only the features that match a query', run: editCmd('definition-query') },
  { id: 'edit.undo', tab: 'edit', group: 'Manage edits', title: 'Undo', icon: 'undo', keys: 'Ctrl+Z', run: editCmd('undo') },
  { id: 'edit.redo', tab: 'edit', group: 'Manage edits', title: 'Redo', icon: 'redo', keys: 'Ctrl+Y', run: editCmd('redo') },
  { id: 'edit.snap', tab: 'edit', group: 'Manage edits', title: 'Snapping', icon: 'magnet', hint: 'Snap new vertices to visible features (on/off)', run: editCmd('snapping') },
  { id: 'edit.new', tab: 'edit', group: 'Manage edits', title: 'New layer', icon: 'plus', hint: 'An empty point, line or polygon layer to draw into', run: editCmd('new-layer') },
  { id: 'edit.export', tab: 'edit', group: 'Manage edits', title: 'Export features', icon: 'export', hint: 'Save the selection (or the layer) as a new layer', run: editCmd('export') },
  { id: 'edit.discard', tab: 'edit', group: 'Manage edits', title: 'Discard edits', icon: 'refresh', hint: 'Go back to the layer\'s original file', run: editCmd('discard') },
  // the same selection tools on the Map tab, where ArcGIS Pro also has them
  ...SELECTION.map((c) => ({ ...c, id: c.id.replace('sel.', 'map.sel.'), tab: 'style' as TabId })),
  ...MEASURE,
  ...MEASURE.map((c) => ({ ...c, id: c.id.replace('measure.', 'edit.measure.'), tab: 'edit' as TabId })),
  // ---- Layer (contextual tab: acts on the selected layer)
  {
    id: 'layer.zoom', tab: 'layer', group: 'Layer', title: 'Zoom to', icon: 'zoomTo', big: true,
    run: (h) => { const id = h.activeId(); if (id) h.fitLayer(id); },
  },
  {
    id: 'layer.table', tab: 'layer', group: 'Layer', title: 'Attribute table', icon: 'table', big: true,
    run: (h) => { if (h.activeId()) h.showTab('right', 'attributes'); },
  },
  {
    id: 'layer.symbology', tab: 'layer', group: 'Style', title: 'Symbology', icon: 'palette', big: true,
    run: (h) => { h.showTab('right', 'symbology'); },
  },
  {
    id: 'layer.auto', tab: 'layer', group: 'Style', title: 'AutoMap', icon: 'wand', big: true,
    hint: 'AutoMap chooses the field, classes and colours, and says why',
    run: async (h) => { const id = h.activeId(); if (id) await h.autostyle(id); },
  },
  // ---- Home
  {
    id: 'home.refresh', tab: 'home', group: 'Project', title: 'Refresh', icon: 'refresh', big: true,
    hint: 'Re-read the data folder and rebuild the layer list', keys: 'F5',
    run: (h) => { h.reload(); },
  },
  {
    id: 'home.save', tab: 'home', group: 'Project', title: 'Save project', icon: 'save', big: true,
    hint: 'Styles, layer order and visibility are stored in the project file', keys: 'Ctrl+S',
    run: (h) => { h.save(); h.setStatus('Project saved'); },
  },
  {
    id: 'home.contents', tab: 'home', group: 'Layers', title: 'Contents', icon: 'layers',
    hint: 'Show the layer list', run: (h) => { h.showTab('left', 'contents'); },
  },
  {
    id: 'home.zoomLayer', tab: 'home', group: 'Layers', title: 'Zoom to layer', icon: 'zoomTo', big: true,
    hint: 'Fit the map to the active layer', keys: 'Z',
    run: (h) => { const id = h.activeId(); if (id) h.fitLayer(id); else h.setStatus('No active layer'); },
  },
  {
    id: 'home.zoomAll', tab: 'home', group: 'Layers', title: 'Zoom to all', icon: 'globe',
    hint: 'Fit every visible layer', keys: 'Ctrl+0',
    run: (h) => { h.fitAll(); },
  },
  {
    id: 'view.bookmarks', tab: 'view', group: 'Navigate', title: 'Bookmarks', icon: 'pin',
    hint: 'Your saved map views (Project pane)', run: (h) => { h.showTab('left', 'project'); },
  },
  {
    id: 'view.addBookmark', tab: 'view', group: 'Navigate', title: 'Bookmark view', icon: 'plus',
    hint: 'Remember this map view by name', run: () => { document.dispatchEvent(new CustomEvent('geospax:bookmark')); },
  },
  {
    id: 'home.attributes', tab: 'home', group: 'Selection', title: 'Attribute table', icon: 'table', big: true,
    hint: 'Open the table of the active layer', keys: 'Ctrl+T',
    run: (h) => { const id = h.activeId(); if (id) h.showTab('right', 'attributes'); else h.setStatus('Select a layer first'); },
  },
  {
    id: 'home.identify', tab: 'home', group: 'Selection', title: 'Identify', icon: 'search',
    hint: 'Click the map to inspect a feature', keys: 'I',
    run: (h) => h.setStatus('Click a feature on the map', 4000),
  },
  {
    id: 'home.finish', tab: 'home', group: 'Map', title: 'Finish my map', icon: 'print', big: true,
    hint: 'The layers on the map, laid out with legend, scale bar and north arrow: PNG, PDF and a report',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:finish')); },
  },
  {
    id: 'home.start', tab: 'home', group: 'Project', title: 'Start', icon: 'layout', big: true,
    hint: 'The start screen: drop data, plug in a device, your finished maps',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:start')); },
  },
  {
    id: 'data.samples', tab: 'data', group: 'Add data', title: 'Sample data', icon: 'layers',
    hint: 'Ready-made data to try the tools (Papua New Guinea survey, species, climate and tree cover)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:samples')); },
  },
  {
    id: 'data.add', tab: 'data', group: 'Add data', title: 'Add files', icon: 'download', big: true,
    hint: 'Choose files to map (or drop them anywhere on the window)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:browse')); },
  },
  {
    id: 'home.exportPng', tab: 'home', group: 'Map', title: 'Export PNG', icon: 'download',
    hint: 'Save the current view as an image',
    run: (h) => {
      try {
        const url = h.map.getCanvas().toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = `geospax-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`;
        a.click();
        h.setStatus('Map exported as PNG');
      } catch (e) {
        h.log(`export PNG failed: ${e}`, 'error');
      }
    },
  },
  {
    id: 'home.copyLink', tab: 'home', group: 'Map', title: 'Copy view link', icon: 'globe',
    hint: 'A URL that reopens this exact view',
    run: async (h) => {
      const c = h.map.getCenter();
      const url = `${location.origin}${location.pathname}#${h.map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
      try { await navigator.clipboard.writeText(url); h.setStatus('View link copied'); } catch { h.setStatus(url, 6000); }
    },
  },

  // ---- Data
  {
    id: 'data.devices', tab: 'data', group: 'Add data', title: 'Devices', icon: 'phone', big: true,
    hint: 'Phones, GPS units, drone SD cards, sensors',
    run: (h) => { h.showTab('right', 'devices'); },
  },
  {
    id: 'data.phone', tab: 'data', group: 'Add data', title: 'Phone over Wi-Fi', icon: 'satellite',
    hint: 'Show the pairing QR code',
    run: (h) => { h.showTab('right', 'devices'); },
  },
  {
    id: 'data.rasters', tab: 'imagery', group: 'Rasters', title: 'Rasters', icon: 'image', big: true,
    hint: 'DEMs, hillshades, satellite indices',
    run: (h) => { h.showTab('right', 'rasters'); },
  },
  {
    id: 'data.catalog', tab: 'data', group: 'Sources', title: 'Catalog', icon: 'book',
    hint: 'Browse every source the engine can see', run: (h) => { h.showTab('left', 'catalog'); },
  },
  {
    id: 'data.refresh', tab: 'data', group: 'Sources', title: 'Refresh', icon: 'refresh',
    run: (h) => { h.reload(); },
  },
  {
    id: 'data.history', tab: 'data', group: 'Sources', title: 'Run history', icon: 'history',
    run: (h) => { h.showTab('bottom', 'history'); },
  },

  // ---- Style
  {
    id: 'style.panel', tab: 'style', group: 'Symbology', title: 'Symbology', icon: 'palette', big: true,
    hint: 'Renderer, field, colours, opacity, labels', keys: 'Ctrl+2',
    run: (h) => { h.showTab('right', 'symbology'); },
  },
  {
    id: 'style.auto', tab: 'style', group: 'Symbology', title: 'AutoMap', icon: 'wand', big: true,
    hint: 'Let the engine pick a style for the active layer', keys: 'Ctrl+1',
    run: async (h) => {
      const id = h.activeId();
      if (!id) return h.setStatus('Select a layer first');
      await h.autostyle(id);
      h.setStatus('AutoMap styled the layer');
    },
  },
  {
    id: 'style.autoAll', tab: 'style', group: 'Symbology', title: 'AutoMap all', icon: 'wand',
    hint: 'Style every layer automatically',
    run: async (h) => {
      for (const l of h.layers()) await h.autostyle(l.id);
      h.setStatus('All layers styled');
    },
  },
  {
    id: 'style.attributes', tab: 'style', group: 'Fields', title: 'Fields', icon: 'table',
    hint: 'Field names and types of the active layer',
    run: (h) => { h.showTab('right', 'attributes'); },
  },
  {
    id: 'style.legend', tab: 'style', group: 'Fields', title: 'Legend', icon: 'layers',
    run: (h) => { h.showTab('left', 'contents'); },
  },

  // ---- Analyze
  {
    id: 'analyze.ask', tab: 'analyze', group: 'Assistant', title: 'Ask', icon: 'chat', big: true,
    hint: 'Ask about your data in plain words (Ollama on this computer, or Claude with your key)',
    run: (h) => { h.showTab('right', 'ask'); document.querySelector<HTMLTextAreaElement>('#ask-q')?.focus(); },
  },
  {
    id: 'analyze.askModel', tab: 'analyze', group: 'Assistant', title: 'Model…', icon: 'settings',
    hint: 'Choose where the assistant runs: Ollama, an OpenAI-compatible server or Claude',
    run: (h) => { h.showTab('right', 'ask'); document.dispatchEvent(new CustomEvent('geospax:ask-settings')); },
  },
  {
    id: 'analyze.gallery', tab: 'analyze', group: 'Geoprocessing', title: 'Recipe gallery', icon: 'play', big: true,
    hint: 'One-click workflows: pick one, press Run', keys: 'Ctrl+R',
    run: (h) => { h.showTab('bottom', 'automate'); },
  },
  {
    id: 'analyze.toolbox', tab: 'analyze', group: 'Geoprocessing', title: 'Toolbox', icon: 'search', big: true,
    hint: 'Every tool, by toolbox: Analysis, Conversion, Spatial Statistics, Terrain, Hydrology, Image Analysis … searchable (ArcGIS and QGIS names work)',
    run: (h) => { h.showTab('right', 'toolbox'); },
  },
  {
    id: 'analyze.hotspots', tab: 'analyze', group: 'Spatial statistics', title: 'Hot spots', icon: 'hotspot', big: true,
    hint: 'Optimized hot spot analysis (Gi*) on incidents or points',
    run: async (h) => {
      const r = await h.recipes();
      const pick = r.find((x) => x.id.includes('hotspot'));
      if (pick) await h.runRecipe(pick.id); else h.setStatus('Recipe not found');
    },
  },
  {
    id: 'analyze.kriging', tab: 'modelling', group: 'Interpolation', title: 'Interpolate', icon: 'chart', big: true,
    hint: 'Kriging / IDW surface from sample points',
    run: async (h) => {
      const r = await h.recipes();
      const pick = r.find((x) => /krig|interpolat/.test(x.id));
      if (pick) await h.runRecipe(pick.id); else h.setStatus('Recipe not found');
    },
  },
  {
    id: 'analyze.charts', tab: 'analyze', group: 'Spatial statistics', title: 'Charts', icon: 'chart',
    hint: 'Attribute charts for the active layer',
    run: (h) => { h.showTab('right', 'attributes'); },
  },

  // ---- View
  {
    id: 'view.zoomIn', tab: 'view', group: 'Navigate', title: 'Zoom in', icon: 'zoomIn', big: true, keys: '+',
    run: (h) => { h.map.zoomIn(); },
  },
  {
    id: 'view.zoomOut', tab: 'view', group: 'Navigate', title: 'Zoom out', icon: 'zoomOut', big: true, keys: '-',
    run: (h) => { h.map.zoomOut(); },
  },
  {
    id: 'view.zoomAll', tab: 'view', group: 'Navigate', title: 'Full extent', icon: 'globe',
    run: (h) => { h.fitAll(); },
  },
  {
    id: 'view.themeLight', tab: 'view', group: 'Theme', title: 'Light', icon: 'image',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:theme', { detail: 'light' })); },
  },
  {
    id: 'view.themeDark', tab: 'view', group: 'Theme', title: 'Dark', icon: 'layout',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:theme', { detail: 'dark' })); },
  },
  {
    id: 'view.themeSystem', tab: 'view', group: 'Theme', title: 'Follow the system', icon: 'globe',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:theme', { detail: 'system' })); },
  },
  {
    id: 'view.projMercator', tab: 'view', group: 'Projection', title: 'Mercator', icon: 'grid',
    hint: 'Web Mercator: the flat web map (shapes kept, areas grow towards the poles)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:projection', { detail: 'mercator' })); },
  },
  {
    id: 'view.projGlobe', tab: 'view', group: 'Projection', title: 'Globe', icon: 'globe',
    hint: '3D globe when zoomed out (true areas and directions at world scale), flat when zoomed in',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:projection', { detail: 'globe' })); },
  },
  {
    id: 'view.basemapOffline', tab: 'view', group: 'Basemap', title: 'World (offline)', icon: 'globe',
    hint: 'Natural Earth land, lakes and borders, bundled with GeoSpaX: works without internet',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:basemap', { detail: 'offline' })); },
  },
  {
    id: 'view.basemapOsm', tab: 'view', group: 'Basemap', title: 'OpenStreetMap (online)', icon: 'image',
    hint: 'Streets and places from openstreetmap.org (needs internet)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:basemap', { detail: 'osm' })); },
  },
  {
    id: 'view.basemapGallery', tab: 'view', group: 'Basemap', title: 'Basemap gallery', icon: 'gallery', big: true,
    hint: 'Streets, topography, imagery, light and dark canvas, or your own XYZ tiles',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:basemap', { detail: 'gallery' })); },
  },
  {
    id: 'view.basemapNone', tab: 'view', group: 'Basemap', title: 'No basemap', icon: 'layout',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:basemap', { detail: 'none' })); },
  },
  {
    id: 'view.palette', tab: 'view', group: 'Windows', title: 'Command palette', icon: 'terminal', big: true,
    hint: 'Every command, recipe and layer, searchable', keys: 'Ctrl+K',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:palette')); },
  },
  {
    id: 'view.dockLeft', tab: 'view', group: 'Windows', title: 'Catalog pane', icon: 'layout',
    run: (h) => { h.toggleDock('left'); },
  },
  {
    id: 'view.dockRight', tab: 'view', group: 'Windows', title: 'Details pane', icon: 'layout',
    run: (h) => { h.toggleDock('right'); },
  },
  {
    id: 'view.dockBottom', tab: 'view', group: 'Windows', title: 'Bottom pane', icon: 'layout',
    run: (h) => { h.toggleDock('bottom'); },
  },
  {
    id: 'view.resetLayout', tab: 'view', group: 'Windows', title: 'Reset layout', icon: 'refresh',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:reset-layout')); },
  },
  {
    id: 'view.ribbonAutoHide', tab: 'view', group: 'Windows', title: 'Auto-hide the ribbon (Ctrl+F1)', icon: 'pin', keys: 'F1',
    run: (h) => { h.toggleRibbon(); },
  },
  {
    id: 'view.ribbonGallery', tab: 'view', group: 'Windows', title: 'Ribbon galleries: expand recipes instead of a list', icon: 'gallery',
    run: (h) => { h.setRibbonCompact(false); h.setStatus('Ribbon: recipes and plugin tools shown as a gallery'); },
  },
  {
    id: 'view.ribbonList', tab: 'view', group: 'Windows', title: 'Ribbon galleries: collapse to a list', icon: 'grid',
    run: (h) => { h.setRibbonCompact(true); h.setStatus('Ribbon: recipes and plugin tools collapsed into dropdowns'); },
  },
  {
    id: 'view.fullscreen', tab: 'view', group: 'Windows', title: 'Full screen', icon: 'fullscreen',
    run: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => {});
    },
  },

  // ---- Automate
  {
    id: 'automate.gallery', tab: 'automate', group: 'Recipes', title: 'Gallery', icon: 'play', big: true,
    run: (h) => { h.showTab('bottom', 'automate'); },
  },
  {
    id: 'automate.history', tab: 'automate', group: 'Runs', title: 'History', icon: 'history', big: true,
    hint: 'Every run, its steps and its artifacts', run: (h) => { h.showTab('bottom', 'history'); },
  },
  {
    id: 'automate.log', tab: 'automate', group: 'Runs', title: 'Log', icon: 'terminal',
    hint: 'What the engine and the UI are doing', run: (h) => { h.showTab('bottom', 'log'); },
  },
  {
    id: 'automate.reload', tab: 'automate', group: 'Runs', title: 'Refresh runs', icon: 'refresh',
    run: (h) => { h.reload(); h.showTab('bottom', 'history'); },
  },
  {
    id: 'automate.scripts', tab: 'automate', group: 'Scripts', title: 'R / Python', icon: 'terminal',
    hint: 'Recipe steps can call R or Python scripts',
    run: (h) => { h.openUrl('docs/AUTOMATION.md'); },
  },

  // ---- Help
  {
    id: 'help.guide', tab: 'help', group: 'Docs', title: 'User guide', icon: 'book', big: true,
    run: (h) => { h.openUrl('docs/USER_GUIDE.md'); },
  },
  {
    id: 'help.automation', tab: 'help', group: 'Docs', title: 'Automation', icon: 'play', big: true,
    run: (h) => { h.openUrl('docs/AUTOMATION.md'); },
  },
  {
    id: 'help.matrix', tab: 'help', group: 'Docs', title: 'Feature matrix', icon: 'grid',
    run: (h) => { h.openUrl('docs/FEATURE_MATRIX.md'); },
  },
  {
    id: 'help.keys', tab: 'help', group: 'About', title: 'Keyboard', icon: 'terminal',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:shortcuts')); },
  },
  {
    id: 'help.credits', tab: 'help', group: 'About', title: 'Credits', icon: 'check',
    hint: 'Open-source components and their licences',
    run: (h) => { h.openUrl('THIRD_PARTY_NOTICES.md'); },
  },
  {
    id: 'help.about', tab: 'help', group: 'About', title: 'About GeoSpaX', icon: 'globe',
    run: (h) => { h.about(); },
  },
  {
    id: 'help.diagnostics', tab: 'help', group: 'Diagnostics', title: 'Engine diagnostics', icon: 'terminal',
    hint: 'Tile transport, engine cache and the developer tests',
    run: (h) => { h.showTab('left', 'project'); const d = document.querySelector<HTMLDetailsElement>('#diagnostics'); if (d) d.open = true; },
  },
  {
    id: 'analyze.bench', tab: 'help', group: 'Diagnostics', title: 'Benchmark', icon: 'clock',
    hint: 'Measure tile and API throughput',
    run: (h) => { h.bench(); },
  },
  {
    id: 'analyze.deck', tab: 'help', group: 'Diagnostics', title: 'Arrow → deck.gl', icon: 'grid',
    hint: 'Load points as Arrow and draw them with deck.gl',
    run: (h) => { h.deck(); },
  },
  // ------------------------------------------------ Data › Online data (no API keys; cut to the map view)
  onlineCmd('data.online', 'All sources', 'globe', 'choose', 'Every online source: climate, future climate, soil, species, boundaries, elevation, ocean depth, forest change, ecoregions'),
  onlineCmd('data.climate', 'Climate', 'globe', 'worldclim', 'WorldClim 2.1 or CHELSA 2.1 bioclim and monthly climate for the map view', true),
  onlineCmd('data.future', 'Future climate', 'clock', 'worldclim-future', 'WorldClim CMIP6 projections: climate model, SSP and period'),
  onlineCmd('data.soil', 'Soil', 'layers', 'soilgrids', 'SoilGrids 2.0: pH, organic carbon, texture … by depth'),
  onlineCmd('data.species', 'Species', 'pin', 'gbif', 'Occurrences from GBIF, OBIS or iNaturalist, with the citation', true),
  onlineCmd('data.boundaries', 'Boundaries', 'grid', 'gadm', 'GADM 4.1 administrative areas of a country'),
  onlineCmd('data.elevation', 'Elevation', 'image', 'dem', 'Copernicus GLO-30 / GLO-90 DEM for the map view'),
  {
    id: 'data.worms', tab: 'data', group: 'Online data', title: 'Check species names', icon: 'check',
    hint: 'Match a layer\'s scientific names against WoRMS: accepted names for synonyms, spelling checks, classification',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:worms')); },
  },
  onlineCmd('data.forest', 'Forest change', 'leaf', 'hansen', 'Hansen Global Forest Change: tree cover 2000 and year of loss 2001–2025 at 30 m'),
  onlineCmd('data.ecoregions', 'Ecoregions', 'layers', 'ecoregions', 'RESOLVE / WWF terrestrial ecoregions (2017) for the map view'),
  onlineCmd('data.ocean', 'Ocean depth', 'wave', 'gebco', 'GEBCO 2026 bathymetry and land height (~450 m), with how each depth was measured'),
  // ------------------------------------------------ Imagery
  {
    id: 'imagery.detect', tab: 'imagery', group: 'AI models', title: 'Detect objects', icon: 'search', big: true,
    hint: 'Run your own ONNX model (object detection or segmentation) over an image, on this computer',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:detect')); },
  },
  {
    id: 'imagery.models', tab: 'imagery', group: 'AI models', title: 'Models…', icon: 'settings',
    hint: 'Add, describe and remove your ONNX models (with their licence)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:models')); },
  },
  {
    id: 'imagery.embeddings', tab: 'imagery', group: 'Satellite embeddings', title: 'Embeddings', icon: 'satellite', big: true,
    hint: 'AlphaEarth satellite embeddings for the area: look, find similar places, group, classify, change',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:embeddings', { detail: 'look' })); },
  },
  {
    id: 'imagery.similar', tab: 'imagery', group: 'Satellite embeddings', title: 'Similar places', icon: 'search',
    hint: 'Places like your sample points (satellite embeddings)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:embeddings', { detail: 'similar' })); },
  },
  {
    id: 'imagery.groups', tab: 'imagery', group: 'Satellite embeddings', title: 'Group landscape', icon: 'grid',
    hint: 'Groups of alike landscape, no samples needed (satellite embeddings)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:embeddings', { detail: 'cluster' })); },
  },
  {
    id: 'imagery.classifyEmb', tab: 'imagery', group: 'Satellite embeddings', title: 'Classify', icon: 'layers',
    hint: 'Classify from labelled sample points (satellite embeddings)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:embeddings', { detail: 'classify' })); },
  },
  {
    id: 'imagery.embChange', tab: 'imagery', group: 'Satellite embeddings', title: 'Change', icon: 'clock',
    hint: 'Change between two years (satellite embeddings)',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:embeddings', { detail: 'change' })); },
  },
  recipeCmd('imagery.ndvi', 'imagery', 'Satellite', 'Latest NDVI', 'satellite', 'latest-ndvi', 'Newest cloud-free Sentinel-2 pass over the area → NDVI map', true),
  recipeCmd('imagery.terrain', 'imagery', 'Terrain', 'Terrain report', 'image', 'terrain-report', 'DEM → hillshade, slope, aspect, contours, map and report', true),
  recipeCmd('imagery.landforms', 'imagery', 'Terrain', 'Landforms', 'layers', 'landforms-grass', 'Geomorphons landforms (GRASS r.geomorphon)'),
  recipeCmd('imagery.wetness', 'imagery', 'Terrain', 'Wetness index', 'chart', 'wetness-saga', 'Topographic wetness index (SAGA)'),
  recipeCmd('imagery.lidar', 'imagery', 'LiDAR', 'LiDAR → terrain', 'layers', 'lidar-to-terrain', 'Point clouds → bare earth, canopy, buildings, trees', true),
  {
    id: 'imagery.rasterTools', tab: 'imagery', group: 'Raster tools', title: 'Raster tools', icon: 'search', big: true,
    hint: 'The raster tools in the Toolbox: map algebra, zonal, reclassify, distance, terrain, hydrology',
    run: (h) => {
      h.showTab('right', 'toolbox');
      document.dispatchEvent(new CustomEvent('geospax:toolbox-search', { detail: 'raster' }));
    },
  },
  // ------------------------------------------------ Modelling
  recipeCmd('modelling.rkrige', 'modelling', 'Interpolation', 'Kriging in R', 'chart', 'r-kriging', 'gstat kriging in R, cross-validated (needs R with sf and gstat)'),
  // ------------------------------------------------ Plugins (the plugins' own tools follow, by plugin)
  {
    id: 'plugins.manage', tab: 'plugins', group: 'Manage', title: 'Manage', icon: 'layers', big: true,
    hint: 'What is installed, the runtimes found, import a plugin (GeoSpaX, RustGIS, GeoLibre, QGIS, ArcGIS Pro), reload or uninstall',
    run: () => { document.dispatchEvent(new CustomEvent('geospax:plugin-manager')); },
  },
  // ------------------------------------------------ R (rconsole.ts)
  rCmd('r.console', 'Code', 'R console', 'rlogo', 'blank', 'Run R code on a layer (sf) and a raster (terra); results come back to the map', true),
  rCmd('r.setup', 'Code', 'R setup', 'download', 'setup', 'Find or install R and package kits (sf, terra, tmap, biomod2 …)'),
  rCmd('r.tmap', 'Maps', 'tmap map', 'layout', 'tmap', 'A thematic map with tmap, saved at print size', true),
  rCmd('r.ggplot', 'Maps', 'ggplot2 map', 'chart', 'ggplot', 'A ggplot2 map (geom_sf) with scale bar and north arrow'),
  rCmd('r.rayshader', 'Maps', 'Relief', 'image', 'rayshader', 'Shaded relief from a DEM with rayshader'),
  rCmd('r.terrain', 'Rasters', 'Terrain', 'image', 'terrain', 'Slope, aspect, hillshade and ruggedness with terra', true),
  rCmd('r.gee', 'Rasters', 'Earth Engine', 'globe', 'gee', 'Sentinel-2 NDVI from Google Earth Engine with rgee'),
  rCmd('r.biomod2', 'Species models', 'biomod2', 'pin', 'biomod2', 'Ensemble species distribution model (GLM, RF, MaxNet) with biomod2', true),
  rCmd('r.maxent', 'Species models', 'MaxEnt', 'pin', 'maxent', 'MaxEnt with maxnet: presences + background, cloglog suitability'),
  rCmd('r.tidymodels', 'Machine learning', 'tidymodels', 'chart', 'tidymodels', 'Random forest with tidymodels, cross-validated', true),
  rCmd('r.dbplyr', 'Machine learning', 'dbplyr', 'table', 'dbplyr', 'dplyr verbs run as SQL in DuckDB'),
];

/** Render one ribbon button (shared by the ribbon and the palette footer). */
export function commandHtml(c: Command, big = false): string {
  const useBig = big || !!c.big;
  return `<button class="rb-btn${useBig ? ' big' : ' small'}" data-cmd="${c.id}" title="${esc(
    `${c.title}${c.hint ? ' — ' + c.hint : ''}${c.keys ? ` (${c.keys})` : ''}`,
  )}">
    <span class="rb-ico">${icon(c.icon, useBig ? 28 : 16)}</span>
    <span class="rb-label">${esc(c.title)}</span>
  </button>`;
}

/** A ribbon group's items, ArcGIS Pro style: large buttons first, then the small ones stacked
 *  three to a column, so every group has the same height and labels line up across tabs. */
export function groupItemsHtml(bigs: string[], smalls: string[]): string {
  const cols: string[] = [];
  for (let i = 0; i < smalls.length; i += 3) cols.push(`<div class="rb-col">${smalls.slice(i, i + 3).join('')}</div>`);
  return bigs.join('') + cols.join('');
}

/** Pick an icon for a recipe from its id and title, so the gallery is not 15 play buttons. */
export function recipeIcon(recipe: { id: string; title?: string }): string {
  const t = `${recipe.id} ${recipe.title ?? ''}`.toLowerCase();
  if (/hotspot|cluster|moran/.test(t)) return 'hotspot';
  if (/krig|interpolat|idw|surface|sample/.test(t)) return 'chart';
  if (/hexbin|grid|fishnet|bin/.test(t)) return 'grid';
  if (/terrain|hillshade|slope|aspect|contour|dem|relief/.test(t)) return 'image';
  if (/ndvi|index|satellite|landsat|sentinel|true.?colour/.test(t)) return 'satellite';
  if (/python|r-kriging|script/.test(t)) return 'terminal';
  if (/photo|image|camera/.test(t)) return 'camera';
  if (/track|gps|nmea|route|waypoint/.test(t)) return 'satellite';
  if (/sensor|air|quality|weather|water/.test(t)) return 'satellite';
  if (/landform|wetness|grass|saga/.test(t)) return 'layers';
  if (/my-map|saved/.test(t)) return 'save';
  if (/lidar|point.?cloud|canopy|building|tree/.test(t)) return 'grid';
  if (/scene|3d|gltf/.test(t)) return 'grid';
  if (/drone|flight|uav/.test(t)) return 'satellite';
  if (/report|pdf|print|layout/.test(t)) return 'print';
  if (/buffer|clip|dissolve|union|intersect|select/.test(t)) return 'layers';
  if (/schedule|webhook|stac|trigger/.test(t)) return 'clock';
  return 'play';
}

/** Group the commands of one tab, in ribbon order. */
export function groupsFor(tab: TabId): { group: string; items: Command[] }[] {
  const out: { group: string; items: Command[] }[] = [];
  for (const c of COMMANDS) {
    if (c.tab !== tab) continue;
    let g = out.find((x) => x.group === c.group);
    if (!g) out.push((g = { group: c.group, items: [] }));
    g.items.push(c);
  }
  return out;
}
