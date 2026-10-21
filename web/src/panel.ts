// Layer properties pane (ArcGIS Pro's "Symbology" pane, docked right):
// single symbol / unique values / graduated colours, appearance, and the
// overview-pyramid job for dense layers.
import type { Backend, LayerInfo, Job } from './backend';
import {
  RAMPS,
  fmtNum,
  graduatedFrom,
  rampColors,
  rampGradient,
  uniqueFrom,
  type ClassifyResponse,
  type LayerStyle,
  type Method,
  type Symbology,
  type UniqueResponse,
} from './symbology';

export interface PanelHost {
  backend: Backend;
  layer(id: string): LayerInfo | undefined;
  style(id: string): LayerStyle;
  setStyle(id: string, s: LayerStyle): void;
  job(id: string): Job | undefined;
  buildOverviews(id: string): Promise<void>;
  cancelJob(jobId: number): Promise<void>;
  deleteOverviews(id: string): Promise<void>;
  /** AutoMap: let the engine choose the style (and say why) */
  autostyle(id: string): Promise<void>;
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');
const METHODS: [Method, string][] = [
  ['jenks', 'Natural breaks (Jenks)'],
  ['quantile', 'Quantile'],
  ['equal', 'Equal interval'],
  ['guideline', 'WHO guideline (PM2.5, PM10)'],
];

export class SymbologyPanel {
  current: string | null = null;
  private busy = '';
  private error = '';
  private stats = '';

  constructor(
    private root: HTMLElement,
    private host: PanelHost,
  ) {
    root.addEventListener('click', (e) => void this.onClick(e));
    root.addEventListener('change', (e) => void this.onChange(e));
    root.addEventListener('input', (e) => this.onInput(e));
  }

  open(id: string) {
    if (this.current !== id) {
      this.error = '';
      this.stats = '';
    }
    this.current = id;
    this.root.hidden = false;
    document.body.classList.add('panel-open');
    this.render();
  }

  close() {
    this.current = null;
    this.root.hidden = true;
    document.body.classList.remove('panel-open');
  }

  refresh() {
    if (this.current) this.render();
  }

  private get layer() {
    return this.current ? this.host.layer(this.current) : undefined;
  }

  private numericFields(l: LayerInfo) {
    return l.fields.filter((f) => f.kind === 'integer' || f.kind === 'real');
  }

  private categoryFields(l: LayerInfo) {
    return l.fields.filter((f) => f.kind === 'string' || f.kind === 'integer');
  }

