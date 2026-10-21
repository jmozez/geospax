// Start screen and drag-and-drop (docs/USER_GUIDE.md §2): the first thing a lazy mapper sees.
// One big drop zone ("drop your data, get a map"), the other ways in (a device, a phone, an
// analysis), and the maps already finished. Files dropped anywhere on the window, in either mode,
// are uploaded (POST /api/upload), styled and zoomed to.
import type { Backend } from './backend';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const ACCEPT = '.geojson,.json,.gpkg,.fgb,.kml,.kmz,.gpx,.csv,.gml,.parquet,.zip,.tif,.tiff,.las,.laz,.nmea';

interface Upload {
  layers: string[];
  rasters: string[];
  point_clouds: string[];
  skipped: string[];
}

interface RunRow {
  id: string;
  recipe: string;
  title: string;
  status: string;
  started_at?: string;
  artifacts?: string[];
}

export interface StartHost {
  backend: Backend;
  /** after uploads: reload layers/rasters, style and zoom to what arrived */
  added: (layers: string[], rasters: string[]) => Promise<void>;
  devices: () => void;
  toolbox: () => void;
  openRun: (runId: string) => void;
  setStatus: (t: string, ms?: number) => void;
}

export class StartScreen {
  private el: HTMLElement;
  private drop: HTMLElement;
  private input: HTMLInputElement;
  private busy = false;

  constructor(private host: StartHost) {
    this.el = document.createElement('section');
    this.el.id = 'start';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Start');
    document.querySelector('#center')?.appendChild(this.el);
    // the window-wide drop target
    this.drop = document.createElement('div');
    this.drop.id = 'drop-veil';
    this.drop.hidden = true;
    this.drop.innerHTML = `<div><b>Drop to map it</b><span>GeoSpaX styles it and zooms to it</span></div>`;
    document.body.appendChild(this.drop);
    this.input = document.createElement('input');
    this.input.type = 'file';
    this.input.multiple = true;
    this.input.accept = ACCEPT;
    this.input.hidden = true;
    document.body.appendChild(this.input);
    this.input.addEventListener('change', () => {
      if (this.input.files?.length) void this.upload([...this.input.files]);
      this.input.value = '';
    });
    this.el.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.hide();
    });
    this.wireDrop();
  }

  get open() {
    return !this.el.hidden;
  }

  async show() {
    this.el.hidden = false;
    document.body.dataset.start = 'open';
    await this.render();
  }

  hide() {
    this.el.hidden = true;
    delete document.body.dataset.start;
  }

  browse() {
    this.input.click();
  }

  private async render() {
    let maps: RunRow[] = [];
    try {
      const r = await this.host.backend.json<{ runs: RunRow[] }>('api/runs');
      maps = (r.runs ?? []).filter((x) => x.status === 'done' && (x.artifacts ?? []).some((a) => /\.png$/.test(a))).slice(0, 6);
    } catch {
      /* engine busy: no gallery this time */
    }
    const thumb = (r: RunRow) => {
      const png = (r.artifacts ?? []).find((a) => /^map.*\.png$|\.png$/.test(a))!;
      return `<button class="st-map" data-run="${esc(r.id)}" title="Open the report">
        <img src="${esc(this.host.backend.url(`api/runs/${r.id}/files/${png}`))}" alt="" loading="lazy" />
        <span>${esc(r.title || r.recipe)}</span></button>`;
    };
    this.el.innerHTML = `<div class="st-card">
      <button class="st-close" data-st="close" title="Go to the map" aria-label="Close">✕</button>
      <h1>Make a map</h1>
      <p class="st-lead">Drop your data: GeoSpaX styles it, lays out the map and writes the report.</p>
      <button class="st-drop" data-st="browse">
        <span class="st-drop-ico">⇪</span>
        <b>Drop files here, or click to choose</b>
        <small>GeoJSON · GeoPackage · Shapefile (zipped) · KML · GPX · CSV · GeoTIFF · LAS/LAZ</small>
      </button>
      <div class="st-ways">
        <button data-st="devices"><b>Plug in a device</b><small>Phone, GPS, drone card, camera, sensor logger: mapped when it is connected</small></button>
        <button data-st="phone"><b>Send from your phone</b><small>Scan a QR code: photos, tracks and live location over Wi-Fi</small></button>
        <button data-st="toolbox"><b>Start from an analysis</b><small>Terrain, satellite indices, hot spots, kriging…</small></button>
      </div>
      ${maps.length ? `<h2>Your finished maps</h2><div class="st-maps">${maps.map(thumb).join('')}</div>` : ''}
      <button class="st-go" data-st="close">Go to the map →</button>
    </div>`;
  }

  private onClick(e: Event) {
    const t = e.target as HTMLElement;
    const run = t.closest<HTMLElement>('[data-run]')?.dataset.run;
    if (run) return this.host.openRun(run);
    switch (t.closest<HTMLElement>('[data-st]')?.dataset.st) {
      case 'close':
        return this.hide();
      case 'browse':
        return this.browse();
      case 'devices':
      case 'phone':
        this.hide();
        return this.host.devices();
      case 'toolbox':
        this.hide();
        return this.host.toolbox();
    }
  }

  private wireDrop() {
    let depth = 0;
    const files = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!files(e)) return; // layer rows dragged inside the app are not uploads
      depth++;
      this.drop.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) this.drop.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (files(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      this.drop.hidden = true;
      const list = [...(e.dataTransfer?.files ?? [])];
      if (list.length) void this.upload(list);
    });
  }

  /** Upload files one by one; everything that arrives is added in one go at the end. */
  async upload(files: File[]) {
    if (this.busy) return;
    this.busy = true;
    const layers: string[] = [];
    const rasters: string[] = [];
    const problems: string[] = [];
    let clouds = 0;
    try {
      for (const [i, f] of files.entries()) {
        this.host.setStatus(`Adding ${f.name} (${i + 1} of ${files.length})…`, 60000);
        try {
          const r = await this.host.backend.json<Upload>(`api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
          layers.push(...r.layers);
          rasters.push(...r.rasters);
          clouds += r.point_clouds.length;
          problems.push(...r.skipped);
        } catch (err) {
          problems.push(`${f.name}: ${String((err as Error).message ?? err).replace(/^api\/upload[^:]*: /, '')}`);
        }
      }
      if (layers.length || rasters.length) {
        this.hide();
        await this.host.added(layers, rasters);
      }
      const parts = [
        layers.length ? `${layers.length} layer${layers.length > 1 ? 's' : ''}` : '',
        rasters.length ? `${rasters.length} raster${rasters.length > 1 ? 's' : ''}` : '',
        clouds ? `${clouds} point cloud${clouds > 1 ? 's' : ''} (run “LiDAR → terrain”)` : '',
      ].filter(Boolean);
      this.host.setStatus(parts.length ? `Added ${parts.join(', ')}${problems.length ? ` · ${problems.length} skipped` : ''}` : `Nothing added: ${problems[0] ?? 'no data'}`, 8000);
      if (problems.length) console.warn('upload:', problems);
      document.body.dataset.uploaded = String(layers.length + rasters.length);
    } finally {
      this.busy = false;
    }
  }
}
