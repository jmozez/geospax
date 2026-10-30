// Shared by shoot.mjs: the seeded GeoSpaX server (GS_URL, default http://127.0.0.1:18300) and a small JSON API helper.
export const base = (process.env.GS_URL || 'http://127.0.0.1:18300').replace(/\/$/, '');
export async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
