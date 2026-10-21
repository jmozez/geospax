# GeoSpaX user guide (v1.7)

GeoSpaX makes maps for you. You bring the data (plug something in, drop a file, or name an area) and a
**recipe** does the rest: import, analysis, styling, layout, legend and export to PNG, PDF and an HTML report.
This guide gets you from zero to a finished map in a few minutes.

- [1. Install](#1-install)
- [2. Your first map: four lazy ways](#2-your-first-map-four-lazy-ways)
- [3. Where things go](#3-where-things-go)
- [4. Recipes in the box](#4-recipes-in-the-box)
- [5. Automation on and off](#5-automation-on-and-off)
- [6. Live sensors and phones](#6-live-sensors-and-phones)
- [7. Optional power tools: R, Python, GRASS, SAGA](#7-optional-power-tools-r-python-grass-saga)
- [8. Command line](#8-command-line)
- [9. Privacy](#9-privacy)
- [10. Troubleshooting](#10-troubleshooting)

## 1. Install

| You have | Do this |
|---|---|
| **Windows 10 or 11** (64-bit) | Run `GeoSpaX_1.8.2_x64-setup.exe`. It installs for you only, so no admin password is needed, and adds WebView2 if your PC lacks it (Windows 11 has it). Start **GeoSpaX** from the Start menu. **GeoSpaX Web Server** in the same menu opens the web edition in your browser. The installer isn't code-signed yet, so Windows may say "Windows protected your PC": click *More info → Run anyway*. Prefer no installer? Unzip `GeoSpaX-1.6.0-windows-x64.zip` anywhere and run `geospax.exe`. |
| **Debian 13** (desktop) | Download `geospax_1.8.2_amd64.deb`, then `sudo apt install ./geospax_1.8.2_amd64.deb`. Start **GeoSpaX** from the applications menu. |
| Another Debian/Ubuntu release | The `.deb` above is built against GDAL 3.10 (`libgdal36`). Build a matching one: `scripts/setup-linux.sh && scripts/package-linux.sh` (it works out the right dependencies for your system), or use the web edition in a container. |
| **Docker** (any OS, web edition) | `mkdir -p data inbox && docker compose up -d`, then open the `http://localhost:8080/?token=…` link printed by `docker compose logs geospax` (set `GEOSPAX_TOKEN` to keep a fixed token). The compose file also starts an MQTT broker for live sensors. *The image is built by CI on version tags; it has not been built in our own test sandbox yet.* |
| macOS | Not packaged yet (it needs a Mac to build). Use the Docker web edition for now. |
| The source code | `scripts/setup-linux.sh`, then `cd web && npm ci && npx vite build`, then `cargo build --release -p geospax-server` and `./target/release/geospax-server --data data`. See the [README](../README.md). |

The `.deb` and the Windows installer both contain both editions (on Windows: `geospax.exe`, `geospax-server.exe`, and `geospax-web.cmd`, which starts the server on your `GeoSpaX` folders and opens the browser):

| Program | What it is |
|---|---|
| `geospax` | The desktop app. It also runs recipes from a terminal, e.g. `geospax run track-to-map --input source=~/tracks` (a folder or device). |
| `geospax-server` | The web edition. Run `geospax-server --data ~/GeoSpaX/Data`, then open <http://localhost:8080>. Only this computer can connect; to use it from other devices, add `--host 0.0.0.0` and open the link with the access token it prints ([SECURITY.md](../SECURITY.md)). |

## 2. Your first map: four lazy ways

**The quickest: drop a file, then Finish my map.**

1. **Start screen.** With nothing of your own on the map yet, GeoSpaX opens on **Make a map**: a big drop
   zone, the other ways in (plug in a device, send from your phone, start from an analysis) and **Your
   finished maps**. It comes back any time with **Add data** (Lazy task bar) or **Home → Start** (Pro).
2. **Drop your data** on the drop zone, or anywhere on the window, in either mode: GeoJSON, GeoPackage,
   a **zipped** shapefile, KML/KMZ, GPX, CSV with coordinates, FlatGeobuf, GeoParquet, GeoTIFF, LAS/LAZ.
   The file is saved in `Uploads/` in your data folder (never overwriting a file of the same name) and
   appears styled, zoomed to and selected. Point clouds wait for the *LiDAR → terrain* analysis.
3. **Finish my map** (Lazy task bar, or **Home → Finish my map** in Pro): give it a title (it suggests
   one) and press **Make the map**. The layers you see, styled as you see them, over the area you see
   (or all the data), are laid out with a title, legend with counts, scale bar, north arrow, graticule,
   a world underneath (Natural Earth land and borders) and credits, as a **PNG**, a print-ready vector
   **PDF** (and **SVG** if you want), with a **one-page report**. The report opens by itself; the files
   are in the run's folder and under **Your finished maps**. In Lazy mode the dialog asks only for the
   title (**More options**: subtitle, area, page size A4/A3/Letter, files); Pro shows them all.

**Layout** (in both Lazy and Pro) picks how the result is arranged:

| Layout | What you get | Like |
| --- | --- | --- |
| **One map** | Everything on one map | |
| **Side by side** | One page, each visible layer in its own panel, same area. With one layer: a single tagged figure panel | R patchwork `wrap_plots()` |
| **Split by a field** | One panel per value of a field (2–12 values, e.g. `kind`), same area and classes, one shared legend | ggplot2 `facet_wrap()` |
| **Panels** | Several areas on one page (a grid 1 × 1 to 4 × 4, or one per feature of a layer), each showing exactly its area | R patchwork |
| **Map series** | An index page with every sheet outlined, then one page per area, each exactly its sheet, bound into one PDF | ArcGIS Pro map series, QGIS atlas |

Panels are tagged (a), (b), … (or A, 1, i, or no tags) with a title each and their own scale bar; one
north arrow; **Columns** (automatic: a landscape page) and **Legend**: *one shared legend*
(patchwork's `guides = "collect"`), *one per panel*, or *automatic* (shared when every panel shows the
same layers, otherwise one per panel). Map series pages are files `title-01.png`, `title-02.png`, …,
the index `title-00-index`, and the bound `title-series.pdf`.

Behind the scenes Finish my map is an ordinary recipe, `finished-map`, replaced each time: it has run
history and provenance, and you can re-run it or give it a trigger like any other.

**Opening the app is already lazy.** Every layer GeoSpaX sees for the first time is styled by AutoMap,
the same engine the recipes use: it picks the field that matters (never an ID), the classification and a
colour-blind-safe colour scheme, and the Symbology pane says why ("✨ Styled automatically …"). Change
anything and the style is yours; **✨ Style automatically** brings AutoMap back. Layers too dense to draw
zoomed out get their overview pyramid built in the background, one at a time, without a click. The map
opens on your data over an offline world basemap (Natural Earth land, lakes and borders); **View →
Basemap** switches to OpenStreetMap (online) or none. Add `?auto=0` or `?autooverviews=0` to the address
to turn either automation off.

**a) Drop files into `~/GeoSpaX/Inbox`.** Photos, GPX/KML/NMEA tracks, drone logs and sensor logs dropped here
are mapped by the matching recipe within about 5 seconds, with no switches to turn on:

| Device content | Recipe that runs | You get |
|---|---|---|
| Geotagged photos (phone, camera, folder) | `photos-to-map` | Photo points and tracks on a laid-out map, plus a report |
| GPS tracks or waypoints | `track-to-map` | Track map, KML and GeoJSON |
| Drone card (DJI photos and SRT logs) | `drone-flight-report` | Coverage map and flight report |
| Sensor logger CSV/JSON | `sensor-log-to-map` | Readings map (air quality is classed by the WHO guideline) and a summary |

**b) Plug something in.** Connect a phone (file transfer mode), a GPS unit, a camera or drone SD card, a sports
watch or an air-quality logger. GeoSpaX lists it in the **Devices** section within about 5 seconds. Press
**Import & map** once. To have it mapped on every plug-in, turn on the matching recipe's **Auto** switch in
**Automate**. Devices are never processed without a click or a switch, because photo locations and tracks are
personal data.

**c) Send from your phone over Wi-Fi.** No cable and no app needed:
1. In the **Devices** section, press **Send from phone → Turn on** and scan the QR code with the phone's camera.
2. The phone shows a certificate warning once. That certificate belongs to your own computer: choose *Advanced → Continue*.
3. Then **Choose files** (photos, tracks, sensor logs) or **Take a photo**.

The map makes itself, on the computer and on the phone. Photos that lost their location on the way are placed on
the phone's track by their time, if **Share live location** was on while you took them. Photos taken with **Take a
photo** always get the phone's position. Works on Android and iPhone, with Windows, macOS and Linux.

**d) Pick a recipe and press Run.** Open the **Automate** section, choose a recipe (for example *Terrain report*
or *Latest cloud-free NDVI*), answer the one or two questions it asks (usually just the area) and press **Run**.
The autopilot fills in every other setting and explains its choices in the report.

Finished maps appear in the **Automate** section under the recipe's runs. Open one to see the map, the PDF and the
report.

## 2b. The workbench: ribbon, panes, map

GeoSpaX opens like a desktop GIS: a **ribbon** on top, **panes** docked around the map, and a **status bar**
underneath. Nothing is hidden behind a menu you have to hunt for — and every button still runs the same engine
calls the recipes use.

**Lazy or Pro: GeoSpaX fits you.** One switch in the title bar (remembered in your browser; Lazy is the
default) changes the ribbon and the layer list together:

- **Lazy: the task bar.** The ribbon becomes one slim row: a **What do you want to do?** box (type anything:
  "hot spots", "export", a layer name), four tasks in plain words (**Add data**, **Make it look good**,
  **Find patterns**, **Finish the map**) and **Next for <layer>**: the analyses that fit the layer you
  selected, one click to run them on it.
- **Pro: the full ribbon** (Home, Data, Style, Analyze, View, Automate, Help) plus a contextual **Layer**
  tab while a layer is selected: zoom, attribute table, symbology, AutoMap and the same next steps.

The side and bottom panes follow it too:

- **Lazy, right: the Inspector.** The selected layer as a short story: what it shows (with a bar per class
  and its count), *why* it looks like that, **Colour it by** (one chip per useful column, plus *Let GeoSpaX
  choose* and *One colour*), a see-through slider, **Do something with it** (the analyses that fit, zoom,
  see the rows) and **Where it came from** (file, format, extent, columns).
- **Lazy, bottom: Activity.** *Ideas for your data* (the analyses that fit the layers on the map, one click
  each) and *What happened* (every run, including the ones devices start by themselves, with **Open
  report**, then the latest notes).
- **Pro** keeps Symbology, Attributes, Rasters, Devices on the right and Automate, Plugins, History, Log at
  the bottom.

The layer list follows the same switch:

| | Lazy: layer cards | Pro: layer tree |
|---|---|---|
| Name | Friendly ("Air quality samples") | File name (`air_quality_samples.geojson`) |
| What it shows | One sentence from the data: "Coloured by PM2.5 against the WHO guideline: 88% of 1,500 readings are above 15." | Geometry · CRS · zoom range · classification on one line |
| Legend | A bar whose segments are as wide as their share of the features | Classes with counts |
| Status | Ready · Styled for you · Preparing zoomed-out view (with progress) · Hidden | Compact badges (pyramid %, auto) |
| Next step | Buttons for the recipes that fit this layer (Make a surface, Hot spots, Hexagon map), run on *this* layer | Ribbon and palette |
| Arranging | Grouped by origin: from your devices, your data, recipe results, reference, background | Drag rows to reorder, inline opacity, filter box |

Both show the same project: switching never changes the map.

```
┌──────────────────────────────────────────────────────────────────────┐
│ GeoSpaX   ⤓ ⟳ ⤢ ⌘                          Ctrl+K for any command    │  title bar
│ Home  Data  Style  Analyze  View  Automate  Help                      │  ribbon tabs
│ ┌ Refresh ┐ ┌ Contents ┐ ┌ Attribute ┐ ┌ Export ┐                     │  ribbon body
│ └──Project┘ └── Layers ┘ └──Selection┘ └──  Map ┘                     │
├────────────┬──────────────────────────────────┬───────────────────────┤
│ Contents   │                                  │ Symbology             │
│  ☐ layer   │            M A P                │ Attributes            │  ← drag the
│ Catalog    │                                  │ Rasters               │    splitters
│ Project    ├──────────────────────────────────┤ Devices               │
│            │ Automate │ History │ Log         │                       │
├────────────┴──────────────────────────────────┴───────────────────────┤
│ Ready   -5.86234, 144.23451   1:18,000 · z14.0    countries · 258      │  status bar
└──────────────────────────────────────────────────────────────────────┘
```

| Where | What it does |
| --- | --- |
| **Ribbon** | Seven tabs of commands with icons, tooltips and shortcuts. **Analyze** carries the recipes as a single dropdown button (`Recipes 10 ▾`) — click it for the list, click a row to run it; the small button in the group title expands it to a card gallery instead. The **pin** at the right of the tab strip (or `Ctrl+F1`) auto-hides the whole ribbon: click a tab to use it, and it closes itself afterwards (about 80px more map). |
| **Contents** (left) | The layer list — visibility, draw order, legend, symbology. |
| **Catalog** (left) | Every source grouped by file, with a search box; clicking a layer makes it active and zooms to it. |
| **Project** (left) | Tile transport, Go-to bookmarks, the benchmark and the Arrow → deck.gl path. |
| **Symbology** (right) | Renderer, field, ramp, opacity, labels, overviews — for the active layer. |
| **Attributes** (right) | The table: 250 rows at a time, click a row to zoom to that feature, `Ctrl+click` to select several, plus **Fields** and **Chart** views. |
| **Rasters / Devices** (right) | DEMs, hillshades, indices; phones, GPS units, SD cards, live sensors. |
| **Automate / History / Log** (bottom) | Recipe gallery with Auto switches; every run with its artifacts; a running log. |
| **Status bar** | Cursor coordinates, scale ratio and zoom, the active layer, and what the last command did. |

**Getting around**

| Key / gesture | Result |
| --- | --- |
| `Ctrl+K` | Command palette: search every command, recipe and layer; `↑↓` to move, `Enter` to run |
| `F5` · `Ctrl+S` | Refresh layers · save the project |
| `Ctrl+1` · `Ctrl+2` | AutoMap the active layer · open Symbology |
| `Ctrl+T` · `Ctrl+0` | Attribute table · zoom to everything |
| `Z` · `+` · `-` | Zoom to layer · in · out |
| drag a splitter | Resize a pane (double-click to reset) |
| double-click a pane tab | Collapse the pane to a 30 px strip of vertical tabs (double-click again to reopen) |
| click a feature | Identify: its attributes in a popup |

Pane sizes, which tab is open and which panes are collapsed are remembered per browser/app.

### The Toolbox: every tool in one place

The **Toolbox** tab (right pane, both modes; **All tools** in the Lazy task bar, **Analyze → Toolbox** in
Pro) lists every tool GeoSpaX can run, with one search box:

- **Ready-made analyses**: the recipes. A form, then **▶ Run**: the result joins the map, with a laid-out
  map and a report under Activity / History. They come first in search results.
- **Building blocks**: the engine's 36 recipe steps. Each shows the tools it stands in for in ArcGIS Pro,
  QGIS, GRASS, SAGA and others (*≈ ArcGIS Buffer, QGIS Buffer, GRASS v.buffer…*), so typing the name you
  know finds the GeoSpaX way, and which ready-made analyses use it.
- **GeoLibre tools**: 1,062 raster, vector, LiDAR, hydrology, terrain and conversion tools (below).
- **Plugin tools** from GeoSpaX, RustGIS, QGIS and ArcGIS Pro plugins, each with a badge saying where it
  comes from.

Recently used tools stay at the top. A tool's page shows what it does and its parameters; **Open the
tool…** opens its form. Whatever a tool writes is added to the map.

### The layer tree (Pro)

Pro mode's Contents is a tree, as in ArcGIS Pro: **Map** ▸ group layers ▸ layers ▸ legend classes, then the
basemap. **＋ Group** puts the selected layer in a new group; drag a layer onto a group to add it, onto
**Map** to take it out, onto another layer to take its place. A group's switch hides all its layers
without changing their own switches; the twisty (▾/▸) folds a layer's legend; ✎ renames a group
(or double-click its name) and ⊟ ungroups it, keeping the layers. Groups are saved in the project.

**Keyboard in the Pro tree.** Tab into the layer tree (one tab stop), then ↑/↓ move, Home/End jump,
→/← expand or collapse a group or a legend (← on a layer in a group goes to the group), Space shows or
hides, Enter opens the symbology, Alt+↑/↓ moves the layer in the drawing order, F2 renames a group.

**Theme.** GeoSpaX opens in a light theme. The button left of the Lazy/Pro switch cycles ☀ Light → ☾ Dark →
◐ System (follows your operating system); View → Theme does the same. The choice is remembered; add
`?theme=dark` to a link to force one. The map's background and land colours follow the theme.

## 2c. Plugins: tools from five ecosystems

Open the **Plugins** tab (bottom dock). Every plugin is a folder with a manifest, and GeoSpaX reads
five formats, so a tool written for another GIS shows up here:

| Written for | File it looks for | What runs |
| --- | --- | --- |
| GeoSpaX | `plugin.yaml` | `process`, `python`, `r`, `wasm`, `recipe` tools |
| RustGIS (`.rgplugin`) | `plugin.json` + `plugin.wasm` | the WASM module, through `wasmtime`/`wasm3`/`deno` |
| GeoLibre | `plugin.json`, WASM tool bundles | its tools (WASI); its React UI cannot run here |
| QGIS | `metadata.txt` | its **processing algorithms** through `qgis_process`; its PyQt UI cannot run here |
| ArcGIS Pro (`.esriAddInX`) | `Config.daml` (+ `Toolboxes/*.pyt`) | its **Python toolbox** tools through arcpy; the .NET assembly cannot run here |

**GeoLibre tools come with GeoSpaX.** The `geolibre-tools` plugin brings GeoLibre's whole tool runner
(geolibre-wasm, built on whitebox_next_gen): 1,062 tools, run locally on WebAssembly. They need
[Node.js](https://nodejs.org) 18 or newer; the runner (about 9 MB) is downloaded once on first use and
checked against its published checksum. A vector parameter is a layer on the map; raster, LiDAR and
table parameters take a file path; results are added to the map. Offline machines: see
`plugins/geolibre-tools/README.md`.

**Removing one:** **Uninstall** on the card (press it twice). Plugins that live in a folder you
started the server with (`--plugins DIR`) are not deletable from here — the card says "external
folder" so you can remove them yourself.

**In the ribbon:** recipes and plugin tools are collapsed into a single button with a count
(`Recipes 10 ▾`) so the ribbon stays one row tall. Click it for the full list — icon, title and one
line of description, one click to run. The tiny button in the group's title switches that group back
to a card gallery, and the choice is remembered.

**Using one:** click a tool's **Run…**, fill in the form, press Run. The result (or the recipe run it
started) is reported in the pane and in the log; recipe-backed tools also appear in **History**.

**Installing:** paste a folder or package path (`.rgplugin`, `.esriAddInX`, `.zip`) into the box at
the top of the pane, or `geospax-server plugins import PATH` on the command line. Plugins are stored
in `<state>/.geospax/plugins`; `--plugins DIR` adds a folder you are developing in.

**Writing one:** copy `plugins/example-python` — a `plugin.yaml` with tools and parameters, plus a
script that reads a JSON request on stdin and prints JSON back. Full contract, runtimes and the
honest compatibility table: [PLUGINS.md](PLUGINS.md).

## 3. Where things go

The installed desktop app keeps everything in one folder:

```
~/GeoSpaX/
├── Inbox/       drop photos, tracks, drone and sensor logs here → the matching recipe maps them
├── Data/        put GIS layers here (GeoPackage, Shapefile, GeoJSON, FlatGeobuf, GeoTIFF …)
│                → they appear in the layer list next time GeoSpaX starts
├── .geospax/    state: runs/ (finished maps, PDFs, reports), overviews, project, Auto switches
└── README.txt
```

When you start it from a terminal with a folder (`geospax /path/to/data`), or with `GEOSPAX_DATA` set, it uses
that folder instead. State then goes into `<folder>/.geospax`.

## 4. Recipes in the box

| Recipe | Makes | Runs by itself when |
|---|---|---|
| `photos-to-map` | Photos and tracks → finished map | Geotagged photos land in the Inbox, or (on Auto) a phone or camera is plugged in |
| `track-to-map` | GPS tracks → map, KML and GeoJSON | Tracks land in the Inbox, or (on Auto) a GPS unit is plugged in |
| `drone-flight-report` | Drone flight → coverage map and report | Drone logs land in the Inbox, or (on Auto) a drone card is plugged in |
| `sensor-log-to-map` | Sensor log → map and report | A sensor log lands in the Inbox, or (on Auto) a logger is plugged in |
| `air-quality-alert` | Alert map of live sensors | A live PM2.5 reading goes above 35 µg/m³ (30 min cooldown) |
| `latest-ndvi` | Latest cloud-free NDVI (Sentinel-2) | A new satellite pass covers your area (when on Auto) |
| `lidar-to-terrain` | LiDAR point clouds (LAS/LAZ) → terrain map, canopy map with tree tops and buildings, **3D scene**, report | LAS/LAZ files land in the Inbox, or (on Auto) a drive with point clouds is plugged in |
| `terrain-report` | DEM → relief, slopes, contours, **3D view** | You press Run |
| `landforms-grass` | Landforms with GRASS r.geomorphon | You press Run (needs GRASS) |
| `wetness-saga` | Topographic wetness index with SAGA | You press Run (needs SAGA) |
| `interpolate-samples` | Field samples → the best surface: **kriging or IDW**, whichever predicts better, plus a map of how sure it is | You press Run |
| `points-to-hotspots` | Incidents → **hot spot map** (where they cluster more than chance explains) | You press Run |
| `r-kriging` | Kriging prediction and uncertainty (R gstat) | You press Run (needs R) |
| `python-spatial-stats` | Centre, spread and clustering of points | You press Run (needs Python 3) |
| `points-to-hexbins` | Hexagon density map for very many points | You press Run |

To make your own recipe, use **Save this map as a recipe** in the app, or copy one of the examples from
`/usr/share/geospax/recipes/` (source: [`recipes/`](../recipes)) into a folder and point `GEOSPAX_RECIPES` at it.
The format is described in [AUTOMATION.md](AUTOMATION.md).

## 5. Automation on and off

Every recipe with a trigger has an **Auto** switch in the Automate section. Your choices are saved in
`.geospax/automation.json`. From a terminal:

| Setting | Desktop (environment variable) | Web edition (flag) |
|---|---|---|
| Recipes on Auto | `GEOSPAX_AUTO=photos-to-map,track-to-map` or `all` | `--auto …` |
| Extra drop folders (mapped without Auto) | — (`~/GeoSpaX/Inbox` is built in) | `--inbox DIR` (repeatable) |
| Extra watched folders (treated like devices) | `GEOSPAX_WATCH=/path/one:/path/two` | `--watch DIR` (repeatable) |
| Import new devices without a recipe | `GEOSPAX_AUTO_IMPORT=1` | `--auto-import` |
| Extra recipe folders | `GEOSPAX_RECIPES=DIR` | `--recipes DIR` |
| Live sensors over MQTT | `GEOSPAX_MQTT=mqtt://host:1883/sensors/#` | `--mqtt …` |
| Live GNSS receiver | `GEOSPAX_GPS=gpsd://localhost:2947` or a serial/TCP/file URL | `--gps …` |
| Data and state folders | `GEOSPAX_DATA`, `GEOSPAX_STATE` | `--data DIR`, `--state-dir DIR` |
| Everything off | — | `--no-triggers` |

## 5b. LiDAR point clouds

Put the `.las` or `.laz` files from a drone LiDAR survey (exported from DJI Terra, Pix4D and the like), an aircraft
survey or a national LiDAR portal into `~/GeoSpaX/Inbox`, a folder of tiles included. About ten seconds later you
have:

- a **terrain map**: the bare ground with buildings and trees taken away, shaded, with contours and building outlines;
- a **canopy map**: how tall the vegetation is, a dot on every tree top, buildings in grey;
- `dtm.tif`, `dsm.tif` and `chm.tif` (ground, surface and canopy height), and `trees` and `buildings` layers with
  heights, in the results folder;
- a **3D scene** (see 5c);
- a report with the point density, the canopy cover, and the number and height of trees and buildings.

If the files were classified by the vendor software, GeoSpaX uses that classification. If not, it finds the ground
itself. A file that doesn't say where on Earth it is (some phone scans and exports) stops with a message; run it
again with the EPSG code of the survey: `geospax run lidar-to-terrain --input source=FILE --input epsg=32755`.
Details: [AUTOMATION.md §6c](AUTOMATION.md#6c-lidar-point-clouds-built).

## 5c. 3D scenes

The LiDAR and terrain recipes also build a 3D scene by themselves. The terrain is a block diagram in its map colours
with the relief shaded, contours painted on, buildings at their measured heights, trees at their heights and crown
widths, and the point cloud. You get it three ways:

- **In the app:** press **🧊 3D** on the recipe's card. Drag to turn, right-drag (or Shift-drag) to move, scroll or
  pinch to zoom, click the compass to face north, double-click to start again. The switches at the top show or hide
  the terrain, buildings, trees and point cloud.
- **`scene.html`** in the results folder: the same viewer with the model inside. It opens in any browser, offline,
  so you can e-mail it or put it on a USB stick.
- **`scene.glb`**: a standard glTF 2.0 model for Blender, Windows 3D Viewer, ArcGIS Pro, CesiumJS or a 3D printer's
  slicer. The report also shows a 3D picture.

Flat land is raised a little so you can read it: at most 1.5× for detailed surveys, up to 3× for big areas. The note
on the picture says by how much. Buildings and trees always keep their true heights. To add a 3D scene to your own
recipe, add a `scene.3d` step after any elevation raster ([AUTOMATION.md §6d](AUTOMATION.md#6d-3d-scenes-built)).

## 5d. Hot spots and kriging (no R or Python needed)

**Hot spots.** Put a file of incidents (crimes, crashes, disease cases, complaints: any points) in your Data folder
and run `points-to-hotspots`. GeoSpaX counts them in hexagons, works out the distance at which they cluster most, and
colours each hexagon: **red** where incidents cluster more than chance would explain (90, 95 or 99 % sure), **blue**
where there are fewer than expected, pale where nothing stands out. It corrects for testing hundreds of hexagons at
once, so a few red cells are not just luck. The report shows the map, how many hot and cold spots there are, the
distance used and a chart of how it was chosen. To map hot spots of a value instead (house prices, pH, yields), set
the `field` input.

**Kriging.** `interpolate-samples` turns field samples into a smooth surface. It tries kriging (which learns from
the samples how fast values change with distance) and IDW, tests both by leaving out each sample in turn and
predicting it from the rest, and keeps the one that predicts better. With kriging you also get an **uncertainty map**:
pale near your samples, dark where the surface is a guess. That is where to sample next. The report shows the error of
each method and the variogram (the chart of how quickly samples stop resembling each other).

Both are checked against R's spdep and gstat, and give the same numbers. Details: [AUTOMATION.md §6e](AUTOMATION.md#6e-spatial-statistics-built).

## 6. Live sensors and phones

- **MQTT:** point GeoSpaX at a broker (`GEOSPAX_MQTT` / `--mqtt`). Publish JSON such as
  `{"lat": -9.44, "lon": 147.18, "pm2_5": 41}` to `sensors/<id>`.
- **HTTP:** POST the same JSON to `/api/devices/live`.
- **Brokers on the internet:** use `mqtts://host:8883/topic/#`. Certificates are always checked; add `?ca=ca.pem` for a
  broker with its own CA, and `?cert=client.pem&key=client.key` where the broker wants a client certificate.
- **LoRaWAN sensors:** subscribe to your The Things Stack application
  (`mqtts://APP-ID@ttn:API-KEY@eu1.cloud.thethings.network/v3/%2B/devices/%2B/up`) or your ChirpStack server
  (`mqtt://host/application/%2B/device/%2B/event/up`). Each uplink's decoded values and signal strength go on the map,
  at the sensor's GPS position or near the gateway that heard it.
- **Public sensor networks (OGC SensorThings):** `--sta https://host/v1.1` (desktop: `GEOSPAX_STA`) shows every station
  with its latest values and updates them when they report.
- **Phones:** the free OwnTracks app works with no GeoSpaX app on the phone.

Live devices appear in the **Devices** section, and `sensor` triggers can fire recipes on thresholds or geofences.
Details and message formats: [DEVICES.md §4](DEVICES.md#4-sensors-in-detail).

## 7. Optional power tools: R, Python, GRASS, SAGA

Recipes that use these tools work once the tool is installed. On Debian:

```sh
sudo apt install python3                       # python-spatial-stats
sudo apt install r-base-core r-cran-sf         # R steps; then in R: install.packages("gstat")
sudo apt install grass-core saga               # landforms-grass, wetness-saga
sudo apt install mosquitto                     # a local MQTT broker for live sensors
```

## 8. Command line

Both programs take the same subcommands, and none of them opens a window:

```sh
geospax recipes                                   # list recipes
geospax check my-recipe.yaml                      # validate a recipe
geospax run track-to-map --input source=~/tracks # run once on a folder or device, print the outputs
geospax watch                                     # run triggers headless (all recipes on Auto)
```

## 9. Privacy

Your photos, tracks and sensor readings are processed on your own machine. Nothing is uploaded. Only recipes that
fetch public data go online: the Copernicus DEM for terrain, and Sentinel-2 scenes from the Earth Search STAC
catalogue. See [DEVICES.md §5](DEVICES.md#5-privacy-and-safety).

## 10. Troubleshooting

| Problem | Try |
|---|---|
| No layers in the list | Put files into `~/GeoSpaX/Data` and restart GeoSpaX |
| A plugged-in device is not listed | Check that it is mounted (Linux: under `/media/$USER`). Phones must be in *file transfer* mode. Or copy its files into `~/GeoSpaX/Inbox` |
| The device is listed but no map is made | Press **Import & map**, or turn on the recipe's **Auto** switch. A device that was already handled with the same content is not processed twice: add a file, or press **Run** |
| An R, GRASS or SAGA recipe fails | Install the tool (section 7). The run's log names the missing piece |
| Windows: "Windows protected your PC" | The installer isn't code-signed yet. Click *More info → Run anyway* |
| Windows: the GeoSpaX window stays blank | WebView2 is missing or broken. Reinstall it from Microsoft ("WebView2 Runtime"), or use **GeoSpaX Web Server** in the meantime |
| Windows: an SD card or camera is not listed | GeoSpaX watches removable drives and drives with `DCIM`/`GARMIN` folders. Phones in MTP mode are not read on Windows yet: copy their photos into `%USERPROFILE%\GeoSpaX\Inbox` |
| Anything else | Start `geospax` from a terminal (Windows: `geospax-server.exe` in the install folder, `%LOCALAPPDATA%\GeoSpaX`). It logs what it detects and runs. Please include that log in bug reports |
