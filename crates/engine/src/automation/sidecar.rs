//! R and Python steps (docs/AUTOMATION.md §6): run user code in a separate process.
//!
//! Inputs arrive as GeoJSON files (and, when sf / geopandas are installed, as sf objects /
//! GeoDataFrames bound to variables of the same name). Layers the code returns or saves become
//! GeoSpaX layers; numbers it reports go into the run log and the report.
//!
//! The process gets a scrubbed environment, its own working directory, a timeout and the run's
//! cancel flag. It is not a sandbox: recipes with code steps must come from a trusted source
//! (AUTOMATION.md §8).

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Python,
    R,
}

impl Lang {
    pub fn name(self) -> &'static str {
        match self {
            Lang::Python => "Python",
            Lang::R => "R",
        }
    }
}

pub struct ScriptRun {
    pub interpreter: String,
    pub version: String,
    /// (name, file) of every layer the code produced
    pub layers: Vec<(String, PathBuf)>,
    /// (name, GeoTIFF) of every raster (terra SpatRaster, raster, rasterio …)
    pub rasters: Vec<(String, PathBuf)>,
    /// (name, PNG/PDF/SVG) of every figure (ggplot2, tmap, rayshader, base graphics, matplotlib …)
    pub figures: Vec<(String, PathBuf)>,
    /// (name, CSV) of every table (a data frame without geometry)
    pub tables: Vec<(String, PathBuf)>,
    pub result: Map<String, Value>,
    pub stdout: String,
    pub stderr: String,
    pub ms: f64,
}

/// Interpreter command and version, if installed (GEOSPAX_PYTHON / GEOSPAX_RSCRIPT override).
pub fn find(lang: Lang) -> Option<(String, String)> {
    let (env, candidates): (&str, &[&str]) = match lang {
        // Windows: "python3" is usually the Microsoft Store stub, "py" is the python.org launcher
        Lang::Python => ("GEOSPAX_PYTHON", if cfg!(windows) { &["python", "py", "python3"] } else { &["python3", "python"] }),
        Lang::R => ("GEOSPAX_RSCRIPT", &["Rscript", "/usr/local/bin/Rscript", "/opt/homebrew/bin/Rscript", "/Library/Frameworks/R.framework/Resources/bin/Rscript"]),
    };
    let mut list: Vec<String> = std::env::var(env).ok().into_iter().collect();
    list.extend(candidates.iter().map(|s| s.to_string()));
    if matches!(lang, Lang::R) {
        list.extend(windows_r_installs());
    }
    for cmd in list {
        if let Ok(out) = crate::command(&cmd).arg("--version").stdin(Stdio::null()).output() {
            if out.status.success() {
                let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
                let version = text.lines().next().unwrap_or("").trim().to_string();
                return Some((cmd, version));
            }
        }
    }
    None
}

/// R's Windows installer does not put Rscript on PATH: look in Program Files\\R\\R-x.y.z\\bin, newest first.
fn windows_r_installs() -> Vec<String> {
    let mut found = Vec::new();
    if !cfg!(windows) {
        return found;
    }
    for (var, sub) in [("ProgramFiles", "R"), ("ProgramW6432", "R"), ("LOCALAPPDATA", "Programs\\R")] {
        let Some(base) = std::env::var_os(var) else { continue };
        if let Ok(rd) = std::fs::read_dir(PathBuf::from(base).join(sub)) {
            for e in rd.flatten() {
                let exe = e.path().join("bin").join("Rscript.exe");
                if exe.is_file() {
                    found.push(exe.to_string_lossy().to_string());
                }
            }
        }
    }
    found.sort();
    found.dedup();
    found.reverse();
    found
}

static R_LIBRARY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// GeoSpaX's own R package library (`<state>/r-library`): packages GeoSpaX installs go here, so
/// the user's R setup is never changed. R steps search it first.
pub fn set_r_library(dir: PathBuf) {
    let _ = R_LIBRARY.set(dir);
}

pub fn r_library() -> Option<&'static PathBuf> {
    R_LIBRARY.get()
}

pub fn install_hint(lang: Lang) -> &'static str {
    match lang {
        Lang::Python => "install Python 3 (https://www.python.org) or set GEOSPAX_PYTHON",
        Lang::R => "open R › R setup to install it (or install R from https://cran.r-project.org, or set GEOSPAX_RSCRIPT)",
    }
}

