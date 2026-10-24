<p align="center"><img src="docs/assets/geospax-logo.png" alt="GeoSpaX logo" width="110" /></p>

<h1 align="center">GeoSpaX</h1>

<p align="center"><b>The open-source GIS where maps make themselves.</b><br>
Desktop, web and phone · one Rust engine · MIT licence</p>

<p align="center">
  <a href="https://github.com/jmozez/geospax/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/jmozez/geospax?label=release"></a>
  <a href="https://github.com/jmozez/geospax/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jmozez/geospax/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue"></a>
</p>

<p align="center"><img src="docs/assets/screenshot-pro.png" alt="GeoSpaX Pro (dark): Overture roads and buildings of Lae, Papua New Guinea, over a Sentinel-2 10 m scene" width="900" /></p>

GeoSpaX is for people who want a finished map without spending hours on it. Drop in data, or plug in a
phone, GPS, drone card, camera or sensor logger, and GeoSpaX styles it, lays out the map, writes the
report and exports PNG, PDF and SVG. When you want control, a full ArcGIS Pro-style workbench is one click
away.

## Features

- **Two modes, one engine.** *Lazy*: layer cards, a task bar and plain-language next steps. *Pro*: an ArcGIS
  Pro-style ribbon, layer tree, attribute table, editing and every pane.
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
- **Design and CAD.** Lines, polygons, arcs (3 points), ellipses, roads from a centreline, offsets of lines and shapes (by distance or through a point), locked layers, dimensions, a traverse (COGO)
  with its misclosure; Move, Copy, Rotate, Scale, Mirror, Align, Stretch, Array, Polar array (previewed as you type),
  Trim, Extend, Fillet, Chamfer, Join, Break, Lengthen, Explode, List and Erase on any feature; Divide and Measure;
  Blocks and Insert; Undo and Redo; hatch patterns (exported to DXF as hatch lines); snap, ortho and polar,
  typed input such as `25<90` and `@10,5`, and DXF to and from AutoCAD.
- **Automation.** Every result is a re-runnable recipe; triggers run them when a device is plugged in, a
  folder changes, a schedule fires or a live sensor crosses a threshold.
- **R, Python and AI.** R and Python as recipe steps with an R console and templates; an assistant (Ollama,
  OpenAI-compatible or Claude) and an MCP server.
- **Private by default.** Everything runs on your computer and works offline.

## Tours

**Design a subdivision.** A 76-lot estate east of Lae, Papua New Guinea, drawn with the Design tab over
Esri World Imagery: two 12 m access roads and a 15 m collector, 20 × 30 m lots, a public reserve, a water
tank and dimensions, all typed into the command line. *Export DXF* hands it to AutoCAD in UTM metres.

<p align="center"><img src="docs/assets/tour-design.png" alt="GeoSpaX Design tab: a 76-lot subdivision plan over Esri World Imagery of Lae" width="900" /></p>

**Rivers and catchments.** The Markham valley above Lae from the Copernicus 30 m DEM (1,547 × 1,253
cells): GeoSpaX's `hydro.network` fills depressions, routes flow (D8), extracts 879 stream links coloured
by Strahler order and outlines 13 drainage basins, in 1.5 seconds, over Esri World Imagery.

<p align="center"><img src="docs/assets/tour-hydrology.png" alt="GeoSpaX: Strahler-ordered streams and drainage basins of the Markham valley over Esri World Imagery" width="900" /></p>

**Land cover.** ESA WorldCover 10 m (2021) for Lae and the Markham delta, downloaded for the area with
*Data › Online data*, drawn in ESA's class colours over Esri World Imagery; the legend gives each class's
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

## Download

| System | Installer |
|---|---|
| Windows 10 / 11 | [`GeoSpaX_<version>_x64-setup.exe`](https://github.com/jmozez/geospax/releases/latest) (no administrator rights needed) or the portable ZIP |
| Debian 13 / Ubuntu | [`geospax_<version>_amd64.deb`](https://github.com/jmozez/geospax/releases/latest), then `sudo apt install ./geospax_<version>_amd64.deb` |
| Any system (web edition) | `docker compose up -d`, then open the link printed by `docker compose logs geospax` |

macOS is not packaged yet; use the web edition or [build from source](docs/DEVELOPMENT.md).

## Quick start

1. Start **GeoSpaX**. It opens on a clean map with the globe.
2. Drop a file on the window (GeoJSON, GeoPackage, Shapefile, KML, GPX, CSV, GeoTIFF, LAS/LAZ), or choose
   **Data › Sample data**.
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

GeoSpaX is released under the [MIT licence](LICENSE). It brings together GeoSpaX 1.4.2
([map-kit](https://github.com/jm0535/map-kit)) and 2.0 ([GeoSpaX](https://github.com/jm0535/GeoSpaX)), and
learns from ArcGIS Pro, QGIS, [GeoLibre](https://github.com/opengeos/geolibre) and
[RustGIS](https://github.com/opengeos/RustGIS). Third-party components and data are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
