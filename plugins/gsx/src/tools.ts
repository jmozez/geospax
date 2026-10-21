// The GSX tools: GeoSpaX parameters in, src/analysis functions, layers and a result table out.
// Each tool appears once in the Toolbox (grouped by what it does); the domain kits (conservation,
// forestry, hydrology …) are recipes that combine them.
import type { Feature } from 'geojson';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import * as A from './analysis';

export interface Param {
  name: string;
  label: string;
  kind: 'number' | 'text' | 'bool' | 'layer' | 'field' | 'file' | 'choice';
  required?: boolean;
  default?: unknown;
  description?: string;
  choices?: string[];
}

export interface Ctx {
  params: Record<string, unknown>;
  /** the features of the layer named by a layer parameter (null when the parameter is empty) */
  layer(name: string): Feature[] | null;
  layerName(name: string): string;
}

export interface Out {
  message: string;
  layers?: { name: string; features: Feature[]; provenance?: unknown }[];
  table?: [string, string | number][];
  notes?: string[];
}

export interface Tool {
  id: string;
  name: string;
  summary: string;
  group: string;
  icon: string;
  params: Param[];
  run(ctx: Ctx): Out | Promise<Out>;
}

// ---------------------------------------------------------------- helpers

const num = (ctx: Ctx, name: string, dflt?: number): number => {
  const v = ctx.params[name];
  if (v === undefined || v === null || v === '') {
    if (dflt === undefined) throw new Error(`'${name}' is required`);
    return dflt;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${name}' must be a number`);
  return n;
};
const str = (ctx: Ctx, name: string, dflt = ''): string => String(ctx.params[name] ?? dflt).trim() || dflt;
const need = (ctx: Ctx, name: string, what: string): Feature[] => {
  const f = ctx.layer(name);
  if (!f) throw new Error(`Choose ${what}`);
  if (!f.length) throw new Error(`${ctx.layerName(name)} has no features`);
  return f;
};
const ok = <T extends { ok: boolean }>(r: T | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error((r as { error: string }).error);
  return r as T;
};
const ha = (m2: number) => A.formatArea(m2, 'ha').display;
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)} %`);
const fix = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v.toFixed(d)));
const areaChoice: Param = { name: 'area', label: 'Area method', kind: 'choice', default: 'equalarea', choices: ['equalarea', 'spherical'], description: 'Equal-area (auto-centred LAEA, hectares) or spherical.' };

/** "field:weight:+" items separated by commas or semicolons (WLC criteria). */
function criteria(text: string) {
  const items = text.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new Error('Give at least one criterion as field:weight (add :- when lower is better)');
  return items.map((it) => {
    const [field, w, dir] = it.split(':').map((s) => s.trim());
    const weight = Number(w ?? 1);
    if (!field || !Number.isFinite(weight) || weight < 0) throw new Error(`Bad criterion '${it}': use field:weight or field:weight:-`);
    return { field, weight, direction: (dir === '-' || /^lower|min|cost/i.test(dir ?? '') ? 'lower' : 'higher') as A.CriterionDirection };
  });
}

// ---------------------------------------------------------------- planning

const PLAN = 'GSX · Planning';
const LAND = 'GSX · Landscape';
const SPECIES = 'GSX · Species & patterns';

export const TOOLS: Tool[] = [
  {
    id: 'overlay',
    name: 'Polygon overlay',
    summary: 'Intersect, erase (difference) or union two polygon layers; areas in hectares.',
    group: LAND,
    icon: 'layers',
    params: [
      { name: 'a', label: 'Layer A', kind: 'layer', required: true },
      { name: 'b', label: 'Layer B', kind: 'layer', required: true },
      { name: 'operation', label: 'Operation', kind: 'choice', default: 'intersect', choices: ['intersect', 'difference', 'union'] },
    ],
    run(ctx) {
      const op = str(ctx, 'operation', 'intersect') as 'intersect' | 'difference' | 'union';
      if (ctx.params.a === ctx.params.b) throw new Error('Choose two different layers');
      const r = ok(A.vectorOverlay(need(ctx, 'a', 'layer A'), need(ctx, 'b', 'layer B'), op)) as A.VectorOverlayResult;
      return {
        message: r.features.length ? `${op}: ${r.features.length} polygon(s)` : 'The layers do not overlap: no polygons',
        layers: [{ name: `${op} ${ctx.layerName('a')} ${ctx.layerName('b')}`, features: r.features as Feature[], provenance: (r as { provenance?: unknown }).provenance }],
        table: [['Pairs tested', r.pairsTested], ['Output features', r.features.length]],
      };
    },
  },
  {
    id: 'suitability',
    name: 'Weighted suitability (WLC)',
    summary: 'Weighted linear combination of numeric fields, each rescaled 0–1; optional constraint field forces zero.',
    group: PLAN,
    icon: 'chart',
    params: [
      { name: 'layer', label: 'Features', kind: 'layer', required: true },
      { name: 'criteria', label: 'Criteria', kind: 'text', required: true, description: 'field:weight, … — add :- when lower is better, e.g. "forest_pct:3, road_km:1:-"' },
      { name: 'constraint', label: 'Constraint field', kind: 'field', description: 'Features where this is true score zero.' },
    ],
    run(ctx) {
      const crit = criteria(str(ctx, 'criteria'));
      if (new Set(crit.map((c) => c.field)).size !== crit.length) throw new Error('Each criterion must use a different field');
      const r = ok(A.featureSuitability(need(ctx, 'layer', 'a layer'), crit, { constraintField: str(ctx, 'constraint') || undefined }));
      return {
        message: `Scored ${r.scoredCount} feature(s); suitability ${fix(r.minSuitability, 3)}–${fix(r.maxSuitability, 3)}`,
        layers: [{ name: `${ctx.layerName('layer')} suitability`, features: r.features as Feature[], provenance: r.provenance }],
        table: [['Scored', r.scoredCount], ['Missing criteria', r.missingCount], ['Constrained to zero', r.constrainedCount], ['Mean', fix(r.meanSuitability, 3)]],
        notes: r.warnings,
      };
    },
  },
  {
    id: 'distance-decay',
    name: 'Distance-decay suitability',
    summary: 'Score features by a distance field with exponential decay: 1 at zero distance, 0.5 at the half-life.',
    group: PLAN,
    icon: 'chart',
    params: [
      { name: 'layer', label: 'Features', kind: 'layer', required: true },
      { name: 'field', label: 'Distance field (m)', kind: 'field', required: true },
      { name: 'half_life', label: 'Half-life (m)', kind: 'number', default: 1000, required: true },
    ],
    run(ctx) {
      const field = str(ctx, 'field');
      const half = num(ctx, 'half_life', 1000);
      if (half <= 0) throw new Error('Half-life must be greater than zero');
      let valid = 0;
      const features = need(ctx, 'layer', 'a layer').map((f) => {
        const raw = Number(f.properties?.[field]);
        const score = Number.isFinite(raw) && raw >= 0 ? A.distanceDecay(raw, half) : null;
        if (score !== null) valid++;
        return { ...f, properties: { ...(f.properties ?? {}), distance_decay_suitability: score, distance_decay_nodata: score === null } };
      });
      if (!valid) throw new Error(`${field} has no finite, non-negative values`);
      return {
        message: `Scored ${valid} of ${features.length} feature(s)`,
        layers: [{ name: `${ctx.layerName('layer')} distance decay`, features: features as Feature[] }],
        table: [['Scored', valid], ['No value', features.length - valid], ['Half-life (m)', half]],
      };
    },
  },
  {
    id: 'priority-sites',
    name: 'Unprotected priority sites',
    summary: 'High-scoring habitat points that fall outside every protected area.',
    group: PLAN,
    icon: 'pin',
    params: [
      { name: 'habitat', label: 'Habitat points', kind: 'layer', required: true },
      { name: 'protected', label: 'Protected areas', kind: 'layer', required: true },
      { name: 'score', label: 'Score field', kind: 'field', required: true },
      { name: 'min_score', label: 'Minimum score', kind: 'number', default: 1 },
    ],
    run(ctx) {
      const r = ok(A.priorityAreas(need(ctx, 'habitat', 'habitat points'), need(ctx, 'protected', 'protected areas'), { scoreField: str(ctx, 'score'), minScore: num(ctx, 'min_score', 1) }));
      return {
        message: r.priorityCount ? `${r.priorityCount} unprotected high-score site(s)` : 'No unprotected site met the score threshold',
        layers: [{ name: 'Unprotected priority sites', features: r.priorityFeatures as Feature[], provenance: r.provenance }],
        table: [['Points', r.totalPoints], ['Unprotected, high score', r.priorityCount], ['Protected, high score', r.protectedHighCount], ['Below threshold', r.lowScoreCount], ['Invalid score', r.invalidScoreCount]],
      };
    },
  },
  {
    id: 'protection-gap',
    name: 'Protection gap',
    summary: 'How much of a habitat or range lies inside protected areas, and the unprotected gap, in hectares.',
    group: PLAN,
    icon: 'globe',
    params: [
      { name: 'habitat', label: 'Habitat / range', kind: 'layer', required: true },
      { name: 'protected', label: 'Protected areas', kind: 'layer', required: true },
      areaChoice,
    ],
    run(ctx) {
      const r = ok(
        A.protectionGap(need(ctx, 'habitat', 'the habitat layer'), need(ctx, 'protected', 'protected areas'), {
          areaMode: str(ctx, 'area', 'equalarea') as A.AreaMethod,
          habitatLayerName: ctx.layerName('habitat'),
          paLayerName: ctx.layerName('protected'),
        }),
      ) as A.ProtectionGapResult;
      const layers = [];
      if (r.gapGeom) layers.push({ name: 'Protection gap', features: [r.gapGeom] as Feature[], provenance: r.provenance });
      if (r.protectedGeom) layers.push({ name: 'Protected habitat', features: [r.protectedGeom] as Feature[], provenance: r.provenance });
      return {
        message: `${pct(r.protectedPct)} protected, ${pct(r.gapPct)} gap (${ha(r.gapAreaM2)})`,
        layers,
        table: [['Habitat', ha(r.totalAreaM2)], ['Protected', `${ha(r.protectedAreaM2)} (${pct(r.protectedPct)})`], ['Gap', `${ha(r.gapAreaM2)} (${pct(r.gapPct)})`], ['Protected areas overlapping', r.paCount]],
      };
    },
  },
  {
    id: 'representation',
    name: 'Minimum-cost representation (SCP)',
    summary: 'Cheapest set of planning units that meets a target for each feature (exact for ≤ 28 units, greedy above).',
    group: PLAN,
    icon: 'grid',
    params: [
      { name: 'units', label: 'Planning units', kind: 'layer', required: true },
      { name: 'cost', label: 'Cost field', kind: 'field', required: true },
      { name: 'targets', label: 'Targets', kind: 'text', required: true, description: 'field:target, … — e.g. "frog_ha:50, forest_ha:200"' },
    ],
    async run(ctx) {
      const units = need(ctx, 'units', 'planning units');
      const costField = str(ctx, 'cost');
      const rows = str(ctx, 'targets')
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [field, t] = s.split(':').map((x) => x.trim());
          const target = Number(t);
          if (!field || !Number.isFinite(target) || target < 0) throw new Error(`Bad target '${s}': use field:target`);
          return { field, target };
        });
      if (!rows.length) throw new Error('Give at least one field:target');
      const val = (f: Feature, k: string) => Number(f.properties?.[k]);
      const costs = units.map((f) => val(f, costField));
      if (costs.some((c) => !Number.isFinite(c) || c < 0)) throw new Error(`${costField} must be finite and non-negative on every unit`);
      const speciesCoverage = rows.map((r) => units.map((f) => val(f, r.field)));
      if (speciesCoverage.some((row) => row.some((v) => !Number.isFinite(v) || v < 0))) throw new Error('Every target field must be finite and non-negative on every unit');
      const problem = { costs, speciesCoverage, targets: rows.map((r) => r.target) };
      const sol = units.length <= 28 ? await A.solveScpExact(problem) : A.solveScpGreedy(problem);
      if (!sol.feasible) throw new Error(sol.warning ?? 'The targets cannot be met with these planning units');
      const chosen = new Set(sol.selected);
      const features = units.map((f, i) => ({ ...f, properties: { ...(f.properties ?? {}), scp_selected: chosen.has(i) } }));
      return {
        message: `${chosen.size} of ${units.length} unit(s) meet every target at cost ${fix(sol.cost)} (${sol.optimal ? 'optimal' : sol.method})`,
        layers: [{ name: `${ctx.layerName('units')} selection`, features: features as Feature[] }],
        table: [['Units selected', chosen.size], ['Total cost', fix(sol.cost)], ['Method', sol.method], ['Optimal', sol.optimal ? 'yes' : 'no'], ...rows.map((r, i) => [`${r.field} (target ${r.target})`, fix(sol.coverage[i])] as [string, number])],
        notes: sol.warning ? [sol.warning] : [],
      };
    },
  },
  {
    id: 'hotspot-grid',
    name: 'Weighted hotspot grid',
    summary: 'Hexagon or square grid scored by weighted counts, density or presence of up to three layers (descriptive, not Gi*).',
    group: PLAN,
    icon: 'grid',
    params: [
      { name: 'layer', label: 'Layer 1', kind: 'layer', required: true },
      { name: 'weight', label: 'Weight 1', kind: 'number', default: 1 },
      { name: 'layer2', label: 'Layer 2', kind: 'layer' },
      { name: 'weight2', label: 'Weight 2', kind: 'number', default: 1 },
      { name: 'layer3', label: 'Layer 3', kind: 'layer' },
      { name: 'weight3', label: 'Weight 3', kind: 'number', default: 1 },
      { name: 'cell_km', label: 'Cell size (km)', kind: 'number', default: 5, required: true },
      { name: 'shape', label: 'Shape', kind: 'choice', default: 'hex', choices: ['hex', 'square'] },
      { name: 'score', label: 'Score', kind: 'choice', default: 'count', choices: ['count', 'density', 'presence'] },
    ],
    run(ctx) {
      const inputs = [
        ['layer', 'weight'],
        ['layer2', 'weight2'],
        ['layer3', 'weight3'],
      ]
        .map(([l, w]) => ({ id: String(ctx.params[l] ?? ''), name: ctx.layerName(l), features: ctx.layer(l) ?? [], weight: num(ctx, w, 1) }))
        .filter((x) => x.id);
      const r = ok(A.hotspotGrid(inputs as A.HotspotLayerInput[], { gridType: str(ctx, 'shape', 'hex') as 'hex' | 'square', scoreMethod: str(ctx, 'score', 'count') as 'count' | 'presence' | 'density', cellSizeKm: num(ctx, 'cell_km', 5) }));
      return {
        message: `${r.cellCount} cell(s), ${r.nonEmptyCells} with data`,
        layers: [{ name: `Hotspot grid ${num(ctx, 'cell_km', 5)} km`, features: r.grid.features as Feature[], provenance: r.provenance }],
        table: [['Cells', r.cellCount], ['Cells with data', r.nonEmptyCells], ['Input features', r.inputFeatureCount], ['Maximum raw score', fix(r.maxRawScore, 3)]],
        notes: [r.methodNote],
      };
    },
  },

  // ---------------------------------------------------------------- landscape
  {
    id: 'fragmentation',
    name: 'Fragmentation and patch metrics',
    summary: 'FRAGSTATS-style metrics (NP, CA, LPI, TE, ED, MSI, core area, CAI, ENN) and core-area polygons.',
    group: LAND,
    icon: 'layers',
    params: [
      { name: 'patches', label: 'Patches', kind: 'layer', required: true },
      { name: 'edge_m', label: 'Core edge depth (m)', kind: 'number', default: 100 },
      areaChoice,
      { name: 'explode', label: 'Each multipolygon part is a patch', kind: 'bool', default: true },
    ],
    run(ctx) {
      const r = ok(A.fragmentationAnalysis(need(ctx, 'patches', 'a patch layer'), { coreDepthM: num(ctx, 'edge_m', 100), areaMode: str(ctx, 'area', 'equalarea') as A.AreaMethod, explodeMultiPolygons: ctx.params.explode !== false }));
      return {
        message: `${r.numPatches} patch(es), ${ha(r.totalAreaM2)}; core ${ha(r.coreAreaM2)} (CAI ${fix(r.coreAreaIndex, 1)} %)`,
        layers: [
          { name: 'Patches with metrics', features: r.patchFeatures as Feature[], provenance: r.provenance },
          { name: `Core areas (${r.coreDepthM} m edge)`, features: r.coreFeatures as Feature[], provenance: r.provenance },
        ],
        table: [
          ['Patches (NP)', r.numPatches],
          ['Class area (CA)', ha(r.totalAreaM2)],
          ['Largest patch', ha(r.largestPatchM2)],
          ['Mean patch', ha(r.meanPatchM2)],
          ['Total edge (TE)', `${fix(r.totalEdgeM / 1000, 2)} km`],
          ['Edge density (ED)', `${fix(r.edgeDensityMPerHa, 2)} m/ha`],
          ['Mean shape index (MSI)', fix(r.meanShapeIndex, 3)],
          ['Core area', ha(r.coreAreaM2)],
          ['Core area index (CAI)', `${fix(r.coreAreaIndex, 1)} %`],
          ['Patches with no core', r.patchesWithNoCore],
          ['Mean nearest neighbour (ENN)', r.meanNearestNeighbourM == null ? '—' : `${fix(r.meanNearestNeighbourM, 0)} m`],
        ],
        notes: r.warnings,
      };
    },
  },
  {
    id: 'connectivity',
    name: 'Patch connectivity',
    summary: 'Links patches closer than a threshold distance and reports the connected components.',
    group: LAND,
    icon: 'hotspot',
    params: [
      { name: 'patches', label: 'Patches', kind: 'layer', required: true },
      { name: 'threshold_m', label: 'Link threshold (m)', kind: 'number', default: 500, required: true },
    ],
    run(ctx) {
      const t = num(ctx, 'threshold_m', 500);
      if (t <= 0) throw new Error('The threshold must be greater than zero');
      const r = ok(A.connectivityAnalysis(need(ctx, 'patches', 'a patch layer'), t));
      return {
        message: `${r.componentCount} component(s) at ${t} m; ${r.isolatedPatches} isolated patch(es)`,
        layers: [
          { name: 'Patches by component', features: r.taggedFeatures as Feature[], provenance: r.provenance },
          { name: `Links ≤ ${t} m`, features: r.linkFeatures as Feature[], provenance: r.provenance },
        ],
        table: [['Patches', r.numPatches], ['Components', r.componentCount], ['Largest component (patches)', r.largestComponentPatches], ['Largest component area', ha(r.largestComponentAreaM2)], ['Isolated patches', r.isolatedPatches], ['Links', r.linkCount]],
      };
    },
  },
  {
    id: 'change',
    name: 'Two-date change (loss, gain, persistence)',
    summary: 'Compares two polygon layers of the same thing (forest, wetland, land cover) and reports loss, gain and the annual rate.',
    group: LAND,
    icon: 'clock',
    params: [
      { name: 't1', label: 'Earlier extent', kind: 'layer', required: true },
      { name: 't2', label: 'Later extent', kind: 'layer', required: true },
      { name: 'year1', label: 'Earlier year', kind: 'number' },
      { name: 'year2', label: 'Later year', kind: 'number' },
      areaChoice,
    ],
    run(ctx) {
      if (ctx.params.t1 === ctx.params.t2) throw new Error('Choose two different layers');
      const y = (k: string) => (ctx.params[k] == null || ctx.params[k] === '' ? null : num(ctx, k));
      const r = ok(A.vectorChangeDetection(need(ctx, 't1', 'the earlier layer'), need(ctx, 't2', 'the later layer'), { yearT1: y('year1'), yearT2: y('year2'), areaMode: str(ctx, 'area', 'equalarea') as A.AreaMethod }));
      return {
        message: `Net change ${pct(r.netChangePct)}: loss ${ha(r.lossAreaM2)}, gain ${ha(r.gainAreaM2)}`,
        layers: [{ name: `Change ${ctx.layerName('t1')} → ${ctx.layerName('t2')}`, features: r.features as Feature[], provenance: r.provenance }],
        table: [
          ['Earlier extent', ha(r.t1AreaM2)],
          ['Later extent', ha(r.t2AreaM2)],
          ['Loss', `${ha(r.lossAreaM2)} (${pct(r.lossPctOfT1)})`],
          ['Gain', `${ha(r.gainAreaM2)} (${pct(r.gainPctOfT1)})`],
          ['Persistence', ha(r.persistenceAreaM2)],
          ['Net change', `${ha(r.netChangeM2)} (${pct(r.netChangePct)})`],
          ['Annual rate', r.annualHaPerYear == null ? '—' : `${fix(r.annualHaPerYear, 1)} ha/yr (${pct(r.annualPctPerYear)}/yr)`],
        ],
      };
    },
  },

  // ---------------------------------------------------------------- species and point patterns
  {
    id: 'dbscan',
    name: 'DBSCAN clusters',
    summary: 'Density-based clusters of up to 2,000 points (haversine distance); noise stays as cluster −1.',
    group: SPECIES,
    icon: 'hotspot',
    params: [
      { name: 'points', label: 'Points', kind: 'layer', required: true },
      { name: 'min_points', label: 'Minimum points', kind: 'number', default: 4 },
      { name: 'epsilon_m', label: 'Radius (m)', kind: 'number', description: 'Empty: from the median nearest-neighbour distance × multiplier.' },
      { name: 'multiplier', label: 'Automatic radius × ', kind: 'number', default: 1.5 },
    ],
    run(ctx) {
      const minPoints = num(ctx, 'min_points', 4);
      if (!Number.isInteger(minPoints) || minPoints < 2) throw new Error('Minimum points must be a whole number of at least 2');
      const eps = ctx.params.epsilon_m;
      const r = ok(
        A.dbscanClusters(need(ctx, 'points', 'a point layer'), {
          minPoints,
          maxPoints: 2000,
          ...(eps != null && eps !== '' ? { epsilonM: num(ctx, 'epsilon_m') } : { epsilonMultiplier: num(ctx, 'multiplier', 1.5) }),
        }),
      );
      return {
        message: `${r.clusterCount} cluster(s), ${r.noiseCount} noise point(s); radius ${fix(r.epsilonM, 0)} m`,
        layers: [{ name: `${ctx.layerName('points')} clusters`, features: r.features as Feature[], provenance: r.provenance }],
        table: [['Points', r.pointCount], ['Clusters', r.clusterCount], ['Noise', r.noiseCount], ['Core points', r.corePointCount], ['Radius', `${fix(r.epsilonM, 0)} m${r.epsilonWasAutomatic ? ' (automatic)' : ''}`]],
      };
    },
  },
  {
    id: 'nearest-neighbour',
    name: 'Occurrence pattern (Clark–Evans)',
    summary: 'Nearest-neighbour ratio R and z-score: clustered, random-like or dispersed.',
    group: SPECIES,
    icon: 'hotspot',
    params: [{ name: 'points', label: 'Points', kind: 'layer', required: true }],
    run(ctx) {
      const r = ok(A.nearestNeighbourIndex(need(ctx, 'points', 'a point layer')));
      return {
        message: `Pattern is ${r.interpretation} (R = ${fix(r.ratio, 3)})`,
        table: [['Points', r.pointCount], ['Study area', ha(r.studyAreaM2)], ['Observed mean NN', `${fix(r.observedMeanM, 1)} m`], ['Expected (CSR)', `${fix(r.expectedMeanM, 1)} m`], ['Clark–Evans R', fix(r.ratio, 3)], ['z-score', fix(r.zScore, 3)], ['Pattern', r.interpretation]],
        notes: [r.methodNote],
      };
    },
  },
  {
    id: 'diversity',
    name: 'Richness and diversity',
    summary: 'Species richness, Shannon H′, Simpson and evenness of an occurrence layer, overall and per area.',
    group: SPECIES,
    icon: 'chart',
    params: [
      { name: 'occurrences', label: 'Occurrences', kind: 'layer', required: true },
      { name: 'species', label: 'Species field', kind: 'field', required: true },
      { name: 'areas', label: 'Per area (optional)', kind: 'layer', description: 'Polygons; each gets richness, Shannon and Simpson of the points inside.' },
    ],
    run(ctx) {
      const occ = need(ctx, 'occurrences', 'occurrences');
      const field = str(ctx, 'species');
      const counts = (fs: Feature[]) => {
        const m = new Map<string, number>();
        for (const f of fs) {
          const s = f.properties?.[field];
          if (s == null || s === '') continue;
          m.set(String(s), (m.get(String(s)) ?? 0) + 1);
        }
        return m;
      };
      const all = counts(occ);
      if (!all.size) throw new Error(`${field} has no species names`);
      const stats = (m: Map<string, number>) => {
        const c = [...m.values()];
        const h = A.shannon(c);
        return { richness: m.size, shannon: h, simpson: A.simpson(c), evenness: h != null && m.size > 1 ? h / Math.log(m.size) : null, records: c.reduce((a, b) => a + b, 0) };
      };
      const s = stats(all);
      const layers: Out['layers'] = [];
      const areas = ctx.layer('areas');
      if (areas?.length) {
        const pts = A.pointsOnly(occ);
        const per = areas.map((a) => {
          const inside = pts.filter((p) => a.geometry && (a.geometry.type === 'Polygon' || a.geometry.type === 'MultiPolygon') && booleanPointInPolygon(p, a as never));
          const st = stats(counts(inside));
          return { ...a, properties: { ...(a.properties ?? {}), richness: st.richness, shannon: st.shannon, simpson: st.simpson, evenness: st.evenness, records: st.records } };
        });
        layers.push({ name: `${ctx.layerName('areas')} diversity`, features: per as Feature[] });
      }
      return {
        message: `${s.richness} species in ${s.records} record(s); Shannon H′ ${fix(s.shannon, 3)}`,
        layers,
        table: [['Records', s.records], ['Richness', s.richness], ['Shannon H′', fix(s.shannon, 3)], ['Simpson (1 − D)', fix(s.simpson, 3)], ['Evenness (Pielou J)', fix(s.evenness, 3)]],
      };
    },
  },
];
