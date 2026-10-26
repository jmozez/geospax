// Toolbox (right pane, both modes): every tool GeoSpaX can run in one searchable list, like
// ArcGIS Pro's Geoprocessing pane. Built-in tools are organised by task, toolbox › toolset
// (Analysis › Overlay, Hydrology › Flow routing …), whatever engine runs them:
//
//   - Ready-made analyses: the recipes (a form, then Run; they lay out a map and a report)
//   - the engine's own tools (recipe steps), each with the ArcGIS Pro / QGIS / GRASS tools it covers,
//     so typing an ArcGIS or QGIS tool name finds the GeoSpaX way to do it
//   - the built-in tool sets (raster, vector, terrain, hydrology, imagery, LiDAR; conservation,
//     landscape and biodiversity), filed under the same toolboxes
//   - tools of plugins the user added (QGIS, ArcGIS Pro, RustGIS …), under Plugins, with their source
//
// Search ranks by name, then summary, then the tools it stands in for. A tool opens in the pane
// itself (no dialog for recipes and building blocks); plugin tools use the plugin's own form.
import type { Backend, LayerInfo } from './backend';
import type { RecipeInfo } from './automate';
import { SOURCE_LABEL, type PluginInfo, type ToolSpec } from './plugins';
import { ICONS, icon } from './commands';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface StepDoc {
  name: string;
  family: string;
  summary: string;
  borrowed?: string;
  params: { name: string; description?: string; required?: boolean }[];
}

type Kind = 'recipe' | 'step' | 'plugin';
interface Tool {
  key: string;
  kind: Kind;
  name: string;
  summary: string;
  category: string;
  source: string;
  /** what else this tool is called (ArcGIS Pro, QGIS, GRASS …) */
  aka: string;
  recipe?: RecipeInfo;
  step?: StepDoc;
  plugin?: PluginInfo;
  tool?: ToolSpec;
}

export interface ToolboxHost {
  backend: Backend;
  layers: () => LayerInfo[];
  activeId: () => string | null;
  runRecipe: (id: string, inputs: Record<string, unknown>) => void;
  openPluginTool: (p: PluginInfo, t: ToolSpec) => void;
  setStatus: (t: string, ms?: number) => void;
}

const RECENT_KEY = 'geospax.toolbox.recent';

/** Toolboxes in the order the pane lists them (ArcGIS Pro / QGIS names, by task). */
const TOOLBOXES = [
  'Ready-made analyses', 'Analysis', 'Cartography', 'Conversion', 'Data Management', 'Spatial Statistics', 'Interpolation',
  'Raster Analysis', 'Terrain', 'Hydrology', 'Image Analysis', 'LiDAR and 3D', 'Network Analysis', 'Landscape Ecology',
  'Conservation Planning', 'Biodiversity', 'Species Distribution', 'Field data and devices', 'Maps and reports', 'Scripting (R and Python)', 'Plugins',
];

/** The engine's own tools (recipe steps) by family → toolbox. */
const FAMILY_TOOLBOX: Record<string, string> = {
  Analysis: 'Analysis', Cartography: 'Cartography', Code: 'Scripting (R and Python)', Data: 'Data Management', Input: 'Data Management',
  Devices: 'Field data and devices', Geostatistics: 'Interpolation', LiDAR: 'LiDAR and 3D', Output: 'Maps and reports',
  Performance: 'Data Management', Providers: 'Scripting (R and Python)', Raster: 'Raster Analysis', 'Remote sensing': 'Image Analysis',
  Statistics: 'Spatial Statistics', Terrain: 'Terrain', '3D': 'LiDAR and 3D',
};

