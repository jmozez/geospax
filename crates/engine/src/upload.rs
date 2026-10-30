//! Files dropped on the app (`POST /api/upload?name=…`, body = the file): saved next to the user's
//! data and added to the map at once. Zips (a shapefile with its sidecars, a folder of GeoJSON…) are
//! unpacked; GeoTIFFs become rasters, everything GDAL reads becomes vector layers.

use crate::Engine;
use serde_json::json;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// What can be dropped. Anything else is refused with a list of these.
pub const ACCEPTED: &[&str] = &[
    "geojson", "json", "gspx", "gpkg", "fgb", "kml", "kmz", "gpx", "csv", "gml", "parquet", "zip",
    "tif", "tiff", "las", "laz", "nmea",
];
const MAX_ZIP_MEMBER: u64 = 1 << 30;

/// A safe file name: no folders, only letters, digits and `._- `, at most 120 characters.
pub fn clean_name(name: &str) -> Option<String> {
    let base = Path::new(name).file_name()?.to_string_lossy().to_string();
    let s: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "._- ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    let s = s.trim().trim_start_matches('.').to_string();
    (!s.is_empty()).then_some(s)
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// `Uploads/` in the first data folder that can be written, else `<state>/uploads`.
pub(crate) fn upload_dir(engine: &Engine) -> PathBuf {
    for d in &engine.data_dirs {
        let dir = d.join("Uploads");
        if fs::create_dir_all(&dir).is_ok()
            && fs::metadata(&dir)
                .map(|m| !m.permissions().readonly())
                .unwrap_or(false)
        {
            let probe = dir.join(".write-test");
            if fs::write(&probe, b"").is_ok() {
                let _ = fs::remove_file(probe);
                return dir;
            }
        }
    }
    let dir = engine.state_dir.join("uploads");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// `name.ext`, else `name (2).ext`, `name (3).ext`… so an upload never overwrites a file.
fn unique(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = Path::new(name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn unzip(zip_path: &Path, dest: &Path, max_total: u64) -> Result<Vec<PathBuf>, String> {
    let mut total = 0u64;
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("not a zip file: {e}"))?;
    let mut files = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        // folders are made as needed; links are never followed or created (they could point anywhere)
        if f.is_dir() || f.is_symlink() {
            continue;
        }
        let name = f.name().map_err(|e| e.to_string())?.to_string();
        if f.size() > MAX_ZIP_MEMBER {
            return Err(format!("{} is larger than 1 GB", name));
        }
        // no ../ and no absolute paths; macOS resource forks are skipped
        let mut out = dest.to_path_buf();
        for part in Path::new(&name).components() {
            match part {
                Component::Normal(p) => out.push(p),
                Component::CurDir => {}
                _ => return Err(format!("zip member '{}' points outside the folder", name)),
            }
        }
        if name.starts_with("__MACOSX") {
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut w = fs::File::create(&out).map_err(|e| e.to_string())?;
        // the sizes a zip declares can lie: count what actually comes out (zip bombs)
        let room = (max_total - total).min(MAX_ZIP_MEMBER);
        let n = std::io::copy(&mut (&mut f).take(room + 1), &mut w).map_err(|e| e.to_string())?;
        if n > room {
            drop(w);
            let _ = fs::remove_dir_all(dest);
            return Err(format!(
                "the zip unpacks to more than {} MB",
                room.min(max_total) >> 20
            ));
        }
        total += n;
        files.push(out);
    }
    Ok(files)
}

/// Put saved files on the map: GeoTIFFs as rasters, LAS/LAZ kept for the LiDAR recipe, everything else
/// GDAL opens as vector layers. Returns (layer ids, raster ids, point clouds, skipped with reasons).
pub fn register_files(
    engine: &Arc<Engine>,
    files: &[PathBuf],
) -> (Vec<String>, Vec<String>, Vec<String>, Vec<String>) {
    let (mut layers, mut rasters, mut kept, mut skipped) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for f in files {
        let e = ext_of(f);
        if matches!(e.as_str(), "tif" | "tiff") {
            let id = f
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            match engine.register_raster(f, &id) {
                Ok(h) => rasters.push(h.info.id.clone()),
                Err(err) => skipped.push(format!("{}: {err}", f.display())),
            }
        } else if e == "parquet" {
            // GeoParquet: read here (the GDAL builds GeoSpaX ships with have no Parquet driver)
            match crate::geoparquet::open_file(engine, &f.to_string_lossy(), None) {
                Ok(v) => layers.extend(
                    v["layers"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|x| x.as_str().map(str::to_string)),
                ),
                Err(err) => skipped.push(format!("{}: {err}", f.display())),
            }
        } else if matches!(e.as_str(), "las" | "laz") {
            // point clouds are a job for lidar-to-terrain, which finds them in the data folder
            kept.push(f.display().to_string());
        } else if matches!(
            e.as_str(),
            "shx" | "dbf" | "prj" | "cpg" | "qix" | "sbn" | "sbx" | "xml" | "txt" | "md" | "pdf"
        ) {
            // shapefile sidecars and documents: read through their main file, or kept as they are
        } else {
            match crate::catalog::load_layers(f) {
                Ok(h) if !h.is_empty() => layers.extend(engine.register_layers(h)),
                Ok(_) => skipped.push(format!("{}: no features", f.display())),
                Err(err) => skipped.push(format!("{}: {err}", f.display())),
            }
        }
    }
    (layers, rasters, kept, skipped)
}

/// Save one dropped file and put what it holds on the map.
pub fn upload(engine: &Arc<Engine>, name: &str, body: &[u8]) -> Result<serde_json::Value, String> {
    let name = clean_name(name).ok_or("the file needs a name")?;
    let ext = ext_of(Path::new(&name));
    if !ACCEPTED.contains(&ext.as_str()) {
        return Err(format!(
            "GeoSpaX cannot open .{ext} files here; drop one of: {}",
            ACCEPTED.join(", ")
        ));
    }
    if body.is_empty() {
        return Err("the file is empty".into());
    }
    let dir = upload_dir(engine);
    let path = unique(&dir, &name);
    fs::write(&path, body).map_err(|e| format!("could not save {}: {e}", path.display()))?;

    // a zip unpacks into a folder of the same name; shapefile sidecars travel together
    let candidates = if ext == "zip" {
        let folder = unique(
            &dir,
            &path.file_stem().unwrap_or_default().to_string_lossy(),
        );
        let max = if engine.guest.load(std::sync::atomic::Ordering::Relaxed) {
            crate::guest::MAX_UNZIPPED
        } else {
            u64::MAX
        };
        let files = unzip(&path, &folder, max)?;
        let _ = fs::remove_file(&path);
        files
    } else {
        vec![path.clone()]
    };

    let (layers, rasters, kept, skipped) = register_files(engine, &candidates);
    if layers.is_empty() && rasters.is_empty() && kept.is_empty() {
        return Err(format!(
            "nothing GeoSpaX can map in {name}{}",
            if skipped.is_empty() {
                String::new()
            } else {
                format!(" ({})", skipped.join("; "))
            }
        ));
    }
    Ok(
        json!({ "saved": path.display().to_string(), "layers": layers, "rasters": rasters, "point_clouds": kept, "skipped": skipped }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(
            clean_name("My Track (1).gpx").as_deref(),
            Some("My Track _1_.gpx")
        );
        assert_eq!(
            clean_name("C:\\x\\.hidden").as_deref(),
            Some("C__x_.hidden")
        );
        assert_eq!(clean_name(".."), None);
    }

    #[test]
    fn zip_members_cannot_escape() {
        let dir = std::env::temp_dir().join(format!("gx-upload-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let zp = dir.join("evil.zip");
        {
            let mut z = zip::ZipWriter::new(fs::File::create(&zp).unwrap());
            z.start_file("../escape.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut z, b"x").unwrap();
            z.finish().unwrap();
        }
        assert!(unzip(&zp, &dir.join("out"), u64::MAX).is_err());
        assert!(!dir.join("escape.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