fn py_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// JSON value as an R literal.
pub fn r_literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => r_str(s),
        Value::Array(a) => {
            let scalars = a.iter().all(|x| x.is_number()) || a.iter().all(|x| x.is_string()) || a.iter().all(|x| x.is_boolean());
            let items: Vec<String> = a.iter().map(r_literal).collect();
            if scalars && !a.is_empty() { format!("c({})", items.join(", ")) } else { format!("list({})", items.join(", ")) }
        }
        Value::Object(o) => {
            let items: Vec<String> = o.iter().map(|(k, x)| format!("{} = {}", r_str(k), r_literal(x))).collect();
            format!("list({})", items.join(", "))
        }
    }
}

fn r_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn python_wrapper(code: &str, inputs: &[(String, PathBuf)], params: &Value, packages: &[String], outputs: &Path) -> String {
    let inputs_py: Vec<String> = inputs.iter().map(|(n, p)| format!("{}: {}", py_str(n), py_str(&p.to_string_lossy()))).collect();
    let packages_py: Vec<String> = packages.iter().map(|p| py_str(p)).collect();
    format!(
        r#"# GeoSpaX Python step (generated). Your code is between the markers below.
import json, os, sys, importlib.util
inputs = {{{inputs}}}
params = json.loads({params})
outputs_dir = {outputs}
_missing = [p for p in [{packages}] if importlib.util.find_spec(p) is None]
if _missing:
    sys.exit("missing Python packages: " + ", ".join(_missing) + "  (install with: pip install " + " ".join(_missing) + ")")
try:
    import geopandas as _gpd
except Exception:
    _gpd = None
def _load(path):
    # a raster: an open rasterio dataset when rasterio is installed, else its path (for GDAL, xarray …)
    if path.lower().endswith((".tif", ".tiff", ".vrt", ".jp2", ".nc")):
        try:
            import rasterio as _rio
            return _rio.open(path)
        except Exception:
            return path
    if _gpd is not None:
        try:
            return _gpd.read_file(path)
        except Exception:
            pass
    with open(path, encoding="utf-8") as f:
        return json.load(f)
for _name, _path in inputs.items():
    globals()[_name] = _load(_path)
def save(name, obj):
    """Save a layer: a GeoDataFrame, a GeoJSON FeatureCollection dict or a list of GeoJSON features."""
    path = os.path.join(outputs_dir, name + ".geojson")
    if hasattr(obj, "to_file"):
        obj.to_file(path, driver="GeoJSON")
        return
    if isinstance(obj, list):
        obj = {{"type": "FeatureCollection", "features": obj}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)
def figure_path(name, ext="png"):
    """Where to save a figure (matplotlib: plt.savefig(figure_path("relief"))); it appears in the report."""
    return os.path.join(outputs_dir, name + "." + ext)
_result = {{}}
def result(**values):
    """Report numbers or text; they appear in the run log and the report."""
    _result.update(values)
    with open(os.path.join(outputs_dir, "result.json"), "w", encoding="utf-8") as f:
        json.dump(_result, f, default=str)
# ---- your code ----
{code}
# ---- end of your code ----
for _name, _obj in (globals().get("OUTPUTS") or {{}}).items():
    save(_name, _obj)
if isinstance(globals().get("RESULT"), dict):
    result(**RESULT)
"#,
        inputs = inputs_py.join(", "),
        params = py_str(&params.to_string()),
        outputs = py_str(&outputs.to_string_lossy()),
        packages = packages_py.join(", "),
        code = code
    )
}

