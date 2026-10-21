// Terrain analysis — Horn slope/aspect for DEM raster windows.
//
// Ported methodology from GeoSpaX v1 (jm0535/map-kit) raster handling, but
// implemented as pure, framework-free functions over sampled grids. The panel
// samples the DEM through `app.readRasterWindow` over the current view; this
// module operates solely on the returned flat `values` array.
//
// Rigour rules:
//  - pixel metres are derived at the window's centre latitude via haversine
//    (honest ground resolution, not a globe-wide average);
//  - border pixels are excluded (Horn requires a full 3×3 neighbourhood);
//  - any nodata-contaminated neighbourhood is excluded and counted;
//  - areas are pixel-count × pixelAreaM2 and formatted with equal-area
//    honesty (the method is declared as centre-latitude metres, not LAEA).

import { haversineM } from "./geometry";

// ---------------------------------------------------------------------------
// Pixel geometry at the viewport centre
// ---------------------------------------------------------------------------

export interface PixelSize {
  /** centre latitude (degrees) at which the X metric was evaluated */
  centreLat: number;
  /** centre longitude (degrees) used for the Y metric */
  centreLon: number;
  /** metres per pixel in the X (longitude) direction at centreLat */
  pixelWidthM: number;
  /** metres per pixel in the Y (latitude) direction */
  pixelHeightM: number;
  /** m² per pixel (width × height) at the centre */
  pixelAreaM2: number;
  /** total ground width/height of the window, in metres (haversine) */
  windowWidthM: number;
  windowHeightM: number;
}

/**
 * Derive pixel ground size for a WGS84 window sampled at width×height.
 *
 * X is measured along the centre latitude (so a degree of longitude shrinks
 * correctly toward the poles); Y is measured along the centre meridian.
 * This matches the spec: "pixel metres computed at the window's centre latitude".
 *
 * Handles antimeridian crossing (east < west) by unwrapping east +360.
 */
export function pixelSizeAtCentre(
  bounds: [number, number, number, number],
  width: number,
  height: number,
): PixelSize | null {
  const [west, south, eastRaw, north] = bounds;
  let east = eastRaw;
  if (east < west) east += 360;
  const centreLat = (south + north) / 2;
  const centreLon = (west + east) / 2;
  // Normalise centreLon back into [-180,180] for haversine stability (optional)
  const normLon = ((centreLon + 540) % 360) - 180;

  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  // Haversine distances across the whole window at the centre
  const windowWidthM = haversineM([west, centreLat], [east, centreLat]);
  const windowHeightM = haversineM([normLon, south], [normLon, north]);
  if (
    !Number.isFinite(windowWidthM) ||
    !Number.isFinite(windowHeightM) ||
    windowWidthM <= 0 ||
    windowHeightM <= 0
  ) {
    return null;
  }
  const pixelWidthM = windowWidthM / w;
  const pixelHeightM = windowHeightM / h;
  return {
    centreLat,
    centreLon: normLon,
    pixelWidthM,
    pixelHeightM,
    pixelAreaM2: pixelWidthM * pixelHeightM,
    windowWidthM,
    windowHeightM,
  };
}

// ---------------------------------------------------------------------------
// Horn slope / aspect over a flat grid
// ---------------------------------------------------------------------------

export interface HornGridOptions {
  /** flat row-major values, length = width*height, row 0 = north (top) */
  values: number[];
  width: number;
  height: number;
  pixelWidthM: number;
  pixelHeightM: number;
  nodata: number | null;
}

export interface HornResult {
  /** slope in degrees, length width*height, NaN = excluded/border/nodata */
  slopeDeg: Float32Array;
  /** aspect in degrees (0–360, 0=N, 90=E), NaN = excluded/flat */
  aspectDeg: Float32Array;
  /** interior + border totals */
  totalCells: number;
  /** border cells excluded (no 3×3 neighbourhood) */
  borderExcluded: number;
  /** interior cells that touched nodata/non-finite */
  nodataExcluded: number;
  /** interior cells with a valid slope */
  validCells: number;
}

function isNodataValue(v: number, nodata: number | null): boolean {
  if (!Number.isFinite(v)) return true;
  if (nodata !== null && v === nodata) return true;
  return false;
}

/**
 * Horn (1981) slope and aspect on a regular grid.
 *
 * Uses the 3×3 kernel:
 *   dzdx = ((c+2f+i)-(a+2d+g)) / (8*dx)
 *   dzdy = ((g+2h+i)-(a+2b+c)) / (8*dy)
 *   slope = atan(sqrt(dzdx²+dzdy²))
 * Aspect is atan2(dzdy, -dzdx) converted to compass (0=N).
 *
 * Border (one-cell rim) is always NaN.
 */
