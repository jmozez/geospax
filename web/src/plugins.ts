// Plugins pane (docs/PLUGINS.md): what is installed, what each plugin can do, and a form
// for every tool. GeoSpaX reads five manifest formats, so a tool written for RustGIS,
// GeoLibre, QGIS or ArcGIS Pro shows up here next to a native one — with an honest note
// when its runtime is missing (a QGIS UI plugin needs PyQt; a Pro add-in needs .NET).
import { pickField, pickLayers, pickRasters } from './prefill';
import type { Backend } from './backend';
import { icon, pluginIcon } from './commands';
import { PM_TABS, actionsFor, buildRows, checkRepo, filterRows, tabCounts } from './pluginmanager';
import type { ManagerConfig, PmRow, PmTab, RepoIndex } from './pluginmanager';

export interface ParamSpec {
  name: string;
  label: string;
  kind: 'number' | 'text' | 'bool' | 'layer' | 'field' | 'file' | 'choice' | string;
  required: boolean;
  default?: unknown;
  description?: string;
  choices?: string[];
}

export interface ToolSpec {
  id: string;
  name: string;
  summary: string;
  group: string;
  params?: ParamSpec[];
  recipe?: string;
  icon?: string;
  /** ribbon tab (default: Plugins) */
  tab?: string;
}

export interface CommandSpec {
  id: string;
  title: string;
  help: string;
  icon?: string;
  group: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** native · rustgis · geolibre · qgis · arcgis */
  source: string;
  /** recipe · process · python · r · wasm · ui */
  kind: string;
  runnable: boolean;
  needs?: string;
  path: string;
  tools: ToolSpec[];
  commands: CommandSpec[];
  warning?: string;
  /** part of GeoSpaX: its tools are filed with the built-in ones, not listed as a plugin */
  builtin?: boolean;
  /** a tool library other plugins run (GSX): its tools run from recipes and the API, never listed */
  library?: boolean;
  /** one of GeoSpaX's default plugins: listed here, shipped with the app, not removable */
  default?: boolean;
}

export interface PluginsState {
  /** what the ribbon and Toolbox offer: switched-off plugins are left out */
  plugins: PluginInfo[];
  /** every plugin found, switched off or not (the manager) */
  all?: PluginInfo[];
  disabled?: string[];
  runtimes: Record<string, string | null>;
  dirs: string[];
}

const esc = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const SOURCE_LABEL: Record<string, string> = {
  native: 'GeoSpaX',
  rustgis: 'RustGIS',
  geolibre: 'GeoLibre',
  qgis: 'QGIS',
  arcgis: 'ArcGIS Pro',
};

export interface PluginsHost {
  log: (line: string) => void;
  setStatus: (text: string, ms?: number) => void;
  layers: () => { id: string; name: string; geometry?: string; fields?: { name: string; kind: string }[] }[];
  /** the layer selected in Contents: tool dialogs start from it when it fits */
  active?: () => string | null;
  onChanged: (state: PluginsState) => void;
}

export class PluginsPane {
  private state: PluginsState = { plugins: [], runtimes: {}, dirs: [] };
  private modal: HTMLDivElement;
  private busy = new Set<string>();
  private error = '';
  /** id of a plugin whose Uninstall button has been pressed once (two-step delete). */
  private confirmUninstall: string | null = null;
  // the manager (pluginmanager.ts)
  private tab: PmTab = 'installed';
  private query = '';
  private selected: string | null = null;
  private msg = '';
  private config: ManagerConfig = { disabled: [], repos: [], check_updates: true, show_experimental: false };
  private index: RepoIndex = { fetched: 0, plugins: [], errors: [] };

