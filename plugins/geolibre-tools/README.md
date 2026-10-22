# GeoLibre tools for GeoSpaX

1,062 raster, vector, LiDAR, hydrology, terrain and conversion tools from
[GeoLibre](https://github.com/opengeos/GeoLibre) (the `geolibre-wasm` tool runner of
[opengeos/geolibre-rust](https://github.com/opengeos/geolibre-rust), built on John Lindsay's
[whitebox_next_gen](https://github.com/jblindsay/whitebox_next_gen)), running locally in GeoSpaX.

- **Built in:** GeoSpaX shows them as its own tools, filed in the **Toolbox** by task (Analysis,
  Conversion, Spatial Statistics, Raster Analysis, Terrain, Hydrology, Image Analysis, LiDAR and 3D …,
  from the runner's own category and subcategory; `gen.mjs` holds the mapping). Search by name, or by
  what ArcGIS Pro / QGIS call the job.
- **Inputs:** a vector parameter is a layer on the map; raster, LiDAR and table parameters take a
  file path. **Outputs** go to `<state>/plugin-results/geolibre-tools/` and are added to the map.
- **Needs** [Node.js](https://nodejs.org) 18+ (the runner is WebAssembly, run with Node's WASI).
- **First use** downloads the runner once (`geolibre-wasm` 1.7.1 from the npm registry, about 9 MB,
  checked against its published SHA-512) into `~/.cache/geospax/`. Offline machines: run
  `node run.mjs --fetch` where there is internet and copy the cache, put `geolibre-cli.wasm` next to
  this file, or set `GEOSPAX_GEOLIBRE_WASM=/path/to/geolibre-cli.wasm`.

| File | What it is |
|---|---|
| `plugin.yaml` | The GeoSpaX manifest: every tool with its form (generated) |
| `tools.json` | Parameter roles and output types for the runner (generated) |
| `run.mjs` | The plugin contract: JSON request on stdin, JSON answer (with `outputs`) on stdout |
| `runtime.mjs` | Finds, fetches and verifies `geolibre-cli.wasm`; runs it under WASI |
| `gen.mjs` | Regenerates `plugin.yaml` and `tools.json` from the runner's own manifests |

Upgrading GeoLibre: change `VERSION` and `INTEGRITY` in `runtime.mjs` (the `dist.integrity` of
`https://registry.npmjs.org/geolibre-wasm/<version>`), then run `node gen.mjs`.

The tools are MIT-licensed (GeoLibre, geolibre-rust, whitebox_next_gen); this plugin is
MIT like GeoSpaX.