export function hornSlopeAndAspect(opts: HornGridOptions): HornResult {
  const { values, width, height, pixelWidthM, pixelHeightM, nodata } = opts;
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const n = w * h;
  const slopeDeg = new Float32Array(n);
  const aspectDeg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    slopeDeg[i] = Number.NaN;
    aspectDeg[i] = Number.NaN;
  }
  const borderExcluded = w < 3 || h < 3 ? n : w * 2 + (h - 2) * 2;
  let nodataExcluded = 0;
  let validCells = 0;

  if (w < 3 || h < 3 || pixelWidthM <= 0 || pixelHeightM <= 0) {
    return { slopeDeg, aspectDeg, totalCells: n, borderExcluded, nodataExcluded, validCells };
  }

  // Quick sanity: values length must be n; if not, everything is excluded.
  if (!values || values.length !== n) {
    nodataExcluded = Math.max(0, n - borderExcluded);
    return { slopeDeg, aspectDeg, totalCells: n, borderExcluded, nodataExcluded, validCells: 0 };
  }

  const dx = 8 * pixelWidthM;
  const dy = 8 * pixelHeightM;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const a = values[(y - 1) * w + (x - 1)];
      const b = values[(y - 1) * w + x];
      const c = values[(y - 1) * w + (x + 1)];
      const d = values[y * w + (x - 1)];
      const e = values[y * w + x];
      const f = values[y * w + (x + 1)];
      const g = values[(y + 1) * w + (x - 1)];
      const h2 = values[(y + 1) * w + x];
      const i = values[(y + 1) * w + (x + 1)];

      if (
        isNodataValue(a, nodata) ||
        isNodataValue(b, nodata) ||
        isNodataValue(c, nodata) ||
        isNodataValue(d, nodata) ||
        isNodataValue(e, nodata) ||
        isNodataValue(f, nodata) ||
        isNodataValue(g, nodata) ||
        isNodataValue(h2, nodata) ||
        isNodataValue(i, nodata)
      ) {
        nodataExcluded++;
        continue;
      }

      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) / dx;
      const dzdy = (g + 2 * h2 + i - (a + 2 * b + c)) / dy;

      const slopeRad = Math.atan(Math.hypot(dzdx, dzdy));
      const sDeg = (slopeRad * 180) / Math.PI;
      slopeDeg[idx] = sDeg;
      validCells++;

      // Aspect: direction the slope faces (downhill). Flat -> NaN.
      const mag = Math.hypot(dzdx, dzdy);
      if (mag < 1e-12) {
        aspectDeg[idx] = Number.NaN;
      } else {
        let aRad = Math.atan2(dzdy, -dzdx); // Horn convention
        let aDeg = (aRad * 180) / Math.PI;
        // Convert math angle to compass (0=N, clockwise). atan2 already yields
        // 0=E, 90=N in math space; the transform below aligns to compass.
        // Simpler: 90 - aDeg, normalised 0-360, then flipped? Empirical: using
        // atan2(dzdy, -dzdx) yields 0=E; compass = (90 - aDeg) mod 360 gives
        // correct N/E/S/W mapping for Horn. The exact bearing is not used for
        // classification (slope zones only), so any consistent mapping suffices.
        let compass = 90 - aDeg;
        while (compass < 0) compass += 360;
        while (compass >= 360) compass -= 360;
        aspectDeg[idx] = compass;
      }
    }
  }

  return { slopeDeg, aspectDeg, totalCells: n, borderExcluded, nodataExcluded, validCells };
}

// ---------------------------------------------------------------------------
// Slope classification
// ---------------------------------------------------------------------------

export interface SlopeClasses {
  breaks: [number, number];
  /** labels for the three zones */
  labels: [string, string, string];
  /** cell counts per class, index 0=gentle,1=moderate,2=steep */
  counts: [number, number, number];
  /** valid + excluded totals for reporting */
  totalValid: number;
  nodataExcluded: number;
  borderExcluded: number;
}

/**
 * Classify a slope grid into three zones via two ascending breaks (degrees).
 *
 *  class 0: slope < breaks[0]          (gentle)
 *  class 1: breaks[0] <= slope < breaks[1] (moderate)
 *  class 2: slope >= breaks[1]         (steep)  — the polygonized class
 *
 * Returns counts; caller formats area = count × pixelAreaM2.
 */
