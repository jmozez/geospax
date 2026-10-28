<p align="center"><img src="docs/assets/geospax-logo.png" alt="GeoSpaX logo" width="110" /></p>

<h1 align="center">GeoSpaX</h1>

<p align="center"><b>The open-source GIS where maps make themselves.</b><br>
Desktop, web and phone · one Rust engine · MIT licence</p>

<p align="center">
  <a href="https://github.com/jmozez/geospax/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/jmozez/geospax?label=release"></a>
  <a href="https://github.com/jmozez/geospax/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jmozez/geospax/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue"></a>
</p>

<p align="center"><img src="docs/assets/screenshot-pro.webp" alt="GeoSpaX Pro: every building, road and place of central Lae, Papua New Guinea (Overture Maps), styled by type, with street and place names, over Esri World Imagery" width="900" /></p>

<table><tr>
<td width="50%"><img src="docs/assets/screenshot-lazy.webp" alt="GeoSpaX Lazy mode: layer cards, task bar and the Layer tab" /><br /><b>Lazy mode</b>: layer cards that explain each layer, a task bar, one-click next steps and the layer's story in the Layer tab.</td>
<td width="50%"><img src="docs/assets/screenshot-globe.webp" alt="GeoSpaX starting on the globe over world imagery" /><br /><b>It starts on the globe</b>: a clean slate over world imagery, with the map's basemap, projection and next steps in the Layer tab.</td>
</tr></table>

GeoSpaX is for people who want a finished map without spending hours on it. Drop in data, or plug in a
phone, GPS, drone card, camera or sensor logger, and GeoSpaX styles it, lays out the map, writes the
report and exports PNG, PDF and SVG. When you want control, a full ArcGIS Pro-style workbench is one click
away.

## Features

- **Two modes, one engine.** *Lazy*: layer cards, a task bar and plain-language next steps. *Pro*: an ArcGIS
  Pro-style ribbon, layer tree, attribute table, editing and every pane.
- **A workbench laid out like the work.** The ribbon runs Home, View, Edit, Design, Imagery, Analysis,
  Share; on the left **Project · Explorer · Contents** (files, online data, recipes, R & Python, plugins
  and devices live in the Explorer); on the right **Layer · Tools · Ask** (the selected layer's style,
  labels, fields and source; the Toolbox; the assistant); under the map the attribute table and the runs.
