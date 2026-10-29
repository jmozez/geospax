import { readFileSync } from 'node:fs';
const SC = JSON.parse(readFileSync(process.env.GS_WORK + '/suitcounts.json'));
const r = (x) => 'r:' + x;
const g = (field, breaks, colors, o = {}) => ({ symbology: { kind: 'graduated', field, method: o.method ?? 'quantile', ramp: o.ramp ?? 'viridis', breaks, colors, counts: o.counts ?? breaks.map(() => 0), min: o.min ?? 0 }, ...(o.fill ? { fill: { fill: true, strokeDash: 'solid', ...o.fill } } : {}), ...(o.line ? { line: { dash: 'solid', cap: 'round', join: 'round', ...o.line } } : {}), ...(o.point ? { point: o.point } : {}), opacity: o.opacity ?? 0.85, outline: !!o.fill });
const S5 = [0.2, 0.4, 0.6, 0.8, 1.0];
const cellsView = { center: [146.83, -6.63], zoom: 10.05 };
const fill = { strokeColor: 'rgba(0,0,0,0.25)', strokeWidth: 0.3 };
const suit = (file, id, colors, br, ramp) => { const k = id.split('_').pop(); return { file, keep: [id], style: { [id]: g('suitability', SC[k].breaks, colors, { fill, opacity: 0.8, counts: SC[k].counts, min: SC[k].min, ramp }) }, view: cellsView, focus: id }; };
const C = JSON.parse(readFileSync(process.env.GS_WORK + '/clusters.json'));
const MARINE = { symbology: { kind: 'unique', field: 'dbscan_cluster', ramp: 'viridis', classes: C.classes, other: '#9e9e9e', othersCount: C.other }, point: { shape: 'circle', size: 16, strokeColor: '#0b1a2a', strokeWidth: 1.2 }, opacity: 1 };
import { execSync } from 'node:child_process';
const fileOf = (id) => { const f = execSync(`find ${process.env.GS_WORK}/state ${process.env.GS_WORK}/data -name '${id}*' \\( -name '*.geojson' -o -name '*.gpkg' \\) | head -1`).toString().trim();
  if (!f.endsWith('.gpkg')) return f; const o = `${process.env.GS_WORK}/cache-${id}.geojson`; execSync(`rm -f ${o}; ogr2ogr -f GeoJSON ${o} ${f}`); return o; };
