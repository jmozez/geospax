// GeoSpaX Field: a full-screen map with the recording bar at the bottom (one-handed use). Points, lines,
// areas, tracks and photos are saved on the phone as they are made and sent to GeoSpaX when there is a
// connection to it.
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { allRecords, deleteRecord, newId, putRecord, type Kind, type Photo, type Rec, type Vertex } from './db';
import { FixFilter, watchPosition, type Fix } from './geo';
import { BASEMAPS, installTileCache, type Basemap } from './tiles';
import { hello, parseLink, saveLink, savedLink, scanLink, send } from './sync';
import { inApp } from './geo';
import { connectNative, type BtDevice } from './btnative';
import { installBasics, settings } from './basics';
import { fmtHeight, type Height } from './elevation';
import { heights, onFix as heightsOnFix, setDem, startHeights } from './heights';
import { areaM2, fmtArea, fmtLen, fmtTime, lengthM, navTo, parseCoords, takeFix, trackStats, turn, xy } from './walk';
import { BUILT_IN, check, coerce, parseForm, qrKind, summary, TYPE_LABEL, TYPES, type Field, type FieldType, type Form, type Values } from './forms';
import { plot, plotArea, SIZES, transect, type Shape } from './plots';
import { scanCode } from './qr';
import { connectReceiver, fmtAcc, QUALITY_LABEL, type GnssFix, type Receiver } from './gnss';
import { fmtAhead, fmtCutFill, fmtNE, parseDesign, stake, type Design } from './stakeout';
import { checkRecords, type Issue } from './qc';
import { askCompass, fmtBearing, fmtDur, MAX_VOICE_MS, norm, startCompass, startVoice, voiceName, type Recording, type Voice } from './capture';

const compass = startCompass();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const LABEL: Record<Kind, string> = { point: 'Point', line: 'Line', area: 'Area', track: 'Track' };

let fix: Fix | null = null;
const fixes = new FixFilter();
let records: Rec[] = [];
let draft: { kind: 'line' | 'area'; coords: Vertex[] } | null = null;
let track: Rec | null = null;
let trackPaused = false;
/** walk-to-measure: the draft takes a vertex from each good fix as you walk */
let walking = false;
/** navigate to a point */
let target: { name: string; at: [number, number] } | null = null;
let basemap: Basemap = settings().basemap;
let follow = true;

// ------------------------------------------------------------------ map
// MapLibre 6 runs its tile and GeoJSON work in a module worker; point it at the bundled copy
maplibregl.setWorkerUrl(workerUrl);
installTileCache();
const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [] },
  center: [147.0, -6.7],
  zoom: 12,
  attributionControl: { compact: true },
  maxPitch: 0,
  dragRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'top-left');

const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features }) as GeoJSON.FeatureCollection;
function recFeature(r: { kind: Kind; coords: Vertex[] }, props: Record<string, unknown> = {}): GeoJSON.Feature | null {
  const xy = r.coords.map((v) => [v[0], v[1]]);
  if (!xy.length) return null;
  let geometry: GeoJSON.Geometry;
  if (r.kind === 'point' || xy.length === 1) geometry = { type: 'Point', coordinates: xy[0] };
  else if (r.kind === 'area' && xy.length > 2) geometry = { type: 'Polygon', coordinates: [[...xy, xy[0]]] };
  else geometry = { type: 'LineString', coordinates: xy };
  return { type: 'Feature', geometry, properties: { kind: r.kind, ...props } };
}

function setBasemap(b: Basemap) {
  basemap = b;
  try { localStorage.setItem('geospax-field.basemap', b); } catch { /* ignore */ }
  const src = map.getSource('base') as maplibregl.RasterTileSource | undefined;
  const def = BASEMAPS[b];
  if (src) src.setTiles([def.tiles]);
  $('#basemap').textContent = b === 'imagery' ? 'Map' : 'Imagery';
  map.getContainer().querySelector('.maplibregl-ctrl-attrib-inner')?.replaceChildren(def.attribution);
}

