// The ribbon's layout, tab by tab: which commands sit in which group, which are large, and which
// families share one split button (Office and ArcGIS Pro style). Commands themselves live in
// commands.ts; this file only arranges them, so Ctrl+K, scripts and the ribbon run the same thing.
//
// Rules the layout follows on every tab:
//  * groups in the order the work goes, the most used command of each group first and large;
//  * related variants (export formats, measure modes, CAD modify tools …) in one split button:
//    the main part runs the last one used (or the default), the arrow lists them all;
//  * small buttons stacked three to a column, so groups have no gaps;
//  * tools that hold the map (Swipe, Identify, Measure, edit and CAD tools) and on/off states stay
//    pressed (aria-pressed) until clicked again; commands never stay pressed.
import { COMMANDS, type Command, type TabId } from './commands';
import { isMapTool } from './toolstate';

/** A split button: main part runs the remembered item, the arrow opens the list. */
export interface Split {
  split: string;
  /** label of a large split's main part (a small one shows the current item instead) */
  label?: string;
  icon?: string;
  hint?: string;
  items: string[];
  /** default item (else the first) */
  default?: string;
}
export type Entry = string | Split;
export interface GroupSpec {
  group: string;
  big?: Entry[];
  small?: Entry[];
}

export const isSplit = (e: Entry): e is Split => typeof e !== 'string';

