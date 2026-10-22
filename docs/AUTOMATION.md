# Automation: recipes, triggers and the autopilot

GeoSpaX's power is in automation ([VISION.md](VISION.md)). This document specifies the **recipe** format, the
**triggers** that start recipes, the **autopilot** (AutoMap) that fills in parameters and explains them, and the
engine that runs recipes on desktop, web and the command line.

**Status (October 2026): automation engine v0 is built, with rasters, remote sensing, providers and sensors.** It includes:
- recipes (YAML) and a dependency-ordered runner;
- 27 built-in steps (32 names with aliases), among them device and sensor import, live sensor snapshots and summaries, AutoMap styling, automatic layout and PNG/SVG/PDF export, an HTML report with an auto-written methods section, SQL, buffer, hexbin, cross-validated IDW, terrain, Sentinel-2 indices, GRASS, SAGA, and R and Python steps;
- device, folder, schedule, `after`, `stac`, `webhook` and **`sensor`** triggers (threshold and geofence, from HTTP, MQTT or GNSS);
- a command line, an HTTP API and an *Automate* panel;
- thirteen gallery recipes, including terrain (Copernicus DEM), latest cloud-free NDVI (Sentinel-2), GRASS landforms, SAGA wetness, a sensor log to map and a live air-quality alert.

