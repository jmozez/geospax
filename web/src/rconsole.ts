// The R tab (docs/R.md): R setup (find R, install R and package kits into GeoSpaX's own library)
// and the R console, which runs R code against layers and rasters on the map. Each run is a one-step
// recipe ("r-console", replaced each time) using the engine's r step, so it has run history and its
// method in the report. sf layers come in as `layer`, rasters as terra `raster`; what the code
// returns comes back: sf → layers, SpatRaster → rasters, ggplot/tmap → figures, data frames → tables.
// The templates are full, editable R: "show me the code" is the point.
import { bytesText, etaText } from './downloads';
import type { Transfer } from './automate';
import type { Backend } from './backend';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const R_RECIPE = 'r-console';

export interface RHost {
  backend: Backend;
  layers: () => string[];
  rasters: () => Promise<string[]>;
  run: (recipe: string) => Promise<void>;
  setStatus: (t: string, ms?: number) => void;
}

interface Template {
  title: string;
  lead: string;
  needs: ('layer' | 'raster')[];
  packages: string[];
  code: string;
}

export const TEMPLATES: Record<string, Template> = {
  // Every template follows the tidyverse style guide: the native pipe |>, dplyr / purrr verbs,
  // snake_case names, .data[[...]] for a field chosen at run time, one step per line, ggplot2 for
  // charts (the theme and palette chosen in Settings are already set by GeoSpaX, see sidecar.rs).
  blank: {
    title: 'R console',
    lead: 'Any R code. `layer` is the chosen layer (sf), `raster` the chosen raster (terra). Return a named list: sf → layers, SpatRaster → rasters, ggplot/tmap → figures, data frames → tables.',
    needs: [],
    packages: [],
    code: `# layer (sf) and raster (terra) are the inputs chosen above
# save_figure("name", plot), save_table("name", df), result(key = value)
layer |>
  sf::st_drop_geometry() |>
  dplyr::glimpse()
`,
  },
  chart: {
    title: 'ggplot2 chart',
    lead: 'A chart of a field with ggplot2 (histogram for numbers, bar chart for categories) in the theme and palette chosen in Settings, saved as PNG, PDF and SVG.',
    needs: ['layer'],
    packages: ['ggplot2', 'dplyr', 'sf'],
    code: `library(ggplot2)
library(dplyr)

attributes <- sf::st_drop_geometry(layer)
field <- attributes |>
  select(where(is.numeric)) |>
  names() |>
  dplyr::first()                                  # or e.g. "elevation"

chart <- attributes |>
  filter(!is.na(.data[[field]])) |>
  ggplot(aes(x = .data[[field]])) +
  geom_histogram(bins = 30) +
  labs(title = paste("Distribution of", field), x = field, y = "count")

save_figure("chart", chart, width = 160, height = 120, dpi = 300, formats = c("png", "pdf", "svg"))
`,
  },
  tmap: {
    title: 'tmap map',
    lead: 'A thematic map of a layer with tmap: classed fill, legend, north arrow and scale bar, saved at print size (PNG and PDF).',
    needs: ['layer'],
    packages: ['tmap', 'sf', 'dplyr'],
    code: `library(tmap)
library(dplyr)

field <- layer |>
  sf::st_drop_geometry() |>
  select(where(is.numeric)) |>
  names() |>
  first()                                         # or e.g. "population"
is_point <- layer |>
  sf::st_geometry_type(by_geometry = FALSE) |>
  as.character() |>
  grepl(pattern = "POINT")
fill_scale <- tm_scale_intervals(style = "jenks", values = "viridis")

map <- tm_shape(layer) +
  (if (is_point) {
    tm_dots(fill = field, size = 0.4, fill.scale = fill_scale)
  } else {
    tm_polygons(fill = field, fill.scale = fill_scale, fill.legend = tm_legend(title = field))
  }) +
  tm_compass(position = c("right", "top")) +
  tm_scalebar(position = c("left", "bottom")) +
  tm_layout(frame = FALSE, legend.outside = TRUE)

save_figure("tmap_map", map, width = 180, height = 140, dpi = 300)
`,
  },
  ggplot: {
    title: 'ggplot2 map',
    lead: 'A ggplot2 map (geom_sf) with a scale bar and north arrow from ggspatial, in the theme chosen in Settings, saved at print size.',
    needs: ['layer'],
    packages: ['ggplot2', 'ggspatial', 'sf', 'dplyr'],
    code: `library(ggplot2)
library(dplyr)

field <- layer |>
  sf::st_drop_geometry() |>
  select(where(is.numeric)) |>
  names() |>
  first()

map <- layer |>
  ggplot() +
  geom_sf(aes(fill = .data[[field]], colour = .data[[field]]), linewidth = 0.2) +
  scale_fill_viridis_c(guide = "none") +
  scale_colour_viridis_c(name = field) +
  ggspatial::annotation_scale(location = "bl") +
  ggspatial::annotation_north_arrow(location = "tr", style = ggspatial::north_arrow_minimal())

save_figure("ggplot_map", map, width = 180, height = 140, dpi = 300)
`,
  },
  rayshader: {
    title: 'rayshader relief',
    lead: 'Shaded relief from an elevation raster with rayshader (sphere shading, ray-traced shadows, ambient occlusion).',
    needs: ['raster'],
    packages: ['rayshader', 'terra'],
    code: `library(rayshader)

dem <- raster[[1]]
elevation <- raster_to_matrix(dem)
# vertical exaggeration: cell size in metres / 10
metres_per_unit <- if (terra::is.lonlat(dem)) 111320 else 1
z_scale <- max(1, mean(terra::res(dem)) * metres_per_unit) / 10

save_figure("relief", function() {
  elevation |>
    sphere_shade(texture = "imhof1") |>
    add_shadow(ray_shade(elevation, zscale = z_scale), 0.5) |>
    add_shadow(ambient_shade(elevation, zscale = z_scale), 0) |>
    plot_map()
}, width = 180, height = 140, formats = "png")
# 3D: plot_3d(...) then render_snapshot(figure_path("relief_3d")) (needs OpenGL)
`,
  },
  terrain: {
    title: 'terra terrain',
    lead: 'Slope, aspect, hillshade and terrain ruggedness from an elevation raster with terra, with a summary table.',
    needs: ['raster'],
    packages: ['terra', 'dplyr', 'tibble'],
    code: `library(dplyr)

dem <- raster[[1]]
derived <- terra::terrain(dem, v = c("slope", "aspect", "TRI"), unit = "degrees")
hillshade <- terra::shade(
  slope = terra::terrain(dem, "slope", unit = "radians"),
  aspect = terra::terrain(dem, "aspect", unit = "radians")
)

terrain_stats <- tibble::tibble(
  layer = names(derived),
  mean = terra::global(derived, "mean", na.rm = TRUE)[[1]],
  max = terra::global(derived, "max", na.rm = TRUE)[[1]]
) |>
  mutate(across(c(mean, max), \\(x) round(x, 2)))

list(
  slope = derived[["slope"]],
  aspect = derived[["aspect"]],
  ruggedness = derived[["TRI"]],
  hillshade = hillshade,
  terrain_stats = terrain_stats
)
`,
  },
  biomod2: {
    title: 'biomod2 ensemble SDM',
    lead: 'An ensemble species distribution model with biomod2: occurrence points + environmental rasters (e.g. WorldClim from Data › Climate), pseudo-absences, GLM + random forest + MaxNet, TSS-weighted ensemble.',
    needs: ['layer', 'raster'],
    packages: ['biomod2', 'terra', 'sf', 'dplyr'],
    code: `library(biomod2)
library(dplyr)

presence_xy <- layer |>
  sf::st_transform(terra::crs(raster)) |>
  sf::st_coordinates()

model_data <- BIOMOD_FormatingData(
  resp.var = rep(1, nrow(presence_xy)), expl.var = raster, resp.xy = presence_xy,
  resp.name = "species", PA.nb.rep = 1, PA.nb.absences = 1000, PA.strategy = "random"
)
models <- BIOMOD_Modeling(
  model_data, models = c("GLM", "RF", "MAXNET"), CV.strategy = "random",
  CV.nb.rep = 2, CV.perc = 0.8, metric.eval = c("TSS", "ROC"), var.import = 2
)
ensemble <- BIOMOD_EnsembleModeling(
  models, em.by = "all", em.algo = "EMwmean",
  metric.select = "TSS", metric.select.thresh = 0.5, metric.eval = c("TSS", "ROC")
)
projection <- BIOMOD_EnsembleForecasting(ensemble, proj.name = "current", new.env = raster)

suitability <- terra::rast(get_predictions(projection))[[1]] / 1000
evaluation <- get_evaluations(models) |>
  as_tibble()
importance <- get_variables_importance(models) |>
  as_tibble() |>
  group_by(expl.var) |>
  summarise(importance = mean(var.imp), .groups = "drop") |>
  arrange(desc(importance))

list(suitability = suitability, evaluation = evaluation, importance = importance)
`,
  },
  maxent: {
    title: 'MaxEnt (maxnet)',
    lead: 'MaxEnt with maxnet: presences from a point layer, 5,000 background points from the rasters, cloglog suitability.',
    needs: ['layer', 'raster'],
    packages: ['maxnet', 'terra', 'sf', 'dplyr'],
    code: `library(maxnet)
library(dplyr)

presence <- layer |>
  sf::st_transform(terra::crs(raster)) |>
  terra::vect() |>
  terra::extract(x = raster, ID = FALSE) |>
  mutate(presence = 1)
background <- raster |>
  terra::spatSample(5000, "random", na.rm = TRUE, values = TRUE) |>
  mutate(presence = 0)
training <- bind_rows(presence, background) |>
  tidyr::drop_na()

predictors <- select(training, -presence)
fit <- maxnet(training$presence, predictors, maxnet.formula(training$presence, predictors, classes = "lqh"))
suitability <- terra::predict(raster, fit, type = "cloglog", na.rm = TRUE)

result(presences = sum(training$presence == 1), background = sum(training$presence == 0))
list(suitability = suitability)
`,
  },
  tidymodels: {
    title: 'tidymodels random forest',
    lead: 'A random forest with tidymodels: predicts a field of the layer from its other numeric fields, 5-fold cross-validated; predictions come back as a layer.',
    needs: ['layer'],
    packages: ['tidymodels', 'ranger', 'sf'],
    code: `library(tidymodels)

numeric_fields <- layer |>
  sf::st_drop_geometry() |>
  select(where(is.numeric))
target <- names(numeric_fields)[1]               # the field to predict
complete <- stats::complete.cases(numeric_fields)
training <- filter(numeric_fields, complete)

forest_wf <- workflow() |>
  add_formula(stats::reformulate(".", response = target)) |>
  add_model(
    rand_forest(trees = 500) |>
      set_engine("ranger") |>
      set_mode("regression")
  )

set.seed(1)
cv_metrics <- forest_wf |>
  fit_resamples(vfold_cv(training, v = 5), metrics = metric_set(rmse, rsq)) |>
  collect_metrics()
fitted <- fit(forest_wf, training)

predictions <- layer |>
  filter(complete) |>
  mutate(
    predicted = predict(fitted, training)$.pred,
    residual = .data[[target]] - predicted
  )

list(predictions = predictions, cv_metrics = cv_metrics)
`,
  },
  dbplyr: {
    title: 'dbplyr query',
    lead: 'dplyr verbs run as SQL in DuckDB with dbplyr; the SQL is printed below the result.',
    needs: ['layer'],
    packages: ['dplyr', 'dbplyr', 'duckdb', 'sf'],
    code: `library(dplyr)

con <- DBI::dbConnect(duckdb::duckdb())
on.exit(DBI::dbDisconnect(con, shutdown = TRUE))

attributes <- sf::st_drop_geometry(layer)
DBI::dbWriteTable(con, "layer", attributes)
field <- attributes |>
  select(where(is.numeric)) |>
  names() |>
  first()

query <- tbl(con, "layer") |>
  summarise(
    n = n(),
    mean = mean(.data[[field]], na.rm = TRUE),
    max = max(.data[[field]], na.rm = TRUE)
  )

show_query(query)
list(summary = collect(query))
`,
  },
  gee: {
    title: 'Earth Engine (rgee)',
    lead: 'A Sentinel-2 median NDVI for the layer’s extent from Google Earth Engine with rgee. Needs an Earth Engine account (rgee::ee_Initialize() once, in R).',
    needs: ['layer'],
    packages: ['rgee', 'sf', 'terra'],
    code: `library(rgee)

ee_Initialize(quiet = TRUE)
area <- layer |>
  sf::st_transform(4326) |>
  sf::st_bbox() |>
  sf::st_as_sfc() |>
  sf_as_ee()

# Earth Engine objects chain with $ (its own API), not with |>
ndvi <- ee$ImageCollection("COPERNICUS/S2_SR_HARMONIZED")$
  filterBounds(area)$
  filterDate("2024-01-01", "2024-12-31")$
  filter(ee$Filter$lt("CLOUDY_PIXEL_PERCENTAGE", 20))$
  median()$
  normalizedDifference(c("B8", "B4"))

list(ndvi = ee_as_rast(ndvi, region = area, scale = 30))
`,
  },
};

