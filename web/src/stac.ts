// STAC search (Explorer › Web services › a STAC catalog › a collection): find satellite and other
// imagery for the area on the map (or a drawn box), a date range and a cloud limit. The results are
// listed newest first with their footprints drawn on the map; each GeoTIFF asset can be streamed
// (read in place, a window at a time, nothing copied) or downloaded cut to the area, with the
// download gauge. The panel sits beside the map so the map stays usable while it is open.
import type { Backend } from './backend';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Box = [number, number, number, number];

export interface StacHost {
  backend: Backend;
  view: () => Box;
  drawBox: () => Promise<Box | null>;
  setStatus: (t: string, ms?: number) => void;
}

interface Asset { key: string; title: string; href: string; cog: boolean }
interface Item { id: string; collection: string; datetime: string; cloud: number | null; platform: string | null; geometry: GeoJSON.Geometry | null; bbox: number[] | null; assets: Asset[]; thumbnail: string | null }

const iso = (d: Date) => d.toISOString().slice(0, 10);

export class StacSearch {
  private el: HTMLElement;
  private sid = '';
  private collection = '';
  private title = '';
  private area: Box | null = null; // a drawn box; null = the map view
  private items: Item[] = [];
  private open: string | null = null;

  constructor(private host: StacHost) {
    this.el = document.createElement('div');
    this.el.className = 'stac-panel';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Search imagery');
    document.body.appendChild(this.el);
    document.addEventListener('geospax:stac-search', (e) => {
      const d = (e as CustomEvent<{ sid: string; collection: string; title: string }>).detail;
      this.show(d.sid, d.collection, d.title);
    });
    this.el.addEventListener('click', (e) => void this.click(e));
    this.el.addEventListener('submit', (e) => { e.preventDefault(); void this.search(); });
  }

  show(sid: string, collection: string, title: string) {
    if (sid !== this.sid || collection !== this.collection) { this.items = []; this.open = null; }
    Object.assign(this, { sid, collection, title });
    const now = new Date();
    const from = new Date(now.getTime() - 90 * 864e5);
    this.el.innerHTML = `<header><b>Search imagery</b><span class="dim">${esc(title)}</span><button type="button" data-x aria-label="Close">✕</button></header>
      <form class="stac-form">
        <div class="stac-area"><span>Area</span><label><input type="radio" name="area" value="view" ${this.area ? '' : 'checked'} /> Map view</label><label><input type="radio" name="area" value="box" ${this.area ? 'checked' : ''} /> Draw a box</label></div>
        <div class="stac-row"><label>From <input type="date" name="from" value="${iso(from)}" /></label><label>To <input type="date" name="to" value="${iso(now)}" /></label></div>
        <label class="stac-row">Cloud at most <input type="number" name="cloud" min="0" max="100" value="20" style="width:5em" /> % <span class="dim">(empty: any)</span></label>
        <div class="stac-acts"><button class="primary" type="submit">Search</button></div>
      </form>
      <div class="stac-results" aria-live="polite">${this.resultsHtml()}</div>`;
    this.el.hidden = false;
    this.el.querySelectorAll<HTMLInputElement>('input[name=area]').forEach((r) => r.addEventListener('change', () => { if (r.checked && r.value === 'box') void this.pickBox(); if (r.checked && r.value === 'view') this.area = null; }));
  }

  private async pickBox() {
    this.el.hidden = true;
    this.host.setStatus('Drag a box on the map for the search area (Esc cancels)');
    const b = await this.host.drawBox();
    this.el.hidden = false;
    this.area = b;
    if (!b) { const v = this.el.querySelector<HTMLInputElement>('input[value=view]'); if (v) v.checked = true; }
  }