map.on('load', () => {
  const def = BASEMAPS[basemap];
  map.addSource('base', { type: 'raster', tiles: [def.tiles], tileSize: 256, maxzoom: def.maxzoom, attribution: def.attribution });
  map.addLayer({ id: 'base', type: 'raster', source: 'base' });
  map.addSource('recs', { type: 'geojson', data: fc([]) });
  map.addSource('draft', { type: 'geojson', data: fc([]) });
  map.addSource('me', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'recs-fill', type: 'fill', source: 'recs', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ff7a45', 'fill-opacity': 0.25 } });
  map.addLayer({ id: 'recs-line', type: 'line', source: 'recs', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': ['match', ['get', 'kind'], 'track', '#4cc2ff', '#ff7a45'], 'line-width': 3 } });
  map.addLayer({ id: 'recs-pt', type: 'circle', source: 'recs', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#ff7a45', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffd43b', 'fill-opacity': 0.25 } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#ffd43b', 'line-width': 3, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'draft-pt', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffd43b', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
  map.addSource('plan', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#ffd166', 'line-width': 3, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'plan-pt', type: 'circle', source: 'plan', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffd166', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
  map.addSource('nav', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'nav-line', type: 'line', source: 'nav', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#4cc2ff', 'line-width': 2, 'line-dasharray': [1, 1] } });
  map.addLayer({ id: 'nav-pt', type: 'circle', source: 'nav', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#4cc2ff', 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'me-acc', type: 'circle', source: 'me', paint: { 'circle-radius': ['get', 'px'], 'circle-color': '#4c8dff', 'circle-opacity': 0.15 } });
  map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 8, 'circle-color': '#4c8dff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  setBasemap(basemap);
  void refresh();
});
map.on('dragstart', () => { follow = false; });
map.on('click', (e) => {
  if (!draft) return;
  draft.coords.push([e.lngLat.lng, e.lngLat.lat, null, Date.now(), null]);
  drawDraft();
});

/** accuracy in metres → circle radius in pixels at the current zoom */
const accPx = (f: Fix) => f.acc / (40075016.686 * Math.cos((f.lat * Math.PI) / 180) / 2 ** (map.getZoom() + 9));

function drawMe() {
  const s = map.getSource('me') as maplibregl.GeoJSONSource | undefined;
  if (s && fix) s.setData(fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: [fix.lon, fix.lat] }, properties: { px: Math.min(400, accPx(fix)) } }]));
}
map.on('zoom', drawMe);

function drawDraft() {
  const parts: (GeoJSON.Feature | null)[] = [];
  if (draft) {
    parts.push(recFeature(draft));
    for (const v of draft.coords) parts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v[0], v[1]] }, properties: {} });
    $('#drawMsg').textContent = draftText(draft.kind, draft.coords, walking);
  }
  if (track) parts.push(recFeature(track));
  (map.getSource('draft') as maplibregl.GeoJSONSource | undefined)?.setData(fc(parts.filter(Boolean)));
}

/** what the draw panel says: the points so far and what they measure */
function draftText(kind: 'line' | 'area', coords: Vertex[], walk: boolean) {
  const n = `${coords.length} point${coords.length === 1 ? '' : 's'}`;
  const pts = coords.map(xy);
  const m = kind === 'area' ? (coords.length > 2 ? ` · ${fmtArea(areaM2(pts))} · perimeter ${fmtLen(lengthM(pts, true))}` : '') : coords.length > 1 ? ` · ${fmtLen(lengthM(pts))}` : '';
  return walk ? `Walking${kind === 'area' ? ' the boundary' : ''} · ${n}${m}` : `${n}${m}: tap the map, add your position or walk it`;
}
/** what a saved record measures, for the list */
function measure(r: Rec) {
  const pts = r.coords.map(xy);
  if (r.kind === 'area') return `${fmtArea(areaM2(pts))} · perimeter ${fmtLen(lengthM(pts, true))}`;
  if (r.kind === 'line') return fmtLen(lengthM(pts));
  if (r.kind === 'track') { const t = trackStats(r.coords); return `${fmtLen(t.distance)} · ${fmtTime(t.duration)}${t.gain >= 3 ? ` · ↑${Math.round(t.gain)} m` : ''}`; }
  return '';
}

async function refresh() {
  records = await allRecords();
  (map.getSource('recs') as maplibregl.GeoJSONSource | undefined)?.setData(fc(records.map((r) => recFeature(r)).filter(Boolean)));
  const unsent = records.filter((r) => !r.sent).length;
  $('#unsent').textContent = unsent ? String(unsent) : '';
}

// ------------------------------------------------------------------ GPS
function showGps(text: string, cls: string) {
  const g = $('#gps');
  g.textContent = text;
  g.className = `chip ${cls}`;
}
showGps('Finding GPS…', 'wait');
// the latest raw fix, for ⋯ › GPS status
const gps: { fix: Fix | null; count: number; error: string | null; since: number } = { fix: null, count: 0, error: null, since: Date.now() };
// an external Bluetooth receiver: while it sends fixes the phone's own are ignored
let receiver: Receiver | null = null;
let receiverAt = 0;
const receiverLive = () => !!receiver && Date.now() - receiverAt < 5000;
function onFixIn(raw: Fix) {
  gps.fix = raw;
  gps.count++;
  gps.error = null;
  const f = fixes.add(raw, Date.now());
  if (!f) {
    if (!fix) showGps(`Waiting for GPS (${fmtAcc(raw.acc)})`, 'wait');
    return;
  }
  useFix(f);
}
async function connectGnss(device?: BtDevice) {
  receiver?.disconnect();
  receiver = null;
  const onFix = (g: GnssFix) => { receiverAt = Date.now(); onFixIn({ ...g, t: receiverAt }); };
  const onGone = (error?: string | null) => { if (!receiver) return; receiver = null; toast(`${error ? `${error}: ` : 'The GNSS receiver disconnected: '}back to the phone GPS`); };
  // the Android app reads receivers through its own plugin; browsers through Web Bluetooth
  receiver = device ? await connectNative(device, onFix, onGone) : await connectReceiver(onFix, () => onGone());
  toast(`Connected to ${receiver.name}`);
}
void watchPosition(
  (raw) => {
    if (receiverLive()) return;
    gps.fix = raw;
    gps.count++;
    gps.error = null;
    const f = fixes.add(raw, Date.now());
    if (!f) {
      // a cached, coarse or jumping fix: say so while there is no good one yet, otherwise keep the last
      if (!fix) showGps(`Waiting for GPS (±${Math.round(raw.acc)} m)`, 'wait');
      return;
    }
    useFix(f);
  },
  (msg) => { gps.error = msg; showGps(msg.length > 40 ? 'No GPS' : msg, 'poor'); },
);
// a jump the filter held back becomes the position once nothing has contradicted it for a while (phones
// that only report a fix when the position changes send no second one after a move)
setInterval(() => {
  const f = fixes.tick(Date.now());
  if (f) useFix(f);
}, 1000);
function useFix(f: Fix) {
  const first = !fix;
  fix = f;
  heightsOnFix(f);
  const q = (f as GnssFix).quality;
  showGps(`${q ? QUALITY_LABEL[q] : 'GPS'} ${fmtAcc(f.acc)}`, f.acc <= 10 ? 'good' : f.acc <= 30 ? 'fair' : 'poor');
  drawMe();
  if (first || follow) map.easeTo({ center: [f.lon, f.lat], zoom: first ? Math.max(map.getZoom(), 16) : map.getZoom(), duration: first ? 0 : 400 });
  if (track && !trackPaused) {
    // a new track point every 3 m, and only fixes good enough to draw a line with
    if (takeFix(track.coords[track.coords.length - 1], f.lon, f.lat, f.acc, 3, 50)) {
      track.coords.push([f.lon, f.lat, heights(f).best?.value ?? null, f.t, f.acc]);
      $('#trackInfo').textContent = trackText(track);
      drawDraft();
    }
  }
  // walk-to-measure: a vertex every 3 m from fixes good to ±20 m
  if (draft && walking && takeFix(draft.coords[draft.coords.length - 1], f.lon, f.lat, f.acc, 3, 20)) {
    draft.coords.push([f.lon, f.lat, heights(f).best?.value ?? null, f.t, f.acc]);
    drawDraft();
  }
  showNav();
}
$('#locate').addEventListener('click', () => {
  follow = true;
  if (fix) map.easeTo({ center: [fix.lon, fix.lat], zoom: Math.max(map.getZoom(), 16) });
});

// a point is placed at the average of the last seconds' good fixes, not at the latest single one
// its height is the best there is now (GPS and geoid, barometer or terrain model), with its source kept
let hereHeight: Height | null = null;
const here = (): Vertex | null => {
  const b = fixes.best();
  hereHeight = b ? heights(b).best : null;
  return b ? [b.lon, b.lat, hereHeight?.value ?? null, Date.now(), b.acc] : null;
};
// for the emulator test in CI (scripts/test-field-emulator.mjs): what the app thinks its position is
const cspBlocked: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => {
  cspBlocked.push(`${e.effectiveDirective} ${e.blockedURI}`);
  console.warn('blocked by the content security policy:', e.effectiveDirective, e.blockedURI);
});
(window as unknown as { __field: object }).__field = { cspBlocked, fix: () => fix, best: () => fixes.best(), here, heights: () => heights(fixes.best() ?? fix), parseLink, hello, send };
function trackText(t: Rec) {
  const s = trackStats(t.coords);
  const time = fmtTime((t.coords.length ? Date.now() - t.coords[0][3] : 0));
  return `${trackPaused ? 'Paused (tap to go on)' : 'Recording'} · ${fmtLen(s.distance)} · ${time}${s.speed ? ` · ${(s.speed * 3.6).toFixed(1)} km/h` : ''}`;
}
// tap the recording pill to pause the track (a break, a drive) and again to go on
$('#trackInfo').addEventListener('click', () => {
  if (!track) return;
  trackPaused = !trackPaused;
  $('#trackInfo').classList.toggle('paused', trackPaused);
  $('#trackInfo').textContent = trackText(track);
  toast(trackPaused ? 'Track paused' : 'Track going on');
});
setInterval(() => { if (track) $('#trackInfo').textContent = trackText(track); }, 1000);

