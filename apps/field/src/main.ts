// GeoSpaX Field: a full-screen map with the recording bar at the bottom (one-handed use). Points, lines,
// areas, tracks and photos are saved on the phone as they are made and sent to GeoSpaX when there is a
// connection to it.
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { allRecords, deleteRecord, newId, putRecord, type Kind, type Photo, type Rec, type Vertex } from './db';
import { FixFilter, metres, watchPosition, type Fix } from './geo';
import { BASEMAPS, installTileCache, type Basemap } from './tiles';
import { hello, parseLink, saveLink, savedLink, scanLink, send } from './sync';
import { inApp } from './geo';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const LABEL: Record<Kind, string> = { point: 'Point', line: 'Line', area: 'Area', track: 'Track' };

let fix: Fix | null = null;
const fixes = new FixFilter();
let records: Rec[] = [];
let draft: { kind: 'line' | 'area'; coords: Vertex[] } | null = null;
let track: Rec | null = null;
let basemap: Basemap = (localStorage.getItem('geospax-field.basemap') as Basemap) || 'imagery';
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
    $('#drawMsg').textContent = `${draft.coords.length} point${draft.coords.length === 1 ? '' : 's'}: tap the map or add your position`;
  }
  if (track) parts.push(recFeature(track));
  (map.getSource('draft') as maplibregl.GeoJSONSource | undefined)?.setData(fc(parts.filter(Boolean)));
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
void watchPosition(
  (raw) => {
    const f = fixes.add(raw);
    if (!f) {
      // a cached, coarse or jumping fix: say so while there is no good one yet, otherwise keep the last
      if (!fix) showGps(`Waiting for GPS (±${Math.round(raw.acc)} m)`, 'wait');
      return;
    }
    const first = !fix;
    fix = f;
    showGps(`GPS ±${Math.round(f.acc)} m`, f.acc <= 10 ? 'good' : f.acc <= 30 ? 'fair' : 'poor');
    drawMe();
    if (first || follow) map.easeTo({ center: [f.lon, f.lat], zoom: first ? Math.max(map.getZoom(), 16) : map.getZoom(), duration: first ? 0 : 400 });
    if (track) {
      const last = track.coords[track.coords.length - 1];
      // a new track point every 3 m, and only fixes good enough to draw a line with
      if (f.acc <= 50 && (!last || metres([last[0], last[1]], [f.lon, f.lat]) >= 3)) {
        track.coords.push([f.lon, f.lat, f.ele, f.t, f.acc]);
        $('#trackInfo').textContent = trackText(track);
        drawDraft();
      }
    }
  },
  (msg) => showGps(msg.length > 40 ? 'No GPS' : msg, 'poor'),
);
$('#locate').addEventListener('click', () => {
  follow = true;
  if (fix) map.easeTo({ center: [fix.lon, fix.lat], zoom: Math.max(map.getZoom(), 16) });
});

// a point is placed at the average of the last seconds' good fixes, not at the latest single one
const here = (): Vertex | null => {
  const b = fixes.best();
  return b ? [b.lon, b.lat, b.ele, Date.now(), b.acc] : null;
};
// for the emulator test in CI (scripts/test-field-emulator.mjs): what the app thinks its position is
const cspBlocked: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => {
  cspBlocked.push(`${e.effectiveDirective} ${e.blockedURI}`);
  console.warn('blocked by the content security policy:', e.effectiveDirective, e.blockedURI);
});
(window as unknown as { __field: object }).__field = { cspBlocked, fix: () => fix, best: () => fixes.best(), here, parseLink, hello, send };
function trackText(t: Rec) {
  let m = 0;
  for (let i = 1; i < t.coords.length; i++) m += metres([t.coords[i - 1][0], t.coords[i - 1][1]], [t.coords[i][0], t.coords[i][1]]);
  return `Recording · ${m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`}`;
}

// ------------------------------------------------------------------ sheets
const sheet = $('#sheet') as HTMLDialogElement;
function openSheet(html: string) {
  $('#sheetBody').innerHTML = html;
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

function noteSheet(title: string, withPhoto = false): Promise<{ note: string; photos: Photo[] } | null> {
  return new Promise((resolve) => {
    const photos: Photo[] = [];
    openSheet(`<h2>${esc(title)}</h2>
      <textarea id="note" rows="3" placeholder="What is here? (optional)"></textarea>
      ${withPhoto ? '<button type="button" class="wide" id="addPhoto">📷 Add a photo</button><div id="thumbs" class="thumbs"></div>' : ''}
      <div class="row"><button type="button" id="cancel">Cancel</button><button type="button" class="primary" id="save">Save</button></div>`);
    $('#addPhoto')?.addEventListener('click', async () => {
      const p = await takePhoto();
      if (!p) return;
      photos.push(p);
      const img = document.createElement('img');
      img.src = URL.createObjectURL(p.blob);
      $('#thumbs').append(img);
    });
    const done = (v: { note: string; photos: Photo[] } | null) => { sheet.close(); resolve(v); };
    $('#cancel').addEventListener('click', () => done(null));
    $('#save').addEventListener('click', () => done({ note: ($('#note') as HTMLTextAreaElement).value.trim(), photos }));
    sheet.addEventListener('close', () => resolve(null), { once: true });
  });
}

/** The camera (or the gallery), with the position at the moment it was taken. */
function takePhoto(): Promise<Photo | null> {
  return new Promise((resolve) => {
    const input = $('#photoInput') as HTMLInputElement;
    input.value = '';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const ts = Date.now();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      resolve({ id: newId(), name: `photo-${new Date(ts).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, blob: file, lon: fix?.lon ?? null, lat: fix?.lat ?? null, acc: fix?.acc ?? null, ts });
    };
    input.click();
  });
}

