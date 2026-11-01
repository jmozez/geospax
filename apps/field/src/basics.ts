// The phone basics behind the ⋯ menu: Help, About, What's new, Settings, Send feedback, the first-run tour,
// the offline maps manager, GPS status, and backup and export. Nothing here leaves the phone unless you
// choose to (feedback opens your own mail app; export hands a file to the share sheet).
import type { Voice } from './capture';
import { allRecords, clearTilesFrom, putRecord, tileStats, type Photo, type Rec } from './db';
import { fmtHeight, SOURCE_LABEL, type Height } from './elevation';
import type { Fix } from './geo';
import { canBluetooth, fmtAcc, QUALITY_LABEL, type GnssFix } from './gnss';
import { BASEMAPS, type Basemap } from './tiles';

export interface Ctx {
  openSheet(html: string): void;
  closeSheet(): void;
  toast(text: string): void;
  refresh(): Promise<void>;
  fix(): Fix | null;
  raw(): { fix: Fix | null; count: number; error: string | null; since: number };
  setBasemap(b: Basemap): void;
  heights(): Heights;
  setDem(on: boolean): void;
  /** the Bluetooth GNSS receiver in use, if any */
  receiver(): { name: string | null; connect(): Promise<void>; disconnect(): void };
}
export interface Heights { gnss: Height | null; baro: Height | null; dem: Height | null; best: Height | null }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const FEEDBACK_EMAIL = 'j.moses0131@gmail.com';
export const ISSUES_URL = 'https://github.com/jmozez/geospax/issues/new';
export const REPO_URL = 'https://github.com/jmozez/geospax';

// ------------------------------------------------------------------ settings
export interface Settings {
  basemap: Basemap;
  /** a point with worse accuracy than this asks before saving, metres */
  warnAcc: number;
  /** keep the screen on while the app is open (uses more battery) */
  keepAwake: boolean;
  /** show the tour again at the next start */
  tourDone: boolean;
  /** ask the terrain model (Open-Meteo, online) for heights: sends the position */
  dem: boolean;
}
const SKEY = 'geospax-field.settings';
export function settings(): Settings {
  const d: Settings = { basemap: (localStorage.getItem('geospax-field.basemap') as Basemap) || 'imagery', warnAcc: 30, keepAwake: false, tourDone: false, dem: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SKEY) ?? '{}') }; } catch { return d; }
}
export function saveSettings(s: Partial<Settings>) {
  const all = { ...settings(), ...s };
  try { localStorage.setItem(SKEY, JSON.stringify(all)); } catch { /* private mode: for this session only */ }
  return all;
}

let wake: { release(): Promise<void> } | null = null;
export async function applyKeepAwake(on: boolean) {
  const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!on) { await wake?.release().catch(() => {}); wake = null; return; }
  if (!wl || wake) return;
  try { wake = await wl.request('screen'); } catch { /* not allowed now: tried again when the app is back in front */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && settings().keepAwake) { wake = null; void applyKeepAwake(true); } });

// ------------------------------------------------------------------ what's new, help, about
export const WHATS_NEW: { version: string; items: string[] }[] = [
  {
    version: '3.1.0',
    items: [
      'A ⋯ menu with Help, About, What\'s new, Settings and Send feedback.',
      'A short tour on the first start (Help › Take the tour shows it again).',
      'Offline maps: see how much map is kept on the phone and clear it per basemap.',
      'GPS status: accuracy, height, speed, heading and the age of the last fix.',
      'Backup and export: a full backup with photos, restore, and GeoJSON export.',
      'Heights above sea level (EGM2008), not above the ellipsoid, each with its source: GPS, barometer or terrain model.',
      'The barometer, on phones that have one, keeps heights steady when the GPS height is poor.',
      'Optional terrain model heights (Copernicus GLO-90, online) when GPS is poor: switch on in Settings.',
    ],
  },
  { version: '3.0.9', items: ['Field sync with GeoSpaX on your computer, and steadier positions from averaged fixes.'] },
];