fn r_wrapper(code: &str, inputs: &[(String, PathBuf)], params: &Value, packages: &[String], outputs: &Path) -> String {
    let inputs_r: Vec<String> = inputs.iter().map(|(n, p)| format!("{} = {}", r_str(n), r_str(&p.to_string_lossy()))).collect();
    let packages_r: Vec<String> = packages.iter().map(|p| r_str(p)).collect();
    format!(
        r##"# GeoSpaX R step (generated). Your code is between the markers below.
.lib <- Sys.getenv("GEOSPAX_R_LIBRARY")
if (nzchar(.lib) && dir.exists(.lib)) .libPaths(c(.lib, .libPaths()))
inputs <- list({inputs})
params <- {params}
outputs_dir <- {outputs}
.missing <- Filter(function(p) !requireNamespace(p, quietly = TRUE), c({packages}))
if (length(.missing) > 0) stop(paste0("missing R packages: ", paste(.missing, collapse = ", "),
  "  (install with: install.packages(c(", paste0('"', .missing, '"', collapse = ", "), ")))"), call. = FALSE)
.has_sf <- requireNamespace("sf", quietly = TRUE)
.is_raster <- function(p) grepl("\\.(tif|tiff|vrt|nc|img|asc|jp2)$", tolower(p))
for (.n in names(inputs)) assign(.n, if (.is_raster(inputs[[.n]]) && requireNamespace("terra", quietly = TRUE)) terra::rast(inputs[[.n]])
  else if (.has_sf) sf::st_read(inputs[[.n]], quiet = TRUE) else inputs[[.n]])
# Charts follow the ggplot2 theme and palette chosen in GeoSpaX's Settings (theme_grey and the hue
# palette unless changed): every ggplot made below uses them without asking.
if (requireNamespace("ggplot2", quietly = TRUE)) local({{
  .size <- as.numeric(Sys.getenv("GEOSPAX_CHART_BASE_SIZE", "11"))
  .theme <- switch(Sys.getenv("GEOSPAX_CHART_THEME", "grey"),
    bw = ggplot2::theme_bw, minimal = ggplot2::theme_minimal, classic = ggplot2::theme_classic,
    light = ggplot2::theme_light, dark = ggplot2::theme_dark, ggplot2::theme_grey)
  ggplot2::theme_set(.theme(base_size = .size))
  .pal <- switch(Sys.getenv("GEOSPAX_CHART_PALETTE", "ggplot2"),
    viridis = function(...) ggplot2::scale_colour_viridis_d(...),
    `okabe-ito` = function(...) ggplot2::scale_colour_manual(values = c("#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#999999"), ...),
    set2 = function(...) ggplot2::scale_colour_brewer(palette = "Set2", ...),
    dark2 = function(...) ggplot2::scale_colour_brewer(palette = "Dark2", ...),
    NULL)
  if (!is.null(.pal)) {{
    options(ggplot2.discrete.colour = .pal)
    options(ggplot2.discrete.fill = function(...) ggplot2::scale_fill_discrete(type = .pal()$palette(8), ...))
  }}
}})
figure_path <- function(name, ext = "png") file.path(outputs_dir, paste0(name, ".", ext))
# A figure at print size: a ggplot, a tmap, or a function that draws (base graphics, terra::plot …).
# rayshader: rayshader::render_snapshot(figure_path("relief")) or save_figure("relief", function() plot_map(hillshade)).
# PNG (at dpi), PDF and SVG by default, so every chart can be downloaded at print quality and as vectors.
save_figure <- function(name, plot, width = 180, height = 120, units = "mm", dpi = 300, formats = c("png", "pdf", "svg")) {{
  inch <- c(mm = 1 / 25.4, cm = 1 / 2.54, `in` = 1)[[units]]
  for (.f in formats) {{
    path <- figure_path(name, .f)
    # ggsave writes SVG through svglite when installed, else with R's own svg device
    svg_device <- if (.f == "svg" && !requireNamespace("svglite", quietly = TRUE)) grDevices::svg else NULL
    if (inherits(plot, "ggplot")) ggplot2::ggsave(path, plot, width = width, height = height, units = units, dpi = dpi, device = svg_device)
    else if (inherits(plot, "tmap")) tmap::tmap_save(plot, path, width = width, height = height, units = units, dpi = dpi)
    else if (is.function(plot)) {{
      if (.f == "pdf") grDevices::pdf(path, width = width * inch, height = height * inch)
      else if (.f == "svg") grDevices::svg(path, width = width * inch, height = height * inch)
      else grDevices::png(path, width = width, height = height, units = units, res = dpi)
      tryCatch(plot(), finally = grDevices::dev.off())
    }} else stop(paste("cannot save", name, "as a figure: expected a ggplot, a tmap or a function that draws"))
  }}
  invisible(path)
}}
save_table <- function(name, obj) utils::write.csv(as.data.frame(obj), file.path(outputs_dir, paste0(name, ".csv")), row.names = FALSE)
save_layer <- function(name, obj) {{
  if (inherits(obj, "SpatRaster")) {{
    terra::writeRaster(obj, file.path(outputs_dir, paste0(name, ".tif")), overwrite = TRUE)
  }} else if (inherits(obj, c("RasterLayer", "RasterStack", "RasterBrick"))) {{
    raster::writeRaster(obj, file.path(outputs_dir, paste0(name, ".tif")), overwrite = TRUE)
  }} else if (inherits(obj, c("ggplot", "tmap"))) {{
    save_figure(name, obj)
  }} else if (inherits(obj, "sf") || inherits(obj, "sfc")) {{
    sf::st_write(obj, file.path(outputs_dir, paste0(name, ".gpkg")), quiet = TRUE, delete_dsn = TRUE)
  }} else if (is.data.frame(obj) || is.matrix(obj)) {{
    save_table(name, obj)
  }} else stop(paste("cannot save", name, ": expected an sf object, a SpatRaster, a ggplot or tmap, or a data frame"))
}}
.result <- list()
result <- function(...) {{
  .result <<- utils::modifyList(.result, list(...))
  lines <- vapply(names(.result), function(k) paste0(k, "\t", paste(format(.result[[k]]), collapse = " ")), "")
  writeLines(lines, file.path(outputs_dir, "result.tsv"))
}}
.out <- local({{
# ---- your code ----
{code}
# ---- end of your code ----
}})
if (inherits(.out, c("sf", "SpatRaster", "ggplot", "tmap"))) save_layer("result", .out) else if (is.list(.out) && !is.null(names(.out)) && !is.data.frame(.out)) {{
  for (.n in names(.out)) if (!is.null(.out[[.n]])) save_layer(.n, .out[[.n]])
}}
"##,
        inputs = inputs_r.join(", "),
        params = r_literal(params),
        outputs = r_str(&outputs.to_string_lossy()),
        packages = packages_r.join(", "),
        code = code
    )
}

