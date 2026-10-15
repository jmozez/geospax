// Scripted camera tour: FPS while moving + "settle" time (moveend -> idle,
// i.e. until every visible tile is fetched, decoded and drawn). Same script
// on web and desktop, so results compare editions and transports directly.
import type * as maplibregl from 'maplibre-gl';
import type { Backend, EngineStats } from './backend';

export interface StopResult {
  name: string;
  zoom: number;
  fps_avg: number;
  fps_min: number;
  move_ms: number;
  settle_ms: number;
  tiles_rendered: number;
  render_ms_mean: number;
}

export interface BenchReport {
  kind: 'tour';
  edition: string;
  transport: string;
  user_agent: string;
  device_pixel_ratio: number;
  viewport: [number, number];
  started_at: string;
  stops: StopResult[];
  summary: { fps_avg: number; settle_p95_ms: number; settle_mean_ms: number; tiles_rendered: number; engine_p95_ms: number };
}

const STOPS: { name: string; center: [number, number]; zoom: number }[] = [
  { name: 'world', center: [30, 10], zoom: 1.6 },
  { name: 'PNG', center: [146, -6.5], zoom: 6 },
  { name: 'highlands', center: [144.6, -5.95], zoom: 11 },
  { name: 'Mt Hagen', center: [144.23, -5.86], zoom: 13 },
  { name: 'Mt Hagen close', center: [144.235, -5.862], zoom: 15.5 },
  { name: 'pan east', center: [144.3, -5.86], zoom: 14 },
  { name: 'pan south', center: [144.3, -5.93], zoom: 14 },
  { name: 'Goroka', center: [145.39, -6.08], zoom: 13 },
  { name: 'zoom out', center: [144.8, -6.0], zoom: 9 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function idle(map: maplibregl.Map, timeout = 30000) {
  if (map.loaded() && map.areTilesLoaded()) return;
  await Promise.race([new Promise<void>((r) => map.once('idle', () => r())), sleep(timeout)]);
}

export async function runBenchmark(map: maplibregl.Map, backend: Backend): Promise<BenchReport> {
  const stops: StopResult[] = [];
  await idle(map);
  for (const s of STOPS) {
    const before = await backend.json<EngineStats>('api/stats');
    const frameTimes: number[] = [];
    let moving = true;
    const onFrame = (t: number) => {
      frameTimes.push(t);
      if (moving) requestAnimationFrame(onFrame);
    };
    const t0 = performance.now();
    const moveEnd = new Promise<void>((r) => map.once('moveend', () => r()));
    requestAnimationFrame(onFrame);
    map.flyTo({ center: s.center, zoom: s.zoom, duration: 2000, essential: true });
    await moveEnd;
    moving = false;
    const t1 = performance.now();
    await idle(map);
    const t2 = performance.now();
    const after = await backend.json<EngineStats>('api/stats');

    // FPS: overall average plus the worst 250 ms window during the flight.
    const dur = (frameTimes.at(-1)! - frameTimes[0]) / 1000 || 1;
    const fpsAvg = (frameTimes.length - 1) / dur;
    let fpsMin = Infinity;
    for (let i = 0, j = 0; i < frameTimes.length; i++) {
      while (frameTimes[i] - frameTimes[j] > 250) j++;
      if (frameTimes[i] - frameTimes[0] >= 250) fpsMin = Math.min(fpsMin, ((i - j) * 1000) / 250);
    }
    const rendered = after.tiles_rendered - before.tiles_rendered;
    const renderMs =
      rendered > 0 ? (after.render_ms_mean * after.tiles_rendered - before.render_ms_mean * before.tiles_rendered) / rendered : 0;
    stops.push({
      name: s.name,
      zoom: s.zoom,
      fps_avg: fpsAvg,
      fps_min: Number.isFinite(fpsMin) ? fpsMin : fpsAvg,
      move_ms: t1 - t0,
      settle_ms: t2 - t1,
      tiles_rendered: rendered,
      render_ms_mean: renderMs,
    });
    await sleep(300);
  }
  const final = await backend.json<EngineStats>('api/stats');
  const settles = stops.map((s) => s.settle_ms).sort((a, b) => a - b);
  return {
    kind: 'tour',
    edition: backend.edition,
    transport: backend.transport,
    user_agent: navigator.userAgent,
    device_pixel_ratio: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    started_at: new Date().toISOString(),
    stops,
    summary: {
      fps_avg: stops.reduce((a, s) => a + s.fps_avg, 0) / stops.length,
      settle_p95_ms: settles[Math.round((settles.length - 1) * 0.95)],
      settle_mean_ms: settles.reduce((a, b) => a + b, 0) / settles.length,
      tiles_rendered: stops.reduce((a, s) => a + s.tiles_rendered, 0),
      engine_p95_ms: final.render_ms_p95,
    },
  };
}