interface RStatus {
  installed: boolean;
  version?: string;
  library?: string;
  kits: { id: string; title: string; packages: string[] }[];
  packages: Record<string, string | null>;
  can_install_r?: boolean;
  install_note?: string;
}

/** Suggestions for Python package names: the geospatial and data-science packages people install most. */
const PY_SUGGEST = ['geopandas', 'shapely', 'pyproj', 'rasterio', 'fiona', 'pyogrio', 'GDAL', 'xarray', 'rioxarray', 'numpy', 'pandas', 'scipy', 'scikit-learn',
  'matplotlib', 'pystac-client', 'planetary-computer', 'stackstac', 'odc-stac', 'duckdb', 'leafmap', 'geemap', 'earthengine-api', 'osmnx', 'networkx', 'momepy',
  'pysal', 'esda', 'libpysal', 'mgwr', 'spopt', 'pointpats', 'h3', 'folium', 'contextily', 'mapclassify', 'cartopy', 'rasterstats', 'whitebox', 'richdem',
  'laspy', 'pdal', 'open3d', 'pyvista', 'scikit-image', 'opencv-python', 'torch', 'torchgeo', 'segment-geospatial', 'samgeo', 'lonboard', 'pydeck', 'plotly',
  'seaborn', 'statsmodels', 'xgboost', 'lightgbm', 'dask', 'dask-geopandas', 'zarr', 'netCDF4', 'cfgrib', 'h5py', 'pyarrow', 'polars', 'geoparquet', 'overturemaps',
  'pygbif', 'requests', 'tqdm', 'jupyterlab', 'ipywidgets'];

