// Layer styling model (the seed of a CIM-like symbology layer): pure data +
// functions that turn it into MapLibre expressions and legend entries.
// No DOM here, so it is shared by the map, the Contents legend and the panel.
import type { ExpressionSpecification } from 'maplibre-gl';
import type { FillSymbol, LabelStyle, LineSymbol, PointSymbol } from './symbols';

export type Method = 'jenks' | 'quantile' | 'equal' | 'guideline';

export interface UniqueClass {
  value: string | number;
  color: string;
  count: number;
}

export type Symbology =
  | { kind: 'single'; color: string }
  | { kind: 'unique'; field: string; ramp: string; classes: UniqueClass[]; other: string; othersCount: number }
  | {
      kind: 'graduated';
      field: string;
      method: Method;
      ramp: string;
      /** class upper bounds, ascending (last = max) */
      breaks: number[];
      colors: string[];
      counts: number[];
      min: number;
      /** class names (WHO guideline classes) */
      labels?: string[];
    };

export interface LayerStyle {
  visible: boolean;
  opacity: number; // 0..1
  minzoom: number;
  maxzoom: number;
  outline: boolean;
  symbology: Symbology;
  /** symbols and labels (symbols.ts); absent = the look from before these options */
  point?: PointSymbol;
  line?: LineSymbol;
  fill?: FillSymbol;
  labels?: LabelStyle;
  /** AutoMap's reason for this style; dropped as soon as someone changes the symbology by hand */
  auto?: string;
}

/** Map background: an id from web/src/basemaps.ts ('offline' = Natural Earth, bundled; 'none'; 'custom' …). */
export type Basemap = string;

export interface Project {
  version: 1;
  /** the project's name (Home › Project › New, Save as, Rename) and its file id under projects/ */
  name?: string;
  slug?: string;
  /** draw order, bottom first */
  order: string[];
  layers: Record<string, LayerStyle>;
  view?: { center: [number, number]; zoom: number };
  basemap?: Basemap;
  /** the user's own XYZ tiles (basemap 'custom') */
  customBasemap?: { url: string; attribution: string; maxzoom?: number };
  /** group layers (Pro tree): a group switches its layers on and off together */
  groups?: LayerGroup[];
  /** layer id -> group id */
  member?: Record<string, string>;
  /** layers taken off the map: their files stay in the data folders, but they are not shown again
   *  at the next start until they are added back (Catalog › Add to the map), as in ArcGIS Pro */
  removed?: string[];
  /** map images from web services (WMS, WMTS, XYZ, ArcGIS MapServer), drawn over the basemap */
  web?: WebLayer[];
  /** Design › Blocks: named shapes in metres around their base point, placed with Insert */
  cadBlocks?: CadBlock[];
  /** Design › Lock: layer ids that Modify tools leave alone */
  cadLocked?: string[];
  /** Design › Insert: where each block was placed, so DXF export writes block references */
  cadInserts?: CadInsert[];
  /** Edit › Attribute rules: layer id -> field -> allowed values, default, required */
  attrRules?: Record<string, Record<string, { values?: string[]; default?: string; required?: boolean }>>;
}

/** a placed block: the feature it made, its insertion point and turn, and that feature's geometry then */
export interface CadInsert { block: string; layer: string; fid: number; at: [number, number]; angle: number; geometry: GeoJSON.Geometry }

export interface CadBlock { name: string; layer: string; geometry: GeoJSON.Geometry; properties: Record<string, unknown> }

export interface WebLayer {
  id: string;
  /** the web service connection (api/services) and its layer */
  sid: string;
  layer: string;
  title: string;
  opacity: number;
  visible: boolean;
}

export interface LayerGroup {
  id: string;
  name: string;
  visible: boolean;
  expanded: boolean;
}

// ------------------------------------------------------------------ ramps
export interface Ramp {
  id: string;
  name: string;
  type: 'sequential' | 'diverging' | 'categorical';
  colors: string[];
}

