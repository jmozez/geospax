// Attribute table — the pane ArcGIS Pro and QGIS users live in. Pages of rows come from the
// engine's `POST /api/layers/{id}/table` (crates/engine/src/edit.rs): every field, sorted and
// filtered by the engine (SQL), so a million-record layer opens as fast as a map tile.
//   · click a column to sort; its ⋮ menu: sort, calculate, statistics, delete
//   · search runs over every text and number field of the whole layer, not just this page
//   · Show all / Show selected; the selection is the map's selection (web/src/editing.ts)
//   · double-click a cell to edit it (edits go to the layer's edit copy; Ctrl+Z undoes)
import type * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';
import type { Editor } from './editing';

const PAGE = 200; // rows per request
const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = encodeURIComponent;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

export interface AttrHost {
  map: maplibregl.Map;
  layers: () => LayerInfo[];
  log: (line: string) => void;
  setStatus: (text: string, ms?: number) => void;
}

type Value = string | number | null;
interface Row {
  fid: number;
  bbox: [number, number, number, number] | null;
  values: Value[];
}

interface Page {
  total: number;
  offset: number;
  fields: string[];
  kinds: string[];
  rows: Row[];
  edited?: boolean;
  filter?: string | null;
}

export class AttributesPane {
  private layerId: string | null = null;
  private page: Page | null = null;
  private view: 'table' | 'fields' | 'chart' = 'table';
  private search = '';
  private sort: { field: string; desc: boolean } | null = null;
  private onlySelected = false;
  private offset = 0;
  private loading = false;
  private error = '';
  private editor: Editor | null = null;
  private anchor: number | null = null; // shift-click range start (row index)
  private menu: string | null = null; // column whose menu is open
  private seq = 0;

  constructor(
    private root: HTMLElement,
    private backend: Backend,
    private host: AttrHost,
  ) {
    root.addEventListener('click', (e) => void this.onClick(e));
    root.addEventListener('dblclick', (e) => this.onDblClick(e));
    root.addEventListener('keydown', (e) => this.onKey(e));
    root.addEventListener('change', (e) => this.onChange(e));
    // refresh when the data or the selection changes elsewhere (map, dialogs, undo)
    document.addEventListener('geospax:edited', (e) => {
      if ((e as CustomEvent<{ layer: string }>).detail.layer === this.layerId) void this.reload();
    });
    document.addEventListener('geospax:selection', (e) => {
      const d = (e as CustomEvent<{ layer: string | null }>).detail;
      if (d.layer === null || d.layer === this.layerId) {
        if (this.onlySelected) void this.reload(true);
        else this.markSelection();
      }
    });
  }

  attachEditor(ed: Editor) {
    this.editor = ed;
  }

  private selected(): Set<number> {
    return new Set(this.layerId ? this.editor?.selected(this.layerId) ?? [] : []);
  }

  // ---------------------------------------------------------------- data

  async open(id: string) {
    if (id !== this.layerId) {
      this.layerId = id;
      this.search = '';
      this.sort = null;
      this.onlySelected = false;
      this.offset = 0;
      this.page = null;
    }
    await this.reload(true);
  }

  clear() {
    this.layerId = null;
    this.page = null;
    this.render();
  }

  private async reload(resetOffset = false) {
    if (resetOffset) this.offset = 0;
    this.error = '';
    this.loading = true;
    this.render();
    await this.fetch();
    this.loading = false;
    this.render();
  }

  /** WHERE clause for the search box: any text or number field containing the text. */
  private searchWhere(): string | undefined {
    const q = this.search.trim();
    if (!q) return undefined;
    const l = this.layer();
    // '!' escapes % and _ : a backslash would end the string early in GDAL's own SQL dialect
    const like = `'%${q.replace(/'/g, "''").replace(/[%_!]/g, '!$&')}%'`;
    const cols = (l?.fields ?? []).filter((f) => f.kind === 'string' || f.kind === 'integer' || f.kind === 'real' || f.kind === 'datetime');
    if (!cols.length) return undefined;
    return cols.map((f) => `CAST(${ident(f.name)} AS TEXT) LIKE ${like} ESCAPE '!'`).join(' OR ');
  }

