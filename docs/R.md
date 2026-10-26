# R in GeoSpaX

GeoSpaX runs R for the analysis and figures R is best at: tmap and ggplot2 maps for publication,
terra rasters, rayshader relief, species distribution models with biomod2 and MaxEnt, tidymodels,
dbplyr and Google Earth Engine through rgee. The data stays in GeoSpaX: layers and rasters on the map
go into R as `sf` and `terra` objects, and what R returns comes back to the map and the report.

## The R tab

| Group | Buttons |
| --- | --- |
| **Code** | **R console** · **R setup** |
| **Maps** | **tmap map** · ggplot2 map · Relief (rayshader) |
| **Rasters** | **Terrain** (terra) · Earth Engine (rgee) |
| **Species models** | **biomod2** (ensemble SDM) · MaxEnt (maxnet) |
| **Machine learning** | **tidymodels** (random forest) · dbplyr (SQL in DuckDB) |

Every button opens the **R console** on a template. The template is ordinary R that you can read,
change and copy into your own scripts. Pick the inputs, then press **Run**:

- **Layer (sf) → `layer`**: any layer on the map, as an sf object.
- **Raster (terra) → `raster`**: any raster on the map, as a terra SpatRaster (all its bands).
- **Packages**: checked before the code runs. If one is missing, the console offers to install it.

What the code returns comes back. Return a named list, or call the helpers:

| R object | Comes back as | Helper |
| --- | --- | --- |
| sf | a layer on the map | `save_layer("name", x)` |
| terra SpatRaster (or raster) | a raster on the map | `save_layer("name", r)` |
| ggplot or tmap | a figure: PNG at 300 dpi, PDF and SVG | `save_figure("name", p, width = 180, height = 120, units = "mm", dpi = 300, formats = c("png", "pdf", "svg"))` |
| a function that draws (base graphics, `terra::plot`, rayshader `plot_map`) | a figure | `save_figure("name", function() plot(x))` |
| data frame, matrix | a table (shown, and kept as CSV) | `save_table("name", df)` |
| numbers or text | the run log and the report | `result(auc = 0.91)` |

Printed output (`print`, `summary`, `show_query`) shows under the results. Figures and tables are
also in the run's files and its report. Each console run is kept in the run history (the recipe
`r-console`). It is replaced by the next run, so save code you want to keep as a recipe (below).

Online data (Explorer › Online data: Climate, Species …) feeds straight in. For a species distribution model, get
occurrences from GBIF and bioclim layers from WorldClim, then open **Explorer › R & Python › R › biomod2** or **› MaxEnt**
with the occurrences as `layer` and the climate raster as `raster`.

## R setup

**R setup** checks whether R is installed and which packages are there, and installs what is missing.

- **R itself**: if R is missing, **Install R and selected packages** installs the official CRAN build.
  - **Windows**: for the current user, without admin rights.
  - **macOS**: CRAN's installer; macOS asks for your password.
  - **Linux**: your package manager (apt, dnf, zypper or pacman); the system asks for your password.
  - On a server without a desktop to ask on, R setup gives the command to run instead.
- **Package kits**: tick the kits you need; *Spatial data*, *Publication maps* and *Spatial statistics*
  are ticked by default.

| Kit | Packages |
| --- | --- |
| Spatial data | sf, terra, stars |
| Publication maps | tmap, ggplot2, ggspatial, patchwork, viridisLite |
| 3D relief | rayshader |
| Species distribution models | biomod2, maxnet, dismo, predicts |
| Machine learning | tidymodels, ranger |
| Data wrangling and databases | tidyverse, dbplyr, DBI, RSQLite, duckdb |
| Spatial statistics | gstat, spdep, spatstat |
| Online data | geodata, rgbif |
| Google Earth Engine | rgee |

Any other CRAN package can be named under *Other packages*.

**How the packages are installed:**
- **Where**: into GeoSpaX's own library (`<state>/r-library`). Your own R setup and library are not
  changed, and the R console and recipe R steps look there first.
- **Ready-built**: the packages are binaries, so nothing is compiled. They come from CRAN on Windows
  and macOS, and from [Posit Public Package Manager](https://packagemanager.posit.co) for your
  distribution on Linux (Ubuntu, Debian, RHEL and relatives, openSUSE).
- **Progress and failures**: installation needs internet and shows progress package by package. A
  package that fails is named at the end; the others are still installed.

**rgee** also needs a Google Earth Engine account and Python. Run `rgee::ee_install()` and
`rgee::ee_Initialize()` once in R; after that, the Earth Engine template works.

## R in the web edition

In the web edition, R runs on the server. People using GeoSpaX in a browser get full R with every
package, and nothing is installed on their computers. R setup installs R and the packages on the
server, once.

Running R inside the browser itself (webR) is possible for light work, but it is slower, downloads a
lot, and rayshader, the heavier biomod2 models and rgee do not run there. It is not part of GeoSpaX yet.

## R in recipes

The console is a one-step recipe; any recipe can have R steps (`use: r`) between built-in steps.
The step's inputs can be layers or rasters, and its outputs go on to the next steps
([AUTOMATION §6](AUTOMATION.md#6-r-and-python-steps-built)).

```yaml
  - id: sdm
    use: r
    with:
      inputs: { layer: "${occurrences.layer}", raster: "${climate.raster}" }
      packages: [maxnet, terra, sf]
      code: |
        library(maxnet)
        ...
        list(suitability = terra::predict(raster, fit, type = "cloglog", na.rm = TRUE))
```

Recipes with R or Python code run code on your computer, so GeoSpaX asks before saving one that
came from elsewhere ([AUTOMATION §8](AUTOMATION.md#8-safety-and-trust)). Code typed in the R
console is yours, so it runs without that question.

## Over HTTP

```bash
curl localhost:8080/api/r                                  # R, its version, the kits, installed packages
curl -X POST localhost:8080/api/r/install -d '{"kits": ["maps", "sdm"], "packages": ["lidR"]}'
curl localhost:8080/api/jobs/1                             # progress of that installation
```

## Charts and code style

**Charts follow ggplot2.** GeoSpaX sets `ggplot2::theme_set()` and the discrete colour palette
before your code runs, from **Settings › Charts** (theme_grey by default; theme_bw, minimal, classic,
light or dark; the ggplot2 hue palette, viridis, Okabe–Ito, Brewer Set2 or Dark2; the text size). The
charts GeoSpaX draws itself (report charts, the Attributes chart, raster histograms) use the same look,
so a report reads as one piece. Add your own `+ theme(...)` to change one chart.

**Code follows the tidyverse style guide.** The templates (R tab) use the native pipe `|>`, dplyr and
purrr verbs, `snake_case` names, `.data[[field]]` for a field chosen at run time and one step per
line; write your own steps the same way (styler::style_text() tidies a script).
