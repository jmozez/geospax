// Environmental covariates for SDM: a regular lon/lat background grid built
// from raster windows, and presence records annotated with the value of the
// grid cell they fall in. Presences and background therefore share one
// sampling grain, which is the usual presence-background SDM convention.
//
// Raster windows are row-major with row 0 at the northern edge (image order),
// matching the host's readRasterWindow.

import type {
  Feature,
  Geometry,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import { makeProvenance, type ProvenanceStamp } from "./provenance";

export interface CovariateGridSpec {
  /** [west, south, east, north] in WGS84 degrees. */
  bounds: [number, number, number, number];
  width: number;
  height: number;
}

export interface CovariateRaster {
  /** Attribute name written to features, e.g. "bio1". */
  field: string;
  /** Row-major values, width × height, row 0 = north. */
  values: number[];
  nodata: number | null;
}

/** Hard ceiling the host imposes on one raster window side. */
export const MAX_COVARIATE_GRID_SIDE = 1024;

/**
 * Expand the bounding box of [lon, lat] points by `bufferDeg` and size a grid
 * of `cellSizeDeg` cells over it. Returns null when there are no valid points
 * or the grid would exceed the host's per-side limit.
 */
export function covariateGridFor(
  points: Array<[number, number]>,
  cellSizeDeg: number,
  bufferDeg = 0
): CovariateGridSpec | null {
  const valid = points.filter(
    ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)
  );
  if (!valid.length || !(cellSizeDeg > 0) || !(bufferDeg >= 0)) return null;
  const west = Math.max(-180, Math.min(...valid.map((p) => p[0])) - bufferDeg);
  const east = Math.min(180, Math.max(...valid.map((p) => p[0])) + bufferDeg);
  const south = Math.max(-90, Math.min(...valid.map((p) => p[1])) - bufferDeg);
  const north = Math.min(90, Math.max(...valid.map((p) => p[1])) + bufferDeg);
  const width = Math.max(2, Math.ceil((east - west) / cellSizeDeg));
  const height = Math.max(2, Math.ceil((north - south) / cellSizeDeg));
  if (width > MAX_COVARIATE_GRID_SIDE || height > MAX_COVARIATE_GRID_SIDE)
    return null;
  // Snap the far edges so every cell is exactly cellSizeDeg.
  return {
    bounds: [
      west,
      south,
      west + width * cellSizeDeg,
      south + height * cellSizeDeg,
    ],
    width,
    height,
  };
}

/** Row-major index of the cell containing [lon, lat], or -1 outside the grid. */
export function gridCellIndex(
  grid: CovariateGridSpec,
  lon: number,
  lat: number
): number {
  const [west, south, east, north] = grid.bounds;
  if (!(lon >= west && lon <= east && lat >= south && lat <= north)) return -1;
  const col = Math.min(
    grid.width - 1,
    Math.floor(((lon - west) / (east - west)) * grid.width)
  );
  const row = Math.min(
    grid.height - 1,
    Math.floor(((north - lat) / (north - south)) * grid.height)
  );
  return row * grid.width + col;
}

function cellValue(raster: CovariateRaster, index: number): number | null {
  const value = raster.values[index];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (raster.nodata !== null && value === raster.nodata) return null;
  return value;
}

export interface CovariateSampleResult {
  /** One point per grid cell with every covariate valid (cell centres). */
  background: Feature<Point>[];
  /** Input presences with covariate fields added (null where missing). */
  presences: Feature<Point>[];
  backgroundCells: number;
  /** Cells inside the mask (or all cells) dropped for missing covariates. */
  backgroundDropped: number;
  /** Cells whose centre falls outside the mask polygons. */
  backgroundMasked: number;
  presencesComplete: number;
  presencesOutside: number;
  /** Presences outside the mask polygons (kept; they still carry values). */
  presencesOutsideMask: number;
  provenance: ProvenanceStamp;
}

export type MaskGeometry = Polygon | MultiPolygon;

function inRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

interface PreparedPolygon {
  rings: Position[][];
  bbox: [number, number, number, number];
}

function preparePolygons(geometries: MaskGeometry[]): PreparedPolygon[] {
  const polygons = geometries.flatMap((geometry) =>
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates
  );
  return polygons
    .filter((rings) => rings.length && rings[0].length >= 4)
    .map((rings) => {
      const xs = rings[0].map((p) => p[0]);
      const ys = rings[0].map((p) => p[1]);
      return {
        rings,
        bbox: [
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
        ],
      };
    });
}

function inPrepared(
  lon: number,
  lat: number,
  polygons: PreparedPolygon[]
): boolean {
  return polygons.some(
    ({ rings, bbox }) =>
      lon >= bbox[0] &&
      lon <= bbox[2] &&
      lat >= bbox[1] &&
      lat <= bbox[3] &&
      inRing(lon, lat, rings[0]) &&
      !rings.slice(1).some((hole) => inRing(lon, lat, hole))
  );
}

/** True when [lon, lat] lies inside any polygon (holes excluded). */
export function pointInMask(
  lon: number,
  lat: number,
  mask: MaskGeometry[]
): boolean {
  return inPrepared(lon, lat, preparePolygons(mask));
}