  private async fetch() {
    if (!this.layerId) return;
    const seq = ++this.seq;
    const fids = this.onlySelected ? [...this.selected()] : undefined;
    try {
      const page = await this.backend.json<Page>(`api/layers/${enc(this.layerId)}/table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: this.offset, limit: PAGE, sort: this.sort?.field, desc: this.sort?.desc ?? false, where: this.searchWhere(), fids }),
      });
      if (seq === this.seq) this.page = page;
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = String((e as Error).message ?? e);
      this.host.log(`attribute table: ${this.error}`);
    }
  }

  private layer(): LayerInfo | undefined {
    return this.host.layers().find((l) => l.id === this.layerId);
  }

  // ---------------------------------------------------------------- render

  render() {
    if (!this.layerId) {
      this.root.innerHTML = `<div class="pane-empty">Pick a layer in <b>Contents</b> or <b>Explorer</b>, then open <b>Attributes</b>.</div>`;
      return;
    }
    const layer = this.layer();
    const nsel = this.selected().size;
    const total = layer?.feature_count ?? this.page?.total ?? 0;
    const head = `<div class="pane-head">
        <span class="pane-title">${esc(layer?.name ?? this.layerId)}${layer?.edited ? ' <span class="badge" title="Edits are saved to a copy; the original file is unchanged">edited</span>' : ''}</span>
        <span class="pane-sub">${total.toLocaleString()} features${nsel ? ` · <b>${nsel.toLocaleString()} selected</b>` : ''}</span>
      </div>
      ${layer?.filter ? `<div class="attr-defq" title="Definition query">Showing only: <code>${esc(layer.filter)}</code> <button data-act="defq">Change</button></div>` : ''}
      <div class="seg">
        ${(['table', 'fields', 'chart'] as const)
          .map((v) => `<button class="${this.view === v ? 'on' : ''}" data-view="${v}">${v[0].toUpperCase()}${v.slice(1)}</button>`)
          .join('')}
      </div>`;
    if (this.error && !this.page) {
      this.root.innerHTML = `${head}<div class="pane-empty err">${esc(this.error)}</div>`;
      return;
    }
    if (this.loading && !this.page) {
      this.root.innerHTML = `${head}<div class="pane-empty">Reading ${esc(this.layerId)}…</div>`;
      return;
    }
    const scroll = this.root.querySelector('.attr-wrap')?.scrollLeft ?? 0;
    this.root.innerHTML = head + (this.view === 'table' ? this.tableHtml() : this.view === 'fields' ? this.fieldsHtml() : this.chartHtml());
    const wrap = this.root.querySelector('.attr-wrap');
    if (wrap) wrap.scrollLeft = scroll;
  }

  private tableHtml(): string {
    const p = this.page;
    const sel = this.selected();
    const nsel = sel.size;
    const tools = `<div class="attr-bar" role="toolbar" aria-label="Table tools">
        <button data-act="selAttr" title="Select by attributes (SQL query)">Select by attributes</button>
        <button data-act="defq" title="Definition query: show only matching features">Filter</button>
        <button data-act="calc" title="Field calculator">Calculate</button>
        <button data-act="addField" title="Add a field">Add field</button>
        <span class="sep"></span>
        <button data-act="showSel" class="${this.onlySelected ? 'on' : ''}" ${nsel || this.onlySelected ? '' : 'disabled'} title="Show only the selected features">Show selected</button>
        <button data-act="zoomSel" ${nsel ? '' : 'disabled'}>Zoom to selected</button>
        <button data-act="switchSel" title="Select the others">Switch</button>
        <button data-act="clearSel" ${nsel ? '' : 'disabled'}>Clear</button>
        <button data-act="delSel" ${nsel ? '' : 'disabled'} title="Delete the selected features">Delete</button>
        <button data-act="export" title="Save the selection (or the layer) as a new layer">Export</button>
      </div>`;
    if (!p) return `${tools}<div class="pane-empty">No rows.</div>`;
    const cols = p.fields;
    const sortMark = (c: string) => (this.sort?.field === c ? (this.sort.desc ? ' ▼' : ' ▲') : '');
    const body = p.rows
      .map((r, i) => {
        const cls = sel.has(r.fid) ? ' class="sel"' : '';
        const cells = r.values.map((v, ci) => `<td data-col="${ci}" class="${typeof v === 'number' ? 'num' : ''}">${this.fmt(v)}</td>`).join('');
        return `<tr${cls} data-row="${r.fid}" data-i="${i}"><td class="rh" title="Feature ${r.fid}: click to select, double-click to zoom">${r.fid}</td>${cells}</tr>`;
      })
      .join('');
    const off = p.offset;
    const menu = this.menu
      ? `<div class="col-menu" role="menu" data-for="${esc(this.menu)}">
          <button data-col-act="asc">Sort ascending</button><button data-col-act="desc">Sort descending</button>
          <button data-col-act="calc">Calculate field…</button><button data-col-act="stats">Statistics</button>
          <button data-col-act="delete" class="danger">Delete field…</button></div>`
      : '';
    return `${tools}<div class="attr-tools">
        <input id="attr-search" type="search" placeholder="Search all ${this.layer()?.feature_count.toLocaleString() ?? ''} features…" value="${esc(this.search)}" aria-label="Search the table" />
        <button data-act="prev" ${off === 0 ? 'disabled' : ''} title="Previous ${PAGE}">‹</button>
        <span class="rows">${p.total ? `${(off + 1).toLocaleString()}–${(off + p.rows.length).toLocaleString()} of ${p.total.toLocaleString()}` : '0 rows'}${this.loading ? ' …' : ''}</span>
        <button data-act="next" ${off + p.rows.length >= p.total ? 'disabled' : ''} title="Next ${PAGE}">›</button>
      </div>
      ${this.error ? `<div class="pane-empty err">${esc(this.error)}</div>` : ''}
      <div class="attr-wrap"><table class="attr">
        <thead><tr><th class="rh" data-sort="fid" title="Feature id">fid${sortMark('fid')}</th>${cols
          .map((c, i) => `<th data-sort="${esc(c)}" title="${esc(c)} · ${esc(p.kinds[i])} · click to sort"><span>${esc(c)}${sortMark(c)}</span><button class="col-more" data-col="${esc(c)}" aria-label="Field menu">⋮</button></th>`)
          .join('')}</tr></thead>
        <tbody>${body || `<tr><td class="empty" colspan="${cols.length + 1}">${this.search ? 'No feature matches the search' : this.onlySelected ? 'Nothing selected' : 'No rows'}</td></tr>`}</tbody>
      </table>${menu}</div>`;
  }

  private fieldsHtml(): string {
    const layer = this.layer();
    const rows = (layer?.fields ?? [])
      .map(
        (f) =>
          `<tr><td>${esc(f.name)}</td><td>${esc(f.kind)}</td><td class="acts"><button data-field-calc="${esc(f.name)}">Calculate</button><button data-field-del="${esc(f.name)}" class="danger">Delete</button></td></tr>`,
      )
      .join('');
    return `<div class="attr-bar"><button data-act="addField">Add field</button></div>
      <table class="attr fields"><thead><tr><th>Field</th><th>Type</th><th></th></tr></thead><tbody>${
        rows || '<tr><td class="empty" colspan="3">This layer has no attribute fields.</td></tr>'
      }</tbody></table>`;
  }

  private chartHtml(): string {
    const p = this.page;
    if (!p || !p.fields.length) return `<div class="pane-empty">No fields to chart.</div>`;
    const ci = Math.max(0, this.statsField ? p.fields.indexOf(this.statsField) : p.kinds.findIndex((k) => k === 'integer' || k === 'real'));
    const field = p.fields[ci];
    const options = p.fields.map((f) => `<option${f === field ? ' selected' : ''}>${esc(f)}</option>`).join('');
    const vals = p.rows.map((r) => r.values[ci]);
    const numeric = p.kinds[ci] === 'integer' || p.kinds[ci] === 'real';
    let bars: string;
    let summary = '';
    if (numeric) {
      const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (nums.length < 2) return `<div class="pane-empty">Not enough numeric values on this page.</div>`;
      const sorted = [...nums].sort((a, b) => a - b);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, nums.length - 1));
      const q = (t: number) => sorted[Math.min(sorted.length - 1, Math.floor(t * (sorted.length - 1)))];
      summary = `<table class="stats"><tr><th>n</th><td>${nums.length}</td><th>mean</th><td>${this.num(mean)}</td><th>sd</th><td>${this.num(sd)}</td></tr>
        <tr><th>min</th><td>${this.num(sorted[0])}</td><th>median</th><td>${this.num(q(0.5))}</td><th>max</th><td>${this.num(sorted[sorted.length - 1])}</td></tr></table>`;
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const bins = 12;
      const hits = new Array(bins).fill(0);
      for (const v of nums) hits[Math.min(bins - 1, Math.floor(((v - min) / (max - min || 1)) * bins))]++;
      const most = Math.max(1, ...hits);
      bars = hits
        .map((h, i) => {
          const lo = min + ((max - min) * i) / bins;
          return `<div class="bar-row"><span class="bar-key">${esc(lo.toPrecision(3))}</span><span class="bar" style="width:${((h / most) * 100).toFixed(1)}%"></span><span class="bar-val">${h.toLocaleString()}</span></div>`;
        })
        .join('');
    } else {
      const counts = new Map<string, number>();
      for (const v of vals) counts.set(String(v ?? '(null)'), (counts.get(String(v ?? '(null)')) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
      const most = Math.max(1, ...top.map((t) => t[1]));
      bars = top
        .map(([k, v]) => `<div class="bar-row"><span class="bar-key" title="${esc(k)}">${esc(k)}</span><span class="bar" style="width:${((v / most) * 100).toFixed(1)}%"></span><span class="bar-val">${v.toLocaleString()}</span></div>`)
        .join('');
    }
    return `<div class="chart-box">
      <label class="chart-title">Field <select data-chart-field>${options}</select> <span class="dim">${numeric ? 'histogram' : 'top values'} of the ${p.rows.length.toLocaleString()} rows on this page${this.search || this.onlySelected ? ' (searched/selected)' : ''}</span></label>
      ${summary}${bars}
    </div>`;
  }

  private statsField: string | null = null;

  /** Show a new selection without rebuilding the table (keeps double-click, scroll and focus). */
  private markSelection() {
    if (this.view !== 'table' || !this.root.querySelector('table.attr')) return this.render();
    const sel = this.selected();
    this.root.querySelectorAll<HTMLElement>('tbody tr[data-row]').forEach((tr) => tr.classList.toggle('sel', sel.has(Number(tr.dataset.row))));
    const n = sel.size;
    const sub = this.root.querySelector('.pane-sub');
    const total = this.layer()?.feature_count ?? this.page?.total ?? 0;
    if (sub) sub.innerHTML = `${total.toLocaleString()} features${n ? ` · <b>${n.toLocaleString()} selected</b>` : ''}`;
    for (const a of ['zoomSel', 'clearSel', 'delSel']) {
      const b = this.root.querySelector<HTMLButtonElement>(`[data-act="${a}"]`);
      if (b) b.disabled = !n;
    }
    const show = this.root.querySelector<HTMLButtonElement>('[data-act="showSel"]');
    if (show) show.disabled = !n && !this.onlySelected;
  }

  private num(v: number) {
    return esc(Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(5));
  }

  private fmt(v: Value): string {
    if (v == null) return '<i class="null">—</i>';
    if (typeof v === 'number') return esc(Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(6));
    return esc(v.length > 60 ? `${v.slice(0, 60)}…` : v);
  }

  // ---------------------------------------------------------------- events

  private async page2(delta: number) {
    this.offset = Math.max(0, this.offset + delta);
    await this.reload();
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const ed = this.editor;
    const id = this.layerId;
    if (!id) return;
    const view = t.closest<HTMLElement>('[data-view]')?.dataset.view;
    if (view) {
      this.view = view as 'table' | 'fields' | 'chart';
      return this.render();
    }
    // column menu
    const more = t.closest<HTMLElement>('.col-more');
    if (more) {
      e.stopPropagation();
      this.menu = this.menu === more.dataset.col ? null : more.dataset.col ?? null;
      this.render();
      const m = this.root.querySelector<HTMLElement>('.col-menu');
      const th = this.root.querySelector<HTMLElement>(`th[data-sort="${CSS.escape(more.dataset.col ?? '')}"]`);
      const wrap = this.root.querySelector<HTMLElement>('.attr-wrap');
      if (m && th && wrap) { m.style.left = `${th.offsetLeft}px`; m.style.top = `${th.offsetHeight}px`; }
      return;
    }
    const colAct = t.closest<HTMLElement>('[data-col-act]')?.dataset.colAct;
    if (colAct && this.menu) {
      const col = this.menu;
      this.menu = null;
      if (colAct === 'asc' || colAct === 'desc') { this.sort = { field: col, desc: colAct === 'desc' }; return void this.reload(true); }
      if (colAct === 'calc') return void ed?.calculateField(id, col);
      if (colAct === 'stats') { this.statsField = col; this.view = 'chart'; return this.render(); }
      if (colAct === 'delete') return void ed?.deleteField(id, col);
    }
    if (this.menu) { this.menu = null; this.render(); }
    const sortTh = t.closest<HTMLElement>('th[data-sort]');
    if (sortTh) {
      const f = sortTh.dataset.sort!;
      this.sort = this.sort?.field === f ? (this.sort.desc ? null : { field: f, desc: true }) : { field: f, desc: false };
      return void this.reload(true);
    }
    const fc = t.closest<HTMLElement>('[data-field-calc]')?.dataset.fieldCalc;
    if (fc) return void ed?.calculateField(id, fc);
    const fd = t.closest<HTMLElement>('[data-field-del]')?.dataset.fieldDel;
    if (fd) return void ed?.deleteField(id, fd);
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    switch (act) {
      case 'next': return void this.page2(PAGE);
      case 'prev': return void this.page2(-PAGE);
      case 'selAttr': return void ed?.selectByAttributes(id);
      case 'defq': return void ed?.definitionQuery(id);
      case 'calc': return void ed?.calculateField(id);
      case 'addField': return void ed?.addField(id);
      case 'export': return void ed?.exportSelection(id);
      case 'clearSel': return ed?.clearSelection(id);
      case 'zoomSel': return void ed?.zoomToSelection(id);
      case 'delSel': return void ed?.deleteSelected();
      case 'showSel': this.onlySelected = !this.onlySelected; return void this.reload(true);
      case 'switchSel': return void this.switchSelection();
    }
    const row = t.closest<HTMLElement>('tr[data-row]');
    if (!row || !ed || t.closest('input')) return;
    const fid = Number(row.dataset.row);
    const i = Number(row.dataset.i);
    if (e.shiftKey && this.anchor != null && this.page) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      ed.setSelection(id, this.page.rows.slice(a, b + 1).map((r) => r.fid), 'add');
    } else if (e.ctrlKey || e.metaKey) {
      ed.setSelection(id, [fid], this.selected().has(fid) ? 'remove' : 'add');
      this.anchor = i;
    } else {
      ed.setSelection(id, [fid]);
      this.anchor = i;
    }
  }

  private async switchSelection() {
    if (!this.layerId || !this.editor) return;
    const cur = this.selected();
    const all = await this.backend.json<{ fids: number[] }>(`api/layers/${enc(this.layerId)}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    this.editor.setSelection(this.layerId, all.fids.filter((f) => !cur.has(f)));
  }

  private onDblClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('tr[data-row]');
    if (!row || !this.page) return;
    const fid = Number(row.dataset.row);
    const r = this.page.rows.find((x) => x.fid === fid);
    if (t.closest('td.rh')) {
      if (r?.bbox) this.fitBox(r.bbox);
      return;
    }
    const td = t.closest<HTMLElement>('td[data-col]');
    if (!td || !r) return;
    const ci = Number(td.dataset.col);
    const kind = this.page.kinds[ci];
    const v = r.values[ci];
    td.innerHTML = `<input class="cell-edit" type="${kind === 'integer' || kind === 'real' ? 'number' : 'text'}"${kind === 'real' ? ' step="any"' : ''} value="${esc(v ?? '')}" data-fid="${fid}" data-field="${esc(this.page.fields[ci])}" data-kind="${esc(kind)}">`;
    const input = td.querySelector('input')!;
    input.focus();
    input.select();
    input.addEventListener('blur', () => void this.commitCell(input), { once: true });
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('cell-edit')) {
      if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
      else if (e.key === 'Escape') { t.dataset.cancel = '1'; t.blur(); }
      return;
    }
    if (t.id === 'attr-search' && e.key === 'Enter') {
      this.search = t.value;
      void this.reload(true);
    }
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.id === 'attr-search') {
      this.search = (t as HTMLInputElement).value;
      void this.reload(true);
    } else if (t.matches('[data-chart-field]')) {
      this.statsField = t.value;
      this.render();
    }
  }

  private async commitCell(input: HTMLInputElement) {
    if (!this.layerId || !this.editor || input.dataset.cancel) return this.render();
    const fid = Number(input.dataset.fid);
    const field = input.dataset.field!;
    const kind = input.dataset.kind!;
    const row = this.page?.rows.find((r) => r.fid === fid);
    const ci = this.page?.fields.indexOf(field) ?? -1;
    const old = row && ci >= 0 ? row.values[ci] : null;
    const raw = input.value;
    const value = raw === '' ? null : kind === 'integer' || kind === 'real' ? Number(raw) : raw;
    if (String(value ?? '') === String(old ?? '')) return this.render();
    const ok = await this.editor.setValue(this.layerId, fid, field, value);
    if (ok) this.host.setStatus(`${field} of feature ${fid} saved. Ctrl+Z undoes it.`);
    else this.render();
  }

  private fitBox(b: [number, number, number, number]) {
    const pad = Math.max(0.0004, (b[2] - b[0]) * 0.3);
    this.host.map.fitBounds(
      [
        [b[0] - pad, b[1] - pad],
        [b[2] + pad, b[3] + pad],
      ],
      { padding: 60, maxZoom: 17, duration: 400 },
    );
  }
}