function menuSheet(ctx: Ctx) {
  const items: [string, string, string][] = [
    ['gps', '📡', 'GPS status'],
    ['offline', '🗺', 'Offline maps'],
    ['backup', '💾', 'Backup and export'],
    ['settings', '⚙', 'Settings'],
    ['help', '❓', 'Help'],
    ['tour', '▶', 'Take the tour'],
    ['news', '✨', "What's new"],
    ['feedback', '✉', 'Send feedback'],
    ['about', 'ℹ', 'About'],
  ];
  ctx.openSheet(`<h2>GeoSpaX Field</h2><div class="menu">${items.map(([id, ic, label]) => `<button type="button" data-go="${id}"><b>${ic}</b><span>${label}</span></button>`).join('')}</div>
    <div class="row"><button type="button" id="menuClose">Close</button></div>`);
  $('#menuClose').addEventListener('click', () => ctx.closeSheet());
  for (const b of $('#sheetBody').querySelectorAll<HTMLButtonElement>('[data-go]')) b.addEventListener('click', () => void go(ctx, b.dataset.go!));
}

async function go(ctx: Ctx, id: string) {
  if (id === 'gps') return gpsSheet(ctx);
  if (id === 'offline') return offlineSheet(ctx);
  if (id === 'backup') return backupSheet(ctx);
  if (id === 'settings') return settingsSheet(ctx);
  if (id === 'help') return helpSheet(ctx);
  if (id === 'tour') { ctx.closeSheet(); return startTour(); }
  if (id === 'news') return newsSheet(ctx);
  if (id === 'feedback') return feedbackSheet(ctx);
  if (id === 'about') return aboutSheet(ctx);
}

const back = (ctx: Ctx) => {
  $('#back').addEventListener('click', () => menuSheet(ctx));
};
const backRow = '<div class="row"><button type="button" id="back">Back</button></div>';

function helpSheet(ctx: Ctx) {
  ctx.openSheet(`<h2>Help</h2>
    <dl class="help">
      <dt>● Point</dt><dd>Saves your position, averaged over the last few seconds, with a note and photos. Without GPS it uses the map centre.</dd>
      <dt>╱ Line and ▱ Area</dt><dd>Tap the map or press My position for each corner, then Finish.</dd>
      <dt>⦿ Track</dt><dd>Records where you walk (a point every 3 m) until you press Stop. Tap the red pill at the top to pause and go on.</dd>
      <dt>🚶 Walk it</dt><dd>While drawing a line or area, tap Walk it and walk the boundary: a point is added every 3 m and the area and perimeter (or length) are shown as you go.</dd>
      <dt>➜ Navigate</dt><dd>In Records, tap ➜ on a record, or Go to coordinates, for the distance and an arrow to it. Tap ✕ to stop.</dd>
      <dt>📋 Forms</dt><dd>When saving, pick a form to fill in its fields. Make or share forms in Records › Forms.</dd>
      <dt>▦ Scan a code</dt><dd>In Records: scan a tag, a form, coordinates or the GeoSpaX phone link. Code fields in a form have their own Scan button.</dd>
      <dt>📍 Stake out</dt><dd>In Records: paste design points or use saved ones, walk until it says On the mark, then tap Staked. The offsets are saved with the point.</dd>
      <dt>✔ Check records</dt><dd>In Records: lists weak fixes, duplicates, crossed areas, track gaps and unanswered form questions. Tap one to see it.</dd>
      <dt>Bluetooth GNSS</dt><dd>Tap the GPS chip, then Connect a Bluetooth receiver, for RTK accuracy. In the phone app, use the receiver's mock location instead.</dd>
      <dt>⬚ Plot and ⟶ Transect</dt><dd>In Records: lay out a plot around you, or a transect on a bearing with stations you are then guided to one by one.</dd>
      <dt>📷 Photo</dt><dd>A photo saved as a point where it was taken, with the compass bearing the camera faced (you can correct it before saving).</dd>
      <dt>🎙 Voice note</dt><dd>On any point, line, area or photo: tap Voice note, talk, tap Stop. It is kept with the record and sent with it.</dd>
      <dt>☰ Records</dt><dd>Everything on the phone. Tap one to zoom to it.</dd>
      <dt>Send</dt><dd>In GeoSpaX on your computer open Devices › Phone link and scan its QR code. Both must be on the same Wi-Fi.</dd>
      <dt>No signal?</dt><dd>Recording works offline. The map shows the places you have looked at before (⋯ › Offline maps).</dd>
      <dt>GPS colour</dt><dd>Green is 10 m or better, amber 30 m or better, red worse. Wait for green under open sky for the best points.</dd>
    </dl>
    <p><a href="${REPO_URL}#readme" target="_blank" rel="noopener">The full GeoSpaX guide</a></p>${backRow}`);
  back(ctx);
}

