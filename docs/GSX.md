# GSX tools

The GSX tools bring the conservation, biodiversity and environmental analysis of **GeoSpaX 2.0**
([jm0535/GeoSpaX](https://github.com/jm0535/GeoSpaX)) and **GeoSpaX 1.4.2**
([jm0535/map-kit](https://github.com/jm0535/map-kit)) into GeoSpaX 3, in GeoSpaX 3's design. They are
built-in tools: filed in the **Toolbox** by task (Conservation Planning, Landscape Ecology,
Biodiversity, Spatial Statistics › Point patterns, Analysis › Overlay), on the Analysis and Modelling
ribbon tabs, in the command palette and the HTTP API, with no separate label. Inside, they run as
`plugins/gsx` through the plugin contract, which is why the source lives there.
In 2.0 the same code sat behind twelve domain panels; here each tool appears once, and the domains
become ready-made recipes (see [Coming next](#coming-next)).

The analysis code (`plugins/gsx/src/analysis`, about 5,000 lines of TypeScript on Turf and proj4) is
GeoSpaX 2.0's `@geospax/analysis`, unchanged, so its golden-value tests run as they did (103 of them,
in CI). It needs **Node.js 18+** and nothing else; no tool here goes online.

## The tools (phase A)

| Tool | Toolbox | What it gives you |
| --- | --- | --- |
| **Polygon overlay** | Analysis › Overlay | Intersect, erase (difference) or union of two polygon layers |
| **Weighted suitability (WLC)** | Conservation Planning | Weighted linear combination of fields, each rescaled 0–1 (`field:weight`, `:-` when lower is better), with an optional constraint field |
| **Distance-decay suitability** | Conservation Planning | Exponential decay from a distance field: 1 at zero, 0.5 at the half-life |
| **Unprotected priority sites** | Conservation Planning | High-score habitat points outside every protected area |
| **Protection gap** | Conservation Planning | Protected and unprotected habitat in hectares (equal-area by default), as two layers |
| **Minimum-cost representation (SCP)** | Conservation Planning | Cheapest planning units that meet each `field:target`; exact branch-and-bound for ≤ 28 units, greedy above |
| **Weighted hotspot grid** | Conservation Planning | Hexagon or square grid scored from up to three weighted layers (descriptive; for statistical hot spots use *Hot spots*, Getis-Ord Gi*) |
| **Fragmentation and patch metrics** | Landscape Ecology | NP, CA, LPI, TE, ED, MSI, core area and CAI, ENN; core-area polygons |
| **Patch connectivity** | Landscape Ecology | Components of patches linked within a threshold distance; link lines |
| **Two-date change** | Landscape Ecology | Loss, gain, persistence and the annual rate between two extents |
| **DBSCAN clusters** | Spatial Statistics › Point patterns | Density clusters of up to 2,000 points; radius automatic or set |
| **Occurrence pattern (Clark–Evans)** | Spatial Statistics › Point patterns | Nearest-neighbour ratio R, z-score: clustered, random-like or dispersed |
| **Richness and diversity** | Biodiversity | Richness, Shannon H′, Simpson, Pielou evenness; optionally per area |

Every tool shows its results in its dialog (a table, plus the method's caveats) and adds its layers to
the map, styled by AutoMap. Areas are in hectares and equal-area (an auto-centred Lambert azimuthal
projection) unless you choose spherical. Each result layer records the tool, its parameters and the
2.0 provenance stamp.

Layers in any format work: the plugin asks for GeoJSON (`geojson: true` in its `plugin.yaml`), so
GeoSpaX hands it each layer the tool uses as GeoJSON, whatever the source (GeoPackage, Shapefile,
FlatGeobuf …).

## Rasters and species distribution (phase B)

| Tool | Toolbox | What it gives you |
| --- | --- | --- |
| **Spectral index and extent (Otsu)** | Image Analysis › Spectral indices | NDVI, NDWI, NDBI, NBR or any band pair; an automatic Otsu threshold (or yours); the index raster, the extent as a class raster and its area; the band-assignment caveat on every result |
| **Raster change (two dates)** | Image Analysis › Change detection | After − before, Otsu thresholds for loss and gain, a loss / no change / gain raster and the areas |
| **Slope zones** | Terrain › Slope zones | Horn slope from a DEM and three zones (default breaks 8° and 20°) with their areas; warns when the DEM is too coarse for slope |
| **Species distribution model** | Species Distribution | Occurrences + environmental rasters (all their bands) → suitability (0–1) and the predicted range at the max-TSS threshold. BIOCLIM, Mahalanobis or presence-background logistic; seeded background sample; spatially blocked cross-validation with AUC, max TSS and the Boyce index |

The rasters come from the map (Data › Climate gives WorldClim or CHELSA; Data › Elevation the
Copernicus DEM; Imagery the latest Sentinel-2 bands), and results go back to the map styled for what
they are: suitability on a fixed 0–1 Viridis scale, change on a diverging red–blue scale centred on
zero, classes with their own colours. Several environmental rasters are resampled onto the first
one's grid.

**Cross-validation.** Points are grouped in square lon/lat blocks (automatic size: about a sixth of the
study area; or set it). Blocks that hold presences are dealt to the folds first, so every held-out fold
has presences even when occurrences are clustered; when there are fewer such blocks than folds, the
number of folds drops to match and the result says so. Report the cross-validated scores: training
AUC is optimistic, and suitability from presence-background data is relative, not a probability of
presence.

Checked against synthetic data with known answers (`tests/rastertools.test.ts`): an image whose west
half is vegetated (NDVI extent 50.0 %), a planted loss strip (found cell for cell), a 10° ramp (mean
slope 10° ± 0.2) and a species confined to one climate corner (cross-validated AUC above 0.85 for
Mahalanobis and logistic, above 0.7 for BIOCLIM).

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

- **Data:** WoRMS taxonomy checks, GEBCO bathymetry and the 2.0 catalogue layers (ecoregions,
  forest, marine, SPREP) in Data › Online data.
- **Domain kits:** conservation, biodiversity, marine, environment, forestry, agriculture, climate,
  disaster, geoscience, hydrology, land use and land cover, soil: each a set of recipes that end in a
  finished map and report, and Lazy-mode tasks.
- **From 1.4.2:** local and global Moran's I, calculate field with expressions, opening 1.4.2 `.gspx`
  and 2.0 projects, the Papua New Guinea sample data, elevation profiles.

## Credits

The GSX analysis and its tests: **J. Moses**, GeoSpaX 1.4.2 and 2.0, MIT. Turf (MIT) and proj4js
(MIT) are bundled into `run.mjs`.
