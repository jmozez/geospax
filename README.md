<p align="center"><img src="docs/assets/geospax-logo.png" alt="GeoSpaX logo" width="120" /></p>

# GeoSpaX

**GeoSpaX is the open-source GIS where maps make themselves.** It's for people who don't want to spend hours making maps: drop in data or plug in a phone, GPS, watch, drone card, camera, sensor logger or a drive of LiDAR point clouds, and GeoSpaX finishes the map. Its power lies in **automation**:
- every result is a re-runnable **recipe**;
- **triggers** run recipes when a device is plugged in, a folder changes, a schedule fires, a new satellite scene arrives, a live sensor crosses a threshold or a phone enters an area;
- an offline **autopilot** fills in every parameter and explains why;
- **R and Python** are first-class steps;
- **two modes, one engine**: **Lazy** (a task bar, layer cards that explain themselves, an Inspector and an Activity feed) and **Pro** (the full ribbon, an ArcGIS-Pro-style layer tree with group layers, every setting);
- **one Toolbox** for every tool: GeoSpaX's recipes and building blocks, the **GSX conservation and environment tools** from GeoSpaX 2.0, plus **1,062 GeoLibre tools** and QGIS, ArcGIS Pro and RustGIS plugin tools, searchable by the names those programs use.

It borrows proven methods from ArcGIS Pro, QGIS, GeoLibre, RustGIS, GRASS, SAGA, MapInfo, ERDAS, ENVI, SNAP and the R/Python data-science world. Built with Rust, Tauri and MapLibre: one native engine for desktop, web and CLI. Clean-room, Apache-2.0 OR MIT.

| Read this | For |
|---|---|
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | **Start here:** install, your first map in a minute, the recipes, troubleshooting |
| [CHANGELOG.md](CHANGELOG.md) | What's in each release (current: **1.8.2**) |
| [docs/VISION.md](docs/VISION.md) | Who it's for, why it's different from ArcGIS Pro / QGIS / GeoLibre / RustGIS, principles, metrics |
| [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md) | What we borrow from each GIS / remote-sensing / data-science tool, and how it becomes automatic |
| [docs/AUTOMATION.md](docs/AUTOMATION.md) | Recipes, triggers, autopilot, R/Python steps, the execution engine |
| [docs/DEVICES.md](docs/DEVICES.md) | Reading phones, GNSS receivers, drones, cameras and sensors |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Plugins from GeoSpaX, RustGIS, GeoLibre, QGIS and ArcGIS Pro |
| [docs/GSX.md](docs/GSX.md) | The GSX conservation, biodiversity and environment tools (from GeoSpaX 2.0 and 1.4.2) |
| [SECURITY.md](SECURITY.md) | Who can reach the web edition, access tokens, reporting a vulnerability |

