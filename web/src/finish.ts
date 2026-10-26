// Finish my map: the visible layers, their exact styles and (by default) the area on screen become a
// laid-out map (title, legend, scale bar, north arrow, credits) as PNG, PDF and SVG plus a one-page
// report, in one click. It is an ordinary recipe ("finished-map", replaced each time) so the result
// has run history, provenance and can be re-run or put on a trigger like any other.
// Layouts, in both modes: one map; several tagged panels on one page after R patchwork (each layer side
// by side, or several areas) or ggplot2 facet_wrap (one panel per value of a field, one legend); or a
// map series (ArcGIS Pro's map series, QGIS's atlas): an index page, then one page per area (a grid, or
// each feature of a layer, titled by a field), each showing exactly its area, bound into one PDF.
import type { Backend } from './backend';
import type { LayerStyle } from './symbology';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const FINISH_RECIPE = 'finished-map';
/** the main window and the layout window (layout.ts) talk over this BroadcastChannel */
export const LAYOUT_CHANNEL = 'geospax-layout';
/** what the layout window draws: the styles of the visible layers and the export.map parameters */
export interface LayoutSpec {
  styles: Record<string, unknown>;
  map: Record<string, unknown>;
  title?: string;
}
export type LayoutMsg =
  | { type: 'hello' }
  | { type: 'bye' }
  | { type: 'make' }
  | { type: 'spec'; spec: LayoutSpec }
  | { type: 'finished'; ok: boolean; error?: string };
/** most pages in one series: each page is a full layout */
export const MAX_PAGES = 40;

type Bbox = [number, number, number, number];
interface Page {
  label: string;
  extent: Bbox;
}

/** cols × rows equal pages over a box */
export function gridPages(b: Bbox, cols: number, rows: number): Page[] {
  const [w, s, e, n] = b;
  const dx = (e - w) / cols;
  const dy = (n - s) / rows;
  const out: Page[] = [];
  // reading order: top row first, left to right; labelled like map sheets (A1, B1, …)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ label: `${String.fromCharCode(65 + c)}${r + 1}`, extent: [w + c * dx, n - (r + 1) * dy, w + (c + 1) * dx, n - r * dy] });
  return out;
}

/** a feature's box with a margin, never smaller than ~1 km so a point still gets a readable map */
export function padBox([w, s, e, n]: Bbox, margin = 0.12): Bbox {
  const mx = Math.max((e - w) * margin, 0.005);
  const my = Math.max((n - s) * margin, 0.005);
  return [Math.max(w - mx, -180), Math.max(s - my, -85), Math.min(e + mx, 180), Math.min(n + my, 85)];
}

/** One-click looks: each sets the furniture fields (and the user can change any of them after). */
export const LOOKS: Record<string, { name: string; hint: string; set: Record<string, string> }> = {
  geospax: { name: 'GeoSpaX', hint: 'pill scale, needle, tidy', set: { scale_bar: 'pill', north_arrow: 'needle', legend: 'right', inset: 'none', dpi: '150', units: 'metric' } },
  journal: { name: 'Journal', hint: '300 dpi, legend inside, no frills', set: { scale_bar: 'line', north_arrow: 'minimal', legend: 'inside', legend_at: 'auto', inset: 'none', dpi: '300', size: '4:3' } },
  poster: { name: 'Poster', hint: '600 dpi, overview inset, rose', set: { scale_bar: 'checker', north_arrow: 'rose', legend: 'right', inset: 'auto', dpi: '600', units: 'both' } },
  classic: { name: 'Classic', hint: 'compass, checker bar', set: { scale_bar: 'checker', north_arrow: 'compass', legend: 'right', inset: 'none', dpi: '300' } },
  slide: { name: 'Slide', hint: '16:9, legend inside, inset', set: { scale_bar: 'pill', north_arrow: 'needle', legend: 'inside', legend_at: 'auto', inset: 'auto', dpi: '150', size: '16:9' } },
};

const round = (b: Bbox) => b.map((v) => Math.round(v * 1e5) / 1e5) as Bbox;

export interface FinishHost {
  backend: Backend;
  mode: () => 'lazy' | 'pro';
  /** visible layers, bottom first, with their styles */
  visible: () => { id: string; style: LayerStyle }[];
  /** a good title: the main layer's friendly name */
  suggestTitle: () => string;
  /** the map's current bounds [w, s, e, n] */
  view: () => [number, number, number, number];
  /** a layer's geometry kind (point, line, polygon) */
  geometry: (id: string) => string;
  run: (recipe: string) => Promise<void>;
  setStatus: (t: string, ms?: number) => void;
}