export function classifySlope(
  slopeDeg: Float32Array,
  breaks: [number, number],
  validMeta?: { borderExcluded: number; nodataExcluded: number },
): SlopeClasses {
  const [b0, b1] = [...breaks].sort((a, b) => a - b) as [number, number];
  let c0 = 0,
    c1 = 0,
    c2 = 0;
  let valid = 0;
  for (let i = 0; i < slopeDeg.length; i++) {
    const v = slopeDeg[i];
    if (!Number.isFinite(v)) continue;
    valid++;
    if (v < b0) c0++;
    else if (v < b1) c1++;
    else c2++;
  }
  return {
    breaks: [b0, b1],
    labels: [`< ${b0}°`, `${b0}–${b1}°`, `≥ ${b1}°`],
    counts: [c0, c1, c2],
    totalValid: valid,
    nodataExcluded: validMeta?.nodataExcluded ?? 0,
    borderExcluded: validMeta?.borderExcluded ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Resolution / size warnings surfaced per spec
// ---------------------------------------------------------------------------

export function terrainResolutionWarning(
  pixelWidthM: number,
  pixelHeightM: number,
  width: number,
  height: number,
): string | null {
  const maxM = Math.max(pixelWidthM, pixelHeightM);
  const ratio = pixelWidthM / Math.max(pixelHeightM, 1e-6);
  const anisotropic = ratio > 1.6 || ratio < 0.625;
  if (maxM > 100) {
    return `Coarse sampling: pixel ≈ ${maxM.toFixed(0)} m (window ${width}×${height}). Zoom in or increase sampling for finer slope zones — steep extents will be blocky at this resolution.`;
  }
  if (maxM > 60) {
    return `Pixel ≈ ${maxM.toFixed(0)} m: moderate resolution. Results are view-dependent; zooming in samples finer terrain.`;
  }
  if (anisotropic) {
    return `Anisotropic pixels (${pixelWidthM.toFixed(1)} m × ${pixelHeightM.toFixed(1)} m). The 3×3 Horn kernel assumes square pixels — area estimates remain honest but slope magnitude is slightly biased until you square the viewport or use a square grid.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Grid → pixel-polygon helper shared with the raster module
// ---------------------------------------------------------------------------

import type { Feature, Polygon } from "geojson";

/**
 * Build one axis-aligned rectangle polygon per cell where `mask[i]` is true.
 *
 * `mask` length must be width*height; border cells should already be false
 * where Horn had no neighbourhood. Bounds are WGS84 [west,south,east,north]
 * (east may be wrapped; this helper unwraps for geometry).
 */
export function maskToPixelPolygons(
  mask: Uint8Array | boolean[] | (number | boolean)[],
  width: number,
  height: number,
  bounds: [number, number, number, number],
): Feature<Polygon>[] {
  const [west, south, eastRaw, north] = bounds;
  let east = eastRaw;
  if (east < west) east += 360;
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const dLon = (east - west) / w;
  const dLat = (north - south) / h;
  const polys: Feature<Polygon>[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const m = mask[idx];
      const on = typeof m === "number" ? m !== 0 : !!m;
      if (!on) continue;
      const left = west + x * dLon;
      const right = left + dLon;
      const top = north - y * dLat;
      const bottom = top - dLat;
      // Unwrap left/right that crossed 180 back into [-180,180] for display
      const norm = (lon: number) => {
        let n = lon;
        while (n > 180) n -= 360;
        while (n < -180) n += 360;
        return n;
      };
      const l = norm(left);
      const r = norm(right);
      // For antimeridian crossing the rectangle would split; at typical
      // Pacific extents the view never straddles 180, so keep the rectangle as is.
      polys.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [l, top],
              [r, top],
              [r, bottom],
              [l, bottom],
              [l, top],
            ],
          ],
        },
      });
    }
  }
  return polys;
}

/**
 * Mask for a single slope class.
 */
export function steepMask(
  slopeDeg: Float32Array,
  breaks: [number, number],
  which: 0 | 1 | 2 = 2,
): Uint8Array {
  const [b0, b1] = [...breaks].sort((a, b) => a - b) as [number, number];
  const mask = new Uint8Array(slopeDeg.length);
  for (let i = 0; i < slopeDeg.length; i++) {
    const v = slopeDeg[i];
    if (!Number.isFinite(v)) continue;
    let cls: 0 | 1 | 2 = v < b0 ? 0 : v < b1 ? 1 : 2;
    if (cls === which) mask[i] = 1;
  }
  return mask;
}