// quantile classes from the real feature values, zeros/nulls optionally dropped into a clear first class
const q = (id, field, colors, o = {}) => {
  const v = JSON.parse(readFileSync(fileOf(id))).features.map((f) => f.properties[field]).filter((x) => x != null).map(Number).sort((a, b) => a - b);
  const pos = o.zeroClear ? v.filter((x) => x > 0) : v; const n = colors.length - (o.zeroClear ? 1 : 0);
  let br = Array.from({ length: n }, (_, i) => pos[Math.min(pos.length - 1, Math.ceil(((i + 1) * pos.length) / n) - 1)]);
  if (o.round) br = br.map((b) => Math.round(b / o.round) * o.round);
  br = [...new Set(br)]; if (o.zeroClear) br = [0, ...br];
  let lo = -Infinity; const counts = br.map((u) => { const c = v.filter((x) => x > lo && x <= u).length; lo = u; return c; });
  return g(field, br, colors.slice(colors.length - br.length), { ...o, counts, min: v[0], method: 'quantile' });
};
export default [
{ file: 'ribbon-swipe', keep: ['core-areas-300-m-edge-20261029-223410.geojson'], style: { 'core-areas-300-m-edge-20261029-223410.geojson': { symbology: { kind: 'single', color: '#2fbf71' }, fill: { fill: true, strokeColor: '#b8f5c9', strokeWidth: 1, strokeDash: 'solid' }, outline: true, opacity: 0.7 } },
  view: { center: [146.8, -6.62], zoom: 10.6 }, focus: 'core-areas-300-m-edge-20261029-223410.geojson',
  extra: async (p) => { await p.locator('text=View').first().click(); await p.waitForTimeout(800); await p.locator('button:has-text("Swipe")').first().click(); await p.waitForTimeout(2500); } },
{ file: 'ribbon-time', keep: ['g-gbif-birds.gbif_aves'], style: { 'g-gbif-birds.gbif_aves': { symbology: { kind: 'single', color: '#ffca28' }, point: { shape: 'circle', size: 9, strokeColor: '#1a1a1a', strokeWidth: 1.2 }, opacity: 1 } }, view: { center: [146.97, -6.69], zoom: 11.2 }, focus: 'g-gbif-birds.gbif_aves',
  extra: async (p) => { await p.locator('text=View').first().click(); await p.waitForTimeout(800); await p.evaluate(() => document.dispatchEvent(new CustomEvent('geospax:x', { detail: 'time' }))); await p.waitForTimeout(1500); await p.locator('input[name=acc]').check().catch((x) => console.log('acc', x.message)); await p.locator('button:has-text("Start")').last().click(); await p.waitForTimeout(1500); await p.waitForTimeout(3000); await p.evaluate(() => { const e = document.querySelector('.gx-time input[type=range]'); e.value = String(Math.round(Number(e.max) * 0.8)); e.dispatchEvent(new Event('input', { bubbles: true })); }); await p.waitForTimeout(3000); } },
{ file: 'ribbon-view', keep: [r('g-worldcover.worldcover_2021')], view: { center: [146.99, -6.715], zoom: 12.3 }, extra: async (p) => { await p.locator('text=View').first().click(); await p.waitForTimeout(800); } },
{ file: 'tour-landcover', keep: [r('g-worldcover.worldcover_2021')], ropacity: { worldcover: 0.9 }, view: { center: [146.99, -6.715], zoom: 12.3 }, focus: 'r:g-worldcover.worldcover_2021' },
{ file: 'tour-classification', keep: [r('g-embed.lae_landcover_classified'), 'lae_training_samples.geojson'], style: { 'lae_training_samples.geojson': { symbology: { kind: 'single', color: '#ffffff' }, point: { shape: 'circle', size: 8, strokeColor: '#111111', strokeWidth: 1.5 }, opacity: 1 } }, view: { center: [146.99, -6.715], zoom: 12.3 }, focus: 'r:g-embed.lae_landcover_classified' },
{ file: 'tour-clustering', keep: [r('g-embed.lae_clusters')], ropacity: { lae_clusters: 0.85 }, view: { center: [146.99, -6.715], zoom: 12.3 }, focus: 'r:g-embed.lae_clusters' },
{ file: 'tour-dem-wilhelm', keep: [r('g-wilhelm.hillshade'), r('g-wilhelm.mount_wilhelm_dem_30m')], ropacity: { mount_wilhelm: 0.6 }, view: { center: [145.03, -5.78], zoom: 11.2 }, focus: 'r:g-wilhelm.mount_wilhelm_dem_30m' },
{ file: 'tour-dem-3d', keep: [r('g-wilhelm.mount_wilhelm_dem_30m')], ropacity: { mount_wilhelm: 0.55 }, view: { center: [145.03, -5.78], zoom: 11.6 }, focus: 'r:g-wilhelm.mount_wilhelm_dem_30m', wait: 12000,
  extra: async (p) => { await p.evaluate(() => document.dispatchEvent(new CustomEvent('geospax:terrain3d'))); await p.waitForTimeout(4000); await p.evaluate(() => window.map.easeTo({ pitch: 70, bearing: -30, zoom: 11.3, duration: 0 })); } },
{ file: 'tour-network', keep: ['lae_health_access.geojson', 'lae_health_facilities.geojson'],
  style: { 'lae_health_access.geojson': { symbology: { kind: 'unique', field: 'band', ramp: 'viridis', classes: [{ value: 'Within 500 m', color: '#1a9850', count: 1053 }, { value: 'Within 1 km', color: '#fee08b', count: 1882 }, { value: 'Within 2 km', color: '#f46d43', count: 2938 }], other: 'rgba(160,160,170,0.55)', othersCount: 1985 }, line: { width: 2.4, cap: 'round', join: 'round', casingWidth: 0.8, casingColor: 'rgba(0,0,0,0.6)' }, opacity: 1 },
           'lae_health_facilities.geojson': { symbology: { kind: 'single', color: '#ff1744' }, point: { shape: 'cross', size: 16, strokeColor: '#ffffff', strokeWidth: 1.6 }, opacity: 1 } },
  view: { center: [147.0, -6.715], zoom: 13.1 }, focus: 'lae_health_access.geojson' },
 { file: 'tour-hydrology', keep: [r('g-markham.hillshade'), 'g-markham.markham_basins', 'g-markham.markham_streams'],
   style: { 'g-markham.markham_streams': g('strahler', [1, 2, 3, 4, 5], ['#c6dbef', '#6baed6', '#3d8fe0', '#1f6fd1', '#0b4fb3'], { min: 1, method: 'jenks', ramp: 'blues', counts: [865, 434, 230, 91, 54], line: { width: 1.8, casingWidth: 0.8, casingColor: 'rgba(0,20,40,0.6)' }, opacity: 1 }),
            'g-markham.markham_basins': { symbology: { kind: 'single', color: '#ffd54f' }, fill: { fill: false, strokeColor: '#ffd54f', strokeWidth: 2, strokeDash: 'dashed' }, outline: true, opacity: 0.95 },
            },
   ropacity: { 'hillshade': 0.4 },
   view: { center: [146.78, -6.58], zoom: 10.3 }, focus: 'g-markham.markham_streams' },
 suit('plugin-agriculture', 'g-s-agri.suit_agri', ['#f7fcb9', '#d9f0a3', '#addd8e', '#41ab5d', '#006837'], [0.305, 0.416, 0.624, 0.778, 1], 'greens'),
 suit('plugin-soil', 'g-s-soil.suit_soil', ['#fff7bc', '#fee391', '#fec44f', '#d95f0e', '#8c2d04'], [0.234, 0.331, 0.397, 0.479, 1], 'ylorrd'),
 suit('plugin-disaster', 'g-s-disaster.suit_disaster', ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'], [0.15, 0.269, 0.409, 0.525, 1], 'ylorrd'),
 suit('plugin-climate', 'g-s-climate.suit_climate', ['#f1eef6', '#bdc9e1', '#74a9cf', '#2b8cbe', '#045a8d'], [0.662, 0.841, 0.941, 0.973, 1], 'blues'),
 suit('plugin-hydrology', 'g-s-hydro.suit_hydro', ['#f0f9e8', '#bae4bc', '#7bccc4', '#43a2ca', '#0868ac'], [0.42, 0.558, 0.722, 0.837, 1], 'blues'),
 { file: 'plugin-geoscience', keep: [r('slope-zones-elevation-20261029-222157')], ropacity: { 'slope-zones-elevation': 0.6 }, view: { center: [146.75, -6.6], zoom: 10.2 }, focus: 'r:slope-zones-elevation-20261029-222157' },
 { file: 'plugin-conservation', keep: [r('g-gebco2.gebco_2026'), 'hotspot-grid-8-km-20261029-223124.geojson'],
   style: { 'hotspot-grid-8-km-20261029-223124.geojson': g('hotspot_score', [0.25, 1, 3, 10, 30, 93], ['rgba(0,0,0,0)', '#fdd49e', '#fc8d59', '#e34a33', '#b30000', '#7f0000'], { method: 'jenks', ramp: 'ylorrd', counts: [672, 23, 14, 15, 8, 8], min: 0, fill: { strokeColor: 'rgba(255,255,255,0.35)', strokeWidth: 0.6 }, opacity: 0.88 }) },
   view: { center: [147.75, -6.65], zoom: 8.35 }, focus: 'hotspot-grid-8-km-20261029-223124.geojson' },
 { file: 'plugin-marine', keep: [r('g-gebco2.gebco_2026'), 'g-obis2-obis-actinopteri-clusters-20261029-223123.geojson'], style: { 'g-obis2-obis-actinopteri-clusters-20261029-223123.geojson': MARINE },
   view: { center: [147.75, -6.65], zoom: 8.6 }, focus: 'g-obis2-obis-actinopteri-clusters-20261029-223123.geojson' },

 { file: 'plugin-biodiversity', keep: ['g-birds.bird_richness_5km'],
   style: { 'g-birds.bird_richness_5km': q('bird_richness_5km', 'richness', ['#edf8fb', '#b3cde3', '#8c96c6', '#8856a7', '#810f7c'], { ramp: 'magma', fill: { strokeColor: 'rgba(255,255,255,0.4)', strokeWidth: 0.6 }, opacity: 0.85 }) },
   view: { center: [146.93, -6.69], zoom: 9.2 }, focus: 'g-birds.bird_richness_5km' },
 { file: 'plugin-forestry', keep: ['patches-with-metrics-20261029-223410.geojson', 'core-areas-300-m-edge-20261029-223410.geojson'],
   style: { 'patches-with-metrics-20261029-223410.geojson': { symbology: { kind: 'single', color: '#ff9f1c' }, fill: { fill: false, strokeColor: '#ffb347', strokeWidth: 1.6, strokeDash: 'solid' }, outline: true, opacity: 1 },
            'core-areas-300-m-edge-20261029-223410.geojson': { symbology: { kind: 'single', color: '#2fbf71' }, fill: { fill: true, strokeColor: '#b8f5c9', strokeWidth: 0.8, strokeDash: 'solid' }, outline: true, opacity: 0.42 } },
   view: { center: [146.8, -6.62], zoom: 10.1 }, focus: 'core-areas-300-m-edge-20261029-223410.geojson' },
 { file: 'plugin-lulc', keep: [r('g-hansen2.hansen_lossyear')], view: { center: [146.8, -6.62], zoom: 10.6 }, focus: 'r:g-hansen2.hansen_lossyear' },
 { file: 'plugin-environment', keep: ['markham_transect.geojson', 'markham-transect-profile-points-20261029-223420.geojson'],
   ropacity: { hillshade: 0.35 },
   style: { 'markham_transect.geojson': { symbology: { kind: 'single', color: '#ffffff' }, line: { width: 3, dash: 'solid', cap: 'round', join: 'round', casingWidth: 2, casingColor: 'rgba(0,0,0,0.6)' }, opacity: 1 },
            'markham-transect-profile-points-20261029-223420.geojson': q('markham-transect-profile-points-20261029-223420', 'elev', ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'], { ramp: 'rdylbu', round: 10, point: { shape: 'circle', size: 10, strokeColor: '#111', strokeWidth: 0.6 }, opacity: 1 }) },
   view: { center: [146.975, -6.59], zoom: 10.3 }, focus: 'markham-transect-profile-points-20261029-223420.geojson' },
];
