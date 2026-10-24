// Symbols: how points, lines and polygons are drawn and labelled (ArcGIS Pro's symbol and label
// classes, QGIS's symbol and labelling tabs). Pure data + functions: the map (MapLibre layers), the
// Contents swatches and the Symbology pane all read the same description, and the engine's map
// export reads it from the project file (crates/engine/src/automation/cartography.rs).
//
// Every part is optional: a style saved before these options existed keeps its old look.
import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import type { LayerStyle } from './symbology';

export type Shape = 'circle' | 'square' | 'triangle' | 'diamond' | 'star' | 'cross' | 'x' | 'pin';
export type Dash = 'solid' | 'dashed' | 'dotted' | 'dashdot' | 'longdash';

export interface SizeBy {
  field: string;
  /** field values mapped to the smallest and largest symbol */
  min: number;
  max: number;
  minSize: number;
  maxSize: number;
}

export interface PointSymbol {
  shape: Shape;
  /** symbol size in px (diameter / width) */
  size: number;
  strokeColor: string;
  strokeWidth: number;
  /** degrees, clockwise */
  rotation?: number;
  /** proportional symbols */
  sizeBy?: SizeBy;
}

export interface LineSymbol {
  width: number;
  dash: Dash;
  cap: 'round' | 'butt' | 'square';
  join: 'round' | 'miter' | 'bevel';
  /** a wider line underneath (roads, rivers): 0 = none */
  casingWidth?: number;
  casingColor?: string;
}

export interface FillSymbol {
  /** false = outline only (hollow) */
  fill: boolean;
  strokeColor: string;
  strokeWidth: number;
  strokeDash: Dash;
  /** hatching instead of a flat fill (AutoCAD HATCH): lines, cross-hatch, dots or bricks */
  pattern?: Hatch;
  /** 3D: raise each polygon to the height in this numeric field (metres × scale), e.g. buildings */
  extrude?: { field: string; scale?: number };
}

export type Hatch = 'diagonal' | 'back' | 'cross' | 'horizontal' | 'vertical' | 'grid' | 'dots' | 'brick';
export const HATCHES: [Hatch, string][] = [
  ['diagonal', 'Diagonal lines (ANSI31)'], ['back', 'Back diagonal'], ['cross', 'Cross-hatch (ANSI37)'],
  ['horizontal', 'Horizontal lines'], ['vertical', 'Vertical lines'], ['grid', 'Grid'], ['dots', 'Dots'], ['brick', 'Brick'],
];
export const HATCH_PREFIX = 'gx-hatch|';

/** A hatch tile (16 px, drawn at 2×) in one colour, for MapLibre's fill-pattern: made the first time
 *  a layer asks for `gx-hatch|<pattern>|<colour>`. */
export function hatchImage(id: string): { width: number; height: number; data: Uint8ClampedArray } {
  const [, kind, color] = id.split('|');
  const n = 32;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.strokeStyle = x.fillStyle = color || '#ffffff';
  x.lineWidth = 2;
  x.lineCap = 'square';
  const line = (a: number, b: number, c2: number, d: number) => { x.beginPath(); x.moveTo(a, b); x.lineTo(c2, d); x.stroke(); };
  // diagonals run corner to corner and across the neighbouring corners, so tiles join seamlessly
  const diag = () => { line(0, n, n, 0); line(-n / 2, n / 2, n / 2, -n / 2); line(n / 2, n + n / 2, n + n / 2, n / 2); };
  const back = () => { line(0, 0, n, n); line(-n / 2, n / 2, n / 2, n + n / 2); line(n / 2, -n / 2, n + n / 2, n / 2); };
  switch (kind) {
    case 'back': back(); break;
    case 'cross': diag(); back(); break;
    case 'horizontal': line(0, n / 2, n, n / 2); break;
    case 'vertical': line(n / 2, 0, n / 2, n); break;
    case 'grid': line(0, n / 2, n, n / 2); line(n / 2, 0, n / 2, n); break;
    case 'dots': x.beginPath(); x.arc(n / 4, n / 4, 2.5, 0, 2 * Math.PI); x.arc((3 * n) / 4, (3 * n) / 4, 2.5, 0, 2 * Math.PI); x.fill(); break;
    case 'brick': line(0, 1, n, 1); line(0, n / 2 + 1, n, n / 2 + 1); line(n / 2, 1, n / 2, n / 2 + 1); line(1, n / 2 + 1, 1, n + 1); break;
    default: diag();
  }
  return { width: n, height: n, data: x.getImageData(0, 0, n, n).data };
}