/** A page shape as the engine's size: named paper, or "W:H" as pixels at 150 dpi (about A4 wide). */
export function pageSize(v: string): string {
  const m = /^(\d+):(\d+)$/.exec(v);
  if (!m) return v;
  const r = Number(m[1]) / Number(m[2]);
  return r >= 1 ? `1800x${Math.round(1800 / r)}` : `${Math.round(1800 * r)}x1800`;
}

/** Numbers as the engine's legend writes them (cartography::fmt_num), so renames match. */
export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  const s = v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** The class labels a layer's legend shows (before counts and notes): what can be renamed. */
export function classLabels(st: LayerStyle | undefined): string[] {
  const sym = st?.symbology;
  if (!sym) return [];
  if (sym.kind === 'unique') return sym.classes.map((c) => String(c.value));
  if (sym.kind === 'graduated') {
    let lo = sym.min;
    return sym.breaks.map((b) => {
      const t = `${fmtNum(lo)} – ${fmtNum(b)}`;
      lo = b;
      return t;
    });
  }
  return [];
}

/** The furniture fields as export.map parameters; legend edits and order from the legend editor. */
function furniture(f: FormData, form: HTMLFormElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['projection', 'dpi', 'legend', 'legend_at', 'legend_title', 'scale_bar', 'units', 'scale_bar_at', 'north_arrow', 'north_arrow_at', 'inset']) {
    const v = f.get(k);
    if (v != null) out[k] = k === 'dpi' ? Number(v) : String(v);
  }
  const edit: Record<string, { title?: string; hide?: boolean; labels?: Record<string, string> }> = {};
  const order: string[] = [];
  form.querySelectorAll<HTMLElement>('[data-layer]').forEach((row) => {
    const id = row.dataset.layer!;
    order.push(id);
    const e: { title?: string; hide?: boolean; labels?: Record<string, string> } = {};
    if (!row.querySelector<HTMLInputElement>('[name=lg-show]')!.checked) e.hide = true;
    const t = row.querySelector<HTMLInputElement>('[name=lg-title]')!.value.trim();
    if (t) e.title = t;
    const labels: Record<string, string> = {};
    row.querySelectorAll<HTMLInputElement>('input[data-class]').forEach((i) => {
      if (i.value.trim() && i.value.trim() !== i.dataset.class) labels[i.dataset.class!] = i.value.trim();
    });
    if (Object.keys(labels).length) e.labels = labels;
    if (Object.keys(e).length) edit[id] = e;
  });
  if (Object.keys(edit).length) out.legend_edit = edit;
  if (order.length) out.legend_order = order;
  return out;
}

interface MapStepDef {
  id: string;
  use: string;
  needs: string[];
  with: Record<string, unknown>;
}

interface Plan {
  title: string;
  formats: string[];
  report: boolean;
  steps: MapStepDef[];
  outputs: string[];
  what: string;
  pages?: number;
}

export class FinishMap {
  private el: HTMLElement;
  private previewSeq = 0;
  private previewTimer = 0;
  private chan: BroadcastChannel | null = 'BroadcastChannel' in window ? new BroadcastChannel(LAYOUT_CHANNEL) : null;
  /** a layout window said hello and has not said goodbye */
  private layoutOpen = false;
  private specTimer = 0;

