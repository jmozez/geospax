// GeoSpaX plugin contract (docs/PLUGINS.md): one JSON request on stdin, one JSON answer on stdout.
//   node run.mjs <tool>      run a GeoLibre tool on the request's params
//   node run.mjs --fetch     download the tool runner now (otherwise it is fetched on first use)
// Inputs: a vector parameter names a layer (resolved to its file through layer_sources); raster,
// LiDAR and table parameters take a file path. Outputs are written to out_dir and listed in
// "outputs", so GeoSpaX adds them to the map.
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWasm, runWasi } from './runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.argv[2] === '--fetch') {
  await fetchWasm((m) => console.log(m));
  process.exit(0);
}

const toolId = process.argv[2];
const specs = JSON.parse(readFileSync(join(here, 'tools.json'), 'utf8'));
const spec = specs[toolId];
if (!spec) fail(`GeoLibre has no tool '${toolId}'`);
const req = JSON.parse(readFileSync(0, 'utf8') || '{}');
const params = req.params ?? {};
const sources = req.layer_sources ?? {};
const outDir = req.out_dir ?? process.cwd();

const preopens = { '/out': outDir };
const mounted = new Map(); // host dir -> guest dir
const guest = (hostPath) => {
  const abs = resolve(hostPath);
  const dir = dirname(abs);
  if (!mounted.has(dir)) {
    const g = `/in${mounted.size}`;
    mounted.set(dir, g);
    preopens[g] = dir;
  }
  return `${mounted.get(dir)}/${basename(abs)}`;
};

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const args = [];
const outputs = [];
// the tool's main output is the parameter named 'output' when there is one; the runner's manifests
// also mark a few choices as outputs (network_service_area's output_mode: nodes, edges or polygons)
const hasOutput = spec.params.some((p) => p.role === 'output' && p.name === 'output');
for (const p of spec.params) {
  let v = params[p.name];
  if (p.role === 'output' && p.name.endsWith('_mode')) {
    if (v !== undefined && v !== null && v !== '') args.push(`--${p.name}=${v}`);
    continue;
  }
  if (p.role === 'output') {
    if (!p.required && (outputs.length || (hasOutput && p.name !== 'output'))) continue; // one main output is enough
    const file = `${toolId}-${p.name === 'output' ? '' : `${p.name}-`}${stamp}.${p.ext}`;
    args.push(`--${p.name}=/out/${file}`);
    outputs.push(join(outDir, file));
    continue;
  }
  if (v === undefined || v === null || v === '') {
    // a required layer left empty means the first map layer; optional ones (barriers, extra points) stay off
    if (p.required && p.role === 'input' && p.data === 'vector' && Object.keys(sources).length) v = Object.keys(sources)[0];
    else if (p.required) fail(`${spec.name}: '${p.label}' is required`);
    else continue;
  }
  if (p.role === 'input') {
    const path = p.data === 'vector' && sources[v] ? sources[v] : String(v);
    if (!isAbsolute(path) && !path.includes('/')) {
      // a bare name: look in the folder of the first layer (usually the data folder)
      const first = Object.values(sources)[0];
      args.push(`--${p.name}=${guest(first ? join(dirname(first), path) : path)}`);
    } else args.push(`--${p.name}=${guest(path)}`);
    continue;
  }
  args.push(`--${p.name}=${typeof v === 'boolean' ? (v ? 'true' : 'false') : v}`);
}

const { code, lines } = await runWasi([toolId, ...args], preopens);
if (code !== 0) fail(`${spec.name} failed (exit ${code}): ${lines.slice(-3).join(' ') || 'no message'}`);
const made = outputs.filter((f) => {
  try {
    return readFileSync(f).length > 0;
  } catch {
    return false;
  }
});
console.log(JSON.stringify({ ok: true, message: `${spec.name}: ${made.length ? made.map((f) => basename(f)).join(', ') : 'done'}`, outputs: made, log: lines.slice(-20) }));