// ------------------------------------------------------------------ layout
export const RIBBON: Partial<Record<TabId, GroupSpec[]>> = {
  home: [
    { group: 'Project', big: ['home.new', 'home.open', { split: 'project-save', label: 'Save', icon: 'save', hint: 'Save the project, save a copy under a new name, or rename it', items: ['home.save', 'home.saveAs', 'home.rename'] }], small: ['home.start', 'home.settings', 'home.refresh'] },
    { group: 'Layer', big: ['home.addData', 'home.basemap'], small: ['home.contents', 'home.zoomLayer'] },
    { group: 'Navigate', small: ['view.zoomIn', 'view.zoomOut', 'view.zoomAll', 'home.prevExtent', 'home.nextExtent', 'home.goto', 'view.bookmarks', 'view.addBookmark'] },
    { group: 'Selection', big: [{ split: 'home-select', label: 'Select', icon: 'select', hint: 'Select features by attributes, by location or with a lasso', items: ['sel.attributes', 'sel.location', 'home.lasso'] }], small: ['home.attributes', 'sel.zoom', 'sel.clear'] },
    { group: 'Inquiry', big: ['home.identify'], small: [{ split: 'home-measure', items: ['measure.distance', 'measure.area', 'measure.clear'] }, 'home.findPlace', 'home.coords'] },
    { group: 'Symbology', big: ['style.panel'], small: [{ split: 'home-automap', items: ['style.auto', 'style.autoAll'] }, 'home.labels', 'style.attributes', 'style.legend'] },
  ],
  view: [
    { group: 'Basemap', big: [{ split: 'view-basemap', label: 'Basemap', icon: 'gallery', hint: 'The basemap gallery, the offline world, OpenStreetMap or none', items: ['view.basemapGallery', 'view.basemapOffline', 'view.basemapOsm', 'view.basemapNone'] }] },
    { group: 'Compare', big: ['view.swipe', 'view.spyglass'] },
    { group: 'Projection', small: ['view.projMercator', 'view.projGlobe', 'view.terrain3d', 'view.crs'] },
    { group: 'Time', big: ['view.time'] },
    { group: 'Map grid', small: ['view.grid', 'view.scale', 'view.lockscale'] },
    { group: 'Theme', small: ['view.themeLight', 'view.themeDark', 'view.themeSystem'] },
    { group: 'Windows', big: ['view.palette'], small: ['view.dockLeft', 'view.dockRight', 'view.dockBottom', 'view.resetLayout', 'view.fullscreen', { split: 'view-ribbon', items: ['view.ribbonAutoHide', 'view.ribbonGallery', 'view.ribbonList'] }] },
  ],
  edit: [
    { group: 'Create', big: ['edit.point', 'edit.line', 'edit.polygon'], small: ['edit.trace', 'edit.gps', 'edit.new'] },
    { group: 'Modify', big: ['edit.select'], small: ['edit.box', 'edit.lasso', 'edit.vertices', 'edit.attributes', { split: 'edit-geometry', items: ['edit.split', 'edit.merge', 'edit.cut', 'edit.reshape'] }, 'edit.delete'] },
    { group: 'Clipboard', small: ['edit.copy', 'edit.paste', 'edit.copyalong'] },
    { group: 'Selection', big: [{ split: 'edit-select', label: 'Select', icon: 'select', hint: 'Select features by attributes or by location', items: ['edit.sel.attributes', 'edit.sel.location'] }], small: ['edit.sel.zoom', 'edit.sel.clear'] },
    { group: 'Fields', big: ['edit.calculate'], small: ['edit.addField', 'edit.table', 'edit.defquery', 'edit.rules'] },
    { group: 'Measure', big: [{ split: 'edit-measure', label: 'Measure', icon: 'ruler', hint: 'Measure a distance or an area on the map', items: ['edit.measure.distance', 'edit.measure.area', 'edit.measure.clear'] }] },
    { group: 'Manage edits', small: ['edit.undo', 'edit.redo', 'edit.snap', 'edit.discard', 'edit.topology'] },
  ],
  design: [
    { group: 'Draw', big: ['design.line', { split: 'design-shapes', label: 'Shapes', icon: 'polyline', hint: 'Polyline, polygon, rectangle, circle, arc or ellipse', items: ['design.polyline', 'design.polygon', 'design.rect', 'design.circle', 'design.arc', 'design.ellipse'] }], small: ['design.point', 'design.text', 'design.hatch'] },
    { group: 'Precision', small: ['design.snap', 'design.ortho', 'design.polar'] },
    { group: 'Construct', big: ['design.road'], small: ['design.offset'] },
    {
      group: 'Modify',
      small: [
        { split: 'design-move', hint: 'Move, copy, rotate, scale, mirror, align or stretch', items: ['design.move', 'design.copy', 'design.rotate', 'design.scale', 'design.mirror', 'design.align', 'design.stretch'] },
        { split: 'design-trim', hint: 'Trim, extend, fillet, chamfer, lengthen, break, join or explode', items: ['design.trim', 'design.extend', 'design.fillet', 'design.chamfer', 'design.lengthen', 'design.break', 'design.join', 'design.explode'] },
        { split: 'design-array', hint: 'Rectangular or polar array', items: ['design.array', 'design.arraypolar'] },
        { split: 'design-boolean', hint: 'Union, subtract or intersect two shapes', items: ['design.union', 'design.subtract', 'design.intersect'] },
        'design.erase', 'design.undo', 'design.redo',
      ],
    },
    { group: 'Blocks', big: ['design.layers', 'design.insert'], small: ['design.block', 'design.lock'] },
    { group: 'Survey', big: ['design.traverse'], small: ['design.survey', 'design.areas', { split: 'design-dimension', items: ['design.dimension', 'design.dimangle', 'design.leader'] }, { split: 'design-inquiry', items: ['design.measure', 'design.list', 'design.divide'] }] },
    { group: 'CAD exchange', big: ['design.dxf-export'], small: ['design.dxf-import', 'design.copyFeatures', 'design.pasteFeatures'] },
  ],
  imagery: [
    { group: 'Rasters', big: ['data.rasters'] },
    { group: 'Indices', big: ['imagery.ndvi', 'imagery.index'], small: ['imagery.ndi'] },
    { group: 'Terrain', big: ['imagery.terrain'], small: ['imagery.hillshade', 'imagery.slope', 'imagery.aspect', 'imagery.tri', 'imagery.twi', 'imagery.viewshed', 'imagery.profile', 'imagery.landforms', 'imagery.lidar'] },
    { group: 'Raster tools', big: ['imagery.rasterTools'], small: ['imagery.clip', 'imagery.mosaic', 'imagery.reproject', 'imagery.resample', 'imagery.change'] },
    { group: 'Satellite embeddings', big: ['imagery.embeddings'], small: ['imagery.similar', 'imagery.groups', 'imagery.classifyEmb', 'imagery.embChange'] },
    { group: 'AI models', big: ['imagery.detect'], small: ['imagery.models'] },
  ],
  analyze: [
    { group: 'Geoprocessing', big: ['analyze.toolbox', 'analyze.gallery'], small: ['automate.history', 'analyze.sql'] },
    {
      group: 'Tools',
      big: ['analyze.tool.buffer', { split: 'analyze-overlay', label: 'Overlay', icon: 'tIntersect', hint: 'Clip, intersect, union or erase one layer with another', items: ['analyze.tool.clip', 'analyze.tool.intersect', 'analyze.tool.union', 'analyze.tool.erase'] }],
      small: ['analyze.tool.dissolve', 'analyze.tool.merge', 'analyze.tool.join', 'analyze.tool.near', 'analyze.tool.summarize', 'analyze.zonal'],
    },
    { group: 'Network', big: ['analyze.servicearea'], small: ['analyze.closest', 'analyze.route'] },
    { group: 'Spatial statistics', big: ['analyze.hotspots'], small: ['analyze.charts', 'analyze.profile'] },
    { group: 'Interpolation', big: ['analyze.kriging'], small: ['modelling.rkrige'] },
    { group: 'Assistant', big: ['analyze.ask'], small: ['analyze.askModel'] },
  ],
  share: [
    {
      group: 'Export map',
      big: [{ split: 'share-map', label: 'Export map', icon: 'print', hint: 'The finished map (legend, scale bar, north arrow) as a file', items: ['share.map.pdf', 'share.map.png', 'share.map.svg', 'share.map.report'], default: 'share.map.pdf' }],
      small: ['home.exportPng', 'share.print'],
    },
    {
      group: 'Export data',
      big: [{ split: 'share-data', label: 'Export data', icon: 'download', hint: 'The selected layer as a file in a common GIS format', items: ['share.data.geojson', 'share.data.shp', 'share.data.csv', 'share.data.gpkg', 'share.data.kml', 'share.data.parquet'], default: 'share.data.geojson' }],
      small: ['edit.export'],
    },
    { group: 'Layout', big: ['home.finish', 'share.layout'] },
    { group: 'Publish', big: ['share.publish'], small: ['share.package', 'home.copyLink'] },
  ],
  help: [
    { group: 'Learn', big: ['help.tutorials', 'help.guide'], small: ['help.search', 'help.keys', 'help.faq'] },
    { group: 'Docs', small: ['help.whatsnew', 'help.automation', 'help.matrix'] },
    { group: 'Support', small: ['help.updates', 'help.report', 'help.diagnostics'] },
    { group: 'About', small: ['help.about', 'help.credits', { split: 'help-perf', items: ['analyze.bench', 'analyze.deck'] }] },
  ],
};