function newsSheet(ctx: Ctx) {
  ctx.openSheet(`<h2>What's new</h2>${WHATS_NEW.map((v) => `<h3>${v.version}</h3><ul>${v.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}${backRow}`);
  back(ctx);
}

function aboutSheet(ctx: Ctx) {
  ctx.openSheet(`<h2>About</h2>
    <p><img src="geospax-logo.png" alt="" width="48" height="48" class="logo" /> <b>GeoSpaX Field ${__APP_VERSION__}</b></p>
    <p class="muted">The phone companion of GeoSpaX, the open-source GIS by Dr Jimmy Moses. Free software under the licence in the repository.</p>
    <p class="muted">Basemaps: © OpenStreetMap contributors; imagery by Esri, Maxar, Earthstar Geographics and the GIS user community.</p>
    <p><a href="${REPO_URL}" target="_blank" rel="noopener">${REPO_URL.replace('https://', '')}</a></p>${backRow}`);
  back(ctx);
}

// ------------------------------------------------------------------ feedback
/** A mailto: link with the app and phone details filled in; nothing is sent until you press send in your mail app. */
export function feedbackMailto(body = '') {
  const info = `\n\n---\nGeoSpaX Field ${__APP_VERSION__}\n${navigator.userAgent}`;
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(`GeoSpaX Field ${__APP_VERSION__} feedback`)}&body=${encodeURIComponent(body + info)}`;
}
function feedbackSheet(ctx: Ctx) {
  ctx.openSheet(`<h2>Send feedback</h2>
    <p class="muted">Your mail app opens with a message to ${FEEDBACK_EMAIL}. Nothing is sent until you press send there.</p>
    <textarea id="fbText" rows="4" placeholder="What happened, or what would help?"></textarea>
    <button type="button" class="wide primary" id="fbMail">✉ Write the email</button>
    <button type="button" class="wide" id="fbIssue">Report on GitHub instead</button>${backRow}`);
  back(ctx);
  const open = async (url: string) => {
    try { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); } catch { window.open(url, '_blank'); }
  };
  $('#fbMail').addEventListener('click', () => void open(feedbackMailto(($('#fbText') as HTMLTextAreaElement).value.trim())));
  $('#fbIssue').addEventListener('click', () => {
    const body = `${($('#fbText') as HTMLTextAreaElement).value.trim()}\n\n---\nGeoSpaX Field ${__APP_VERSION__}`;
    void open(`${ISSUES_URL}?title=${encodeURIComponent('Field app: ')}&body=${encodeURIComponent(body)}`);
  });
}

