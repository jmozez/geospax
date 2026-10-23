// A raster told as a story, for the places a vector layer has its story or its table: the Inspector
// (Lazy), the Symbology pane (Pro) and the Attributes pane. A raster has no rows to list, so these
// show what its pixels hold instead: the range and spread of values, a histogram coloured like the
// map, band statistics, where it came from, and the value under any point clicked on the map
// (GET api/rasters/{id}/value). The full raster symbology editor (web/src/rasterstyle.ts) opens
// from here.
import type { RasterInfo } from './rasters';

export interface Histogram {
  bins: number;
  bands: { band: number; min: number; max: number; counts: number[]; nodata: number }[];
}

export interface RasterValue {
  inside: boolean;
  values: (number | null)[];
  units: string;
  class: string | null;
  lon: number;
  lat: number;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fmtVal = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toPrecision(4));
const kindName = (k: string) => (k === 'raster' ? 'Raster' : k.toUpperCase() === k ? k : k[0].toUpperCase() + k.slice(1));

/** The colour of a 0–1 position on the raster's legend ramp (its colours spread evenly). */
function rampAt(colors: string[], t: number): string {
  if (!colors.length) return '#7a8ea6';
  const i = Math.min(colors.length - 1, Math.max(0, Math.round(t * (colors.length - 1))));
  return colors[i];
}

function histogramSvg(r: RasterInfo, h: Histogram['bands'][number] | undefined): string {
  if (!h || !h.counts.some((c) => c > 0)) return '';
  const max = Math.max(...h.counts);
  const n = h.counts.length;
  const colors = r.legend?.colors ?? [];
  const bars = h.counts
    .map((c, i) => {
      const bh = c ? Math.max(1.5, (c / max) * 56) : 0;
      return `<rect x="${(i * 100) / n}%" y="${60 - bh}" width="${100 / n - 0.6}%" height="${bh}" fill="${esc(rampAt(colors, (i + 0.5) / n))}"><title>${fmtVal(h.min + ((h.max - h.min) * i) / n)} – ${fmtVal(h.min + ((h.max - h.min) * (i + 1)) / n)}: ${c.toLocaleString('en-US')} px</title></rect>`;
    })
    .join('');
  return `<svg class="rv-hist" viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label="Histogram of values">${bars}</svg>
    <div class="rv-hist-axis"><span>${fmtVal(h.min)}</span><span>${fmtVal(h.max)}${r.units ? ` ${esc(r.units)}` : ''}</span></div>`;
}

/** One sentence about the values: their range, where most of them lie and how much is covered. */
function story(r: RasterInfo, h: Histogram['bands'][number] | undefined): string {
  const s = r.stats?.[0];
  if (!s) return esc(r.description || 'A raster: a grid of cells that each hold a value.');
  const u = r.units ? ` ${esc(r.units)}` : '';
  let most = '';
  if (h && h.counts.length) {
    // the narrowest run of bins holding half the pixels
    const total = h.counts.reduce((a, c) => a + c, 0) || 1;
    let best: [number, number] = [0, h.counts.length - 1];
    for (let i = 0; i < h.counts.length; i++) {
      let sum = 0;
      for (let j = i; j < h.counts.length; j++) {
        sum += h.counts[j];
        if (sum >= total / 2) {
          if (j - i < best[1] - best[0]) best = [i, j];
          break;
        }
      }
    }
    const w = (h.max - h.min) / h.counts.length;
    most = ` Half the area lies between <b>${fmtVal(h.min + best[0] * w)}</b> and <b>${fmtVal(h.min + (best[1] + 1) * w)}${u}</b>.`;
  }
  return `Values from <b>${fmtVal(s.min)}</b> to <b>${fmtVal(s.max)}${u}</b>, average <b>${fmtVal(s.mean)}</b>.${most}`;
}