  constructor(
    private root: HTMLElement,
    private backend: Backend,
    private host: PluginsHost,
  ) {
    this.modal = document.createElement('div');
    this.modal.id = 'plugin-modal';
    this.modal.hidden = true;
    document.body.appendChild(this.modal);
    this.modal.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.modal || t.dataset.close !== undefined) this.closeModal();
      const run = t.closest<HTMLElement>('[data-run-tool]');
      if (run) void this.submit(run.dataset.plugin!, run.dataset.runTool!);
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.closeModal());
    root.addEventListener('click', (e) => void this.onClick(e));
    root.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id !== 'pm-search') return;
      this.query = t.value;
      this.render();
    });
  }

  async reload() {
    try {
      this.state = await this.backend.json<PluginsState>('api/plugins');
      const m = await this.backend
        .json<{ config: ManagerConfig; index: RepoIndex }>('api/plugins/manager')
        .catch(() => ({ config: this.config, index: this.index }));
      this.config = { ...this.config, ...m.config };
      this.index = m.index ?? this.index;
      this.error = '';
    } catch (e) {
      this.error = String((e as Error).message ?? e);
    }
    this.render();
    this.host.onChanged(this.state);
  }

  get plugins(): PluginInfo[] {
    return this.state.plugins;
  }

  /** When the manager opens: fetch the repositories if you asked for update checks (Settings). */
  async opened() {
    await this.reload();
    const stale = Date.now() / 1000 - (this.index.fetched || 0) > 3600;
    if (this.config.check_updates && this.config.repos.some((r) => r.enabled) && stale) await this.refreshRepos(true);
  }

  private get stateDir(): string | undefined {
    return this.state.dirs[this.state.dirs.length - 1];
  }

  private rows(): PmRow[] {
    const all = this.state.all ?? this.state.plugins;
    return buildRows(all, this.state.disabled ?? this.config.disabled, this.index.plugins, this.stateDir, this.config.show_experimental);
  }

  // ---------------------------------------------------------------- render

  render() {
    if (this.error) {
      this.root.innerHTML = `<div class="pane-head"><span class="pane-title">Plugins</span></div>
        <div class="pane-empty err">${esc(this.error)}</div>`;
      return;
    }
    const search = this.root.querySelector<HTMLInputElement>('#pm-search');
    const hadFocus = !!search && document.activeElement === search;
    const rows = this.rows();
    const counts = tabCounts(rows);
    const rail = PM_TABS.map(
      (t) => `<button type="button" class="pm-tab${t.id === this.tab ? ' on' : ''}" data-pm-tab="${t.id}">
        <span>${esc(t.label)}</span>${counts[t.id] === null ? '' : `<span class="pm-count">${counts[t.id]}</span>`}</button>`,
    ).join('');
    let main = '';
    if (this.tab === 'zip') main = this.zipView();
    else if (this.tab === 'settings') main = this.settingsView();
    else main = this.listView(rows);
    const rt = Object.entries(this.state.runtimes)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');
    this.root.innerHTML = `<div class="pm">
      <nav class="pm-rail" aria-label="Plugin manager">${rail}</nav>
      <div class="pm-main">${main}</div>
    </div>
    <div class="pm-status"><span class="pm-msg" role="status">${esc(this.msg)}</span><span class="dim">runtimes: ${esc(rt || 'none found')}</span>
      <button type="button" data-act="reload">Reload</button></div>`;
    if (hadFocus) {
      const s = this.root.querySelector<HTMLInputElement>('#pm-search');
      s?.focus();
      s?.setSelectionRange(s.value.length, s.value.length);
    }
  }

  private listView(rows: PmRow[]): string {
    const shown = filterRows(rows, this.tab, this.query);
    if (!this.selected || !shown.some((r) => r.id === this.selected)) this.selected = shown[0]?.id ?? null;
    const sel = shown.find((r) => r.id === this.selected);
    const empty =
      this.tab === 'not-installed' && !this.config.repos.length
        ? 'No plugin repositories yet: add one under Settings, or install a ZIP.'
        : this.tab === 'upgradeable'
          ? 'Everything is up to date.'
          : this.query
            ? 'No plugin matches your search.'
            : 'No plugins here.';
    const list = shown.length
      ? shown.map((r) => this.row(r)).join('')
      : `<div class="pane-empty">${esc(empty)}</div>`;
    return `<input id="pm-search" type="search" placeholder="Search plugins by name, description, author or tag" value="${esc(this.query)}" />
      <div class="pm-split">
        <div class="plugin-list pm-list" role="listbox">${list}</div>
        <div class="pm-detail">${sel ? this.detail(sel) : '<div class="pane-empty">Choose a plugin to see its details.</div>'}</div>
      </div>`;
  }

  private row(r: PmRow): string {
    const p = r.installed;
    const ver = p?.version ?? r.available?.version ?? '';
    const flag = r.upgradeable
      ? `<span class="badge up">upgrade ${esc(r.available!.version)}</span>`
      : r.available?.experimental
        ? `<span class="badge warn">experimental</span>`
        : '';
    const state = p && !p.runnable ? `<span class="badge warn">needs ${esc(p.needs ?? 'its runtime')}</span>` : '';
    const check = p
      ? `<input type="checkbox" data-act="toggle" data-id="${esc(r.id)}" ${r.enabled ? 'checked' : ''} title="${r.enabled ? 'Switch off (keeps it installed)' : 'Switch on'}" aria-label="Enable ${esc(r.name)}" />`
      : `<span class="pm-nocheck" title="Not installed"></span>`;
    return `<div class="plugin pm-row${r.id === this.selected ? ' on' : ''}${p ? '' : ' avail'}${r.enabled || !p ? '' : ' off'}" data-pm-row="${esc(r.id)}" role="option" aria-selected="${r.id === this.selected}">
      ${check}
      <span class="p-ico">${icon(p ? pluginIcon(p) : 'puzzle', 16)}</span>
      <span class="p-name">${esc(r.name)}</span>
      <span class="p-ver">${esc(ver)}</span>
      ${flag}${state}
    </div>`;
  }

  private detail(r: PmRow): string {
    const p = r.installed;
    const a = r.available;
    const meta: [string, string | undefined][] = [
      ['Installed version', p?.version ?? (p ? '(none)' : undefined)],
      ['Available version', a ? `${a.version} · ${a.repo}` : undefined],
      ['Source', SOURCE_LABEL[r.source] ?? r.source],
      ['Kind', p ? `${p.kind}${p.runnable ? ' · ready' : ` · needs ${p.needs ?? 'its runtime'}`}` : undefined],
      ['Author', p?.author ?? a?.author],
      ['Licence', p?.license ?? a?.license],
      ['Tags', a?.tags?.join(', ')],
      ['Folder', p?.path],
    ];
    const home = p?.homepage ?? a?.homepage;
    const tools = p?.tools.length
      ? p.tools
          .map(
            (t) => `<div class="tool-row">
              <span class="tool-ico">${icon(t.icon ?? 'play', 16)}</span>
              <span class="tool-name" data-open="${esc(p.id)}" data-tool="${esc(t.id)}" title="${esc(t.summary)}">${esc(t.name)}</span>
              <span class="tool-sum">${esc(t.summary)}</span>
              <button data-open="${esc(p.id)}" data-tool="${esc(t.id)}" ${p.runnable && r.enabled ? '' : 'disabled'}>Run…</button>
            </div>`,
          )
          .join('')
      : p
        ? `<div class="tool-row dim">No tools declared.</div>`
        : '';
    const cmds = p?.commands.length ? `<div class="cmd-row">ribbon: ${p.commands.map((c) => esc(c.title)).join(' · ')}</div>` : '';
    const label = { install: 'Install plugin', upgrade: 'Upgrade plugin', reinstall: 'Reinstall plugin', uninstall: 'Uninstall plugin' };
    const buttons = actionsFor(r)
      .map((act) =>
        act === 'uninstall'
          ? `<button class="p-del" data-act="uninstall" data-id="${esc(r.id)}" title="Remove this plugin from ${esc(this.stateDir ?? 'the plugin folder')}">${this.confirmUninstall === r.id ? 'Click again to delete' : label[act]}</button>`
          : `<button class="${act === 'reinstall' ? '' : 'primary'}" data-act="${act}" data-id="${esc(r.id)}" ${this.busy.has(`pm:${r.id}`) ? 'disabled' : ''}>${label[act]}</button>`,
      )
      .join('');
    const keep = r.isDefault
      ? `<span class="p-keep dim" title="Ships with GeoSpaX">default plugin</span>`
      : p && !r.removable
        ? `<span class="p-keep dim" title="This one lives in a folder you pointed at with --plugins; remove it yourself">external folder</span>`
        : '';
    return `<div class="pm-dhead">
        <span class="p-ico">${icon(p ? pluginIcon(p) : 'puzzle', 22)}</span>
        <div><h3>${esc(r.name)}</h3><span class="badge src-${esc(r.source)}">${esc(SOURCE_LABEL[r.source] ?? r.source)}</span>
        ${p ? (r.enabled ? '<span class="badge ok">on</span>' : '<span class="badge warn">switched off</span>') : '<span class="badge">not installed</span>'}
        ${r.newer ? '<span class="badge">newer than the repository</span>' : ''}</div>
      </div>
      <p class="p-desc">${esc(r.description || a?.description || '')}</p>
      ${p?.warning ? `<div class="p-warn">⚠ ${esc(p.warning)}</div>` : ''}
      <table class="pm-meta">${meta
        .filter(([, v]) => v)
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v!)}</td></tr>`)
        .join('')}${home ? `<tr><th>Home page</th><td><a href="${esc(home)}" target="_blank" rel="noopener">${esc(home)}</a></td></tr>` : ''}</table>
      ${tools ? `<div class="p-tools">${tools}</div>` : ''}${cmds}
      <div class="p-foot pm-actions">${keep}${buttons}</div>`;
  }

  private zipView(): string {
    return `<div class="pm-pad">
      <h3>Install from ZIP</h3>
      <p class="dim">A plugin package from a file: <code>.zip</code>, <code>.rgplugin</code> (RustGIS) or <code>.esriAddInX</code> (ArcGIS Pro).
      Installing a newer copy of a plugin you have replaces it. Only install plugins from sources you trust: a plugin runs code on this computer.</p>
      <label class="pf"><span>ZIP file</span><input id="pm-zip-file" type="file" accept=".zip,.rgplugin,.esriAddInX" /></label>
      <div><button class="primary" data-act="upload">Install plugin</button></div>
      <h3>Install from a folder or a path</h3>
      <p class="dim">A plugin folder or package on this computer (on a server: on the server's disk).</p>
      <div class="plugin-tools">
        <input id="plugin-import" type="text" placeholder="Folder or package (.rgplugin, .esriAddInX, .zip)" />
        <button data-act="import" class="primary">Install</button>
      </div>
    </div>`;
  }

  private settingsView(): string {
    const repos = this.config.repos;
    const when = this.index.fetched ? new Date(this.index.fetched * 1000).toLocaleString() : 'never';
    return `<div class="pm-pad">
      <h3>Settings</h3>
      <label class="pf check"><input type="checkbox" data-pm-set="check_updates" ${this.config.check_updates ? 'checked' : ''} /><span>Check for updates when the manager opens</span></label>
      <label class="pf check"><input type="checkbox" data-pm-set="show_experimental" ${this.config.show_experimental ? 'checked' : ''} /><span>Show experimental plugins</span></label>
      <h3>Plugin repositories</h3>
      <p class="dim">A repository is a <code>plugins.json</code> index of packages at a URL or a path (docs/PLUGINS.md). Last checked: ${esc(when)}.</p>
      <table class="pm-repos">
        <tr><th>On</th><th>Name</th><th>URL</th><th></th></tr>
        ${repos.length ? repos
          .map(
            (r, i) => `<tr data-repo="${i}"><td><input type="checkbox" data-act="repo-toggle" data-i="${i}" ${r.enabled ? 'checked' : ''} aria-label="Use ${esc(r.name)}" /></td>
              <td>${esc(r.name)}</td><td class="pm-url">${esc(r.url)}</td>
              <td><button data-act="repo-del" data-i="${i}" title="Remove this repository">Remove</button></td></tr>`,
          )
          .join('') : '<tr><td colspan="4" class="dim">No repositories yet.</td></tr>'}
      </table>
      ${this.index.errors.map((e) => `<div class="p-warn">⚠ ${esc(e)}</div>`).join('')}
      <div class="plugin-tools pm-addrepo">
        <input id="pm-repo-name" type="text" placeholder="Name" />
        <input id="pm-repo-url" type="text" placeholder="https://…/plugins.json or a path" />
        <button data-act="repo-add">Add</button>
      </div>
      <div><button class="primary" data-act="repo-refresh" ${this.busy.has('pm:refresh') ? 'disabled' : ''}>Reload repositories</button></div>
    </div>`;
  }

  private say(text: string, ms = 4000) {
    this.msg = text;
    const el = this.root.querySelector('.pm-msg');
    if (el) el.textContent = text;
    this.host.setStatus(text, ms);
  }

  private async saveConfig(patch: Partial<ManagerConfig>) {
    this.config = { ...this.config, ...patch };
    try {
      const r = await this.backend.json<{ config: ManagerConfig; index: RepoIndex }>('api/plugins/manager', {
        method: 'POST',
        body: JSON.stringify(patch),
        headers: { 'content-type': 'application/json' },
      });
      this.config = r.config;
    } catch (err) {
      this.say(`Could not save the settings: ${(err as Error).message}`, 6000);
    }
    this.render();
  }

  private async refreshRepos(quiet = false) {
    if (this.busy.has('pm:refresh')) return;
    this.busy.add('pm:refresh');
    if (!quiet) this.say('Reading the plugin repositories…');
    try {
      const r = await this.backend.json<{ index: RepoIndex }>('api/plugins/repos/refresh', { method: 'POST' });
      this.index = r.index;
      const up = this.rows().filter((x) => x.upgradeable).length;
      this.say(`${r.index.plugins.length} plugins in the repositories${up ? ` · ${up} upgradeable` : ''}${r.index.errors.length ? ` · ${r.index.errors.length} could not be read` : ''}`);
    } catch (err) {
      this.say(`Could not read the repositories: ${(err as Error).message}`, 6000);
    } finally {
      this.busy.delete('pm:refresh');
    }
    this.render();
  }

  private async installed(r: { plugin: PluginInfo }, verb: string) {
    await this.reload();
    this.selected = r.plugin.id;
    this.say(`${verb} ${r.plugin.name} ${r.plugin.version ?? ''} (${r.plugin.tools.length} tools)`.replace('  ', ' '), 6000);
    this.host.log(`plugins: ${verb.toLowerCase()} ${r.plugin.id}`);
  }

  // ---------------------------------------------------------------- events

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>('[data-pm-tab]')?.dataset.pmTab as PmTab | undefined;
    if (tab) {
      this.tab = tab;
      this.confirmUninstall = null;
      this.render();
      return;
    }
    const actEl = t.closest<HTMLElement>('[data-act]');
    const act = actEl?.dataset.act;
    const id = actEl?.dataset.id ?? '';
    if (act === 'reload') {
      await this.reload();
      this.say('Plugins reloaded');
      return;
    }
    if (act === 'toggle') {
      const on = (actEl as HTMLInputElement).checked;
      try {
        const r = await this.backend.json<{ disabled: string[] }>(`api/plugins/${encodeURIComponent(id)}/enable`, {
          method: 'POST',
          body: JSON.stringify({ enabled: on }),
          headers: { 'content-type': 'application/json' },
        });
        this.config.disabled = r.disabled;
        await this.reload();
        this.say(`${this.state.all?.find((p) => p.id === id)?.name ?? id} ${on ? 'switched on' : 'switched off: its tools are hidden until you switch it on again'}`);
      } catch (err) {
        (actEl as HTMLInputElement).checked = !on;
        this.say(`${(err as Error).message}`, 6000);
      }
      return;
    }
    if (act === 'install' || act === 'upgrade' || act === 'reinstall') {
      const key = `pm:${id}`;
      if (this.busy.has(key)) return;
      this.busy.add(key);
      const verb = { install: 'Installed', upgrade: 'Upgraded', reinstall: 'Reinstalled' }[act];
      this.say(`${verb.replace(/ed$/, 'ing').replace('Upgradeing', 'Upgrading')} ${id}…`);
      this.render();
      try {
        const r = await this.backend.json<{ plugin: PluginInfo }>('api/plugins/repos/install', {
          method: 'POST',
          body: JSON.stringify({ id }),
          headers: { 'content-type': 'application/json' },
        });
        this.busy.delete(key);
        await this.installed(r, verb);
      } catch (err) {
        this.busy.delete(key);
        this.say(`Install failed: ${(err as Error).message}`, 8000);
        this.render();
      }
      return;
    }
    if (act === 'upload') {
      const file = this.root.querySelector<HTMLInputElement>('#pm-zip-file')?.files?.[0];
      if (!file) {
        this.say('Choose a ZIP file first');
        return;
      }
      this.say(`Installing ${file.name}…`);
      try {
        const r = await this.backend.json<{ plugin: PluginInfo }>(`api/plugins/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: await file.arrayBuffer(),
          headers: { 'content-type': 'application/zip' },
        });
        this.tab = 'installed';
        await this.installed(r, 'Installed');
      } catch (err) {
        this.say(`Install failed: ${(err as Error).message}`, 8000);
      }
      return;
    }
    if (act === 'import') {
      const input = this.root.querySelector<HTMLInputElement>('#plugin-import');
      const path = input?.value.trim();
      if (!path) return;
      this.say(`Installing ${path}…`);
      try {
        const r = await this.backend.json<{ plugin: PluginInfo }>('api/plugins/import', {
          method: 'POST',
          body: JSON.stringify({ path }),
          headers: { 'content-type': 'application/json' },
        });
        this.tab = 'installed';
        await this.installed(r, 'Installed');
      } catch (err) {
        this.say(`Install failed: ${(err as Error).message}`, 6000);
        this.host.log(`plugin install failed: ${err}`);
      }
      return;
    }
    if (act === 'uninstall') {
      if (this.confirmUninstall !== id) {
        this.confirmUninstall = id;
        this.render();
        this.say('Press Uninstall again to delete this plugin');
        return;
      }
      this.confirmUninstall = null;
      this.say(`Uninstalling ${id}…`);
      try {
        const r = await this.backend.json<{ message: string }>(`api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await this.reload();
        this.say(r.message ?? `Uninstalled ${id}`);
        this.host.log(`plugins: ${r.message ?? id}`);
      } catch (err) {
        this.say(`Uninstall failed: ${(err as Error).message}`, 6000);
        this.host.log(`plugin uninstall failed: ${err}`);
      }
      return;
    }
    if (act === 'repo-add') {
      const name = this.root.querySelector<HTMLInputElement>('#pm-repo-name')?.value.trim() ?? '';
      const url = this.root.querySelector<HTMLInputElement>('#pm-repo-url')?.value.trim() ?? '';
      const bad = checkRepo(name, url, this.config.repos);
      if (bad) {
        this.say(bad);
        return;
      }
      await this.saveConfig({ repos: [...this.config.repos, { name, url, enabled: true }] });
      await this.refreshRepos();
      return;
    }
    if (act === 'repo-del' || act === 'repo-toggle') {
      const i = Number(actEl!.dataset.i);
      const repos =
        act === 'repo-del'
          ? this.config.repos.filter((_, j) => j !== i)
          : this.config.repos.map((r, j) => (j === i ? { ...r, enabled: (actEl as HTMLInputElement).checked } : r));
      await this.saveConfig({ repos });
      return;
    }
    if (act === 'repo-refresh') {
      await this.refreshRepos();
      return;
    }
    const set = t.closest<HTMLInputElement>('[data-pm-set]');
    if (set) {
      await this.saveConfig({ [set.dataset.pmSet!]: set.checked } as Partial<ManagerConfig>);
      return;
    }
    const open = t.closest<HTMLElement>('[data-open]');
    if (open?.dataset.open && open.dataset.tool) {
      const all = this.state.all ?? this.state.plugins;
      const p = all.find((x) => x.id === open.dataset.open);
      const tool = p?.tools.find((x) => x.id === open.dataset.tool);
      if (p && tool) this.openTool(p, tool);
      return;
    }
    const row = t.closest<HTMLElement>('[data-pm-row]');
    if (row) {
      this.selected = row.dataset.pmRow!;
      this.confirmUninstall = null;
      this.render();
    }
  }

  // ---------------------------------------------------------------- tool dialog

  async openTool(p: PluginInfo, tool: ToolSpec) {
    const layers = this.host.layers();
    // rasters for raster parameters (newest first)
    const rasters = (tool.params ?? []).some((x) => x.kind === 'raster' || x.kind === 'rasters')
      ? ((await this.backend.json<{ rasters: { id: string; title: string; bands: number }[] }>('api/rasters').catch(() => ({ rasters: [] }))).rasters ?? []).slice().reverse()
      : [];
    const field = (l: { fields?: { name: string; kind: string }[] }) => l.fields ?? [];
    const params = tool.params ?? [];
    // fitting inputs chosen up front, as ArcGIS Pro does (prefill.ts)
    const chosen = pickLayers(params, layers, this.host.active?.());
    const firstLayer = layers.find((l) => l.id === Object.values(chosen)[0]);
    const chosenRasters = pickRasters(params, rasters);
    const sel = (on: boolean) => (on ? ' selected' : '');
    const inputs = params
      .map((prm) => {
        const v = prm.default ?? '';
        if (prm.kind === 'layer') {
          return `<label class="pf"><span>${esc(prm.label || prm.name)}</span><select data-p="${esc(prm.name)}">
            <option value="">${prm.required ? '(choose)' : '(none)'}</option>
            ${layers.map((l) => `<option value="${esc(l.id)}"${sel(chosen[prm.name] === l.id)}>${esc(l.name)}</option>`).join('')}
          </select></label>`;
        }
        if (prm.kind === 'raster' || prm.kind === 'rasters') {
          const multi = prm.kind === 'rasters';
          const want = chosenRasters[prm.name];
          const opts = rasters.map((r) => `<option value="${esc(r.id)}"${sel(Array.isArray(want) ? want.includes(r.id) : want === r.id)}>${esc(r.title || r.id)}${r.bands > 1 ? ` (${r.bands} bands)` : ''}</option>`).join('');
          return `<label class="pf"><span>${esc(prm.label || prm.name)}${multi ? ' <small class="dim">(Ctrl/⌘-click for several)</small>' : ''}</span><select data-p="${esc(prm.name)}" ${multi ? `multiple size="${Math.min(6, Math.max(3, rasters.length))}"` : ''}>
            ${multi ? '' : '<option value="">(choose)</option>'}${opts || '<option value="" disabled>No rasters on the map yet: add one (Data › Online data, Imagery)</option>'}
          </select></label>`;
        }
        if (prm.kind === 'field') {
          // the chosen layer's fields first, then the others
          const all = [...new Set([...field(firstLayer ?? {}), ...layers.flatMap(field)].map((f) => f.name))];
          const f0 = pickField(prm, firstLayer);
          return `<label class="pf"><span>${esc(prm.label || prm.name)}</span><select data-p="${esc(prm.name)}">
            <option value="">(none)</option>${all.map((f) => `<option${sel(f === f0)}>${esc(f)}</option>`).join('')}
          </select></label>`;
        }
        if (prm.kind === 'bool') {
          return `<label class="pf check"><input type="checkbox" data-p="${esc(prm.name)}" ${v === true ? 'checked' : ''} /><span>${esc(prm.label || prm.name)}</span></label>`;
        }
        if (prm.kind === 'choice') {
          return `<label class="pf"><span>${esc(prm.label || prm.name)}</span><select data-p="${esc(prm.name)}">
            ${(prm.choices ?? []).map((c) => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select></label>`;
        }
        const type = prm.kind === 'number' ? 'number' : 'text';
        return `<label class="pf"><span>${esc(prm.label || prm.name)}</span>
          <input type="${type}" data-p="${esc(prm.name)}" value="${esc(String(v))}" placeholder="${esc(prm.description ?? '')}" /></label>`;
      })
      .join('');
    const body = params.length ? inputs : `<p class="dim">This tool takes no parameters.</p>`;
    this.modal.innerHTML = `<div class="sheet">
      <header>
        <div>
          <b>${esc(tool.name)}</b>
          <div class="dim">${
            p.builtin
              ? esc((tool.group ?? '').replace(' › ', ' › '))
              : `${esc(p.name)} · ${esc(SOURCE_LABEL[p.source] ?? p.source)} · ${esc(tool.id)}${tool.recipe ? ` · recipe <code>${esc(tool.recipe)}</code>` : ''}`
          }</div>
        </div>
        <button data-close>×</button>
      </header>
      <div class="body">${tool.summary ? `<p class="dim">${esc(tool.summary)}</p>` : ''}${body}<div id="plugin-result" class="plugin-result" hidden></div></div>
      <footer>
        <span class="dim" id="plugin-msg"></span>
        <button data-close>Cancel</button>
        <button class="primary" data-run-tool="${esc(tool.id)}" data-plugin="${esc(p.id)}">Run</button>
      </footer>
    </div>`;
    this.modal.hidden = false;
  }

  private closeModal() {
    this.modal.hidden = true;
  }

  private async submit(pluginId: string, toolId: string) {
    const key = `${pluginId}/${toolId}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    const msg = this.modal.querySelector<HTMLElement>('#plugin-msg');
    const params: Record<string, unknown> = {};
    for (const el of this.modal.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-p]')) {
      if (el instanceof HTMLInputElement && el.type === 'checkbox') params[el.dataset.p!] = el.checked;
      else if (el instanceof HTMLSelectElement && el.multiple) params[el.dataset.p!] = [...el.selectedOptions].map((o) => o.value).filter(Boolean);
      else if (el instanceof HTMLInputElement && el.type === 'number') params[el.dataset.p!] = el.value === '' ? null : Number(el.value);
      else params[el.dataset.p!] = el.value;
    }
    if (msg) msg.textContent = 'Running…';
    this.host.setStatus(`${pluginId}/${toolId} running…`);
    try {
      const res = await this.backend.json<{ kind?: string; run?: { id: string }; result?: unknown; message?: string }>(
        `api/plugins/${encodeURIComponent(pluginId)}/tools/${encodeURIComponent(toolId)}/run`,
        { method: 'POST', body: JSON.stringify({ params }), headers: { 'content-type': 'application/json' } },
      );
      // a tool's answer: its message as text, its table and notes in the dialog (not raw JSON)
      const r = (res.result ?? {}) as { message?: string; table?: [string, unknown][]; notes?: string[]; figures?: { title: string; svg: string }[] };
      const text = res.run?.id
        ? `Recipe started: ${res.run.id} (see History)`
        : res.message
          ? String(res.message)
          : r.message
            ? String(r.message)
            : JSON.stringify(res.result ?? res).slice(0, 300);
      const box = this.modal.querySelector<HTMLElement>('#plugin-result');
      if (box && (r.table?.length || r.notes?.length || r.figures?.length)) {
        const figs = (r.figures ?? [])
          // as images: an SVG in an <img> cannot run scripts, whichever plugin made it
          .map((f) => `<figure class="tool-fig"><img alt="${esc(f.title)}" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(f.svg)))}"><figcaption>${esc(f.title)}</figcaption></figure>`)
          .join('');
        // the chart first, then the numbers, then the method notes
        box.innerHTML = `${figs}${r.table?.length ? `<table>${r.table.map(([k, v]) => `<tr><th>${esc(String(k))}</th><td>${esc(String(v))}</td></tr>`).join('')}</table>` : ''}${(r.notes ?? [])
          .filter(Boolean)
          .map((n) => `<p class="dim">${esc(n)}</p>`)
          .join('')}`;
        box.hidden = false;
        // the answer, not the form, is what you want to see now
        box.scrollIntoView({ block: 'start' });
      }
      if (msg) msg.textContent = text;
      this.host.setStatus(text, 6000);
      this.host.log(`${key}: ${text}`);
      // tools that wrote files report them in "outputs"; the engine adds them to the map
      const added = (res as { added?: string[] }).added ?? [];
      if (added.length) document.dispatchEvent(new CustomEvent('geospax:plugin-ran', { detail: added }));
    } catch (e) {
      const text = String((e as Error).message ?? e);
      if (msg) msg.textContent = text;
      this.host.setStatus(text, 6000);
    } finally {
      this.busy.delete(key);
    }
  }
}