// ------------------------------------------------------------------ sheets
const sheet = $('#sheet') as HTMLDialogElement;
function openSheet(html: string) {
  $('#sheetBody').innerHTML = html;
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

interface Noted { note: string; photos: Photo[]; voice: Voice[]; form?: string; attrs?: Values }

// ------------------------------------------------------------------ forms
const FORMS_KEY = 'geospax-field.forms';
const LAST_FORM_KEY = 'geospax-field.lastForm';
function userForms(): Form[] {
  try {
    const a = JSON.parse(localStorage.getItem(FORMS_KEY) || '[]');
    return Array.isArray(a) ? a.flatMap((f) => { try { return [parseForm(f)]; } catch { return []; } }) : [];
  } catch { return []; }
}
function saveUserForms(f: Form[]) { try { localStorage.setItem(FORMS_KEY, JSON.stringify(f)); } catch { /* private mode */ } }
const allForms = () => [...BUILT_IN, ...userForms()];
const formNamed = (name?: string) => (name ? allForms().find((f) => f.name === name) : undefined);
/** Adds a form (replacing one with the same name); built-in names are kept for the built-in forms. */
function addForm(f: Form) {
  if (BUILT_IN.some((b) => b.name === f.name)) throw new Error(`"${f.name}" is a built-in form: give yours another name.`);
  saveUserForms([...userForms().filter((x) => x.name !== f.name), f]);
}
function fieldHtml(f: Field, v: Values[string] | undefined): string {
  const val = v == null ? '' : String(v);
  const lab = `${esc(f.label)}${f.unit ? ` (${esc(f.unit)})` : ''}${f.required ? ' <i>*</i>' : ''}`;
  const k = esc(f.key);
  if (f.type === 'choice') return `<label>${lab}<select data-key="${k}"><option value=""></option>${f.options!.map((o) => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  if (f.type === 'yesno') return `<label>${lab}<select data-key="${k}"><option value=""></option><option value="yes"${v === true ? ' selected' : ''}>Yes</option><option value="no"${v === false ? ' selected' : ''}>No</option></select></label>`;
  if (f.type === 'code') return `<label>${lab}<span class="codeRow"><input data-key="${k}" value="${esc(val)}" autocomplete="off" /><button type="button" class="scanBtn" data-for="${k}" aria-label="Scan ${esc(f.label)}">▦ Scan</button></span></label>`;
  const attrs = f.type === 'number' ? `type="number" inputmode="decimal" step="any"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}` : f.type === 'date' ? 'type="date"' : '';
  return `<label>${lab}<input data-key="${k}" ${attrs} value="${esc(val)}" /></label>`;
}
/** Shows a form's fields in a box, with Scan buttons for codes; returns a reader for what was typed. */
function showForm(box: HTMLElement, form: Form | undefined, values: Values = {}): () => Values | null {
  if (!form) { box.innerHTML = ''; return () => null; }
  box.innerHTML = form.fields.map((f) => fieldHtml(f, values[f.key])).join('');
  for (const b of box.querySelectorAll<HTMLButtonElement>('.scanBtn')) {
    b.addEventListener('click', async () => {
      const code = await scanCode(`Scan: ${form.fields.find((f) => f.key === b.dataset.for)?.label ?? 'code'}`);
      if (code) (box.querySelector(`[data-key="${b.dataset.for}"]`) as HTMLInputElement).value = code;
    });
  }
  return () => {
    const raw: Record<string, string> = {};
    for (const el of box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) raw[el.dataset.key!] = el.value;
    return coerce(form, raw);
  };
}
/** The note sheet: a note, photos (with the way each faced) and voice notes. */
function noteSheet(title: string, withPhoto = false, first: Photo[] = [], noteInit = ''): Promise<Noted | null> {
  return new Promise((resolve) => {
    const photos: Photo[] = [...first];
    const voice: Voice[] = [];
    let rec: Recording | null = null;
    let tick = 0;
    openSheet(`<h2>${esc(title)}</h2>
      <div id="thumbs" class="thumbs"></div>
      <textarea id="note" rows="3" placeholder="What is here? (optional)">${esc(noteInit)}</textarea>
      <label class="formpick">Form<select id="formSel"><option value="">No form</option>${allForms().map((f) => `<option${f.name === localStorage.getItem(LAST_FORM_KEY) ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <div id="formBox" class="form"></div>
      <p id="formMsg" class="msg" aria-live="polite"></p>
      <div class="row">${withPhoto ? '<button type="button" id="addPhoto">📷 Add a photo</button>' : ''}<button type="button" id="voiceBtn">🎙 Voice note</button></div>
      <ul id="voices" class="voices"></ul>
      <div class="row"><button type="button" id="cancel">Cancel</button><button type="button" class="primary" id="save">Save</button></div>`);
    const showPhoto = (p: Photo) => {
      const fig = document.createElement('figure');
      fig.className = 'thumb';
      fig.innerHTML = `<img alt="" src="${URL.createObjectURL(p.blob)}" /><label>Facing <input type="number" inputmode="numeric" min="0" max="359" step="1" value="${p.bearing != null ? Math.round(p.bearing) : ''}" placeholder="°" aria-label="Bearing in degrees" />°</label><figcaption>${esc(fmtBearing(p.bearing))}</figcaption>`;
      const inp = fig.querySelector('input')!;
      inp.addEventListener('input', () => {
        const v = inp.value.trim() === '' ? null : Number(inp.value);
        p.bearing = v != null && Number.isFinite(v) ? norm(v) : null;
        fig.querySelector('figcaption')!.textContent = fmtBearing(p.bearing);
      });
      $('#thumbs').append(fig);
    };
    photos.forEach(showPhoto);
    let readForm = showForm($('#formBox'), formNamed(($('#formSel') as HTMLSelectElement).value));
    $('#formBox').addEventListener('input', () => { $('#formMsg').textContent = ''; });
    $('#formSel').addEventListener('change', () => {
      const name = ($('#formSel') as HTMLSelectElement).value;
      try { localStorage.setItem(LAST_FORM_KEY, name); } catch { /* private mode */ }
      readForm = showForm($('#formBox'), formNamed(name));
    });
    const showVoice = (v: Voice) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>🎙 ${fmtDur(v.ms)}</span><audio controls preload="none" src="${URL.createObjectURL(v.blob)}"></audio><button type="button" class="del" aria-label="Remove this voice note">✕</button>`;
      li.querySelector('.del')!.addEventListener('click', () => { voice.splice(voice.indexOf(v), 1); li.remove(); });
      $('#voices').append(li);
    };
    $('#addPhoto')?.addEventListener('click', async () => {
      const p = await takePhoto();
      if (p) { photos.push(p); showPhoto(p); }
    });
    const btn = $('#voiceBtn') as HTMLButtonElement;
    const stopVoice = async () => {
      if (!rec) return;
      const r0 = rec;
      rec = null;
      clearInterval(tick);
      btn.classList.remove('rec');
      btn.textContent = '🎙 Voice note';
      const out = await r0.stop();
      if (out.blob.size === 0) return toast('Nothing was recorded');
      const b = fixes.best() ?? fix;
      const v: Voice = { id: newId(), name: voiceName(r0.started, out.mime), blob: out.blob, ts: r0.started, ms: out.ms, lon: b?.lon ?? null, lat: b?.lat ?? null };
      voice.push(v);
      showVoice(v);
    };
    btn.addEventListener('click', async () => {
      if (rec) return void stopVoice();
      try {
        rec = await startVoice();
      } catch (e) {
        return toast((e as Error).message);
      }
      btn.classList.add('rec');
      const show = () => {
        const ms = Date.now() - (rec?.started ?? Date.now());
        btn.textContent = `■ Stop ${fmtDur(ms)}`;
        if (ms >= MAX_VOICE_MS) void stopVoice();
      };
      show();
      tick = window.setInterval(show, 500);
    });
    let settled = false;
    const done = async (v: Noted | null) => {
      if (settled) return;
      settled = true;
      if (rec) { if (v) await stopVoice(); else { rec.cancel(); rec = null; clearInterval(tick); } }
      if (sheet.open) sheet.close();
      resolve(v ? { ...v, voice } : null);
    };
    $('#cancel').addEventListener('click', () => void done(null));
    $('#save').addEventListener('click', () => {
      const form = formNamed(($('#formSel') as HTMLSelectElement).value);
      const attrs = readForm();
      const bad = form && attrs ? check(form, attrs) : [];
      if (bad.length) return void ($('#formMsg').textContent = bad.join(' '));
      void done({ note: ($('#note') as HTMLTextAreaElement).value.trim(), photos, voice, ...(form && attrs ? { form: form.name, attrs } : {}) });
    });
    sheet.addEventListener('close', () => void done(null), { once: true });
  });
}

/** The camera (or the gallery), with the position at the moment it was taken and the way the camera faced. */
function takePhoto(): Promise<Photo | null> {
  void askCompass();
  // the compass as the camera opens (the phone is being pointed); the camera app pauses this one
  const aim = compass.bearing(Date.now());
  return new Promise((resolve) => {
    const input = $('#photoInput') as HTMLInputElement;
    input.value = '';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const ts = Date.now();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const bearing = compass.bearing(ts) ?? aim;
      resolve({ id: newId(), name: `photo-${new Date(ts).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, blob: file, lon: fix?.lon ?? null, lat: fix?.lat ?? null, acc: fix?.acc ?? null, ts, bearing });
    };
    input.click();
  });
}