/** The engine's own tools by name (the ids stay in recipes; people see these). */
const STEP_TITLES: Record<string, string> = {
  'devices.import': 'Import from a device', 'devices.import_photos': 'Import geotagged photos', 'devices.import_tracks': 'Import GPS tracks',
  'sensor.snapshot': 'Live sensor readings', 'sensor.summary': 'Summarize sensor readings', 'io.open': 'Open layers', 'vector.sql': 'SQL query',
  'vector.buffer': 'Buffer', 'aggregate.hexbin': 'Hexagon bins', 'interpolate.idw': 'IDW interpolation', 'interpolate.auto': 'Kriging or IDW (automatic)',
  'stats.hotspots': 'Optimized hot spot analysis', 'automap.style': 'Style automatically', 'style.apply': 'Apply saved styles',
  'overviews.build': 'Build overviews', 'layout.auto': 'Page layout defaults', 'data.fetch': 'Get online data', 'dem.fetch': 'Get elevation (DEM)',
  'terrain.derive': 'Terrain derivatives', 'terrain.contours': 'Contours', 'lidar.grid': 'LiDAR to terrain and canopy', 'scene.3d': '3D scene',
  'raster.classify': 'Reclassify raster', 'raster.sample': 'Extract raster values to points', 'rs.search': 'Find satellite scenes',
  'rs.index': 'Spectral index (NDVI …)', 'rs.fetch': 'Get satellite imagery', grass: 'GRASS GIS tool', saga: 'SAGA GIS tool',
  'export.map': 'Export map', 'export.png': 'Export map (PNG)', 'export.pdf': 'Export map (PDF)', 'export.svg': 'Export map (SVG)',
  'export.series': 'Map series (atlas)', 'export.report': 'Report', 'export.data': 'Export data', python: 'Python script', r: 'R script',
};

const toolboxOf = (category: string) => category.split(' › ')[0];