// ------------------------------------------------------------------ pressed states
/** 'tool' holds the map (one at a time, Esc ends it); 'state' is an on/off or a choice. */
export type PressKind = 'tool' | 'state';
const ds = () => document.body.dataset;
const on = (k: string) => () => ds()[k] === 'on';
const tool = (name: string) => () => isMapTool(name);

export const PRESSED: Record<string, { kind: PressKind; test: () => boolean }> = {};
const T = (id: string, name: string) => { PRESSED[id] = { kind: 'tool', test: tool(name) }; };
const S = (id: string, test: () => boolean) => { PRESSED[id] = { kind: 'state', test }; };

T('view.swipe', 'swipe');
T('view.spyglass', 'spyglass');
T('home.identify', 'identify');
for (const m of ['distance', 'area']) { T(`measure.${m}`, `measure:${m}`); T(`edit.measure.${m}`, `measure:${m}`); }
for (const t of ['point', 'line', 'polygon', 'select', 'box', 'vertices', 'lasso', 'split', 'cut', 'reshape', 'copyalong']) T(`edit.${t}`, `edit:${t}`);
T('home.lasso', 'edit:lasso');
for (const t of ['line', 'polyline', 'polygon', 'rect', 'circle', 'arc', 'ellipse', 'point', 'text', 'offset', 'road', 'move', 'copy', 'rotate', 'scale', 'mirror',
  'trim', 'extend', 'fillet', 'array', 'arraypolar', 'divide', 'measure', 'block', 'insert', 'lock', 'union', 'subtract', 'intersect', 'explode', 'join', 'break',
  'lengthen', 'chamfer', 'stretch', 'list', 'align', 'erase', 'dimension', 'dimangle', 'leader']) T(`design.${t}`, `cad:${t}`);