- **Every ribbon tab does real work.** Swipe and Spyglass to compare a layer with the map under it, a time
  slider for any date or year field, a map grid, split, merge, cut and reshape, attribute rules and topology
  checks, zonal statistics with exact cell coverage, network routes and service areas, and a web map in a
  single HTML file. The [user guide](docs/USER_GUIDE.md#the-ribbon-tools-tab-by-tab) goes through them tab
  by tab.
- **Maps that style themselves.** AutoMap picks the field, classes and colours and says why; full
  symbology for points, lines, polygons, labels and rasters when you want your own.
- **Finished maps and reports.** Layout with legend, scale bar, north arrow and inset; Equal Earth for world
  maps; 150–1200 dpi PNG, vector PDF and SVG; map series and multi-panel pages.
- **Analysis.** About 1,130 tools in one Toolbox (vector, raster, terrain, hydrology, imagery, LiDAR),
  hot spots and kriging, and domain plugins for agriculture, biodiversity, climate, conservation,
  forestry, hydrology, marine, soil and more.
- **Data from anywhere.** Files, devices and phones, plus online data cut to your area with citations:
  WorldClim, CHELSA, CMIP6, SoilGrids, GBIF, OBIS, iNaturalist, GADM, Copernicus DEM, GEBCO, Hansen forest
  change, ecoregions.
- **Design and CAD.** Lines, polygons, arcs (3 points), ellipses, roads from a centreline, offsets of lines and shapes (by distance or through a point), a Layer Properties manager (colour, linetype, lineweight, on/off, lock), locked layers, dimensions (linear and angular), leaders, a traverse (COGO)
  with its misclosure; Move, Copy, Rotate, Scale, Mirror, Align, Stretch, Array, Polar array (previewed as you type),
  Union, Subtract, Intersect, Trim, Extend, Fillet, Chamfer, Join, Break, Lengthen, Explode, List and Erase on any feature; Divide and Measure;
  Blocks and Insert; Undo and Redo; hatch patterns (exported to DXF as hatch lines); snap, ortho and polar,
  typed input such as `25<90` and `@10,5`, and DXF to and from AutoCAD.
- **Automation.** Every result is a re-runnable recipe; triggers run them when a device is plugged in, a
  folder changes, a schedule fires or a live sensor crosses a threshold.
- **R, Python and AI.** R and Python as recipe steps with an R console and templates; an assistant (Ollama,
  OpenAI-compatible or Claude) and an MCP server.
- **Private by default.** Everything runs on your computer and works offline.

## Tours

**Compare and play through time.** *Swipe* (View tab) shows the selected layer on one side of a divider and
the map without it on the other; *Time slider* plays a layer through its dates, and tools and exports see
the same features as the map.

<table>
<tr>
<td width="50%"><img src="docs/assets/ribbon-swipe.webp" alt="GeoSpaX Swipe: the reserves layer on the left of the divider only, with the map grid on" /></td>
<td width="50%"><img src="docs/assets/ribbon-time.webp" alt="GeoSpaX time slider playing survey points by year" /></td>
</tr>
</table>

**Design a subdivision.** A 76-lot estate east of Lae, Papua New Guinea, drawn with the Design tab over
Esri World Imagery: two 12 m access roads and a 15 m collector, 20 × 30 m lots, a public reserve, a water
tank and dimensions, all typed into the command line. *Export DXF* hands it to AutoCAD in UTM metres.

<p align="center"><img src="docs/assets/tour-design.png" alt="GeoSpaX Design tab: a 76-lot subdivision plan over Esri World Imagery of Lae" width="900" /></p>

**Rivers and catchments.** The Huon Peninsula coast east of Lae from the Copernicus DEM at 60 m
(1,909 × 1,400 cells, sea masked out): GeoSpaX's `hydro.network` fills depressions, routes flow (D8),
extracts 834 stream links coloured by Strahler order (1 to 5) and outlines the 11 drainage basins that lie
wholly inside the DEM (basins cut by its edge are left out), over Esri World Imagery.

<p align="center"><img src="docs/assets/tour-hydrology.png" alt="GeoSpaX: Strahler-ordered streams and drainage basins of the Markham valley over Esri World Imagery" width="900" /></p>

**Land cover.** ESA WorldCover 10 m (2021) for Lae and the Markham delta, downloaded for the area with
*Explorer › Online data*, drawn in ESA's class colours over Esri World Imagery; the legend gives each class's
share of the area.

<p align="center"><img src="docs/assets/tour-landcover.png" alt="GeoSpaX: ESA WorldCover land cover of Lae over Esri World Imagery" width="900" /></p>

**Supervised classification.** Six land-cover classes from Google DeepMind's AlphaEarth satellite
embeddings (64 values per 10 m pixel), k-nearest neighbours trained on 360 points labelled from
WorldCover; leave-one-out accuracy 81 %.

<p align="center"><img src="docs/assets/tour-classification.png" alt="GeoSpaX: supervised land-cover classification of Lae from satellite embeddings, with training points" width="900" /></p>

**Unsupervised classification.** The same embeddings grouped into eight kinds of landscape by k-means,
with no samples: 3.6 million pixels in under a minute.

<p align="center"><img src="docs/assets/tour-clustering.png" alt="GeoSpaX: k-means landscape groups of Lae from satellite embeddings" width="900" /></p>

**LiDAR in 3D.** 23 million USGS 3DEP points of downtown San Francisco (615 Entwine tiles) gridded in
12 seconds into terrain, surface and canopy models; the 184 buildings found are raised to their measured
roof heights with *Extrude in 3D* over Esri World Imagery.

<p align="center"><img src="docs/assets/tour-lidar.png" alt="GeoSpaX: LiDAR buildings of downtown San Francisco extruded to their roof heights in 3D" width="900" /></p>

**Network analysis.** Road distance from every street in Lae to the nearest of 12 hospitals and clinics,
over 2,646 Overture road segments (service area with the network tools of the Toolbox).

<p align="center"><img src="docs/assets/tour-network.png" alt="GeoSpaX: road distance to the nearest hospital across Lae's street network" width="900" /></p>

**Mount Wilhelm in 30 m.** The Copernicus GLO-30 DEM for the area around Papua New Guinea's highest
peak (839–4,471 m), fetched with *Online data › Elevation* in 4 seconds and tinted green to white, with
its histogram and band statistics.

<p align="center"><img src="docs/assets/tour-dem-wilhelm.webp" alt="GeoSpaX: Copernicus 30 m DEM of Mount Wilhelm, Papua New Guinea, in a hypsometric tint" width="900" /></p>

The same DEM in 3D: *3D view* raises it as terrain over the imagery. For a print-quality 3D relief,
the **3D relief with rayshader** analysis (R) renders it with ray-traced shadows and ambient occlusion.

<p align="center"><img src="docs/assets/tour-dem-3d.webp" alt="GeoSpaX: Mount Wilhelm DEM as 3D terrain over Esri World Imagery" width="900" /></p>

## Plugin showcases

Each domain plugin run in GeoSpaX on open data around Lae and the Huon Gulf, Papua New Guinea, over Esri
World Imagery. The plugins share one tested toolkit (GSX), so a tool behaves the same in every domain.

**Agriculture · weighted suitability.** Where new gardens could go: land cells of about 220 m (0.002°) scored
by gentle slope (weight 3), open grass, shrub and crop land (2) and low ground (1) from the Copernicus 30 m
DEM and ESA WorldCover 2021. Forest is kept out, which leaves 3,187 of 18,546 cells to score.

<p align="center"><img src="docs/assets/plugin-agriculture.png" alt="GeoSpaX Agriculture plugin: cropland suitability around Lae from slope, open land and elevation" width="900" /></p>

**Biodiversity · richness and diversity.** OBIS records of the Huon Gulf, kept to those on the seafloor
(GEBCO depth below 0 m, birds left out: 3,536 of 4,842), summarised per 0.1° cell: 987 taxa in all,
species richness up to 133 in one cell, and Shannon, Simpson and evenness for the 49 cells with records.

<p align="center"><img src="docs/assets/plugin-biodiversity.png" alt="GeoSpaX Biodiversity plugin: species richness of OBIS records per cell in the Huon Gulf" width="900" /></p>

**Climate · coastal flood exposure.** The 462 cells of Lae's low-elevation coastal zone (10 m and
below) scored by low ground (weight 3) and built-up land (2): exposure is highest on the waterfront and port.

