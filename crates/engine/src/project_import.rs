//! Opening projects from earlier GeoSpaX versions: a 1.4.2 project (`.gspx`, JSON with
//! `"format": "geospax-project"`, every vector layer embedded as GeoJSON) and a 2.0 / GeoLibre project
//! (`.geolibre.json`, layers whose `source.data` holds an inline FeatureCollection). Their embedded
//! layers are written as GeoJSON files to a cache folder and opened like any other layer, named
//! `<project>.<layer>`. Styles, the map view and layers that only point at outside files are not
//! carried over (they are listed in the warning instead); AutoMap styles the layers.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// True when `path` looks like a 1.4.2 or 2.0 project (by name, then by its first bytes).
pub fn is_project(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.ends_with(".gspx") || name.ends_with(".geolibre.json") {
        return true;
    }
    if !name.ends_with(".json") {
        return false;
    }
    let head = std::fs::read(path).map(|b| String::from_utf8_lossy(&b[..b.len().min(4096)]).to_string()).unwrap_or_default();
    head.contains("\"geospax-project\"") || (head.contains("\"mapView\"") && head.contains("\"layers\""))
}

/// The embedded layers as GeoJSON files (cached by path and modification time) and what was left out.
pub fn extract(path: &Path) -> Result<(Vec<PathBuf>, Vec<String>), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("{} is not a readable project: {e}", path.display()))?;
    let stamp = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let stem = path.file_name().map(|n| n.to_string_lossy().replace(".geolibre.json", "").replace(".gspx", "").replace(".json", "")).unwrap_or_else(|| "project".into());
    let stem = crate::catalog::sanitize(&stem);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&(path.to_string_lossy(), stamp), &mut h);
    let dir = std::env::temp_dir().join("geospax-projects").join(format!("{stem}-{:x}", std::hash::Hasher::finish(&h)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let (mut files, mut left_out) = (Vec::new(), Vec::new());
    let layers = v.get("layers").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    if layers.is_empty() {
        return Err(format!("{} holds no layers", path.display()));
    }
    let mut used = std::collections::HashSet::new();
    for (i, l) in layers.iter().enumerate() {
        let name = l.get("name").and_then(|n| n.as_str()).unwrap_or("layer").to_string();
        // 1.4.2: layer.geojson; 2.0 / GeoLibre: layer.source.data (inline FeatureCollection)
        let fc = l.get("geojson").filter(|g| g.get("features").is_some()).or_else(|| l.get("source").and_then(|s| s.get("data")).filter(|d| d.get("features").is_some()));
        let Some(fc) = fc else {
            let why = if l.get("isRaster").and_then(|b| b.as_bool()).unwrap_or(false) { "raster, not embedded" } else { "not embedded in the project" };
            left_out.push(format!("{name} ({why})"));
            continue;
        };
        if fc["features"].as_array().is_none_or(|f| f.is_empty()) {
            left_out.push(format!("{name} (no features)"));
            continue;
        }
        let mut slug = crate::catalog::sanitize(&name).replace('.', "_");
        if slug.trim_matches('_').is_empty() {
            slug = format!("layer_{i}");
        }
        while !used.insert(slug.clone()) {
            slug.push('_');
        }
        let file = dir.join(format!("{slug}.geojson"));
        let out = serde_json::json!({ "type": "FeatureCollection", "name": slug, "features": fc["features"] });
        std::fs::write(&file, out.to_string()).map_err(|e| e.to_string())?;
        files.push(file);
    }
    if files.is_empty() {
        return Err(format!("{}: none of its {} layers holds embedded features ({})", path.display(), layers.len(), left_out.join(", ")));
    }
    Ok((files, left_out))
}

/// Layers of a project file, named `<project>.<layer>`.
pub fn load(path: &Path) -> Result<Vec<crate::catalog::LayerHandle>, String> {
    let (files, left_out) = extract(path)?;
    if !left_out.is_empty() {
        eprintln!("{}: not imported: {}", path.display(), left_out.join(", "));
    }
    let stem = crate::catalog::sanitize(&path.file_name().map(|n| n.to_string_lossy().replace(".geolibre.json", "").replace(".gspx", "").replace(".json", "")).unwrap_or_default());
    let mut out = Vec::new();
    for f in files {
        for mut h in crate::catalog::load_layers_plain(&f)? {
            let layer = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            h.info.id = format!("{stem}.{layer}");
            h.info.source = path.display().to_string();
            out.push(h);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_142_and_20_projects() {
        let dir = std::env::temp_dir().join(format!("gx-proj-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pt = r#"{"type":"Feature","properties":{"n":1},"geometry":{"type":"Point","coordinates":[146,-6]}}"#;
        let p142 = dir.join("field.gspx");
        std::fs::write(&p142, format!(r#"{{"format":"geospax-project","formatVersion":2,"layers":[{{"name":"Survey sites","geojson":{{"type":"FeatureCollection","features":[{pt}]}}}},{{"name":"BIO1","isRaster":true,"geojson":null}}]}}"#)).unwrap();
        let p20 = dir.join("study.geolibre.json");
        std::fs::write(&p20, format!(r#"{{"version":"1","name":"x","mapView":{{}},"layers":[{{"name":"Plots","type":"geojson","source":{{"data":{{"type":"FeatureCollection","features":[{pt}]}}}}}},{{"name":"Remote","source":{{"data":"https://example.org/a.geojson"}}}}]}}"#)).unwrap();
        assert!(is_project(&p142) && is_project(&p20));
        let (f, out) = extract(&p142).unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(out, vec!["BIO1 (raster, not embedded)".to_string()]);
        let (f, out) = extract(&p20).unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(out.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
