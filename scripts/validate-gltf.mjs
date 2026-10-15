// Validate glTF binaries with the Khronos glTF-Validator (npm `gltf-validator`, installed next to
// Playwright by scripts/setup-linux.sh --test-tools):
//   GLTF_VALIDATOR=/opt/pw/node_modules/gltf-validator node scripts/validate-gltf.mjs FILE.glb [...]
// Prints one JSON line per file (errors, warnings, what the validator saw) and the first issues;
// exits 1 when any file has an error.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const validator = require(process.env.GLTF_VALIDATOR ?? '/opt/pw/node_modules/gltf-validator');
let bad = 0;
for (const f of process.argv.slice(2)) {
  const report = await validator.validateBytes(new Uint8Array(readFileSync(f)), { maxIssues: 100 });
  const i = report.issues;
  const info = report.info ?? {};
  console.log(JSON.stringify({ file: f, errors: i.numErrors, warnings: i.numWarnings, infos: i.numInfos, hints: i.numHints, generator: info.generator, drawCalls: info.drawCallCount, vertices: info.totalVertexCount, triangles: info.totalTriangleCount, extensions: info.extensionsUsed }));
  for (const m of i.messages.filter((m) => m.severity <= 1).slice(0, 20)) console.log(`  ${m.severity === 0 ? 'ERROR' : 'WARNING'} ${m.code} ${m.pointer ?? ''}: ${m.message}`);
  if (i.numErrors > 0) bad++;
}
process.exit(bad ? 1 : 0);
