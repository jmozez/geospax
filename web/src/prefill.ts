// Tool dialogs open with fitting inputs already chosen, as ArcGIS Pro's geoprocessing pane does: the
// layer selected in Contents when it fits, else the layer whose geometry and name fit the parameter;
// a field of the right type from that layer; rasters by what the parameter needs (a multiband image,
// a DEM, an earlier and a later date). Everything stays changeable; nothing is chosen when nothing fits.

export interface PLayer { id: string; name: string; geometry?: string; fields?: { name: string; kind: string }[] }
export interface PRaster { id: string; title?: string; bands: number }
export interface PParam { name: string; label?: string; kind: string; description?: string; required?: boolean }

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2);
const text = (p: PParam) => `${p.name} ${p.label ?? ''} ${p.description ?? ''}`.toLowerCase();
const numeric = (k: string) => k === 'integer' || k === 'real';

/** The geometry a layer parameter wants, from its name, label and description. */
export function wantGeometry(p: PParam): string[] {
  const head = `${p.name} ${p.label ?? ''}`.toLowerCase();
  const t = text(p);
  if (/\blines?\b|transect|route|track/.test(head)) return ['line', 'point'];
  if (/point|occurrence|presence|sites?\b|record|sighting/.test(head) || /\bpoints?\b/.test(t.split('.')[0])) return ['point'];
  if (/patch|protected|reserve|unit|area|polygon|range|zone|\bt[12]\b|^[ab]\b|habitat|boundar/.test(head)) return ['polygon'];
  return [];
}

// names that mark a layer as the protected or reference one, so "habitat" and "protected" differ
const ROLE: [RegExp, RegExp][] = [
  [/protect|reserve|\bmpa\b|park/, /protect|reserve|mpa|park|conserv/],
  [/habitat|range/, /habitat|forest|range|cover|patch/],
];

function score(p: PParam, l: PLayer): number {
  const t = text(p);
  let s = 0;
  const lw = words(l.name);
  for (const w of words(`${p.name} ${p.label ?? ''}`)) if (lw.some((x) => x.startsWith(w.slice(0, 5)))) s += 3;
  for (const [role, name] of ROLE) if (role.test(t) && name.test(l.name.toLowerCase())) s += 5;
  if (!/protect|reserve/.test(t) && /protect|reserve/.test(l.name.toLowerCase())) s -= 2;
  return s;
}

/** Layer for each layer parameter: the selected one if it fits, else the best-named fitting one,
 * not reusing a layer while another fits (intersect A with B, habitat with protected areas). */
export function pickLayers(params: PParam[], layers: PLayer[], active?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const fieldParams = params.filter((p) => p.kind === 'field');
  // a layer that has the fields the tool names (a species column for diversity, elevation_m for a
  // profile); sort and grouping fields ("Sort points by") do not choose the layer
  const steering = fieldParams.filter((f) => f.required || !/^(order|sort|group|label|name)_|_by$/.test(f.name));
  const hasFields = (l: PLayer) => steering.filter((f) => pickField(f, l, true)).length * 3;
  const used = new Set<string>();
  const lp = params.filter((p) => p.kind === 'layer');
  for (const p of lp) {
    const first = lp.indexOf(p) === 0;
    const want = wantGeometry(p);
    // results of earlier runs are inputs only when you select them
    const fits = layers.filter((l) => (!want.length || !l.geometry || l.geometry === 'unknown' || want.includes(l.geometry)) && (!isResult(l.id) || l.id === active));
    if (!fits.length) continue;
    // a variant of a layer already chosen (habitat_2024 after habitat) is the right second date of a
    // before/after pair, and a weaker second input anywhere else
    const stem = (l: PLayer) => words(l.name)[0] ?? l.id;
    const pair = /\bt[12]\b|before|after|earlier|later|year/.test(`${p.name} ${p.label ?? ''}`.toLowerCase());
    const rank = (l: PLayer) =>
      score(p, l) + (want[0] && l.geometry === want[0] ? (want.length > 1 ? 4 : 1) : 0) +
      (want[0] === 'line' && /transect|route|track|traverse|profile/.test(l.name.toLowerCase()) ? 3 : 0) + (first ? hasFields(l) : 0) - (used.has(l.id) ? 10 : 0) +
      ([...used].some((u) => stem(layers.find((x) => x.id === u)!) === stem(l)) ? (pair ? 3 : -3) : 0);
    const ranked = fits.map((l, i) => ({ l, s: rank(l), i })).sort((a, b) => b.s - a.s || a.i - b.i);
    let best = ranked[0];
    // the layer selected in Contents goes into the first input it fits, unless another layer fits that
    // input clearly better by name or fields (habitat_survey_grid for "Habitat", a layer with species)
    const sel = first && active ? ranked.find((r) => r.l.id === active && !used.has(active)) : undefined;
    if (sel && sel.s + 2 >= best.s) best = sel;
    // optional inputs (a second or third layer, areas to count in) only when the name says so
    if (!p.required && best !== sel && score(p, best.l) <= 0) continue;
    out[p.name] = best.l.id;
    used.add(best.l.id);
  }
  return out;
}