async function save(kind: Kind, coords: Vertex[], n: Noted, height: Height | null = null, quiet = false, created = Date.now()) {
  const extra = { ...(n.form ? { form: n.form } : {}), ...(n.attrs && Object.keys(n.attrs).length ? { attrs: n.attrs } : {}) };
  await putRecord({ id: newId(), kind, coords, note: n.note, created, sent: false, photos: n.photos, ...(height ? { height } : {}), ...(n.voice.length ? { voice: n.voice } : {}), ...extra });
  if (quiet) return;
  await refresh();
  toast(`${LABEL[kind]} saved`);
}

let toastTimer = 0;
function toast(text: string) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 2500);
}

// ------------------------------------------------------------------ the recording bar
$('#btnPoint').addEventListener('click', async () => {
  const v = here() ?? (() => { const c = map.getCenter(); return [c.lng, c.lat, null, Date.now(), null] as Vertex; })();
  const warn = settings().warnAcc;
  if (warn && v[4] != null && v[4] > warn && !confirm(`GPS is only good to ±${Math.round(v[4])} m. Save the point anyway?`)) return;
  const r = await noteSheet(v[4] != null ? `Point at your position (±${Math.round(v[4])} m)` : 'Point at the map centre (no GPS yet)', true);
  if (r) await save('point', [v], r, v[2] != null ? hereHeight : null);
});

function startDraw(kind: 'line' | 'area') {
  draft = { kind, coords: [] };
  setWalking(false);
  $('#draw').hidden = false;
  $('#bar').hidden = true;
  drawDraft();
}
$('#btnLine').addEventListener('click', () => startDraw('line'));
$('#btnArea').addEventListener('click', () => startDraw('area'));
$('#drawHere').addEventListener('click', () => {
  const v = here();
  if (!v || !draft) return toast('No GPS position yet');
  draft.coords.push(v);
  drawDraft();
});
function setWalking(on: boolean) {
  walking = on;
  const b = $('#drawWalk');
  b.classList.toggle('rec', on);
  b.textContent = on ? '■ Stop walking' : '🚶 Walk it';
  if (on) {
    follow = true;
    const v = here();
    if (v && draft && takeFix(draft.coords[draft.coords.length - 1], v[0], v[1], v[4] ?? Infinity, 3, 20)) draft.coords.push(v);
  }
  drawDraft();
}
$('#drawWalk').addEventListener('click', () => {
  if (!walking && !fix) return toast('No GPS position yet');
  setWalking(!walking);
});
$('#drawUndo').addEventListener('click', () => { draft?.coords.pop(); drawDraft(); });
const endDraw = () => { setWalking(false); draft = null; $('#draw').hidden = true; $('#bar').hidden = false; drawDraft(); };
$('#drawCancel').addEventListener('click', endDraw);
$('#drawDone').addEventListener('click', async () => {
  if (!draft) return;
  const need = draft.kind === 'area' ? 3 : 2;
  if (draft.coords.length < need) return toast(`An ${draft.kind} needs at least ${need} points`);
  const d = draft;
  setWalking(false);
  const r = await noteSheet(`${LABEL[d.kind]} · ${draftText(d.kind, d.coords, false).replace(/: tap.*$/, '')}`);
  if (r) {
    await save(d.kind, d.coords, r);
    endDraw();
  }
});

$('#btnTrack').addEventListener('click', async () => {
  if (!track) {
    track = { id: newId(), kind: 'track', coords: [], note: '', created: Date.now(), sent: false, photos: [] };
    trackPaused = false;
    $('#trackInfo').classList.remove('paused');
    const v = here();
    if (v) track.coords.push(v);
    $('#btnTrack').classList.add('rec');
    $('#btnTrack').querySelector('span')!.textContent = 'Stop';
    $('#trackInfo').hidden = false;
    $('#trackInfo').textContent = trackText(track);
    follow = true;
    return;
  }
  const t = track;
  track = null;
  $('#btnTrack').classList.remove('rec');
  $('#btnTrack').querySelector('span')!.textContent = 'Track';
  $('#trackInfo').hidden = true;
  drawDraft();
  if (t.coords.length < 2) return toast('Track too short: nothing saved');
  const r = await noteSheet(`Track · ${measure(t)}`);
  await save('track', t.coords, r ?? { note: '', photos: [], voice: [] });
});

$('#btnPhoto').addEventListener('click', async () => {
  const p = await takePhoto();
  if (!p) return;
  const h = p.lon != null && p.lat != null ? heights(fix).best : null;
  const v: Vertex = p.lon != null && p.lat != null ? [p.lon, p.lat, h?.value ?? null, p.ts, p.acc] : (() => { const c = map.getCenter(); return [c.lng, c.lat, null, p.ts, null] as Vertex; })();
  const r = await noteSheet(`Photo point · facing ${fmtBearing(p.bearing)}`, true, [p]);
  if (r) await save('point', [v], { ...r, note: r.note || 'Photo' }, h);
});

$('#basemap').addEventListener('click', () => setBasemap(basemap === 'imagery' ? 'map' : 'imagery'));

// ------------------------------------------------------------------ records
$('#btnList').addEventListener('click', () => void listSheet());
async function listSheet() {
  await refresh();
  const rows = records
    .map((r) => `<li data-id="${r.id}"><b>${LABEL[r.kind]}</b> ${esc(r.note || '')}${r.form && r.attrs ? ` <span class="attrs">${esc(summary(formNamed(r.form), r.attrs))}</span>` : ''}<small>${new Date(r.created).toLocaleString()}${measure(r) ? ` · ${esc(measure(r))}` : ''}${r.height ? ` · ${esc(fmtHeight(r.height))}` : ''}${r.photos.length ? ` · ${r.photos.length} photo${r.photos.length > 1 ? 's' : ''}${r.photos[0].bearing != null ? ` facing ${esc(fmtBearing(r.photos[0].bearing))}` : ''}` : ''}${r.voice?.length ? ` · 🎙 ${r.voice.length}` : ''} · ${r.sent ? 'sent' : '<em>not sent</em>'}</small><button type="button" class="go" aria-label="Navigate here">➜</button><button type="button" class="del" aria-label="Delete">✕</button></li>`)
    .join('');
  openSheet(`<h2>Records <small>${records.length}</small></h2>${records.length ? `<ul class="list">${rows}</ul>` : '<p class="muted">Nothing recorded yet. Use the bar at the bottom.</p>'}
    <div class="tools"><button type="button" id="goCoords">🧭 Go to coordinates</button><button type="button" id="plotBtn">⬚ Plot</button><button type="button" id="transectBtn">⟶ Transect</button><button type="button" id="scanBtn">▦ Scan a code</button><button type="button" id="formsBtn">📋 Forms</button><button type="button" id="stakeBtn">📍 Stake out</button><button type="button" id="qcBtn">✔ Check records</button></div>
    <div class="row"><button type="button" id="closeList">Close</button></div>`);
  $('#plotBtn').addEventListener('click', plotSheet);
  $('#transectBtn').addEventListener('click', transectSheet);
  $('#scanBtn').addEventListener('click', () => void scanAny());
  $('#formsBtn').addEventListener('click', formsSheet);
  $('#stakeBtn').addEventListener('click', stakeSheet);
  $('#qcBtn').addEventListener('click', () => void qcSheet());
  $('#closeList').addEventListener('click', () => sheet.close());
  $('#goCoords').addEventListener('click', coordsSheet);
  for (const li of $('#sheetBody').querySelectorAll<HTMLElement>('li')) {
    li.addEventListener('click', (e) => {
      const r = records.find((x) => x.id === li.dataset.id);
      if (!r) return;
      if ((e.target as HTMLElement).classList.contains('go')) {
        sheet.close();
        return startNav(`${LABEL[r.kind]}${r.note ? `: ${r.note}` : ''}${r.kind === 'point' ? '' : ' (start)'}`, xy(r.coords[0]));
      }
      if ((e.target as HTMLElement).classList.contains('del')) {
        if (confirm(`Delete this ${LABEL[r.kind].toLowerCase()}?`)) void deleteRecord(r.id).then(listSheet);
        return;
      }
      sheet.close();
      follow = false;
      const b = r.coords.reduce((bb, v) => bb.extend([v[0], v[1]]), new maplibregl.LngLatBounds([r.coords[0][0], r.coords[0][1]], [r.coords[0][0], r.coords[0][1]]));
      map.fitBounds(b, { padding: 80, maxZoom: 18 });
    });
  }
}

