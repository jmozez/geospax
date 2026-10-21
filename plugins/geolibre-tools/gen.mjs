// Regenerates plugin.yaml (what GeoSpaX shows: names, groups, forms) and tools.json (what run.mjs
// needs: parameter roles and output types) from the tool runner's own manifests:
//   node gen.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, runWasi } from './runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { lines } = await runWasi(['manifests'], { '/out': here });
const manifests = JSON.parse(lines.join(''));
const ICON = { Analysis: 'layers', Cartography: 'layout', Conversion: 'download', 'Data Management': 'save', 'Spatial Statistics': 'hotspot', Interpolation: 'chart', 'Raster Analysis': 'grid', Terrain: 'image', Hydrology: 'chart', 'Image Analysis': 'satellite', 'LiDAR and 3D': 'satellite', 'Network Analysis': 'pin', 'Landscape Ecology': 'grid' };
const EXT = { raster: 'tif', vector: 'shp', lidar: 'las', table: 'csv', json: 'json', text: 'txt', file: 'txt' };
// Where each tool sits in the GeoSpaX Toolbox: "Toolbox › Toolset", named by task the way ArcGIS
// Pro and QGIS name theirs (Analysis, Conversion, Data Management, Spatial Statistics, Hydrology …),
// from the runner's own taxonomy (category/subcategory) with a few name rules for its catch-alls.
const TOOLBOX = {
  'Vector/Overlay Analysis': 'Analysis › Overlay',
  'Vector/Geometry Processing': 'Analysis › Geometry',
  'Vector/Attribute Analysis': 'Analysis › Fields and attributes',
  'Vector/Sampling & Gridding': 'Analysis › Sampling and grids',
  'Vector/Cartography & Generalization': 'Cartography › Generalization',
  'Vector/Spatial Statistics': 'Spatial Statistics',
  'Vector/Space-Time Analysis': 'Spatial Statistics › Space-time',
  'Vector/Shape Metrics': 'Landscape Ecology › Shape metrics',
  'Vector/Network Analysis': 'Network Analysis',
  'Vector/Linear Referencing': 'Network Analysis › Linear referencing',
  'Vector/3D Features': 'LiDAR and 3D › 3D features',
  'Vector/Online Data': 'Data Management › Online data',
  'Raster/Overlay Math': 'Raster Analysis › Map algebra',
  'Raster/Distance & Cost': 'Raster Analysis › Distance and cost',
  'Raster/Interpolation': 'Interpolation',
  'Raster/Zonal': 'Raster Analysis › Zonal',
  'Raster/Local Neighborhood': 'Raster Analysis › Neighbourhood',
  'Raster/Reclassify & Mask': 'Raster Analysis › Reclassify and mask',
  'Raster/Multidimensional': 'Raster Analysis › Multidimensional',
  'Raster/Spatial Statistics': 'Spatial Statistics › Rasters',
  'Terrain/General': 'Terrain › Surface',
  'Terrain/Derivatives': 'Terrain › Derivatives',
  'Terrain/Multiscale Signatures': 'Terrain › Multiscale',
  'Terrain/Visibility': 'Terrain › Visibility',
  'Terrain/Landform Indices': 'Terrain › Landforms',
  'Terrain/Roughness & Texture': 'Terrain › Roughness',
  'Terrain/Workflow Products': 'Terrain › Surface',
  'Hydrology/Flow Routing': 'Hydrology › Flow routing',
  'Hydrology/Depressions & Storage': 'Hydrology › Depressions',
  'Hydrology/Hydrologic Indices': 'Hydrology › Indices',
  'Hydrology/Watersheds & Basins': 'Hydrology › Watersheds',
  'Hydrology/Streams - Ordering Metrics': 'Hydrology › Stream networks',
  'Hydrology/Streams - Network Extraction': 'Hydrology › Stream networks',
  'Hydrology/Streams - Longitudinal Analysis': 'Hydrology › Stream networks',
  'Remote Sensing/Filters': 'Image Analysis › Filters',
  'Remote Sensing/OBIA': 'Image Analysis › Segmentation (OBIA)',
  'Remote Sensing/SAR': 'Image Analysis › Radar (SAR)',
  'Remote Sensing/Enhancement & Contrast': 'Image Analysis › Enhancement',
  'Remote Sensing/Classification': 'Image Analysis › Classification',
  'Remote Sensing/Spectral Analytics': 'Image Analysis › Spectral indices',
  'Remote Sensing/Change Detection': 'Image Analysis › Change detection',
  'Remote Sensing/Edge & Feature Detection': 'Image Analysis › Edges and features',
  'Remote Sensing/Radiometric Correction': 'Image Analysis › Correction',
  'Remote Sensing/Thermal & Emissivity': 'Image Analysis › Thermal',
  'LiDAR/Filtering & Classification': 'LiDAR and 3D › Filter and classify',
  'LiDAR/Interpolation & Gridding': 'LiDAR and 3D › Gridding',
  'LiDAR/Analysis Metrics': 'LiDAR and 3D › Metrics',
  'LiDAR/I/O & Management': 'LiDAR and 3D › Manage',
  'Conversion/Vector & Table I/O': 'Conversion › Vector and tables',
  'Conversion/Raster/Vector Conversion': 'Conversion › Raster and vector',
  'Conversion/Geometry & Topology': 'Conversion › Geometry and topology',
  'Conversion/Tiles & Web Formats': 'Conversion › Tiles and web',
  'Projection/Georeferencing': 'Data Management › Projections',
};
// the runner's "Raster › General" catch-all, sorted by what each tool does
const RASTER_GENERAL = [
  [/^(abs|arc|ar[cst]|atan|ceil|cos|exp|floor|ln|log|max|min|negate|reciprocal|round|sin|sqrt|square|tan|truncate|to(degrees|radians)|integerdivision|increment|decrement|inplace|equalto|notequalto|greaterthan|lessthan|isnodata|raster calculator|rescale|raster normalize|z scores|quantiles)/i, 'Raster Analysis › Math'],
  [/^(anova|k-s|two sample|paired|wilcoxon|kappa|phi coeff|root mean|cumulative|raster histogram|raster summary|list unique|image (auto)?correlation|image regression|trend surface|principal comp|inverse pca)/i, 'Spatial Statistics › Rasters'],
  [/random forest/i, 'Image Analysis › Classification'],
  [/(shape complexity|narrowness|radius of gyration|edge proportion|patch edge|crispness|raster area|raster perimeter|clump|sieve|filter raster features|locate regions|centroid raster|boundary shape)/i, 'Landscape Ecology › Patches'],
  [/(random field|turning bands|random sample|create plane|heat map|dbscan)/i, 'Raster Analysis › Generate'],
];
const toolset = (m) => {
  const key = `${m.taxonomy?.category ?? m.category}/${m.taxonomy?.subcategory ?? 'General'}`;
  if (TOOLBOX[key]) return TOOLBOX[key];
  if (key === 'Raster/General') return RASTER_GENERAL.find(([re]) => re.test(m.display_name))?.[1] ?? 'Data Management › Rasters';
  return `${m.taxonomy?.category ?? m.category}`;
};
// "AddPointCoordinatesToTable" → "Add Point Coordinates To Table" (spaced names, like every other tool)
const FIX = [[/\bCsv\b/g, 'CSV'], [/\bGeo Tiff\b/g, 'GeoTIFF'], [/\bLand Trendr\b/g, 'LandTrendr'], [/^Bool /, 'Boolean '], [/\bNodata\b/g, 'NoData']];
const spaced = (n) => {
  const s = /\s/.test(n) ? n : n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return FIX.reduce((x, [re, to]) => x.replace(re, to), s);
};
const q = (s) => JSON.stringify(String(s ?? '').replace(/\s+/g, ' ').trim());
const label = (n) => n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const specs = {};
const out = [
  '# GeoLibre tools in GeoSpaX. Generated by gen.mjs from geolibre-wasm ' + VERSION + ' (do not edit by hand).',
  '# Each tool runs the GeoLibre / whitebox_next_gen tool runner under Node\'s WASI: see run.mjs.',
  'plugin: geolibre-tools',
  `version: ${VERSION}`,
  'title: Toolbox (raster, vector, terrain, hydrology, imagery, LiDAR)',
  `description: ${q(`${manifests.length} raster, vector, LiDAR, hydrology, terrain and imagery tools, run locally on WebAssembly (the GeoLibre / whitebox_next_gen tool runner, about 9 MB, downloaded once on first use).`)}`,
  'author: opengeos (GeoLibre, geolibre-rust) · whitebox_next_gen (John Lindsay) · plugin by GeoSpaX',
  'license: MIT',
  'homepage: https://github.com/opengeos/geolibre-rust',
  'kind: process',
  'run: node --no-warnings ${plugin}/run.mjs ${tool}',
  'tools:',
];
for (const m of manifests.sort((a, b) => toolset(a).localeCompare(toolset(b)) || a.display_name.localeCompare(b.display_name))) {
  const ps = [];
  specs[m.id] = { name: m.display_name, params: [] };
  for (const p of m.params) {
    const role = p.io_role === 'input' ? 'input' : p.io_role === 'output' ? 'output' : 'value';
    const ext = role === 'output' ? (String(m.defaults?.[p.name] ?? '').split('.').pop() || EXT[p.data_kind] || 'out') : undefined;
    specs[m.id].params.push({ name: p.name, label: label(p.name), role, data: p.data_kind, required: !!p.required, ...(ext ? { ext: ext.length <= 8 ? ext : EXT[p.data_kind] ?? 'out' } : {}) });
    if (role === 'output') continue;
    let kind = 'text';
    const extra = [];
    if (role === 'input') kind = p.data_kind === 'vector' ? 'layer' : 'file';
    else if (p.schema?.kind === 'enum') {
      kind = 'choice';
      extra.push(`choices: [${p.schema.options.map((o) => q(o.value)).join(', ')}]`);
    } else if (p.data_kind === 'bool') kind = 'bool';
    else if (p.data_kind === 'number') kind = 'number';
    const def = m.defaults?.[p.name];
    if (role === 'value' && def !== undefined && def !== null && typeof def !== 'object') extra.push(`default: ${typeof def === 'string' ? q(def) : def}`);
    const desc = role === 'input' && kind === 'file' ? p.data_kind === "file" ? `${p.description} (a path)` : `${p.description} (path to a ${p.data_kind} file)` : p.description;
    ps.push(`      - { name: ${q(p.name)}, label: ${q(label(p.name))}, kind: ${kind}, required: ${!!p.required}, description: ${q(desc)}${extra.length ? ', ' + extra.join(', ') : ''} }`);
  }
  const ts = toolset(m);
  out.push(`  - id: ${q(m.id)}`, `    name: ${q(spaced(m.display_name))}`, `    summary: ${q(m.summary)}`, `    group: ${q(ts)}`, `    icon: ${ICON[ts.split(' › ')[0]] ?? 'grid'}`);
  out.push(ps.length ? `    params:\n${ps.join('\n')}` : '    params: []');
}
writeFileSync(join(here, 'plugin.yaml'), out.join('\n') + '\n');
writeFileSync(join(here, 'tools.json'), JSON.stringify(specs));
console.log(`wrote ${manifests.length} tools`);
