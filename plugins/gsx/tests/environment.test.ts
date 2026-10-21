// Golden-value tests for the geospax-environment drop-in — terrain (Horn
// slope/aspect) and spectral-index (normalized difference + Otsu) pure
// functions in @geospax/analysis (terrain.ts / raster.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BAND_ASSIGNMENT_CAVEAT,
  INDEX_PRESETS,
  areaM2ForPixelCount,
  extentPolygonsForThreshold,
  histogramND,
  indexStatsRow,
  normalizedDifferenceGrid,
  otsuThreshold,
  rasterResolutionWarning,
} from "../src/analysis/raster";
import {
  classifySlope,
  hornSlopeAndAspect,
  maskToPixelPolygons,
  pixelSizeAtCentre,
  steepMask,
  terrainResolutionWarning,
} from "../src/analysis/terrain";

describe("geospax-environment: pixelSizeAtCentre (centre-latitude metres)", () => {
  it("derives ~111km per degree at the equator", () => {
    const pix = pixelSizeAtCentre([0, 0, 1, 1], 100, 100);
    assert.ok(pix);
    if (!pix) return;
    // Width at equator ~111319m per degree; with 100 pixels, ~1113m per pixel
    assert.ok(Math.abs(pix.pixelWidthM - 1113) < 80, `pixelWidth ${pix.pixelWidthM}`);
    assert.ok(Math.abs(pix.pixelHeightM - 1113) < 80, `pixelHeight ${pix.pixelHeightM}`);
    assert.equal(pix.centreLat, 0.5);
  });

  it("shrinks longitude ground distance with latitude (centre-lat)", () => {
    const eq = pixelSizeAtCentre([0, 0, 1, 1], 100, 100)!;
    const high = pixelSizeAtCentre([0, 60, 1, 61], 100, 100)!;
    // At 60°N a degree of longitude is cos60 = 0.5 × equatorial
    assert.ok(
      high.pixelWidthM < eq.pixelWidthM * 0.6,
      `high ${high.pixelWidthM} vs eq ${eq.pixelWidthM}`,
    );
    // Latitude distance is roughly latitude-invariant (allow small haversine curvature)
    assert.ok(
      Math.abs(high.pixelHeightM - eq.pixelHeightM) < 150,
      `lat height high ${high.pixelHeightM} vs eq ${eq.pixelHeightM}`,
    );
  });

  it("keeps pixelArea as product", () => {
    const pix = pixelSizeAtCentre([141, -10, 151, -2], 256, 180)!;
    assert.ok(Math.abs(pix.pixelAreaM2 - pix.pixelWidthM * pix.pixelHeightM) < 1e-6);
  });

  it("returns null on degenerate window", () => {
    // zero-height window -> null
    const pix = pixelSizeAtCentre([0, 0, 0, 0], 10, 10);
    // Not necessarily null? windowWidthM=0 => returns null per impl
    assert.equal(pix, null);
  });
});

describe("geospax-environment: Horn slope/aspect", () => {
  // Flat 5×5 grid elevation = 100 everywhere → slope 0
  const w = 5,
    h = 5;
  const flat = new Array(w * h).fill(100);
  it("flat terrain yields ~0° slope interior, NaN border", () => {
    const pix = pixelSizeAtCentre([0, 0, 1, 1], w, h)!;
    const res = hornSlopeAndAspect({
      values: flat,
      width: w,
      height: h,
      pixelWidthM: pix.pixelWidthM,
      pixelHeightM: pix.pixelHeightM,
      nodata: null,
    });
    assert.equal(res.totalCells, w * h);
    assert.equal(res.borderExcluded, w * 2 + (h - 2) * 2);
    assert.equal(res.validCells, 9); // 3×3 interior
    assert.equal(res.nodataExcluded, 0);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const v = res.slopeDeg[y * w + x];
        assert.ok(Math.abs(v) < 1e-6, `flat slope ${v} at ${x},${y}`);
      }
    // border is NaN
    assert.ok(!Number.isFinite(res.slopeDeg[0]));
  });

  it("east-rising ramp yields positive slope, correct magnitude", () => {
    // Create an eastward ramp: elevation = x*10 per pixel column
    const ramp: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ramp.push(x * 10);
    const pix = pixelSizeAtCentre([0, 0, 1, 1], w, h)!;
    const res = hornSlopeAndAspect({
      values: ramp,
      width: w,
      height: h,
      pixelWidthM: pix.pixelWidthM,
      pixelHeightM: pix.pixelHeightM,
      nodata: null,
    });
    // dzdx ≈ 10 / pixelWidthM, so slope = atan(10/dx) in degrees
    const expected = (Math.atan(10 / pix.pixelWidthM) * 180) / Math.PI;
    const centre = res.slopeDeg[Math.floor(h / 2) * w + Math.floor(w / 2)];
    assert.ok(Math.abs(centre - expected) < 0.5, `centre slope ${centre} vs expected ${expected}`);
  });

  it("excludes nodata neighbourhoods and counts them", () => {
    const g = [...flat];
    g[12] = -9999; // centre nodata
    const pix = pixelSizeAtCentre([0, 0, 1, 1], w, h)!;
    const res = hornSlopeAndAspect({
      values: g,
      width: w,
      height: h,
      pixelWidthM: pix.pixelWidthM,
      pixelHeightM: pix.pixelHeightM,
      nodata: -9999,
    });
    // Any interior cell whose 3×3 touches centre is excluded — at least 9 cells
    assert.ok(res.nodataExcluded >= 1);
    assert.ok(res.validCells < 9);
    assert.ok(!Number.isFinite(res.slopeDeg[12]));
  });

  it("handles too-small grid (no interior)", () => {
    const pix = pixelSizeAtCentre([0, 0, 1, 1], 2, 2)!;
    const res = hornSlopeAndAspect({
      values: [0, 0, 0, 0],
      width: 2,
      height: 2,
      pixelWidthM: pix.pixelWidthM,
      pixelHeightM: pix.pixelHeightM,
      nodata: null,
    });
    assert.equal(res.validCells, 0);
    assert.equal(res.borderExcluded, 4);
  });
});

