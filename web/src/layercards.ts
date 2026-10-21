// The Contents pane in two densities, one per kind of user (docs/USER_GUIDE.md §2b):
//
//  - Lazy: "layer cards". Each layer says what it shows in one sentence written from its data,
//    the legend is a bar whose segments are as wide as their share of the features, status is in
//    words, and the next step (the recipes that fit this layer) is a button on the card.
//  - Pro: a dense layer tree (ArcGIS Pro's Contents): file names, drag to reorder, inline opacity,
//    CRS / zoom range / classification on one line, legend with counts, a filter box.
//
// Both render the same project; switching never changes the map. Pure HTML builders, no state:
// main.ts owns the project and wires the events.
import type { Job, LayerInfo } from './backend';
import { fmtNum, legendItems, primaryColor, type LayerStyle, type Symbology } from './symbology';

export type UiMode = 'lazy' | 'pro';

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);

const NOUN: Record<string, [string, string]> = {
  point: ['point', 'points'],
  line: ['line', 'lines'],
  polygon: ['area', 'areas'],
  unknown: ['feature', 'features'],
};
const noun = (l: LayerInfo, n = l.feature_count) => NOUN[l.geometry]?.[n === 1 ? 0 : 1] ?? 'features';

/** "air_quality_samples" → "Air quality samples"; "natural_earth.countries" → "Countries". */
export function friendlyName(l: LayerInfo, all?: LayerInfo[]): string {
  const base = friendlyBase(l);
  // the same data in two formats (buildings.gpkg, buildings.fgb): say which is which
  return all && all.some((o) => o.id !== l.id && friendlyBase(o) === base) ? `${base} (${l.driver})` : base;
}

function friendlyBase(l: LayerInfo): string {
  const base = (l.name || l.id).replace(/\.(geojson|json|gpkg|shp|fgb|csv|kml|gpx|parquet)$/i, '').split('.').pop() ?? l.id;
  const words = base.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : l.id;
}

/** A readable field name: pm2_5 → PM2.5, pop_est → pop est. */
export const fieldName = (f: string) => (/^pm2_?5$/i.test(f) ? 'PM2.5' : /^pm10$/i.test(f) ? 'PM10' : f.replace(/_/g, ' '));

export type Group = 'data' | 'devices' | 'results' | 'reference';
export const GROUP_TITLE: Record<Group, string> = {
  data: 'Your data',
  devices: 'From your devices',
  results: 'Recipe results',
  reference: 'Reference',
};

export function groupOf(l: LayerInfo, isDevice: (id: string) => boolean): Group {
  if (isDevice(l.id)) return 'devices';
  if (/[\\/]runs[\\/]/.test(l.source)) return 'results';
  if (/^natural_earth\./.test(l.id)) return 'reference';
  return 'data';
}

/** One sentence, written from the symbology the layer actually has. */
export function sentence(l: LayerInfo, s: Symbology): string {
  const n = l.feature_count;
  if (s.kind === 'graduated') {
    const total = s.counts.reduce((a, b) => a + b, 0) || n;
    if (s.method === 'guideline' && s.breaks.length > 1) {
      const above = total - (s.counts[0] ?? 0);
      return `Coloured by <b>${esc(fieldName(s.field))}</b> against the WHO guideline: <b>${pct(above, total)}%</b> of ${fmt(total)} readings are above ${fmtNum(s.breaks[0])}.`;
    }
    let top = 0;
    s.counts.forEach((c, i) => (c > s.counts[top] ? (top = i) : 0));
    const lo = top === 0 ? s.min : s.breaks[top - 1];
    return `Coloured by <b>${esc(fieldName(s.field))}</b>, ${fmtNum(s.min)} to ${fmtNum(s.breaks[s.breaks.length - 1])}. Most ${noun(l)} (<b>${pct(s.counts[top], total)}%</b>) are between ${fmtNum(lo)} and ${fmtNum(s.breaks[top])}.`;
  }
  if (s.kind === 'unique') {
    const total = s.classes.reduce((a, c) => a + c.count, 0) + s.othersCount || n;
    const kinds = s.classes.length + (s.othersCount > 0 ? 1 : 0);
    const top = [...s.classes].sort((a, b) => b.count - a.count).slice(0, 3);
    const list = top.map((c) => `<b>${esc(c.value)}</b> (${pct(c.count, total)}%)`).join(', ');
    const more = s.classes.length > 3 ? ` and ${s.classes.length - 3 + (s.othersCount > 0 ? 1 : 0)} more` : '';
    return `Split by <b>${esc(fieldName(s.field))}</b> into ${kinds} groups: ${list}${more}.`;
  }
  return `${fmt(n)} ${noun(l)} in one colour. <i>Style automatically</i> colours them by what matters.`;
}