interface JobInfo { id: number; status: string; message: string; progress: number; done: number; total: number; log?: string[]; transfer?: (Transfer & { units?: number; planned?: number }) | null }

interface RunOut {
  figures?: Record<string, string[]>;
  tables?: Record<string, { columns: string[]; rows: unknown[][]; total: number }>;
  layers?: Record<string, string>;
  result?: Record<string, unknown>;
  stdout?: string;
}

const table = (t: { columns: string[]; rows: unknown[][]; total: number }) => {
  const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : v == null ? 'NA' : String(v));
  return `<table class="rc-table"><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${t.rows
    .slice(0, 50)
    .map((r) => `<tr>${r.map((v) => `<td>${esc(fmt(v))}</td>`).join('')}</tr>`)
    .join('')}</table>${t.total > 50 ? `<p class="dim">First 50 of ${t.total} rows (all in the CSV).</p>` : ''}`;
};

/** "Rscript (R) version 4.3.3 (2024-02-29)" → "R 4.3.3" */
const rVersion = (v?: string) => (/version (\d[\d.]*)/.exec(v ?? '')?.[1] ? `R ${/version (\d[\d.]*)/.exec(v ?? '')![1]}` : v ?? 'R');

export class RConsole {
  private el: HTMLElement;
  private status: RStatus | null = null;

