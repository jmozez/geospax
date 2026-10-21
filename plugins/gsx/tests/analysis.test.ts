// Golden-value tests for @geospax/analysis - the TypeScript port of GeoSpaX
// v1's audit-fixed conservation algorithms (jm0535/map-kit). Values are
// derived analytically (spherical excess, haversine perimeters, exact 50%
// overlay splits) so regressions in the port fail loudly.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, Polygon } from "geojson";
import {
  formatArea,
  areaM2,
  laeaFor,
  measureArea,
  perimeterM,
  polygonsOnly,
  protectionGap,
  unionAll,
  fc,
} from "../src/analysis/index";

/** Axis-aligned [lon, lat] box polygon feature. */
function box(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  properties: Record<string, unknown> = {},
): Feature<Polygon> {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
  };
}

const point: Feature = {
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [147.1, -9.4] },
};

// Spherical constants used by Turf (R = 6371008.8 m).
const R = 6371008.8;
const DEG = Math.PI / 180;
/** Spherical-excess area of a 1deg x 1deg box at the equator. */
const EQUATORIAL_DEG2_M2 = DEG * DEG * R * R; // ~1.23646e10
const QUARTER_MERIDIAN_M = DEG * R; // ~111194.93 m per degree

describe("geospax units: formatArea (v1 P0-3, hectares first-class)", () => {
  it("formats zero, sub-10, sub-1000 and grouped values", () => {
    assert.equal(formatArea(0).display, "0 ha");
    // 1500 m2 = 0.15 ha -> two decimals (never rounds sub-10 ha to integer)
    assert.equal(formatArea(1500).text, "0.15");
    // 150000 m2 = 15 ha -> one decimal
    assert.equal(formatArea(150000).display, "15.0 ha");
    // 15,000,000 m2 = 1500 ha -> grouped integer, deterministic commas
    assert.equal(formatArea(15_000_000).display, "1,500 ha");
  });

  it("supports km2 and m2 units", () => {
    assert.equal(formatArea(15_000_000, "km2").display, "15.0 km\u00b2");
    assert.equal(formatArea(1500, "m2").display, "1,500 m\u00b2");
  });
});

describe("geospax units: spherical area & perimeter", () => {
  it("areaM2 matches spherical excess for an equatorial 1x1 degree box", () => {
    const a = areaM2(box(0, 0, 1, 1));
    assert.ok(
      Math.abs(a - EQUATORIAL_DEG2_M2) / EQUATORIAL_DEG2_M2 < 0.005,
      `area ${a} not within 0.5% of ${EQUATORIAL_DEG2_M2}`,
    );
  });

  it("perimeterM matches haversine ring length", () => {
    const p = perimeterM(box(0, 0, 1, 1));
    const expected = 4 * QUARTER_MERIDIAN_M;
    assert.ok(Math.abs(p - expected) / expected < 0.001, `perimeter ${p} vs ${expected}`);
  });

  it("areaM2 tolerates null/invalid input", () => {
    assert.equal(areaM2(null), 0);
    assert.equal(areaM2(point), 0);
  });
});

describe("geospax units: equal-area reporting (v1 P1-4b)", () => {
  it("laeaFor centres LAEA on the data bbox (PNG extent)", () => {
    const p = laeaFor([box(140, -10, 150, -2)]);
    assert.ok(p);
    assert.equal(p.label, "LAEA centred -6.0000, 145.0000");
    assert.ok(p.proj.startsWith("+proj=laea"));
    assert.ok(p.proj.includes("+datum=WGS84"));
  });

  it("laeaFor returns null without a finite bbox", () => {
    assert.equal(laeaFor([]), null);
  });

  it("measureArea equalarea agrees with spherical within 2% and declares its method", () => {
    const feats = [box(0, 0, 1, 1)];
    const eq = measureArea(feats, "equalarea");
    const sph = measureArea(feats, "spherical");
    assert.equal(eq.method, "Equal-area (LAEA)");
    assert.ok(eq.crs.startsWith("LAEA centred"));
    assert.equal(sph.method, "Spherical (WGS84)");
    assert.equal(sph.crs, "EPSG:4326");
    assert.ok(Math.abs(eq.m2 - sph.m2) / sph.m2 < 0.02, `LAEA ${eq.m2} vs spherical ${sph.m2}`);
  });

  it("falls back honestly: no projection -> declares spherical, never LAEA", () => {
    const m = measureArea([], "equalarea");
    assert.equal(m.method, "Spherical (WGS84)");
    assert.equal(m.m2, 0);
  });
});