/** Legend bar: one segment per class, as wide as its share of the features. */
function legendBar(s: Symbology): string {
  const items = legendItems(s).filter((i) => (i.count ?? 0) > 0);
  if (!items.length) return '';
  const segs = items.map((i) => `<i style="flex:${Math.max(1, i.count ?? 1)};background:${esc(i.color)}" title="${esc(i.label)} · ${fmt(i.count ?? 0)}"></i>`).join('');
  let ticks = '';
  if (s.kind === 'graduated') {
    const names = s.labels?.length ? [s.labels[0], s.labels[s.labels.length - 1]] : [fmtNum(s.min), fmtNum(s.breaks[s.breaks.length - 1])];
    ticks = `<div class="lc-ticks"><span>${esc(names[0])}</span><span>${esc(names[1])}</span></div>`;
  }
  return `<div class="lc-bar">${segs}</div>${ticks}`;
}

export interface RowState {
  layer: LayerInfo;
  style: LayerStyle;
  job?: Job;
  selected: boolean;
  first: boolean;
  last: boolean;
  /** every layer, to tell apart layers with the same friendly name */
  all: LayerInfo[];
  /** recipes that fit this layer: [recipe id, button label] */
  actions: [string, string][];
  autoOverviews: boolean;
  /** Pro tree: nesting level (0 = under the map, 1 = in a group) and whether its legend is open */
  depth?: number;
  expanded?: boolean;
}

function statusChips(r: RowState): string {
  const { layer: l, style: st, job } = r;
  const running = job && (job.status === 'queued' || job.status === 'running');
  const chips: string[] = [];
  if (running) chips.push(`<span class="lc-chip busy">Preparing zoomed-out view · ${Math.round(job!.progress * 100)}%</span>`);
  else if (!l.overview && l.overview_suggested != null)
    chips.push(r.autoOverviews && st.visible ? `<span class="lc-chip busy">Zoomed-out view queued</span>` : `<span class="lc-chip warn">Shows from zoom ${l.live_minzoom}</span>`);
  else chips.push(`<span class="lc-chip ok">✓ Ready</span>`);
  if (st.auto) chips.push(`<span class="lc-chip" title="${esc(st.auto)}">✨ Styled for you</span>`);
  if (!st.visible) chips.push(`<span class="lc-chip">Hidden</span>`);
  return `<div class="lc-chips">${chips.join('')}</div>${running ? `<div class="lc-prog"><i style="width:${Math.round(job!.progress * 100)}%"></i></div>` : ''}`;
}

const GLYPH: Record<string, string> = { point: '◉', line: '〰', polygon: '▰', unknown: '◆' };

export function lazyCard(r: RowState): string {
  const { layer: l, style: st } = r;
  const c = primaryColor(st.symbology);
  const acts = r.actions
    .slice(0, 2)
    .map(([id, label], i) => `<button data-act="recipe" data-recipe="${esc(id)}" class="${i === 0 ? 'pri' : ''}">${esc(label)}</button>`)
    .join('');
  return `<div class="layer card${r.selected ? ' selected' : ''}${st.visible ? '' : ' off'}" data-id="${esc(l.id)}" style="--c:${esc(c)}">
    <div class="lc-top">
      <span class="lc-glyph">${GLYPH[l.geometry] ?? '◆'}</span>
      <span class="lc-title"><b class="name" title="${esc(l.id)}">${esc(friendlyName(l, r.all))}</b>
        <small>${fmt(l.feature_count)} ${noun(l)} · ${esc(l.driver)}</small></span>
      <label class="lc-eye" title="${st.visible ? 'Hide' : 'Show'}"><input type="checkbox" ${st.visible ? 'checked' : ''}  aria-label="Show ${esc(friendlyName(l, r.all))}" /><span>${st.visible ? '👁' : '◌'}</span></label>
    </div>
    <p class="lc-sentence">${sentence(l, st.symbology)}</p>
    ${legendBar(st.symbology)}
    ${statusChips(r)}
    <div class="lc-acts">${acts}<button data-act="zoom">Zoom to</button><button data-act="props" title="Style and settings" aria-label="Style and settings">⋯</button></div>
  </div>`;
}

function symbologySummary(s: Symbology): string {
  if (s.kind === 'single') return 'single symbol';
  if (s.kind === 'unique') return `unique ${s.field} (${s.classes.length})`;
  const m = { jenks: 'natural breaks', quantile: 'quantile', equal: 'equal interval', guideline: 'WHO guideline' }[s.method];
  return `graduated ${s.field} · ${m} · ${s.breaks.length} classes`;
}