<p align="center"><img src="docs/assets/plugin-climate.png" alt="GeoSpaX Climate plugin: coastal flood exposure of Lae's low-lying coast" width="900" /></p>

**Conservation · weighted hotspot grid.** The same marine records counted on 10 km hexagons: 35 of 176
hold records, densest off Lae and along the Huon Peninsula coast.

<p align="center"><img src="docs/assets/plugin-conservation.png" alt="GeoSpaX Conservation plugin: 10 km hexagon hotspot grid of OBIS records" width="900" /></p>

**Disaster · landslide susceptibility.** Slope (weight 4), local relief (2) and little tree cover (1)
combined into a 0–1 score on the same land cells along the Markham valley; built-up and water cells score 0.

<p align="center"><img src="docs/assets/plugin-disaster.png" alt="GeoSpaX Disaster plugin: landslide susceptibility from slope, relief and tree cover" width="900" /></p>

**Environment · elevation profile.** A 38.9 km transect from the Saruwaged foothills to the Huon Gulf on
the Copernicus 30 m DEM (882 samples, about 44 m apart): from 20 m to 1,175 m, with 2,833 m of climb.

<p align="center"><img src="docs/assets/plugin-environment.png" alt="GeoSpaX Environment plugin: elevation profile along a transect to the Huon Gulf" width="900" /></p>