/**
 * Build the background grid and annotate presences from raster windows that
 * all share `grid`. Background cells with any missing covariate are dropped
 * (not zero-filled); presences keep their record with null fields instead.
 */
export function sampleCovariates(
  grid: CovariateGridSpec,
  rasters: CovariateRaster[],
  presences: Feature<Point>[],
  params: Record<string, unknown> = {},
  mask?: MaskGeometry[]
): CovariateSampleResult | null {
  const cells = grid.width * grid.height;
  if (!rasters.length || rasters.some((r) => r.values.length !== cells))
    return null;
  if (new Set(rasters.map((r) => r.field)).size !== rasters.length) return null;
  const [west, south, east, north] = grid.bounds;
  const dx = (east - west) / grid.width;
  const dy = (north - south) / grid.height;

  const prepared = mask?.length ? preparePolygons(mask) : null;
  if (mask?.length && !prepared?.length) return null;
  const background: Feature<Point>[] = [];
  let backgroundMasked = 0;
  for (let index = 0; index < cells; index++) {
    const row = Math.floor(index / grid.width);
    const col = index % grid.width;
    if (
      prepared &&
      !inPrepared(west + (col + 0.5) * dx, north - (row + 0.5) * dy, prepared)
    ) {
      backgroundMasked++;
      continue;
    }
    const values = rasters.map((raster) => cellValue(raster, index));
    if (values.some((value) => value === null)) continue;
    background.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [west + (col + 0.5) * dx, north - (row + 0.5) * dy],
      },
      properties: {
        cell: index,
        ...Object.fromEntries(
          rasters.map((raster, i) => [raster.field, values[i]])
        ),
      },
    });
  }

  let presencesComplete = 0;
  let presencesOutside = 0;
  const annotated = presences.map((feature): Feature<Point> => {
    const [lon, lat] = feature.geometry.coordinates;
    const index = gridCellIndex(grid, lon, lat);
    if (index < 0) presencesOutside++;
    const values = rasters.map((raster) =>
      index < 0 ? null : cellValue(raster, index)
    );
    if (values.every((value) => value !== null)) presencesComplete++;
    return {
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        ...Object.fromEntries(
          rasters.map((raster, i) => [raster.field, values[i]])
        ),
      },
    };
  });

  return {
    background,
    presences: annotated,
    backgroundCells: background.length,
    backgroundDropped: cells - backgroundMasked - background.length,
    backgroundMasked,
    presencesComplete,
    presencesOutside,
    presencesOutsideMask: prepared
      ? presences.filter(
          (feature) =>
            !inPrepared(
              feature.geometry.coordinates[0],
              feature.geometry.coordinates[1],
              prepared
            )
        ).length
      : 0,
    provenance: makeProvenance(
      "sdm-covariates",
      "Regular lon/lat background grid; presences take the value of the grid cell containing them (nearest raster sample at cell centre); cells with any NoData dropped",
      "WGS84 lon/lat grid (not equal-area)",
      {
        bounds: grid.bounds,
        width: grid.width,
        height: grid.height,
        cellSizeDeg: dx,
        variables: rasters.map((r) => r.field),
        backgroundMask: prepared
          ? `${prepared.length} polygon(s); cell centres outside dropped`
          : "none (full rectangle)",
        ...params,
      }
    ),
  };
}

/**
 * Recover the covariate grid from a background-grid feature's provenance
 * stamp (`_geospax.params` written by {@link sampleCovariates}), or null when
 * the features did not come from the covariate tool.
 */
export function covariateGridFromFeatures(
  features: Array<Feature<Geometry | null>>
): CovariateGridSpec | null {
  for (const feature of features) {
    const params = (
      feature.properties?._geospax as
        | { params?: Record<string, unknown> }
        | undefined
    )?.params;
    const bounds = params?.bounds;
    const width = params?.width;
    const height = params?.height;
    if (
      Array.isArray(bounds) &&
      bounds.length === 4 &&
      bounds.every((value) => Number.isFinite(value)) &&
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      (width as number) > 0 &&
      (height as number) > 0
    ) {
      return {
        bounds: bounds as [number, number, number, number],
        width: width as number,
        height: height as number,
      };
    }
  }
  return null;
}

/**
 * Rasterise a per-cell score back onto the covariate grid: each feature's
 * `cell` index (row-major, row 0 = north) receives its `field` value; cells
 * with no feature or a non-finite score are NaN.
 */
export function gridFromCellScores(
  grid: CovariateGridSpec,
  features: Array<Feature<Geometry | null>>,
  field: string
): { values: Float32Array; filled: number } {
  const values = new Float32Array(grid.width * grid.height).fill(Number.NaN);
  let filled = 0;
  for (const feature of features) {
    const cell = feature.properties?.cell;
    const score = feature.properties?.[field];
    if (
      Number.isInteger(cell) &&
      (cell as number) >= 0 &&
      (cell as number) < values.length &&
      typeof score === "number" &&
      Number.isFinite(score)
    ) {
      values[cell as number] = score;
      filled++;
    }
  }
  return { values, filled };
}
