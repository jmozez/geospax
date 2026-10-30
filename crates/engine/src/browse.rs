//! The Catalog's file browser (`GET /api/browse[?path=…]`, `POST /api/browse/add?path=…`): the data
//! folders, the edit copies and the uploads, with every file the engine can open, what kind it is and
//! whether it is already on the map, as the Catalog pane in ArcGIS Pro and the Browser panel in QGIS.
//! Only folders inside those roots can be listed or opened, so the web edition never shows the rest
//! of the machine.

use crate::Engine;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The folders the Catalog starts from: (title, path, what it holds).
pub fn roots(engine: &Engine) -> Vec<(String, PathBuf, &'static str)> {
    let mut out = Vec::new();
    for d in &engine.data_dirs {
        if d.is_dir() {
            let name = d
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| d.display().to_string());
            out.push((
                name,
                d.clone(),
                "Data folder: GeoSpaX reads every layer and raster in it at start",
            ));
        }
    }
    let edits = engine.state_dir.join("edits");
    if edits.is_dir() {
        out.push((
            "Edits".into(),
            edits,
            "Copies of layers you edited and layers you created",
        ));
    }
    for c in engine.connections.read().unwrap().iter() {
        if c.is_dir() && !out.iter().any(|(_, p, _)| p == c) {
            out.push((
                folder_title(c),
                c.clone(),
                "Folder connection: browse it and open what you need",
            ));
        }
    }
    let uploads = engine.state_dir.join("uploads");
    if uploads.is_dir() {
        out.push((
            "Uploads".into(),
            uploads,
            "Files dropped on the app (when no data folder can be written)",
        ));
    }
    out
}

fn folder_title(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.display().to_string())
}

fn connections_file(state: &Path) -> PathBuf {
    state.join("folders.json")
}

/// The folder connections saved by an earlier session.
pub fn load_connections(state: &Path) -> Vec<PathBuf> {
    std::fs::read(connections_file(state))
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .map(|v| v.into_iter().map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn save_connections(engine: &Engine) -> Result<(), String> {
    let list: Vec<String> = engine
        .connections
        .read()
        .unwrap()
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    std::fs::create_dir_all(&engine.state_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        connections_file(&engine.state_dir),
        serde_json::to_vec_pretty(&list).unwrap(),
    )
    .map_err(|e| e.to_string())
}

const SHARED: &str = "this GeoSpaX was started with --restricted, so folders cannot be connected from here; start it without --restricted, or with --data <folder>";

/// Connect a folder: it shows in the Explorer from now on (and after a restart).
pub fn connect(engine: &Engine, path: &str) -> Result<Value, String> {
    if engine.shared.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(SHARED.into());
    }
    let p = canonical(Path::new(path.trim())).ok_or_else(|| format!("{path}: no such folder"))?;
    if !p.is_dir() {
        return Err(format!("{} is not a folder", p.display()));
    }
    if p.parent().is_none() {
        return Err("connect a folder, not the whole disk".into());
    }
    {
        let mut c = engine.connections.write().unwrap();
        if !c.contains(&p) {
            c.push(p.clone());
        }
    }
    save_connections(engine)?;
    Ok(json!({ "connected": p.display().to_string(), "title": folder_title(&p) }))
}

/// Remove a folder connection (the folder and its files are not touched).
pub fn disconnect(engine: &Engine, path: &str) -> Result<Value, String> {
    let p = canonical(Path::new(path.trim())).unwrap_or_else(|| PathBuf::from(path.trim()));
    let before = engine.connections.read().unwrap().len();
    engine
        .connections
        .write()
        .unwrap()
        .retain(|c| c != &p && c.display().to_string() != path.trim());
    if engine.connections.read().unwrap().len() == before {
        return Err(format!("{path} is not a folder connection"));
    }
    save_connections(engine)?;
    Ok(json!({ "disconnected": path }))
}

/// Folders anywhere on this computer, for the "Connect a folder" chooser: the home folder (or the
/// given folder), its sub-folders and the drives / places to start from. Refused when shared.
pub fn pick(engine: &Engine, path: Option<&str>) -> Result<Value, String> {
    if engine.shared.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(SHARED.into());
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let dir = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => canonical(Path::new(p.trim())).ok_or_else(|| format!("{p}: no such folder"))?,
        None => home.clone(),
    };
    let mut folders: Vec<Value> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| json!({ "name": e.file_name().to_string_lossy(), "path": e.path().display().to_string() }))
        .collect();
    folders.sort_by_key(|f| f["name"].as_str().unwrap_or("").to_lowercase());
    let mut places = vec![json!({ "name": "Home", "path": home.display().to_string() })];
    if cfg!(windows) {
        for d in b'C'..=b'Z' {
            let root = format!("{}:\\", d as char);
            if Path::new(&root).is_dir() {
                places.push(json!({ "name": format!("{}:", d as char), "path": root }));
            }
        }
    } else {
        for (n, p) in [
            ("Computer", "/"),
            ("Media", "/media"),
            ("Mounted", "/mnt"),
            ("Volumes", "/Volumes"),
        ] {
            if Path::new(p).is_dir() {
                places.push(json!({ "name": n, "path": p }));
            }
        }
    }
    let files = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| kind_of(&e.path()).is_some())
                .count()
        })
        .unwrap_or(0);
    Ok(
        json!({ "path": dir.display().to_string(), "parent": dir.parent().map(|p| p.display().to_string()), "folders": folders, "places": places, "map_files": files }),
    )
}

