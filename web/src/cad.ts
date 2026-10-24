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
//   Chamfer       click near a corner, then d or d1,d2 (m): the corner cut straight (CHAMFER)
//   Stretch       two corners of a window, then a base point and a second point (or @dx,dy): every
//                 vertex inside the window moves, the rest stay (STRETCH, crossing window)
//   Align         click the feature, then source 1, target 1, source 2, target 2: moved and turned so
//                 the first pair meet and the second lies along the target direction (ALIGN)
//   List          click a feature: its type, vertices, length or perimeter, area and attributes (LIST)
//   Array         rows,columns,dx,dy (m): copies in a grid, as ARRAYRECT (dy < 0 goes south)
//   Polar array   the centre, then items[,angle] (default 360°): copies turned around it (ARRAYPOLAR)
//   Explode       a polygon becomes its outline as lines, a multi-part feature its parts (EXPLODE)
//   Join          click two lines whose ends meet (within 1 m): they become one line (JOIN)
//   Break         click a line, then the point to split it at: two lines (BREAK at point)
//   Lengthen      click near an end, then +5 / -3 (m) or =40 for the total length (LENGTHEN)
//   Divide        a number of equal parts: points on the line between them (DIVIDE)
//   Measure       a distance: a point every so many metres along the line (MEASURE), with its chainage
//   Block         click a feature (where you click is its base point), name it: saved for Insert
//   Insert        choose a block, then click where each copy goes; type an angle first to turn them
//   Offset        lines and shapes: a distance, or a click it goes through (OFFSET T)
//   Arc           start, a point on the arc, end (ARC 3P)
//   Ellipse       centre, end of one axis, then the other half-axis in m or a click (ELLIPSE)
//   Angular dim   vertex, then a point on each side: the angle between them as an arc (DIMANGULAR)
//   Leader        the point, then where the note goes, then the note (QLEADER)
//   Union         two shapes into one; Subtract cuts the second out of the first; Intersect keeps the overlap
//   Layers        Layer Properties: colour, linetype, lineweight, on/off, lock for each design layer (LAYER)
//   Lock layer    click a feature to lock or unlock its layer; Modify tools skip locked layers (LAYLCK)
//
// Distances and bearings are worked out on a local plane around the first point (metres east and
// north), which is accurate to a few centimetres over a town; the layers stay in WGS 84.
import type * as maplibregl from 'maplibre-gl';
import type { Backend, LayerInfo } from './backend';
import type { CadBlock, CadInsert } from './symbology';
import { align, breakAt, chamfer, divide, stretch, extend, fillet, join, lengthen, lengthOf, mapGeometry, measure, mirror, nearestVertex, rotate, scale, translate, trim } from './cadmodify';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type LL = [number, number];
type XY = [number, number];
export type CadTool = 'line' | 'polyline' | 'polygon' | 'rect' | 'circle' | 'arc' | 'ellipse' | 'point' | 'text' | 'dimension' | 'dimangle' | 'leader' | 'offset' | 'road' | 'insert' | 'stretch' | ModifyTool;
export type ModifyTool = 'move' | 'copy' | 'rotate' | 'scale' | 'mirror' | 'erase' | 'trim' | 'extend' | 'fillet' | 'array' | 'arraypolar' | 'divide' | 'measure' | 'block' | 'explode' | 'join' | 'break' | 'lengthen' | 'chamfer' | 'list' | 'align' | 'lock' | 'union' | 'subtract' | 'intersect';
const MODIFY: ModifyTool[] = ['move', 'copy', 'rotate', 'scale', 'mirror', 'erase', 'trim', 'extend', 'fillet', 'array', 'arraypolar', 'divide', 'measure', 'block', 'explode', 'join', 'break', 'lengthen', 'chamfer', 'list', 'align', 'lock', 'union', 'subtract', 'intersect'];
/** a saved block: a geometry in metres around its base point, and the layer and attributes it came with */
type Block = CadBlock;
/** where blocks lived before they were kept in the project: moved over the first time */
const OLD_BLOCKS_KEY = 'geospax.cad.blocks';
const isModify = (t: CadTool | null): t is ModifyTool => !!t && (MODIFY as string[]).includes(t);
/** one Design edit, as it can be undone: a feature added, changed or deleted */
type Op =
  | { kind: 'add'; layer: string; fid: number; feature: GeoJSON.Feature }
  | { kind: 'update'; layer: string; fid: number; before: GeoJSON.Geometry; after: GeoJSON.Geometry }
  | { kind: 'delete'; layer: string; fid: number; feature: GeoJSON.Feature };
/** a feature picked for Modify: its layer, id, full geometry and where it was clicked */
interface Sel { layer: string; fid: number; feature: GeoJSON.Feature; at: LL }

export interface CadHost {
  map: maplibregl.Map;
  backend: Backend;
  layers: () => LayerInfo[];
  /** a layer's data changed (re-read it and redraw) */
  changed: (id: string, info?: LayerInfo) => Promise<void>;
  /** the project's blocks (Design › Block / Insert), and saving a new list */
  blocks: () => CadBlock[];
  setBlocks: (b: CadBlock[]) => void;
  /** design layers locked against edits (Design › Lock), and saving a new list */
  locked: () => string[];
  /** where blocks were placed (DXF export writes them as block references) */
  inserts: () => CadInsert[];
  setInserts: (v: CadInsert[]) => void;
  /** a design layer's properties as the Layer Properties Manager shows them, and changing them */
  props: (id: string) => CadLayerProps | null;
  setProps: (id: string, p: Partial<CadLayerProps>) => void;
  /** a layer's hatch pattern, if it has one (DXF export draws it as lines) */
  hatch: (id: string) => string | undefined;
  setLocked: (ids: string[]) => void;
  /** show a field as labels on a layer (dimensions, annotations) */
  labels: (id: string, field: string, placement: 'point' | 'line' | 'line-center') => void;
  /** a new design layer's drafting look: colour, hollow or filled, line width */
  look: (id: string, look: CadLook) => void;
  setStatus: (t: string, ms?: number) => void;
}

/** A design layer as AutoCAD's Layer Properties Manager lists it. */
export interface CadLayerProps { color: string; width: number; dash: 'solid' | 'dashed' | 'dotted'; visible: boolean; hollow: boolean }

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

