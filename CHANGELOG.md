# Changelog

All notable changes to GeoSpaX. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — the lazy path, stage 1
- **Layers style themselves.** A layer seen for the first time gets AutoMap's style instead of a grey
  single symbol (e.g. PM2.5 readings in WHO guideline classes, a `kind` field as unique colours). The
  Symbology pane shows AutoMap's reason; editing the symbology takes over, and **✨ Style automatically**
  re-applies it. Opt out with `?auto=0`.
- **Overviews build themselves.** Layers too dense to draw zoomed out get their overview pyramid in the
  background, one job at a time; the Contents badge reads "preparing zoomed-out view" instead of asking
  you to click. Opt out with `?autooverviews=0`.
- **Offline basemap.** Natural Earth 1:50m land, lakes and country borders (public domain, 1.8 MB) ship
  with the web UI, so the map never opens on an empty void, even without internet. **View → Basemap**:
  World (offline), OpenStreetMap (online) or none; the choice is saved in the project.
- **The map opens on your data** when there is no saved view, instead of a fixed place.

### Added — Lazy and Pro ribbons
- **One Lazy | Pro switch in the title bar** drives the ribbon and the layer list together.
- **Lazy: a task bar instead of a ribbon.** One row: a "What do you want to do?" box (the command
  palette), four tasks in plain words (Add data, Make it look good, Find patterns, Finish the map) and
  **Next for <layer>**: the analyses that fit the selected layer, run on it with one click. Every button is
  an ordinary command, so nothing is lazy-only.
- **Pro: a contextual Layer tab** (as ArcGIS Pro shows for a selected layer) with zoom, attribute table,
  symbology, AutoMap and the same next steps. Clicking a layer card selects it.

### Added — Lazy and Pro layer lists
- **Contents has two modes**, switched at the top of the pane and remembered per browser (Lazy by default;
  `?mode=lazy|pro`). **Lazy: layer cards** with a friendly name, a one-sentence summary written from the
  layer's own classes ("88% of 1,500 readings are above 15"), a legend bar sized by class counts, status in
  words, a big show/hide button and buttons for the recipes that fit the layer, run on that layer
  (`POST /api/recipes/{id}/run` with `{"inputs": {"layer": …}}`). Cards are grouped by origin (devices, your
  data, recipe results, reference) with the basemap as a card at the bottom. **Pro: layer tree** with file
  names, drag-to-reorder, inline opacity, CRS / zoom range / classification on one line, legend counts and a
  filter box. Benchmarks and UI tests (`?fresh`, `?bench`) open in Pro.

### Fixed
- Switching a layer to graduated or unique colours no longer picks an identifier field (`id`, `fid`,
  `objectid`, `*_id`); it prefers measurements such as PM2.5, height, population or elevation.
- Benchmarks and UI tests (`?bench`, `?fresh`) keep the old manual behaviour so their steps stay deterministic.


### Security
- **The web edition is no longer open to the network by default.** `geospax-server` used to listen on
  every interface with no access control, so anyone who could reach port 8080 could save and run
  recipes (including their R and Python code) and install plugins. Now:
  - the default listen address is `127.0.0.1` (this computer only);
  - on any other address the API requires an access token (`--token`, `GEOSPAX_TOKEN`, or one
    generated at start and printed as a login link); the link sets an `HttpOnly`, `SameSite=Strict`
    cookie so the web UI works unchanged;
  - on localhost without a token, requests must be addressed to `localhost` (blocks DNS rebinding) and
    cross-site browser requests are refused (blocks other web sites posting to the API);
  - `GET /api/health` and webhook URLs (`/api/hooks/{token}`) stay open;
  - `docker-compose.yml` publishes GeoSpaX and the MQTT broker on `127.0.0.1` only.
  See [SECURITY.md](SECURITY.md).

### Changed
- README and user guide brought up to 1.8.2; links to research notes outside this repository removed.

## [1.8.2] — 2026-10-16

### Added
- **Auto-hide the ribbon** (pin button in the tab strip, or **Ctrl+F1**, or *Auto-hide the ribbon* in
  the palette). The whole ribbon body collapses to its tab strip and the space goes to the map —
  **542px → 623px** in a 1600×950 window. Click a tab to use it; it puts itself away after you run
  something, click the map, press `Escape` or click the same tab again. The choice is remembered.
- **Uninstall a plugin**: a two-step **Uninstall** button on each plugin card, `DELETE
  /api/plugins/{id}` and `geospax-server plugins uninstall ID`. Only plugins installed into the
  state directory can be removed — one that lives in a folder you pointed at with `--plugins` is
  refused with a message telling you why, so a plugin can never delete your working copy.

### Fixed
- A plugin tool that declares no parameters crashed instead of opening its dialog (the engine
  skipped empty `params` arrays when serialising a tool).

## [1.8.1] — 2026-10-16

### Fixed
- **The recipe gallery ate the whole ribbon.** Ten recipe cards side by side made the Analyze tab
  scroll sideways and pushed the real buttons off screen. Recipes are now **one dropdown button** —
  the same way ArcGIS Pro collapses a gallery — that opens a list of every recipe with its icon,
  title and one-line description; picking a row runs it. `Escape`, a click outside, or a second click
  on the button closes the list.
- Plugin groups with more than three tools collapse the same way, so a plugin never costs a row.

### Fixed
- Clicking a plugin tool that declares **no parameters** crashed (`Cannot read properties of
  undefined (reading 'map')`) instead of opening its dialog: the engine skipped empty `params` arrays
  when serialising a tool, so the front end read `undefined`. The engine now always emits the arrays
  the front end reads, and the pane tolerates a manifest that omits them. Found by the new dropdown
  test, which clicks a five-tool plugin whose tools take no arguments.

### Added
- A small **expand/collapse** affordance in the group title switches back to the old card gallery
  (and the choice is remembered per browser), plus two palette commands: *Ribbon galleries: expand
  recipes instead of a list* / *…collapse to a list*.

## [1.8.0] — 2026-10-16

