// Basemaps (View › Basemap gallery; Contents › Basemap), as ArcGIS Pro's gallery and QGIS's XYZ tiles.
// Every online source states its licence or terms here and in the gallery, so nobody uses one unknowingly.
// "offline" is Natural Earth shipped with the app (main.ts draws it); "custom" is the user's own XYZ URL.
import type * as maplibregl from 'maplibre-gl';

export interface BasemapDef {
  id: string;
  title: string;
  group: 'Offline' | 'Streets and topography' | 'Imagery' | 'Daily satellite (NASA)' | 'Ocean and relief' | 'Light and dark canvas' | 'Your own';
  tiles?: string[];
  tileSize?: number;
  maxzoom?: number;
  attribution?: string;
  /** licence or terms of use, shown in the gallery */
  terms: string;
  /** imagery stays as it is; street maps are toned down so the data carries the colour */
  dim?: boolean;
}

/** Yesterday (UTC) as YYYY-MM-DD: today's daily satellite mosaic is still filling in. */
function gibsDay(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

export const BASEMAPS: BasemapDef[] = [
  { id: 'offline', title: 'World (offline)', group: 'Offline', terms: 'Natural Earth 1:50m, public domain; bundled, works without internet' },
  {
    id: 'osm', title: 'OpenStreetMap', group: 'Streets and topography', dim: true, maxzoom: 19,
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    terms: 'ODbL data; OSM tile usage policy (light use, no bulk downloads)',
  },
  {
    id: 'topo', title: 'OpenTopoMap', group: 'Streets and topography', dim: true, maxzoom: 17,
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    terms: 'CC-BY-SA; contour lines and hill shading, good for field work',
  },
  {
    id: 'esri-topo', title: 'Esri Topographic', group: 'Streets and topography', maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Sources: Esri, HERE, Garmin, USGS, NGA, EPA, USDA, NPS, © OpenStreetMap contributors and the GIS user community',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'esri-imagery', title: 'Esri World Imagery', group: 'Imagery', maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Esri, Maxar, Earthstar Geographics and the GIS user community',
    terms: "High-resolution imagery; Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 's2cloudless', title: 'Sentinel-2 cloudless 2016 (EOX)', group: 'Imagery', maxzoom: 15,
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'],
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless - https://s2maps.eu</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016)',
    terms: 'CC-BY 4.0 (the 2016 edition); 10 m, cloud-free, free for any use with credit',
  },
  {
    id: 'carto-light', title: 'Light canvas (CARTO Positron)', group: 'Light and dark canvas', maxzoom: 20,
    tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`),
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    terms: 'Free for non-commercial use; CARTO licence needed for commercial use',
  },
  {
    id: 'carto-dark', title: 'Dark canvas (CARTO Dark Matter)', group: 'Light and dark canvas', maxzoom: 20,
    tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    terms: 'Free for non-commercial use; CARTO licence needed for commercial use',
  },

  // ---- More basemaps, in the spirit of the QGIS HCMGIS plugin's basemap list. Only services whose
  // terms allow use in third-party apps are listed (no Google or Bing tiles, which forbid it).
  {
    id: 'osm-hot', title: 'Humanitarian (HOT)', group: 'Streets and topography', dim: true, maxzoom: 19,
    tiles: ['a', 'b'].map((s) => `https://${s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png`),
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, style © Humanitarian OpenStreetMap Team, hosted by OSM France',
    terms: 'ODbL data; OSM France tile policy (light use)',
  },
  {
    id: 'cyclosm', title: 'CyclOSM (paths and tracks)', group: 'Streets and topography', dim: true, maxzoom: 19,
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, style © CyclOSM, hosted by OSM France',
    terms: 'ODbL data; OSM France tile policy (light use)',
  },
  {
    id: 'esri-street', title: 'Esri World Street Map', group: 'Streets and topography', maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NGA, © OpenStreetMap contributors',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'esri-natgeo', title: 'Esri National Geographic style', group: 'Streets and topography', maxzoom: 16,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'National Geographic, Esri, Garmin, HERE, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA, increment P',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'esri-gray', title: 'Esri Light Gray canvas', group: 'Light and dark canvas', maxzoom: 16,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'esri-darkgray', title: 'Esri Dark Gray canvas', group: 'Light and dark canvas', maxzoom: 16,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'carto-voyager', title: 'CARTO Voyager', group: 'Light and dark canvas', maxzoom: 20,
    tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`),
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    terms: 'Free for non-commercial use; CARTO licence needed for commercial use',
  },
  {
    id: 'esri-ocean', title: 'Esri Ocean (bathymetry)', group: 'Ocean and relief', maxzoom: 13,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Esri, GEBCO, NOAA, National Geographic, Garmin, HERE and other contributors',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'esri-relief', title: 'Esri Shaded Relief', group: 'Ocean and relief', maxzoom: 13,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Esri, USGS, NOAA',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'esri-physical', title: 'Esri Physical', group: 'Ocean and relief', maxzoom: 8,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'U.S. National Park Service',
    terms: "Esri's terms of use apply (an ArcGIS account may be needed for commercial use)",
  },
  {
    id: 'gibs-bluemarble', title: 'NASA Blue Marble (relief and bathymetry)', group: 'Daily satellite (NASA)', maxzoom: 8,
    tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'],
    attribution: 'NASA Earth Observatory, via NASA GIBS',
    terms: 'NASA imagery: no copyright, free for any use with credit',
  },
  {
    id: 'gibs-viirs', title: "NASA VIIRS true colour (yesterday)", group: 'Daily satellite (NASA)', maxzoom: 9,
    tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${gibsDay()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
    attribution: 'NASA EOSDIS GIBS, Suomi NPP VIIRS',
    terms: 'NASA imagery: no copyright, free for any use with credit. One image a day at 375 m: fires, smoke, floods, cloud',
  },
  {
    id: 'gibs-modis', title: 'NASA MODIS Terra true colour (yesterday)', group: 'Daily satellite (NASA)', maxzoom: 9,
    tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${gibsDay()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
    attribution: 'NASA EOSDIS GIBS, Terra MODIS',
    terms: 'NASA imagery: no copyright, free for any use with credit. One image a day at 250 m',
  },
  { id: 'custom', title: 'Your own tiles (XYZ URL)', group: 'Your own', terms: 'Any XYZ raster tile service: {z}/{x}/{y} in the URL (as QGIS XYZ Tiles)' },
  { id: 'none', title: 'No basemap', group: 'Offline', terms: 'A plain background' },
];

export interface CustomBasemap {
  url: string;
  attribution: string;
  maxzoom?: number;
}

export const basemapDef = (id: string) => BASEMAPS.find((b) => b.id === id);

/** Source and layer for an online basemap (offline and none are drawn by main.ts). */
export function onlineBasemap(id: string, custom?: CustomBasemap): { source: maplibregl.RasterSourceSpecification; layer: maplibregl.LayerSpecification } | null {
  const d = basemapDef(id);
  let tiles = d?.tiles;
  let attribution = d?.attribution ?? '';
  let maxzoom = d?.maxzoom ?? 19;
  if (id === 'custom') {
    if (!custom?.url) return null;
    tiles = [custom.url];
    attribution = custom.attribution;
    maxzoom = custom.maxzoom ?? 19;
  }
  if (!tiles) return null;
  return {
    source: { type: 'raster', tiles, tileSize: d?.tileSize ?? 256, maxzoom, attribution },
    layer: {
      id: 'basemap:tiles',
      type: 'raster',
      source: 'basemap:tiles',
      paint: d?.dim ? { 'raster-opacity': 0.6, 'raster-saturation': -0.5 } : {},
    } as maplibregl.LayerSpecification,
  };
}

/** Check a user's XYZ URL before using it. */
export function checkTileUrl(url: string): string | null {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return 'The URL must start with https:// (or http://).';
  if (!(u.includes('{z}') && u.includes('{x}') && u.includes('{y}')) && !u.includes('{quadkey}')) return 'The URL needs {z}, {x} and {y} where the tile numbers go.';
  return null;
}
