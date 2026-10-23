// Rasters (docs/AUTOMATION.md "Rasters"): every raster the engine knows — files in the data folders
// and recipe outputs such as DEMs, hillshades, NDVI, landforms — is a MapLibre `image` source
// rendered server-side in Web Mercator with the style AutoMap chose. This pane switches them on and
// off, sets opacity and shows the legend. After a recipe run, its rasters appear the way the map
// composer shows them: the newest thematic raster with relief shading on top.
import type * as maplibregl from 'maplibre-gl';
import type { Backend } from './backend';

export interface RasterLegend {
  type: 'ramp' | 'classes' | 'note' | 'none';
  colors?: string[];
  min?: number;
  max?: number;
  units?: string;
  items?: { color: string; label: string }[];
  label?: string;
  /** colour positions 0–1 (a split ramp: each half its own ramp) */
  offsets?: number[];
  /** end labels given by the engine (years) */
  labels?: string[];
  /** the value where a split ramp changes (sea level) */
  mid?: { value: number; label: string };
}

export interface RasterInfo {
  id: string;
  title: string;
  kind: string;
  bounds: [number, number, number, number];
  width: number;
  height: number;
  pixel_m: number;
  crs: string;
  /** the file on disk */
  path?: string;
  description: string;
  why: string;
  style: { opacity?: number; kind?: string; resampling?: string; [k: string]: unknown };
  bands?: number;
  units?: string;
  stats?: { min: number; max: number; mean: number; std: number; p2: number; p98: number }[];
  legend: RasterLegend;
  overlay: { url: string; coordinates: [number, number][] };
}

interface RasterState {
  visible: boolean;
  opacity: number;
}

const KEY = 'gsx.rasters';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (v: number | undefined, u = '') =>
  v === undefined || v === null ? '' : `${Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : +v.toPrecision(3)}${u ? (u === '°' ? u : ` ${u}`) : ''}`;

export class RasterPane {
  rasters: RasterInfo[] = [];
  private state: Record<string, RasterState> = {};

