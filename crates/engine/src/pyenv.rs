//! Python environments in the Explorer (as VS Code's Python environment picker, and ArcGIS Pro's
//! Package Manager): the interpreters on this computer (on PATH, conda/mamba environments, pyenv
//! versions, virtual environments in the usual places and in the data folders), which geospatial
//! packages each has, and which one GeoSpaX's Python steps use. The choice is kept in
//! `<state>/python.json` and applied through GEOSPAX_PYTHON, which `sidecar::find` reads first.
//! Only an interpreter that was found here can be chosen, so the API never runs an arbitrary path.

use crate::automation::sidecar::{self, Lang};
use crate::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// The packages shown for each environment, in the order a GIS user cares about.
pub const GEO_PACKAGES: &[&str] = &[
    "geopandas", "shapely", "pyproj", "rasterio", "fiona", "pyogrio", "GDAL", "xarray", "rioxarray", "numpy", "pandas", "scipy",
    "scikit-learn", "matplotlib", "pystac-client", "duckdb", "leafmap", "osmnx",
];

fn file(state: &Path) -> PathBuf {
    state.join("python.json")
}

/// The chosen interpreter (if any), applied at start.
pub fn apply_saved(state: &Path) {
    let chosen = std::fs::read(file(state)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["python"].as_str().map(str::to_string));
    if let Some(p) = chosen.filter(|p| Path::new(p).is_file()) {
        unsafe { std::env::set_var("GEOSPAX_PYTHON", p) };
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// The interpreter inside an environment folder.
fn env_python(dir: &Path) -> Option<PathBuf> {
    let p = if cfg!(windows) { dir.join("python.exe") } else { dir.join("bin").join("python") };
    let p2 = if cfg!(windows) { dir.join("Scripts").join("python.exe") } else { dir.join("bin").join("python3") };
    [p, p2].into_iter().find(|x| x.is_file())
}

fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(if cfg!(windows) { format!("{bin}.exe") } else { bin.to_string() })).find(|p| p.is_file())
}

fn subdirs(d: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    v.sort();
    v
}

/// Every interpreter found: (label, kind, path). Duplicates (the same file) are dropped.
fn candidates(engine: &Engine) -> Vec<(String, &'static str, PathBuf)> {
    let mut out: Vec<(String, &'static str, PathBuf)> = Vec::new();
    for b in if cfg!(windows) { &["python", "py", "python3"][..] } else { &["python3", "python"][..] } {
        if let Some(p) = which(b) {
            out.push(("System Python".into(), "system", p));
        }
    }
    // conda / mamba / micromamba environments
    for tool in ["conda", "mamba", "micromamba"] {
        let Some(bin) = which(tool) else { continue };
        let Ok(o) = crate::command(bin.to_string_lossy().as_ref()).args(["env", "list", "--json"]).stdin(Stdio::null()).output() else { continue };
        let v: Value = serde_json::from_slice(&o.stdout).unwrap_or_default();
        for e in v["envs"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let dir = PathBuf::from(e);
            if let Some(py) = env_python(&dir) {
                let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                out.push((format!("conda: {name}"), "conda", py));
            }
        }
    }
    if let Some(h) = home() {
        for d in subdirs(&h.join(".pyenv").join("versions")) {
            if let Some(py) = env_python(&d) {
                out.push((format!("pyenv: {}", d.file_name().unwrap_or_default().to_string_lossy()), "pyenv", py));
            }
        }
        for base in [".virtualenvs", "venvs", ".venvs"] {
            for d in subdirs(&h.join(base)) {
                if let Some(py) = env_python(&d) {
                    out.push((format!("venv: {}", d.file_name().unwrap_or_default().to_string_lossy()), "venv", py));
                }
            }
        }
        for base in ["miniforge3", "mambaforge", "miniconda3", "anaconda3"] {
            let root = h.join(base);
            if let Some(py) = env_python(&root) {
                out.push((format!("conda: {base} (base)"), "conda", py.clone()));
            }
            for d in subdirs(&root.join("envs")) {
                if let Some(py) = env_python(&d) {
                    out.push((format!("conda: {}", d.file_name().unwrap_or_default().to_string_lossy()), "conda", py));
                }
            }
        }
    }
    // a .venv in a data folder (a project's own environment)
    for (_, root, _) in crate::browse::roots(engine) {
        for d in [root.join(".venv"), root.join("venv")] {
            if let Some(py) = env_python(&d) {
                out.push((format!("venv: {}", root.file_name().unwrap_or_default().to_string_lossy()), "venv", py));
            }
        }
    }
    // python3 and python on PATH are often the same file; an environment is its own even when its
    // interpreter links to the system one (a venv), so only PATH entries are merged by their target
    let mut seen = Vec::new();
    out.retain(|(_, kind, p)| {
        let c = if *kind == "system" { std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()) } else { p.clone() };
        if seen.contains(&c) {
            false
        } else {
            seen.push(c);
            true
        }
    });
    out
}

