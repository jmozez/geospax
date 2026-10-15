# GeoSpaX: measured results (Phase 0, Phase 1, device hub, automation engine v0, rasters, sensors, packaging, sensor networks, LiDAR, 3D, spatial statistics)

Environment: 2 vCPU / 1.9 GB RAM Linux sandbox (Debian 13), GDAL 3.10.3, Rust 1.99 release build, data in the OS page cache.
Engine numbers are single-threaded per-tile latencies over 30 data-weighted tiles per row (`geospax-bench`). UI numbers come from software-rendered WebGL (no GPU), so they verify function, not frame rate.

## 1. On-the-fly vector tiles: source format comparison (1M building polygons)

| source | z | p50 ms | p95 ms | max ms | features/tile | KB/tile | setup | GDAL read | our pipeline |
|---|---|---|---|---|---|---|---|---|---|
| GeoPackage | 11 | 29.1 | 535.1 | 658 | 13,520 | 520 | 30% | 56% | 12% |
| GeoPackage | 12 | 13.0 | 197.5 | 229 | 7,559 | 290 | 30% | 56% | 13% |
| GeoPackage | 13 | 14.7 | 64.8 | 75 | 3,381 | 130 | 31% | 55% | 12% |
| GeoPackage | 14 | 7.7 | 18.7 | 20 | 1,251 | 50 | 33% | 54% | 12% |
| FlatGeobuf | 11 | 8.8 | 155.3 | 156 | 14,448 | 555 | 0% | 53% | 42% |
| FlatGeobuf | 12 | 13.2 | 59.1 | 64 | 9,069 | 348 | 0% | 52% | 42% |
| FlatGeobuf | 13 | 6.9 | 20.2 | 23 | 3,877 | 149 | 0% | 54% | 40% |
| FlatGeobuf | 14 | 1.9 | 5.0 | 5 | 1,205 | 48 | 0% | 53% | 41% |
| Shapefile (+.qix) | 11 | 54.8 | 310.9 | 313 | 15,194 | 583 | 21% | 61% | 16% |
| Shapefile (+.qix) | 12 | 34.2 | 148.7 | 171 | 7,958 | 305 | 22% | 62% | 14% |
| Shapefile (+.qix) | 13 | 22.1 | 73.3 | 74 | 3,599 | 138 | 24% | 62% | 12% |
| Shapefile (+.qix) | 14 | 13.1 | 30.3 | 42 | 1,212 | 48 | 26% | 62% | 12% |

Cold start: the first request per worker opens a GDAL handle. A fresh server measured 935 ms for the Shapefile (loading its 29 MB `.qix` index), 59 ms for FlatGeobuf and 21 ms for GeoPackage, each including the tile. Pooled handles make this a one-time cost; the table above excludes it.

## 2. Natural Earth layers (GeoPackage)

| layer | z | p50 ms | p95 ms | features/tile | KB/tile |
|---|---|---|---|---|---|
| countries | 0 | 46.0 | 46.0 | 192 | 55.0 |
| countries | 2 | 11.1 | 26.2 | 33 | 15.2 |
| countries | 4 | 7.7 | 11.1 | 11 | 4.9 |
| countries | 6 | 3.2 | 12.2 | 3 | 1.3 |
| countries | 8 | 3.1 | 10.2 | 2 | 0.3 |
| roads | 2 | 59.2 | 83.1 | 7,409 | 190.4 |
| roads | 4 | 5.1 | 15.7 | 1,320 | 40.4 |
| roads | 6 | 1.3 | 2.8 | 214 | 8.9 |
| roads | 8 | 0.3 | 0.8 | 35 | 1.6 |
| rivers | 0 | 23.5 | 23.5 | 1,339 | 56.8 |
| rivers | 2 | 2.8 | 8.2 | 160 | 10.6 |
| rivers | 4 | 1.1 | 2.2 | 36 | 4.3 |
| rivers | 6 | 0.5 | 0.9 | 8 | 1.3 |
| rivers | 8 | 0.2 | 0.4 | 2 | 0.2 |
| places | 0 | 21.0 | 21.0 | 7,341 | 295.8 |
| places | 2 | 2.9 | 8.3 | 941 | 38.3 |
| places | 4 | 0.6 | 1.3 | 153 | 6.3 |
| places | 6 | 0.2 | 0.3 | 17 | 0.8 |
| places | 8 | 0.1 | 0.1 | 3 | 0.2 |

## 3. 1M points: vector tiles vs one Arrow IPC payload

| path | p50 ms | p95 ms | payload |
|---|---|---|---|
| MVT tile z12 (7,512 pts/tile) | 7.8 | 100.8 | 230 KB/tile |
| MVT tile z13 (3,338 pts/tile) | 8.0 | 38.8 | 102 KB/tile |
| MVT tile z14 (1,219 pts/tile) | 4.7 | 11.6 | 39 KB/tile |
| Arrow export, all 1,000,000 points (engine) | 826 total (817 GDAL read + 8 Arrow encode) | | 16.4 MB |
| Arrow in the browser (web edition) | fetch 2400 · parse 3.9 · deck.gl first render 138 | total 2542 | 16.4 MB |

Gzip on the Arrow stream: 14.2 MB in 1.7 s vs 16.4 MB in 0.9 s uncompressed (-13% size, +80% time). The server now skips compression for Arrow.

## 4. Camera-tour benchmark in the UI (same script on every edition)

| edition · transport | renderer | settle mean | settle p95 | tiles | engine p95 | FPS |
|---|---|---|---|---|---|---|
| web · http | Chromium headless (SwiftShader) | 1715 ms | 4602 ms | 615 | 168 ms | 4 (software) |
| desktop · scheme | WebKitGTK on Xvfb (llvmpipe) | 926 ms | 3106 ms | 758 | 138 ms | 14 (software) |
| desktop · invoke | WebKitGTK on Xvfb (llvmpipe) | 793 ms | 2906 ms | 795 | 123 ms | 15 (software) |

Settle = time from the end of a camera move until every visible tile is fetched, decoded and drawn. The two renderers differ, so compare **scheme vs invoke** with each other, not web vs desktop. Run the in-app **Run benchmark** button on real GPUs (Windows/WebView2, macOS/WKWebView, Linux/WebKitGTK) to get representative numbers.

### Per-stop detail (desktop · invoke)

| stop | zoom | settle ms | tiles rendered | engine ms/tile |
|---|---|---|---|---|
| world | 1.6 | 883 | 221 | 18.5 |
| PNG | 6 | 338 | 20 | 1.2 |
| highlands | 11 | 790 | 101 | 5.2 |
| Mt Hagen | 13 | 1287 | 93 | 31.6 |
| Mt Hagen close | 15.5 | 0 | 45 | 4.9 |
| pan east | 14 | 468 | 60 | 8.9 |
| pan south | 14 | 467 | 60 | 5.9 |
| Goroka | 13 | 2906 | 191 | 36.6 |
| zoom out | 9 | 0 | 4 | 0.4 |

## 5. Phase 1: GDAL Arrow stream reader vs per-feature reader

Same 30 data-weighted tiles per row, one thread, `geospax-bench --reader arrow|features`. Cells are **mean / p95 ms**. The Arrow reader (`OGR_L_GetArrowStream` with ignored fields and a spatial filter) produced byte-identical MVT for all 108 tiles compared against the per-feature reader.

| layer | z | feats/tile | per-feature | Arrow | Δ mean |
|---|---|---|---|---|---|
| FlatGeobuf buildings | 11 | 14,448 | 32.6 / 153 | **21.8 / 115** | -33% |
| FlatGeobuf buildings | 12 | 9,069 | 16.1 / 52 | **11.6 / 39** | -28% |
| FlatGeobuf buildings | 13 | 3,877 | 6.8 / 19 | **4.8 / 13** | -29% |
| FlatGeobuf buildings | 14 | 1,205 | 2.1 / 5 | **1.6 / 4** | -25% |
| Shapefile buildings | 11 | 15,194 | 88.4 / 317 | **67.0 / 269** | -24% |
| Shapefile buildings | 12 | 7,958 | 47.2 / 167 | **37.2 / 115** | -21% |
| Shapefile buildings | 13 | 3,599 | 24.0 / 57 | **18.0 / 42** | -25% |
| Shapefile buildings | 14 | 1,212 | 8.9 / 21 | **6.5 / 16** | -26% |

GeoPackage has three Arrow paths, because GDAL 3.10's async GPKG Arrow path has a data race (see README finding 11):

| layer | z | per-feature reader | Arrow, per-feature fallback | **Arrow, `base` (default on GDAL < 3.12)** | Arrow, async (default on GDAL ≥ 3.12) |
|---|---|---|---|---|---|
| GPKG buildings | 11 | 106.1 / 544 | 119.7 / 737 | **85.7 / 472** | 65.7 / 338 |
| GPKG buildings | 12 | 50.8 / 215 | 52.2 / 185 | **42.4 / 215** | 28.7 / 101 |
| GPKG buildings | 13 | 24.4 / 90 | 25.3 / 90 | **17.0 / 63** | 13.8 / 36 |
| GPKG buildings | 14 | 8.9 / 24 | 10.2 / 23 | **7.6 / 20** | 6.1 / 13 |
| GPKG points | 11 | 55.7 / 302 | 59.5 / 318 | **60.1 / 285** | 43.8 / 219 |
| GPKG points | 12 | 26.8 / 104 | 29.5 / 113 | **27.2 / 93** | 22.6 / 91 |
| GPKG points | 13 | 11.9 / 36 | 16.0 / 51 | **13.0 / 38** | 12.7 / 41 |
| GPKG points | 14 | 4.4 / 10 | 4.7 / 11 | **4.5 / 9** | 4.2 / 9 |

The two per-feature columns run the same code path, yet differ by 3–34% on the mean. That is the run-to-run noise of single runs on this shared 2-vCPU sandbox, so read small differences with caution. The FlatGeobuf and Shapefile gains are consistent across all eight rows (−21% to −33%), and the GPKG buildings gain from `base` holds at every zoom (−17% to −30% vs the per-feature reader). The GPKG points differences are within noise. The async column was measured before the race was found; it shows what GDAL ≥ 3.12 should deliver.

Whole-layer Arrow IPC export (1M points, 16.4 MB): **579 → 131 ms** (GDAL read 568 → 123 ms; IPC encode 9.1 → 7.9 ms).

## 6. Phase 1: overview pyramid (PMTiles, z0–12)

