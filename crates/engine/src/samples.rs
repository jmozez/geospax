//! Sample data that ships with GeoSpaX (`samples/<set>/` with a `sample.json`; installed next to the
//! program, like the bundled plugins). Data › Sample data copies a set into the first writable data
//! folder (`Samples/<set>/`) and puts its layers and rasters on the map.
//! `GET /api/samples` lists the sets, `POST /api/samples/<set>` opens one.

use crate::Engine;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The folder holding the sample sets: `$GEOSPAX_SAMPLES`, `./samples`, next to the program, or
/// `<prefix>/share/geospax/samples` (Linux packages).
pub fn bundled_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("GEOSPAX_SAMPLES") {
        return Some(PathBuf::from(v)).filter(|p| p.is_dir());
    }
    let mut c = vec![PathBuf::from("samples")];
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        c.push(d.join("samples"));
        c.push(d.parent().unwrap_or(&d).join("share/geospax/samples"));
    }
    c.into_iter().find(|p| p.join("png/sample.json").is_file()).and_then(|p| p.canonicalize().ok())
}

/// Every sample set: its sample.json plus the files it holds.
pub fn list() -> Vec<Value> {
    let Some(root) = bundled_dir() else { return Vec::new() };
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&root) else { return out };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join("sample.json").is_file()).collect();
    dirs.sort();
    for d in dirs {
        let Ok(mut meta) = fs::read(d.join("sample.json")).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) else {
            continue;
        };
        let mut files: Vec<String> = data_files(&d).iter().filter_map(|f| f.file_name().map(|n| n.to_string_lossy().to_string())).collect();
        files.sort();
        meta["files"] = json!(files);
        out.push(meta);
    }
    out
}

fn data_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| matches!(e.to_string_lossy().to_lowercase().as_str(), "geojson" | "gpkg" | "tif" | "tiff" | "fgb" | "csv" | "md")))
                .collect()
        })
        .unwrap_or_default()
}

/// Copy a set into the data folder (once; later calls reuse the copy) and add it to the map.
pub fn open(engine: &Arc<Engine>, set: &str) -> Result<Value, String> {
    if set.is_empty() || !set.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("there is no sample set '{set}'"));
    }
    let root = bundled_dir().ok_or("this installation has no sample data")?;
    let src = root.join(set);
    if !src.join("sample.json").is_file() {
        return Err(format!("there is no sample set '{set}'"));
    }
    // Uploads/ is the writable data folder; samples go beside it
    let dest = crate::upload::upload_dir(engine).parent().map(|p| p.join("Samples").join(set)).ok_or("no writable data folder")?;
    fs::create_dir_all(&dest).map_err(|e| format!("could not create {}: {e}", dest.display()))?;
    let mut files = Vec::new();
    for f in data_files(&src) {
        let to = dest.join(f.file_name().unwrap_or_default());
        if !to.exists() {
            fs::copy(&f, &to).map_err(|e| format!("could not copy {}: {e}", f.display()))?;
        }
        files.push(to);
    }
    // already on the map (opened before in this session): nothing to add twice
    let fresh: Vec<PathBuf> = files
        .into_iter()
        .filter(|f| {
            let p = f.to_string_lossy();
            !engine.layers().iter().any(|l| l.info.source == p) && !engine.rasters.read().unwrap().iter().any(|r| r.info.path == *f)
        })
        .collect();
    let (layers, rasters, _, skipped) = crate::upload::register_files(engine, &fresh);
    Ok(json!({ "set": set, "folder": dest.display().to_string(), "layers": layers, "rasters": rasters, "skipped": skipped }))
}
