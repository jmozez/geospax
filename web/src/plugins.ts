// Plugins pane (docs/PLUGINS.md): what is installed, what each plugin can do, and a form
// for every tool. GeoSpaX reads five manifest formats, so a tool written for RustGIS,
// GeoLibre, QGIS or ArcGIS Pro shows up here next to a native one — with an honest note
// when its runtime is missing (a QGIS UI plugin needs PyQt; a Pro add-in needs .NET).
import type { Backend } from './backend';
import { icon } from './commands';

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
  plugins: PluginInfo[];
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
  layers: () => { id: string; name: string; fields?: { name: string; kind: string }[] }[];
  onChanged: (state: PluginsState) => void;
}

export class PluginsPane {
  private state: PluginsState = { plugins: [], runtimes: {}, dirs: [] };
  private modal: HTMLDivElement;
  private busy = new Set<string>();
  private error = '';
  /** id of a plugin whose Uninstall button has been pressed once (two-step delete). */
  private confirmUninstall: string | null = null;

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
  }

  async reload() {
    try {
      this.state = await this.backend.json<PluginsState>('api/plugins');
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

  // ---------------------------------------------------------------- render

  render() {
    if (this.error) {
      this.root.innerHTML = `<div class="pane-head"><span class="pane-title">Plugins</span></div>
        <div class="pane-empty err">${esc(this.error)}</div>`;
      return;
    }
    const rt = Object.entries(this.state.runtimes)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');
    // built-in tool sets are part of GeoSpaX: their tools are in the Toolbox, not listed here
    const added = this.state.plugins.filter((p) => !p.builtin && !p.library).sort((a, b) => Number(!!b.default) - Number(!!a.default));
    const head = `<div class="pane-head">
        <span class="pane-title">Plugins</span>
        <span class="pane-sub">${added.length} installed · runtimes: ${esc(rt || 'none found')}</span>
      </div>
      <div class="plugin-tools">
        <button data-act="reload">Reload</button>
        <input id="plugin-import" type="text" placeholder="Folder or package (.rgplugin, .esriAddInX, .zip)" />
        <button data-act="import" class="primary">Install</button>
      </div>`;
    if (!added.length) {
      this.root.innerHTML = `${head}
        <div class="pane-empty">No plugins yet. Drop a folder into <code>${esc(
          this.state.dirs[0] ?? '<state>/plugins',
        )}</code>, install one above, or copy <code>plugins/example-python</code> to see the format.
        Every plugin is a folder with a manifest: <code>plugin.yaml</code> (GeoSpaX),
        <code>plugin.json</code> (RustGIS/GeoLibre), <code>metadata.txt</code> (QGIS) or
        <code>Config.daml</code> (ArcGIS Pro).</div>`;
      return;
    }
    const cards = added.map((p) => this.card(p)).join('');
    this.root.innerHTML = head + `<div class="plugin-list">${cards}</div>`;
  }

  private card(p: PluginInfo): string {
    const badge = `<span class="badge src-${p.source}">${esc(SOURCE_LABEL[p.source] ?? p.source)}</span>`;
    const state = p.runnable
      ? `<span class="badge ok">${esc(p.kind)} · ready</span>`
      : `<span class="badge warn">needs ${esc(p.needs ?? 'its runtime')}</span>`;
    const tools = p.tools.length
      ? p.tools
          .map(
            (t) => `<div class="tool-row">
              <span class="tool-ico">${icon(t.icon ?? 'play', 16)}</span>
              <span class="tool-name" data-open="${esc(p.id)}" data-tool="${esc(t.id)}" title="${esc(t.summary)}">${esc(t.name)}</span>
              <span class="tool-sum">${esc(t.summary)}</span>
              <button data-open="${esc(p.id)}" data-tool="${esc(t.id)}" ${p.runnable ? '' : 'disabled'}>Run…</button>
            </div>`,
          )
          .join('')
      : `<div class="tool-row dim">No tools declared.</div>`;
    const cmds = p.commands.length
      ? `<div class="cmd-row">ribbon: ${p.commands.map((c) => esc(c.title)).join(' · ')}</div>`
      : '';
    return `<div class="plugin ${p.runnable ? '' : 'off'}">
      <div class="p-head">
        <span class="p-name">${esc(p.name)}</span>
        <span class="p-ver">${esc(p.version ?? '')}</span>
        ${badge}${state}
      </div>
      <div class="p-desc">${esc(p.description)}</div>
      ${p.warning ? `<div class="p-warn">⚠ ${esc(p.warning)}</div>` : ''}
      <div class="p-tools">${tools}</div>
      ${cmds}
      <div class="p-foot">
        <span class="p-path">${esc(p.path)}</span>
        ${p.default
          ? `<span class="p-keep dim" title="Ships with GeoSpaX">default plugin</span>`
          : this.canUninstall(p)
          ? `<button class="p-del" data-act="uninstall" data-id="${esc(p.id)}" title="Remove this plugin from ${esc(
              this.state.dirs[this.state.dirs.length - 1] ?? 'the plugin folder',
            )}">${this.confirmUninstall === p.id ? 'Click again to delete' : 'Uninstall'}</button>`
          : `<span class="p-keep dim" title="This one lives in a folder you pointed at with --plugins; remove it yourself">external folder</span>`}
      </div>
    </div>`;
  }

  /** Only plugins installed into the state directory can be removed from here. */
  private canUninstall(p: PluginInfo): boolean {
    const dir = this.state.dirs[this.state.dirs.length - 1];
    return !!dir && p.path.startsWith(dir);
  }

  // ---------------------------------------------------------------- events

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'reload') {
      await this.reload();
      this.host.setStatus('Plugins reloaded');
      return;
    }
    if (act === 'import') {
      const input = this.root.querySelector<HTMLInputElement>('#plugin-import');
      const path = input?.value.trim();
      if (!path) return;
      this.host.setStatus(`Installing ${path}…`);
      try {
        const r = await this.backend.json<{ plugin: PluginInfo }>('api/plugins/import', {
          method: 'POST',
          body: JSON.stringify({ path }),
          headers: { 'content-type': 'application/json' },
        });
        await this.reload();
        this.host.setStatus(`Installed ${r.plugin.name} (${r.plugin.tools.length} tools)`);
      } catch (err) {
        this.host.setStatus(`Install failed: ${(err as Error).message}`, 6000);
        this.host.log(`plugin install failed: ${err}`);
      }
      return;
    }
    const del = t.closest<HTMLElement>('[data-act="uninstall"]');
    if (del) {
      const id = del.dataset.id!;
      if (this.confirmUninstall !== id) {
        this.confirmUninstall = id;
        this.render();
        this.host.setStatus('Press Uninstall again to delete this plugin');
        return;
      }
      this.confirmUninstall = null;
      this.host.setStatus(`Uninstalling ${id}…`);
      try {
        const r = await this.backend.json<{ message: string }>(`api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await this.reload();
        this.host.onChanged(this.state);
        this.host.setStatus(r.message ?? `Uninstalled ${id}`);
        this.host.log(`plugins: ${r.message ?? id}`);
      } catch (err) {
        this.host.setStatus(`Uninstall failed: ${(err as Error).message}`, 6000);
        this.host.log(`plugin uninstall failed: ${err}`);
      }
      return;
    }
    const open = t.closest<HTMLElement>('[data-open]');
    if (open?.dataset.open && open.dataset.tool) {
      const p = this.state.plugins.find((x) => x.id === open.dataset.open);
      const tool = p?.tools.find((x) => x.id === open.dataset.tool);
      if (p && tool) this.openTool(p, tool);
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
    const inputs = params
      .map((prm) => {
        const v = prm.default ?? '';
        if (prm.kind === 'layer') {
          return `<label class="pf"><span>${esc(prm.label || prm.name)}</span><select data-p="${esc(prm.name)}">
            <option value="">auto</option>
            ${layers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}
          </select></label>`;
        }
        if (prm.kind === 'raster' || prm.kind === 'rasters') {
          const multi = prm.kind === 'rasters';
          const opts = rasters.map((r) => `<option value="${esc(r.id)}">${esc(r.title || r.id)}${r.bands > 1 ? ` (${r.bands} bands)` : ''}</option>`).join('');
          return `<label class="pf"><span>${esc(prm.label || prm.name)}${multi ? ' <small class="dim">(Ctrl/⌘-click for several)</small>' : ''}</span><select data-p="${esc(prm.name)}" ${multi ? `multiple size="${Math.min(6, Math.max(3, rasters.length))}"` : ''}>
            ${multi ? '' : '<option value="">(choose)</option>'}${opts || '<option value="" disabled>No rasters on the map yet: add one (Data › Online data, Imagery)</option>'}
          </select></label>`;
        }
        if (prm.kind === 'field') {
          const all = [...new Set(layers.flatMap((l) => field(l).map((f) => f.name)))];
          return `<label class="pf"><span>${esc(prm.label || prm.name)}</span><select data-p="${esc(prm.name)}">
            <option value="">(none)</option>${all.map((f) => `<option>${esc(f)}</option>`).join('')}
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
