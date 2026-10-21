// Change detection helpers for sampled rasters and two-date vector extents.
//
// Raster differencing complements the Whitebox change tools. Vector change is
// the audit-fixed GeoSpaX v1 workflow: dissolve each date, derive loss/gain/
// persistence, report closure, annualised rates and the area method used.

import { histogramND, otsuThreshold, type Histogram } from "./raster";
import { differencePair, intersectPair, unionAll } from "./overlay";
import { measureArea, type AreaMethod } from "./units";
import { makeProvenance, type ProvenanceStamp } from "./provenance";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { AnyFeature } from "./geometry";

export interface ChangeGrid {
  /** A - B (callers must label which date is A and which is B). */
  diff: Float32Array;
  width: number;
  height: number;
  validCells: number;
  nodataCells: number;
}

export function differenceGrid(
  aValues: number[],
  bValues: number[],
  width: number,
  height: number,
  nodataA: number | null,
  nodataB: number | null,
): ChangeGrid {
  const n = width * height;
  const diff = new Float32Array(n);
  let valid = 0;
  let nodata = 0;
  if (aValues.length !== n || bValues.length !== n) {
    diff.fill(Number.NaN);
    return { diff, width, height, validCells: 0, nodataCells: n };
  }
  for (let i = 0; i < n; i++) {
    const a = aValues[i];
    const b = bValues[i];
    const bad =
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      (nodataA !== null && a === nodataA) ||
      (nodataB !== null && b === nodataB);
    if (bad) {
      diff[i] = Number.NaN;
      nodata++;
    } else {
      diff[i] = a - b;
      valid++;
    }
  }
  return { diff, width, height, validCells: valid, nodataCells: nodata };
}

export interface ChangeOtsu {
  histogram: Histogram;
  otsuGain: number | null;
  otsuLoss: number | null;
}

