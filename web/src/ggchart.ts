// Charts drawn the ggplot2 way (theme_grey by default, or bw, minimal, classic, light, dark; the hue
// palette by default, or viridis, Okabe–Ito, Set2, Dark2), the same look as the report charts the
// engine draws (crates/engine/src/automation/charts.rs) and as R's ggplot2 in R steps, all from the
// style chosen in Settings (api/settings/charts). Every chart has Customise (title, axis labels,
// theme, palette, text size, colour by category) and Download (PNG or SVG, DPI, size / aspect ratio).
import type { Backend } from './backend';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ChartStyle { theme: string; palette: string; base_size: number }
export const THEMES: [string, string][] = [['grey', 'theme_grey (ggplot2 default)'], ['bw', 'theme_bw'], ['minimal', 'theme_minimal'], ['classic', 'theme_classic'], ['light', 'theme_light'], ['dark', 'theme_dark']];
export const PALETTES: [string, string][] = [['ggplot2', 'ggplot2 hue'], ['viridis', 'viridis'], ['okabe-ito', 'Okabe–Ito (colour-blind safe)'], ['set2', 'Brewer Set2'], ['dark2', 'Brewer Dark2']];

let current: ChartStyle = { theme: 'grey', palette: 'ggplot2', base_size: 11 };
export const chartStyle = () => current;
export async function loadChartStyle(backend: Backend) {
  try {
    current = { ...current, ...(await backend.json<ChartStyle>('api/settings/charts')) };
  } catch { /* the defaults */ }
  return current;
}
export async function saveChartStyle(backend: Backend, st: ChartStyle) {
  current = { ...current, ...(await backend.json<ChartStyle>('api/settings/charts', { method: 'POST', body: JSON.stringify(st), headers: { 'content-type': 'application/json' } })) };
  document.dispatchEvent(new CustomEvent('geospax:chart-style'));
  return current;
}

// ---------------------------------------------------------------- palettes (as charts.rs)
/** sRGB hex of an HCL colour, as R's grDevices::hcl(), so scales::hue_pal() gives the same colours. */
function hcl(h: number, c: number, l: number): string {
  const [un, vn] = [0.1978398, 0.4683361];
  const y = l > 8 ? ((l + 16) / 116) ** 3 : l / 903.3;
  const hr = (h * Math.PI) / 180;
  const [u, v] = [c * Math.cos(hr), c * Math.sin(hr)];
  const [up, vp] = l > 0 ? [u / (13 * l) + un, v / (13 * l) + vn] : [un, vn];
  const x = (9 * y * up) / (4 * vp);
  const z = -x / 3 - 5 * y + (3 * y) / vp;
  const lin = [3.240454 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
  const g = (t: number) => Math.round(Math.min(1, Math.max(0, t > 0.0031308 ? 1.055 * t ** (1 / 2.4) - 0.055 : 12.92 * t)) * 255).toString(16).padStart(2, '0');
  return `#${lin.map(g).join('')}`.toUpperCase();
}
const FIXED: Record<string, string[]> = {
  'okabe-ito': ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#999999'],
  set2: ['#66C2A5', '#FC8D62', '#8DA0CB', '#E78AC3', '#A6D854', '#FFD92F', '#E5C494', '#B3B3B3'],
  dark2: ['#1B9E77', '#D95F02', '#7570B3', '#E7298A', '#66A61E', '#E6AB02', '#A6761D', '#666666'],
};
const VIRIDIS = ['#440154', '#482878', '#3E4A89', '#31688E', '#26828E', '#1F9E89', '#35B779', '#6DCD59', '#B4DE2C', '#FDE725'];
export function palette(name: string, n: number): string[] {
  if (name === 'viridis') return Array.from({ length: n }, (_, i) => VIRIDIS[n <= 1 ? 0 : Math.round((i * (VIRIDIS.length - 1)) / (n - 1))]);
  if (FIXED[name]) return Array.from({ length: n }, (_, i) => FIXED[name][i % FIXED[name].length]);
  const k = Math.max(1, n);
  return Array.from({ length: k }, (_, i) => hcl(15 + (360 * i) / k, 100, 65));
}

interface Look { panel: string | null; border: string | null; grid: [string, number] | null; axis: string | null; ticks: boolean }
function look(theme: string): Look {
  switch (theme) {
    case 'bw': return { panel: '#FFFFFF', border: '#333333', grid: ['#EBEBEB', 1.1], axis: null, ticks: true };
    case 'minimal': return { panel: null, border: null, grid: ['#EBEBEB', 1.1], axis: null, ticks: false };
    case 'classic': return { panel: null, border: null, grid: null, axis: '#000000', ticks: true };
    case 'light': return { panel: '#FFFFFF', border: '#B3B3B3', grid: ['#DEDEDE', 0.55], axis: null, ticks: true };
    case 'dark': return { panel: '#7F7F7F', border: null, grid: ['#6B6B6B', 1.1], axis: null, ticks: true };
    default: return { panel: '#EBEBEB', border: null, grid: ['#FFFFFF', 1.1], axis: null, ticks: true };
  }
}

function nice(range: number, target: number) {
  const raw = Math.max(range / Math.max(1, target), 1e-12);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return p * (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10);
}
const fmt = (v: number) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : Number(v.toPrecision(6)).toLocaleString('en-US'));

