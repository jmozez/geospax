// GPU points (View › GPU points, off by default): draw a large point layer with deck.gl from the
// engine's Arrow stream (`GET api/layers/{id}/arrow`, a zero-copy Float64 position buffer) instead
// of vector tiles. Millions of points stay smooth on modest laptops; MapLibre keeps the base map
// and every other layer. deck.gl draws with WebGL2 here; its WebGPU device is not used yet.
// Toggle per layer; switching off gives the layer back to MapLibre.
import { Deck, MapView } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { tableFromIPC } from 'apache-arrow';
import type { CommandHost } from './commands';

const MAX = 20_000_000;
const on = new Map<string, ScatterplotLayer>();
let deck: Deck<MapView> | null = null;

function ensure(h: CommandHost): Deck<MapView> {
  if (deck) return deck;
  const map = h.map;
  const canvas = document.createElement('canvas');
  canvas.id = 'gpu-points-canvas';
  canvas.className = 'gpu-points';
  map.getCanvasContainer().after(canvas);
  const vs = () => {
    const c = map.getCenter();
    return { longitude: c.lng, latitude: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  };
  const d = new Deck({ canvas, views: new MapView({ repeat: true }), viewState: vs(), controller: false, layers: [] });
  map.on('move', () => d.setProps({ viewState: vs() }));
  map.on('resize', () => d.setProps({ viewState: vs() }));
  // a restyle (basemap change, reload) brings MapLibre's copy back: hide it again
  map.on('styledata', () => on.forEach((_, id) => hide(h, id, true)));
  deck = d;
  return d;
}

function hide(h: CommandHost, id: string, hidden: boolean) {
  const style = h.map.getStyle();
  for (const l of style?.layers ?? []) {
    if ((l as { source?: string }).source === id) {
      const want = hidden ? 'none' : 'visible';
      if (h.map.getLayoutProperty(l.id, 'visibility') !== want) h.map.setLayoutProperty(l.id, 'visibility', want);
    }
  }
}

function colour(h: CommandHost, id: string): [number, number, number, number] {
  const l = h.map.getStyle()?.layers?.find((x) => (x as { source?: string }).source === id && x.type === 'circle');
  const c = l ? h.map.getPaintProperty(l.id, 'circle-color') : null;
  const m = typeof c === 'string' ? /^#([0-9a-f]{6})$/i.exec(c) : null;
  if (!m) return [46, 196, 182, 200];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 210];
}

function redraw() {
  deck?.setProps({ layers: [...on.values()] });
}

/** Toggle GPU drawing for the active point layer. */
export async function toggleGpuPoints(h: CommandHost): Promise<void> {
  const id = h.activeId();
  const info = h.layers().find((l) => l.id === id);
  if (!id || !info) return h.setStatus('Select a point layer in Contents first', 4000);
  if (on.has(id)) {
    on.delete(id);
    redraw();
    hide(h, id, false);
    return h.setStatus(`${info.name ?? id}: back to vector tiles`, 3000);
  }
  if (info.geometry !== 'point') return h.setStatus('GPU points works on point layers only', 4000);
  h.setStatus(`Loading ${info.feature_count.toLocaleString()} points for the GPU…`);
  const t0 = performance.now();
  try {
    const { bytes } = await h.backend.binary(`api/layers/${encodeURIComponent(id)}/arrow?limit=${MAX}`);
    const table = tableFromIPC(new Uint8Array(bytes));
    const child = table.getChild('geometry')!.data[0].children[0];
    const coords = (child.values as Float64Array).subarray(child.offset, child.offset + child.length);
    const n = coords.length / 2;
    const d = ensure(h);
    on.set(id, new ScatterplotLayer({
      id: `gpu-${id}`,
      data: { length: n, attributes: { getPosition: { value: coords, size: 2 } } },
      getRadius: 2, radiusUnits: 'pixels', radiusMinPixels: 1, getFillColor: colour(h, id),
    }));
    d.setProps({ layers: [...on.values()] });
    hide(h, id, true);
    h.setStatus(`${info.name ?? id}: ${n.toLocaleString()} points on the GPU (${Math.round(performance.now() - t0)} ms). Run the command again to switch back.`, 6000);
  } catch (e) {
    h.setStatus(`GPU points: ${(e as Error).message ?? e}`, 6000);
  }
}
