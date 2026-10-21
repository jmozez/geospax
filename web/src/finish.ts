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

/** The furniture fields as export.map parameters (", key: value" …); legend edits from the table. */
function furniture(f: FormData, form: HTMLFormElement): string {
  const out: string[] = [];
  for (const k of ['dpi', 'legend', 'legend_at', 'legend_title', 'scale_bar', 'units', 'scale_bar_at', 'north_arrow', 'north_arrow_at', 'inset']) {
    const v = f.get(k);
    if (v == null) continue;
    out.push(`${k}: ${k === 'dpi' ? Number(v) : JSON.stringify(String(v))}`);
  }
  const edit: Record<string, { title?: string; hide?: boolean; labels?: Record<string, string> }> = {};
  form.querySelectorAll<HTMLTableRowElement>('tr[data-layer]').forEach((tr) => {
    const id = tr.dataset.layer!;
    const e: { title?: string; hide?: boolean; labels?: Record<string, string> } = {};
    if (!tr.querySelector<HTMLInputElement>('[name=lg-show]')!.checked) e.hide = true;
    const t = tr.querySelector<HTMLInputElement>('[name=lg-title]')!.value.trim();
    if (t) e.title = t;
    const pairs = tr.querySelector<HTMLInputElement>('[name=lg-labels]')!.value.split(';').map((x) => x.split('=').map((y) => y.trim()));
    const labels = Object.fromEntries(pairs.filter((p) => p.length === 2 && p[0] && p[1]));
    if (Object.keys(labels).length) e.labels = labels;
    if (Object.keys(e).length) edit[id] = e;
  });
  if (Object.keys(edit).length) out.push(`legend_edit: ${JSON.stringify(edit)}`);
  return out.length ? `, ${out.join(', ')}` : '';
}

export class FinishMap {
  private el: HTMLElement;

  constructor(private host: FinishHost) {
    this.el = document.createElement('div');
    this.el.id = 'finish';
    this.el.className = 'modal';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
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
    const legendRows = layers
      .map(
        (id) => `<tr data-layer="${esc(id)}"><td><input type="checkbox" name="lg-show" checked aria-label="Show ${esc(id)} in the legend" /></td>
          <td><input name="lg-title" placeholder="${esc(id.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '))}" aria-label="Legend title for ${esc(id)}" /></td>
          <td><input name="lg-labels" placeholder="old = new; …" aria-label="Rename classes of ${esc(id)}" /></td></tr>`,
      )
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
          <table><thead><tr><th>Show</th><th>Title</th><th>Rename classes</th></tr></thead><tbody>${legendRows}</tbody></table>
          <small class="dim">Rename classes as <code>old = new</code>, separated by <code>;</code> (e.g. <code>0.2 – 15 = ≤ 15</code>). The legend lists layers top first, as on the map.</small>
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
        <label class="ck"><input type="checkbox" name="svg" /> Editable (SVG)</label>
        <label class="ck"><input type="checkbox" name="report" checked /> One-page report</label></fieldset>`;
    this.el.innerHTML = `<form class="sheet fin">
      <header><b>Finish my map</b><button type="button" data-close aria-label="Close">✕</button></header>
      <div class="body">
        <p class="fin-lead">The ${this.host.visible().length} layer${this.host.visible().length > 1 ? 's' : ''} on the map, styled as you see them, laid out with a legend, scale bar, north arrow and credits.</p>
        <label><span>Title</span><input name="title" value="${esc(this.host.suggestTitle())}" required /></label>
        ${layout}
        ${styleBox}
        ${lazy ? `<details><summary>More options</summary>${more}</details>` : more}
      </div>
      <footer><span class="dim" id="finish-msg"></span><button type="button" data-close>Cancel</button><button class="primary" type="submit">Make the map</button></footer>
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
  }

