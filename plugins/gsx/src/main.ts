// Conservation, landscape and biodiversity tools for GeoSpaX 3 (plugins/gsx). One JSON request on stdin, one JSON answer on stdout
// (docs/PLUGINS.md). The analysis code in src/analysis is by in4metrix, MIT; it is unchanged so
// its golden-value tests still hold. This file only maps GeoSpaX parameters to those functions and writes results.
//   node run.mjs <tool>         run a tool
//   node run.mjs --manifest     print the tool list (gen-manifest.mjs turns it into plugin.yaml)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature } from 'geojson';
import { TOOLS, type Ctx, type Grid, type Out } from './tools';

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.argv[2] === '--manifest') {
  console.log(JSON.stringify(TOOLS.map(({ run: _run, ...spec }) => spec)));
  process.exit(0);
}

const tool = TOOLS.find((t) => t.id === process.argv[2]);
if (!tool) fail(`there is no tool '${process.argv[2]}'`);
const req = JSON.parse(readFileSync(0, 'utf8') || '{}');
const params: Record<string, unknown> = req.params ?? {};
const geojson: Record<string, string> = req.layer_geojson ?? {};
const sources: Record<string, string> = req.layer_sources ?? {};
const grids: Record<string, string> = req.raster_grids ?? {};
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
  raster(name) {
    const id = params[name];
    if (id == null || id === '') return null;
    return readGrid(String(id));
  },
  rasters(name) {
    const v = params[name];
    const ids = Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return ids.map(readGrid);
  },
};

/** A raster GeoSpaX wrote for this run (`<id>.grid.json` + float32 bands). */
function readGrid(id: string): Grid {
  const header = grids[id];
  if (!header) throw new Error(`raster '${id}' was not handed to the tool`);
  const m = JSON.parse(readFileSync(header, 'utf8'));
  const buf = readFileSync(m.data);
  const n = m.width * m.height;
  const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const bands = Array.from({ length: m.bands }, (_, b) => all.slice(b * n, (b + 1) * n));
  return {
    id, title: m.title ?? id, kind: m.kind ?? 'raster', units: m.units ?? '', width: m.width, height: m.height,
    bandNames: m.band_names ?? bands.map((_, i) => `band ${i + 1}`), bands, transform: m.transform, crs: m.crs ?? '', geographic: !!m.geographic,
  };
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'result';

try {
  const out: Out = await tool!.run(ctx);
  const outputs: string[] = [];
  for (const l of out.layers ?? []) {
    if (!l.features.length) continue;
    const file = join(outDir, `${slug(l.name)}-${stamp}.geojson`);
    // provenance travels with the layer (earlier GeoSpaX stamped every derived layer the same way)
    writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', name: l.name, gsx: { tool: tool!.id, params, provenance: l.provenance ?? null }, features: l.features }));
    outputs.push(file);
  }
  for (const r of out.rasters ?? []) {
    // a float32 grid on the input's grid; GeoSpaX turns it into a GeoTIFF and adds it to the map
    const stem = join(outDir, `${slug(r.name)}-${stamp}`);
    const data = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    writeFileSync(`${stem}.f32`, data);
    writeFileSync(`${stem}.grid.json`, JSON.stringify({
      title: r.name, kind: r.kind ?? 'raster', units: r.units ?? '', description: r.description ?? '', classes: r.classes ?? null,
      width: r.like.width, height: r.like.height, transform: r.like.transform, crs: r.like.crs, data: `${stem}.f32`,
    }));
    outputs.push(`${stem}.grid.json`);
  }
  console.log(JSON.stringify({ ok: true, message: out.message, outputs, table: out.table ?? [], notes: out.notes ?? [], figures: out.figures ?? [] }));
} catch (err) {
  fail((err as Error).message ?? String(err));
}