**Forestry · fragmentation and connectivity.** 136 forest patches of 1 ha or more from Hansen tree cover
(2000 canopy ≥ 50 %, 40,783 ha): FRAGSTATS-style metrics, 28,797 ha of core forest more than 100 m from an
edge, and 33 links joining patches within a 500 m dispersal distance (105 connected groups).

<p align="center"><img src="docs/assets/plugin-forestry.png" alt="GeoSpaX Forestry plugin: forest patches, core areas and 1 km connectivity links" width="900" /></p>

**Geoscience · slope zones.** Horn slope from the Copernicus 30 m DEM in three zones (under 8°, 8–20°,
20° and over) across the Markham valley.

<p align="center"><img src="docs/assets/plugin-geoscience.png" alt="GeoSpaX Geoscience plugin: slope zones of the Markham valley" width="900" /></p>

**Hydrology · streams and basins.** Strahler-ordered streams and drainage basins of the Markham valley
(see the Rivers and catchments tour above).

**Land use and land cover · two-date change.** Forest of 2000 against forest left in 2023 (Hansen Global
Forest Change) east of Lae: 3,800 ha lost, 43,831 ha unchanged, no gain (patches of 1 ha or more).

<p align="center"><img src="docs/assets/plugin-lulc.png" alt="GeoSpaX Land use and land cover plugin: forest loss and persistence from 2000 to 2023" width="900" /></p>

**Marine · DBSCAN clusters.** 409 OBIS fish records from the sea grouped into 9 clusters (5 km radius,
9 records of noise) over GEBCO 2026 bathymetry of the Huon Gulf (shown from 0 to 3,000 m deep).

<p align="center"><img src="docs/assets/plugin-marine.png" alt="GeoSpaX Marine plugin: clusters of fish records over GEBCO bathymetry of the Huon Gulf" width="900" /></p>

**Soil · erosion potential.** A RUSLE-style index on the land cells: the slope-steepness factor S
(McCool) times the cover-management factor C from the WorldCover shares (forest 0.003, shrub and grass 0.05,
crop 0.20, bare 0.35). Rainfall and soil erodibility are taken as even over this small area, so the index
ranks cells rather than giving tonnes; built-up and water cells are left out.

<p align="center"><img src="docs/assets/plugin-soil.png" alt="GeoSpaX Soil plugin: erosion risk from slope, exposed land and tree cover" width="900" /></p>

## Industry maps

Twelve finished maps, one per industry kit, made in GeoSpaX (Pro mode, dark theme) on real basemaps and real Papua New Guinea locations. Each has a title, legend, scale bar, north arrow, grid, credits and a CRS note. Illustrative or simulated data is marked on each map.

### Surveying: Plan a lot in minutes, not days.

Bearings and distances from the real OpenStreetMap lot outline in Lae, a Bowditch-adjusted traverse and a PNG94 / UTM 55S grid, ready to print at 1:2,500.

<p align="center"><img src="docs/assets/industry/survey-plan-map-pro-dark.png" alt="GeoSpaX Surveying map: Bearings and distances from the real OpenStreetMap lot outline in Lae, a Bowditch-adjusted traverse and a PNG94 / UTM 55S grid, ready to print at 1:2,500." width="900" /></p>

### Power lines: See every easement at a glance.

The real OpenStreetMap transmission line near Lae on Esri imagery, with 20 m easement, 50 m clearance and 100 m consultation zones. Tower types and span checks are illustrative.