**Plugins — one tool model, five ecosystems.** GeoSpaX had no plugin story at all. It now reads the
manifest formats people already write for, so a tool shows up in the ribbon whether it was authored
for GeoSpaX, **RustGIS**, **GeoLibre**, **QGIS** or **ArcGIS Pro** — and where something cannot run
here, the Plugins pane says what is missing instead of hiding it ([docs/PLUGINS.md](docs/PLUGINS.md)).

| Ecosystem | Read | Runs |
| --- | --- | --- |
| GeoSpaX `plugin.yaml` | manifest, tools, commands | ✅ `process` · `python` · `r` · `wasm` · `recipe` |
| RustGIS `.rgplugin` | `plugin.json` (commands, tools, params, permissions) | ✅ the WASM module through `wasmtime`/`wasm3`/`deno` |
| GeoLibre | `plugin.json`, WASM tool bundles | ✅ its tools (WASI "tools over `/work`"); ❌ its React UI |
| QGIS | `metadata.txt` (`hasProcessingProvider=yes`) | ✅ its processing algorithms through `qgis_process`; ❌ its PyQt UI |
| ArcGIS Pro `.esriAddInX` | `Config.daml` + `Toolboxes/*.pyt` | ✅ Python toolbox tools through arcpy; ❌ the .NET assembly (no CLR) |

### Added
- **Plugin registry** (`crates/engine/src/plugins.rs`): discovery across `--plugins DIR` folders and
  `<state>/plugins`, five manifest readers, runtimes detection, install with path-traversal and
  size checks, duplicate-id resolution (installed wins over a folder copy).
- **Four runtimes**: `recipe` (runs through the automation engine, so tools get triggers, history and
  artifacts), `process`/`python`/`r` (JSON on stdin → JSON on stdout), `wasm` (WASI runner), and
  `qgis_process`/`arcpy` bridges for the two foreign ecosystems.
- **API**: `GET /api/plugins`, `POST /api/plugins/reload|import`,
  `POST /api/plugins/{plugin}/tools/{tool}/run`.
- **CLI**: `geospax-server plugins list|check PATH|import PATH`.
- **Plugins pane** (bottom dock, `web/src/plugins.ts`): one card per plugin with its source badge,
  runnable state, honest `needs …` note, every tool with a generated parameter form, and an
  install box for folders and packages.
- **Ribbon**: plugin tools get a group of their own on **Analyze**, and every plugin tool is in the
  command palette (`Ctrl+K`).
- Two shipped examples: `plugins/example-python` (2 Python tools) and `plugins/field-recipes`
  (2 recipes packaged as tools), plus fixtures for all four foreign formats under
  `tests/fixtures/plugins/`.

### Fixed
- The **Analyze** tab showed every recipe as the same big play button. Recipes now render as cards
  with an icon chosen from the recipe's subject (hot spots, kriging, terrain, NDVI, photos, tracks,
  LiDAR, sensors, GRASS/SAGA …), the title and one line of description: 10 cards, 6 distinct icons,
  none of them the fallback.
- Plugin tools could deadlock: the engine wrote the request but never closed the tool's stdin, so a
  tool waiting for EOF never returned. The pipe is now closed after the write.

## [1.7.0] — 2026-10-16

**A desktop-GIS workbench, not a sidebar.** GeoSpaX now opens the way a professional GIS looks: a **ribbon** across the
top, **dockable panes** (Contents/Catalog on the left, Symbology/**Attributes**/Rasters/Devices on the right,
Automate/History/Log along the bottom), a **map that owns the middle** and a **status bar** with coordinates, scale and
the active layer. The shell is new, the engine is not — every ribbon button calls the same APIs the old sidebar did.

The desktop-GIS structure was modelled on two permissively-licensed open-source projects, as
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records in full: **RustGIS** (Apache-2.0) for the "everything is a
command" registry and the ribbon/pane vocabulary, and **GeoLibre** (MIT) for the pane set and for treating the attribute
table as a peer of the map. No source files were copied; both patterns are re-implemented in TypeScript.

### Added
- **Ribbon** with seven tabs — Home, Data, Style, Analyze, View, Automate, Help — and 40 commands, each with an icon,
  a tooltip, a keyboard shortcut and a place in the palette (`web/src/commands.ts`).
- **Command registry**: one `Command` record per action (`id`, `tab`, `group`, `title`, `icon`, `keys`, `run(host)`), so
  the ribbon, the keyboard, the palette and the catalog all call the same function.
- **Command palette** (`Ctrl+K`): 40 commands + every recipe + every layer, fuzzy-filtered, arrow keys and Enter.
- **Attribute table** (`Attributes` tab, `web/src/attributes.ts`): paged rows (250 at a time) with a bbox per row, so
  clicking a row zooms to that feature and `Ctrl+click` builds a selection — it opens a 1,000,000-feature layer in the
  same time as a map tile. Sub-views: **Fields** (names and types) and **Chart** (histogram / top values).
- **New engine endpoint `GET /api/layers/{id}/rows`** (`?offset=`, `?limit=` ≤ 2000): a window of features with their
  attributes and a bounding box each, read through the pooled GDAL handles (`crates/engine/src/lib.rs`,
  `wkb::bbox`). 250 rows from row 500,000 of the 1 M-point layer: 0.43 s.
- **Catalog pane**: layers grouped by source with a search box, plus one-click jumps to Devices, Rasters, Recipes and
  Run history. Clicking a layer makes it active, opens its symbology and zooms to it.
- **Run history pane**: every recipe run with status, trigger, duration and a **Report** button.
- **Log pane**: what the engine and the UI are doing, newest first.
- **Status bar**: cursor coordinates, scale ratio and zoom, active layer with feature count, edition and transport,
  and a message area that reports what the last command did.
- **Docks are resizable** (drag a splitter, double-click to reset), **collapsible** (double-click a tab — a collapsed
  pane keeps a 30 px strip of vertical tabs) and **remembered** across reloads in `localStorage`.
- **Identify**: click a feature on the map and its attributes appear in a popup.
- `THIRD_PARTY_NOTICES.md`: dependencies, plus exactly what was borrowed from RustGIS and GeoLibre and what was not.