  private render() {
    const l = this.layer;
    if (!l) return this.close();
    const st = this.host.style(l.id);
    const s = st.symbology;
    const num = this.numericFields(l);
    const cat = this.categoryFields(l);
    const opt = (v: string, label: string, sel: boolean, dis = false) =>
      `<option value="${esc(v)}" ${sel ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(label)}</option>`;

    let body = '';
    if (s.kind === 'single') {
      body = `<label class="field"><span>Color</span><input type="color" data-k="single-color" value="${esc(s.color)}"></label>`;
    } else if (s.kind === 'unique') {
      body = `
        <label class="field"><span>Field</span><select data-k="field">${cat.map((f) => opt(f.name, f.name, f.name === s.field)).join('')}</select></label>
        <label class="field"><span>Color scheme</span><select data-k="ramp">${RAMPS.map((r) => opt(r.id, r.name, r.id === s.ramp)).join('')}</select></label>
        <div class="ramp" style="background:${rampGradient(s.ramp)}"></div>
        <table class="classes">
          <tr><th></th><th>Value</th><th>Count</th></tr>
          ${s.classes
            .map(
              (c, i) => `<tr><td><input type="color" data-k="class-color" data-i="${i}" value="${esc(c.color)}"></td>
              <td>${esc(c.value)}</td><td>${fmt(c.count)}</td></tr>`,
            )
            .join('')}
          ${s.othersCount > 0 ? `<tr><td><input type="color" data-k="other-color" value="${esc(s.other)}"></td><td><i>all other values</i></td><td>${fmt(s.othersCount)}</td></tr>` : ''}
        </table>`;
    } else {
      const total = s.counts.reduce((a, b) => a + b, 0) || 1;
      const maxc = Math.max(...s.counts, 1);
      body = `
        <label class="field"><span>Field</span><select data-k="field">${num.map((f) => opt(f.name, f.name, f.name === s.field)).join('')}</select></label>
        <label class="field"><span>Method</span><select data-k="method">${METHODS.map(([m, n]) => opt(m, n, m === s.method)).join('')}</select></label>
        <label class="field"><span>Classes</span><select data-k="classes">${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => opt(String(k), String(k), k === s.breaks.length)).join('')}</select></label>
        <label class="field"><span>Color ramp</span><select data-k="ramp">${RAMPS.filter((r) => r.type !== 'categorical').map((r) => opt(r.id, r.name, r.id === s.ramp)).join('')}</select></label>
        <div class="ramp" style="background:${rampGradient(s.ramp)}"></div>
        <table class="classes">
          <tr><th></th><th>Range</th><th>Count</th><th></th></tr>
          ${s.breaks
            .map(
              (b, i) => `<tr><td><input type="color" data-k="class-color" data-i="${i}" value="${esc(s.colors[i])}"></td>
              <td>${fmtNum(i === 0 ? s.min : s.breaks[i - 1])} – ${fmtNum(b)}${s.labels?.[i] ? `<br><small>${s.labels[i]}</small>` : ''}</td><td>${fmt(s.counts[i] ?? 0)}</td>
              <td class="bar"><i style="width:${(((s.counts[i] ?? 0) / maxc) * 100).toFixed(1)}%" title="${(((s.counts[i] ?? 0) / total) * 100).toFixed(1)}%"></i></td></tr>`,
            )
            .join('')}
        </table>`;
    }

    // overview / pyramid section
    const job = this.host.job(l.id) ?? l.overview_job ?? undefined;
    let ov = '';
    if (job && (job.status === 'queued' || job.status === 'running')) {
      ov = `<div class="progress"><i style="width:${(job.progress * 100).toFixed(1)}%"></i></div>
        <p class="hint">Building z0–${l.overview_suggested ?? '?'}: ${fmt(job.done)} / ${fmt(job.total)} tiles · ${(job.elapsed_ms / 1000).toFixed(0)} s</p>
        <button data-k="cancel-job" data-job="${job.id}">Cancel</button>`;
    } else if (l.overview) {
      ov = `<p>Pyramid <b>z0–${l.overview.max_zoom}</b> · ${fmt(l.overview.tiles)} tiles · ${(l.overview.bytes / 1e6).toFixed(1)} MB.
          Live tiles from z${l.overview.max_zoom + 1} (source minzoom z${l.live_minzoom}).</p>
        ${job?.status === 'done' ? `<p class="hint">${esc(job.message)}</p>` : ''}
        <div class="row"><button data-k="build">Rebuild</button><button data-k="delete-ov">Delete</button></div>`;
    } else if (l.overview_suggested != null) {
      ov = `<p class="hint">Too dense to tile live below z${l.live_minzoom}. A background job pre-renders z0–${l.overview_suggested} into a
        PMTiles pyramid. Features under 2 px become a density heatmap.</p>
        ${job && job.status !== 'done' ? `<p class="err">Last job ${esc(job.status)}: ${esc(job.message)}</p>` : ''}
        <button data-k="build" class="primary">Build overviews (z0–${l.overview_suggested})</button>`;
    } else {
      ov = `<p class="hint">Not needed: this layer renders live at every zoom.</p>`;
    }

    this.root.innerHTML = `
      <header>
        <div><h2>Symbology</h2><b>${esc(l.id)}</b>
          <small>${esc(l.geometry)} · ${fmt(l.feature_count)} features · ${esc(l.driver)} · ${esc(l.crs)}</small></div>
        <button data-k="close" title="Close" aria-label="Close">✕</button>
      </header>
      <label class="field"><span>Primary symbology</span>
        <select data-k="kind">
          ${opt('single', 'Single symbol', s.kind === 'single')}
          ${opt('unique', 'Unique values', s.kind === 'unique', !cat.length)}
          ${opt('graduated', 'Graduated colors', s.kind === 'graduated', !num.length)}
        </select></label>
      ${
        st.auto
          ? `<p class="auto-why"><b>✨ Styled automatically</b> ${esc(st.auto)}. Change anything below to take over.</p>`
          : `<button data-k="autostyle" class="auto-btn">✨ Style automatically</button>`
      }
      ${body}
      ${this.busy ? `<p class="hint">${esc(this.busy)}</p>` : ''}
      ${this.stats ? `<p class="hint">${this.stats}</p>` : ''}
      ${this.error ? `<p class="err">${esc(this.error)}</p>` : ''}
      <h3>Appearance</h3>
      <label class="field"><span>Opacity <output>${Math.round(st.opacity * 100)}%</output></span>
        <input type="range" min="0" max="100" step="5" data-k="opacity" value="${Math.round(st.opacity * 100)}"></label>
      ${l.geometry === 'polygon' ? `<label class="check"><input type="checkbox" data-k="outline" ${st.outline ? 'checked' : ''}> Outline</label>` : ''}
      <div class="field"><span>Visible range (zoom)</span>
        <div class="row"><input type="number" min="0" max="24" data-k="minzoom" value="${st.minzoom}" aria-label="Min zoom"> to
        <input type="number" min="0" max="24" data-k="maxzoom" value="${st.maxzoom}" aria-label="Max zoom"></div></div>
      <h3>Overviews</h3>
      ${ov}`;
  }

