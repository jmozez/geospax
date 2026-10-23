# GeoSpaX vision: the GIS where maps make themselves

> **GeoSpaX is an open-source desktop and web GIS for people who don't want to spend hours making maps.**
> You drop in data or plug in a device, and GeoSpaX finishes the map. It cleans the data, picks the style,
> runs the analysis, lays out the page and exports it. Every result is a **recipe** you can re-run, schedule
> or attach to a trigger, so the next map makes itself.

Status: positioning adopted October 2026. What exists today is listed in [Development notes](DEVELOPMENT.md#status); the plan is in
TECH_STACK.md §8.

**The lazy loop runs today (automation engine v0 + Phase 2 slice 2 + sensor hub v1):**
- Plug in a phone, GPS unit or drone card with its recipe on Auto, and a styled, labelled, laid-out map plus a one-page report is ready about 5 s later, set by the 5 s device poll; the run itself takes 0.15 s.
- Give it an area and it fetches the Copernicus DEM or the newest Sentinel-2 pass that is actually clear over that area. Terrain (relief, slopes, contours) or vegetation (NDVI, classes, true colour) maps and a report follow in 5–6 s, with no download dialog and no tile picking.
- A `stac` trigger re-runs the NDVI recipe when a newer pass appears; a webhook starts any recipe from another system.
- Plug in an air-quality logger or a sports watch and its geotagged readings become a map, classed by the WHO guideline for particulate matter, with a report, in 0.12 s.
- A live sensor posting over HTTP or MQTT that crosses a threshold produces an alert map 0.26 s later. A phone (the phone page or OwnTracks) entering an area starts its recipe the moment it arrives.
- Thirteen gallery recipes cover photos, tracks, drone coverage, hexbin density, cross-validated IDW, Python point-pattern statistics, R kriging, terrain, latest NDVI, GRASS landforms, SAGA wetness, sensor logs and live air-quality alerts.
- Every automatic choice is written down with its reason ([AUTOMATION.md](AUTOMATION.md), [RESULTS §11](../bench/RESULTS.md#11-automation-engine-v0)).

---

## 1. Who it's for: "lazy mappers"

"Lazy" here means *busy*. These people need maps but have neither the time nor the training to drive a professional GIS:

| Persona | Today | With GeoSpaX |
|---|---|---|
| **Field officer** (agriculture extension, health, forestry, utilities) | Copies phone photos and GPS tracks to a laptop, then drags them into a GIS one by one | Plugs in the phone. Photos, tracks and visit points appear on a styled map, and a weekly PDF builds itself |
| **Consultant / NGO analyst** | Rebuilds the same monthly maps by hand for every report | Writes the workflow once as a recipe; it re-runs when new data lands in a folder |
| **Researcher / student** | Needs a kriged surface or hotspot map without learning geostatistics | Clicks "Interpolate". GeoSpaX fits and cross-validates the model (gstat/automap-style) and explains it in plain words |
| **Drone operator** | Juggles photogrammetry, NDVI and GIS tools | Plugs in the SD card; the orthomosaic, surface model and vegetation index come out the other end |
| **GIS professional** | Repeats production steps across projects | Records a session once and turns it into a scheduled, versioned recipe with triggers |

## 2. What makes GeoSpaX unique

By 2026, chatting with a GIS is table stakes:
- ArcGIS Pro 3.6 ships an assistant (beta) that answers help questions, writes SQL/openCypher queries and generates ArcPy code [1].
- GeoLibre has a natural-language assistant, provider-pluggable and disabled until you supply an API key [3].
- RustGIS includes an assistant crate and an MCP server [5].
- Felt AI (June 2026) turns questions into analysis and picks a map style [6].

So GeoSpaX does not compete on "chat to make a map". It competes on **automation that keeps working when nobody is watching**:

| | ArcGIS Pro | QGIS 4 | GeoLibre | RustGIS | **GeoSpaX** |
|---|---|---|---|---|---|
| Optimized for | Professional GIS production | Professional / power users, free | Light, cloud-native GIS everywhere | Fast pure-Rust GIS, small binary | **Finished maps with the fewest decisions** |
| Main way of working | Ribbon + 2,000+ geoprocessing tools | Toolbox, plugins, expressions | Panels, SQL, assistant | Ribbon, command registry | **Drop data or plug in a device, and AutoMap finishes it** |
| Automation | ModelBuilder, ArcPy, Tasks; real-time rules in the separate ArcGIS Velocity [7] | Graphical modeler, batch, PyQGIS | Batch runner, model/pipeline chaining, Python API [3][4] | CLI, command log [5] | **Recipes with triggers (device, folder, schedule, new satellite pass, sensor threshold, geofence, webhook) as the core of the product, in one free app** |
| AI | Assistant (beta) [1] | Plugins | Assistant, bring your own key [3] | Assistant + MCP [5] | **Optional, and it only *writes recipes*. The core autopilot is deterministic, offline, and needs no key** |
| Connected devices | Companion apps (Field Maps) | GPS panel, QField | Android build, photo layers (object detection on the roadmap) [4] | – | **A device hub that detects phones, GNSS, watches, drones, cameras and sensor loggers, then runs recipes on connect** |
| Live sensors | ArcGIS Velocity / GeoEvent Server (extra products) [7] | Live GPS tracking; IoT through plugins | – | – | **Built in: HTTP push and MQTT (OwnTracks too), live readings on the map, alert recipes that finish their own map and report** |
| Science / stats | Geostatistical Analyst (extension) | Via providers and plugins | Kriging/IDW, spatial-statistics toolbox [4] | GeoLibre/Whitebox tools | **R and Python as first-class recipe steps, with geostat autopilot and "show me the code"** |
| Remote sensing | Image Analyst (extension) | Via providers (OTB, SAGA, GRASS) | SamGeo segmentation [4] | Whitebox RS tools | **RS autopilot: STAC search → cloud-free composite → indices → classification → change report** |
| Engine | Native (.NET/C++) | Native (C++/Qt) | Browser (WASM) + Python sidecar | Native Rust + WASM | **One native Rust engine for desktop, web and headless CLI** |
| License / cost | Commercial | GPL, free | MIT | Apache-2.0 | **MIT, free** |

**One-sentence position:** *GeoSpaX is the open-source GIS where every map is a re-runnable recipe that triggers itself
on new data (a plugged-in phone, a dropped file, a new satellite pass, a sensor crossing a threshold) and finishes the
cartography, analysis and export without a human in the loop.*

GeoSpaX borrows its methods from the best tools in the field. The full list of what we borrow from ArcGIS Pro, QGIS,
GeoLibre, RustGIS, GRASS, SAGA, MapInfo Pro, ERDAS/Octave Imagine, ENVI, eCognition, SNAP, Orfeo ToolBox, Earth Engine,
Whitebox, GeoDa, Global Mapper, FME and the R and Python ecosystems is in [FEATURE_MATRIX.md](FEATURE_MATRIX.md).

## 3. The lazy loop

```
 ① DROP / PLUG         ② AUTOMAP                 ③ NUDGE                ④ AUTOMATE              ⑤ SHARE
 files, folders,  →    detect · clean ·      →   "try another look",  →  "do this every time"  →  PDF, PNG, web map,
 URLs, devices,        reproject · style ·       plain-language          = recipe + trigger       story; refreshes
 an area on a map      label · lay out ·         tweaks, undo                                     when inputs change
                       explain
```

- **① Drop / plug.** Any GDAL/PDAL format, folders, URLs, STAC areas, and connected devices ([DEVICES.md](DEVICES.md)).
- **② AutoMap.** Profiles the data and picks the cartography: symbology type, classification, colour-blind-safe ramp, labels, scale range, basemap, layout. Every choice comes with a one-line *why*.
- **③ Nudge.** Three alternative looks, one click each. Tweaks in plain words ("fewer classes", "label towns"). Everything is undoable.
- **④ Automate.** "Do this every time" turns the session into a recipe ([AUTOMATION.md](AUTOMATION.md)) and offers triggers.
- **⑤ Share.** One-click exports. Outputs re-render when inputs change, and recipes can be shared as files.

## 4. Product principles

1. **Never ask what you can infer.** Defaults come from the data: CRS from the extent, method from the distribution, bands from sensor metadata. Ask only when confidence is low, and then ask one question with a recommended answer.
2. **Every automatic decision is explained and reversible.** A "why" line, a methods log, and undo.
3. **Recipes are the source of truth.** The UI is a friendly recipe editor. Desktop, web and CLI run the same recipe and get the same result.
4. **Offline, no account, no API key** for everything in the autopilot. AI is an optional accelerator that writes recipes; it never replaces them.
5. **Borrow proven methods and say where they come from.** Jenks via ckmeans, variograms the gstat/automap way, OBIA the eCognition way. The methods panel and auto-generated report text cite the technique.
6. **Show the code.** Every step can export equivalent R or Python. Lazy users grow into power users without switching tools.
7. **One engine, two densities.** *Lazy* and *Pro* are views, not editions: a task bar, layer cards, an Inspector and an Activity feed for people who want the map; the full ribbon, a layer tree and every setting for people who want control. One switch, the same project, the same map.
8. **Respect location privacy.** Device and photo locations are personal data. Imports are opt-in, nothing leaves the machine by default, and EXIF is stripped on share.

## 5. Success metrics

| Metric | Target | v0 (October 2026) |
|---|---|---|
| Time to first good map (drop → styled, labelled map on screen) | ≤ 60 s for local data, with no setting changed | **~5 s** from plugging in a device (the device poll); the run itself takes 0.1–0.7 s natively |
| Zero-touch acceptance (AutoMaps exported without manual style edits) | ≥ 70 % | Needs real users; the gallery maps were accepted after map-level rules (README finding 20) and, for air quality, guideline classes (finding 30) |
| Clicks to a finished PDF | ≤ 3 | **0 with Auto, 1 with Run** → PNG + SVG + vector PDF + report (`terrain-report` exports a PDF by default; `format: pdf` on any map) |
| Recipe portability (same outputs on desktop, web, CLI) | 100 % for core steps | ✅ the same engine runs recipes from the UI, `geospax-server run` and the desktop `geospax run` |
| Share of runs started by triggers rather than by hand (active users) | ≥ 50 % after 30 days | Device, folder, schedule, after, stac (new satellite pass), webhook and sensor (threshold, geofence) triggers built; usage still to be measured |
| Time from a sensor event to a finished map | ≤ 10 s | **0.26 s** (HTTP reading above a threshold → alert map + report); plugging in a logger → 5 s (device poll) |

## 6. Non-goals

- **Not an ArcGIS Pro clone.** We borrow workflows, not the UI or its complexity, and never decompiled code (TECH_STACK §1).
- **Not a chatbot wrapper.** Natural language is one way to *write* a recipe.
- **Not cloud-only.** It is local-first. The web edition runs the same engine on your own server.
- **Not an editing-first CAD tool.** Editing exists, but finishing maps automatically comes first.

## Sources

1. Esri, *Join the ArcGIS Pro assistant 3.6 beta* (Jan 2026): https://www.esri.com/arcgis-blog/products/arcgis-pro/announcements/join-the-arcgis-pro-assistant-3-6-beta-help-shape-the-future-of-desktop-gis
2. QGIS 4.0 visual changelog discussion (Mar 2026): https://www.reddit.com/r/QGIS/comments/1rodk65/qgis_40_visual_changelog_official_video/
3. GeoLibre docs, *What GeoLibre does today* (Sep 2026): https://github.com/opengeos/geolibre/blob/main/docs/index.md
4. GeoLibre v1.3.0 release notes (Jun 2026) and roadmap: https://github.com/opengeos/GeoLibre/discussions/385 · https://github.com/opengeos/GeoLibre/blob/main/docs/roadmap.md
5. RustGIS README, architecture (Oct 2026): https://github.com/opengeos/RustGIS
6. Felt blog, *A brand new era of GIS, powered by Felt AI* (Jun 2026) and *Felt MCP server* (Apr 2026): https://felt.com/blog
7. Esri, ArcGIS Velocity overview (real-time feeds, geofences, alerts; a separate product): https://www.esri.com/en-us/arcgis/products/arcgis-velocity/overview
