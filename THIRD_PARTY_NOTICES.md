# Third-party notices

GeoSpaX is dual-licensed under **MIT** or **Apache-2.0** (your choice): see
[`LICENSE-MIT`](LICENSE-MIT) and [`LICENSE-APACHE`](LICENSE-APACHE).

This file records the open-source projects GeoSpaX depends on, learns from, or
acknowledges — including the two the workbench UI was modelled on.

---

## 1. Runtime dependencies (vendored by the build)

* **Rust crates** — every direct dependency is listed in
  [`Cargo.toml`](Cargo.toml); `cargo tree` prints the full graph with licences.
  Notable ones: `axum`, `tokio`, `serde`/`serde_json`, `gdal`, `arrow`, `geo`,
  `rusqlite`, `image`, `dhat`/`mimalloc` (feature-gated), `tauri`, `tract-onnx`
  (Sonos; MIT or Apache-2.0: runs ONNX models you add, docs/AI.md §4).
* **JavaScript** — [`web/package.json`](web/package.json): MapLibre GL JS
  (BSD-3-Clause), deck.gl (MIT), Apache Arrow JS (Apache-2.0), terra-draw and its MapLibre adapter
  (MIT, drawing and vertex editing), Vite (MIT),
  TypeScript (Apache-2.0), Playwright (Apache-2.0, dev only).
* **GeoLibre tools plugin** (`plugins/geolibre-tools/`) — downloads, on first use, the `geolibre-wasm`
  1.7.1 tool runner (MIT; opengeos/geolibre-rust, built on whitebox_next_gen by John Lindsay, MIT) from
  the npm registry and verifies its SHA-512. It is not redistributed in this repository or the installers.
* **Fonts** — DejaVu Sans (Book, Bold, Oblique, Bold Oblique; Bitstream Vera licence with DejaVu changes,
  public domain), as MapLibre glyph files in `web/public/fonts/` (made with fontnik 0.7.7) and embedded in
  the engine (`crates/engine/fonts/`) for exported maps. Licence: `web/public/fonts/LICENSE-DejaVu.txt`.
* **Data at runtime** — Natural Earth (public domain) for the sample layers and the bundled offline basemap
  (`web/public/basemap/`: 1:50m land, lakes and admin-0 boundary lines, coordinates rounded to 0.001°).
* **Online data fetched on request** (nothing is redistributed; each result carries its citation) —
  GEBCO 2026 Grid (public domain, not for navigation), Hansen Global Forest Change v1.13 (CC-BY 4.0,
  Hansen/UMD/Google/USGS/NASA), RESOLVE Ecoregions 2017 (CC-BY 4.0, Dinerstein et al. 2017) and the World
  Register of Marine Species (CC-BY 4.0, WoRMS Editorial Board), alongside the earlier WorldClim, CHELSA,
  SoilGrids, GBIF, OBIS, iNaturalist, GADM (non-commercial), Copernicus DEM and AlphaEarth sources.

Licence texts for the big ones are reproduced below where their terms require it.

---

## 2. RustGIS — design and architecture reference

> RustGIS · <https://github.com/opengeos/RustGIS> · **Apache License 2.0** ·
> Copyright the RustGIS contributors.

The 1.7 workbench borrows, with attribution and re-implemented in TypeScript:

| Borrowed from RustGIS | Where it appears in GeoSpaX |
| --- | --- |
| "Everything is a command": one registry that the ribbon, keyboard and scripts all call | `web/src/commands.ts` — `Command` records with `id`, `tab`, `group`, `keys`, `run(host)` |
| Ribbon vocabulary: Home · Data · Style · Analyze · View · Publish/Share | `web/src/commands.ts` → `TABS` (`home`, `data`, `style`, `analyze`, `view`, `automate`, `help`) |
| Panes as first-class docks around a map that owns the middle | `web/src/workbench.ts`, `web/index.html` (`#dock-left`, `#center`, `#dock-right`, `#dock-bottom`) |
| Commands never open a modal themselves; the shell decides | every `run()` in `commands.ts` calls `showTab()`/`setStatus()`/`log()` instead of rendering UI |
| Plugin model: manifest + sandboxed WASM module, hashed packages, permissions, commands callable from ribbon/palette/CLI | GeoSpaX 1.8 `crates/engine/src/plugins.rs` — `plugin.yaml`, `--plugins DIR`, `plugins list/check/import` |
| Honest degradation: a plugin whose runtime is missing is listed with `needs: …` rather than dropped | `PluginInfo.runnable` / `PluginInfo.needs`, shown in the Plugins pane |

