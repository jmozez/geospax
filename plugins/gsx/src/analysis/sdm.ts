// Species-distribution modelling: audit-fixed BIOCLIM and Mahalanobis.
//
// This module fits and *predicts* both models. It never falls back to longitude/
// latitude or Euclidean distance when environmental data/covariance are
// inadequate. Missing rows are excluded and counted by callers; a singular
// covariance is ridge-regularised and explicitly marked on the model.

import { makeProvenance, type ProvenanceStamp } from "./provenance";

export const SDM_VERSION = "2.0.0";

/** Linearly interpolated percentile, p in [0, 1]. */
export function percentile(sortedValues: number[], p: number): number | null {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const bounded = Math.max(0, Math.min(1, p));
  const index = (sortedValues.length - 1) * bounded;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sortedValues[low];
  return sortedValues[low] + (sortedValues[high] - sortedValues[low]) * (index - low);
}

export interface BioclimEnvelope {
  variables: string[];
  min: number[];
  max: number[];
  pLow: number[];
  pHigh: number[];
  percentile: number;
  n: number;
}

export interface BioclimOptions {
  /** Symmetric tail trim in percent, 0–49.9 (default 5). */
  percentile?: number;
}

function matrixWidth(matrix: number[][]): number {
  return matrix[0]?.length ?? 0;
}

function completeRows(matrix: number[][], width: number): number[][] {
  return (matrix ?? []).filter(
    (row) => row.length === width && row.every((value) => Number.isFinite(value)),
  );
}

/** Fit percentile envelopes from a complete n×p environmental matrix. */
export function fitBioclim(
  presences: number[][],
  variableNames: string[] = [],
  options: BioclimOptions = {},
): BioclimEnvelope | null {
  const p = matrixWidth(presences);
  if (!p) return null;
  const complete = completeRows(presences, p);
  if (!complete.length) return null;
  const trim = options.percentile ?? 5;
  if (!Number.isFinite(trim) || trim < 0 || trim >= 50) return null;
  const lowQ = trim / 100;
  const highQ = 1 - lowQ;
  const min: number[] = [];
  const max: number[] = [];
  const pLow: number[] = [];
  const pHigh: number[] = [];
  for (let variable = 0; variable < p; variable++) {
    const values = complete.map((row) => row[variable]).sort((a, b) => a - b);
    min.push(values[0]);
    max.push(values[values.length - 1]);
    pLow.push(percentile(values, lowQ) as number);
    pHigh.push(percentile(values, highQ) as number);
  }
  return {
    variables:
      variableNames.length === p
        ? variableNames
        : Array.from({ length: p }, (_, index) => `var${index + 1}`),
    min,
    max,
    pLow,
    pHigh,
    percentile: trim,
    n: complete.length,
  };
}

export type BioclimMode = "limiting" | "proportion";

export interface BioclimPrediction {
  suitability: number | null;
  evaluated: number;
  inEnvelope: number;
  limitingVariables: string[];
}

/** Score one environmental vector against a fitted BIOCLIM envelope. */
export function predictBioclim(
  values: number[],
  model: BioclimEnvelope,
  mode: BioclimMode = "limiting",
): BioclimPrediction {
  if (values.length !== model.variables.length) {
    return { suitability: null, evaluated: 0, inEnvelope: 0, limitingVariables: [] };
  }
  let evaluated = 0;
  let inEnvelope = 0;
  const limitingVariables: string[] = [];
  for (let variable = 0; variable < values.length; variable++) {
    const value = values[variable];
    if (!Number.isFinite(value)) continue;
    evaluated++;
    if (value >= model.pLow[variable] && value <= model.pHigh[variable]) {
      inEnvelope++;
    } else {
      limitingVariables.push(model.variables[variable]);
    }
  }
  if (evaluated !== values.length || evaluated === 0) {
    return { suitability: null, evaluated, inEnvelope, limitingVariables };
  }
  return {
    suitability: mode === "limiting" ? (inEnvelope === evaluated ? 1 : 0) : inEnvelope / evaluated,
    evaluated,
    inEnvelope,
    limitingVariables,
  };
}

export function predictBioclimMatrix(
  matrix: number[][],
  model: BioclimEnvelope,
  mode: BioclimMode = "limiting",
): BioclimPrediction[] {
  return matrix.map((row) => predictBioclim(row, model, mode));
}

export interface MatrixInverseResult {
  inverse: number[][] | null;
  singular: boolean;
  ridge: number;
}