// ------------------------------------------------------------------ settings sheet
function settingsSheet(ctx: Ctx) {
  const s = settings();
  ctx.openSheet(`<h2>Settings</h2>
    <label class="field">Basemap at start<select id="sBase">${(Object.keys(BASEMAPS) as Basemap[]).map((b) => `<option value="${b}" ${b === s.basemap ? 'selected' : ''}>${BASEMAPS[b].label}</option>`).join('')}</select></label>
    <label class="field">Ask before saving a point worse than<select id="sAcc">${[10, 20, 30, 50, 100, 0].map((m) => `<option value="${m}" ${m === s.warnAcc ? 'selected' : ''}>${m ? `±${m} m` : 'never ask'}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" id="sAwake" ${s.keepAwake ? 'checked' : ''} /> Keep the screen on (uses more battery)</label>
    <label class="check"><input type="checkbox" id="sDem" ${s.dem ? 'checked' : ''} /> Heights from the terrain model when GPS is poor (online: sends your position to Open-Meteo)</label>
    <label class="check"><input type="checkbox" id="sTour" ${s.tourDone ? '' : 'checked'} /> Show the tour at the next start</label>
    ${backRow}`);
  back(ctx);
  $('#sBase').addEventListener('change', (e) => { const b = (e.target as HTMLSelectElement).value as Basemap; saveSettings({ basemap: b }); ctx.setBasemap(b); });
  $('#sAcc').addEventListener('change', (e) => saveSettings({ warnAcc: Number((e.target as HTMLSelectElement).value) }));
  $('#sAwake').addEventListener('change', (e) => { const on = (e.target as HTMLInputElement).checked; saveSettings({ keepAwake: on }); void applyKeepAwake(on); });
  $('#sDem').addEventListener('change', (e) => { const on = (e.target as HTMLInputElement).checked; saveSettings({ dem: on }); ctx.setDem(on); });
  $('#sTour').addEventListener('change', (e) => saveSettings({ tourDone: !(e.target as HTMLInputElement).checked }));
}

// ------------------------------------------------------------------ GPS status
/** Fix type, satellites and DOP, when the fix came from an external receiver. */
export function receiverRows(r: Fix | null): [string, string][] {
  const g = r as GnssFix | null;
  if (!g || !('quality' in g)) return [];
  return [
    ['Receiver fix', `${QUALITY_LABEL[g.quality]} (${fmtAcc(g.acc)})`],
    ['Satellites', g.sats != null ? String(g.sats) : 'not reported'],
    ['HDOP · PDOP', `${g.hdop ?? '-'} · ${g.pdop ?? '-'}`],
    ...(g.age != null ? [['Correction age', `${g.age} s`] as [string, string]] : []),
  ];
}
export function gpsRows(f: Fix | null, raw: ReturnType<Ctx['raw']>, now = Date.now(), hs: Heights | null = null): [string, string][] {
  const r = raw.fix;
  const age = r ? Math.max(0, Math.round((now - r.t) / 1000)) : null;
  const quality = !f ? 'No usable fix yet' : f.acc <= 10 ? 'Good (±10 m or better)' : f.acc <= 30 ? 'Fair (±30 m or better)' : 'Poor';
  return [
    ['Quality', quality],
    ['Accuracy', f ? `±${f.acc.toFixed(1)} m` : '-'],
    ['Latitude', f ? f.lat.toFixed(7) : '-'],
    ['Longitude', f ? f.lon.toFixed(7) : '-'],
    ['Height above sea level', fmtHeight(hs?.best ?? null)],
    ['GPS height', r?.ele != null ? `${r.ele.toFixed(1)} m above the ellipsoid${r.altAcc != null ? ` (±${Math.round(r.altAcc)} m)` : ''}` : 'not reported'],
    [`From ${SOURCE_LABEL.gnss}`, hs?.gnss ? fmtHeight(hs.gnss) : '-'],
    ['From the barometer', hs?.baro ? fmtHeight(hs.baro) : 'no barometer'],
    ['From the terrain model', hs?.dem ? fmtHeight(hs.dem) : 'off (see Settings)'],
    ['Speed', r?.speed != null ? `${(r.speed * 3.6).toFixed(1)} km/h` : 'not reported'],
    ['Heading', r?.heading != null && !Number.isNaN(r.heading) ? `${Math.round(r.heading)}°` : 'not reported'],
    ['Last fix', age == null ? 'none yet' : `${age} s ago`],
    ...receiverRows(r),
    ['Fixes received', String(raw.count)],
    ['Problem', raw.error ?? 'none'],
  ];
}
function gpsSheet(ctx: Ctx) {
  const draw = () => {
    const body = document.getElementById('gpsRows');
    if (!body) return clearInterval(timer);
    body.innerHTML = gpsRows(ctx.fix(), ctx.raw(), Date.now(), ctx.heights()).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('');
  };
  const rx = ctx.receiver();
  ctx.openSheet(`<h2>GPS status</h2><table class="kv"><tbody id="gpsRows"></tbody></table>
    <h3>External receiver</h3>
    ${rx.name ? `<p>Using <b>${esc(rx.name)}</b>. The phone's own GPS is ignored while it sends fixes.</p><button type="button" class="wide" id="rxOff">Disconnect</button>`
      : canBluetooth() ? '<p class="muted">For centimetre work, connect an RTK or survey receiver that sends NMEA over Bluetooth LE (a Nordic UART or HM-10 serial service).</p><button type="button" class="wide" id="rxOn">Connect a Bluetooth receiver</button>'
      : '<p class="muted">This phone app cannot open Bluetooth receivers itself. Pair the receiver in the phone settings, run its app or a Bluetooth GNSS app, and turn on mock location in the developer options: GeoSpaX Field then uses its fixes.</p>'}
    <p id="rxMsg" class="msg" aria-live="polite"></p>
    <p class="muted">Phones do not give apps the satellite count. Accuracy is the phone's own estimate; under trees and near buildings it can be worse than shown. Heights are above mean sea level (EGM2008); the best source is used for saved points.</p>${backRow}`);
  back(ctx);
  document.getElementById('rxOff')?.addEventListener('click', () => { rx.disconnect(); gpsSheet(ctx); });
  document.getElementById('rxOn')?.addEventListener('click', () => {
    $('#rxMsg').textContent = 'Choose the receiver…';
    rx.connect().then(() => gpsSheet(ctx), (e: Error) => { if (document.getElementById('rxMsg')) $('#rxMsg').textContent = e.name === 'NotFoundError' ? 'No receiver chosen.' : e.message; });
  });
  const timer = window.setInterval(draw, 1000);
  draw();
}

// ------------------------------------------------------------------ offline maps
export const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
async function offlineSheet(ctx: Ctx) {
  const stats = await tileStats().catch(() => ({}) as Record<string, { count: number; bytes: number }>);
  const rows = (Object.keys(BASEMAPS) as Basemap[]).map((b) => {
    const host = BASEMAPS[b].tiles.slice('cached://'.length).split('/')[0];
    const s = stats[host] ?? { count: 0, bytes: 0 };
    return `<li><b>${BASEMAPS[b].label}</b><small>${s.count} tiles · ${fmtBytes(s.bytes)}</small><button type="button" class="clr" data-host="${host}" ${s.count ? '' : 'disabled'}>Clear</button></li>`;
  });
  let quota = '';
  try { const e = await navigator.storage?.estimate?.(); if (e?.usage != null && e.quota) quota = `The app uses ${fmtBytes(e.usage)} of ${fmtBytes(e.quota)} available.`; } catch { /* unknown */ }
  ctx.openSheet(`<h2>Offline maps</h2><ul class="list">${rows.join('')}</ul>
    <p class="muted">Every map tile you look at is kept, so before going out of coverage, look over the area at the zooms you need while online. Bulk downloads are not allowed by the map providers' terms. ${quota}</p>${backRow}`);
  back(ctx);
  for (const b of $('#sheetBody').querySelectorAll<HTMLButtonElement>('.clr')) b.addEventListener('click', async () => {
    if (!confirm('Forget these kept map tiles? They download again when you are online.')) return;
    const n = await clearTilesFrom(b.dataset.host!);
    ctx.toast(`${n} tiles cleared`);
    void offlineSheet(ctx);
  });
}

// ------------------------------------------------------------------ backup and export
const b64 = (blob: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
export async function backupJson(recs: Rec[]) {
  const records = await Promise.all(recs.map(async (r) => ({ ...r, photos: await Promise.all(r.photos.map(async (p) => ({ ...p, blob: await b64(p.blob) }))), voice: await Promise.all((r.voice ?? []).map(async (v) => ({ ...v, blob: await b64(v.blob) }))) })));
  return JSON.stringify({ app: 'geospax-field', version: __APP_VERSION__, saved: new Date().toISOString(), records });
}
export async function restoreJson(text: string): Promise<Rec[]> {
  const j = JSON.parse(text);
  if (j?.app !== 'geospax-field' || !Array.isArray(j.records)) throw new Error('not a GeoSpaX Field backup');
  return Promise.all((j.records as (Omit<Rec, 'photos' | 'voice'> & { photos: (Omit<Photo, 'blob'> & { blob: string })[]; voice?: (Omit<Voice, 'blob'> & { blob: string })[] })[]).map(async (r) => ({
    ...r,
    photos: await Promise.all(r.photos.map(async (p) => ({ ...p, blob: await (await fetch(p.blob)).blob() }))),
    voice: await Promise.all((r.voice ?? []).map(async (v) => ({ ...v, blob: await (await fetch(v.blob)).blob() }))),
  })));
}
export function toGeoJson(recs: Rec[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: recs.map((r) => {
      const xy = r.coords.map((v) => (v[2] != null ? [v[0], v[1], v[2]] : [v[0], v[1]]));
      const geometry: GeoJSON.Geometry = r.kind === 'point' || xy.length === 1 ? { type: 'Point', coordinates: xy[0] } : r.kind === 'area' && xy.length > 2 ? { type: 'Polygon', coordinates: [[...xy, xy[0]]] } : { type: 'LineString', coordinates: xy };
      return { type: 'Feature', id: r.id, geometry, properties: { ...r.attrs, form: r.form ?? null, kind: r.kind, note: r.note, created: new Date(r.created).toISOString(), accuracy_m: r.coords[0]?.[4] ?? null, height_m: r.height?.value ?? null, height_source: r.height?.source ?? null, height_acc_m: r.height?.acc ?? null, photos: r.photos.map((p) => p.name).join(';') || null, photo_bearings: r.photos.some((p) => p.bearing != null) ? r.photos.map((p) => (p.bearing != null ? Math.round(p.bearing) : '')).join(';') : null, voice_notes: r.voice?.map((v) => v.name).join(';') || null, sent: r.sent } };
    }),
  };
}
async function hand(name: string, text: string, type: string) {
  const file = new File([text], name, { type });
  const nav = navigator as Navigator & { canShare?(d: { files: File[] }): boolean };
  if (nav.canShare?.({ files: [file] })) { try { await nav.share({ files: [file], title: name }); return; } catch { /* cancelled: fall through to a download */ } }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function backupSheet(ctx: Ctx) {
  const recs = await allRecords();
  const photos = recs.reduce((n, r) => n + r.photos.length, 0);
  const stamp = new Date().toISOString().slice(0, 10);
  ctx.openSheet(`<h2>Backup and export</h2>
    <p class="muted">${recs.length} record${recs.length === 1 ? '' : 's'} and ${photos} photo${photos === 1 ? '' : 's'} on this phone.</p>
    <button type="button" class="wide primary" id="bkSave">💾 Full backup (records, photos and voice notes)</button>
    <button type="button" class="wide" id="bkGeo">Export as GeoJSON (for QGIS or GeoSpaX)</button>
    <button type="button" class="wide" id="bkLoad">Restore a backup</button>
    <input type="file" id="bkFile" accept=".json,application/json" hidden />
    <p class="muted">Restoring adds the backup's records; records already on the phone are kept.</p>
    <p id="bkMsg" class="msg" aria-live="polite"></p>${backRow}`);
  back(ctx);
  const msg = $('#bkMsg');
  $('#bkSave').addEventListener('click', async () => { msg.textContent = 'Preparing…'; await hand(`geospax-field-backup-${stamp}.json`, await backupJson(recs), 'application/json'); msg.textContent = ''; });
  $('#bkGeo').addEventListener('click', () => void hand(`geospax-field-${stamp}.geojson`, JSON.stringify(toGeoJson(recs)), 'application/geo+json'));
  $('#bkLoad').addEventListener('click', () => ($('#bkFile') as HTMLInputElement).click());
  $('#bkFile').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const have = new Set((await allRecords()).map((r) => r.id));
      const got = (await restoreJson(await f.text())).filter((r) => !have.has(r.id));
      for (const r of got) await putRecord(r);
      await ctx.refresh();
      msg.textContent = `Restored ${got.length} record${got.length === 1 ? '' : 's'}.`;
    } catch (err) { msg.textContent = `Not restored: ${(err as Error).message}.`; }
  });
}

