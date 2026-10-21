// Finish my map: the visible layers, their exact styles and (by default) the area on screen become a
// laid-out map (title, legend, scale bar, north arrow, credits) as PNG, PDF and SVG plus a one-page
// report, in one click. It is an ordinary recipe ("finished-map", replaced each time) so the result
// has run history, provenance and can be re-run or put on a trigger like any other.
import type { Backend } from './backend';
import type { LayerStyle } from './symbology';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const FINISH_RECIPE = 'finished-map';

export interface FinishHost {
  backend: Backend;
  mode: () => 'lazy' | 'pro';
  /** visible layers, bottom first, with their styles */
  visible: () => { id: string; style: LayerStyle }[];
  /** a good title: the main layer's friendly name */
  suggestTitle: () => string;
  /** the map's current bounds [w, s, e, n] */
  view: () => [number, number, number, number];
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
    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const more = `
      <label><span>Subtitle</span><input name="subtitle" value="${esc(today)}" /></label>
      <fieldset><legend>Area</legend>
        <label class="ck"><input type="radio" name="area" value="view" checked /> What you see now</label>
        <label class="ck"><input type="radio" name="area" value="auto" /> All of the data</label></fieldset>
      <label><span>Page</span><select name="size">
        <option value="auto">Automatic (fits the area)</option><option value="a4">A4 landscape</option><option value="a4-portrait">A4 portrait</option>
        <option value="a3">A3 landscape</option><option value="letter">US Letter</option></select></label>
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
    const [w, s, e, n] = this.host.view().map((v) => Math.round(v * 1e5) / 1e5);
    const extent = area === 'view' ? `[${Math.max(w, -180)}, ${Math.max(s, -85)}, ${Math.min(e, 180)}, ${Math.min(n, 85)}]` : 'auto';
    const ids = layers.map((l) => l.id);
    const styles = Object.fromEntries(layers.map((l) => [l.id, l.style]));
    const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'map';
    // JSON is valid YAML: values are written as JSON so titles with ':' or quotes stay intact
    const yaml = [
      `# Made by "Finish my map" on ${new Date().toLocaleString()}; replaced the next time you finish a map.`,
      `recipe: ${FINISH_RECIPE}`,
      'version: 1',
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(`${layers.length} layer(s) as styled on the map, laid out as ${formats.join(', ').toUpperCase()}${has('report') ? ' with a report' : ''}.`)}`,
      'steps:',
      '  - id: open',
      '    use: io.open',
      `    with: { layers: ${JSON.stringify(ids)} }`,
      '  - id: style',
      '    use: style.apply',
      `    with: { styles: ${JSON.stringify(styles)}, save: false }`,
      '  - id: map',
      '    use: export.map',
      '    needs: [open, style]',
      `    with: { layers: ${JSON.stringify(ids)}, title: ${JSON.stringify(title)}, subtitle: ${JSON.stringify(subtitle)}, size: ${JSON.stringify(String(f.get('size') ?? 'auto'))}, format: ${JSON.stringify(formats)}, extent: ${extent}, name: ${JSON.stringify(name)} }`,
      ...(has('report') ? ['  - id: report', '    use: export.report', '    needs: [map]', `    with: { title: ${JSON.stringify(title)} }`] : []),
      `outputs: [map${has('report') ? ', report' : ''}]`,
      '',
    ].join('\n');
    const msg = this.el.querySelector<HTMLElement>('#finish-msg');
    try {
      if (msg) msg.textContent = 'Laying out…';
      await this.host.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      this.close();
      this.host.setStatus(`Finishing “${title}”: map, legend, scale bar, ${formats.join(' + ').toUpperCase()}${has('report') ? ' and the report' : ''}…`, 15000);
      await this.host.run(FINISH_RECIPE);
    } catch (err) {
      if (msg) msg.textContent = String((err as Error).message ?? err);
    }
  }
}