fn canonical(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// `path` resolved, if it lies inside one of the roots.
fn inside_roots(engine: &Engine, path: &Path) -> Option<PathBuf> {
    let p = canonical(path)?;
    roots(engine)
        .iter()
        .filter_map(|(_, r, _)| canonical(r))
        .any(|r| p.starts_with(&r))
        .then_some(p)
}

/// What a file is to GeoSpaX, by extension; None for files it does not open.
pub fn kind_of(p: &Path) -> Option<&'static str> {
    let name = p.file_name()?.to_string_lossy().to_lowercase();
    if name.ends_with(".gspx") || name.ends_with(".geolibre.json") {
        return Some("project");
    }
    let ext = p.extension()?.to_string_lossy().to_lowercase();
    Some(match ext.as_str() {
        "tif" | "tiff" => "raster",
        "las" | "laz" => "point cloud",
        "geojson" | "json" | "gpkg" | "fgb" | "shp" | "kml" | "kmz" | "gpx" | "csv" | "gml"
        | "parquet" | "nmea" | "pmtiles" => "vector",
        "zip" => "archive",
        "yaml" | "yml" => "recipe",
        _ => return None,
    })
}

/// The ids of layers and rasters on the map that were read from `file`.
fn on_map(engine: &Engine, file: &Path) -> Vec<String> {
    let Some(f) = canonical(file) else {
        return vec![];
    };
    let mut ids: Vec<String> = engine
        .layers()
        .iter()
        .filter(|l| {
            canonical(Path::new(&l.info.source)).as_deref() == Some(f.as_path())
                || canonical(l.path()).as_deref() == Some(f.as_path())
        })
        .map(|l| l.info.id.clone())
        .collect();
    for id in engine.edited_from(&f) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.extend(
        engine
            .rasters()
            .iter()
            .filter(|r| canonical(&r.info.path).as_deref() == Some(f.as_path()))
            .map(|r| r.info.id.clone()),
    );
    ids
}

/// The roots, or one folder's sub-folders and openable files.
pub fn list(engine: &Engine, path: Option<&str>) -> Result<Value, String> {
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        let rs: Vec<Value> = roots(engine)
            .into_iter()
            .map(|(title, p, about)| json!({ "title": title, "path": p.display().to_string(), "about": about, "connection": about.starts_with("Folder connection") }))
            .collect();
        return Ok(
            json!({ "roots": rs, "can_connect": !engine.shared.load(std::sync::atomic::Ordering::Relaxed) }),
        );
    };
    let dir = inside_roots(engine, Path::new(path))
        .ok_or("that folder is outside GeoSpaX's data folders")?;
    let mut folders = Vec::new();
    let mut files = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            folders.push(json!({ "name": name, "path": p.display().to_string() }));
        } else if let Some(kind) = kind_of(&p) {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            files.push(json!({ "name": name, "path": p.display().to_string(), "kind": kind, "size": size, "on_map": on_map(engine, &p), "container": is_container(&p) }));
        }
    }
    let by_name = |a: &Value, b: &Value| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    };
    folders.sort_by(by_name);
    files.sort_by(by_name);
    let parent = dir
        .parent()
        .and_then(|p| inside_roots(engine, p))
        .map(|p| p.display().to_string());
    Ok(
        json!({ "path": dir.display().to_string(), "parent": parent, "folders": folders, "files": files }),
    )
}