// ---------------------------------------------------------------- the chart
/** A histogram (numeric bins, bars touching) or a bar chart (categories), as geom_histogram / geom_col. */
export interface BarSpec {
  kind: 'histogram' | 'bar';
  bars: { label: string; x0?: number; x1?: number; value: number; fill?: string }[];
  title: string;
  x: string;
  y: string;
  /** name used for downloaded files */
  file: string;
}
export interface ChartOpts { theme: string; palette: string; base_size: number; title: string; x: string; y: string; colour: 'single' | 'palette' | 'data' }

/** The chart as SVG at w × h (CSS px at 96 dpi), in a ggplot2 theme. */
export function barSvg(spec: BarSpec, o: ChartOpts, w = 680, h = 380): string {
  const lk = look(o.theme);
  const fs = o.base_size * 1.15;
  const small = fs * 0.8;
  const titleH = o.title ? fs * 1.2 + 8 : 0;
  const cats = spec.kind === 'bar';
  const longest = cats ? Math.min(14, Math.max(...spec.bars.map((b) => b.label.length))) : 0;
  const rot = cats && spec.bars.length * longest * small * 0.55 > w - 100; // labels at 45° when they would overlap
  const l = 14 + fs + 40;
  const r = 12;
  const t = 10 + titleH;
  const b = 16 + fs * 1.4 + (rot ? longest * small * 0.45 : small + 6);
  const n = spec.bars.length;
  const ymax = Math.max(1e-12, ...spec.bars.map((d) => d.value)) * 1.05; // geom_col starts at 0; 5 % on top
  const ys = nice(ymax, 5);
  const px0 = l;
  const px1 = w - r;
  const py = (v: number) => h - b - (v / ymax) * (h - t - b);
  // histogram: continuous x with 5 % expansion; bars: discrete x, 0.9 bar width with 0.6 expansion
  let xs: (i: number) => [number, number];
  let xbreaks: [number, string][] = [];
  if (!cats) {
    const lo = spec.bars[0]?.x0 ?? 0;
    const hi = spec.bars[n - 1]?.x1 ?? 1;
    const pad = (hi - lo) * 0.05;
    const X = (v: number) => px0 + ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (px1 - px0);
    xs = (i) => [X(spec.bars[i].x0 ?? i), X(spec.bars[i].x1 ?? i + 1)];
    const step = nice(hi - lo, 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) xbreaks.push([X(v), fmt(v)]);
  } else {
    const slot = (px1 - px0) / (n + 0.2);
    xs = (i) => [px0 + slot * (0.6 + i) - slot * 0.45, px0 + slot * (0.6 + i) + slot * 0.45];
    xbreaks = spec.bars.map((d, i) => [px0 + slot * (0.6 + i), d.label.length > 14 ? `${d.label.slice(0, 13)}…` : d.label]);
  }
  const pal = palette(o.palette, n);
  const fill = (i: number) => (o.colour === 'palette' ? pal[i] : o.colour === 'data' && spec.bars[i].fill ? spec.bars[i].fill! : '#595959'); // grey35, ggplot2's default fill
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="'DejaVu Sans', Arial, sans-serif"><rect width="${w}" height="${h}" fill="#FFFFFF"/>`;
  if (o.title) s += `<text x="${l}" y="${10 + fs * 1.1}" font-size="${(fs * 1.2).toFixed(1)}" fill="#000">${esc(o.title)}</text>`;
  if (lk.panel) s += `<rect x="${px0}" y="${t}" width="${px1 - px0}" height="${h - t - b}" fill="${lk.panel}"/>`;
  if (lk.grid) {
    const [gc, gw] = lk.grid;
    for (let v = ys / 2; v <= ymax; v += ys) s += `<line x1="${px0}" x2="${px1}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" stroke="${gc}" stroke-width="${gw / 2}"/>`;
    for (let v = 0; v <= ymax; v += ys) s += `<line x1="${px0}" x2="${px1}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" stroke="${gc}" stroke-width="${gw}"/>`;
    for (const [x] of xbreaks) s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${t}" y2="${h - b}" stroke="${gc}" stroke-width="${gw}"/>`;
  }
  spec.bars.forEach((d, i) => {
    const [a, z] = xs(i);
    const y = py(d.value);
    s += `<rect x="${a.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.5, z - a).toFixed(2)}" height="${(h - b - y).toFixed(2)}" fill="${esc(fill(i))}"><title>${esc(d.label)}: ${d.value.toLocaleString('en-US')}</title></rect>`;
  });
  if (lk.border) s += `<rect x="${px0}" y="${t}" width="${px1 - px0}" height="${h - t - b}" fill="none" stroke="${lk.border}"/>`;
  if (lk.axis) s += `<line x1="${px0}" x2="${px1}" y1="${h - b}" y2="${h - b}" stroke="${lk.axis}"/><line x1="${px0}" x2="${px0}" y1="${t}" y2="${h - b}" stroke="${lk.axis}"/>`;
  const tick = lk.ticks ? 3.7 : 0;
  for (let v = 0; v <= ymax; v += ys) {
    if (tick) s += `<line x1="${px0 - tick}" x2="${px0}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" stroke="#333"/>`;
    s += `<text x="${px0 - tick - 3}" y="${(py(v) + small * 0.35).toFixed(1)}" text-anchor="end" font-size="${small.toFixed(1)}" fill="#4D4D4D">${fmt(v)}</text>`;
  }
  for (const [x, lab] of xbreaks) {
    if (tick) s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${h - b}" y2="${h - b + tick}" stroke="#333"/>`;
    s += rot
      ? `<text transform="translate(${x.toFixed(1)} ${(h - b + tick + small).toFixed(1)}) rotate(-45)" text-anchor="end" font-size="${small.toFixed(1)}" fill="#4D4D4D">${esc(lab)}</text>`
      : `<text x="${x.toFixed(1)}" y="${(h - b + tick + small + 2).toFixed(1)}" text-anchor="middle" font-size="${small.toFixed(1)}" fill="#4D4D4D">${esc(lab)}</text>`;
  }
  s += `<text x="${((px0 + px1) / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="${fs.toFixed(1)}" fill="#000">${esc(o.x)}</text>`;
  s += `<text transform="translate(${(fs + 2).toFixed(1)} ${((t + h - b) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="${fs.toFixed(1)}" fill="#000">${esc(o.y)}</text>`;
  return `${s}</svg>`;
}