// ------------------------------------------------------------------ send
$('#sendBtn').addEventListener('click', () => void sendSheet());
async function sendSheet() {
  await refresh();
  const link = savedLink();
  const unsent = records.filter((r) => !r.sent);
  openSheet(`<h2>Send to GeoSpaX</h2>
    <p class="muted">In GeoSpaX on your computer open <b>Devices › Phone link</b>, then scan its QR code. The phone and the computer must be on the same Wi-Fi.</p>
    <div id="linkState" class="state">${link ? `Paired with <b>${esc(link.base)}</b>` : 'Not paired yet'}</div>
    ${inApp ? '<button type="button" class="wide" id="scan">Scan the QR code</button>' : ''}
    <details ${inApp ? '' : 'open'}><summary>Or paste the phone link address</summary><input id="linkText" placeholder="https://192.168.1.20:8765/#t=…" /><button type="button" id="useLink">Use this address</button></details>
    <p>${unsent.length} record${unsent.length === 1 ? '' : 's'} to send.${(() => { const n = checkRecords(unsent, allForms()).length; return n ? ` <a href="#" id="sendQc">${n} problem${n === 1 ? '' : 's'} found: check first</a>` : ''; })()}</p>
    <div class="row"><button type="button" id="closeSend">Close</button><button type="button" class="primary" id="doSend" ${link && unsent.length ? '' : 'disabled'}>Send</button></div>
    <p id="sendMsg" class="msg" aria-live="polite"></p>`);
  document.getElementById('sendQc')?.addEventListener('click', (e) => { e.preventDefault(); void qcSheet(); });
  const msg = $('#sendMsg');
  const pair = async (l: ReturnType<typeof parseLink>) => {
    if (!l) return void (msg.textContent = 'That is not a GeoSpaX phone link (it has no #t= code).');
    msg.textContent = 'Checking…';
    try {
      const h = await hello(l);
      saveLink(l);
      msg.textContent = `Paired with ${h.computer} (GeoSpaX ${h.version}).`;
      void sendSheet();
    } catch (e) {
      msg.textContent = `GeoSpaX did not answer: ${(e as Error).message}. Same Wi-Fi, and the phone link switched on?`;
    }
  };
  $('#scan')?.addEventListener('click', async () => {
    try { await pair(await scanLink()); } catch (e) { msg.textContent = String((e as Error).message ?? e); }
  });
  $('#useLink').addEventListener('click', () => void pair(parseLink(($('#linkText') as HTMLInputElement).value)));
  $('#closeSend').addEventListener('click', () => sheet.close());
  $('#doSend').addEventListener('click', async () => {
    if (!link) return;
    const btn = $('#doSend') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const n = await send(link, unsent, (d, t) => { msg.textContent = `Sending ${d} of ${t}…`; });
      for (const r of unsent) await putRecord({ ...r, sent: true });
      await refresh();
      msg.textContent = `Sent: ${n} file${n === 1 ? '' : 's'}. GeoSpaX is making the map.`;
    } catch (e) {
      btn.disabled = false;
      msg.textContent = `Not sent: ${(e as Error).message}. Your records are still on the phone.`;
    }
  });
}

// ---------------------------------------------------------------- new version notice
// Once a day, ask GitHub for the latest release; when its APK is newer than this one, say so and
// offer the download (Android installs it over this version; records stay on the phone).
async function checkUpdate() {
  const KEY = 'geospax-field-update-check';
  try {
    if (Date.now() - Number(localStorage.getItem(KEY) ?? 0) < 86_400_000) return;
    localStorage.setItem(KEY, String(Date.now()));
  } catch { /* no storage: check every start */ }
  try {
    const { fetch } = await import('@tauri-apps/plugin-http');
    const r = await fetch('https://api.github.com/repos/jmozez/geospax/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = (await r.json()) as { assets?: { name: string; browser_download_url: string }[] };
    const apk = rel.assets?.find((a) => /^GeoSpaX-Field-[\d.]+\.apk$/.test(a.name));
    const latest = apk?.name.match(/([\d.]+)\.apk$/)?.[1];
    if (!apk || !latest || !newer(latest, __APP_VERSION__)) return;
    openSheet(`<h2>GeoSpaX Field ${latest} is out</h2>
      <p>You have ${__APP_VERSION__}. Download the new version and install it over this one: your records stay on the phone.</p>
      <p><button id="getUpdate" class="primary">Download ${latest}</button> <button id="laterUpdate">Later</button></p>`);
    $('#getUpdate').addEventListener('click', async () => {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(apk.browser_download_url);
      sheet.close();
    });
    $('#laterUpdate').addEventListener('click', () => sheet.close());
  } catch { /* offline in the field: try again tomorrow */ }
}
/** true when version a is later than b ("3.0.10" > "3.0.9") */
function newer(a: string, b: string) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
setTimeout(() => void checkUpdate(), 3000);

// ------------------------------------------------------------------ navigate to a point
function coordsSheet() {
  openSheet(`<h2>Go to coordinates</h2>
    <input id="coordsIn" type="text" inputmode="text" placeholder="-9.4431, 147.1803 or 9°26'35&quot;S 147°10'49&quot;E" autocomplete="off" />
    <p class="muted">Latitude then longitude in decimal degrees, or degrees, minutes and seconds (WGS 84).</p>
    <p id="coordsMsg" class="msg" aria-live="polite"></p>
    <div class="row"><button type="button" id="coordsCancel">Cancel</button><button type="button" class="primary" id="coordsGo">Go</button></div>`);
  $('#coordsCancel').addEventListener('click', () => sheet.close());
  $('#coordsGo').addEventListener('click', () => {
    const text = ($('#coordsIn') as HTMLInputElement).value;
    const at = parseCoords(text);
    if (!at) return void ($('#coordsMsg').textContent = 'Those are not coordinates GeoSpaX Field can read.');
    sheet.close();
    startNav(`${at[1].toFixed(5)}, ${at[0].toFixed(5)}`, at);
  });
}
/** Stations still to walk to after this one (a transect), in order. */
let navQueue: { name: string; at: [number, number] }[] = [];
function startNav(name: string, at: [number, number], then: { name: string; at: [number, number] }[] = []) {
  navQueue = then;
  staking = null;
  $('#nav').classList.remove('staking');
  wasArrived = false;
  target = { name, at };
  void askCompass();
  $('#navName').textContent = name;
  $('#nav').hidden = false;
  follow = false;
  const me = fixes.best() ?? fix;
  if (me) map.fitBounds([[Math.min(me.lon, at[0]), Math.min(me.lat, at[1])], [Math.max(me.lon, at[0]), Math.max(me.lat, at[1])]], { padding: 100, maxZoom: 18 });
  else map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 16) });
  showNav();
}
function stopNav() {
  target = null;
  navQueue = [];
  staking = null;
  $('#nav').classList.remove('staking');
  $('#nav').hidden = true;
  (map.getSource('nav') as maplibregl.GeoJSONSource | undefined)?.setData(fc([]));
}
$('#navStop').addEventListener('click', stopNav);
let wasArrived = false;
function showNav() {
  if (!target) return;
  // the latest fix, not the averaged best one, so the line and distance follow you as you walk
  const me = fix ?? fixes.best();
  const src = map.getSource('nav') as maplibregl.GeoJSONSource | undefined;
  const pt: GeoJSON.Feature = { type: 'Feature', geometry: { type: 'Point', coordinates: target.at }, properties: {} };
  if (!me) {
    $('#navInfo').textContent = 'Waiting for GPS…';
    src?.setData(fc([pt]));
    return;
  }
  if (staking) return showStake(me, src, pt);
  const n = navTo(me, target.at);
  // which way the phone faces: the direction of travel when walking briskly, otherwise the compass
  const moving = me.speed != null && me.speed > 1 && me.heading != null;
  const facing = moving ? me.heading! : compass.bearing(Date.now());
  const arrow = $('#navArrow');
  arrow.style.transform = `rotate(${(facing != null ? turn(n.bearing, facing) : n.bearing) - 90}deg)`;
  arrow.classList.toggle('north', facing == null);
  $('#navInfo').textContent = n.arrived
    ? `You are there (±${Math.round(me.acc)} m)`
    : `${fmtLen(n.distance)} · ${Math.round(n.bearing)}°${facing == null ? ' (arrow from north: no compass)' : ''}${n.eta != null ? ` · about ${fmtTime(n.eta)}` : ''}`;
  $('#nav').classList.toggle('arrived', n.arrived);
  if (n.arrived && !wasArrived) {
    navigator.vibrate?.(200);
    const next = navQueue.shift();
    if (next) {
      toast(`Reached ${target.name}: on to ${next.name}`);
      target = { ...next };
      $('#navName').textContent = next.name;
      wasArrived = false;
      return showNav();
    }
    toast('You have arrived');
  }
  wasArrived = n.arrived;
  src?.setData(fc([pt, { type: 'Feature', geometry: { type: 'LineString', coordinates: [[me.lon, me.lat], target.at] }, properties: {} }]));
}

