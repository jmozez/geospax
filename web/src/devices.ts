// Devices section (docs/DEVICES.md): connected phones, GPS units, drones, cameras and watched
// folders found by the engine's device hub, sensor loggers and FIT watches, one-click
// "Import & map", live GNSS positions, and live sensors (HTTP pushes, MQTT feeds).
import type { Backend, Job } from './backend';

export interface DeviceInfo {
  id: string;
  name: string;
  kind: 'phone' | 'camera' | 'drone' | 'gps' | 'sensor' | 'lidar' | 'folder';
  root: string;
  connected: boolean;
  photos_geotagged: number | null;
  photos_total: number | null;
  tracks: number | null;
  waypoints: number | null;
  readings?: number | null;
  reading_fields?: string[] | null;
  point_clouds?: number | null;
  cloud_points?: number | null;
  bounds: [number, number, number, number] | null;
  imported: { layers: string[] } | null;
  error: string | null;
}

interface LiveInfo {
  id: string;
  name: string;
  source: string;
  kind?: string;
  fixes: number;
  readings?: number;
  values?: Record<string, number>;
  age_s: number;
}

interface MqttInfo {
  url: string;
  connected: boolean;
  messages: number;
  error: string | null;
}

interface StaInfo {
  url: string;
  things: number;
  polls: number;
  readings: number;
  last_poll: string | null;
  error: string | null;
}

interface DevicesState {
  devices: DeviceInfo[];
  live: LiveInfo[];
  auto_import: boolean;
  mqtt?: MqttInfo[];
  sta?: StaInfo[];
}

export type LiveGeoJSON = { type: 'FeatureCollection'; features: unknown[] };

const ICON: Record<string, string> = { phone: '📱', camera: '📷', drone: '🛩️', gps: '🛰️', sensor: '🌡️', lidar: '⛰️', folder: '📁' };
const num = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : String(Math.round(v * 10) / 10));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pointCount = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion points` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million points` : plural(n, 'point'));

export class DevicesPane {
  private state: DevicesState = { devices: [], live: [], auto_import: false };
  private busy = new Map<string, Job>();
  private liveTimer: number | undefined;