/// Put one file from a data folder on the map.
pub fn add(engine: &Arc<Engine>, path: &str, layer: Option<&str>) -> Result<Value, String> {
    // a file inside a zip, or one layer of a GeoPackage
    if path.starts_with("/vsizip/") || layer.is_some() {
        let p = resolve(engine, path)?;
        if matches!(kind_of(&p), Some("raster")) {
            let id = p
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let h = engine.register_raster(&p, &id)?;
            return Ok(json!({ "layers": [], "rasters": [h.info.id.clone()] }));
        }
        let mut hs = crate::catalog::load_layers(&p)?;
        if let Some(name) = layer {
            hs.retain(|h| h.info.name == name);
        }
        if hs.is_empty() {
            return Err(format!("{}: no layer {}", p.display(), layer.unwrap_or("")));
        }
        let ids = engine.register_layers(hs);
        return Ok(json!({ "layers": ids, "rasters": [] }));
    }
    let p = inside_roots(engine, Path::new(path))
        .ok_or("that file is outside GeoSpaX's data folders")?;
    if !p.is_file() {
        return Err(format!("{} is not a file", p.display()));
    }
    let already = on_map(engine, &p);
    if !already.is_empty() {
        return Ok(json!({ "layers": already, "rasters": [], "already": true }));
    }
    let (layers, rasters, kept, skipped) = crate::upload::register_files(engine, &[p.clone()]);
    if layers.is_empty() && rasters.is_empty() {
        let why = skipped.first().cloned().or_else(|| {
            kept.first()
                .map(|k| format!("{k}: point clouds are opened by the lidar-to-terrain recipe"))
        });
        return Err(why.unwrap_or_else(|| format!("{}: nothing GeoSpaX can draw", p.display())));
    }
    Ok(json!({ "layers": layers, "rasters": rasters, "skipped": skipped }))
}

/// Files whose layers the Explorer can list one by one.
pub fn is_container(p: &Path) -> bool {
    matches!(
        p.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .as_deref(),
        Some("gpkg" | "zip" | "kmz")
    )
}

/// A path the Explorer may read: a file inside the roots, or a member of a zip inside them
/// (`/vsizip/<zip>/<member>`).
fn resolve(engine: &Engine, path: &str) -> Result<PathBuf, String> {
    if let Some(rest) = path.strip_prefix("/vsizip/") {
        let lower = rest.to_lowercase();
        let end = lower.find(".zip").map(|i| i + 4).ok_or("not a zip path")?;
        let zip = inside_roots(engine, Path::new(&rest[..end]))
            .ok_or("that file is outside GeoSpaX's folders")?;
        return Ok(PathBuf::from(format!(
            "/vsizip/{}{}",
            zip.display(),
            &rest[end..]
        )));
    }
    inside_roots(engine, Path::new(path))
        .ok_or_else(|| "that file is outside GeoSpaX's folders".to_string())
}

/// What is inside a container: the layers of a GeoPackage (name, geometry, count) or the map files
/// in a zip (each readable in place as /vsizip/…).
pub fn inside(engine: &Engine, path: &str) -> Result<Value, String> {
    use gdal::vector::LayerAccess;
    let p = resolve(engine, path)?;
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut items = Vec::new();
    if ext == "zip" {
        let root = format!("/vsizip/{}", p.display());
        let c = std::ffi::CString::new(root.clone()).map_err(|e| e.to_string())?;
        unsafe {
            let list = gdal_sys::VSIReadDirRecursive(c.as_ptr());
            if !list.is_null() {
                let mut i = 0;
                loop {
                    let item = *list.add(i);
                    if item.is_null() {
                        break;
                    }
                    let name = std::ffi::CStr::from_ptr(item).to_string_lossy().to_string();
                    let member = format!("{root}/{name}");
                    if let Some(kind) =
                        kind_of(Path::new(&name)).filter(|k| *k != "archive" && *k != "recipe")
                    {
                        items.push(json!({ "name": name, "path": member, "kind": kind }));
                    }
                    i += 1;
                }
                gdal_sys::CSLDestroy(list);
            }
        }
    } else {
        let ds = crate::catalog::open_vector(&p)?;
        for lyr in ds.layers() {
            let geom = lyr
                .defn()
                .geom_fields()
                .next()
                .map(|g| format!("{:?}", g.field_type()))
                .unwrap_or_else(|| "table".into());
            let name = lyr.name();
            let cp = canonical(&p);
            let on: Vec<String> = engine
                .layers()
                .iter()
                .filter(|l| l.info.name == name && canonical(Path::new(&l.info.source)) == cp)
                .map(|l| l.info.id.clone())
                .collect();
            items.push(json!({ "name": name, "path": p.display().to_string(), "layer": name, "kind": "vector", "geometry": geometry_word(&geom), "count": lyr.feature_count(), "on_map": on }));
        }
    }
    Ok(json!({ "path": path, "items": items }))
}

pub(crate) fn geometry_word(t: &str) -> &'static str {
    // OGRwkbGeometryType as a number (2.5D and ISO Z/M variants folded): 1/4 points, 2/5 lines, 3/6 polygons
    if let Ok(n) = t.parse::<u64>() {
        return match (n & 0x7fff_ffff) % 1000 {
            1 | 4 => "points",
            2 | 5 => "lines",
            3 | 6 => "polygons",
            100 => "table",
            _ => "features",
        };
    }
    let t = t.to_lowercase();
    if t.contains("point") {
        "points"
    } else if t.contains("line") || t.contains("string") {
        "lines"
    } else if t.contains("polygon") || t.contains("surface") {
        "polygons"
    } else if t == "table" {
        "table"
    } else {
        "features"
    }
}

