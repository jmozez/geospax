// Marine occurrence quality control: flag records that fall on land.
// A record counts as on land when every elevation cell of the DEM within `coastalM` metres of
// it is above `maxElevationM` (so records just off a coarse coastline are kept), and/or when it
// lies inside a land polygon (e.g. OSM land polygons or Natural Earth land). Typical causes are
// specimens georeferenced to a town, island or 0.1°/1° grid centroid, or swapped coordinates.
import type { Feature, Position } from "geojson";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

export interface LandGrid {
  width: number;
  height: number;
  bands: Float32Array[];
  /** GDAL geotransform in lon/lat degrees */
  transform: number[];
  geographic: boolean;
}

export interface OnLandOptions {
  dem?: LandGrid | null;
  /** to lon/lat → the DEM's CRS (only needed when the DEM is projected) */
  toDem?: (p: Position) => Position;
  land?: Feature[] | null;
  /** search radius around a record for any sea cell (m); default 1000 */
  coastalM?: number;
  /** cells at or below this are sea; default 0 */
  maxElevationM?: number;
  /** drop records on land from the output; default false */
  drop?: boolean;
}

export interface OnLandResult {
  features: Feature[];
  total: number;
  onLand: number;
  kept: number;
  removed: number;
  outsideDem: number;
  maxElevationOnLand: number | null;
}

const point = (f: Feature): Position | null =>
  f.geometry?.type === "Point" ? (f.geometry.coordinates as Position) : null;

/** Lowest DEM value within radiusM of p (NaN if p is outside the grid). */
export function minElevationNear(g: LandGrid, p: Position, radiusM: number, demXY: Position = p): number {
  const [x0, dx, , y0, , dy] = g.transform;
  const col = Math.floor((demXY[0] - x0) / dx);
  const row = Math.floor((demXY[1] - y0) / dy);
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return NaN;
  const mPerX = g.geographic ? 111320 * Math.cos((p[1] * Math.PI) / 180) : 1;
  const mPerY = g.geographic ? 110540 : 1;
  const rc = Math.ceil(radiusM / Math.max(1e-9, Math.abs(dx) * mPerX));
  const rr = Math.ceil(radiusM / Math.max(1e-9, Math.abs(dy) * mPerY));
  const b = g.bands[0];
  let min = Infinity;
  for (let r = Math.max(0, row - rr); r <= Math.min(g.height - 1, row + rr); r++)
    for (let c = Math.max(0, col - rc); c <= Math.min(g.width - 1, col + rc); c++) {
      const ex = (c - col) * Math.abs(dx) * mPerX, ey = (r - row) * Math.abs(dy) * mPerY;
      if (radiusM > 0 && ex * ex + ey * ey > (radiusM + Math.abs(dx) * mPerX) ** 2) continue;
      const v = b[r * g.width + c];
      if (Number.isFinite(v) && v < min) min = v;
    }
  return min === Infinity ? NaN : min;
}

export function flagOnLand(points: Feature[], o: OnLandOptions): OnLandResult {
  if (!o.dem && !(o.land && o.land.length)) throw new Error("Give an elevation raster (DEM/bathymetry) or a land polygon layer");
  const coastalM = o.coastalM ?? 1000;
  const sea = o.maxElevationM ?? 0;
  const polys = (o.land ?? []).filter((f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon");
  const out: Feature[] = [];
  let n = 0, onLand = 0, outsideDem = 0, maxEl: number | null = null;
  for (const f of points) {
    const p = point(f);
    if (!p) continue;
    n++;
    let elev: number | null = null, byDem = false, byPoly = false;
    if (o.dem) {
      const m = minElevationNear(o.dem, p, coastalM, o.toDem ? o.toDem(p) : p);
      if (Number.isNaN(m)) outsideDem++;
      else {
        elev = m;
        byDem = m > sea;
      }
    }
    if (polys.length) byPoly = polys.some((poly) => booleanPointInPolygon(p, poly as never));
    const land = byDem || byPoly;
    if (land) {
      onLand++;
      if (elev != null) maxEl = maxEl == null ? elev : Math.max(maxEl, elev);
    }
    if (land && o.drop) continue;
    out.push({
      ...f,
      properties: { ...(f.properties ?? {}), on_land: land, min_elev_near_m: elev == null ? null : Math.round(elev) },
    });
  }
  return { features: out, total: n, onLand, kept: out.length, removed: o.drop ? onLand : 0, outsideDem, maxElevationOnLand: maxEl };
}