**Coming in GeoSpaX 3.0** ([CHANGELOG § Unreleased](CHANGELOG.md#unreleased)): GeoSpaX 3 brings together GeoSpaX 1.4.2 ([map-kit](https://github.com/jm0535/map-kit)) and 2.0 ([GeoSpaX](https://github.com/jm0535/GeoSpaX)) in this design, starting with the **GSX tools**: suitability (WLC, distance decay), protection gaps, priority sites, minimum-cost representation, hotspot grids, fragmentation, connectivity, two-date change, DBSCAN, Clark–Evans and diversity, in the Toolbox ([GSX.md](docs/GSX.md)); the web edition is local-only by default with an access token beyond this computer ([SECURITY.md](SECURITY.md)); layers style themselves (AutoMap), dense layers get their overviews in the background and an offline world basemap ships with the app; **Lazy and Pro modes** change the ribbon (a task bar with *Next for <layer>* vs the full ribbon with a contextual Layer tab), the layer list (cards vs a tree with group layers), the right pane (Inspector vs Symbology) and the bottom pane (Activity vs Automate/History/Log); a **Toolbox** pane searches every tool, including **1,062 GeoLibre tools** run locally on WebAssembly ([USER_GUIDE §2b](docs/USER_GUIDE.md#2b-the-workbench-ribbon-panes-map), [PLUGINS.md](docs/PLUGINS.md)). **Version 1.8** adds **plugins**: one tool model that reads GeoSpaX, RustGIS, GeoLibre, QGIS and ArcGIS Pro plugin manifests, runs what it can (process, Python, R, WASM, recipes, `qgis_process`, arcpy) and says what is missing for the rest ([PLUGINS.md](docs/PLUGINS.md)); 1.8.1–1.8.2 collapse ribbon galleries into dropdowns, auto-hide the ribbon and uninstall plugins. **Version 1.7.0** turns the app into a desktop-GIS workbench: a ribbon, dockable panes and an attribute table ([CHANGELOG](CHANGELOG.md)). **Version 1.6.0** puts spatial statistics on autopilot, natively (no R or Python, on Windows too): hot spot analysis that chooses its own cell size, distance band and false-discovery-rate correction, and automatic kriging that fits the variogram, cross-validates against IDW and maps where the surface can be trusted. Both are checked against R's spdep and gstat on every release ([AUTOMATION §6e](docs/AUTOMATION.md#6e-spatial-statistics-built), [RESULTS §20](bench/RESULTS.md#20-spatial-statistics)). **Version 1.5.0** makes 3D scenes by itself: every LiDAR and terrain recipe also delivers the terrain as a block diagram with buildings, trees and the point cloud, as a glTF model, an offline interactive viewer and a 3D picture in the report ([AUTOMATION §6d](docs/AUTOMATION.md#6d-3d-scenes-built), [RESULTS §19](bench/RESULTS.md#19-3d-scenes)). **Version 1.4.0** reads LiDAR: drop LAS/LAZ point clouds into the Inbox (or plug in the drive) and `lidar-to-terrain` makes a bare-earth terrain model, canopy heights, building outlines and tree tops, with maps and a report, in seconds ([AUTOMATION §6c](docs/AUTOMATION.md#6c-lidar-point-clouds-built), [RESULTS §18](bench/RESULTS.md#18-lidar-point-clouds)). **Version 1.0.0** was the first packaged release: a Linux installer with both editions, a container image for the web edition and CI ([CHANGELOG](CHANGELOG.md)). It packages Phase 0, Phase 1 slice 1, **automation engine v0**, **Phase 2 slice 2** (rasters, terrain, remote sensing, GRASS/SAGA providers, PDF, STAC and webhook triggers) and **device and sensor hub v1** (sensor-logger and FIT readings, live sensors over HTTP and MQTT, sensor triggers). Plug in an air-quality logger and its readings become a map classed by the WHO guideline in 0.12 s; a live reading above a threshold produces an alert map 0.26 s later ([RESULTS §13](bench/RESULTS.md#13-sensors-loggers-watches-live-feeds-and-sensor-triggers)). Give it an area and it fetches the Copernicus DEM or the newest cloud-free Sentinel-2 pass for just that area and finishes the map and report in 5–6 s ([RESULTS §12](bench/RESULTS.md#12-rasters-terrain-remote-sensing-and-providers)). Plug in a phone and, without a click, a styled, laid-out map and a one-page report are ready about 5 s later (the 5 s device poll; the run itself takes about 0.15 s) ([AUTOMATION.md](docs/AUTOMATION.md), [RESULTS §11](bench/RESULTS.md#11-automation-engine-v0)).

## Install

| Platform | Get it |
|---|---|
| **Linux desktop + web** (Debian 13) | `scripts/package-linux.sh` builds `releases/geospax_1.8.2_amd64.deb`; install it with `sudo apt install ./releases/geospax_1.8.2_amd64.deb`, then start **GeoSpaX** from the menu. Your files go in `~/GeoSpaX/Data`, and anything dropped into `~/GeoSpaX/Inbox`, or sent from a phone (**Devices → Send from phone**, scan the QR code), is mapped automatically. Built on another Debian/Ubuntu release, the script picks that system's GDAL. |
| **Web edition in a container** | `docker compose up -d`, then open the `http://localhost:8080/?token=…` link from `docker compose logs geospax` (with an MQTT broker for live sensors). Not yet built in our sandbox, which has no container engine; CI builds it on version tags |
| **Windows 10/11 desktop + web** | `scripts/package-windows.sh` (run on Linux) builds `releases/GeoSpaX_1.8.2_x64-setup.exe` (≈41 MB, GDAL bundled). Double-click it; no admin rights are needed. Start **GeoSpaX** or **GeoSpaX Web Server** from the Start menu. Your files go in `%USERPROFILE%\GeoSpaX`. A portable ZIP is built too. Tested under Wine ([RESULTS §15](bench/RESULTS.md#15-windows-edition)); the desktop window needs WebView2, so CI checks it on real Windows. Not code-signed yet, so SmartScreen asks once |
| **macOS** | Not packaged (it can't be cross-built from Linux). Use the container, or build from source ([Run it](#run-it)) |

More in the [user guide](docs/USER_GUIDE.md).

## Status

| Pillar | Built | Next |
|---|---|---|
| Packaging | ✅ 1.1: Linux `.deb` with both editions (dependencies computed from the binaries), lazy `~/GeoSpaX` folder with a drop-in **Inbox**, container image + compose; **Windows installer + portable ZIP** (cross-built, GDAL/PROJ bundled, Wine-tested), CI (test, package, Wine + native Windows checks, release, GHCR) | macOS, code signing, AppImage/Flatpak, auto-updates |
| Native engine, desktop + web from one code path | ✅ GDAL Arrow reader, MVT tiles, PMTiles overview pyramids, Arrow export, job registry, two-lane dispatch; **raster catalogue** with statistics and server-rendered Web Mercator overlays; GDAL warp/translate/DEM/HTTP in-process | MLT, raster tiles for very large rasters |
| AutoMap (lazy cartography) | ✅ v0: style rules that explain themselves (field choice, method from skewness, colour-blind-safe ramps by meaning, **WHO guideline classes for PM2.5/PM10**, labels, distinct colours, see-through areas); **automatic page layout** (title, legend with counts, scale bar, north arrow, graticule, collision-free labels, credits) → PNG + SVG + **vector PDF**; **raster maps** (hypsometric tint, relief shading multiplied on top, ramp and class legends); HTML report with an auto-written methods section | Web-map export, line/polygon labels, atlas (Phase 2) |
| Interface (Lazy / Pro) | ✅ next: a **start screen** (drop zone, devices, phone, finished maps), **drop files anywhere** (`POST /api/upload`), **Finish my map** (PNG + PDF + report of what is on screen, with a world underneath); one switch for the ribbon (task bar · full ribbon + contextual Layer tab), layer list (cards with a sentence, legend bar, status and next steps · tree with Map node, group layers, twisties, drag into groups), right pane (Inspector · Symbology) and bottom pane (Activity · Automate/History/Log); a **Toolbox** across recipes, building blocks and plugin tools; self-styling layers, automatic overviews, offline basemap; **light (default), dark and system themes**; **map styling** with a **live preview** (looks, 150–1200 dpi, legend inside or edited class by class and reordered, scale bars, north arrows, overview inset, placed where the data isn't), **multi-panel pages** (patchwork panels, ggplot2 facets) and **map series** with an index page and one bound PDF, and a keyboard-driven Pro tree; every control click-tested (`test-web-controls.mjs`) | Map series from a saved recipe with a trigger (e.g. monthly district atlas) |
| Recipes and triggers | ✅ YAML recipes, dependency-ordered runner, 36 steps, **device / folder / schedule / after / stac / webhook / sensor triggers**, Auto switches, `geospax run / check / watch`, API, Automate panel, "Save this map as a recipe", 15 gallery recipes | `for_each`, step cache, AI recipe writer (Phase 2) |
| Device and sensor hub | ✅ v1.4: **LiDAR drives and drop folders** (`lidar` devices: point clouds counted from their headers, footprints as a tile index). v1.3: **sensors anywhere**: MQTT over TLS (own CA, client certificates), **LoRaWAN uplinks** from The Things Stack and ChirpStack, **OGC SensorThings** services; **send from phone over Wi-Fi** (QR code, HTTPS, no app; photos, tracks, logs, geotagged camera photos, live location); photos without GPS placed on a track by time; XMP sidecars; removable/phone mounts and watched folders; EXIF GPS (JPEG/HEIC/TIFF), DJI XMP, GPX/KML, NMEA, DJI SRT; **sensor logs** (CSV/TSV/JSON with coordinates, units from headers) and **FIT** watches (heart rate, cadence, temperature …); one-click or automatic import; live GNSS from phone page, NMEA serial/TCP/file, gpsd; **live sensors over HTTP push and MQTT** (OwnTracks phones too); `sensor` triggers (threshold, geofence) ([DEVICES.md](docs/DEVICES.md)) | Windows/macOS MTP, BLE/RTK, GoPro (Phase 3) |
| Analysis + geostatistics | ✅ v1.6: **hot spots** (Getis-Ord Gi*: cell size, distance band from incremental spatial autocorrelation and FDR correction chosen from the data; global Moran's I) and **automatic kriging** (variogram fitted with three models, ordinary kriging, cross-validated against IDW; prediction + standard-error maps, variogram chart), native and equal to R spdep/gstat. SQL (SpatiaLite), UTM buffer + dissolve, hexbin (1M points in 0.5 s), IDW with cross-validated power, raster classification with areas, raster values at points + correlation | Local Moran clusters, space-time hot spots, GWR, overlay, zonal statistics (Phase 2–4) |
| 3D | ✅ v1.5: **3D scenes made automatically**: terrain block diagrams draped with map colours, relief shading, imagery or contours; extruded buildings, modelled trees and point clouds → **glTF 2.0** (`scene.glb`), a **self-contained offline WebGL viewer** (`scene.html`, 🧊 3D in the app) and a **CPU-rendered 3D picture** in the report; exaggeration, mesh, texture and camera chosen from the data (0.9 s for the 10.7 M-point Autzen survey; Khronos glTF-Validator: 0 errors) | Roof shapes (LOD2), I3S / 3D Tiles for big areas, 3D in the main map |
| Terrain + remote sensing | ✅ v1.4: **LiDAR point clouds** (LAS/LAZ, COPC) → bare-earth terrain from the vendor classes or the **SMRF** filter, surface, canopy height, **building outlines with roof heights, tree tops with heights** (2 cm terrain error, 40 of 40 trees on the test scene; 10.7 M real points in 12 s). Copernicus GLO-30 DEM for any area (COG windows over HTTP), hillshade/slope/aspect/TRI/TPI/roughness, contours; STAC search (Earth Search), NDVI/NDWI/NBR/NDMI/SAVI/EVI from the newest pass that is **clear over the area**, true-colour imagery | Cloud-free composites, land-cover classification, change detection, Landsat/Sentinel-1 (Phase 3–4) |
| R / Python | ✅ sidecar steps: sf/geopandas in, layers + numbers out, scrubbed env, timeout, cancel; tested with R gstat kriging and a Python point-pattern recipe | Managed environments (uv/pixi, rig/renv), webR/Pyodide |
| Providers (GRASS, SAGA, OTB, SNAP, ODM, Whitebox) | ✅ **GRASS** (temporary project, class labels and colours kept) and **SAGA** (`saga_cmd`) as recipe steps ([AUTOMATION §6b](docs/AUTOMATION.md#6b-rasters-remote-sensing-and-providers-built)) | Whitebox, OTB, SNAP, ODM (Phase 3–4) |


It grew out of a Phase 0 spike that covered the riskiest part of a Rust + Tauri ArcGIS-Pro-class GIS: moving lots of geodata from a **native Rust engine** into a **web-tech UI**, with one code path for the **desktop** and **web** editions.

- **Phase 0** built the data plane.
- **Phase 1, slice 1** adds:
  - GDAL's columnar **Arrow reader**;
  - **overview pyramids** (a background job that writes PMTiles, with density heatmaps at low zoom);
  - a **Symbology pane** (single symbol, unique values, graduated colours with natural breaks / quantile / equal interval);
  - legends, draw order and a persisted project.

```
                 ┌──────────── web/ (TypeScript, MapLibre GL JS 6, deck.gl 9.4) ────────────┐
                 │ Automate (recipes, Auto, runs) · Contents · Symbology · Devices · map    │
                 │  Backend interface:  HttpBackend  |  TauriBackend (scheme | invoke)      │
                 └───────────────┬───────────────────────────────────┬──────────────────────┘
                     HTTP (gzip MVT, raw Arrow)        gis:// custom scheme · invoke → raw bytes
          ┌──────── crates/server (Axum, 180 lines) ──┐   ┌── apps/desktop (Tauri 2.12, 114 lines) ─┐
          └──────────────────┬────────────────────────┘   └──────────────────┬──────────────────────┘
                             └────────────── Engine::handle(ApiRequest) ─────┘
          ┌──────────────────────── crates/engine (Rust, ~15.7k lines) ─────────────────────────┐
          │ reader:   GDAL Arrow stream (RFC 86) | per-feature, ignored-fields column pruning   │
          │ tiles:    WKB → project → Douglas-Peucker → clip → quantise → MVT (hand-rolled pbf) │
          │ overview: z0–12 pyramid job → PMTiles (+ density points), served transparently      │
          │ jobs:     background pool, progress, cancel · classify: Jenks/quantile/equal, unique│
          │ catalog · pooled GDAL handles · LRU · Arrow IPC export · project file · stats       │
          │ devices:  phones/cameras/drones/GPS → photos, tracks, waypoints · live GNSS          │
          │ sensors:  logs, FIT, HTTP, MQTT(S), LoRaWAN, SensorThings → readings · triggers      │
          │ rasters:  DEM/terrain/STAC indices · GRASS/SAGA providers                            │
          │ automation: recipes · runner · triggers · AutoMap · layout → PNG/SVG · report ·     │
          │           SQL/buffer/hexbin/IDW · R & Python sidecars · CLI (run/check/watch)        │
          └──────────────────────────────────────────────────────────────────────────────────────┘
                  GeoPackage · FlatGeobuf · Shapefile · FileGDB · … (GDAL ≥ 3.6; 3.12+ recommended)
```

## What it proves

| Question | Answer |
|---|---|
| Can one Rust engine serve both editions through thin adapters? | **Yes.** The Axum and Tauri adapters only translate requests into `Engine::handle()` calls. Verified: the web edition in Chromium, and the desktop edition in a real Tauri/WebKitGTK window with both transports. |
| Is the hand-rolled MVT encoder correct? | **Yes.** GDAL's independent MVT driver decodes every test tile with matching feature counts and extents. 16 unit tests. |
| Is on-the-fly tiling fast enough? | **At z13 and above, yes:** p95 ≤ 63 ms from every format with the Arrow reader, and ≤ 13 ms from FlatGeobuf. **Dense data at z0–12, no**, and that is now solved by overview pyramids (below). |
| Does GDAL's Arrow stream beat per-feature reads? | **For polygons, yes: mean tile time drops 19–44%, with byte-identical output** (108/108 tiles compared). Point tiles change by −21% to +7%, mostly noise. The 1M-point Arrow export drops from 579 to **131 ms**. On GDAL < 3.12 one GeoPackage code path needs a workaround (finding 11). |
| Do pre-built overviews fix low zooms? | **Yes.** A z0–12 pyramid of 1M polygons builds in **~29 s** on 2 cores (16.7 MB PMTiles), and serves tiles in **0.2 ms p50 / 2 ms p95**. Live renders take 100–470 ms p95. z0–10 now show a density heatmap instead of nothing. |
| Is engine-side classification interactive? | **Yes.** Natural breaks over 1M values: 140–380 ms column scan plus ~15 ms optimal 1-D k-means. Unique values: 200–370 ms. |
| Which source format renders fastest? | **FlatGeobuf**: about 2–4× faster than GeoPackage and 3–6× faster than Shapefile on identical data. |
| Can maps make themselves? | **Yes (v0).** A plugged-in phone triggers a recipe that imports, styles, lays out and exports a finished map plus report in **0.15 s** (5 s after plug-in, set by the 5 s device poll). Seven gallery recipes run in 0.1–0.7 s natively; R kriging takes 4.2 s. Every automatic choice is written down with its reason. |
| Can statistics choose their own settings? | **Yes (1.6).** Hot spots of 1,120 incidents with cell size, distance band and FDR correction chosen from the data in 0.04 s: all three planted clusters found, none invented. Automatic kriging picks the variogram and halves IDW's error against the true surface. Gi*, Moran's I, the variogram, kriging and cross-validation equal R's spdep and gstat to 10⁻⁶ or better ([RESULTS §20](bench/RESULTS.md#20-spatial-statistics)). |
| Can the lazy loop reach rasters and satellites? | **Yes.** `terrain-report` (Copernicus DEM → relief, slopes, contours, PDF) takes 6.1 s and `latest-ndvi` (newest clear Sentinel-2 pass → NDVI, classes, true colour) 5.5 s, each including the HTTP reads. GRASS `r.geomorphon` and SAGA's wetness index run as recipe steps in 1.4–1.8 s. A `stac` trigger fires on a new pass in about 6 s. |
| Can sensors drive maps? | **Yes.** A plugged-in air-quality logger (360 readings) becomes a PM2.5 map classed by the WHO guideline, with statistics and a report, in **0.12 s** (5 s after plug-in). A FIT run from a watch maps 400 heart-rate readings in 0.13 s. A live reading over HTTP starts an alert map **0.26 s** later; MQTT messages reach the map within 0.2 s; a phone entering a geofence starts its recipe immediately. |
| Arrow → deck.gl for "show me everything"? | **Works.** 1M points arrive in one 16.4 MB payload. The browser parses it in 3.9 ms (zero-copy), and deck.gl's first render takes 138 ms even with software GL. |

Full numbers: [`bench/RESULTS.md`](bench/RESULTS.md). Screenshots: [`bench/screenshots/`](bench/screenshots/).

## Findings that change the plan

1. **Keep two storage roles.** Use GeoPackage as the *editable workspace* and FlatGeobuf as the *read-optimized render cache*. GeoPackage spends about 30% of each tile in GDAL's per-query setup. FlatGeobuf's packed Hilbert R-tree spends about 0%.
2. **On-the-fly tiling needs an overview pyramid below about z13** for dense layers. *Done in Phase 1, see finding 12.* Live tiling now serves only z13+ (and, later, edits). The engine still auto-raises the live `minzoom` when an average tile would exceed 10k features.
3. **GDAL reading is the bottleneck, not our code.** Our whole pipeline (WKB parse → projection → simplification → clipping → encoding) costs about **1 µs per feature**. Per-feature GDAL calls were 50–80% of tile time, and 99% of the Arrow export. *Phase 1 switched to the Arrow stream (finding 10).* With FlatGeobuf, our own processing is now about half of tile time, so it is the next optimization target.
4. **Don't gzip Arrow.** Float64 coordinates barely compress: 13% smaller but 80% slower, as measured. The server now gzips MVT and JSON only.
5. **deck.gl 9.4's interleaved MapLibre integration (`MapboxOverlay({interleaved: true})`) breaks on MapLibre 6.** It divides by `map.transform.height`, and v6 removed `map.transform`. Overlaid mode also touches it when terrain is on. GeoSpaX runs a standalone `Deck` synced through MapLibre's public camera API instead (`web/src/main.ts`). Revisit when deck.gl ships v6 support.
6. **The MapLibre 6 worker works with Vite 8** via `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'` plus `worker.format: 'es'`.
7. **Desktop transports are close.** Custom scheme vs `invoke` + raw bytes gave 926 vs 793 ms mean settle under software GL, which is within noise. Measure on real GPUs before choosing. Keep both behind the `Backend` interface.
8. **Pool GDAL handles.** Opening a handle ranges from about 20 ms (GeoPackage) to about 0.9 s (Shapefile, which loads its `.qix` index). The engine opens each handle once per worker and reuses it.
9. **Rust and GDAL threading.** `gdal::Dataset` is `Send`, but `CoordTransform` isn't. The engine therefore uses per-worker pooled handles (dataset + transforms) on a bounded rayon pool, and async adapters never run GDAL on an executor thread.
10. **Read through GDAL's Arrow stream by default** (`--reader arrow`; `features` remains as a fallback). GDAL emits batches of 16k rows (`OGR_L_GetArrowStream`), we tell it which columns to skip (`OGR_L_SetIgnoredFields`), and arrow-rs reads them zero-copy over the C Data Interface. Mean polygon-tile time drops 19–44% at the same output (108/108 tiles byte-identical); point tiles barely change. The 1M-point Arrow export drops 4.4×.
11. **GDAL < 3.12 has a race in the GeoPackage Arrow path that crashes multi-batch bbox reads.** We found it while building overviews: random segfaults inside GDAL's SQLite worker thread, or in our code reading corrupted batches. In 3.10's `GetNextArrowArrayAsynchronous`, the consumer waits for `nCountRows == 0 && !bIsFinished`, so it can take a batch the worker thread is still writing. GDAL 3.12.0 replaced this with an explicit `bThreadReady` handshake (we diffed 3.10.3 / 3.11.3 / 3.12.0). The engine checks the runtime GDAL version. On < 3.12 it routes *bbox* GPKG reads through GDAL's generic Arrow implementation (a thread-local `OGR_GPKG_STREAM_BASE_IMPL`). That path is still 20–30% faster than per-feature reads. Whole-table reads (export, column scans) keep the fast multi-threaded path. Ship desktop builds with GDAL ≥ 3.12 (`bundled-gdal` or conda-forge); 16-client stress test: 255/255 requests, 0 errors. Related: a spatial filter that covers the whole layer is now dropped, because GDAL then swaps the R-tree for an `ST_EnvIntersects()` SQL filter that crashed in the same worker.
12. **Overview pyramids work best with density points, not feature dropping.** The job renders z0–N with the normal tile pipeline. Features smaller than 2 px are not dropped but *counted* on a 4 px grid, giving a `<layer>:density` point layer with a `count` attribute. Low-zoom tiles stay small (z0–5: 0.1–9 KB) and the map still shows where the data is. The engine serves z ≤ N from the PMTiles file and renders z > N live, so URLs don't change. Each archive is keyed by a fingerprint of the source (path, size, mtime, feature count), and a stale archive is ignored. Builds run on a separate job pool with progress and cancel. Open issue: the densest z12 tile is 840 KB, because many buildings sit just over 2 px; a stricter threshold or MLT would shrink it.
13. **Calibrate density heatmaps from data, not constants.** My hand-tuned weights were 10× off: saturated at first, invisible after one fix. The build job now records, per zoom, the 90th percentile of each tile's densest cell (z9: 166 features; z12: 4) in a sidecar JSON. The frontend sets weight = `sqrt(count / p90[z])` per integer zoom (`step`, because tiles are per zoom), with intensity set from the kernel's cell overlap.
14. **Encode only the attributes the symbology needs.** Tiles carry a small default attribute set; the UI requests more with `?fields=height,kind` (part of the cache key). Classification runs in the engine on one column (geometry ignored), so the browser never downloads 1M rows to compute breaks. The DP is optimal 1-D k-means (Ckmeans.1d.dp) with divide-and-conquer, which is what "Jenks natural breaks" approximates. It is unit-tested against brute force.
15. **Persist the project as one JSON document now; move to CIM later.** `GET/PUT /api/project` stores layer styles, draw order and the view (atomic write to `<data>/.geospax/project.json`). The schema is deliberately small; mapping it onto CIM (`CIMUniqueValueRenderer`, `CIMClassBreaksRenderer`) is a Phase 2 item.
16. **Give control-plane requests their own lane.** `scripts/bench-api-stress.py` showed that job polling, project saves and stats waited about 500 ms (p50) behind tile renders and column scans, because every request went through the 2-thread tile pool. That would stall a progress bar while the user pans. `Engine::dispatch` now routes data-plane requests (tiles, Arrow, classify, unique) to the tile pool and everything else to a small control pool: **p50 0.5 ms, p95 ≤ 2 ms** under the same 16-client load. Both adapters (Axum and the Tauri `gis://` protocol) use the same function.
17. **WebKitGTK (the Linux desktop webview) silently drops whole tiles with the default WebGL drawing buffer.** Under software GL (Xvfb + llvmpipe), 25 of 29 desktop sessions lost at least one (source, tile) pair at random positions. This happened on both transports, with or without the heatmap, and with compositing disabled. A probe (`?gldebug=1`) showed MapLibre holding every tile loaded, renderable and with geometry, and `gl.getError()` was clean: the draws are lost inside the webview. `preserveDrawingBuffer: true` or MSAA fixes it (17 / 17 sessions complete). GeoSpaX turns `preserveDrawingBuffer` on for WebKitGTK only, because it costs a frame copy, more on tile-based GPUs. Override it with `?glpdb=0|1` or `?glaa=1`. Still to check: GPU-backed WebKitGTK, and a minimal MapLibre-only reproduction to report upstream. Tauri 3's CEF runtime is the escape hatch if WebKitGTK stays fragile.
18. **Real-world EXIF is often slightly broken, so parse it tolerantly.** Photos written by GDAL (and the HEIC made from them) were rejected wholesale by the strict EXIF parser ("Unexpected next IFD"), although the GPS fields were intact. With `continue_on_error`, every sample reads: 12/12 phone JPEGs, 15/15 drone JPEGs with DJI XMP gimbal data, a HEIC, and two genuine Nikon photos from `exif-samples`. Lazy users never learn why a photo "has no location", so the reader must not be the reason.
19. **Runtime layers need a registry, not a fixed list.** Device imports add layers while the app runs. The engine's layer list became an append-only `RwLock` registry with stable indexes (the tile cache keys on them). Re-imports replace layers in place and clear the cache; imports persist across restarts.
20. **Per-layer style rules are not enough; the map needs map-level rules.** The first automatic maps followed every per-layer rule and still went wrong:
    - an orange coverage polygon hid orange photo points;
    - red sample dots disappeared into a red ramp;
    - a white mesh covered an interpolated surface.

    AutoMap now also decides at map level:
    - single colours stay distinct within one map;
    - points over a coloured surface turn white with a dark ring;
    - one to three areas over other data are see-through;
    - dense polygon layers drop outlines;
    - the step that made a layer can hint how it should look (IDW: no outlines; hexbins: outlines).

    Each rule adds its reason to the run log.
21. **Never call out while holding a lock you might need again.** The first server run with device recipes on Auto froze. The device hook started a run while holding the active-runs lock, and run creation looked up runs under the same lock: a self-deadlock. CLI runs never hit it because they don't take that lock. Run ids are now unique by their folder alone, and lock order is documented in the code.
22. **Write attributes by the field's real index, not its position.** KML adds `Name` and `Description` fields of its own, and Shapefile truncates names to 10 characters. Writing by position therefore shifted values: a timestamp ended up in `length_m`, and GDAL warned. The writer now records each field's index after it is created.
23. **Validation must list every problem at once.** The test suite caught that a structural error (a dependency cycle) hid per-step errors (an unknown step name, a missing parameter). Lazy users fix everything in one pass, so the validator now collects all of them. Unknown step names suggest the nearest real one.
24. **Kriging beat cross-validated IDW by 28 % RMSE on the same samples** (0.106 vs 0.147). Picking the method automatically is worth it; that is the planned `interpolate.auto`. Almost all of the 4.2 s R step is interpreter start-up and package loading, so a warm R session is the obvious next optimisation. Debian 13 does not package `gstat`; install it from CRAN on top of Debian's `r-cran-sf`.
25. **Don't trust STAC raster metadata blindly.** Earth Search marks Sentinel-2 L2A items `earthsearch:boa_offset_applied: true` yet still lists `offset: -0.1` in `raster:bands`. Applying the offset again pushed red reflectance to about zero and NDVI to a mean of 0.90 with the 98th percentile at 1.00. With the flag honoured, the mean is 0.55 (0.13–0.85), which fits Mt Hagen's gardens, grassland and forest. The test suite now fails if NDVI sticks near 1.
26. **"Clear on average" is not "clear over my field".** Scene cloud cover is a tile-wide number, so `rs.index` reads the 20 m scene classification for just the area first (one small COG read). It skips dates that are under 70 % clear there before fetching any bands.
27. **Read windows, not scenes.** COG range reads make remote data cheap enough for automation. The 11 × 9 km area needs about 1.3 MB of a 3600 × 3600 Copernicus tile (2.7–3.8 s including reprojection), and a 13 × 13 km Sentinel-2 band window takes 2.1 s, versus 100+ MB per full band.
28. **One coordinate helper per meaning.** The composer's own `merc()` returns normalised tile space; GDAL wants metres. Using the wrong one rendered every raster for a 0.0002 m box at 0°, 0°: transparent maps with correct legends. Rasters are now warped with an explicitly named metre-based function.
29. **Reuse the GIS engines people trust instead of re-implementing them.** GRASS `r.geomorphon` (ten landforms) and SAGA's wetness index each took one step of glue. Inputs and outputs move as GeoTIFF, and GRASS's own category labels and colours become the legend. Wrapping them took less code than re-implementing either algorithm.
30. **When a standard exists, classes should carry its meaning.** On the air-quality walk, quantile breaks for PM2.5 came out at 5.5 / 8 / 9 / 10.1 / 15.7 / 61.1 µg/m³. That painted 80 % of a clean walk orange and red and hid the one roadside hotspot. Anchoring classes at the WHO 2021 guideline and interim targets (15 / 25 / 37.5 / 50 / 75) gives a green walk with one hotspot running yellow to red. Maps from different days now compare, and the legend says "guideline met" instead of a number nobody can act on.
31. **Sensor files need no format registry; the headers are enough.** Latitude, longitude and time columns are recognised by name, and units are taken from brackets (`PM2.5 (µg/m³)`). That read every sample without configuration: logger CSV, semicolon CSV with decimal commas, JSON lines with nested locations or GeoJSON geometries, and FIT. Rows logged before the GPS had a fix (empty or 0/0) are counted and skipped instead of being plotted off the coast of Africa.
32. **A device's kind must follow what it sends, not whether it sends numbers.** The first version turned an OwnTracks phone into a "sensor" because the phone reports its battery level; the MQTT test caught it. A minimal MQTT 3.1.1 subscriber on a plain thread is about 200 lines (CONNECT, SUBSCRIBE, PUBLISH, PINGREQ, QoS-1 acks, back-off), so the engine needs no async MQTT stack. It is tested end to end against Mosquitto 2.0.21.
33. **The first map export in a fresh process can take 3 s on a cold disk.** fontdb scans every system font before the first render. The same export takes 0.1 s once the OS file cache is warm. Desktop builds should bundle a small font set and load only that, both for speed and for maps that look the same on every machine.
34. **TLS fits the thread-per-source MQTT client without going async.** rustls' `StreamOwned` wraps the same `TcpStream`, read timeouts stay on the socket underneath, and rustls keeps partial records across a timeout, so the 1-second poll loop did not change. Errors are worth translating: "invalid peer certificate: UnknownIssuer" became "not signed by a CA this computer trusts; for a private broker add ?ca=", which is the fix. For SensorThings, the poller pushes a station only when its newest observation time moves, because the live store keeps every push as a reading and triggers would otherwise fire on every poll.

35. **With LiDAR, the data's own classes beat any filter, but only the right ones.** The Autzen survey's stadium stands are left unclassified, so "surface minus ground minus buildings" turned them into 30 m of canopy with tree tops on the seats, and a transmission tower became a 58 m tree. Building the canopy from the vegetation classes (3–5) fixed both. Water returns (class 9) have to count as bare earth or rivers become holes in the DTM. Headers are written before coordinates are rounded to the file's scale, so a grid sized exactly to them drops edge points. And contours traced on a 50 cm DTM turned centimetre noise into 485 tiny loops; on a 2 m average there are 12 clean lines.

36. **A 3D view needs its own framing and colour rules, not the 2D map's.** The first rendered scenes looked wrong in ways no unit test caught. The point cloud, drawn over the model, speckled the terrain and painted every roof in the building class's orange. Autzen's DTM ends in no-data around the irregular survey edge, so the grid-border walls vanished and the terrain floated. White sample dots, the right 2D rule for points over a coloured raster, lay on the 3D terrain like snow. Fitting the camera to the bounding box's corners left the model filling only 20 % of the window, because those corners are mostly empty air. The fixes: the picture shows points only when there is no model; walls follow the edge of the data; light dots are recoloured for 3D; the camera is fitted to actual vertices and re-centred. Baking the hillshade's sun into every colour and marking materials unlit kept the scene identical in Blender, the browser and the CPU renderer. The Khronos validator found nothing to fix, because 16-bit indices, 4-byte alignment and min/max bounds were designed in from the start.
37. **Matching R digit for digit is not the same as being understood.** GeoSpaX's Gi*, Moran's I, variograms and kriging equal R's spdep and gstat to 10⁻⁶ or better, yet three results would still have misled a lazy reader. The pH variogram's best fit (gstat's too) has a 38 km range on a 4 km study area. That is mathematically right, but the samples follow a trend and the variogram never levels off, so the report now says "trend" instead of quoting a range. On a random field, the fitted nugget was a quarter of the true one (gstat's fit did the same), so the standard errors were twice too small (RMSSE 2.0). The report now flags any RMSSE outside 0.67–1.5 and says how to read the uncertainty map. Hexagon centres put dozens of neighbour pairs exactly at the automatic distance band, where a rounding error would decide whether they count; a one-in-a-billion slack makes the answer deterministic. The cartography needed its own fixes. "Not significant" cells vanished into the land colour. The frame-filling layout that suits DEMs cut the edges off surfaces clipped to the samples' hull.

## Run it

### Prerequisites
On Debian 12+/Ubuntu 22.04+, `scripts/setup-linux.sh [--test-tools] [--r] [--rea] [--windows] [--swap 4G]` installs everything below (system packages, Rust, Node 24, and optionally the headless-test tools, R with sf + gstat for the R recipe steps, REA, and the Windows cross-build tools).
If a copy of the repo lost the executable bits, run `chmod +x scripts/*.sh scripts/*.py` (or call them through `bash`/`python3`).

- **Rust** via rustup (tested with 1.99) and **Node.js 22+**.
- **GDAL ≥ 3.6 with headers** (Arrow stream API). Use **3.12+** for the fast GeoPackage bbox path (finding 11).
  - Debian/Ubuntu: `sudo apt install libgdal-dev gdal-bin pkg-config clang`
  - macOS: `brew install gdal pkg-config`
  - Windows: install GDAL (OSGeo4W or conda), then set `GDAL_HOME` (containing `include/` and `lib/`) and `GDAL_VERSION` (e.g. `3.10.3`), and put GDAL's `bin` on `PATH`. Alternatively, build GDAL from source with `--features geospax-engine/bundled-gdal` (needs CMake and a C++ toolchain; the first build is slow).
  - Windows binaries from Linux: `scripts/setup-linux.sh --windows && scripts/package-windows.sh` (MinGW-w64 + conda-forge GDAL; see [RESULTS §15](bench/RESULTS.md#15-windows-edition)).
- **Tauri 2 prerequisites:**
  - Windows: WebView2, already present on 10/11.
  - macOS: Xcode Command Line Tools.
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev libxdo-dev libssl-dev`.

### 1. Data (≈800 MB: Natural Earth + 1M synthetic buildings and points)
```bash
scripts/data-fetch-samples.sh data          # bash; on Windows use Git Bash or WSL
```
Natural Earth is public domain. The "buildings" are **synthetic**: random rectangles clustered around five Papua New Guinea highland towns.

### 2. Web edition
```bash
(cd web && npm install && npm run build)
cargo run --release -p geospax-server -- --data data   # → http://localhost:8080 (this computer only; see SECURITY.md)
```
For frontend development, run `npm --prefix web run dev` (port 5173, which proxies `/api` and `/tiles` to :8080). The developer stats panel (FPS, tile timings, cache) is hidden from 1.0 on: add `?hud=1` to the URL to show it (benchmark runs show it automatically).

Server flags:
- `--reader arrow|features`
- `--state-dir DIR`: overviews and project; default `<data>/.geospax`, or `GEOSPAX_STATE` for desktop
- `--threads N`, `--no-cache`, `--no-gzip`, `--bench-log FILE`
- Automation: `--recipes DIR` (extra recipe folder), `--auto id,id|all` (triggers on), `--no-triggers`, `--inbox DIR` (drop folder: the matching device recipe maps whatever lands there, no Auto switch needed); subcommands `run`, `check`, `watch`, `recipes`, `steps`
- Installed (`.deb`, container): without `--web` the server serves `/usr/share/geospax/web`

Environment:
- `GEOSPAX_GPKG_FILTERED=async|base|features` overrides the GDAL-version-based choice.
- `GEOSPAX_VALIDATE_ARROW=1` runs `validate_full()` on every Arrow batch from GDAL (debugging).

### Try the device hub (plug in, get a map)
```bash
python3 scripts/data-sample-devices.py /tmp/geospax-devices      # sample phone, drone card, GPS and inbox (synthetic)
./target/release/geospax-server --data data \
  --watch /tmp/geospax-devices/TEST-PHONE --watch /tmp/geospax-devices/DJI-SD \
  --watch /tmp/geospax-devices/GARMIN --watch /tmp/geospax-devices/inbox \
  --gps "file:///tmp/geospax-devices/live-replay.nmea?rate=1"    # add --auto-import to map new devices automatically
```
- Real devices need no flags. Phones and cards mounted under `/media/$USER`, `/run/media/$USER`, gvfs MTP/PTP mounts, `/Volumes` (macOS), or removable drives and camera/GPS cards on Windows drive letters are found automatically.
- Live GNSS: `--gps /dev/ttyUSB0`, `serial:///dev/ttyACM0?baud=9600`, `tcp://host:port` or `gpsd://localhost:2947`.
- Desktop edition: the same options through `GEOSPAX_WATCH`, `GEOSPAX_AUTO_IMPORT=1` and `GEOSPAX_GPS`.
- In the UI, **Devices** lists what was found. **Import & map** adds photos, tracks, waypoints and sensor readings as layers, styles them with AutoMap (photo wedges, track casing, readings coloured by the main measurement) and zooms to them; they persist across restarts.
- **Send from phone:** add `--phone` (or press **Devices → Send from phone → Turn on**) and scan the QR code with a phone on the same Wi-Fi: it sends photos, tracks and logs, takes geotagged photos and shares live location, and the map comes back to the phone ([DEVICES.md §3a](docs/DEVICES.md#3a-send-from-phone-phone-link)).
- **Sensor networks:** `--mqtt "mqtts://APP@ttn:API-KEY@eu1.cloud.thethings.network/v3/%2B/devices/%2B/up"` maps every LoRaWAN sensor of a The Things Stack application; ChirpStack works the same way. `--sta https://host/v1.1` turns the stations of an OGC SensorThings service (public air-quality and water networks) into live sensors ([DEVICES.md §4](docs/DEVICES.md#4-sensors-in-detail)).

### Try automation (maps make themselves)
```bash
python3 scripts/data-sample-devices.py /tmp/geospax-devices     # sample phone, drone card, GPS, inbox
python3 scripts/data-sample-field.py data                        # 60 soil samples for the geostatistics recipes
python3 scripts/data-sample-incidents.py data                    # 1,120 incidents in Lae with 3 planted clusters (hot spots)

# One command, one finished map + report (PNG, SVG, report.html in <state>/runs/<run-id>/)
./target/release/geospax-server run photos-to-map --data data --input source=/tmp/geospax-devices/TEST-PHONE
./target/release/geospax-server run points-to-hexbins --data data          # 1M points -> hexagons in ~0.7 s
./target/release/geospax-server run interpolate-samples --data data        # IDW, power chosen by cross-validation
./target/release/geospax-server check recipes/drone-flight-report.yaml     # validate + show the plan
./target/release/geospax-server recipes | steps                            # what is installed / available

# Plug in and forget: device recipes on Auto (a phone -> photos-to-map, a drone card -> drone-flight-report, …)
./target/release/geospax-server --data data --watch /tmp/geospax-devices/DJI-SD --watch /tmp/geospax-devices/GARMIN \
  --auto photos-to-map,track-to-map,drone-flight-report
```
- **UI:** the **Automate** pane (bottom dock).
  - **Run** a recipe and watch its steps.
  - Open the finished **Map** and **Report**.
  - Switch on **Auto** to let triggers run it.
  - **Save this map as a recipe** to turn the current map into a re-runnable recipe.
- **Desktop:** the desktop binary takes the same commands (`geospax run …`, `geospax watch`). Environment variables: `GEOSPAX_AUTO=id,id|all`, `GEOSPAX_RECIPES=dir`.
- **R and Python steps** need `Rscript` (with `sf` + `gstat` for `r-kriging`) or `python3` on PATH, or `GEOSPAX_RSCRIPT` / `GEOSPAX_PYTHON`. On Debian/Ubuntu:

  ```bash
  apt install r-base-core r-base-dev r-cran-sf r-cran-sp r-cran-zoo r-cran-fnn r-cran-spacetime r-cran-sftime
  Rscript -e 'install.packages("gstat")'      # or simply: scripts/setup-linux.sh --r
  ```
- **Your own recipes:** put them in `<state>/recipes/` or a `--recipes DIR` folder (format: [AUTOMATION §2](docs/AUTOMATION.md#2-recipe-format-v1-as-implemented)).

### Try sensors (loggers, watches, live feeds)
```bash
python3 scripts/data-sample-devices.py /tmp/geospax-devices     # includes AQ-LOGGER/ (air-quality CSV) and WATCH/ (FIT run)
./target/release/geospax-server run sensor-log-to-map --data data --input source=/tmp/geospax-devices/AQ-LOGGER
./target/release/geospax-server run track-to-map --data data --input source=/tmp/geospax-devices/WATCH   # + heart rate

# Live sensors + an alert recipe: an MQTT broker (apt install mosquitto), the server subscribed, a simulated feed
mosquitto -p 1883 &
./target/release/geospax-server --data data --web web/dist --mqtt "mqtt://127.0.0.1:1883/sensors/#" --auto air-quality-alert &
python3 scripts/demo-sensor-feed.py --mqtt 127.0.0.1:1883        # or --url http://127.0.0.1:8080 to push over HTTP
curl -X POST localhost:8080/api/devices/live -d '{"id":"aq-01","lat":-5.86,"lon":144.23,"values":{"pm2_5":48}}'

# Sensor networks: a broker over TLS with your own CA, LoRaWAN from The Things Stack, an OGC SensorThings service
./target/release/geospax-server --data data --web web/dist --auto air-quality-alert \
  --mqtt "mqtts://broker.example.org/sensors/%23?ca=/etc/geospax/ca.pem" \
  --mqtt "mqtts://my-app@ttn:NNSXS.KEY@eu1.cloud.thethings.network/v3/%2B/devices/%2B/up" \
  --sta "https://sensorthings.example.org/FROST-Server/v1.1?every=300"
```
- **Plug in a logger.** Any folder or card whose CSV/TSV/JSON files have latitude/longitude columns is a sensor device. Turn on `sensor-log-to-map` Auto and plugging it in gives the map. Phone sensor-app exports work the same way.
- **Phones without an app.** OwnTracks publishing to your broker shows up as a live phone.
- **Sensor networks.** LoRaWAN uplinks (The Things Stack, ChirpStack) and OGC SensorThings stations are live sensors too, so `air-quality-alert` fires when any of them reports PM2.5 above 35.
- **Alerts.** `air-quality-alert` fires when any live sensor reports PM2.5 above 35 µg/m³, at most every 30 minutes per sensor. Copy it to watch another field or level. `sensor: { inside: <polygon layer> }` fires when a phone or sensor enters an area ([DEVICES §4](docs/DEVICES.md#4-sensors-in-detail)).

### Try terrain, satellite and GRASS/SAGA recipes (needs internet)
```bash
./target/release/geospax-server run terrain-report --data data          # Copernicus DEM -> relief + contours (PNG/SVG/PDF), slope classes
./target/release/geospax-server run latest-ndvi --data data             # newest clear Sentinel-2 pass -> NDVI, classes, true colour
./target/release/geospax-server run landforms-grass --data data         # GRASS r.geomorphon (apt install grass-core)
./target/release/geospax-server run wetness-saga --data data            # SAGA wetness index (apt install saga)
./target/release/geospax-server run terrain-report --data data --input area=my_parcels   # any layer as the area
```
- The area is any layer (the default is the most sample-like one). Only that window of the DEM or imagery is read. Rasters appear in the **Rasters** panel and the maps.
- `latest-ndvi` carries a `stac` trigger: switch on **Auto** and it re-runs when a newer clear pass appears over the area.
- Add `- webhook: { token: <16+ chars> }` to any recipe to start it with `POST /api/hooks/<token>`. The JSON body becomes its inputs.

### Try LiDAR (point clouds → terrain, canopy, trees, buildings)
```bash
python3 scripts/data-sample-lidar.py /tmp/scene.las                      # synthetic survey near Lae with known truth (add --classified)
./target/release/geospax-server run lidar-to-terrain --input source=/tmp/scene.las
./target/release/geospax-server run lidar-to-terrain --input source=/path/to/tiles --input resolution=0.5
./target/release/geospax-server run lidar-to-terrain --input source=file.laz --input epsg=32755   # file without a coordinate system
```
- Ground comes from the file's classes when it has them, else the SMRF filter finds it. Outputs: `dtm`, `dsm` and `chm` GeoTIFFs, `trees` and `buildings` layers, a terrain map, a canopy map and a report.
- With the web edition started with `--inbox DIR` (or the desktop's `~/GeoSpaX/Inbox`), dropping a folder of LAS/LAZ files there runs it by itself; a drive with point clouds shows up as a `lidar` device.

### Try 3D scenes (terrain, buildings, trees, point clouds)
```bash
./target/release/geospax-server run lidar-to-terrain --input source=/tmp/scene.las   # → scene.glb, scene.html, scene.png in the run folder
./target/release/geospax-server run terrain-report --data data                      # terrain block diagram with contours (needs internet)
xdg-open "$(ls -d data/.geospax/runs/*terrain-report | tail -1)/scene.html"           # the offline viewer
```
- `scene.glb` is glTF 2.0 (Blender, Windows 3D Viewer, ArcGIS Pro, CesiumJS); `scene.html` is a self-contained WebGL viewer with the model inside; the report shows the rendered 3D picture. In the app, the run card's **🧊 3D** button opens it.
- Any recipe can add `- { id: scene, use: scene.3d, with: { dem: dem } }` after a DEM ([AUTOMATION §6d](docs/AUTOMATION.md#6d-3d-scenes-built)).

### Try the Phase 1 features
1. Open **⚙** (or the layer name) on `synthetic.buildings`. Choose **Graduated colors** → field `height` → **Natural breaks** (or Quantile / Equal interval) → 3–10 classes → a colour ramp. Or choose **Unique values** → `kind`. Class colours are editable; the legend appears under the layer in Contents.
2. In the same pane, click **Build overviews (z0–12)** and watch the progress bar (about 30 s). Then zoom out to z9: a density heatmap. Polygons take over from z13.
3. Reorder layers with ▲▼, and change opacity or visible zoom range. Everything persists across reloads (`?fresh` ignores the saved project).

### 3. Desktop edition
```bash
(cd apps/desktop && npm install)
GEOSPAX_DATA="$PWD/data" npm --prefix apps/desktop run dev                       # dev: Vite + Tauri
cargo build --release -p geospax --features geospax/custom-protocol && ./target/release/geospax data
(cd apps/desktop && npx tauri build)                                             # installers (MSI/NSIS, DMG, deb/rpm/AppImage)
```
On Linux with NVIDIA, if the window is blank, set `WEBKIT_DISABLE_DMABUF_RENDERER=1` (see Tauri's Linux graphics notes).
On Linux the app enables WebGL `preserveDrawingBuffer` automatically, to work around WebKitGTK dropping tiles (finding 17).

### 4. Measure on your machines (the Phase 0 exit criterion)
```bash
# Engine latency, headless, per format and zoom:
cargo run --release -p geospax-engine --bin geospax-bench -- --data data \
  --layer synthetic.buildings --layer synthetic_buildings.fgb --zooms 11,12,13,14 --arrow synthetic.points \
  --reader arrow            # or: --reader features
# Overview pyramid build time, size and serving latency (writes to --state-dir):
cargo run --release -p geospax-engine --bin geospax-bench -- --data data --overview synthetic.buildings --state-dir /tmp/ov
```
In the app, click **Run benchmark** (a 9-stop camera tour recording FPS and settle time), then **Download JSON**. Do this on:

| Machine | Web edition | Desktop · scheme | Desktop · invoke |
|---|---|---|---|
| Windows (WebView2) | ☐ | ☐ | ☐ |
| macOS (WKWebView) | ☐ | ☐ | ☐ |
| Linux (WebKitGTK) | ☐ | ☐ | ☐ |

On Windows, the quickest way to fill the first row is the Windows installer (`scripts/package-windows.sh`). Install it, start GeoSpaX and click **Run benchmark**.

### Scripts
Names follow `setup-*`, `data-*`, `demo-*`, `test-*`, `bench-*` (`test-web-*` for browser tests). **`scripts/test-all.sh DATA [OUT]` runs everything with one command** and prints a pass/fail summary. Headless runs (CI, or a server without a GPU) exercise the same paths, but their FPS numbers are meaningless.

| Script | Was | Does |
|---|---|---|
| `package-linux.sh [--no-build] [OUT]` | new | Builds the `.deb` (desktop + web edition, menu entry, icons, docs) with `dpkg-deb`; dependencies come from the binaries' linked libraries |
| `package-windows.sh [--no-build]` | new | Cross-builds the Windows edition on Linux (MinGW-w64): `releases/GeoSpaX_<v>_x64-setup.exe` (Tauri NSIS bundler) and a portable ZIP in `target/windows/`, with the GDAL/PROJ DLLs the binaries import, GDAL/PROJ data, fonts, web UI and licenses. Needs `setup-linux.sh --windows` |
| `test-package-windows.sh SETUP [OUT]` | new | Installs the Windows installer under Wine and runs 20 checks: silent install, Start menu, every DLL import resolves, two recipes, LiDAR (LAS survey, LAZ) and its 3D scene, the Windows server serving UI and reprojected tiles, a camera card on E:, the phone link over HTTPS, MQTT over TLS with a LoRaWAN uplink, silent uninstall |
| `test-package-linux.sh [DEB] [OUT]` | new | Install test for the `.deb`: apt resolves dependencies, menu entry validates, the installed CLI makes LiDAR maps and the 3D scene, the installed server serves the UI, and a fresh-HOME desktop start creates `~/GeoSpaX`, maps a GPX dropped into Inbox and does not redo it after a restart; with the phone link on, a photo sent over HTTPS lands in `~/GeoSpaX/Inbox` and is mapped (15 checks) |
| `test-docs-links.py [FILES]` | new | Every relative link and `#anchor` in the Markdown docs (GitHub anchor rules) |
| `setup-linux.sh [--test-tools] [--r] [--providers] [--rea] [--windows] [--swap 4G]` | – | Installs system packages, Rust, Node 24, and optionally test tools, R + sf + gstat (`--r`), GRASS + SAGA (`--providers`), REA, and the Windows cross-build kit (`--windows`: MinGW-w64, NSIS, Wine, GDAL for Windows from conda-forge with a license check) |
| `data-fetch-samples.sh DIR [N]` | `prepare-data.sh` | Natural Earth + N synthetic buildings/points in GPKG, FlatGeobuf, Shapefile |
| `data-gen-synthetic.py` | `gen_synthetic.py` | The synthetic generator used by the script above |
| `data-sample-devices.py [DIR]` | new | Sample phone, drone card, Garmin GPS, NMEA inbox, air-quality logger (CSV), sports watch (FIT) and live-replay file |
| `demo-sensor-networks.py [--mqtt HOST:PORT] [--sta-port N]` | new | A mock OGC SensorThings service with stations in Port Moresby plus TTN and ChirpStack uplinks published to a local broker, to try the sensor networks without hardware |
| `demo-sensor-feed.py [--url URL \| --mqtt HOST:PORT]` | new | Two simulated walking air-quality sensors (HTTP push or MQTT) with a smoky-roadside spike every few minutes |
| `data-sample-field.py DIR [--count N]` | new | 60 synthetic soil samples (pH, moisture, land use) for the geostatistics recipes |
| `data-sample-lidar.py OUT.las [--classified]` | new | A synthetic LiDAR survey near Lae (LAS 1.2, EPSG:32755): ground with a hill, three buildings, 40 trees, birds and below-ground noise; a `.truth.json` beside it for the tests |
| `test-all.sh DATA [OUT]` | new | The whole suite (12 parts), with sample devices (incl. the sensor logger and watch) and isolated state dirs |
| `test-sensor-networks.py [--bin B] [--data DIR] [--port N]` | new | MQTT over TLS against Mosquitto (private CA, client certificates, wrong CA, missing client certificate), LoRaWAN uplinks (TTN, ChirpStack v4/v3, TTN webhook), a mock OGC SensorThings service (paging, no duplicates), `air-quality-alert` from both (24 checks) |
| `test-lidar.py [--bin B] [--cache DIR] [--offline \| --quick] [--pw PLAYWRIGHT]` | new | LiDAR against known truth (terrain RMSE, trees found and their heights, buildings, noise, contours, maps, report) for classified and unclassified scenes; real files (LAZ without a CRS, Oregon feet → UTM, 10.7 M points); the drop-folder trigger; the 3D scene of every run (GLB, validator, picture, viewer, report) |
| `test-plugins.py [BASE]` | new | Plugins: shipped plugins load, a python tool round-trips JSON, a recipe tool runs to artifacts, RustGIS/QGIS/ArcGIS manifests import with honest `needs`, packages install, CLI list/check |
| `test-web-start.mjs BASE FILE [OUT]` | new | The lazy path on an empty server: start screen → choose a file → layer card → Finish my map → PNG, PDF and report → listed on the start screen |
| `test-web-series.mjs BASE` | new | Pro tree keyboard navigation; a 2 × 1 map series makes an index page, two pages and one 3-page PDF; side by side, facets and panels each make one page; the Journal look makes a 300 dpi PNG with inset and edited legend; the live preview follows changes; a renamed class and a reordered legend reach the map; Lazy shows the layouts and looks; a too-large page layer is refused with a reason |
| `test-gsx.mjs BASE` | new | Every GSX tool through the engine (`POST /api/plugins/gsx/tools/…/run`) on the sample layers: answers and adds its layers |
| `test-web-controls.mjs [BASE] [OUT]` | new | Every control in both modes: every ribbon command on every tab, the contextual Layer tab, the layer tree (groups, group switch, twisties, filter, basemap), every dock tab, the Toolbox, the task bar, Inspector chips, card buttons, and one analysis from a card to its report; fails on any page error, console error or 5xx |
| `test-web-workbench.mjs [BASE] [OUT]` | new | The 1.7 workbench: ribbon tabs and buttons, dock tabs, attribute table (rows/fields/chart), command palette, splitter drag and reset, pane collapse, layout persistence across a reload; 29 checks, screenshots |
| `test-web-scene.mjs OUT NAME=scene.html…` | new | The 3D viewer in Playwright Chromium with the network blocked: ready, framing, turn, zoom, pan, compass, reset, layer switches; screenshots |
| `validate-gltf.mjs FILE.glb…` | new | The Khronos glTF-Validator (npm `gltf-validator`, installed by `setup-linux.sh --test-tools`); exits 1 on any error |
| `test-automation.py [--data DIR]` | new | Every gallery recipe from the CLI (files checked; DEM/Sentinel-2/GRASS/SAGA ones skipped offline or when not installed), FIT watch, live device/folder/schedule/after/webhook/stac triggers, live sensors over HTTP and MQTT (Mosquitto), sensor threshold + cooldown, geofence, raster API, API, safety, the 3D scene files (218 checks) |
| `test-web-automation.mjs URL OUT` | new | Automate panel: Run → layers + styles on the map → map and report viewer → Auto switch → Save as recipe → run it → `terrain-report` puts shaded relief on the map and fills the Rasters panel → its 🧊 3D button opens the scene (sandboxed WebGL) |
| `test-tiles-gdal.py URL` | `validate-tiles.py` | Decodes tiles with GDAL's MVT driver; checks feature counts and extents |
| `test-web-viewer.mjs URL OUT` | `smoke.mjs` | Phase 0 viewer paths in Playwright Chromium (tiles, Arrow → deck.gl, camera tour) |
| `test-web-symbology.mjs URL OUT` | `smoke-phase1.mjs` | Symbology pane, overview job, reordering, project reload |
| `test-phone-link.mjs [BIN] [SAMPLES] [OUT]` | new | Phone link end to end with its own server: Turn on → QR → a mobile browser pairs over HTTPS, shares live location, sends a geotagged and an unlocated photo (placed on the live track by time) and a camera photo (phone position) → the map comes back to the phone; wrong code refused, http:// redirected, Turn off closes the port, the pairing code survives a restart (10 checks) |
| `test-web-devices.mjs URL OUT` | `test-devices.mjs` | Devices pane → Import & map → phone page (mocked GPS) → live device on the map → sensor logger listed → live sensor values → readings mapped |
| `test-desktop.sh DATA OUT QUERY [SECONDS]` | `desktop-smoke.sh` | Desktop edition under Xvfb. With `gldebug=1` it screenshots once the map is idle; `COVERAGE_MAX=5` fails on dropped tiles |
| `test-tile-coverage.py PNG… [--max-empty 5]` | new | Dropped-tile detector (regression test for finding 17) |
| `bench-api-stress.py URL [--clients 16 --requests 256]` | `stress.py` | Mixed concurrent API load with density-weighted tiles; exits non-zero on any error |

## Layout
```
docs/            USER_GUIDE.md · VISION.md · FEATURE_MATRIX.md · AUTOMATION.md · DEVICES.md
CHANGELOG.md · LICENSE-APACHE · LICENSE-MIT
Dockerfile · docker-compose.yml    web edition image (+ MQTT broker); .github/workflows/ci.yml: CI and releases
releases/        packages built by scripts/package-linux.sh (.deb) and scripts/package-windows.sh (setup.exe)
packaging/windows/  Tauri NSIS overlay, installer hooks, geospax-web.cmd, README.txt for the install folder
recipes/         gallery recipes (YAML), embedded in the binaries: photos-to-map · track-to-map ·
                 drone-flight-report · points-to-hexbins · points-to-hotspots · interpolate-samples · python-spatial-stats · r-kriging ·
                 terrain-report · lidar-to-terrain · latest-ndvi · landforms-grass · wetness-saga · sensor-log-to-map ·
                 air-quality-alert
crates/engine/   reader.rs (Arrow | features) · catalog.rs · wkb.rs · tile.rs · mvt.rs (+ density grid)
                 overview.rs · pmtiles_io.rs (sync PMTiles v3 reader) · jobs.rs · classify.rs
                 devices.rs (device hub: discovery, EXIF/XMP + sidecars, GPX/NMEA/SRT, photos placed by time,
                             import, live store, sensor hook) · phone.rs (phone link: HTTPS, QR, uploads, batches)
                 sensors.rs (sensor CSV/JSON/FIT readers, live HTTP/MQTT messages, LoRaWAN uplinks (TTN, ChirpStack),
                             MQTT 3.1.1 client with TLS (rustls, Mozilla roots, own CA, client certificates), WHO levels)
                 sta.rs (OGC SensorThings polling: newest observation per datastream, nextLink paging)
                 raster.rs (catalogue, stats, auto-style, Web Mercator overlays, GDAL warp/translate/DEM/HTTP)
                 lidar.rs (LAS/LAZ headers and streaming, grids, SMRF ground, DSM, canopy, buildings, tree tops)
                 geostats.rs (neighbour index, Moran's I, Gi*, FDR, distance search, variograms, kriging, CV)
                 automation/ recipe.rs (parse, validate, ${…}) · mod.rs (registry, runner, runs) · steps.rs
                             automap.rs · cartography.rs (layout → SVG, resvg PNG, krilla PDF) · report.rs · features.rs
                             raster_steps.rs (DEM, terrain, contours, classify, sample, STAC + indices)
                             lidar_steps.rs (lidar.grid: rasters, tree and building layers, report story)
                             providers.rs (GRASS, SAGA) · sidecar.rs (R/Python)
                             triggers.rs (folder, schedule, stac) · cli.rs (run/check/watch)
                 router.rs · arrow_export.rs · bin/geospax-bench.rs
crates/server/   Axum adapter, binary `geospax-server` (static files + /api + /tiles; gzip except Arrow)
apps/desktop/    Tauri 2 adapter (gis:// scheme, `tile` command, GEOSPAX_* env hooks); binary `geospax`
web/             MapLibre 6 + deck.gl frontend shared by both editions
                 main.ts · automate.ts (Automate panel) · rasters.ts (Rasters panel) · symbology.ts · panel.ts
                 devices.ts · phone.ts (Send from phone card) · backend.ts · public/phone.html (phone page)
scripts/         setup-* · data-* · demo-* · test-* · bench-*  (see Scripts)
bench/           RESULTS.md · engine-*.json · reader-*.json · overviews.json · classify.json · stress.json
                 desktop-tile-drops.json · ui-*-headless.json · screenshots/
```

## API (identical over HTTP and `gis://`)
| Route | Returns |
|---|---|
| `GET /api/health` | `{"ok": true, "version": "1.0.0"}`: liveness (Docker health check) and the version shown in the header |
| `GET /api/recipes` · `GET /api/recipes/{id}` · `GET /api/steps` | Recipes (triggers, inputs, steps, Auto state, last run) · one recipe with its YAML and plan · the step catalogue |
| `POST /api/recipes[?approve=code]` · `POST /api/recipes/validate` · `DELETE /api/recipes/{id}` | Save a recipe (YAML body; code steps need approval) · validate (every problem + plan) · delete a user recipe |
| `POST /api/recipes/{id}/run` · `PUT /api/recipes/{id}/auto` | Start a run (`{"inputs": {…}}`; 202, 409 if it is running) · switch its triggers on/off |
| `GET /api/runs` · `GET /api/runs/{id}` · `POST /api/runs/{id}/cancel` · `GET /api/runs/{id}/files/{name}` | Run history · steps, status, why lines, outputs, styles, extent · cancel · artifacts (map.png, map.svg, report.html, exports) |
| `GET /api/rasters` · `GET /api/rasters/{id}` · `GET /api/rasters/{id}/overlay.png?max=` · `PUT /api/rasters/{id}/style` | Rasters (kind, bounds, stats, style + reason, legend, overlay URL + corners) · one raster · Web Mercator PNG for the map · change the style |
| `POST /api/hooks/{token}` · `GET /api/providers` | Start the recipe with that webhook token (JSON body → inputs; 404 unknown, 409 switched off) · GRASS / SAGA / Whitebox availability and versions |
| `GET /api/devices` · `POST /api/devices/rescan` | Detected devices (kind, geotagged photos, tracks, waypoints, sensor readings + fields, bounds, import state), live devices with latest values and source, MQTT subscriptions, SensorThings services, watched roots |
| `POST /api/devices/{id}/import` | Import a device as layers (job; 202). Re-import replaces the layers in place |
| `GET /api/devices/live` · `POST /api/devices/live` | Live positions + recent tracks (GeoJSON, with latest sensor values) · push a fix or a sensor reading (`{"id","lat","lon","values":{…}}`) |
| `GET /api/devices/readings?minutes=60&device=aq-*` | Live sensor readings as GeoJSON points |
| `GET /api/layers` | Layer metadata: geometry, count, bounds, CRS, fields, effective/live zoom range, overview state |
| `GET /tiles/{layer}/{z}/{x}/{y}.mvt[?fields=a,b]` | MVT from the pyramid (z ≤ its max) or rendered live. Headers: `X-Tile-Source`, plus `Server-Timing` (setup / read / proc / enc / teardown) |
| `GET /api/layers/{layer}/classify?field=&method=jenks\|quantile\|equal\|guideline&classes=5` | Breaks (class upper bounds), per-class counts, min/max/mean/σ/median, timings; `guideline` = WHO classes with colours and names for PM2.5/PM10 |
| `GET /api/layers/{layer}/unique?field=&limit=50` | Most frequent values with counts, distinct count, "others" |
| `GET /api/layers/{layer}/autostyle` | AutoMap's style for the layer with its reason (what recipes use); the UI applies it after **Import & map** |
| `POST /api/layers/{layer}/overviews[?maxzoom=N]` · `DELETE …/overviews` | Start an overview job (202 + job; 409 if one is already running) · remove the pyramid |
| `GET /api/jobs` · `GET /api/jobs/{id}` · `POST /api/jobs/{id}/cancel` | Background jobs: status, done/total, message, result |
| `GET /api/project` · `PUT /api/project` | The project document (styles with AutoMap's reason, draw order, group layers, view, basemap) |
| `POST /api/upload?name=FILE` | Body = the file. Saved in `Uploads/` of the data folder (unique name), zips unpacked safely, vector layers and GeoTIFF rasters added to the map: `{"layers", "rasters", "point_clouds", "skipped", "saved"}` (201); unsupported types → 400 with the accepted list |
| `GET /api/plugins` · `POST /api/plugins/{id}/tools/{tool}/run` | Plugins (source, kind, runnable, tools with forms) · run a tool (`{"params": {…}}`); the reply lists the layers and rasters its `outputs` added (`"added"`) |
| `GET /api/layers/{layer}/arrow[?bbox=w,s,e,n&limit=n]` | Arrow IPC stream (`geoarrow.point`) |
| `GET /api/stats` · `POST /api/cache/clear` · `POST/GET /api/bench` | Engine stats (reader, GDAL, live vs pyramid tiles) · clear the LRU tile cache · benchmark reports |

## Not in scope (yet)
- **MLT encoding.** Martin can transcode MVT to MLT. It would shrink the dense z12 pyramid tiles.
- **Bottom-up pyramid builds.** The builder re-reads the source at every zoom; z6–12 take 3–4.5 s each. Aggregating density counts from the zoom below would cut build time for point-like data.
- **Symbol editing beyond colour, CIM import/export.** (Automatic point labels exist in exported maps; interactive labels don't yet.)
- **Raster tiles** (rasters are served as one overlay image each; tiles matter for very large rasters).
- **Editing.**
- **CEF on Linux.** Waiting for Tauri 3 to stabilize.
- **Web-map export, `for_each`, the step cache, OGC SensorThings, cloud-free composites, land-cover classification, more providers (Whitebox, OTB, SNAP, ODM), the optional AI recipe writer.** Specified in [docs/AUTOMATION.md](docs/AUTOMATION.md); Phase 2 onwards.

License: Apache-2.0 OR MIT.