**No RustGIS source file was copied.** GeoSpaX's shell is TypeScript rendered in
a browser/Tauri webview; RustGIS's is Rust/egui. The items above are
architectural patterns, re-implemented against GeoSpaX's own engine API.

Apache-2.0 requires that derivative works state the changes: the table above is
that statement. The full Apache-2.0 text ships as [`LICENSE-APACHE`](LICENSE-APACHE)
and at <http://www.apache.org/licenses/LICENSE-2.0>.

---

## 3. GeoLibre — feature and UI reference

> GeoLibre · <https://github.com/opengeos/GeoLibre> · **MIT License** ·
> Copyright (c) 2025–2026 Qiusheng Wu and the GeoLibre contributors.

GeoLibre (Tauri v2 + React + MapLibre GL JS + DuckDB-WASM, ~1,000 Whitebox
geoprocessing tools in WASM) was studied as the reference for what a modern,
permissively-licensed desktop GIS puts on screen. It shaped GeoSpaX 1.7's

* pane set — catalog/contents on the left, symbology + attribute table on the
  right, automation/history/log along the bottom, map in the middle;
* the decision to make the **attribute table** a peer of the map rather than a
  dialog (including paging, field list and a chart view);
* the expectation that styling, labelling and layer order are dockable, not modal.

The GeoSpaX plugin runtime also follows **GeoLibre's** WASI tool contract
([geolibre-rust](https://github.com/opengeos/geolibre-rust)): tools take arguments and
read/write files under a sandbox directory (`/work`), which is why the same WASM
tool can be driven by either app.

**No GeoLibre source file was copied** — GeoSpaX renders with its own
server-side tile pipeline (MapLibre + GeoArrow/Arrow IPC) and its own automation
engine in Rust, not DuckDB-WASM or Whitebox.

MIT notice, reproduced as its terms require:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 4. Other acknowledgements

* **ArcGIS Pro** (Esri, proprietary) — the *look* users expect from a desktop
  GIS. Only its conventions (ribbon, docked panes, status bar, scale readout,
  Ctrl+K-style command search) are mirrored; no Esri code, asset or icon is
  included, and none of its file formats are implemented.
* **QGIS** — GeoSpaX runs a QGIS plugin's **processing algorithms** through the documented
  `qgis_process` CLI (`list`/`help`/`run --json`). Its PyQt interface cannot be hosted, and the
  Plugins pane says so.
* **ArcGIS Pro** — GeoSpaX imports an add-in's ribbon from `Config.daml` and runs its **Python
  toolbox** (`.pyt`) tools through arcpy. The compiled .NET assembly cannot run (no CLR) and this
  is reported on the plugin's card.
* **GRASS GIS**, **SAGA GIS**, **MapInfo**, **ERDAS Imagine** — the
  analysis vocabulary GeoSpaX's recipes and terrain/remote-sensing steps follow.
* **MapLibre GL JS** (BSD-3-Clause) and **deck.gl** (MIT) render the map; the
  attribution control in the app lists the data sources.

---

## 5. If you reuse GeoSpaX

You may copy, modify and redistribute it under MIT or Apache-2.0. If you carry
the workbench forward, keep this file (or an equivalent NOTICE) with the
attributions in sections 2–4 intact.


## GSX tools (plugins/gsx)

The analysis code and tests come from **GeoSpaX 2.0** (`@geospax/analysis`, https://github.com/jm0535/GeoSpaX)
and **GeoSpaX 1.4.2** (https://github.com/jm0535/map-kit), © J. Moses, MIT License. The built
`plugins/gsx/run.mjs` bundles **Turf** (© Morgan Herlocker and contributors, MIT) and **proj4js**
(© Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral, Calvin Metcalf and contributors, MIT).
The GeoSpaX logo is the GeoSpaX 2.0 logo.