Measurements are in [bench/RESULTS.md §11–13](../bench/RESULTS.md#11-automation-engine-v0). Code:
`crates/engine/src/automation/`, recipes: [`recipes/`](../recipes).

```bash
geospax run photos-to-map --input source=/media/$USER/PHONE   # the desktop binary (or geospax-server)
geospax check my-recipe.yaml                                   # validate + show the plan
geospax watch --watch ~/Field/inbox                            # triggers on, no window
```

## 1. Concepts

| Concept | What it is | State |
|---|---|---|
| **Step** | One operation: import, analyse, style, lay out, export, a GRASS/SAGA tool, or an R/Python script (later: Whitebox, OTB, SNAP, ODM providers) | ✅ 27 built-in steps |
| **Recipe** | A small YAML (or JSON) file: inputs, triggers, steps, outputs. Versioned, diffable, shareable | ✅ |
| **Trigger** | What starts a recipe without a click: device connected, folder changed, schedule, another recipe finishing, new satellite pass, webhook call, live sensor threshold or geofence | ✅ device, folder, schedule, after, stac, webhook, sensor |
| **Run** | One execution: per-step status, timing and "why" lines, cancel, artifacts, provenance. Listed in the job registry as kind `recipe` | ✅ |
| **Autopilot / AutoMap** | Rules plus data profiling that choose styles, classes, colours, labels, CRS, page and parameters, and explain each choice | ✅ v0 rules (§4) |
| **Artifact** | A run output: map PNG/SVG, report, data files in `<state>/runs/<run-id>/`; result layers in `<state>/outputs/<recipe>/` | ✅ |

## 2. Recipe format (v1, as implemented)

The gallery recipe that turns a plugged-in phone into a finished map ([`recipes/photos-to-map.yaml`](../recipes/photos-to-map.yaml)):

```yaml
recipe: photos-to-map
version: 1
title: Photos and tracks → finished map
triggers:
  - device: { kinds: [phone, camera, folder], has: [photos] }
inputs:
  source: { type: device, default: auto, description: device id, mounted device or folder }
steps:
  - id: import
    use: devices.import
    with: { source: "${inputs.source}" }
  - id: style
    use: automap.style                    # picks symbology for each layer and records why
    with: { layers: "${import.layers}" }
  - id: map
    use: export.map                       # page layout + PNG/SVG
    needs: [style]
    with: { layers: "${import.layers}", title: "Field photos · ${import.device}", format: [png, svg] }
  - id: report
    use: export.report                    # map + numbers + methods + decisions + provenance
    needs: [map]
    with: { title: "Field report · ${import.device} · ${run.date}" }
outputs: [import, map, report]
```

| Key | Meaning |
|---|---|
| `recipe` | Id: `a-z 0-9 - _`, ≤ 64 characters |
| `version`, `title`, `description` | Shown in the gallery and the report |
| `triggers` | List of `device`, `folder`, `schedule`, `after` (§3). No triggers = run by hand, from the CLI or the API |
| `inputs` | `name: { type, default, description }`. Missing inputs without a default are an error before anything runs |
| `steps[]` | `id`, `use` (step name), `with` (parameters), optional `needs` (extra ordering), `when` (run only if truthy), `title` |
| `outputs` | Step ids whose outputs are the run's outputs (all steps if omitted) |

**Expressions:**
- `${inputs.x}`, `${step.key}` and `${step.list.0}`;
- `${run.date}`, `${run.time}`, `${run.datetime}`, `${run.id}`, `${run.dir}` and `${recipe}`;
- `${trigger.kind}`, `${trigger.text}`, `${trigger.device}`, `${trigger.root}`, `${trigger.path}` and `${trigger.files}`;
- a fallback with `${inputs.title ?? Field map}`.

A string that is exactly one `${…}` keeps the referenced type, so `layers: "${import.layers}"` is a list. Otherwise the values are interpolated as text.

**Order:** steps run in declaration order, except that a step always runs after every step it references or
`needs`. Cycles are rejected. A skipped step (`when:` false) records `{ skipped: true }`.

**Validation reports every problem at once, before anything runs** (`geospax check`, `POST /api/recipes/validate`):

```
✗ broken.yaml has 4 problem(s):
  - these steps depend on each other in a circle: b, c
  - step 'd' refers to ${nowhere.x}, but there is no step or input called 'nowhere'
  - step 'a': unknown step 'export.mapp' (did you mean 'export.map'? `geospax steps` lists them all)
  - step 'b': 'vector.buffer' needs 'distance'
```

Planned control steps: `for_each` (files, features, dates, devices), `parallel` and `ask` (one question with a recommended answer, only when the autopilot's confidence is low).

### Step catalogue (built)

| Step | What it does | Borrowed from |
|---|---|---|
| `devices.import` (+ `devices.import_photos`, `devices.import_tracks`) | Geotagged photos (EXIF, HEIC, DJI XMP), GPX/KML, NMEA, DJI `.SRT`, **sensor logs** (CSV/TSV/JSON with coordinates; units from headers) and **FIT** activities from a phone, camera, drone card, GPS unit, watch, sensor logger or folder → layers (`photos`, `tracks`, `waypoints`, `readings`); `source: auto` = the triggering or connected device | ArcGIS Geotagged Photos To Points, QGIS ImportPhotos, MapInfo drone add-in, Garmin Connect / Strava FIT import |
| `sensor.snapshot` | Live sensor readings of the last `minutes` (HTTP pushes, MQTT, phones) → `live_readings` points, `live_tracks` (each sensor's path) and `live_latest` (where each sensor is now, labelled); `device:` filters with `*` wildcards | ArcGIS Velocity / GeoEvent Server, QGIS live GPS tracking |
| `sensor.summary` | Count, mean, 95th percentile and maximum per measurement; air quality against the WHO 2021 guidelines (share of readings above); picks the measurement to map (`${summary.main}`) | ArcGIS Velocity summaries, R `openair`, pandas `describe` |
| `io.open` | Layers by id or file path; `auto` picks a suitable layer (`kind`, `prefer: largest\|samples\|incidents`) | ArcGIS Add Data, QGIS Data Source Manager |
| `vector.sql` | SQLite-dialect SQL with SpatiaLite functions; `@input` is the layer's table; rows without geometry come back as values | MapInfo SQL Select, QGIS virtual layers, ArcGIS Make Query Layer |
| `vector.buffer` | Buffer in metres in the data's UTM zone (picked from the extent), optional dissolve, area in m²/ha | ArcGIS Buffer, QGIS Buffer, GRASS `v.buffer`, SAGA |
| `aggregate.hexbin` | Points → hexagons (count, sum or mean of a field), auto-sized for ~25 cells across; streams any number of points | ArcGIS Generate Tessellation + Summarize Within, QGIS Count points in polygon |
| `interpolate.idw` | IDW surface clipped to the samples' hull; power chosen by leave-one-out cross-validation; RMSE/MAE reported | ArcGIS IDW, QGIS IDW, GRASS `v.surf.idw`, SAGA |
| `interpolate.auto` | Automatic geostatistics: variogram fitted with three models, ordinary kriging with the best, cross-validated against IDW (lower error wins); prediction and standard-error GeoTIFFs, variogram chart (§6e) | ArcGIS Geostatistical Wizard, R gstat + automap `autoKrige`, GRASS `v.krige`, SAGA Ordinary Kriging |
| `stats.hotspots` | Getis-Ord Gi* hot and cold spots with every setting from the data: incidents counted in auto-sized hexagons, distance band from incremental spatial autocorrelation, false-discovery-rate correction, global Moran's I (§6e) | ArcGIS Optimized Hot Spot Analysis, GeoDa, PySAL `esda`, R spdep `localG` |
| `automap.style` | Chooses symbology for each layer (§4), explains it, writes it to the project | ArcGIS smart mapping, Felt AI auto-style |
| `style.apply` | Applies saved styles exactly (what "Save as recipe" records) | ArcGIS layer files, QGIS QML |
| `overviews.build` | PMTiles overview pyramid for a dense layer; skipped when not needed | ArcGIS Build Pyramids, GDAL `gdaladdo` |
| `layout.auto` | Page defaults (title, subtitle, size) for later exports | ArcGIS Pro layouts, QGIS Print Layout |
| `export.map` (+ `export.png`, `export.svg`, `export.pdf`) | Finished page: title, subtitle, legend with class counts, ramps and class swatches, scale bar, north arrow, graticule, labels, credits; rasters under the vectors (relief shading multiplied on top); the automatic page takes the data's shape, so raster maps are neither cropped nor padded; PNG (resvg), SVG and vector PDF (krilla, selectable text) | ArcGIS Export Layout, QGIS Print Layout, MapInfo Layout Designer |
| `export.series` | Binds every map this run laid out (a map series: index page + sheets) into one multi-page vector PDF; `export.map` `frames: [{extent, label}]` outlines the sheets on the index map | ArcGIS Pro Map Series export, QGIS Atlas |
| `export.map` multi-panel | `panels: [{extent?, title?, layers?}]` (R patchwork) or `facet: field` + `facet_layer` (ggplot2 `facet_wrap`); `ncol`, `legends: collect\|keep\|auto`, `tags: a\|A\|1\|i\|none`; each panel shows exactly its extent; `exact: true` does the same for a single map | R patchwork, ggplot2 facets, tmap `tm_facets` |
| `export.map` furniture | `dpi` (150–1200, written into the PNG), `scale_bar: pill\|checker\|line\|ruler\|none`, `units: metric\|imperial\|both`, `north_arrow: needle\|compass\|rose\|minimal\|none`, `legend: right\|inside\|none`, `legend_title`, `legend_edit: {layer: {title, hide, labels: {old: new}}}`, `legend_order`, `inset: none\|auto\|tl\|tr\|bl\|br`, and `*_at` corners (`auto` = where the data is not) | ArcGIS Pro layout elements, QGIS print layout items |
| `data.fetch` | Online data for the area, no API keys: `source: worldclim` (bioclim, `variables`, `resolution` 10m/5m/2.5m/30s), `worldclim-monthly` (`variable`, `months`), `worldclim-future` (`gcm`, `ssp`, `period`), `chelsa`, `soilgrids` (`property`, `depth`), `gbif` / `obis` / `inat` (`species`, `limit`), `gadm` (`country`, `level`), `gebco` (`layers`: elevation, tid; GEBCO 2026 at 15″), `hansen` (`layers`: treecover, lossyear, gain, datamask; Hansen GFC v1.13 at 1″, areas up to 2° a side; loss as years 2001–2025), `ecoregions` (RESOLVE 2017, clipped, with geodesic areas and RESOLVE's colours; downloaded once to `<state>/catalog/`). Rasters are windows of the provider's grid read over HTTP; `base:` points at a mirror. The citation goes into the methods | R geodata, rgbif, robis, rinat; ArcGIS Living Atlas |
| `taxa.worms` | Check a layer's scientific names against WoRMS (`layer`, `field`, `within` a group to settle homonyms, `base` a mirror): adds AphiaID, match type, status, accepted name and ID, rank, kingdom to family, habitat, extinct, address and a verdict (ok, synonym, check spelling, ambiguous, not in WoRMS); names are kept; answers cached 30 days | WoRMS Taxon match; worrms `wm_records_names`; obistools `match_taxa` |
| `tool` | Runs any Toolbox tool in a recipe: `tool: gsx/sdm` (plugin/tool), `params:` its parameters, with layers and rasters by id or by this recipe's own names (`climate.raster_ids`, `dem`). Outputs `layers`, `layer`, `rasters`, `raster` (first), `message` and `table`; the table and notes go into the methods. The domain kits use it ([GSX.md](GSX.md#domain-kits)) | ArcGIS ModelBuilder tool calls, QGIS graphical modeler |
| `POST /api/preview/map` | `{map: <export.map parameters>, styles?, dpi?}` → a low-resolution PNG of the first page, made in a temporary folder; no run is recorded (Finish my map's live preview) | |
| `export.report` | Self-contained HTML: map, headline numbers, "How this map was made", every automatic decision, run log, provenance | ArcGIS Pro reports, R Markdown / Quarto |
| `export.data` | GeoPackage, GeoJSON, CSV, FlatGeobuf, KML or Shapefile (EPSG:4326) | ArcGIS Export Features, QGIS Save As, ogr2ogr |
| `python`, `r` (+ `script.python`, `script.r`) | User code in a sidecar process (§6) | ArcPy, PyQGIS, GRASS Python; R sf/gstat/terra |
| `dem.fetch` | Elevation for the area of interest: Copernicus GLO-30 (or GLO-90, or any DEM file/URL) read as cloud-optimised GeoTIFF windows over HTTP, mosaicked and reprojected to the local UTM zone | ArcGIS Living Atlas terrain, QGIS SRTM Downloader, GRASS `r.in.srtm` |
| `ai.detect` | Your own ONNX model over an image in tiles, on this computer (tract, pure Rust): object detection (YOLOv5/v8/v11 layouts, NMS) → polygon layer with `class`, `score`, `area_m2`; segmentation → class raster with areas. `model` (name in Imagery › Models or a path), `raster`, `threshold`, `iou`, `bands`, `scale`, `mean`, `std`, `tile`, `overlap`, `format`; the model's licence goes into the methods ([AI.md §4](AI.md#4-your-own-model-object-detection-and-segmentation)) | ArcGIS Pro Detect Objects / Classify Pixels Using Deep Learning, QGIS Deepness, ERDAS IMAGINE deep learning |
| `embeddings.fetch` | AlphaEarth Foundations annual satellite embeddings (Google DeepMind, CC-BY 4.0; 2017–2025): 64 numbers per 10 m pixel summarising a year of observations, read for the area of interest from the public copy on Source Cooperative (VRT windows over HTTP; areas over ~20 km are read coarser to stay under 4 million pixels). Which files cover an area is cached per UTM zone in `<state>/aef/` ([AI.md §3](AI.md#3-satellite-embeddings)) | Earth Engine `GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL` |
| `embeddings.similar` | Cosine similarity of every pixel to the mean embedding of sample points (or one `point`): places like these; the area at ≥ `threshold` reported | Earth Engine similarity search, ArcGIS one-class classification, QGIS SCP spectral angle mapping |
| `embeddings.cluster` | Spherical k-means (k-means++, fixed seed) into `classes` groups of alike landscape, no samples needed | ArcGIS Iso Cluster, GRASS `i.cluster`, Earth Engine `wekaKMeans` |
| `embeddings.classify` | Classes from labelled sample points (`field`), cosine k-nearest neighbours; leave-one-out accuracy and area per class reported | ArcGIS Train/Classify, QGIS Semi-Automatic Classification Plugin, Earth Engine `ee.Classifier` |
| `embeddings.change` | 1 − cosine similarity of each pixel's embeddings in two years (`before`, `after`, same grid); the area at ≥ `threshold` reported | ArcGIS Change Detection Wizard, GRASS `i.change` |
| `terrain.derive` | Hillshade (multidirectional, auto z-factor), slope, aspect, TRI, TPI, roughness via GDAL DEM processing; geographic DEMs are reprojected first; mean slope, steep share and dominant aspect reported | ArcGIS Surface toolset, QGIS terrain analysis, GRASS `r.slope.aspect`, SAGA, gdaldem |
| `terrain.contours` | Contours with an automatic interval (≈ 12 levels), index contours, Chaikin smoothing; DEMs finer than 2 m (LiDAR, drone) are traced on a 2 m average so measurement noise does not break lines into loops; drawn thin and brown with bolder index lines | ArcGIS Contour, QGIS Contour, GRASS `r.contour`, MapInfo Vertical Mapper |
| `lidar.grid` | LAS/LAZ point clouds (one file, a folder of tiles or a device) → bare-earth terrain (DTM), surface (DSM) and canopy height (CHM) rasters, building outlines with roof heights and tree tops with heights, in one streaming pass (§6c) | ArcGIS LAS Dataset to Raster + Classify LAS Ground + Extract Buildings/Trees, ERDAS IMAGINE point-cloud tools, PDAL `filters.smrf`, lidR `rasterize_terrain`/`locate_trees`, LAStools `lasground`/`las2dem`, GRASS `r.in.pdal` |
| `scene.3d` | A DEM (plus the run's buildings, trees and point-cloud sample) → a 3D scene: terrain block diagram draped with its map colours and relief shading or imagery, vector layers painted on, extruded buildings, modelled trees, the point cloud; saved as glTF 2.0 (`scene.glb`), a self-contained offline viewer (`scene.html`) and a rendered picture for the report (§6d) | ArcGIS Pro local scenes + Export to glTF, QGIS 3D map view + Qgis2threejs, ERDAS IMAGINE VirtualGIS, GRASS NVIZ, SAGA 3D View, MapInfo 3DMap, CloudCompare, CesiumJS |
| `raster.classify` | Labelled classes with areas (ha, %); automatic schemes for slope, NDVI/SAVI/EVI, NDWI/NDMI, NBR and elevation, or your breaks | ArcGIS Reclassify + Tabulate Area, GRASS `r.reclass`/`r.report`, ERDAS Recode |
| `raster.sample` | Raster values at points as new fields (elevation, slope, NDVI…), plus the strongest Pearson correlation with a measured field | ArcGIS Extract Multi Values to Points, QGIS Sample raster values, GRASS `v.what.rast` |
| `rs.search` | STAC search (Earth Search, Sentinel-2 L2A by default): newest first, cloud-filtered, prefers the tile that covers the whole area | Octave Imagine (ERDAS) search, Earth Engine filters, QGIS STAC plugin |
| `rs.index` | NDVI, NDWI, NBR, NDMI, SAVI or EVI at 10 m from the newest scene that is **clear over the area** (scene classification checked first; clouds, shadows, cirrus masked); falls back to older dates | ERDAS Indices, ArcGIS NDVI function, GRASS `i.vi`, Earth Engine `normalizedDifference` |
| `rs.fetch` | True-colour image (or any band) of the chosen scene for the area | ArcGIS imagery basemaps, ERDAS Subset |
| `grass` | GRASS modules in a temporary project (`grass --tmp-project … --exec`); inputs imported, outputs exported back; categorical outputs keep GRASS's class labels and colours | GRASS, QGIS Processing's GRASS provider |
| `saga` | A SAGA tool through `saga_cmd`; outputs come back as rasters | SAGA, QGIS Processing's SAGA provider |

### Step catalogue (planned)

| Family | Examples | Engine |
|---|---|---|
| Data | Landsat / Sentinel-1 in `rs.*`, OGC SensorThings and LoRaWAN feeds in `sensor.*` | native |
| Clean | `clean.auto` (validity, duplicates, encoding, empty geometries), `crs.auto` as a step (UTM selection already exists inside `vector.buffer`) | native / GDAL |
| Vector | `overlay`, `nearby`, `summarize_within`, `dissolve`, `join.auto` | native (geo, DuckDB) |
| Raster / RS | `composite.cloudfree` (median of several passes), `classify.auto` (unsupervised/supervised land cover), `change.detect`, `ortho.drone`, zonal statistics | native / OTB / GRASS / SNAP / ODM |
| Terrain / hydro | `watersheds`, `viewshed`, `solar` as native steps (today: through the `grass`/`saga` steps) | Whitebox / GRASS / SAGA |
| Stats / geostats | `clusters` (local Moran's I outliers, DBSCAN), `hotspots.spacetime`, `regression.spatial` (GWR), kriging with a trend or anisotropy | native + R/Python |
| Cartography | `labels.auto` for lines and polygons, `atlas` | native |
| Output | `export.webmap` (PMTiles + MapLibre site), multi-page atlas PDF | native |
| Code | `wasm:` plugin steps | wasmtime |

## 3. Triggers

| Trigger | Example | State |
|---|---|---|
| `device` | `device: { kinds: [phone, camera], has: [photos] }` | ✅ From the device hub ([DEVICES.md](DEVICES.md)) on every new or changed device with geodata; the run gets `source` = the device folder. A recipe that takes the device supersedes the plain `--auto-import`. Drop folders (`--inbox`, desktop `~/GeoSpaX/Inbox`) run their recipe without Auto. A device left plugged in is not re-run after a restart unless its content changed (`<state>/devices/seen.json`) |
| `folder` | `folder: { path: /data/inbox, pattern: "*.gpx" }` | ✅ Polled every 4 s (2 levels deep); fires when new or changed files appear and the listing is stable across two polls (copies finished); `${trigger.files}` lists them |
| `schedule` | `schedule: { every: 6h }` or `{ cron: "0 6 * * MON" }` | ✅ `every:` (s/m/h/d/w) and five-field cron in local time; `on_start: true` fires at start |
| `after` | `after: photos-to-map` | ✅ Runs when that recipe succeeds; `${trigger.outputs}` holds its outputs |
| `stac` | `stac: { every: 12h, area: auto, max_cloud: 50 }` | ✅ Polls the STAC API (Earth Search by default) on its own thread; fires when a pass **newer than the one the last run used** appears over the area. `area: auto` = the area of the last successful run (kept in `<state>/memo/<recipe>.json`); a recipe that never ran fires once to settle it. One fire per new date |
| `webhook` | `webhook: { token: <≥ 16 chars> }` → `POST /api/hooks/<token>` | ✅ The JSON body's keys that match declared inputs become the run's inputs; the whole body is `${trigger.payload}`. 404 for unknown tokens, 409 while the recipe's Auto switch is off |
| `sensor` | `sensor: { field: pm2_5, above: 35, cooldown: 30m }` · `sensor: { inside: farm.parcels }` · both together | ✅ Every live position or reading (HTTP push, MQTT, phone page, GNSS) is checked against the enabled recipes. Thresholds use `above:`/`below:` on a field; `device:` filters by id or name (wildcards). `inside: <polygon layer>` alone fires when a device **enters** the polygons; with a field it limits the threshold to readings inside. `cooldown` (default 10 min) per recipe and device. The run gets `${trigger.device}`, `.value`, `.threshold`, `.lat`, `.lon`, `.text` and the reading's values ([DEVICES.md §4](DEVICES.md#4-sensors-in-detail)) |

**Auto switches.** Triggers fire only for recipes whose **Auto** switch is on. The switches persist in
`<state>/automation.json`. Turn them on with the UI switch, `geospax-server --auto id,id|all`,
`GEOSPAX_AUTO` (desktop) or `PUT /api/recipes/{id}/auto`. `geospax watch` turns all of them on (or `--only id,id`).

**One run per recipe at a time.** A trigger that fires while its recipe is busy is queued. Requests with different
inputs (two devices) run one after the other; identical requests merge.

## 4. Autopilot (AutoMap): smart defaults that explain themselves

Every automatic choice comes with a one-line reason. The reason appears in the run log, the report's "Automatic
decisions" table and the UI.

| Decision | Rule (v0, built) | Borrowed from |
|---|---|---|
| Symbology type | Text with 2–12 categories → unique values; numeric → graduated; ids, names, paths and constants skipped; field names score (`pop`, `value`, `ph`, `type`, `class`, …) | ArcGIS smart mapping, QGIS |
| Classification method | Skewness g1: \|g1\| < 0.5 → equal intervals; < 2 → natural breaks (ckmeans); ≥ 2 → quantiles | Jenks/ckmeans, MapInfo thematic wizards |
| Number of classes | 5; 3–5 for small samples (Sturges) | Cartographic practice |
| Colour ramp | Diverging when values straddle 0 in a balanced way; Blues for water/rain/moisture, Greens for vegetation, Viridis for elevation, pH and predictions, Yellow-Orange-Red otherwise; Tableau 10 / Bold for categories; all colour-blind-safe | ColorBrewer practice |
| Device layers | Photos: bold orange with a white ring and camera-direction wedges; tracks: magenta over a white casing; waypoints: labelled | Field-app conventions |
| Single colours | Distinct from the other layers on the same map; points over a coloured surface turn white with a dark ring | Cartographic practice |
| Polygons | 1–3 areas over other data are see-through; layers with more than 400 polygons drop outlines; the step that made a layer can hint (IDW: no outlines; hexbins: outlines) | Cartographic practice |
| Label field | `name`, `title`, `label`, `site`, `*_name`; photo file names never labelled | QGIS/ArcGIS label defaults |
| CRS for analysis | UTM zone from the data's centre (buffers) | PROJ |
| Interpolation | IDW power from leave-one-out cross-validation over {1, 1.5, 2, 3}; kriging via the R step (gstat fits Sph/Exp/Gau and keeps the best). Automatic IDW-vs-kriging choice: planned | gstat, ArcGIS Geostatistical Analyst |
| Raster styles | DEM → hypsometric tint stretched 2–98 %; hillshade → grey at 50 % with multiply blending over the colour layer; slope 0–45° pale yellow → dark red; aspect → colour wheel; NDVI/SAVI/EVI → red–yellow–green with a **fixed** −0.2…0.9 range (dates compare); NDWI/NDMI brown → blue; wetness → blues; classes → their own colours (GRASS's for GRASS outputs); RGB → 2–98 % stretch + gamma 0.75 | ✅ `raster.rs` |
| Raster maps | One thematic raster per map (the newest) with relief shading on top; the frame is filled with data (no empty margins); rasters render at native resolution (1–2× the page) | ✅ |
| Scene choice | Newest pass first; a scene must be ≥ 70 % clear **over the area** (scene classification), not just on average; same-day tiles: the one covering the whole area | ✅ `rs.index` |
| Contour interval | Round step (1, 2, 2.5, 5 × 10ⁿ) giving ≈ 12 levels; every 5th is an index contour | ✅ |
| Air-quality classes | PM2.5 and PM10 are classed at the WHO 2021 24-hour guideline and interim targets (PM2.5: 15 / 25 / 37.5 / 50 / 75 µg/m³), green "guideline met" to dark red "above IT-1", instead of statistical breaks; also offered as **WHO guideline** in the symbology panel | ✅ `automap.rs` |
| Sensor field to map | A pollutant first (PM2.5, PM10, NO₂, O₃ …), then heart rate, CO₂, noise, temperature, humidity; units from the logger's headers or common defaults | ✅ `sensor.summary` |
| Spectral index | Sensor metadata → valid indices (Landsat, PlanetScope) | planned |
| Overview pyramid | Layer too dense to tile live → build automatically (`overviews.build`, `overview_suggested`) | ✅ |

**Layout rules (`export.map`):**
- **Page:** landscape or portrait from the data's shape, or A4, A3 or Letter at 150 dpi. The extent fits all the mapped data with a margin and is at least 400 m across.
- **Title and subtitle:** automatic (device, what was found, date).
- **Map elements:**
  - a legend built from the styles, with class counts;
  - a scale bar with round numbers;
  - a north arrow;
  - a graticule with round steps;
  - point labels with collision avoidance (four candidate positions).
- **Context layers:** land, roads and rivers are added automatically when loaded.
- **Large point layers:** above 30,000 points, a density grid replaces individual points.
- **Credits:** sources and the recipe.

## 5. Three ways to write a recipe, all lazy

1. **Record.** ✅ v0: **"Save this map as a recipe"** in the Automate panel turns the visible layers and their exact styles into a recipe (`io.open` → `style.apply` → `export.map` → `export.report`) that redraws and re-exports the map on demand, or on a trigger once you add one. Planned: recording the session log, where literal paths become inputs and repeated actions become `for_each`.
2. **Pick from the gallery.** ✅ Fifteen built recipes ([`recipes/`](../recipes)):

   | Recipe | Trigger | What you get | Time (RESULTS §11) |
   |---|---|---|---|
   | `photos-to-map` | phone / camera / folder with photos | Styled map of photos (with camera direction), tracks and waypoints; PNG + SVG + report | 0.17 s |
   | `track-to-map` | GPS unit with tracks | Map + KML (Google Earth) + GeoJSON + report | 0.11 s |
   | `drone-flight-report` | drone card | Flight path, photo positions, dissolved ground coverage (ha) in UTM, report | 0.11 s |
   | `points-to-hexbins` | by hand | Auto-sized hexagon density map from any point layer (1M points) | 0.65 s |
   | `points-to-hotspots` | by hand (add a folder trigger) | Hot and cold spots of incidents (or of a value) at 90/95/99 % confidence, every setting chosen from the data; map (PNG/SVG/PDF) + report with Moran's I and the distance search (§6e) | 0.30 s (RESULTS §20) |
   | `interpolate-samples` | by hand (add a folder trigger) | Kriging or IDW, whichever cross-validates better: surface map, uncertainty map (kriging standard error), variogram chart, RMSE (§6e) | 1.0 s (RESULTS §20) |
   | `python-spatial-stats` | by hand | Mean centre, standard distance, deviational ellipse, Clark–Evans nearest-neighbour index (Python) | 0.19 s |
   | `r-kriging` | by hand | Ordinary kriging with an auto-fitted variogram and cross-validation (R gstat) | 4.2 s |
   | `terrain-report` | by hand | Copernicus 30 m DEM for the area → shaded relief + contours map (PNG/SVG/PDF), slope-class map with hectares, elevation and slope sampled at your points | 6.1 s |
   | `lidar-to-terrain` | a drive or drop folder with LAS/LAZ (`has: [point-clouds]`) | Bare-earth terrain map with relief shading, contours and buildings; canopy map with tree tops and buildings over surface relief (PNG/SVG/PDF); canopy-height classes with hectares; report with points, density, canopy cover, tree and building counts | 2.3 s for 0.7 M points, 12 s for 10.7 M (RESULTS §18) |
   | `latest-ndvi` | `stac` (new pass) | Newest Sentinel-2 pass that is clear over the area → NDVI map, vegetation classes with hectares, true-colour map, NDVI at your points | 5.5 s |
   | `landforms-grass` | by hand | GRASS `r.geomorphon`: ten landforms over relief shading, GRASS colours, share of each | 5.0 s |
   | `wetness-saga` | by hand | SAGA Wetness Index (`ta_hydrology 15`) over relief shading; wetness sampled at your points | 6.2 s |
   | `sensor-log-to-map` | sensor logger plugged in | Every geotagged reading coloured by the main measurement (WHO classes for PM), the logger's track, statistics per measurement, GeoJSON, report | 0.12 s (RESULTS §13) |
   | `air-quality-alert` | `sensor` (PM2.5 > 35) | Snapshot of every live sensor's last two hours → alert map + report naming the sensor and value | 0.26 s from the reading (RESULTS §13) |

   Times include reading the DEM and imagery over HTTP (about 2.8 s and 1.8 s here). Planned gallery entries: `field-week-report`, `what-changed`, `flood-extent` and `drone-to-ortho`.
3. **Ask (optional AI).** Planned. A local model (llama.cpp/Ollama) or your own provider turns a request into recipe YAML, constrained by the step catalogue (`GET /api/steps`) and checked by the validator. GeoSpaX shows the plan first; recipes that write outside the state folder, use the network or run code need explicit approval. An MCP server would expose recipes and steps to external agents.

## 6. R and Python steps (built)

```yaml
  - id: krige
    use: r
    with:
      inputs: { samples: "${samples.layer}" }   # arrives as an sf object (path if sf is missing)
      params: { field: "${inputs.field}" }      # becomes the R list `params`
      packages: [sf, gstat]                     # checked before running, with install hints
      code: |
        library(sf); library(gstat)
        pts <- st_transform(samples, 32755)
        model <- fit.variogram(variogram(ph ~ 1, pts), vgm(c("Sph", "Exp", "Gau")))
        ...
        result(model = as.character(model$model[2]), cv_rmse = rmse)   # numbers -> run log + report
        list(prediction = st_transform(grid, 4326))                    # returned sf objects -> layers
```

| | Python | R |
|---|---|---|
| Inputs | Variables named after `inputs` (GeoDataFrame if geopandas is installed, else a GeoJSON dict); `inputs[name]` is the GeoJSON path; `params` dict | Variables named after `inputs`: layers as sf objects (the path if sf is missing), rasters as terra SpatRasters; `params` list |
| Layers out | `save(name, obj)` (GeoDataFrame, FeatureCollection dict or list of features) or `OUTPUTS = {name: obj}` | Return a named list of sf objects (or call `save_layer(name, obj)`) |
| Rasters, figures, tables out | GeoTIFF, PNG/PDF/SVG and CSV files written to `outputs_dir` | Return SpatRasters (rasters), ggplot/tmap objects (figures) and data frames (tables) in the list, or call `save_figure(name, plot)` / `save_table(name, df)` ([R.md](R.md)) |
| Numbers out | `result(key=value)` or `RESULT = {...}` | `result(key = value)` |
| Interpreter | `python3`/`python` on PATH or `GEOSPAX_PYTHON` (Windows: `python`, then the `py` launcher) | `Rscript` on PATH or `GEOSPAX_RSCRIPT` (Windows: also `Program Files\R\R-*\bin` and `%LOCALAPPDATA%\Programs\R`, newest first; macOS: also the CRAN framework and Homebrew). Packages GeoSpaX installs (R › R setup) are in `<state>/r-library`, searched first |

**How a code step runs:**
- **Isolation:**
  - each step runs in its own process with a scrubbed environment (`PATH`, `HOME`, locale, R/Python library paths and PROJ/GDAL data only);
  - its working directory is `steps/<id>/` inside the run folder;
  - it has a timeout (`timeout_s`, default 600) and stops on the run's cancel button.
- **Data exchange** goes through files: GeoJSON in, GeoJSON or GeoPackage out. A crashing script cannot take the app down, and GPL code stays out of process.
- **Results:** returned layers become `<recipe>.<name>` and appear on the map. A non-zero exit fails the step with the last lines of stderr.

The **R tab** runs R steps from a console with templates for tmap, ggplot2, rayshader, terra,
biomod2, MaxEnt, tidymodels, dbplyr and rgee, and **R setup** installs R and package kits
([R.md](R.md)).

Planned:
- Python environment management (`uv`/`pixi`);
- Arrow/GeoParquet and COG exchange;
- "Show me the code" (built-in steps exported as equivalent R or Python);
- webR and Pyodide for light steps in the web edition.

## 6b. Rasters, remote sensing and providers (built)

**Rasters are first-class.** GeoTIFF, VRT, JPEG 2000, ERDAS IMAGINE (`.img`), ASCII grid and SRTM `.hgt` files in
the data folders are catalogued at start; recipe outputs are added as they are made and restored after a restart.
Each raster has statistics, a guessed kind (DEM, hillshade, slope, NDVI, classes, RGB…), an automatic style with a
reason (§4) and a legend. A small sidecar (`<file>.gsx.json`) keeps what the step that made it knew: kind, title,
class labels and colours, units and attribution.

| Where | How rasters appear |
|---|---|
| Web and desktop map | **Rasters** panel: switch on/off, opacity, legend (ramp or classes), zoom to. Each raster is a MapLibre `image` source rendered by the engine in Web Mercator (`GET /api/rasters/{id}/overlay.png`, cached per style), drawn above land and below every vector layer. After a run, its rasters appear the way the map composer shows them |
| Map composer | The raster is warped to the page frame (GDAL) and embedded as PNG under the vectors; relief shading is multiplied on top; the legend gets a colour ramp with units or class swatches with shares; credits carry the data attribution |
| PDF | `format: pdf` or `export.pdf`: vector PDF through krilla (text stays selectable; rasters embedded) |

**Remote data without downloads.** `dem.fetch`, `embeddings.fetch`, `rs.search`, `rs.index` and `rs.fetch` read only the area of interest:
Copernicus DEM tiles and Sentinel-2 bands are cloud-optimised GeoTIFFs on AWS open data, so GDAL fetches byte ranges
(`/vsicurl/`), and STAC searches go through GDAL's own HTTP client (proxy settings such as `GDAL_HTTP_PROXY`
apply). For the 11 × 9 km test area, the DEM takes about 2.8 s; the cloud check plus two 10 m bands, about 1.8 s.

**Providers.** `grass` and `saga` steps run the installed GRASS (`grass --tmp-project <first input> --exec`) and
SAGA (`saga_cmd`) headless. GeoSpaX imports the inputs, runs the script or tool, exports the outputs back as GeoTIFF
or GeoPackage, and registers them like any other result. GRASS class labels and colours (`r.category`, `r.colors.out`) become the legend. Both
binaries are looked up on `PATH`, in the usual install folders or via `GEOSPAX_GRASS` / `GEOSPAX_SAGA`;
`GET /api/providers` reports what is available. Like code steps, they need `?approve=code` when saved through the
API. Whitebox, Orfeo ToolBox and SNAP providers are next.

## 6c. LiDAR point clouds (built)

`lidar.grid` (and the `lidar-to-terrain` recipe around it) turns point clouds into the products surveyors and
foresters make first, with no settings to choose.

| | What GeoSpaX does |
|---|---|
| Input | LAS 1.0–1.4 and LAZ (including COPC), any point format, one file or a folder of tiles (sub-folders searched), read with the pure-Rust `las` + `laz-rs` crates (MIT / Apache-2.0; LAZ chunks decompressed in parallel), so the Windows build needs nothing extra. Withheld points and the noise classes (7, 18) are left out |
| Coordinates | From the file: WKT (LAS 1.4) or GeoTIFF keys. Metric projected files stay in their CRS; files in longitude/latitude or in feet (US State Plane, Oregon Lambert…) are gridded in their UTM zone with heights converted to metres. Files without a coordinate system stop with a message asking for `epsg:` (a recipe input) |
| Cell size | About 2–3 points per cell (`1.6 / √density`, snapped to 5, 10, 20, 25, 50 cm, 1, 2, 2.5, 5 … m), coarsened until the area fits 6 million cells; or `resolution:` |
| Ground (DTM) | The data's own classes when at least 0.5 % of points are ground (class 2; water, class 9, counts too, as in USGS 3DEP DEMs), else **SMRF**, the simple morphological filter of Pingel, Clarke & McBride (2013) behind PDAL's `filters.smrf`: a minimum-elevation grid at 1 m, isolated low outliers removed, empty cells inpainted, progressive openings up to an 18 m radius (`window:`) with a 0.15 slope threshold, then every cell within 0.5 m + 1.25 × slope of the provisional surface is ground. Gaps (under buildings, water) are filled by GDAL's inverse-distance interpolation; a 3 × 3 mean takes out centimetre noise |
| Surface (DSM) | Highest return per cell; isolated spikes 5 m above all neighbours (birds, multipath) replaced by the neighbourhood; pinholes filled |
| Canopy (CHM) | Height of the vegetation classes (3–5) above the DTM when the data has them, so unclassified structures (stadium stands, towers, bridges) stay out; otherwise DSM − DTM. Buildings are removed in both cases |
| Buildings | The building class (6) when present, else planar roof regions: 3 × 3 plane fits with under 12 cm error, at least 2.5 m above the ground, joined into regions of at least 20 m² and 3 m across, grown 1 m over eaves and ridges. Outlined (GDAL polygonize, simplified) with `height_m` (90th percentile of the roof), `area_m2` and `ground_m` |
| Tree tops | Local maxima of the smoothed CHM at least 3 m high (`min_tree:`) that are the highest point within the expected crown radius, `0.5 × (2.51503 + 0.00901 h²)` m (Popescu & Wynne 2004), 1–8 m; points with `height_m` and an estimated `crown_m` |
| Outputs | `dtm`, `dsm`, `chm` GeoTIFFs (kinds `dem`, `dsm`, `chm`: hypsometric tint, and a yellow-to-dark-green canopy ramp that leaves bare cells clear over the relief), `trees` and `buildings` layers, statistics (points, density, area, classes, canopy cover, CHM median and 95th percentile, counts), a methods paragraph and plain-language reasons |
| Devices | A drive, card or folder with `.las`/`.laz` files is a `lidar` device (point clouds counted from their headers, footprints shown); a recipe with `device: { has: [point-clouds] }` starts on it; a plain import writes a `point_clouds` footprint layer (a tile index) |

Accuracy against a synthetic scene with known truth (`scripts/data-sample-lidar.py`: rolling ground with a hill,
three buildings, 40 trees, birds and below-ground noise; `scripts/test-lidar.py`):

| | Classified | Unclassified (SMRF) |
|---|---|---|
| Terrain RMSE (all 285,844 cells) | 0.9 cm | 2.2 cm |
| Under the buildings (interpolated) | 4.0 cm | 4.2 cm |
| Trees found (within 1.5 m) / false | 40 of 40 / 0 | 40 of 40 / 0 |
| Tree height error (mean) | 0.11 m | 0.11 m |
| Buildings, footprint area, roof height | 3 of 3, within 1 %, within 0.1 m | 3 of 3, within 3 %, within 0.1 m |

On the real Autzen Stadium survey (PDAL sample data, 10.7 million points, LAS 1.4 point format 7, Oregon Lambert
feet) the whole recipe takes 12 s: 1 m cells, ground and water from the vendor classes, 55 buildings, 4,393 trees up
to 49 m (RESULTS §18).

Limits: SMRF keeps buildings wider than about twice the window (warehouses: raise `window:`), and on steep forested
slopes vendor ground classes are better; trees whose crowns merge into one dome count as one; full-waveform data,
E57 and PLY are not read (convert with PDAL or CloudCompare).

## 6d. 3D scenes (built)

`scene.3d` makes the 3D view a GIS analyst would otherwise build by hand in ArcGIS Pro's scene view or QGIS's 3D map
view. It runs inside `lidar-to-terrain` and `terrain-report`, and any recipe can add it after a DEM.

| | What GeoSpaX does |
|---|---|
| Terrain | The DEM as a mesh of at most 320 vertices along the longer side (`grid:`), averaged down from finer DEMs. Geographic, rotated or foot-based DEMs are warped to UTM first. Earth-coloured walls run down to a base along every edge where the data stops, so irregular surveys get a proper block diagram |
| Drape | The DEM in its own map style (hypsometric tint unless you restyled it); the run's imagery when there is some, or any rasters you name (`drape:`); vector layers painted on in their map colours (`overlay:`: contours with bolder index lines, boundaries, sample points); then relief shading from the north-west, stronger for gentle relief. Power-of-two JPEG, 256–2048 px a side |
| Exaggeration | `auto`: relief about 10 % of the scene width, in half steps, at most 1.5× for surveys finer than 5 m (where buildings and trees carry the scene) and 3× for regional DEMs; or `exaggeration:`. Only the terrain is raised: buildings, trees and point heights above the ground stay true |
| Buildings | `buildings:` (auto: a buildings layer from the run) extruded as flat-roofed blocks (LOD1) standing on the drawn terrain. Heights from `height_m`/`height`/`hgt`, or `building:levels × 3 m + 1 m`, or `height:`; roofs triangulated with their courtyards (earcut); largest first, at most 25,000 |
| Trees | `trees:` (auto: a tree-top layer from the run): a trunk and a rounded crown from 32 % of the height to the top, crown width from `crown_m` or Popescu & Wynne; tallest first, at most 40,000 |
| Point cloud | `cloud: auto` uses the sample `lidar.grid` kept during its single read (every n-th point; no second read), or name a LAS/LAZ file or folder. About 250,000 points (`points:`), coloured by the file's own RGB, else by class, else by elevation |
| Light | Baked into the colours with the hillshade's sun; every material is unlit (`KHR_materials_unlit`), so the scene looks the same in Blender, Windows 3D Viewer, ArcGIS Pro, CesiumJS and the built-in viewer |
| Outputs | `scene.glb` (glTF 2.0, metres from an origin, X east, Y up, Z south; CRS, origin and exaggeration in `asset.extras.geospax`), `scene.html` (the viewer with the model inside, no network), `scene.png` (rendered on the CPU: perspective from the south-south-west at 35° by default, `azimuth:`/`elevation:`, z-buffer, 2 × 2 supersampling, sky, haze, north arrow) and a 3D section in the report |
| Viewer | Plain WebGL 2 (falls back to WebGL 1), no libraries: drag to turn, right-drag or Shift-drag to move, scroll or pinch to zoom, compass to face north, double-click to reset, a switch per layer, spin. It opens framed to the window. In the app, the run card's 🧊 3D button shows it in a sandboxed frame |

```yaml
- id: scene
  use: scene.3d
  with: { dem: dem, overlay: ["${contours.layer}", "${area.layer}"], title: Terrain in 3D }
```

Measured on the Autzen survey (10.7 million points): the scene adds 0.9 s to the recipe and holds 55 buildings,
4,391 trees and 250,000 true-colour points in 327,000 triangles. The Khronos glTF-Validator reports no errors or
warnings for any test scene ([RESULTS §19](../bench/RESULTS.md#19-3d-scenes)).

Limits: buildings are flat-roofed blocks (no roof shapes yet); trees are stylised, not species models; the model is
one level of detail, so very large areas are coarser (raise `grid:` up to 2048); I3S and 3D Tiles are not written yet
(glTF is the payload of both, so this is the next step).

## 6e. Spatial statistics (built)

Two native steps cover what analysts most often open R, Python or ArcGIS's Spatial Statistics toolbox for. Every
setting is chosen from the data and explained in the report. They run on every OS without R or Python, and
`scripts/test-stats.py` checks them against R's spdep and gstat ([RESULTS §20](../bench/RESULTS.md#20-spatial-statistics)).

**`stats.hotspots`: where do things cluster more than chance would explain?**

| | What GeoSpaX does |
|---|---|
| Input | Incident points (counted), or features with a value (`field:`; polygons use their centroids). `auto` picks the most incident-like point layer (names such as incidents, crimes, cases, crashes, calls) |
| Aggregation | Incidents are collapsed to unique locations and counted in hexagons (`aggregation: fishnet` for squares). The cell is twice the larger of the average and median nearest-neighbour distance, or 1/100 of the extent when the incidents are dense. Locational outliers (nearest-neighbour distance above the mean + 3 SD) are ignored for the sizing; empty cells are left out. Needs 60 incidents and 30 filled cells |
| Scale | Incremental spatial autocorrelation: global Moran's I at 10 distances from the largest nearest-neighbour distance. The first significant peak (z > 1.96) sets the distance band. Without a peak: the average distance to k neighbours (5 % of the features, 3–30), at most one standard distance. If some feature would get 500 or more neighbours: the average distance to 30 |
| Statistic | Getis-Ord Gi* on a fixed distance band, binary weights, each feature its own neighbour |
| Significance | False discovery rate (Benjamini–Hochberg) at 90, 95 and 99 % confidence, as `gi_bin` −3…3 |
| Outputs | A layer with `count` (or the value), `gi_z`, `gi_p`, `gi_bin`, `gi_class` and `neighbors`, mapped with the conventional red–blue classes; report cards (hot, cold, band, Moran's I), the distance-search chart and global Moran's I with its z-score |

**`interpolate.auto`: the best surface the samples support**

| | What GeoSpaX does |
|---|---|
| Variogram | Empirical semivariogram with gstat's defaults (cutoff a third of the diagonal, 15 lags). Spherical, exponential and Gaussian models are fitted by weighted least squares (weights = pairs / distance², gstat's default): a global search over the range with nugget and partial sill solved exactly (both ≥ 0), then golden-section refinement. The lowest weighted error wins (`model:` to force one) |
| Kriging | Ordinary kriging in the local UTM zone: with all samples up to 200 (one factorisation), else the 32 nearest (`neighbours:`). Coincident samples are averaged |
| Choice | Leave-one-out cross-validation of kriging (Dubrule's closed form when all samples are used) and of IDW at powers 1, 1.5, 2 and 3. The lower RMSE wins (`method: auto`; or `kriging`, `idw`). With fewer than 10 samples or a flat variogram (pure nugget), IDW |
| Outputs | `surface` GeoTIFF (prediction, Viridis) and, for kriging, `surface_se` (standard error: pale near samples, dark where the map is a guess), both clipped to the samples' hull; RMSE, MAE, mean error and RMSSE; the variogram chart in the report. A variogram that never levels off within the data is reported as a trend, not as a range |

```yaml
- id: hot
  use: stats.hotspots
  with: { layer: incidents.geojson, name: hotspots }   # cell, band and FDR chosen from the data
- id: surface
  use: interpolate.auto
  with: { layer: "${samples.layer}", field: ph }       # ${surface.raster}, ${surface.se}, ${surface.method}
```

Checked on every release: every planted incident cluster is a 99 % hot spot and no hot spot lies elsewhere; Gi*,
Moran's I and the whole distance search equal spdep; the empirical variogram equals gstat's, the fitted models fit at
least as well as `fit.variogram`, and predictions, standard errors and cross-validation equal `krige` and `krige.cv`
for both global and 32-neighbour kriging. Against the known surfaces, kriging's error is about half of IDW's.

Limits: fixed distance bands only (no k-nearest or contiguity weights yet); no study-area boundary for zero-count
cells yet; ordinary kriging only (no trend model, anisotropy or block kriging). For those, the `r` step with spdep or
gstat is one line away, and the `r-kriging` recipe shows how.

## 7. Execution engine (built)

- **Runs** each get their own thread, not a pool worker, so a step can wait for heavy work (overview builds) without starving the shared pools. They are also listed in the job registry (`kind: recipe`) with progress and cancel.
- **Run folder** `<state>/runs/<run-id>/`:
  - `run.json` (steps, status, timings, why lines, outputs, artifacts, trigger, inputs);
  - `recipe.yaml` (an exact copy);
  - the maps, the report and data exports;
  - `steps/<id>/` for code steps (generated script, stdout, stderr, inputs, outputs).

  History survives restarts.
- **Result layers:**
  - Each one is written to `<state>/outputs/<recipe>/<name>.gpkg` with an atomic replace, registered as `<recipe>.<name>` and restored at startup.
  - A re-run replaces the layer in place, so the map updates itself.
  - Device imports keep the device hub's ids (`<device>.photos`, …).
- **Provenance:** the report lists the recipe id and its FNV-1a fingerprint, run id, trigger, inputs, GeoSpaX and GDAL versions and the generation time. The run folder holds the exact recipe copy.
- **Failures:**
  - A failing step stops the run; later steps are marked "not run" with the reason.
  - Panics inside a step are caught and reported as step errors.
  - Partial artifacts are kept.
- **Planned:**
  - a content-addressed step cache, hashing input fingerprints, step version and resolved parameters (the overview pyramid already works this way);
  - parallel branches;
  - providers (GRASS, SAGA, Whitebox, OTB, SNAP, ODM, PDAL) chosen by a benchmark table.

## 8. Safety and trust

| Rule | State |
|---|---|
| Recipes with `python`/`r`/`grass`/`saga` steps saved through the API are refused unless the request carries `?approve=code` (gallery and your own recipe folder are trusted; the CLI runs what you ask it to) | ✅ |
| Webhook tokens are at least 16 characters; webhooks only start recipes whose Auto switch is on | ✅ |
| Code steps: separate process, scrubbed environment, own folder, timeout, cancel | ✅ (a process boundary, not a sandbox) |
| Artifact downloads are confined to the run folder (`..` and `/` rejected) | ✅ |
| Result layers are written to new files; inputs are never modified | ✅ |
| Permission manifests (filesystem scopes, network hosts, devices) and signed gallery recipes, same model as WASM plugins (TECH_STACK §4.11) | planned |

## 9. Interfaces (built)

| Surface | Use |
|---|---|
| UI (Lazy) | **Next for <layer>** in the task bar, the buttons on a layer card and in the Inspector, and **Ideas for your data** in Activity run the recipes that fit a layer *on that layer* (`{"inputs": {"layer": …}}`); **Activity** lists every run with **Open report**. **Toolbox → Ready-made analyses** shows any recipe's inputs as a form. A run's styles dress the layers it made; a layer already styled by hand or by AutoMap keeps its look |
| Finish my map | Task bar / **Home → Finish my map**: the visible layers and their exact styles, the area on screen, saved as the recipe `finished-map` (`io.open` → `style.apply` with `save: false` → `export.map` with `format: [png, pdf(, svg)]`, `extent`, `size`, `title`, `subtitle` → `export.report`) and run; the report opens when it is done. `export.map` draws Natural Earth land and borders underneath when no context layers are loaded |
| UI (Pro) | **Automate** panel (bottom dock): the gallery and your recipes, **Run**, an **Auto** switch per recipe, live step progress, the finished map and report in a viewer, "Save this map as a recipe". When a run finishes, its layers, rasters and styles appear on the map and the view moves to them. **Rasters** panel: overlays with opacity and legends |
| CLI | `geospax run <recipe.yaml\|id> [--input k=v]… [--data DIR]… [--state-dir DIR] [--json]` · `geospax check <recipe>` · `geospax watch [--only ids] [--watch DIR]…` · `geospax recipes` · `geospax steps`. The same commands work with `geospax-server`. Exit codes: 0 done, 1 failed or invalid, 2 usage |
| API | `GET /api/recipes` · `GET /api/recipes/{id}` (YAML + plan) · `POST /api/recipes` (YAML body; `?approve=code` for code steps) · `POST /api/recipes/validate` · `DELETE /api/recipes/{id}` · `POST /api/recipes/{id}/run` (`{"inputs": {…}}`) · `PUT /api/recipes/{id}/auto` · `GET /api/runs` · `GET /api/runs/{id}` · `POST /api/runs/{id}/cancel` · `GET /api/runs/{id}/files/{name}` · `GET /api/steps` · `GET /api/layers/{id}/autostyle` (AutoMap's style + reason for one layer) · `GET /api/rasters` · `GET /api/rasters/{id}` · `GET /api/rasters/{id}/overlay.png?max=` · `PUT /api/rasters/{id}/style` · `POST /api/hooks/{token}` · `GET /api/providers` |
| Server flags | `--recipes DIR` (extra recipe folder), `--auto id,id\|all`, `--no-triggers`, `--inbox DIR` (drop folder); live sensors: `--mqtt mqtt://host:1883/topic/#`; desktop: `GEOSPAX_RECIPES`, `GEOSPAX_AUTO`, `GEOSPAX_MQTT` |
| MCP | planned: recipes and steps as tools for external agents, with the same approval rules |

## 10. Status

| Piece | State |
|---|---|
| Job registry (progress, cancel, duplicate protection) | ✅ `jobs.rs` |
| Classification engine (natural breaks, quantile, equal interval, unique values) | ✅ `classify.rs` |
| Control-plane lane (fast job polling under load) | ✅ `Engine::dispatch` |
| Recipe parser + validator (YAML/JSON, expressions, every problem at once) | ✅ `automation/recipe.rs` |
| Runner (dependency order, `needs`, `when`, run folder, history, queueing) | ✅ `automation/mod.rs` |
| Triggers: device, folder, schedule (every + cron), after, stac, webhook, sensor (threshold, geofence, cooldown); Auto switches | ✅ `automation/triggers.rs`, device hub hooks, `Automation::on_sensor`, `router.rs` |
| Sensor hub v1: logger CSV/JSON and FIT readings, live readings over HTTP and MQTT (OwnTracks too), WHO guideline checks | ✅ `sensors.rs`, `devices.rs`, `sensor.*` steps |
| Rasters: catalogue, statistics, auto-style, Web Mercator overlays, GDAL warp/translate/DEM/HTTP in-process | ✅ `raster.rs`, `web/src/rasters.ts` |
| Terrain, raster and remote-sensing steps (Copernicus DEM, Sentinel-2 via STAC) | ✅ `automation/raster_steps.rs` |
| LiDAR: LAS/LAZ → DTM (classes or SMRF), DSM, CHM, buildings, tree tops; `lidar` devices | ✅ `lidar.rs`, `automation/lidar_steps.rs` |
| 3D scenes: terrain block diagrams, extruded buildings, trees, point clouds → glTF, offline viewer, rendered picture | ✅ `scene3d.rs`, `automation/scene_steps.rs`, `assets/scene-viewer.html` |
| Providers: GRASS, SAGA | ✅ `automation/providers.rs` |
| AutoMap style engine (§4) | ✅ `automation/automap.rs` |
| Automatic layout + PNG/SVG/PDF export (rasters, ramps, class legends) | ✅ `automation/cartography.rs` (resvg, krilla) |
| HTML report with methods, decisions, provenance | ✅ `automation/report.rs` |
| Analysis steps: SQL, buffer (UTM), hexbin, IDW + cross-validation | ✅ `automation/steps.rs` |
| Spatial statistics: Gi* hot spots (incremental spatial autocorrelation, FDR, Moran's I), automatic kriging (variogram fitting, ordinary kriging, cross-validation against IDW), report charts | ✅ `geostats.rs`, `automation/stats_steps.rs`, `automation/charts.rs` |
| R / Python sidecar steps | ✅ `automation/sidecar.rs` (environment management planned) |
| CLI (`run`, `check`, `watch`, `recipes`, `steps`) in both binaries | ✅ `automation/cli.rs` |
| API + Automate panel + "Save as recipe" | ✅ `router.rs`, `web/src/automate.ts` |
| Gallery: 15 recipes | ✅ `recipes/` |
| Tests | ✅ 89 engine unit tests (incl. sensor parsers, MQTT wire format, WHO classes, LiDAR filters, 3D scenes, Gi*, FDR, Moran's I, variogram fitting, kriging), `scripts/test-stats.py` (hot spots and kriging against known truth and R spdep/gstat), `scripts/test-automation.py` (235 checks: all recipes incl. live DEM/Sentinel-2/GRASS/SAGA, the sensor log, the hot spots and the kriged surface, the 3D scene files, all trigger types incl. stac, webhook, sensor threshold + cooldown, geofence, MQTT through Mosquitto, raster API, safety), `scripts/test-web-automation.mjs` (incl. raster overlays), `scripts/test-web-devices.mjs` (incl. live sensor values), `scripts/test-lidar.py` (terrain, tree and building accuracy against known truth, real LAS/LAZ, drop-folder trigger, the 3D scene of every run), `scripts/test-web-scene.mjs` (the 3D viewer in Chromium), `scripts/validate-gltf.mjs` (Khronos glTF-Validator) |
| Web-map export, `for_each`/`parallel`, content-addressed cache, zonal statistics, cloud-free composites | Phase 2 (next) |
| Providers (OTB, SNAP, ODM, Whitebox) | Phase 2 → 4 |
| Optional AI recipe writer, MCP server | Phase 2 → 6 |