  constructor(private host: FinishHost) {
    this.chan?.addEventListener('message', (e: MessageEvent<LayoutMsg>) => {
      const m = e.data;
      if (m.type === 'hello') {
        this.layoutOpen = true;
        void this.sendSpec();
      } else if (m.type === 'bye') this.layoutOpen = false;
      else if (m.type === 'make') void this.makeFinal();
    });
    this.el = document.createElement('div');
    this.el.id = 'finish';
    this.el.className = 'modal';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-layout]')) {
        void this.openLayout();
        return this.close();
      }
      if (t === this.el || t.closest('[data-close]')) this.close();
    });
    this.el.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.make(e.target as HTMLFormElement);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) this.close();
    });
  }

  /** Share › Export map › PDF / SVG / PNG / Word: Finish my map with just that output ticked. */
  openFor(fmt: 'png' | 'pdf' | 'svg' | 'report') {
    this.open();
    const form = this.el.querySelector<HTMLFormElement>('form');
    if (!form) return;
    for (const k of ['png', 'pdf', 'svg', 'report']) {
      const box = form.querySelector<HTMLInputElement>(`input[name="${k}"]`);
      if (box) box.checked = k === fmt || (fmt === 'report' && k === 'png');
    }
  }

  open() {
    if (!this.host.visible().length) return this.host.setStatus('Switch on at least one layer first: the finished map shows what is on the map', 5000);
    const lazy = this.host.mode() === 'lazy';
    // page layers: visible polygon or line layers small enough to page through
    const index = this.host.visible().map((l) => l.id).filter((id) => /polygon|line/.test(this.host.geometry(id))).reverse();
    const layers = this.host.visible().map((l) => l.id).reverse();
    const multi = layers.length > 1; // one layer: "side by side" is a single-panel figure
    const layout = `<fieldset class="fin-layout"><legend>Layout</legend>
      <div class="fin-chips" role="radiogroup" aria-label="Layout">
        <label><input type="radio" name="layout" value="one" checked /><b>One map</b><small>everything on one map</small></label>
        <label><input type="radio" name="layout" value="side" /><b>${multi ? 'Side by side' : 'Single panel'}</b><small>${multi ? 'each layer in its own panel' : 'a figure panel, tagged'}</small></label>
        <label><input type="radio" name="layout" value="facet" /><b>Split by a field</b><small>small multiples, one legend</small></label>
        <label><input type="radio" name="layout" value="panels" /><b>Panels</b><small>several areas on one page</small></label>
        <label><input type="radio" name="layout" value="atlas" /><b>Map series</b><small>one page per area, bound PDF</small></label>
      </div>
      <div class="fin-opt" data-for="facet">
        <label><span>Layer</span><select name="facet_layer" aria-label="Layer to split">${layers.map((id) => `<option>${esc(id)}</option>`).join('')}</select></label>
        <label><span>Field</span><select name="facet" aria-label="Field to split by"><option value="">…</option></select></label>
      </div>
      <div class="fin-opt" data-for="panels atlas">
        <label class="ck"><input type="radio" name="split" value="grid" checked /> A grid over the area
          <select name="grid" aria-label="Grid"><option value="1x1">1 × 1</option><option value="2x1">2 × 1</option><option value="2x2" selected>2 × 2</option><option value="3x2">3 × 2</option><option value="3x3">3 × 3</option><option value="4x4">4 × 4</option></select></label>
        ${
          index.length
            ? `<label class="ck"><input type="radio" name="split" value="features" /> One per feature of
          <select name="index" aria-label="Area layer">${index.map((id) => `<option>${esc(id)}</option>`).join('')}</select></label>
          <label class="fin-field"><span>Titles from field</span><select name="field" aria-label="Title field"><option value="">(numbered)</option></select></label>`
            : ''
        }
      </div>
      <div class="fin-opt" data-for="side facet panels">
        <label><span>Columns</span><select name="ncol"><option value="">Automatic</option><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
        <label><span>Legend</span><select name="legends"><option value="auto">Automatic</option><option value="collect">One shared legend</option><option value="keep">One per panel</option></select></label>
        <label><span>Tags</span><select name="tags"><option value="a">(a) (b) (c)</option><option value="A">(A) (B) (C)</option><option value="1">(1) (2) (3)</option><option value="i">(i) (ii) (iii)</option><option value="none">No tags</option></select></label>
      </div>
      <small class="dim fin-hint"></small>
    </fieldset>`;
    // Style: one-click looks (what Lazy sees first) and every piece of map furniture (Pro sees all)
    const corners = (name: string, auto: string) =>
      `<select name="${name}"><option value="auto">${auto}</option><option value="tl">Top left</option><option value="tr">Top right</option><option value="bl">Bottom left</option><option value="br">Bottom right</option></select>`;
    const styleOf = new Map(this.host.visible().map((l) => [l.id, l.style]));
    const legendRows = layers
      .map((id) => {
        const classes = classLabels(styleOf.get(id));
        return `<div class="lg-row" data-layer="${esc(id)}" draggable="true">
          <span class="lg-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
          <input type="checkbox" name="lg-show" checked aria-label="Show ${esc(id)} in the legend" />
          <input name="lg-title" placeholder="${esc(id.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '))}" aria-label="Legend title for ${esc(id)}" />
          <span class="lg-move"><button type="button" data-lg="up" aria-label="Move up">▲</button><button type="button" data-lg="down" aria-label="Move down">▼</button></span>
          ${
            classes.length
              ? `<details class="lg-classes"><summary>${classes.length} classes</summary>${classes
                  .map((c) => `<label><span>${esc(c)}</span><input data-class="${esc(c)}" value="${esc(c)}" aria-label="New name for ${esc(c)}" /></label>`)
                  .join('')}</details>`
              : ''
          }
        </div>`;
      })
      .join('');
    const styleBox = `<fieldset class="fin-style"><legend>Style</legend>
      <div class="fin-looks" role="radiogroup" aria-label="Look">
        ${Object.entries(LOOKS)
          .map(([k, l]) => `<label><input type="radio" name="look" value="${k}" ${k === 'geospax' ? 'checked' : ''} /><b>${l.name}</b><small>${l.hint}</small></label>`)
          .join('')}
      </div>
      <details class="fin-more" ${lazy ? '' : 'open'}><summary>Page, legend, scale bar, north arrow, inset</summary>
        <div class="fin-grid">
          <label><span>Page shape</span><select name="size">
            <option value="auto">Automatic (fits the area)</option><option value="1:1">Square 1:1</option><option value="4:3">4:3</option><option value="3:2">3:2</option><option value="16:9">Wide 16:9</option>
            <option value="3:4">Portrait 3:4</option><option value="2:3">Portrait 2:3</option><option value="a4">A4 landscape</option><option value="a4-portrait">A4 portrait</option><option value="a3">A3 landscape</option><option value="letter">US Letter</option></select></label>
          <label><span>Projection</span><select name="projection" title="Equal Earth keeps areas true; Web Mercator matches the web map"><option value="auto">Automatic (Equal Earth for world maps)</option><option value="mercator">Web Mercator</option><option value="equal-earth">Equal Earth (equal-area)</option></select></label>
          <label><span>Resolution</span><select name="dpi"><option value="150">150 dpi (screen)</option><option value="300">300 dpi (print, journals)</option><option value="600">600 dpi (fine print)</option><option value="1200">1200 dpi (line art)</option></select></label>
          <label><span>Legend</span><select name="legend"><option value="right">Beside the map</option><option value="inside">Inside the map</option><option value="none">None</option></select></label>
          <label><span>Legend corner</span>${corners('legend_at', 'Where the data isn’t')}</label>
          <label><span>Legend heading</span><input name="legend_title" value="Legend" /></label>
          <label><span>Scale bar</span><select name="scale_bar"><option value="pill">Pill</option><option value="checker">Checker</option><option value="line">Line</option><option value="ruler">Ruler</option><option value="none">None</option></select></label>
          <label><span>Units</span><select name="units"><option value="metric">km / m</option><option value="imperial">mi / ft</option><option value="both">Both</option></select></label>
          <label><span>Scale bar corner</span>${corners('scale_bar_at', 'Where the data isn’t')}</label>
          <label><span>North arrow</span><select name="north_arrow"><option value="needle">Needle</option><option value="compass">Compass</option><option value="rose">Rose</option><option value="minimal">Minimal</option><option value="none">None</option></select></label>
          <label><span>North arrow corner</span>${corners('north_arrow_at', 'Where the data isn’t')}</label>
          <label><span>Overview inset</span><select name="inset"><option value="none">None</option><option value="auto">Where the data isn’t</option><option value="tl">Top left</option><option value="tr">Top right</option><option value="bl">Bottom left</option><option value="br">Bottom right</option></select></label>
        </div>
        <details class="fin-legend-edit"><summary>Edit the legend</summary>
          <div class="lg-list">${legendRows}</div>
          <small class="dim">Untick to hide a layer, type a new title, rename its classes, and drag (or ▲▼) to change the order.</small>
        </details>
      </details>
    </fieldset>`;
    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const more = `
      <label><span>Subtitle</span><input name="subtitle" value="${esc(today)}" /></label>
      <fieldset><legend>Area</legend>
        <label class="ck"><input type="radio" name="area" value="view" checked /> What you see now</label>
        <label class="ck"><input type="radio" name="area" value="auto" /> All of the data</label></fieldset>
      <fieldset><legend>Files</legend>
        <label class="ck"><input type="checkbox" name="png" checked /> Picture (PNG)</label>
        <label class="ck"><input type="checkbox" name="pdf" checked /> Print (vector PDF)</label>
        <label class="ck"><input type="checkbox" name="svg" checked /> Editable (SVG)</label>
        <label class="ck"><input type="checkbox" name="report" checked /> One-page report</label></fieldset>`;
    this.el.innerHTML = `<form class="sheet fin">
      <header><b>Finish my map</b><button type="button" data-close aria-label="Close">✕</button></header>
      <div class="fin-cols"><figure class="fin-preview" aria-live="polite"><img alt="Preview of the finished map" /><figcaption>Preview…</figcaption></figure>
      <div class="body">
        <p class="fin-lead">The ${this.host.visible().length} layer${this.host.visible().length > 1 ? 's' : ''} on the map, styled as you see them, laid out with a legend, scale bar, north arrow and credits.</p>
        <label><span>Title</span><input name="title" value="${esc(this.host.suggestTitle())}" required /></label>
        ${layout}
        ${styleBox}
        ${lazy ? `<details><summary>More options</summary>${more}</details>` : more}
      </div></div>
      <footer><span class="dim" id="finish-msg"></span><button type="button" data-layout title="The page in a window of its own: zoom in, move it to a second monitor; it redraws as you edit the map">Open in layout window</button><button type="button" data-close>Cancel</button><button class="primary" type="submit">Make the map</button></footer>
    </form>`;
    this.el.hidden = false;
    this.el.querySelector<HTMLInputElement>('input[name=title]')?.select();
    const idx = this.el.querySelector<HTMLSelectElement>('select[name=index]');
    const fillFields = async () => {
      const sel = this.el.querySelector<HTMLSelectElement>('select[name=field]');
      if (!idx || !sel) return;
      try {
        const r = await this.host.backend.json<{ fields: string[] }>(`api/layers/${encodeURIComponent(idx.value)}/rows?limit=1`);
        const good = r.fields.find((f) => /^(name|title|label|district|region|sheet|id)$/i.test(f)) ?? '';
        sel.innerHTML = `<option value="">(numbered)</option>${r.fields.map((f) => `<option ${f === good ? 'selected' : ''}>${esc(f)}</option>`).join('')}`;
      } catch {
        /* keep numbers */
      }
    };
    idx?.addEventListener('change', () => void fillFields());
    void fillFields();
    const fl = this.el.querySelector<HTMLSelectElement>('select[name=facet_layer]')!;
    fl.addEventListener('change', () => void this.facetFields(fl.value));
    // picking a grid size or area layer picks that kind of split
    this.el.querySelector('select[name=grid]')?.addEventListener('change', () => this.pick('grid'));
    idx?.addEventListener('change', () => this.pick('features'));
    const show = () => {
      const v = (this.el.querySelector<HTMLInputElement>('input[name=layout]:checked')?.value ?? 'one');
      this.el.querySelectorAll<HTMLElement>('.fin-opt').forEach((o) => (o.hidden = !o.dataset.for!.split(' ').includes(v)));
      const hint = this.el.querySelector<HTMLElement>('.fin-hint')!;
      hint.textContent = {
        one: '',
        side: 'Like R patchwork: one page, each layer in its own tagged panel, same area, each with its legend.',
        facet: 'Like ggplot2 facet_wrap: one panel per value of the field, same area and classes, one shared legend.',
        panels: 'Like R patchwork: several areas on one page, each showing exactly its area, tagged (a), (b)…',
        atlas: `Like ArcGIS map series / QGIS atlas: an index page, then one page per area (up to ${MAX_PAGES}), bound into one PDF.`,
      }[v]!;
      if (v === 'facet' && this.el.querySelector<HTMLSelectElement>('select[name=facet]')!.options.length <= 1) void this.firstFacetLayer(fl, layers);
    };
    this.el.querySelectorAll('input[name=layout]').forEach((r) => r.addEventListener('change', show));
    // legend order: drag a row, or ▲▼
    const list = this.el.querySelector<HTMLElement>('.lg-list');
    let dragged: HTMLElement | null = null;
    list?.addEventListener('dragstart', (e) => (dragged = (e.target as HTMLElement).closest('.lg-row')));
    list?.addEventListener('dragover', (e) => {
      const over = (e.target as HTMLElement).closest<HTMLElement>('.lg-row');
      if (!dragged || !over || over === dragged) return;
      e.preventDefault();
      const after = e.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2;
      over.parentElement!.insertBefore(dragged, after ? over.nextSibling : over);
    });
    list?.addEventListener('dragend', () => {
      dragged = null;
      this.schedulePreview(form);
    });
    list?.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-lg]');
      const row = b?.closest<HTMLElement>('.lg-row');
      if (!b || !row) return;
      if (b.dataset.lg === 'up' && row.previousElementSibling) row.parentElement!.insertBefore(row, row.previousElementSibling);
      if (b.dataset.lg === 'down' && row.nextElementSibling) row.parentElement!.insertBefore(row.nextElementSibling, row);
      this.schedulePreview(form);
    });
    // the preview follows every change
    const form = this.el.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('change', () => this.schedulePreview(form));
    form.addEventListener('input', (e) => {
      if ((e.target as HTMLElement).matches('input[type=text], input:not([type]), input[name=title]')) this.schedulePreview(form, 900);
    });
    void this.preview(form);
    // a look fills in the furniture fields
    this.el.querySelectorAll<HTMLInputElement>('input[name=look]').forEach((r) =>
      r.addEventListener('change', () => {
        for (const [k, v] of Object.entries(LOOKS[r.value].set)) {
          const f = this.el.querySelector<HTMLSelectElement | HTMLInputElement>(`[name=${k}]`);
          if (f) f.value = v;
        }
      }),
    );
    show();
  }

  /** Start on the first visible layer (top first) that has a field worth splitting by. */
  private async firstFacetLayer(sel: HTMLSelectElement, layers: string[]) {
    for (const id of [sel.value, ...layers.filter((x) => x !== sel.value)]) {
      sel.value = id;
      if (await this.facetFields(id)) return;
    }
  }

  /** Fields worth splitting by: 2 to 12 different values (ggplot2 facets of a categorical variable). */
  private async facetFields(layer: string): Promise<boolean> {
    const sel = this.el.querySelector<HTMLSelectElement>('select[name=facet]');
    if (!sel) return false;
    sel.innerHTML = '<option value="">checking fields…</option>';
    const r = await this.host.backend.json<{ layers: { id: string; fields: { name: string; kind: string }[] }[] }>('api/layers');
    const fields = r.layers.find((l) => l.id === layer)?.fields ?? [];
    const good: [string, number][] = [];
    // text fields first: they are usually the categories (kind, land use, month name)
    for (const f of [...fields].sort((a, b) => Number(a.kind !== 'string') - Number(b.kind !== 'string'))) {
      if (f.kind === 'real' || /^(id|fid|ogc_fid|objectid)$/i.test(f.name)) continue;
      try {
        const u = await this.host.backend.json<{ distinct: number }>(`api/layers/${encodeURIComponent(layer)}/unique?field=${encodeURIComponent(f.name)}&limit=13`);
        if (u.distinct >= 2 && u.distinct <= 12) good.push([f.name, u.distinct]);
      } catch {
        /* skip */
      }
      if (good.length >= 6) break;
    }
    sel.innerHTML = good.length
      ? good.map(([n, k]) => `<option value="${esc(n)}">${esc(n)} (${k} panels)</option>`).join('')
      : '<option value="">no field with 2–12 values</option>';
    return good.length > 0;
  }

  private pick(v: string) {
    const r = this.el.querySelector<HTMLInputElement>(`input[name=split][value=${v}]`);
    if (r) r.checked = true;
  }

  /** The areas of a series or of panels, or null for one map. */
  private async pages(f: FormData, area: Bbox | null): Promise<Page[] | null> {
    const layout = f.get('layout') ?? 'one';
    if (layout !== 'atlas' && layout !== 'panels') return null;
    const kind = f.get('split') ?? 'grid';
    if (kind === 'grid') {
      const [c, r] = String(f.get('grid') ?? '2x2').split('x').map(Number);
      const b = area ?? (await this.dataBounds());
      return gridPages(b, c, r);
    }
    if (kind !== 'features') return null;
    const id = String(f.get('index'));
    const field = String(f.get('field') ?? '');
    const r = await this.host.backend.json<{ total: number; fields: string[]; rows: { fid: number; bbox: Bbox | null; values: unknown[] }[] }>(
      `api/layers/${encodeURIComponent(id)}/rows?limit=${MAX_PAGES}`,
    );
    if (r.total > MAX_PAGES) throw new Error(`${id} has ${r.total.toLocaleString()} features: a series is at most ${MAX_PAGES} pages. Pick a smaller layer or a grid.`);
    const fi = r.fields.indexOf(field);
    return r.rows
      .filter((row) => row.bbox)
      .map((row, i) => ({ label: fi >= 0 && row.values[fi] != null && row.values[fi] !== '' ? String(row.values[fi]) : `Page ${i + 1}`, extent: padBox(row.bbox!) }));
  }

  /** all visible layers' bounds, for a grid over "all of the data" */
  private async dataBounds(): Promise<Bbox> {
    const r = await this.host.backend.json<{ layers: { id: string; bounds: Bbox }[] }>('api/layers');
    const ids = new Set(this.host.visible().map((l) => l.id));
    const bs = r.layers.filter((l) => ids.has(l.id) && l.bounds).map((l) => l.bounds);
    if (!bs.length) return this.host.view();
    return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
  }

  close() {
    this.el.hidden = true;
    // the layout window follows the choices made here (title, layout, furniture)
    this.mapChanged();
  }

  /** The map page in a window of its own (a second monitor, full screen), redrawn live as the map changes. */
  async openLayout() {
    if (!this.host.visible().length) return this.host.setStatus('Switch on at least one layer first: the layout shows what is on the map', 5000);
    const url = 'layout.html';
    if ('__TAURI_INTERNALS__' in window) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const open = await WebviewWindow.getByLabel('layout');
        if (open) {
          await open.setFocus();
          return void this.sendSpec();
        }
        new WebviewWindow('layout', { url, title: 'GeoSpaX Layout', width: 1400, height: 950 });
        return;
      } catch {
        /* fall through to a browser window */
      }
    }
    if (!window.open(url, 'geospax-layout')) this.host.setStatus('The browser blocked the layout window: allow pop-ups for GeoSpaX', 8000);
  }

  /** The map, a layer or a style changed: a live layout window redraws (after a short pause). */
  mapChanged() {
    if (!this.layoutOpen) return;
    clearTimeout(this.specTimer);
    this.specTimer = window.setTimeout(() => void this.sendSpec(), 700);
  }

  /** A finished-map run ended: the layout window shows its files. */
  runFinished(ok: boolean, error?: string) {
    this.chan?.postMessage({ type: 'finished', ok, error } satisfies LayoutMsg);
  }

  /** What the layout window draws: the Finish my map choices when the dialog has been used, else one map of the view. */
  private async spec(): Promise<LayoutSpec | null> {
    const layers = this.host.visible();
    if (!layers.length) return null;
    const styles = Object.fromEntries(layers.map((l) => [l.id, l.style]));
    const form = this.el.querySelector<HTMLFormElement>('form');
    if (form) {
      const plan = await this.plan(form);
      if (typeof plan !== 'string') return { styles, map: plan.steps[0].with, title: plan.title };
    }
    const v = this.host.view();
    const extent = [Math.max(v[0], -180), Math.max(v[1], -85), Math.min(v[2], 180), Math.min(v[3], 85)].map((x) => Math.round(x * 1e5) / 1e5);
    const title = this.host.suggestTitle();
    return { styles, title, map: { layers: layers.map((l) => l.id), title, subtitle: new Date().toLocaleDateString(), size: pageSize('auto'), extent, name: 'layout' } };
  }

  private async sendSpec() {
    const spec = await this.spec();
    if (spec) this.chan?.postMessage({ type: 'spec', spec } satisfies LayoutMsg);
  }

  /** "Make final files" from the layout window: the same as pressing Make in Finish my map. */
  private async makeFinal() {
    const form = this.el.querySelector<HTMLFormElement>('form');
    if (form) return this.make(form);
    // never opened: open it so the title and formats can be chosen
    this.open();
  }

  /** What Finish my map will make, from the form: the export steps and their parameters. */
  private async plan(form: HTMLFormElement): Promise<Plan | string> {
    const f = new FormData(form);
    const layers = this.host.visible();
    const title = String(f.get('title') || 'My map').trim();
    const subtitle = String(f.get('subtitle') ?? new Date().toLocaleDateString());
    // lazy mode hides the options: their defaults are the checked boxes above
    const has = (k: string) => (form.querySelector(`[name=${k}]`) ? f.get(k) === 'on' : true);
    const formats = ['png', 'pdf', 'svg'].filter(has);
    if (!formats.length) formats.push('png');
    const area = f.get('area') ?? 'view';
    const view = round(this.host.view());
    const clipped: Bbox = [Math.max(view[0], -180), Math.max(view[1], -85), Math.min(view[2], 180), Math.min(view[3], 85)];
    const ids = layers.map((l) => l.id);
    const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'map';
    let pages: Page[] | null;
    try {
      pages = await this.pages(f, area === 'view' ? clipped : null);
    } catch (err) {
      return String((err as Error).message ?? err);
    }
    if (pages && !pages.length) return 'No pages: that layer has no features with a location';
    const base = { layers: ids, title, size: pageSize(String(f.get('size') ?? 'auto')), format: formats, ...furniture(f, form) };
    // one export.map step per page; the first keeps the id "map" so the report shows it
    const mapStep = (id: string, extent: unknown, sub: string, file: string, extra: Record<string, unknown> = {}): MapStepDef => ({
      id,
      use: 'export.map',
      needs: ['open', 'style'],
      with: { ...base, subtitle: sub, extent, name: file, ...extra },
    });
    const layout = String(f.get('layout') ?? 'one');
    const panelOpts = { ...(f.get('ncol') ? { ncol: Number(f.get('ncol')) } : {}), legends: String(f.get('legends') ?? 'auto'), tags: String(f.get('tags') ?? 'a') };
    const ext = area === 'view' ? clipped : 'auto';
    const report = has('report');
    if (layout === 'facet' && !f.get('facet')) return 'Pick a field to split by';
    if (layout === 'side' || layout === 'facet' || layout === 'panels') {
      const extra =
        layout === 'side'
          ? { panels: [...ids].reverse().map((id) => ({ title: id.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '), layers: [id] })), ...panelOpts }
          : layout === 'facet'
            ? { facet: String(f.get('facet')), facet_layer: String(f.get('facet_layer')), ...panelOpts }
            : { panels: pages!.map((p) => ({ extent: round(p.extent), title: p.label })), ...panelOpts };
      return { title, formats, report, steps: [mapStep('map', ext, subtitle, name, extra)], outputs: ['map'], what: `a ${layout === 'facet' ? 'faceted' : 'multi-panel'} page` };
    }
    if (!pages) return { title, formats, report, steps: [mapStep('map', ext, subtitle, name)], outputs: ['map'], what: 'one map' };
    // a series opens with an index page (every sheet outlined and labelled) and ends bound into one PDF
    const n = pages.length;
    const all = round(pages.reduce<Bbox>((a, p) => [Math.min(a[0], p.extent[0]), Math.min(a[1], p.extent[1]), Math.max(a[2], p.extent[2]), Math.max(a[3], p.extent[3])], pages[0].extent));
    const steps = [
      mapStep('map', all, `Index of ${n} pages · ${subtitle}`, `${name}-00-index`, { frames: pages.map((p) => ({ extent: round(p.extent), label: p.label })) }),
      ...pages.map((p, i) => mapStep(`page${i + 1}`, round(p.extent), `${p.label} · page ${i + 1} of ${n} · ${subtitle}`, `${name}-${String(i + 1).padStart(2, '0')}`, { exact: true })),
    ];
    const ids2 = steps.map((x) => x.id);
    steps.push({ id: 'series', use: 'export.series', needs: ids2, with: { name: `${name}-series` } });
    return { title, formats, report, steps, outputs: [...ids2, 'series'], what: `a ${n}-page map series`, pages: n };
  }

  private async make(form: HTMLFormElement) {
    const msg = this.el.querySelector<HTMLElement>('#finish-msg');
    const plan = await this.plan(form);
    if (typeof plan === 'string') {
      if (msg) msg.textContent = plan;
      return;
    }
    const layers = this.host.visible();
    const ids = layers.map((l) => l.id);
    const styles = Object.fromEntries(layers.map((l) => [l.id, l.style]));
    const { title, formats, report, what } = plan;
    // JSON is valid YAML: values are written as JSON so titles with ':' or quotes stay intact
    const step = (s: MapStepDef) => [`  - id: ${s.id}`, `    use: ${s.use}`, `    needs: [${s.needs.join(', ')}]`, `    with: ${JSON.stringify(s.with)}`];
    const yaml = [
      `# Made by "Finish my map" on ${new Date().toLocaleString()}; replaced the next time you finish a map.`,
      `recipe: ${FINISH_RECIPE}`,
      'version: 1',
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(`${layers.length} layer(s) as styled on the map, laid out as ${what} (${formats.join(', ').toUpperCase()})${report ? ' with a report' : ''}.`)}`,
      'steps:',
      '  - id: open',
      '    use: io.open',
      `    with: { layers: ${JSON.stringify(ids)} }`,
      '  - id: style',
      '    use: style.apply',
      `    with: { styles: ${JSON.stringify(styles)}, save: false }`,
      ...plan.steps.flatMap(step),
      ...(report ? ['  - id: report', '    use: export.report', `    needs: [${plan.outputs.join(', ')}]`, `    with: { title: ${JSON.stringify(title)} }`] : []),
      `outputs: [${[...plan.outputs, ...(report ? ['report'] : [])].join(', ')}]`,
      '',
    ].join('\n');
    try {
      if (msg) msg.textContent = 'Laying out…';
      await this.host.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      this.close();
      this.host.setStatus(`Finishing “${title}”${plan.pages ? ` (${plan.pages} pages)` : ''}: ${what}, legend, scale bar, ${formats.join(' + ').toUpperCase()}${report ? ' and the report' : ''}…`, 15000);
      await this.host.run(FINISH_RECIPE);
    } catch (err) {
      if (msg) msg.textContent = String((err as Error).message ?? err);
    }
  }

  private schedulePreview(form: HTMLFormElement, ms = 350) {
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => void this.preview(form), ms);
  }

  /** Redraw the preview: the first page as it will be made, small and quick. Newer requests win. */
  private async preview(form: HTMLFormElement) {
    const box = this.el.querySelector<HTMLElement>('.fin-preview');
    if (!box) return;
    const seq = ++this.previewSeq;
    box.classList.add('busy');
    const plan = await this.plan(form);
    if (seq !== this.previewSeq) return;
    if (typeof plan === 'string') {
      box.classList.remove('busy');
      box.querySelector('figcaption')!.textContent = plan;
      return;
    }
    const first = plan.steps[0];
    const styles = Object.fromEntries(this.host.visible().map((l) => [l.id, l.style]));
    try {
      const r = await fetch(this.host.backend.url('api/preview/map'), { method: 'POST', body: JSON.stringify({ styles, map: first.with, dpi: 48 }), headers: { 'content-type': 'application/json' } });
      if (seq !== this.previewSeq) return;
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
      const url = URL.createObjectURL(await r.blob());
      const img = box.querySelector('img')!;
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      img.src = url;
      box.querySelector('figcaption')!.textContent = plan.pages ? `Index page of ${plan.pages} (preview)` : 'Preview';
    } catch (err) {
      box.querySelector('figcaption')!.textContent = `No preview: ${String((err as Error).message ?? err)}`;
    } finally {
      if (seq === this.previewSeq) box.classList.remove('busy');
    }
  }
}