/** A closed ring `d` metres outward (negative: inward), corners mitred; the ring is given without its closing point. */
export function offsetRing(ring: XY[], d: number): XY[] {
  const n = ring.length;
  if (n < 3) return ring;
  const signed = ring.reduce((s, p, i) => { const q = ring[(i + 1) % n]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  // the right of a counter-clockwise ring is outward
  const dd = signed > 0 ? d : -d;
  const wrapped = [ring[n - 1], ...ring, ring[0]];
  return offsetLine(wrapped, dd).slice(1, n + 1);
}

/** How far `p` lies to the right (+) or left (−) of a polyline, at its nearest segment. */
export function sideDistance(pts: XY[], p: XY): number {
  let best = Infinity, sign = 1;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const d = dist(p, [a[0] + t * dx, a[1] + t * dy]);
    if (d < best) { best = d; sign = dx * (p[1] - a[1]) - dy * (p[0] - a[0]) > 0 ? -1 : 1; }
  }
  return best * sign;
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

/** ARC by three points (start, a point on it, end): the circle through them, walked from start to end
 *  the way that passes the middle point; null when the points are in a line. */
export function arc3(a: XY, b: XY, c: XY, step = 5): XY[] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sq = (p: XY) => p[0] * p[0] + p[1] * p[1];
  const o: XY = [(sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d, (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d];
  const r = dist(o, a);
  const ang = (p: XY) => Math.atan2(p[1] - o[1], p[0] - o[0]);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const t0 = ang(a), sweepC = norm(ang(c) - t0), sweepB = norm(ang(b) - t0);
  // counter-clockwise from a reaches b before c, or the arc goes the other way round
  const sweep = sweepB <= sweepC ? sweepC : sweepC - 2 * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs((sweep * 180) / Math.PI) / step));
  return Array.from({ length: n + 1 }, (_, i) => { const t = t0 + (sweep * i) / n; return [o[0] + r * Math.cos(t), o[1] + r * Math.sin(t)] as XY; });
}

/** DIMANGULAR: the arc between two sides from a vertex (the smaller angle), at 60% of the shorter side. */
export function angleArc(v: XY, a: XY, b: XY): { arc: XY[]; deg: number } | null {
  const ra = dist(v, a), rb = dist(v, b);
  if (!(ra > 0 && rb > 0)) return null;
  const t0 = Math.atan2(a[1] - v[1], a[0] - v[0]);
  let sweep = Math.atan2(b[1] - v[1], b[0] - v[0]) - t0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const r = 0.6 * Math.min(ra, rb), n = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
  const arc = Array.from({ length: n + 1 }, (_, i) => { const t = t0 + (sweep * i) / n; return [v[0] + r * Math.cos(t), v[1] + r * Math.sin(t)] as XY; });
  return { arc, deg: Math.abs((sweep * 180) / Math.PI) };
}

/** ELLIPSE from its centre, the end of one axis and the other half-axis length (m). */
export function ellipse(c: XY, end: XY, half: number, n = 72): XY[] {
  const a = dist(c, end), th = Math.atan2(end[1] - c[1], end[0] - c[0]);
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n, x = a * Math.cos(t), y = half * Math.sin(t);
    return [c[0] + x * Math.cos(th) - y * Math.sin(th), c[1] + x * Math.sin(th) + y * Math.cos(th)] as XY;
  });
}