// ---------------------------------------------------------------- on the page: chart + Customise + Download
const SIZES: [string, string, number, number][] = [
  ['4:3', '4:3 (160 × 120 mm)', 160, 120], ['16:9', '16:9 slide (254 × 143 mm)', 254, 143], ['1:1', '1:1 square (120 × 120 mm)', 120, 120],
  ['3:2', '3:2 (180 × 120 mm)', 180, 120], ['col1', 'Journal, one column (85 × 64 mm)', 85, 64], ['col2', 'Journal, two columns (174 × 100 mm)', 174, 100],
  ['a4l', 'A4 landscape (277 × 190 mm)', 277, 190], ['custom', 'Custom…', 0, 0],
];

/** A chart in `host` with its Customise and Download panels; `spec` can change (redraw with `update`). */
export class GgChart {
  private o: ChartOpts;
  /** `keep`: the look of the chart this one replaces (same view redrawn), so customising survives a redraw */
  constructor(private host: HTMLElement, private spec: BarSpec, colour: ChartOpts['colour'] = 'single', keep?: GgChart | null) {
    const st = chartStyle();
    const same = keep && keep.spec.file === spec.file;
    this.o = same ? { ...keep.o } : { theme: st.theme, palette: st.palette, base_size: st.base_size, title: spec.title, x: spec.x, y: spec.y, colour: keep?.o.colour ?? colour };
    if (keep && !same) this.o = { ...keep.o, title: spec.title, x: spec.x, y: spec.y };
    host.classList.add('gg');
    host.addEventListener('click', (e) => this.onClick(e));
    host.addEventListener('input', (e) => this.onInput(e));
    host.addEventListener('change', (e) => this.onInput(e));
    this.render();
  }

  update(spec: BarSpec) {
    // a new field keeps the user's look but takes the new labels
    this.spec = spec;
    this.o = { ...this.o, title: spec.title, x: spec.x, y: spec.y };
    this.render();
  }

