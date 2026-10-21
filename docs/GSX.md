# GSX tools

The GSX tools bring the conservation, biodiversity and environmental analysis of **GeoSpaX 2.0**
([jm0535/GeoSpaX](https://github.com/jm0535/GeoSpaX)) and **GeoSpaX 1.4.2**
([jm0535/map-kit](https://github.com/jm0535/map-kit)) into GeoSpaX 3, in GeoSpaX 3's design: one
plugin (`plugins/gsx`) whose tools sit in the **Toolbox** with everything else, run from the ribbon,
the command palette and the HTTP API, and put their results on the map with their provenance.
In 2.0 the same code sat behind twelve domain panels; here each tool appears once, and the domains
become ready-made recipes (see [Coming next](#coming-next)).

The analysis code (`plugins/gsx/src/analysis`, about 5,000 lines of TypeScript on Turf and proj4) is
GeoSpaX 2.0's `@geospax/analysis`, unchanged, so its golden-value tests run as they did (103 of them,
in CI). It needs **Node.js 18+** and nothing else; no tool here goes online.

## The tools (phase A)

| Tool | Toolbox group | What it gives you |
| --- | --- | --- |
| **Polygon overlay** | GSX · Landscape | Intersect, erase (difference) or union of two polygon layers |
| **Weighted suitability (WLC)** | GSX · Planning | Weighted linear combination of fields, each rescaled 0–1 (`field:weight`, `:-` when lower is better), with an optional constraint field |
| **Distance-decay suitability** | GSX · Planning | Exponential decay from a distance field: 1 at zero, 0.5 at the half-life |
| **Unprotected priority sites** | GSX · Planning | High-score habitat points outside every protected area |
| **Protection gap** | GSX · Planning | Protected and unprotected habitat in hectares (equal-area by default), as two layers |
| **Minimum-cost representation (SCP)** | GSX · Planning | Cheapest planning units that meet each `field:target`; exact branch-and-bound for ≤ 28 units, greedy above |
| **Weighted hotspot grid** | GSX · Planning | Hexagon or square grid scored from up to three weighted layers (descriptive; for statistical hot spots use *Hot spots*, Getis-Ord Gi*) |
| **Fragmentation and patch metrics** | GSX · Landscape | NP, CA, LPI, TE, ED, MSI, core area and CAI, ENN; core-area polygons |
| **Patch connectivity** | GSX · Landscape | Components of patches linked within a threshold distance; link lines |
| **Two-date change** | GSX · Landscape | Loss, gain, persistence and the annual rate between two extents |
| **DBSCAN clusters** | GSX · Species & patterns | Density clusters of up to 2,000 points; radius automatic or set |
| **Occurrence pattern (Clark–Evans)** | GSX · Species & patterns | Nearest-neighbour ratio R, z-score: clustered, random-like or dispersed |
| **Richness and diversity** | GSX · Species & patterns | Richness, Shannon H′, Simpson, Pielou evenness; optionally per area |

Every tool shows its results in its dialog (a table, plus the method's caveats) and adds its layers to
the map, styled by AutoMap. Areas are in hectares and equal-area (an auto-centred Lambert azimuthal
projection) unless you choose spherical. Each result layer records the tool, its parameters and the
2.0 provenance stamp.

Layers in any format work: the plugin asks for GeoJSON (`geojson: true` in its `plugin.yaml`), so
GeoSpaX hands it each layer the tool uses as GeoJSON, whatever the source (GeoPackage, Shapefile,
FlatGeobuf …).

## From scripts

```bash
curl -X POST localhost:8080/api/plugins/gsx/tools/fragmentation/run \
  -d '{"params": {"patches": "forest.gpkg", "edge_m": 100}}'
```

`scripts/test-gsx.mjs` runs every tool this way. Recipe steps that call plugin tools (so the domain
kits can chain them) come with the domain kits.

## Building the plugin

`plugins/gsx` ships its built file (`run.mjs`) so it runs without a build step. To change it:

```bash
cd plugins/gsx
npm ci
npm test            # the GeoSpaX 2.0 analysis tests
npm run build       # src/ → run.mjs
node gen-manifest.mjs   # src/tools.ts → plugin.yaml
```

CI checks that `run.mjs` and `plugin.yaml` match the source.

## Coming next

- **Rasters, models and data:** spectral indices (NDVI, NDWI, NBR …) with Otsu thresholds, slope
  zones, reclassify and polygonize, raster change, **species distribution models** (BIOCLIM,
  Mahalanobis, presence-background logistic, spatial-block cross-validation), environmental
  covariates (CHELSA, Copernicus DEM), occurrences from GBIF, OBIS, iNaturalist and WoRMS, GEBCO.
- **Domain kits:** conservation, biodiversity, marine, environment, forestry, agriculture, climate,
  disaster, geoscience, hydrology, land use and land cover, soil: each a set of recipes that end in a
  finished map and report, and Lazy-mode tasks.
- **From 1.4.2:** local and global Moran's I, calculate field with expressions, opening 1.4.2 `.gspx`
  and 2.0 projects, the Papua New Guinea sample data, elevation profiles.

## Credits

The GSX analysis and its tests: **J. Moses**, GeoSpaX 1.4.2 and 2.0, MIT. Turf (MIT) and proj4js
(MIT) are bundled into `run.mjs`.
