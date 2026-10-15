# What GeoSpaX borrows, and how it makes each feature lazy

GeoSpaX borrows proven features from commercial and open-source GIS, remote-sensing and data-science tools. It then
**automates** them: smart defaults, auto-chosen methods, recipes and triggers ([VISION.md](VISION.md), [AUTOMATION.md](AUTOMATION.md)).

**Rules for borrowing**
- From **commercial products** we borrow *ideas and workflows* only, through clean-room specs written from public docs. No decompiled code, copied UI assets or doc text ([TECH_STACK §1](../../gis-platform-research/TECH_STACK.md#1-ground-rules-clean-room-not-decompilation)).
- From **open-source tools** we reuse code where the license allows. GPL/AGPL engines (GRASS, SAGA, SNAP, R, OpenDroneMap) run as **separate processes** ("providers"), so the GeoSpaX core stays Apache-2.0 OR MIT.

**How each feature is built:** `N` native Rust engine · `G` GDAL/PDAL/PROJ in-process · `P` provider process · `R` R step · `Py` Python step · `W` WASM in the web edition · `AI` optional LLM.
**Phase** (see [TECH_STACK §8](../../gis-platform-research/TECH_STACK.md#8-phased-roadmap)): P1 Viewer · P2 Autopilot · P3 Field & sensors · P4 Remote-sensing & geostats autopilot · P5 Cartographer & publisher · P6 Platform. ✅ built · 🚧 started.

**Built so far (automation engine v0 + Phase 2 slice 2 + sensor hub v1, October 2026):**
- AutoMap rules that explain themselves, automatic page layouts with collision-free point labels, finished PNG/SVG/**PDF** maps and an HTML report;
- **raster maps** with relief shading, ramp and class legends;
- recipes with device / folder / schedule / after / **stac / webhook / sensor** triggers (threshold, geofence);
- SQL, buffer, hexbin and cross-validated IDW;
- **spatial statistics (1.6)**: Gi* hot spots with automatic scale and FDR, global Moran's I, automatic kriging with standard-error maps, native and checked against R spdep/gstat;
- **terrain** (Copernicus DEM for any area, hillshade, slope, aspect, TRI/TPI, contours);
- **remote sensing** (STAC search, NDVI and other indices from the newest pass that is clear over the area, true colour);
- raster classification with areas, raster values at points;
- **GRASS and SAGA providers**;
- R steps (gstat kriging) and Python steps (point-pattern statistics);
- the device and **sensor** hub: sensor-logger CSV/JSON and FIT readings, live sensors over HTTP and MQTT (OwnTracks phones too), WHO air-quality guideline checks and classes;
- **LiDAR** (1.4: LAS/LAZ → DTM, DSM, canopy, buildings, tree tops) and **3D scenes** (1.5: terrain block diagrams, extruded buildings, trees and point clouds → glTF, an offline viewer and a rendered picture, made by the recipes themselves).

These are marked ✅ / 🚧 in the tables below; details are in [AUTOMATION.md](AUTOMATION.md), [DEVICES.md](DEVICES.md), [RESULTS §11](../bench/RESULTS.md#11-automation-engine-v0), [§12](../bench/RESULTS.md#12-rasters-terrain-remote-sensing-and-providers) and [§13](../bench/RESULTS.md#13-sensors-loggers-watches-live-feeds-and-sensor-triggers).

---

## Desktop GIS

### ArcGIS Pro (Esri, commercial)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| Smart mapping style suggestions | **AutoMap**: profiles every layer and picks symbology, classification, ramp and labels, with a *why* line and 3 alternatives | N | P2 (✅ v0: field choice, method from skewness, ramp by meaning, labels, map-level rules, *why* lines; 3 alternatives next) |
| ModelBuilder, iterators, Tasks | Recipe graph view; `for_each` over files, features, dates or devices; guided recipes for first-timers | N | P2 (🚧 recipes + runner + 13 gallery recipes ✅; graph view, `for_each` next) |
| Geoprocessing history | Every action is logged as a command; **"Save as recipe"** turns the session into a workflow | N | P2 (🚧 "Save this map as a recipe" ✅; session log next) |
| Geostatistical Analyst (kriging wizard, EBK, cross-validation) | **Auto-kriging**: three variogram models fitted, ordinary kriging cross-validated against IDW (lower error wins), prediction + standard-error maps, variogram chart, plain-language report | N (`interpolate.auto`); R (gstat, automap) / Py (PyKrige, GSTools) for more | P4 (✅ v1.6 native `interpolate.auto`, equal to gstat `krige`/`krige.cv`; `r-kriging` recipe ✅; EBK, anisotropy, trends next) |
| Image Analyst, deep-learning classify pixels/objects | Pretrained land-cover and object models run as recipe steps; training samples suggested | Py (TorchGeo, SAM) / N (ONNX) | P4 |
| Layouts, map series, dynamic text | Auto layout (title, legend, scale bar, north arrow, credits) and auto atlas per feature or region | N (Typst/SVG) | P5 (🚧 auto layout → PNG/SVG/PDF ✅ in `export.map`, rasters with relief shading ✅; atlas next) |
| Local scenes: elevation surfaces, vertical exaggeration, extrusion, LAS dataset layers, Export to glTF / 3D Object | **3D scene in every LiDAR and terrain recipe**: block diagram draped with map colours, relief shading, imagery or contours; buildings extruded to their heights, trees, point cloud; exaggeration chosen from the relief; glTF + offline viewer + picture in the report ([AUTOMATION §6d](AUTOMATION.md#6d-3d-scenes-built)) | N (own mesher, glTF writer, CPU renderer, WebGL viewer) | ✅ v1.5; LOD2 roofs, I3S/3D Tiles next |
| Network Analyst (routes, service areas) | "What can I reach in 15 min?" as one step (isochrones, OD matrices) | P (Valhalla/OSRM) / Py (osmnx) | P4 |
| Pro assistant (help, SQL, ArcPy code) [1] | Natural language → **recipe** (previewed, never auto-run if it writes, deletes or uses the network) | AI | P2 |

### QGIS 4 (GPL)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| Processing toolbox with GDAL/GRASS/SAGA providers | **Provider federation**: one step vocabulary, and the best installed engine is picked automatically (and recorded) | N + P | P2 (🚧 GDAL in-process ✅, `grass` and `saga` steps ✅; automatic engine choice next) |
| Graphical modeler, batch processing | Recipes, batch over folders and devices, triggers | N | P2 (🚧 recipes + device/folder/schedule/after/stac/webhook/sensor triggers ✅) |
| Expressions, data-defined overrides | DuckDB/SQL expressions in recipes and styles | N | P2 |
| Print layouts, atlas, layout charts and legend sync modes (new in 4.0) [2] | Auto layouts with charts; legend synced to visible layers by default | N | P5 (🚧 legend from styles with class counts ✅; charts next) |
| Labeling engine (collision, priorities) | Auto-labels: label field guessed (name/title/label), collision-free, priority by size or rank | N | P5 (🚧 points ✅: field guessed, 4-position collision avoidance; lines/polygons next) |
| GPS panel, QField companion | **Device hub**: live GNSS, phone streaming, OwnTracks over MQTT, auto-import, geofence triggers ([DEVICES.md](DEVICES.md)) | N | ✅ v1 (Linux mounts, NMEA, gpsd, phone page, MQTT); Windows/macOS MTP, BLE in P3 |
| Point-cloud algorithms (Height Above Ground, SMRF ground, virtual point clouds; new in 4.0) [2] | LiDAR autopilot: ground → DTM/DSM/CHM → building/tree extraction, started by dropping the files ([AUTOMATION §6c](AUTOMATION.md#6c-lidar-point-clouds-built)) | N (`las`/`laz-rs`, own SMRF) | ✅ v1.4 (LAS/LAZ, vendor classes or SMRF, buildings, tree tops); colourised point cloud in 3D ✅ v1.5; E57/PLY next |
| 3D map view, Qgis2threejs export | The 3D scene opens from the run card (🧊 3D) and travels as one `scene.html` that works offline in any browser; `scene.glb` for other 3D tools | N | ✅ v1.5; 3D inside the main map next |
| Geometry checker, fix geometries | Auto-clean on import (validity, duplicates, encoding, empty geometries), with a report | G/N | P2 |
| Georeferencer | Assisted georeferencing (control points suggested from a reference layer) | N | P5 |

### MapInfo Pro (Precisely, commercial)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| Thematic map wizards, heat maps, temporal mapping [3] | Covered by AutoMap; time fields detected, so an animation is offered automatically | N | P2 |
| Spatial services: Search Nearby, Overlap, Summarize (v23.2) [3] | One-click "what's near / what overlaps / summarize by area" steps | N | P2 (🚧 buffer + hexbin summarise ✅) |
| SQL Select, saved queries, MapBasic | Plain-language filter → SQL; recipes + R/Python instead of a proprietary language | N / AI | P2 (🚧 `vector.sql` ✅, R/Python steps ✅) |
| Redistricting / territory balancing | "Balance territories by X" recipe (regionalization with constraints) | Py (PySAL max-p) | P4 |
| Drone data add-in [3] | Drone autopilot (device hub + OpenDroneMap) | P | P3 |
| 3DMap window (Vertical Mapper surfaces in 3D) | Any elevation raster → `scene.3d` (one step after `dem.fetch`, `interpolate.idw`, a GRASS/SAGA surface) | N | ✅ v1.5 |

### GeoLibre (MIT) and RustGIS (Apache-2.0)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| DuckDB Spatial SQL workspace (GeoLibre) | SQL steps inside recipes, in the native engine (larger-than-memory) | N | P2 (🚧 SQLite/SpatiaLite ✅; DuckDB next) |
| Batch runner, model/pipeline chaining (GeoLibre) [4] | Recipes with triggers, caching and provenance | N | P2 (🚧 triggers, `after` chains, provenance ✅; cache next) |
| Auditable, undoable assistant operations (GeoLibre) [4] | The AI only emits recipe steps, so everything stays auditable, undoable and re-runnable | AI | P2 |
| SamGeo / SAM segmentation (GeoLibre) [4] | Segment-anything step in the RS autopilot | Py | P4 |
| Story maps, offline region download, Android (GeoLibre) [4] | Story generated from a recipe run (one step per slide); offline packs built automatically before field trips | N | P3/P5 |
| Command registry, undo, transaction log, CLI, sandboxed WASM plugins (RustGIS) [5] | Command log → recipes; `geospax run` CLI; WASM recipe steps and plugins | N / W | P2/P6 (🚧 `geospax run/check/watch` ✅) |

### Global Mapper (Blue Marble, commercial; known for ease of use)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| "Open anything" format breadth, instant display | GDAL/PDAL breadth with auto-open, auto-CRS, auto-overviews | G | P1 ✅ / P2 |
| Terrain tools: volumes, contours, profiles | "Terrain report" recipe from any DEM | N / P | P4 (✅ `terrain-report`: Copernicus DEM, relief, slope classes with ha, contours, PDF; volumes and profiles next) |

## Open-source analysis engines (called as providers)

### GRASS 8.5 (GPL)
New in 8.5: a `grass.tools` Python API that calls tools as functions with NumPy I/O, wider parallelization, and JSON outputs [6]. We use it as a provider.

| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| `r.watershed`, `r.stream.*`, `r.fill.dir` | "Watersheds & streams" from a DEM (fetched automatically for the area if missing) | P | P4 |
| `r.sun`, `r.viewshed`, `r.cost`, `r.walk` | Solar potential, visibility and cost-distance as one-click recipes | P | P4 |
| `i.segment`, `i.maxlik`, `i.cluster` | Segmentation and classification steps in the RS autopilot | P | P4 |
| Temporal framework (`t.*`) | Time-series recipes (monthly NDVI trends, anomalies) | P | P4 |
| `r.geomorphon` and any other module | Landforms in plain words (flat, peak, ridge, …) with GRASS's colours; any GRASS script as a recipe step | P (`grass --tmp-project --exec`) | P2 (✅ `grass` step, `landforms-grass`) |
| NVIZ / `m.nviz.image` (3D surfaces with draped rasters and vectors) | `scene.3d` drapes any raster (`drape:`) and paints vector layers on (`overlay:`), with no camera to set: the view and exaggeration are chosen and explained | N | ✅ v1.5 |

### SAGA (GPL) · Whitebox (MIT open core) · Orfeo ToolBox (Apache-2.0)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| SAGA terrain analysis (TWI, LS-factor, channel network, TPI, landforms), kriging | Part of the terrain report; landform classes labelled in plain words | P (`saga_cmd`) | P4 (✅ `saga` step, `wetness-saga`) |
| GDAL DEM tools (hillshade, slope, aspect, TRI, TPI, roughness, contours) | Built-in terrain steps with automatic z-factor, contour interval and smoothing | N (GDAL in-process) | P2 (✅ `terrain.derive`, `terrain.contours`) |
| Whitebox hydrology, LiDAR and terrain tools (500+) | Default native provider for terrain/hydrology steps | N/P | P2 |
| OTB streaming apps (pan-sharpening, LSMS segmentation, SVM/RF classification, SAR) | Large-image steps with automatic tiling and streaming | P (`otbcli`) | P4 |

## Remote sensing and photogrammetry

### ERDAS IMAGINE / Octave Imagine (Hexagon, commercial)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| Spatial Modeler, "no-code workflows with AI and automation" [7] | Recipes (graph view + YAML) | N | P2 (🚧 YAML ✅; graph view next) |
| Indices, band math, Recode, Subset | `rs.index` (NDVI, NDWI, NBR, NDMI, SAVI, EVI, cloud-masked), `raster.classify` with areas, `rs.fetch` for the area only | N | P2 (✅) |
| Supervised/unsupervised classification (ISODATA, max likelihood), accuracy assessment | Auto-classification: training samples suggested, accuracy report written automatically | P (OTB/GRASS) / Py | P4 |
| Orthorectification, mosaicking, pan-sharpening, ATCOR atmospheric correction [7] | Auto-ortho, mosaic, pan-sharpen; surface reflectance via open processors (Sen2Cor/6S-style) | P | P4 |
| Change detection (DeltaCue, zonal change) | **"What changed?"**: two dates → change map + area table + report | N / P | P4 |
| Photogrammetry (semi-global matching dense clouds) [7] | Drone autopilot via OpenDroneMap (AGPL, separate process) | P | P3/P4 |
| VirtualGIS / 3D viewing of imagery on terrain | Imagery fetched in the run (`rs.fetch`) is draped on the terrain automatically | N | ✅ v1.5 |

### ENVI (NV5 Geospatial) · eCognition (Trimble) · TerrSet (Clark Labs), all commercial
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| ENVI spectral tools: SAM, MNF, PPI, spectral libraries, band math | Index library picked automatically from sensor metadata (NDVI, NDWI, NBR, …); SAM against open spectral libraries | N / Py | P4 |
| ENVI Modeler | Recipes | N | P2 |
| eCognition object-based image analysis (multiresolution segmentation + rule sets) | OBIA recipes (segmentation → features → classifier), with rules suggested from samples | P / Py | P4 |
| TerrSet Land Change Modeler, Earth Trends Modeler | Land-change projection and trend/seasonality recipes | Py / R | P4 |

### ESA SNAP (GPL) · Google Earth Engine (cloud, proprietary)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| SNAP Sentinel-1/2/3 toolboxes, Graph Builder, `gpt` batch | SAR autopilot: orbit → calibration → speckle → terrain correction → **flood map** | P (`gpt`) | P4 |
| Earth Engine catalog, reducers, cloud-free composites, time series | STAC-based "virtual catalog": search, cloud mask, median composite and zonal stats for your area, locally or through openEO backends | N / Py | P4 (🚧 STAC search, per-area cloud check, masked indices ✅ (`rs.*`, `latest-ndvi`, `stac` trigger); composites, zonal stats next) |
| Copernicus DEM / SRTM access | The DEM for any area, fetched as COG windows and reprojected to UTM | N | P2 (✅ `dem.fetch`) |
| Earth Engine code editor | Recipes + notebooks; an optional connector uses your own Earth Engine/openEO credentials | Py | P4 |

### LiDAR and drones (PDAL, LAStools, OpenDroneMap, Pix4D/Metashape)
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| PDAL pipelines, LAStools-style ground/height/classify (`lasground`, `lasheight`, `las2dem`), lidR `rasterize_terrain`/`locate_trees`, ArcGIS LAS Dataset to Raster + Classify LAS Ground + Extract Buildings | `lidar-to-terrain`: one drop → DTM (vendor classes or SMRF), DSM, canopy height, building outlines with roof heights, tree tops with heights, maps + report; 2 cm terrain error and 40/40 trees on the test scene | N | ✅ v1.4 |
| Pix4D / Metashape / ODM processing | Plug in the SD card: orthomosaic, DSM, and NDVI if multispectral, then map + report | P (ODM) | P3/P4 |
| CloudCompare / Potree point-cloud viewing | The run's point cloud in the 3D scene (about 250,000 points in the file's own colours, else by class or elevation), next to the modelled terrain, buildings and trees | N | ✅ v1.5; full-density streaming (COPC/Potree-style) next |

## Spatial statistics, geostatistics, data science

### GeoDa / PySAL · R · Python
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| GeoDa ESDA: Moran's I, LISA clusters, spatial regression, regionalization (SKATER, max-p) | **"Find hotspots / clusters"**: weights chosen automatically, significance explained, map + table | N (`stats.hotspots`); Py (PySAL esda/spreg) / R (spdep) for more | P4 (✅ v1.6 global Moran's I + Gi* hot spots, equal to spdep; LISA clusters, regression, regionalization next) |
| ArcGIS Optimized Hot Spot Analysis + Incremental Spatial Autocorrelation | **`points-to-hotspots` recipe**: incidents counted in auto-sized hexagons, distance band from the first clustering peak, Gi* with FDR, hot/cold map at 90/95/99 % and the reasons in the report | N | P4 (✅ v1.6: 1,120 incidents in 0.04 s, 1 M points in 2.2 s) |
| ArcGIS Spatial Statistics: Mean Center, Standard Distance, Directional Distribution, Average Nearest Neighbor | **`python-spatial-stats` recipe**: centre, spread, deviational ellipse and the Clark–Evans index (clustered / random / dispersed) in plain words, on the map | Py | P2 (✅ gallery recipe, plain Python) |
| ArcGIS Generate Tessellation + Summarize Within; QGIS Count points in polygon | **`points-to-hexbins` recipe**: auto-sized hexagons with counts (or sum/mean), classes chosen from the distribution | N | P2 (✅ `aggregate.hexbin`, 1M points in 0.5 s) |
| R `sf`, `terra`, `stars` | R steps receive layers as `sf`/`terra` objects (GeoParquet/COG exchange) | R | P2 (✅ v1: `sf` in/out via GeoJSON/GPKG; GeoParquet/COG next) |
| R `gstat` + `automap::autoKrige` | The auto-kriging engine, fittingly an "automap" for lazy users | R | P4 |
| R `spatstat`, `mgcv`, `INLA` | Point-pattern analysis and spatial models as advanced recipe steps | R | P4 |
| R `tmap`, `mapsf`, `ggplot2` | "Show me the R code" for any AutoMap; publication maps | R | P2/P5 |
| Python `geopandas`, `shapely`, `rasterio`, `xarray`, `dask` | Python steps with Arrow/GeoParquet exchange; notebooks beside the map | Py | P2 (✅ v1: GeoDataFrame or GeoJSON in, layers + numbers out) |
| Python `scikit-learn`, `PyKrige`, `GSTools`, `mgwr` | ML regression/classification, kriging, geographically weighted regression | Py | P4 |
| Python `pystac-client`, `stackstac`/`odc-stac`, `TorchGeo`, `segment-geospatial` | RS autopilot building blocks | Py | P4 |
| webR, Pyodide | Light R/Python steps in the browser edition, with no server-side install | W | P4 |

## Automation and lazy web mapping

### FME (Safe Software) · CARTO Workflows · Felt / kepler.gl / Datawrapper
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| FME transformers, automations (triggers, schedules, webhooks), validation | Recipe triggers, connectors, data-quality checks | N | P2 (✅ device / folder / schedule / after / stac / webhook / sensor triggers) |
| CARTO no-code workflows in data warehouses | Recipe steps against DuckDB, PostGIS and cloud warehouses | N | P6 |
| Felt: instant good-looking defaults, share links, natural language → map + style [8] | AutoMap + one-click publish to a static web map (PMTiles + MapLibre, no server needed) | N | P2/P5 (🚧 AutoMap + finished PNG/SVG map + report ✅; web-map publish next) |
| kepler.gl / Datawrapper: beautiful defaults with no setup | Colour-blind-safe palettes and typographic defaults out of the box | N | P2 |

## Field data capture

### Esri Field Maps / Survey123 · QField / Mergin Maps · ODK / KoboToolbox
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| Form-based capture (XLSForm) | Import XLSForm/ODK/Kobo submissions; a recipe builds the map + summary | N | P3 |
| Offline field maps, sync | Offline packs made automatically; device-hub sync when the phone is plugged in or on Wi-Fi | N | P3 |
| Live location sharing | Phone browser streaming, OwnTracks over MQTT and GNSS feeds into the live layer; a phone entering an area starts a recipe | N | ✅ (phone page, NMEA, gpsd, MQTT; geofence trigger) |

## Real-time feeds and sensors

### ArcGIS Velocity / GeoEvent Server · Garmin Connect / Strava · OpenAQ / PurpleAir / Sensor.Community · R `openair` · OGC SensorThings
| Borrow | GeoSpaX lazy version | How | Phase |
|---|---|---|---|
| Velocity / GeoEvent: real-time feeds (MQTT, HTTP), geofencing, incident detection, alerts [9] | **`sensor` trigger**: threshold (`above`/`below`), geofence (`inside: <polygon layer>`), cooldown per device, on HTTP pushes, MQTT messages and GNSS fixes; the alert is a finished map + report (`air-quality-alert`) | N | ✅ v1 |
| MQTT ingestion (IoT platforms, Home Assistant, Node-RED) [10] | Built-in MQTT 3.1.1 subscriber (`--mqtt mqtt://host/topic/#`): generic sensor JSON, flat numeric payloads, device id from payload or topic | N | ✅ (`mqtts://` and LoRaWAN payload mappings in P3) |
| OwnTracks phone tracking [11] | OwnTracks location messages become live phones (no GeoSpaX app on the phone) | N | ✅ |
| Garmin Connect / Strava activity import (FIT) [12] | Watches, bike computers and fitness sensors plug in like any device: track + per-second heart rate, cadence, power, temperature as a readings layer | N (`fitparser`) | ✅ |
| OpenAQ / PurpleAir / Sensor.Community air-quality maps | Logger CSV/JSON with coordinates → readings → PM classes at the **WHO 2021 guideline and interim targets** [13], share of readings above, hotspot map, report | N | ✅ |
| R `openair` (pollution summaries, polar plots) | `sensor.summary` (count, mean, p95, max, WHO exceedance); `openair` plots through the R step | N / R | ✅ summary · polar plots P4 |
| OGC SensorThings API clients (FROST, OSGeo istSOS) | Poll Things/Datastreams/Observations into the live store, same triggers | N | P3 (next) |
| Phone sensor apps (SensorLog, phyphox exports) | Their CSV exports (`locationLatitude(WGS84)` …) are sensor logs without configuration | N | ✅ (CSV) |

---

## Sources
1. Esri, ArcGIS Pro assistant 3.6 beta (Jan 2026): https://www.esri.com/arcgis-blog/products/arcgis-pro/announcements/join-the-arcgis-pro-assistant-3-6-beta-help-shape-the-future-of-desktop-gis
2. QGIS 4.0 changes: https://www.reddit.com/r/QGIS/comments/1rodk65/qgis_40_visual_changelog_official_video/ · https://giscarta.com/blog/creating-a-demographic-map-copy · https://usemaps.com/en/qgis-4-0-whats-changed-webinar-summary/
3. MapInfo Pro v23.2 announcement (Nov 2025): https://groups.google.com/g/mapinfo-l/c/x4nndYq8KxU · feature list: https://www.pelicangeographics.com/pbmapinfo
4. GeoLibre v1.3.0 and docs: https://github.com/opengeos/GeoLibre/discussions/385 · https://github.com/opengeos/geolibre/blob/main/docs/index.md
5. RustGIS README: https://github.com/opengeos/RustGIS
6. GRASS 8.5.0 release (May 2026): https://github.com/OSGeo/grass/releases/tag/8.5.0
7. Hexagon, Octave Imagine (formerly ERDAS IMAGINE): https://hexagon.com/products/erdas-imagine
8. Felt blog (Felt AI, MCP server): https://felt.com/blog
9. Esri, ArcGIS Velocity overview: https://www.esri.com/en-us/arcgis/products/arcgis-velocity/overview
10. OASIS, MQTT Version 3.1.1 (standard): https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html
11. OwnTracks JSON format: https://owntracks.org/booklet/tech/json/
12. Garmin, FIT protocol: https://developer.garmin.com/fit/protocol/
13. WHO global air quality guidelines (2021): https://www.who.int/publications/i/item/9789240034228