// ------------------------------------------------------------------ stakeout
/** The design points being staked out, which one is next, and the tolerance in metres. */
let staking: { points: Design[]; i: number; tol: number } | null = null;
function stakeSheet() {
  const pts = records.filter((r) => r.kind === 'point' && r.attrs?.stake_id == null);
  openSheet(`<h2>Stake out</h2>
    <p class="muted">Paste design points, one per line: <code>id, latitude, longitude, height</code> (height above sea level, optional). A CSV with a header line works.</p>
    <textarea id="stakeIn" rows="5" placeholder="P1, -9.44310, 147.18030, 52.10"></textarea>
    <label class="check"><input type="checkbox" id="stakeSaved" ${pts.length ? '' : 'disabled'} /> Or stake the ${pts.length} saved point${pts.length === 1 ? '' : 's'}</label>
    <label>Tolerance <input id="stakeTol" type="number" inputmode="decimal" value="5" min="1" max="500" style="width:5em" /> cm</label>
    <p id="stakeMsg" class="msg" aria-live="polite"></p>
    <div class="row"><button type="button" id="stakeCancel">Cancel</button><button type="button" class="primary" id="stakeGo">Start</button></div>`);
  $('#stakeCancel').addEventListener('click', () => sheet.close());
  $('#stakeIn').addEventListener('input', () => { $('#stakeMsg').textContent = ''; });
  $('#stakeGo').addEventListener('click', () => {
    const tol = Math.max(0.01, Number(($('#stakeTol') as HTMLInputElement).value || 5) / 100);
    let points: Design[];
    if (($('#stakeSaved') as HTMLInputElement).checked) {
      points = [...pts].reverse().map((r, i) => ({ id: r.note.split('\n')[0].trim().slice(0, 30) || `P${i + 1}`, at: xy(r.coords[0]), h: r.coords[0][2] }));
    } else {
      const d = parseDesign(($('#stakeIn') as HTMLTextAreaElement).value);
      if (d.bad.length) return void ($('#stakeMsg').textContent = `Line${d.bad.length > 1 ? 's' : ''} ${d.bad.join(', ')} ${d.bad.length > 1 ? 'are' : 'is'} not a point.`);
      points = d.points;
    }
    if (!points.length) return void ($('#stakeMsg').textContent = 'No design points yet.');
    sheet.close();
    startStake(points, 0, tol);
  });
}
function startStake(points: Design[], i: number, tol: number) {
  const p = points[i];
  startNav(`Stake ${p.id} (${i + 1} of ${points.length})`, p.at);
  staking = { points, i, tol };
  $('#nav').classList.add('staking');
  showNav();
}
function showStake(me: Fix, src: maplibregl.GeoJSONSource | undefined, pt: GeoJSON.Feature) {
  const d = staking!.points[staking!.i];
  const moving = me.speed != null && me.speed > 1 && me.heading != null;
  const facing = moving ? me.heading! : compass.bearing(Date.now());
  const s = stake([me.lon, me.lat], d.at, facing, heights(me).best?.value ?? null, d.h, staking!.tol);
  const bearing = norm((Math.atan2(s.e, s.n) * 180) / Math.PI);
  const arrow = $('#navArrow');
  arrow.style.transform = `rotate(${(facing != null ? turn(bearing, facing) : bearing) - 90}deg)`;
  arrow.classList.toggle('north', facing == null);
  $('#navInfo').innerHTML = `<span class="big">${s.on ? 'On the mark' : esc(fmtLen(s.dist))}</span> ${esc(fmtNE(s))}${fmtAhead(s) ? `<br>${esc(fmtAhead(s))}` : ''}${d.h != null ? `<br>${esc(fmtCutFill(s.dh) || 'No height here yet')}` : ''}<br><small>${esc(fmtAcc(me.acc))}${me.acc > staking!.tol ? ': weaker than the tolerance' : ''}</small>`;
  $('#nav').classList.toggle('arrived', s.on);
  if (s.on && !wasArrived) navigator.vibrate?.(200);
  wasArrived = s.on;
  src?.setData(fc([pt, { type: 'Feature', geometry: { type: 'LineString', coordinates: [[me.lon, me.lat], d.at] }, properties: {} }]));
}
$('#navStake').addEventListener('click', async () => {
  if (!staking) return;
  // the latest fix, as shown in the box: an average would lag behind the last steps onto the mark
  const b = fix ?? fixes.best();
  if (!b) return toast('Waiting for GPS');
  const d = staking.points[staking.i];
  const h = heights(b).best;
  const s = stake([b.lon, b.lat], d.at, null, h?.value ?? null, d.h, staking.tol);
  const r2 = (x: number) => Math.round(x * 1000) / 1000;
  await save('point', [[b.lon, b.lat, h?.value ?? null, Date.now(), b.acc]], {
    note: `Staked ${d.id}`, photos: [], voice: [],
    attrs: { stake_id: d.id, design_lat: d.at[1], design_lon: d.at[0], design_h: d.h, stake_dn: r2(-s.n), stake_de: r2(-s.e), stake_offset_m: r2(s.dist), stake_dh: s.dh != null ? r2(-s.dh) : null },
  }, h, true);
  await refresh();
  toast(`${d.id} staked ${s.on ? 'within tolerance' : `${fmtLen(s.dist)} off`}`);
  const { points, i, tol } = staking;
  if (i + 1 < points.length) startStake(points, i + 1, tol);
  else { stopNav(); toast(`All ${points.length} points staked`); }
});

