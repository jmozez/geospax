// Spatial conservation planning as a minimum-cost representation problem.
//
// Small/medium problems are solved exactly with deterministic branch-and-bound.
// Larger or node-limited problems return an explicitly labelled greedy
// solution. No result claims HiGHS, MILP or optimality unless this module has
// actually proved it.

export interface ScpProblem {
  /** Non-negative planning-unit costs. */
  costs: number[];
  /** Species × planning-unit representation amounts (binary or continuous). */
  speciesCoverage: number[][];
  /** Required representation amount per species. */
  targets: number[];
}

export type ScpMethod = "branch-and-bound" | "greedy";

export interface ScpSolution {
  selected: number[];
  cost: number;
  coverage: number[];
  optimal: boolean;
  feasible: boolean;
  method: ScpMethod;
  nodesVisited?: number;
  warning?: string;
}

function validProblem(problem: ScpProblem): boolean {
  const unitCount = problem?.costs?.length ?? 0;
  return (
    unitCount > 0 &&
    problem.targets?.length > 0 &&
    problem.targets.every((target) => Number.isFinite(target) && target >= 0) &&
    problem.costs.every((cost) => Number.isFinite(cost) && cost >= 0) &&
    problem.speciesCoverage.length === problem.targets.length &&
    problem.speciesCoverage.every(
      (row) =>
        row.length === unitCount && row.every((amount) => Number.isFinite(amount) && amount >= 0),
    )
  );
}

function covered(coverage: number[], targets: number[]): boolean {
  return coverage.every((amount, species) => amount + 1e-12 >= targets[species]);
}

function greedy(problem: ScpProblem): ScpSolution {
  if (!validProblem(problem)) {
    return {
      selected: [],
      cost: 0,
      coverage: new Array(problem?.targets?.length ?? 0).fill(0),
      optimal: false,
      feasible: false,
      method: "greedy",
      warning:
        "Invalid SCP problem: costs, targets and coverage must be finite, non-negative and rectangular.",
    };
  }
  const { costs, speciesCoverage, targets } = problem;
  const coverage = new Array(targets.length).fill(0);
  const selected: number[] = [];
  const used = new Set<number>();
  while (!covered(coverage, targets)) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let unit = 0; unit < costs.length; unit++) {
      if (used.has(unit)) continue;
      let gain = 0;
      for (let species = 0; species < targets.length; species++) {
        const shortfall = Math.max(0, targets[species] - coverage[species]);
        gain += Math.min(shortfall, speciesCoverage[species][unit]);
      }
      if (gain <= 0) continue;
      const score = gain / Math.max(1e-12, costs[unit]);
      if (score > bestScore || (score === bestScore && unit < bestIndex)) {
        bestScore = score;
        bestIndex = unit;
      }
    }
    if (bestIndex === -1) break;
    used.add(bestIndex);
    selected.push(bestIndex);
    for (let species = 0; species < targets.length; species++) {
      coverage[species] += speciesCoverage[species][bestIndex];
    }
  }
  selected.sort((a, b) => a - b);
  return {
    selected,
    cost: selected.reduce((sum, unit) => sum + costs[unit], 0),
    coverage,
    optimal: false,
    feasible: covered(coverage, targets),
    method: "greedy",
  };
}

export interface ScpExactOptions {
  /** Maximum units considered by the in-browser exact solver (default 28). */
  maxUnits?: number;
  /** Abort exact search after this many nodes and return labelled greedy (default 2,000,000). */
  maxNodes?: number;
}

/**
 * Exact minimum-cost selection for bounded problems. The Promise signature is
 * retained for compatibility with the former advertised HiGHS hook.
 */
