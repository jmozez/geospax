import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wlc, distanceDecay } from "../src/analysis/suitability";
import {
  patchMetrics,
  summarizeFragmentation,
} from "../src/analysis/fragmentation";
import {
  connectivityGraph,
  connectivitySummary,
} from "../src/analysis/connectivity";
import { descriptiveStats, zonalMean } from "../src/analysis/statistics";
import { differenceGrid, changeOtsu } from "../src/analysis/change";
import { isD8, d8Coverage, basinStats } from "../src/analysis/hydrology";
import { richness, shannon, simpson } from "../src/analysis/biodiversity";
import { equalInterval, jenksBreaks } from "../src/analysis/classification";
import { solveScpGreedy } from "../src/analysis/scp";
import { fitBioclim, fitMahalanobis } from "../src/analysis/sdm";
import type { Feature, Polygon } from "geojson";

function square(minLon: number, minLat: number, size: number): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minLon, minLat],
          [minLon + size, minLat],
          [minLon + size, minLat + size],
          [minLon, minLat + size],
          [minLon, minLat],
        ],
      ],
    },
  };
}

describe("geospax v0.4.0 suitability (WLC)", () => {
  it("wlc weighted mean with benefit/cost", () => {
    const r = wlc([
      { id: "a", weight: 2, score: 0.8, benefit: true },
      { id: "b", weight: 1, score: 0.2, benefit: false },
    ]);
    assert.ok(r);
    // a 0.8*0.666=0.533, b cost 1-0.2=0.8*0.333=0.267 => 0.8
    assert.ok(Math.abs(r!.suitability - 0.8) < 0.001);
  });
  it("normalizes scores >1 via /100", () => {
    const r = wlc([{ id: "a", weight: 1, score: 80, benefit: true }]);
    assert.equal(r?.suitability, 0.8);
    assert.equal(r?.normalized, true);
  });
  it("zero weight total → null", () => {
    assert.equal(wlc([{ id: "a", weight: 0, score: 0.5, benefit: true }]), null);
  });
  it("distanceDecay half-life", () => {
    assert.equal(distanceDecay(0, 100), 1);
    assert.ok(Math.abs(distanceDecay(100, 100) - 0.5) < 1e-9);
    assert.ok(distanceDecay(200, 100) < 0.26);
  });
  it("clamp01 false allows >1", () => {
    const r = wlc([{ id: "a", weight: 1, score: 1.5, benefit: true }], {
      clamp01: false,
      normalizeScores: false,
    });
    assert.equal(r?.suitability, 1.5);
  });
});

describe("fragmentation patch metrics", () => {
  it("shapeIndex 1 for circle-like, >1 for elongated", () => {
    const sq = square(0, 0, 0.01);
    const m = patchMetrics(sq, "sq");
    assert.ok(m);
    assert.ok(m!.shapeIndex > 1 && m!.shapeIndex < 1.3);
    assert.ok(m!.edgeDensity > 0);
  });
  it("summarizeFragmentation aggregates", () => {
    const a = patchMetrics(square(0, 0, 0.01), "a")!;
    const b = patchMetrics(square(1, 1, 0.02), "b")!;
    const s = summarizeFragmentation([a, b]);
    assert.equal(s.patchCount, 2);
    assert.ok(s.totalAreaHa > a.areaHa);
    assert.ok(s.meanShapeIndex > 1);
  });
  it("empty summarize returns zeros", () => {
    const s = summarizeFragmentation([]);
    assert.equal(s.patchCount, 0);
  });
});

describe("connectivity graph", () => {
  it("edges within maxDistanceM", () => {
    const patches = [square(0, 0, 0.01), square(0.01, 0, 0.01), square(10, 10, 0.01)];
    const g = connectivityGraph(patches as any, { maxDistanceM: 5000 });
    assert.ok(g);
    assert.equal(g!.nodes.length, 3);
    assert.ok(g!.edges.length >= 1);
    const summary = connectivitySummary(g!);
    assert.equal(summary.edgeCount, g!.edges.length);
  });
  it("null on bad input", () => {
    assert.equal(connectivityGraph([], { maxDistanceM: 1000 }), null);
    assert.equal(connectivityGraph([square(0, 0, 0.01)] as any, { maxDistanceM: -1 }), null);
  });
  it("isolated count", () => {
    const patches = [square(0, 0, 0.01), square(10, 10, 0.01)];
    const g = connectivityGraph(patches as any, { maxDistanceM: 1000 })!;
    const s = connectivitySummary(g);
    assert.equal(s.isolatedCount, 2);
    assert.equal(s.componentCount, 2);
  });
});

describe("statistics descriptive", () => {
  it("mean/median/stddev", () => {
    const s = descriptiveStats([1, 2, 3, 4, 5]);
    assert.equal(s.min, 1);
    assert.equal(s.max, 5);
    assert.equal(s.mean, 3);
    assert.equal(s.median, 3);
    assert.ok(Math.abs(s.stddev! - Math.sqrt(2)) < 1e-6);
  });
  it("handles nodata", () => {
    const s = descriptiveStats([1, -9999, 2, -9999], -9999);
    assert.equal(s.valid, 2);
    assert.equal(s.nodata, 2);
  });
  it("zonalMean", () => {
    const zm = zonalMean([
      { zoneId: "A", values: [1, 2, 3] },
      { zoneId: "B", values: [10, 20] },
    ]);
    assert.equal(zm["A"], 2);
    assert.equal(zm["B"], 15);
  });
});