// A tool's icon, like ArcGIS Pro's and QGIS's. Tools with a well-known job (Buffer, Clip, Slope,
// Kriging …) get that job's icon, matched on whole words of the name; every other tool gets the icon
// of its toolset (Image Analysis › Filters, Hydrology › Depressions …), then of its toolbox.
const ICON_RULES: [RegExp, string][] = [
  [/\bbuffer/, 'gp-buffer'], [/\b(clip|erase|extract by mask|crop)\b/, 'gp-clip'], [/\bintersect/, 'intersect'],
  [/\bunion\b/, 'union'], [/^(symmetrical difference|difference)( 3d)?$/, 'subtract'], [/\bdissolve/, 'gp-dissolve'],
  [/^(merge|append|mosaic)\b/, 'gp-merge'], [/\b(reproject|project raster|project vector|^project$|warp)\b/, 'gp-project'],
  [/\bcontour/, 'gp-contour'], [/\b(hillshade|shaded relief|multidirectional hillshade)\b/, 'gp-hillshade'], [/^slope|\bslope\b(?! vs)/, 'slope'],
  [/\b(watershed|basin|catchment)/, 'gp-flow'], [/\b(viewshed|line of sight|visibility|skyline|horizon)\b/, 'gp-eye'],
  [/\b(kernel density|point density|line density|heat ?map)\b/, 'gp-density'], [/\b(kriging|idw|inverse distance|spline|natural neighbou?r|empirical bayesian)\b/, 'gp-interpolate'],
  [/\b(hot ?spots?|getis|moran|lisa|dbscan|clusters|clustering)\b/, 'hotspot'], [/\bhistogram\b(?! (equali|match))/, 'chart'], [/\bzonal\b/, 'gp-zonal'],
  [/\b(reclass|reclassify)\b/, 'gp-classify'], [/\b(raster calculator|band math|map algebra)\b/, 'gp-calc'],
  [/\b(ndvi|ndwi|nbr|evi|savi|spectral index)\b/, 'satellite'], [/\b(join|relate)\b/, 'gp-join'], [/\bcentroid/, 'point'],
  [/\b(voronoi|thiessen|delaunay)\b/, 'polygon'], [/\b(hexagon|hexbin|h3|fishnet|tessellation)/, 'grid'],
  [/^filter (vector|raster) features\b|\bselect\b|\bquery\b/, 'select'], [/\b(lidar|las|point cloud)\b/, 'pointcloud'], [/\bfilter\b/, 'gp-filter'], [/\b(classification|k-means)\b/, 'gp-classify'], [/\binterpolation\b/, 'gp-interpolate'], [/\bgridding\b/, 'gp-raster'],
  [/\b(near|nearest|distance)\b/, 'ruler'], [/\b(shortest path|route|routes|closest facility|service area|od cost)\b/, 'road'],
  [/^(random )?sample\b|\b(extract values|values (at|to) points|raster\.sample)\b/, 'gp-sample'], [/\b(select|query|sql)\b/, 'select'],
  [/\b(export|save)\b/, 'export'], [/\b(regression|correlation)\b/, 'gp-metric'], [/\b(species|occurrence|richness|diversity|patch|patches|fragmentation|tree|forest)\b/, 'leaf'], [/\bprofile\b/, 'gp-landform'],
  [/\bpolygon overlay\b/, 'intersect'], [/\b(protection|priority|protected|representation)\b/, 'pin'], [/\breport\b/, 'layout'], [/\bpoint grid\b/, 'grid'],
  // the engine's own tools, by their step name
  [/^ai\./, 'detect'], [/^data\.fetch/, 'download'], [/^devices\.import_photos/, 'camera'], [/^devices\./, 'phone'], [/^embeddings\./, 'embed'],
  [/^io\.open/, 'folder'], [/^lidar\./, 'pointcloud'], [/^overviews\./, 'gp-raster'], [/^r$/, 'rlogo'], [/^(saga|grass|tool)$/, 'toolbox'], [/^sensor\./, 'speed'],
  [/\b(change|two-date|two dates)\b/, 'gp-change'], [/\b(suitability)\b/, 'gp-classify'], [/\b(python)\b/, 'python'], [/\br script\b/, 'rlogo'],
];
// ready-made analyses (recipes) by their subject
const RECIPE_RULES: [RegExp, string][] = [
  [/slopes?\b/, 'slope'], [/wetness/, 'wetness'], [/landform/, 'gp-landform'], [/lidar|point cloud/, 'pointcloud'], [/photo/, 'camera'],
  [/gps|track/, 'phone'], [/drone/, 'camera'], [/climate|rain/, 'd-climate'], [/soil/, 'd-soil'], [/air.quality|sensor/, 'speed'],
  [/hot ?spot|incident/, 'hotspot'], [/hexagon|density/, 'gp-density'], [/flood|water|river|watershed/, 'gp-flow'], [/forest|tree|habitat|species|vegetation/, 'leaf'],
  [/land ?cover|change/, 'gp-change'], [/elevation|terrain|dem\b/, 'mountain'], [/satellite|ndvi|imagery/, 'satellite'], [/boundar|admin/, 'polygon'],
];
const TOOLSET_ICON: Record<string, string> = {
  'Spatial Statistics': 'hotspot', 'Spatial Statistics › Rasters': 'gp-metric', 'Spatial Statistics › Space-time': 'clock',
  'Raster Analysis › Math': 'gp-calc', 'Raster Analysis › Map algebra': 'gp-calc', 'Raster Analysis › Multidimensional': 'gp-cube',
  'Raster Analysis › Distance and cost': 'ruler', 'Raster Analysis › Zonal': 'gp-zonal', 'Raster Analysis › Generate': 'gp-raster',
  'Raster Analysis › Neighbourhood': 'gp-filter', 'Raster Analysis › Reclassify and mask': 'gp-classify',
  'Image Analysis › Filters': 'gp-filter', 'Image Analysis › Segmentation (OBIA)': 'gp-segment', 'Image Analysis › Classification': 'gp-classify',
  'Image Analysis › Radar (SAR)': 'gp-radar', 'Image Analysis › Enhancement': 'tune', 'Image Analysis › Spectral indices': 'satellite',
  'Image Analysis › Change detection': 'gp-change', 'Image Analysis › Edges and features': 'gp-edge', 'Image Analysis › Correction': 'satellite',
  'Image Analysis › Thermal': 'gp-thermal',
  'Terrain › Surface': 'mountain', 'Terrain › Derivatives': 'slope', 'Terrain › Multiscale': 'mountain', 'Terrain › Visibility': 'gp-eye',
  'Terrain › Landforms': 'gp-landform', 'Terrain › Roughness': 'gp-landform',
  'Analysis › Geometry': 'shape', 'Analysis › Sampling and grids': 'grid', 'Analysis › Overlay': 'intersect', 'Analysis › Fields and attributes': 'fields',
  'Cartography › Generalization': 'gp-generalize', 'Network Analysis': 'gp-network', 'Network Analysis › Linear referencing': 'road',
  'Hydrology › Stream networks': 'gp-stream', 'Hydrology › Flow routing': 'gp-flow', 'Hydrology › Depressions': 'gp-sink',
  'Hydrology › Indices': 'wetness', 'Hydrology › Watersheds': 'gp-flow',
  'Conversion › Vector and tables': 'gp-convert', 'Conversion › Raster and vector': 'gp-convert', 'Conversion › Geometry and topology': 'shape',
  'Conversion › Tiles and web': 'gp-tile',
  'LiDAR and 3D › 3D features': 'cube', 'LiDAR and 3D › Filter and classify': 'pointcloud', 'LiDAR and 3D › Gridding': 'gp-raster',
  'LiDAR and 3D › Metrics': 'gp-metric', 'LiDAR and 3D › Manage': 'pointcloud',
  'Landscape Ecology › Shape metrics': 'gp-metric', 'Landscape Ecology › Patches': 'leaf',
  'Data Management › Projections': 'gp-project', 'Data Management › Rasters': 'gp-raster', 'Data Management › Online data': 'download',
  Interpolation: 'gp-interpolate',
};
const TOOLBOX_ICON: Record<string, string> = {
  'Ready-made analyses': 'play', Analysis: 'toolbox', 'Raster Analysis': 'gp-raster', 'Spatial Statistics': 'hotspot',
  Terrain: 'mountain', Hydrology: 'gp-flow', 'Image Analysis': 'satellite', 'Remote sensing': 'satellite', 'LiDAR and 3D': 'pointcloud',
  Interpolation: 'gp-interpolate', Cartography: 'palette', 'Maps and reports': 'layout', 'Data Management': 'database',
  'Field data and devices': 'phone', 'Network Analysis': 'gp-network', 'Landscape Ecology': 'leaf', 'Scripting (R and Python)': 'code',
  Conversion: 'gp-convert', Plugins: 'puzzle',
};
export function toolIcon(t: { name: string; aka: string; category: string; kind: string; tool?: { icon?: string } }): string {
  const name = t.name.toLowerCase();
  if (t.kind === 'recipe') for (const [re, ic] of RECIPE_RULES) if (re.test(name)) return ic;
  for (const [re, ic] of ICON_RULES) if (re.test(name)) return ic;
  if (TOOLSET_ICON[t.category]) return TOOLSET_ICON[t.category];
  const aka = t.aka.toLowerCase();
  for (const [re, ic] of ICON_RULES) if (re.test(aka)) return ic;
  return TOOLBOX_ICON[toolboxOf(t.category)] ?? (t.kind === 'recipe' ? 'play' : t.tool?.icon && ICONS[t.tool.icon] ? t.tool.icon : 'toolbox');
}
const toolsetOf = (category: string) => category.split(' › ')[1] ?? '';