export function proRow(r: RowState): string {
  const { layer: l, style: st, job } = r;
  const running = job && (job.status === 'queued' || job.status === 'running');
  const ext = /\.[a-z0-9]+$/i.exec(l.id)?.[0] ?? '';
  const items = legendItems(st.symbology);
  const zr = l.overview ? `pyramid z0–${l.overview.max_zoom}` : l.overview_suggested != null ? `live z${l.live_minzoom}–${l.maxzoom}` : `z${l.minzoom}–${l.maxzoom}`;
  const badges = [
    running ? `<b class="busy">pyramid ${Math.round(job!.progress * 100)}%</b>` : '',
    !l.overview && !running && l.overview_suggested != null ? `<b class="warn">${r.autoOverviews && st.visible ? 'pyramid queued' : 'overviews suggested'}</b>` : '',
    st.auto ? `<b title="${esc(st.auto)}">auto</b>` : '',
  ].join('');
  const open = r.expanded ?? true;
  return `<div class="layer pro${r.selected ? ' selected' : ''}" data-id="${esc(l.id)}" draggable="true" role="treeitem" aria-level="${(r.depth ?? 0) + 2}" aria-expanded="${open}" aria-selected="${r.selected}" style="--c:${esc(primaryColor(st.symbology))};--d:${r.depth ?? 0}">
    <button class="pr-tw" data-act="twisty" aria-label="${open ? 'Collapse' : 'Expand'} legend" ${items.length ? '' : 'disabled'}>${items.length ? (open ? '▾' : '▸') : ''}</button>
    <input type="checkbox" ${st.visible ? 'checked' : ''} aria-label="Toggle ${esc(l.id)}" />
    <span class="swatch ${l.geometry}" style="--c:${esc(primaryColor(st.symbology))}"></span>
    <b class="name" title="Open symbology">${esc(ext ? l.id.slice(0, -ext.length) : l.id)}<em>${esc(ext)}</em></b>
    <span class="pr-n">${fmt(l.feature_count)}</span>
    <input class="pr-op" type="range" min="0" max="100" step="5" value="${Math.round(st.opacity * 100)}" data-act="opacity" title="Opacity ${Math.round(st.opacity * 100)}%" aria-label="Opacity" />
    <span class="tools">
      <button data-act="up" title="Move up" aria-label="Move up" ${r.first ? 'disabled' : ''}>▲</button>
      <button data-act="down" title="Move down" aria-label="Move down" ${r.last ? 'disabled' : ''}>▼</button>
      <button data-act="props" title="Symbology" aria-label="Symbology">⚙</button>
    </span>
    <small class="pr-sub">${esc(l.geometry)} · ${esc(l.crs)} · ${zr} · ${esc(symbologySummary(st.symbology))} ${badges}</small>
    ${
      items.length && open
        ? `<div class="legend">${items
            .slice(0, 10)
            .map((it) => `<div><i style="background:${esc(it.color)}"></i>${esc(it.label)}<span>${it.count != null ? fmt(it.count) : ''}</span></div>`)
            .join('')}${items.length > 10 ? `<div class="more">… ${items.length - 10} more</div>` : ''}</div>`
        : ''
    }
  </div>`;
}

/** A group layer row in the Pro tree: twisty, switch, name, member count, tools. */
export function proGroup(g: { id: string; name: string; visible: boolean; expanded: boolean }, count: number): string {
  return `<div class="pr-group" data-group="${esc(g.id)}" role="treeitem" aria-level="2" aria-expanded="${g.expanded}">
    <button class="pr-tw" data-gact="twisty" aria-label="${g.expanded ? 'Collapse' : 'Expand'} group">${g.expanded ? '▾' : '▸'}</button>
    <input type="checkbox" ${g.visible ? 'checked' : ''} data-gact="visible" aria-label="Show group ${esc(g.name)}" />
    <span class="pr-gico" aria-hidden="true">▤</span>
    <b class="pr-gname" title="Double-click to rename">${esc(g.name)}</b>
    <span class="pr-n">${count} layer${count === 1 ? '' : 's'}</span>
    <span class="tools"><button data-gact="rename" title="Rename group" aria-label="Rename group">✎</button><button data-gact="ungroup" title="Ungroup (keep the layers)" aria-label="Ungroup">⊟</button></span>
  </div>`;
}

export function modeSwitch(mode: UiMode): string {
  return `<div class="lc-mode" role="tablist" aria-label="Layer list mode">
    <button role="tab" data-mode="lazy" aria-selected="${mode === 'lazy'}" title="Cards that explain each layer">Lazy</button>
    <button role="tab" data-mode="pro" aria-selected="${mode === 'pro'}" title="Dense layer tree with every setting">Pro</button>
  </div>`;
}

/** Recipes that fit a layer, best first, as [recipe id, button label]. Only recipes that take a `layer` input. */
export function actionsFor(l: LayerInfo, s: Symbology, recipes: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  const add = (id: string, label: string) => recipes.has(id) && out.push([id, label]);
  if (l.geometry === 'point') {
    const numeric = s.kind === 'graduated';
    if (numeric) add('interpolate-samples', 'Make a surface');
    add('points-to-hotspots', 'Hot spots');
    if (l.feature_count >= 5000) add('points-to-hexbins', 'Hexagon map');
  }
  return out;
}
