// Editing and selection — the Edit tab (docs/USER_GUIDE.md §5a). Drawing and vertex editing use
// terra-draw (MIT); every change is sent to the engine (crates/engine/src/edit.rs), which writes it
// to the layer's edit copy, so the original file is never touched and Discard edits restores it.
//
//   create   point / line / polygon into the active layer, snapping to visible features
//   modify   edit vertices (drag, insert at midpoints, right-click to delete), move, delete
//   select   click, rectangle, by attributes (SQL WHERE), by location (another layer)
//   history  undo / redo of whole edits (create, change, delete), across layers
import type * as maplibregl from 'maplibre-gl';
import { TerraDraw, TerraDrawLineStringMode, TerraDrawPointMode, TerraDrawPolygonMode, TerraDrawRectangleMode, TerraDrawSelectMode, type GeoJSONStoreFeatures } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { Backend, LayerInfo } from './backend';

type Fid = number;
type Geometry = GeoJSON.Geometry;
interface FeatureJson { type: 'Feature'; id?: Fid; geometry: Geometry | null; properties: Record<string, unknown> }

export interface EditHost {
  map: maplibregl.Map;
  backend: Backend;
  layers: () => LayerInfo[];
  activeId: () => string | null;
  setActive: (id: string) => void;
  /** a layer's data changed: re-read layer info, bust its tiles, redraw */
  changed: (id: string, info?: LayerInfo) => Promise<void>;
  /** the selection changed: redraw the highlight */
  selectionChanged: () => void;
  openTable: (id: string) => void;
  setStatus: (text: string, ms?: number) => void;
  log: (line: string, level?: 'info' | 'warn' | 'error') => void;
}

type Op =
  | { kind: 'add'; layer: string; fid: Fid; feature: FeatureJson }
  | { kind: 'update'; layer: string; fid: Fid; before: FeatureJson; after: FeatureJson }
  | { kind: 'delete'; layer: string; features: { fid: Fid; feature: FeatureJson }[] };

export type EditTool = 'idle' | 'point' | 'line' | 'polygon' | 'select' | 'box' | 'vertices';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = encodeURIComponent;
const SNAP_PX = 12;

/** Map layers that draw one GeoSpaX layer (see buildStyle in main.ts). */
export const drawnLayers = (map: maplibregl.Map, id: string) => [`${id}#fill`, `${id}#line`, `${id}#circle`].filter((l) => map.getLayer(l));

// ---------------------------------------------------------------- small dialogs

export interface DialogOpts {
  wide?: boolean;
  /** called once the card is in the page (wire up live parts here) */
  onOpen?: (root: HTMLElement) => void;
  /** a button was pressed: return false to keep the dialog open (e.g. "Check") */
  onButton?: (button: string, values: Record<string, string>, root: HTMLElement) => boolean | Promise<boolean>;
}

/** A modal card; resolves with the button pressed ('' = closed) and the form's values. */
export function dialog(title: string, body: string, buttons: [string, string][] = [['ok', 'OK'], ['', 'Cancel']], opts: DialogOpts = {}): Promise<{ button: string; values: Record<string, string>; root: HTMLElement }> {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal gx-dialog';
    m.innerHTML = `<form class="sheet${opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><b>${esc(title)}</b><button type="button" data-btn="" aria-label="Close">✕</button></header>
      <div class="body">${body}</div>
      <footer>${buttons.map(([v, label], i) => `<button type="${i === 0 ? 'submit' : 'button'}" data-btn="${v}" class="${i === 0 ? 'primary' : ''}">${esc(label)}</button>`).join('')}</footer>
    </form>`;
    document.body.append(m);
    const form = m.querySelector('form')!;
    const values = () => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));
    let closing = false;
    const done = async (button: string) => {
      if (closing) return;
      const v = values();
      if (button && opts.onButton) {
        let close: boolean;
        try {
          close = await opts.onButton(button, v, form);
        } catch (err) {
          const msg = form.querySelector<HTMLElement>('[data-msg]');
          if (msg) { msg.textContent = String((err as Error).message ?? err); msg.className = 'dlg-msg err'; }
          return;
        }
        if (!close) return;
      }
      closing = true;
      m.remove();
      resolve({ button, values: v, root: form });
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void done((e.submitter as HTMLElement | null)?.dataset.btn ?? buttons[0][0]);
    });
    m.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-btn]');
      if (b && b.getAttribute('type') !== 'submit') void done(b.dataset.btn ?? '');
      else if (e.target === m) void done('');
    });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') void done('');
    });
    opts.onOpen?.(form);
    (form.querySelector<HTMLElement>('[autofocus]') ?? form.querySelector<HTMLElement>('input, select, textarea'))?.focus();
  });
}

/** Say something inside an open dialog (its [data-msg] line). */
export function say(root: HTMLElement, text: string, kind: 'ok' | 'err' | '' = '') {
  const el = root.querySelector<HTMLElement>('[data-msg]');
  if (el) { el.textContent = text; el.className = `dlg-msg ${kind}`; }
}

const fieldOptions = (l: LayerInfo | undefined, selected = '', numericOnly = false) =>
  (l?.fields ?? [])
    .filter((f) => !numericOnly || f.kind === 'integer' || f.kind === 'real')
    .map((f) => `<option value="${esc(f.name)}"${f.name === selected ? ' selected' : ''}>${esc(f.name)} · ${esc(f.kind)}</option>`)
    .join('');

const sqlIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sqlValue = (v: unknown) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// ---------------------------------------------------------------- the editor

export class Editor {
  /** selected fids per layer */
  readonly selection = new Map<string, Set<Fid>>();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private draw: TerraDraw | null = null;
  tool: EditTool = 'idle';
  snapping = true;
  /** the feature whose vertices are being edited */
  private vertexEdit: { layer: string; fid: Fid; drawId: string | number; before: FeatureJson } | null = null;
  private clickHandler = (e: maplibregl.MapMouseEvent) => void this.onMapClick(e);
  private busy = false;