`geospax-bench --overview synthetic.buildings` (the same job the UI starts). 1M polygons → **735 tiles, 16.66 MB archive** (42.10 MB raw MVT) in **17.9 s on 2 threads** (warm page cache, nothing else running; 27–30 s when a compile was running in parallel).
z0–5 tiles are density aggregates (heatmap cells); z6–12 keep the polygons, simplified and point-reduced per zoom. The densest-cell p90 is stored in the archive metadata, and the UI scales the heatmap with it.

| z | tiles | max tile KB | mean tile KB | build ms | densest cell max / p90 |
|---|---|---|---|---|---|
| 0 | 1 | 0.1 | 0.1 | 429 | 807,462 / 807,462 |
| 1 | 1 | 0.2 | 0.2 | 386 | 442,787 / 442,787 |
| 2 | 1 | 0.3 | 0.3 | 355 | 314,738 / 314,738 |
| 3 | 1 | 1.0 | 1.0 | 345 | 166,742 / 166,742 |
| 4 | 1 | 2.9 | 2.9 | 344 | 82,279 / 82,279 |
| 5 | 1 | 9.2 | 9.2 | 378 | 33,644 / 33,644 |
| 6 | 2 | 22.8 | 15.8 | 2583 | 11,206 / 11,206 |
| 7 | 4 | 83.3 | 29.4 | 2482 | 3,201 / 3,201 |
| 8 | 6 | 190.0 | 75.2 | 1688 | 837 / 837 |
| 9 | 15 | 232.3 | 110.2 | 1780 | 227 / 166 |
| 10 | 48 | 225.0 | 82.3 | 2173 | 68 / 30 |
| 11 | 150 | 237.2 | 46.3 | 1888 | 26 / 12 |
| 12 | 504 | 840.2 | 55.5 | 3051 | 7 / 4 |

Serving z9–12 from the archive (164 tiles): **p50 0.21 ms, p95 1.57 ms**, max 3.21 ms. Live tiling of the same zooms in Phase 0: 300–580 KB tiles, p95 155–535 ms (§1).

## 7. Phase 1: classification

Single requests, median of 3. `scan` reads the column through the Arrow reader, and `classify` computes the breaks (Jenks uses ckmeans, an exact O(k·n log n) algorithm).

| request | rows | scan ms | classify ms | breaks | features per class |
|---|---|---|---|---|---|
| `synthetic.buildings/classify?field=height&method=jenks&classes=5` | 1,000,000 | 89 | 12.9 | 8.4, 13.8, 19.2, 24.6, 30 | 202,551 / 199,467 / 200,054 / 199,480 / 198,448 |
| `synthetic.buildings/classify?field=height&method=quantile&classes=5` | 1,000,000 | 92 | 9.1 | 8.4, 13.8, 19.2, 24.6, 30 | 202,551 / 199,467 / 200,054 / 199,480 / 198,448 |
| `synthetic.buildings/classify?field=height&method=equal&classes=5` | 1,000,000 | 106 | 12.9 | 8.4, 13.8, 19.2, 24.6, 30 | 202,551 / 199,467 / 200,054 / 199,480 / 198,448 |
| `synthetic.buildings/unique?field=kind` | 1,000,000 | 151 | – | – | residential 600,347, commercial 199,913, industrial 100,348, public 99,392 |
| `natural_earth.countries/classify?field=POP_EST&method=jenks&classes=5` | 258 | 3 | <0.1 | 21.8M, 69.6M, 163.0M, 328.2M, 1397.7M | 201 / 38 / 12 / 5 / 2 |
| `natural_earth.countries/classify?field=POP_EST&method=quantile&classes=5` | 258 | 2 | <0.1 | 0.1M, 1.4M, 7.2M, 25.9M, 1397.7M | 52 / 52 / 51 / 52 / 51 |
| `natural_earth.countries/classify?field=POP_EST&method=equal&classes=5` | 258 | 2 | <0.1 | 279.5M, 559.1M, 838.6M, 1118.2M, 1397.7M | 255 / 1 / 0 / 0 / 2 |

The synthetic `height` is uniform (3–30 m), so all three methods agree, as they should. Country population is heavily skewed, and there the methods diverge: Jenks isolates the two largest countries, quantile puts about 52 countries in each class, and equal interval puts 255 of 258 countries in its first class.

## 8. Phase 1: API stress test

`scripts/bench-api-stress.py --clients 16 --requests 256`: a closed-loop mixed workload. Tiles are density-weighted: a coarse grid is probed once per layer extent, then requests favour dense areas at random zooms inside each layer's range, and a third ask for `?fields=height`. The mix also covers classify, unique, project, jobs and stats.
**256 / 256 OK, 0 errors**, 18.7 MB in 9.1 s on 2 vCPU (load generator on the same 2 cores).

| kind | n | p50 ms | p95 ms | max ms | mean KB |
|---|---|---|---|---|---|
| classify | 31 | 751.2 | 1438.9 | 1560.9 | 0.3 |
| jobs | 9 | 0.5 | 2.0 | 2.0 | 0.0 |
| project | 26 | 0.5 | 1.9 | 2.9 | 0.0 |
| stats | 13 | 0.6 | 0.8 | 0.9 | 0.3 |
| tile | 154 | 585.6 | 1285.2 | 1376.1 | 118.3 |
| unique | 23 | 789.6 | 1684.5 | 1766.5 | 0.2 |

**The test found a queueing problem, now fixed (README finding 16).** Before the fix, every request went through the 2-thread tile pool. With the same plan, the control-plane endpoints waited behind tile renders and column scans: project p50 496 ms / p95 639 ms, jobs 519 / 649 ms, stats 459 / 638 ms. `Engine::dispatch` now sends them to a separate 2-thread pool: **p50 0.5 ms, p95 ≤ 2 ms** at the same load. Tile and scan latencies at this load are queueing-dominated (16 clients on 2 cores). They rose somewhat because clients no longer stall on control requests and keep more heavy requests queued; total work and wall time are unchanged within run-to-run variation (8.3 vs 9.1 s).

## 9. Desktop edition: WebKitGTK drops whole tiles (found and fixed)

Desktop edition (Tauri 2 / WebKitGTK, Xvfb + llvmpipe software GL), project view at z12 (6 visible tiles x 5 sources). Metric: share of 40x40 px map blocks that are pure background in a screenshot taken after MapLibre's first 'idle' (0% = complete; ~14-25% = one tile missing).

| configuration | WebGL context | sessions with dropped tiles | empty-block % per session |
|---|---|---|---|
| default · invoke · heatmap on | `antialias=false preserveDrawingBuffer=false` | 3 / 4 | 14.2, 0.0, 20.1, 42.3 |
| default · invoke · heatmap off (?heatmap=0) | `antialias=false preserveDrawingBuffer=false` | 3 / 4 | 0.0, 22.9, 14.2, 10.5 |
| default · custom URI scheme | `antialias=false preserveDrawingBuffer=false` | 4 / 4 | 12.8, 3.7, 24.3, 6.3 |
| default · invoke · screenshots at +2/+10/+25/+50 s after idle (same session) | `antialias=false preserveDrawingBuffer=false` | 1 / 1 | 24.7 |
| default · invoke · screenshots ~30 s after start | `antialias=false preserveDrawingBuffer=false` | 1 / 3 | 0.0, 22.6, 0.0 |
| default · invoke · tile-state probe (MapLibre: all tiles loaded+renderable with buckets; gl.getError() = none) | `antialias=false preserveDrawingBuffer=false` | 4 / 4 | 14.2, 20.1, 13.8, 14.2 |
| default · invoke · WEBKIT_DISABLE_COMPOSITING_MODE=1 | `antialias=false preserveDrawingBuffer=false` | 5 / 5 | 35.1, 6.3, 12.2, 49.7, 23.1 |
| control after fix (?glpdb=0) | `antialias=false preserveDrawingBuffer=false` | 4 / 4 | 10.5, 12.6, 6.3, 23.1 |
| MSAA (?glaa=1) | `antialias=true preserveDrawingBuffer=false` | 0 / 5 | 0.0, 0.0, 0.0, 0.0, 0.0 |
| preserveDrawingBuffer (?glpdb=1) | `antialias=false preserveDrawingBuffer=true` | 0 / 5 | 0.0, 0.0, 0.0, 0.0, 0.0 |
| fix: auto on WebKitGTK · invoke | `antialias=false preserveDrawingBuffer=true` | 0 / 3 | 0.0, 0.0, 0.0 |
| fix: auto on WebKitGTK · custom URI scheme | `antialias=false preserveDrawingBuffer=true` | 0 / 3 | 0.0, 0.0, 0.0 |
| fix: scripts/test-desktop.sh (official run) | `antialias=false preserveDrawingBuffer=true` | 0 / 1 | 0.0 |

Default context: **25 / 29 sessions dropped at least one tile**. With `preserveDrawingBuffer` or MSAA: **0 / 17**. The drop is not caused by the heatmap, the transport, timing or the compositor. MapLibre holds every tile loaded, renderable and with geometry, and WebGL reports no error, but some tiles never reach the screen. GeoSpaX now enables `preserveDrawingBuffer` on WebKitGTK only (README finding 17). It is not yet known whether GPU-backed WebKitGTK is affected.

## 10. Device hub v0 (sample devices from `scripts/data-sample-devices.py`)

| Device (how it was found) | Kind detected | Found | Scan | Import → layers |
|---|---|---|---|---|
| TEST-PHONE (removable mount `/media/user`) | phone | 12 geotagged of 13 photos, 1 GPX track, 2 waypoints | 2 ms | 3 layers in < 0.1 s |
| DJI-SD (`--watch`) | drone | 15/15 photos (EXIF GPS + DJI XMP: gimbal yaw 90°, height above take-off 80.1 m), 1 SRT flight track | < 1 ms | 2 layers in 0.1 s |
| GARMIN (`--watch`) | gps | GPX track + 4 waypoints | 1 ms | 2 layers |
| inbox (`--watch`) | gps | NMEA log track | < 1 ms | 1 layer |
| REAL-CAMERA (`--watch`) | folder | 3/3: two genuine Nikon photos (`exif-samples`) + one HEIC | 2–10 ms | – |