/** A field of the right type from the chosen layer (the first layer parameter's, else any). */
export function pickField(p: PParam, layer: PLayer | undefined, namedOnly = false): string {
  const fields = layer?.fields ?? [];
  if (!fields.length) return '';
  const t = text(p);
  const wantText = /species|taxon|name|class|category|group|type|transect/.test(`${p.name} ${p.label ?? ''}`.toLowerCase()) && !/numeric|number/.test(t);
  // identifiers are numbers but not values; measured values (real) before counts and codes (integer)
  const idLike = (n: string) => /^(id|fid|objectid|ogc_fid|site|code|gid|uid)$|_id$|^id_/i.test(n);
  const pool = fields.filter((f) => (wantText ? f.kind === 'string' : numeric(f.kind)) && !idLike(f.name)).sort((a, b) => Number(b.kind === 'real') - Number(a.kind === 'real'));
  if (!pool.length) return '';
  const match = (src: string) => {
    const pw = words(src);
    return pool.find((f) => words(f.name).some((w) => pw.some((x) => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))));
  };
  // an optional field only when its own name or label names the field (elevation_m for "Elevation
  // field"), never from examples in its description: a wrong constraint would zero results
  if (!p.required) {
    // …or a field named exactly as the description's own example ("e.g. transect")
    const eg = (p.description ?? '').match(/e\.g\.\s*([A-Za-z_][\w]*)/)?.[1];
    const exact = eg ? fields.find((f) => f.name.toLowerCase() === eg.toLowerCase()) : undefined;
    return match(`${p.name} ${p.label ?? ''}`)?.name ?? exact?.name ?? '';
  }
  if (namedOnly) return match(`${p.name} ${p.label ?? ''} ${(p.description ?? '').split(/[.;]/)[0]}`)?.name ?? '';
  return (match(`${p.name} ${p.label ?? ''} ${(p.description ?? '').split(/[.;]/)[0]}`) ?? pool[0]).name;
}

// results of earlier runs end in the run's time stamp (…-20261022-152641): a tool starts from your
// data, not from the last result, unless you select that result in Contents
const RESULT = /-\d{8}-\d{6}(\.|$)/;
export const isResult = (id: string) => RESULT.test(id);
const YEAR = /(?<!\d)(19[5-9]\d|20[0-4]\d)(?!\d)/;

/** Rasters: a multiband image for images, a DEM for elevation, the earlier and later of two dates. */
export function pickRasters(params: PParam[], rasters: PRaster[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const rp = params.filter((p) => p.kind === 'raster' || p.kind === 'rasters');
  rasters = rasters.filter((r) => !isResult(r.id));
  const name = (r: PRaster) => `${r.id} ${r.title ?? ''}`.toLowerCase();
  const dem = (r: PRaster) => /\bdem\b|dem[_ ]|elev|srtm|height|terrain|copernicus.?dem/.test(name(r));
  const year = (r: PRaster) => Number(name(r).match(YEAR)?.[0] ?? NaN);
  const dated = rasters.filter((r) => !Number.isNaN(year(r))).sort((a, b) => year(a) - year(b));
  for (const p of rp) {
    const head = `${p.name} ${p.label ?? ''}`.toLowerCase();
    if (p.kind === 'rasters') {
      if (/future/.test(head)) continue; // optional: never guessed
      const clim = rasters.filter((r) => /bio|clim|chelsa|temperature|precip/.test(name(r)));
      out[p.name] = (clim.length ? clim : rasters.filter((r) => !dem(r))).map((r) => r.id);
      continue;
    }
    let pick: PRaster | undefined;
    // a DEM only when its name says so: slope of a temperature surface is no answer
    if (/\bdem\b|elevation/.test(head)) pick = rasters.find(dem);
    else if (/image|multiband/.test(head)) pick = rasters.filter((r) => r.bands >= 2).sort((a, b) => b.bands - a.bands)[0];
    else if (/before|earlier/.test(head)) pick = dated[0];
    else if (/after|later/.test(head)) pick = dated.length > 1 ? dated[dated.length - 1] : undefined;
    else if (p.required) pick = rasters.find((r) => !dem(r));
    if (pick) out[p.name] = pick.id;
  }
  return out;
}
