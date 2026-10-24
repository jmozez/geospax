// The Pro-style shell: ribbon, dockable panes, splitters, status bar, command palette
// and history. It renders commands (commands.ts) and hosts the panes that already exist
// (symbology, rasters, devices, automate) instead of replacing them, so the engine keeps
// one front end. Layout state (pane sizes, open tabs) persists in localStorage.
import * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';
import { DocsViewer } from './docs';
import type { RecipeInfo } from './automate';
import type { PluginsPane } from './plugins';
import { groupItemsHtml, COMMANDS, TABS, commandHtml, groupsFor, icon, pluginIcon, recipeIcon, type Command, type CommandHost, type TabId } from './commands';
import type { PluginInfo, PluginsState } from './plugins';
import { ONLINE_SOURCES } from './online';
import { bytesText, followJob } from './downloads';

/** Public open data in cloud storage, one click in "＋ Add" (read without signing in). */
const CLOUD_PRESETS: { title: string; url: string; endpoint?: string; region?: string; about: string; ask?: string }[] = [
  { title: 'Source Cooperative', url: 's3://', endpoint: 'https://data.source.coop', about: 'Open geospatial data shared by many organisations (source.coop)', ask: 'Type the account and repository after s3://, as shown on source.coop (for example s3://account/repository), then Connect.' },
  { title: 'Sentinel-2 COGs (AWS)', url: 's3://sentinel-cogs/sentinel-s2-l2a-cogs', region: 'us-west-2', about: 'Sentinel-2 Level-2A scenes as cloud-optimised GeoTIFFs, by UTM tile and date' },
  { title: 'Copernicus DEM 30 m (AWS)', url: 's3://copernicus-dem-30m', region: 'eu-central-1', about: 'Global elevation model, one GeoTIFF per 1° tile' },
  { title: 'Overture Maps files (AWS)', url: 's3://overturemaps-us-west-2/release', region: 'us-west-2', about: 'The raw GeoParquet releases (for areas, use GeoSpaX › Overture Maps instead)' },
];

/** Overture Maps themes (the engine's geoparquet::OVERTURE). */
const OVERTURE_THEMES: [string, string][] = [
  ['buildings', 'Buildings'], ['roads', 'Roads and paths'], ['places', 'Places (shops, schools, clinics…)'], ['water', 'Water'],
  ['land_use', 'Land use'], ['land_cover', 'Land cover'], ['boundaries', 'Boundaries'], ['addresses', 'Addresses'],
];

const LS_KEY = 'geospax.workbench.v1';
const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Dock = 'left' | 'right' | 'bottom';
type DockTab = Record<Dock, string>;

interface Layout {
  left: number;
  right: number;
  bottom: number;
  collapsed: Dock[];
  tabs: DockTab;
  ribbon: TabId;
  /** true = big galleries (recipes, plugin tools) collapse into one dropdown button. */
  compact: boolean;
  /** false = auto-hide: the ribbon body opens on a tab click and closes again after use. */
  ribbonPinned: boolean;
}

const DEFAULT_LAYOUT: Layout = {
  left: 300,
  right: 340,
  bottom: 232,
  collapsed: [],
  tabs: { left: 'contents', right: 'symbology', bottom: 'automate' },
  ribbon: 'home',
  compact: true,
  ribbonPinned: true,
};

export interface WorkbenchHost {
  backend: Backend;
  map: maplibregl.Map;
  edition: string;
  layers: () => LayerInfo[];
  layerById: (id: string) => LayerInfo | undefined;
  activeId: () => string | null;
  setActive: (id: string | null) => void;
  fitLayer: (id: string) => void;
  fitAll: () => void;
  autostyle: (id: string) => Promise<void>;
  reload: () => Promise<void>;
  save: () => void;
  runRecipe: (id: string) => Promise<void>;
  openRun: (runId: string) => void;
  bench: () => void;
  deck: () => void;
  refreshContents: () => void;
  openAttributes: (id: string) => void;
  plugins: () => PluginsPane | null;
  layersWithFields: () => { id: string; name: string; fields?: { name: string; kind: string }[] }[];
  /** Lazy: one-row task bar; Pro: the full ribbon with a contextual Layer tab. */
  mode: () => 'lazy' | 'pro';
  /** Friendly name of a layer, as the layer cards show it. */
  layerName: (id: string) => string;
  /** Analyses that fit this layer, best first (the same as its card's buttons). */
  nextSteps: (id: string) => { label: string; run: () => void }[];
}

interface BrowseListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  files: { name: string; path: string; kind: string; size: number; on_map: string[]; container?: boolean }[];
}

interface InsideItem { name: string; path: string; kind: string; layer?: string; geometry?: string; count?: number; on_map?: string[] }
interface Preview { kind: 'vector' | 'raster'; layer?: string; geometry?: string; count?: number; crs: string; bounds: [number, number, number, number] | null; fields?: { name: string; type: string }[]; rows?: (string | null)[][]; width?: number; height?: number; bands?: number }

const FAV_KEY = 'geospax.favourites';

interface RunRow {
  id: string;
  recipe: string;
  title: string;
  status: string;
  elapsed_ms: number;
  trigger?: { kind: string; text: string };
  artifacts?: string[];
  error?: string | null;
}

/** The narrowest the left pane gets: its three tabs and a layer name still fit. */
const MIN_LEFT = 240;

export class Workbench {
  private layout: Layout = { ...DEFAULT_LAYOUT, tabs: { ...DEFAULT_LAYOUT.tabs } };
  private paletteOpen = false;
  private paletteItems: { id: string; label: string; sub: string; kind: string; run: () => void }[] = [];
  private paletteIndex = 0;
  private logs: { t: string; level: string; text: string }[] = [];
  private runs: RunRow[] = [];
  private catalogFilter = '';
  private recipes: RecipeInfo[] = [];
  private menu: HTMLElement | null = null;
  /** Auto-hide mode: the body is showing because a tab was clicked. */
  private ribbonPeek = false;
  private statusTimer: number | undefined;
  private statusExpire = 0;

  constructor(private host: WorkbenchHost) {
    this.loadLayout();
    // a narrower or wider window: lay the ribbon out again (groups collapse or open up)
    let t: number | undefined;
    let w = window.innerWidth;
    window.addEventListener('resize', () => {
      if (Math.abs(window.innerWidth - w) < 8) return;
      w = window.innerWidth;
      clearTimeout(t);
      t = window.setTimeout(() => this.buildRibbon(), 200);
    });
  }

  // ---------------------------------------------------------------- mount

  mount() {
    this.buildRibbon();
    this.buildQuickBar();
    this.wireDockTabs();
    this.wireSplitters();
    this.applyLayout();
    this.wireKeyboard();
    this.wirePalette();
    this.wireMapStatus();
    this.wireIdentify();
    this.host.map.on('click', () => this.hideRibbon());
    this.renderCatalog();
    void this.loadRuns();
    void this.renderHistory();
    this.renderLog();
    // pane hosts may re-render themselves (contents, symbology…); keep the catalog in step
    setInterval(() => this.renderCatalog(), 4000);
    setInterval(() => void this.loadRunsSilently(), 15000);
    document.addEventListener('geospax:reload-views', () => {
      this.renderCatalog();
      void this.loadRunsSilently();
    });
    document.addEventListener('geospax:plugins-changed', () => this.buildRibbon());
    // the mode and the selected layer decide what the ribbon offers
    document.addEventListener('geospax:mode', () => {
      this.buildRibbon();
      this.applyModeTabs();
    });
    document.addEventListener('geospax:active', () => {
      this.buildRibbon();
      this.renderActivity();
    });
    document.addEventListener('geospax:reload-views', () => this.renderActivity());
    this.applyModeTabs();
    this.renderActivity();
  }

  /** The command host every ribbon button sees. */
  private cmdHost(): CommandHost {
    const h = this.host;
    return {
      backend: h.backend,
      map: h.map,
      layers: h.layers,
      activeId: h.activeId,
      setActive: h.setActive,
      fitLayer: h.fitLayer,
      fitAll: h.fitAll,
      autostyle: h.autostyle,
      reload: h.reload,
      save: h.save,
      recipes: async () => {
        const r = await h.backend.json<{ recipes: RecipeInfo[] }>('api/recipes');
        return r.recipes;
      },
      runRecipe: h.runRecipe,
      openRun: h.openRun,
      showTab: (dock, tab) => this.showTab(dock, tab),
      toggleDock: (dock) => this.toggleDock(dock),
      bench: h.bench,
      deck: h.deck,
      setStatus: (t, ms) => this.setStatus(t, ms),
      log: (line, level) => this.log(line, level),
      // guides open inside the app (a new tab cannot show Markdown, and the desktop window and phones have no tabs)
      openUrl: (p) => (/\.md(#.*)?$/.test(p) ? void this.docs().open(p) : window.open(p, '_blank', 'noopener')),
      about: () => void this.docs().about(this.host.edition),
      setRibbonCompact: (compact) => this.setRibbonCompact(compact),
      toggleRibbon: () => this.setRibbonPinned(!this.layout.ribbonPinned),
    };
  }

  private docsViewer?: DocsViewer;
  private docs(): DocsViewer {
    return (this.docsViewer ??= new DocsViewer(this.host.backend));
  }

  // ---------------------------------------------------------------- ribbon

  private buildQuickBar() {
    const el = document.querySelector<HTMLElement>('#quickbar');
    if (!el) return;
    const quick = ['home.save', 'home.refresh', 'view.zoomAll', 'view.palette'];
    el.innerHTML = quick
      .map((id) => {
        const c = COMMANDS.find((x) => x.id === id);
        return c ? `<button data-cmd="${c.id}" title="${esc(c.title)}">${icon(c.icon, 16)}</button>` : '';
      })
      .join('');
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
      if (b) void this.run(b.dataset.cmd!);
    });
  }