describe("change detection", () => {
  it("differenceGrid", () => {
    const d = differenceGrid([5, 10], [3, 7], 2, 1, null, null);
    assert.equal(d.diff[0], 2);
    assert.equal(d.diff[1], 3);
    assert.equal(d.validCells, 2);
  });
  it("nodata handling", () => {
    const d = differenceGrid([5, -9999], [3, 7], 2, 1, -9999, null);
    assert.ok(!Number.isFinite(d.diff[1]));
    assert.equal(d.nodataCells, 1);
  });
  it("changeOtsu works", () => {
    const d = differenceGrid([10, 10, 0, 0], [0, 0, 10, 10], 4, 1, null, null);
    const co = changeOtsu(d.diff);
    assert.ok(co.histogram);
  });
});

describe("hydrology D8", () => {
  it("isD8 valid codes", () => {
    assert.equal(isD8(1), true);
    assert.equal(isD8(4), true);
    assert.equal(isD8(3), false);
    assert.equal(isD8(256), false);
  });
  it("d8Coverage", () => {
    const c = d8Coverage([1, 2, 4, 99, -9999], -9999);
    assert.equal(c.valid, 3); // 1,2,4
    assert.ok(c.coverage < 1);
  });
  it("basinStats", () => {
    const b = basinStats([100, 200, 300]);
    assert.equal(b.count, 3);
    assert.equal(b.totalCells, 600);
  });
});

describe("biodiversity indices", () => {
  it("richness", () => {
    assert.equal(
      richness([
        ["a", "b"],
        ["b", "c"],
      ]),
      3,
    );
  });
  it("shannon", () => {
    const h = shannon([10, 10, 10]);
    assert.ok(Math.abs(h! - Math.log(3)) < 1e-6);
    assert.equal(shannon([0, 0]), null);
    assert.equal(shannon([]), null);
  });
  it("simpson", () => {
    const d = simpson([5, 5]);
    assert.ok(d! > 0 && d! < 1);
    assert.equal(simpson([1]), null);
  });
});

describe("classification breaks", () => {
  it("equalInterval", () => {
    const br = equalInterval([0, 10, 20, 30], 3);
    assert.deepEqual(br, [10, 20, 30]);
  });
  it("jenks natural breaks — valid optima", () => {
    const br = jenksBreaks([0, 10, 20], 2)!;
    assert.equal(br.length, 2);
    assert.equal(br[1], 20);
    assert.ok(br[0] >= 0 && br[0] <= 20);
    assert.ok(br[0] <= br[1]);
    // also works on bimodal data where jenks diverges from equalInterval
    const bimodal = [0, 0, 0, 10, 10, 10, 20, 20, 20];
    const jb = jenksBreaks(bimodal, 3)!;
    assert.equal(jb.length, 3);
    assert.equal(jb[2], 20);
  });
  it("null on empty", () => {
    assert.equal(equalInterval([], 3), null);
  });
});

describe("SDM audit-fixed guards", () => {
  it("fitBioclim percentile", () => {
    const pres = [
      [5, 10],
      [6, 11],
      [7, 12],
      [8, 13],
      [100, 100],
    ];
    const env = fitBioclim(pres, ["bio1", "bio12"], { percentile: 30 });
    assert.ok(env);
    // 30th pct trims outliers: pHigh should be < max=100
    assert.ok(env!.pLow[0] >= 5);
    assert.ok(env!.pHigh[0] < 100);
    assert.ok(env!.pHigh[0] >= 7);
  });
  it("fitBioclim null on empty", () => {
    assert.equal(fitBioclim([]), null);
  });
  it("fitMahalanobis 2D", () => {
    const pres = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const m = fitMahalanobis(pres);
    assert.ok(m);
    assert.equal(m!.singular, false);
    assert.equal(m!.invCov?.length, 2);
  });
  it("fitMahalanobis singular detection", () => {
    const pres = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    const m = fitMahalanobis(pres);
    assert.ok(m);
    assert.equal(m!.singular, true);
  });
});

describe("SCP greedy exact fallback", () => {
  it("covers all species", async () => {
    const problem = {
      costs: [1, 2, 1],
      speciesCoverage: [
        [1, 0, 1],
        [0, 1, 1],
      ],
      targets: [1, 1],
    };
    const sol = solveScpGreedy(problem);
    assert.ok(sol.selected.length >= 1);
    assert.ok(sol.coverage[0] >= 1 && sol.coverage[1] >= 1);
    assert.equal(sol.optimal, false);
  });
  it("exact falls back to greedy", async () => {
    const problem = { costs: [1, 1], speciesCoverage: [[1, 0]], targets: [1] };
    const sol = await import("../src/analysis/scp").then((m) =>
      m.solveScpExact(problem),
    );
    assert.ok(sol.selected.length > 0);
  });
});