- **Readers:** the tolerant EXIF parser reads every sample (README finding 18). Tiles decoded by GDAL carry `taken_at`, `direction`, `model`, `gimbal_yaw`, `rel_alt`.
- **Triggers:** with `--auto-import`, both watched devices imported themselves at startup. A photo dropped into the watched inbox was re-scanned and re-imported within one 5 s poll, and the new `inbox….photos` layer appeared without a click.
- **Live GNSS:** NMEA replay (`--gps file://…?rate=5`) → 147-fix track with HDOP-based accuracy (4.5 m), 9 satellites, speed. Phone-page POST accepted; out-of-range coordinates rejected (400).
- **UI end to end** (`scripts/test-web-devices.mjs`, formerly `test-devices.mjs`; 16–17 s, 24 s with the sensor section of §13): Devices pane → Import & map (3 layers, zoom to z14.8) → phone page in a mobile viewport with mocked GPS → live phone on the map; clean console.
- **Restarts:** imported layers are restored from `<state>/devices/*.gpkg` at startup.


## 11. Automation engine v0

Recipes, triggers, AutoMap, automatic layout and R/Python steps.

Every gallery recipe, run from the command line (`geospax-server run <id> --json`) on this 2-core sandbox against
the sample devices, the 1M-point synthetic layer and 60 synthetic soil samples (`scripts/data-sample-field.py`).
Times are the run itself, without process start (add about 0.1 s). Source: `scripts/test-automation.py`.

| Recipe | Steps (ms) | Total | map.png | map.svg | report.html |
|---|---|---|---|---|---|
| `photos-to-map` (TEST-PHONE) | import 22 · style 0 · map 150 · report 0 | **0.17 s** | 91 KB (1240×1600) | 7 KB | 14 KB |
| `track-to-map` (GARMIN) | import 12 · style 0 · map 90 · KML 2 · GeoJSON 1 · report 0 | **0.11 s** | 74 KB | 6 KB | 12 KB |
| `drone-flight-report` (DJI-SD) | import 12 · coverage (UTM buffer + dissolve) 12 · style 2 · map 87 · report 0 | **0.11 s** | 86 KB | 8 KB | 14 KB |
| `points-to-hexbins` (1,000,000 points) | open 0 · **hexbin 512** · style 3 · map 132 · report 0 | **0.65 s** | 297 KB | 73 KB | 78 KB |
| `interpolate-samples` (60 samples) | open 0 · IDW + 4-power cross-validation 23 · style 3 · map 129 · report 0 | **0.16 s** | 166 KB | 129 KB | 136 KB |
| `python-spatial-stats` | open 0 · Python step 76 · style 0 · map 108 · report 0 | **0.19 s** | 138 KB | 10 KB | 16 KB |
| `r-kriging` (R 4.5 + gstat 2.1.6) | open 0 · **R step 4,024** · style 3 · map 174 · report 0 | **4.2 s** | 344 KB | 138 KB | 145 KB |

**Where the time goes:**
- **Pages:** laying out and rasterising a page (`export.map`) is the largest cost of a native recipe, 90–175 ms. It renders a 1600×1100 PNG with resvg and system fonts, which load once per process.
- **Hexbin:** binning **1M points takes 0.5 s**. The points stream through the engine's Arrow reader; there is no per-feature allocation.
- **Kriging:** almost all of `r-kriging` is R itself: startup, loading sf and gstat, variogram fitting, kriging 2,115 cells and leave-one-out cross-validation.

**Triggers** (live server, `scripts/test-automation.py`):

| Trigger | What happened | Latency |
|---|---|---|
| device | A phone folder appeared under a watched path → `photos-to-map` ran and finished | **5.0–5.1 s** (one 5 s device poll) |
| folder | A GeoJSON dropped into a watched folder → a user recipe (`io.open` → `interpolate.idw` → `export.svg`) ran | **7.8–8.1 s** (4 s poll + one settle poll so half-copied files are not read) |
| schedule | `every: 3s` | fired 3 times in ~9 s |
| after | `after: tick` | followed every `tick` run |
| startup (preview server, `--auto photos-to-map,track-to-map,drone-flight-report`) | 4 devices connected → 4 runs: phone, drone card, GPS unit, then the second GPS folder (queued behind the first) | all finished within 0.3 s of the first device scan |

**Geostatistics, same 60 samples** (`ph`):
- **IDW:** cross-validation picked power 3, with RMSE **0.147** (powers 1 / 1.5 / 2 gave 0.236 / 0.193 / 0.168).
- **Ordinary kriging in R (gstat):** a spherical model was fitted automatically, with cross-validated RMSE **0.106**, about 28 % lower than the best IDW.

This is exactly the comparison the planned `interpolate.auto` step will make on its own (AUTOMATION.md §4).

**AutoMap decisions** (from the run logs):

| Layer | Decision and why |
|---|---|
| Hexbins (1M points) | `count` is heavy-tailed (skew 4.3) → quantiles, 5 classes, Yellow-Orange-Red; hexagons keep a thin white outline |
| IDW surface | `ph` is roughly symmetric (skew −0.3) → equal intervals, 5 classes, Viridis (field meaning: pH); no outlines, so it reads as a continuous surface |
| Samples over the surface | Single colour turned white with a dark ring, so they stay visible on every class colour |
| Drone coverage | One area over other data → see-through; colour kept distinct from the orange photos |

**Pages and labels:**
- **Labels:** the IDW map placed 60 sample labels and the phone map labelled its 2 waypoints, with no overlaps. Photo file names are never labelled.
- **Context:** Natural Earth land, roads and rivers were added automatically wherever they intersect the extent.
- **Examples:** [`19-auto-map-phone.png`](screenshots/19-auto-map-phone.png), [`20-auto-map-drone.png`](screenshots/20-auto-map-drone.png), [`21-auto-map-hexbins-1M.png`](screenshots/21-auto-map-hexbins-1M.png), [`22-auto-map-idw.png`](screenshots/22-auto-map-idw.png), [`23-auto-map-r-kriging.png`](screenshots/23-auto-map-r-kriging.png), [`24-auto-map-python-stats.png`](screenshots/24-auto-map-python-stats.png) and the report [`19-auto-report-phone.html`](screenshots/19-auto-report-phone.html).

**Tests:**
- **Unit:** 21 new engine unit tests (43 in total) cover recipe parsing and validation, expressions, cron, AutoMap rules, ramp parity with the web UI, clipping, hexagon partition, IDW cross-validation, the Python sidecar round trip and the validity of every gallery recipe.
- **`scripts/test-automation.py`:** 91 checks, with every recipe's files verified and all four trigger types exercised. It also checks the API (run, poll, download), path confinement, unknown inputs (400), and the code-approval gate: 403 without `?approve=code`.
- **`scripts/test-web-automation.mjs`:** about 12 s. It covers the gallery, then Run, which puts layers and styles on the map and zooms there. It opens the map and the report in the viewer, checks that the Auto switch persists, then runs "Save this map as a recipe" and runs the saved recipe ([`15-automate-run.png`](screenshots/15-automate-run.png), [`17-automate-report.png`](screenshots/17-automate-report.png)).

## 12. Rasters, terrain, remote sensing and providers

Phase 2 slice 2 (`scripts/test-all.sh`: 9/9 parts pass in 4 min 54 s): rasters as first-class data, the Copernicus DEM and Sentinel-2 read for just the area of
interest, GRASS and SAGA as recipe steps, vector PDF, and `stac` / `webhook` triggers. All runs below use **live
public data over HTTP** from this 2-core sandbox in Papua New Guinea. The area is the 60 field samples near Mt Hagen
plus a margin (10.6 × 8.0 km for the terrain report, 11.2 × 8.6 km for the others). Source:
`scripts/test-automation.py`; times are the run itself.

| Recipe | Steps (ms) | Total |
|---|---|---|
| `terrain-report` | DEM fetch **3,820** · terrain (hillshade, slope, aspect) 55 · contours 23 · slope classes 12 · sample 26 · relief map (PNG+SVG+PDF) 1,358 · slope map 775 · report 4 | **6.1 s** |
| `latest-ndvi` | STAC search **155** · NDVI (cloud check + 2 bands) **1,786** · classes 107 · true colour 872 · sample 42 · 3 maps 2,480 · report 7 | **5.5 s** |
| `landforms-grass` | DEM 2,810 · hillshade 14 · **GRASS `r.geomorphon` 1,377** (import, run, export, labels) · map 811 | **5.0 s** |
| `wetness-saga` | DEM 2,863 · hillshade 15 · **SAGA `ta_hydrology 15` 1,781** · sample 30 · map 1,527 | **6.2 s** |

**What the steps found** (run logs):
- **DEM:** one Copernicus GLO-30 tile read as COG windows, reprojected to UTM 55S at 30 m: 351 × 270 px, 1,624–2,411 m (mean 1,788 m).
- **Terrain:** mean slope 8.7°, maximum 51°; 1 % of the area is steeper than 30°; slopes most often face north (18 %). Contours every 100 m (85 lines, 13 index contours).
- **Slope classes:** flat 2,860 ha (33.5 %) · gentle 4,392 ha (51.5 %) · moderate 1,206 ha (14.1 %) · steep 71 ha (0.8 %).
- **Satellite:** 14 Sentinel-2 dates in 90 days under 50 % cloud. The newest, 12 Oct 2026 (S2A, tile 54MZU, 8 % scene cloud), was 100 % clear over the area, so no fallback was needed.
- **NDVI:** 1124 × 860 px at 10 m, mean **0.55**, 2–98 % range 0.13–0.85. Classes: dense 41 %, moderate 38 %, sparse 17 %, bare/water/built 4 %. Mt Hagen town and the airstrip stand out in red.
- **Samples:** `raster.sample` added elevation, slope, NDVI and wetness to the 60 samples. The strongest relationship with a measured field is `ph` vs elevation, r = 0.45 (moderate). NDVI vs pH is weak (r = 0.21).
- **GRASS:** 10 landform classes with GRASS's own colours: slope 24 %, ridge 19 %, spur 18 %, valley 15 %, hollow 13 %, pit 4 %, peak 3 %, footslope 2 %, flat 1 %, shoulder 1 %.
- **SAGA:** wetness index 3.95–14.67 (mean 8.0); the wet valleys line up with the GRASS valleys.

**Remote reads** (GDAL `/vsicurl/`, no downloads):
- **Copernicus tile:** opening a 3600 × 3600 tile and warping the area window takes 2.7–3.8 s. Most of that is HTTP round trips from Papua New Guinea to `eu-central-1`.
- **Sentinel-2 band:** a 13 × 13 km window of one 10 m band (1323 × 1336 px) takes **2.1 s** standalone. Inside `rs.index`, the 20 m cloud check plus two 10 m bands take 1.8 s with GDAL's HTTP cache.
- **STAC:** a search on Earth Search takes 0.15–0.25 s.