  private buildRibbon() {
    this.closeMenu();
    const tabsEl = document.querySelector<HTMLElement>('#ribbon-tabs');
    const bodyEl = document.querySelector<HTMLElement>('#ribbon-body');
    if (!tabsEl || !bodyEl) return;
    const pinned = this.layout.ribbonPinned;
    const lazy = this.host.mode() === 'lazy';
    document.querySelector<HTMLElement>('#ribbon')?.classList.toggle('lazy', lazy);
    const active = this.host.activeId();
    if (this.layout.ribbon === 'layer' && !active) this.layout.ribbon = 'home';
    // a tab that no longer exists (Modelling went into Analysis in 3.0.1) falls back to Home
    if (this.layout.ribbon !== 'layer' && !TABS.some((t) => t.id === this.layout.ribbon)) this.layout.ribbon = 'home';
    // contextual tab, coloured like Pro's: only while a layer is selected
    const ctx = active
      ? `<button class="rb-ctx${this.layout.ribbon === 'layer' ? ' on' : ''}" data-tab="layer" title="Tools for the selected layer"><span>Layer</span> ${esc(this.host.layerName(active))}</button>`
      : '';
    tabsEl.innerHTML = lazy
      ? ''
      : TABS.map(
        (t) => `<button class="rb-tab${t.id === this.layout.ribbon ? ' on' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`,
      ).join('') + ctx +
      `<button class="rb-pin${pinned ? ' on' : ''}" data-ribbon-pin title="${
        pinned ? 'Ribbon is pinned open — click to auto-hide it (Ctrl+F1)' : 'Ribbon is hidden — it opens when you click a tab (Ctrl+F1)'
      }"><span class="rb-pin-ico">${icon('pin', 13)}</span><span class="rb-pin-txt">${pinned ? 'Pin' : 'Auto-hide'}</span></button>`;
    // Assignment (not addEventListener): buildRibbon runs again on every tab switch.
    tabsEl.onclick = (e) => {
      const pin = (e.target as HTMLElement).closest<HTMLElement>('[data-ribbon-pin]');
      if (pin) { this.setRibbonPinned(!this.layout.ribbonPinned); return; }
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) {
        const same = this.layout.ribbon === (b.dataset.tab as TabId) && this.ribbonVisible();
        this.layout.ribbon = b.dataset.tab as TabId;
        this.ribbonPeek = !same;
        this.saveLayout();
        this.buildRibbon();
      }
    };
    bodyEl.onclick = (e) => {
      const t = e.target as HTMLElement;
      const combo = t.closest<HTMLElement>('[data-menu]');
      if (combo) {
        const kind = combo.dataset.menu!;
        const wasOpen = this.menu?.dataset.kind === kind;
        this.closeMenu();
        if (!wasOpen) this.openMenu(combo, kind);
        return;
      }
      const gal = t.closest<HTMLElement>('[data-gallery]');
      if (gal) {
        this.closeMenu();
        this.setRibbonCompact(gal.dataset.gallery === 'collapse');
        return;
      }
      const rec = t.closest<HTMLElement>('[data-recipe]');
      if (rec?.dataset.recipe) {
        this.hideRibbon();
        this.setStatus(`Running ${rec.dataset.recipe}…`);
        this.showTab('bottom', 'automate');
        void this.host.runRecipe(rec.dataset.recipe);
        return;
      }
      const tool = t.closest<HTMLElement>('[data-plugin-tool]')?.dataset.pluginTool;
      if (tool) {
        const [pid, tid] = tool.split('/');
        const p = this.host.plugins()?.plugins.find((x) => x.id === pid);
        const tl = p?.tools.find((x) => x.id === tid);
        if (p && tl) this.hideRibbon();
        if (p && tl) this.host.plugins()?.openTool(p, tl);
        return;
      }
      const tbx = t.closest<HTMLElement>('[data-toolbox]')?.dataset.toolbox;
      if (tbx) {
        this.showTab('right', 'toolbox');
        document.dispatchEvent(new CustomEvent('geospax:toolbox-search', { detail: tbx }));
        return;
      }
      const next = t.closest<HTMLElement>('[data-next]');
      if (next) {
        this.nextList[Number(next.dataset.next)]?.run();
        this.showTab('bottom', 'automate');
        return;
      }
      const b = t.closest<HTMLElement>('[data-cmd]');
      if (b) void this.run(b.dataset.cmd!);
    };
    void (lazy ? this.renderTaskBar(bodyEl) : this.renderRibbonBody(bodyEl));
  }

  private nextList: { label: string; run: () => void }[] = [];

  /** "Next step" buttons: the analyses that fit the selected layer. */
  private nextHtml(cls: string): string {
    const id = this.host.activeId();
    this.nextList = id ? this.host.nextSteps(id) : [];
    if (!id || !this.nextList.length) return '';
    return this.nextList
      .map((n, i) => `<button class="${cls}" data-next="${i}" title="Run on ${esc(this.host.layerName(id))}">${icon('play', 12)} ${esc(n.label)}</button>`)
      .join('');
  }

  /**
   * Lazy mode: the ribbon becomes one row of tasks in plain words, a "What do you want to do?" box
   * (the command palette) and the next steps for the selected layer. Every button is an ordinary
   * command, so Pro mode, the palette and scripts reach the same things.
   */
  private async renderTaskBar(bodyEl: HTMLElement) {
    bodyEl.hidden = false;
    document.querySelector<HTMLElement>('#ribbon')?.classList.remove('auto');
    requestAnimationFrame(() => this.host.map.resize());
    try {
      if (!this.recipes.length) this.recipes = (await this.host.backend.json<{ recipes: RecipeInfo[] }>('api/recipes')).recipes;
    } catch { /* engine offline: the menu stays empty */ }
    const task = (attr: string, ico: string, title: string, sub: string) =>
      `<button class="tk-task" ${attr}><span class="tk-ico">${icon(ico, 20)}</span><span class="tk-txt"><b>${esc(title)}</b><small>${esc(sub)}</small></span></button>`;
    const id = this.host.activeId();
    const next = this.nextHtml('tk-next-btn');
    bodyEl.innerHTML = `<div class="tk-bar">
      <button class="tk-ask" data-cmd="view.palette">${icon('search', 16)}<span>What do you want to do?</span><kbd>Ctrl K</kbd></button>
      <div class="tk-tasks">
        ${task('data-cmd="home.start"', 'phone', 'Add data', 'Drop files, a phone, a GPS, a drone card')}
        ${task('data-cmd="data.online"', 'globe', 'Online data', 'Climate, soil, species, boundaries')}
        ${task('data-cmd="style.autoAll"', 'wand', 'Make it look good', 'Style every layer for you')}
        ${task('data-menu="recipes"', 'hotspot', 'Find patterns', `${this.generalRecipes().length} ready-made analyses`)}
        ${task('data-cmd="analyze.toolbox"', 'search', 'All tools', 'Search every tool by name')}
        ${task('data-cmd="home.finish"', 'print', 'Finish my map', 'Legend, scale bar, PDF and report')}
      </div>
      ${
        next
          ? `<div class="tk-next"><span class="tk-next-h">Next for <b>${esc(this.host.layerName(id!))}</b></span>${next}</div>`
          : `<div class="tk-next empty"><span class="tk-next-h">Select a layer to see what you can do with it</span></div>`
      }
    </div>`;
  }

  private ribbonVisible(): boolean {
    return this.layout.ribbonPinned || this.ribbonPeek;
  }

  /** Auto-hide mode: put the body away after a command, a map click or Escape. */
  private hideRibbon() {
    if (this.layout.ribbonPinned || !this.ribbonPeek) return;
    this.ribbonPeek = false;
    this.buildRibbon();
  }

  setRibbonPinned(pinned: boolean) {
    this.layout.ribbonPinned = pinned;
    // Unpinning collapses it at once (Pro does the same): click a tab to bring it back.
    this.ribbonPeek = false;
    this.saveLayout();
    this.buildRibbon();
    this.setStatus(pinned ? 'Ribbon pinned open' : 'Ribbon auto-hides — click a tab to use it, Ctrl+F1 to pin it back');
  }

  private async renderRibbonBody(bodyEl: HTMLElement) {
    const visible = this.ribbonVisible();
    bodyEl.hidden = !visible;
    document.querySelector<HTMLElement>('#ribbon')?.classList.toggle('auto', !visible);
    requestAnimationFrame(() => this.host.map.resize());
    if (!visible) { bodyEl.innerHTML = ''; return; }
    const groups = groupsFor(this.layout.ribbon);
    const parts: string[] = [];
    for (const g of groups) {
      const items = groupItemsHtml(g.items.filter((c) => c.big).map((c) => commandHtml(c)), g.items.filter((c) => !c.big).map((c) => commandHtml(c)));
      parts.push(`<div class="rb-group"><div class="rb-items">${items}</div><div class="rb-title">${esc(g.group)}</div></div>`);
    }
    // contextual Layer tab: the analyses that fit the selected layer, run on it
    if (this.layout.ribbon === 'layer') {
      const next = this.nextHtml('rb-next');
      if (next) parts.push(`<div class="rb-group"><div class="rb-items next">${next}</div><div class="rb-title">Next steps for this layer</div></div>`);
    }
    // Analyze: recipes straight from the engine — collapsed to one dropdown button by
    // default (Pro collapses a gallery the same way) so the ribbon stays one row tall.
    if (this.layout.ribbon === 'analyze') {
      try {
        this.recipes = (await this.host.backend.json<{ recipes: RecipeInfo[] }>('api/recipes')).recipes;
        const r = { recipes: this.generalRecipes() };
        if (this.layout.compact) {
          parts.unshift(
            `<div class="rb-group" data-group="recipes"><div class="rb-items">${this.comboHtml({
              menu: 'recipes',
              icon: 'wand',
              label: 'Recipes',
              count: r.recipes.length,
              title: `${r.recipes.length} recipes — click to open the list`,
            })}</div><div class="rb-title">Recipes ${this.galleryToggle()}</div></div>`,
          );
        } else {
          const cards = r.recipes
            .slice(0, 10)
            .map((x) => {
              const desc = (x.description ?? '').replace(/\s+/g, ' ').trim();
              return `<button class="rb-recipe" data-recipe="${esc(x.id)}" title="${esc(desc)}">
              <span class="rr-ico">${icon(recipeIcon(x), 22)}</span>
              <span class="rr-txt"><span class="rr-name">${esc(x.title ?? x.id)}</span><span class="rr-desc">${esc(
                desc.length > 96 ? `${desc.slice(0, 96)}…` : desc,
              )}</span></span>
              <span class="rr-run">${icon('play', 12)} Run</span>
            </button>`;
            })
            .join('');
          parts.unshift(
            `<div class="rb-group wide" data-group="recipes"><div class="rb-items recipes">${cards}</div>` +
              `<div class="rb-title">Recipes — click to run ${this.galleryToggle()}</div></div>`,
          );
        }
      } catch { /* engine offline: the static commands still work */ }
    }
    // Plugin tools on the tab their manifest names (`tab:`), one group per tool group; a whole
    // third-party tool library (40+ tools) is one button that opens the Toolbox (the built-in 1,000+ are filed in the Toolbox by task); tools that name no
    // tab go to the Plugins tab (like ArcGIS Pro's Add-In tab).
    const tab = this.layout.ribbon;
    const before = parts.length;
    // the default domain plugins (GSX: Agriculture, Biodiversity …) are one grid of buttons, each
    // opening its tools and its kit, so twelve domains fit the ribbon without scrolling
    const domains = this.pluginTools().filter((p) => p.default && (p.tools[0]?.tab ?? 'plugins') === 'plugins');
    if (tab === 'plugins' && domains.length) {
      const btns = domains
        .map((p) => `<button class="rb-btn small" data-menu="plugin:${esc(p.id)}" title="${esc(p.name)}: ${p.tools.length} tools — ${esc(p.description)}" aria-haspopup="true">
            <span class="rb-ico">${icon(pluginIcon(p), 16)}</span><span class="rb-label">${esc(p.name)}</span><span class="rb-caret">${icon('caret', 10)}</span></button>`)
        .join('');
      parts.push(`<div class="rb-group" data-group="domains"><div class="rb-items grid3">${btns}</div><div class="rb-title">Domain plugins (GSX)</div></div>`);
    }
    for (const p of this.pluginTools()) {
      if (tab === 'plugins' && domains.includes(p)) continue;
      // a built-in library (1,000+ raster, terrain, hydrology … tools) lives in the Toolbox, by task
      if (p.builtin && p.tools.length > 40) continue;
      if (p.tools.length > 40) {
        if ((p.tools[0]?.tab ?? 'analyze') !== tab) continue;
        parts.push(`<div class="rb-group" data-group="plugin:${esc(p.id)}"><div class="rb-items">
          <button class="rb-btn big" data-toolbox="${esc(p.name)}" title="Search the ${p.tools.length.toLocaleString('en-US')} tools of ${esc(p.name)} in the Toolbox">
            <span class="rb-ico">${icon('grid', 20)}</span><span class="rb-label">${esc(p.name)}<br><small>${p.tools.length.toLocaleString('en-US')} tools</small></span></button>
          </div><div class="rb-title">${esc(p.name)}</div></div>`);
        continue;
      }
      const mine = p.tools.filter((t) => (t.tab ?? 'plugins') === tab);
      const groups = new Map<string, typeof mine>();
      for (const t of mine) groups.set(t.group || p.name, [...(groups.get(t.group || p.name) ?? []), t]);
      for (const [group, tools] of groups) {
        const key = `plugin:${p.id}:${group}`;
        const inline = groupItemsHtml(
          [],
          tools.slice(0, 12).map(
            (t) =>
              `<button class="rb-btn small" data-plugin-tool="${esc(p.id)}/${esc(t.id)}" title="${esc(t.summary || t.name)}">
              <span class="rb-ico">${icon(t.icon ?? 'grid', 16)}</span>
              <span class="rb-label">${esc(t.name)}</span>
            </button>`,
          ),
        );
        // more than three tools and the row would eat the ribbon: collapse to a list
        const body =
          this.layout.compact && tools.length > 3
            ? this.comboHtml({ menu: key, icon: tools[0].icon ?? 'grid', label: group.split(' › ').pop()!, count: tools.length, title: `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}` })
            : inline;
        parts.push(
          `<div class="rb-group" data-group="${esc(key)}"><div class="rb-items">${body}</div><div class="rb-title">${esc(group.split(' › ').pop()!)}${tools.length > 3 ? this.galleryToggle() : ''}</div></div>`,
        );
      }
    }
    if (tab === 'plugins' && parts.length === before) {
      parts.push(`<div class="rb-group"><div class="rb-items"><span class="dim rb-empty">No plugin tools here yet. Tools of plugins that name no other tab show here.</span></div><div class="rb-title">Plugins</div></div>`);
    }
    bodyEl.innerHTML = parts.join('') + `<div class="rb-spacer"></div>`;
    this.fitRibbon(bodyEl);
  }

  // ------------------------------------------------- compact galleries (dropdowns)

  /** true keeps the ribbon one row tall; false expands recipes/tools into cards. */
  setRibbonCompact(compact: boolean) {
    if (this.layout.compact === compact) return;
    this.layout.compact = compact;
    this.saveLayout();
    this.buildRibbon();
    this.setStatus(compact ? 'Ribbon: galleries collapsed into lists' : 'Ribbon: galleries expanded');
  }

  /** One button that opens a list — ArcGIS Pro collapses a gallery the same way. */
  private comboHtml(o: { menu: string; icon: string; label: string; count: number; title: string }): string {
    return `<button class="rb-combo" data-menu="${esc(o.menu)}" title="${esc(o.title)}" aria-haspopup="true">
        <span class="rb-ico">${icon(o.icon, 20)}</span>
        <span class="rb-combo-label">${esc(o.label)}</span>
        <span class="rb-combo-count">${o.count}</span>
        <span class="rb-caret">${icon('caret', 12)}</span>
      </button>`;
  }

  /** The little expand/collapse affordance in a group's title. */
  private galleryToggle(): string {
    return this.layout.compact
      ? `<button class="rb-title-btn" data-gallery="expand" title="Show these as a gallery">${icon('gallery', 10)}</button>`
      : `<button class="rb-title-btn" data-gallery="collapse" title="Collapse these into a list">${icon('grid', 10)}</button>`;
  }

  /** Groups collapsed to one button when the window is too narrow (their buttons, by group index). */
  private collapsed = new Map<string, { title: string; html: string }>();

  /** ArcGIS Pro's ribbon scaling: while the tab is wider than the window, the rightmost group with
   *  several buttons becomes one button that drops its buttons down, so nothing is cut off. */
  private fitRibbon(body: HTMLElement) {
    this.collapsed.clear();
    if (body.clientWidth === 0) return;
    const groups = [...body.querySelectorAll<HTMLElement>(':scope > .rb-group')];
    for (let i = groups.length - 1; i >= 0 && body.scrollWidth > body.clientWidth + 1; i--) {
      const g = groups[i];
      const items = g.querySelector<HTMLElement>('.rb-items');
      const n = items?.querySelectorAll('button').length ?? 0;
      // an expanded gallery stays open: the user asked for it, so other groups fold first
      if (!items || n < 2 || g.querySelector('.rb-recipe')) continue;
      const title = g.querySelector('.rb-title')?.textContent?.trim() || 'More';
      const key = `group:${i}`;
      this.collapsed.set(key, { title, html: items.innerHTML });
      const ico = items.querySelector('.rb-ico svg')?.outerHTML ?? icon('grid', 20);
      items.innerHTML = `<button class="rb-btn big rb-collapsed" data-menu="${key}" title="${esc(title)}: ${n} commands" aria-haspopup="true">
        <span class="rb-ico">${ico}</span><span class="rb-label">${esc(title)} ▾</span></button>`;
      g.classList.add('collapsed');
    }
  }

  private openMenu(anchor: HTMLElement, kind: string) {
    const group = this.collapsed.get(kind);
    const rows = group ? `<div class="rb-menu-head"><span>${esc(group.title)}</span></div><div class="rb-menu-group">${group.html}</div>` : kind === 'recipes' ? this.recipeRows() : kind.startsWith('plugin:') ? this.pluginRows(kind.slice(7).split(':')[0], kind.split(':').slice(2).join(':') || undefined) : '';
    if (!rows) return;
    const el = document.createElement('div');
    el.className = 'rb-menu';
    el.dataset.kind = kind;
    el.innerHTML = rows;
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = Math.max(el.offsetWidth, 240);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 8))}px`;
    el.style.top = `${r.bottom + 3}px`;
    el.style.maxHeight = `${Math.max(180, Math.min(window.innerHeight - r.bottom - 24, window.innerHeight * 0.62))}px`;
    el.onclick = (e) => {
      const t = e.target as HTMLElement;
      // a collapsed group's buttons: commands, plugin menus, the Toolbox
      const sub = t.closest<HTMLElement>('.rb-menu-group [data-menu]');
      if (sub) {
        const k = sub.dataset.menu!;
        this.closeMenu();
        this.openMenu(anchor, k);
        return;
      }
      const cmd = t.closest<HTMLElement>('.rb-menu-group [data-cmd]')?.dataset.cmd;
      if (cmd) {
        this.closeMenu();
        void this.run(cmd);
        return;
      }
      const tbx = t.closest<HTMLElement>('.rb-menu-group [data-toolbox]')?.dataset.toolbox;
      if (tbx) {
        this.closeMenu();
        this.showTab('right', 'toolbox');
        document.dispatchEvent(new CustomEvent('geospax:toolbox-search', { detail: tbx }));
        return;
      }
      const rec = t.closest<HTMLElement>('[data-recipe]');
      if (rec?.dataset.recipe) {
        this.closeMenu();
        this.hideRibbon();
        this.setStatus(`Running ${rec.dataset.recipe}…`);
        this.showTab('bottom', 'automate');
        void this.host.runRecipe(rec.dataset.recipe);
        return;
      }
      const tool = t.closest<HTMLElement>('[data-plugin-tool]')?.dataset.pluginTool;
      if (tool) {
        this.closeMenu();
        this.hideRibbon();
        const [pid, tid] = tool.split('/');
        const p = this.host.plugins()?.plugins.find((x) => x.id === pid);
        const tl = p?.tools.find((x) => x.id === tid);
        if (p && tl) this.host.plugins()?.openTool(p, tl);
      }
    };
    anchor.classList.add('on');
    this.menu = el;
  }

  private closeMenu() {
    if (!this.menu) return;
    const kind = this.menu.dataset.kind;
    this.menu.remove();
    this.menu = null;
    document.querySelectorAll<HTMLElement>('.rb-combo.on').forEach((b) => {
      if (!kind || b.dataset.menu === kind) b.classList.remove('on');
    });
  }

  /** The domain plugins (GSX) a recipe belongs to: a domain kit ("Biodiversity", "Disaster and
   *  geoscience" …) is listed with its plugins on the Plugins tab, not with the general recipes. */
  private kitDomains(x: RecipeInfo): PluginInfo[] {
    const k = x.kit?.toLowerCase();
    if (!k) return [];
    return (this.host.plugins()?.plugins ?? []).filter((p) => p.default && k.includes(p.name.toLowerCase()));
  }

  /** Recipes that are not a domain plugin's kit (Analysis, Lazy's Find patterns). */
  private generalRecipes(): RecipeInfo[] {
    return this.recipes.filter((x) => !this.kitDomains(x).length);
  }

  private recipeRow(x: RecipeInfo): string {
    const desc = (x.description ?? '').replace(/\s+/g, ' ').trim();
    return `<button class="rb-menu-row" data-recipe="${esc(x.id)}" title="${esc(desc)}">
        <span class="rm-ico">${icon(recipeIcon(x), 16)}</span>
        <span class="rm-txt"><span class="rm-name">${esc(x.title ?? x.id)}</span>${
          desc ? `<span class="rm-desc">${esc(desc.length > 90 ? `${desc.slice(0, 90)}…` : desc)}</span>` : ''
        }</span></button>`;
  }

  private recipeRows(): string {
    const recipes = this.generalRecipes();
    const head = `<div class="rb-menu-head"><span>Recipes</span><span class="dim">${recipes.length} — click to run</span></div>`;
    const row = (x: RecipeInfo) => this.recipeRow(x);
    // kits that are not a domain plugin's (satellite embeddings) first, then the general recipes
    const kits = [...new Set(recipes.map((x) => x.kit).filter((k): k is string => !!k))].sort();
    const sub = (t: string) => `<div class="rb-menu-sub">${esc(t)}</div>`;
    return (
      head +
      kits.map((k) => sub(`${k} kit`) + recipes.filter((x) => x.kit === k).map(row).join('')).join('') +
      (kits.length ? sub('General') : '') +
      recipes.filter((x) => !x.kit).map(row).join('')
    );
  }

  private pluginRows(pluginId: string, group?: string): string {
    const p = this.host.plugins()?.plugins.find((x) => x.id === pluginId);
    if (!p) return '';
    const head = `<div class="rb-menu-head"><span>${esc(group ?? p.name)}</span><span class="dim">${esc(p.name)}</span></div>`;
    const rows = p.tools
      .filter((t) => !group || (t.group || p.name) === group)
      .map(
        (t) => `<button class="rb-menu-row" data-plugin-tool="${esc(p.id)}/${esc(t.id)}" title="${esc(t.summary || t.name)}">
          <span class="rm-ico">${icon(t.icon ?? 'grid', 16)}</span>
          <span class="rm-txt"><span class="rm-name">${esc(t.name)}</span>${
            t.summary ? `<span class="rm-desc">${esc(t.summary.length > 90 ? `${t.summary.slice(0, 90)}…` : t.summary)}</span>` : ''
          }</span></button>`,
      )
      .join('');
    // a domain plugin's ready-made analyses (its kit recipes) come with its tools
    const kits = group ? [] : this.recipes.filter((x) => this.kitDomains(x).some((d) => d.id === p.id));
    const kitRows = kits.length ? `<div class="rb-menu-sub">Ready-made analyses (kit)</div>${kits.map((x) => this.recipeRow(x)).join('')}` : '';
    return rows || kitRows ? head + rows + kitRows : head + '<div class="rb-menu-empty">no tools</div>';
  }

  private async run(id: string) {
    const c = COMMANDS.find((x) => x.id === id);
    if (!c) return;
    this.setStatus(`${c.title}…`);
    this.hideRibbon();
    try {
      await c.run(this.cmdHost());
    } catch (e) {
      this.log(`${c.title} failed: ${e}`, 'error');
      this.setStatus(`${c.title} failed`, 4000);
    }
  }

  // ---------------------------------------------------------------- docks

  private wireDockTabs() {
    document.querySelectorAll<HTMLElement>('.dock-tabs').forEach((bar) => {
      const dock = (bar.dataset.dock ?? 'left') as Dock;
      bar.innerHTML = [...bar.querySelectorAll<HTMLElement>('button[data-tab]')]
        .map((b) => `<button data-tab="${b.dataset.tab}">${esc(b.textContent ?? '')}</button>`)
        .join('');
      bar.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
        if (b) this.showTab(dock, b.dataset.tab!);
      });
      bar.addEventListener('dblclick', () => this.toggleDock(dock));
    });
  }

  showTab(dock: Dock, tab: string) {
    this.layout.tabs[dock] = tab;
    if (this.layout.collapsed.includes(dock)) this.layout.collapsed = this.layout.collapsed.filter((d) => d !== dock);
    this.saveLayout();
    this.applyLayout();
    document.dispatchEvent(new CustomEvent('geospax:show-pane', { detail: dock }));
  }

  toggleDock(dock: Dock) {
    this.layout.collapsed = this.layout.collapsed.includes(dock)
      ? this.layout.collapsed.filter((d) => d !== dock)
      : [...this.layout.collapsed, dock];
    this.saveLayout();
    this.applyLayout();
  }

  private applyLayout() {
    const shell = document.querySelector<HTMLElement>('#shell');
    if (!shell) return;
    const c = this.layout.collapsed;
    // A collapsed pane keeps a 30 px strip of vertical tabs, so it can always be reopened
    // without hunting for a ribbon command (ArcGIS/QGIS convention).
    // a width saved by an older version (or dragged too narrow) never hides the pane's tabs and names
    this.layout.left = Math.min(560, Math.max(MIN_LEFT, this.layout.left));
    shell.style.setProperty('--left', c.includes('left') ? '30px' : `${this.layout.left}px`);
    shell.style.setProperty('--right', c.includes('right') ? '30px' : `${this.layout.right}px`);
    shell.style.setProperty('--bottom', c.includes('bottom') ? '30px' : `${this.layout.bottom}px`);
    document.querySelectorAll<HTMLElement>('.dock').forEach((d) => {
      const dock = (d.dataset.dock ?? 'left') as Dock;
      d.classList.toggle('collapsed', c.includes(dock));
      d.querySelectorAll<HTMLElement>('.dock-body > section').forEach((s) => {
        s.classList.toggle('on', s.dataset.tab === this.layout.tabs[dock]);
      });
      const bar = d.querySelector<HTMLElement>('.dock-tabs');
      bar?.querySelectorAll<HTMLElement>('button[data-tab]').forEach((b) => {
        b.classList.toggle('on', b.dataset.tab === this.layout.tabs[dock]);
      });
    });
    // the map must be resized when a pane opens or a splitter moves
    setTimeout(() => this.host.map.resize(), 60);
  }

  private wireSplitters() {
    const drag = (sel: string, apply: (dx: number, dy: number, start: number) => void) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return;
      let start = 0;
      let x0 = 0;
      let y0 = 0;
      const move = (e: MouseEvent) => apply(e.clientX - x0, e.clientY - y0, start);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        this.saveLayout();
      };
      el.addEventListener('mousedown', (e) => {
        const dock = (el.dataset.dock ?? 'left') as Dock;
        if (this.layout.collapsed.includes(dock)) return;
        x0 = e.clientX; y0 = e.clientY;
        start = dock === 'left' ? this.layout.left : dock === 'right' ? this.layout.right : this.layout.bottom;
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        document.body.classList.add('resizing');
      });
      el.addEventListener('dblclick', () => {
        const dock = (el.dataset.dock ?? 'left') as Dock;
        this.layout[dock] = DEFAULT_LAYOUT[dock];
        this.saveLayout();
        this.applyLayout();
      });
    };
    drag('#splitter-left', (dx) => { this.layout.left = Math.min(560, Math.max(MIN_LEFT, this.layout.left + dx)); this.applyLayout(); });
    drag('#splitter-right', (dx) => { this.layout.right = Math.min(640, Math.max(220, this.layout.right - dx)); this.applyLayout(); });
    drag('#splitter-bottom', (_dx, dy) => { this.layout.bottom = Math.min(560, Math.max(90, this.layout.bottom - dy)); this.applyLayout(); });
  }

  private loadLayout() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) this.layout = { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Layout), tabs: { ...DEFAULT_LAYOUT.tabs, ...(JSON.parse(raw) as Layout).tabs } };
    } catch { /* first run, or a stale shape: defaults are fine */ }
    // a tab that no longer exists (e.g. the old bottom Plugins tab) falls back to the default
    for (const dock of Object.keys(this.layout.tabs) as Dock[]) {
      if (!document.querySelector(`.dock-tabs[data-dock="${dock}"] [data-tab="${this.layout.tabs[dock]}"]`)) this.layout.tabs[dock] = DEFAULT_LAYOUT.tabs[dock];
    }
  }

  private saveLayout() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.layout)); } catch { /* private mode */ }
  }

  // ---------------------------------------------------------------- catalog

  private browseOpen = new Set<string>();
  private browseCache = new Map<string, BrowseListing>();
  private browseLoading = false;
  private browseRoots: { title: string; path: string; about: string; connection?: boolean }[] | null = null;
  /** false when GeoSpaX was started with --restricted: no folder connections or web services then */
  private canConnect = true;
  /** containers (GeoPackages, zips) opened in the tree, and what is inside them */
  private insideCache = new Map<string, InsideItem[] | string>();
  /** GeoSpaX section: open nodes and their lists */
  private gxOpen = new Set<string>();
  private gxData: { recipes?: RecipeInfo[]; models?: { name: string }[]; plugins?: PluginInfo[] } = {};
  /** R and Python in the Explorer: R's kits and packages, the Python environments and their packages */
  private envR: { installed: boolean; version?: string; kits: { id: string; title: string; packages: string[] }[]; packages: Record<string, string | null> } | null = null;
  private envPy: { environments: { label: string; kind: string; path: string; version: string; current: boolean }[] } | null = null;
  private envPyPkgs = new Map<string, { packages: Record<string, string | null>; total: number } | string>();
  /** web service connections and their layers */
  private services: { id: string; kind: string; url: string; title: string }[] | null = null;
  private serviceKinds: { id: string; title: string }[] = [];
  private stacCatalogs: { title: string; url: string }[] = [];
  private serviceLayers = new Map<string, { id: string; title: string; type: 'tiles' | 'features' | 'collection' | 'folder' | 'file'; kind?: string; size?: number | null }[] | string>();
  private cloudKids = new Map<string, { id: string; title: string; type: string; kind?: string; size?: number | null }[] | string>();
  /** the file or layer selected in the Explorer, with its preview */
  private sel: { path: string; layer?: string; name: string; data?: Preview; error?: string } | null = null;
  private favourites: { path: string; name: string; folder: boolean }[] = (() => {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); } catch { return []; }
  })();

  /** Re-read the open folders (after an upload, an edit or "Refresh"). */
  async refreshCatalog() {
    this.browseRoots = null;
    this.browseCache.clear();
    // R and Python are looked for again (after installing one, or a package)
    this.envR = null;
    this.envPy = null;
    this.envPyPkgs.clear();
    if (this.gxOpen.has('envs')) void this.loadEnvs().then(() => this.renderCatalog());
    await this.loadBrowse();
  }

  private async loadBrowse() {
    this.browseLoading = true;
    try {
      if (!this.browseRoots) {
        const r = await this.host.backend.json<{ roots: { title: string; path: string; about: string; connection?: boolean }[]; can_connect?: boolean }>('api/browse');
        this.browseRoots = r.roots;
        this.canConnect = r.can_connect !== false;
      }
      for (const p of this.browseOpen) {
        if (p.startsWith('in:')) {
          const c = p.slice(3);
          if (!this.insideCache.has(c)) this.insideCache.set(c, (await this.host.backend.json<{ items: InsideItem[] }>(`api/browse/inside?path=${encodeURIComponent(c)}`)).items);
        } else if (p.startsWith('ws:') || p.startsWith('wsf:')) {
          // web service and cloud folder rows: their state is kept here, but they are not disk folders
        } else if (!this.browseCache.has(p)) this.browseCache.set(p, await this.host.backend.json<BrowseListing>(`api/browse?path=${encodeURIComponent(p)}`));
      }
    } catch (e) {
      this.browseOpen.clear();
      this.browseRoots ??= [];
      this.log(`catalog: ${e}`, 'warn');
    }
    this.browseLoading = false;
    this.renderCatalog();
  }

  /**
   * The Catalog, as in ArcGIS Pro and QGIS's Browser: the data folders on disk (double-click a file to
   * add it to the map; a green tick marks files already on it), the layers on the map by source, and
   * shortcuts to sample data, recipes, devices, rasters and run history.
   */
  renderCatalog() {
    const el = document.querySelector<HTMLElement>('#catalog');
    if (!el) return;
    if (!this.browseRoots && !this.browseLoading) void this.loadBrowse();
    const f = this.catalogFilter.trim().toLowerCase();
    const KIND_ICON: Record<string, string> = { vector: 'layers', raster: 'image', project: 'save', 'point cloud': 'grid', recipe: 'play' };
    const size = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const folder = (title: string, path: string, about: string, depth: number, connection = false): string => {
      const open = this.browseOpen.has(path);
      const pad = `style="padding-left:${4 + depth * 14}px"`;
      let html = `<div class="node source folder${connection ? ' conn' : ''}" data-folder="${esc(path)}" ${pad} title="${esc(`${about ? `${about}\n` : ''}${path}`)}"><span class="tw">${open ? '▾' : '▸'}</span>${icon('folder', 14)}<span class="nm">${esc(title)}</span>${
        connection ? `<button class="ct disc" data-disconnect="${esc(path)}" title="Remove this folder connection (the folder is not touched)" aria-label="Remove the connection to ${esc(title)}">✕</button>` : ''
      }</div>`;
      if (!open) return html;
      const l = this.browseCache.get(path);
      if (!l) return `${html}<div class="pane-empty" ${pad}>Reading…</div>`;
      const kids = l.folders.map((d) => folder(d.name, d.path, '', depth + 1)).join('');
      const files = l.files
        .filter((x) => !f || x.name.toLowerCase().includes(f))
        .map((x) => this.fileRow(x.path, x.name, x.kind, depth + 1, { size: size(x.size), on: x.on_map, container: !!x.container }))
        .join('');
      return html + kids + (files || (l.folders.length ? '' : `<div class="pane-empty" style="padding-left:${18 + (depth + 1) * 14}px">${f ? 'No match' : 'No map files here'}</div>`));
    };
    const roots = (this.browseRoots ?? []).map((r) => folder(r.title, r.path, r.about, 0, !!r.connection)).join('');

    const layers = this.host.layers();
    const bySource = new Map<string, LayerInfo[]>();
    for (const l of layers) {
      if (f && !`${l.name} ${l.id} ${l.source}`.toLowerCase().includes(f)) continue;
      const key = l.source || 'engine';
      const arr = bySource.get(key) ?? [];
      arr.push(l);
      bySource.set(key, arr);
    }
    const active = this.host.activeId();
    const tree = [...bySource.entries()]
      .map(([src, ls]) => {
        const rows = ls
          .map(
            (l) => `<div class="node layer${l.id === active ? ' on' : ''}" data-layer="${esc(l.id)}" title="${esc(l.id)}">
              <span class="dot g-${l.geometry}"></span>
              <span class="nm">${esc(l.name)}</span>
              <span class="ct">${l.feature_count.toLocaleString()}</span>
            </div>`,
          )
          .join('');
        return `<div class="node source" title="${esc(src)}"><span class="tw">▾</span>${icon('book', 14)}<span class="nm">${esc(src.split(/[\\/]/).pop() || src)}</span><span class="ct">${ls.length}</span></div><div class="kids">${rows}</div>`;
      })
      .join('');
    el.innerHTML = `<div class="pane-tools"><input id="cat-filter" type="search" placeholder="Find a file or layer…" value="${esc(this.catalogFilter)}" /><button id="cat-refresh" title="Read the folders again" aria-label="Refresh">${icon('refresh', 14)}</button></div>
      <p class="hint cat-intro">Your files on disk. Double-click a file (or <b>+</b>) to add it to the map; ${icon('check', 11)} means it is on the map. Right-click for more.</p>
      ${this.canConnect ? `<button class="cat-connect" id="cat-connect" title="Show another folder of this computer here (like a folder connection in ArcGIS Pro)">${icon('folder', 14)} Connect a folder…</button>` : ''}
      <div class="tree">
        ${this.favourites.length ? `<div class="cat-head">Favourites</div>${this.favourites.map((x) => (x.folder ? folder(x.name, x.path, 'Favourite', 0) : this.fileRow(x.path, x.name, 'vector', 0, {}))).join('')}` : ''}
        <div class="cat-head">Folders</div>
        ${roots || '<div class="pane-empty">No data folder. Add files with Data › Add data, or open sample data.</div>'}
        <div class="cat-head">On the map</div>
        ${tree || '<div class="pane-empty">No layers yet. Add a file above, open sample data, or run a recipe.</div>'}
        <div class="cat-head cat-head-row"><span>Web services</span>${this.canConnect ? '<button class="cat-mini" data-ws-add title="Add a web service: WMS, WMTS, XYZ, WFS, OGC API, ArcGIS">＋ Add</button>' : ''}</div>
        ${this.servicesSection()}
        <div class="cat-head">GeoSpaX</div>
        ${this.gxSection()}
      </div>
      ${this.previewHtml()}`;
    el.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('#cat-refresh')) return void this.refreshCatalog();
      if (t.closest('#cat-connect')) return void this.connectFolder();
      const disc = t.closest<HTMLElement>('[data-disconnect]')?.dataset.disconnect;
      if (disc) {
        e.stopPropagation();
        return void this.disconnectFolder(disc);
      }
      const addEl = t.closest<HTMLElement>('[data-add]');
      if (addEl?.dataset.add) return void this.addFile(addEl.dataset.add, addEl.dataset.addLayer);
      if (t.closest('[data-pv-close]')) { this.select(null); return; }
      const pvAdd = t.closest<HTMLElement>('[data-pv-add]');
      if (pvAdd && this.sel) return void this.addFile(this.sel.path, this.sel.layer);
      if (t.closest('[data-ws-add]')) return void this.addService();
      const wsRm = t.closest<HTMLElement>('[data-ws-rm]')?.dataset.wsRm;
      if (wsRm) { e.stopPropagation(); return void this.removeService(wsRm); }
      const ws = t.closest<HTMLElement>('[data-ws]')?.dataset.ws;
      if (ws) return void this.toggleService(ws);
      const wf = t.closest<HTMLElement>('[data-ws-folder]');
      if (wf) return void this.toggleCloudFolder(wf.dataset.wsSid!, wf.dataset.wsFolder!);
      const wfile = t.closest<HTMLElement>('[data-ws-file]');
      if (wfile) return void this.openCloudFile(wfile.dataset.wsSid!, wfile.dataset.wsFile!, wfile.dataset.wsTitle!);
      const wl = t.closest<HTMLElement>('[data-ws-layer]');
      if (wl) {
        const d = { sid: wl.dataset.wsSid!, layer: wl.dataset.wsLayer!, title: wl.dataset.wsTitle! };
        if (wl.dataset.wsType === 'collection') return void document.dispatchEvent(new CustomEvent('geospax:stac-search', { detail: { sid: d.sid, collection: d.layer, title: d.title } }));
        return void document.dispatchEvent(new CustomEvent(wl.dataset.wsType === 'features' ? 'geospax:ws-fetch' : 'geospax:add-web-layer', { detail: d }));
      }
      const gx = t.closest<HTMLElement>('[data-gx]')?.dataset.gx;
      if (gx) return void this.gxToggle(gx);
      const gxRun = t.closest<HTMLElement>('[data-gx-act]');
      if (gxRun) return void this.gxAct(gxRun.dataset.gxAct!, gxRun.dataset.gxId ?? '');
      const cont = t.closest<HTMLElement>('[data-container]')?.dataset.container;
      if (cont && t.closest('.tw')) return void this.toggleContainer(cont);
      const sc = t.closest<HTMLElement>('[data-shortcut]')?.dataset.shortcut;
      if (sc === 'samples') return void document.dispatchEvent(new CustomEvent('geospax:samples'));
      if (sc === 'devices') return this.showTab('right', 'devices');
      if (sc === 'rasters') return this.showTab('right', 'rasters');
      if (sc === 'automate') return this.showTab('bottom', 'automate');
      if (sc === 'history') return this.showTab('bottom', 'history');
      const fold = t.closest<HTMLElement>('[data-folder]')?.dataset.folder;
      if (fold) {
        if (this.browseOpen.has(fold)) this.browseOpen.delete(fold);
        else this.browseOpen.add(fold);
        return void this.loadBrowse();
      }
      const file = t.closest<HTMLElement>('[data-file]');
      if (file) {
        const c = file.dataset.container;
        if (c) return void this.toggleContainer(c);
        // the second click of a double-click adds it (the first one's preview redraws the row)
        if (e.detail >= 2) return void this.addFile(file.dataset.file!, file.dataset.layerName);
        return void this.select({ path: file.dataset.file!, layer: file.dataset.layerName, name: file.querySelector('.nm')?.textContent ?? '' });
      }
      const row = t.closest<HTMLElement>('[data-layer]');
      if (row?.dataset.layer) {
        const id = row.dataset.layer;
        this.host.setActive(id);
        this.host.refreshContents();
        this.host.fitLayer(id);
        this.host.openAttributes(id);
        this.setStatus(`Active layer: ${this.host.layerById(id)?.name ?? id}`);
        this.renderCatalog();
      }
    };
    el.ondragstart = (e) => {
      const file = (e.target as HTMLElement).closest<HTMLElement>('[data-file]');
      if (!file?.dataset.file || file.dataset.container || !e.dataTransfer) return;
      e.dataTransfer.setData('application/x-geospax-file', JSON.stringify({ path: file.dataset.file, layer: file.dataset.layerName }));
      e.dataTransfer.effectAllowed = 'copy';
    };
    el.oninput = (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'cat-filter') { this.catalogFilter = t.value; this.renderCatalog(); const a = document.querySelector<HTMLInputElement>('#cat-filter'); if (a) { a.focus(); a.setSelectionRange(a.value.length, a.value.length); } }
    };
  }

  /** One file (or a layer inside a GeoPackage / a file inside a zip) as a tree row. */
  private fileRow(path: string, name: string, kind: string, depth: number, o: { size?: string; on?: string[]; container?: boolean; layer?: string; note?: string }): string {
    const KIND_ICON: Record<string, string> = { vector: 'layers', raster: 'image', project: 'save', 'point cloud': 'grid', recipe: 'play', archive: 'folder' };
    const on = (o.on ?? []).length > 0;
    const key = o.layer ? `${path}#${o.layer}` : path;
    const selected = this.sel && this.sel.path === path && this.sel.layer === o.layer;
    const open = o.container && this.insideCache.has(path) && this.browseOpen.has(`in:${path}`);
    const pad = `style="padding-left:${(o.container ? 4 : 18) + depth * 14}px"`;
    let html = `<div class="node file${on ? ' onmap' : ''}${selected ? ' sel' : ''}" data-file="${esc(path)}" ${o.layer ? `data-layer-name="${esc(o.layer)}"` : ''} ${o.container ? `data-container="${esc(path)}"` : 'draggable="true"'} data-kind="${esc(kind)}" ${pad} title="${esc(`${o.note ?? kind}${o.size ? ` · ${o.size}` : ''}${on ? ` · on the map as ${(o.on ?? []).join(', ')}` : o.container ? ' · click to see what is inside' : ' · click for a preview, double-click or drag to the map to add it'}`)}">${o.container ? `<span class="tw">${open ? '▾' : '▸'}</span>` : ''}${icon(KIND_ICON[kind] ?? 'layers', 14)}<span class="nm">${esc(name)}</span>${o.note ? `<span class="ct dim">${esc(o.note)}</span>` : ''}${
      on ? `<span class="ct ok" aria-label="on the map">${icon('check', 12)}</span>` : o.container ? '' : `<button class="ct add" data-add="${esc(path)}" ${o.layer ? `data-add-layer="${esc(o.layer)}"` : ''} title="Add to the map" aria-label="Add ${esc(name)} to the map">${icon('plus', 12)}</button>`
    }</div>`;
    void key;
    if (!o.container || !open) return html;
    const inside = this.insideCache.get(path);
    if (typeof inside === 'string') return `${html}<div class="pane-empty" style="padding-left:${18 + (depth + 1) * 14}px">${esc(inside)}</div>`;
    html += (inside ?? []).map((it) => this.fileRow(it.path, it.name, it.kind, depth + 1, { layer: it.layer, on: it.on_map, note: it.layer ? `${(it.count ?? 0).toLocaleString()} ${it.geometry ?? ''}`.trim() : undefined })).join('')
      || `<div class="pane-empty" style="padding-left:${18 + (depth + 1) * 14}px">Nothing GeoSpaX can open inside</div>`;
    return html;
  }

  private async toggleContainer(path: string) {
    const k = `in:${path}`;
    if (this.browseOpen.has(k)) {
      this.browseOpen.delete(k);
      return this.renderCatalog();
    }
    this.browseOpen.add(k);
    if (!this.insideCache.has(path)) {
      try {
        this.insideCache.set(path, (await this.host.backend.json<{ items: InsideItem[] }>(`api/browse/inside?path=${encodeURIComponent(path)}`)).items);
      } catch (e) {
        this.insideCache.set(path, `Could not read it: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.renderCatalog();
  }

  /** Select a file or layer: its preview below the tree and its footprint on the map. */
  private async select(s: { path: string; layer?: string; name: string; data?: Preview; error?: string } | null) {
    this.sel = s;
    document.dispatchEvent(new CustomEvent('geospax:footprint', { detail: null }));
    this.renderCatalog();
    if (!s) return;
    try {
      const d = await this.host.backend.json<Preview>(`api/browse/preview?path=${encodeURIComponent(s.path)}${s.layer ? `&layer=${encodeURIComponent(s.layer)}` : ''}`);
      if (this.sel !== s) return;
      s.data = d;
      if (d.bounds) document.dispatchEvent(new CustomEvent('geospax:footprint', { detail: d.bounds }));
    } catch (e) {
      if (this.sel !== s) return;
      s.error = e instanceof Error ? e.message : String(e);
    }
    this.renderCatalog();
  }

  /** The preview strip: what the selected file holds, before adding it. */
  private previewHtml(): string {
    const s = this.sel;
    if (!s) return '';
    const d = s.data;
    const body = s.error
      ? `<p class="err">${esc(s.error)}</p>`
      : !d
        ? '<p class="dim">Reading…</p>'
        : d.kind === 'raster'
          ? `<p>Raster · ${d.width?.toLocaleString()} × ${d.height?.toLocaleString()} cells · ${d.bands} band${d.bands === 1 ? '' : 's'} · ${esc(d.crs)}</p>`
          : `<p>${(d.count ?? 0).toLocaleString()} ${esc(d.geometry ?? 'features')} · ${esc(d.crs)}</p>
            ${(d.fields ?? []).length ? `<div class="pv-table"><table><thead><tr>${(d.fields ?? []).slice(0, 8).map((f) => `<th title="${esc(f.type)}">${esc(f.name)}</th>`).join('')}</tr></thead><tbody>${(d.rows ?? []).map((r) => `<tr>${r.slice(0, 8).map((v) => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}`;
    return `<div class="cat-preview" aria-live="polite">
      <div class="pv-head"><b title="${esc(s.path)}">${esc(s.name)}</b><button data-pv-close aria-label="Close the preview">✕</button></div>
      ${body}
      ${d?.bounds ? '<p class="dim">Its outline is drawn on the map.</p>' : ''}
      <div class="pv-acts"><button class="primary" data-pv-add>Add to the map</button></div>
    </div>`;
  }

  /** Web services (WMS, WMTS, XYZ, ArcGIS, WFS, OGC API): connections and their layers. */
  private servicesSection(): string {
    if (!this.services) {
      void this.host.backend.json<{ services: { id: string; kind: string; url: string; title: string }[]; kinds: { id: string; title: string }[]; stac_catalogs?: { title: string; url: string }[] }>('api/services').then((r) => {
        this.services = r.services;
        this.serviceKinds = r.kinds;
        this.stacCatalogs = r.stac_catalogs ?? [];
        this.renderCatalog();
      }).catch(() => { this.services = []; });
      return '<div class="pane-empty">Reading…</div>';
    }
    if (!this.services.length) return `<div class="pane-empty">No web services yet.${this.canConnect ? ' <b>＋ Add</b> connects a WMS, WMTS, XYZ, WFS, OGC API, ArcGIS service, a STAC imagery catalog or cloud storage (S3, Google Cloud, Azure).' : ''}</div>`;
    // the short form in the tree ("Cloud storage (S3, …)" → "Cloud storage"); the full one is in the tooltip
    const kindTitle = (k: string) => (this.serviceKinds.find((x) => x.id === k)?.title ?? k).replace(/ \(.*\)$/, '');
    return this.services.map((sv) => {
      const open = this.browseOpen.has(`ws:${sv.id}`);
      const head = `<div class="node source folder" data-ws="${esc(sv.id)}" title="${esc(`${kindTitle(sv.kind)} · ${sv.url}`)}"><span class="tw">${open ? '▾' : '▸'}</span>${icon('globe', 14)}<span class="nm">${esc(sv.title)}</span><span class="ct dim">${esc(kindTitle(sv.kind))}</span><button class="ct disc" data-ws-rm="${esc(sv.id)}" title="Remove this connection" aria-label="Remove ${esc(sv.title)}">✕</button></div>`;
      if (!open) return head;
      const ls = this.serviceLayers.get(sv.id);
      if (ls === undefined) return `${head}<div class="pane-empty" style="padding-left:32px">Asking the service…</div>`;
      if (typeof ls === 'string') return `${head}<div class="pane-empty err" style="padding-left:32px">${esc(ls)}</div>`;
      if (sv.kind === 'cloud') return head + this.cloudRows(sv.id, ls, 0);
      return head + ls.map((l) => `<div class="node gx-leaf" data-ws-layer="${esc(l.id)}" data-ws-sid="${esc(sv.id)}" data-ws-title="${esc(l.title)}" data-ws-type="${l.type}" style="padding-left:32px" title="${esc(l.type === 'collection' ? 'Click to search it for imagery of the map area' : l.type === 'features' ? 'Click to download its features for the map view' : 'Click to add it to the map')}">${icon(l.type === 'features' ? 'layers' : l.type === 'collection' ? 'search' : 'image', 13)}<span class="nm">${esc(l.title)}</span><span class="ct dim">${l.type === 'collection' ? 'search' : l.type === 'features' ? 'features' : 'map image'}</span></div>`).join('');
    }).join('');
  }

  /** A cloud storage folder's rows: sub-folders open in place, files go on the map when clicked. */
  private cloudRows(sid: string, items: { id: string; title: string; type: string; kind?: string; size?: number | null }[], depth: number): string {
    const pad = 32 + depth * 14;
    if (!items.length) return `<div class="pane-empty" style="padding-left:${pad}px">Nothing GeoSpaX can open here</div>`;
    return items.map((it) => {
      if (it.type === 'folder') {
        const key = `${sid}:${it.id}`;
        const open = this.browseOpen.has(`wsf:${key}`);
        const kids = this.cloudKids.get(key);
        const row = `<div class="node folder" data-ws-folder="${esc(it.id)}" data-ws-sid="${esc(sid)}" style="padding-left:${pad - 14}px"><span class="tw">${open ? '▾' : '▸'}</span>${icon('folder', 14)}<span class="nm">${esc(it.title)}</span></div>`;
        if (!open) return row;
        if (kids === undefined) return `${row}<div class="pane-empty" style="padding-left:${pad + 14}px">Listing…</div>`;
        if (typeof kids === 'string') return `${row}<div class="pane-empty err" style="padding-left:${pad + 14}px">${esc(kids)}</div>`;
        return row + this.cloudRows(sid, kids, depth + 1);
      }
      const size = typeof it.size === 'number' ? bytesText(it.size) : '';
      return `<div class="node gx-leaf" data-ws-file="${esc(it.id)}" data-ws-sid="${esc(sid)}" data-ws-title="${esc(it.title)}" style="padding-left:${pad}px" title="Click to put it on the map (${it.kind === 'raster' ? 'read in place, a window at a time' : 'read into a layer'})">${icon(it.kind === 'raster' ? 'image' : 'layers', 13)}<span class="nm">${esc(it.title)}</span><span class="ct dim">${esc(size)}</span></div>`;
    }).join('');
  }

  private async toggleCloudFolder(sid: string, path: string) {
    const key = `${sid}:${path}`;
    if (this.browseOpen.has(`wsf:${key}`)) { this.browseOpen.delete(`wsf:${key}`); return this.renderCatalog(); }
    this.browseOpen.add(`wsf:${key}`);
    this.renderCatalog();
    if (!this.cloudKids.has(key) || typeof this.cloudKids.get(key) === 'string') {
      try {
        this.cloudKids.set(key, (await this.host.backend.json<{ layers: { id: string; title: string; type: string; kind?: string; size?: number | null }[] }>(`api/services/${encodeURIComponent(sid)}/list?path=${encodeURIComponent(path)}`)).layers);
      } catch (e) {
        this.cloudKids.set(key, `Could not list it: ${e instanceof Error ? e.message : e}`);
      }
      this.renderCatalog();
    }
  }

  private async openCloudFile(sid: string, path: string, title: string) {
    this.setStatus(`Opening ${title} from cloud storage…`);
    try {
      const r = await this.host.backend.json<{ layers: string[]; rasters: string[] }>(`api/services/${encodeURIComponent(sid)}/open?path=${encodeURIComponent(path)}`, { method: 'POST' });
      document.dispatchEvent(new CustomEvent('geospax:added', { detail: { layers: r.layers, rasters: r.rasters } }));
      this.setStatus(`${title} is on the map`, 5000);
    } catch (e) {
      this.setStatus(`${title}: ${e instanceof Error ? e.message : e}`, 10000);
    }
  }

  private async toggleService(id: string) {
    const k = `ws:${id}`;
    if (this.browseOpen.has(k)) { this.browseOpen.delete(k); return this.renderCatalog(); }
    this.browseOpen.add(k);
    this.renderCatalog();
    if (!this.serviceLayers.has(id) || typeof this.serviceLayers.get(id) === 'string') {
      try {
        this.serviceLayers.set(id, (await this.host.backend.json<{ layers: { id: string; title: string; type: 'tiles' | 'features' | 'collection' | 'folder' | 'file'; kind?: string; size?: number | null }[] }>(`api/services/${encodeURIComponent(id)}/layers`)).layers);
      } catch (e) {
        this.serviceLayers.set(id, `The service did not answer: ${e instanceof Error ? e.message : e}`);
      }
      this.renderCatalog();
    }
  }

  private async removeService(id: string) {
    try { await this.host.backend.json(`api/services/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* already gone */ }
    this.services = null;
    this.serviceLayers.delete(id);
    for (const k of [...this.cloudKids.keys()]) if (k.startsWith(`${id}:`)) this.cloudKids.delete(k);
    this.renderCatalog();
  }

  /** "＋ Add" under Web services: type, address and an optional name; the engine checks it answers. */
  async addService() {
    const kinds = this.serviceKinds.length ? this.serviceKinds : [{ id: 'wms', title: 'WMS' }];
    const hints: Record<string, string> = {
      xyz: 'https://tile.example.org/{z}/{x}/{y}.png', wms: 'https://example.org/geoserver/wms', wmts: 'https://example.org/wmts/1.0.0/WMTSCapabilities.xml',
      'arcgis-map': 'https://example.org/arcgis/rest/services/Name/MapServer', wfs: 'https://example.org/geoserver/wfs', ogcapi: 'https://example.org/ogcapi', 'arcgis-feature': 'https://example.org/arcgis/rest/services/Name/FeatureServer', stac: 'https://earth-search.aws.element84.com/v1', cloud: 's3://bucket/folder  ·  gs://bucket  ·  az://container  ·  https://…/folder/',
    };
    const known = this.stacCatalogs;
    const modal = document.createElement('div');
    modal.className = 'modal folder-pick';
    modal.innerHTML = `<form class="sheet fp" role="dialog" aria-label="Add a web service">
      <header><b>Add a web service</b><button type="button" data-x aria-label="Close">✕</button></header>
      <div class="body">
        <label class="ws-field"><span>Type</span><select name="kind">${kinds.map((k) => `<option value="${esc(k.id)}">${esc(k.title)}</option>`).join('')}</select></label>
        <label class="ws-field"><span>Address</span><input name="url" required spellcheck="false" placeholder="${esc(hints[kinds[0].id] ?? 'https://')}" /></label>
        <label class="ws-field"><span>Name (optional)</span><input name="title" /></label>
        <div class="ws-cloud" hidden>
          <label class="ws-check"><input type="checkbox" name="public" checked /> Public (read without signing in)</label>
          <p class="dim">Not public: GeoSpaX uses this computer's own cloud sign-in (AWS profile or environment, gcloud, az login). No key is stored by GeoSpaX.</p>
          <label class="ws-field"><span>S3 endpoint (optional)</span><input name="endpoint" spellcheck="false" placeholder="for MinIO or other S3-compatible storage, e.g. https://minio.example.org" /></label>
          <label class="ws-field"><span>S3 region (optional)</span><input name="region" spellcheck="false" placeholder="e.g. us-west-2" /></label>
          <label class="ws-field"><span>Azure account (az:// only)</span><input name="account" spellcheck="false" /></label>
        </div>
        <div class="ws-field ws-known"><span>Or open data in the cloud</span>${CLOUD_PRESETS.map((c, i) => `<button type="button" data-cloud-preset="${i}" title="${esc(c.about)}">${esc(c.title)}</button>`).join('')}</div>
        ${known.length ? `<div class="ws-field ws-known"><span>Or a public STAC catalog</span>${known.map((k) => `<button type="button" data-known="${esc(k.url)}" data-known-title="${esc(k.title)}">${esc(k.title)}</button>`).join('')}</div>` : ''}
        <p class="dim">Map images (WMS, WMTS, XYZ, ArcGIS MapServer) are drawn over the basemap; features (WFS, OGC API, ArcGIS FeatureServer) are downloaded for the map view and become a layer; a STAC catalog is searched for imagery by area, date and cloud; cloud storage is browsed like a folder.</p>
        <p class="err" data-msg></p>
      </div>
      <footer><button type="button" data-x>Cancel</button><button class="primary" type="submit">Connect</button></footer></form>`;
    document.body.appendChild(modal);
    const form = modal.querySelector('form')!;
    const close = () => modal.remove();
    modal.addEventListener('click', (e) => {
      if (e.target === modal || (e.target as HTMLElement).closest('[data-x]')) close();
      const cp = (e.target as HTMLElement).closest<HTMLElement>('[data-cloud-preset]');
      if (cp) {
        const c = CLOUD_PRESETS[Number(cp.dataset.cloudPreset)];
        (form.kind as HTMLSelectElement).value = 'cloud';
        cloudBox.hidden = false;
        const set = (n: string, v: string) => { (form.elements.namedItem(n) as HTMLInputElement).value = v; };
        set('url', c.url); set('title', c.title); set('endpoint', c.endpoint ?? ''); set('region', c.region ?? '');
        (form.elements.namedItem('public') as HTMLInputElement).checked = true;
        const msg = modal.querySelector<HTMLElement>('[data-msg]')!;
        if (c.ask) {
          // Source Cooperative: the account and repository are typed after s3://
          msg.textContent = c.ask;
          const u = form.url as HTMLInputElement;
          u.focus();
          u.setSelectionRange(u.value.length, u.value.length);
        } else form.requestSubmit();
        return;
      }
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-known]');
      if (k) {
        (form.kind as HTMLSelectElement).value = 'stac';
        (form.url as HTMLInputElement).value = k.dataset.known!;
        (form.elements.namedItem('title') as HTMLInputElement).value = k.dataset.knownTitle!;
        form.requestSubmit();
      }
    });
    const cloudBox = modal.querySelector<HTMLElement>('.ws-cloud')!;
    form.kind.addEventListener('change', () => {
      const k = (form.kind as HTMLSelectElement).value;
      (form.url as HTMLInputElement).placeholder = hints[k] ?? 'https://';
      cloudBox.hidden = k !== 'cloud';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = modal.querySelector<HTMLElement>('[data-msg]')!;
      msg.textContent = 'Asking the service…';
      const q = `kind=${encodeURIComponent(form.kind.value)}&url=${encodeURIComponent((form.url as HTMLInputElement).value)}&title=${encodeURIComponent((form.elements.namedItem('title') as HTMLInputElement).value)}${
        form.kind.value === 'cloud' ? `&public=${(form.elements.namedItem('public') as HTMLInputElement).checked ? 1 : 0}${['endpoint', 'region', 'account'].map((n) => `&${n}=${encodeURIComponent((form.elements.namedItem(n) as HTMLInputElement).value.trim())}`).join('')}` : ''}`;
      try {
        const r = await this.host.backend.json<{ service: { id: string; title: string }; layers: number }>(`api/services?${q}`, { method: 'POST' });
        close();
        this.services = null;
        this.setStatus(`Connected ${r.service.title}: ${r.layers} layer${r.layers === 1 ? '' : 's'}`, 6000);
        this.serviceLayers.delete(r.service.id);
        this.browseOpen.delete(`ws:${r.service.id}`);
        void this.toggleService(r.service.id);
      } catch (err) {
        msg.textContent = err instanceof Error ? err.message : String(err);
      }
    });
    (form.url as HTMLInputElement).focus();
  }

  /** Favourite folders and files (right-click › Add to Favourites), kept in this browser. */
  toggleFavourite(path: string, name: string, folder: boolean) {
    const i = this.favourites.findIndex((x) => x.path === path);
    if (i >= 0) this.favourites.splice(i, 1);
    else this.favourites.push({ path, name, folder });
    try { localStorage.setItem(FAV_KEY, JSON.stringify(this.favourites)); } catch { /* private mode */ }
    this.setStatus(i >= 0 ? `Removed ${name} from Favourites` : `Added ${name} to Favourites`, 4000);
    this.renderCatalog();
  }

  isFavourite(path: string) {
    return this.favourites.some((x) => x.path === path);
  }

  /** The GeoSpaX section: what GeoSpaX itself holds, in the same tree. */
  private gxSection(): string {
    const node = (id: string, title: string, ico: string, n?: number) =>
      `<div class="node source gx" data-gx="${id}"><span class="tw">${this.gxOpen.has(id) ? '▾' : '▸'}</span>${icon(ico, 14)}<span class="nm">${esc(title)}</span>${n !== undefined ? `<span class="ct">${n}</span>` : ''}</div>`;
    const leaf = (act: string, id: string, title: string, ico: string, note = '') =>
      `<div class="node gx-leaf" data-gx-act="${act}" data-gx-id="${esc(id)}" style="padding-left:32px" title="${esc(note || title)}">${icon(ico, 13)}<span class="nm">${esc(title)}</span>${note ? `<span class="ct dim">${esc(note)}</span>` : ''}</div>`;
    const kids = (id: string, html: () => string) => (this.gxOpen.has(id) ? html() : '');
    const done = this.runs.filter((r) => r.status === 'done').slice(0, 20);
    return [
      node('online', 'Online data', 'globe', ONLINE_SOURCES.length),
      kids('online', () => ONLINE_SOURCES.map((o) => leaf('online', o.id, o.title, 'download')).join('')),
      node('overture', 'Overture Maps', 'layers', OVERTURE_THEMES.length),
      kids('overture', () => OVERTURE_THEMES.map(([id, title]) => leaf('overture', id, title, 'download', 'for the map view')).join('')),
      node('recipes', 'Recipes', 'play', this.gxData.recipes?.length),
      kids('recipes', () => (this.gxData.recipes ? this.gxData.recipes.map((r) => leaf('recipe', r.id, r.title || r.id, recipeIcon(r))).join('') || '<div class="pane-empty">No recipes</div>' : '<div class="pane-empty">Reading…</div>')),
      node('results', 'Results', 'history', done.length),
      kids('results', () => done.map((r) => leaf('run', r.id, r.title || r.recipe, 'check', (r.artifacts ?? []).length ? `${(r.artifacts ?? []).length} files` : '')).join('') || '<div class="pane-empty">No finished runs yet</div>'),
      node('envs', 'R & Python', 'code'),
      kids('envs', () => this.envsHtml()),
      node('models', 'AI models', 'brain', this.gxData.models?.length),
      kids('models', () => (this.gxData.models ? this.gxData.models.map((m) => leaf('model', m.name, m.name, 'brain')).join('') || leaf('models', '', 'Add a model…', 'plus') : '<div class="pane-empty">Reading…</div>')),
      node('plugins', 'Plugins', 'puzzle', this.gxData.plugins?.length),
      kids('plugins', () => (this.gxData.plugins ? this.gxData.plugins.map((p) => leaf('plugin', p.id, p.name, pluginIcon(p))).join('') : '<div class="pane-empty">Reading…</div>')),
      `<div class="node source" data-shortcut="samples">${icon('gallery', 14)}<span class="nm">Sample data</span></div>`,
      `<div class="node source" data-shortcut="devices">${icon('phone', 14)}<span class="nm">Devices</span></div>`,
    ].join('');
  }

  private async gxToggle(id: string) {
    if (this.gxOpen.has(id)) this.gxOpen.delete(id);
    else this.gxOpen.add(id);
    this.renderCatalog();
    if (!this.gxOpen.has(id)) return;
    try {
      if (id === 'recipes' && !this.gxData.recipes) this.gxData.recipes = (await this.host.backend.json<{ recipes: RecipeInfo[] }>('api/recipes')).recipes;
      if (id === 'models' && !this.gxData.models) this.gxData.models = (await this.host.backend.json<{ models: { name: string }[] }>('api/models')).models;
      if (id === 'plugins' && !this.gxData.plugins) this.gxData.plugins = (await this.host.backend.json<{ plugins: PluginInfo[] }>('api/plugins')).plugins;
      if (id === 'results') await this.loadRuns();
      if (id === 'envs') await this.loadEnvs();
      if (id.startsWith('env:py:') && !this.envPyPkgs.has(id.slice(7))) {
        const path = id.slice(7);
        this.renderCatalog();
        try {
          this.envPyPkgs.set(path, await this.host.backend.json(`api/python/packages?path=${encodeURIComponent(path)}`));
        } catch (e) {
          this.envPyPkgs.set(path, e instanceof Error ? e.message : String(e));
        }
      }
    } catch { /* the node says Reading… until the next try */ }
    this.renderCatalog();
  }

  private async usePython(path: string) {
    try {
      const r = await this.host.backend.json<{ version: string | null }>(`api/python/use?path=${encodeURIComponent(path)}`, { method: 'POST' });
      this.setStatus(`Python steps now use ${path}${r.version ? ` (Python ${r.version})` : ''}`, 6000);
      await this.loadEnvs();
      this.renderCatalog();
    } catch (e) {
      this.setStatus(`Python: ${e instanceof Error ? e.message : e}`, 10000);
    }
  }

  private async loadEnvs() {
    const [r, py] = await Promise.all([
      this.host.backend.json<NonNullable<Workbench['envR']>>('api/r').catch(() => null),
      this.host.backend.json<NonNullable<Workbench['envPy']>>('api/python').catch(() => null),
    ]);
    this.envR = r ?? { installed: false, kits: [], packages: {} };
    this.envPy = py ?? { environments: [] };
  }

  /** R (version, kits and their packages) and the Python environments (packages, which one steps use). */
  private envsHtml(): string {
    if (!this.envR || !this.envPy) return '<div class="pane-empty">Looking for R and Python…</div>';
    const pad = (d: number) => `style="padding-left:${32 + d * 14}px"`;
    const row = (d: number, ico: string, name: string, note = '', attrs = '', cls = 'gx-leaf') =>
      `<div class="node ${cls}" ${attrs} ${pad(d)}>${icon(ico, 13)}<span class="nm">${esc(name)}</span>${note ? `<span class="ct dim">${esc(note)}</span>` : ''}</div>`;
    const tw = (key: string) => `<span class="tw">${this.gxOpen.has(key) ? '▾' : '▸'}</span>`;
    let h = '';
    // R
    const r = this.envR;
    h += `<div class="node folder" data-gx="env:r" ${pad(-1)}>${tw('env:r')}${icon('rlogo', 14)}<span class="nm">R</span><span class="ct dim">${esc(r.installed ? (r.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? 'installed') : 'not installed')}</span></div>`;
    if (this.gxOpen.has('env:r')) {
      if (!r.installed) h += row(1, 'download', 'Set up R…', 'installs R and its packages', 'data-gx-act="r-setup" data-gx-id=""');
      else {
        for (const k of r.kits) {
          const have = k.packages.filter((p) => r.packages[p]).length;
          const key = `env:r:${k.id}`;
          h += `<div class="node folder" data-gx="${esc(key)}" ${pad(0)}>${tw(key)}${icon('package', 13)}<span class="nm">${esc(k.title)}</span><span class="ct ${have === k.packages.length ? 'ok' : 'dim'}">${have}/${k.packages.length}</span></div>`;
          if (this.gxOpen.has(key)) h += k.packages.map((p) => row(2, r.packages[p] ? 'check' : 'none', p, r.packages[p] ?? 'not installed')).join('');
        }
        h += row(1, 'download', 'Install or update packages…', '', 'data-gx-act="r-setup" data-gx-id=""');
      }
    }
    // Python
    const envs = this.envPy.environments;
    h += `<div class="node folder" data-gx="env:py" ${pad(-1)}>${tw('env:py')}${icon('python', 14)}<span class="nm">Python</span><span class="ct dim">${envs.length ? `${envs.length} environment${envs.length === 1 ? '' : 's'}` : 'not found'}</span></div>`;
    if (this.gxOpen.has('env:py')) {
      if (!envs.length) h += `<div class="pane-empty" ${pad(1)}>No Python found. Install Python 3 (python.org, or Miniforge for conda) and press Refresh.</div>`;
      for (const e of envs) {
        const key = `env:py:${e.path}`;
        h += `<div class="node folder${e.current ? ' sel' : ''}" data-gx="${esc(key)}" ${pad(0)} title="${esc(e.path)}">${tw(key)}${icon(e.current ? 'check' : 'python', 13)}<span class="nm">${esc(e.label)}</span><span class="ct dim">${esc(e.version)}${e.current ? ' · in use' : ''}</span></div>`;
        if (!this.gxOpen.has(key)) continue;
        const pk = this.envPyPkgs.get(e.path);
        if (pk === undefined) h += `<div class="pane-empty" ${pad(2)}>Reading its packages…</div>`;
        else if (typeof pk === 'string') h += `<div class="pane-empty err" ${pad(2)}>${esc(pk)}</div>`;
        else {
          // installed first, then the rest, each alphabetically
          const list = Object.entries(pk.packages).sort((a, b) => Number(!a[1]) - Number(!b[1]) || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
          h += list.map(([n, v]) => row(2, v ? 'check' : 'none', n, v ?? 'not installed')).join('');
          h += `<div class="pane-empty" ${pad(2)}>${pk.total} packages in all</div>`;
        }
        if (!e.current) h += row(1, 'play', 'Use for Python steps', '', `data-gx-act="py-use" data-gx-id="${esc(e.path)}"`);
      }
    }
    return h;
  }

  /** Overture Maps: one theme (buildings, roads, places…) for the map view, as a download job. */
  private async overture(theme: string) {
    const title = OVERTURE_THEMES.find((t) => t[0] === theme)?.[1] ?? theme;
    const [w, so, ea, n] = this.host.map.getBounds().toArray().flat();
    const bbox = [Math.max(-180, w), Math.max(-85, so), Math.min(180, ea), Math.min(85, n)];
    if (bbox[2] - bbox[0] > 0.5 || bbox[3] - bbox[1] > 0.5) {
      this.setStatus(`Zoom in: Overture ${title.toLowerCase()} is fetched for an area up to about 50 km across`, 8000);
      return;
    }
    try {
      const r = await this.host.backend.json<{ job: number }>(`api/overture?theme=${encodeURIComponent(theme)}&bbox=${bbox.map((v) => v.toFixed(5)).join(',')}`, { method: 'POST' });
      void followJob(this.host.backend, r.job, `Overture ${title}`, (t, ms) => this.setStatus(t, ms));
    } catch (e) {
      this.setStatus(`Overture ${title}: ${e instanceof Error ? e.message : e}`, 10000);
    }
  }

  private gxAct(act: string, id: string) {
    switch (act) {
      case 'online': return void document.dispatchEvent(new CustomEvent('geospax:online', { detail: id }));
      case 'overture': return void this.overture(id);
      case 'r-setup': return void document.dispatchEvent(new CustomEvent('geospax:r', { detail: 'setup' }));
      case 'py-use': return void this.usePython(id);
      case 'recipe': return void document.dispatchEvent(new CustomEvent('geospax:run-recipe', { detail: id }));
      case 'run': return void this.host.openRun(id);
      case 'model': case 'models': return void document.dispatchEvent(new CustomEvent('geospax:models'));
      case 'plugin': return void document.dispatchEvent(new CustomEvent('geospax:plugin-manager', { detail: id }));
    }
  }

  /** Remove a folder connection (nothing on disk changes; layers already on the map stay). */
  async disconnectFolder(path: string) {
    try {
      await this.host.backend.json(`api/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      this.browseOpen.delete(path);
      this.setStatus(`Removed the connection to ${path.split(/[\\/]/).pop()}`, 5000);
    } catch (e) {
      this.setStatus(`Could not remove it: ${e instanceof Error ? e.message : e}`, 8000);
    }
    await this.refreshCatalog();
  }

  /**
   * "Connect a folder…": a folder chooser over this computer's folders (the browser cannot hand a
   * web page a folder path, so the engine lists them), like Add Folder Connection in ArcGIS Pro or
   * Add a directory in QGIS's Browser. The chosen folder joins the Explorer, kept across restarts.
   */
  async connectFolder(start?: string) {
    type Pick = { path: string; parent: string | null; folders: { name: string; path: string }[]; places: { name: string; path: string }[]; map_files: number };
    const modal = document.createElement('div');
    modal.className = 'modal folder-pick';
    document.body.appendChild(modal);
    const close = () => { modal.remove(); document.removeEventListener('keydown', key, true); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', key, true);
    let cur: Pick | null = null;
    const show = async (path?: string) => {
      let msg = '';
      try {
        cur = await this.host.backend.json<Pick>(`api/folders/pick${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      const c = cur;
      modal.innerHTML = `<div class="sheet fp" role="dialog" aria-label="Connect a folder">
        <header><b>Connect a folder</b><button type="button" data-fp="close" aria-label="Close">✕</button></header>
        <div class="body">
          <div class="fp-places">${(c?.places ?? []).map((p) => `<button type="button" data-fp-go="${esc(p.path)}">${esc(p.name)}</button>`).join('')}</div>
          <form class="fp-path" data-fp-form><input name="path" value="${esc(c?.path ?? path ?? '')}" aria-label="Folder path" spellcheck="false" /><button type="submit">Go</button></form>
          ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
          <div class="fp-list">
            ${c?.parent ? `<button type="button" class="fp-row up" data-fp-go="${esc(c.parent)}">${icon('folder', 14)} ..</button>` : ''}
            ${(c?.folders ?? []).map((d) => `<button type="button" class="fp-row" data-fp-go="${esc(d.path)}">${icon('folder', 14)} ${esc(d.name)}</button>`).join('') || '<p class="dim">No sub-folders.</p>'}
          </div>
          <p class="dim">${c ? `${c.map_files} map file${c.map_files === 1 ? '' : 's'} directly in this folder. Nothing is added to the map until you open it.` : ''}</p>
        </div>
        <footer><button type="button" data-fp="close">Cancel</button><button type="button" class="primary" data-fp="ok" ${c ? '' : 'disabled'}>Connect this folder</button></footer>
      </div>`;
    };
    modal.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      if (t === modal || t.closest('[data-fp="close"]')) return close();
      const go = t.closest<HTMLElement>('[data-fp-go]')?.dataset.fpGo;
      if (go) return void show(go);
      if (t.closest('[data-fp="ok"]') && cur) {
        try {
          const r = await this.host.backend.json<{ connected: string; title: string }>(`api/folders?path=${encodeURIComponent(cur.path)}`, { method: 'POST' });
          close();
          this.browseOpen.add(r.connected);
          this.showTab('left', 'catalog');
          this.setStatus(`Connected ${r.title}: its files are in the Explorer`, 6000);
          await this.refreshCatalog();
        } catch (err) {
          const p = modal.querySelector('.fp-list');
          p?.insertAdjacentHTML('beforebegin', `<p class="err">${esc(err instanceof Error ? err.message : String(err))}</p>`);
        }
      }
    });
    modal.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = (modal.querySelector('input[name=path]') as HTMLInputElement).value;
      void show(v);
    });
    await show(start);
  }

  /** Put a file from a data folder on the map (Catalog double-click, + or right-click). */
  async addFile(path: string, layer?: string) {
    const name = layer ?? path.split(/[\\/]/).pop() ?? path;
    this.setStatus(`Adding ${name}…`);
    try {
      const r = await this.host.backend.json<{ layers: string[]; rasters: string[]; already?: boolean }>(`api/browse/add?path=${encodeURIComponent(path)}${layer ? `&layer=${encodeURIComponent(layer)}` : ''}`, { method: 'POST' });
      document.dispatchEvent(new CustomEvent('geospax:added', { detail: r }));
      this.setStatus(r.already ? `${name} is already on the map` : `Added ${name}: ${[...r.layers, ...r.rasters].join(', ')}`, 6000);
      this.insideCache.clear();
      await this.refreshCatalog();
    } catch (e) {
      this.setStatus(`${name} could not be added: ${e instanceof Error ? e.message : e}`, 10000);
    }
  }

  // ---------------------------------------------------------------- history + log

  private async loadRuns() {
    try {
      const r = await this.host.backend.json<{ runs: RunRow[] }>('api/runs');
      this.runs = r.runs ?? [];
    } catch (e) {
      this.runs = [];
      this.log(`run history unavailable: ${e}`, 'warn');
    }
  }

  private async loadRunsSilently() {
    try {
      const r = await this.host.backend.json<{ runs: RunRow[] }>('api/runs');
      this.runs = r.runs ?? [];
      this.renderHistory();
    } catch { /* transient */ }
  }

  /**
   * Each mode has its own panes: Lazy shows the Inspector (right) and Activity (bottom); Pro the
   * Symbology / Attributes / Rasters / Devices and Automate / Plugins / History / Log tabs. Moving to
   * a mode opens its pane if the current one belongs to the other mode.
   */
  private applyModeTabs() {
    const lazy = this.host.mode() === 'lazy';
    const right = this.layout.tabs.right;
    const bottom = this.layout.tabs.bottom;
    if (lazy) {
      if (this.layout.tabs.left === 'project') this.layout.tabs.left = 'contents';
      if (!['inspector', 'toolbox', 'ask', 'devices', 'attributes'].includes(right)) this.layout.tabs.right = 'inspector';
      if (bottom !== 'activity') this.layout.tabs.bottom = 'activity';
    } else {
      if (right === 'inspector') this.layout.tabs.right = 'symbology';
      if (bottom === 'activity') this.layout.tabs.bottom = 'automate';
    }
    this.applyLayout();
  }

  /**
   * Lazy mode's bottom pane: what GeoSpaX suggests for the data on the map, and what has happened
   * (recipe runs with their reports, then the latest notes), in words rather than tabs of logs.
   */
  renderActivity() {
    const el = document.querySelector<HTMLElement>('#activity');
    if (!el) return;
    const ideas: { label: string; layer: string; run: () => void }[] = [];
    for (const l of this.host.layers()) {
      const first = this.host.nextSteps(l.id)[0];
      if (first) ideas.push({ label: first.label, layer: this.host.layerName(l.id), run: first.run });
      if (ideas.length >= 4) break;
    }
    this.activityIdeas = ideas;
    const st: Record<string, [string, string]> = {
      done: ['✓', 'Finished'], failed: ['!', 'Failed'], running: ['◌', 'Running'], queued: ['◌', 'Waiting'], cancelled: ['×', 'Stopped'],
    };
    const runs = this.runs.slice(0, 8).map((r) => {
      const [ico, word] = st[r.status] ?? ['•', r.status];
      return `<div class="act-item ${esc(r.status)}"><span class="act-ico">${ico}</span>
        <span class="act-txt"><b>${esc(r.title || r.recipe)}</b><small>${esc(word)}${r.trigger?.text ? ` · ${esc(r.trigger.text)}` : ''} · ${(r.elapsed_ms / 1000).toFixed(1)} s</small></span>
        ${r.status === 'done' ? `<button data-act-open="${esc(r.id)}">Open report</button>` : ''}
        ${r.status === 'running' || r.status === 'queued' ? '' : `<button class="act-del" data-act-del="${esc(r.id)}" title="Delete this from the list (map, report, log)" aria-label="Delete">✕</button>`}
        ${r.status === 'failed' && r.error ? `<p class="act-why">${esc(r.error.replace(/^step '[^']*' \([^)]*\) failed: /, ''))}</p>` : ''}</div>`;
    });
    const notes = [...this.logs].reverse().slice(0, 5).map((l) => `<div class="act-note ${l.level}"><span>${esc(l.t)}</span>${esc(l.text)}</div>`);
    el.innerHTML = `<div class="act">
      <div class="act-col">
        <h3>Ideas for your data</h3>
        ${
          ideas.length
            ? ideas.map((x, i) => `<button class="act-idea" data-act-idea="${i}"><span class="act-idea-ico">▶</span><span><b>${esc(x.label)}</b><small>on ${esc(x.layer)}</small></span></button>`).join('')
            : `<p class="act-empty">Add points (a phone, a GPS, a sensor log or a file) and GeoSpaX suggests what to do with them.</p>`
        }
        <button class="act-more" data-cmd-act="analyze.toolbox">All tools in the Toolbox →</button>
      </div>
      <div class="act-col">
        <h3>What happened</h3>
        ${runs.join('') || `<p class="act-empty">Nothing yet. Every analysis you run (or that runs by itself when a device is plugged in) appears here with its report.</p>`}
        ${notes.length ? `<div class="act-notes">${notes.join('')}</div>` : ''}
      </div>
    </div>`;
    el.onclick = (e) => {
      const t = e.target as HTMLElement;
      const idea = t.closest<HTMLElement>('[data-act-idea]');
      if (idea) {
        this.activityIdeas[Number(idea.dataset.actIdea)]?.run();
        this.setStatus('Running…');
        return;
      }
      const del = t.closest<HTMLElement>('[data-act-del]')?.dataset.actDel;
      if (del) return void this.deleteRuns([del]);
      const open = t.closest<HTMLElement>('[data-act-open]')?.dataset.actOpen;
      if (open) return this.host.openRun(open);
      const cmd = t.closest<HTMLElement>('[data-cmd-act]')?.dataset.cmdAct;
      if (cmd) void this.run(cmd);
    };
  }

  private activityIdeas: { run: () => void }[] = [];

  /** Forget runs (their map, report and log; layers they added stay), after asking once. */
  async deleteRuns(ids: string[]) {
    if (!ids.length) return;
    const what = ids.length === 1 ? 'this map and its report' : `${ids.length} finished runs (maps and reports)`;
    if (!window.confirm(`Delete ${what}? Layers already on the map stay. This cannot be undone.`)) return;
    let failed = 0;
    for (const id of ids) {
      try {
        await this.host.backend.json(`api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch {
        failed++;
      }
    }
    await this.loadRuns();
    this.renderHistory();
    document.dispatchEvent(new CustomEvent('geospax:runs-changed'));
    this.setStatus(failed ? `${failed} could not be deleted (still running?)` : ids.length === 1 ? 'Deleted' : `Deleted ${ids.length} runs`, 5000);
  }

  renderHistory() {
    this.renderActivity();
    const el = document.querySelector<HTMLElement>('#history');
    if (!el) return;
    if (!this.runs.length) {
      el.innerHTML = `<div class="pane-empty">No runs yet. Open <b>Automate</b> and run a recipe.</div>`;
      return;
    }
    const rows = this.runs
      .map(
        (r) => `<div class="run-row ${esc(r.status)}" data-run="${esc(r.id)}">
          <span class="st">${esc(r.status)}</span>
          <span class="rt">${esc(r.title || r.recipe)}</span>
          <span class="rm">${esc(r.trigger?.text ?? '')}</span>
          <span class="rd">${(r.elapsed_ms / 1000).toFixed(1)}s</span>
          <button data-open="${esc(r.id)}" title="Open the report">Report</button>
          ${r.status === 'running' || r.status === 'queued' ? '' : `<button class="run-del" data-del="${esc(r.id)}" title="Delete this run (map, report, log)" aria-label="Delete">✕</button>`}
        </div>`,
      )
      .join('');
    el.innerHTML = `<div class="pane-head"><span class="pane-title">Run history</span><span class="pane-sub">${this.runs.length} runs</span><button class="run-clear" data-clear title="Delete every finished run">Clear history</button></div>
      <div class="run-list">${rows}</div>`;
    el.onclick = (e) => {
      const t = e.target as HTMLElement;
      const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
      if (del) return void this.deleteRuns([del]);
      if (t.closest('[data-clear]')) return void this.deleteRuns(this.runs.filter((r) => r.status !== 'running' && r.status !== 'queued').map((r) => r.id));
      const b = t.closest<HTMLElement>('[data-open]');
      if (b?.dataset.open) this.host.openRun(b.dataset.open);
    };
  }

  log(line: string, level: 'info' | 'warn' | 'error' = 'info') {
    const t = new Date().toLocaleTimeString();
    this.logs.push({ t, level, text: line });
    if (this.logs.length > 300) this.logs.shift();
    this.renderLog();
    this.renderActivity();
  }

  renderLog() {
    const el = document.querySelector<HTMLElement>('#log');
    if (!el) return;
    const rows = [...this.logs].reverse().map((l) => `<div class="log-row ${l.level}"><span class="lt">${l.t}</span>${esc(l.text)}</div>`).join('');
    el.innerHTML = `<div class="pane-head"><span class="pane-title">Log</span><span class="pane-sub">${this.logs.length} lines</span></div>
      <div class="log-list">${rows || '<div class="pane-empty">Nothing logged yet.</div>'}</div>`;
  }

  // ---------------------------------------------------------------- status bar

  setStatus(text: string, ms = 2500) {
    const el = document.querySelector<HTMLElement>('#sb-msg');
    if (el) el.textContent = text;
    this.statusExpire = Date.now() + ms;
    window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      if (Date.now() >= this.statusExpire) {
        const e2 = document.querySelector<HTMLElement>('#sb-msg');
        if (e2) e2.textContent = 'Ready';
      }
    }, ms);
  }

  private wireMapStatus() {
    const map = this.host.map;
    const coords = document.querySelector<HTMLElement>('#sb-coords');
    const scale = document.querySelector<HTMLElement>('#sb-scale');
    const layer = document.querySelector<HTMLElement>('#sb-layer');
    const updScale = () => {
      const z = map.getZoom();
      const mpp = (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / Math.pow(2, z);
      const ratio = Math.round(mpp * 3779.5275590551); // 96 dpi → px per metre
      if (scale) scale.textContent = `1:${nice(ratio)} · z${z.toFixed(1)}`;
    };
    map.on('mousemove', (e) => {
      if (coords) coords.textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
    });
    map.on('move', updScale);
    map.on('zoom', updScale);
    updScale();
    const tick = () => {
      const id = this.host.activeId();
      const l = id ? this.host.layerById(id) : undefined;
      if (layer) layer.textContent = l ? `${l.name} · ${l.feature_count.toLocaleString()} features · ${l.geometry}` : 'no layer selected';
      const ed = document.querySelector<HTMLElement>('#sb-edition');
      if (ed) ed.textContent = this.host.edition;
    };
    tick();
    setInterval(tick, 1000);
  }

  private wireIdentify() {
    // Pro's "Identify": click a feature, get its attributes in a popup.
    let popup: maplibregl.Popup | null = null;
    this.host.map.on('click', (e) => {
      // an edit tool owns the click (web/src/editing.ts); drawing handles (td-*) are not data
      const tool = document.body.dataset.editTool;
      if ((tool && tool !== 'idle') || document.body.dataset.measure) return;
      const feats = this.host.map.queryRenderedFeatures(e.point);
      const f = feats.find((x) => !x.layer.id.startsWith('td-') && !x.layer.id.endsWith('#sel') && x.properties && Object.keys(x.properties).length);
      if (!f) return;
      popup?.remove();
      const rows = Object.entries(f.properties as Record<string, unknown>)
        .filter(([, v]) => v != null && String(v) !== '')
        .slice(0, 12)
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`)
        .join('');
      if (!rows) return;
      popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="identify"><table>${rows}</table></div>`)
        .addTo(this.host.map);
      this.log(`Identify ${f.layer.id ?? ''} · ${Object.keys(f.properties ?? {}).length} fields`);
    });
  }

  // ---------------------------------------------------------------- palette

  private wirePalette() {
    const box = document.querySelector<HTMLElement>('#palette');
    const input = document.querySelector<HTMLInputElement>('#palette-input');
    const list = document.querySelector<HTMLElement>('#palette-list');
    if (!box || !input || !list) return;
    const open = async () => {
      this.paletteOpen = true;
      box.hidden = false;
      input.value = '';
      await this.buildPaletteItems('');
      input.focus();
    };
    const close = () => {
      this.paletteOpen = false;
      box.hidden = true;
    };
    document.addEventListener('geospax:palette', () => void open());
    document.addEventListener('geospax:shortcuts', () => this.showShortcuts());
    box.addEventListener('click', (e) => {
      if (e.target === box) close();
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-pal]');
      if (row) {
        const idx = Number(row.dataset.pal);
        const item = this.paletteItems[idx];
        close();
        item?.run();
      }
    });
    input.addEventListener('input', () => void this.buildPaletteItems(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowDown') { this.paletteIndex = Math.min(this.paletteItems.length - 1, this.paletteIndex + 1); this.renderPalette(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { this.paletteIndex = Math.max(0, this.paletteIndex - 1); this.renderPalette(); e.preventDefault(); }
      if (e.key === 'Enter') {
        const item = this.paletteItems[this.paletteIndex];
        close();
        item?.run();
        e.preventDefault();
      }
    });
    this.renderPalette = () => {
      list.innerHTML = this.paletteItems
        .map(
          (it, i) =>
            `<div class="pal-row${i === this.paletteIndex ? ' on' : ''}" data-pal="${i}"><span class="pk">${esc(it.kind)}</span><span class="pl">${esc(it.label)}</span><span class="ps">${esc(it.sub)}</span></div>`,
        )
        .join('');
      list.querySelector('.pal-row.on')?.scrollIntoView({ block: 'nearest' });
    };
    this.renderPalette();
  }

  private renderPalette: () => void = () => {};

  /** Installed plugins with at least one tool (used by the ribbon and the palette). */
  private pluginTools(): PluginInfo[] {
    return (this.host.plugins()?.plugins ?? []).filter((p) => p.tools.length > 0 && !p.library);
  }

  private paletteSeq = 0;

  private async buildPaletteItems(q: string) {
    // the newest query wins: a slower earlier build (the one on open) must not overwrite it
    const seq = ++this.paletteSeq;
    const items: typeof this.paletteItems = [];
    const host = this.cmdHost();
    // R & Python is a Pro tab: Lazy's search does not offer its commands
    const lazy = this.host.mode() === 'lazy';
    for (const c of COMMANDS) {
      if (lazy && c.tab === 'r') continue;
      items.push({
        id: c.id,
        label: c.title,
        sub: `${c.tab} › ${c.group}${c.keys ? ` · ${c.keys}` : ''}`,
        kind: 'cmd',
        run: () => void c.run(host),
      });
    }
    for (const p of this.pluginTools()) {
      for (const t of p.tools) {
        items.push({
          id: `plugin:${p.id}/${t.id}`,
          label: t.name,
          sub: p.builtin ? `tool · ${t.group ?? ''}` : `plugin tool · ${p.name}`,
          kind: p.builtin ? 'tool' : 'plugin',
          run: () => this.host.plugins()?.openTool(p, t),
        });
      }
    }
    for (const l of this.host.layers()) {
      items.push({
        id: `layer:${l.id}`,
        label: l.name,
        sub: `layer · ${l.feature_count.toLocaleString()} features`,
        kind: 'layer',
        run: () => {
          this.host.setActive(l.id);
          this.host.refreshContents();
          this.host.fitLayer(l.id);
        },
      });
    }
    try {
      const r = await this.host.backend.json<{ recipes: RecipeInfo[] }>('api/recipes');
      for (const x of r.recipes) {
        items.push({
          id: `recipe:${x.id}`,
          label: x.title ?? x.id,
          sub: `recipe · run now`,
          kind: 'recipe',
          run: () => void this.host.runRecipe(x.id),
        });
      }
    } catch { /* offline */ }
    const s = q.trim().toLowerCase();
    const score = (t: string) => {
      const hay = t.toLowerCase();
      if (hay.startsWith(s)) return 0;
      const i = hay.indexOf(s);
      return i < 0 ? 99 : 1 + i / 100;
    };
    if (seq !== this.paletteSeq) return;
    this.paletteItems = (s ? items.map((it) => ({ it, k: Math.min(score(it.label), score(it.sub) + 0.5) })).filter((x) => x.k < 99).sort((a, b) => a.k - b.k).map((x) => x.it) : items).slice(0, 60);
    this.paletteIndex = 0;
    this.renderPalette();
  }

  private showShortcuts() {
    const rows = COMMANDS.filter((c) => c.keys)
      .map((c) => `<tr><td><kbd>${esc(c.keys!)}</kbd></td><td>${esc(c.title)}</td><td class="dim">${esc(c.tab)} › ${esc(c.group)}</td></tr>`)
      .join('');
    const box = document.querySelector<HTMLElement>('#palette');
    const list = document.querySelector<HTMLElement>('#palette-list');
    if (!box || !list) return;
    box.hidden = false;
    this.paletteOpen = true;
    list.innerHTML = `<div class="keys-help"><h3>Keyboard</h3><table>${rows}</table>
      <p class="dim">Ctrl+K palette · double-click a splitter to reset it · double-click a pane tab to collapse the pane · F11 full screen.</p></div>`;
  }

  // ---------------------------------------------------------------- keyboard

  private wireKeyboard() {
    document.addEventListener('mousedown', (e) => {
      if (!this.menu) return;
      const t = e.target as HTMLElement;
      if (t.closest('.rb-menu') || t.closest('[data-menu]')) return;
      this.closeMenu();
    });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); document.dispatchEvent(new CustomEvent('geospax:palette')); return; }
      if (mod && (e.key === 'F1' || e.key === 'f1')) { e.preventDefault(); this.setRibbonPinned(!this.layout.ribbonPinned); return; }
      if (e.key === 'F5') { e.preventDefault(); void this.run('home.refresh'); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.host.save(); this.setStatus('Project saved'); return; }
      if (!typing && !mod) {
        if (e.key === '+') return void this.host.map.zoomIn();
        if (e.key === '-') return void this.host.map.zoomOut();
        const hit = COMMANDS.find((c) => c.keys && c.keys.length === 1 && c.keys.toLowerCase() === e.key.toLowerCase());
        if (hit) { e.preventDefault(); void this.run(hit.id); return; }
      }
      if (e.key === 'Escape' && this.menu) { e.preventDefault(); this.closeMenu(); return; }
      if (e.key === 'Escape' && !this.layout.ribbonPinned && this.ribbonPeek) { this.hideRibbon(); return; }
      if (e.key === 'Escape' && this.paletteOpen) {
        const box = document.querySelector<HTMLElement>('#palette');
        if (box) box.hidden = true;
        this.paletteOpen = false;
      }
    });
  }
}

function nice(n: number): string {
  const steps = [1, 2, 5];
  let p = Math.pow(10, Math.floor(Math.log10(Math.max(1, n))));
  for (const s of steps) if (s * p >= n) return (s * p).toLocaleString('en-US');
  return (10 * p).toLocaleString('en-US');
}
