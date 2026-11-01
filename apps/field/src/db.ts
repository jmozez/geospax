// Everything recorded stays on the phone (IndexedDB) until it has been sent: no signal needed.
// Map tiles that were on screen are kept too, so the map works offline where you have looked before.

import type { Voice } from './capture';
import type { Height } from './elevation';

export type Kind = 'point' | 'line' | 'area' | 'track';
/** [lon, lat, height above sea level m (EGM2008) or null, time ms, accuracy m or null] */
export type Vertex = [number, number, number | null, number, number | null];

export interface Photo {
  id: string;
  name: string;
  blob: Blob;
  lon: number | null;
  lat: number | null;
  acc: number | null;
  ts: number;
  /** where the camera faced: compass bearing in degrees from magnetic north (null without a compass) */
  bearing?: number | null;
}

export interface Rec {
  id: string;
  kind: Kind;
  coords: Vertex[];
  note: string;
  created: number;
  sent: boolean;
  photos: Photo[];
  /** the height of a point and where it came from (GPS and geoid, barometer or terrain model) */
  height?: Height | null;
  /** voice notes recorded with it */
  voice?: Voice[];
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('geospax-field', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('records', { keyPath: 'id' });
      r.result.createObjectStore('tiles');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = f(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const allRecords = () => tx<Rec[]>('records', 'readonly', (s) => s.getAll() as IDBRequest<Rec[]>).then((r) => r.sort((a, b) => b.created - a.created));
export const putRecord = (r: Rec) => tx('records', 'readwrite', (s) => s.put(r));
export const deleteRecord = (id: string) => tx('records', 'readwrite', (s) => s.delete(id));
export const getTile = (key: string) => tx<ArrayBuffer | undefined>('tiles', 'readonly', (s) => s.get(key));
export const putTile = (key: string, data: ArrayBuffer) => tx('tiles', 'readwrite', (s) => s.put(data, key));
export const countTiles = () => tx<number>('tiles', 'readonly', (s) => s.count());
export const clearTiles = () => tx('tiles', 'readwrite', (s) => s.clear());

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Kept basemap tiles per server, with their size in bytes, for the offline maps manager. */
export async function tileStats(): Promise<Record<string, { count: number; bytes: number }>> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out: Record<string, { count: number; bytes: number }> = {};
    const req = d.transaction('tiles', 'readonly').objectStore('tiles').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      const host = String(c.key).split('/')[0];
      const s = (out[host] ??= { count: 0, bytes: 0 });
      s.count++;
      s.bytes += (c.value as ArrayBuffer)?.byteLength ?? 0;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Forget the kept tiles of one server (its host name, as in the tile key). */
export async function clearTilesFrom(host: string): Promise<number> {
  const d = await db();
  return new Promise((resolve, reject) => {
    let n = 0;
    const req = d.transaction('tiles', 'readwrite').objectStore('tiles').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(n);
      if (String(c.key).split('/')[0] === host) { c.delete(); n++; }
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
