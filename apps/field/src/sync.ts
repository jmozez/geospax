// Send records to GeoSpaX through its phone link (Devices › Phone link): the same address and code as the QR
// code there (https://<computer>:8765/#t=<code>). Points, lines and areas go as one GeoJSON file, each track
// as GPX and each photo with its position; GeoSpaX maps them with its matching recipe once the batch is in.
import { inApp } from './geo';
import type { Rec, Vertex } from './db';

export interface Link {
  base: string;
  token: string;
}

const KEY = 'geospax-field.link';

export function parseLink(text: string): Link | null {
  try {
    const u = new URL(text.trim());
    const token = new URLSearchParams(u.hash.slice(1)).get('t') ?? u.searchParams.get('t');
    if (!token || !/^https?:$/.test(u.protocol)) return null;
    return { base: `${u.protocol}//${u.host}`, token };
  } catch {
    return null;
  }
}

export function savedLink(): Link | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}
export function saveLink(l: Link | null) {
  try {
    if (l) localStorage.setItem(KEY, JSON.stringify(l));
    else localStorage.removeItem(KEY);
  } catch { /* private mode */ }
}

/** Pair by scanning the QR code shown in GeoSpaX (phones only). */
export async function scanLink(): Promise<Link | null> {
  if (!inApp) return null;
  const { scan, Format } = await import('@tauri-apps/plugin-barcode-scanner');
  const r = await scan({ windowed: false, formats: [Format.QRCode] });
  return parseLink(r.content);
}

// The phone link uses a self-signed certificate on the local network: in the app, the HTTP plugin accepts it
// for that address only; in a browser the user has opened the address once and accepted it.
async function request(url: string, init: RequestInit): Promise<Response> {
  if (inApp) {
    const { fetch } = await import('@tauri-apps/plugin-http');
    return fetch(url, { ...init, danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true } } as RequestInit);
  }
  return fetch(url, init);
}

async function json(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `GeoSpaX answered ${res.status}`);
  return body;
}

export async function hello(l: Link): Promise<{ computer: string; version: string }> {
  return json(await request(`${l.base}/api/phone/hello?t=${encodeURIComponent(l.token)}`, { method: 'GET' }));
}

const iso = (t: number) => new Date(t).toISOString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function geometry(r: Rec) {
  const xy = (v: Vertex) => [v[0], v[1]];
  if (r.kind === 'point') return { type: 'Point', coordinates: xy(r.coords[0]) };
  if (r.kind === 'area') return { type: 'Polygon', coordinates: [[...r.coords.map(xy), xy(r.coords[0])]] };
  return { type: 'LineString', coordinates: r.coords.map(xy) };
}

export function geojson(recs: Rec[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: recs.map((r) => ({
      type: 'Feature',
      geometry: geometry(r),
      properties: {
        kind: r.kind,
        note: r.note,
        recorded: iso(r.created),
        accuracy_m: r.coords[0]?.[4] ?? null,
        photos: r.photos.map((p) => p.name).join(';') || null,
        photo_bearings: r.photos.some((p) => p.bearing != null) ? r.photos.map((p) => (p.bearing != null ? Math.round(p.bearing) : '')).join(';') : null,
        voice_notes: r.voice?.map((v) => v.name).join(';') || null,
      },
    })),
  });
}

export function gpx(r: Rec): string {
  const pts = r.coords
    .map((v) => `<trkpt lat="${v[1]}" lon="${v[0]}">${v[2] != null ? `<ele>${v[2].toFixed(1)}</ele>` : ''}<time>${iso(v[3])}</time></trkpt>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GeoSpaX Field" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(r.note || `Track ${iso(r.created)}`)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

/** Upload the records as one batch; resolves with the number of files GeoSpaX received. */
export async function send(l: Link, recs: Rec[], progress: (done: number, total: number) => void): Promise<number> {
  const batch = `field-${Date.now().toString(36)}`;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const files: { name: string; body: Blob; extra?: Record<string, string> }[] = [];
  const shapes = recs.filter((r) => r.kind !== 'track' && r.coords.length);
  if (shapes.length) files.push({ name: `field-${stamp}.geojson`, body: new Blob([geojson(shapes)], { type: 'application/geo+json' }) });
  for (const r of recs.filter((r) => r.kind === 'track' && r.coords.length > 1)) {
    files.push({ name: `track-${new Date(r.created).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.gpx`, body: new Blob([gpx(r)], { type: 'application/gpx+xml' }) });
  }
  for (const r of recs) {
    for (const p of r.photos) {
      const extra: Record<string, string> = { ts: String(p.ts) };
      if (p.lat != null && p.lon != null) Object.assign(extra, { lat: String(p.lat), lon: String(p.lon) });
      if (p.acc != null) extra.acc = String(p.acc);
      if (p.bearing != null) extra.dir = p.bearing.toFixed(1);
      files.push({ name: p.name, body: p.blob, extra });
    }
    for (const v of r.voice ?? []) files.push({ name: v.name, body: v.blob, extra: { ts: String(v.ts) } });
  }
  let done = 0;
  progress(0, files.length);
  for (const f of files) {
    const q = new URLSearchParams({ t: l.token, batch, name: f.name, ...(f.extra ?? {}) });
    await json(await request(`${l.base}/api/phone/upload?${q}`, { method: 'POST', body: f.body }));
    progress(++done, files.length);
  }
  if (files.length) await json(await request(`${l.base}/api/phone/commit?${new URLSearchParams({ t: l.token, batch })}`, { method: 'POST', body: '{}' }));
  return files.length;
}