function facts(r: RasterInfo): string {
  const [w, s, e, n] = r.bounds;
  const rows: [string, string][] = [
    ['Size', `${r.width.toLocaleString('en-US')} × ${r.height.toLocaleString('en-US')} cells`],
    ['Cell size', `${fmtVal(r.pixel_m)} m`],
    ['Bands', String(r.bands ?? 1)],
    ['CRS', r.crs],
    ['Covers', `${w.toFixed(2)}…${e.toFixed(2)}° E, ${s.toFixed(2)}…${n.toFixed(2)}° N`],
  ];
  if (r.units) rows.splice(3, 0, ['Units', r.units]);
  if (r.path) rows.push(['File', r.path.split(/[\\/]/).pop() ?? r.path], ['Saved in', r.path.replace(/[\\/][^\\/]*$/, '')]);
  return `<dl class="rv-facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

/** Statistics of every band as a table: the raster's "attributes". */
export function bandTable(r: RasterInfo): string {
  const st = r.stats ?? [];
  if (!st.length) return '';
  return `<div class="rv-table"><table class="rv-bands"><thead><tr><th>Band</th><th>Min</th><th>Max</th><th>Mean</th><th>Std. dev.</th><th>2 %</th><th>98 %</th></tr></thead><tbody>${st
    .map((s, i) => `<tr><td>${i + 1}</td><td>${fmtVal(s.min)}</td><td>${fmtVal(s.max)}</td><td>${fmtVal(s.mean)}</td><td>${fmtVal(s.std)}</td><td>${fmtVal(s.p2)}</td><td>${fmtVal(s.p98)}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

/** The value box: what was read last, or how to read one. */
export function valueHtml(v: RasterValue | null, r: RasterInfo): string {
  if (!v) return `<p class="rv-hint">Click the map to read the value under the pointer.</p>`;
  if (!v.inside) return `<p class="rv-hint">That point is outside this raster. Click inside it.</p>`;
  const u = v.units || r.units;
  const vals = v.values.length > 1 ? v.values.map((x, i) => `Band ${i + 1}: <b>${fmtVal(x)}</b>`).join(' · ') : `<b>${fmtVal(v.values[0])}</b>${v.values[0] !== null && u ? ` ${esc(u)}` : ''}`;
  return `<p class="rv-read">${v.values.every((x) => x === null) ? 'No data at this point' : vals}${v.class ? ` · ${esc(v.class)}` : ''}<small>at ${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}</small></p>`;
}

/** The whole story (Lazy Inspector; Pro Symbology with `pro`). */
export function rasterStoryHtml(r: RasterInfo, h: Histogram | null, opacity: number, value: RasterValue | null, pro = false): string {
  const hb = h?.bands[0];
  const colors = r.legend?.colors ?? [];
  return `<div class="ins rv" data-raster="${esc(r.id)}">
    <header class="ins-head">
      <span class="ins-glyph rv-glyph" style="background:linear-gradient(135deg,${esc((colors.length ? colors : ['#4c78a8', '#f2cf5b']).join(','))})"></span>
      <div><h2>${esc(r.title)}</h2><small>${esc(kindName(r.kind))} · ${r.width.toLocaleString('en-US')} × ${r.height.toLocaleString('en-US')} cells · ${fmtVal(r.pixel_m)} m</small></div>
    </header>
    <p class="ins-story">${story(r, hb)}</p>
    ${r.why ? `<p class="ins-why"><b>✨ Why it looks like this</b>${esc(r.why)}</p>` : ''}
    <h3>How the values spread</h3>
    ${histogramSvg(r, hb) || '<p class="rv-hint">Reading the values…</p>'}
    <h3>Read a value</h3>
    <div class="rv-value">${valueHtml(value, r)}</div>
    <h3>See through it</h3>
    <input class="ins-op" type="range" min="10" max="100" step="5" value="${Math.round(opacity * 100)}" data-rv="opacity" aria-label="Opacity">
    <h3>${pro ? 'Symbology' : 'Do something with it'}</h3>
    <div class="ins-acts">
      <button class="pri" data-rv="style">${pro ? 'Edit symbology…' : 'Colours and legend…'}</button>
      <button data-rv="zoom">Zoom to it</button>
      <button data-rv="attributes">Statistics</button>
      <button data-rv="remove" title="Remove from the map (the file is kept)">Remove</button>
    </div>
    ${pro ? `<h3>Bands</h3>${bandTable(r)}` : ''}
    <h3>Where it came from</h3>
    ${facts(r)}
    ${r.description ? `<p class="rv-hint">${esc(r.description)}</p>` : ''}
  </div>`;
}

/** The Attributes pane for a raster: no table of rows, so the band statistics and the histogram. */
export function rasterAttributesHtml(r: RasterInfo, h: Histogram | null, value: RasterValue | null): string {
  return `<div class="rv rv-attr">
    <div class="pane-head"><span class="pane-title">${esc(r.title)}</span><span class="pane-sub">raster · ${r.bands ?? 1} band${(r.bands ?? 1) === 1 ? '' : 's'}</span></div>
    <p class="rv-hint">A raster has no attribute table: each of its ${(r.width * r.height).toLocaleString('en-US')} cells holds a value. Here are the statistics of those values; click the map to read one cell.</p>
    ${bandTable(r)}
    ${(h?.bands ?? []).map((b) => `<h3>Band ${b.band}</h3>${histogramSvg(r, b)}`).join('')}
    <div class="rv-value">${valueHtml(value, r)}</div>
  </div>`;
}
