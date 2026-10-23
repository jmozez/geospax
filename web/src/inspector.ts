// The Inspector (right pane, Lazy mode): one selected layer told as a short story instead of a
// settings form. What it shows (sentence + legend with counts), how to colour it (one chip per
// useful field: the engine classifies on click), what to do next (the recipes that fit it), and
// where it came from. Pro mode keeps the full Symbology / Attributes panes for the same layer.
import type { LayerInfo } from './backend';
import { fieldName, friendlyName, sentence } from './layercards';
import { fmtNum, legendItems, primaryColor, type LayerStyle } from './symbology';

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');
const isId = (n: string) => /^(id|fid|gid|oid|objectid|ogc_fid|uuid|index)$|_id$|^id_/i.test(n);
const KIND: Record<string, string> = { integer: 'whole numbers', real: 'numbers', string: 'text', date: 'dates', datetime: 'times' };

export interface InspectorState {
  layer: LayerInfo;
  style: LayerStyle;
  all: LayerInfo[];
  next: { label: string }[];
}

export function inspectorHtml(s: InspectorState | null): string {
  if (!s) {
    return `<div class="ins-empty"><div class="ins-empty-ico">◎</div><b>Click a layer</b><p>Its story shows up here: what it shows, how to colour it and what you can do with it.</p></div>`;
  }
  const { layer: l, style: st } = s;
  const sym = st.symbology;
  const cur = sym.kind === 'single' ? null : sym.field;
  const items = legendItems(sym).filter((i) => (i.count ?? 0) > 0);
  const total = items.reduce((a, i) => a + (i.count ?? 0), 0) || 1;
  const fields = l.fields.filter((f) => !isId(f.name) && (f.kind === 'string' || f.kind === 'integer' || f.kind === 'real')).slice(0, 10);
  const [w, so, e, n] = l.bounds;
  return `<div class="ins" style="--c:${esc(primaryColor(sym))}">
    <header class="ins-head">
      <span class="ins-glyph"></span>
      <div><h2>${esc(friendlyName(l, s.all))}</h2><small>${fmt(l.feature_count)} ${l.geometry === 'polygon' ? 'areas' : l.geometry === 'line' ? 'lines' : 'points'} · ${esc(l.driver)}</small></div>
    </header>
    <p class="ins-story">${sentence(l, sym)}</p>
    ${st.auto ? `<p class="ins-why"><b>✨ Why it looks like this</b>${esc(st.auto)}</p>` : ''}
    ${
      items.length
        ? `<div class="ins-legend">${items
            .map(
              (i) => `<div class="ins-cls"><i style="background:${esc(i.color)}"></i><span>${esc(i.label)}</span>
                <span class="ins-bar"><b style="width:${Math.max(2, Math.round((100 * (i.count ?? 0)) / total))}%;background:${esc(i.color)}"></b></span>
                <em>${fmt(i.count ?? 0)}</em></div>`,
            )
            .join('')}</div>`
        : ''
    }
    <h3>Colour it by</h3>
    <div class="ins-chips">
      <button class="ins-chip auto" data-ins="auto">✨ Let GeoSpaX choose</button>
      ${fields.map((f) => `<button class="ins-chip${f.name === cur ? ' on' : ''}" data-ins="colour" data-field="${esc(f.name)}" title="${esc(KIND[f.kind] ?? f.kind)}">${esc(fieldName(f.name))}</button>`).join('')}
      <button class="ins-chip${cur ? '' : ' on'}" data-ins="colour" data-field="">One colour</button>
    </div>
    <h3>See through it</h3>
    <input class="ins-op" type="range" min="10" max="100" step="5" value="${Math.round(st.opacity * 100)}" data-ins="opacity" aria-label="Opacity">
    <h3>Do something with it</h3>
    <div class="ins-acts">
      ${s.next.map((x, i) => `<button class="${i === 0 ? 'pri' : ''}" data-ins="next" data-i="${i}">▶ ${esc(x.label)}</button>`).join('')}
      <button data-ins="zoom">Zoom to it</button>
      <button data-ins="table">See the rows</button>
    </div>
    <h3>Where it came from</h3>
    <dl class="ins-about">
      <dt>File</dt><dd title="${esc(l.source)}">${esc(l.source.split(/[\\/]/).pop() ?? l.source)}</dd>
      <dt>Saved in</dt><dd class="ins-path" title="${esc(l.source)}">${esc(l.source.replace(/[\\/][^\\/]*$/, '') || l.source)}</dd>
      <dt>Format</dt><dd>${esc(l.driver)} · ${esc(l.crs)}</dd>
      <dt>Covers</dt><dd>${fmtNum(w)}…${fmtNum(e)}° E, ${fmtNum(so)}…${fmtNum(n)}° N</dd>
      <dt>Columns</dt><dd>${l.fields.length}: ${esc(l.fields.slice(0, 6).map((f) => f.name).join(', '))}${l.fields.length > 6 ? '…' : ''}</dd>
    </dl>
  </div>`;
}