export class Toolbox {
  private tools: Tool[] = [];
  /** rasters on the map, for recipe inputs of type raster */
  private rasterList: { id: string; title: string }[] = [];
  private query = '';
  private open = new Set<string>(['Ready-made analyses']);
  private current: Tool | null = null;
  private recent: string[] = [];

  constructor(private el: HTMLElement, private host: ToolboxHost) {
    try {
      this.recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    } catch {
      this.recent = [];
    }
    el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.classList.contains('tb-search')) {
        this.query = t.value;
        this.current = null;
        this.render();
        // a new query starts at the top of the list
        this.el.closest('.dock-body')?.scrollTo(0, 0);
      }
    });
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      this.runCurrent(e.target as HTMLFormElement);
    });
  }

  /** Read every source again (recipes, steps, plugins). */
  async reload() {
    const be = this.host.backend;
    this.rasterList = await be.json<{ rasters: { id: string; title: string }[] }>('api/rasters').then((x) => x.rasters).catch(() => []);
    const [r, s, p] = await Promise.all([
      be.json<{ recipes: RecipeInfo[] }>('api/recipes').catch(() => ({ recipes: [] as RecipeInfo[] })),
      be.json<{ steps: StepDoc[] }>('api/steps').catch(() => ({ steps: [] as StepDoc[] })),
      be.json<{ plugins: PluginInfo[] }>('api/plugins').catch(() => ({ plugins: [] as PluginInfo[] })),
    ]);
    const tools: Tool[] = [];
    for (const x of r.recipes) {
      tools.push({ key: `r:${x.id}`, kind: 'recipe', name: x.title || x.id, summary: x.description, category: x.kit ? `Ready-made analyses › ${x.kit} kit` : 'Ready-made analyses', source: '', aka: '', recipe: x });
    }
    for (const x of s.steps) {
      tools.push({ key: `s:${x.name}`, kind: 'step', name: STEP_TITLES[x.name] ?? x.name, summary: x.summary, category: FAMILY_TOOLBOX[x.family] ?? 'Data Management', source: '', aka: x.borrowed ?? '', step: x });
    }
    // the twelve domain plugins share tools (Slope zones is in five of them): each shows once, with the
    // domains it belongs to; a plugin that names two tools alike gets the second one's id as its name
    const shared = new Map<string, Tool>();
    for (const pl of p.plugins.filter((x) => !x.library)) {
      const names = new Set<string>();
      for (const t of pl.tools ?? []) {
        if (pl.id.startsWith('geospax-')) {
          const seen = shared.get(t.id);
          const domain = pl.name.replace(/^GeoSpaX\s*/, '');
          if (seen) {
            seen.aka += `, ${domain}`;
            seen.summary = seen.summary.replace(/^\(in ([^)]*)\) /, (_, d) => `(in ${d}, ${domain}) `);
            continue;
          }
        }
        const display = names.has(t.name) ? t.id.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) : t.name;
        names.add(t.name);
        // built-in tool sets file their tools by task, like the engine's own; added plugins go under
        // Plugins, one toolset each, with where they come from
        const src = SOURCE_LABEL[pl.source] ?? pl.source;
        const cat = pl.builtin ? t.group || 'Analysis' : `Plugins › ${pl.name}`;
        const dom = pl.id.startsWith('geospax-');
        const entry: Tool = { key: `p:${pl.id}/${t.id}`, kind: 'plugin', name: display, summary: dom ? `(in ${pl.name.replace(/^GeoSpaX\s*/, '')}) ${t.summary}` : t.summary, category: dom ? 'Plugins › Domain tools' : cat, source: pl.builtin ? '' : src, aka: t.id, plugin: pl, tool: t };
        if (dom) shared.set(t.id, entry);
        tools.push(entry);
      }
    }
    this.tools = tools;
    this.render();
  }

  /** Ranked matches: name start, name, words in the summary, then what the tool stands in for. */
  private search(q: string): Tool[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: [number, Tool][] = [];
    for (const t of this.tools) {
      const name = t.name.toLowerCase();
      const hay = `${name} ${t.summary} ${t.aka} ${t.category} ${t.source} ${t.step?.name ?? ''} ${t.plugin && !t.plugin.builtin ? t.plugin.name : ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      let s = 0;
      if (name.startsWith(words[0])) s += 50;
      if (words.every((w) => name.includes(w))) s += 30;
      if (t.kind === 'step' && t.aka.toLowerCase().includes(q.toLowerCase())) s += 20; // an ArcGIS / QGIS tool name
      if (t.kind === 'recipe') s += 60; // a finished map and report beats a single tool
      scored.push([s, t]);
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).map(([, t]) => t);
  }

  render() {
    if (this.current) return this.renderTool(this.current);
    const q = this.query.trim();
    const head = `<div class="tb-head">
      <input type="search" class="tb-search" placeholder="Find a tool: buffer, slope, kernel density…" value="${esc(this.query)}" aria-label="Find a tool" />
      <div class="tb-sources"><span class="dim">${this.tools.length.toLocaleString('en-US')} tools in ${new Set(this.tools.map((t) => toolboxOf(t.category))).size} toolboxes</span></div>
    </div>`;
    let body = '';
    if (q) {
      const hits = this.search(q);
      body = `<div class="tb-count">${hits.length.toLocaleString('en-US')} tool${hits.length === 1 ? '' : 's'}${hits.length > 150 ? ' · showing the best 150' : ''}</div>` +
        hits.slice(0, 150).map((t) => this.row(t)).join('');
      if (!hits.length) body += `<p class="tb-empty">Nothing matches “${esc(q)}”. Try a shorter word, or the name the tool has in ArcGIS Pro or QGIS.</p>`;
    } else {
      const recent = this.recent.map((k) => this.tools.find((t) => t.key === k)).filter(Boolean) as Tool[];
      if (recent.length) body += `<div class="tb-cat static"><span>Recently used</span></div>${recent.slice(0, 5).map((t) => this.row(t)).join('')}`;
      // toolbox, then its toolsets (tools with no toolset first), like ArcGIS Pro's toolboxes
      const boxes = new Map<string, Tool[]>();
      for (const t of this.tools) boxes.set(toolboxOf(t.category), [...(boxes.get(toolboxOf(t.category)) ?? []), t]);
      const order = [...boxes.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      for (const c of order) {
        const list = boxes.get(c)!;
        const isOpen = this.open.has(c);
        body += `<button class="tb-cat" data-cat="${esc(c)}" aria-expanded="${isOpen}"><span>${isOpen ? '▾' : '▸'} <span class="tb-ico tb-ico-box">${icon(TOOLBOX_ICON[c] ?? 'toolbox', 16)}</span> ${esc(c)}</span><em>${list.length.toLocaleString('en-US')}</em></button>`;
        if (!isOpen) continue;
        const sets = new Map<string, Tool[]>();
        for (const t of list) sets.set(toolsetOf(t.category), [...(sets.get(toolsetOf(t.category)) ?? []), t]);
        for (const set of [...sets.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
          const tools = sets.get(set)!.sort((a, b) => a.name.localeCompare(b.name));
          if (set) body += `<div class="tb-set">${esc(set)} <em>${tools.length}</em></div>`;
          body += tools.map((t) => this.row(t)).join('');
        }
      }
    }
    this.el.innerHTML = head + `<div class="tb-list">${body}</div>`;
    const s = this.el.querySelector<HTMLInputElement>('.tb-search');
    if (s && q) {
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  }

  private row(t: Tool): string {
    const aka = t.kind === 'step' && t.aka ? `<small class="tb-aka">≈ ${esc(t.aka)}</small>` : '';
    return `<button class="tb-tool" data-tool="${esc(t.key)}">
      <span class="tb-ico tb-ico-${t.kind}">${icon(toolIcon(t), 18)}</span>
      <span class="tb-name">${esc(t.name)}${t.source ? ` <span class="tb-src src-${esc(t.source.toLowerCase())}">${esc(t.source)}</span>` : ''}</span>
      <small>${esc(t.summary.length > 120 ? `${t.summary.slice(0, 120)}…` : t.summary)}</small>${aka}
    </button>`;
  }

  private renderTool(t: Tool) {
    const layers = this.host.layers();
    const active = this.host.activeId();
    const layerSel = (name: string) =>
      `<select name="${esc(name)}"><option value="auto">auto: GeoSpaX picks</option>${layers
        .map((l) => `<option value="${esc(l.id)}" ${l.id === active ? 'selected' : ''}>${esc(l.name)}</option>`)
        .join('')}</select>`;
    let body = '';
    if (t.kind === 'recipe') {
      const r = t.recipe!;
      const fields = [...new Set(layers.flatMap((l) => l.fields.map((f) => f.name)))];
      body = `<form class="tb-form">${(r.inputs ?? [])
        .map((i) => {
          const label = `<span>${esc(i.name.replace(/_/g, ' '))}<small>${esc(i.description)}</small></span>`;
          if (i.type === 'layer') return `<label>${label}${layerSel(i.name)}</label>`;
          if (i.type === 'raster')
            return `<label>${label}<select name="${esc(i.name)}"><option value="">(choose a raster)</option>${this.rasterList
              .map((x) => `<option value="${esc(x.id)}">${esc(x.title || x.id)}</option>`)
              .join('')}</select></label>`;
          if (i.type === 'field') return `<label>${label}<select name="${esc(i.name)}"><option value="auto">auto</option>${fields.map((f) => `<option>${esc(f)}</option>`).join('')}</select></label>`;
          return `<label>${label}<input name="${esc(i.name)}" value="${esc(i.default ?? '')}" /></label>`;
        })
        .join('')}
        <button type="submit" class="primary">▶ Run</button></form>
        <p class="tb-note">Runs the whole recipe: the result joins the map, with a laid-out map and a report under Activity / History.</p>`;
    } else if (t.kind === 'step') {
      const used = this.tools.filter((x) => x.kind === 'recipe' && x.recipe!.steps?.some((s) => s.use === t.name));
      body = `${t.aka ? `<p class="tb-aka-big"><b>Stands in for</b>${esc(t.aka)}</p>` : ''}
        <h4>Parameters</h4><dl class="tb-params">${t.step!.params.map((p) => `<dt>${esc(p.name)}${p.required ? ' *' : ''}</dt><dd>${esc(p.description ?? '')}</dd>`).join('') || '<dd>none</dd>'}</dl>
        <h4>Ready-made analyses that use it</h4>
        ${used.length ? used.map((u) => this.row(u)).join('') : '<p class="tb-note">None yet: use it in your own recipe (docs/AUTOMATION.md).</p>'}`;
    } else {
      const p = t.plugin!;
      const where = p.builtin ? esc(t.category.replace(' › ', ' › ')) : `${esc(p.name)} · ${esc(SOURCE_LABEL[p.source] ?? p.source)} plugin`;
      body = `<p class="tb-note">${where}${p.runnable ? '' : ` · <b>needs ${esc(p.needs ?? 'its runtime')}${p.needs === 'node' ? ' (Node.js)' : ''}</b>`}</p>
        <h4>Parameters</h4><ul class="tb-plist">${(t.tool!.params ?? []).map((x) => `<li><b>${esc(x.label || x.name)}</b>${x.required ? ' *' : ''} <small>${esc(x.description ?? '')}</small></li>`).join('') || '<li>none</li>'}</ul>
        <button class="primary" data-open-plugin ${p.runnable ? '' : 'disabled'}>Open the tool…</button>`;
    }
    this.el.innerHTML = `<div class="tb-detail">
      <button class="tb-back" data-back>← All tools</button>
      <h3><span class="tb-ico tb-ico-${t.kind}">${icon(toolIcon(t), 22)}</span>${esc(t.name)}${t.source ? ` <span class="tb-src src-${esc(t.source.toLowerCase())}">${esc(t.source)}</span>` : ''}</h3>
      <p class="tb-sum">${esc(t.summary)}</p>${body}</div>`;
  }

  private remember(t: Tool) {
    this.recent = [t.key, ...this.recent.filter((k) => k !== t.key)].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    } catch {
      /* session only */
    }
  }

  private runCurrent(form: HTMLFormElement) {
    const t = this.current;
    if (!t?.recipe) return;
    const inputs: Record<string, unknown> = {};
    new FormData(form).forEach((v, k) => (inputs[k] = v));
    this.remember(t);
    this.host.runRecipe(t.recipe.id, inputs);
    this.host.setStatus(`Running ${t.name}…`);
  }

  private onClick(e: Event) {
    const el = e.target as HTMLElement;
    if (el.closest('[data-back]')) {
      this.current = null;
      return this.render();
    }
    const cat = el.closest<HTMLElement>('[data-cat]')?.dataset.cat;
    if (cat) {
      if (!this.open.delete(cat)) this.open.add(cat);
      return this.render();
    }
    if (el.closest('[data-open-plugin]') && this.current?.plugin && this.current.tool) {
      this.remember(this.current);
      return this.host.openPluginTool(this.current.plugin, this.current.tool);
    }
    const key = el.closest<HTMLElement>('[data-tool]')?.dataset.tool;
    const t = key ? this.tools.find((x) => x.key === key) : undefined;
    if (t) {
      this.current = t;
      this.render();
    }
  }

  /** Show the list filtered by a query (ribbon buttons of big plugins). */
  find(q: string) {
    this.current = null;
    this.query = q;
    this.render();
  }

  /** Open one tool by its key (palette, ribbon). */
  show(key: string) {
    const t = this.tools.find((x) => x.key === key);
    if (t) {
      this.current = t;
      this.render();
    }
  }
}

/** Ready-made first, then building blocks, then plugin toolboxes. */
function rank(c: string): number {
  const i = TOOLBOXES.indexOf(c);
  return i < 0 ? TOOLBOXES.length - 1 : i;
}
