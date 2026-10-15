// Attribute table — the pane ArcGIS Pro users live in. Rows come from the engine's
// `/api/layers/{id}/rows` endpoint: a window of features with their attributes and a
// bounding box each, so a million-record layer opens as fast as a map tile and clicking
// a row can zoom to that feature without re-reading the source.
import type * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';

const PAGE = 250; // rows per request
const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface AttrHost {
  map: maplibregl.Map;
  layers: () => LayerInfo[];
  log: (line: string) => void;
  setStatus: (text: string, ms?: number) => void;
}

interface Row {
  fid: number;
  bbox: [number, number, number, number] | null;
  values: (string | number | null)[];
}

interface Page {
  total: number;
  offset: number;
  fields: string[];
  rows: Row[];
}

export class AttributesPane {
  private layerId: string | null = null;
  private page: Page | null = null;
  private view: 'table' | 'fields' | 'chart' = 'table';
  private filter = '';
  private selected = new Set<number>();
  private loading = false;
  private error = '';

  constructor(
    private root: HTMLElement,
    private backend: Backend,
    private host: AttrHost,
  ) {
    root.addEventListener('click', (e) => void this.onClick(e));
    root.addEventListener('input', (e) => this.onInput(e as InputEvent));
  }

  // ---------------------------------------------------------------- data

  async open(id: string) {
    this.layerId = id;
    this.selected.clear();
    this.error = '';
    this.loading = true;
    this.render();
    await this.fetch(0);
    this.loading = false;
    this.render();
  }

  clear() {
    this.layerId = null;
    this.page = null;
    this.render();
  }

  private async fetch(offset: number) {
    if (!this.layerId) return;
    try {
      this.page = await this.backend.json<Page>(
        `api/layers/${encodeURIComponent(this.layerId)}/rows?offset=${offset}&limit=${PAGE}`,
      );
    } catch (e) {
      this.error = String((e as Error).message ?? e);
      this.host.log(`attribute table: ${this.error}`);
    }
  }

  private rows(): Row[] {
    const rows = this.page?.rows ?? [];
    const f = this.filter.trim().toLowerCase();
    if (!f) return rows;
    return rows.filter((r) => r.values.some((v) => v != null && String(v).toLowerCase().includes(f)));
  }

  // ---------------------------------------------------------------- render

  render() {
    if (!this.layerId) {
      this.root.innerHTML = `<div class="pane-empty">Pick a layer in <b>Contents</b> or <b>Catalog</b>, then open <b>Attributes</b>.</div>`;
      return;
    }
    const layer = this.host.layers().find((l) => l.id === this.layerId);
    const total = this.page?.total ?? 0;
    const shown = this.rows().length;
    const head = `<div class="pane-head">
        <span class="pane-title">${esc(layer?.name ?? this.layerId)}</span>
        <span class="pane-sub">${this.filter ? `${shown} of ${total.toLocaleString()} match` : `${total.toLocaleString()} rows`}</span>
      </div>
      <div class="seg">
        ${(['table', 'fields', 'chart'] as const)
          .map((v) => `<button class="${this.view === v ? 'on' : ''}" data-view="${v}">${v[0].toUpperCase()}${v.slice(1)}</button>`)
          .join('')}
      </div>`;
    if (this.error) {
      this.root.innerHTML = `${head}<div class="pane-empty err">${esc(this.error)}</div>`;
      return;
    }
    if (this.loading && !this.page) {
      this.root.innerHTML = `${head}<div class="pane-empty">Reading ${esc(this.layerId)}…</div>`;
      return;
    }
    this.root.innerHTML =
      head + (this.view === 'table' ? this.tableHtml() : this.view === 'fields' ? this.fieldsHtml() : this.chartHtml());
  }