<p align="center"><img src="docs/assets/industry/power-corridor-map-pro-dark.png" alt="GeoSpaX Power lines map: The real OpenStreetMap transmission line near Lae on Esri imagery, with 20 m easement, 50 m clearance and 100 m consultation zones. Tower types and span checks are illustrative." width="900" /></p>

### Petroleum and gas: Spot tenure clashes before they cost you.

Illustrative licence blocks at Hides, Hela Province, over real OpenStreetMap villages, with overlaps flagged and a least-cost pipeline route on the real terrain.

<p align="center"><img src="docs/assets/industry/petroleum-leases-map-pro-dark.png" alt="GeoSpaX Petroleum and gas map: Illustrative licence blocks at Hides, Hela Province, over real OpenStreetMap villages, with overlaps flagged and a least-cost pipeline route on the real terrain." width="900" /></p>

### Mining: Measure cut and fill from free elevation data.

Surface change at Ok Tedi from SRTM (2000) to the Copernicus DEM, in metres, with an illustrative lease outline.

<p align="center"><img src="docs/assets/industry/mine-volumes-map-pro-dark.png" alt="GeoSpaX Mining map: Surface change at Ok Tedi from SRTM (2000) to the Copernicus DEM, in metres, with an illustrative lease outline." width="900" /></p>

### Logging: Know your net harvest area before the first tree falls.

Illustrative coupes at Bulolo, Morobe Province, net of slopes over 30° and real OpenStreetMap stream buffers, with a least-cost haul road.

<p align="center"><img src="docs/assets/industry/harvest-planning-map-pro-dark.png" alt="GeoSpaX Logging map: Illustrative coupes at Bulolo, Morobe Province, net of slopes over 30° and real OpenStreetMap stream buffers, with a least-cost haul road." width="900" /></p>

### Maritime: Turn AIS reports into patrol targets.

AIS density, vessel tracks and loitering events in the Huon Gulf off the Port of Lae. The AIS tracks are simulated.

<p align="center"><img src="docs/assets/industry/maritime-watch-map-pro-dark.png" alt="GeoSpaX Maritime map: AIS density, vessel tracks and loitering events in the Huon Gulf off the Port of Lae. The AIS tracks are simulated." width="900" /></p>

### Aerodromes: Protect your airspace, obstacle by obstacle.

ICAO Annex 14 obstacle limitation surfaces for the real Nadzab (AYNZ) runway, with OpenStreetMap buildings checked against them. Obstacle heights are assumed.

<p align="center"><img src="docs/assets/industry/aerodrome-safeguarding-map-pro-dark.png" alt="GeoSpaX Aerodromes map: ICAO Annex 14 obstacle limitation surfaces for the real Nadzab (AYNZ) runway, with OpenStreetMap buildings checked against them. Obstacle heights are assumed." width="900" /></p>

### Logistics: Cut kilometres off every delivery run.

Drive-time bands from the Lae port depot on real OpenStreetMap roads, and the optimised order to visit each stop.

<p align="center"><img src="docs/assets/industry/delivery-routes-map-pro-dark.png" alt="GeoSpaX Logistics map: Drive-time bands from the Lae port depot on real OpenStreetMap roads, and the optimised order to visit each stop." width="900" /></p>

### Urban planning: Show who is within walking distance of a park.

Real OpenStreetMap land use and buildings in Lae, with every home checked against a 400 m walk to green space.

<p align="center"><img src="docs/assets/industry/urban-planning-map-pro-dark.png" alt="GeoSpaX Urban planning map: Real OpenStreetMap land use and buildings in Lae, with every home checked against a 400 m walk to green space." width="900" /></p>

### Rural development: Find the villages furthest from clinics and schools.

Real OpenStreetMap villages, clinics and schools in the Morobe highlands, graded by straight-line distance in km.

<p align="center"><img src="docs/assets/industry/rural-access-map-pro-dark.png" alt="GeoSpaX Rural development map: Real OpenStreetMap villages, clinics and schools in the Morobe highlands, graded by straight-line distance in km." width="900" /></p>

### Asset management: Put your highest-risk assets on the map first.

