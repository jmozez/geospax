// Golden-value tests for @geospax/analysis SDM evaluation. Expected values are
// derived by hand (Mann–Whitney pair counts, explicit confusion tables), so
// they match R's pROC/ecospat definitions without depending on them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boyceIndex,
  crossValidateSdm,
  fitPresenceBackgroundLogistic,
  maxTssThreshold,
  predictPresenceBackgroundLogistic,
  rocAuc,
  spatialBlockFolds,
  spearman,
  thresholdMetrics,
} from "../src/analysis/index";

describe("rocAuc", () => {
  it("is 1 for perfect separation and 0 for inverted", () => {
    assert.equal(rocAuc([0.8, 0.9], [0.1, 0.2, 0.3]), 1);
    assert.equal(rocAuc([0.1, 0.2], [0.8, 0.9]), 0);
  });

  it("counts ties as one half", () => {
    assert.equal(rocAuc([0.5, 0.5], [0.5, 0.5]), 0.5);
    // Pairs: (0.6>0.4)=1, (0.6>0.6)=½, (0.4>0.4)=½, (0.4>0.6)=0 → 2/4
    assert.equal(rocAuc([0.6, 0.4], [0.4, 0.6]), 0.5);
  });

  it("matches a hand-counted pair tally", () => {
    // P={0.9,0.6,0.3}, B={0.7,0.4,0.2,0.1}
    // 0.9 beats 4; 0.6 beats 3; 0.3 beats 2 → 9/12
    assert.equal(rocAuc([0.9, 0.6, 0.3], [0.7, 0.4, 0.2, 0.1]), 0.75);
  });

  it("drops non-finite scores and returns null for an empty class", () => {
    assert.equal(rocAuc([0.9, null, Number.NaN], [0.1]), 1);
    assert.equal(rocAuc([], [0.1]), null);
    assert.equal(rocAuc([0.4], [null]), null);
  });
});

describe("threshold metrics", () => {
  const P = [0.9, 0.6, 0.3];
  const B = [0.7, 0.4, 0.2, 0.1];

  it("computes sensitivity, specificity and TSS at a fixed threshold", () => {
    const m = thresholdMetrics(P, B, 0.5)!;
    assert.equal(m.sensitivity, 2 / 3);
    assert.equal(m.specificity, 3 / 4);
    assert.ok(Math.abs(m.tss - (2 / 3 + 3 / 4 - 1)) < 1e-12);
  });

  it("finds the TSS-maximising threshold", () => {
    // Candidates: 0.3 → sens 1, spec 2/4 → 0.5; 0.6 → 2/3 + 3/4 − 1 ≈ 0.417
    const best = maxTssThreshold(P, B)!;
    assert.equal(best.threshold, 0.3);
    assert.equal(best.tss, 0.5);
  });
});

describe("spearman", () => {
  it("is ±1 for monotone data and null for constant input", () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 25, 100]), 1);
    assert.equal(spearman([1, 2, 3], [3, 2, 1]), -1);
    assert.equal(spearman([1, 2, 3], [5, 5, 5]), null);
  });
});

describe("boyceIndex", () => {
  it("is 1 when presences concentrate monotonically at high suitability", () => {
    const background = Array.from({ length: 101 }, (_, i) => i / 100);
    // Presence density ∝ score: score s appears round(10·s) times.
    const presence = background.flatMap((s) =>
      Array(Math.round(10 * s)).fill(s)
    );
    const result = boyceIndex(presence, background, {
      windowFraction: 0.1,
      steps: 11,
    });
    assert.ok(result.index! > 0.95, `expected near 1, got ${result.index}`);
  });

  it("is negative when presences sit at low suitability", () => {
    const background = Array.from({ length: 101 }, (_, i) => i / 100);
    const presence = background.filter((s) => s < 0.3);
    const result = boyceIndex(presence, background, {
      windowFraction: 0.1,
      steps: 11,
    });
    assert.ok(result.index! < 0, `expected negative, got ${result.index}`);
  });

  it("returns null for degenerate input", () => {
    assert.equal(boyceIndex([0.5], [0.5, 0.5]).index, null);
    assert.equal(boyceIndex([], [0.1, 0.9]).index, null);
  });

  it("is not computed for binary or near-binary scores", () => {
    // Limiting-factor BIOCLIM output: only 0 and 1.
    const background = [...Array(50).fill(0), ...Array(50).fill(1)];
    assert.equal(boyceIndex([1, 1, 0, 1], background).index, null);
  });
});

