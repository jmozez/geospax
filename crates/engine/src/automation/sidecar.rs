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
        Lang::R => ("GEOSPAX_RSCRIPT", &["Rscript"]),
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

pub fn install_hint(lang: Lang) -> &'static str {
    match lang {
        Lang::Python => "install Python 3 (https://www.python.org) or set GEOSPAX_PYTHON",
        Lang::R => "install R (https://cran.r-project.org; Debian/Ubuntu: apt install r-base-core r-cran-sf r-cran-gstat) or set GEOSPAX_RSCRIPT",
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
        r#"# GeoSpaX R step (generated). Your code is between the markers below.
inputs <- list({inputs})
params <- {params}
outputs_dir <- {outputs}
.missing <- Filter(function(p) !requireNamespace(p, quietly = TRUE), c({packages}))
if (length(.missing) > 0) stop(paste0("missing R packages: ", paste(.missing, collapse = ", "),
  "  (install with: install.packages(c(", paste0('"', .missing, '"', collapse = ", "), ")))"), call. = FALSE)
.has_sf <- requireNamespace("sf", quietly = TRUE)
for (.n in names(inputs)) assign(.n, if (.has_sf) sf::st_read(inputs[[.n]], quiet = TRUE) else inputs[[.n]])
save_layer <- function(name, obj) {{
  if (inherits(obj, "sf") || inherits(obj, "sfc")) {{
    sf::st_write(obj, file.path(outputs_dir, paste0(name, ".gpkg")), quiet = TRUE, delete_dsn = TRUE)
  }} else if (is.data.frame(obj)) {{
    utils::write.csv(obj, file.path(outputs_dir, paste0(name, ".csv")), row.names = FALSE)
  }} else stop(paste("cannot save", name, "as a layer: expected an sf object or a data.frame"))
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
if (inherits(.out, "sf")) save_layer("result", .out) else if (is.list(.out) && !is.null(names(.out)) && !is.data.frame(.out)) {{
  for (.n in names(.out)) if (!is.null(.out[[.n]])) save_layer(.n, .out[[.n]])
}}
"#,
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
    let mut result = Map::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&outputs).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
            "geojson" | "gpkg" | "fgb" | "shp" | "kml" => layers.push((name, p)),
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
    Ok(ScriptRun { interpreter: cmd, version, layers, result, stdout, stderr, ms })
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
}