/** Otsu on the signed difference histogram. */
export function changeOtsu(diff: Float32Array): ChangeOtsu {
  const vals = Array.from(diff).filter((value) => Number.isFinite(value)) as number[];
  if (vals.length === 0) {
    const histogram = {
      counts: new Array(64).fill(0),
      edges: Array.from({ length: 65 }, (_, i) => -1 + i * (2 / 64)),
      binCount: 64,
      range: [-1, 1] as [number, number],
      totalValid: 0,
    };
    return { histogram, otsuGain: null, otsuLoss: null };
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const binCount = 64;
  const counts = new Array(binCount).fill(0);
  const edges: number[] = [];
  const binW = (hi - lo) / binCount;
  for (let i = 0; i <= binCount; i++) edges.push(lo + i * binW);
  for (const value of vals) {
    let bin = Math.floor((value - lo) / binW);
    if (bin < 0) bin = 0;
    if (bin >= binCount) bin = binCount - 1;
    counts[bin]++;
  }
  const histogram = {
    counts,
    edges,
    binCount,
    range: [lo, hi] as [number, number],
    totalValid: vals.length,
  };
  const otsu = otsuThreshold(histogram);
  return {
    histogram,
    otsuGain: otsu.threshold !== null && otsu.threshold > 0 ? otsu.threshold : null,
    otsuLoss: otsu.threshold !== null && otsu.threshold < 0 ? otsu.threshold : null,
  };
}

type PolyFeature = Feature<Polygon | MultiPolygon>;

export interface VectorChangeOptions {
  yearT1?: number | null;
  yearT2?: number | null;
  areaMode?: AreaMethod;
}

export interface VectorChangeResult {
  ok: true;
  lossGeom: PolyFeature | null;
  gainGeom: PolyFeature | null;
  persistenceGeom: PolyFeature | null;
  features: PolyFeature[];
  t1AreaM2: number;
  t2AreaM2: number;
  lossAreaM2: number;
  gainAreaM2: number;
  persistenceAreaM2: number;
  lossPctOfT1: number;
  gainPctOfT1: number;
  netChangeM2: number;
  netChangePct: number;
  years: number | null;
  annualHaPerYear: number | null;
  annualPctPerYear: number | null;
  areaMethod: string;
  areaCrs: string;
  residualPct: number;
  provenance: ProvenanceStamp;
}

/** Two-date polygon extent change: loss, gain and persistence. */
export function vectorChangeDetection(
  t1Features: AnyFeature[] | null | undefined,
  t2Features: AnyFeature[] | null | undefined,
  options: VectorChangeOptions = {},
): VectorChangeResult | { ok: false; error: string } {
  const t1 = unionAll(t1Features);
  const t2 = unionAll(t2Features);
  if (!t1) return { ok: false, error: "Time-1 layer contains no polygons." };
  if (!t2) return { ok: false, error: "Time-2 layer contains no polygons." };

  const loss = differencePair(t1, t2);
  const gain = differencePair(t2, t1);
  const persistence = intersectPair(t1, t2);
  const areaMode = options.areaMode ?? "equalarea";
  const m1 = measureArea([t1], areaMode);
  const m2 = measureArea([t2], areaMode);
  const ml = loss ? measureArea([loss], areaMode) : { m2: 0, method: m1.method, crs: m1.crs };
  const mg = gain ? measureArea([gain], areaMode) : { m2: 0, method: m1.method, crs: m1.crs };
  const mp = persistence
    ? measureArea([persistence], areaMode)
    : { m2: 0, method: m1.method, crs: m1.crs };

  const years =
    Number.isFinite(options.yearT1) &&
    Number.isFinite(options.yearT2) &&
    (options.yearT2 as number) > (options.yearT1 as number)
      ? (options.yearT2 as number) - (options.yearT1 as number)
      : null;
  const net = m2.m2 - m1.m2;
  const provenance = makeProvenance(
    "vector-change-detection",
    "Dissolved polygon overlay",
    m1.crs,
    {
      areaMethod: m1.method,
      yearT1: options.yearT1 ?? null,
      yearT2: options.yearT2 ?? null,
      years,
      differenceConvention: "loss=T1−T2; gain=T2−T1; persistence=T1∩T2",
    },
  );

  const features: PolyFeature[] = [];
  const stamp = (
    feature: PolyFeature | null,
    change: "loss" | "gain" | "persistence",
    m2Value: number,
  ) => {
    if (!feature) return;
    feature.properties = {
      change,
      area_m2: m2Value,
      year_t1: options.yearT1 ?? null,
      year_t2: options.yearT2 ?? null,
      _geospax: provenance,
    };
    features.push(feature);
  };
  stamp(loss, "loss", ml.m2);
  stamp(gain, "gain", mg.m2);
  stamp(persistence, "persistence", mp.m2);

  return {
    ok: true,
    lossGeom: loss,
    gainGeom: gain,
    persistenceGeom: persistence,
    features,
    t1AreaM2: m1.m2,
    t2AreaM2: m2.m2,
    lossAreaM2: ml.m2,
    gainAreaM2: mg.m2,
    persistenceAreaM2: mp.m2,
    lossPctOfT1: m1.m2 > 0 ? (ml.m2 / m1.m2) * 100 : 0,
    gainPctOfT1: m1.m2 > 0 ? (mg.m2 / m1.m2) * 100 : 0,
    netChangeM2: net,
    netChangePct: m1.m2 > 0 ? (net / m1.m2) * 100 : 0,
    years,
    annualHaPerYear: years ? net / 10_000 / years : null,
    annualPctPerYear: years && m1.m2 > 0 ? ((net / m1.m2) * 100) / years : null,
    areaMethod: m1.method,
    areaCrs: m1.crs,
    residualPct: m1.m2 > 0 ? (Math.abs(ml.m2 + mp.m2 - m1.m2) / m1.m2) * 100 : 0,
    provenance,
  };
}