### Changed
- The old single left sidebar (`#sidebar`) is gone; every pane it held now lives in a dock (Contents, Project with
  transport/go-to/measure, Devices, Rasters, Automate).
- Symbology is no longer a floating card over the map — it is the right dock's `Symbology` tab, so it can stay open
  while you work.
- AutoMap styling moved into one `autostyleLayer()` helper used by the ribbon, the catalog and device imports.

### Fixed
- Pooled GDAL layer handles could keep the spatial filter set by the last tile read, so a scanned layer saw only one
  tile's worth of features. `rows()` now clears the filter before reading (no effect on tiles, which set it per read).

## [1.6.0] — 2026-10-16

**Spatial statistics on autopilot.** Two analyses that used to mean opening R, Python or ArcGIS's Spatial Statistics
toolbox are now native steps with every setting chosen from the data. **Hot spot analysis** (Getis-Ord Gi*) counts
incidents in auto-sized hexagons, finds the distance at which clustering peaks, corrects for multiple testing and maps
hot and cold spots at 90, 95 and 99 % confidence. **Automatic kriging** fits a variogram, krigs with the best of three
models, cross-validates it against IDW and keeps whichever predicts better, and also maps where the surface can be
trusted. Both run on Windows, Linux and the web edition with no R or Python, and they are checked against R's spdep and
gstat on every release.