// ------------------------------------------------------------------ quality checks
async function qcSheet() {
  await refresh();
  const issues = checkRecords(records, allForms(), { maxAcc: settings().warnAcc || 10 });
  const by = (l: Issue['level']) => issues.filter((i) => i.level === l).length;
  openSheet(`<h2>Check records <small>${records.length}</small></h2>
    ${issues.length ? `<p>${by('error')} error${by('error') === 1 ? '' : 's'} and ${by('warning')} warning${by('warning') === 1 ? '' : 's'}. Tap one to see it on the map.</p>
    <ul class="list qc">${issues.map((i, n) => `<li data-n="${n}" class="${i.level}"><b>${i.level === 'error' ? '✕' : '!'}</b> ${esc(i.text)}</li>`).join('')}</ul>`
      : '<p class="state">No problems found.</p>'}
    <p class="muted">Checks: weak fixes, possible duplicate points, areas that cross themselves, very short lines, gaps and jumps in tracks, unanswered form questions and stakeout misses.</p>
    <div class="row"><button type="button" id="qcClose">Close</button></div>`);
  $('#qcClose').addEventListener('click', () => sheet.close());
  for (const li of $('#sheetBody').querySelectorAll<HTMLElement>('li[data-n]')) {
    li.addEventListener('click', () => {
      const r = records.find((x) => x.id === issues[Number(li.dataset.n)].id);
      if (!r) return;
      sheet.close();
      follow = false;
      const b = r.coords.reduce((bb, v) => bb.extend([v[0], v[1]]), new maplibregl.LngLatBounds([r.coords[0][0], r.coords[0][1]], [r.coords[0][0], r.coords[0][1]]));
      map.fitBounds(b, { padding: 80, maxZoom: 19 });
    });
  }
}

// ------------------------------------------------------------------ plots, transects, codes and forms
const nextId = (prefix: string, key: string) => {
  let n = 0;
  for (const r of records) { const m = String(r.attrs?.[key] ?? '').match(new RegExp(`^${prefix}(\\d+)$`)); if (m) n = Math.max(n, Number(m[1])); }
  return `${prefix}${n + 1}`;
};
const centre = (): [number, number, number | null] => {
  const me = fixes.best() ?? fix;
  if (me) return [me.lon, me.lat, me.acc];
  const c = map.getCenter();
  return [c.lng, c.lat, null];
};

function plotSheet() {
  const id = nextId('P', 'plot_id');
  const [, , acc] = centre();
  const opts = (shape: Shape) => SIZES[shape].map((m) => `<option value="${m}">${shape === 'circle' ? `radius ${m} m` : `${m} × ${m} m`} (${fmtArea(plotArea(shape, m))})</option>`).join('');
  openSheet(`<h2>Lay out a plot</h2>
    <p class="muted">Centred on ${acc != null ? `your position (±${Math.round(acc)} m)` : 'the map centre (no GPS yet)'}.</p>
    <label>Plot<input id="plotId" value="${id}" /></label>
    <label>Shape<select id="plotShape"><option value="circle">Circle</option><option value="square">Square (sides north to south)</option></select></label>
    <label>Size<select id="plotSize">${opts('circle')}</select></label>
    <div class="row"><button type="button" id="plotCancel">Cancel</button><button type="button" class="primary" id="plotGo">Lay out</button></div>`);
  ($('#plotSize') as HTMLSelectElement).selectedIndex = 1;
  $('#plotShape').addEventListener('change', () => { $('#plotSize').innerHTML = opts(($('#plotShape') as HTMLSelectElement).value as Shape); });
  $('#plotCancel').addEventListener('click', () => sheet.close());
  $('#plotGo').addEventListener('click', async () => {
    const shape = ($('#plotShape') as HTMLSelectElement).value as Shape;
    const size = Number(($('#plotSize') as HTMLSelectElement).value);
    const pid = ($('#plotId') as HTMLInputElement).value.trim() || id;
    const [lon, lat, a] = centre();
    const ring = plot(lon, lat, shape, size);
    const now = Date.now();
    const coords: Vertex[] = ring.map(([x, y]) => [x, y, null, now, a]);
    showPlan([ring]);
    const r = await noteSheet(`Plot ${pid} · ${shape === 'circle' ? `radius ${size} m` : `${size} × ${size} m`} · ${fmtArea(plotArea(shape, size))}`, false, [], `Plot ${pid}`);
    showPlan([]);
    if (!r) return;
    await save('area', coords, { ...r, attrs: { ...r.attrs, plot_id: pid, plot_shape: shape, plot_size_m: size } });
    map.fitBounds(ring.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(ring[0], ring[0])), { padding: 80, maxZoom: 19 });
  });
}

function transectSheet() {
  const id = nextId('T', 'transect_id');
  const [, , acc] = centre();
  const b = compass.bearing(Date.now());
  openSheet(`<h2>Lay out a transect</h2>
    <p class="muted">Starts at ${acc != null ? `your position (±${Math.round(acc)} m)` : 'the map centre (no GPS yet)'}. You are then guided to each station in turn.</p>
    <label>Transect<input id="trId" value="${id}" /></label>
    <label>Bearing (degrees from north)<span class="codeRow"><input id="trBearing" type="number" inputmode="decimal" min="0" max="359" step="any" value="${b != null ? Math.round(b) : 0}" /><button type="button" id="trAim">🧭 Facing</button></span></label>
    <div class="row"><label>Length (m)<input id="trLen" type="number" inputmode="decimal" min="1" step="any" value="100" /></label><label>Station every (m)<input id="trEvery" type="number" inputmode="decimal" min="1" step="any" value="10" /></label></div>
    <p id="trMsg" class="msg" aria-live="polite"></p>
    <div class="row"><button type="button" id="trCancel">Cancel</button><button type="button" class="primary" id="trGo">Lay out</button></div>`);
  void askCompass();
  $('#trAim').addEventListener('click', () => {
    const v = compass.bearing(Date.now());
    if (v == null) return void ($('#trMsg').textContent = 'No compass reading: type the bearing.');
    ($('#trBearing') as HTMLInputElement).value = String(Math.round(v));
  });
  $('#trCancel').addEventListener('click', () => sheet.close());
  $('#trGo').addEventListener('click', async () => {
    const num = (sel: string) => Number(($(sel) as HTMLInputElement).value);
    const bearing = norm(num('#trBearing')), length = num('#trLen'), every = num('#trEvery');
    const tid = ($('#trId') as HTMLInputElement).value.trim() || id;
    const [lon, lat, a] = centre();
    let t;
    try { t = transect(lon, lat, bearing, length, every); } catch (e) { return void ($('#trMsg').textContent = (e as Error).message); }
    showPlan([t.line], t.stations.map((s) => s.at));
    const r = await noteSheet(`Transect ${tid} · ${fmtLen(length)} on ${Math.round(bearing)}° (${fmtBearing(bearing)}) · ${t.stations.length} stations`, false, [], `Transect ${tid}`);
    showPlan([]);
    if (!r) return;
    const now = Date.now();
    const meta = { transect_id: tid, bearing_deg: Math.round(bearing * 10) / 10, length_m: length, station_every_m: every };
    await save('line', t.line.map(([x, y]) => [x, y, null, now, a] as Vertex), { ...r, attrs: { ...r.attrs, ...meta } }, null, true, now);
    for (const [i, st] of t.stations.entries()) await save('point', [[st.at[0], st.at[1], null, now, a]], { note: `${tid} station ${st.m} m`, photos: [], voice: [], attrs: { transect_id: tid, station_m: st.m } }, null, true, now + i + 1);
    await refresh();
    toast(`Transect ${tid} saved with ${t.stations.length} stations`);
    const legs = t.stations.slice(1).map((st) => ({ name: `${tid} station ${st.m} m`, at: st.at }));
    if (legs.length) startNav(legs[0].name, legs[0].at, legs.slice(1));
  });
}