  constructor(private h: EditHost) {
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (this.undoStack.length) { e.preventDefault(); void this.undo(); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        if (this.redoStack.length) { e.preventDefault(); void this.redo(); }
      } else if (e.key === 'Escape' && this.tool !== 'idle') {
        void this.setTool('idle');
      } else if (e.key === 'Enter' && this.tool === 'vertices') {
        void this.finishVertices();
      } else if (e.key === 'Delete' && this.tool === 'select') {
        void this.deleteSelected();
      }
    });
  }

  // ---------------------------------------------------------------- state

  private layer(id = this.h.activeId()): LayerInfo | undefined {
    return id ? this.h.layers().find((l) => l.id === id) : undefined;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  selected(id: string): Fid[] {
    return [...(this.selection.get(id) ?? [])];
  }

  /** Replace, add to, remove from or intersect with a layer's selection. */
  setSelection(id: string, fids: Iterable<Fid>, how: 'new' | 'add' | 'remove' | 'and' = 'new') {
    const cur = this.selection.get(id) ?? new Set<Fid>();
    const next = new Set<Fid>(how === 'new' ? [] : cur);
    const incoming = new Set(fids);
    if (how === 'remove') for (const f of incoming) next.delete(f);
    else if (how === 'and') for (const f of cur) { if (!incoming.has(f)) next.delete(f); }
    else for (const f of incoming) next.add(f);
    if (next.size) this.selection.set(id, next);
    else this.selection.delete(id);
    this.h.selectionChanged();
    document.dispatchEvent(new CustomEvent('geospax:selection', { detail: { layer: id, count: next.size } }));
  }

  clearSelection(id?: string) {
    if (id) this.selection.delete(id);
    else this.selection.clear();
    this.h.selectionChanged();
    document.dispatchEvent(new CustomEvent('geospax:selection', { detail: { layer: id ?? null, count: 0 } }));
  }

  private status(text: string, ms = 5000) {
    this.h.setStatus(text, ms);
  }

  private fail(err: unknown) {
    const msg = String((err as Error).message ?? err);
    this.h.log(`edit: ${msg}`, 'error');
    this.status(msg, 8000);
  }

  // ---------------------------------------------------------------- engine calls

  private async api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return this.h.backend.json<T>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  }

  private async getFeature(layer: string, fid: Fid): Promise<FeatureJson> {
    return this.api<FeatureJson>(`api/layers/${enc(layer)}/features/${fid}`);
  }

  private async afterChange(layer: string, info?: LayerInfo) {
    await this.h.changed(layer, info);
    document.dispatchEvent(new CustomEvent('geospax:edited', { detail: { layer } }));
  }

  /** First edit of a file: say once where edits go. */
  private async confirmFirstEdit(id: string): Promise<boolean> {
    const l = this.layer(id);
    if (!l || l.edited) return true;
    const key = 'geospax.edit.copy-ok';
    try { if (localStorage.getItem(key)) return true; } catch { /* private mode */ }
    const r = await dialog(
      'Edit this layer?',
      `<p>Edits to <b>${esc(l.name)}</b> are saved to a GeoPackage copy that GeoSpaX keeps for you; the original file is not changed.</p>
       <p class="dim">Undo steps back one edit at a time. <b>Discard edits</b> goes back to the original file, and <b>Export</b> saves the edited data wherever you like.</p>
       <label class="chk"><input type="checkbox" name="remember" value="1" checked> Don't ask again</label>`,
      [['ok', 'Start editing'], ['', 'Cancel']],
    );
    if (r.button !== 'ok') return false;
    if (r.values.remember) try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    return true;
  }

  private async addFeature(layer: string, f: FeatureJson): Promise<Fid> {
    const r = await this.api<{ fid: Fid; layer: LayerInfo }>(`api/layers/${enc(layer)}/features`, 'POST', f);
    await this.afterChange(layer, r.layer);
    return r.fid;
  }

  private async putFeature(layer: string, fid: Fid, f: Partial<FeatureJson>) {
    const r = await this.api<{ layer: LayerInfo }>(`api/layers/${enc(layer)}/features/${fid}`, 'PUT', f);
    await this.afterChange(layer, r.layer);
  }

  private async deleteFeatures(layer: string, fids: Fid[]) {
    const r = await this.api<{ deleted: number; layer: LayerInfo }>(`api/layers/${enc(layer)}/features/delete`, 'POST', { fids });
    await this.afterChange(layer, r.layer);
    return r.deleted;
  }

  private push(op: Op) {
    this.undoStack.push(op);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    document.dispatchEvent(new CustomEvent('geospax:edit-history'));
  }

  // ---------------------------------------------------------------- undo / redo

  async undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    try {
      await this.apply(op, true);
      this.redoStack.push(op);
      this.status(`Undone: ${this.describe(op)}`);
    } catch (e) {
      this.undoStack.push(op);
      this.fail(e);
    }
    document.dispatchEvent(new CustomEvent('geospax:edit-history'));
  }

  async redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    try {
      await this.apply(op, false);
      this.undoStack.push(op);
      this.status(`Redone: ${this.describe(op)}`);
    } catch (e) {
      this.redoStack.push(op);
      this.fail(e);
    }
    document.dispatchEvent(new CustomEvent('geospax:edit-history'));
  }

  private describe(op: Op) {
    return op.kind === 'add' ? 'add feature' : op.kind === 'update' ? 'change feature' : `delete ${op.features.length} feature${op.features.length === 1 ? '' : 's'}`;
  }

  /** Run an op forwards or backwards. Re-created features get new fids; the op keeps track. */
  private async apply(op: Op, backwards: boolean) {
    if (op.kind === 'add') {
      if (backwards) await this.deleteFeatures(op.layer, [op.fid]);
      else op.fid = await this.addFeature(op.layer, op.feature);
    } else if (op.kind === 'update') {
      const f = backwards ? op.before : op.after;
      await this.putFeature(op.layer, op.fid, { geometry: f.geometry, properties: f.properties });
    } else if (backwards) {
      for (const x of op.features) x.fid = await this.addFeature(op.layer, x.feature);
    } else {
      await this.deleteFeatures(op.layer, op.features.map((x) => x.fid));
    }
  }

  // ---------------------------------------------------------------- tools

  private ensureDraw(): TerraDraw {
    if (this.draw) return this.draw;
    const snap = { toCoordinate: true, toCustom: (e: { containerX: number; containerY: number }) => (this.snapping ? this.snapTo(e.containerX, e.containerY) : undefined) };
    const accent = '#ff8a5c';
    const draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map: this.h.map as never, coordinatePrecision: 9 }),
      modes: [
        new TerraDrawPointMode({ styles: { pointColor: accent, pointWidth: 7, pointOutlineColor: '#ffffff', pointOutlineWidth: 2 } }),
        new TerraDrawLineStringMode({ snapping: snap, styles: { lineStringColor: accent, lineStringWidth: 3, closingPointColor: accent } }),
        new TerraDrawPolygonMode({ snapping: snap, styles: { fillColor: accent, fillOpacity: 0.25, outlineColor: accent, outlineWidth: 2 } }),
        new TerraDrawRectangleMode({ styles: { fillColor: '#4cc9f0', fillOpacity: 0.15, outlineColor: '#4cc9f0', outlineWidth: 2 } }),
        new TerraDrawSelectMode({
          flags: Object.fromEntries(
            ['point', 'linestring', 'polygon'].map((m) => [m, { feature: { draggable: true, coordinates: { draggable: true, midpoints: true, deletable: true, snappable: true } } }]),
          ),
          styles: { selectedPolygonColor: accent, selectedPolygonOutlineColor: accent, selectedLineStringColor: accent, selectionPointColor: '#ffffff', selectionPointOutlineColor: accent, midPointColor: accent },
        }),
      ],
    });
    draw.start();
    draw.on('finish', (id, ctx) => void this.onFinish(id as string, ctx.mode, ctx.action));
    this.draw = draw;
    return draw;
  }

  /** Snap to the nearest vertex of any visible vector feature within SNAP_PX pixels. */
  private snapTo(x: number, y: number): [number, number] | undefined {
    const map = this.h.map;
    const ids = this.h.layers().flatMap((l) => drawnLayers(map, l.id));
    if (!ids.length) return undefined;
    const hits = map.queryRenderedFeatures([[x - SNAP_PX, y - SNAP_PX], [x + SNAP_PX, y + SNAP_PX]], { layers: ids });
    let best: [number, number] | undefined;
    let bestD = SNAP_PX * SNAP_PX;
    const visit = (c: number[]) => {
      const p = map.project([c[0], c[1]]);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d <= bestD) { bestD = d; best = [c[0], c[1]]; }
    };
    const walk = (g: Geometry) => {
      if (g.type === 'Point') visit(g.coordinates);
      else if (g.type === 'MultiPoint' || g.type === 'LineString') g.coordinates.forEach(visit);
      else if (g.type === 'MultiLineString' || g.type === 'Polygon') g.coordinates.forEach((r) => r.forEach(visit));
      else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((r) => r.forEach(visit)));
    };
    for (const f of hits.slice(0, 50)) walk(f.geometry as Geometry);
    return best;
  }

  async setTool(tool: EditTool) {
    const map = this.h.map;
    if (this.tool === 'vertices' && tool !== 'vertices' && this.vertexEdit) await this.finishVertices(true);
    map.off('click', this.clickHandler);
    this.draw?.clear();
    this.tool = tool;
    document.body.dataset.editTool = tool;
    document.dispatchEvent(new CustomEvent('geospax:edit-tool', { detail: tool }));
    if (tool === 'idle') {
      if (this.draw) this.draw.setMode('static');
      map.getCanvas().style.cursor = '';
      return;
    }
    if (tool === 'select') {
      if (this.draw) this.draw.setMode('static');
      map.on('click', this.clickHandler);
      map.getCanvas().style.cursor = 'pointer';
      this.status('Select: click a feature (Shift adds, Ctrl removes). Delete removes the selected features. Esc ends.', 8000);
      return;
    }
    const id = this.h.activeId();
    const l = this.layer(id);
    if (tool !== 'box' && !l) {
      this.status('Pick a layer in Contents first: edits go into the active layer.', 6000);
      this.tool = 'idle';
      return;
    }
    if (tool === 'point' || tool === 'line' || tool === 'polygon') {
      const want = tool === 'point' ? 'point' : tool === 'line' ? 'line' : 'polygon';
      if (l!.geometry !== want) {
        this.status(`${l!.name} holds ${l!.geometry}s: choose a ${l!.geometry} tool, or make a new layer for ${want}s (Edit › New layer).`, 8000);
        this.tool = 'idle';
        return;
      }
      if (!(await this.confirmFirstEdit(id!))) { this.tool = 'idle'; return; }
      this.ensureDraw().setMode(tool === 'line' ? 'linestring' : tool);
      this.status(tool === 'point' ? `Click to add points to ${l!.name}. Esc ends.` : `Click to add vertices; double-click (or click the first point) to finish. ${this.snapping ? 'Snapping is on.' : ''} Esc ends.`, 9000);
      return;
    }
    if (tool === 'box') {
      this.ensureDraw().setMode('rectangle');
      this.status('Drag or click two corners: features of the active layer inside the box are selected.', 7000);
      return;
    }
    if (tool === 'vertices') await this.startVertices();
  }

  private async onMapClick(e: maplibregl.MapMouseEvent) {
    if (this.tool !== 'select') return;
    const id = this.h.activeId();
    const map = this.h.map;
    const pad = 4;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    // the active layer first; otherwise the top-most layer under the cursor becomes active
    let layers = id ? drawnLayers(map, id) : [];
    let hits = layers.length ? map.queryRenderedFeatures(box, { layers }) : [];
    if (!hits.length) {
      layers = this.h.layers().flatMap((l) => drawnLayers(map, l.id));
      hits = layers.length ? map.queryRenderedFeatures(box, { layers }) : [];
    }
    const how = e.originalEvent.ctrlKey || e.originalEvent.metaKey ? 'remove' : e.originalEvent.shiftKey ? 'add' : 'new';
    if (!hits.length) {
      if (how === 'new' && id) this.clearSelection(id);
      return;
    }
    const lid = hits[0].layer.id.replace(/#.*$/, '');
    if (lid !== id) this.h.setActive(lid);
    const fid = Number(hits[0].id);
    if (!Number.isFinite(fid)) return;
    this.setSelection(lid, [fid], how);
    const n = this.selected(lid).length;
    this.status(`${n} selected in ${this.layer(lid)?.name ?? lid}`);
  }

  private async onFinish(drawId: string, mode: string, action: string) {
    const draw = this.draw!;
    if (this.busy) return;
    if (mode === 'rectangle') {
      const f = draw.getSnapshotFeature(drawId);
      draw.removeFeatures([drawId]);
      if (f) this.selectInBox(f.geometry as GeoJSON.Polygon);
      return;
    }
    if (mode === 'select') return; // vertex edits are saved on Enter / Finish
    if (action !== 'draw') return;
    const id = this.h.activeId();
    const f = draw.getSnapshotFeature(drawId);
    draw.removeFeatures([drawId]);
    if (!id || !f) return;
    this.busy = true;
    try {
      const feature: FeatureJson = { type: 'Feature', geometry: f.geometry as Geometry, properties: {} };
      const props = await this.attributeForm(id, feature.properties, 'New feature');
      if (props === null) { this.status('Feature not added'); return; }
      feature.properties = props;
      const fid = await this.addFeature(id, feature);
      this.push({ kind: 'add', layer: id, fid, feature });
      this.setSelection(id, [fid]);
      this.status(`Added feature ${fid} to ${this.layer(id)?.name ?? id}. Ctrl+Z undoes it.`);
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy = false;
    }
  }

  private selectInBox(poly: GeoJSON.Polygon) {
    const id = this.h.activeId();
    if (!id) return this.status('Pick a layer in Contents first.');
    const map = this.h.map;
    const pts = poly.coordinates[0].map((c) => map.project([c[0], c[1]]));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const hits = map.queryRenderedFeatures([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { layers: drawnLayers(map, id) });
    const fids = [...new Set(hits.map((f) => Number(f.id)).filter(Number.isFinite))];
    this.setSelection(id, fids);
    this.status(`${fids.length} selected in ${this.layer(id)?.name ?? id}`);
  }

  // ---------------------------------------------------------------- vertex editing

  private async startVertices() {
    const id = this.h.activeId();
    const sel = id ? this.selected(id) : [];
    if (!id || sel.length !== 1) {
      this.status('Select one feature first (Select tool), then Edit vertices.', 7000);
      this.tool = 'idle';
      return;
    }
    if (!(await this.confirmFirstEdit(id))) { this.tool = 'idle'; return; }
    try {
      const before = await this.getFeature(id, sel[0]);
      if (!before.geometry) throw new Error('this feature has no geometry');
      const draw = this.ensureDraw();
      draw.setMode('select');
      const parts = this.splitForDraw(before.geometry);
      if (!parts.length) throw new Error(`${before.geometry.type} geometries cannot be edited here yet`);
      if (parts.length > 1) this.status(`Multi-part feature: editing its ${parts.length} parts together.`, 6000);
      const res = draw.addFeatures(parts);
      const bad = res.find((r) => !r.valid);
      if (bad) throw new Error(`terra-draw refused the geometry (${bad.reason ?? 'invalid'})`);
      const first = res[0].id!;
      draw.selectFeature(first);
      this.vertexEdit = { layer: id, fid: sel[0], drawId: first, before };
      this.status('Drag vertices or the shape; drag a midpoint to add a vertex, right-click a vertex to delete it. Enter (or Finish) saves, Esc cancels.', 12000);
    } catch (e) {
      this.tool = 'idle';
      this.fail(e);
    }
  }

  /** GeoJSON → terra-draw features (multi-parts become one feature per part). */
  private splitForDraw(g: Geometry): GeoJSONStoreFeatures[] {
    const f = (geometry: Geometry, mode: string) => ({ type: 'Feature', geometry, properties: { mode } }) as GeoJSONStoreFeatures;
    switch (g.type) {
      case 'Point': return [f(g, 'point')];
      case 'MultiPoint': return g.coordinates.map((c) => f({ type: 'Point', coordinates: c }, 'point'));
      case 'LineString': return [f(g, 'linestring')];
      case 'MultiLineString': return g.coordinates.map((c) => f({ type: 'LineString', coordinates: c }, 'linestring'));
      case 'Polygon': return [f(g, 'polygon')];
      case 'MultiPolygon': return g.coordinates.map((c) => f({ type: 'Polygon', coordinates: c }, 'polygon'));
      default: return [];
    }
  }

  /** Save (or with `cancel`, drop) the vertex edit. */
  async finishVertices(cancel = false) {
    const v = this.vertexEdit;
    if (!v || !this.draw) return;
    this.vertexEdit = null;
    const parts = this.draw.getSnapshot().filter((f) => f.properties.mode !== 'rectangle');
    this.draw.clear();
    this.draw.setMode('static');
    this.tool = 'idle';
    document.body.dataset.editTool = 'idle';
    document.dispatchEvent(new CustomEvent('geospax:edit-tool', { detail: 'idle' }));
    if (cancel || !parts.length) return this.status('Vertex edit cancelled');
    const t = v.before.geometry!.type;
    let geometry: Geometry;
    const coords = parts.map((p) => (p.geometry as GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon).coordinates);
    if (t.startsWith('Multi')) geometry = { type: t, coordinates: coords } as Geometry;
    else geometry = parts[0].geometry as Geometry;
    try {
      await this.putFeature(v.layer, v.fid, { geometry });
      const after: FeatureJson = { ...v.before, geometry };
      this.push({ kind: 'update', layer: v.layer, fid: v.fid, before: v.before, after });
      this.status('Vertices saved. Ctrl+Z undoes it.');
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------- feature commands

  async deleteSelected() {
    const id = this.h.activeId();
    const fids = id ? this.selected(id) : [];
    if (!id || !fids.length) return this.status('Nothing selected in the active layer.');
    if (fids.length > 1) {
      const r = await dialog('Delete features', `<p>Delete <b>${fids.length}</b> selected features from <b>${esc(this.layer(id)?.name)}</b>? Undo brings them back.</p>`, [['ok', 'Delete'], ['', 'Cancel']]);
      if (r.button !== 'ok') return;
    }
    if (!(await this.confirmFirstEdit(id))) return;
    try {
      // keep copies so undo can put them back (up to 2,000; beyond that undo is not offered)
      const keep = fids.length <= 2000 ? await Promise.all(fids.map(async (fid) => ({ fid, feature: await this.getFeature(id, fid) }))) : null;
      const n = await this.deleteFeatures(id, fids);
      this.clearSelection(id);
      if (keep) this.push({ kind: 'delete', layer: id, features: keep });
      this.status(`Deleted ${n} feature${n === 1 ? '' : 's'}${keep ? '. Ctrl+Z undoes it.' : ' (too many to undo).'}`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Edit the attributes of the (single) selected feature. */
  async editAttributes(id = this.h.activeId(), fid?: Fid) {
    if (!id) return this.status('Pick a layer first.');
    const f0 = fid ?? (this.selected(id).length === 1 ? this.selected(id)[0] : undefined);
    if (f0 == null) return this.status('Select one feature to edit its attributes, or use the attribute table.');
    try {
      const before = await this.getFeature(id, f0);
      const props = await this.attributeForm(id, before.properties, `Feature ${f0}`);
      if (props === null) return;
      const changed = Object.fromEntries(Object.entries(props).filter(([k, v]) => String(v ?? '') !== String(before.properties[k] ?? '')));
      if (!Object.keys(changed).length) return this.status('No changes');
      if (!(await this.confirmFirstEdit(id))) return;
      await this.putFeature(id, f0, { properties: changed });
      this.push({ kind: 'update', layer: id, fid: f0, before, after: { ...before, properties: { ...before.properties, ...changed } } });
      this.status(`Saved ${Object.keys(changed).length} attribute${Object.keys(changed).length === 1 ? '' : 's'}`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Change one cell (attribute table inline edit). */
  async setValue(id: string, fid: Fid, field: string, value: unknown) {
    if (!(await this.confirmFirstEdit(id))) return false;
    try {
      const before = await this.getFeature(id, fid);
      await this.putFeature(id, fid, { properties: { [field]: value } });
      this.push({ kind: 'update', layer: id, fid, before, after: { ...before, properties: { ...before.properties, [field]: value } } });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** A form with one input per field; resolves with the values, or null when cancelled. */
  private async attributeForm(id: string, values: Record<string, unknown>, title: string): Promise<Record<string, unknown> | null> {
    const l = this.layer(id);
    const fields = l?.fields ?? [];
    if (!fields.length) return {};
    const input = (f: { name: string; kind: string }) => {
      const v = values[f.name];
      const type = f.kind === 'integer' || f.kind === 'real' ? 'number' : 'text';
      const step = f.kind === 'real' ? ' step="any"' : '';
      return `<label class="row"><span>${esc(f.name)} <i>${esc(f.kind)}</i></span><input name="f:${esc(f.name)}" type="${type}"${step} value="${esc(v ?? '')}"></label>`;
    };
    const r = await dialog(`${title} · ${l?.name ?? id}`, `<div class="attr-form">${fields.map(input).join('')}</div>`, [['ok', 'Save'], ['', 'Cancel']]);
    if (r.button !== 'ok') return null;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = r.values[`f:${f.name}`] ?? '';
      if (raw === '' && (values[f.name] == null || values[f.name] === '')) continue;
      out[f.name] = raw === '' ? null : f.kind === 'integer' || f.kind === 'real' ? Number(raw) : raw;
    }
    return out;
  }

  // ---------------------------------------------------------------- selection dialogs

  /** The query builder used by select by attributes, definition queries and the calculator's scope. */
  private queryBuilder(l: LayerInfo, name = 'where', initial = '', placeholder = `"elevation_m" > 2000 AND "transect" = 'YUS'`) {
    return `<div class="qb">
        <div class="qb-row">
          <select data-qb="field" aria-label="Field">${fieldOptions(l)}</select>
          <select data-qb="op" aria-label="Operator">${['=', '<>', '>', '>=', '<', '<=', 'LIKE', 'IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'].map((o) => `<option>${o}</option>`).join('')}</select>
          <input data-qb="value" list="qb-values" placeholder="value" aria-label="Value">
          <datalist id="qb-values"></datalist>
          <button type="button" data-qb="and">AND</button><button type="button" data-qb="or">OR</button>
        </div>
        <label class="qb-sql">SQL WHERE clause
          <textarea name="${name}" rows="3" placeholder="${esc(placeholder)}" spellcheck="false">${esc(initial)}</textarea></label>
        <div class="qb-help dim">Text in 'single quotes', field names in "double quotes". LIKE 'Mt%' matches the start of a text, IN ('a', 'b') a list, BETWEEN 10 AND 20 a range; AND, OR, NOT and brackets combine conditions.</div>
      </div>`;
  }

  /** Wire the query builder: field values as suggestions, Add AND / OR writes the clause. */
  private wireBuilder(root: HTMLElement, id: string, name = 'where') {
    const $ = <T extends HTMLElement>(q: string) => root.querySelector<T>(q)!;
    const field = $<HTMLSelectElement>('[data-qb="field"]');
    const op = $<HTMLSelectElement>('[data-qb="op"]');
    const value = $<HTMLInputElement>('[data-qb="value"]');
    const list = $<HTMLDataListElement>('#qb-values');
    const sql = $<HTMLTextAreaElement>(`textarea[name="${name}"]`);
    const kind = () => this.layer(id)?.fields.find((f) => f.name === field.value)?.kind ?? 'string';
    const loadValues = async () => {
      list.innerHTML = '';
      try {
        const r = await this.h.backend.json<{ values?: { value: unknown }[]; classes?: { value: unknown }[] }>(`api/layers/${enc(id)}/unique?field=${enc(field.value)}`);
        const vals = (r.values ?? r.classes ?? []).slice(0, 200);
        list.innerHTML = vals.map((v) => `<option value="${esc(v.value)}">`).join('');
      } catch { /* numbers: no list */ }
    };
    field.addEventListener('change', () => void loadValues());
    void loadValues();
    const clause = () => {
      const f = sqlIdent(field.value);
      const o = op.value;
      const num = kind() === 'integer' || kind() === 'real';
      const lit = (v: string) => (num && v.trim() !== '' && Number.isFinite(Number(v)) ? v.trim() : sqlValue(v));
      if (o === 'IS NULL' || o === 'IS NOT NULL') return `${f} ${o}`;
      if (o === 'IN') return `${f} IN (${value.value.split(',').map((v) => lit(v.trim())).join(', ')})`;
      if (o === 'BETWEEN') {
        const [a, b] = value.value.split(/\s+and\s+|,|;/i).map((v) => v.trim());
        return `${f} BETWEEN ${lit(a ?? '')} AND ${lit(b ?? '')}`;
      }
      if (o === 'LIKE') return `${f} LIKE ${sqlValue(value.value.includes('%') ? value.value : `%${value.value}%`)}`;
      return `${f} ${o} ${lit(value.value)}`;
    };
    for (const join of ['and', 'or'] as const) {
      $<HTMLButtonElement>(`[data-qb="${join}"]`).addEventListener('click', () => {
        const c = clause();
        sql.value = sql.value.trim() ? `${sql.value.trim()} ${join.toUpperCase()} ${c}` : c;
        sql.focus();
      });
    }
  }

  /** Select by attributes: a query builder that writes SQL, as in ArcGIS Pro and QGIS. */
  async selectByAttributes(id = this.h.activeId()) {
    const l = this.layer(id);
    if (!l || !id) return this.status('Pick a layer first.');
    const has = this.selected(id).length;
    const how = `<label class="qb-how">Selection <select name="how"><option value="new">New selection</option>${
      has ? `<option value="add">Add to the current selection (${has})</option><option value="remove">Remove from the current selection</option><option value="and">Select from the current selection</option>` : ''
    }</select></label><div class="dlg-msg" data-msg></div>`;
    await dialog(`Select by attributes · ${l.name}`, this.queryBuilder(l) + how, [['ok', 'Select'], ['check', 'Check'], ['', 'Cancel']], {
      wide: true,
      onOpen: (root) => this.wireBuilder(root, id),
      onButton: async (button, v, root) => {
        if (button !== 'ok' && button !== 'check') return true;
        if (!v.where.trim()) { say(root, 'Write a condition, or build one with the boxes above.', 'err'); return false; }
        const r = await this.api<{ count: number; fids: Fid[] }>(`api/layers/${enc(id)}/select`, 'POST', { where: v.where });
        if (button === 'check') { say(root, `The query is valid: ${r.count.toLocaleString()} feature${r.count === 1 ? '' : 's'} match.`, 'ok'); return false; }
        this.setSelection(id, r.fids, v.how as 'new');
        this.status(`${this.selected(id).length.toLocaleString()} selected in ${l.name}`);
        return true;
      },
    });
  }

  /** Select by location: features of the active layer that intersect, lie within, contain or are
   *  within a distance of another layer's features (or its selected ones). */
  async selectByLocation(id = this.h.activeId()) {
    const l = this.layer(id);
    if (!l || !id) return this.status('Pick a layer first.');
    const others = this.h.layers().filter((o) => o.id !== id);
    if (!others.length) return this.status('Select by location needs a second layer.');
    const has = this.selected(id).length;
    await dialog(
      `Select by location · ${l.name}`,
      `<div class="form-grid">
        <label>Select features that<select name="relation">
          <option value="intersects">intersect</option><option value="within_distance">are within a distance of</option>
          <option value="within">are completely within</option><option value="contains">completely contain</option></select></label>
        <label>the features of<select name="layer">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}${this.selected(o.id).length ? ` (${this.selected(o.id).length} selected)` : ''}</option>`).join('')}</select></label>
        <label class="chk"><input type="checkbox" name="only" value="1"> only its selected features</label>
        <label>Distance (m)<input name="distance" type="number" min="0" step="any" value="1000"></label>
        <label>Selection<select name="how"><option value="new">New selection</option>${has ? `<option value="add">Add to the current selection</option><option value="remove">Remove from it</option><option value="and">Select from it</option>` : ''}</select></label>
      </div><div class="dlg-msg" data-msg></div>`,
      [['ok', 'Select'], ['', 'Cancel']],
      {
        onButton: async (button, v, root) => {
          if (button !== 'ok') return true;
          const fids = v.only ? this.selected(v.layer) : undefined;
          if (v.only && !fids?.length) { say(root, 'That layer has no selected features.', 'err'); return false; }
          say(root, 'Selecting…');
          const r = await this.api<{ count: number; fids: Fid[] }>(`api/layers/${enc(id)}/select`, 'POST', {
            location: { layer: v.layer, relation: v.relation, distance_m: Number(v.distance) || 0, fids },
          });
          this.setSelection(id, r.fids, v.how as 'new');
          this.status(`${this.selected(id).length.toLocaleString()} selected in ${l.name}`);
          return true;
        },
      },
    );
  }

  /** Definition query: show (and analyse) only the features that match. */
  async definitionQuery(id = this.h.activeId()) {
    const l = this.layer(id);
    if (!l || !id) return this.status('Pick a layer first.');
    await dialog(
      `Definition query · ${l.name}`,
      `<p class="dim">Only features matching the query are drawn, listed in the table and used by tools, until you clear it. The data is not changed.</p>${this.queryBuilder(l, 'where', l.filter ?? '')}<div class="dlg-msg" data-msg></div>`,
      [['ok', 'Apply'], ['clear', 'Clear query'], ['', 'Cancel']],
      {
        wide: true,
        onOpen: (root) => this.wireBuilder(root, id),
        onButton: async (button, v) => {
          if (button !== 'ok' && button !== 'clear') return true;
          const where = button === 'clear' ? '' : v.where.trim();
          const r = await this.api<{ layer: LayerInfo & { filtered_count?: number } }>(`api/layers/${enc(id)}/filter`, 'PUT', { where });
          await this.afterChange(id, r.layer);
          this.status(where ? `${l.name}: showing ${(r.layer.filtered_count ?? 0).toLocaleString()} of ${l.feature_count.toLocaleString()} features` : `${l.name}: definition query cleared`, 7000);
          return true;
        },
      },
    );
  }

  /** Field calculator (SQL expression) and Calculate geometry, for all or the selected features. */
  async calculateField(id = this.h.activeId(), field?: string) {
    const l = this.layer(id);
    if (!l || !id) return this.status('Pick a layer first.');
    const nsel = this.selected(id).length;
    const geomChoices = l.geometry === 'polygon' ? ['area_ha', 'area_m2', 'area_km2', 'perimeter_m', 'x', 'y'] : l.geometry === 'line' ? ['length_m', 'length_km', 'x', 'y'] : ['x', 'y'];
    await dialog(
      `Calculate field · ${l.name}`,
      `<div class="form-grid">
        <label>Field<input name="field" list="calc-fields" value="${esc(field ?? '')}" placeholder="existing or new field" autofocus></label>
        <datalist id="calc-fields">${l.fields.map((f) => `<option value="${esc(f.name)}">`).join('')}</datalist>
        <label>New field type<select name="kind"><option value="real">decimal number</option><option value="integer">whole number</option><option value="text">text</option><option value="date">date</option></select></label>
        <label>Calculate<select name="mode"><option value="expr">an expression</option>${geomChoices.map((g) => `<option value="geom:${g}">geometry: ${g.replace('_', ' ')}</option>`).join('')}</select></label>
        <label>Features<select name="scope"><option value="all">all ${l.feature_count.toLocaleString()}</option>${nsel ? `<option value="sel" selected>the ${nsel.toLocaleString()} selected</option>` : ''}</select></label>
      </div>
      <label class="qb-sql">Expression (SQL)<textarea name="expression" rows="3" spellcheck="false" placeholder="&quot;species_richness&quot; / (&quot;elevation_m&quot; / 1000.0)"></textarea></label>
      <div class="chips">${[
        ['field × 2', '"x" * 2'], ['round', 'round("x", 2)'], ['join text', '"a" || \' \' || "b"'], ['if … then', "CASE WHEN \"x\" > 10 THEN 'high' ELSE 'low' END"],
        ['upper', 'upper("x")'], ['first 3 letters', 'substr("x", 1, 3)'], ['null → 0', 'coalesce("x", 0)'], ['today', "date('now')"],
      ].map(([t, e]) => `<button type="button" class="chip" data-expr="${esc(e)}">${esc(t)}</button>`).join('')}</div>
      <div class="qb-help dim">Geometry measures are geodesic (on the sphere): hectares, metres, km; x and y in WGS 84 degrees. A new field is created with the type above.</div>
      <div class="dlg-msg" data-msg></div>`,
      [['ok', 'Calculate'], ['', 'Cancel']],
      {
        wide: true,
        onOpen: (root) => {
          const ta = root.querySelector<HTMLTextAreaElement>('textarea[name="expression"]')!;
          root.querySelectorAll<HTMLButtonElement>('[data-expr]').forEach((b) =>
            b.addEventListener('click', () => {
              const f = root.querySelector<HTMLInputElement>('input[name="field"]')!.value || l.fields[0]?.name || 'x';
              ta.value = (b.dataset.expr ?? '').replace(/"x"/g, sqlIdent(f));
              ta.focus();
            }),
          );
          const mode = root.querySelector<HTMLSelectElement>('select[name="mode"]')!;
          const sync = () => { ta.disabled = mode.value !== 'expr'; };
          mode.addEventListener('change', sync);
          sync();
        },
        onButton: async (button, v, root) => {
          if (button !== 'ok') return true;
          const name = v.field.trim();
          if (!name) { say(root, 'Name the field to calculate.', 'err'); return false; }
          if (!(await this.confirmFirstEdit(id))) return false;
          const fids = v.scope === 'sel' ? this.selected(id) : undefined;
          const exists = l.fields.some((f) => f.name === name);
          const body = v.mode.startsWith('geom:')
            ? { field: name, geometry: v.mode.slice(5), fids }
            : { field: name, expression: v.expression, kind: exists ? undefined : v.kind, fids };
          say(root, 'Calculating…');
          const r = await this.api<{ updated: number; layer: LayerInfo }>(`api/layers/${enc(id)}/calculate`, 'POST', body);
          await this.afterChange(id, r.layer);
          this.undoStack = this.undoStack.filter((op) => op.layer !== id); // a calculation is not undoable feature by feature
          document.dispatchEvent(new CustomEvent('geospax:edit-history'));
          this.status(`${name}: ${r.updated.toLocaleString()} feature${r.updated === 1 ? '' : 's'} calculated`, 7000);
          return true;
        },
      },
    );
  }

  async addField(id = this.h.activeId()) {
    const l = this.layer(id);
    if (!l || !id) return this.status('Pick a layer first.');
    await dialog(
      `Add field · ${l.name}`,
      `<div class="form-grid"><label>Name<input name="name" autofocus maxlength="63"></label>
       <label>Type<select name="kind"><option value="text">text</option><option value="integer">whole number</option><option value="real">decimal number</option><option value="date">date</option><option value="datetime">date and time</option></select></label></div>
       <div class="dlg-msg" data-msg></div>`,
      [['ok', 'Add field'], ['', 'Cancel']],
      {
        onButton: async (button, v, root) => {
          if (button !== 'ok') return true;
          if (!v.name.trim()) { say(root, 'Give the field a name.', 'err'); return false; }
          if (!(await this.confirmFirstEdit(id))) return false;
          const r = await this.api<{ layer: LayerInfo }>(`api/layers/${enc(id)}/fields`, 'POST', { name: v.name.trim(), kind: v.kind });
          await this.afterChange(id, r.layer);
          this.status(`Added field ${v.name.trim()}`);
          return true;
        },
      },
    );
  }

  async deleteField(id: string, name: string) {
    const r = await dialog('Delete field', `<p>Delete the field <b>${esc(name)}</b> and all its values from <b>${esc(this.layer(id)?.name)}</b>? This cannot be undone (Discard edits restores the original file).</p>`, [['ok', 'Delete field'], ['', 'Cancel']]);
    if (r.button !== 'ok' || !(await this.confirmFirstEdit(id))) return;
    try {
      const res = await this.api<{ layer: LayerInfo }>(`api/layers/${enc(id)}/fields/${enc(name)}`, 'DELETE');
      await this.afterChange(id, res.layer);
      this.status(`Deleted field ${name}`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Save the selection (or the whole layer) as a new layer. */
  async exportSelection(id = this.h.activeId()) {
    const l = this.layer(id);
    if (!l || !id) return this.status('Pick a layer first.');
    const fids = this.selected(id);
    await dialog(
      `Export features · ${l.name}`,
      `<div class="form-grid"><label>New layer name<input name="name" autofocus value="${esc(`${l.name} ${fids.length ? 'selection' : 'copy'}`)}"></label>
       <label>Features<select name="scope">${fids.length ? `<option value="sel">the ${fids.length.toLocaleString()} selected</option>` : ''}<option value="all">all${l.filter ? ' (matching the definition query)' : ''}</option></select></label></div>
       <p class="dim">The new layer is a GeoPackage in the same coordinate system, added to the map. Use Data › Export to save any layer to a file.</p><div class="dlg-msg" data-msg></div>`,
      [['ok', 'Export'], ['', 'Cancel']],
      {
        onButton: async (button, v, root) => {
          if (button !== 'ok') return true;
          if (!v.name.trim()) { say(root, 'Name the new layer.', 'err'); return false; }
          const r = await this.api<{ layer: LayerInfo }>(`api/layers/${enc(id)}/export`, 'POST', { name: v.name.trim(), fids: v.scope === 'sel' ? fids : undefined });
          await this.afterChange(r.layer.id, r.layer);
          this.h.setActive(r.layer.id);
          this.status(`New layer ${r.layer.name}: ${r.layer.feature_count.toLocaleString()} features`);
          return true;
        },
      },
    );
  }

  /** New, empty layer to digitise into. */
  async newLayer() {
    await dialog(
      'New layer',
      `<div class="form-grid"><label>Name<input name="name" autofocus placeholder="Survey plots"></label>
       <label>Geometry<select name="geometry"><option value="point">points</option><option value="line">lines</option><option value="polygon">polygons</option></select></label>
       <label>Fields<input name="fields" placeholder="name:text, count:integer, depth_m:real"></label></div>
       <p class="dim">A GeoPackage in WGS 84 (EPSG:4326), kept with your edits and listed in Contents. Fields can be added later too.</p><div class="dlg-msg" data-msg></div>`,
      [['ok', 'Create'], ['', 'Cancel']],
      {
        onButton: async (button, v, root) => {
          if (button !== 'ok') return true;
          if (!v.name.trim()) { say(root, 'Name the layer.', 'err'); return false; }
          const fields = v.fields
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const [name, kind] = s.split(':').map((x) => x.trim());
              return { name, kind: kind || 'text' };
            });
          const r = await this.api<{ layer: LayerInfo }>('api/layers/new', 'POST', { name: v.name.trim(), geometry: v.geometry, fields });
          await this.afterChange(r.layer.id, r.layer);
          this.h.setActive(r.layer.id);
          this.status(`${r.layer.name} is ready: choose a ${v.geometry} tool to draw into it.`, 8000);
          return true;
        },
      },
    );
  }

  /** Go back to the original file (or remove a layer made here). */
  async discardEdits(id = this.h.activeId()) {
    const l = this.layer(id);
    if (!l || !id) return this.status('Pick a layer first.');
    if (!l.edited) return this.status(`${l.name} has no edits.`);
    const r = await dialog('Discard edits', `<p>Throw away every edit to <b>${esc(l.name)}</b> and read its original file again? A layer made in GeoSpaX (New layer, Export) is removed instead. This cannot be undone.</p>`, [['ok', 'Discard edits'], ['', 'Cancel']]);
    if (r.button !== 'ok') return;
    try {
      const res = await this.api<{ layer?: LayerInfo; removed?: string }>(`api/layers/${enc(id)}/revert`, 'POST');
      this.undoStack = this.undoStack.filter((op) => op.layer !== id);
      this.redoStack = this.redoStack.filter((op) => op.layer !== id);
      this.clearSelection(id);
      await this.afterChange(id, res.layer);
      document.dispatchEvent(new CustomEvent('geospax:edit-history'));
      this.status(res.removed ? `${l.name} removed` : `${l.name} reads its original file again`);
    } catch (e) {
      this.fail(e);
    }
  }

  async zoomToSelection(id = this.h.activeId()) {
    if (!id) return;
    const fids = this.selected(id);
    if (!fids.length) return this.status('Nothing selected.');
    try {
      const t = await this.api<{ rows: { bbox: [number, number, number, number] | null }[] }>(`api/layers/${enc(id)}/table`, 'POST', { fids: fids.slice(0, 5000), limit: 5000 });
      let b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const r of t.rows) if (r.bbox) b = [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])];
      if (!Number.isFinite(b[0])) return;
      const pad = Math.max(0.0005, (b[2] - b[0]) * 0.15);
      this.h.map.fitBounds([[b[0] - pad, b[1] - pad], [b[2] + pad, b[3] + pad]], { padding: 60, maxZoom: 17, duration: 400 });
    } catch (e) {
      this.fail(e);
    }
  }
}