  constructor(
    private el: HTMLElement,
    private backend: Backend,
    private hooks: { restyle: () => void; fit: (b: [number, number, number, number]) => void; changed?: () => void; style?: (r: RasterInfo) => void },
  ) {
    try {
      this.state = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      this.state = {};
    }
    el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const id = t.closest<HTMLElement>('.raster')?.dataset.id;
      if (!id || t.dataset.act !== 'opacity') return;
      this.st(id).opacity = +t.value / 100;
      this.save();
      this.hooks.restyle();
    });
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const id = t.closest<HTMLElement>('.raster')?.dataset.id;
      if (!id || t.dataset.act !== 'visible') return;
      this.st(id).visible = t.checked;
      this.save();
      this.render();
      this.hooks.restyle();
    });
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const id = t.closest<HTMLElement>('.raster')?.dataset.id;
      const r = this.rasters.find((x) => x.id === id);
      if (r && t.dataset.act === 'fit') this.hooks.fit(r.bounds);
      if (r && t.dataset.act === 'style') this.hooks.style?.(r);
    });
  }

  private st(id: string): RasterState {
    const r = this.rasters.find((x) => x.id === id);
    return (this.state[id] ??= { visible: false, opacity: r?.style.opacity ?? (r?.kind === 'hillshade' ? 0.5 : 1) });
  }

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* private mode */ }
    this.hooks.changed?.();
  }

  // ---- for the Contents pane, which lists rasters with the layers (one state for both panes)
  byId(id: string): RasterInfo | undefined {
    return this.rasters.find((r) => r.id === id);
  }
  isVisible(id: string): boolean {
    return this.st(id).visible;
  }
  opacity(id: string): number {
    return this.st(id).opacity;
  }
  setVisible(id: string, on: boolean) {
    this.st(id).visible = on;
    this.save();
    this.render();
    this.hooks.restyle();
  }
  setOpacity(id: string, o: number) {
    this.st(id).opacity = Math.min(1, Math.max(0, o));
    this.save();
    this.render();
    this.hooks.restyle();
  }
  /** The engine restyled a raster (Symbology): new legend and overlay URL. */
  replace(info: RasterInfo) {
    const i = this.rasters.findIndex((r) => r.id === info.id);
    if (i < 0) return;
    this.rasters[i] = info;
    this.render();
    this.hooks.changed?.();
    this.hooks.restyle();
  }
  private resampling(r: RasterInfo): 'nearest' | 'linear' {
    const s = r.style.resampling;
    return s === 'nearest' || (s !== 'bilinear' && (r.kind === 'classes' || r.style.kind === 'classes')) ? 'nearest' : 'linear';
  }
  legendHtml(id: string): string {
    const r = this.byId(id);
    return r ? this.legend(r.legend) : '';
  }
  /** The MapLibre source and layer of one raster, or null when it is hidden. */
  partsFor(id: string): { sid: string; source: maplibregl.SourceSpecification; layer: maplibregl.LayerSpecification } | null {
    const r = this.byId(id);
    if (!r || !this.st(id).visible) return null;
    const sid = `raster:${r.id}`;
    return {
      sid,
      source: { type: 'image', url: this.backend.url(r.overlay.url.replace(/^\//, '')), coordinates: r.overlay.coordinates as never },
      layer: {
        id: sid,
        type: 'raster',
        source: sid,
        paint: { 'raster-opacity': this.st(id).opacity, 'raster-fade-duration': 0, 'raster-resampling': this.resampling(r) },
      } as maplibregl.LayerSpecification,
    };
  }

  async reload() {
    try {
      this.rasters = (await this.backend.json<{ rasters: RasterInfo[] }>('api/rasters')).rasters;
    } catch {
      this.rasters = [];
    }
    for (const id of Object.keys(this.state)) if (!this.rasters.some((r) => r.id === id)) delete this.state[id];
    this.render();
    this.hooks.changed?.();
  }

  /**
   * Rasters that just appeared (a tool, the assistant, a trigger): the newest thematic one is shown with
   * its relief shading, the way a run's result is; nothing that is already on is switched off.
   */
  showNew(ids: string[]) {
    const made = ids.map((id) => this.byId(id)).filter((r): r is RasterInfo => !!r);
    const base = [...made].reverse().find((r) => r.kind !== 'hillshade' && r.kind !== 'embedding') ?? [...made].reverse().find((r) => r.kind !== 'hillshade');
    const shade = base && base.kind !== 'rgb' ? [...made].reverse().find((r) => r.kind === 'hillshade') : undefined;
    for (const r of [base, shade]) if (r) this.st(r.id).visible = true;
    this.save();
    this.render();
    this.hooks.restyle();
  }

  /**
   * Show what a run made: the rasters of its first (main) map when it exported one, else what the
   * map composer would pick (the newest thematic raster + relief shading).
   */
  showRun(ids: string[], mainMap?: string[]) {
    const pick = (mainMap ?? []).filter((id) => this.rasters.some((r) => r.id === id));
    // like ArcGIS Pro and QGIS, a new result is switched on and nothing already on is switched off
    if (pick.length) {
      for (const id of pick) this.st(id).visible = true;
      this.save();
      this.render();
      return;
    }
    const made = ids.map((id) => this.rasters.find((r) => r.id === id)).filter((r): r is RasterInfo => !!r);
    if (!made.length) return;
    const base = [...made].reverse().find((r) => r.kind !== 'hillshade');
    const shade = base && base.kind !== 'rgb' ? [...made].reverse().find((r) => r.kind === 'hillshade') : undefined;
    for (const r of [base ?? made[made.length - 1], shade]) if (r) this.st(r.id).visible = true;
    this.save();
    this.render();
  }

  /** MapLibre sources and layers (hillshade above the colour layers). */
  styleParts(): { sources: Record<string, maplibregl.SourceSpecification>; layers: maplibregl.LayerSpecification[] } {
    const sources: Record<string, maplibregl.SourceSpecification> = {};
    const layers: maplibregl.LayerSpecification[] = [];
    const order = [...this.rasters].sort((a, b) => +(a.kind === 'hillshade') - +(b.kind === 'hillshade'));
    for (const r of order) {
      const s = this.st(r.id);
      if (!s.visible) continue;
      const sid = `raster:${r.id}`;
      sources[sid] = { type: 'image', url: this.backend.url(r.overlay.url.replace(/^\//, '')), coordinates: r.overlay.coordinates as never };
      layers.push({
        id: sid,
        type: 'raster',
        source: sid,
        paint: { 'raster-opacity': s.opacity, 'raster-fade-duration': 0, 'raster-resampling': this.resampling(r) },
      });
    }
    return { sources, layers };
  }

  private legend(l: RasterLegend): string {
    if (l.type === 'ramp' && l.colors?.length) {
      // a split ramp (bathymetry) places its colours itself and marks sea level at the middle
      const stops = l.offsets?.length === l.colors.length ? l.colors.map((c, i) => `${c} ${(l.offsets![i] * 100).toFixed(1)}%`) : l.colors;
      const mid = l.mid ? `<span class="mid">${esc(l.mid.label)}</span>` : '';
      const [lo, hi] = l.labels?.length === 2 ? l.labels : [fmt(l.min, l.units), fmt(l.max, l.units)];
      return `<div class="ramp${l.mid ? ' split' : ''}" style="background:linear-gradient(90deg,${stops.join(',')})"></div><div class="ends"><span>${esc(lo)}</span>${mid}<span>${esc(hi)}</span></div>`;
    }
    if (l.type === 'classes') {
      return `<ul class="classes">${(l.items ?? []).slice(0, 12).map((c) => `<li><i style="background:${esc(c.color)}"></i>${esc(c.label)}</li>`).join('')}</ul>`;
    }
    if (l.type === 'note') return `<div class="note">${esc(l.label ?? '')}</div>`;
    return '';
  }

  render() {
    if (!this.rasters.length) {
      this.el.innerHTML = '<p class="muted">No rasters yet. Run <b>Terrain report</b> or <b>Latest cloud-free NDVI</b>, or drop a GeoTIFF into a data folder.</p>';
      return;
    }
    this.el.innerHTML = this.rasters
      .map((r) => {
        const s = this.st(r.id);
        return `<div class="raster" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}">
  <label><input type="checkbox" data-act="visible" ${s.visible ? 'checked' : ''}> <span class="name" title="${esc(r.description || r.why)}">${esc(r.title)}</span></label>
  <span class="tag">${esc(r.kind)}</span><button class="fit" data-act="fit" title="Zoom to">⤢</button><button class="fit" data-act="style" title="Symbology" aria-label="Symbology">⚙</button>
  ${s.visible ? `<input type="range" data-act="opacity" min="10" max="100" value="${Math.round(s.opacity * 100)}" title="Opacity">${this.legend(r.legend)}` : ''}
  <div class="meta">${r.width}×${r.height} px · ${r.pixel_m} m · ${esc(r.crs)}</div>
</div>`;
      })
      .join('');
  }
}