  private tableHtml(): string {
    const p = this.page;
    if (!p) return '<div class="pane-empty">No rows.</div>';
    const cols = p.fields;
    const body = this.rows()
      .map((r) => {
        const sel = this.selected.has(r.fid) ? ' class="sel"' : '';
        const cells = r.values.map((v) => `<td>${this.fmt(v)}</td>`).join('');
        return `<tr${sel} data-row="${r.fid}"><td class="rh">${r.fid}</td>${cells}</tr>`;
      })
      .join('');
    const off = p.offset;
    return `<div class="attr-tools">
        <input id="attr-filter" type="search" placeholder="Find in table…" value="${esc(this.filter)}" />
        <button data-act="prev" ${off === 0 ? 'disabled' : ''} title="Previous ${PAGE}">‹</button>
        <span class="rows">${(off + 1).toLocaleString()}–${(off + p.rows.length).toLocaleString()} of ${p.total.toLocaleString()}</span>
        <button data-act="next" ${off + p.rows.length >= p.total ? 'disabled' : ''} title="Next ${PAGE}">›</button>
      </div>
      <div class="attr-wrap"><table class="attr">
        <thead><tr><th></th>${cols.map((c) => `<th title="${esc(c)}">${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${body || '<tr><td class="empty" colspan="20">No rows in this window</td></tr>'}</tbody>
      </table></div>
      <div class="attr-foot">
        <span>${this.selected.size} selected</span>
        <button data-act="zoomSel">Zoom to selected</button>
        <button data-act="clearSel">Clear</button>
      </div>`;
  }

  private fieldsHtml(): string {
    const layer = this.host.layers().find((l) => l.id === this.layerId);
    const exposed = new Set(this.page?.fields ?? []);
    const rows = (layer?.fields ?? [])
      .map(
        (f) =>
          `<tr><td>${esc(f.name)}${exposed.has(f.name) ? '' : ' <span class="dim">(not in tiles)</span>'}</td><td>${esc(f.kind)}</td></tr>`,
      )
      .join('');
    return `<table class="attr fields"><thead><tr><th>Field</th><th>Type</th></tr></thead><tbody>${
      rows || '<tr><td class="empty" colspan="2">This layer exposes no attribute fields.</td></tr>'
    }</tbody></table>`;
  }

  private chartHtml(): string {
    const p = this.page;
    if (!p || !p.fields.length) return `<div class="pane-empty">No fields to chart.</div>`;
    // first numeric column, else the first column (top values)
    let ci = p.fields.findIndex((_, i) => this.rows().some((r) => typeof r.values[i] === 'number'));
    if (ci < 0) ci = 0;
    const rows = this.rows();
    const vals = rows.map((r) => r.values[ci]);
    const numeric = vals.some((v) => typeof v === 'number');
    let bars: string;
    if (numeric) {
      const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (nums.length < 2) return `<div class="pane-empty">Not enough numeric values in this window.</div>`;
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      const bins = 12;
      const hits = new Array(bins).fill(0);
      for (const v of nums) hits[Math.min(bins - 1, Math.floor(((v - min) / (max - min || 1)) * bins))]++;
      const most = Math.max(1, ...hits);
      bars = hits
        .map((h, i) => {
          const lo = min + ((max - min) * i) / bins;
          return `<div class="bar-row"><span class="bar-key">${esc(lo.toPrecision(3))}</span><span class="bar" style="width:${(
            (h / most) * 100
          ).toFixed(1)}%"></span><span class="bar-val">${h.toLocaleString()}</span></div>`;
        })
        .join('');
    } else {
      const counts = new Map<string, number>();
      for (const v of vals) {
        const k = String(v ?? '(null)');
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
      const most = Math.max(1, ...top.map((t) => t[1]));
      bars = top
        .map(
          ([k, v]) =>
            `<div class="bar-row"><span class="bar-key" title="${esc(k)}">${esc(k)}</span><span class="bar" style="width:${(
              (v / most) * 100
            ).toFixed(1)}%"></span><span class="bar-val">${v.toLocaleString()}</span></div>`,
        )
        .join('');
    }
    return `<div class="chart-box">
      <div class="chart-title">${esc(p.fields[ci])} ${numeric ? '· histogram of this window' : '· top values in this window'}</div>
      ${bars}
    </div>`;
  }

  private fmt(v: string | number | null): string {
    if (v == null) return '<i class="null">—</i>';
    if (typeof v === 'number') return esc(Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(6));
    return esc(v.length > 44 ? `${v.slice(0, 44)}…` : v);
  }

  // ---------------------------------------------------------------- events

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const view = t.closest<HTMLElement>('[data-view]')?.dataset.view;
    if (view) {
      this.view = view as 'table' | 'fields' | 'chart';
      this.render();
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'next') { this.loading = true; this.render(); await this.fetch((this.page?.offset ?? 0) + PAGE); this.loading = false; this.render(); return; }
    if (act === 'prev') { this.loading = true; this.render(); await this.fetch(Math.max(0, (this.page?.offset ?? 0) - PAGE)); this.loading = false; this.render(); return; }
    if (act === 'clearSel') { this.selected.clear(); this.render(); return; }
    if (act === 'zoomSel') { this.zoomSelected(); return; }
    const row = t.closest<HTMLElement>('tr[data-row]');
    if (!row) return;
    const fid = Number(row.dataset.row);
    if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(fid)) this.selected.delete(fid);
      else this.selected.add(fid);
    } else {
      this.selected.clear();
      this.selected.add(fid);
      this.zoomTo(fid);
    }
    this.render();
  }

  private onInput(e: InputEvent) {
    const t = e.target as HTMLInputElement;
    if (t.id !== 'attr-filter') return;
    this.filter = t.value;
    const pos = t.selectionStart ?? t.value.length;
    this.render();
    const again = this.root.querySelector<HTMLInputElement>('#attr-filter');
    if (again) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  }

  private row(fid: number): Row | undefined {
    return this.page?.rows.find((r) => r.fid === fid);
  }

  private zoomTo(fid: number) {
    const b = this.row(fid)?.bbox;
    if (!b) return;
    this.fitBox(b);
  }

  private zoomSelected() {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const fid of this.selected) {
      const b = this.row(fid)?.bbox;
      if (!b) continue;
      minx = Math.min(minx, b[0]); miny = Math.min(miny, b[1]);
      maxx = Math.max(maxx, b[2]); maxy = Math.max(maxy, b[3]);
    }
    if (!Number.isFinite(minx)) return;
    this.fitBox([minx, miny, maxx, maxy]);
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