fn field_word(t: u32) -> &'static str {
    match t {
        0 | 12 => "whole numbers",
        2 => "numbers",
        4 => "text",
        9 => "dates",
        10 => "times",
        11 => "date-times",
        _ => "other",
    }
}

/// A look before adding: where it is (lon/lat bounds), its CRS and size, its fields and a few rows
/// (vectors) or its grid and bands (rasters). Nothing is registered.
pub fn preview(engine: &Engine, path: &str, layer: Option<&str>) -> Result<Value, String> {
    use gdal::vector::LayerAccess;
    let p = resolve(engine, path)?;
    if matches!(kind_of(&p), Some("raster")) {
        let ds = crate::raster::open(&p)?;
        let (w, h) = ds.raster_size();
        let b = crate::raster::lonlat_bounds(&ds).ok();
        let crs = crate::raster::srs_of(&ds)
            .and_then(|s| s.auth_code().ok().map(|c| format!("EPSG:{c}")))
            .unwrap_or_else(|| "unknown".into());
        return Ok(
            json!({ "kind": "raster", "bounds": b, "crs": crs, "width": w, "height": h, "bands": ds.raster_count() }),
        );
    }
    let ds = crate::catalog::open_vector(&p)?;
    let mut lyr = match layer {
        Some(n) => ds.layer_by_name(n).map_err(|e| e.to_string())?,
        None => ds.layer(0).map_err(|e| e.to_string())?,
    };
    let count = lyr.feature_count();
    let fields: Vec<Value> = lyr
        .defn()
        .fields()
        .map(|f| json!({ "name": f.name(), "type": field_word(f.field_type()) }))
        .collect();
    let geom = lyr
        .defn()
        .geom_fields()
        .next()
        .map(|g| format!("{:?}", g.field_type()))
        .unwrap_or_else(|| "table".into());
    let mut crs = "unknown (assumed EPSG:4326)".to_string();
    let mut bounds = None;
    if let Ok(env) = lyr.get_extent() {
        let srs = lyr.spatial_ref();
        if let Some(s) = &srs {
            crs = s
                .auth_code()
                .ok()
                .map(|c| format!("EPSG:{c}"))
                .unwrap_or_else(|| s.name().unwrap_or_default());
        }
        let (mut xs, mut ys) = (
            vec![env.MinX, env.MaxX, env.MinX, env.MaxX],
            vec![env.MinY, env.MinY, env.MaxY, env.MaxY],
        );
        let ok = match srs {
            Some(mut s) => {
                s.set_axis_mapping_strategy(
                    gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder,
                );
                let mut zs = vec![0.0; 4];
                crate::catalog::wgs84()
                    .ok()
                    .and_then(|w| gdal::spatial_ref::CoordTransform::new(&s, &w).ok())
                    .map(|ct| ct.transform_coords(&mut xs, &mut ys, &mut zs).is_ok())
                    .unwrap_or(false)
            }
            None => true,
        };
        if ok {
            let f = |v: &[f64], m: fn(f64, f64) -> f64| v.iter().copied().fold(v[0], m);
            bounds = Some([
                f(&xs, f64::min),
                f(&ys, f64::min),
                f(&xs, f64::max),
                f(&ys, f64::max),
            ]);
        }
    }
    let names: Vec<String> = fields
        .iter()
        .filter_map(|f| f["name"].as_str().map(String::from))
        .collect();
    let mut rows = Vec::new();
    for feat in lyr.features().take(5) {
        let row: Vec<Value> = names
            .iter()
            .map(|n| {
                feat.field_index(n)
                    .ok()
                    .and_then(|i| feat.field_as_string(i).ok().flatten())
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            })
            .collect();
        rows.push(Value::Array(row));
    }
    Ok(
        json!({ "kind": "vector", "layer": lyr.name(), "geometry": geometry_word(&geom), "count": count, "crs": crs, "bounds": bounds, "fields": fields, "rows": rows }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of(Path::new("a/b.GeoJSON")), Some("vector"));
        assert_eq!(kind_of(Path::new("bio1.tif")), Some("raster"));
        assert_eq!(kind_of(Path::new("old.gspx")), Some("project"));
        assert_eq!(kind_of(Path::new("x.geolibre.json")), Some("project"));
        assert_eq!(kind_of(Path::new("x.shx")), None);
        assert_eq!(kind_of(Path::new("README")), None);
    }
}