/** A plot or transect being laid out, drawn on the map until it is saved or cancelled. */
function showPlan(lines: [number, number][][], pts: [number, number][] = []) {
  const src = map.getSource('plan') as maplibregl.GeoJSONSource | undefined;
  src?.setData(fc([
    ...lines.map((l): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.length > 2 ? [...l, l[0]] : l }, properties: {} })),
    ...pts.map((p): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} })),
  ]));
}

/** Scans any code: a form is added, a phone link pairs, coordinates are navigated to, anything else is saved as a point. */
async function scanAny() {
  const code = await scanCode('Scan a code');
  if (!code) return;
  const k = qrKind(code);
  if (k === 'form') {
    try { const f = parseForm(code); addForm(f); toast(`Form "${f.name}" added`); return formsSheet(); } catch (e) { return toast((e as Error).message); }
  }
  if (k === 'link') { const l = parseLink(code); if (l) { saveLink(l); return void sendSheet(); } }
  const at = parseCoords(code);
  if (at) { sheet.close(); return startNav(`${at[1].toFixed(5)}, ${at[0].toFixed(5)}`, at); }
  const v = here() ?? (() => { const c = map.getCenter(); return [c.lng, c.lat, null, Date.now(), null] as Vertex; })();
  const r = await noteSheet(`Code ${code.length > 40 ? `${code.slice(0, 40)}…` : code}`, true, [], code);
  if (r) await save('point', [v], { ...r, attrs: { ...r.attrs, code } });
}

function formsSheet() {
  const forms = allForms();
  openSheet(`<h2>Forms <small>${forms.length}</small></h2>
    <p class="muted">Pick a form when you save a record to fill in its fields. They are sent to GeoSpaX as attributes.</p>
    <ul class="list forms">${forms.map((f, i) => `<li data-i="${i}"><b>${esc(f.name)}</b><small>${f.fields.length} field${f.fields.length === 1 ? '' : 's'}: ${esc(f.fields.map((x) => x.label).join(', '))}${i < BUILT_IN.length ? ' · built in' : ''}</small><button type="button" class="share" aria-label="Share ${esc(f.name)}">⇪</button>${i < BUILT_IN.length ? '' : `<button type="button" class="del" aria-label="Delete ${esc(f.name)}">✕</button>`}</li>`).join('')}</ul>
    <div class="tools"><button type="button" id="newForm">＋ New form</button><button type="button" id="scanForm">▦ Scan a form</button><button type="button" id="pasteForm">Paste a form</button></div>
    <div class="row"><button type="button" id="formsBack">Back</button></div>`);
  $('#formsBack').addEventListener('click', () => void listSheet());
  $('#newForm').addEventListener('click', () => formBuilder());
  $('#scanForm').addEventListener('click', () => void scanAny());
  $('#pasteForm').addEventListener('click', () => {
    openSheet(`<h2>Paste a form</h2><textarea id="formJson" rows="8" placeholder='{"name": "…", "fields": [{"label": "…", "type": "text"}]}'></textarea><p id="pasteMsg" class="msg"></p>
      <div class="row"><button type="button" id="pasteBack">Back</button><button type="button" class="primary" id="pasteAdd">Add</button></div>`);
    $('#pasteBack').addEventListener('click', formsSheet);
    $('#pasteAdd').addEventListener('click', () => {
      try { const f = parseForm(($('#formJson') as HTMLTextAreaElement).value); addForm(f); toast(`Form "${f.name}" added`); formsSheet(); } catch (e) { $('#pasteMsg').textContent = (e as Error).message; }
    });
  });
  for (const li of $('#sheetBody').querySelectorAll<HTMLElement>('ul.forms li')) {
    const f = forms[Number(li.dataset.i)];
    li.querySelector('.del')?.addEventListener('click', () => {
      if (!confirm(`Delete the form "${f.name}"? Records already filled in keep their answers.`)) return;
      saveUserForms(userForms().filter((x) => x.name !== f.name));
      formsSheet();
    });
    li.querySelector('.share')!.addEventListener('click', () => {
      const json = JSON.stringify(f);
      openSheet(`<h2>${esc(f.name)}</h2><p class="muted">Copy this and paste it on another phone (Forms › Paste a form), or make a QR code of it to scan.</p><textarea id="formJson" rows="8" readonly>${esc(json)}</textarea>
        <div class="row"><button type="button" id="shareBack">Back</button><button type="button" class="primary" id="shareCopy">Copy</button></div>`);
      $('#shareBack').addEventListener('click', formsSheet);
      $('#shareCopy').addEventListener('click', () => void navigator.clipboard?.writeText(json).then(() => toast('Copied'), () => toast('Select the text and copy it')));
    });
  }
}

function formBuilder() {
  openSheet(`<h2>New form</h2>
    <label>Name<input id="fbName" placeholder="Water point check" /></label>
    <div id="fbFields"></div>
    <button type="button" class="wide" id="fbAdd">＋ Add a field</button>
    <p id="fbMsg" class="msg" aria-live="polite"></p>
    <div class="row"><button type="button" id="fbBack">Back</button><button type="button" class="primary" id="fbSave">Save form</button></div>`);
  const addRow = () => {
    const d = document.createElement('fieldset');
    d.className = 'fbRow';
    d.innerHTML = `<input class="fbLabel" placeholder="Field label" /><select class="fbType">${TYPES.map((t) => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('')}</select>
      <input class="fbOpts" placeholder="Choices, separated by commas" hidden /><input class="fbUnit" placeholder="Unit (optional), e.g. cm" hidden />
      <span class="codeRow"><label class="check"><input type="checkbox" class="fbReq" /> Needed</label><button type="button" class="fbDel" aria-label="Remove this field">✕</button></span>`;
    const ty = d.querySelector<HTMLSelectElement>('.fbType')!;
    ty.addEventListener('change', () => {
      d.querySelector<HTMLInputElement>('.fbOpts')!.hidden = ty.value !== 'choice';
      d.querySelector<HTMLInputElement>('.fbUnit')!.hidden = ty.value !== 'number';
    });
    d.querySelector('.fbDel')!.addEventListener('click', () => d.remove());
    $('#fbFields').append(d);
    d.querySelector<HTMLInputElement>('.fbLabel')!.focus();
  };
  addRow();
  $('#fbAdd').addEventListener('click', addRow);
  $('#fbBack').addEventListener('click', formsSheet);
  $('#fbSave').addEventListener('click', () => {
    const fields = [...$('#fbFields').querySelectorAll<HTMLElement>('.fbRow')].map((d) => {
      const q = (c: string) => d.querySelector<HTMLInputElement>(c)!;
      const type = (d.querySelector<HTMLSelectElement>('.fbType')!.value) as FieldType;
      return { label: q('.fbLabel').value, type, required: q('.fbReq').checked, ...(type === 'choice' ? { options: q('.fbOpts').value.split(',') } : {}), ...(type === 'number' && q('.fbUnit').value.trim() ? { unit: q('.fbUnit').value } : {}) };
    });
    try {
      const f = parseForm({ name: ($('#fbName') as HTMLInputElement).value, fields });
      addForm(f);
      toast(`Form "${f.name}" saved`);
      formsSheet();
    } catch (e) { $('#fbMsg').textContent = (e as Error).message; }
  });
}

setInterval(showNav, 300);
(window as unknown as { __field: Record<string, unknown> }).__field.startNav = startNav;

installBasics({
  openSheet,
  closeSheet: () => sheet.close(),
  toast,
  refresh,
  fix: () => fixes.best() ?? fix,
  raw: () => gps,
  receiver: () => ({ name: receiverLive() || receiver ? receiver!.name : null, connect: connectGnss, disconnect: () => { receiver?.disconnect(); receiver = null; } }),
  heights: () => heights(fixes.best() ?? fix),
  setDem,
  setBasemap,
});
startHeights(settings().dem);