export type Anchor = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type FontStyle = 'regular' | 'bold' | 'italic' | 'bold-italic';

export interface LabelStyle {
  on: boolean;
  field: string;
  font: FontStyle;
  size: number;
  color: string;
  haloColor: string;
  haloWidth: number;
  /** points and polygons: where the text sits around the anchor point */
  anchor: Anchor;
  /** offset in ems [x, y] (right, down) */
  offset: [number, number];
  /** lines: along the line, once at its centre, or horizontal */
  placement: 'point' | 'line' | 'line-center';
  /** show labels that collide with others */
  overlap: boolean;
  minzoom: number;
  maxzoom: number;
  /** wrap after this many ems (0 = never) */
  wrap: number;
  transform: 'none' | 'uppercase' | 'lowercase';
  letterSpacing: number;
}

export const SHAPES: [Shape, string][] = [
  ['circle', 'Circle'], ['square', 'Square'], ['triangle', 'Triangle'], ['diamond', 'Diamond'],
  ['star', 'Star'], ['cross', 'Cross'], ['x', 'X'], ['pin', 'Pin'],
];
export const DASHES: [Dash, string][] = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['dashdot', 'Dash-dot'], ['longdash', 'Long dash']];
export const ANCHORS: [Anchor, string][] = [
  ['top-left', '↖'], ['top', '↑'], ['top-right', '↗'], ['left', '←'], ['center', '•'], ['right', '→'], ['bottom-left', '↙'], ['bottom', '↓'], ['bottom-right', '↘'],
];
export const FONTS: [FontStyle, string][] = [['regular', 'Regular'], ['bold', 'Bold'], ['italic', 'Italic'], ['bold-italic', 'Bold italic']];

/** The bundled font (web/public/fonts, DejaVu Sans; MapLibre glyph PBFs). */
export const FONT_STACK: Record<FontStyle, string> = {
  regular: 'DejaVu Sans Book',
  bold: 'DejaVu Sans Bold',
  italic: 'DejaVu Sans Oblique',
  'bold-italic': 'DejaVu Sans Bold Oblique',
};
/** relative to the app; the placeholders must stay literal (new URL() would percent-encode them) */
export const GLYPHS = 'fonts/{fontstack}/{range}.pbf';

/** Dash patterns in multiples of the line width (MapLibre's line-dasharray; SVG multiplies). */
export const DASH_ARRAY: Record<Dash, number[] | null> = {
  solid: null,
  dashed: [4, 2],
  dotted: [0.5, 2],
  dashdot: [4, 2, 0.5, 2],
  longdash: [8, 3],
};

export const defaultPoint = (): PointSymbol => ({ shape: 'circle', size: 7, strokeColor: '#ffffff', strokeWidth: 1 });
export const defaultLine = (): LineSymbol => ({ width: 1.6, dash: 'solid', cap: 'round', join: 'round' });
export const defaultFill = (): FillSymbol => ({ fill: true, strokeColor: '#ffffff', strokeWidth: 0.7, strokeDash: 'solid' });
export const defaultLabels = (field = ''): LabelStyle => ({
  on: false, field, font: 'regular', size: 12, color: '#1b2631', haloColor: '#ffffff', haloWidth: 1.5,
  anchor: 'top', offset: [0, 0], placement: 'point', overlap: false, minzoom: 0, maxzoom: 24, wrap: 10, transform: 'none', letterSpacing: 0,
});

// ------------------------------------------------------------------ shapes

