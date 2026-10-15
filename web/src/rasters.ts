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
  description: string;
  why: string;
  style: { opacity?: number; kind?: string };
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
    private hooks: { restyle: () => void; fit: (b: [number, number, number, number]) => void },
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
    });
  }

  private st(id: string): RasterState {
    const r = this.rasters.find((x) => x.id === id);
    return (this.state[id] ??= { visible: false, opacity: r?.style.opacity ?? (r?.kind === 'hillshade' ? 0.5 : 1) });
  }

  private save() {
    localStorage.setItem(KEY, JSON.stringify(this.state));
  }

  async reload() {
    try {
      this.rasters = (await this.backend.json<{ rasters: RasterInfo[] }>('api/rasters')).rasters;
    } catch {
      this.rasters = [];
    }
    for (const id of Object.keys(this.state)) if (!this.rasters.some((r) => r.id === id)) delete this.state[id];
    this.render();
  }

  /**
   * Show what a run made: the rasters of its first (main) map when it exported one, else what the
   * map composer would pick (the newest thematic raster + relief shading).
   */
  showRun(ids: string[], mainMap?: string[]) {
    const pick = (mainMap ?? []).filter((id) => this.rasters.some((r) => r.id === id));
    if (pick.length) {
      for (const r of this.rasters) this.st(r.id).visible = pick.includes(r.id);
      this.save();
      this.render();
      return;
    }
    const made = ids.map((id) => this.rasters.find((r) => r.id === id)).filter((r): r is RasterInfo => !!r);
    if (!made.length) return;
    const base = [...made].reverse().find((r) => r.kind !== 'hillshade');
    const shade = base && base.kind !== 'rgb' ? [...made].reverse().find((r) => r.kind === 'hillshade') : undefined;
    for (const r of this.rasters) this.st(r.id).visible = r === base || r === shade || (!base && r === made[made.length - 1]);
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
        paint: { 'raster-opacity': s.opacity, 'raster-fade-duration': 0, 'raster-resampling': r.kind === 'classes' ? 'nearest' : 'linear' },
      });
    }
    return { sources, layers };
  }

  private legend(l: RasterLegend): string {
    if (l.type === 'ramp' && l.colors?.length) {
      return `<div class="ramp" style="background:linear-gradient(90deg,${l.colors.join(',')})"></div><div class="ends"><span>${esc(fmt(l.min, l.units))}</span><span>${esc(fmt(l.max, l.units))}</span></div>`;
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
  <span class="tag">${esc(r.kind)}</span><button class="fit" data-act="fit" title="Zoom to">⤢</button>
  ${s.visible ? `<input type="range" data-act="opacity" min="10" max="100" value="${Math.round(s.opacity * 100)}" title="Opacity">${this.legend(r.legend)}` : ''}
  <div class="meta">${r.width}×${r.height} px · ${r.pixel_m} m · ${esc(r.crs)}</div>
</div>`;
      })
      .join('');
  }
}