  constructor(private host: RHost) {
    this.el = document.createElement('div');
    this.el.id = 'rconsole';
    this.el.className = 'modal';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-close]')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close(); // also cancels a window still waiting to open
    });
    document.addEventListener('geospax:r', (e) => {
      const what = String((e as CustomEvent).detail ?? 'blank');
      if (what.startsWith('python:')) return void this.pythonUpdates(what.slice(7));
      void (what === 'setup' ? this.setup() : this.console(what));
    });
  }

  /** Bumped on every open and close: a window still loading when you close it (or open another) stays shut. */
  private seq = 0;

  close() {
    this.seq++;
    this.el.hidden = true;
  }

  private async loadStatus() {
    this.status = await this.host.backend.json<RStatus>('api/r');
    return this.status;
  }

  /** R setup: R itself and package kits, installed into GeoSpaX's own library. */
  private missing: string[] = [];

  /** The kits with each package marked installed (its version) or not. */
  private kitsHtml(s: RStatus, missing: string[]): string {
    const have = (p: string) => !!s.packages[p];
    return s.kits
      .map((k) => {
        const n = k.packages.filter(have).length;
        const all = n === k.packages.length;
        // only kits with something missing that the user needs are ticked: nothing is "installed" twice
        const want = !all && (k.packages.some((p) => missing.includes(p)) || (!missing.length && ['spatial', 'maps', 'stats'].includes(k.id)));
        return `<label class="ck rc-kit ${all ? 'ok' : ''}"><input type="checkbox" name="kit" value="${esc(k.id)}" ${want ? 'checked' : ''} ${all ? 'disabled' : ''} />
        <span><b>${esc(k.title)}</b> <span class="dim">${all ? '✓ installed' : `${n} of ${k.packages.length} installed`}</span><br /><small class="dim">${k.packages
          .map((p) => `<span class="${have(p) ? 'rc-have' : 'rc-miss'}" title="${have(p) ? `${esc(p)} ${esc(s.packages[p])}` : 'not installed'}">${have(p) ? '✓' : '○'} ${esc(p)}</span>`)
          .join(' · ')}</small></span></label>`;
      })
      .join('');
  }

  /** Re-read what is installed and redraw the kit list (after an install). */
  private async refreshPackages() {
    const s = await this.loadStatus().catch(() => null);
    const list = this.el.querySelector<HTMLElement>('.rc-kitlist');
    if (s && list) list.innerHTML = this.kitsHtml(s, this.missing);
  }

  async setup(missing: string[] = []) {
    this.el.innerHTML = `<div class="sheet fin rc"><header><b>R setup</b><button type="button" data-close aria-label="Close">✕</button></header><div class="body"><p class="dim">Checking for R…</p></div></div>`;
    this.el.hidden = false;
    let s: RStatus;
    try {
      s = await this.loadStatus();
    } catch (err) {
      this.body(`<p class="err">${esc((err as Error).message ?? err)}</p>`);
      return;
    }
    this.missing = missing;
    const extra = missing.filter((p) => !s.kits.some((k) => k.packages.includes(p)));
    this.body(`
      <p class="fin-lead">${
        s.installed
          ? `<b>${esc(rVersion(s.version))}</b> is installed. Packages GeoSpaX installs go into its own library, so your R setup is not changed.`
          : s.can_install_r
            ? 'R is not installed on this computer. GeoSpaX can install it now (the official CRAN build), then the packages you tick.'
            : `R is not installed. ${esc(s.install_note ?? '')}`
      }</p>
      <form class="rc-kits"><div class="rc-kitlist">${this.kitsHtml(s, missing)}</div>
        ${extra.length ? `<label class="ck"><input type="checkbox" name="pkg" value="${esc(extra.join(','))}" checked /> Also: ${esc(extra.join(', '))}</label>` : ''}
        <label><span>Other packages</span><input name="more" list="rc-cran" autocomplete="off" placeholder="Start typing: lidR, landscapemetrics, sdmTMB …" /></label><datalist id="rc-cran"></datalist>
      </form>
      <div class="rc-updates" hidden></div>
      <div class="rc-progress" hidden><div class="rc-bar running" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i><b>0%</b></div><div class="rc-meta"><span class="rc-size"></span><span class="rc-eta"></span></div><span class="dim"></span>
        <pre class="rc-log" aria-live="polite" aria-label="Installation log"></pre></div>
      <p class="dim">Packages are ready-built binaries (CRAN on Windows and macOS, Posit Package Manager on Linux): nothing is compiled. Needs internet.${
        s.library ? ` Library: <code>${esc(s.library)}</code>` : ''
      }</p>`,
      `<span class="dim" id="rc-msg"></span>${s.installed ? '<button type="button" id="rc-check">Check for updates</button>' : ''}<button type="button" data-close>Close</button>${
        s.installed || s.can_install_r ? `<button class="primary" type="button" id="rc-install">${s.installed ? 'Install selected' : 'Install R and selected packages'}</button>` : ''
      }`);
    this.el.querySelector('#rc-install')?.addEventListener('click', () => void this.install());
    this.el.querySelector('#rc-check')?.addEventListener('click', () => void this.checkUpdates());
    // package names from CRAN as the user types (the list is read once, then filtered here)
    const more = this.el.querySelector<HTMLInputElement>('input[name=more]');
    more?.addEventListener('input', () => void this.suggest(more));
  }

  private cran: string[] | null = null;
  private async suggest(input: HTMLInputElement) {
    if (!this.cran) {
      this.cran = [];
      this.cran = (await this.host.backend.json<{ packages: string[] }>('api/r/available').catch(() => ({ packages: [] as string[] }))).packages;
    }
    // the word being typed (several names can be given, separated by commas or spaces)
    const word = input.value.split(/[\s,]+/).pop()!.toLowerCase();
    const list = this.el.querySelector('#rc-cran');
    if (!list) return;
    const hits = word.length < 2 ? [] : [...this.cran.filter((p) => p.toLowerCase().startsWith(word)), ...this.cran.filter((p) => !p.toLowerCase().startsWith(word) && p.toLowerCase().includes(word))].slice(0, 40);
    const head = input.value.slice(0, input.value.length - word.length);
    list.innerHTML = hits.map((p) => `<option value="${esc(head + p)}"></option>`).join('');
  }

  /** Newer versions of the packages in GeoSpaX's R library, with an "Update all" button. */
  private async checkUpdates() {
    const box = this.el.querySelector<HTMLElement>('.rc-updates')!;
    box.hidden = false;
    box.innerHTML = '<p class="dim">Checking the repository for newer versions…</p>';
    try {
      const r = await this.host.backend.json<{ packages: { name: string; installed: string; available: string }[] }>('api/r/outdated');
      if (!r.packages.length) {
        box.innerHTML = '<p class="ok">✓ Every package in GeoSpaX\'s R library is up to date.</p>';
        return;
      }
      box.innerHTML = `<p><b>${r.packages.length} update${r.packages.length === 1 ? '' : 's'} available</b></p>
        <ul class="rc-upd-list">${r.packages.map((p) => `<li><label class="ck"><input type="checkbox" name="upd" value="${esc(p.name)}" checked /> <b>${esc(p.name)}</b> <span class="dim">${esc(p.installed)} → ${esc(p.available)}</span></label></li>`).join('')}</ul>
        <button type="button" class="primary" id="rc-update">Update selected</button>`;
      box.querySelector('#rc-update')!.addEventListener('click', () => {
        const pk = [...box.querySelectorAll<HTMLInputElement>('input[name=upd]:checked')].map((c) => c.value);
        if (pk.length) void this.install(pk);
      });
    } catch (e) {
      box.innerHTML = `<p class="err">${esc((e as Error).message ?? e)}</p>`;
    }
  }

  private body(html: string, footer = '<button type="button" data-close>Close</button>') {
    const sheet = this.el.querySelector('.sheet')!;
    sheet.querySelector('.body')!.innerHTML = html;
    sheet.querySelector('footer')?.remove();
    sheet.insertAdjacentHTML('beforeend', `<footer>${footer}</footer>`);
  }

  private async install(update: string[] | null = null) {
    const form = this.el.querySelector<HTMLFormElement>('.rc-kits')!;
    const f = new FormData(form);
    const kits = f.getAll('kit').map(String);
    const packages = [...f.getAll('pkg').flatMap((v) => String(v).split(',')), ...String(f.get('more') ?? '').split(/[\s,]+/)].map((s) => s.trim()).filter(Boolean);
    const msg = this.el.querySelector<HTMLElement>('#rc-msg')!;
    if (!update && !kits.length && !packages.length && this.status?.installed) {
      msg.textContent = 'Tick a kit or name a package';
      return;
    }
    await this.follow(() => this.host.backend.json<JobInfo>('api/r/install', {
        method: 'POST',
        body: JSON.stringify(update ? { r: false, packages: update, update: true } : { r: true, kits, packages }),
        headers: { 'content-type': 'application/json' },
      }), 'R setup', async (ok) => {
      // the package list is refreshed under the log, which stays open to read
      if (ok) await this.refreshPackages();
      if (ok && update) await this.checkUpdates();
      document.dispatchEvent(new CustomEvent('geospax:envs-changed'));
    });
  }

  /** Start a package job and follow it with the coloured gauge (size, speed, packages, time left) and its log. */
  private async follow(start: () => Promise<JobInfo>, what: string, after: (ok: boolean) => Promise<void> = async () => {}) {
    const msg = this.el.querySelector<HTMLElement>('#rc-msg')!;
    const prog = this.el.querySelector<HTMLElement>('.rc-progress')!;
    const barEl = prog.querySelector<HTMLElement>('.rc-bar')!;
    // a coloured bar: striped and moving while R downloads and builds, green when done, red on failure
    const bar = {
      set value(v: number) {
        const pct = Math.round(Math.min(Math.max(v, 0), 1) * 100);
        barEl.querySelector('i')!.style.width = `${Math.max(pct, 2)}%`;
        barEl.querySelector('b')!.textContent = `${pct}%`;
        barEl.setAttribute('aria-valuenow', String(pct));
      },
    };
    barEl.className = 'rc-bar running';
    const label = prog.querySelector('span')!;
    const btn = this.el.querySelector<HTMLButtonElement>('#rc-install, #rc-update');
    if (btn) btn.disabled = true;
    try {
      let job = await start();
      prog.hidden = false;
      const log = prog.querySelector<HTMLElement>('.rc-log')!;
      const show = (j: JobInfo) => {
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
        log.textContent = (j.log ?? []).join('\n');
        if (atEnd) log.scrollTop = log.scrollHeight;
      };
      while (job.status === 'queued' || job.status === 'running') {
        const t = job.transfer;
        bar.value = t ? t.fraction : job.progress;
        label.textContent = job.message || 'Starting…';
        // size downloaded (of the expected total), speed, packages done and time left, like a download gauge
        prog.querySelector('.rc-size')!.textContent = t
          ? `${bytesText(t.bytes)}${t.total ? ` of about ${bytesText(t.total)}` : ' downloaded'}${t.rate > 0 && t.bytes > 0 ? ` · ${bytesText(t.rate)}/s` : ''}${t.planned ? ` · ${t.units ?? 0} of ${t.planned} packages` : ''}`
          : 'Working out what to download…';
        prog.querySelector('.rc-eta')!.textContent = t ? etaText(t.eta_s) : '';
        show(job);
        await new Promise((r) => setTimeout(r, 700));
        job = await this.host.backend.json<JobInfo>(`api/jobs/${job.id}`);
      }
      bar.value = 1;
      prog.querySelector('.rc-eta')!.textContent = job.status === 'done' ? 'done' : '';
      barEl.className = `rc-bar ${job.status === 'done' ? 'done' : 'failed'}`;
      show(job);
      label.textContent = job.status === 'done' ? `✓ ${job.message}` : `✗ ${job.message}`;
      label.className = job.status === 'done' ? 'ok' : 'err';
      this.host.setStatus(job.status === 'done' ? job.message : `${what}: ${job.message}`, 8000);
      await after(job.status === 'done');
    } catch (err) {
      msg.textContent = String((err as Error).message ?? err);
    } finally {
      const b = this.el.querySelector<HTMLButtonElement>('#rc-install, #rc-update');
      if (b) b.disabled = false;
    }
  }

  /** Python packages of one environment: which have newer versions, and update them with pip (with
   *  the same gauge). A Python the system or conda manages is updated there instead: the command is shown. */
  async pythonUpdates(path: string) {
    this.el.innerHTML = `<div class="sheet fin rc"><header><b>Python packages</b><button type="button" data-close aria-label="Close">✕</button></header><div class="body"></div></div>`;
    this.el.hidden = false;
    this.body(`<p class="fin-lead"><code>${esc(path)}</code></p>
      <div class="rc-updates"><p class="dim">Checking PyPI for newer versions (can take a minute)…</p></div>
      <label><span>Install or update other packages</span><input name="pymore" list="py-sugg" autocomplete="off" placeholder="Start typing: geopandas, rasterio, osmnx …" /></label><datalist id="py-sugg">${PY_SUGGEST.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
      <div class="rc-progress" hidden><div class="rc-bar running" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i><b>0%</b></div><div class="rc-meta"><span class="rc-size"></span><span class="rc-eta"></span></div><span class="dim"></span>
        <pre class="rc-log" aria-live="polite" aria-label="Update log"></pre></div>`,
      `<span class="dim" id="rc-msg"></span><button type="button" data-close>Close</button><button type="button" class="primary" id="rc-update">Install / update</button>`);
    const box = this.el.querySelector<HTMLElement>('.rc-updates')!;
    const run = (pk: string[]) => this.follow(() => this.host.backend.json<JobInfo>('api/python/update', { method: 'POST', body: JSON.stringify({ path, packages: pk }), headers: { 'content-type': 'application/json' } }), 'Python', async (ok) => {
      if (ok) await this.pythonUpdates(path);
      document.dispatchEvent(new CustomEvent('geospax:envs-changed'));
    });
    this.el.querySelector('#rc-update')!.addEventListener('click', () => {
      const pk = [...box.querySelectorAll<HTMLInputElement>('input[name=upd]:checked')].map((c) => c.value);
      pk.push(...String(this.el.querySelector<HTMLInputElement>('input[name=pymore]')?.value ?? '').split(/[\s,]+/).filter(Boolean));
      if (!pk.length) this.el.querySelector('#rc-msg')!.textContent = 'Tick an update or name a package';
      else void run(pk);
    });
    try {
      const r = await this.host.backend.json<{ packages: { name: string; installed: string; available: string }[]; manager: string; command: string | null }>(`api/python/outdated?path=${encodeURIComponent(path)}`);
      if (r.manager !== 'pip') {
        box.innerHTML = `<p>${r.packages.length ? `<b>${r.packages.length} update${r.packages.length === 1 ? '' : 's'} available.</b> ` : '✓ Up to date. '}This Python is managed by ${r.manager === 'conda' ? 'conda' : 'your system'}, so GeoSpaX does not change it with pip. Update it with:</p><pre class="rc-cmd">${esc(r.command ?? '')}</pre>${r.packages.length ? `<ul class="rc-upd-list">${r.packages.map((p) => `<li><b>${esc(p.name)}</b> <span class="dim">${esc(p.installed)} → ${esc(p.available)}</span></li>`).join('')}</ul>` : ''}`;
        this.el.querySelector('#rc-update')?.remove();
        this.el.querySelector('input[name=pymore]')?.closest('label')?.remove();
        return;
      }
      box.innerHTML = r.packages.length
        ? `<p><b>${r.packages.length} update${r.packages.length === 1 ? '' : 's'} available</b> <button type="button" class="link" data-all>Select all</button> <button type="button" class="link" data-none>None</button></p>
          <ul class="rc-upd-list">${r.packages.map((p) => {
            // the GDAL bindings must match the GDAL library on this computer: never updated by default, with a warning
            const gdal = p.name.toLowerCase() === 'gdal';
            return `<li><label class="ck" ${gdal ? 'title="The GDAL Python package must match the GDAL library installed on this computer; update it with the library"' : ''}><input type="checkbox" name="upd" value="${esc(p.name)}" ${gdal ? 'data-risky' : ''} /> <b>${esc(p.name)}</b> <span class="dim">${esc(p.installed)} → ${esc(p.available)}</span>${gdal ? ' <span class="err">⚠ match your GDAL</span>' : ''}</label></li>`;
          }).join('')}</ul>`
        : '<p class="ok">✓ Every package in this environment is up to date.</p>';
      box.querySelector('[data-all]')?.addEventListener('click', () => box.querySelectorAll<HTMLInputElement>('input[name=upd]:not([data-risky])').forEach((c) => (c.checked = true)));
      box.querySelector('[data-none]')?.addEventListener('click', () => box.querySelectorAll<HTMLInputElement>('input[name=upd]').forEach((c) => (c.checked = false)));
    } catch (e) {
      box.innerHTML = `<p class="err">${esc((e as Error).message ?? e)}</p>`;
    }
  }

  /** The R console, opened on a template. */
  async console(kind: string) {
    const t = TEMPLATES[kind] ?? TEMPLATES.blank;
    const my = ++this.seq;
    const layers = this.host.layers();
    const rasters = await this.host.rasters().catch(() => [] as string[]);
    if (my !== this.seq) return;
    const pick = (name: 'layer' | 'raster', ids: string[]) =>
      `<label><span>${name === 'layer' ? 'Layer (sf) → <code>layer</code>' : 'Raster (terra) → <code>raster</code>'}</span><select name="${name}">
        ${t.needs.includes(name) ? '' : '<option value="">none</option>'}${ids.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('')}</select></label>`;
    this.el.innerHTML = `<form class="sheet fin rc rc-console" data-kind="${esc(kind)}">
      <header><b>${esc(t.title)}</b><span class="dim rc-r"></span><button type="button" data-close aria-label="Close">✕</button></header>
      <div class="body">
        <p class="fin-lead">${esc(t.lead)}</p>
        <div class="rc-row">
          <label><span>Template</span><select name="template">${Object.entries(TEMPLATES)
            .map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${esc(v.title)}</option>`)
            .join('')}</select></label>
          ${pick('layer', layers)}${pick('raster', rasters)}
        </div>
        <div class="rc-split">
          <div class="rc-code"><textarea name="code" spellcheck="false" rows="18" aria-label="R code">${esc(t.code)}</textarea>
            <label><span>Packages (checked before the code runs)</span><input name="packages" value="${esc(t.packages.join(', '))}" /></label></div>
          <div class="rc-out" aria-live="polite"><p class="dim">Results appear here: layers and rasters go on the map; figures, tables and printed output show here.</p></div>
        </div>
      </div>
      <footer><span class="dim" id="rc-msg"></span><button type="button" data-r-setup>R setup…</button><button type="button" data-close>Close</button><button class="primary" type="submit">Run</button></footer>
    </form>`;
    this.el.hidden = false;
    const form = this.el.querySelector<HTMLFormElement>('form')!;
    form.querySelector<HTMLSelectElement>('[name=template]')!.addEventListener('change', (e) => void this.console((e.target as HTMLSelectElement).value));
    form.querySelector('[data-r-setup]')!.addEventListener('click', () => void this.setup());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.run(form);
    });
    // Tab inserts two spaces in the editor
    form.querySelector<HTMLTextAreaElement>('textarea')!.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const ta = e.target as HTMLTextAreaElement;
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    });
    form.querySelector('textarea')!.focus();
    if (layers.length + rasters.length === 0 && t.needs.length) this.out(`<p class="dim">Add a ${t.needs.join(' and a ')} to the map first (Data › Add data or Data › Online data).</p>`);
    try {
      const s = this.status ?? (await this.loadStatus());
      const r = this.el.querySelector('.rc-r');
      if (r) r.textContent = s.installed ? rVersion(s.version) : 'R is not installed';
      if (!s.installed) this.out(`<p>R is not installed on this computer. <button type="button" class="link" data-r-setup2>Set up R…</button></p>`);
      this.el.querySelector('[data-r-setup2]')?.addEventListener('click', () => void this.setup());
    } catch {
      /* status is optional here */
    }
  }

  private out(html: string) {
    const o = this.el.querySelector<HTMLElement>('.rc-out');
    if (o) o.innerHTML = html;
  }

  /** the r step for the form (exported shape for tests) */
  step(form: HTMLFormElement): { use: string; with: Record<string, unknown> } {
    const f = new FormData(form);
    const inputs: Record<string, string> = {};
    for (const k of ['layer', 'raster']) if (f.get(k)) inputs[k] = String(f.get(k));
    const packages = String(f.get('packages') ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    return { use: 'r', with: { code: String(f.get('code') ?? ''), inputs, packages, timeout_s: 3600 } };
  }

  private async run(form: HTMLFormElement) {
    const msg = this.el.querySelector<HTMLElement>('#rc-msg')!;
    const s = this.step(form);
    const title = TEMPLATES[form.dataset.kind ?? 'blank']?.title ?? 'R console';
    const yaml = [
      `# Made by R › ${title} on ${new Date().toLocaleString()}; replaced the next time the R console runs.`,
      `recipe: ${R_RECIPE}`,
      'version: 1',
      `title: ${JSON.stringify(title)}`,
      'steps:',
      '  - id: r',
      '    use: r',
      `    with: ${JSON.stringify(s.with)}`,
      'outputs: [r]',
      '',
    ].join('\n');
    const runBtn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    runBtn.disabled = true;
    msg.textContent = 'Running R…';
    this.out('<p class="dim">Running…</p>');
    try {
      // the code is the user's own, typed here: approve it
      await this.host.backend.json('api/recipes?approve=code', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      await this.host.run(R_RECIPE);
      const runs = (await this.host.backend.json<{ runs: { id: string; recipe: string }[] }>('api/runs')).runs;
      const id = runs.find((r) => r.recipe === R_RECIPE)?.id;
      if (!id) throw new Error('the run was not found');
      const run = await this.host.backend.json<{ status: string; error?: string | null; outputs?: Record<string, RunOut> }>(`api/runs/${id}`);
      msg.textContent = run.status === 'done' ? 'Done' : 'Failed';
      this.showRun(id, run.status, run.error ?? '', run.outputs?.r ?? {});
    } catch (err) {
      msg.textContent = String((err as Error).message ?? err);
    } finally {
      runBtn.disabled = false;
    }
  }

  private showRun(id: string, status: string, error: string, o: RunOut) {
    const file = (f: string) => this.host.backend.url(`api/runs/${id}/files/${encodeURIComponent(f)}`);
    const parts: string[] = [];
    if (status !== 'done') {
      const miss = /missing R packages: ([^(]+)/.exec(error)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
      parts.push(`<pre class="rc-err">${esc(error)}</pre>`);
      if (miss.length) parts.push(`<p><button type="button" class="primary" data-install="${esc(miss.join(','))}">Install ${esc(miss.join(', '))}</button></p>`);
      else if (/R is not installed/.test(error)) parts.push('<p><button type="button" class="primary" data-install="">Set up R…</button></p>');
    }
    const layers = Object.values(o.layers ?? {});
    if (layers.length) parts.push(`<p>On the map: ${layers.map((l) => `<b>${esc(l)}</b>`).join(', ')}</p>`);
    for (const [name, files] of Object.entries(o.figures ?? {})) {
      const png = files.find((f) => f.endsWith('.png'));
      const order = (f: string) => ['png', 'pdf', 'svg'].indexOf(f.split('.').pop() ?? '');
      parts.push(`<figure>${png ? `<img src="${esc(file(png))}" alt="${esc(name)}" />` : ''}<figcaption>${esc(name)} · ${[...files]
        .sort((a, b) => order(a) - order(b))
        .map((f) => `<a href="${esc(file(f))}" target="_blank" rel="noopener">${esc(f.split('.').pop()!.toUpperCase())}</a>`)
        .join(' · ')}</figcaption></figure>`);
    }
    for (const [name, t] of Object.entries(o.tables ?? {})) parts.push(`<h4>${esc(name)} <a class="dim" href="${esc(file(`${name}.csv`))}" target="_blank" rel="noopener">CSV</a></h4>${table(t)}`);
    const res = Object.entries(o.result ?? {});
    if (res.length) parts.push(`<p>${res.map(([k, v]) => `${esc(k)} = <b>${esc(v)}</b>`).join(' · ')}</p>`);
    if (o.stdout?.trim()) parts.push(`<pre class="rc-stdout">${esc(o.stdout)}</pre>`);
    this.out(parts.join('') || '<p class="dim">Done; the code returned nothing to show.</p>');
    this.el.querySelector<HTMLElement>('[data-install]')?.addEventListener('click', (e) => {
      const pk = (e.currentTarget as HTMLElement).dataset.install!;
      void this.setup(pk ? pk.split(',') : []);
    });
  }
}