function gaussJordan(matrix: number[][], tolerance = 1e-12): number[][] | null {
  const n = matrix.length;
  if (!n || matrix.some((row) => row.length !== n)) return null;
  const augmented = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: n }, (_, column) => (column === index ? 1 : 0)),
  ]);
  for (let column = 0; column < n; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) {
        pivotRow = row;
      }
    }
    if (
      !Number.isFinite(augmented[pivotRow][column]) ||
      Math.abs(augmented[pivotRow][column]) <= tolerance
    ) {
      return null;
    }
    if (pivotRow !== column) {
      [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];
    }
    const pivot = augmented[column][column];
    for (let value = 0; value < n * 2; value++) augmented[column][value] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let value = 0; value < n * 2; value++) {
        augmented[row][value] -= factor * augmented[column][value];
      }
    }
  }
  return augmented.map((row) => row.slice(n));
}

/** General covariance inversion with disclosed ridge regularisation. */
export function invertMatrixSafe(matrix: number[][]): MatrixInverseResult {
  const direct = gaussJordan(matrix);
  if (direct) return { inverse: direct, singular: false, ridge: 0 };
  const n = matrix.length;
  if (!n) return { inverse: null, singular: true, ridge: 0 };
  const diagonalScale = matrix.reduce((sum, row, index) => sum + Math.abs(row[index] ?? 0), 0) / n;
  let ridge = Math.max(1e-10, diagonalScale * 1e-8);
  for (let attempt = 0; attempt < 8; attempt++) {
    const regularized = matrix.map((row, rowIndex) =>
      row.map((value, columnIndex) => value + (rowIndex === columnIndex ? ridge : 0)),
    );
    const inverse = gaussJordan(regularized);
    if (inverse) return { inverse, singular: true, ridge };
    ridge *= 10;
  }
  return { inverse: null, singular: true, ridge };
}

export interface MahalanobisModel {
  mean: number[];
  cov: number[][];
  invCov: number[][] | null;
  variables: string[];
  n: number;
  singular: boolean;
  regularized: boolean;
  ridge: number;
  recordsDropped: number;
}

function meanVector(data: number[][]): number[] {
  const p = data[0].length;
  const mean = new Array(p).fill(0);
  for (const row of data) {
    for (let variable = 0; variable < p; variable++) mean[variable] += row[variable];
  }
  for (let variable = 0; variable < p; variable++) mean[variable] /= data.length;
  return mean;
}

export function covarianceMatrix(data: number[][], mean: number[]): number[][] {
  const p = mean.length;
  const covariance = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const row of data) {
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) {
        covariance[a][b] += (row[a] - mean[a]) * (row[b] - mean[b]);
      }
    }
  }
  const denominator = Math.max(1, data.length - 1);
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) covariance[a][b] /= denominator;
  }
  return covariance;
}

/** Fit a p-variable Mahalanobis model; no p>2 Euclidean fallback. */
export function fitMahalanobis(
  presences: number[][],
  variableNames: string[] = [],
): MahalanobisModel | null {
  const p = matrixWidth(presences);
  if (p < 2) return null;
  const complete = completeRows(presences, p);
  if (complete.length < 2) return null;
  const mean = meanVector(complete);
  const cov = covarianceMatrix(complete, mean);
  const inversion = invertMatrixSafe(cov);
  return {
    mean,
    cov,
    invCov: inversion.inverse,
    variables:
      variableNames.length === p
        ? variableNames
        : Array.from({ length: p }, (_, index) => `var${index + 1}`),
    n: complete.length,
    singular: inversion.singular,
    regularized: inversion.singular && inversion.inverse !== null,
    ridge: inversion.ridge,
    recordsDropped: presences.length - complete.length,
  };
}

/** Squared Mahalanobis distance, or null when the fitted inverse is unavailable. */
export function mahalanobisD2(values: number[], model: MahalanobisModel): number | null {
  if (
    !model.invCov ||
    values.length !== model.mean.length ||
    values.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }
  const delta = values.map((value, index) => value - model.mean[index]);
  let distance = 0;
  for (let row = 0; row < delta.length; row++) {
    for (let column = 0; column < delta.length; column++) {
      distance += delta[row] * model.invCov[row][column] * delta[column];
    }
  }
  // Floating-point cancellation can yield tiny negative values.
  return Math.max(0, distance);
}

function logGamma(z: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const shifted = z - 1;
  let x = 0.9999999999998099;
  for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (shifted + i + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function gammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN;
  if (x === 0) return 0;
  const gammaLog = logGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let delta = sum;
    for (let iteration = 1; iteration < 300; iteration++) {
      ap++;
      delta *= x / ap;
      sum += delta;
      if (Math.abs(delta) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaLog);
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let iteration = 1; iteration < 300; iteration++) {
    const an = -iteration * (iteration - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const factor = d * c;
    h *= factor;
    if (Math.abs(factor - 1) < 1e-12) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - gammaLog) * h;
  return 1 - q;
}

/** Survival probability P(X > x) for a chi-square variate. */
export function chiSquareSurvival(x: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(degreesOfFreedom) || degreesOfFreedom <= 0) {
    return Number.NaN;
  }
  if (x <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - gammaP(degreesOfFreedom / 2, x / 2)));
}

