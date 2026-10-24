// Design: CAD-style drafting on the map (the Design tab). The precision tools of QGIS's Advanced
// Digitizing panel, ArcGIS Pro's direction–distance and COGO traverse, and AutoCAD's command line,
// ortho, polar tracking and object snaps, writing into ordinary GIS layers ("Design · …"
// GeoPackages), so a design can be analysed, styled, laid out and exported like any layer, and
// exchanged with AutoCAD as DXF.
//
// While drawing, type into the command bar under the map and press Enter:
//   25<90      25 m on a bearing of 90° (east) from the last point
//   25         25 m along the direction the pointer shows
//   @10,-4     10 m east and 4 m south of the last point
//   147.01,-6.72   an absolute longitude, latitude
//   (empty)    finish the shape
// F8 ortho (right angles to the last segment), F10 polar tracking (every 15°), F3 object snaps
// (vertex, midpoint, nearest point on a segment), U or Ctrl+Z steps back one point, Esc cancels.
//
// Modify (AutoCAD's Modify panel) works on any feature of any vector layer: click it, then
//   Move / Copy   base point, then the second point (or @dx,dy)
//   Rotate        base point, then an angle in degrees (counter-clockwise) or a click
//   Scale         base point, then a factor
//   Mirror        two points of the mirror line (a mirrored copy is added)
//   Erase         the feature is deleted
//   Trim          click the part of a line to cut away between the lines that cross it
//   Extend        click near a line's end: it runs on to the next line it meets
//   Fillet        click near a corner, then the radius: the corner becomes a tangent arc
//
// Distances and bearings are worked out on a local plane around the first point (metres east and
// north), which is accurate to a few centimetres over a town; the layers stay in WGS 84.
import type * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';
import { extend, fillet, mapGeometry, mirror, nearestVertex, rotate, scale, translate, trim } from './cadmodify';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type LL = [number, number];
type XY = [number, number];
export type CadTool = 'line' | 'polyline' | 'polygon' | 'rect' | 'circle' | 'point' | 'text' | 'dimension' | 'offset' | 'road' | ModifyTool;
export type ModifyTool = 'move' | 'copy' | 'rotate' | 'scale' | 'mirror' | 'erase' | 'trim' | 'extend' | 'fillet';
const MODIFY: ModifyTool[] = ['move', 'copy', 'rotate', 'scale', 'mirror', 'erase', 'trim', 'extend', 'fillet'];
const isModify = (t: CadTool | null): t is ModifyTool => !!t && (MODIFY as string[]).includes(t);
/** a feature picked for Modify: its layer, id, full geometry and where it was clicked */
interface Sel { layer: string; fid: number; feature: GeoJSON.Feature; at: LL }

export interface CadHost {
  map: maplibregl.Map;
  backend: Backend;
  layers: () => LayerInfo[];
  /** a layer's data changed (re-read it and redraw) */
  changed: (id: string, info?: LayerInfo) => Promise<void>;
  /** show a field as labels on a layer (dimensions, annotations) */
  labels: (id: string, field: string, placement: 'point' | 'line' | 'line-center') => void;
  /** a new design layer's drafting look: colour, hollow or filled, line width */
  look: (id: string, look: CadLook) => void;
  setStatus: (t: string, ms?: number) => void;
}

/** How a design layer is drawn: bright drafting colours that read over imagery, outlines for plans. */
export interface CadLook { color: string; hollow?: boolean; width: number; dash?: 'solid' | 'dashed'; opacity?: number }

/** The design layers: kind → (name, geometry, fields, look). */
const DESIGN: Record<string, { name: string; geometry: 'point' | 'line' | 'polygon'; fields: [string, string][]; label?: [string, 'point' | 'line' | 'line-center']; look: CadLook }> = {
  lines: { name: 'Design · lines', geometry: 'line', fields: [['name', 'text'], ['kind', 'text'], ['length_m', 'real']], look: { color: '#ff6b9a', width: 1.4, dash: 'dashed' } },
  polygons: { name: 'Design · polygons', geometry: 'polygon', fields: [['name', 'text'], ['kind', 'text'], ['area_m2', 'real'], ['perimeter_m', 'real']], look: { color: '#ffd166', hollow: true, width: 1.6 } },
  points: { name: 'Design · points', geometry: 'point', fields: [['name', 'text'], ['kind', 'text']], look: { color: '#ffffff', width: 1 } },
  dimensions: { name: 'Design · dimensions', geometry: 'line', fields: [['label', 'text'], ['length_m', 'real']], label: ['label', 'line-center'], look: { color: '#7fdbff', width: 1 } },
  annotations: { name: 'Design · annotations', geometry: 'point', fields: [['text', 'text']], label: ['text', 'point'], look: { color: '#ffd166', width: 1 } },
  roads: { name: 'Design · roads', geometry: 'polygon', fields: [['name', 'text'], ['width_m', 'real'], ['length_m', 'real'], ['area_m2', 'real']], look: { color: '#d9dde3', width: 1.4, opacity: 0.75 } },
  parcels: { name: 'Design · parcels', geometry: 'polygon', fields: [['name', 'text'], ['area_m2', 'real'], ['perimeter_m', 'real'], ['misclosure_m', 'real']], label: ['name', 'point'], look: { color: '#ffa94d', hollow: true, width: 2 } },
};

const M_PER_DEG = 111320;

/** A local plane (metres east, north) around an origin. */
class Plane {
  private k: number;
  constructor(private o: LL) {
    this.k = Math.cos((o[1] * Math.PI) / 180);
  }
  xy(p: LL): XY {
    return [(p[0] - this.o[0]) * M_PER_DEG * this.k, (p[1] - this.o[1]) * M_PER_DEG];
  }
  ll(p: XY): LL {
    return [this.o[0] + p[0] / (M_PER_DEG * this.k), this.o[1] + p[1] / M_PER_DEG];
  }
}