/** SVG path of a shape in a 24 × 24 box (centre 12, 12). */
export function shapePath(shape: Shape): string {
  switch (shape) {
    case 'square':
      return 'M4 4h16v16H4z';
    case 'triangle':
      return 'M12 2.5 22 20.5H2z';
    case 'diamond':
      return 'M12 1.5 22.5 12 12 22.5 1.5 12z';
    case 'star':
      return 'M12 1.5l3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 17.6l-6.4 3.6L7 14l-5.3-5 7.2-.9z';
    case 'cross':
      return 'M9 2h6v7h7v6h-7v7H9v-7H2V9h7z';
    case 'x':
      return 'M5.6 1.4 12 7.8l6.4-6.4 4.2 4.2-6.4 6.4 6.4 6.4-4.2 4.2-6.4-6.4-6.4 6.4-4.2-4.2 6.4-6.4-6.4-6.4z';
    case 'pin':
      return 'M12 1.5a7.5 7.5 0 0 0-7.5 7.5c0 5.6 7.5 13.5 7.5 13.5s7.5-7.9 7.5-13.5A7.5 7.5 0 0 0 12 1.5z';
    default:
      return 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20z';
  }
}

const INF = 1e20;

// 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher 2012), as TinySDF
function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

function edt(data: Float64Array, w: number, h: number) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), z = new Float64Array(n + 1), v = new Uint16Array(n);
  for (let x = 0; x < w; x++) edt1d(data, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(data, y * w, 1, w, f, v, z);
}

/** A shape as a signed-distance-field image for MapLibre (addImage sdf: true): tinted per feature
 *  by icon-color, outlined by icon-halo. 48 px shape + 8 px buffer, edge at alpha 192 (as TinySDF). */