  constructor(
    private el: HTMLElement,
    private backend: Backend,
    private hooks: {
      onImported: (layerIds: string[], bounds: DeviceInfo['bounds']) => Promise<void>;
      onLive: (data: LiveGeoJSON) => void;
      onAutoImported: () => Promise<void>;
    },
  ) {
    el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button[data-import]') as HTMLButtonElement | null;
      if (b) void this.importDevice(b.dataset.import!);
    });
  }

  start() {
    const tick = async () => {
      await this.refresh().catch(() => {});
      setTimeout(tick, 5000);
    };
    void tick();
  }

  private async refresh() {
    const before = new Set(this.state.devices.flatMap((d) => d.imported?.layers ?? []));
    this.state = await this.backend.json<DevicesState>('api/devices');
    // Layers imported by a trigger (auto-import / folder change) appear without a click.
    const after = this.state.devices.flatMap((d) => d.imported?.layers ?? []);
    if (after.some((id) => !before.has(id)) && before.size + after.length > 0 && this.busy.size === 0) await this.hooks.onAutoImported();
    this.render();
    if (this.state.live.length && this.liveTimer === undefined) this.pollLive();
  }

  private pollLive() {
    const tick = async () => {
      try {
        this.hooks.onLive(await this.backend.json<LiveGeoJSON>('api/devices/live'));
      } catch {
        /* keep polling */
      }
      this.liveTimer = window.setTimeout(tick, 2000);
    };
    void tick();
  }

  private async importDevice(id: string) {
    const dev = this.state.devices.find((d) => d.id === id);
    const job = await this.backend.json<Job>(`api/devices/${id}/import`, { method: 'POST' });
    this.busy.set(id, job);
    this.render();
    const poll = async (): Promise<Job> => {
      const j = await this.backend.json<Job>(`api/jobs/${job.id}`);
      if (j.status === 'queued' || j.status === 'running') {
        await new Promise((r) => setTimeout(r, 500));
        return poll();
      }
      return j;
    };
    const done = await poll();
    this.busy.delete(id);
    document.body.dataset.deviceImport = done.status;
    const layers = ((done as unknown as { result?: { layers?: string[] } }).result?.layers) ?? [];
    await this.refresh();
    if (done.status === 'done') await this.hooks.onImported(layers, dev?.bounds ?? null);
  }

  private render() {
    const { devices, live } = this.state;
    if (!devices.length && !live.length) {
      this.el.innerHTML = '<p class="muted">No devices yet. Plug in a phone, GPS unit, drone SD card, camera, sensor logger or a drive with LiDAR point clouds.</p>';
      return;
    }
    const rows = devices.map((d) => {
      const photos = d.photos_geotagged ?? 0;
      const parts = [
        photos ? plural(photos, 'geotagged photo') : '',
        d.tracks ? plural(d.tracks, 'track') : '',
        d.waypoints ? plural(d.waypoints, 'waypoint') : '',
        d.readings ? `${plural(d.readings, 'sensor reading')}${d.reading_fields?.length ? ` (${d.reading_fields.slice(0, 4).join(', ')})` : ''}` : '',
        d.point_clouds ? `${plural(d.point_clouds, 'point cloud')} (${pointCount(d.cloud_points ?? 0)})` : '',
      ].filter(Boolean);
      const has = parts.length > 0;
      const job = this.busy.get(d.id);
      const action = job
        ? '<span class="badge run">importing…</span>'
        : has
          ? `<button data-import="${esc(d.id)}" class="${d.imported ? 'ghost' : ''}">${d.imported ? 'Re-import' : 'Import &amp; map'}</button>`
          : '';
      return `<div class="device ${d.connected ? '' : 'gone'}" data-device="${esc(d.id)}">
        <div class="dev-head"><span class="dev-icon" aria-hidden="true">${ICON[d.kind] ?? '📁'}</span>
          <b>${esc(d.name)}</b><span class="muted">${esc(d.kind)}${d.connected ? '' : ' · disconnected'}</span></div>
        <div class="dev-meta">${has ? esc(parts.join(' · ')) : 'no geodata found'}${d.photos_total && d.photos_total > photos ? ` <span class="muted">(${d.photos_total - photos} without GPS)</span>` : ''}</div>
        ${d.imported ? `<div class="dev-meta ok">✓ on the map: ${esc(d.imported.layers.length)} layers</div>` : ''}
        ${d.error ? `<div class="dev-meta err">${esc(d.error)}</div>` : ''}
        <div class="dev-actions">${action}</div></div>`;
    });
    const liveRows = live.map((l) => {
      const sensor = l.kind === 'sensor';
      const counts = sensor ? plural(l.readings ?? 0, 'reading') : plural(l.fixes, 'fix');
      const values = Object.entries(l.values ?? {})
        .slice(0, 4)
        .map(([k, v]) => `${esc(k)} <b>${esc(num(v))}</b>`)
        .join(' · ');
      return `<div class="device live" data-live="${esc(l.id)}"><div class="dev-head"><span class="dev-icon" aria-hidden="true">${sensor ? '🌡️' : '📍'}</span>
        <b>${esc(l.name)}</b><span class="muted">live ${esc(l.source)} · ${esc(counts)} · ${l.age_s < 10 ? 'now' : `${Math.round(l.age_s)} s ago`}</span></div>
        ${values ? `<div class="dev-meta">${values}</div>` : ''}</div>`;
    });
    const mqtt = (this.state.mqtt ?? [])
      .map((m) => `<p class="muted">MQTT ${esc(m.url)}: ${m.connected ? `connected · ${esc(plural(m.messages, 'message'))}` : esc(m.error ?? 'connecting…')}</p>`)
      .join('');
    const sta = (this.state.sta ?? [])
      .map((s) => {
        const state = s.error
          ? esc(s.error)
          : s.polls
            ? `${esc(plural(s.things, 'station'))} · ${esc(plural(s.readings, 'update'))} · polled ${esc((s.last_poll ?? '').slice(11, 16))} UTC`
            : 'first poll…';
        return `<p class="muted" data-sta="${esc(s.url)}">SensorThings ${esc(s.url)}: ${state}</p>`;
      })
      .join('');
    const auto = this.state.auto_import ? '<p class="muted">Auto-import is on: new devices are mapped automatically.</p>' : '';
    this.el.innerHTML = rows.join('') + liveRows.join('') + mqtt + sta + auto;
  }
}
