// Runs every GSX tool through the engine (POST /api/plugins/gsx/tools/<tool>/run) on the sample
// layers and checks that each one answers and adds its layers to the map.
//   node scripts/test-gsx.mjs [base]
// Needs a server with a point layer that has a numeric field and a polygon layer (as in CI's data).
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const get = async (p) => (await fetch(`${base}/${p}`)).json();
const layers = (await get('api/layers')).layers;
const by = (g) => layers.filter((l) => l.geometry === g);
const pts = by('point').find((l) => l.fields.some((f) => f.kind === 'real')) ?? by('point')[0];
const polys = by('polygon').sort((a, b) => a.feature_count - b.feature_count);
if (!pts || polys.length < 1) throw new Error('need a point layer with a numeric field and a polygon layer');
const num = pts.fields.find((f) => f.kind === 'real')?.name;
const txt = pts.fields.find((f) => f.kind === 'string')?.name;
const [p1, p2 = polys[0]] = polys;
const pnum = p1.fields.find((f) => f.kind !== 'string')?.name;
const cases = [
  ['overlay', { a: p1.id, b: p2.id, operation: 'intersect' }],
  ['suitability', { layer: pts.id, criteria: `${num}:1` }],
  ['distance-decay', { layer: pts.id, field: num, half_life: 20 }],
  ['priority-sites', { habitat: pts.id, protected: p1.id, score: num, min_score: 20 }],
  ['protection-gap', { habitat: p1.id, protected: p2.id }],
  ['representation', { units: p1.id, cost: pnum, targets: `${pnum}:5` }],
  ['hotspot-grid', { layer: pts.id, cell_km: 20 }],
  ['fragmentation', { patches: p1.id, edge_m: 100 }],
  ['connectivity', { patches: p1.id, threshold_m: 2000 }],
  ['change', { t1: p1.id, t2: p2.id === p1.id ? polys[1]?.id : p2.id, year1: 2015, year2: 2024 }],
  ['dbscan', { points: pts.id }],
  ['nearest-neighbour', { points: pts.id }],
  ['diversity', { occurrences: pts.id, species: txt ?? num, areas: p1.id }],
];
let pass = 0;
const fails = [];
for (const [tool, params] of cases) {
  if (Object.values(params).some((v) => v === undefined)) {
    console.log(`  skip ${tool} (no suitable layer)`);
    continue;
  }
  const t0 = Date.now();
  const r = await fetch(`${base}/api/plugins/gsx/tools/${tool}/run`, { method: 'POST', body: JSON.stringify({ params }), headers: { 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  const good = r.ok && j.result?.ok;
  if (good) pass++;
  else fails.push(tool);
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${tool} (${Date.now() - t0} ms): ${good ? `${j.result.message}${j.added?.length ? ` · added ${j.added.length}` : ''}` : j.error ?? JSON.stringify(j).slice(0, 200)}`);
}
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