describe("geospax-environment: slope classification", () => {
  it("three-class split at 15° / 30°", () => {
    const slopes = new Float32Array([5, 10, 15, 20, 30, 45, Number.NaN]);
    const cls = classifySlope(slopes, [15, 30]);
    assert.deepEqual(cls.counts, [2, 2, 2]);
    assert.deepEqual(cls.labels, ["< 15°", "15–30°", "≥ 30°"]);
    assert.equal(cls.totalValid, 6);
  });

  it("order-independent breaks (30,15) normalised", () => {
    const slopes = new Float32Array([0, 29.9, 30, 90]);
    const cls = classifySlope(slopes, [30, 15]);
    assert.deepEqual(cls.breaks, [15, 30]);
    assert.deepEqual(cls.counts, [1, 1, 2]);
  });

  it("steepMask selects only ≥30°", () => {
    const slopes = new Float32Array([10, 20, 30, 35, Number.NaN]);
    const mask = steepMask(slopes, [15, 30], 2);
    assert.equal(mask[0], 0);
    assert.equal(mask[1], 0);
    assert.equal(mask[2], 1);
    assert.equal(mask[3], 1);
    assert.equal(mask[4], 0);
  });

  it("terrainResolutionWarning surfaces coarse / anisotropic warnings", () => {
    assert.ok(terrainResolutionWarning(120, 120, 256, 256)?.includes("Coarse"));
    assert.ok(terrainResolutionWarning(70, 70, 256, 256)?.includes("moderate"));
    // Use a not-coarse anisotropic case: max 45m but ratio 2.25 → anisotropic
    assert.ok(terrainResolutionWarning(45, 20, 256, 256)?.includes("Anisotropic"));
    assert.equal(terrainResolutionWarning(20, 20, 256, 256), null);
  });
});

describe("geospax-environment: mask→polygons", () => {
  it("one steep cell becomes one pixel rectangle inside bounds", () => {
    const w = 2,
      h = 2;
    const bounds: [number, number, number, number] = [0, 0, 2, 2];
    const slopes = new Float32Array([10, 40, 5, 35]);
    const mask = steepMask(slopes, [15, 30], 2);
    const polys = maskToPixelPolygons(mask, w, h, bounds);
    assert.equal(polys.length, 2);
    // First steep cell is x=1,y=0 (top row, second column): left=1, right=2, top=2, bottom=1
    const geom = polys[0].geometry.coordinates[0];
    // Expect rectangle corners roughly [1,2],[2,2],[2,1],[1,1]
    assert.deepEqual(geom[0], [1, 2]);
    assert.deepEqual(geom[2], [2, 1]);
  });
});

describe("geospax-environment: normalized-difference grid", () => {
  it("ND = (A−B)/(A+B) with valid cells", () => {
    const w = 3,
      h = 2;
    const A = [10, 20, 30, 10, 10, 10];
    const B = [5, 10, 10, 10, 0, 10];
    const g = normalizedDifferenceGrid(A, B, w, h, null, null);
    // (10-5)/(15)=0.333..., (20-10)/30=0.333..., (30-10)/40=0.5, (10-10)/20=0, (10-0)/10=1, (10-10)/20=0
    assert.ok(Math.abs(g.nd[0] - 0.333333) < 0.001);
    assert.ok(Math.abs(g.nd[2] - 0.5) < 0.001);
    assert.ok(Math.abs(g.nd[4] - 1) < 0.001);
    assert.equal(g.validCells, 6);
    assert.equal(g.nodataCells, 0);
    assert.ok(Number.isFinite(g.min) && Number.isFinite(g.max));
    assert.ok(Math.abs(g.mean - (0.3333 + 0.3333 + 0.5 + 0 + 1 + 0) / 6) < 0.001);
  });

  it("nodata and zero-denom are NaN and counted", () => {
    const w = 2,
      h = 1;
    const A = [1, 5],
      B = [-1, 5]; // first has denom 0 => NaN, second (5-5)/10=0
    const g = normalizedDifferenceGrid(A, B, w, h, null, null);
    assert.ok(!Number.isFinite(g.nd[0]));
    assert.equal(g.nodataCells, 1);
    assert.equal(g.validCells, 1);
    assert.equal(g.nd[1], 0);
  });

  it("respects nodata sentinel", () => {
    const g = normalizedDifferenceGrid([10, -9999], [5, 5], 2, 1, -9999, null);
    assert.ok(Number.isFinite(g.nd[0]));
    assert.ok(!Number.isFinite(g.nd[1]));
    assert.equal(g.validCells, 1);
    assert.equal(g.nodataCells, 1);
  });

  it("mismatched lengths → all nodata", () => {
    const g = normalizedDifferenceGrid([1, 2, 3], [1, 2], 3, 1, null, null);
    assert.equal(g.validCells, 0);
    assert.equal(g.nodataCells, 3);
  });
});