### Added
- **`stats.hotspots` step** (`crates/engine/src/geostats.rs`, `automation/stats_steps.rs`, [AUTOMATION.md §6e](docs/AUTOMATION.md#6e-spatial-statistics-built)),
  following the rules ArcGIS documents for Optimized Hot Spot Analysis:
  - incidents collapsed to unique locations and counted in hexagons (or a fishnet) sized from the nearest-neighbour
    distances, or 1/100 of the extent for dense data; locational outliers ignored for the sizing;
  - distance band from an **incremental spatial autocorrelation** search (global Moran's I at 10 distances, first
    significant peak), with the documented fallbacks (k-neighbour distance capped at one standard distance; 30
    neighbours when some feature would get 500);
  - Gi* z-scores and p-values with the **false discovery rate** correction (Benjamini–Hochberg) into `gi_bin` −3…3;
  - also works on features with a value (`field:`), points or polygons;
  - output layer with `gi_z`, `gi_p`, `gi_bin`, `gi_class` and `neighbors`, mapped in the conventional red–blue
    classes, plus global Moran's I.
- **`interpolate.auto` step**: empirical variogram with gstat's defaults; spherical, exponential and Gaussian models
  fitted by weighted least squares (global search over the range, exact non-negative sills); ordinary kriging with all
  samples (≤ 200) or the 32 nearest; leave-one-out cross-validation (Dubrule's closed form for all-sample systems)
  against IDW at four powers; prediction and **standard-error GeoTIFFs** in the local UTM zone, clipped to the samples'
  hull. A variogram that never levels off is reported as a trend, and an RMSSE far from 1 is flagged in the report.
- **`points-to-hotspots` recipe** (15th in the gallery): incidents in, hot spot map (PNG/SVG/PDF) and report out.
- **Charts in reports** (`automation/charts.rs`): the variogram with the fitted models, and the distance search
  behind the hot spot band, as inline SVG.
- **Every map in the report**: maps after the first (the uncertainty map, the terrain report's slope map) now appear
  as pictures in the report, not only as links.
- `io.open` `prefer: incidents`; new raster kinds `surface` (Viridis) and `stderr` (pale to dark purple).
- `scripts/data-sample-incidents.py`: 1,120 incidents in Lae with three planted clusters, and the truth.
- `scripts/test-stats.py` (in `test-all.sh` and CI):
  - planted clusters found, with no false hot spots;
  - Gi*, Moran's I and the distance search equal R spdep;
  - the variogram, fit, kriging and cross-validation equal or beat R gstat, for global and 32-neighbour kriging;
  - kriging beats IDW against the known surfaces;
  - one million points timed.

### Changed
- `interpolate-samples` recipe v2: kriging or IDW, whichever cross-validates better, with a surface map, an uncertainty
  map and the variogram chart, instead of IDW polygons. The R version (`r-kriging`) stays in the gallery.
- Maps of hull-clipped surfaces show the whole surface instead of filling the frame (which cut off its edges).
- An export's layout sentence appears once per report, not once per map.

### Fixed
- 3D scenes: building walls traced from LiDAR no longer show light and dark stripes. Cell-sized zig-zags left in the
  outlines are straightened before extrusion, keeping the area within 15 %.

### Measured ([RESULTS §20](bench/RESULTS.md#20-spatial-statistics))
- Hot spots of 1,120 incidents: 604 hexagons of 211 m, band 680 m (first Moran's I peak, z 24.5), 111 hot cells
  covering all three planted clusters and none elsewhere; 0.04 s for the step, 0.37 s for the recipe. One million
  points: 2.2 s.
- Gi* equals spdep `localG` to 5 × 10⁻⁷ (the output's six decimals); Moran's I and all ten distances of the search equal
  `moran.test` to 10⁻¹².
- Kriging pH (60 samples): kriging RMSE 0.106 against IDW's 0.147 in cross-validation; against the true surface
  0.082 against 0.170 (52 % lower). Our variogram fit has an 8 % lower weighted error than gstat's `fit.variogram`;
  predictions and standard errors equal gstat's `krige` to float precision and `krige.cv` to 10⁻¹⁰.
- A stationary random field (400 samples, Gaussian covariance): the Gaussian model is picked and the practical range is
  2.49 km (true 2.2 km); local kriging with 32 neighbours equals gstat's `krige(nmax = 32)`.

## [1.5.0] — 2026-10-16

**3D scenes, made automatically.** Every LiDAR and terrain recipe now also builds a 3D scene: the terrain as a block
diagram draped with its map colours and relief shading (or imagery), buildings extruded to their measured heights,
trees modelled from their heights and crown widths, and the point cloud. The scene is saved three ways: a **glTF 2.0
model** (`scene.glb`) for Blender, Windows 3D Viewer, ArcGIS Pro, CesiumJS or any 3D tool; a **self-contained
interactive viewer** (`scene.html`) that works offline in any browser; and a **rendered 3D picture** in the report.
In the app, the run card's **🧊 3D** button opens it. Nothing to set: the vertical exaggeration, mesh size, texture
and camera are chosen from the data, and the reasons are logged.

### Added
- **`scene.3d` step** (`crates/engine/src/scene3d.rs`, `automation/scene_steps.rs`, [AUTOMATION.md §6d](docs/AUTOMATION.md#6d-3d-scenes-built)):
  - Terrain mesh from any DEM (geographic, rotated or foot-based DEMs are warped to UTM first), at most 320 vertices
    along the longer side, in 16-bit-index primitives. Earth-coloured walls follow the edge of the data, so irregular
    surveys get a proper block diagram too.
  - Draped texture: the DEM in its own map style, any rasters you name (`drape:`; imagery from the run is used
    automatically), vector layers painted on in their map colours (`overlay:`: contours, boundaries, sample points),
    then relief shading from the north-west.
  - **Vertical exaggeration** chosen from the relief: relief about 10 % of the width, at most 1.5× for surveys finer
    than 5 m and 3× for regional DEMs. Buildings, trees and point heights above the ground stay true.
  - **Buildings** extruded as flat-roofed blocks (LOD1). Heights come from `height_m`/`height`, or `levels × 3 m + 1 m`
    (OpenStreetMap), or a number you give; roofs are triangulated with holes (earcut).
  - **Trees** as a trunk and a rounded crown from `height_m` and `crown_m` (or the Popescu & Wynne crown width).
  - **Point cloud**: about 250,000 points, coloured by the file's own RGB, else by class, else by elevation. They come
    from a sample `lidar.grid` keeps during its single read pass, so they cost no second read.
  - Lighting is baked into the colours with the hillshade's sun, and every material is unlit
    (`KHR_materials_unlit`), so the scene looks the same in every viewer. The georeference (CRS, origin, axes,
    exaggeration) is in `asset.extras.geospax`.
  - **Still picture** from a built-in software rasteriser (perspective, z-buffer, 2 × 2 supersampling, sky, haze,
    north arrow), so reports get a 3D view on servers without a GPU.
- **Viewer** (`crates/engine/assets/scene-viewer.html`): plain WebGL (2, falling back to 1), about 430 lines and no
  libraries. Drag to turn, right-drag or Shift-drag to move, scroll or pinch to zoom, compass to face north,
  double-click to reset; switches per layer (the point cloud is off by default next to a model); spin. It frames
  the model to the window and works in a sandboxed frame with no network.
- `lidar-to-terrain` and `terrain-report` gain a `scene` step; the report shows the 3D view, links the viewer and the
  model, and explains how the scene was made. In the app, the run card has **🧊 3D** (opens the viewer, sandboxed)
  and **GLB** buttons.
- `lidar.grid` keeps every n-th point for 3D (`sample:`, default 300,000).
- Tests: 5 engine unit tests (GLB structure and index ranges, roof area with a courtyard, the rendered picture,
  walls along irregular data, exaggeration); `scripts/test-web-scene.mjs` (the viewer in Chromium: framing, turn,
  zoom, pan, compass, reset, layer switches, no network); `scripts/validate-gltf.mjs` (Khronos glTF-Validator);
  `scripts/test-lidar.py` checks the scene of every LiDAR run, and `scripts/test-web-automation.mjs` opens the 3D
  button in the app.

### Changed
- Tree tops on LiDAR maps are dark green: thousands of white dots read as snow over the light greens of low canopy.
- Device folders and drop folders follow symlinks (bounded by the existing depth and entry limits), so a link to a
  folder of tiles works. The device log line counts point clouds.
- The Windows installer ships every notice in `packaging/third-party/`. A new one is `jpeg-encoder`: *this software
  is based in part on the work of the Independent JPEG Group.*

### Fixed
- `scripts/package-windows.sh` failed on a fresh tree: its DLL scan read `geospax.exe` before the Tauri build had
  made it. It now scans the server, and checks the desktop's imports against the staged folder after the build.
- `scripts/test-docs-links.py` crashed instead of reporting a broken link when given relative paths (as CI does).

### Measured ([RESULTS §19](bench/RESULTS.md#19-3d-scenes))
- Autzen Stadium (10.7 M points): the scene adds 0.9 s to the recipe. It holds 55 of 55 buildings, 4,391 of 4,391
  trees and 250,000 true-colour points (327,000 triangles). The Khronos glTF-Validator reports 0 errors and
  0 warnings. The viewer is ready in 0.5 s in headless Chromium with software WebGL.
- Terrain report near Lae (10.5 × 8.1 km, 787 m relief): 0.7 s, 2.7 MB model, 3.6 MB viewer.
- `test-all.sh` 12/12 (9 min), 78 engine unit tests, `test-lidar.py` 63/63, `test-automation.py` 218 checks; `.deb`
  install test 15/15; Windows installer under Wine 20/20, with the 3D scene made by the Windows build. Sizes: server
  20.9 MB, `.deb` 12.5 MB, installer 41.4 MB, ZIP 59.0 MB.

## [1.4.0] — 2026-10-16

**LiDAR point clouds → terrain.** Drop LAS or LAZ files into the Inbox, plug in the drive that holds them, or run
`geospax run lidar-to-terrain --input source=…`, and GeoSpaX grids them into a bare-earth terrain model, a surface
model and canopy heights, outlines the buildings, finds the tree tops and lays out a terrain map, a canopy map and a
report. There are no settings to choose: the cell size follows the point density, and ground comes from the data's own
classes or, when there are none, from the SMRF filter.

### Added
- **`lidar.grid` step** (`crates/engine/src/lidar.rs`, `automation/lidar_steps.rs`, [AUTOMATION.md §6c](docs/AUTOMATION.md#6c-lidar-point-clouds-built)):
  - Reads LAS 1.0–1.4 and LAZ (including COPC), any point format, one file or a folder of tiles, through the pure-Rust
    `las` + `laz-rs` crates (MIT / Apache-2.0; LAZ chunks are decompressed in parallel). One streaming pass, at
    1.4–11 million points per second.
  - Coordinates: WKT or GeoTIFF keys from the file. Metric projected data stays in its CRS; longitude/latitude and
    foot-based data (US State Plane, Oregon Lambert…) are gridded in UTM with heights in metres. A file without a
    coordinate system stops with a message asking for `epsg:`.
  - Ground (DTM): the data's ground and water classes (2, 9), or **SMRF** (Pingel, Clarke & McBride 2013, the algorithm
    behind PDAL's `filters.smrf`) with isolated low outliers removed first. Gaps are filled by GDAL's inverse-distance
    interpolation.
  - Surface (DSM) with bird and multipath spikes removed. Canopy height (CHM) comes from the vegetation classes when
    there are any, so unclassified stadium stands, towers and bridges stay out; otherwise it is DSM − DTM without
    buildings.
  - Buildings from the building class, or found as planar roof regions; outlined with roof height, area and ground
    level. Tree tops as the highest point within the expected crown radius (Popescu & Wynne 2004), with height and
    crown width.
  - Statistics for the report: points, density, area, classes, canopy cover, canopy median and 95th percentile, tree
    and building counts.
- **`lidar-to-terrain` gallery recipe** (the 14th): terrain map (relief shading, contours, buildings), canopy map
  (canopy height over surface relief, tree tops, buildings), canopy-height classes with hectares, report. Its device
  trigger, `device: { has: [point-clouds] }`, starts it on any drive or drop folder with point clouds.
- **LiDAR devices** ([DEVICES.md](docs/DEVICES.md)): `.las`/`.laz` files on a drive, card or folder are counted from
  their headers (points, coordinate system, footprint, height range), the device kind becomes `lidar`, and a plain
  import writes a `point_clouds` footprint layer (a tile index). The Devices pane shows "3 point clouds
  (12.4 million points)".
- Raster kinds `dsm` (hypsometric tint) and `chm` (yellow-to-dark-green canopy ramp to the tallest tree; cells under
  0.5 m are left clear so the relief shows through), and a canopy-height scheme for `raster.classify` (no vegetation,
  low vegetation, shrubs, trees, tall trees, very tall trees).
- `scripts/data-sample-lidar.py` (a synthetic survey near Lae with known truth) and `scripts/test-lidar.py`: terrain,
  tree and building accuracy against the truth for classified and unclassified data, real files (LAZ without a
  coordinate system, Oregon feet, 10.7 million points) and the drop-folder trigger. It runs in `test-all.sh` and in CI
  (`--quick`).

### Changed
- `terrain.contours` traces DEMs finer than 2 m on a 2 m average, so LiDAR and drone DEMs give clean lines instead of
  thousands of noise loops (485 → 12 lines on the test scene).
- The automatic map page takes the data's shape (fixed width, matching height), so raster maps are neither cropped nor
  padded.
- AutoMap keeps a colour that the step making a layer chose on purpose (brown contours, dark-grey buildings) instead of
  swapping it for a "distinct" one.

### Measured ([RESULTS §18](bench/RESULTS.md#18-lidar-point-clouds))
- Synthetic scene (0.72 M points, 50 cm cells): terrain RMSE 0.9 cm with vendor classes, 2.2 cm with SMRF; 40 of 40
  trees found with no false ones, heights within 0.11 m on average; 3 of 3 buildings with footprints within 3 % and
  roof heights within 0.1 m. The whole recipe takes 2.3 s.
- Autzen Stadium (PDAL sample, 10.7 M points, LAS 1.4 point format 7): 12 s for the whole recipe, 55 buildings,
  4,393 trees up to 49 m.
- A folder of LAS files dropped into the Inbox becomes a finished report 7 s later.
- Packages: `.deb` 12.3 MB (install test 15/15, now including a LiDAR run with the installed CLI); Windows installer
  41.2 MB and portable ZIP 58.7 MB (Wine test 19/19, now including `lidar-to-terrain` and LAZ decoding in the Windows
  build). `test-all.sh` 12/12, 72 engine unit tests.

## [1.3.0] — 2026-10-15

**Sensors anywhere.** Live sensors no longer need a broker on your own network. GeoSpaX connects to MQTT brokers
over TLS, understands LoRaWAN uplinks from The Things Stack and ChirpStack as they arrive, and polls OGC
SensorThings services, the standard many public air-quality and water networks publish with. All of them become
live sensors on the map, and sensor triggers such as `air-quality-alert` fire on them like on any other sensor.

### Added
- **MQTT over TLS** (`mqtts://host[:8883]/topic/#`, [DEVICES.md §4](docs/DEVICES.md#live-readings-over-mqtt)):
  - rustls (TLS 1.2/1.3, ring) on the existing MQTT thread.
  - The broker's certificate is checked against Mozilla's CA list (`webpki-roots`, compiled in, so it behaves the same
    on every OS) or your own CA (`?ca=ca.pem`). There is no switch to skip the check.
  - Client certificates (`?cert=client.pem&key=client.key`) for AWS IoT Core, Azure IoT Hub and Mosquitto with
    `require_certificate`.
  - TLS failures are explained in words: unknown CA (add `?ca=`), certificate for another host name, expired, the
    broker wants a client certificate, or the port speaks plain MQTT.
- **LoRaWAN uplinks** (`sensors::parse_lorawan`, [DEVICES.md §4](docs/DEVICES.md#lorawan-sensors-the-things-stack-chirpstack)):
  - Formats: The Things Stack v3 (`v3/{app}@{tenant}/devices/{id}/up`), ChirpStack v4 (`application/{id}/device/{eui}/event/up`)
    and v3 (`…/rx`). A TTN webhook can POST the same JSON to `/api/devices/live`, so no broker is needed at all.
  - Values: the decoded payload (one level of nesting flattened), plus the strongest gateway's `rssi` and `snr` and the
    number of `gateways` that heard it.
  - Position: from the payload (GPS trackers), else the device location set in the network console, else the receiving
    gateway (accuracy 2 km).
  - Join, ack, downlink and status events are ignored.
- **OGC SensorThings API polling** (`crates/engine/src/sta.rs`, `--sta https://host/v1.1[?every=60]`, desktop
  `GEOSPAX_STA`, [DEVICES.md §4](docs/DEVICES.md#ogc-sensorthings-services)):
  - One request per 100 Things returns each location and the newest observation of every datastream (`$expand` with
    `$top=1`), following `@iot.nextLink` up to 1,000 stations.
  - Stations with a point location become live sensors `sta-<service>-<id>` (e.g. `sta-hamburg-6211`) named after the
    Thing, so two services never mix up their stations. Values are named after the observed property and unit
    (`PM2.5` in µg/m³ → `pm2_5`; a second datastream with the same name becomes `pm2_5_2`).
  - A station is updated only when its newest observation is newer than at the last poll: no duplicate readings, one
    trigger per real observation.
  - `bbox=minlon,minlat,maxlon,maxlat` asks the service for your area only (`st_intersects`), `filter=` passes any
    OData filter, `max=` changes the 1,000-station limit, `name=` sets the service part of the ids.
  - Tried on two public services: Fraunhofer IOSB's air-quality FROST (988 European stations with NO2, PM10, PM2.5, O3,
    CO) and Hamburg's urban data platform (293 stations inside a bbox, filtered by the service).
- The Devices pane shows where each live sensor comes from (*LoRaWAN · TTN*, *LoRaWAN · ChirpStack*, *SensorThings*),
  and lists SensorThings services with their stations, updates and last poll. `GET /api/devices` adds `sta`; sensor
  trigger runs record the source in `trigger.source`.
- `scripts/demo-sensor-networks.py`: a mock SensorThings service and TTN/ChirpStack uplinks on a local broker, to
  try all of this without hardware.
- Tests:
  - `scripts/test-sensor-networks.py` (24 checks, part of `test-all.sh` and the CI Linux job):
    - a private CA and server and client certificates made with openssl;
    - mosquitto with a TLS listener and a client-certificate listener;
    - the wrong CA and a missing client certificate, each explained in words;
    - TTN, ChirpStack v4 and v3 uplinks, and a TTN webhook;
    - a mock SensorThings service with two pages, and no duplicate updates;
    - `air-quality-alert` fired by a TTN node and by a SensorThings station.
  - The Wine test checks that the Windows build connects over TLS with a private CA given as a `Z:\` path and maps a TTN
    uplink (17 checks).
  - Engine unit tests: 67 (+8). They cover TTN uplinks and positions, ChirpStack v4 and v3, join and status events,
    `mqtts://` URLs, TLS error texts, SensorThings URLs, filters and pages, and accented field names.

### Changed
- `--help` lists `--sta` and the `mqtts://` options. The privacy notes no longer tell you to keep MQTT on your LAN; they
  recommend `mqtts://` for any broker outside it.
- `geospax-server` is 19.7 MB (+0.5 MB, mostly Mozilla's root certificates).
- The Wine test checks for ~1.9 GB of free disk before it starts and reports the installer's exit code: out of space,
  the silent installer used to stop halfway without a word and every later check failed for the wrong reason.

### Fixed
- **Field names with accents were mangled.** "Température" became `temp_rature` and Hamburg's "Anzahl verfügbarer
  Fahrräder" became `anzahl_verf_gbarer_fahrr_der`. Accented Latin letters are now folded to ASCII (`temperature`,
  `anzahl_verfugbarer_fahrrader`, `ß` → `ss`) in sensor logs and SensorThings names alike.
- **An interrupted read dropped the MQTT connection.** A signal arriving while the subscriber waited for data
  (`Interrupted system call`, seen once in an hour of the preview server running recipes) was treated as a broken
  connection. The subscriber reconnected after 2 s and lost the QoS-0 messages sent in between. It now just reads
  again. The bug had been there since 1.0.

### Dependencies
- `webpki-roots` 1.0.9 (Mozilla's root certificates as data, CDLA-Permissive-2.0). Its license text ships in both
  packages (`packaging/third-party/`). rustls and ring were already in for the phone link.

## [1.2.0] — 2026-10-15

**Send from phone.** GeoSpaX shows a QR code; a phone on the same Wi-Fi scans it and sends photos, tracks and
sensor logs, takes geotagged photos or shares its live location. No cable, no app, any phone, any OS: the
desktop app on Windows, macOS and Linux and the web edition. The finished map comes back to the phone. Photos
that lost their location on the way are placed on a GPS track by their capture time.

### Added
- **Phone link** (`crates/engine/src/phone.rs`, [DEVICES.md §3a](docs/DEVICES.md#3a-send-from-phone-phone-link)):
  - **Devices → Send from phone → Turn on** shows a QR code; the web edition can also start it with `--phone`
    (`--phone-port`, default 8765).
  - The phone gets a page with **Choose files**, **Take a photo** and **Share live location**.
  - Uploads collect in a batch that moves into the drop folder when the phone is done, so the recipe runs once per
    batch. The page then shows the finished map and report.
  - Safety: off until turned on; its own HTTPS port with a self-signed certificate (phone browsers only allow
    location on secure pages); a 128-bit pairing code on every request (**New code** changes it); only a whitelist
    of routes; 64 MB per file; unfinished batches commit after two quiet minutes.
  - It runs inside the engine, so the desktop app, the web edition and the Windows build all have it.
- **Photos placed by time** (`devices::place_by_time`). Photos without GPS but with a capture time are placed on
  the device's GPS track: interpolated between points at most 5 minutes apart, or snapped within 60 s of either
  end. This is the GPicSync/Lightroom/digiKam workflow, and it works for any device or folder with a timed track
  (GPX, dated NMEA, zoned sensor logs). The phone's live track goes into each batch, so phone photos whose
  location the browser stripped are placed too.
- **XMP sidecars** (`IMG.jpg.xmp` / `IMG.xmp`, `exif:GPSLatitude`), as Lightroom, darktable and digiKam write them.
  The phone's camera mode writes one with the phone's position when the photo has no GPS of its own.
- The photos layer records how each photo got its position (`placed`: `exif`, `sidecar`, `track`).
  `GET /api/devices` adds `photos_placed`.
- `--help` / `-h` and `--version` / `-V` for `geospax-server` and `geospax`. An unknown option now prints the usage
  instead of a panic.
- **Code signing hook** for the Windows edition. With `WINDOWS_SIGN_PFX` (+ `WINDOWS_SIGN_PASSWORD`) set,
  `package-windows.sh` Authenticode-signs both executables and the installer with osslsigncode
  (`packaging/windows/sign.sh`, Tauri's `signCommand`). CI does it when a `WINDOWS_SIGN_PFX_BASE64` secret exists.
- Tests:
  - `scripts/test-phone-link.mjs` (10 checks, part of `test-all.sh`): QR, pairing over HTTPS, live track, gallery
    and camera sends, the map on the phone, a wrong code, the http redirect, Turn off, the pairing code after a
    restart;
  - phone-link checks in the `.deb` install test (desktop app) and the Wine test (Windows build);
  - engine unit tests for time placement, GDAL date-times, sidecars, the GPX writer and upload names.

### Changed
- The phone page served by the web edition at `/phone.html` keeps working (live location only). Opened from the
  QR code, it gets the send section.
- Version 1.2.0.

### Notes
- **Phone browsers and photo locations.** When a photo is picked from the gallery in a browser, iOS and recent
  Android versions often remove its GPS. *Take a photo* (phone position) and *Share live location* (placement by
  time) cover that. A photo with no time and no location is listed but not mapped.
- **The certificate warning** appears once per phone, because the certificate is the computer's own. A CA-signed
  certificate would need a public host name, which a laptop on home Wi-Fi does not have.
- **Code signing** was tested on copies with a throwaway certificate ("Signature verification: ok"). The released
  installer is still unsigned until a real certificate is configured.
- **Tested here with Playwright's mobile emulation and mocked GPS, not on a physical phone.** iOS Safari and
  Android Chrome behave the same way for HTTPS pages and file uploads, but camera capture and how much EXIF
  survives vary between phones.

## [1.1.0] — 2026-10-15

The **Windows edition**: an installer and a portable ZIP with the desktop app *and* the web edition, GDAL
bundled. Both are cross-built on Linux and tested under Wine. Linux users only get the new version number.

### Platforms

| Edition | How | Status |
|---|---|---|
| Desktop + web, **Windows 10/11 x64** | `GeoSpaX_1.1.0_x64-setup.exe` (≈39 MB, per-user, no admin rights) or `GeoSpaX-1.1.0-windows-x64.zip` (≈56 MB, unzip and run) | ✅ Installed, run and uninstalled under Wine 10: 15 checks, [RESULTS §15](bench/RESULTS.md#15-windows-edition). ⚠️ **The desktop window itself is untested.** It needs Microsoft Edge WebView2, which Wine can't run. The new CI job starts it on a real Windows runner, but that job hasn't run yet because the repository isn't published |
| Desktop + web, Linux | `geospax_1.1.0_amd64.deb` | ✅ As in 1.0.0; `test-all.sh` 9/9 and the install test pass after the Windows changes |
| Web, container | `Dockerfile` + compose | ⚠️ As in 1.0.0 (not built here; CI builds it on tags) |
| macOS | — | ❌ Can't be cross-built from Linux (needs Apple's SDK and code signing). Needs a Mac or a macOS CI runner |

### Added
- **Windows installer** (`scripts/package-windows.sh`, built with Tauri's NSIS bundler). It installs to
  `%LOCALAPPDATA%\GeoSpaX` without admin rights and adds two Start-menu entries:
  - **GeoSpaX**, the desktop app;
  - **GeoSpaX Web Server**, which runs `geospax-web.cmd` and serves <http://localhost:8080> from `%USERPROFILE%\GeoSpaX`.

  It installs WebView2 silently when it's missing. The uninstaller removes the app and keeps your maps.
- **Portable ZIP** with the same folder. CI attaches it to releases.
- **GDAL for Windows, bundled**: GDAL 3.10.3 and PROJ 9.7 from conda-forge.
  - It ships only the 40 DLLs the executables actually import (resolved from their import tables), plus
    `share\gdal`, `share\proj` (with `proj.db`) and DejaVu Sans, so maps look the same as on Linux.
  - The LGPL builds of SpatiaLite and libarchive are pinned, so the bundle contains no GPL-only code.
  - `third-party-licenses\` lists all 45 libraries with their licenses.
- **Windows support in the engine:**
  - Bundled data is found next to the executable: `GDAL_DATA`, the PROJ search path, fonts and the web UI.
    Environment variables still take precedence.
  - The device hub watches **removable drives** (SD cards, USB sticks, and cameras, GPS units and drones in
    mass-storage mode) and any drive with `DCIM`, `GARMIN` or `PRIVATE` folders. Fixed disks are no longer
    walked every 5 s. Drives are named by their volume label ("EOS_DIGITAL", or "Drive E:" if there is none),
    and map titles use that name.
  - Live GNSS from COM ports: `--gps serial://COM3?baud=4800` (the line is set with `mode.com`).
  - Python steps find the `py` launcher. R steps find `Rscript.exe` in `Program Files\R`. GRASS
    (`grass84.bat`/`grass85.bat`), SAGA and QGIS installs in Program Files are found too.
  - Child processes never open a console window, and Python and R get the Windows environment they need
    (`TEMP`, `USERPROFILE`, `APPDATA`, …).
- **`scripts/setup-linux.sh --windows`** installs MinGW-w64, NSIS, Wine (with `wine32`, since the installer
  stub is 32-bit), the Rust `x86_64-pc-windows-gnu` target and GDAL for Windows (via micromamba, with a license check).
- **`scripts/test-package-windows.sh`** runs 15 checks under Wine:
  - silent install and Start-menu entries;
  - every DLL import resolves;
  - two recipes run (GPX → map, samples → IDW GeoPackage);
  - the Windows server serves the UI and reprojected vector tiles to a Linux browser;
  - a camera card on drive E: is detected;
  - a silent uninstall.
- **CI**:
  - a `windows` job cross-builds and runs the Wine test;
  - a `windows-native` job installs on `windows-latest`, starts the desktop window, checks the web server and uninstalls;
  - tagged releases attach the installer and the ZIP.

### Changed
- Version 1.1.0 everywhere. `/api/health` reports it.

### Notes
- **Toolchain.** MSVC via cargo-xwin came first, but unpacking the Windows SDK cabinets is quadratic in the
  `cab` crate and was still running after 20 min on our 2-core box. MinGW-w64 (`x86_64-pc-windows-gnu`)
  builds the server cold in 3 min.
  - GDAL is still conda-forge's MSVC build. Only its C API is used, and GDAL-allocated memory is always freed
    by GDAL, so the two C runtimes never mix.
  - GNU builds load WebView2 through `WebView2Loader.dll`, which ships next to `geospax.exe`.
- **Not code-signed yet.** Windows SmartScreen will say "Windows protected your PC": choose *More info → Run
  anyway*. Signing needs a code-signing certificate; the Tauri bundler can then sign at build time.

## [1.0.0] — 2026-10-15

The first packaged release: the **Linux desktop app** (`.deb`) and the **web edition** (server + browser UI,
also as a container image). It packages what the milestones below built and fixes the rough edges found on
the way. Nothing is removed.

### Platforms

| Edition | How | Status |
|---|---|---|
| Desktop, Linux | `geospax_1.0.0_amd64.deb` (Debian 13, GDAL 3.10) | ✅ Built, installed and started in a clean test (see [RESULTS §14](bench/RESULTS.md#14-v10-packaging)) |
| Web, any OS with a browser | `geospax-server` from the same `.deb`, or from source | ✅ Tested by the web test suites |
| Web, container | `Dockerfile` + `docker-compose.yml` (with an MQTT broker) | ⚠️ Written and linted (hadolint clean); not built yet because the build sandbox has no container engine. CI builds it on every version tag |
| Desktop, Windows / macOS | — | ❌ Not packaged yet: GDAL has to be bundled into the installer. Use the web edition meanwhile |

### Added
- **Linux installer** (`scripts/package-linux.sh`): one `.deb` containing the desktop app (`geospax`), the web
  edition (`geospax-server`, which serves `/usr/share/geospax/web`), a menu entry, icons, example recipes and docs.
  Runtime dependencies are computed from the binaries, so the script also works on other Debian/Ubuntu releases.
- **Lazy defaults for the installed desktop app.** Started from the menu, it uses one visible folder, `~/GeoSpaX`:
  - `Data/` holds GIS layers;
  - `Inbox/` is a drop folder: dropping photos, a GPX file or a sensor log there gives a finished map, with no
    setup and no switches;
  - `.geospax/` holds the state (finished runs, overviews, project).
  
  Plugged-in phones and other devices still wait for an Auto switch or a click, as
  [DEVICES.md §5](docs/DEVICES.md#5-privacy-and-safety) promises.
- **Drop folders (inboxes)** in the engine: `DevicesConfig::inbox`, server flag `--inbox DIR`. Files put there are
  taken by the matching device recipe even when its Auto switch is off, because dropping them is the consent.
- **Container image** for the web edition (Dockerfile: Node 24 web build, Debian 13 server build, slim runtime
  with only the libraries the binary links). `docker compose up` adds a Mosquitto broker, so live sensors work.
- **CI** (`.github/workflows/ci.yml`): every push runs the web type check and build, the engine unit tests, the
  release build, a gallery recipe check, packaging and an install test. Version tags also publish the `.deb` to
  a GitHub release and the image to GHCR.
- **[User guide](docs/USER_GUIDE.md)**: install, the three lazy ways to a first map, the recipes, where files go,
  troubleshooting.
- `LICENSE-APACHE` and `LICENSE-MIT` (the project was already declared Apache-2.0 OR MIT), plus a Windows icon
  (`icon.ico`) for the future Windows installer.
- Tests: `scripts/test-package-linux.sh` (13-check install test of the `.deb`, including a fresh-HOME desktop start),
  11 new checks in `test-automation.py` (drop folders, restarts, sensor-log changes; 211 in total) and
  `scripts/test-docs-links.py` (every relative link and anchor in the docs).

### Changed
- The header shows the version (`v1.0.0`), which `GET /api/health` now reports.
- The developer stats panel (FPS, tile timings, cache) is hidden by default. Add `?hud=1` to show it; benchmark runs
  still show it.

### Fixed
- **Device recipes re-ran on every restart** while a device stayed plugged in. The hub now remembers the content
  signature it last handled (`<state>/devices/seen.json`). An unchanged device is listed but not processed again;
  new photos, tracks or readings still trigger the recipes.
- **Readings appended to a sensor logger's files went unnoticed** during a session: the change detector counted
  photos and tracks but not CSV/TSV/JSON/FIT logs.
- An installed `geospax-server` now finds its web UI without `--web`.

## Milestones before 1.0 (unreleased)

| Milestone | Highlights |
|---|---|
| Device and sensor hub v1 | Sensor-logger CSV/TSV/JSON and FIT watch readings; live sensors over HTTP push and MQTT (OwnTracks phones too); `sensor` trigger (threshold, geofence, cooldown); WHO-guideline classes; 13 gallery recipes |
| Phase 2, slice 2 | Raster catalogue; Copernicus DEM terrain (hillshade, slope, contours); Sentinel-2 indices from the newest pass that is clear over the area; GRASS and SAGA steps; vector PDF; `stac` and `webhook` triggers |
| Automation engine v0 | YAML recipes, dependency-ordered runner, device/folder/schedule/after triggers, AutoMap styling and automatic page layout (PNG/SVG + HTML report), SQL/buffer/hexbin/IDW, R and Python sidecar steps, `geospax run / check / watch` |
| Device hub v0 | Phones, cameras, drone cards and GPS units: EXIF GPS photos, DJI XMP and SRT, GPX/KML/NMEA; live GNSS (phone page, NMEA serial/TCP/file, gpsd) |
| Phase 1, slice 1 | GDAL Arrow reader, PMTiles overview pyramids, Symbology pane (unique values, graduated colours), legends, project file |
| Phase 0 | One Rust engine behind both a web server (Axum) and a desktop app (Tauri 2); hand-rolled MVT tiles verified against GDAL |