describe("geospax geometry helpers", () => {
  it("polygonsOnly filters and counts", () => {
    const r = polygonsOnly([box(0, 0, 1, 1), point, box(1, 1, 2, 2)]);
    assert.equal(r.polys.length, 2);
    assert.equal(r.skipped, 1);
  });

  it("unionAll dissolves overlapping boxes and skips malformed input", () => {
    const u = unionAll([box(0, 0, 1, 1), box(0.5, 0, 1.5, 1)]);
    assert.ok(u);
    // Union area ~ 1.5 deg^2 at equator
    const expected = 1.5 * EQUATORIAL_DEG2_M2;
    assert.ok(Math.abs(areaM2(u) - expected) / expected < 0.01);
    // A point among polygons is skipped, not fatal
    const u2 = unionAll([box(0, 0, 1, 1), point]);
    assert.ok(u2);
    assert.equal(unionAll([]), null);
    assert.equal(unionAll([point]), null);
  });
});

describe("geospax protection gap (v1 P0-2 + equal-area default)", () => {
  const habitat = [box(0, 0, 1, 1, { name: "Habitat" })];
  const pas = [box(0.5, 0, 2, 1, { name: "Test PA" })];

  it("splits an exact 50/50 overlap with closure", () => {
    const r = protectionGap(habitat, pas, {
      habitatLayerName: "Habitat",
      paLayerName: "PAs",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(Math.abs(r.protectedPct - 50) < 1.5, `protectedPct ${r.protectedPct}`);
    assert.ok(Math.abs(r.gapPct - 50) < 1.5, `gapPct ${r.gapPct}`);
    assert.ok(r.residualPct < 1, `closure residual ${r.residualPct}%`);
    assert.equal(r.paCount, 1);
    assert.deepEqual(r.paNames, ["Test PA"]);
  });

  it("stamps class properties on result geometry", () => {
    const r = protectionGap(habitat, pas);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.protectedGeom?.properties?.class, "protected");
    assert.equal(r.gapGeom?.properties?.class, "gap");
    assert.ok(typeof r.protectedGeom?.properties?.area_m2 === "number");
  });

  it("declares the measurement method and provenance (no silent fallbacks)", () => {
    const eq = protectionGap(habitat, pas);
    assert.equal(eq.ok, true);
    if (eq.ok) {
      assert.equal(eq.measurement.total.method, "Equal-area (LAEA)");
      assert.equal(eq.provenance.tool, "protection-gap");
      assert.equal(eq.provenance.engine, "@geospax/analysis");
      assert.deepEqual(eq.provenance.params.habitatLayer, null);
    }
    const sph = protectionGap(habitat, pas, { areaMode: "spherical" });
    if (sph.ok) assert.equal(sph.measurement.total.method, "Spherical (WGS84)");
  });

  it("counts only PAs that actually touch the habitat", () => {
    const r = protectionGap(habitat, [
      box(0.5, 0, 2, 1, { name: "Touches" }),
      box(5, 5, 6, 6, { NAME: "Far away" }),
      box(0.9, 0, 3, 1, { pa_name: "Also touches" }),
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.paCount, 2);
    assert.deepEqual(r.paNames, ["Touches", "Also touches"]);
  });

  it("reports unnamed PAs and skipped non-polygons", () => {
    const r = protectionGap([...habitat, point], [box(0.5, 0, 2, 1)], {});
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.paNames, ["(unnamed)"]);
    assert.equal(r.skipped.habitat, 1);
    assert.equal(r.skipped.pa, 0);
  });

  it("fails loudly on non-polygonal inputs", () => {
    const noHab = protectionGap([point], pas);
    assert.equal(noHab.ok, false);
    if (!noHab.ok) assert.equal(noHab.error, "Habitat layer contains no polygons.");
    const noPa = protectionGap(habitat, [point]);
    assert.equal(noPa.ok, false);
    if (!noPa.ok) assert.equal(noPa.error, "Protected-area layer contains no polygons.");
  });

  it("fully protected habitat leaves an empty gap with zero residual", () => {
    const r = protectionGap([box(0.25, 0.25, 0.75, 0.75)], [box(0, 0, 1, 1)]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.gapGeom, null);
    assert.ok(Math.abs(r.protectedPct - 100) < 1.5);
    assert.equal(r.gapPct, 0);
    assert.ok(r.residualPct < 1);
  });
});

describe("geospax fc helper", () => {
  it("wraps features and tolerates null", () => {
    assert.equal(fc(null).features.length, 0);
    assert.equal(fc([point]).type, "FeatureCollection");
  });
});
