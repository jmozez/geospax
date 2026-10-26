// The Project pane (left dock): what the project is, where it is saved, and what is in it, as the
// Project pane in ArcGIS Pro. The project (draw order, styles, groups, basemap, view, bookmarks) saves
// itself to the engine's state folder after every change; "Save a copy" downloads it as a file to keep
// or share, "Open" reads one back (a 3.0 copy, or a .gspx / .geolibre.json whose layers are
// imported), and bookmarks remember map views by name.
import type { Backend } from './backend';
import type { Project } from './symbology';
import { icon } from './commands';
import { basemapDef } from './basemaps';
import { dialog } from './editing';

export interface Bookmark {
  name: string;
  center: [number, number];
  zoom: number;
}

export interface ProjectPaneHost {
  backend: Backend;
  project: () => Project & { bookmarks?: Bookmark[] };
  view: () => { center: [number, number]; zoom: number };
  flyTo: (b: Bookmark) => void;
  projection: () => 'mercator' | 'globe';
  layerCount: () => number;
  rasterCount: () => number;
  save: () => void;
  /** replace the whole project (Open, New) and redraw */
  replace: (p: Project) => Promise<void>;
  /** an earlier GeoSpaX project file: imported through the upload route */
  importFile: (f: File) => Promise<void>;
  setStatus: (t: string, ms?: number) => void;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export class ProjectPane {
  private path = '';

  constructor(private host: ProjectPaneHost, private el: HTMLElement) {
    void host.backend
      .json<{ path: string }>('api/project/info')
      .then((r) => { this.path = r.path; this.render(); })
      .catch(() => { /* older engine: no path shown */ });
    el.addEventListener('click', (e) => void this.click(e));
    document.addEventListener('geospax:project-changed', () => this.render());
  }

  render() {
    const p = this.host.project();
    const v = this.host.view();
    const bm = p.bookmarks ?? [];
    const saved = Number(document.body.dataset.saved ?? 0);
    const basemap = basemapDef(p.basemap ?? 'offline')?.title ?? p.basemap ?? 'World (offline)';
    this.el.innerHTML = `
      <p class="hint">A project is your map: its layers, their order and styles, groups, basemap, projection, the view and your bookmarks. GeoSpaX saves it by itself after every change. The data stays in your files; the project only points at them.</p>
      <h2>This project</h2>
      <dl class="props">
        <dt>Saved in</dt><dd class="path" title="${esc(this.path)}">${esc(this.path || 'the GeoSpaX state folder')}</dd>
        <dt>Last saved</dt><dd data-saved>${saved ? new Date(saved).toLocaleTimeString() : 'not yet this session'}</dd>
        <dt>Layers</dt><dd>${this.host.layerCount()} vector · ${this.host.rasterCount()} raster</dd>
        <dt>Basemap</dt><dd>${esc(basemap)} <button class="link" data-act="basemap">change</button></dd>
        <dt>Projection</dt><dd>${this.host.projection() === 'globe' ? 'Globe' : 'Web Mercator'} <button class="link" data-act="projection">switch</button></dd>
        <dt>View</dt><dd>${v.center[1].toFixed(4)}, ${v.center[0].toFixed(4)} · zoom ${v.zoom.toFixed(1)}</dd>
      </dl>
      <div class="row">
        <button data-act="save-copy" title="Download the project as a file to keep or share">${icon('download', 14)} Save a copy…</button>
        <button data-act="open" title="Open a GeoSpaX 3 project copy, a .gspx or .geolibre.json file">${icon('folder', 14)} Open…</button>
        <button data-act="new" title="Start again: every layer back to its default style, no groups or bookmarks">${icon('plus', 14)} New</button>
      </div>
      <h2>Bookmarks</h2>
      <div class="bookmarks">${
        bm.length
          ? bm.map((b, i) => `<div class="bm"><button class="bm-go" data-go="${i}" title="Zoom ${b.zoom.toFixed(1)} at ${b.center[1].toFixed(3)}, ${b.center[0].toFixed(3)}">${icon('pin', 13)} ${esc(b.name)}</button><button class="icon" data-ren="${i}" title="Rename" aria-label="Rename ${esc(b.name)}">✎</button><button class="icon" data-del="${i}" title="Delete" aria-label="Delete ${esc(b.name)}">${icon('trash', 13)}</button></div>`).join('')
          : '<p class="pane-empty">No bookmarks yet. Bookmarks remember a map view by name.</p>'
      }</div>
      <div class="row"><button data-act="bookmark" class="primary">${icon('plus', 14)} Bookmark this view</button></div>`;
  }

  /** Called after each save so "Last saved" stays true without a full render. */
  touchSaved() {
    const d = this.el.querySelector('[data-saved]');
    if (d) d.textContent = new Date().toLocaleTimeString();
  }

  async addBookmark(name?: string) {
    const p = this.host.project();
    const v = this.host.view();
    const n = name ?? (await askName('Bookmark this view', `View ${(p.bookmarks?.length ?? 0) + 1}`));
    if (!n?.trim()) return;
    p.bookmarks = [...(p.bookmarks ?? []), { name: n.trim(), center: v.center, zoom: v.zoom }];
    this.host.save();
    this.render();
    this.host.setStatus(`Bookmark "${n.trim()}" added`);
  }

  private async click(e: Event) {
    const t = e.target as HTMLElement;
    const p = this.host.project();
    const bm = p.bookmarks ?? [];
    const go = t.closest<HTMLElement>('[data-go]')?.dataset.go;
    if (go !== undefined) return this.host.flyTo(bm[Number(go)]);
    const ren = t.closest<HTMLElement>('[data-ren]')?.dataset.ren;
    if (ren !== undefined) {
      const b = bm[Number(ren)];
      const n = await askName('Rename the bookmark', b.name);
      if (n?.trim()) { b.name = n.trim(); this.host.save(); this.render(); }
      return;
    }
    const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (del !== undefined) {
      p.bookmarks = bm.filter((_, i) => i !== Number(del));
      this.host.save();
      return this.render();
    }
    switch (t.closest<HTMLElement>('[data-act]')?.dataset.act) {
      case 'bookmark': return void this.addBookmark();
      case 'basemap': return void document.dispatchEvent(new CustomEvent('geospax:basemap', { detail: 'gallery' }));
      case 'projection':
        document.dispatchEvent(new CustomEvent('geospax:projection', { detail: this.host.projection() === 'globe' ? 'mercator' : 'globe' }));
        return this.render();
      case 'save-copy': return this.saveCopy();
      case 'open': return this.open();
      case 'new':
        if ((await dialog('New project', '<p>Every layer goes back to its default style; groups and bookmarks are removed. Your data files are not touched.</p>', [['ok', 'Start a new project'], ['', 'Cancel']])).button !== 'ok') return;
        await this.host.replace({ version: 1, order: [], layers: {} });
        this.host.setStatus('New project');
        return this.render();
    }
  }

  private saveCopy() {
    const p = { ...this.host.project(), view: this.host.view(), format: 'geospax-3-project', saved: new Date().toISOString() };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
    a.download = `geospax-project-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.host.setStatus(`Saved a copy as ${a.download}`, 6000);
  }

  private open() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,.gspx';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const v = JSON.parse(text) as Partial<Project> & { format?: string };
        if (v.format === 'geospax-3-project' || (v.version === 1 && Array.isArray(v.order) && v.layers && typeof v.layers === 'object')) {
          await this.host.replace(v as Project);
          this.host.setStatus(`Opened ${f.name}. Layers it styles that are not in your data folders are left out.`, 8000);
        } else {
          await this.host.importFile(f);
        }
        this.render();
      } catch (e) {
        this.host.setStatus(`${f.name} could not be opened: ${e instanceof Error ? e.message : e}`, 10000);
      }
    };
    inp.click();
  }
}

async function askName(title: string, value: string): Promise<string | null> {
  const r = await dialog(title, `<label>Name <input name="name" value="${esc(value)}" maxlength="80" autofocus></label>`, [['ok', 'OK'], ['', 'Cancel']]);
  return r.button === 'ok' ? r.values.name ?? null : null;
}
