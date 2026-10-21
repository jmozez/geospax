// Finds (or fetches once) GeoLibre's tool runner, geolibre-cli.wasm, and runs it under Node's WASI.
// The binary is the one published as the npm package geolibre-wasm (MIT, opengeos/geolibre-rust),
// pinned to one version and checked against the registry's SHA-512 before it is used.
import { WASI } from 'node:wasi';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const VERSION = '1.7.1';
const TARBALL = `https://registry.npmjs.org/geolibre-wasm/-/geolibre-wasm-${VERSION}.tgz`;
const INTEGRITY = 'sha512-AFyENgRnlTPceEkyiruzAtdmVgA4OnijsfiKbQKEnGdBe62f+3GeHXraAbaKoan/rFx0Rz5vu620AWEFkozOuQ==';
const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(process.env.XDG_CACHE_HOME || (process.platform === 'win32' ? process.env.LOCALAPPDATA || homedir() : join(homedir(), '.cache')), 'geospax');

/** Where the runner is: $GEOSPAX_GEOLIBRE_WASM, next to this plugin, or the user cache. */
export function wasmPath() {
  const candidates = [process.env.GEOSPAX_GEOLIBRE_WASM, join(here, 'geolibre-cli.wasm'), join(cacheDir, `geolibre-cli-${VERSION}.wasm`)];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/** One file out of a .tgz (ustar), without a tar dependency. */
function untarOne(tgz, wanted) {
  const tar = gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    if (name === wanted) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not found in the package`);
}

/** Download the pinned package once, verify it, keep geolibre-cli.wasm in the user cache. */
export async function fetchWasm(log = (m) => process.stderr.write(`${m}\n`)) {
  const existing = wasmPath();
  if (existing) return existing;
  log(`GeoLibre tools: downloading geolibre-wasm ${VERSION} (about 9 MB, once)…`);
  const res = await fetch(TARBALL);
  if (!res.ok) throw new Error(`could not download ${TARBALL}: HTTP ${res.status}. Without internet, put geolibre-cli.wasm next to this plugin or set GEOSPAX_GEOLIBRE_WASM.`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const got = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  if (got !== INTEGRITY) throw new Error(`geolibre-wasm ${VERSION} failed its integrity check (expected ${INTEGRITY}, got ${got})`);
  const wasm = untarOne(tgz, 'package/geolibre-cli.wasm');
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, `geolibre-cli-${VERSION}.wasm`);
  writeFileSync(`${dest}.part`, wasm);
  renameSync(`${dest}.part`, dest);
  log(`GeoLibre tools: ready (${dest})`);
  return dest;
}

/** Run the tool runner with argv; preopens maps guest dirs (/in0, /out…) to host dirs. */
export async function runWasi(argv, preopens, { capture = true } = {}) {
  const path = await fetchWasm();
  const lines = [];
  const mod = await WebAssembly.compile(readFileSync(path));
  // stdout of the guest goes to a file we read back, so our own stdout stays clean JSON
  const outFile = join(preopens['/out'] ?? cacheDir, `.geolibre-stdout-${process.pid}.txt`);
  const { openSync, closeSync, readFileSync: rf, rmSync } = await import('node:fs');
  const fd = capture ? openSync(outFile, 'w') : 1;
  const wasi = new WASI({ version: 'preview1', args: ['geolibre', ...argv], preopens, stdout: fd, stderr: 2, returnOnExit: true });
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
  const code = wasi.start(inst);
  if (capture) {
    closeSync(fd);
    lines.push(...rf(outFile, 'utf8').split('\n').filter(Boolean));
    rmSync(outFile, { force: true });
  }
  return { code, lines };
}