fn version_of(py: &Path) -> Option<String> {
    let o = crate::command(py.to_string_lossy().as_ref()).arg("--version").stdin(Stdio::null()).output().ok()?;
    o.status.success().then(|| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)).trim().trim_start_matches("Python ").to_string())
}

/// The environments, with their versions and which one is in use.
pub fn list(engine: &Engine) -> Value {
    let current = sidecar::find(Lang::Python).map(|(c, _)| c);
    let chosen = std::env::var("GEOSPAX_PYTHON").ok();
    let current_real = current.as_ref().and_then(|c| which(c).or_else(|| Some(PathBuf::from(c)))).map(|p| std::fs::canonicalize(&p).unwrap_or(p));
    let envs: Vec<Value> = candidates(engine)
        .into_iter()
        .filter_map(|(label, kind, path)| {
            let version = version_of(&path)?;
            let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            // the chosen environment by its own path; otherwise the interpreter found on PATH
            let is_current = match &chosen {
                Some(c) => Path::new(c) == path,
                None => kind == "system" && current_real.as_ref() == Some(&real),
            };
            Some(json!({ "label": label, "kind": kind, "path": path.display().to_string(), "version": version, "current": is_current }))
        })
        .collect();
    json!({ "environments": envs, "current": current, "packages": GEO_PACKAGES })
}

/// Which of GEO_PACKAGES one environment has (name → version, or null), and how many packages in all.
pub fn packages(engine: &Engine, path: &str) -> Result<Value, String> {
    let py = known(engine, path)?;
    let names = GEO_PACKAGES.iter().map(|p| format!("{p:?}")).collect::<Vec<_>>().join(", ");
    let script = format!(
        "import json\ntry:\n    from importlib import metadata as m\nexcept ImportError:\n    import importlib_metadata as m\nout = {{}}\nfor p in [{names}]:\n    try:\n        out[p] = m.version(p)\n    except Exception:\n        out[p] = None\nn = sum(1 for _ in m.distributions())\nprint(json.dumps({{'packages': out, 'total': n}}))\n"
    );
    let o = crate::command(py.to_string_lossy().as_ref()).args(["-c", &script]).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&o.stdout);
    serde_json::from_str(text.trim()).map_err(|_| format!("could not read its packages: {}", String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("")))
}

/// `path` if it is one of the interpreters found (never an arbitrary program).
fn known(engine: &Engine, path: &str) -> Result<PathBuf, String> {
    candidates(engine).into_iter().map(|c| c.2).find(|p| p.to_string_lossy() == path).ok_or_else(|| "not one of the Python environments found on this computer".into())
}

/// Use this environment for GeoSpaX's Python steps (kept for the next start).
pub fn choose(engine: &Engine, path: &str) -> Result<Value, String> {
    let py = known(engine, path)?;
    std::fs::create_dir_all(&engine.state_dir).map_err(|e| e.to_string())?;
    std::fs::write(file(&engine.state_dir), serde_json::to_vec_pretty(&json!({ "python": py })).unwrap()).map_err(|e| e.to_string())?;
    unsafe { std::env::set_var("GEOSPAX_PYTHON", &py) };
    Ok(json!({ "python": py, "version": version_of(&py) }))
}