describe("geospax-environment: histogram + Otsu + stats", () => {
  it("histogram bins ND values into [-1,1]", () => {
    const nd = new Float32Array([-1, -0.5, 0, 0.5, 1, 0.9, Number.NaN]);
    const hist = histogramND(nd, 4, [-1, 1]);
    assert.equal(hist.binCount, 4);
    assert.equal(hist.totalValid, 6);
    // bins: [-1,-0.5),[-0.5,0),[0,0.5),[0.5,1] — expect distribution
    assert.equal(hist.counts[0], 1); // -1
    assert.equal(hist.counts[1], 1); // -0.5
    assert.equal(hist.counts[2], 1); // 0
    assert.equal(hist.counts[3], 3); // 0.5,1,0.9
  });

  it("Otsu bimodal: two peaks → threshold between them", () => {
    // Construct a clearly bimodal ND: half at -0.8, half at +0.7. Otsu should
    // land somewhere between the peaks — not at an extreme. Allow a wide
    // band because the exact bin depends on histogram discretisation.
    const nd = new Float32Array([...new Array(50).fill(-0.8), ...new Array(50).fill(0.7)]);
    const hist = histogramND(nd, 64, [-1, 1]);
    const otsu = otsuThreshold(hist);
    assert.ok(otsu.threshold !== null, "Otsu should find a threshold for bimodal data");
    if (otsu.threshold !== null) {
      assert.ok(
        otsu.threshold > -0.9 && otsu.threshold < 0.9,
        `otsu ${otsu.threshold} not in [-0.9,0.9]`,
      );
      assert.ok(
        otsu.threshold > -0.8 && otsu.threshold < 0.7,
        `otsu ${otsu.threshold} not between peaks`,
      );
      assert.ok(otsu.binIndex !== null);
      assert.ok((otsu.betweenVariance ?? 0) > 0);
    }
  });

  it("Otsu unimodal (single occupied bin) → null", () => {
    const nd = new Float32Array(new Array(20).fill(0.5));
    const hist = histogramND(nd, 64, [-1, 1]);
    const otsu = otsuThreshold(hist);
    assert.equal(otsu.threshold, null);
  });

  it("stats row: range, mean, valid cells", () => {
    const nd = new Float32Array([0.1, 0.2, 0.3, Number.NaN]);
    const g = {
      nd,
      validCells: 3,
      nodataCells: 1,
      min: 0.1,
      max: 0.3,
      mean: 0.2,
      width: 2,
      height: 2,
      rawNodata: null,
    } as ReturnType<typeof normalizedDifferenceGrid>;
    const row = indexStatsRow(g);
    assert.equal(row.min, 0.1);
    assert.equal(row.max, 0.3);
    assert.equal(row.mean, 0.2);
    assert.equal(row.validCells, 3);
    assert.equal(row.totalCells, 4);
  });

  it("rasterResolutionWarning mirrors terrain logic for ND", () => {
    assert.ok(rasterResolutionWarning(110, 110, 256, 256)?.includes("Coarse"));
    assert.equal(rasterResolutionWarning(20, 20, 256, 256), null);
  });

  it("INDEX_PRESETS has 5 entries and BAND caveat is verbatim", () => {
    assert.equal(Object.keys(INDEX_PRESETS).length, 5);
    assert.ok(INDEX_PRESETS.NDVI);
    assert.ok(INDEX_PRESETS.NDWI);
    assert.ok(INDEX_PRESETS.NDBI);
    assert.ok(INDEX_PRESETS.NBR);
    assert.ok(INDEX_PRESETS.CUSTOM);
    assert.ok(BAND_ASSIGNMENT_CAVEAT.includes("Band-assignment caveat"));
    assert.ok(BAND_ASSIGNMENT_CAVEAT.includes("do not auto-detect"));
  });

  it("areaM2ForPixelCount and extentPolygonsForThreshold round-trip", () => {
    const pixArea = 100; // 10×10m
    assert.equal(areaM2ForPixelCount(5, pixArea), 500);
    const nd = new Float32Array([0.5, 0.1, 0.3, 0.8]);
    const polys = extentPolygonsForThreshold(nd, 2, 2, [0, 0, 2, 2], 0.3);
    // 0.5≥0.3, 0.3≥0.3, 0.8≥0.3 => 3 rects
    assert.equal(polys.length, 3);
  });
});