export async function solveScpExact(
  problem: ScpProblem,
  optionsOrLegacyHighs: ScpExactOptions | { solve: (lp: unknown) => unknown } = {},
): Promise<ScpSolution> {
  if (!validProblem(problem)) return greedy(problem);
  const options: ScpExactOptions = "solve" in optionsOrLegacyHighs ? {} : optionsOrLegacyHighs;
  const maxUnits = options.maxUnits ?? 28;
  const maxNodes = options.maxNodes ?? 2_000_000;
  const baseline = greedy(problem);
  if (!baseline.feasible) {
    return {
      ...baseline,
      warning: "Representation targets are infeasible with the supplied planning units.",
    };
  }
  if (problem.costs.length > maxUnits) {
    return {
      ...baseline,
      warning: `Exact branch-and-bound is limited to ${maxUnits} planning units in-browser; returned the greedy solution for ${problem.costs.length} units.`,
    };
  }

  const speciesCount = problem.targets.length;
  const units = problem.costs.map((cost, index) => {
    const totalPotential = problem.speciesCoverage.reduce(
      (sum, row, species) => sum + Math.min(problem.targets[species], row[index]),
      0,
    );
    return {
      original: index,
      cost,
      efficiency: totalPotential / Math.max(1e-12, cost),
    };
  });
  units.sort((a, b) => b.efficiency - a.efficiency || a.cost - b.cost || a.original - b.original);

  // Suffix representation gives a strong feasibility prune at every node.
  const suffix = Array.from({ length: units.length + 1 }, () => new Array(speciesCount).fill(0));
  for (let depth = units.length - 1; depth >= 0; depth--) {
    const unit = units[depth].original;
    for (let species = 0; species < speciesCount; species++) {
      suffix[depth][species] = suffix[depth + 1][species] + problem.speciesCoverage[species][unit];
    }
  }

  let bestCost = baseline.cost;
  let bestSelected = [...baseline.selected];
  let bestCoverage = [...baseline.coverage];
  let nodesVisited = 0;
  let aborted = false;
  const coverage = new Array(speciesCount).fill(0);
  const chosen: number[] = [];

  const search = (depth: number, cost: number): void => {
    if (aborted) return;
    nodesVisited++;
    if (nodesVisited > maxNodes) {
      aborted = true;
      return;
    }
    if (cost >= bestCost - 1e-12) return;
    if (covered(coverage, problem.targets)) {
      bestCost = cost;
      bestSelected = [...chosen].sort((a, b) => a - b);
      bestCoverage = [...coverage];
      return;
    }
    if (depth >= units.length) return;
    for (let species = 0; species < speciesCount; species++) {
      if (coverage[species] + suffix[depth][species] + 1e-12 < problem.targets[species]) return;
    }

    // Fractional single-species lower bound. Taking the maximum across species
    // is admissible (never overstates the extra cost needed).
    let lowerBound = 0;
    for (let species = 0; species < speciesCount; species++) {
      let shortfall = Math.max(0, problem.targets[species] - coverage[species]);
      if (shortfall <= 0) continue;
      const candidates = units
        .slice(depth)
        .map((unit) => ({
          amount: problem.speciesCoverage[species][unit.original],
          ratio:
            problem.speciesCoverage[species][unit.original] > 0
              ? unit.cost / problem.speciesCoverage[species][unit.original]
              : Number.POSITIVE_INFINITY,
        }))
        .filter((candidate) => candidate.amount > 0)
        .sort((a, b) => a.ratio - b.ratio);
      let bound = 0;
      for (const candidate of candidates) {
        const amount = Math.min(shortfall, candidate.amount);
        bound += amount * candidate.ratio;
        shortfall -= amount;
        if (shortfall <= 1e-12) break;
      }
      lowerBound = Math.max(lowerBound, bound);
    }
    if (cost + lowerBound >= bestCost - 1e-12) return;

    const unit = units[depth];
    // Include first: good incumbents tighten subsequent pruning.
    chosen.push(unit.original);
    for (let species = 0; species < speciesCount; species++) {
      coverage[species] += problem.speciesCoverage[species][unit.original];
    }
    search(depth + 1, cost + unit.cost);
    for (let species = 0; species < speciesCount; species++) {
      coverage[species] -= problem.speciesCoverage[species][unit.original];
    }
    chosen.pop();

    search(depth + 1, cost);
  };

  // If the greedy baseline is the optimum, the strict `cost >= bestCost` prune
  // still proves it by exhausting every potentially cheaper branch.
  search(0, 0);
  if (aborted) {
    return {
      ...baseline,
      nodesVisited,
      warning: `Exact branch-and-bound reached the ${maxNodes.toLocaleString()}-node safety limit; returned the explicitly non-optimal greedy solution.`,
    };
  }
  return {
    selected: bestSelected,
    cost: bestCost,
    coverage: bestCoverage,
    optimal: true,
    feasible: true,
    method: "branch-and-bound",
    nodesVisited,
  };
}

export function solveScpGreedy(problem: ScpProblem): ScpSolution {
  return greedy(problem);
}