  private render() {
    const open = this.host.querySelector<HTMLDetailsElement>('details[open]')?.dataset.panel;
    const sel = (name: string, list: [string, string][], v: string) => `<select name="${name}">${list.map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    this.host.innerHTML = `<div class="gg-plot">${this.screen()}</div>
      <div class="gg-acts">
        <details data-panel="style"${open === 'style' ? ' open' : ''}><summary>Customise</summary><div class="gg-form">
          <label>Title <input name="title" value="${esc(this.o.title)}" /></label>
          <label>x axis <input name="x" value="${esc(this.o.x)}" /></label>
          <label>y axis <input name="y" value="${esc(this.o.y)}" /></label>
          <label>Theme ${sel('theme', THEMES, this.o.theme)}</label>
          <label>Palette ${sel('palette', PALETTES, this.o.palette)}</label>
          <label>Colour ${sel('colour', [['single', 'one colour (grey35)'], ['palette', 'by category (palette)'], ...(this.spec.bars.some((b) => b.fill) ? [['data', 'as on the map'] as [string, string]] : [])], this.o.colour)}</label>
          <label>Text size <input name="base_size" type="number" min="6" max="24" step="1" value="${this.o.base_size}" /></label>
        </div></details>
        <details data-panel="dl"${open === 'dl' ? ' open' : ''}><summary>Download</summary><div class="gg-form">
          <label>Format <select name="fmt"><option value="png">PNG</option><option value="svg">SVG (vector)</option></select></label>
          <label>Resolution <select name="dpi"><option>72</option><option>150</option><option selected>300</option><option>600</option></select> dpi</label>
          <label>Size ${sel('size', SIZES.map(([k, t]) => [k, t]), '4:3')}</label>
          <label class="gg-custom" hidden>Width <input name="wmm" type="number" min="20" max="1000" value="160" /> mm × height <input name="hmm" type="number" min="20" max="1000" value="120" /> mm</label>
          <p class="dim gg-px"></p>
          <button type="button" class="primary" data-gg-dl>Download</button>
        </div></details>
      </div>`;
    this.pxNote();
  }

  /** On screen the chart is drawn at the width it is shown at, so its text keeps its point size. */
  private screen() {
    const w = Math.max(280, Math.round(this.host.clientWidth || this.host.parentElement?.clientWidth || 680));
    return barSvg(this.spec, this.o, w, Math.round(Math.min(420, Math.max(220, w * 0.62))));
  }

  private dims(): [number, number, number] {
    const f = this.host.querySelector<HTMLElement>('[data-panel="dl"]')!;
    const v = (n: string) => (f.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${n}]`)?.value ?? '');
    const size = SIZES.find((s) => s[0] === v('size'))!;
    const [wmm, hmm] = size[0] === 'custom' ? [Number(v('wmm')) || 160, Number(v('hmm')) || 120] : [size[2], size[3]];
    return [wmm, hmm, Number(v('dpi')) || 300];
  }

  private pxNote() {
    const [wmm, hmm, dpi] = this.dims();
    const note = this.host.querySelector('.gg-px');
    if (note) note.textContent = `${Math.round((wmm / 25.4) * dpi)} × ${Math.round((hmm / 25.4) * dpi)} px · ${wmm} × ${hmm} mm at ${dpi} dpi`;
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (!t.name) return;
    if (t.closest('[data-panel="dl"]')) {
      if (t.name === 'size') this.host.querySelector<HTMLElement>('.gg-custom')!.hidden = t.value !== 'custom';
      return this.pxNote();
    }
    (this.o as unknown as Record<string, unknown>)[t.name] = t.name === 'base_size' ? Math.min(24, Math.max(6, Number(t.value) || 11)) : t.value;
    // redraw the picture only, so typing in the form keeps its focus
    this.host.querySelector('.gg-plot')!.innerHTML = this.screen();
  }

  private onClick(e: Event) {
    if (!(e.target as HTMLElement).closest('[data-gg-dl]')) return;
    const [wmm, hmm, dpi] = this.dims();
    const fmtSel = this.host.querySelector<HTMLSelectElement>('[name=fmt]')!.value;
    // draw at the chosen size in CSS px (96 per inch), so text keeps its point size, then scale to the dpi
    const w = Math.round((wmm / 25.4) * 96);
    const h = Math.round((hmm / 25.4) * 96);
    const svg = barSvg(this.spec, this.o, w, h);
    const name = this.spec.file.replace(/[^\w.-]+/g, '_') || 'chart';
    if (fmtSel === 'svg') {
      // the SVG says its physical size, so it prints at wmm × hmm
      const sized = svg.replace(`width="${w}" height="${h}"`, `width="${wmm}mm" height="${hmm}mm"`);
      return save(new Blob([sized], { type: 'image/svg+xml' }), `${name}.svg`);
    }
    const scale = dpi / 96;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => b && save(b, `${name}_${dpi}dpi.png`), 'image/png');
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
