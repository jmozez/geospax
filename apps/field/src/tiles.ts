// Basemap tiles through a "cached://" protocol: a tile seen once is kept on the phone, so the map still shows
// where you have looked before when there is no signal. Only tiles that were actually on screen are stored
// (the tile servers' terms forbid bulk downloading), so look over the area once while online.
import * as maplibregl from 'maplibre-gl';
import { getTile, putTile } from './db';

export const BASEMAPS = {
  map: {
    label: 'Map',
    tiles: 'cached://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
  imagery: {
    label: 'Imagery',
    tiles: 'cached://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, Maxar, Earthstar Geographics and the GIS user community',
    maxzoom: 19,
  },
} as const;
export type Basemap = keyof typeof BASEMAPS;

export function installTileCache() {
  maplibregl.addProtocol('cached', async (params, abort) => {
    const key = params.url.slice('cached://'.length);
    const kept = await getTile(key).catch(() => undefined);
    if (kept) return { data: kept };
    const res = await fetch(`https://${key}`, { signal: abort.signal });
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const data = await res.arrayBuffer();
    void putTile(key, data).catch(() => {});
    return { data };
  });
}
