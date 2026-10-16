# Plugins

A GeoSpaX **plugin** is a folder with a **manifest** and one or more **tools**. Tools land on the
**Analyze** ribbon tab and in the **Plugins** pane (bottom dock); commands land on the ribbon and in
the command palette (`Ctrl+K`).

The point of the design: GeoSpaX reads the manifest formats of the four ecosystems people already
write for, so the same tool works whether it was authored for GeoSpaX, **RustGIS**, **GeoLibre**,
**QGIS** or **ArcGIS Pro**. Where a tool cannot run here, GeoSpaX says so instead of pretending.

---

## 1. What is compatible with what

| Ecosystem | What it is | Manifest GeoSpaX reads | Runs? |
| --- | --- | --- | --- |
| **GeoSpaX** | folder with `plugin.yaml` | `plugin.yaml` / `plugin.yml` | ✅ fully — `process`, `python`, `r`, `wasm`, `recipe` |
| **RustGIS** ([opengeos/RustGIS](https://github.com/opengeos/RustGIS), Apache-2.0) | `.rgplugin` = zip of `plugin.json` + `plugin.wasm` | `plugin.json` (`commands`, `tools`, `params`, `permissions`) | ✅ the WASM module, through a WASI runner (`wasmtime`/`wasm3`/`deno`) |
| **GeoLibre** ([opengeos/GeoLibre](https://github.com/opengeos/GeoLibre), MIT) | TS/React plugin (`plugin.json`) + WASM tool bundles ([geolibre-rust](https://github.com/opengeos/geolibre-rust), WASI over `/work`) | `plugin.json`, `tools.mjs` | ✅ its **tools** (same WASI contract); ❌ its UI (React components) |
| **QGIS** | Python plugin; `metadata.txt` + `__init__.py` | `metadata.txt` (`hasProcessingProvider=yes`) | ✅ its **processing algorithms**, through `qgis_process list/help/run --json`; ❌ its PyQt UI |
| **ArcGIS Pro** | `.esriAddInX` = zip of `Config.daml` + .NET assembly (+ `Toolboxes/*.pyt`) | `Config.daml`, `*.pyt` | ✅ **Python toolbox (`.pyt`) tools** through `python3` + arcpy; ❌ the .NET assembly (no CLR) |

**Honest limits**

- A QGIS *UI* plugin drives the QGIS GUI through PyQt — there is no way to host it. Its
  **processing algorithms** are a clean CLI contract (`qgis_process`), and those we run.
- An ArcGIS Pro add-in's buttons are .NET (`ProAppModule.dll`). We import the **ribbon declaration**
  (tabs, groups, buttons from `Config.daml`) and can execute **Python toolbox** tools; the compiled
  tool bodies have to be ported. GeoSpaX labels them `needs arcpy` / "the .NET assembly cannot run"
  rather than silently dropping them.
- RustGIS plugins are WASM and sandboxed; GeoSpaX runs the same module with the same JSON contract,
  so a `.rgplugin` is portable between the two apps. Its `permissions` are respected: `edit` is
  required before a plugin may change the project, `files` before it may name a file.

---

## 2. Plugin folders

```
<state>/.geospax/plugins/     always read (state = the first --data folder)
--plugins DIR                 extra folder (repeatable)
~/GeoSpaX/plugins             the installed desktop app reads this too
```

`geospax-server plugins list` prints what it found:

```
example-python         native     python    2 tool(s)  runnable
field-recipes          native     recipe    2 tool(s)  runnable
hello-rustgis          rustgis    wasm      1 tool(s)  needs plugin.wasm next to plugin.json
save_attributes        qgis       process   0 tool(s)  needs qgis_process
Field Tools            arcgis     python    1 tool(s)  needs arcpy (for .pyt tools)
```

---

## 3. Writing a GeoSpaX plugin

`plugin.yaml`:

```yaml
plugin: example-python          # id: lowercase, no spaces
version: 0.1.0
title: Example Python tools
description: Two tools that show the contract.
author: You
license: MIT
homepage: https://example.com
kind: python                    # process | python | r | wasm | recipe
run: python3 ${plugin}/tools.py ${tool}
tools:
  - id: layer-report
    name: Layer report
    summary: Row count, field list and a value count for one layer.
    group: Example               # ribbon group / toolbox name
    icon: chart                  # any icon name in web/src/commands.ts ICONS
    params:
      - { name: layer, label: Layer, kind: layer, required: true }
      - { name: field, label: Count values of, kind: field }
  - id: point-grid
    name: Point grid
    summary: Hexagon or square grid over a layer's extent.
    group: Example
    icon: grid
    params:
      - { name: layer, label: Over, kind: layer, required: true }
      - { name: size, label: Cell size (m), kind: number, default: 500, required: true }
      - { name: shape, label: Shape, kind: choice, default: hex, choices: [hex, square] }
commands:                        # optional ribbon buttons
  - { id: about, title: About this plugin, icon: check, group: Example }
```

Parameter `kind`: `number` · `text` · `bool` · `layer` · `field` · `file` · `choice`.
`${plugin}` expands to the plugin folder, `${tool}` to the tool id, `${workdir}` to a scratch dir.

### Run-time contract

GeoSpaX runs `run:` with this JSON on **stdin**:

```json
{ "plugin": "example-python", "tool": "layer-report",
  "params": { "layer": "field_samples.geojson", "field": "land_use" },
  "layers": ["field_samples.geojson", "incidents.geojson"],
  "workdir": "/tmp/geospax-plugin-work" }
```

and expects **JSON on stdout**:

```json
{ "ok": true, "message": "report for field_samples.geojson", "artifacts": ["…/out.geojson"] }
```

A non-zero exit turns the first line of stderr into the error shown in the Plugins pane. That is the
whole ABI, so the same plugin shape works for a Rust binary, an R script
(`run: Rscript ${plugin}/tools.R ${tool}`) or a WASI module
(`run: wasmtime run --dir ${workdir} ${plugin}/tools.wasm -- ${tool}`).

`kind: recipe` plugins ship ordinary GeoSpaX recipes in `recipes/` and their tools run through the
automation engine — so they get triggers, run history, artifacts and Auto switches for free
(see [`plugins/field-recipes`](../plugins/field-recipes)).

---

## 4. Installing plugins

- **UI:** bottom dock › **Plugins** › paste a folder or package path › **Install**.
- **CLI:** `geospax-server plugins import ./my-plugin [--dir PLUGINDIR]`,
  `plugins list`, `plugins check ./my-plugin`.
- Packages (`.rgplugin`, `.esriAddInX`, `.zip`) are unpacked into the plugin folder. Members are
  size-limited (64 MB), `../` and absolute paths are rejected, and the executable bit is preserved.
- Package files that are *not* installed are still listed (read-only, from inside the zip) so you can
  see what is in them before installing.

---

## 5. HTTP API

| Route | What |
| --- | --- |
| `GET /api/plugins` | `{plugins, runtimes, dirs}` — installed plugins and which runtimes this machine has |
| `POST /api/plugins/reload` | re-scan the plugin folders |
| `POST /api/plugins/import` | `{"path": "…"}` → install a folder or package |
| `GET /api/plugins/{id}` | one plugin |
| `POST /api/plugins/{id}/tools/{tool}/run` | `{"params": {…}}` → run a tool |

---

## 6. Credits

The plugin model follows **RustGIS** (`docs/plugins.md`, Apache-2.0): a manifest plus a sandboxed
WASM module, hash-pinned packages, permissions, and commands that the ribbon, the palette and the
CLI all call. The WASI "tools over `/work`" contract follows **GeoLibre**'s `geolibre-rust` tool
runner (MIT). QGIS and ArcGIS Pro compatibility uses their public, documented CLI surfaces
(`qgis_process`, Python toolboxes). See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
