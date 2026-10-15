// One frontend, two editions. The UI only talks to `Backend`; the transport
// underneath is HTTP (web edition, Axum) or Tauri (desktop edition: custom
// URI scheme, or `invoke` with a raw binary response).
import * as maplibregl from 'maplibre-gl';
import { invoke } from '@tauri-apps/api/core';

export type GeomKind = 'point' | 'line' | 'polygon' | 'unknown';

export interface FieldInfo {
  name: string;
  kind: 'integer' | 'real' | 'string' | 'datetime' | 'other';
}

export interface Job {
  id: number;
  kind: string;
  layer: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  progress: number;
  message: string;
  elapsed_ms: number;
  result: unknown;
}

export interface OverviewMeta {
  max_zoom: number;
  tiles: number;
  bytes: number;
  built_at: number;
  path: string;
  /** per zoom: p90 of the densest 4 px cell's feature count (heatmap normalisation) */
  density_p90: number[];
}

export interface LayerInfo {
  id: string;
  name: string;
  source: string;
  driver: string;
  geometry: GeomKind;
  feature_count: number;
  bounds: [number, number, number, number];
  crs: string;
  fields: FieldInfo[];
  tile_fields: string[];
  /** effective minzoom (0 once an overview pyramid exists) */
  minzoom: number;
  /** zoom from which tiles are rendered live from the source */
  live_minzoom: number;
  maxzoom: number;
  overview: OverviewMeta | null;
  overview_suggested: number | null;
  overview_job: Job | null;
}

export type Transport = 'http' | 'scheme' | 'invoke';

export interface EngineStats {
  workers: number;
  reader: string;
  gpkg_filtered: string;
  gdal: string;
  tiles_served: number;
  overview_tiles: number;
  cache_hits: number;
  tiles_rendered: number;
  empty_tiles: number;
  bytes_served: number;
  features_encoded: number;
  render_ms_mean: number;
  render_ms_p50: number;
  render_ms_p95: number;
}

export interface Backend {
  readonly edition: 'web' | 'desktop';
  readonly transports: Transport[];
  transport: Transport;
  /** MapLibre tile URL template for a layer (optionally with extra attributes). */
  tileUrl(layerId: string, fields?: string[]): string;
  json<T>(path: string, init?: RequestInit): Promise<T>;
  binary(path: string): Promise<{ bytes: ArrayBuffer; headers: Headers }>;
  /** Absolute URL for an engine path (images such as raster overlays). */
  url(path: string): string;
}

/** Client-side samples for transports where the main thread sees each request. */
export const clientTileTimings: number[] = [];

const fieldsQuery = (fields?: string[]) => (fields && fields.length ? `?fields=${fields.map(encodeURIComponent).join(',')}` : '');

/** JSON request; engine errors ({"error": ...}) become exceptions with that message. */
async function jsonFetch<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(base + path, init);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(`${path}: ${msg}`);
  }
  return (await r.json()) as T;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const isWindows = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);

class HttpBackend implements Backend {
  readonly edition = 'web' as const;
  readonly transports: Transport[] = ['http'];
  transport: Transport = 'http';
  // Absolute base so URLs also resolve inside MapLibre's web workers.
  private base = new URL('.', document.baseURI).href;
  tileUrl(id: string, fields?: string[]) {
    return `${this.base}tiles/${id}/{z}/{x}/{y}.mvt${fieldsQuery(fields)}`;
  }
  async json<T>(path: string, init?: RequestInit) {
    return jsonFetch<T>(this.base, path, init);
  }
  url(path: string) {
    return this.base + path.replace(/^\//, '');
  }
  async binary(path: string) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
    return { bytes: await r.arrayBuffer(), headers: r.headers };
  }
}

class TauriBackend implements Backend {
  readonly edition = 'desktop' as const;
  readonly transports: Transport[] = ['scheme', 'invoke'];
  transport: Transport = 'scheme';
  // Tauri serves custom schemes as gis://localhost/ (macOS/Linux) and
  // http://gis.localhost/ (Windows/Android).
  private base = isWindows ? 'http://gis.localhost/' : 'gis://localhost/';

  constructor() {
    // `invoke` transport: MapLibre hands the request to the main thread,
    // which calls the Rust `tile` command and gets raw bytes back (no JSON).
    maplibregl.addProtocol('gisinvoke', async (params) => {
      const m = /^gisinvoke:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\?fields=([^&]*))?/.exec(params.url);
      if (!m) throw new Error(`bad url ${params.url}`);
      const t0 = performance.now();
      const fields = m[5] ? decodeURIComponent(m[5]) : null;
      const data = await invoke<ArrayBuffer>('tile', { layer: m[1], z: +m[2], x: +m[3], y: +m[4], fields });
      clientTileTimings.push(performance.now() - t0);
      if (clientTileTimings.length > 2000) clientTileTimings.splice(0, 1000);
      return { data };
    });
  }
  tileUrl(id: string, fields?: string[]) {
    const q = fieldsQuery(fields);
    return this.transport === 'invoke' ? `gisinvoke://${id}/{z}/{x}/{y}${q}` : `${this.base}tiles/${id}/{z}/{x}/{y}.mvt${q}`;
  }
  async json<T>(path: string, init?: RequestInit) {
    return jsonFetch<T>(this.base, path, init);
  }
  url(path: string) {
    return this.base + path.replace(/^\//, '');
  }
  async binary(path: string) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return { bytes: await r.arrayBuffer(), headers: r.headers };
  }
}

export function createBackend(): Backend {
  return isTauri ? new TauriBackend() : new HttpBackend();
}