export type MahalanobisOutput = "chisq" | "index";

export interface MahalanobisPrediction {
  suitability: number | null;
  d2: number | null;
  output: MahalanobisOutput;
}

export function predictMahalanobis(
  values: number[],
  model: MahalanobisModel,
  output: MahalanobisOutput = "chisq",
): MahalanobisPrediction {
  const d2 = mahalanobisD2(values, model);
  if (d2 === null) return { suitability: null, d2: null, output };
  return {
    d2,
    output,
    suitability:
      output === "chisq" ? chiSquareSurvival(d2, model.mean.length) : 1 / (1 + Math.sqrt(d2)),
  };
}

export function predictMahalanobisMatrix(
  matrix: number[][],
  model: MahalanobisModel,
  output: MahalanobisOutput = "chisq",
): MahalanobisPrediction[] {
  return matrix.map((row) => predictMahalanobis(row, model, output));
}

export interface PresenceBackgroundLogisticOptions {
  /** L2 penalty on standardised predictor coefficients (default 0.01). */
  lambda?: number;
  /** Newton iterations (default 100). */
  maxIterations?: number;
  /** Parameter/loss convergence tolerance (default 1e-7). */
  tolerance?: number;
}

export interface PresenceBackgroundLogisticModel {
  variables: string[];
  mean: number[];
  scale: number[];
  coefficients: number[];
  intercept: number;
  lambda: number;
  nPresences: number;
  nBackground: number;
  iterations: number;
  converged: boolean;
  loss: number;
  constantVariables: string[];
  optimizerRidge: number;
  method: "presence-background-logistic";
}