// ------------------------------------------------------------------ first-run tour
export const TOUR: { sel: string; title: string; text: string }[] = [
  { sel: '#gps', title: 'Your GPS', text: 'Green means ±10 m or better. Tap it for the full GPS status.' },
  { sel: '#btnPoint', title: 'Record', text: 'Points, lines, areas, tracks and photos. Everything is saved on the phone straight away, signal or not.' },
  { sel: '#btnList', title: 'Your records', text: 'See, find and delete what you have recorded.' },
  { sel: '#sendBtn', title: 'Send to GeoSpaX', text: 'Pair with GeoSpaX on your computer over Wi-Fi and send your records to make the map.' },
  { sel: '#more', title: 'More', text: 'Offline maps, backup, settings, help and feedback are here. That is all: happy fieldwork!' },
];
export function startTour(step = 0) {
  document.getElementById('tour')?.remove();
  const s = TOUR[step];
  if (!s) { saveSettings({ tourDone: true }); return; }
  const el = document.querySelector<HTMLElement>(s.sel);
  const r = el?.getBoundingClientRect();
  const box = document.createElement('div');
  box.id = 'tour';
  box.className = 'tour';
  box.innerHTML = `${r ? `<div class="tour-ring" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>` : ''}
    <div class="tour-card ${r && r.top < innerHeight / 2 ? 'low' : 'high'}" role="dialog" aria-label="Tour">
      <small>${step + 1} of ${TOUR.length}</small><h3>${s.title}</h3><p>${s.text}</p>
      <div class="row"><button type="button" id="tourSkip">Skip</button>${step ? '<button type="button" id="tourBack">Back</button>' : ''}<button type="button" class="primary" id="tourNext">${step === TOUR.length - 1 ? 'Done' : 'Next'}</button></div>
    </div>`;
  document.body.append(box);
  $('#tourNext').addEventListener('click', () => startTour(step + 1));
  document.getElementById('tourBack')?.addEventListener('click', () => startTour(step - 1));
  $('#tourSkip').addEventListener('click', () => { box.remove(); saveSettings({ tourDone: true }); });
}

// ------------------------------------------------------------------ wiring
const SEEN = 'geospax-field.seen-version';
export function installBasics(ctx: Ctx) {
  $('#more').addEventListener('click', () => menuSheet(ctx));
  $('#gps').addEventListener('click', () => gpsSheet(ctx));
  const s = settings();
  void applyKeepAwake(s.keepAwake);
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN); localStorage.setItem(SEEN, __APP_VERSION__); } catch { /* ignore */ }
  // the tour on a first start; What's new once after an update
  if (!s.tourDone) setTimeout(() => startTour(), 800);
  else if (seen && seen !== __APP_VERSION__) setTimeout(() => newsSheet(ctx), 800);
}