**Maps:**
- **Rasters:** warped to the page frame at native resolution (1–2× the page) and embedded under the vectors. Relief shading is multiplied on top, and raster maps fill the frame (cover layout).
- **Time:** a page with rasters takes 0.4–1.5 s, against 0.1–0.2 s for vector-only pages; most of the extra time is PNG encoding and resvg decoding the embedded image.
- **PDF:** the relief map is a 1.2 MB vector PDF with selectable text (krilla).
- **Sizes:** PNG pages are 0.5–3 MB (photographic true colour is the largest).
- **Examples:**
  - relief: [`26-auto-map-relief.png`](screenshots/26-auto-map-relief.png) / [`.pdf`](screenshots/26-auto-map-relief.pdf);
  - slopes: [`27-auto-map-slopes.png`](screenshots/27-auto-map-slopes.png);
  - NDVI: [`28-auto-map-ndvi.jpg`](screenshots/28-auto-map-ndvi.jpg);
  - true colour: [`29-auto-map-truecolor.jpg`](screenshots/29-auto-map-truecolor.jpg);
  - GRASS landforms: [`30-auto-map-landforms-grass.png`](screenshots/30-auto-map-landforms-grass.png);
  - SAGA wetness: [`31-auto-map-wetness-saga.png`](screenshots/31-auto-map-wetness-saga.png);
  - web UI with the Rasters panel: [`25-ui-terrain-rasters.png`](screenshots/25-ui-terrain-rasters.png).

**Web overlay:** `GET /api/rasters/{id}/overlay.png` renders the DEM (403 × 313 px, 112 KB) in **63 ms**. It is cached per style, and 99 % of pixels have data; the rest are corner slivers from the UTM → Web Mercator warp.

**Triggers:**

| Trigger | What happened | Latency |
|---|---|---|
| stac | Recipe with `stac: { every: 10s, area: […] }` switched on → the first poll (3 s after) found the newest pass and ran it. The next poll found nothing newer and stayed quiet | **6.3 s** to a finished run; no second fire |
| webhook | `POST /api/hooks/<token>` with `{"note": "from CI", "extra": 42}` → run with `note` as input and the whole body as `${trigger.payload}`; 409 while switched off, 404 for an unknown token | run finished in **< 0.1 s** |

**Bugs the tests caught:**
- **Double offset:** Earth Search's `boa_offset_applied` flag was ignored and the offset applied twice, giving NDVI ≈ 1 (README finding 25). The suite now fails if the NDVI 98th percentile is above 0.97.
- **Wrong coordinate space:** rasters were rendered for a box in normalised tile space instead of metres, so every map was transparent with a correct legend (finding 28).
- **Report size:** the HTML report inlined a 12 MB SVG when the true-colour map came last. It now shows the first map, as PNG when the SVG is heavy, and links the others.
- **Wrong input layer:** `io.open` with `prefer: samples` picked a restored output of an earlier recipe over the source data. Results under the state folder now rank lower.
- **Colour balance:** per-band stretches turned vegetation purple in true colour. One stretch for all three bands keeps natural colour.

**Tests:**
- **Unit:** 49 engine unit tests (6 new: raster statistics and kind guessing, colourising and nodata, Copernicus tile names, contour intervals and smoothing, STAC footprint cover, GRASS category/colour parsing).
- **`scripts/test-automation.py`:** 162 checks (91 before this slice). It runs all 11 gallery recipes, with the four live-data ones skipped offline (`GEOSPAX_OFFLINE=1`) and GRASS/SAGA skipped when not installed. It checks:
  - PDF headers and slope-class shares summing to 100 %;
  - a plausible NDVI;
  - the raster API (list, overlay PNG, style change);
  - the webhook (202/409/404, inputs, payload);
  - the stac trigger (fires once, not twice).
- **`scripts/test-web-automation.mjs`:** runs `terrain-report` from the UI and checks that the DEM and hillshade overlays are on the map below the sample points, and that the Rasters panel lists all five rasters.


## 13. Sensors: loggers, watches, live feeds and sensor triggers

Device and sensor hub v1 (`scripts/test-all.sh`: 9/9 parts pass in 6 min 0 s; `scripts/test-automation.py`: 200
checks). Sample devices come from `scripts/data-sample-devices.py` (synthetic: an air-quality walk through Mt Hagen and
a FIT run). Throughput comes from `scripts/bench-sensors.py` (raw numbers in [`sensors.json`](sensors.json)). All on
the same 2-core sandbox.

| What | Result |
|---|---|
| `sensor-log-to-map` on the air-quality logger (360 readings, 5 measurements) | **0.12 s**: import 12 ms (scan + GeoPackage with readings and track) · summary 4 ms · style < 1 ms · map 101 ms · GeoJSON 7 ms · report < 1 ms |
| Logger plugged in → finished map (device trigger, `kinds: [sensor]`) | **5.0 s**, set by the 5 s device poll |
| Watch FIT run (400 records) through `track-to-map` | 0.12–0.13 s: 5.6 km track + readings layer (heart rate, cadence, temperature, speed, altitude; units from the FIT profile) |
| 200,000-row logger CSV (9.9 MB) through `sensor-log-to-map` | **4.1 s**: import 1.08 s · summary 0.14 s · map 0.25 s (density grid above 30,000 points: 3,771 cells drawn) · GeoJSON export 2.6 s |
| HTTP push, `POST /api/devices/live` (one keep-alive connection) | **4,500 readings/s**, p50 0.20 ms, p95 0.27 ms |
| MQTT through Mosquitto 2.0.21 (QoS 0) | 5,000 messages taken in 0.07 s; the live store keeps the newest 2,000 readings per sensor |
| MQTT message → visible in `/api/devices` | ≤ 0.2 s (the test polls every 0.25 s) |
| `sensor` trigger: PM2.5 48 > 35 → `air-quality-alert` done (snapshot, summary, style, map, report) | **0.26 s** from the HTTP push |
| Cooldown: a second high reading within 30 min | no second run |
| Geofence (`inside: natural_earth.countries`): outside → nothing; entering → run; moving inside → nothing; leaving and re-entering → run | each decision immediate (< 0.3 s) |

**What the steps found** (air-quality walk):
- **Rows:** 361. One row was logged before the GPS had a fix (empty coordinates) and was skipped. That leaves 360 readings × 5 measurements (`pm1`, `pm2_5`, `pm10`, `temperature`, `humidity`), with units from the CSV header.
- **PM2.5:** mean 15.1 µg/m³, 95th percentile 52.8, maximum 61.1. **20.8 %** of readings are above the WHO 24-hour guideline (15 µg/m³).
- **PM10:** mean 26.2, maximum 99.7; 15 % above 45.
- **WHO classes:** 285 readings "guideline met", 20 IT-4, 19 IT-3, 13 IT-2, 23 IT-1. Only the roadside hotspot leaves the green.
- **Quantile breaks for comparison:** 5.5 / 8 / 9 / 10.1 / 15.7 / 61.1 coloured 80 % of the same clean walk orange and red (README finding 30).
- **Track:** the walk also became a 2.87 km track. A list of fixed stations would not.
- **Live readings:** the `live_readings` layer of `air-quality-alert` holds every live sensor's readings of the last two hours. The report names the sensor and the value that fired it.

**Bugs the tests caught:**
- **Wrong device kind:** an OwnTracks phone was listed as a "sensor" because it reports its battery level (README finding 32). The kind now follows the message type.
- **Cold start:** the first map export after a rebuild took 3.3 s instead of 0.1 s; fontdb scans the system fonts from a cold disk (finding 33).

**Examples:**
- logger map with WHO classes: [`32-auto-map-sensor-log.png`](screenshots/32-auto-map-sensor-log.png);
- alert map from the live preview fed by `scripts/demo-sensor-feed.py` over MQTT: [`33-auto-map-air-quality-alert.png`](screenshots/33-auto-map-air-quality-alert.png);
- Devices pane with the logger, the watch and a live sensor's values, with the readings imported in one click and styled by AutoMap: [`34-ui-sensor-devices.png`](screenshots/34-ui-sensor-devices.png).

## 14. v1.0 packaging

Release 1.0.0. All parts pass:
- `scripts/test-all.sh`: **9/9 parts pass in 6 min 29 s**;
- `scripts/test-automation.py`: **211 checks**, including 11 new ones for drop folders, restarts and sensor-log changes;
- `scripts/test-package-linux.sh`: **13/13**.

The sandbox had been **reset** before this release (uptime 0 min). Every tool, the sample data and the 4.4 GB build cache had to be restored first. The first rows show what that costs on the same 2-core, 1.9 GB machine.