export const RAMPS: Ramp[] = [
  { id: 'viridis', name: 'Viridis', type: 'sequential', colors: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
  { id: 'magma', name: 'Magma', type: 'sequential', colors: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'] },
  { id: 'ylorrd', name: 'Yellow-Orange-Red', type: 'sequential', colors: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'] },
  { id: 'blues', name: 'Blues', type: 'sequential', colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'] },
  { id: 'greens', name: 'Greens', type: 'sequential', colors: ['#edf8e9', '#bae4b3', '#74c476', '#31a354', '#006d2c'] },
  { id: 'rdylbu', name: 'Red-Yellow-Blue', type: 'diverging', colors: ['#d7191c', '#fdae61', '#ffffbf', '#abd9e9', '#2c7bb6'] },
  { id: 'tableau', name: 'Tableau 10', type: 'categorical', colors: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'] },
  { id: 'set2', name: 'Pastel (Set2)', type: 'categorical', colors: ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'] },
  { id: 'bold', name: 'Bold', type: 'categorical', colors: ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff'] },
];

export const rampById = (id: string) => RAMPS.find((r) => r.id === id) ?? RAMPS[0];

const hex2rgb = (h: string) => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgb2hex = (c: number[]) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

/** n colours sampled along a ramp (categorical ramps cycle). */
export function rampColors(id: string, n: number): string[] {
  const r = rampById(id);
  if (r.type === 'categorical') return Array.from({ length: n }, (_, i) => r.colors[i % r.colors.length]);
  if (n === 1) return [r.colors[Math.floor(r.colors.length / 2)]];
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (r.colors.length - 1);
    const j = Math.min(Math.floor(t), r.colors.length - 2);
    const a = hex2rgb(r.colors[j]);
    const b = hex2rgb(r.colors[j + 1]);
    const f = t - j;
    return rgb2hex(a.map((x, k) => x + (b[k] - x) * f));
  });
}

/** CSS linear-gradient preview of a ramp. */
export const rampGradient = (id: string) => {
  const c = rampById(id).colors;
  return rampById(id).type === 'categorical'
    ? `linear-gradient(90deg, ${c.map((x, i) => `${x} ${(i / c.length) * 100}% ${((i + 1) / c.length) * 100}%`).join(', ')})`
    : `linear-gradient(90deg, ${c.join(', ')})`;
};

// ------------------------------------------------------------------ expressions
export const NULL_COLOR = '#6b7785';

/** MapLibre colour expression for a symbology. */
export function colorExpression(s: Symbology): ExpressionSpecification | string {
  if (s.kind === 'single') return s.color;
  if (s.kind === 'unique') {
    if (!s.classes.length) return s.other;
    const pairs = s.classes.flatMap((c) => [String(c.value), c.color]);
    return ['match', ['to-string', ['get', s.field]], ...pairs, s.other] as unknown as ExpressionSpecification;
  }
  if (!s.breaks.length) return NULL_COLOR;
  // inclusive upper bounds: class i = (b[i-1], b[i]]
  const v: ExpressionSpecification = ['to-number', ['get', s.field]];
  const cases: unknown[] = ['case', ['!', ['has', s.field]], NULL_COLOR];
  s.breaks.slice(0, -1).forEach((b, i) => cases.push(['<=', v, b], s.colors[i]));
  cases.push(s.colors[s.colors.length - 1]);
  return cases as ExpressionSpecification;
}

/** Attribute the symbology needs in the tiles (for `?fields=`). */
export const symbologyField = (s: Symbology) => (s.kind === 'single' ? null : s.field);

// ------------------------------------------------------------------ legend
export function fmtNum(v: number | null | undefined): string {
  // a project file can hold a null bound (an empty class): show a dash rather than stop the app
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : v.toPrecision(2);
}

export interface LegendItem {
  color: string;
  label: string;
  count?: number;
}

export function legendItems(s: Symbology): LegendItem[] {
  if (s.kind === 'single') return [];
  if (s.kind === 'unique') {
    const items: LegendItem[] = s.classes.map((c) => ({ color: c.color, label: String(c.value), count: c.count }));
    if (s.othersCount > 0) items.push({ color: s.other, label: 'all other values', count: s.othersCount });
    return items;
  }
  return s.breaks.map((b, i) => ({
    color: s.colors[i],
    label: `${fmtNum(i === 0 ? s.min : s.breaks[i - 1])} – ${fmtNum(b)}${s.labels?.[i] ? ` · ${s.labels[i]}` : ''}`,
    count: s.counts[i],
  }));
}

/** Swatch colour for the Contents row (first class for multi-class). */
export const primaryColor = (s: Symbology) =>
  s.kind === 'single' ? s.color : s.kind === 'unique' ? (s.classes[0]?.color ?? s.other) : (s.colors[Math.floor(s.colors.length / 2)] ?? NULL_COLOR);

// ------------------------------------------------------------------ engine responses
export interface ClassifyResponse {
  field: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  median: number;
  method: Method;
  breaks: number[];
  counts: number[];
  /** method=guideline: air-quality-index colours and class names */
  colors?: string[];
  labels?: string[];
  scan_ms: number;
  classify_ms: number;
}

export interface UniqueResponse {
  field: string;
  count: number;
  distinct: number;
  values: { value: string | number; count: number }[];
  others: number;
  scan_ms: number;
}

export function graduatedFrom(r: ClassifyResponse, ramp: string): Symbology {
  return {
    kind: 'graduated',
    field: r.field,
    method: r.method,
    ramp,
    breaks: r.breaks,
    colors: r.colors ?? rampColors(ramp, r.breaks.length),
    counts: r.counts,
    min: r.min,
    ...(r.labels ? { labels: r.labels } : {}),
  };
}

export function uniqueFrom(r: UniqueResponse, ramp: string): Symbology {
  const colors = rampColors(ramp, r.values.length);
  return {
    kind: 'unique',
    field: r.field,
    ramp,
    classes: r.values.map((v, i) => ({ value: v.value, color: colors[i], count: v.count })),
    other: NULL_COLOR,
    othersCount: r.others,
  };
}
