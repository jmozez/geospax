// The Pro-style shell: ribbon, dockable panes, splitters, status bar, command palette
// and history. It renders commands (commands.ts) and hosts the panes that already exist
// (symbology, rasters, devices, automate) instead of replacing them, so the engine keeps
// one front end. Layout state (pane sizes, open tabs) persists in localStorage.
import * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';
import type { RecipeInfo } from './automate';
import type { PluginsPane } from './plugins';
import { COMMANDS, TABS, commandHtml, groupsFor, icon, recipeIcon, type Command, type CommandHost, type TabId } from './commands';
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
}

const DEFAULT_LAYOUT: Layout = {
  left: 300,
  right: 340,
  bottom: 232,
  collapsed: [],
  tabs: { left: 'contents', right: 'symbology', bottom: 'automate' },
  ribbon: 'home',
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
    const tabsEl = document.querySelector<HTMLElement>('#ribbon-tabs');
    const bodyEl = document.querySelector<HTMLElement>('#ribbon-body');
    if (!tabsEl || !bodyEl) return;
    tabsEl.innerHTML = TABS.map(
      (t) => `<button class="rb-tab${t.id === this.layout.ribbon ? ' on' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`,
    ).join('');
    // Assignment (not addEventListener): buildRibbon runs again on every tab switch.
    tabsEl.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) { this.layout.ribbon = b.dataset.tab as TabId; this.saveLayout(); this.buildRibbon(); }
    };
    bodyEl.onclick = (e) => {
      const t = e.target as HTMLElement;
      const rec = t.closest<HTMLElement>('[data-recipe]');
      if (rec?.dataset.recipe) {
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
        if (p && tl) this.host.plugins()?.openTool(p, tl);
        return;
      }
      const b = t.closest<HTMLElement>('[data-cmd]');
      if (b) void this.run(b.dataset.cmd!);
    };
    void this.renderRibbonBody(bodyEl);
  }

  private async renderRibbonBody(bodyEl: HTMLElement) {
    const groups = groupsFor(this.layout.ribbon);
    const parts: string[] = [];
    for (const g of groups) {
      parts.push(`<div class="rb-group"><div class="rb-items">${g.items.map((c) => commandHtml(c)).join('')}</div><div class="rb-title">${esc(g.group)}</div></div>`);
    }
    // Analyze: a live recipe gallery (one click = run), straight from the engine.
    if (this.layout.ribbon === 'analyze') {
      try {
        const r = await this.host.backend.json<{ recipes: RecipeInfo[] }>('api/recipes');
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
        parts.unshift(`<div class="rb-group wide"><div class="rb-items recipes">${cards}</div><div class="rb-title">Recipes — click to run</div></div>`);
      } catch { /* engine offline: the static commands still work */ }
    }
    // Plugin tools, one group per plugin (docs/PLUGINS.md).
    for (const p of this.pluginTools()) {
      const items = p.tools
        .slice(0, 6)
        .map(
          (t) =>
            `<button class="rb-btn" data-plugin-tool="${esc(p.id)}/${esc(t.id)}" title="${esc(t.summary || t.name)}">
              <span class="rb-ico">${icon(t.icon ?? 'grid', 18)}</span>
              <span class="rb-label">${esc(t.name)}</span>
            </button>`,
        )
        .join('');
      parts.push(`<div class="rb-group"><div class="rb-items">${items}</div><div class="rb-title">${esc(p.name)} <span class="dim">plugin</span></div></div>`);
    }
    bodyEl.innerHTML = parts.join('') + `<div class="rb-spacer"></div>`;
  }

  private async run(id: string) {
    const c = COMMANDS.find((x) => x.id === id);
    if (!c) return;
    this.setStatus(`${c.title}…`);
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

  renderHistory() {
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
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); document.dispatchEvent(new CustomEvent('geospax:palette')); return; }
      if (e.key === 'F5') { e.preventDefault(); void this.run('home.refresh'); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.host.save(); this.setStatus('Project saved'); return; }
      if (!typing && !mod) {
        if (e.key === '+') return void this.host.map.zoomIn();
        if (e.key === '-') return void this.host.map.zoomOut();
        const hit = COMMANDS.find((c) => c.keys && c.keys.length === 1 && c.keys.toLowerCase() === e.key.toLowerCase());
        if (hit) { e.preventDefault(); void this.run(hit.id); return; }
      }
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