  private async make(form: HTMLFormElement) {
    const f = new FormData(form);
    const layers = this.host.visible();
    const title = String(f.get('title') || 'My map').trim();
    const subtitle = String(f.get('subtitle') ?? new Date().toLocaleDateString());
    // lazy mode hides the options: their defaults are the checked boxes above
    const has = (k: string) => (form.querySelector(`[name=${k}]`) ? f.get(k) === 'on' : k !== 'svg');
    const formats = ['png', 'pdf', 'svg'].filter(has);
    if (!formats.length) formats.push('png');
    const area = f.get('area') ?? 'view';
    const view = round(this.host.view());
    const clipped: Bbox = [Math.max(view[0], -180), Math.max(view[1], -85), Math.min(view[2], 180), Math.min(view[3], 85)];
    const ids = layers.map((l) => l.id);
    const styles = Object.fromEntries(layers.map((l) => [l.id, l.style]));
    const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'map';
    const msg = this.el.querySelector<HTMLElement>('#finish-msg');
    let pages: Page[] | null;
    try {
      pages = await this.pages(f, area === 'view' ? clipped : null);
    } catch (err) {
      if (msg) msg.textContent = String((err as Error).message ?? err);
      return;
    }
    if (pages && !pages.length) {
      if (msg) msg.textContent = 'No pages: that layer has no features with a location';
      return;
    }
    const furn = furniture(f, form);
    // one export.map step per page; the first keeps the id "map" so the report shows it
    const mapStep = (id: string, extent: string, sub: string, file: string) => [
      `  - id: ${id}`,
      '    use: export.map',
      '    needs: [open, style]',
      `    with: { layers: ${JSON.stringify(ids)}, title: ${JSON.stringify(title)}, subtitle: ${JSON.stringify(sub)}, size: ${JSON.stringify(pageSize(String(f.get('size') ?? 'auto')))}, format: ${JSON.stringify(formats)}, extent: ${extent}, name: ${JSON.stringify(file)}${furn} }`,
    ];
    const layout = String(f.get('layout') ?? 'one');
    const panelOpts = () =>
      [
        f.get('ncol') ? `ncol: ${Number(f.get('ncol'))}` : '',
        `legends: ${JSON.stringify(String(f.get('legends') ?? 'auto'))}`,
        `tags: ${JSON.stringify(String(f.get('tags') ?? 'a'))}`,
      ]
        .filter(Boolean)
        .join(', ');
    const onePage = (extra: string, ext: string) => mapStep('map', ext, subtitle, name).map((l, i, a) => (i === a.length - 1 ? l.replace(/ }$/, `, ${extra} }`) : l));
    const ext = area === 'view' ? JSON.stringify(clipped) : 'auto';
    if (layout === 'facet' && !f.get('facet')) {
      if (msg) msg.textContent = 'Pick a field to split by';
      return;
    }
    if (layout === 'side' || layout === 'facet' || layout === 'panels') {
      const extra =
        layout === 'side'
          ? `panels: ${JSON.stringify([...ids].reverse().map((id) => ({ title: id.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '), layers: [id] })))}, ${panelOpts()}`
          : layout === 'facet'
            ? `facet: ${JSON.stringify(String(f.get('facet')))}, facet_layer: ${JSON.stringify(String(f.get('facet_layer')))}, ${panelOpts()}`
            : `panels: ${JSON.stringify(pages!.map((p) => ({ extent: round(p.extent), title: p.label })))}, ${panelOpts()}`;
      return this.submit(form, f, title, layers, formats, has, onePage(extra, ext), ['map'], `a ${layout === 'facet' ? 'faceted' : 'multi-panel'} page`);
    }
    const n = pages?.length ?? 1;
    // a series opens with an index page (every sheet outlined and labelled) and ends bound into one PDF
    const stepIds = pages ? ['map', ...pages.map((_, i) => `page${i + 1}`)] : ['map'];
    const frames = pages ? JSON.stringify(pages.map((p) => ({ extent: round(p.extent), label: p.label }))) : '';
    const all = pages ? round(pages.reduce<Bbox>((a, p) => [Math.min(a[0], p.extent[0]), Math.min(a[1], p.extent[1]), Math.max(a[2], p.extent[2]), Math.max(a[3], p.extent[3])], pages[0].extent)) : null;
    const maps = pages
      ? [
          ...mapStep('map', JSON.stringify(all), `Index of ${n} pages · ${subtitle}`, `${name}-00-index`).map((l, i, a) => (i === a.length - 1 ? l.replace(/ }$/, `, frames: ${frames} }`) : l)),
          ...pages.flatMap((p, i) => mapStep(stepIds[i + 1], JSON.stringify(round(p.extent)), `${p.label} · page ${i + 1} of ${n} · ${subtitle}`, `${name}-${String(i + 1).padStart(2, '0')}`).map((l, k, a) => (k === a.length - 1 ? l.replace(/ }$/, ', exact: true }') : l))),
          '  - id: series',
          '    use: export.series',
          `    needs: [${stepIds.join(', ')}]`,
          `    with: { name: ${JSON.stringify(`${name}-series`)} }`,
        ]
      : mapStep('map', area === 'view' ? JSON.stringify(clipped) : 'auto', subtitle, name);
    if (pages) stepIds.push('series');
    return this.submit(form, f, title, layers, formats, has, maps, stepIds, pages ? `a ${n}-page map series` : 'one map', pages?.length);
  }

  private async submit(
    _form: HTMLFormElement,
    _f: FormData,
    title: string,
    layers: { id: string; style: LayerStyle }[],
    formats: string[],
    has: (k: string) => boolean,
    maps: string[],
    stepIds: string[],
    what: string,
    nPages?: number,
  ) {
    const msg = this.el.querySelector<HTMLElement>('#finish-msg');
    const ids = layers.map((l) => l.id);
    const styles = Object.fromEntries(layers.map((l) => [l.id, l.style]));
    // JSON is valid YAML: values are written as JSON so titles with ':' or quotes stay intact
    const yaml = [
      `# Made by "Finish my map" on ${new Date().toLocaleString()}; replaced the next time you finish a map.`,
      `recipe: ${FINISH_RECIPE}`,
      'version: 1',
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(`${layers.length} layer(s) as styled on the map, laid out as ${what} (${formats.join(', ').toUpperCase()})${has('report') ? ' with a report' : ''}.`)}`,
      'steps:',
      '  - id: open',
      '    use: io.open',
      `    with: { layers: ${JSON.stringify(ids)} }`,
      '  - id: style',
      '    use: style.apply',
      `    with: { styles: ${JSON.stringify(styles)}, save: false }`,
      ...maps,
      ...(has('report') ? ['  - id: report', '    use: export.report', `    needs: [${stepIds.join(', ')}]`, `    with: { title: ${JSON.stringify(title)} }`] : []),
      `outputs: [${[...stepIds, ...(has('report') ? ['report'] : [])].join(', ')}]`,
      '',
    ].join('\n');
    try {
      if (msg) msg.textContent = 'Laying out…';
      await this.host.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      this.close();
      this.host.setStatus(`Finishing “${title}”${nPages ? ` (${nPages} pages)` : ''}: ${what}, legend, scale bar, ${formats.join(' + ').toUpperCase()}${has('report') ? ' and the report' : ''}…`, 15000);
      await this.host.run(FINISH_RECIPE);
    } catch (err) {
      if (msg) msg.textContent = String((err as Error).message ?? err);
    }
  }
}