  /** Apply a style edit. Slider drags pass rerender=false (keeps the live element). */
  private update(fn: (st: LayerStyle) => void, rerender = true) {
    const id = this.current!;
    const st = structuredClone(this.host.style(id));
    fn(st);
    this.host.setStyle(id, st);
    if (rerender) this.render();
  }

  /** The Inspector's "Colour by" chips: graduated for numbers (WHO classes for PM2.5/PM10), unique
   *  values for text; null = one colour. */
  async colourBy(id: string, field: string | null) {
    this.open(id);
    const l = this.layer;
    if (!l) return;
    if (!field) return this.update((x) => (x.symbology = { kind: 'single', color: rampColors('tableau', 1)[0] }));
    const f = l.fields.find((x) => x.name === field);
    if (f && (f.kind === 'real' || f.kind === 'integer')) {
      const pm = /^(pm2_?5|pm10)$/i.test(field);
      return this.classify({ kind: 'graduated', field, ramp: pm ? 'ylorrd' : 'viridis', method: pm ? 'guideline' : 'jenks', classes: pm ? 6 : 5 });
    }
    return this.classify({ kind: 'unique', field, ramp: 'tableau' });
  }

  /** (Re)classify with the engine and apply. */
  private async classify(next: { kind: 'unique' | 'graduated'; field: string; ramp: string; method?: Method; classes?: number }) {
    const l = this.layer!;
    this.error = '';
    this.busy = `Scanning ${fmt(l.feature_count)} values of “${next.field}”…`;
    this.render();
    const be = this.host.backend;
    const f = encodeURIComponent(next.field);
    try {
      let sym: Symbology;
      if (next.kind === 'graduated') {
        const r = await be.json<ClassifyResponse>(
          `api/layers/${l.id}/classify?field=${f}&method=${next.method ?? 'jenks'}&classes=${next.classes ?? 5}`,
        );
        sym = graduatedFrom(r, next.ramp);
        this.stats = `n=${fmt(r.count)} · min ${fmtNum(r.min)} · max ${fmtNum(r.max)} · mean ${fmtNum(r.mean)} · σ ${fmtNum(r.std)}<br>
          engine: column scan ${r.scan_ms.toFixed(0)} ms + classify ${r.classify_ms.toFixed(1)} ms`;
      } else {
        const r = await be.json<UniqueResponse>(`api/layers/${l.id}/unique?field=${f}&limit=12`);
        sym = uniqueFrom(r, next.ramp);
        this.stats = `${fmt(r.distinct)} distinct values in ${fmt(r.count)} features${r.distinct > 12 ? ' (top 12 shown)' : ''} · engine scan ${r.scan_ms.toFixed(0)} ms`;
      }
      if (this.current !== l.id) return;
      this.busy = '';
      this.update((st) => (st.symbology = sym));
    } catch (e) {
      this.busy = '';
      this.error = String((e as Error).message ?? e);
      this.render();
    }
  }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
    if (!t || t.tagName === 'SELECT' || t.tagName === 'INPUT') return;
    const id = this.current;
    if (!id) return;
    switch (t.dataset.k) {
      case 'close':
        return this.close();
      case 'build':
        this.error = '';
        try {
          await this.host.buildOverviews(id);
        } catch (err) {
          this.error = String((err as Error).message ?? err);
        }
        return this.render();
      case 'cancel-job':
        await this.host.cancelJob(Number(t.dataset.job));
        return this.render();
      case 'autostyle':
        this.busy = 'AutoMap is choosing a style…';
        this.render();
        await this.host.autostyle(id);
        this.busy = '';
        return this.render();
      case 'delete-ov':
        await this.host.deleteOverviews(id);
        return this.render();
    }
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.k === 'opacity') {
      const v = Number(t.value) / 100;
      const out = t.closest('label')?.querySelector('output');
      if (out) out.textContent = `${Math.round(v * 100)}%`;
      this.update((st) => (st.opacity = v), false);
    }
  }

  private async onChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = t.dataset.k;
    const id = this.current;
    if (!k || !id) return;
    const l = this.layer!;
    const st = this.host.style(id);
    const s = st.symbology;
    switch (k) {
      case 'kind': {
        const v = t.value as Symbology['kind'];
        if (v === 'single') {
          const color = s.kind === 'single' ? s.color : rampColors('tableau', 1)[0];
          this.stats = '';
          return this.update((x) => (x.symbology = { kind: 'single', color }));
        }
        const fields = v === 'graduated' ? this.numericFields(l) : this.categoryFields(l);
        // never an identifier: classing row numbers says nothing about the data
        const isId = (n: string) => /^(id|fid|gid|oid|objectid|ogc_fid|uuid|index)$|_id$|^id_/i.test(n);
        const useful = fields.filter((f) => !isId(f.name));
        const preferred = useful.find((f) =>
          /pm2_?5|pm10|no2|o3|value|height|elev|depth|temp|pop|area|count|rate|density|speed|ndvi|level/i.test(f.name) ||
          /kind|type|class|category|continent|landuse|status/i.test(f.name));
        const firstUseful = useful[0] ?? fields[0];
        const field = (s.kind !== 'single' && fields.some((f) => f.name === s.field) ? s.field : (preferred ?? firstUseful)?.name) ?? '';
        return this.classify(
          v === 'graduated' ? { kind: v, field, ramp: 'viridis', method: 'jenks', classes: 5 } : { kind: v, field, ramp: 'tableau' },
        );
      }
      case 'field':
      case 'ramp':
      case 'method':
      case 'classes': {
        if (s.kind === 'single') return;
        if (k === 'ramp' && s.kind === 'graduated') {
          // recolour only, keep breaks
          return this.update((x) => {
            const g = x.symbology as Extract<Symbology, { kind: 'graduated' }>;
            g.ramp = t.value;
            g.colors = rampColors(t.value, g.breaks.length);
          });
        }
        if (k === 'ramp' && s.kind === 'unique') {
          return this.update((x) => {
            const u = x.symbology as Extract<Symbology, { kind: 'unique' }>;
            u.ramp = t.value;
            const c = rampColors(t.value, u.classes.length);
            u.classes.forEach((cl, i) => (cl.color = c[i]));
          });
        }
        const field = k === 'field' ? t.value : s.field;
        if (s.kind === 'graduated') {
          return this.classify({
            kind: 'graduated',
            field,
            ramp: s.ramp,
            method: k === 'method' ? (t.value as Method) : s.method,
            classes: k === 'classes' ? Number(t.value) : s.breaks.length,
          });
        }
        return this.classify({ kind: 'unique', field, ramp: s.ramp });
      }
      case 'single-color':
        return this.update((x) => (x.symbology = { kind: 'single', color: t.value }));
      case 'class-color': {
        const i = Number(t.dataset.i);
        return this.update((x) => {
          const sy = x.symbology;
          if (sy.kind === 'unique') sy.classes[i].color = t.value;
          else if (sy.kind === 'graduated') sy.colors[i] = t.value;
        });
      }
      case 'other-color':
        return this.update((x) => {
          if (x.symbology.kind === 'unique') x.symbology.other = t.value;
        });
      case 'outline':
        return this.update((x) => (x.outline = (t as HTMLInputElement).checked));
      case 'minzoom':
      case 'maxzoom': {
        const v = Math.max(0, Math.min(24, Number(t.value) || 0));
        return this.update((x) => {
          x[k] = v;
          if (x.minzoom > x.maxzoom) [x.minzoom, x.maxzoom] = [x.maxzoom, x.minzoom];
        });
      }
    }
  }
}
