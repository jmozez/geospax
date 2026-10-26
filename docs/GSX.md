# GSX tools

The GSX tools bring the conservation, biodiversity and environmental analysis into GeoSpaX 3. They are
**twelve default plugins**, one per domain, each with its tools:

| Plugin | Tools |
| --- | --- |
| **Conservation** | overlay, hot spot grid, DBSCAN, local Moran's I, priority sites, representation, species distribution, suitability, protection gap, fragmentation, connectivity, change |
| **Agriculture** | spectral index, suitability, distance decay, slope zones, raster change, change |
| **Biodiversity** | diversity, nearest neighbour, DBSCAN, local Moran's I, hot spot grid, species distribution, priority sites, protection gap |
| **Environment** | slope zones, spectral index, raster change, overlay, elevation profile |
| **Forestry** | spectral index, fragmentation, connectivity, raster change, change, protection gap |
| **Marine** | diversity, nearest neighbour, DBSCAN, species distribution, spectral index, suitability, hot spot grid, priority sites, protection gap |
| **Climate** | spectral index, suitability, distance decay, raster change, change |
| **Disaster** | suitability, slope zones, spectral index, distance decay, priority sites, raster change, change, hot spot grid, local Moran's I |
| **Geoscience** | slope zones, spectral index, suitability, overlay, raster change, change, elevation profile |
| **Hydrology** | spectral index, slope zones, suitability, distance decay, overlay, raster change, change, elevation profile |
| **Land use and land cover** | spectral index, raster change, change, overlay, suitability |
| **Soil** | spectral index, suitability, distance decay, overlay, raster change, change |

They ship with GeoSpaX and are in the **Explorer** under **Plugins** (one per domain), in the **Tools** tab under
*Plugins › <domain>* and in the plugin manager marked *default plugin*. They are not on the Analysis,
Imagery or Modelling tabs, which hold GeoSpaX's own tools. All twelve run the same code, the shared
**GSX library** in `plugins/gsx` (`library: true`: not listed, but recipes, the API and MCP call its
tools as `gsx/<tool>`, so a tool gives the same answer from every domain).

A tool's dialog opens with its inputs already chosen, as in ArcGIS Pro's geoprocessing pane:
- **Layers:** the layer selected in Contents when it fits, unless another layer fits the input better
  by name (a *habitat* layer for "Habitat", a layer with a species column for diversity). Points,
  lines and polygons go only to inputs that take them; a second input (B, protected areas) gets a
  different layer, and the second date of a pair the layer's later version (habitat → habitat_2024).
- **Fields:** a field of the right type from that layer, its name matching the input's
  (`dist_to_road_km` for "Distance field", `species` for "Species"); identifiers such as `site` are
  never taken as values. Optional inputs (a constraint field, a second layer) stay empty unless their
  own name names the field, since a wrong constraint would change the result.
- **Rasters:** a multiband image for "Image", a raster named as a DEM for "Elevation" (never a
  temperature or other surface), the earlier and later of two dated rasters for change, and the
  climate rasters as species-model covariates.
- **Never earlier results**, unless you select one: a tool starts from your data.
When nothing fits, the input stays empty and the tool says what it needs ("Choose a DEM").

