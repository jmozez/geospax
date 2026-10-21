// The Pro-style shell: ribbon, dockable panes, splitters, status bar, command palette
// and history. It renders commands (commands.ts) and hosts the panes that already exist
// (symbology, rasters, devices, automate) instead of replacing them, so the engine keeps
// one front end. Layout state (pane sizes, open tabs) persists in localStorage.
import * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';
import type { RecipeInfo } from './automate';
import type { PluginsPane } from './plugins';
import { groupItemsHtml, COMMANDS, TABS, commandHtml, groupsFor, icon, recipeIcon, type Command, type CommandHost, type TabId } from './commands';
import type { PluginInfo, PluginsState } from './plugins';

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
      openUrl: (p) => window.open(p, '_blank', 'noopener'),
      setRibbonCompact: (compact) => this.setRibbonCompact(compact),
      toggleRibbon: () => this.setRibbonPinned(!this.layout.ribbonPinned),
    };
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
        ${task('data-menu="recipes"', 'hotspot', 'Find patterns', `${this.recipes.length} ready-made analyses`)}
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
        const r = await this.host.backend.json<{ recipes: RecipeInfo[] }>('api/recipes');
        this.recipes = r.recipes;
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
    // tool library (GeoLibre's 1,000+) is one button that opens the Toolbox; tools that name no
    // tab go to Add-ins (ArcGIS Pro's Add-In tab).
    const tab = this.layout.ribbon;
    for (const p of this.pluginTools()) {
      if (p.tools.length > 40) {
        if ((p.tools[0]?.tab ?? 'analyze') !== tab) continue;
        parts.push(`<div class="rb-group" data-group="plugin:${esc(p.id)}"><div class="rb-items">
          <button class="rb-btn big" data-toolbox="${esc(p.name)}" title="Search the ${p.tools.length.toLocaleString('en-US')} tools of ${esc(p.name)} in the Toolbox">
            <span class="rb-ico">${icon('grid', 20)}</span><span class="rb-label">${esc(p.name)}<br><small>${p.tools.length.toLocaleString('en-US')} tools</small></span></button>
          </div><div class="rb-title">${esc(p.name)}</div></div>`);
        continue;
      }
      const mine = p.tools.filter((t) => (t.tab ?? 'addins') === tab);
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
            ? this.comboHtml({ menu: key, icon: tools[0].icon ?? 'grid', label: group.replace(/^GSX · /, ''), count: tools.length, title: `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}` })
            : inline;
        parts.push(
          `<div class="rb-group" data-group="${esc(key)}"><div class="rb-items">${body}</div><div class="rb-title">${esc(group)}${tools.length > 3 ? this.galleryToggle() : ''}</div></div>`,
        );
      }
    }
    if (tab === 'addins' && !parts.length) {
      parts.push(`<div class="rb-group"><div class="rb-items"><span class="dim rb-empty">No add-ins yet. Plugins whose tools name no tab show here; manage them in the Plugins pane.</span></div><div class="rb-title">Add-ins</div></div>`);
    }
    bodyEl.innerHTML = parts.join('') + `<div class="rb-spacer"></div>`;
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

  private openMenu(anchor: HTMLElement, kind: string) {
    const rows = kind === 'recipes' ? this.recipeRows() : kind.startsWith('plugin:') ? this.pluginRows(kind.slice(7).split(':')[0], kind.split(':').slice(2).join(':') || undefined) : '';
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

  private recipeRows(): string {
    const head = `<div class="rb-menu-head"><span>Recipes</span><span class="dim">${this.recipes.length} — click to run</span></div>`;
    const rows = this.recipes
      .map((x) => {
        const desc = (x.description ?? '').replace(/\s+/g, ' ').trim();
        return `<button class="rb-menu-row" data-recipe="${esc(x.id)}" title="${esc(desc)}">
          <span class="rm-ico">${icon(recipeIcon(x), 16)}</span>
          <span class="rm-txt"><span class="rm-name">${esc(x.title ?? x.id)}</span>${
            desc ? `<span class="rm-desc">${esc(desc.length > 90 ? `${desc.slice(0, 90)}…` : desc)}</span>` : ''
          }</span></button>`;
      })
      .join('');
    return head + rows;
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
    return head + rows || head + '<div class="rb-menu-empty">no tools</div>';
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
    drag('#splitter-left', (dx) => { this.layout.left = Math.min(560, Math.max(190, this.layout.left + dx)); this.applyLayout(); });
    drag('#splitter-right', (dx) => { this.layout.right = Math.min(640, Math.max(220, this.layout.right - dx)); this.applyLayout(); });
    drag('#splitter-bottom', (_dx, dy) => { this.layout.bottom = Math.min(560, Math.max(90, this.layout.bottom - dy)); this.applyLayout(); });
  }

  private loadLayout() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) this.layout = { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Layout), tabs: { ...DEFAULT_LAYOUT.tabs, ...(JSON.parse(raw) as Layout).tabs } };
    } catch { /* first run, or a stale shape: defaults are fine */ }
  }

  private saveLayout() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.layout)); } catch { /* private mode */ }
  }

  // ---------------------------------------------------------------- catalog

  renderCatalog() {
    const el = document.querySelector<HTMLElement>('#catalog');
    if (!el) return;
    const f = this.catalogFilter.trim().toLowerCase();
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
        return `<div class="node source"><span class="tw">▾</span>${icon('book', 14)}<span class="nm">${esc(src.split('/').pop() || src)}</span><span class="ct">${ls.length}</span></div><div class="kids">${rows}</div>`;
      })
      .join('');
    el.innerHTML = `<div class="pane-tools"><input id="cat-filter" type="search" placeholder="Find a layer…" value="${esc(this.catalogFilter)}" /></div>
      <div class="tree">
        <div class="node source" data-shortcut="devices">${icon('phone', 14)}<span class="nm">Devices</span></div>
        <div class="node source" data-shortcut="rasters">${icon('image', 14)}<span class="nm">Rasters</span></div>
        <div class="node source" data-shortcut="automate">${icon('play', 14)}<span class="nm">Recipes</span></div>
        <div class="node source" data-shortcut="history">${icon('history', 14)}<span class="nm">Run history</span></div>
        ${tree || '<div class="pane-empty">No layers yet — import a device or run a recipe.</div>'}
      </div>`;
    el.onclick = (e) => {
      const t = e.target as HTMLElement;
      const sc = t.closest<HTMLElement>('[data-shortcut]')?.dataset.shortcut;
      if (sc === 'devices') return this.showTab('right', 'devices');
      if (sc === 'rasters') return this.showTab('right', 'rasters');
      if (sc === 'automate') return this.showTab('bottom', 'automate');
      if (sc === 'history') return this.showTab('bottom', 'history');
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
    el.oninput = (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'cat-filter') { this.catalogFilter = t.value; this.renderCatalog(); const a = document.querySelector<HTMLInputElement>('#cat-filter'); if (a) { a.focus(); a.setSelectionRange(a.value.length, a.value.length); } }
    };
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
      if (!['inspector', 'toolbox', 'devices', 'attributes'].includes(right)) this.layout.tabs.right = 'inspector';
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
        ${r.status === 'done' ? `<button data-act-open="${esc(r.id)}">Open report</button>` : ''}</div>`;
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
      const open = t.closest<HTMLElement>('[data-act-open]')?.dataset.actOpen;
      if (open) return this.host.openRun(open);
      const cmd = t.closest<HTMLElement>('[data-cmd-act]')?.dataset.cmdAct;
      if (cmd) void this.run(cmd);
    };
  }

  private activityIdeas: { run: () => void }[] = [];

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
        </div>`,
      )
      .join('');
    el.innerHTML = `<div class="pane-head"><span class="pane-title">Run history</span><span class="pane-sub">${this.runs.length} runs</span></div>
      <div class="run-list">${rows}</div>`;
    el.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
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
      const feats = this.host.map.queryRenderedFeatures(e.point);
      const f = feats.find((x) => x.properties && Object.keys(x.properties).length);
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
    return (this.host.plugins()?.plugins ?? []).filter((p) => p.tools.length > 0);
  }

  private async buildPaletteItems(q: string) {
    const items: typeof this.paletteItems = [];
    const host = this.cmdHost();
    for (const c of COMMANDS) {
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
          sub: `plugin tool · ${p.name}`,
          kind: 'plugin',
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