async function save(kind: Kind, coords: Vertex[], note: string, photos: Photo[] = []) {
  await putRecord({ id: newId(), kind, coords, note, created: Date.now(), sent: false, photos });
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
  const r = await noteSheet(v[4] != null ? `Point at your position (±${Math.round(v[4])} m)` : 'Point at the map centre (no GPS yet)', true);
  if (r) await save('point', [v], r.note, r.photos);
});

function startDraw(kind: 'line' | 'area') {
  draft = { kind, coords: [] };
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
$('#drawUndo').addEventListener('click', () => { draft?.coords.pop(); drawDraft(); });
const endDraw = () => { draft = null; $('#draw').hidden = true; $('#bar').hidden = false; drawDraft(); };
$('#drawCancel').addEventListener('click', endDraw);
$('#drawDone').addEventListener('click', async () => {
  if (!draft) return;
  const need = draft.kind === 'area' ? 3 : 2;
  if (draft.coords.length < need) return toast(`An ${draft.kind} needs at least ${need} points`);
  const d = draft;
  const r = await noteSheet(`${LABEL[d.kind]} with ${d.coords.length} points`);
  if (r) {
    await save(d.kind, d.coords, r.note);
    endDraw();
  }
});

$('#btnTrack').addEventListener('click', async () => {
  if (!track) {
    track = { id: newId(), kind: 'track', coords: [], note: '', created: Date.now(), sent: false, photos: [] };
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
  const r = await noteSheet(trackText(t).replace('Recording · ', 'Track · '));
  await save('track', t.coords, r?.note ?? '');
});

$('#btnPhoto').addEventListener('click', async () => {
  const p = await takePhoto();
  if (!p) return;
  const v: Vertex = p.lon != null && p.lat != null ? [p.lon, p.lat, fix?.ele ?? null, p.ts, p.acc] : (() => { const c = map.getCenter(); return [c.lng, c.lat, null, p.ts, null] as Vertex; })();
  await save('point', [v], 'Photo', [p]);
});

$('#basemap').addEventListener('click', () => setBasemap(basemap === 'imagery' ? 'map' : 'imagery'));

// ------------------------------------------------------------------ records
$('#btnList').addEventListener('click', () => void listSheet());
async function listSheet() {
  await refresh();
  const rows = records
    .map((r) => `<li data-id="${r.id}"><b>${LABEL[r.kind]}</b> ${esc(r.note || '')}<small>${new Date(r.created).toLocaleString()}${r.photos.length ? ` · ${r.photos.length} photo${r.photos.length > 1 ? 's' : ''}` : ''} · ${r.sent ? 'sent' : '<em>not sent</em>'}</small><button type="button" class="del" aria-label="Delete">✕</button></li>`)
    .join('');
  openSheet(`<h2>Records <small>${records.length}</small></h2>${records.length ? `<ul class="list">${rows}</ul>` : '<p class="muted">Nothing recorded yet. Use the bar at the bottom.</p>'}
    <div class="row"><button type="button" id="closeList">Close</button></div>`);
  $('#closeList').addEventListener('click', () => sheet.close());
  for (const li of $('#sheetBody').querySelectorAll<HTMLElement>('li')) {
    li.addEventListener('click', (e) => {
      const r = records.find((x) => x.id === li.dataset.id);
      if (!r) return;
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
    <p>${unsent.length} record${unsent.length === 1 ? '' : 's'} to send.</p>
    <div class="row"><button type="button" id="closeSend">Close</button><button type="button" class="primary" id="doSend" ${link && unsent.length ? '' : 'disabled'}>Send</button></div>
    <p id="sendMsg" class="msg" aria-live="polite"></p>`);
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
