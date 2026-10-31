// Heights above sea level, and where each one comes from. A phone's GPS gives the height above the
// ellipsoid (WGS 84), which in Papua New Guinea is around 70 m above the sea; the EGM2008 geoid takes it to
// the height above mean sea level. Three other sources fill in when the GPS height is poor or missing:
//  - the barometer (on phones that have one): steady over minutes, calibrated against a good GPS height,
//  - the terrain model (Copernicus GLO-90, through Open-Meteo): needs the internet, and sends the position,
//    so it is off unless switched on in Settings,
//  - the barometer against standard air pressure (1013.25 hPa): a rough guess, often 50 m out.
// The logic here is pure (no DOM), so scripts/test-field-elevation.mjs runs it in Node.

export type HeightSource = 'gnss' | 'baro' | 'dem' | 'baro-std';
export interface Height {
  /** metres above mean sea level (EGM2008) */
  value: number;
  source: HeightSource;
  /** the expected error, metres, when known */
  acc: number | null;
}
export const SOURCE_LABEL: Record<HeightSource, string> = {
  gnss: 'GPS and EGM2008 geoid',
  baro: 'barometer, set from GPS',
  dem: 'terrain model (GLO-90)',
  'baro-std': 'barometer, standard air',
};

// ------------------------------------------------------------------ the EGM2008 geoid
/** The grid in public/geoid/egm2008-15m.bin (made by scripts/make-geoid-grid.py): 0.25° cells, int16 cm. */
export const GEOID = { rows: 721, cols: 1441, step: 0.25 };

/** Geoid height N in metres (the sea level above the ellipsoid) at a place, interpolated bilinearly. */
export function geoidAt(grid: Int16Array, lat: number, lon: number): number {
  const r = Math.min(Math.max((90 - lat) / GEOID.step, 0), GEOID.rows - 1);
  const c = ((((lon % 360) + 360) % 360) / GEOID.step);
  const r0 = Math.min(Math.floor(r), GEOID.rows - 2), c0 = Math.min(Math.floor(c), GEOID.cols - 2);
  const fr = r - r0, fc = c - c0;
  const at = (i: number, j: number) => grid[i * GEOID.cols + j] / 100;
  return at(r0, c0) * (1 - fr) * (1 - fc) + at(r0, c0 + 1) * (1 - fr) * fc + at(r0 + 1, c0) * fr * (1 - fc) + at(r0 + 1, c0 + 1) * fr * fc;
}

/** Height above sea level from the GPS ellipsoid height: h - N. */
export const orthometric = (ellipsoidH: number, n: number) => ellipsoidH - n;

// ------------------------------------------------------------------ the barometer
export const STD_HPA = 1013.25;
/** Height difference for a pressure change (the international barometric formula), metres. */
export const baroDelta = (p: number, p0: number) => 44330 * (1 - (p / p0) ** (1 / 5.255));
/** A barometer reading set against a known height (h0 at pressure p0). */
export interface BaroCal { p0: number; h0: number; t: number }
/** Height from air pressure: against a calibration when there is one, else against standard air. */
export function baroHeight(p: number, cal: BaroCal | null, now = Date.now()): Height {
  if (cal) {
    // the weather moves the pressure by about 1 hPa (8 m) in a few hours, so trust drops with age
    const hours = Math.max(0, now - cal.t) / 3_600_000;
    return { value: cal.h0 + baroDelta(p, cal.p0), source: 'baro', acc: 2 + 3 * hours };
  }
  return { value: baroDelta(p, STD_HPA), source: 'baro-std', acc: 50 };
}

// ------------------------------------------------------------------ choosing
/** A GPS height is used when its vertical accuracy is this good or better, metres. */
export const GOOD_VERTICAL = 15;
/** A calibration is used for this long; after that the weather has moved the pressure too much. */
export const CAL_MAX_AGE = 6 * 3_600_000;

/**
 * The best height there is now: the GPS (with the geoid) when its vertical accuracy is 15 m or better, else
 * the calibrated barometer, else the terrain model, else the GPS however poor, else the barometer against
 * standard air. Null when there is nothing.
 */
export function bestHeight(c: { gnss?: Height | null; baro?: Height | null; dem?: Height | null }): Height | null {
  const g = c.gnss, b = c.baro, d = c.dem;
  if (g && g.acc != null && g.acc <= GOOD_VERTICAL) return g;
  if (b && b.source === 'baro') return b;
  if (d) return d;
  if (g) return g;
  return b ?? null;
}

/** Whether a GPS height is good enough to set the barometer from. */
export const canCalibrate = (g: Height | null | undefined) => !!g && g.acc != null && g.acc <= 10;

/** A short text for a height: "412.3 m (±4 m, GPS and EGM2008 geoid)". */
export function fmtHeight(h: Height | null): string {
  if (!h) return 'not known';
  return `${h.value.toFixed(1)} m${h.acc != null ? ` (±${Math.round(h.acc)} m, ` : ' ('}${SOURCE_LABEL[h.source]})`;
}

// ------------------------------------------------------------------ the terrain model
/** The cache key for a terrain height: about a 100 m cell, so walking around asks again only now and then. */
export const demKey = (lat: number, lon: number) => `${(Math.round(lat * 1000) / 1000).toFixed(3)},${(Math.round(lon * 1000) / 1000).toFixed(3)}`;
export const demUrl = (lat: number, lon: number) => `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`;
/** Reads Open-Meteo's answer: {"elevation":[412.0]}. */
export function parseDem(j: unknown): number | null {
  const e = (j as { elevation?: unknown })?.elevation;
  const v = Array.isArray(e) ? e[0] : null;
  return typeof v === 'number' && Number.isFinite(v) && v > -500 && v < 9000 ? v : null;
}
/** GLO-90 is about ±4 m in open country, worse under forest and on steep slopes. */
export const DEM_ACC = 8;