describe("spatialBlockFolds", () => {
  it("keeps every point in a block in the same fold and is reproducible", () => {
    const coords: Array<[number, number]> = [];
    for (let lon = 140; lon < 150; lon += 0.5)
      for (let lat = -10; lat < -2; lat += 0.5) coords.push([lon, lat]);
    const a = spatialBlockFolds(coords, { blockSizeDeg: 2, k: 4, seed: 7 })!;
    const b = spatialBlockFolds(coords, { blockSizeDeg: 2, k: 4, seed: 7 })!;
    assert.deepEqual(a.folds, b.folds);
    assert.equal(a.blockCount, 5 * 4);
    const foldOfBlock = new Map<string, number>();
    a.blocks.forEach((key, i) => {
      if (foldOfBlock.has(key!))
        assert.equal(foldOfBlock.get(key!), a.folds[i]);
      else foldOfBlock.set(key!, a.folds[i]);
    });
    // 20 blocks dealt round-robin into 4 folds → 5 blocks each.
    const perFold = [0, 0, 0, 0];
    for (const fold of foldOfBlock.values()) perFold[fold]++;
    assert.deepEqual(perFold, [5, 5, 5, 5]);
  });

  it("flags invalid coordinates and rejects bad options", () => {
    const r = spatialBlockFolds(
      [
        [Number.NaN, 0],
        [0, 0],
      ],
      { k: 2 }
    )!;
    assert.equal(r.folds[0], -1);
    assert.equal(spatialBlockFolds([[0, 0]], { k: 1 }), null);
    assert.equal(spatialBlockFolds([[0, 0]], { blockSizeDeg: 0 }), null);
  });
});

describe("crossValidateSdm", () => {
  // Synthetic species: present where the (single) covariate is high.
  // Covariate = latitude-driven gradient plus a fixed pseudo-random wobble.
  const presences: number[][] = [];
  const presenceCoords: Array<[number, number]> = [];
  const background: number[][] = [];
  const backgroundCoords: Array<[number, number]> = [];
  let i = 0;
  for (let lon = 140; lon < 150; lon += 0.25) {
    for (let lat = -10; lat < -2; lat += 0.25) {
      const env = lat + 10 + ((i * 37) % 11) / 11;
      i++;
      backgroundCoords.push([lon, lat]);
      background.push([env]);
      if (env > 6) {
        presenceCoords.push([lon, lat]);
        presences.push([env]);
      }
    }
  }

  it("scores a well-specified model highly on held-out blocks", () => {
    const result = crossValidateSdm({
      presences,
      presenceCoords,
      background,
      backgroundCoords,
      fit: (p, b) => fitPresenceBackgroundLogistic(p, b),
      predict: (row, model) => predictPresenceBackgroundLogistic(row, model),
      blocks: { blockSizeDeg: 2, k: 5, seed: 1 },
    })!;
    assert.equal(result.folds.length, 5);
    assert.ok(result.auc.n >= 1);
    assert.ok(result.auc.mean! > 0.75, `AUC ${result.auc.mean}`);
    assert.ok(result.tss.mean! > 0.4, `TSS ${result.tss.mean}`);
    // Held-out blocks span a narrow slice of the gradient, so blocked CV must
    // be more conservative than in-sample (resubstitution) AUC.
    const model = fitPresenceBackgroundLogistic(presences, background)!;
    const inSample = rocAuc(
      presences.map((row) => predictPresenceBackgroundLogistic(row, model)),
      background.map((row) => predictPresenceBackgroundLogistic(row, model))
    )!;
    assert.ok(
      inSample > result.auc.mean!,
      `in-sample ${inSample} vs CV ${result.auc.mean}`
    );
    assert.equal(result.provenance.tool, "sdm-cross-validation");
    for (const fold of result.folds) {
      if (!fold.skipped) {
        assert.equal(
          fold.trainPresences + fold.testPresences,
          presences.length
        );
        assert.equal(
          fold.trainBackground + fold.testBackground,
          background.length
        );
      }
    }
  });

  it("reports skipped folds instead of dropping them", () => {
    const result = crossValidateSdm({
      presences: [[1], [2]],
      presenceCoords: [
        [0.5, 0.5],
        [0.6, 0.6],
      ],
      background: [[0], [3]],
      backgroundCoords: [
        [5.5, 5.5],
        [5.6, 5.6],
      ],
      fit: () => ({}),
      predict: (row) => row[0],
      blocks: { k: 2 },
    })!;
    assert.equal(result.folds.length, 2);
    assert.ok(result.folds.every((fold) => fold.skipped));
    assert.equal(result.auc.mean, null);
  });

  it("rejects mismatched coordinate arrays", () => {
    const fit = () => ({});
    const predict = () => 0;
    assert.equal(
      crossValidateSdm({
        presences: [[1]],
        presenceCoords: [],
        background: [],
        backgroundCoords: [],
        fit,
        predict,
      }),
      null
    );
  });
});
