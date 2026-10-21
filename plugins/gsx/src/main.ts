// GSX tools for GeoSpaX 3 (plugins/gsx). One JSON request on stdin, one JSON answer on stdout
// (docs/PLUGINS.md). The analysis code in src/analysis comes from GeoSpaX 2.0 (@geospax/analysis,
// jm0535/GeoSpaX) and 1.4.2 (jm0535/map-kit), by J. Moses, MIT; it is unchanged so its golden-value
// tests still hold. This file only maps GeoSpaX parameters to those functions and writes results.
//   node run.mjs <tool>         run a tool
//   node run.mjs --manifest     print the tool list (gen-manifest.mjs turns it into plugin.yaml)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature } from 'geojson';
import { TOOLS, type Ctx, type Out } from './tools';

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.argv[2] === '--manifest') {
  console.log(JSON.stringify(TOOLS.map(({ run: _run, ...spec }) => spec)));
  process.exit(0);
}

const tool = TOOLS.find((t) => t.id === process.argv[2]);
if (!tool) fail(`GSX has no tool '${process.argv[2]}'`);
const req = JSON.parse(readFileSync(0, 'utf8') || '{}');
const params: Record<string, unknown> = req.params ?? {};
const geojson: Record<string, string> = req.layer_geojson ?? {};
const sources: Record<string, string> = req.layer_sources ?? {};
const outDir: string = req.out_dir ?? process.cwd();
mkdirSync(outDir, { recursive: true });

const ctx: Ctx = {
  params,
  layer(name) {
    const id = params[name];
    if (id == null || id === '') return null;
    const path = geojson[String(id)] ?? (/\.(geo)?json$/i.test(sources[String(id)] ?? '') ? sources[String(id)] : null);
    if (!path) throw new Error(`'${id}' could not be read as GeoJSON`);
    const fc = JSON.parse(readFileSync(path, 'utf8'));
    return (fc.features ?? []) as Feature[];
  },
  layerName(name) {
    return String(params[name] ?? '').replace(/\.[a-z0-9]+$/i, '');
  },
};

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'result';

try {
  const out: Out = await tool!.run(ctx);
  const outputs: string[] = [];
  for (const l of out.layers ?? []) {
    if (!l.features.length) continue;
    const file = join(outDir, `${slug(l.name)}-${stamp}.geojson`);
    // provenance travels with the layer (GeoSpaX 2.0 stamped every derived layer the same way)
    writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', name: l.name, gsx: { tool: tool!.id, params, provenance: l.provenance ?? null }, features: l.features }));
    outputs.push(file);
  }
  console.log(JSON.stringify({ ok: true, message: out.message, outputs, table: out.table ?? [], notes: out.notes ?? [] }));
} catch (err) {
  fail((err as Error).message ?? String(err));
}