export function sdfImage(shape: Shape, size = 48, buffer = 8, radius = 8): { width: number; height: number; data: Uint8ClampedArray } {
  const w = size + buffer * 2;
  const c = document.createElement('canvas');
  c.width = c.height = w;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.translate(buffer, buffer);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = '#000';
  ctx.fill(new Path2D(shapePath(shape)));
  const a = ctx.getImageData(0, 0, w, w).data;
  const outer = new Float64Array(w * w), inner = new Float64Array(w * w);
  for (let i = 0; i < w * w; i++) {
    const al = a[i * 4 + 3] / 255;
    if (al >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (al <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - al;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, w, w);
  edt(inner, w, w);
  const out = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < w * w; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
    out[i * 4 + 3] = Math.round(255 - 255 * (d / radius + 0.25));
  }
  return { width: w, height: w, data: out };
}

export const ICON_PREFIX = 'gx-shape-';
/** the SDF image is registered at pixelRatio 2, so its 48-pixel shape is 24 css px on the map
 *  (icon-size = wanted size / this) */
export const ICON_SIZE = 24;

// ------------------------------------------------------------------ map layers

const lin = (zs: [number, number][]) => ['interpolate', ['linear'], ['zoom'], ...zs.flat()] as unknown as ExpressionSpecification;

/** Size (px) of a point symbol: fixed, or scaled by a field (area-proportional, as cartographers scale circles). */
export function sizeExpression(p: PointSymbol): ExpressionSpecification | number {
  const s = p.sizeBy;
  if (!s || !s.field || !(s.max > s.min)) return p.size;
  // area ∝ value: the size grows with the square root
  return [
    'interpolate', ['linear'], ['sqrt', ['max', 0, ['-', ['to-number', ['get', s.field], s.min], s.min]]],
    0, s.minSize, Math.sqrt(s.max - s.min), s.maxSize,
  ] as unknown as ExpressionSpecification;
}

const scaleExpr = (e: ExpressionSpecification | number, k: number): ExpressionSpecification | number =>
  typeof e === 'number' ? e * k : (['*', e, k] as unknown as ExpressionSpecification);

export interface MapLayerArgs {
  id: string;
  geometry: string;
  st: LayerStyle;
  color: ExpressionSpecification | string;
  base: Record<string, unknown>;
  /** colours for the defaults that follow the theme */
  outlineColor: string;
  /** device layers (photos, waypoints) keep their larger look */
  device?: boolean;
  /** sample land: a thin border at every zoom */
  land?: boolean;
}

/** MapLibre layers for a vector layer's symbols (labels are separate: labelLayer). */
export function symbolLayers(a: MapLayerArgs): LayerSpecification[] {
  const { id, geometry, st, color, base } = a;
  const out: LayerSpecification[] = [];
  const op = st.opacity;
  if (geometry === 'polygon') {
    const f = st.fill;
    if (f?.extrude?.field) {
      // blocks raised to their height: seen in 3D once the map is tilted
      const h = ['*', ['to-number', ['get', f.extrude.field], 0], f.extrude.scale ?? 1];
      out.push({ ...base, id: `${id}#fill`, type: 'fill-extrusion', paint: { 'fill-extrusion-color': color, 'fill-extrusion-height': h, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': Math.max(0.3, op), 'fill-extrusion-vertical-gradient': true } } as LayerSpecification);
      return out;
    }
    if (f?.pattern && f.fill !== false) {
      // hatching in one colour: the layer's colour when it has one, else the outline colour
      const ink = typeof color === 'string' ? color : f.strokeColor;
      out.push({ ...base, id: `${id}#fill`, type: 'fill', paint: { 'fill-pattern': `${HATCH_PREFIX}${f.pattern}|${ink}`, 'fill-opacity': op } } as LayerSpecification);
    } else if (f?.fill !== false) out.push({ ...base, id: `${id}#fill`, type: 'fill', paint: { 'fill-color': color, 'fill-opacity': op } } as LayerSpecification);
    if (f) {
      if (f.strokeWidth > 0)
        out.push({
          ...base,
          id: `${id}#line`,
          type: 'line',
          layout: { ...(base.layout as object), 'line-join': 'round' },
          paint: {
            'line-color': f.fill === false && f.strokeColor === defaultFill().strokeColor ? color : f.strokeColor,
            'line-width': f.strokeWidth,
            'line-opacity': Math.min(1, op + 0.15),
            ...(DASH_ARRAY[f.strokeDash] ? { 'line-dasharray': DASH_ARRAY[f.strokeDash] } : {}),
          },
        } as LayerSpecification);
    } else if (st.outline) {
      // the look from before symbols: a hairline from zoom 13 (always for the sample land)
      out.push({
        ...base,
        id: `${id}#line`,
        type: 'line',
        minzoom: Math.max(a.land ? 0 : 13, st.minzoom),
        paint: { 'line-color': a.outlineColor, 'line-width': a.land ? 0.6 : 0.5, 'line-opacity': Math.min(1, op + 0.15) },
      } as LayerSpecification);
    }
    return out;
  }
  if (geometry === 'line') {
    const l = st.line;
    const width = l ? l.width : lin([[2, 0.4], [10, 1.6], [14, 3]]);
    const layout = { ...(base.layout as object), 'line-cap': l?.cap ?? 'round', 'line-join': l?.join ?? 'round' };
    if (l?.casingWidth && l.casingWidth > 0)
      out.push({ ...base, id: `${id}#casing`, type: 'line', layout, paint: { 'line-color': l.casingColor ?? '#ffffff', 'line-width': l.width + 2 * l.casingWidth, 'line-opacity': op } } as LayerSpecification);
    out.push({
      ...base,
      id: `${id}#line`,
      type: 'line',
      layout,
      paint: { 'line-color': color, 'line-opacity': op, 'line-width': width, ...(l && DASH_ARRAY[l.dash] ? { 'line-dasharray': DASH_ARRAY[l.dash] } : {}) },
    } as LayerSpecification);
    return out;
  }
  const p = st.point;
  if (!p) {
    // the look from before symbols
    out.push({
      ...base,
      id: `${id}#circle`,
      type: 'circle',
      paint: {
        'circle-color': color,
        'circle-opacity': op,
        'circle-radius': a.device ? lin([[2, 3], [10, 5], [15, 7]]) : lin([[2, 1.5], [10, 2.5], [15, 4]]),
        'circle-stroke-color': a.device ? '#ffffff' : a.outlineColor,
        'circle-stroke-width': a.device ? 1.5 : 0.5,
        'circle-stroke-opacity': op,
      },
    } as LayerSpecification);
    return out;
  }
  const size = sizeExpression(p);
  if (p.shape === 'circle') {
    out.push({
      ...base,
      id: `${id}#circle`,
      type: 'circle',
      paint: {
        'circle-color': color,
        'circle-opacity': op,
        'circle-radius': scaleExpr(size, 0.5),
        'circle-stroke-color': p.strokeColor,
        'circle-stroke-width': p.strokeWidth,
        'circle-stroke-opacity': op,
      },
      // big circles under small ones
      ...(p.sizeBy?.field ? { layout: { ...(base.layout as object), 'circle-sort-key': ['-', 0, ['to-number', ['get', p.sizeBy.field], 0]] } } : {}),
    } as LayerSpecification);
  } else {
    out.push({
      ...base,
      id: `${id}#circle`,
      type: 'symbol',
      layout: {
        ...(base.layout as object),
        'icon-image': `${ICON_PREFIX}${p.shape}`,
        'icon-size': scaleExpr(size, 1 / ICON_SIZE),
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotate': p.rotation ?? 0,
        // a pin stands on its point
        ...(p.shape === 'pin' ? { 'icon-anchor': 'bottom' } : {}),
        // big symbols under small ones
        ...(p.sizeBy?.field ? { 'symbol-sort-key': ['-', 0, ['to-number', ['get', p.sizeBy.field], 0]] } : {}),
      },
      paint: { 'icon-color': color, 'icon-opacity': op, 'icon-halo-color': p.strokeColor, 'icon-halo-width': p.strokeWidth, 'icon-halo-blur': 0 },
    } as LayerSpecification);
  }
  return out;
}

/** The label layer for a vector layer (null when labels are off). */
export function labelLayer(id: string, geometry: string, st: LayerStyle, base: Record<string, unknown>): LayerSpecification | null {
  const lb = st.labels;
  if (!lb?.on || !lb.field) return null;
  let text: ExpressionSpecification = ['to-string', ['get', lb.field]];
  if (lb.transform === 'uppercase') text = ['upcase', text];
  if (lb.transform === 'lowercase') text = ['downcase', text];
  const alongLine = geometry === 'line' && lb.placement !== 'point';
  const layout: Record<string, unknown> = {
    ...(base.layout as object),
    'text-field': text,
    'text-font': [FONT_STACK[lb.font]],
    'text-size': lb.size,
    'text-allow-overlap': lb.overlap,
    'text-letter-spacing': lb.letterSpacing,
    'text-max-width': lb.wrap > 0 ? lb.wrap : 1000,
    'symbol-placement': alongLine ? lb.placement : 'point',
  };
  if (alongLine) {
    layout['text-rotation-alignment'] = 'map';
    layout['text-keep-upright'] = true;
    if (lb.offset[1]) layout['text-offset'] = [0, lb.offset[1]];
  } else {
    layout['text-anchor'] = lb.anchor === 'center' ? 'center' : oppositeAnchor(lb.anchor);
    layout['text-offset'] = geometry === 'polygon' ? lb.offset : clearOffset(lb, st.point);
    layout['text-justify'] = 'auto';
  }
  return {
    ...base,
    id: `${id}#label`,
    type: 'symbol',
    minzoom: Math.max(lb.minzoom, (base.minzoom as number) ?? 0),
    maxzoom: Math.min(lb.maxzoom, (base.maxzoom as number) ?? 24),
    layout,
    paint: { 'text-color': lb.color, 'text-halo-color': lb.haloColor, 'text-halo-width': lb.haloWidth, 'text-opacity': Math.min(1, st.opacity + 0.2) },
  } as LayerSpecification;
}

/** A point label's offset (ems): clear of its own symbol in the anchor's direction, plus the
 *  user's offset. With sizes by a field the gap follows each symbol's size. */
export function clearOffset(lb: LabelStyle, p: PointSymbol | undefined): [number, number] | ExpressionSpecification {
  const dir = (a: Anchor): [number, number] => {
    if (a === 'center') return [0, 0];
    const x = a.includes('left') ? -1 : a.includes('right') ? 1 : 0;
    const y = a.startsWith('top') ? -1 : a.startsWith('bottom') ? 1 : 0;
    const n = Math.hypot(x, y) || 1;
    return [x / n, y / n];
  };
  const [dx, dy] = dir(lb.anchor);
  const at = (symbolPx: number): [number, number] => {
    const g = (symbolPx / 2 + 2) / lb.size;
    return [+(lb.offset[0] + dx * g).toFixed(3), +(lb.offset[1] + dy * g).toFixed(3)];
  };
  const s = p?.sizeBy;
  if (p && s?.field && s.max > s.min) {
    return [
      'interpolate', ['linear'], ['sqrt', ['max', 0, ['-', ['to-number', ['get', s.field], s.min], s.min]]],
      0, ['literal', at(s.minSize)], Math.sqrt(s.max - s.min), ['literal', at(s.maxSize)],
    ] as unknown as ExpressionSpecification;
  }
  // the default look of points: about 5 px across
  return at(p ? p.size : 5);
}

/** "Label above the point" means the text's bottom touches the point (MapLibre anchors the text). */
export function oppositeAnchor(a: Anchor): Anchor {
  const m: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  return a.split('-').map((p) => m[p] ?? p).join('-') as Anchor;
}

/** Attributes the symbols and labels need in the tiles. */
export function symbolFields(st: LayerStyle): string[] {
  const f: string[] = [];
  if (st.point?.sizeBy?.field) f.push(st.point.sizeBy.field);
  if (st.labels?.on && st.labels.field) f.push(st.labels.field);
  if (st.fill?.extrude?.field) f.push(st.fill.extrude.field);
  return f;
}

// ------------------------------------------------------------------ swatches

const escAttr = (s: string | undefined) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A small SVG of the layer's symbol in a colour (Contents rows, legends, the pane's preview). */
export function swatchSvg(geometry: string, st: LayerStyle, color: string, px = 16): string {
  const c = escAttr(color);
  if (geometry === 'polygon') {
    const f = st.fill ?? defaultFill();
    const sw = st.fill ? Math.min(3, f.strokeWidth) : st.outline ? 1 : 0;
    const dash = st.fill && DASH_ARRAY[f.strokeDash] ? ` stroke-dasharray="${DASH_ARRAY[f.strokeDash]!.map((d) => d * Math.max(1, sw)).join(' ')}"` : '';
    const stroke = st.fill ? (f.fill === false && f.strokeColor === defaultFill().strokeColor ? c : escAttr(f.strokeColor)) : 'currentColor';
    return `<svg class="sym" viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" fill="${st.fill?.fill === false ? 'none' : c}" fill-opacity="${st.opacity}" stroke="${stroke}" stroke-width="${sw * 1.5}"${dash}/></svg>`;
  }
  if (geometry === 'line') {
    const l = st.line ?? defaultLine();
    const w = Math.min(6, Math.max(1.5, l.width * 1.4));
    const dash = DASH_ARRAY[l.dash] ? ` stroke-dasharray="${DASH_ARRAY[l.dash]!.map((d) => d * w).join(' ')}"` : '';
    const casing = l.casingWidth ? `<path d="M2 16 C8 4 16 20 22 8" fill="none" stroke="${escAttr(l.casingColor ?? '#ffffff')}" stroke-width="${w + 2 * l.casingWidth}" stroke-linecap="${l.cap}"/>` : '';
    return `<svg class="sym" viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true">${casing}<path d="M2 16 C8 4 16 20 22 8" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="${l.cap}" stroke-linejoin="${l.join}"${dash}/></svg>`;
  }
  const p = st.point ?? { ...defaultPoint(), size: 10, strokeWidth: 0.5, strokeColor: 'currentColor' };
  const k = Math.min(1, Math.max(0.45, p.size / 14));
  const t = 12 - 12 * k;
  return `<svg class="sym" viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true"><path d="${shapePath(p.shape)}" transform="translate(${t} ${t}) scale(${k}) rotate(${p.rotation ?? 0} 12 12)" fill="${c}" fill-opacity="${st.opacity}" stroke="${escAttr(p.strokeColor)}" stroke-width="${(p.strokeWidth * 1.5) / k}" paint-order="stroke"/></svg>`;
}
