// Keeps the current height from each source up to date for the app: the geoid grid is loaded once, the
// barometer is read every few seconds (phones without one give nothing), and the terrain model is asked
// for a new ~100 m cell only when it is switched on in Settings. The choosing is in elevation.ts.
import { baroHeight, bestHeight, CAL_MAX_AGE, canCalibrate, DEM_ACC, demKey, demUrl, geoidAt, orthometric, parseDem, type BaroCal, type Height } from './elevation';
import type { Fix } from './geo';

const inApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let grid: Int16Array | null = null;
let gridP: Promise<void> | null = null;
export function loadGeoid(): Promise<void> {
  gridP ??= fetch(`${import.meta.env.BASE_URL}geoid/egm2008-15m.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((b) => { grid = new Int16Array(b); })
    .catch(() => { gridP = null; });
  return gridP;
}

export const state: { hpa: number | null; cal: BaroCal | null; dem: Height | null; demOn: boolean } = { hpa: null, cal: loadCal(), dem: null, demOn: false };
function loadCal(): BaroCal | null {
  try { return JSON.parse(localStorage.getItem('geospax-field.baroCal') ?? 'null'); } catch { return null; }
}

/** The GPS height above sea level for a fix, with its vertical accuracy. */
export function gnssHeight(f: Fix | null): Height | null {
  if (!f || f.ele == null || !grid) return null;
  return { value: orthometric(f.ele, geoidAt(grid, f.lat, f.lon)), source: 'gnss', acc: f.altAcc ?? null };
}

/** Every source now, and the best of them. */
export function heights(f: Fix | null, now = Date.now()) {
  const gnss = gnssHeight(f);
  const cal = state.cal && now - state.cal.t <= CAL_MAX_AGE ? state.cal : null;
  const baro = state.hpa != null ? baroHeight(state.hpa, cal, now) : null;
  const dem = state.demOn ? state.dem : null;
  return { gnss, baro, dem, best: bestHeight({ gnss, baro, dem }) };
}

async function readBarometer(): Promise<number | null> {
  if (!inApp) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<number | null>('barometer_hpa');
  } catch { return null; }
}

const demCache = new Map<string, number>();
async function askDem(f: Fix) {
  const k = demKey(f.lat, f.lon);
  let v = demCache.get(k) ?? Number(localStorage.getItem(`geospax-field.dem.${k}`) ?? NaN);
  if (!Number.isFinite(v)) {
    try {
      const r = await fetch(demUrl(f.lat, f.lon));
      const p = parseDem(await r.json());
      if (p == null) return;
      v = p;
      try { localStorage.setItem(`geospax-field.dem.${k}`, String(v)); } catch { /* full: kept for this session */ }
    } catch { return; /* offline */ }
  }
  demCache.set(k, v);
  state.dem = { value: v, source: 'dem', acc: DEM_ACC };
}

let lastDemKey = '';
/** Call with each new fix: sets the barometer from a good GPS height and asks the terrain model for a new cell. */
export function onFix(f: Fix) {
  const g = gnssHeight(f);
  if (state.hpa != null && canCalibrate(g) && (!state.cal || Date.now() - state.cal.t > 60_000)) {
    state.cal = { p0: state.hpa, h0: g!.value, t: Date.now() };
    try { localStorage.setItem('geospax-field.baroCal', JSON.stringify(state.cal)); } catch { /* session only */ }
  }
  if (state.demOn && demKey(f.lat, f.lon) !== lastDemKey) {
    lastDemKey = demKey(f.lat, f.lon);
    void askDem(f);
  }
}

/** Starts the geoid load and the barometer readings. */
export function startHeights(demOn: boolean) {
  state.demOn = demOn;
  void loadGeoid();
  if (!inApp) return;
  const tick = async () => {
    state.hpa = await readBarometer();
    // no barometer on this phone (or no reading): ask again only once a minute
    setTimeout(tick, state.hpa != null ? 5000 : 60_000);
  };
  void tick();
}
export function setDem(on: boolean) {
  state.demOn = on;
  lastDemKey = '';
  if (!on) state.dem = null;
}