The analysis code (`plugins/gsx/src/analysis`, about 5,000 lines of TypeScript on Turf and proj4) is
`@geospax/analysis`, unchanged, so its golden-value tests run as they did (103 of them,
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

The rasters come from the map (Explorer › Online data › Climate gives WorldClim or CHELSA; › Elevation the
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

## From earlier GeoSpaX (phase C)

| Tool | Toolbox | What it gives you |
| --- | --- | --- |
| **Local Moran's I (clusters and outliers, LISA)** | Spatial Statistics › Clusters and outliers | Each feature as a high-high or low-low cluster, a high-low or low-high outlier, or not significant (Anselin 1995), in the conventional red/blue colours; the global Moran's I with its permutation p-value and the Moran scatterplot. Neighbours: touching polygons (queen), k nearest or a distance band, row-standardised; conditional permutations with a seed (same seed, same answer); optional Benjamini–Hochberg false discovery rate |
| **Elevation profile** | Terrain › Profiles | The terrain along each line over a DEM (bilinear samples every half cell), or through points with an elevation field, one profile per group (e.g. transect) and sorted by a field: the chart, length, lowest and highest point, total climb and descent, steepest stretch |
| **Calculate field** | Edit › Fields, attribute table | SQL expressions and geodesic geometry measures ([USER_GUIDE §5a](USER_GUIDE.md#5a-edit-and-query-data)) |

Tool results can now carry charts (`figures` in the plugin answer, drawn as images so a plugin's SVG
cannot run scripts). **Checked** (`tests/legacytools.test.ts`): a two-block pattern is strongly clustered
with high-high and low-low on the right sides and no outliers; a checkerboard with rook neighbours gives
Moran's I = −1 exactly; the global I equals the textbook double sum; a north-facing ramp DEM gives the
profile length (11.1 km for 0.1° of latitude) and climb (1,000 m) it should. On the sample
transects, species richness gives I = 0.82 with 8 neighbours (the earlier guide expects about 0.8).

**Sample data** (Explorer › Sample data) brings back the Papua New Guinea set: the survey transects,
birdwing butterflies and their host vines, forest patches, a habitat grid, streams, WorldClim
temperature and rainfall and tree cover ([samples/png/README.md](../samples/png/README.md)). **1.4.2
`.gspx` and 2.0 `.geolibre.json` projects** open like any file: their embedded layers come onto the map
(styles and layers that only point at outside files are not carried over).

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
npm test            # the analysis tests
npm run build       # src/ → run.mjs
node gen-manifest.mjs   # src/tools.ts → plugin.yaml
```

CI checks that `run.mjs` and `plugin.yaml` match the source.

## Domain kits

Ready-made recipes that chain online data, the tools above, a finished map and a report. They are in
**Analysis › Recipes** (grouped by domain), the **Toolbox** under *Ready-made analyses*, and Lazy mode's
**Find patterns**; each takes a few inputs and runs to the end by itself.

| Kit | Recipe | In → out |
| --- | --- | --- |
| Biodiversity | **Species distribution model (GBIF + WorldClim)** | A species name and an area → occurrences (GBIF, OBIS or iNaturalist), bioclim layers, a model with spatial cross-validation, suitability and range maps |
| Biodiversity | **Survey diversity and clustering** | Point records with a species field → richness, Shannon and Simpson per hexagon, DBSCAN clusters, the Clark–Evans test |
| Climate | **Range shift under future climate (CMIP6)** | The same model on present climate, projected onto a CMIP6 model, SSP and period → present and future suitability, range lost, stable and gained, the net change |
| Conservation | **Protection gaps** | Habitat and protected areas → protected and unprotected hectares, the share protected, a gap map |
| Forestry | **Forest fragmentation and connectivity** | Forest patches → landscape metrics, core areas, patches linked within a dispersal distance |
| Land use and land cover | **Land cover change (two dates)** | Two extents (mangrove, forest, wetland …) → loss, gain, persistence, annual rate |
| Agriculture and environment | **Vegetation change (two rasters)** | Two NDVI rasters → the difference, loss and gain with their areas |
| Disaster and geoscience | **Steep slopes** | An area → Copernicus 30 m DEM, slope zones (default 15° and 30°, landslide screening), relief |
| Soil | **Topsoil properties (SoilGrids)** | An area → pH, organic carbon and clay at a chosen depth |

Every kit is an ordinary recipe (`recipes/kit-*.yaml`): open it in the Automate pane to see each step,
change a default, or save a copy with your own steps. Kits call the tools with the **`tool`** step
([AUTOMATION §2](AUTOMATION.md#2-recipe-format-v1-as-implemented)).

**Checked:** `scripts/test-kits.py` runs all nine against data with known answers
(`scripts/test-kits-data.R`): 25 % protected, 12 patches, net land-cover change of zero, 12 species in
3 clusters, the planted vegetation-loss strip, and a future range that is both lost and gained. Kits
that download data run with the downloads swapped for local test rasters, so their tools, maps and
reports run for real; the downloads need internet and are covered by the `data.fetch` tests.

## Online data from the 2.0 catalogue

earlier GeoSpaX listed these sources; 3.0 fetches them, for the area on the map, with their citations
(Explorer › Online data, and its Check species names; steps in [AUTOMATION.md](AUTOMATION.md)):

| Source | What you get | Licence and credit |
| --- | --- | --- |
| **GEBCO 2026 Grid** | Sea depth and land height in one surface at 15″ (~450 m), drawn with the colours changing at sea level; optionally how each depth was obtained (GEBCO's Type Identifier: multibeam, single beam, satellite gravity, interpolation …) with its share of the area | Public domain; *not for navigation*. GEBCO Compilation Group (2026) GEBCO 2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa. Read from the cloud-optimised copy on Source Cooperative (giswqs/gebco-bathymetry), checked cell for cell |
| **Hansen Global Forest Change v1.13** | Tree canopy cover in 2000 (%), year of forest loss 2001–2025, gain 2000–2012, land/water mask, at 1″ (~30 m), for areas up to 2° a side. Maps draw loss (pink 2001 → purple 2025) over tree cover | CC-BY 4.0; *Source: Hansen/UMD/Google/USGS/NASA*; Hansen et al. 2013, *Science* 342. The authors' caveat goes into the methods: a relative indicator of loss; do not estimate areas from pixel counts |
| **RESOLVE Ecoregions 2017** | The 846 terrestrial ecoregions (updated WWF ecoregions), clipped to the area, with biome, realm, Nature Needs Half category and geodesic area, in RESOLVE's colours | CC-BY 4.0; Dinerstein et al. 2017, *BioScience* 67: 534–545. The 149 MB file is downloaded once into `<state>/catalog/` |
| **WoRMS** | Names checked: AphiaID, status, accepted name, classification, habitat and a verdict per name | WoRMS Editorial Board, World Register of Marine Species, doi:10.14284/170 (citation with the access date in the methods) |

**Not yet:** coral reef extent, mangroves and the SPREP Pacific layers. The SPREP Inform portal refuses
automated requests (a Cloudflare browser challenge), so it needs another route.

## Coming next

- **More kits:** marine (OBIS with ocean covariates), hydrology (watersheds and stream networks with the
  raster tools), ecosystem services.

## Credits

The GSX analysis and its tests: **in4metrix**, MIT. Turf (MIT) and proj4js
(MIT) are bundled into `run.mjs`.