/// Run one code step in `dir` (created). Fails on a non-zero exit, timeout or cancel.
#[allow(clippy::too_many_arguments)]
pub fn run(lang: Lang, code: &str, inputs: &[(String, PathBuf)], params: &Value, packages: &[String], dir: &Path, timeout: Duration, cancel: &AtomicBool) -> Result<ScriptRun, String> {
    let (cmd, version) = find(lang).ok_or_else(|| format!("{} is not installed: {}", lang.name(), install_hint(lang)))?;
    let outputs = dir.join("outputs");
    std::fs::create_dir_all(&outputs).map_err(|e| format!("{}: {e}", outputs.display()))?;
    let (file, text) = match lang {
        Lang::Python => ("step.py", python_wrapper(code, inputs, params, packages, &outputs)),
        Lang::R => ("step.R", r_wrapper(code, inputs, params, packages, &outputs)),
    };
    let script = dir.join(file);
    std::fs::write(&script, text).map_err(|e| e.to_string())?;
    let stdout_path = dir.join("stdout.txt");
    let stderr_path = dir.join("stderr.txt");
    let out = std::fs::File::create(&stdout_path).map_err(|e| e.to_string())?;
    let err = std::fs::File::create(&stderr_path).map_err(|e| e.to_string())?;
    let mut c = crate::command(&cmd);
    c.arg(&script).current_dir(dir).stdin(Stdio::null()).stdout(out).stderr(err).env_clear();
    for k in ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "R_HOME", "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE", "PROJ_DATA", "PROJ_LIB", "GDAL_DATA", "SYSTEMROOT",
        // Windows: Python and R need these to find temp dirs, user libraries and system DLLs
        "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PATHEXT", "COMSPEC", "R_USER", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"] {
        if let Ok(v) = std::env::var(k) {
            c.env(k, v);
        }
    }
    if let Some(lib) = r_library() {
        c.env("GEOSPAX_R_LIBRARY", lib);
    }
    // the chart look chosen in Settings: the R prelude sets the ggplot2 theme and palette from these
    let st = super::charts::style();
    c.env("GEOSPAX_CHART_THEME", &st.theme).env("GEOSPAX_CHART_PALETTE", &st.palette).env("GEOSPAX_CHART_BASE_SIZE", st.base_size.to_string());
    c.env("PYTHONIOENCODING", "utf-8").env("PYTHONDONTWRITEBYTECODE", "1").env("GEOSPAX_STEP", "1");
    let t0 = Instant::now();
    let mut child = c.spawn().map_err(|e| format!("could not start {cmd}: {e}"))?;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        if t0.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{} step timed out after {} s", lang.name(), timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    if !status.success() {
        let tail: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(6)..].join(" | ");
        return Err(format!("{} exited with {}: {}", lang.name(), status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into()), if tail.is_empty() { "no error output".into() } else { tail }));
    }
    let mut layers = Vec::new();
    let (mut rasters, mut figures, mut tables) = (Vec::new(), Vec::new(), Vec::new());
    let mut result = Map::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&outputs).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
            "geojson" | "gpkg" | "fgb" | "shp" | "kml" => layers.push((name, p)),
            "tif" | "tiff" => rasters.push((name, p)),
            "png" | "pdf" | "svg" => figures.push((name, p)),
            "csv" => tables.push((name, p)),
            "json" if name == "result" => {
                if let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&std::fs::read(&p).unwrap_or_default()) {
                    result.extend(m);
                }
            }
            "tsv" if name == "result" => {
                for line in std::fs::read_to_string(&p).unwrap_or_default().lines() {
                    if let Some((k, v)) = line.split_once('\t') {
                        let v = v.trim();
                        let val = v.parse::<i64>().map(|i| json!(i)).or_else(|_| v.parse::<f64>().map(|f| json!(f))).unwrap_or_else(|_| json!(v));
                        result.insert(k.to_string(), val);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(ScriptRun { interpreter: cmd, version, layers, rasters, figures, tables, result, stdout, stderr, ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r_literals() {
        assert_eq!(r_literal(&json!({ "field": "ph", "power": 2, "grid": [60, 45], "x": null, "ok": true })), r#"list("field" = "ph", "grid" = c(60, 45), "ok" = TRUE, "power" = 2, "x" = NULL)"#);
        assert_eq!(r_str("a\"b\\c"), r#""a\"b\\c""#);
    }

    #[test]
    fn python_step_roundtrip() {
        let Some(_) = find(Lang::Python) else { return };
        let dir = std::env::temp_dir().join(format!("geospax-sidecar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("pts.geojson");
        std::fs::write(&input, r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"v":1},"geometry":{"type":"Point","coordinates":[144.2,-5.8]}}]}"#).unwrap();
        let code = "fc = pts if isinstance(pts, dict) else json.loads(pts.to_json())\nsave('copy', fc)\nresult(n=len(fc['features']), scale=params['scale'])";
        let r = run(Lang::Python, code, &[("pts".into(), input)], &json!({ "scale": 2 }), &[], &dir, Duration::from_secs(60), &AtomicBool::new(false)).unwrap();
        assert_eq!(r.layers.len(), 1);
        assert_eq!(r.result["n"], json!(1));
        assert_eq!(r.result["scale"], json!(2));
        let e = run(Lang::Python, "raise ValueError('boom')", &[], &json!({}), &[], &dir, Duration::from_secs(60), &AtomicBool::new(false)).err().unwrap();
        assert!(e.contains("boom"), "{e}");
        let e = run(Lang::Python, "pass", &[], &json!({}), &["surely_not_a_module_xyz".into()], &dir, Duration::from_secs(60), &AtomicBool::new(false)).err().unwrap();
        assert!(e.contains("pip install"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn r_step_returns_rasters_figures_tables() {
        let Some(_) = find(Lang::R) else { return };
        let probe = crate::command(&find(Lang::R).unwrap().0).args(["-e", "stopifnot(requireNamespace('terra', quietly = TRUE), requireNamespace('ggplot2', quietly = TRUE))"]).output();
        if !probe.map(|o| o.status.success()).unwrap_or(false) {
            return;
        }
        let dir = std::env::temp_dir().join(format!("geospax-sidecar-r-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let code = r#"
r <- terra::rast(nrows = 10, ncols = 12, xmin = 144, xmax = 145, ymin = -6, ymax = -5, crs = "EPSG:4326")
terra::values(r) <- seq_len(terra::ncell(r))
df <- data.frame(name = c("a", "b, c"), value = c(1.5, NA))
p <- ggplot2::ggplot(df, ggplot2::aes(name, value)) + ggplot2::geom_col()
save_figure("bars", p, width = 80, height = 60, formats = "png")
save_figure("base", function() terra::plot(r), formats = c("png", "pdf"))
result(cells = terra::ncell(r))
list(surface = r, summary = df)
"#;
        let run = run(Lang::R, code, &[], &json!({}), &["terra".into(), "ggplot2".into()], &dir, Duration::from_secs(120), &AtomicBool::new(false)).unwrap();
        assert_eq!(run.rasters.len(), 1, "{}", run.stderr);
        assert_eq!(run.tables.len(), 1);
        assert_eq!(run.figures.len(), 3, "{:?}", run.figures);
        assert_eq!(run.result["cells"], json!(120));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