| What | Result |
|---|---|
| Restore after a reset: `setup-linux.sh --test-tools --providers --rea --swap 4G` (GDAL, WebKitGTK, Rust, Playwright, Mosquitto, GRASS, SAGA, REA) | 2.5 min |
| Sample data (`data-fetch-samples.sh`, `data-sample-field.py`) · R + sf + gstat (`--r`) | 24 s · 43 s |
| Cold release build, server + desktop in one `cargo build` (2 cores, 1.9 GB RAM + 4 GB swap) | **9 min 23 s** |
| Rebuild after an engine change (server + desktop, thin LTO) | 3 min 28 s – 3 min 42 s |
| `scripts/package-linux.sh --no-build` (strip, stage, dependencies, `dpkg-deb -Zxz`) | **12 s** → `geospax_1.0.0_amd64.deb`, **10 MB** (34 MB installed: desktop 19.7 MB, server 13.9 MB, web UI, icons, recipes, docs) |
| Runtime dependencies, computed from the binaries' `NEEDED` libraries | libc6, libcairo2, libdbus-1-3, libgcc-s1, **libgdal36**, libgdk-pixbuf-2.0-0, libglib2.0-0t64, libgtk-3-0t64, libjavascriptcoregtk-4.1-0, libsoup-3.0-0, libwebkit2gtk-4.1-0, plus fonts-dejavu-core for map text |
| Install test | 13/13 in 26 s: `apt` resolves everything; the menu entry passes `desktop-file-validate`; `geospax recipes` works without a window; `geospax-server` started outside the repo serves the UI from `/usr/share/geospax/web` |
| Desktop started with a fresh `HOME` and no arguments (as from the menu) | Creates `~/GeoSpaX/` with `Data/`, `Inbox/`, `.geospax/` and `README.txt`. All Auto switches stay off |
| GPX dropped into `~/GeoSpaX/Inbox` → finished `track-to-map` run (map PNG/SVG, KML, GeoJSON, report) | **1.5 s** in the install test, 4.0–4.5 s in `test-automation.py`; both are bounded by the 5 s device poll. The run itself takes 249–252 ms |
| Restart with the same Inbox content | Not processed again; the log says "unchanged since last session" |
| Plugged-in device with no recipe on Auto | Listed but not processed (the [DEVICES.md §5](../docs/DEVICES.md#5-privacy-and-safety) promise) |
| Rows appended to a logger CSV during a session | Noticed: the recipe runs again (before 1.0 this was missed) |
| New file in the Inbox after a restart | New run |
| Container image | **Not built:** the sandbox has no container engine. The `Dockerfile` passes hadolint 2.15.1 and the CI workflow passes actionlint 1.7.12. CI builds the image on version tags |
| Docs | Every relative link and anchor resolves (`scripts/test-docs-links.py`) |

**Bugs found on the way to 1.0:**
- **Device recipes re-ran on every restart** while a device stayed plugged in. Fixed with `<state>/devices/seen.json`.
- **Sensor-log changes went unnoticed:** the change signature counted photos and tracks but not CSV/TSV/JSON/FIT logs.
- **An installed server had no UI:** it looked for `web/dist` relative to the working directory. It now falls back to `/usr/share/geospax/web`.
- **`ldconfig` is not on a normal user's PATH,** so the package script could not compute dependencies. It now resolves `/sbin/ldconfig`.

**A design change:** the first plan switched the four device recipes on at the first start. That would have broken the privacy promise for plugged-in phones. Drop folders replace it: files you put into the Inbox are mapped with no switches, and devices still wait for a click or an Auto switch.

**Examples:**
- the installed desktop app at its first start, after a GPX was dropped into the Inbox (version tag from `/api/health`; developer stats hidden): [`35-installed-desktop-first-run.png`](screenshots/35-installed-desktop-first-run.png);
- the map that run made: [`36-installed-inbox-map.png`](screenshots/36-installed-inbox-map.png).

## 15. Windows edition

Release 1.1.0 adds a Windows installer and a portable ZIP. Both are **cross-built on this Linux box** and
**tested under Wine 10**: `scripts/test-package-windows.sh` passes **15/15 in 39 s**. Everything below
was measured on the same 2-core, 1.9 GB machine.

| What | Result |
|---|---|
| Cross-build kit: `setup-linux.sh --windows` (MinGW-w64 GCC 14, NSIS 3.11, Wine 10 + `wine32`, Rust `x86_64-pc-windows-gnu`, GDAL for Windows) | ≈80 s in total. The GDAL step takes 5 s: micromamba creates the conda-forge `win-64` env (libgdal-core 3.10.3, 44 packages), collects their license files and fails on any GPL-only package |
| First toolchain tried: MSVC via cargo-xwin | **Abandoned after 20 min.** cargo-xwin downloaded the CRT + Windows SDK for x64 *and* arm64 (30 packages), then sat in `cab::FolderReader::load_block` → `miniz_oxide::inflate` (gdb stack trace). Each file re-inflates its MSZIP cabinet folder from the start, which is quadratic. Not one package finished unpacking |
| MinGW-w64 instead: cold build of `geospax-server.exe` | **2 min 58 s**, 18.1 MB. It imports only Windows DLLs, `msvcrt` and `gdal.dll`; no MinGW runtime DLLs |
| First build of server + desktop (all Tauri/WebView2 crates) | 8 min 25 s; `geospax.exe` 27 MB |
| `package-windows.sh` after an engine change | 6 min 22 s: server 1 min 23 s, desktop through the Tauri CLI 3 min 29 s, then staging, NSIS (LZMA) and the ZIP |
| DLLs bundled, resolved transitively from the import tables | **40 DLLs, 99 MB**, out of the 126 DLLs (184 MB) in conda's `Library/bin`; plus `WebView2Loader.dll`, which GNU builds load at run time |
| Licenses | The LGPL builds of SpatiaLite and libarchive are pinned (the default `gpl_` builds pull in GPL-only librttopo and lzo). `third-party-licenses\` has 45 entries: 44 conda-forge packages and DejaVu |
| Installer | **`GeoSpaX_1.1.0_x64-setup.exe`, 39.1 MB**. Per-user, no admin rights, Start-menu entries **GeoSpaX** and **GeoSpaX Web Server**, silent WebView2 bootstrap, uninstaller. Not code-signed |
| Portable ZIP · installed size | 55.9 MB · 155 MB (129 MB runtime folder + 26 MB `geospax.exe`) |
| Wine prefix · silent install (`/S`) | 15 s · **6–7 s**. Installs to `%LOCALAPPDATA%\GeoSpaX` with both Start-menu shortcuts |
| Every DLL import of both executables and all 41 bundled DLLs | Resolves to a bundled DLL or a Windows system DLL. `api-ms-win-*` API sets (the Universal CRT) are resolved by the Windows 10/11 loader |
| `geospax-server.exe recipes` · `run track-to-map` on a Garmin folder · `run interpolate-samples` | 13 recipes · map PNG/SVG, KML, GeoJSON and report in 1–2 s wall (the run itself takes 0.4 s) · IDW surface written as a 528 KB GeoPackage by the Windows GDAL in 1–2 s (run 0.5 s) |
| The Windows server seen from Linux | `/api/health` → `1.1.0`. The UI is served from the install folder, 5 layers load (GeoJSON + GeoPackage), and the z4 countries tile is 3,453 bytes: EPSG:4326 → 3857 through the **bundled `proj.db`** |
| Camera card on drive E: (the sample DJI card, mapped as a Wine drive) | Found within the 5 s poll as **"DJI-SD"** (from its volume label), kind *drone*, 15 geotagged photos. C: and Z: (Z: is Wine's view of the Linux root) are not scanned |
| Silent uninstall | Removes the app, its DLLs and both Start-menu entries |
| Linux after the Windows changes | Engine unit tests 55/55; **`test-all.sh` 9/9 in 6 min 2 s**; `geospax_1.1.0_amd64.deb` (10 MB) passes its install test. The live preview restarted on 1.1.0 lists its six watched devices as "unchanged since last session" |
| **Not tested here** | **The desktop window.** It needs Microsoft Edge WebView2, which Wine can't run, so the test pre-registers WebView2 to keep the installer from fetching it. The CI job `windows-native` installs the same file on `windows-latest`, starts `geospax.exe`, checks the `~/GeoSpaX` layout and the web server, then uninstalls. It has not run yet because the repository isn't published. Also untested: COM-port GNSS on real hardware |

**Bugs found on the way:**
- **Maps titled "GPS tracks · E:\".** On Windows a drive root has no folder name. Devices are now named by
  volume label ("Drive E:" when there is none), and device ids get a readable slug.
- **The engine would have walked every fixed disk** (D:–Z:, including Wine's Z: = `/`) every 5 s. Only removable
  drives and drives with camera/GPS folders count now.
- **Every Python, R, GRASS or SAGA step would flash a console window** from the desktop app. Child processes now
  get `CREATE_NO_WINDOW`, and Python and R get `TEMP`, `USERPROFILE`, `APPDATA` and the rest of the Windows environment.
- **R and GRASS were not found on a stock Windows install:** R's installer doesn't touch PATH, and GRASS launchers
  are versioned (`grass84.bat`). Both are now looked up in Program Files.
- **The NSIS step failed with "No space left on device".** `/tmp` here is a 1 GB tmpfs. The package script now
  points `TMPDIR` at `target/`, and the Wine test keeps its 800 MB prefix in `/var/tmp` and deletes it afterwards.
- **The installer stub is 32-bit**, so 64-bit-only Wine can't run it. `setup-linux.sh --windows` adds `wine32:i386`.

**Examples:**
- the map `geospax-server.exe` made from the Garmin sample, installed under Wine (fonts from the bundle):
  [`37-windows-wine-track-map.png`](screenshots/37-windows-wine-track-map.png);
- the web UI served by the installed Windows server, opened in Chromium on Linux (vector tiles reprojected by the
  bundled PROJ): [`38-windows-wine-web-ui.png`](screenshots/38-windows-wine-web-ui.png).

## 16. Send from phone

Release 1.2.0 adds the phone link: a QR code, an HTTPS listener inside the engine, uploads in batches, and
photos placed on GPS tracks by time. Measured on the same 2-core, 1.9 GB machine. "Phone" means Chromium's mobile
emulation (390×844, touch) with mocked GPS; no physical phone was used.

| What | Result |
|---|---|
| `scripts/test-phone-link.mjs` (own server, fresh state) | **10/10 in 15.5 s** |
| Turn on (Devices → Send from phone) | The QR code appears at once. Decoded with `zbarimg` it reads `https://<LAN address>:<port>/#t=<32 hex>` |
| Phone opens the address | Paired, `window.isSecureContext` true (so location works), pairing code removed from the address bar and kept in the phone's storage |
| Gallery send: a geotagged photo + a photo without GPS taken "now", with live location on (3 fixes) | Batch committed, `photos-to-map` started by the drop folder with no Auto switch, **map shown on the phone 2.7 s** after choosing the files |
| Camera mode: a photo with no GPS of its own | Sent with the phone's position; GeoSpaX writes an XMP sidecar, and the photo is mapped |
| What GeoSpaX made of it | The "From phone" device has **3 of 3 photos geotagged, 2 placed by GeoSpaX** (one on the live track by time, one from the camera-mode position) |
| Wrong pairing code · `http://` · Turn off · restart with `--phone` | Page says "not paired" (API 401) · 301 to `https://` · port closed · same pairing code |
| Placing by time, checked by hand (sample walk GPX 08:00:00Z–08:14:50Z) | A photo stamped 08:07:30 lands **exactly** on the track point recorded at 08:07:30Z (−5.8423496, 144.2162090). A photo stamped 09:30, outside the track, stays unplaced. The photos layer marks them `placed = track` / `exif` |
| Desktop app (`.deb` install test, `GEOSPAX_PHONE=1`) | HTTPS page, photo sent → `~/GeoSpaX/Inbox/Phone 2026-10-15 …/` → new map. The Inbox already held the Garmin GPX, so `track-to-map` mapped the photo with the track. The install test now has 14 checks |
| Windows build (Wine test, `--phone`) | HTTPS page (rustls + ring cross-compiled with MinGW), upload (EXIF GPS found), commit → `photos-to-map` done. The Wine test now has 16 checks |
| Engine unit tests | 59 (+4): time placement (between points, snapping, gaps), GDAL date-time text, XMP sidecar round trip, GPX of live fixes read back with times, upload names, pairing code kept across restarts |
| Binary size | `geospax-server` 19.2 MB (+1.2 MB for rustls, ring, rcgen, qrcode); `.deb` 12 MB; Windows installer 40.5 MB |
| Full suites on the final 1.2.0 builds | **`test-all.sh` 10/10 in 7 min 0 s** (the phone link is a new part) · `.deb` install test **14/14** · Wine test **16/16** |
| Code-signing hook | Tested on copies of `geospax-server.exe` and the installer with a throwaway certificate: `osslsigncode verify` → "Signature verification: ok"; a DigiCert time-stamp works too. The released installer stays unsigned until a real certificate is configured |

**Bugs found on the way:**
- **The pairing code changed on every restart** when the link was started by `--phone` or `GEOSPAX_PHONE` rather
  than the UI: the code was only saved by Turn on/off. A phone's bookmark would have broken. It is now saved the
  first time the link starts, and covered by a unit test and a restart check.
- **The phone link's own drop folder was called `inbox`**, so maps were titled "Field photos · inbox". It is
  "From phone" now.
- **The Wine test named the camera card "Drive E:" once.** A drive mapped while Wine's services run can miss its
  label on the first query (the same exe read "DJI-SD" every time from a fresh start). The test restarts
  wineserver after mapping the drive, which mirrors how Windows sees a freshly plugged card.
- **The phone page logged a 404 on the web edition.** The existing devices test treats console errors as failures,
  and caught it: to tell the phone link from the web edition's `/phone.html`, the page asked `api/phone/hello`,
  which only the phone link answered. The web edition now answers it too (`link: false`), and the console is clean.
- **The Wine test read the phone run's status the moment it appeared** ("running"). It now waits until the run has finished.
- **A test expected the wrong recipe.** A photo sent into a drop folder that already holds a GPS track is mapped by
  `track-to-map` together with the track, which is right; the test now accepts any new map.

**Not tested here:** a physical phone (iOS Safari, Android Chrome): how much EXIF survives the gallery picker, the
camera capture path and the certificate prompt all vary by phone. Also untested: the Windows firewall prompt on
first use.

**Examples:**
- the "Send from phone" card with its QR code: [`39-phone-link-card.png`](screenshots/39-phone-link-card.png);
- the phone page after pairing: [`40-phone-link-page.png`](screenshots/40-phone-link-page.png);
- the finished map shown on the phone, with the photo that had no location placed on the live track:
  [`41-phone-link-map-on-phone.png`](screenshots/41-phone-link-map-on-phone.png).

## 17. Sensor networks: MQTT over TLS, LoRaWAN, OGC SensorThings

Release 1.3.0 lets live sensors come from anywhere: brokers on the internet over TLS, LoRaWAN network servers and
OGC SensorThings services. Measured on the same 2-core machine. The local test uses a real Mosquitto 2.0.21 broker
with certificates made by openssl and a mock SensorThings service; the last rows use real public services.

| What | Result |
|---|---|
| `scripts/test-sensor-networks.py` (own broker, server and mock SensorThings service) | **24/24 in 21 s** |
| `mqtts://` with a private CA (`?ca=`) · mutual TLS (`?cert=&key=`, Mosquitto `require_certificate true`) | Both connected |
| Wrong CA | Refused: "TLS: the broker's certificate is not signed by a CA this computer trusts; for a private broker add ?ca=/path/to/ca.pem (invalid peer certificate: UnknownIssuer)" |
| No client certificate for a broker that wants one | "TLS: the broker wants a client certificate: add ?cert=client.pem&key=client.key (received fatal alert: CertificateRequired)" |
| TTN v3 uplink over `mqtts://` | Live sensor within 0.25 s (the test polls every 0.25 s). Values `pm2_5`, `pm10`, `temperature`, `battery_voltage` (nested `battery.voltage` flattened), `rssi` −87 dBm and `snr` 8.5 dB from the stronger of 2 gateways, `gateways` 2. Position from the tracker's GPS payload |
| ChirpStack v4 over mutual TLS · ChirpStack v3 · TTN webhook over HTTP | `level_cm` 82.5, placed at the receiving gateway with accuracy 2,000 m · `rain_mm` 1.2, `snr` from `loRaSNR` · HTTP 200, live sensor `sensor-aq-node-9` |
| Join-accept (no uplink) | Ignored: no sensor without readings |
| TTN node reports `pm2_5` 41.2 → `air-quality-alert` | **Map done 0.8 s** after the uplink; the run records `trigger.source = "LoRaWAN · TTN"` |
| SensorThings (mock service, 2 pages) | 3 stations in 2 requests (the Thing without a location skipped). A poll with nothing new adds no readings; one new observation adds exactly one; a station above 35 µg/m³ starts `air-quality-alert` 10.1 s after the observation, most of which is the 10 s poll interval |
| **Public broker over TLS**: `mqtts://test.mosquitto.org:8886` (Let's Encrypt certificate, checked with the built-in Mozilla roots) | Connected in 0.5 s. A TTN-format uplink published through it arrived as *LoRaWAN · TTN*, `pm2_5` 27.3 |
| **Fraunhofer IOSB air-quality FROST** (`--sta https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1`) | **988 European stations** in one poll (10 requests), with `no2`, `pm10`, `pm2_5`, `o3`, `co`, `so2` named for the WHO-guideline styling. Interval phenomenon times (`start/end`) read |
| **Hamburg urban data platform** (`--sta https://iot.hamburg.de/v1.1`) | Without a filter: the first 997 of many thousands of Things (the 1,000 limit). With `bbox=9.95,53.54,10.03,53.57`: **293 stations**, filtered by the service (`st_intersects`): traffic counters, counting fields, bike-share stations. GeoJSON Feature locations read |
| Engine unit tests | 67 (+8): TTN uplinks and positions, ChirpStack v4/v3, join and status events, `mqtts://` URLs, TLS error texts, SensorThings URLs, filters, ids and pages, accented field names |
| Binary size | `geospax-server` 19.7 MB (+0.5 MB, mostly Mozilla's root certificates); `.deb` 12 MB; Windows installer 40.9 MB, portable ZIP 58.2 MB |
| Full suites | `test-all.sh` **11/11 in 7 min 41 s** on the first 1.3.0 build (sensor networks is a new part). The fixes made after it (accented names, the EINTR read, station ids, `bbox=`) were re-tested on the final build with the engine tests (67), `test-sensor-networks.py` (24/24), `test-automation.py` (pass) and the real services above · `.deb` install test **14/14** · Wine test **17/17**, twice (new: the Windows build connects over TLS with a private CA at a `Z:\` path and maps a TTN uplink) |

**Bugs found on the way:**
- **Real data mangled field names.** Hamburg's "Anzahl verfügbarer Fahrräder" became `anzahl_verf_gbarer_fahrr_der`,
  because every non-ASCII letter counted as a word break. The same happened to sensor-log headers such as
  "Température". Accented Latin letters are folded to ASCII now. The mock service, written in English, could not
  have caught this.
- **Station ids could collide across services.** Ids were `sta-<thing id>`, and Thing 6 exists on most servers. With two
  services configured, two stations a country apart would have shared one live device. Ids are `sta-<service>-<id>`
  now (`sta-hamburg-6211`).
- **Big platforms hit the station limit.** Hamburg lists many thousands of Things; the first poll stopped at 1,000. The
  fix is to ask for less: `bbox=` (sent as an `st_intersects` filter) and `filter=`.
- **An interrupted read dropped the MQTT connection** (in 1.0 – 1.2 too). Found in the preview server's log, after an
  hour of recipes spawning processes: `Interrupted system call` led to a reconnect and 2 s of lost QoS-0 messages.
- **The Wine test failed 16 of 17 checks for the wrong reason.** With 1.5 GB free, the silent installer ran out of disk
  halfway (the Wine prefix and the app need about 1.7 GB), exited after 3 s, and every later check failed. NSIS says
  nothing in silent mode. After clearing 0.8 GB of build artifacts left by earlier versions, the same installer
  passed 17/17. The test now checks free space first and reports the installer's exit code.
- **A data license had to travel with the binaries.** `webpki-roots` ships Mozilla's root list under
  CDLA-Permissive-2.0, which asks for the agreement text to go with the data; both packages now include it.

Screenshot: the Devices pane of the preview server fed by `scripts/demo-sensor-networks.py` (a TTN air-quality node, a
ChirpStack water tank, three SensorThings stations, with their sources and values):
[`42-sensor-networks-devices.png`](screenshots/42-sensor-networks-devices.png).

**Not tested here:** a real The Things Stack or ChirpStack server and real LoRaWAN radios (the messages follow the
documented formats, and one travelled through a real public broker); AWS IoT Core or Azure IoT Hub accounts (mutual
TLS was tested with Mosquitto); SensorThings services that need a login; the SensorThings MQTT extension.

## 18. LiDAR point clouds

Release 1.4.0 turns LAS/LAZ point clouds into a bare-earth terrain model, a surface model, canopy heights, building
outlines and tree tops (`lidar.grid`, recipe `lidar-to-terrain`, [AUTOMATION.md §6c](../docs/AUTOMATION.md#6c-lidar-point-clouds-built)).
Measured on the same 2-core machine with `scripts/test-lidar.py`. The synthetic survey from
`scripts/data-sample-lidar.py` is 300 × 240 m near Lae (EPSG:32755): rolling ground with a 6 m hill, a flat-roofed
hall, a gabled house and a tower, 40 trees of 8–25 m, 25 birds 40–80 m up and 25 below-ground multipath points; about
10 pulses per m², with 40 % of the vegetation pulses also returning from the ground. The truth is written beside it.

| What | Classified (vendor classes) | Unclassified (SMRF finds the ground) |
|---|---|---|
| Points, cells | 723,931 used (50 noise points left out), 50 cm cells (11 points/m²) | 723,981, 50 cm cells |
| Terrain error against the true ground (285,844 cells) | **RMSE 0.9 cm**, 95 % within 1.5 cm | **RMSE 2.2 cm**, 95 % within 3.5 cm |
| Under the buildings (filled by interpolation) | 4.0 cm | 4.2 cm |
| Trees found within 1.5 m of the true stem / false tree tops | **40 of 40 / 0** | **40 of 40 / 0** |
| Tree heights | 0.11 m mean error (worst 0.28 m) | 0.11 m (worst 0.28 m) |
| Buildings: area found / true, roof height found / true (90th percentile) | hall 383/384 m², 6.1/6.0 m · house 160/160 m², 6.3/6.2 m · tower 144/144 m², 9.1/9.0 m | hall 389/384 m², 6.1/6.0 m · house 161/160 m², 6.3/6.2 m · tower 147/144 m², 9.1/9.0 m |
| Birds 40–80 m up, unclassified | – | Removed from the surface: canopy 95th percentile 22.2 m, tallest tree 24.8 m (true 24.9 m) |
| Contours (1 m interval, traced on a 2 m average) | 12 lines | 16 lines |
| `lidar.grid` · whole recipe (9 steps, 6 map files, report) | 0.16 s · **2.4 s** | 0.18 s · **2.5 s** |

Real files (downloaded once at test time, not shipped):

| File | Result |
|---|---|
| `simple.laz` (laspy test data: LAZ, 1,065 points, no coordinate system) | Stops with "simple.laz has no coordinate system (no WKT or GeoTIFF keys in its header); pass epsg: …". With `epsg=2994` (Oregon Lambert, feet): decoded and gridded in UTM 10N (EPSG:32610) at 50 m |
| `autzen_trim.las` (PDAL test data: 110,000 points, user-defined Lambert projection in international feet plus WKT) | Gridded in UTM 10N at 1 m with heights converted to metres: ground 123.9–132.2 m (Eugene lies at about 130 m), 111 trees; 0.37 s |
| **`autzen-classified.laz`** (PDAL sample data: Autzen Stadium, 10,653,336 points, LAS 1.4 point format 7 with colour, 74 MB) | **Whole recipe 12–13 s**: reading 8 s (1.3–1.5 million points/s, LAZ chunks decompressed on both cores), 1 m cells (1,088 × 1,451), ground and water from the vendor classes, canopy from the vegetation class over 22 % of the area, **55 buildings, 4,391 trees up to 49 m** |
| Uncompressed LAS (synthetic scene) | 11 million points/s |

| What | Result |
|---|---|
| Drop folder: a folder with a LAS file moved into `--inbox` | `lidar-to-terrain` started by itself (trigger `device`, kind `lidar`), report done **7.6 s** after the drop (the 5 s device poll plus 2.5 s) |
| Devices pane | The drop folder listed as a `lidar` device with 1 point cloud (723,981 points) and its footprint |
| `scripts/test-lidar.py` | **33/33 in 33 s** (`--quick` skips the 74 MB file for CI) |
| Engine unit tests | 72 (+5): running min/max filter against brute force, automatic cell size, SMRF keeps the hill and drops the building, tree tops on cones (and none inside a building mask), roof planes vs round crowns |
| Full suite | `test-all.sh` **12/12 in 7 min 6 s** (LiDAR is a new part) |
| Binary size | `geospax-server` 20.4 MB (+0.7 MB for `las` + `laz-rs`); `.deb` 12.3 MB; Windows installer 41.2 MB, portable ZIP 58.7 MB |
| Packages | `.deb` install test **15/15** (new: the installed CLI turns a LAS survey into maps with 40 tree tops); Windows installer under Wine **19/19** (new: `lidar-to-terrain` on the LAS survey in 5 s, and `simple.laz` decoded by laz-rs in the Windows build) |

**Bugs found on the way:**
- **Unclassified structures became forest.** On Autzen, "surface minus ground minus buildings" drew the stadium stands
  as 30 m canopy with tree tops on the seats, and a transmission tower became a 58 m tree, because the vendor left
  both unclassified (class 1) rather than building. When the data has vegetation classes, the canopy now comes from
  those points only: 4,393 trees instead of 5,284, tallest 49 m.
- **Rivers were holes.** Water returns are class 9, not ground, and the Willamette is wider than the gap filler's
  reach, so the DTM had white holes in the river. Ground and water now both count as bare earth, as in USGS 3DEP DEMs.
- **One point fell off the grid.** Headers are written before coordinates are rounded to the file's scale, so a point
  can sit half a millimetre outside them, and a grid sized exactly to the header dropped it (723,980 of 723,981). The
  extent is padded by 1 cm.
- **Contours on a 50 cm DTM were noise.** Two centimetres of noise on a 3 % slope moves a contour by 0.7 m, and
  `terrain.contours` traced 485 lines, mostly tiny loops, for a 12 m range. Fine DEMs are now traced on a 2 m average:
  12 lines. The same applies to drone DEMs.
- **Maps cut off the survey.** The map composer crops raster maps to fill the frame, and the fixed portrait page
  showed only 870 of 1,088 m of Autzen. The automatic page now takes the data's shape, so nothing is cropped or padded.
- **AutoMap repainted the buildings blue.** Its "keep single colours distinct" rule replaced the step's grey with blue,
  which reads as water. A colour the step chose on purpose is kept now.
- **A forced EPSG code was ignored when choosing the UTM zone.** `simple.laz` with `epsg=2994` stopped with "cannot
  place the point cloud on Earth" because the zone was worked out from the file's own (missing) coordinate system.

Screenshots: the synthetic survey through the SMRF path, [`43-lidar-terrain.png`](screenshots/43-lidar-terrain.png)
(bare-earth tint, relief shading, 1 m contours, buildings) and [`44-lidar-canopy.png`](screenshots/44-lidar-canopy.png)
(canopy height to 25 m over surface relief, 40 tree tops, buildings); and Autzen Stadium,
[`45-lidar-autzen-canopy.png`](screenshots/45-lidar-autzen-canopy.png) and
[`46-lidar-autzen-terrain.png`](screenshots/46-lidar-autzen-terrain.png) (sample data from the PDAL project); the
canopy map made by the Windows build under Wine, [`47-windows-wine-lidar-canopy.png`](screenshots/47-windows-wine-lidar-canopy.png).

**Not tested here:** raw drone LiDAR formats (DJI `.LDR` needs DJI Terra to become LAS first); E57 and PLY; surveys
in steep forested terrain without ground classes, where SMRF's defaults may need a larger `window:` or vendor ground;
very large collections (the grid is capped at 6 million cells, so a 100 km² block is gridded at 5 m).

## 19. 3D scenes

Release 1.5.0 adds `scene.3d` to `lidar-to-terrain` and `terrain-report` ([AUTOMATION.md §6d](../docs/AUTOMATION.md#6d-3d-scenes-built)).
Each run writes a glTF 2.0 model, a self-contained viewer and a rendered picture. Measured on the same 2-core machine
with `scripts/test-lidar.py`, which checks every 3D scene it makes: the GLB container, mesh names and georeference;
the Khronos glTF-Validator (npm `gltf-validator` 2.0.0-dev.3.10); the picture; the viewer in Chromium with the
network blocked (`scripts/test-web-scene.mjs`); and the report's 3D section.

| Scene | Built in | Content | Model · viewer | Validator | Viewer ready |
|---|---|---|---|---|---|
| Synthetic survey, classified (300 × 240 m) | **0.91 s** | 320 × 256 terrain mesh, ×1.5 (12 m relief), 2048 × 1024 texture; **3 of 3 buildings, 40 of 40 trees**, 241,311 points by class; 167,197 triangles | 6.8 MB · 9.1 MB | **0 errors, 0 warnings** | 0.42 s |
| Synthetic survey, unclassified (SMRF) | 0.97 s | same, points coloured by elevation | 6.8 MB · 9.1 MB | 0 errors, 0 warnings | 0.41 s |
| **Autzen Stadium** (10.7 M points, 1,088 × 1,451 m) | **0.91 s** (whole recipe 15 s) | 240 × 320 mesh, ×1.5 (23 m relief), 1024 × 2048 texture, walls along the irregular survey edge; **55 of 55 buildings, 4,391 of 4,391 trees, 250,000 points in the file's own colours**; 327,467 triangles | 9.8 MB · 13.1 MB | **0 errors, 0 warnings** | 0.50 s |
| Terrain report near Lae (Copernicus 30 m, 10.5 × 8.1 km) | 0.7 s | 320 × 246 mesh, ×1.5 (787 m relief), 1024 × 512 texture with 100 m contours and the 60 sample points painted on; 158,566 triangles | 2.7 MB · 3.6 MB | 0 errors, 0 warnings | 0.22 s |

"Viewer ready" is the time from opening `scene.html` to the first frame in headless Chromium with software WebGL
(SwiftShader): decoding the embedded model, uploading it and the texture, and drawing. The whole LiDAR recipe peaked at
209 MB of memory on Autzen. The scene's point sample is kept while `lidar.grid` reads the file, so the 3D step does
not read the 74 MB LAZ again.

| What | Result |
|---|---|
| Viewer interaction (`test-web-scene.mjs`, each scene) | Model framed to the window (45 % of the pixels on Autzen at 1280 × 800); a 200 px drag turns the view 60° and tilts it; scrolling zooms 2×; Shift-drag pans without turning; the compass faces north; double-click returns home; hiding the terrain clears most of the view; the point cloud alone fills it; no console errors, **no network requests** |
| In the app (`test-web-automation.mjs`) | The `terrain-report` card shows **🧊 3D**; it opens the viewer in a sandboxed frame (scripts on, no same-origin access to the app), ready with the terrain layer |
| `scripts/test-lidar.py` | **63/63 in 74 s** (30 new 3D checks on three scenes) |
| Engine unit tests | 78 (+6): GLB container, alignment and index ranges; roof area of a block with a courtyard (540 m² of 600 − 60); the CPU picture shows terrain, sky and the block; walls along a diamond of data face outwards; exaggeration picks; symlinked LiDAR tiles are found |
| `scripts/test-automation.py` | **218 checks** (the terrain report's scene files: the picture, the offline viewer with the model inside, glTF 2.0) |
| Full suite | `test-all.sh` **12/12 in 9 min 7 s** |
| Binary size | `geospax-server` 20.9 MB (+0.5 MB for the mesher, glTF writer, CPU renderer, viewer, `jpeg-encoder` and `earcutr`); `.deb` 12.5 MB; Windows installer 41.4 MB, portable ZIP 59.0 MB |
| Packages | `.deb` install test **15/15** (new: the installed CLI makes the 3D scene); Windows installer under Wine **20/20** (new: the Windows build writes `scene.glb`, the viewer and the picture, [`52-windows-wine-scene.png`](screenshots/52-windows-wine-scene.png)) |

**Bugs found on the way** (all from looking at the pictures; the unit tests passed throughout):
- **The point cloud speckled the model.** The first picture drew all 241,000 points over the terrain, so the ground
  looked like gravel and every roof took the building class's orange-red. The picture now shows points only when there
  is no model, as the viewer does by default.
- **Irregular surveys floated.** Autzen's DTM is no-data around its edge, so walls built along the grid border had
  nothing to stand on and vanished. Walls now follow the edge of the data: wherever a drawn cell meets an empty one.
- **Sample points looked like snow.** The 2D rule "points over a coloured layer turn white" made 60 white blots on
  the 3D terrain. Light point colours are replaced on terrain textures.
- **The viewer opened too far away.** Fitting the eight corners of the bounding box left Autzen at 20 % of the window,
  because the top corners at tree-top height over the far edge are empty air. It now fits about 400 drawn vertices
  per primitive and re-centres in three passes.
- **2D maps had their own snow.** 4,391 tree tops drawn as white dots (the same rule) turned low canopy whitish on
  the Autzen canopy map. Tree tops now carry a fixed dark green.

Screenshots (Autzen; sample data from the PDAL project): the viewer,
[`48-scene-viewer.png`](screenshots/48-scene-viewer.png); the same scene showing only the point cloud in its own
colours, [`49-scene-points.png`](screenshots/49-scene-points.png); the picture made on the CPU for the report,
[`50-scene-still.png`](screenshots/50-scene-still.png); the 3D button in the app, [`51-ui-scene-3d.png`](screenshots/51-ui-scene-3d.png).

**Not tested here:** opening the GLB in Blender, Windows 3D Viewer, ArcGIS Pro or CesiumJS (the Khronos validator is
the stand-in for them); a GPU (all WebGL here is software); phones and touch (pinch is implemented, not
exercised); the desktop app's WebKitGTK and WebView2 webviews.

**Cosmetic issue, fixed in 1.6.0:** footprints traced from LiDAR rasters had slightly zig-zag edges. Each wall segment is lit
by its own direction, so long walls showed faint vertical bands in the picture (see the hall in `52-…`). The scene now
straightens cell-sized zig-zags before extrusion (Douglas–Peucker at up to 1.2 m, then a merge of nearly collinear
vertices, keeping the area within 15 %).

## 20. Spatial statistics

Release 1.6.0 adds native hot spot analysis and automatic kriging ([AUTOMATION.md §6e](../docs/AUTOMATION.md#6e-spatial-statistics-built)).
`scripts/test-stats.py` runs both from the command line on data with known answers, then recomputes everything in R
(spdep 1.3-5, gstat 2.1.6, sf 1.0-19) on the same 2-core machine.

**Hot spots: 1,120 incidents with three planted clusters** (`scripts/data-sample-incidents.py`: 700 spread evenly over
Lae plus 170, 140 and 110 around three centres, σ 210–300 m)

| What | Result |
|---|---|
| Aggregation | **604 hexagons of 211 m**: twice the larger of the average (105 m) and median (82 m) nearest-neighbour distance; 12 locational outliers ignored for the sizing |
| Scale | Incremental spatial autocorrelation from 227 m in steps of 227 m: first peak at **680 m** (Moran's I z = 24.5) |
| Hot spots | **111 hot cells (≥ 90 %, FDR); every planted centre lies in a 99 % cell; no hot cell is farther than 2σ + the band from a planted centre.** No cold spots: empty cells are left out, as in ArcGIS without a study-area boundary |
| Speed | 0.04 s for the step; 0.37 s for the whole recipe with process start (map PNG/SVG/PDF and report) |
| vs R spdep | Gi* equals `localG` (`include.self`, binary weights) to 5 × 10⁻⁷, the six decimals the output keeps. Global Moran's I equals `moran.test` (randomisation) to 10⁻¹⁴, its z to 10⁻¹². Each of the 10 distances in the search matches |
| Values mode (pH at 60 samples) | 33 hot and 22 cold samples (the pH trend), band 3.4 km; Gi* and Moran's I equal spdep's in the same way |
| One million points (`synthetic.points`: 70 % in clusters around five towns) | 6,218 cells, band 17.4 km (first peak), 1,244 hot / 4,437 cold: **2.2 s** for the step |

**Kriging: pH at 60 field samples** (a smooth trend plus noise, sd 0.12; the true surface is known)

| What | Result |
|---|---|
| Variogram | 15 lags to 4.0 km, identical to gstat's `variogram()`: same pair counts, γ to 2 × 10⁻¹⁵ |
| Fit | Spherical, which is also gstat's pick among Sph/Exp/Gau: nugget 0.0041, partial sill 0.526, range 38 km. That is far beyond the data, so the report calls it a trend. Weighted SSE 1.83 × 10⁻⁸ against 2.00 × 10⁻⁸ for gstat's `fit.variogram`, both computed in R: **8 % better** |
| Kriging | All 60 samples; 320 columns of 33 m cells, 54,390 inside the hull. Predictions and standard errors equal gstat's `krige()` to 7.7 × 10⁻⁸ and 1.1 × 10⁻⁷ relative (the output is float32) |
| Cross-validation | Kriging RMSE 0.106, MAE 0.075, mean error 0.006, RMSSE 0.82; equals `krige.cv()` to 10⁻¹¹. IDW was best at power 3, with RMSE 0.147, so **kriging is chosen** |
| Against the truth (300 cells) | **Kriging 0.082, IDW 0.170: 52 % lower** |
| Speed | 0.19 s for the step: variogram, three fits, cross-validation of both methods, 54,000 predictions with standard errors. 1.0 s for the recipe with two maps and the report |

**Kriging: a stationary random field** (400 samples of a Gaussian random field: covariance exp(−h²/2ℓ²), ℓ = 900 m,
sd 2, measurement nugget 0.15²)

| What | Result |
|---|---|
| Fit | **Gaussian**, the true family. Practical range 2.49 km (true 2.20 km). Weighted SSE 7.77 × 10⁻⁵ against 8.73 × 10⁻⁵ for gstat's own fit |
| Kriging | The 32 nearest samples per prediction. Equals gstat's `krige(nmax = 32)` to 2.5 × 10⁻⁷ and `krige.cv(nmax = 32)` to 10⁻¹⁰ |
| Accuracy | Cross-validation RMSE 0.185 against IDW's 0.313; against the truth 0.118 (the field's sd is 2) |
| Honesty | RMSSE 2.0. The fitted nugget (0.006) is a quarter of the true 0.0225, so the standard errors are twice too small; gstat's fit does the same (nugget 0.013). The report now says so whenever the RMSSE is outside 0.67–1.5, and says to read the uncertainty map as relative |

| What | Result |
|---|---|
| `scripts/test-stats.py` | **39 checks in 36 s** (planted clusters found, none invented; Gi*, Moran's I and the whole distance search equal to spdep; variogram, fit, kriging and cross-validation equal to or better than gstat, for global and 32-neighbour kriging; kriging beats IDW against the known surfaces) |
| Engine unit tests | 89 (+11): grid index against brute force; normal tail and Benjamini–Hochberg on a textbook list; Gi* by hand; Moran's I of a gradient (I > 0.8) and a checkerboard (I = −1); variogram fit recovering a known model; kriging exact at samples, weights summing to 1, Dubrule's closed-form cross-validation equal to refits; distance search finding planted clusters; polygon centroid with a hole; report chart parses; zig-zag building outlines straightened |
| `scripts/test-automation.py` | **235 checks** (the 15 gallery recipes: the hot spot map's 111 hot cells and their Moran's I, the kriged surface with its standard-error map; all trigger types incl. stac, webhook, sensor threshold + cooldown, geofence, MQTT through Mosquitto, raster API, safety) |
| Full suite | `test-all.sh` **13/13 in 9 min 30 s** (spatial statistics is the 12th part) |
| Binary size | `geospax-server` 21.4 MB (the neighbour index, variogram fitting, kriging, cross-validation and report charts); `.deb` 12.7 MB; Windows installer 41.7 MB, portable ZIP 59.3 MB |
| Packages | `.deb` install test **15/15** (the installed CLI lists 15 gallery recipes, makes the LiDAR terrain and the 3D scene); Windows installer under Wine **21/21** (new: the Windows build writes the kriged surface and its standard error as GeoTIFFs, and the hot spots as a GeoPackage, [`38-windows-wine-web-ui.png`](screenshots/38-windows-wine-web-ui.png)) |

**Bugs found on the way:**
- **The grey that wasn't there.** "Not significant" cells were drawn in a near-white that matched the land colour, so
  the map seemed to show only the hot spots. They are now a visible light grey.
- **Frames cut surfaces.** The page layout that fills the frame with a DEM cropped the kriged surface, whose edges follow
  the samples' hull. Hull-clipped surfaces are now shown whole. The grid also had to grow: the hull, enlarged by 6 %
  and half a cell, reached past it.
- **Ties at the band.** Hexagon centres sit on a lattice, so dozens of neighbour pairs lie exactly at the automatic
  distance band. A rounding error would decide whether they count, so a 10⁻⁹ relative slack makes "within the band"
  include them deterministically. The R cross-check gives spdep the same band with a 10⁻⁶ slack.
- **Two wrong test expectations, not bugs.** z = −3 (p = 0.0027) is not a 99 % hot spot among ten tests after the FDR
  correction (the cut-off is 0.002), and Rust rounds 1234.5 to even.

Screenshots: the hot spot map, [`55-hotspot-map.png`](screenshots/55-hotspot-map.png), and its report,
[`53-hotspot-report.png`](screenshots/53-hotspot-report.png); the kriged surface,
[`56-kriging-map.png`](screenshots/56-kriging-map.png), its uncertainty map,
[`57-kriging-uncertainty.png`](screenshots/57-kriging-uncertainty.png), and the report with the variogram chart,
[`54-kriging-report.png`](screenshots/54-kriging-report.png).

**Not tested here:** real incident data (the planted clusters are synthetic; the method follows ArcGIS's documentation
and the statistics match spdep, but ArcGIS itself was not run for comparison); study areas where empty cells matter
(no boundary option yet); anisotropic or trending fields beyond the pH example.