const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** bearing in degrees clockwise from north */
const bearing = (a: XY, b: XY) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
const polar = (a: XY, d: number, deg: number): XY => [a[0] + d * Math.sin((deg * Math.PI) / 180), a[1] + d * Math.cos((deg * Math.PI) / 180)];
const fmt = (m: number) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(2)} m`);
const area = (pts: XY[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const perimeter = (pts: XY[], closed: boolean) => pts.reduce((s, p, i) => (i === 0 ? 0 : s + dist(pts[i - 1], p)), 0) + (closed && pts.length > 2 ? dist(pts[pts.length - 1], pts[0]) : 0);

/** Lines `d` metres to the right (negative: left) of a polyline, corners mitred (capped at 4× d). */
export function offsetLine(pts: XY[], d: number): XY[] {
  if (pts.length < 2) return pts;
  const n = pts.length;
  const normal = (a: XY, b: XY): XY => { const l = dist(a, b) || 1; return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]; };
  const out: XY[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      const [a, b] = i === 0 ? [pts[0], pts[1]] : [pts[n - 2], pts[n - 1]];
      const nn = normal(a, b);
      out.push([pts[i][0] + nn[0] * d, pts[i][1] + nn[1] * d]);
      continue;
    }
    const n1 = normal(pts[i - 1], pts[i]);
    const n2 = normal(pts[i], pts[i + 1]);
    const m: XY = [n1[0] + n2[0], n1[1] + n2[1]];
    const ml = Math.hypot(m[0], m[1]) || 1;
    const cos = (n1[0] * m[0] + n1[1] * m[1]) / ml;
    const len = Math.min(Math.abs(d) / Math.max(cos, 0.25), Math.abs(d) * 4) * Math.sign(d);
    out.push([pts[i][0] + (m[0] / ml) * len, pts[i][1] + (m[1] / ml) * len]);
  }
  return out;
}

/** A road (or any corridor) of `width` metres around a centreline: one closed ring. */
export function corridor(pts: XY[], width: number): XY[] {
  const l = offsetLine(pts, -width / 2);
  const r = offsetLine(pts, width / 2);
  return [...l, ...r.reverse()];
}

/** A traverse: lines "bearing distance" (bearing in degrees, or N45°30'E quadrant form) from a start. */
export function traverse(start: XY, legs: string[]): { pts: XY[]; misclosure: number } | string {
  const pts: XY[] = [start];
  for (const raw of legs) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const d = Number(parts[parts.length - 1]);
    const b = parseBearing(parts.slice(0, -1).join(' '));
    if (!Number.isFinite(d) || b === null) return `Not a "bearing distance" line: ${line}`;
    pts.push(polar(pts[pts.length - 1], d, b));
  }
  if (pts.length < 3) return 'A traverse needs at least two legs';
  return { pts, misclosure: dist(pts[pts.length - 1], start) };
}

/** 90, 90.5, 90°30', 90°30'15", N45E, S30°15'W … → degrees clockwise from north, or null. */
export function parseBearing(s: string): number | null {
  const t = s.trim().toUpperCase().replace(/\s+/g, '');
  const dms = (x: string) => {
    const m = x.match(/^(\d+(?:\.\d+)?)(?:[°D](\d+(?:\.\d+)?)?['M]?(?:(\d+(?:\.\d+)?)["S]?)?)?$/);
    return m ? Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600 : null;
  };
  const q = t.match(/^([NS])(.+)([EW])$/);
  if (q) {
    const a = dms(q[2]);
    if (a === null || a > 90) return null;
    if (q[1] === 'N') return q[3] === 'E' ? a : (360 - a) % 360;
    return q[3] === 'E' ? 180 - a : 180 + a;
  }
  const a = dms(t);
  return a === null || a >= 360 ? null : a;
}

const circle = (c: XY, r: number, n = 72): XY[] => Array.from({ length: n }, (_, i) => polar(c, r, (360 * i) / n));

export class CadDesigner {
  private tool: CadTool | null = null;
  private pts: LL[] = [];
  private plane: Plane | null = null;
  private cursor: LL | null = null;
  private snapped: { at: LL; kind: string } | null = null;
  ortho = false;
  polar = true;
  snap = true;
  private bar: HTMLElement;
  private picked: { layer: string; coords: LL[] } | null = null;
  private sel: Sel | null = null;
  private onMove = (e: maplibregl.MapMouseEvent) => this.move(e);
  private onClick = (e: maplibregl.MapMouseEvent) => void this.click(e);
  private onDbl = (e: maplibregl.MapMouseEvent) => { e.preventDefault(); void this.finish(); };

  constructor(private h: CadHost) {
    this.bar = document.createElement('div');
    this.bar.className = 'cad-bar';
    this.bar.hidden = true;
    document.querySelector('#map')?.parentElement?.appendChild(this.bar);
    document.addEventListener('geospax:cad', (e) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === 'traverse') return void this.traverseDialog();
      if (what === 'dxf-export') return void this.exportDxf();
      if (what === 'dxf-import') return void this.importDxf();
      if (what === 'ortho' || what === 'polar' || what === 'snap') { this[what] = !this[what]; return this.renderBar(); }
      void this.start(what as CadTool);
    });
    document.addEventListener('keydown', (e) => {
      if (!this.tool) return;
      const input = this.bar.querySelector<HTMLInputElement>('input');
      if (e.key === 'Escape') { e.preventDefault(); this.stop(); return; }
      if (e.key === 'F8') { e.preventDefault(); this.ortho = !this.ortho; return this.renderBar(); }
      if (e.key === 'F10') { e.preventDefault(); this.polar = !this.polar; return this.renderBar(); }
      if (e.key === 'F3') { e.preventDefault(); this.snap = !this.snap; return this.renderBar(); }
      if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || (e.key.toLowerCase() === 'u' && document.activeElement !== input)) {
        e.preventDefault(); this.pts.pop(); return this.draw();
      }
      // typing anywhere goes to the command line
      if (input && document.activeElement !== input && /^[-\d@.,<NSEWnsew°']$/.test(e.key)) input.focus();
    });
  }

  // ---------------------------------------------------------------- tools
  async start(tool: CadTool) {
    this.stop();
    this.tool = tool;
    this.pts = [];
    this.plane = null;
    this.picked = null;
    this.sel = null;
    const m = this.h.map;
    m.doubleClickZoom.disable();
    m.on('mousemove', this.onMove);
    m.on('click', this.onClick);
    m.on('dblclick', this.onDbl);
    m.getCanvas().style.cursor = 'crosshair';
    this.ensurePreview();
    this.renderBar();
    this.bar.querySelector('input')?.focus();
  }

  stop() {
    const m = this.h.map;
    m.off('mousemove', this.onMove);
    m.off('click', this.onClick);
    m.off('dblclick', this.onDbl);
    m.doubleClickZoom.enable();
    m.getCanvas().style.cursor = '';
    this.tool = null;
    this.pts = [];
    this.cursor = null;
    this.picked = null;
    this.sel = null;
    this.bar.hidden = true;
    this.draw();
  }

  private prompt(): string {
    const n = this.pts.length;
    switch (this.tool) {
      case 'line': return n === 0 ? 'Line: first point' : 'Line: next point (25<90, @10,5 or click)';
      case 'polyline': return n === 0 ? 'Polyline: first point' : 'Polyline: next point · Enter finishes';
      case 'polygon': return n === 0 ? 'Polygon: first corner' : `Polygon: next corner · Enter closes (${n} so far)`;
      case 'rect': return n === 0 ? 'Rectangle: first corner' : 'Rectangle: opposite corner, or @width,height in m';
      case 'circle': return n === 0 ? 'Circle: centre' : 'Circle: radius in m, or click a point on the edge';
      case 'point': return 'Point: click or type lon,lat';
      case 'text': return 'Text: click where it goes';
      case 'dimension': return n === 0 ? 'Dimension: first point' : 'Dimension: second point';
      case 'offset': return this.picked ? 'Offset: distance in m (+ right, − left of the line)' : 'Offset: click the line to copy';
      case 'road': return n < 2 ? 'Road: centreline points · Enter when done' : 'Road: next centreline point · Enter, then the width';
      case 'move': case 'copy': return !this.sel ? `${this.tool === 'move' ? 'Move' : 'Copy'}: click the feature` : n === 0 ? 'Base point' : 'Second point (or @dx,dy in m)';
      case 'rotate': return !this.sel ? 'Rotate: click the feature' : n === 0 ? 'Base point' : 'Angle in degrees (counter-clockwise), or click';
      case 'scale': return !this.sel ? 'Scale: click the feature' : n === 0 ? 'Base point' : 'Scale factor (2 = twice the size)';
      case 'mirror': return !this.sel ? 'Mirror: click the feature' : n === 0 ? 'First point of the mirror line' : 'Second point of the mirror line';
      case 'erase': return 'Erase: click the feature to delete';
      case 'trim': return 'Trim: click the part of a line to cut away';
      case 'extend': return 'Extend: click near the end of a line';
      case 'fillet': return !this.sel ? 'Fillet: click near a corner' : 'Fillet radius in m';
      default: return '';
    }
  }

  private renderBar() {
    if (!this.tool) return;
    const live = this.liveText();
    const prev = this.bar.querySelector<HTMLInputElement>('input')?.value ?? '';
    this.bar.hidden = false;
    this.bar.innerHTML = `<b>${esc(this.prompt())}</b>
      <input class="cad-cmd" spellcheck="false" autocomplete="off" placeholder="25<90 · @10,5 · lon,lat · Enter" aria-label="Command" value="${esc(prev)}">
      <span class="cad-live">${esc(live)}</span>
      <span class="cad-modes">
        <button data-mode="snap" class="${this.snap ? 'on' : ''}" title="Object snaps: vertices, midpoints, nearest (F3)">Snap</button>
        <button data-mode="ortho" class="${this.ortho ? 'on' : ''}" title="Right angles to the last segment (F8)">Ortho</button>
        <button data-mode="polar" class="${this.polar ? 'on' : ''}" title="Polar tracking every 15° (F10)">Polar</button>
        <button data-done title="Finish (Enter)">Finish</button><button data-cancel title="Cancel (Esc)">✕</button>
      </span>`;
    const input = this.bar.querySelector<HTMLInputElement>('input')!;
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = input.value.trim();
      input.value = '';
      void (v ? this.typed(v) : this.finish());
    });
    this.bar.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.mode as 'snap' | 'ortho' | 'polar';
      this[k] = !this[k];
      this.renderBar();
    }));
    this.bar.querySelector('[data-done]')?.addEventListener('click', () => void this.finish());
    this.bar.querySelector('[data-cancel]')?.addEventListener('click', () => this.stop());
  }

  private liveText(): string {
    const last = this.pts[this.pts.length - 1];
    const c = this.cursor;
    if (!c) return '';
    const coord = `${c[0].toFixed(6)}, ${c[1].toFixed(6)}`;
    if (!last || !this.plane) return coord + (this.snapped ? ` · snap: ${this.snapped.kind}` : '');
    const a = this.plane.xy(last), b = this.plane.xy(c);
    return `${fmt(dist(a, b))} < ${bearing(a, b).toFixed(1)}°${this.snapped ? ` · snap: ${this.snapped.kind}` : ''}`;
  }

  // ---------------------------------------------------------------- pointer
  private move(e: maplibregl.MapMouseEvent) {
    this.cursor = this.constrain([e.lngLat.lng, e.lngLat.lat], e.point);
    this.draw();
    const live = this.bar.querySelector('.cad-live');
    if (live) live.textContent = this.liveText();
  }

  /** Object snap first; otherwise ortho / polar tracking from the last point. */
  private constrain(p: LL, px: { x: number; y: number }): LL {
    this.snapped = null;
    if (this.snap) {
      const s = this.snapAt(px);
      if (s) { this.snapped = s; return s.at; }
    }
    const last = this.pts[this.pts.length - 1];
    if (!last || !this.plane) return p;
    const a = this.plane.xy(last), b = this.plane.xy(p);
    const d = dist(a, b);
    let br = bearing(a, b);
    if (this.ortho) {
      const prev = this.pts.length >= 2 ? bearing(this.plane.xy(this.pts[this.pts.length - 2]), a) : 0;
      br = prev + Math.round((br - prev) / 90) * 90;
    } else if (this.polar) {
      const r = Math.round(br / 15) * 15;
      if (Math.abs(r - br) < 3) br = r;
    }
    return this.plane.ll(polar(a, d, br));
  }

  private snapAt(px: { x: number; y: number }): { at: LL; kind: string } | null {
    const m = this.h.map;
    const R = 12;
    const own = this.pts.map((p) => ({ p, kind: 'vertex' }));
    const feats = m.queryRenderedFeatures([[px.x - R, px.y - R], [px.x + R, px.y + R]]).filter((f) => !f.layer.id.startsWith('cad-') && !f.layer.id.startsWith('basemap'));
    const cands: { p: LL; kind: string }[] = [...own];
    const segs: [LL, LL][] = [];
    for (const f of feats) {
      const g = f.geometry;
      const rings: LL[][] = g.type === 'Point' ? [[g.coordinates as LL]] : g.type === 'LineString' ? [g.coordinates as LL[]] : g.type === 'Polygon' ? (g.coordinates as LL[][]) : g.type === 'MultiLineString' ? (g.coordinates as LL[][]) : g.type === 'MultiPolygon' ? (g.coordinates as LL[][][]).flat() : [];
      for (const ring of rings) {
        ring.forEach((p, i) => {
          cands.push({ p, kind: 'vertex' });
          if (i > 0) { cands.push({ p: [(ring[i - 1][0] + p[0]) / 2, (ring[i - 1][1] + p[1]) / 2], kind: 'midpoint' }); segs.push([ring[i - 1], p]); }
        });
      }
    }
    let best: { at: LL; kind: string; d: number } | null = null;
    const rank = (k: string) => (k === 'vertex' ? 0 : k === 'midpoint' ? 3 : 6);
    for (const c of cands) {
      const q = m.project(c.p as maplibregl.LngLatLike);
      const d = Math.hypot(q.x - px.x, q.y - px.y);
      if (d <= R && (!best || d + rank(c.kind) < best.d)) best = { at: c.p, kind: c.kind, d: d + rank(c.kind) };
    }
    if (!best) {
      // the nearest point on a segment under the pointer
      for (const [a, b] of segs) {
        const pa = m.project(a as maplibregl.LngLatLike), pb = m.project(b as maplibregl.LngLatLike);
        const vx = pb.x - pa.x, vy = pb.y - pa.y;
        const t = Math.max(0, Math.min(1, ((px.x - pa.x) * vx + (px.y - pa.y) * vy) / (vx * vx + vy * vy || 1)));
        const x = pa.x + t * vx, y = pa.y + t * vy;
        const d = Math.hypot(x - px.x, y - px.y);
        if (d <= R && (!best || d < best.d)) best = { at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], kind: 'nearest', d };
      }
    }
    return best ? { at: best.at, kind: best.kind } : null;
  }

  private async click(e: maplibregl.MapMouseEvent) {
    if (!this.tool) return;
    const p = this.constrain([e.lngLat.lng, e.lngLat.lat], e.point);
    if (this.tool === 'offset' && !this.picked) return this.pick(e);
    if (isModify(this.tool) && !this.sel) return this.pickFeature(e);
    await this.add(p);
  }

  private pick(e: maplibregl.MapMouseEvent) {
    const R = 6;
    const f = this.h.map.queryRenderedFeatures([[e.point.x - R, e.point.y - R], [e.point.x + R, e.point.y + R]])
      .find((x) => x.geometry.type === 'LineString' && !x.layer.id.startsWith('cad-'));
    if (!f) return this.h.setStatus('Click on a line to offset', 4000);
    this.picked = { layer: f.layer.source, coords: (f.geometry as GeoJSON.LineString).coordinates as LL[] };
    this.plane = new Plane(this.picked.coords[0]);
    this.renderBar();
    this.draw();
  }

  /** a point is placed (clicked or typed) */
  private async add(p: LL) {
    if (!this.plane) this.plane = new Plane(p);
    this.pts.push(p);
    const n = this.pts.length;
    switch (this.tool) {
      case 'point': await this.commit(); break;
      case 'text': {
        const t = window.prompt('Text');
        if (t) await this.save('annotations', { type: 'Point', coordinates: p }, { text: t });
        this.pts = [];
        break;
      }
      case 'line': case 'dimension': case 'rect': if (n === 2) await this.commit(); break;
      case 'circle': if (n === 2) await this.commit(); break;
      case 'move': case 'copy': if (n === 2) await this.transform(translate(this.diff(this.pts[0], this.pts[1])), this.tool === 'copy'); break;
      case 'mirror': if (n === 2) await this.transform(mirror(this.plane.xy(this.pts[0]), this.plane.xy(this.pts[1])), true); break;
      case 'rotate': if (n === 2) {
        const [a, b] = [this.plane.xy(this.pts[0]), this.plane.xy(this.pts[1])];
        await this.transform(rotate(a, (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI), false);
      } break;
    }
    this.renderBar();
    this.draw();
  }

  /** what was typed into the command line */
  private async typed(v: string) {
    const last = this.pts[this.pts.length - 1];
    const s = v.replace(/\s+/g, '');
    if (this.tool === 'offset' && this.picked) return this.doOffset(Number(s));
    if (this.sel && /^-?\d+(\.\d+)?$/.test(s)) {
      const v = Number(s);
      if (this.tool === 'rotate' && this.pts.length === 1) return this.transform(rotate(this.plane!.xy(this.pts[0]), v), false);
      if (this.tool === 'scale' && this.pts.length === 1) return v > 0 ? this.transform(scale(this.plane!.xy(this.pts[0]), v), false) : this.h.setStatus('The factor must be above 0', 4000);
      if (this.tool === 'fillet') return this.doFillet(v);
    }
    if (this.tool === 'circle' && this.pts.length === 1 && /^\d+(\.\d+)?$/.test(s)) {
      return this.add(this.plane!.ll(polar(this.plane!.xy(last), Number(s), 90)));
    }
    let m = s.match(/^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (m && last && this.plane) {
      const a = this.plane.xy(last);
      if (this.tool === 'rect') return this.add(this.plane.ll([a[0] + Number(m[1]), a[1] + Number(m[2])]));
      return this.add(this.plane.ll([a[0] + Number(m[1]), a[1] + Number(m[2])]));
    }
    m = s.match(/^(-?\d+(?:\.\d+)?)<(.+)$/);
    if (m && last && this.plane) {
      const b = parseBearing(m[2]);
      if (b === null) return this.h.setStatus(`Not a bearing: ${m[2]}`, 5000);
      return this.add(this.plane.ll(polar(this.plane.xy(last), Number(m[1]), b)));
    }
    m = s.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (m) {
      const lon = Number(m[1]), lat = Number(m[2]);
      if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) return this.add([lon, lat]);
    }
    if (/^\d+(\.\d+)?$/.test(s) && last && this.plane && this.cursor) {
      // a distance along the direction the pointer shows
      const a = this.plane.xy(last);
      return this.add(this.plane.ll(polar(a, Number(s), bearing(a, this.plane.xy(this.cursor)))));
    }
    this.h.setStatus(`Not understood: ${v}. Try 25<90, @10,5, a distance, or lon,lat`, 6000);
  }

  async finish() {
    if (!this.tool) return;
    const n = this.pts.length;
    if ((this.tool === 'polyline' && n >= 2) || (this.tool === 'polygon' && n >= 3)) await this.commit();
    else if (this.tool === 'road' && n >= 2) {
      const w = Number(window.prompt('Road width (m)', '7.5'));
      if (Number.isFinite(w) && w > 0) await this.commitRoad(w);
    } else this.stop();
  }

  // ---------------------------------------------------------------- saving
  private async layerFor(kind: keyof typeof DESIGN): Promise<string> {
    const d = DESIGN[kind];
    // the engine keeps the name as a file name (design__parcels.gpkg): compare letters and digits only
    const norm = (x: string) => x.toLowerCase().replace(/\.gpkg$/, '').replace(/[^a-z0-9]+/g, '');
    const have = this.h.layers().find((l) => norm(l.name) === norm(d.name) || norm(l.id.split('.')[0]) === norm(d.name));
    if (have) return have.id;
    const r = await this.h.backend.json<{ layer: LayerInfo }>('api/layers/new', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: d.name, geometry: d.geometry, fields: d.fields.map(([name, k]) => ({ name, kind: k })) }),
    });
    await this.h.changed(r.layer.id, r.layer);
    this.h.look(r.layer.id, d.look);
    if (d.label) this.h.labels(r.layer.id, d.label[0], d.label[1]);
    return r.layer.id;
  }

  private async save(kind: keyof typeof DESIGN, geometry: GeoJSON.Geometry, properties: Record<string, unknown>) {
    const id = await this.layerFor(kind);
    const r = await this.h.backend.json<{ layer: LayerInfo }>(`api/layers/${encodeURIComponent(id)}/features`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'Feature', geometry, properties }),
    });
    await this.h.changed(id, r.layer);
  }

  private async commit() {
    const p = this.plane!;
    const xy = this.pts.map((q) => p.xy(q));
    const ring = (pts: XY[]) => [...pts, pts[0]].map((q) => p.ll(q));
    const r2 = (v: number) => Math.round(v * 100) / 100;
    try {
      switch (this.tool) {
        case 'point': await this.save('points', { type: 'Point', coordinates: this.pts[0] }, { kind: 'point' }); break;
        case 'line': case 'polyline': await this.save('lines', { type: 'LineString', coordinates: this.pts }, { kind: this.tool, length_m: r2(perimeter(xy, false)) }); break;
        case 'dimension': {
          const d = dist(xy[0], xy[1]);
          await this.save('dimensions', { type: 'LineString', coordinates: this.pts }, { label: fmt(d), length_m: r2(d) });
          break;
        }
        case 'polygon': await this.save('polygons', { type: 'Polygon', coordinates: [ring(xy)] }, { kind: 'polygon', area_m2: r2(area(xy)), perimeter_m: r2(perimeter(xy, true)) }); break;
        case 'rect': {
          const [a, b] = xy;
          const rect: XY[] = [a, [b[0], a[1]], b, [a[0], b[1]]];
          await this.save('polygons', { type: 'Polygon', coordinates: [ring(rect)] }, { kind: 'rectangle', area_m2: r2(area(rect)), perimeter_m: r2(perimeter(rect, true)) });
          break;
        }
        case 'circle': {
          const r = dist(xy[0], xy[1]);
          const c = circle(xy[0], r);
          await this.save('polygons', { type: 'Polygon', coordinates: [ring(c)] }, { kind: `circle r=${r2(r)} m`, area_m2: r2(Math.PI * r * r), perimeter_m: r2(2 * Math.PI * r) });
          break;
        }
      }
      this.h.setStatus(`${this.tool} saved`, 3000);
    } catch (e) {
      this.h.setStatus(`Could not save: ${e instanceof Error ? e.message : e}`, 8000);
    }
    const keep = this.tool!;
    this.pts = [];
    this.plane = null;
    // a line tool continues from where the last one ended, as in CAD
    if (keep === 'line') { /* fresh start point */ }
    this.renderBar();
    this.draw();
  }

  private async commitRoad(width: number) {
    const p = this.plane!;
    const xy = this.pts.map((q) => p.xy(q));
    const ring = corridor(xy, width);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    await this.save('roads', { type: 'Polygon', coordinates: [[...ring, ring[0]].map((q) => p.ll(q))] }, { name: 'road', width_m: width, length_m: r2(perimeter(xy, false)), area_m2: r2(area(ring)) });
    await this.save('lines', { type: 'LineString', coordinates: this.pts }, { kind: 'road centreline', length_m: r2(perimeter(xy, false)) });
    this.h.setStatus(`Road saved: ${fmt(perimeter(xy, false))} long, ${width} m wide`, 5000);
    this.pts = [];
    this.plane = null;
    this.renderBar();
    this.draw();
  }

  private async doOffset(d: number) {
    if (!this.picked || !Number.isFinite(d) || d === 0) return this.h.setStatus('Type the offset distance in m (+ right, − left)', 5000);
    const p = new Plane(this.picked.coords[0]);
    const out = offsetLine(this.picked.coords.map((q) => p.xy(q)), d).map((q) => p.ll(q));
    await this.save('lines', { type: 'LineString', coordinates: out }, { kind: `offset ${d} m` });
    this.h.setStatus(`Parallel line ${Math.abs(d)} m to the ${d > 0 ? 'right' : 'left'} saved`, 4000);
    this.picked = null;
    this.renderBar();
    this.draw();
  }

  // ---------------------------------------------------------------- modify
  private diff(a: LL, b: LL): XY {
    const p = this.plane!, x = p.xy(a), y = p.xy(b);
    return [y[0] - x[0], y[1] - x[1]];
  }

  /** the feature under the pointer: its layer and id from the map, its full geometry from the engine */
  private async pickFeature(e: maplibregl.MapMouseEvent) {
    const R = 6;
    const hit = this.h.map.queryRenderedFeatures([[e.point.x - R, e.point.y - R], [e.point.x + R, e.point.y + R]])
      .find((x) => x.layer.id.includes('#') && !x.layer.id.startsWith('cad-') && !x.layer.id.startsWith('basemap') && Number.isFinite(Number(x.id)));
    if (!hit) return this.h.setStatus('No feature there: click on a line, shape or point', 4000);
    const layer = hit.layer.id.replace(/#.*$/, '');
    const fid = Number(hit.id);
    const at: LL = [e.lngLat.lng, e.lngLat.lat];
    try {
      const feature = await this.h.backend.json<GeoJSON.Feature>(`api/layers/${encodeURIComponent(layer)}/features/${fid}`);
      if (!feature.geometry) return this.h.setStatus('That feature has no geometry', 4000);
      this.sel = { layer, fid, feature, at };
      this.plane = new Plane(at);
    } catch (err) {
      return this.h.setStatus(`Could not read the feature: ${err instanceof Error ? err.message : err}`, 6000);
    }
    if (this.tool === 'erase') return this.doErase();
    if (this.tool === 'trim' || this.tool === 'extend') return this.doTrimExtend();
    this.renderBar();
    this.draw();
  }

  /** the picked feature through a plane transform: replaced (move, rotate, scale) or copied */
  private async transform(f: (p: XY) => XY, copy: boolean) {
    const s = this.sel!, p = this.plane!;
    const geometry = mapGeometry(s.feature.geometry, (q) => p.ll(f(p.xy(q))));
    await this.write(geometry, copy);
  }

  private async write(geometry: GeoJSON.Geometry, copy: boolean, extra?: GeoJSON.Geometry[]) {
    const s = this.sel!;
    const url = `api/layers/${encodeURIComponent(s.layer)}/features`;
    const props = Object.fromEntries(Object.entries(s.feature.properties ?? {}).filter(([k]) => !/^(fid|ogc_fid)$/i.test(k)));
    try {
      if (copy) await this.h.backend.json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'Feature', geometry, properties: props }) });
      else await this.h.backend.json(`${url}/${s.fid}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ geometry }) });
      for (const g of extra ?? []) await this.h.backend.json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'Feature', geometry: g, properties: props }) });
      await this.h.changed(s.layer);
      this.h.setStatus(`${this.tool} done`, 3000);
    } catch (err) {
      this.h.setStatus(`Could not save: ${err instanceof Error ? err.message : err}`, 8000);
    }
    this.sel = null;
    this.pts = [];
    this.plane = null;
    this.renderBar();
    this.draw();
  }

  private async doErase() {
    const s = this.sel!;
    try {
      await this.h.backend.json(`api/layers/${encodeURIComponent(s.layer)}/features/${s.fid}`, { method: 'DELETE' });
      await this.h.changed(s.layer);
      this.h.setStatus('Erased', 3000);
    } catch (err) {
      this.h.setStatus(`Could not erase: ${err instanceof Error ? err.message : err}`, 8000);
    }
    this.sel = null;
    this.draw();
  }

  /** the lines of the picked feature and, as cutting edges, every other line and outline in view */
  private lines(g: GeoJSON.Geometry): LL[][] {
    switch (g.type) {
      case 'LineString': return [g.coordinates as LL[]];
      case 'MultiLineString': return g.coordinates as LL[][];
      case 'Polygon': return g.coordinates as LL[][];
      case 'MultiPolygon': return (g.coordinates as LL[][][]).flat();
      default: return [];
    }
  }

  private cutters(): XY[][] {
    const s = this.sel!, p = this.plane!;
    const out: XY[][] = [];
    for (const f of this.h.map.queryRenderedFeatures()) {
      if (!f.layer.id.includes('#') || f.layer.id.startsWith('cad-') || f.layer.id.startsWith('basemap')) continue;
      if (f.layer.id.replace(/#.*$/, '') === s.layer && Number(f.id) === s.fid) continue;
      for (const l of this.lines(f.geometry)) out.push(l.map((q) => p.xy(q)));
    }
    return out;
  }

  private async doTrimExtend() {
    const s = this.sel!, p = this.plane!;
    const g = s.feature.geometry;
    if (g.type !== 'LineString') {
      this.sel = null;
      return this.h.setStatus(`${this.tool === 'trim' ? 'Trim' : 'Extend'} works on single lines (this is a ${g.type})`, 5000);
    }
    const line = (g.coordinates as LL[]).map((q) => p.xy(q));
    const at = p.xy(s.at);
    if (this.tool === 'extend') {
      const out = extend(line, this.cutters(), at);
      if (!out) {
        this.sel = null;
        this.draw();
        return this.h.setStatus('Nothing to extend to in that direction (in view)', 5000);
      }
      return this.write({ type: 'LineString', coordinates: out.map((q) => p.ll(q)) }, false);
    }
    const pieces = trim(line, this.cutters(), at);
    if (!pieces) {
      this.sel = null;
      this.draw();
      return this.h.setStatus('No line crosses it: nothing to trim against (Erase removes it whole)', 5000);
    }
    if (!pieces.length) return this.doErase();
    const [first, ...rest] = pieces.map((l) => ({ type: 'LineString', coordinates: l.map((q) => p.ll(q)) }) as GeoJSON.Geometry);
    return this.write(first, false, rest);
  }

  private async doFillet(r: number) {
    const s = this.sel!, p = this.plane!;
    const g = s.feature.geometry;
    if (!(r > 0)) return this.h.setStatus('The radius must be above 0', 4000);
    const closed = g.type === 'Polygon';
    const coords = g.type === 'LineString' ? (g.coordinates as LL[]) : g.type === 'Polygon' ? (g.coordinates[0] as LL[]) : null;
    if (!coords) return this.h.setStatus(`Fillet works on lines and polygons (this is a ${g.type})`, 5000);
    const line = coords.map((q) => p.xy(q));
    const i = nearestVertex(closed ? line.slice(0, -1) : line, p.xy(s.at));
    const out = fillet(line, i, r, closed);
    if (!out) return this.h.setStatus('That corner cannot take this radius (a straight corner, an end point, or legs shorter than the arc needs)', 6000);
    const ring = out.map((q) => p.ll(q));
    const geometry: GeoJSON.Geometry = closed ? { type: 'Polygon', coordinates: [ring, ...(g.coordinates.slice(1) as LL[][])] } : { type: 'LineString', coordinates: ring };
    return this.write(geometry, false);
  }

  // ---------------------------------------------------------------- traverse (COGO)
  private traverseDialog() {
    const c = this.h.map.getCenter();
    const modal = document.createElement('div');
    modal.className = 'modal folder-pick';
    modal.innerHTML = `<form class="sheet fp cad-trav" role="dialog" aria-label="Traverse">
      <header><b>Traverse (COGO)</b><button type="button" data-x aria-label="Close">✕</button></header>
      <div class="body">
        <p class="dim">A parcel from its survey: a start point, then one leg per line as <b>bearing distance</b> (bearings
        clockwise from north in degrees, 45°30'15", or quadrant form like N45°30'E; distances in metres).</p>
        <label class="ws-field"><span>Start (longitude, latitude)</span><input name="start" value="${c.lng.toFixed(6)}, ${c.lat.toFixed(6)}"></label>
        <label class="ws-field"><span>Name</span><input name="name" value="Lot 1"></label>
        <label class="ws-field"><span>Legs</span><textarea name="legs" rows="7" spellcheck="false">N0°E 40
N90°E 25
S0°E 40
S90°W 25</textarea></label>
        <p class="err" data-msg></p>
      </div>
      <footer><button type="button" data-x>Cancel</button><button class="primary" type="submit">Create parcel</button></footer></form>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal || (e.target as HTMLElement).closest('[data-x]')) close(); });
    const form = modal.querySelector('form')!;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = modal.querySelector<HTMLElement>('[data-msg]')!;
      const [lon, lat] = (form.elements.namedItem('start') as HTMLInputElement).value.split(',').map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) { msg.textContent = 'Start: longitude, latitude'; return; }
      const p = new Plane([lon, lat]);
      const t = traverse([0, 0], (form.elements.namedItem('legs') as HTMLTextAreaElement).value.split('\n'));
      if (typeof t === 'string') { msg.textContent = t; return; }
      const pts = t.pts.slice(0, t.misclosure < 0.005 ? -1 : undefined);
      const r2 = (v: number) => Math.round(v * 1000) / 1000;
      const total = perimeter(t.pts, false);
      await this.save('parcels', { type: 'Polygon', coordinates: [[...pts, pts[0]].map((q) => p.ll(q))] },
        { name: (form.elements.namedItem('name') as HTMLInputElement).value, area_m2: r2(area(pts)), perimeter_m: r2(total), misclosure_m: r2(t.misclosure) });
      close();
      // the precision ratio, as surveyors give it; under a millimetre the figure closes
      const prec = t.misclosure < 0.001 ? 'closes exactly' : `precision 1:${Math.round(total / t.misclosure).toLocaleString()}`;
      this.h.setStatus(`Parcel saved: ${r2(area(pts))} m², misclosure ${fmt(t.misclosure)} (${prec})`, 8000);
      this.h.map.easeTo({ center: [lon, lat], zoom: Math.max(this.h.map.getZoom(), 17) });
    });
  }

  // ---------------------------------------------------------------- DXF
  private async exportDxf() {
    const ids = this.h.layers().filter((l) => l.name.startsWith('Design · ')).map((l) => l.id);
    if (!ids.length) return this.h.setStatus('Nothing to export yet: draw with the Design tools first', 6000);
    try {
      const r = await this.h.backend.json<{ path: string; features: number; epsg: number }>('api/design/dxf', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layers: ids }),
      });
      window.open(this.h.backend.url(`api/design/dxf?path=${encodeURIComponent(r.path)}`), '_blank', 'noopener');
      this.h.setStatus(`DXF: ${r.features} entities in EPSG:${r.epsg} (metres), one AutoCAD layer per design layer`, 8000);
    } catch (e) {
      this.h.setStatus(`DXF export: ${e instanceof Error ? e.message : e}`, 8000);
    }
  }

  private importDxf() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.dxf';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const epsg = window.prompt('Coordinate system of the drawing (EPSG code; DXF files do not say). For example 32755 = UTM 55S, 3857 = Web Mercator, 4326 = longitude/latitude', '32755');
      if (!epsg) return;
      try {
        const r = await this.h.backend.json<{ layers: string[]; features: number }>(`api/design/dxf-import?name=${encodeURIComponent(f.name)}&epsg=${encodeURIComponent(epsg)}`, { method: 'POST', body: await f.arrayBuffer() });
        document.dispatchEvent(new CustomEvent('geospax:added', { detail: { layers: r.layers, rasters: [] } }));
        this.h.setStatus(`${f.name}: ${r.features} entities added`, 6000);
      } catch (e) {
        this.h.setStatus(`DXF import: ${e instanceof Error ? e.message : e}`, 8000);
      }
    };
    inp.click();
  }

  // ---------------------------------------------------------------- preview
  private ensurePreview() {
    const m = this.h.map;
    if (m.getSource('cad-preview')) return;
    m.addSource('cad-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addLayer({ id: 'cad-fill', type: 'fill', source: 'cad-preview', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ff7a45', 'fill-opacity': 0.15 } });
    m.addLayer({ id: 'cad-line', type: 'line', source: 'cad-preview', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#ff7a45', 'line-width': 2, 'line-dasharray': [3, 2] } });
    m.addLayer({ id: 'cad-pts', type: 'circle', source: 'cad-preview', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['case', ['==', ['get', 'k'], 'snap'], 7, 4], 'circle-color': ['case', ['==', ['get', 'k'], 'snap'], 'rgba(0,0,0,0)', '#ff7a45'], 'circle-stroke-color': ['case', ['==', ['get', 'k'], 'snap'], '#ffd166', '#ffffff'], 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'cad-dim', type: 'symbol', source: 'cad-preview', filter: ['has', 'dim'], layout: { 'text-field': ['get', 'dim'], 'text-size': 12, 'symbol-placement': 'line-center', 'text-offset': [0, -0.8], 'text-font': ['DejaVu Sans Book'] }, paint: { 'text-color': '#ffd166', 'text-halo-color': '#0b0d10', 'text-halo-width': 1.5 } });
  }

  private draw() {
    const m = this.h.map;
    // a style rebuild (a layer added or restyled) drops the preview: put it back while a tool is on
    if (!m.getSource('cad-preview')) {
      if (!this.tool && !this.picked) return;
      this.ensurePreview();
    }
    const src = m.getSource('cad-preview') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const feats: GeoJSON.Feature[] = [];
    const all = this.cursor && this.tool ? [...this.pts, this.cursor] : [...this.pts];
    if (this.picked) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.picked.coords } });
    if (this.sel?.feature.geometry) {
      feats.push({ type: 'Feature', properties: {}, geometry: this.sel.feature.geometry });
      // Move and Copy follow the pointer from the base point
      if ((this.tool === 'move' || this.tool === 'copy') && this.pts.length === 1 && this.cursor && this.plane) {
        const p = this.plane, d = this.diff(this.pts[0], this.cursor);
        feats.push({ type: 'Feature', properties: {}, geometry: mapGeometry(this.sel.feature.geometry, (q) => p.ll(translate(d)(p.xy(q)))) });
      }
    }
    if (this.tool && this.plane && all.length >= 2) {
      const xy = all.map((q) => this.plane!.xy(q));
      if (this.tool === 'rect') {
        const [a, b] = [xy[0], xy[xy.length - 1]];
        feats.push({ type: 'Feature', properties: { dim: `${fmt(Math.abs(b[0] - a[0]))} × ${fmt(Math.abs(b[1] - a[1]))}` }, geometry: { type: 'Polygon', coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a].map((q) => this.plane!.ll(q as XY))] } });
      } else if (this.tool === 'circle') {
        const r = dist(xy[0], xy[xy.length - 1]);
        feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...circle(xy[0], r), circle(xy[0], r)[0]].map((q) => this.plane!.ll(q))] } });
        feats.push({ type: 'Feature', properties: { dim: `r ${fmt(r)}` }, geometry: { type: 'LineString', coordinates: [all[0], all[all.length - 1]] } });
      } else {
        for (let i = 1; i < all.length; i++) {
          feats.push({ type: 'Feature', properties: { dim: fmt(dist(xy[i - 1], xy[i])) }, geometry: { type: 'LineString', coordinates: [all[i - 1], all[i]] } });
        }
        if (this.tool === 'polygon' && all.length >= 3) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...all, all[0]]] } });
        if (this.tool === 'road' && all.length >= 2) {
          const ring = corridor(xy, 7.5);
          feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map((q) => this.plane!.ll(q))] } });
        }
      }
    }
    for (const p of this.pts) feats.push({ type: 'Feature', properties: { k: 'v' }, geometry: { type: 'Point', coordinates: p } });
    if (this.snapped) feats.push({ type: 'Feature', properties: { k: 'snap' }, geometry: { type: 'Point', coordinates: this.snapped.at } });
    src.setData({ type: 'FeatureCollection', features: feats });
  }
}
