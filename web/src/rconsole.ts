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
  blank: {
    title: 'R console',
    lead: 'Any R code. `layer` is the chosen layer (sf), `raster` the chosen raster (terra). Return a named list: sf → layers, SpatRaster → rasters, ggplot/tmap → figures, data frames → tables.',
    needs: [],
    packages: [],
    code: `# layer (sf) and raster (terra) are the inputs chosen above
# save_figure("name", plot_or_function), save_table("name", df), result(key = value)
summary(layer)
`,
  },
  tmap: {
    title: 'tmap map',
    lead: 'A thematic map of a layer with tmap: classed fill, legend, north arrow and scale bar, saved at print size (PNG and PDF).',
    needs: ['layer'],
    packages: ['tmap', 'sf'],
    code: `library(tmap)
field <- names(Filter(is.numeric, sf::st_drop_geometry(layer)))[1]   # or e.g. "population"
geom <- as.character(sf::st_geometry_type(layer, by_geometry = FALSE))
shape <- tm_shape(layer)
m <- if (grepl("POINT", geom)) {
  shape + tm_dots(fill = field, size = 0.4, fill.scale = tm_scale_intervals(style = "jenks", values = "viridis"))
} else {
  shape + tm_polygons(fill = field, fill.scale = tm_scale_intervals(style = "jenks", values = "viridis"),
                      fill.legend = tm_legend(title = field))
}
m <- m + tm_compass(position = c("right", "top")) + tm_scalebar(position = c("left", "bottom")) +
  tm_layout(frame = FALSE, legend.outside = TRUE)
save_figure("tmap_map", m, width = 180, height = 140, dpi = 300)
`,
  },
  ggplot: {
    title: 'ggplot2 map',
    lead: 'A ggplot2 map (geom_sf) with a scale bar and north arrow from ggspatial, saved at print size.',
    needs: ['layer'],
    packages: ['ggplot2', 'ggspatial', 'sf'],
    code: `library(ggplot2)
field <- names(Filter(is.numeric, sf::st_drop_geometry(layer)))[1]
p <- ggplot(layer) +
  geom_sf(aes(fill = .data[[field]], colour = .data[[field]]), linewidth = 0.2) +
  scale_fill_viridis_c(guide = "none") + scale_colour_viridis_c(name = field) +
  ggspatial::annotation_scale(location = "bl") +
  ggspatial::annotation_north_arrow(location = "tr", style = ggspatial::north_arrow_minimal()) +
  theme_minimal(base_size = 10) + theme(panel.grid = element_line(colour = "grey90"))
save_figure("ggplot_map", p, width = 180, height = 140, dpi = 300)
`,
  },
  rayshader: {
    title: 'rayshader relief',
    lead: 'Shaded relief from an elevation raster with rayshader (sphere shading, ray-traced shadows, ambient occlusion).',
    needs: ['raster'],
    packages: ['rayshader', 'terra'],
    code: `library(rayshader)
dem <- raster[[1]]
m <- raster_to_matrix(dem)
z <- max(1, mean(terra::res(dem)) * if (terra::is.lonlat(dem)) 111320 else 1) / 10   # vertical exaggeration
save_figure("relief", function() {
  m |>
    sphere_shade(texture = "imhof1") |>
    add_shadow(ray_shade(m, zscale = z), 0.5) |>
    add_shadow(ambient_shade(m, zscale = z), 0) |>
    plot_map()
}, width = 180, height = 140, formats = "png")
# 3D: plot_3d(...) then render_snapshot(figure_path("relief_3d")) (needs OpenGL)
`,
  },
  terrain: {
    title: 'terra terrain',
    lead: 'Slope, aspect, hillshade and terrain ruggedness from an elevation raster with terra.',
    needs: ['raster'],
    packages: ['terra'],
    code: `dem <- raster[[1]]
t <- terra::terrain(dem, v = c("slope", "aspect", "TRI"), unit = "degrees")
shade <- terra::shade(terra::terrain(dem, "slope", unit = "radians"), terra::terrain(dem, "aspect", unit = "radians"))
stats <- data.frame(layer = names(t), mean = terra::global(t, "mean", na.rm = TRUE)[[1]],
                    max = terra::global(t, "max", na.rm = TRUE)[[1]])
list(slope = t[["slope"]], aspect = t[["aspect"]], ruggedness = t[["TRI"]], hillshade = shade, terrain_stats = stats)
`,
  },
  biomod2: {
    title: 'biomod2 ensemble SDM',
    lead: 'An ensemble species distribution model with biomod2: occurrence points + environmental rasters (e.g. WorldClim from Data › Climate), pseudo-absences, GLM + random forest + MaxNet, TSS-weighted ensemble.',
    needs: ['layer', 'raster'],
    packages: ['biomod2', 'terra', 'sf'],
    code: `library(biomod2)
xy <- sf::st_coordinates(sf::st_transform(layer, terra::crs(raster)))
data <- BIOMOD_FormatingData(resp.var = rep(1, nrow(xy)), expl.var = raster, resp.xy = xy,
  resp.name = "species", PA.nb.rep = 1, PA.nb.absences = 1000, PA.strategy = "random")
mods <- BIOMOD_Modeling(data, models = c("GLM", "RF", "MAXNET"), CV.strategy = "random",
  CV.nb.rep = 2, CV.perc = 0.8, metric.eval = c("TSS", "ROC"), var.import = 2)
ens <- BIOMOD_EnsembleModeling(mods, em.by = "all", em.algo = "EMwmean",
  metric.select = "TSS", metric.select.thresh = 0.5, metric.eval = c("TSS", "ROC"))
proj <- BIOMOD_EnsembleForecasting(ens, proj.name = "current", new.env = raster)
suitability <- terra::rast(get_predictions(proj))[[1]] / 1000
list(suitability = suitability, evaluation = get_evaluations(mods), importance = get_variables_importance(mods))
`,
  },
  maxent: {
    title: 'MaxEnt (maxnet)',
    lead: 'MaxEnt with maxnet: presences from a point layer, 5,000 background points from the rasters, cloglog suitability.',
    needs: ['layer', 'raster'],
    packages: ['maxnet', 'terra', 'sf'],
    code: `library(maxnet)
pts <- terra::vect(sf::st_transform(layer, terra::crs(raster)))
pres <- terra::extract(raster, pts, ID = FALSE)
bg <- terra::spatSample(raster, 5000, "random", na.rm = TRUE, values = TRUE)
d <- na.omit(rbind(data.frame(p = 1, pres), data.frame(p = 0, bg)))
fit <- maxnet(d$p, d[, -1, drop = FALSE], maxnet.formula(d$p, d[, -1, drop = FALSE], classes = "lqh"))
suitability <- terra::predict(raster, fit, type = "cloglog", na.rm = TRUE)
result(presences = sum(d$p == 1), background = sum(d$p == 0))
list(suitability = suitability)
`,
  },
  tidymodels: {
    title: 'tidymodels random forest',
    lead: 'A random forest with tidymodels: predicts a field of the layer from its other numeric fields, 5-fold cross-validated; predictions come back as a layer.',
    needs: ['layer'],
    packages: ['tidymodels', 'ranger', 'sf'],
    code: `library(tidymodels)
d <- sf::st_drop_geometry(layer) |> dplyr::select(where(is.numeric))
target <- names(d)[1]                       # the field to predict
ok <- stats::complete.cases(d)
f <- stats::as.formula(paste(target, "~ ."))
wf <- workflow() |> add_formula(f) |> add_model(rand_forest(trees = 500) |> set_engine("ranger") |> set_mode("regression"))
set.seed(1)
cv <- fit_resamples(wf, vfold_cv(d[ok, ], v = 5), metrics = metric_set(rmse, rsq))
fitted <- fit(wf, d[ok, ])
out <- layer[ok, ]
out$predicted <- predict(fitted, d[ok, ])$.pred
out$residual <- out[[target]] - out$predicted
list(predictions = out, cv_metrics = collect_metrics(cv))
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
DBI::dbWriteTable(con, "layer", sf::st_drop_geometry(layer))
num <- names(Filter(is.numeric, sf::st_drop_geometry(layer)))[1]
q <- tbl(con, "layer") |> summarise(n = n(), mean = mean(.data[[num]], na.rm = TRUE), max = max(.data[[num]], na.rm = TRUE))
show_query(q)
list(summary = collect(q))
`,
  },
  gee: {
    title: 'Earth Engine (rgee)',
    lead: 'A Sentinel-2 median NDVI for the layer’s extent from Google Earth Engine with rgee. Needs an Earth Engine account (rgee::ee_Initialize() once, in R).',
    needs: ['layer'],
    packages: ['rgee', 'sf', 'terra'],
    code: `library(rgee)
ee_Initialize(quiet = TRUE)
aoi <- sf_as_ee(sf::st_as_sfc(sf::st_bbox(sf::st_transform(layer, 4326))))
ndvi <- ee$ImageCollection("COPERNICUS/S2_SR_HARMONIZED")$
  filterBounds(aoi)$filterDate("2024-01-01", "2024-12-31")$
  filter(ee$Filter$lt("CLOUDY_PIXEL_PERCENTAGE", 20))$
  median()$normalizedDifference(c("B8", "B4"))
list(ndvi = ee_as_rast(ndvi, region = aoi, scale = 30))
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
        <label><span>Other packages</span><input name="more" placeholder="e.g. lidR, landscapemetrics, sdmTMB" /></label>
      </form>
      <div class="rc-progress" hidden><div class="rc-bar running" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i><b>0%</b></div><div class="rc-meta"><span class="rc-size"></span><span class="rc-eta"></span></div><span class="dim"></span>
        <pre class="rc-log" aria-live="polite" aria-label="Installation log"></pre></div>
      <p class="dim">Packages are ready-built binaries (CRAN on Windows and macOS, Posit Package Manager on Linux): nothing is compiled. Needs internet.${
        s.library ? ` Library: <code>${esc(s.library)}</code>` : ''
      }</p>`,
      `<span class="dim" id="rc-msg"></span><button type="button" data-close>Close</button>${
        s.installed || s.can_install_r ? `<button class="primary" type="button" id="rc-install">${s.installed ? 'Install selected' : 'Install R and selected packages'}</button>` : ''
      }`);
    this.el.querySelector('#rc-install')?.addEventListener('click', () => void this.install());
  }

  private body(html: string, footer = '<button type="button" data-close>Close</button>') {
    const sheet = this.el.querySelector('.sheet')!;
    sheet.querySelector('.body')!.innerHTML = html;
    sheet.querySelector('footer')?.remove();
    sheet.insertAdjacentHTML('beforeend', `<footer>${footer}</footer>`);
  }

  private async install() {
    const form = this.el.querySelector<HTMLFormElement>('.rc-kits')!;
    const f = new FormData(form);
    const kits = f.getAll('kit').map(String);
    const packages = [...f.getAll('pkg').flatMap((v) => String(v).split(',')), ...String(f.get('more') ?? '').split(/[\s,]+/)].map((s) => s.trim()).filter(Boolean);
    const msg = this.el.querySelector<HTMLElement>('#rc-msg')!;
    if (!kits.length && !packages.length && this.status?.installed) {
      msg.textContent = 'Tick a kit or name a package';
      return;
    }
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
    this.el.querySelector<HTMLButtonElement>('#rc-install')!.disabled = true;
    try {
      let job = await this.host.backend.json<JobInfo>('api/r/install', {
        method: 'POST',
        body: JSON.stringify({ r: true, kits, packages }),
        headers: { 'content-type': 'application/json' },
      });
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
        label.textContent = job.message || 'Starting R…';
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
      this.host.setStatus(job.status === 'done' ? job.message : `R setup: ${job.message}`, 8000);
      // the package list is refreshed under the log, which stays open to read
      if (job.status === 'done') await this.refreshPackages();
    } catch (err) {
      msg.textContent = String((err as Error).message ?? err);
    } finally {
      const b = this.el.querySelector<HTMLButtonElement>('#rc-install');
      if (b) b.disabled = false;
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