function logistic(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function softplus(value: number): number {
  return value > 0 ? value + Math.log1p(Math.exp(-value)) : Math.log1p(Math.exp(value));
}

function logisticObjective(
  rows: number[][],
  labels: number[],
  weights: number[],
  parameters: number[],
  lambda: number,
): number {
  let loss = 0;
  for (let row = 0; row < rows.length; row++) {
    let linear = parameters[0];
    for (let variable = 0; variable < rows[row].length; variable++) {
      linear += parameters[variable + 1] * rows[row][variable];
    }
    loss += weights[row] * (softplus(linear) - labels[row] * linear);
  }
  for (let parameter = 1; parameter < parameters.length; parameter++) {
    loss += 0.5 * lambda * parameters[parameter] ** 2;
  }
  return loss;
}

/**
 * Fit the deterministic linear logistic fallback used when full elapid MaxEnt
 * is unavailable. Unlike the original v1 fallback, this requires explicit
 * environmental background rows; it never invents pseudo-absence values from
 * the presence range or interpolates a prediction grid from presence points.
 *
 * The two classes receive equal total weight. Scores are therefore relative
 * presence-versus-background suitability, not calibrated occurrence
 * probabilities and not a claim that elapid/MaxEnt ran.
 */
export function fitPresenceBackgroundLogistic(
  presences: number[][],
  background: number[][],
  variableNames: string[] = [],
  options: PresenceBackgroundLogisticOptions = {},
): PresenceBackgroundLogisticModel | null {
  const width = matrixWidth(presences);
  if (!width || presences.length < 2 || background.length < 2) return null;
  if (
    presences.some((row) => row.length !== width || row.some((value) => !Number.isFinite(value))) ||
    background.some((row) => row.length !== width || row.some((value) => !Number.isFinite(value)))
  ) {
    return null;
  }
  const lambda = options.lambda ?? 0.01;
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-7;
  if (
    !Number.isFinite(lambda) ||
    lambda < 0 ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0
  ) {
    return null;
  }

  const variables =
    variableNames.length === width
      ? variableNames
      : Array.from({ length: width }, (_, index) => `var${index + 1}`);
  const rawRows = [...presences, ...background];
  const labels = [...new Array(presences.length).fill(1), ...new Array(background.length).fill(0)];
  // Equal class totals prevent an arbitrary background count from changing the
  // fitted intercept and swamping the presence class.
  const weights = [
    ...new Array(presences.length).fill(0.5 / presences.length),
    ...new Array(background.length).fill(0.5 / background.length),
  ];
  const mean = new Array(width).fill(0);
  for (let row = 0; row < rawRows.length; row++) {
    for (let variable = 0; variable < width; variable++) {
      mean[variable] += weights[row] * rawRows[row][variable];
    }
  }
  const variance = new Array(width).fill(0);
  for (let row = 0; row < rawRows.length; row++) {
    for (let variable = 0; variable < width; variable++) {
      variance[variable] += weights[row] * (rawRows[row][variable] - mean[variable]) ** 2;
    }
  }
  const constantVariables: string[] = [];
  const scale = variance.map((value, index) => {
    const deviation = Math.sqrt(Math.max(0, value));
    if (!(deviation > 1e-12)) {
      constantVariables.push(variables[index]);
      return 1;
    }
    return deviation;
  });
  const rows = rawRows.map((row) =>
    row.map((value, variable) => (value - mean[variable]) / scale[variable]),
  );

  let parameters = new Array(width + 1).fill(0);
  let loss = logisticObjective(rows, labels, weights, parameters, lambda);
  let converged = false;
  let iterations = 0;
  let optimizerRidge = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const gradient = new Array(width + 1).fill(0);
    const hessian = Array.from({ length: width + 1 }, () => new Array(width + 1).fill(0));
    for (let row = 0; row < rows.length; row++) {
      const augmented = [1, ...rows[row]];
      let linear = parameters[0];
      for (let variable = 0; variable < width; variable++) {
        linear += parameters[variable + 1] * rows[row][variable];
      }
      const probability = logistic(linear);
      const gradientWeight = weights[row] * (probability - labels[row]);
      const hessianWeight = weights[row] * probability * (1 - probability);
      for (let left = 0; left <= width; left++) {
        gradient[left] += gradientWeight * augmented[left];
        for (let right = 0; right <= width; right++) {
          hessian[left][right] += hessianWeight * augmented[left] * augmented[right];
        }
      }
    }
    for (let parameter = 1; parameter <= width; parameter++) {
      gradient[parameter] += lambda * parameters[parameter];
      hessian[parameter][parameter] += lambda;
    }
    const inversion = invertMatrixSafe(hessian);
    if (!inversion.inverse) break;
    optimizerRidge = Math.max(optimizerRidge, inversion.ridge);
    const delta = inversion.inverse.map((row) =>
      row.reduce((sum, value, index) => sum + value * gradient[index], 0),
    );
    const maxDelta = Math.max(...delta.map(Math.abs));

    let step = 1;
    let accepted: number[] | null = null;
    let nextLoss = loss;
    while (step >= 1 / 4096) {
      const candidate = parameters.map((value, index) => value - step * delta[index]);
      const candidateLoss = logisticObjective(rows, labels, weights, candidate, lambda);
      if (Number.isFinite(candidateLoss) && candidateLoss <= loss + 1e-12) {
        accepted = candidate;
        nextLoss = candidateLoss;
        break;
      }
      step /= 2;
    }
    if (!accepted) break;
    const lossChange = Math.abs(loss - nextLoss);
    parameters = accepted;
    loss = nextLoss;
    iterations = iteration + 1;
    if (step * maxDelta <= tolerance || lossChange <= tolerance * Math.max(1, Math.abs(loss))) {
      converged = true;
      break;
    }
  }

  return {
    variables,
    mean,
    scale,
    coefficients: parameters.slice(1),
    intercept: parameters[0],
    lambda,
    nPresences: presences.length,
    nBackground: background.length,
    iterations,
    converged,
    loss,
    constantVariables,
    optimizerRidge,
    method: "presence-background-logistic",
  };
}

/** Relative presence-versus-background logistic score in [0,1]. */
export function predictPresenceBackgroundLogistic(
  values: number[],
  model: PresenceBackgroundLogisticModel,
): number | null {
  if (
    values.length !== model.coefficients.length ||
    values.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }
  let linear = model.intercept;
  for (let variable = 0; variable < values.length; variable++) {
    linear +=
      model.coefficients[variable] *
      ((values[variable] - model.mean[variable]) / model.scale[variable]);
  }
  return logistic(linear);
}

export function predictPresenceBackgroundLogisticMatrix(
  matrix: number[][],
  model: PresenceBackgroundLogisticModel,
): Array<number | null> {
  return matrix.map((row) => predictPresenceBackgroundLogistic(row, model));
}

export function provenanceForSdm(
  tool: "bioclim" | "mahalanobis" | "presence-background-logistic",
  params: Record<string, unknown> = {},
): ProvenanceStamp {
  return makeProvenance(
    tool,
    tool === "bioclim"
      ? "BIOCLIM percentile envelope"
      : tool === "mahalanobis"
        ? "Mahalanobis D² with general covariance inversion"
        : "Class-balanced L2-regularised presence-background logistic regression (linear MaxEnt fallback; not elapid MaxEnt)",
    "Environmental-variable space; output geometry retains its source CRS",
    params,
  );
}