  private async search() {
    const f = this.el.querySelector<HTMLFormElement>('form')!;
    const get = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
    const bbox = this.area ?? this.host.view();
    const from = get('from'), to = get('to'), cloud = get('cloud');
    const datetime = from || to ? `${from ? `${from}T00:00:00Z` : '..'}/${to ? `${to}T23:59:59Z` : '..'}` : '';
    const box = this.el.querySelector<HTMLElement>('.stac-results')!;
    box.innerHTML = '<p class="dim">Searching…</p>';
    try {
      const r = await this.host.backend.json<{ items: Item[]; matched: number | null }>('api/stac/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: this.sid, collection: this.collection, bbox, datetime, max_cloud: cloud === '' ? null : Number(cloud), limit: 50 }),
      });
      this.items = r.items;
      this.open = null;
      box.innerHTML = this.resultsHtml(r.matched);
      this.footprints();
    } catch (e) {
      box.innerHTML = `<p class="err">${esc(e instanceof Error ? e.message : e)}</p>`;
    }
  }

  private resultsHtml(matched?: number | null): string {
    if (!this.items.length) return this.sid ? '<p class="dim">Set the area and dates, then Search. Results are listed newest first and outlined on the map.</p>' : '';
    const head = `<p class="dim">${this.items.length}${matched && matched > this.items.length ? ` of ${matched.toLocaleString()}` : ''} found</p>`;
    return head + this.items.map((it) => {
      const open = this.open === it.id;
      const cloud = typeof it.cloud === 'number' ? ` · ☁ ${Math.round(it.cloud)} %` : '';
      return `<div class="stac-item${open ? ' open' : ''}" data-item="${esc(it.id)}">
        <div class="si-head">${it.thumbnail ? `<img src="${esc(it.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}<div><b>${esc(it.datetime.slice(0, 10))}</b><span class="dim">${esc(it.platform ?? '')}${cloud}</span><span class="dim si-id" title="${esc(it.id)}">${esc(it.id)}</span></div></div>
        ${open ? (it.assets.length ? `<div class="si-assets">${it.assets.map((a) => `<div class="si-asset"><span title="${esc(a.href)}">${esc(a.title)}</span><button data-stream="${esc(a.key)}" title="Put it on the map in place: read over the web a window at a time, nothing is copied${a.cog ? '' : ' (not cloud-optimised: may be slow)'}">Stream</button><button data-dl="${esc(a.key)}" title="Download it cut to the search area, kept on this computer">Download</button></div>`).join('')}</div>` : '<p class="dim">No GeoTIFF assets in this item.</p>') : ''}
      </div>`;
    }).join('');
  }

  private footprints(hl?: string) {
    const features = this.items.filter((i) => i.geometry).map((i) => ({ type: 'Feature' as const, properties: { id: i.id, hl: i.id === hl ? 1 : 0 }, geometry: i.geometry! }));
    document.dispatchEvent(new CustomEvent('geospax:stac-footprints', { detail: features.length ? { type: 'FeatureCollection', features } : null }));
  }

  private async click(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('[data-x]')) { this.el.hidden = true; document.dispatchEvent(new CustomEvent('geospax:stac-footprints', { detail: null })); return; }
    const itemEl = t.closest<HTMLElement>('[data-item]');
    if (!itemEl) return;
    const it = this.items.find((i) => i.id === itemEl.dataset.item);
    if (!it) return;
    const key = t.closest<HTMLElement>('[data-stream]')?.dataset.stream ?? t.closest<HTMLElement>('[data-dl]')?.dataset.dl;
    if (key) return void this.add(it, it.assets.find((a) => a.key === key)!, !!t.closest('[data-stream]'));
    if (t.closest('.si-head')) {
      this.open = this.open === it.id ? null : it.id;
      this.el.querySelector<HTMLElement>('.stac-results')!.innerHTML = this.resultsHtml();
      this.footprints(this.open ?? undefined);
    }
  }

  private async add(it: Item, a: Asset, stream: boolean) {
    const id = `${it.id}_${a.key}`;
    const label = `${it.datetime.slice(0, 10)} ${a.title}`;
    const bbox = stream ? null : (this.area ?? this.host.view());
    this.host.setStatus(stream ? `Opening ${label} over the web…` : `Starting the download of ${label}…`);
    try {
      const r = await this.host.backend.json<{ rasters?: string[]; job?: number }>('api/stac/add', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ href: a.href, id, title: label, stream, bbox }),
      });
      if (r.rasters) {
        document.dispatchEvent(new CustomEvent('geospax:added', { detail: { layers: [], rasters: r.rasters } }));
        this.host.setStatus(`${label} is on the map (streamed)`, 6000);
      } else if (r.job !== undefined) {
        void this.follow(r.job, label);
      }
    } catch (err) {
      this.host.setStatus(`${label}: ${err instanceof Error ? err.message : err}`, 10000);
    }
  }

  /** Poll the download job and feed the download gauge until it ends. */
  private async follow(job: number, label: string) {
    const runId = `stac-job-${job}`;
    for (;;) {
      let j: { status: string; message: string; elapsed_ms: number; result: { rasters?: string[] } | null; transfer: unknown };
      try { j = await this.host.backend.json(`api/jobs/${job}`); } catch { return; }
      const status = j.status;
      const rasters = j.result?.rasters ?? [];
      document.dispatchEvent(new CustomEvent('geospax:run-progress', {
        detail: { id: runId, recipe: 'stac', title: label, status, progress: 0, elapsed_ms: j.elapsed_ms, current: label, steps: [], artifacts: [], layers: [], rasters, styles: {}, extent: null, error: status === 'failed' || status === 'cancelled' ? j.message : null, transfer: j.transfer ?? null, cancel_url: `api/jobs/${job}/cancel` },
      }));
      if (status === 'done') {
        document.dispatchEvent(new CustomEvent('geospax:added', { detail: { layers: [], rasters } }));
        this.host.setStatus(`${label} downloaded and added`, 6000);
        return;
      }
      if (status === 'failed' || status === 'cancelled') return;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
}
