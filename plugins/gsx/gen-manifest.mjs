// Writes the manifests from the tool list in run.mjs (node run.mjs --manifest), so they never drift
// from the code. Run after `npm run build`.
//   plugins/gsx/plugin.yaml              the shared tool library (library: true): recipes, the API and
//                                        MCP call its tools as gsx/<tool>; not listed in the app
//   plugins/geospax-<domain>/plugin.yaml the twelve default domain plugins of earlier GeoSpaX, each with
//                                        its set of tools, run by the same run.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const tools = JSON.parse(execFileSync(process.execPath, ['run.mjs', '--manifest'], { encoding: 'utf8' }));
const byId = new Map(tools.map((t) => [t.id, t]));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const q = (s) => JSON.stringify(String(s));

// The twelve workbenches of earlier GeoSpaX and the
// workflows each exposed, mapped to the tools that carry them in 3.0.
export const DOMAINS = [
  ['conservation', 'Conservation', 'shield', 'Overlay, hot spots, clusters, priority sites, minimum-cost representation, species distribution, suitability, protection gaps, fragmentation, connectivity and change.',
    ['overlay', 'hotspot-grid', 'dbscan', 'local-moran', 'priority-sites', 'representation', 'sdm', 'suitability', 'protection-gap', 'fragmentation', 'connectivity', 'change']],
  ['agriculture', 'Agriculture', 'leaf', 'Crop condition from spectral indices, suitability, distance decay, slope zones and crop change.',
    ['spectral-index', 'suitability', 'distance-decay', 'slope-zones', 'raster-change', 'change']],
  ['biodiversity', 'Biodiversity', 'paw', 'Richness and diversity, point patterns, clusters, hot spots, species distribution, priority sites and protection gaps.',
    ['diversity', 'nearest-neighbour', 'dbscan', 'local-moran', 'hotspot-grid', 'sdm', 'priority-sites', 'protection-gap']],
  ['environment', 'Environment', 'globe', 'Slope zones, spectral indices, raster change, overlay and elevation profiles.',
    ['slope-zones', 'spectral-index', 'raster-change', 'overlay', 'elevation-profile']],
  ['forestry', 'Forestry', 'tree', 'Forest and burn extent, landscape metrics, connectivity, loss and gain, and forest protection gaps.',
    ['spectral-index', 'fragmentation', 'connectivity', 'raster-change', 'change', 'protection-gap']],
  ['marine', 'Marine', 'wave', 'Richness and diversity, point patterns, clusters, species distribution, habitat extent, priorities and marine protected area gaps.',
    ['diversity', 'nearest-neighbour', 'dbscan', 'sdm', 'spectral-index', 'suitability', 'hotspot-grid', 'priority-sites', 'protection-gap']],
  ['climate', 'Climate', 'sun', 'Moisture and burn stress, climate vulnerability, distance decay and signal change.',
    ['spectral-index', 'suitability', 'distance-decay', 'raster-change', 'change']],
  ['disaster', 'Disaster', 'alert', 'Multi-hazard susceptibility, slope triggers, hazard footprints, response access, priorities, impact change and hot spots.',
    ['suitability', 'slope-zones', 'spectral-index', 'distance-decay', 'priority-sites', 'raster-change', 'change', 'hotspot-grid', 'local-moran']],
  ['geoscience', 'Geoscience', 'mountain', 'Slope classes, spectral-ratio proxies, prospectivity, geological overlay, surface change and profiles.',
    ['slope-zones', 'spectral-index', 'suitability', 'overlay', 'raster-change', 'change', 'elevation-profile']],
  ['hydrology', 'Hydrology', 'drop', 'Open water and wetness, runoff terrain, catchment characteristics, riparian distance decay, overlays, water-extent change and profiles.',
    ['spectral-index', 'slope-zones', 'suitability', 'distance-decay', 'overlay', 'raster-change', 'change', 'elevation-profile']],
  ['lulc', 'Land use and land cover', 'grid', 'Cover indices, two-date transitions with hectares, field-validation overlays and land-use allocation.',
    ['spectral-index', 'raster-change', 'change', 'overlay', 'suitability']],
  ['soil', 'Soil', 'layers', 'Moisture and salinity proxies, land capability, management access, survey overlays and change.',
    ['spectral-index', 'suitability', 'distance-decay', 'overlay', 'raster-change', 'change']],
];

function toolLines(list, group) {
  const lines = ['tools:'];
  for (const t of list) {
    lines.push(`  - id: ${q(t.id)}`, `    name: ${q(t.name)}`, `    summary: ${q(t.summary)}`, `    group: ${q(group ?? t.group)}`, `    icon: ${t.icon}`, '    params:');
    for (const p of t.params) {
      const f = [`name: ${q(p.name)}`, `label: ${q(p.label)}`, `kind: ${p.kind}`];
      if (p.required) f.push('required: true');
      if (p.default !== undefined) f.push(`default: ${JSON.stringify(p.default)}`);
      if (p.description) f.push(`description: ${q(p.description)}`);
      if (p.choices) f.push(`choices: [${p.choices.map(q).join(', ')}]`);
      lines.push(`      - { ${f.join(', ')} }`);
    }
  }
  return lines;
}

const common = ['author: in4metrix', 'license: MIT', 'homepage: https://github.com/jmozez/geospax', 'kind: process', 'geojson: true'];

writeFileSync('plugin.yaml', [
  '# GSX tool library for GeoSpaX 3. Generated by gen-manifest.mjs from src/ (do not edit by hand).',
  '# The analysis is by in4metrix (MIT). The app shows it',
  '# through the twelve geospax-<domain> plugins; recipes, the API and MCP call it as gsx/<tool>.',
  'plugin: gsx', `version: ${pkg.version}`, 'title: GSX tool library',
  `description: ${q(`${tools.length} conservation, landscape and biodiversity tools shared by the twelve domain plugins. Runs on Node, offline.`)}`,
  ...common, 'library: true', 'run: node --no-warnings ${plugin}/run.mjs ${tool}', ...toolLines(tools), '',
].join('\n'));

const used = new Set();
for (const [id, title, , description, ids] of DOMAINS) {
  const list = ids.map((x) => {
    const t = byId.get(x);
    if (!t) throw new Error(`geospax-${id}: no tool ${x}`);
    used.add(x);
    return t;
  });
  mkdirSync(`../geospax-${id}`, { recursive: true });
  writeFileSync(`../geospax-${id}/plugin.yaml`, [
    `# GeoSpaX ${title} plugin, one of the twelve default plugins. Generated by plugins/gsx/gen-manifest.mjs`,
    '# (do not edit by hand); its tools run from the shared GSX library in plugins/gsx.',
    `plugin: geospax-${id}`, `version: ${pkg.version}`, `title: ${q(title)}`, `description: ${q(description)}`,
    ...common, 'default: true', 'run: node --no-warnings ${plugin}/../gsx/run.mjs ${tool}', ...toolLines(list, title), '',
  ].join('\n'));
}
const orphans = tools.filter((t) => !used.has(t.id)).map((t) => t.id);
if (orphans.length) throw new Error(`tools in no domain plugin: ${orphans.join(', ')}`);
console.log(`plugin.yaml: ${tools.length} tools; ${DOMAINS.length} domain plugins`);