S('home.labels', on('labels'));
S('view.grid', on('grid'));
S('view.lockscale', on('scaleLock'));
S('view.time', () => ds().time === 'on');
S('view.terrain3d', on('terrain3d'));
S('view.projMercator', () => ds().projection !== 'globe');
S('view.projGlobe', () => ds().projection === 'globe');
S('view.themeLight', () => ds().themePref === 'light');
S('view.themeDark', () => ds().themePref === 'dark');
S('view.themeSystem', () => ds().themePref === 'system');
S('view.basemapOffline', () => ds().baseMap === 'offline');
S('view.basemapOsm', () => ds().baseMap === 'osm');
S('view.basemapNone', () => ds().baseMap === 'none');
S('edit.trace', on('tracing'));
S('edit.snap', on('snapping'));
S('design.snap', on('cadSnap'));
S('design.ortho', on('cadOrtho'));
S('design.polar', on('cadPolar'));

/** Dock toggles need the workbench's layout: it fills these in. */
export function setDockTests(open: (d: 'left' | 'right' | 'bottom') => boolean) {
  S('view.dockLeft', () => open('left'));
  S('view.dockRight', () => open('right'));
  S('view.dockBottom', () => open('bottom'));
}

// ------------------------------------------------------------------ resolve
const byId = new Map<string, Command>();
for (const c of COMMANDS) if (!byId.has(c.id)) byId.set(c.id, c);
export const command = (id: string) => byId.get(id);

export interface ResolvedGroup {
  group: string;
  big: (Command | ResolvedSplit)[];
  small: (Command | ResolvedSplit)[];
}
export interface ResolvedSplit extends Split { cmds: Command[] }
export const isResolvedSplit = (x: Command | ResolvedSplit): x is ResolvedSplit => 'split' in x;

const SPLITS = new Map<string, Split>();
for (const groups of Object.values(RIBBON)) for (const g of groups ?? []) for (const e of [...(g.big ?? []), ...(g.small ?? [])]) if (isSplit(e)) SPLITS.set(e.split, e);
export const splitSpec = (key: string) => SPLITS.get(key);

/** The groups of one tab. Commands of the tab that the layout does not place are added to their
 *  own group's small buttons, so a new command is never lost from the ribbon. */
export function ribbonFor(tab: TabId): ResolvedGroup[] | null {
  const spec = RIBBON[tab];
  if (!spec) return null;
  const placed = new Set<string>();
  const res = (e: Entry): Command | ResolvedSplit | null => {
    if (isSplit(e)) {
      const cmds = e.items.map((i) => byId.get(i)).filter((c): c is Command => !!c);
      cmds.forEach((c) => placed.add(c.id));
      return cmds.length ? { ...e, cmds } : null;
    }
    const c = byId.get(e);
    if (c) placed.add(c.id);
    return c ?? null;
  };
  const out: ResolvedGroup[] = spec.map((g) => ({
    group: g.group,
    big: (g.big ?? []).map(res).filter((x): x is Command | ResolvedSplit => !!x),
    small: (g.small ?? []).map(res).filter((x): x is Command | ResolvedSplit => !!x),
  }));
  for (const c of COMMANDS) {
    if (c.tab !== tab || placed.has(c.id)) continue;
    placed.add(c.id);
    let g = out.find((x) => x.group === c.group);
    if (!g) out.push((g = { group: c.group, big: [], small: [] }));
    (c.big && !g.big.length ? g.big : g.small).push(c);
  }
  return out.filter((g) => g.big.length || g.small.length);
}

// ------------------------------------------------------------------ remembered split items
const KEY = (k: string) => `geospax.split.${k}`;
export function splitCurrent(s: Split): string {
  let v: string | null = null;
  try { v = localStorage.getItem(KEY(s.split)); } catch { /* private mode */ }
  return v && s.items.includes(v) ? v : s.default ?? s.items[0];
}
export function rememberSplit(cmd: string): void {
  for (const s of SPLITS.values()) {
    if (!s.items.includes(cmd) || /\.clear$/.test(cmd)) continue;
    try { localStorage.setItem(KEY(s.split), cmd); } catch { /* private mode */ }
  }
}