Real OpenStreetMap asset locations in Lae, ranked by condition and criticality, with changes since 2025. Register attributes are illustrative.

<p align="center"><img src="docs/assets/industry/asset-register-map-pro-dark.png" alt="GeoSpaX Asset management map: Real OpenStreetMap asset locations in Lae, ranked by condition and criticality, with changes since 2025. Register attributes are illustrative." width="900" /></p>

### Climate and El Niño: See drought coming, province by province.

CHIRPS v3 rainfall for October to December 2015 as a percentage of the 1991 to 2020 normal across Papua New Guinea, with the NOAA Oceanic Niño Index.

<p align="center"><img src="docs/assets/industry/el-nino-drought-map-pro-dark.png" alt="GeoSpaX Climate and El Niño map: CHIRPS v3 rainfall for October to December 2015 as a percentage of the 1991 to 2020 normal across Papua New Guinea, with the NOAA Oceanic Niño Index." width="900" /></p>


## Download

| System | Installer |
|---|---|
| Windows 10 / 11 | [`GeoSpaX_<version>_x64-setup.exe`](https://github.com/jmozez/geospax/releases/latest) (no administrator rights needed) or the portable ZIP |
| Any Linux | [`GeoSpaX-<version>-x86_64.AppImage`](https://github.com/jmozez/geospax/releases/latest): one file, no installing; `chmod +x GeoSpaX-*.AppImage`, then run it. Needs a 2024-or-newer distribution (glibc 2.39). |
| Any system (web edition) | `docker compose up -d`, then open the link printed by `docker compose logs geospax` |

macOS is not packaged yet; use the web edition or [build from source](docs/DEVELOPMENT.md).

## Quick start

1. Start **GeoSpaX**. It opens on a clean map with the globe.
2. Drop a file on the window (GeoJSON, GeoPackage, Shapefile, KML, GPX, CSV, GeoTIFF, LAS/LAZ), or choose
   **Explorer › Sample data**.
3. Press **Finish my map**: a laid-out map and a one-page report, ready to print or share.

The web edition (`geospax-server`) answers at <http://localhost:8080> on this computer only; see
[Security](SECURITY.md) to open it to other devices.

## Documentation

| Guide | |
|---|---|
| [User guide](docs/USER_GUIDE.md) | Install, your first map, the workbench, recipes, troubleshooting |
| [FAQ](docs/FAQ.md) | Answers to the common questions |
| [Automation](docs/AUTOMATION.md) | Recipes, triggers, autopilot, R and Python steps |
| [Plugins](docs/PLUGINS.md) · [GSX tools](docs/GSX.md) · [R](docs/R.md) · [AI](docs/AI.md) · [Devices](docs/DEVICES.md) | The rest of the program in depth |
| [What's new](CHANGELOG.md) | Every release |
| [Development](docs/DEVELOPMENT.md) | Build from source, tests, benchmarks, the engine API |

In the app, **Help** opens the same guides as a searchable web page.

## Build from source

```bash
scripts/setup-linux.sh            # GDAL, Rust, Node.js (Debian/Ubuntu)
. /opt/rust-env.sh
(cd web && npm ci && npx vite build)
cargo build --release -p geospax-server
./target/release/geospax-server --data ~/GeoSpaX/Data --web web/dist   # http://localhost:8080
```

Packaging, the test suite and benchmarks are described in [Development](docs/DEVELOPMENT.md).

## Contributing

Bug reports and ideas are welcome in [issues](https://github.com/jmozez/geospax/issues). Please include what
you did, what you expected and what happened; **Help › Engine diagnostics** shows details worth adding.
Security problems: see [SECURITY.md](SECURITY.md).

## Licence and credits

GeoSpaX is released under the [MIT licence](LICENSE). It
learns from ArcGIS Pro, QGIS, [GeoLibre](https://github.com/opengeos/geolibre) and
[RustGIS](https://github.com/opengeos/RustGIS). Third-party components and data are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