/** the other half-axis of an ellipse: how far `p` is from the first axis */
const halfAxis = (c: XY, end: XY, p: XY) => {
  const l = dist(c, end) || 1;
  return Math.abs(((end[0] - c[0]) * (p[1] - c[1]) - (end[1] - c[1]) * (p[0] - c[0])) / l);
};

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
  private picked: { layer: string; coords: LL[]; closed: boolean } | null = null;
  private sel: Sel | null = null;
  /** Insert: the block being placed and the angle each copy is turned by */
  private inserting: { block: Block; angle: number } | null = null;
  /** undo history of this session's Design edits (one command may make several) */
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private batch: Op[] | null = null;
  /** what is typed so far, for previews (Polar array draws its copies as you type) */
  private preview = '';
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
      if (what === 'layers') return void this.layerDialog();
      if (what === 'dxf-export') return void this.exportDxf();
      if (what === 'dxf-import') return void this.importDxf();
      if (what === 'undo') return void this.undo();
      if (what === 'redo') return void this.redo();
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
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); return void this.redo();
      }
      if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || (e.key.toLowerCase() === 'u' && document.activeElement !== input)) {
        e.preventDefault();
        // a point being placed goes first; with none, the last saved edit is undone
        if (this.pts.length) { this.pts.pop(); return this.draw(); }
        return void this.undo();
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
    this.preview = '';
    const m = this.h.map;
    m.doubleClickZoom.disable();
    m.on('mousemove', this.onMove);
    m.on('click', this.onClick);
    m.on('dblclick', this.onDbl);
    m.getCanvas().style.cursor = 'crosshair';
    this.ensurePreview();
    if (tool === 'insert') {
      const blocks = this.loadBlocks();
      if (!blocks.length) {
        this.stop();
        return this.h.setStatus('No blocks yet: make one with Block (click a feature, give it a name)', 6000);
      }
      const names = blocks.map((b) => b.name);
      const pick = window.prompt(`Insert which block?\n${names.join(', ')}`, names[names.length - 1]);
      const block = blocks.find((b) => b.name === pick?.trim());
      if (!block) {
        this.stop();
        return this.h.setStatus(pick ? `No block called "${pick}"` : 'Insert cancelled', 4000);
      }
      this.inserting = { block, angle: 0 };
    }
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
    this.inserting = null;
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
      case 'arc': return n === 0 ? 'Arc: start point' : n === 1 ? 'Arc: a point on the arc' : 'Arc: end point';
      case 'ellipse': return n === 0 ? 'Ellipse: centre' : n === 1 ? 'Ellipse: end of one axis' : 'Ellipse: other half-axis in m, or click';
      case 'point': return 'Point: click or type lon,lat';
      case 'text': return 'Text: click where it goes';
      case 'dimension': return n === 0 ? 'Dimension: first point' : 'Dimension: second point';
      case 'dimangle': return n === 0 ? 'Angular dimension: the vertex' : n === 1 ? 'A point on the first side' : 'A point on the second side';
      case 'leader': return n === 0 ? 'Leader: the point it points at' : 'Leader: where the note goes';
      case 'offset': return this.picked ? `Offset: distance in m (${this.picked.closed ? '+ outward, − inward' : '+ right, − left'}), or click a point it goes through` : 'Offset: click the line or shape to copy';
      case 'union': case 'subtract': case 'intersect': {
        const verb = { union: 'Union: joins two shapes into one', subtract: 'Subtract: cuts the second shape out of the first', intersect: 'Intersect: keeps where two shapes overlap' }[this.tool];
        return !this.sel ? `${verb} · click the first shape` : 'Click the second shape (same layer)';
      }
      case 'lock': return 'Lock: click a feature to lock or unlock its layer';
      case 'road': return n < 2 ? 'Road: centreline points · Enter when done' : 'Road: next centreline point · Enter, then the width';
      case 'move': case 'copy': return !this.sel ? `${this.tool === 'move' ? 'Move' : 'Copy'}: click the feature` : n === 0 ? 'Base point' : 'Second point (or @dx,dy in m)';
      case 'rotate': return !this.sel ? 'Rotate: click the feature' : n === 0 ? 'Base point' : 'Angle in degrees (counter-clockwise), or click';
      case 'scale': return !this.sel ? 'Scale: click the feature' : n === 0 ? 'Base point' : 'Scale factor (2 = twice the size)';
      case 'mirror': return !this.sel ? 'Mirror: click the feature' : n === 0 ? 'First point of the mirror line' : 'Second point of the mirror line';
      case 'erase': return 'Erase: click the feature to delete';
      case 'trim': return 'Trim: click the part of a line to cut away';
      case 'extend': return 'Extend: click near the end of a line';
      case 'fillet': return !this.sel ? 'Fillet: click near a corner' : 'Fillet radius in m';
      case 'stretch': return n === 0 ? 'Stretch: first corner of the window' : n === 1 ? 'Opposite corner of the window' : n === 2 ? 'Base point' : 'Second point (or @dx,dy in m)';
      case 'chamfer': return !this.sel ? 'Chamfer: click near a corner' : 'Distance in m, or d1,d2 along each leg';
      case 'array': return !this.sel ? 'Array: click the feature' : 'rows,columns,dx,dy in m (e.g. 2,10,20,-36)';
      case 'divide': return !this.sel ? 'Divide: click the line' : 'Number of equal parts';
      case 'arraypolar': return !this.sel ? 'Polar array: click the feature' : n === 0 ? 'Centre of the array' : 'items[,angle to fill] (e.g. 8 or 6,180)';
      case 'block': return 'Block: click the feature; the click is its base point';
      case 'list': return 'List: click a feature to describe it';
      case 'align': return !this.sel ? 'Align: click the feature' : ['First source point', 'First target point', 'Second source point', 'Second target point'][Math.min(n, 3)];
      case 'explode': return 'Explode: click a polygon or multi-part feature';
      case 'break': return !this.sel ? 'Break: click the line' : 'Point to break it at';
      case 'lengthen': return !this.sel ? 'Lengthen: click near the end to change' : '+metres, -metres, or =total length';
      case 'join': return !this.sel ? 'Join: click the first line' : 'Join: click the line to join to it';
      case 'insert': return this.inserting ? `Insert ${this.inserting.block.name}: click where it goes (angle ${this.inserting.angle}°; type another to turn it) · Enter ends` : 'Insert: no blocks yet';
      case 'measure': return !this.sel ? 'Measure: click the line (near the end to start from)' : 'Distance between points in m';
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
    input.addEventListener('input', () => { this.preview = input.value; this.draw(); });
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
    if (this.tool === 'offset' && this.picked) return this.offsetThrough(p);
    if (isModify(this.tool) && !this.sel) return this.pickFeature(e);
    if (this.tool === 'join' && this.sel) return this.doJoin(e);
    if ((this.tool === 'union' || this.tool === 'subtract' || this.tool === 'intersect') && this.sel) return this.doBoolean(e);
    await this.add(p);
  }

  private pick(e: maplibregl.MapMouseEvent) {
    const R = 6;
    const f = this.h.map.queryRenderedFeatures([[e.point.x - R, e.point.y - R], [e.point.x + R, e.point.y + R]])
      .find((x) => (x.geometry.type === 'LineString' || x.geometry.type === 'Polygon') && !x.layer.id.startsWith('cad-'));
    if (!f) return this.h.setStatus('Click on a line or shape to offset', 4000);
    const closed = f.geometry.type === 'Polygon';
    const coords = (closed ? (f.geometry as GeoJSON.Polygon).coordinates[0].slice(0, -1) : (f.geometry as GeoJSON.LineString).coordinates) as LL[];
    this.picked = { layer: f.layer.source, coords, closed };
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
      case 'line': case 'dimension': case 'rect': case 'leader': if (n === 2) await this.commit(); break;
      case 'dimangle': if (n === 3) await this.commit(); break;
      case 'circle': if (n === 2) await this.commit(); break;
      case 'arc': case 'ellipse': if (n === 3) await this.commit(); break;
      case 'insert': await this.placeBlock(p); break;
      case 'break': if (n === 1) await this.doBreak(p); break;
      case 'stretch': if (n === 4) await this.doStretch(); break;
      case 'align': if (n === 4) {
        const [s1, d1, s2, d2] = this.pts.map((q) => this.plane!.xy(q));
        await this.transform(align(s1, d1, s2, d2), false);
      } break;
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
    if (this.tool === 'array' && this.sel) return this.doArray(s);
    if (this.tool === 'lengthen' && this.sel) return this.doLengthen(s);
    if (this.tool === 'chamfer' && this.sel) return this.doChamfer(s);
    if (this.tool === 'arraypolar' && this.sel && this.pts.length === 1) return this.doPolar(s);
    if (this.tool === 'insert' && this.inserting && /^-?\d+(\.\d+)?$/.test(s)) {
      this.inserting.angle = Number(s);
      return this.renderBar();
    }
    if ((this.tool === 'divide' || this.tool === 'measure') && this.sel) return this.doDivide(Number(s));
    if (this.sel && /^-?\d+(\.\d+)?$/.test(s)) {
      const v = Number(s);
      if (this.tool === 'rotate' && this.pts.length === 1) return this.transform(rotate(this.plane!.xy(this.pts[0]), v), false);
      if (this.tool === 'scale' && this.pts.length === 1) return v > 0 ? this.transform(scale(this.plane!.xy(this.pts[0]), v), false) : this.h.setStatus('The factor must be above 0', 4000);
      if (this.tool === 'fillet') return this.doFillet(v);
    }
    if (this.tool === 'ellipse' && this.pts.length === 2 && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0) {
      const p = this.plane!, c = p.xy(this.pts[0]), e = p.xy(this.pts[1]), l = dist(c, e) || 1;
      // a point the typed distance off the first axis stands in for the click
      return this.add(p.ll([c[0] - ((e[1] - c[1]) / l) * Number(s), c[1] + ((e[0] - c[0]) / l) * Number(s)]));
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
    if (this.tool === 'insert') return this.stop();
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
    const feature: GeoJSON.Feature = { type: 'Feature', geometry, properties };
    const r = await this.h.backend.json<{ fid: number; layer: LayerInfo }>(`api/layers/${encodeURIComponent(id)}/features`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(feature),
    });
    this.record({ kind: 'add', layer: id, fid: r.fid, feature });
    await this.h.changed(id, r.layer);
  }

  // ---------------------------------------------------------------- undo
  /** an edit into the open batch (one command), or as its own step */
  private record(op: Op) {
    if (this.batch) this.batch.push(op);
    else this.undoStack.push([op]);
    this.redoStack = [];
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  private api<T>(url: string, method: string, body?: unknown) {
    return this.h.backend.json<T>(url, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  }

  /** apply one op backwards (undo) or forwards (redo); a re-added feature gets a new id */
  private async play(op: Op, back: boolean): Promise<Op> {
    const url = `api/layers/${encodeURIComponent(op.layer)}/features`;
    const re = async (f: GeoJSON.Feature) => (await this.api<{ fid: number }>(url, 'POST', f)).fid;
    if (op.kind === 'update') {
      await this.api(`${url}/${op.fid}`, 'PUT', { geometry: back ? op.before : op.after });
      return op;
    }
    const removing = (op.kind === 'add') === back;
    if (removing) {
      await this.api(`${url}/${op.fid}`, 'DELETE');
      return op;
    }
    return { ...op, fid: await re(op.feature) };
  }

  private async replay(from: Op[][], to: Op[][], back: boolean, word: string) {
    const step = from.pop();
    if (!step) return this.h.setStatus(`Nothing to ${word.toLowerCase()}`, 3000);
    const done: Op[] = [];
    try {
      for (const op of back ? [...step].reverse() : step) {
        const now = await this.play(op, back);
        // a feature added back gets a new id: every older and newer step must follow it
        if (now.fid !== op.fid) this.remap(op.layer, op.fid, now.fid);
        done.push(now);
      }
    } catch (err) {
      this.h.setStatus(`${word} failed: ${err instanceof Error ? err.message : err}`, 8000);
    }
    to.push(back ? done.reverse() : done);
    for (const l of new Set(step.map((o) => o.layer))) await this.h.changed(l);
    this.h.setStatus(`${word}: ${step.length} change${step.length === 1 ? '' : 's'}`, 3000);
  }

  private remap(layer: string, from: number, to: number) {
    for (const st of [this.undoStack, this.redoStack]) for (const step of st) for (const o of step) if (o.layer === layer && o.fid === from) o.fid = to;
  }

  undo() {
    return this.replay(this.undoStack, this.redoStack, true, 'Undo');
  }

  redo() {
    return this.replay(this.redoStack, this.undoStack, false, 'Redo');
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
        case 'dimangle': {
          const a = angleArc(xy[0], xy[1], xy[2]);
          if (!a) { this.h.setStatus('The sides must leave the vertex', 5000); break; }
          await this.save('dimensions', { type: 'LineString', coordinates: a.arc.map((q) => p.ll(q)) }, { label: `${a.deg.toFixed(a.deg < 10 ? 2 : 1)}°`, length_m: r2(perimeter(a.arc, false)) });
          break;
        }
        case 'leader': {
          const t = window.prompt('Note');
          if (!t) break;
          // an arrowhead at the tip: two short barbs back along the leader
          const [tip, to] = xy, l = dist(tip, to) || 1, u: XY = [(to[0] - tip[0]) / l, (to[1] - tip[1]) / l], s = Math.min(1.5, l / 4);
          const barb = (k: number): XY => [tip[0] + s * (u[0] * 0.94 - k * u[1] * 0.34), tip[1] + s * (u[1] * 0.94 + k * u[0] * 0.34)];
          this.batch = [];
          await this.save('dimensions', { type: 'LineString', coordinates: [to, tip].map((q) => p.ll(q)) }, { label: t, length_m: r2(l) });
          await this.save('dimensions', { type: 'LineString', coordinates: [barb(1), tip, barb(-1)].map((q) => p.ll(q)) }, { label: '', length_m: 0 });
          if (this.batch.length) this.undoStack.push(this.batch);
          this.batch = null;
          break;
        }
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
        case 'arc': {
          const a = arc3(xy[0], xy[1], xy[2]);
          if (!a) { this.h.setStatus('The three points are in a line: no arc through them', 5000); break; }
          await this.save('lines', { type: 'LineString', coordinates: a.map((q) => p.ll(q)) }, { kind: 'arc', length_m: r2(perimeter(a, false)) });
          break;
        }
        case 'ellipse': {
          const [c, e] = xy, b = halfAxis(c, e, xy[2]), a = dist(c, e);
          if (!(a > 0 && b > 0)) { this.h.setStatus('An ellipse needs two axes longer than 0', 5000); break; }
          const el = ellipse(c, e, b);
          // Ramanujan's perimeter
          const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
          await this.save('polygons', { type: 'Polygon', coordinates: [ring(el)] }, { kind: `ellipse ${r2(2 * a)}×${r2(2 * b)} m`, area_m2: r2(Math.PI * a * b), perimeter_m: r2(per) });
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
    // the road and its centreline are one step for Undo
    this.batch = [];
    try {
      await this.save('roads', { type: 'Polygon', coordinates: [[...ring, ring[0]].map((q) => p.ll(q))] }, { name: 'road', width_m: width, length_m: r2(perimeter(xy, false)), area_m2: r2(area(ring)) });
      await this.save('lines', { type: 'LineString', coordinates: this.pts }, { kind: 'road centreline', length_m: r2(perimeter(xy, false)) });
    } finally {
      if (this.batch.length) this.undoStack.push(this.batch);
      this.batch = null;
    }
    this.h.setStatus(`Road saved: ${fmt(perimeter(xy, false))} long, ${width} m wide`, 5000);
    this.pts = [];
    this.plane = null;
    this.renderBar();
    this.draw();
  }

  private async doOffset(d: number) {
    const pk = this.picked;
    if (!pk || !Number.isFinite(d) || d === 0) return this.h.setStatus(`Type the offset distance in m (${pk?.closed ? '+ outward, − inward' : '+ right, − left'}), or click a point it goes through`, 5000);
    const p = new Plane(pk.coords[0]);
    const xy = pk.coords.map((q) => p.xy(q));
    if (pk.closed) {
      const ring = offsetRing(xy, d).map((q) => p.ll(q));
      const r = [...ring.map((q) => p.xy(q))];
      await this.save('polygons', { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, { kind: `offset ${d} m`, area_m2: Math.round(area(r) * 100) / 100, perimeter_m: Math.round(perimeter(r, true) * 100) / 100 });
      this.h.setStatus(`Shape ${Math.abs(d)} m ${d > 0 ? 'outside' : 'inside'} saved`, 4000);
    } else {
      const out = offsetLine(xy, d).map((q) => p.ll(q));
      await this.save('lines', { type: 'LineString', coordinates: out }, { kind: `offset ${d} m` });
      this.h.setStatus(`Parallel line ${Math.abs(d)} m to the ${d > 0 ? 'right' : 'left'} saved`, 4000);
    }
    this.picked = null;
    this.renderBar();
    this.draw();
  }

  /** Offset › Through (AutoCAD OFFSET T): the distance is wherever the click is */
  private async offsetThrough(at: LL) {
    const pk = this.picked!;
    const p = new Plane(pk.coords[0]);
    const xy = pk.coords.map((q) => p.xy(q));
    const q = p.xy(at);
    let d = sideDistance(pk.closed ? [...xy, xy[0]] : xy, q);
    if (pk.closed) {
      const n = xy.length;
      const signed = xy.reduce((s, a, i) => { const b = xy[(i + 1) % n]; return s + a[0] * b[1] - b[0] * a[1]; }, 0);
      d = signed > 0 ? d : -d;
    }
    await this.doOffset(Math.round(d * 1000) / 1000);
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
    if (this.tool === 'lock') return this.toggleLock(layer);
    if (this.h.locked().includes(layer)) return this.h.setStatus(`${this.layerName(layer)} is locked: unlock it with Design › Lock`, 5000);
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
    if (this.tool === 'block') return this.makeBlock();
    if (this.tool === 'explode') return this.doExplode();
    if (this.tool === 'list') return this.doList();
    if (this.tool === 'trim' || this.tool === 'extend') return this.doTrimExtend();
    this.renderBar();
    this.draw();
  }

  private layerName(id: string) {
    return this.h.layers().find((l) => l.id === id)?.name ?? id;
  }

  /** Lock (AutoCAD LAYLCK / LAYULK): a locked layer is shown and snapped to but not changed */
  private toggleLock(layer: string) {
    const locked = this.h.locked();
    const on = !locked.includes(layer);
    this.h.setLocked(on ? [...locked, layer] : locked.filter((l) => l !== layer));
    this.h.setStatus(`${this.layerName(layer)} ${on ? 'locked: Modify tools leave it alone' : 'unlocked'}`, 4000);
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
    const batch: Op[] = [];
    const add = async (g: GeoJSON.Geometry) => {
      const feature: GeoJSON.Feature = { type: 'Feature', geometry: g, properties: props };
      const r = await this.api<{ fid: number }>(url, 'POST', feature);
      batch.push({ kind: 'add', layer: s.layer, fid: r.fid, feature });
    };
    try {
      if (copy) await add(geometry);
      else {
        await this.api(`${url}/${s.fid}`, 'PUT', { geometry });
        batch.push({ kind: 'update', layer: s.layer, fid: s.fid, before: s.feature.geometry, after: geometry });
      }
      for (const g of extra ?? []) await add(g);
      await this.h.changed(s.layer);
      this.h.setStatus(`${this.tool} done · Ctrl+Z undoes it`, 3000);
    } catch (err) {
      this.h.setStatus(`Could not save: ${err instanceof Error ? err.message : err}`, 8000);
    }
    if (batch.length) {
      this.undoStack.push(batch);
      this.redoStack = [];
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
      this.record({ kind: 'delete', layer: s.layer, fid: s.fid, feature: { type: 'Feature', geometry: s.feature.geometry, properties: Object.fromEntries(Object.entries(s.feature.properties ?? {}).filter(([k]) => !/^(fid|ogc_fid)$/i.test(k))) } });
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

  /** the project's blocks; ones saved in this browser by an older version are moved into the project */
  private loadBlocks(): Block[] {
    const blocks = this.h.blocks();
    try {
      const old = JSON.parse(localStorage.getItem(OLD_BLOCKS_KEY) ?? '[]') as Block[];
      if (old.length) {
        const merged = [...blocks, ...old.filter((o) => !blocks.some((b) => b.name === o.name))];
        this.h.setBlocks(merged);
        localStorage.removeItem(OLD_BLOCKS_KEY);
        return merged;
      }
    } catch { /* no browser storage */ }
    return blocks;
  }

  /** LIST: what the picked feature is, measured on the local plane, shown under the command line */
  private doList() {
    const s = this.sel!, p = this.plane!, g = s.feature.geometry;
    const len = (l: LL[]) => l.reduce((t, q, i) => (i ? t + dist(p.xy(l[i - 1]), p.xy(q)) : 0), 0);
    const ringArea = (r: LL[]) => Math.abs(area(r.map((q) => p.xy(q))));
    let verts = 0, length = 0, ar = 0;
    const lines = this.lines(g);
    for (const l of lines) { verts += l.length; length += len(l); }
    if (g.type === 'Polygon') ar = ringArea(g.coordinates[0] as LL[]) - (g.coordinates.slice(1) as LL[][]).reduce((t, r) => t + ringArea(r), 0);
    if (g.type === 'MultiPolygon') ar = (g.coordinates as LL[][][]).reduce((t, poly) => t + ringArea(poly[0]) - poly.slice(1).reduce((u, r) => u + ringArea(r), 0), 0);
    if (g.type === 'Point' || g.type === 'MultiPoint') verts = g.type === 'Point' ? 1 : g.coordinates.length;
    const attrs = Object.entries(s.feature.properties ?? {}).filter(([, v]) => v !== null && v !== '').slice(0, 6).map(([k, v]) => `${k}=${v}`).join(', ');
    const where = g.type === 'Point' ? ` at ${(g.coordinates[0] as number).toFixed(6)}, ${(g.coordinates[1] as number).toFixed(6)}` : '';
    const parts = [`${g.type} in ${s.layer} #${s.fid}${where}`, `${verts} vertices`];
    if (/Line/.test(g.type)) parts.push(`length ${fmt(length)}`);
    if (/Polygon/.test(g.type)) parts.push(`perimeter ${fmt(length)}`, `area ${ar >= 10000 ? `${(ar / 10000).toFixed(4)} ha` : `${ar.toFixed(2)} m²`}`);
    if (attrs) parts.push(attrs);
    this.h.setStatus(parts.join(' · '), 15000);
    this.sel = null;
    this.draw();
  }

  /** EXPLODE: a polygon's rings into Design · lines (the polygon removed), or a multi-part feature
   *  into one feature per part in its own layer */
  private async doExplode() {
    const s = this.sel!, g = s.feature.geometry;
    const url = (l: string) => `api/layers/${encodeURIComponent(l)}/features`;
    const props = Object.fromEntries(Object.entries(s.feature.properties ?? {}).filter(([k]) => !/^(fid|ogc_fid)$/i.test(k)));
    let parts: { layer: string; geometry: GeoJSON.Geometry; properties: Record<string, unknown> }[] = [];
    if (g.type === 'Polygon') {
      const lines = await this.layerFor('lines');
      parts = (g.coordinates as LL[][]).map((r) => ({ layer: lines, geometry: { type: 'LineString', coordinates: r }, properties: { kind: 'exploded outline' } }));
    } else if (g.type === 'MultiPolygon') parts = (g.coordinates as LL[][][]).map((c) => ({ layer: s.layer, geometry: { type: 'Polygon', coordinates: c }, properties: props }));
    else if (g.type === 'MultiLineString') parts = (g.coordinates as LL[][]).map((c) => ({ layer: s.layer, geometry: { type: 'LineString', coordinates: c }, properties: props }));
    else if (g.type === 'MultiPoint') parts = (g.coordinates as LL[]).map((c) => ({ layer: s.layer, geometry: { type: 'Point', coordinates: c }, properties: props }));
    if (!parts.length) {
      this.sel = null;
      this.draw();
      return this.h.setStatus(`A ${g.type} has nothing to explode`, 4000);
    }
    const step: Op[] = [];
    try {
      for (const part of parts) {
        const feature: GeoJSON.Feature = { type: 'Feature', geometry: part.geometry, properties: part.properties };
        const r = await this.api<{ fid: number }>(url(part.layer), 'POST', feature);
        step.push({ kind: 'add', layer: part.layer, fid: r.fid, feature });
      }
      await this.api(`${url(s.layer)}/${s.fid}`, 'DELETE');
      step.push({ kind: 'delete', layer: s.layer, fid: s.fid, feature: { type: 'Feature', geometry: g, properties: props } });
      for (const l of new Set(parts.map((x) => x.layer).concat(s.layer))) await this.h.changed(l);
      this.h.setStatus(`Exploded into ${parts.length} part${parts.length === 1 ? '' : 's'}`, 4000);
    } catch (err) {
      this.h.setStatus(`Could not explode: ${err instanceof Error ? err.message : err}`, 8000);
    }
    if (step.length) {
      this.undoStack.push(step);
      this.redoStack = [];
    }
    this.sel = null;
    this.draw();
  }

  private selLine(): XY[] | null {
    const g = this.sel!.feature.geometry, p = this.plane!;
    return g.type === 'LineString' ? (g.coordinates as LL[]).map((q) => p.xy(q)) : null;
  }

  private async doBreak(at: LL) {
    const line = this.selLine(), p = this.plane!;
    if (!line) return this.h.setStatus('Break works on single lines', 4000);
    const parts = breakAt(line, p.xy(at));
    if (!parts) return this.h.setStatus('That is at the end of the line: pick a point along it', 4000);
    const [a, b] = parts.map((l) => ({ type: 'LineString', coordinates: l.map((q) => p.ll(q)) }) as GeoJSON.Geometry);
    return this.write(a, false, [b]);
  }

  private async doLengthen(v: string) {
    const line = this.selLine(), p = this.plane!;
    if (!line) return this.h.setStatus('Lengthen works on single lines', 4000);
    const m = v.match(/^([+=-]?)(\d+(?:\.\d+)?)$/);
    if (!m) return this.h.setStatus('Type +5, -3 or =40 (metres)', 5000);
    const L = line.reduce((t, q, i) => (i ? t + Math.hypot(q[0] - line[i - 1][0], q[1] - line[i - 1][1]) : 0), 0);
    const delta = m[1] === '=' ? Number(m[2]) - L : m[1] === '-' ? -Number(m[2]) : Number(m[2]);
    const out = lengthen(line, p.xy(this.sel!.at), delta);
    if (!out) return this.h.setStatus('That would leave nothing of the line', 4000);
    return this.write({ type: 'LineString', coordinates: out.map((q) => p.ll(q)) }, false);
  }

  /** JOIN: the second line clicked is added onto the first (ends within 1 m) and removed */
  private async doJoin(e: maplibregl.MapMouseEvent) {
    const a = this.sel!;
    const R = 6;
    const hit = this.h.map.queryRenderedFeatures([[e.point.x - R, e.point.y - R], [e.point.x + R, e.point.y + R]])
      .find((x) => x.layer.id.includes('#') && !x.layer.id.startsWith('cad-') && x.layer.id.replace(/#.*$/, '') === a.layer && Number(x.id) !== a.fid);
    if (!hit) return this.h.setStatus('Click another line of the same layer', 4000);
    const fid = Number(hit.id);
    const b = await this.h.backend.json<GeoJSON.Feature>(`api/layers/${encodeURIComponent(a.layer)}/features/${fid}`);
    if (a.feature.geometry.type !== 'LineString' || b.geometry?.type !== 'LineString') {
      this.sel = null;
      this.draw();
      return this.h.setStatus('Join works on two single lines', 4000);
    }
    const p = this.plane!;
    const out = join((a.feature.geometry.coordinates as LL[]).map((q) => p.xy(q)), (b.geometry.coordinates as LL[]).map((q) => p.xy(q)), 1);
    if (!out) return this.h.setStatus('Their ends are more than 1 m apart: Extend or Fillet them first', 5000);
    const url = `api/layers/${encodeURIComponent(a.layer)}/features`;
    const geometry: GeoJSON.Geometry = { type: 'LineString', coordinates: out.map((q) => p.ll(q)) };
    const bProps = Object.fromEntries(Object.entries(b.properties ?? {}).filter(([k]) => !/^(fid|ogc_fid)$/i.test(k)));
    try {
      await this.api(`${url}/${a.fid}`, 'PUT', { geometry });
      await this.api(`${url}/${fid}`, 'DELETE');
      this.undoStack.push([
        { kind: 'update', layer: a.layer, fid: a.fid, before: a.feature.geometry, after: geometry },
        { kind: 'delete', layer: a.layer, fid, feature: { type: 'Feature', geometry: b.geometry, properties: bProps } },
      ]);
      this.redoStack = [];
      await this.h.changed(a.layer);
      this.h.setStatus('Joined into one line', 3000);
    } catch (err) {
      this.h.setStatus(`Could not join: ${err instanceof Error ? err.message : err}`, 8000);
    }
    this.sel = null;
    this.plane = null;
    this.renderBar();
    this.draw();
  }

  /** UNION / SUBTRACT / INTERSECT (AutoCAD regions): the first shape becomes the result, the second is used up */
  private async doBoolean(e: maplibregl.MapMouseEvent) {
    const a = this.sel!, op = this.tool as 'union' | 'subtract' | 'intersect';
    const R = 6;
    const hit = this.h.map.queryRenderedFeatures([[e.point.x - R, e.point.y - R], [e.point.x + R, e.point.y + R]])
      .find((x) => x.layer.id.includes('#') && !x.layer.id.startsWith('cad-') && x.layer.id.replace(/#.*$/, '') === a.layer && Number(x.id) !== a.fid);
    if (!hit) return this.h.setStatus('Click another shape of the same layer', 4000);
    const fid = Number(hit.id);
    const b = await this.h.backend.json<GeoJSON.Feature>(`api/layers/${encodeURIComponent(a.layer)}/features/${fid}`);
    const areaish = (g?: GeoJSON.Geometry | null) => g?.type === 'Polygon' || g?.type === 'MultiPolygon';
    if (!areaish(a.feature.geometry) || !areaish(b.geometry)) {
      this.sel = null;
      this.draw();
      return this.h.setStatus(`${op[0].toUpperCase()}${op.slice(1)} works on two shapes (polygons)`, 4000);
    }
    const url = `api/layers/${encodeURIComponent(a.layer)}/features`;
    const bProps = Object.fromEntries(Object.entries(b.properties ?? {}).filter(([k]) => !/^(fid|ogc_fid)$/i.test(k)));
    try {
      const r = await this.api<{ geometry: GeoJSON.Geometry | null }>('api/design/boolean', 'POST', { op, a: a.feature.geometry, b: b.geometry });
      if (!r.geometry) {
        this.h.setStatus(op === 'intersect' ? 'The shapes do not overlap: nothing to keep' : 'Nothing would be left of the first shape', 5000);
      } else {
        await this.api(`${url}/${a.fid}`, 'PUT', { geometry: r.geometry });
        await this.api(`${url}/${fid}`, 'DELETE');
        this.undoStack.push([
          { kind: 'update', layer: a.layer, fid: a.fid, before: a.feature.geometry, after: r.geometry },
          { kind: 'delete', layer: a.layer, fid, feature: { type: 'Feature', geometry: b.geometry, properties: bProps } },
        ]);
        this.redoStack = [];
        await this.h.changed(a.layer);
        this.h.setStatus(`${op[0].toUpperCase()}${op.slice(1)} done · Ctrl+Z undoes it`, 3000);
      }
    } catch (err) {
      this.h.setStatus(`Could not ${op}: ${err instanceof Error ? err.message : err}`, 8000);
    }
    this.sel = null;
    this.plane = null;
    this.renderBar();
    this.draw();
  }

  /** BLOCK: the picked feature in metres around the click, kept in the project under a name */
  private makeBlock() {
    const s = this.sel!, p = this.plane!;
    const name = window.prompt('Block name (e.g. house 10x12)', '')?.trim();
    if (!name) {
      this.sel = null;
      this.draw();
      return this.h.setStatus('Block cancelled', 3000);
    }
    const props = Object.fromEntries(Object.entries(s.feature.properties ?? {}).filter(([k]) => !/^(fid|ogc_fid)$/i.test(k)));
    // the plane is centred on the click, so plane metres are offsets from the base point
    const geometry = mapGeometry(s.feature.geometry, (q) => p.xy(q));
    const blocks = this.loadBlocks().filter((b) => b.name !== name);
    blocks.push({ name, layer: s.layer, geometry, properties: props });
    this.h.setBlocks(blocks);
    this.h.setStatus(`Block "${name}" saved (${blocks.length} in all): Insert places it`, 5000);
    this.sel = null;
    this.draw();
  }

  /** INSERT: one copy of the block with its base point at p, turned by the chosen angle */
  private async placeBlock(at: LL) {
    const ins = this.inserting!;
    const p = new Plane(at);
    const turn = rotate([0, 0], ins.angle);
    const geometry = mapGeometry(ins.block.geometry, (q) => p.ll(turn(q)));
    try {
      const feature: GeoJSON.Feature = { type: 'Feature', geometry, properties: ins.block.properties };
      const r = await this.api<{ fid: number }>(`api/layers/${encodeURIComponent(ins.block.layer)}/features`, 'POST', feature);
      this.record({ kind: 'add', layer: ins.block.layer, fid: r.fid, feature });
      this.h.setInserts([...this.h.inserts(), { block: ins.block.name, layer: ins.block.layer, fid: r.fid, at, angle: ins.angle, geometry }]);
      await this.h.changed(ins.block.layer);
    } catch (err) {
      this.h.setStatus(`Could not insert (was its layer removed?): ${err instanceof Error ? err.message : err}`, 8000);
    }
    this.pts = [];
    this.plane = null;
  }

  /** DIVIDE / MEASURE: points along the picked line, saved to Design · points with their chainage */
  private async doDivide(v: number) {
    const s = this.sel!, p = this.plane!;
    const g = s.feature.geometry;
    const coords = g.type === 'LineString' ? (g.coordinates as LL[]) : g.type === 'Polygon' ? (g.coordinates[0] as LL[]) : null;
    if (!coords) return this.h.setStatus(`${this.tool === 'divide' ? 'Divide' : 'Measure'} works on lines and polygon outlines`, 5000);
    let line = coords.map((q) => p.xy(q));
    // MEASURE starts from the end nearer the click, as AutoCAD does
    const at = p.xy(s.at);
    if (this.tool === 'measure' && Math.hypot(line[line.length - 1][0] - at[0], line[line.length - 1][1] - at[1]) < Math.hypot(line[0][0] - at[0], line[0][1] - at[1])) line = [...line].reverse();
    const ok = this.tool === 'divide' ? Number.isInteger(v) && v >= 2 && v <= 1000 : v > 0 && lengthOf(line) / v <= 5000;
    if (!ok) return this.h.setStatus(this.tool === 'divide' ? 'Type a whole number of parts, 2 to 1000' : 'Type a distance in m (at most 5000 points)', 5000);
    const pts = this.tool === 'divide' ? divide(line, v) : measure(line, v);
    if (!pts.length) return this.h.setStatus('The line is shorter than that distance', 4000);
    const L = lengthOf(line);
    this.batch = [];
    try {
      for (let i = 0; i < pts.length; i++) {
        const chain = this.tool === 'divide' ? (L * (i + 1)) / v : v * (i + 1);
        await this.save('points', { type: 'Point', coordinates: p.ll(pts[i]) }, { kind: this.tool, name: `${(Math.round(chain * 100) / 100).toFixed(2)} m` });
      }
    } finally {
      if (this.batch.length) this.undoStack.push(this.batch);
      this.batch = null;
    }
    this.h.setStatus(`${pts.length} points along ${fmt(L)}`, 4000);
    this.sel = null;
    this.renderBar();
    this.draw();
  }

  /** ARRAYPOLAR: n items around the centre over the fill angle (the original is the first) */
  /** the copies a Polar array of "items[,angle]" makes, or why it cannot */
  private polarCopies(v: string): GeoJSON.Geometry[] | string {
    const m = v.replace(/\s+/g, '').match(/^(\d+)(?:,(-?\d+(?:\.\d+)?))?$/);
    if (!m) return 'Type items, or items,angle (e.g. 8 or 6,180)';
    const n = Number(m[1]), fill = m[2] === undefined ? 360 : Number(m[2]);
    if (n < 2 || n > 1000 || fill === 0) return 'Between 2 and 1000 items, over a non-zero angle';
    const s = this.sel!, p = this.plane!, c = p.xy(this.pts[0]);
    // a full circle spaces n items evenly; a part circle puts the last item at the end of the angle
    const step = Math.abs(fill) >= 360 ? fill / n : fill / (n - 1);
    const copies: GeoJSON.Geometry[] = [];
    for (let i = 1; i < n; i++) copies.push(mapGeometry(s.feature.geometry, (q) => p.ll(rotate(c, step * i)(p.xy(q)))));
    return copies;
  }

  private async doPolar(v: string) {
    const copies = this.polarCopies(v);
    if (typeof copies === 'string') return this.h.setStatus(copies, 5000);
    this.preview = '';
    const [first, ...rest] = copies;
    return this.write(first, true, rest);
  }

  /** ARRAYRECT: copies of the picked feature on a grid, the original in the first cell */
  private async doArray(v: string) {
    const m = v.match(/^(\d+),(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!m) return this.h.setStatus('Type rows,columns,dx,dy (e.g. 2,10,20,-36)', 5000);
    const [rows, cols, dx, dy] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (rows < 1 || cols < 1 || rows * cols > 2000) return this.h.setStatus('Between 1 and 2000 copies in all', 5000);
    const s = this.sel!, p = this.plane!;
    const copies: GeoJSON.Geometry[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (r || c) copies.push(mapGeometry(s.feature.geometry, (q) => p.ll(translate([c * dx, r * dy])(p.xy(q)))));
    if (!copies.length) return this.h.setStatus('Nothing to copy (1 row, 1 column)', 4000);
    const [first, ...rest] = copies;
    return this.write(first, true, rest);
  }

  /** STRETCH: every feature in view with a vertex inside the window, those vertices moved */
  private async doStretch() {
    const p = this.plane!;
    const [a, b, base, to] = this.pts.map((q) => p.xy(q));
    const box: [number, number, number, number] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const d: XY = [to[0] - base[0], to[1] - base[1]];
    const m = this.h.map;
    const [pa, pb] = [m.project(this.pts[0]), m.project(this.pts[1])];
    const hits = m.queryRenderedFeatures([[Math.min(pa.x, pb.x), Math.min(pa.y, pb.y)], [Math.max(pa.x, pb.x), Math.max(pa.y, pb.y)]])
      .filter((f) => f.layer.id.includes('#') && !f.layer.id.startsWith('cad-') && !f.layer.id.startsWith('basemap') && Number.isFinite(Number(f.id)));
    const seen = new Set<string>();
    const step: Op[] = [];
    try {
      for (const f of hits) {
        const layer = f.layer.id.replace(/#.*$/, ''), fid = Number(f.id), key = `${layer}/${fid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const url = `api/layers/${encodeURIComponent(layer)}/features/${fid}`;
        const feat = await this.h.backend.json<GeoJSON.Feature>(url);
        if (!feat.geometry) continue;
        const r = stretch(feat.geometry, (q) => p.xy(q as LL), (q) => p.ll(q), box, d);
        if (!r.moved) continue;
        await this.api(url, 'PUT', { geometry: r.geometry });
        step.push({ kind: 'update', layer, fid, before: feat.geometry, after: r.geometry });
      }
    } catch (err) {
      this.h.setStatus(`Could not stretch: ${err instanceof Error ? err.message : err}`, 8000);
    }
    if (step.length) {
      this.undoStack.push(step);
      this.redoStack = [];
      for (const l of new Set(step.map((o) => o.layer))) await this.h.changed(l);
    }
    this.h.setStatus(step.length ? `Stretched ${step.length} feature${step.length === 1 ? '' : 's'}` : 'No vertex inside the window', 4000);
    this.pts = [];
    this.plane = null;
    this.renderBar();
    this.draw();
  }

  private async doChamfer(v: string) {
    const m = v.match(/^(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?$/);
    if (!m) return this.h.setStatus('Type a distance, or d1,d2 (m)', 5000);
    const d1 = Number(m[1]), d2 = m[2] === undefined ? d1 : Number(m[2]);
    const s = this.sel!, p = this.plane!, g = s.feature.geometry;
    const closed = g.type === 'Polygon';
    const coords = g.type === 'LineString' ? (g.coordinates as LL[]) : closed ? (g.coordinates[0] as LL[]) : null;
    if (!coords) return this.h.setStatus(`Chamfer works on lines and polygons (this is a ${g.type})`, 5000);
    const line = coords.map((q) => p.xy(q));
    const i = nearestVertex(closed ? line.slice(0, -1) : line, p.xy(s.at));
    const out = chamfer(line, i, d1, d2, closed);
    if (!out) return this.h.setStatus('That corner cannot take this chamfer (an end, a straight corner, or a leg shorter than the distance)', 6000);
    const ring = out.map((q) => p.ll(q));
    return this.write(closed ? { type: 'Polygon', coordinates: [ring, ...(g.coordinates.slice(1) as LL[][])] } : { type: 'LineString', coordinates: ring }, false);
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
  /** LAYER: every design layer with its colour, linetype, lineweight, fill, on/off and lock */
  private layerDialog() {
    const layers = this.h.layers().filter((l) => l.name.startsWith('Design · '));
    if (!layers.length) return this.h.setStatus('No design layers yet: draw with the Design tools first', 5000);
    const locked = new Set(this.h.locked());
    const modal = document.createElement('div');
    modal.className = 'modal folder-pick';
    const row = (l: LayerInfo) => {
      const p = this.h.props(l.id);
      if (!p) return '';
      const opt = (v: string, t: string) => `<option value="${v}" ${p.dash === v ? 'selected' : ''}>${t}</option>`;
      return `<tr data-id="${esc(l.id)}">
        <td><label class="lc-switch"><input type="checkbox" data-k="visible" ${p.visible ? 'checked' : ''} aria-label="Show ${esc(l.name)}"></label></td>
        <td><input type="checkbox" data-k="locked" ${locked.has(l.id) ? 'checked' : ''} aria-label="Lock ${esc(l.name)}"></td>
        <td>${esc(l.name.replace(/^Design · /, ''))}</td>
        <td><input type="color" data-k="color" value="${esc(p.color)}" aria-label="Colour of ${esc(l.name)}"></td>
        <td><select data-k="dash" aria-label="Linetype of ${esc(l.name)}">${opt('solid', 'Continuous')}${opt('dashed', 'Dashed')}${opt('dotted', 'Dotted')}</select></td>
        <td><input type="number" data-k="width" min="0.25" max="12" step="0.25" value="${p.width}" aria-label="Lineweight of ${esc(l.name)}"></td>
        <td>${l.geometry === 'polygon' ? `<input type="checkbox" data-k="hollow" ${p.hollow ? 'checked' : ''} aria-label="Outline only">` : ''}</td>
      </tr>`;
    };
    modal.innerHTML = `<form class="sheet fp cad-layers" role="dialog" aria-label="Layer properties">
      <header><b>Layer Properties</b><button type="button" data-x aria-label="Close">✕</button></header>
      <div class="body">
        <p class="dim">The design layers as AutoCAD's Layer Properties Manager lists them. Colours, linetypes and lineweights also go out with DXF export; a locked layer is left alone by every Modify tool.</p>
        <table class="cad-layer-table"><thead><tr><th>On</th><th>Lock</th><th>Name</th><th>Colour</th><th>Linetype</th><th>Weight (px)</th><th>Outline only</th></tr></thead>
        <tbody>${layers.map(row).join('')}</tbody></table>
      </div>
      <footer><button class="primary" type="button" data-x>Done</button></footer></form>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal || (e.target as HTMLElement).closest('[data-x]')) modal.remove(); });
    modal.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      const id = el.closest<HTMLElement>('tr')?.dataset.id;
      const k = el.dataset.k;
      if (!id || !k) return;
      if (k === 'locked') {
        const now = this.h.locked().filter((x) => x !== id);
        return this.h.setLocked(el.checked ? [...now, id] : now);
      }
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(0.25, Number(el.value) || 1) : el.value;
      this.h.setProps(id, { [k]: v } as Partial<CadLayerProps>);
    });
  }

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
      // a placed block still as it was placed goes out as a block reference; one since moved, edited or
      // erased is plain linework (and is forgotten)
      const same = (a: GeoJSON.Geometry, b: GeoJSON.Geometry) => JSON.stringify(mapGeometry(a, (q) => q.map((v) => Math.round(v * 1e7)) as LL)) === JSON.stringify(mapGeometry(b, (q) => q.map((v) => Math.round(v * 1e7)) as LL));
      const kept: CadInsert[] = [];
      for (const i of this.h.inserts()) {
        if (!ids.includes(i.layer)) continue;
        const f = await this.h.backend.json<GeoJSON.Feature>(`api/layers/${encodeURIComponent(i.layer)}/features/${i.fid}`).catch(() => null);
        if (f?.geometry && same(f.geometry, i.geometry)) kept.push(i);
      }
      if (kept.length !== this.h.inserts().length) this.h.setInserts(kept);
      const used = new Set(kept.map((i) => i.block));
      const blocks = this.loadBlocks().filter((b) => used.has(b.name)).map((b) => ({ name: b.name, geometry: b.geometry }));
      const inserts = kept.map((i) => ({ block: i.block, layer: i.layer, fid: i.fid, at: i.at, angle: i.angle }));
      const r = await this.h.backend.json<{ path: string; features: number; epsg: number }>('api/design/dxf', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layers: ids, blocks, inserts, pens: Object.fromEntries(ids.map((id) => [id, this.h.props(id)]).filter(([, v]) => v)), hatch: Object.fromEntries(ids.map((id) => [id, this.h.hatch(id)]).filter(([, h]) => h)) }),
      });
      window.open(this.h.backend.url(`api/design/dxf?path=${encodeURIComponent(r.path)}`), '_blank', 'noopener');
      this.h.setStatus(`DXF: ${r.features} entities${kept.length ? ` (${kept.length} block references)` : ''} in EPSG:${r.epsg} (metres), one AutoCAD layer per design layer`, 8000);
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
      if (this.tool === 'arraypolar' && this.pts.length === 1 && this.plane && this.preview) {
        const copies = this.polarCopies(this.preview);
        if (typeof copies !== 'string') for (const g of copies) feats.push({ type: 'Feature', properties: {}, geometry: g });
      }
      if ((this.tool === 'move' || this.tool === 'copy') && this.pts.length === 1 && this.cursor && this.plane) {
        const p = this.plane, d = this.diff(this.pts[0], this.cursor);
        feats.push({ type: 'Feature', properties: {}, geometry: mapGeometry(this.sel.feature.geometry, (q) => p.ll(translate(d)(p.xy(q)))) });
      }
    }
    if (this.tool && this.plane && all.length >= 2) {
      const xy = all.map((q) => this.plane!.xy(q));
      if (this.tool === 'stretch' && all.length >= 2) {
        const [a, b] = [xy[0], xy[Math.min(1, xy.length - 1)]];
        feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a].map((q) => this.plane!.ll(q as XY))] } });
      } else if (this.tool === 'rect') {
        const [a, b] = [xy[0], xy[xy.length - 1]];
        feats.push({ type: 'Feature', properties: { dim: `${fmt(Math.abs(b[0] - a[0]))} × ${fmt(Math.abs(b[1] - a[1]))}` }, geometry: { type: 'Polygon', coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a].map((q) => this.plane!.ll(q as XY))] } });
      } else if (this.tool === 'arc' && xy.length >= 3) {
        const a = arc3(xy[0], xy[1], xy[2]);
        if (a) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: a.map((q) => this.plane!.ll(q)) } });
      } else if (this.tool === 'ellipse' && xy.length >= 3) {
        const el = ellipse(xy[0], xy[1], halfAxis(xy[0], xy[1], xy[2]));
        feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...el, el[0]].map((q) => this.plane!.ll(q))] } });
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
