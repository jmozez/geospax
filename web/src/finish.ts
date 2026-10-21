// Finish my map: the visible layers, their exact styles and (by default) the area on screen become a
// laid-out map (title, legend, scale bar, north arrow, credits) as PNG, PDF and SVG plus a one-page
// report, in one click. It is an ordinary recipe ("finished-map", replaced each time) so the result
// has run history, provenance and can be re-run or put on a trigger like any other.
// A map series (atlas, ArcGIS Pro's "map series", QGIS's atlas) is the same map once per page: a grid
// over the area, or one page per feature of a layer (each district, each site), titled by a field.
// It opens with an index page (every sheet outlined) and is also bound into one multi-page PDF.
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
    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const more = `
      <label><span>Subtitle</span><input name="subtitle" value="${esc(today)}" /></label>
      <fieldset><legend>Area</legend>
        <label class="ck"><input type="radio" name="area" value="view" checked /> What you see now</label>
        <label class="ck"><input type="radio" name="area" value="auto" /> All of the data</label></fieldset>
      <label><span>Page</span><select name="size">
        <option value="auto">Automatic (fits the area)</option><option value="a4">A4 landscape</option><option value="a4-portrait">A4 portrait</option>
        <option value="a3">A3 landscape</option><option value="letter">US Letter</option></select></label>
      <fieldset class="fin-series"><legend>Pages</legend>
        <label class="ck"><input type="radio" name="pages" value="one" checked /> One map</label>
        <label class="ck"><input type="radio" name="pages" value="grid" /> A grid of pages over the area
          <select name="grid" aria-label="Grid"><option value="2x1">2 × 1</option><option value="2x2" selected>2 × 2</option><option value="3x2">3 × 2</option><option value="3x3">3 × 3</option><option value="4x4">4 × 4</option></select></label>
        ${
          index.length
            ? `<label class="ck"><input type="radio" name="pages" value="features" /> One page per feature of
          <select name="index" aria-label="Page layer">${index.map((id) => `<option>${esc(id)}</option>`).join('')}</select></label>
          <label class="fin-field"><span>Page title from field</span><select name="field" aria-label="Page title field"><option value="">(page number)</option></select></label>`
            : ''
        }
        <small class="dim">A map series (atlas): an index page, then the same layout once per page (up to ${MAX_PAGES}), also bound into one PDF.</small></fieldset>
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
        sel.innerHTML = `<option value="">(page number)</option>${r.fields.map((f) => `<option ${f === good ? 'selected' : ''}>${esc(f)}</option>`).join('')}`;
      } catch {
        /* keep page numbers */
      }
    };
    idx?.addEventListener('change', () => void fillFields());
    void fillFields();
    // picking a grid size or page layer picks that kind of series
    this.el.querySelector('select[name=grid]')?.addEventListener('change', () => this.pick('grid'));
    idx?.addEventListener('change', () => this.pick('features'));
  }

  private pick(v: string) {
    const r = this.el.querySelector<HTMLInputElement>(`input[name=pages][value=${v}]`);
    if (r) r.checked = true;
  }

  /** The pages of the series, or null for one map. */
  private async pages(f: FormData, area: Bbox | null): Promise<Page[] | null> {
    const kind = f.get('pages') ?? 'one';
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
    // one export.map step per page; the first keeps the id "map" so the report shows it
    const mapStep = (id: string, extent: string, sub: string, file: string) => [
      `  - id: ${id}`,
      '    use: export.map',
      '    needs: [open, style]',
      `    with: { layers: ${JSON.stringify(ids)}, title: ${JSON.stringify(title)}, subtitle: ${JSON.stringify(sub)}, size: ${JSON.stringify(String(f.get('size') ?? 'auto'))}, format: ${JSON.stringify(formats)}, extent: ${extent}, name: ${JSON.stringify(file)} }`,
    ];
    const n = pages?.length ?? 1;
    // a series opens with an index page (every sheet outlined and labelled) and ends bound into one PDF
    const stepIds = pages ? ['map', ...pages.map((_, i) => `page${i + 1}`)] : ['map'];
    const frames = pages ? JSON.stringify(pages.map((p) => ({ extent: round(p.extent), label: p.label }))) : '';
    const all = pages ? round(pages.reduce<Bbox>((a, p) => [Math.min(a[0], p.extent[0]), Math.min(a[1], p.extent[1]), Math.max(a[2], p.extent[2]), Math.max(a[3], p.extent[3])], pages[0].extent)) : null;
    const maps = pages
      ? [
          ...mapStep('map', JSON.stringify(all), `Index of ${n} pages · ${subtitle}`, `${name}-00-index`).map((l, i, a) => (i === a.length - 1 ? l.replace(/ }$/, `, frames: ${frames} }`) : l)),
          ...pages.flatMap((p, i) => mapStep(stepIds[i + 1], JSON.stringify(round(p.extent)), `${p.label} · page ${i + 1} of ${n} · ${subtitle}`, `${name}-${String(i + 1).padStart(2, '0')}`)),
          '  - id: series',
          '    use: export.series',
          `    needs: [${stepIds.join(', ')}]`,
          `    with: { name: ${JSON.stringify(`${name}-series`)} }`,
        ]
      : mapStep('map', area === 'view' ? JSON.stringify(clipped) : 'auto', subtitle, name);
    if (pages) stepIds.push('series');
    const what = pages ? `a ${n}-page map series` : 'one map';
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
      this.host.setStatus(`Finishing “${title}”${pages ? ` (${pages.length} pages)` : ''}: map, legend, scale bar, ${formats.join(' + ').toUpperCase()}${has('report') ? ' and the report' : ''}…`, 15000);
      await this.host.run(FINISH_RECIPE);
    } catch (err) {
      if (msg) msg.textContent = String((err as Error).message ?? err);
    }
  }
}
