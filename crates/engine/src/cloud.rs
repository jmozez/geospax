//! Cloud storage in the Explorer (as ArcGIS Pro's cloud storage connections and QGIS's cloud
//! browser): an S3 bucket (or any S3-compatible store such as MinIO), a Google Cloud Storage
//! bucket, an Azure container, or a plain web folder, read through GDAL's /vsis3/, /vsigs/, /vsiaz/
//! and /vsicurl/ file systems. The folders are browsed like the data folders; a GeoTIFF/COG goes on
//! the map read in place (a window at a time), a vector file is read into a layer.
//!
//! No secret is stored by GeoSpaX. A *public* connection reads without signing; otherwise GDAL
//! uses this computer's own credentials (environment variables, ~/.aws, gcloud, az login), as the
//! command-line tools do.

use crate::Engine;
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::Path;
use std::sync::Arc;

/// The GDAL path of the connection's top folder, and the per-bucket prefix its options apply to.
fn roots(svc: &Value) -> Result<(String, String), String> {
    let url = svc["url"].as_str().unwrap_or("").trim().trim_end_matches('/');
    if url.starts_with("https://") || url.starts_with("http://") {
        let r = format!("/vsicurl/{url}");
        return Ok((r.clone(), r));
    }
    let (fs, rest) = [("s3://", "/vsis3/"), ("gs://", "/vsigs/"), ("az://", "/vsiaz/")]
        .iter()
        .find_map(|(scheme, fs)| url.strip_prefix(scheme).map(|r| (*fs, r)))
        .ok_or("a cloud address starts with s3://, gs://, az:// or https://")?;
    if rest.is_empty() || rest.split('/').any(|s| s == "..") {
        return Err("name the bucket, as in s3://bucket or s3://bucket/folder".into());
    }
    let bucket = rest.split('/').next().unwrap_or(rest);
    Ok((format!("{fs}{rest}"), format!("{fs}{bucket}")))
}

fn set(prefix: &str, key: &str, value: &str) {
    let (p, k, v) = (CString::new(prefix).unwrap(), CString::new(key).unwrap(), CString::new(value).unwrap());
    unsafe { gdal_sys::VSISetPathSpecificOption(p.as_ptr(), k.as_ptr(), v.as_ptr()) };
}

/// Apply the connection's options (public or signed, S3 endpoint, Azure account) to its bucket.
fn configure(svc: &Value) -> Result<String, String> {
    let (root, bucket) = roots(svc)?;
    let sign = if svc["public"].as_bool().unwrap_or(true) { "YES" } else { "NO" };
    if bucket.starts_with("/vsis3/") {
        set(&bucket, "AWS_NO_SIGN_REQUEST", sign);
        if let Some(ep) = svc["endpoint"].as_str().map(str::trim).filter(|e| !e.is_empty()) {
            let host = ep.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
            set(&bucket, "AWS_S3_ENDPOINT", host);
            set(&bucket, "AWS_HTTPS", if ep.starts_with("http://") { "NO" } else { "YES" });
            set(&bucket, "AWS_VIRTUAL_HOSTING", "FALSE");
        }
        if let Some(r) = svc["region"].as_str().map(str::trim).filter(|r| !r.is_empty()) {
            set(&bucket, "AWS_REGION", r);
        }
    } else if bucket.starts_with("/vsigs/") {
        set(&bucket, "GS_NO_SIGN_REQUEST", sign);
    } else if bucket.starts_with("/vsiaz/") {
        set(&bucket, "AZURE_NO_SIGN_REQUEST", sign);
        if let Some(a) = svc["account"].as_str().map(str::trim).filter(|a| !a.is_empty()) {
            set(&bucket, "AZURE_STORAGE_ACCOUNT", a);
        }
    }
    Ok(root)
}

/// A path inside the connection: `sub` is relative, without `..`.
fn path_in(svc: &Value, sub: &str) -> Result<String, String> {
    let root = configure(svc)?;
    let sub = sub.trim_matches('/');
    if sub.split('/').any(|s| s == ".." || s == ".") {
        return Err("not a path inside this connection".into());
    }
    Ok(if sub.is_empty() { root } else { format!("{root}/{sub}") })
}

/// One folder of the connection: its sub-folders and the files GeoSpaX can open, as Explorer rows.
pub fn list(svc: &Value, sub: &str) -> Result<Vec<Value>, String> {
    let dir = path_in(svc, sub)?;
    let c = CString::new(dir.clone()).map_err(|e| e.to_string())?;
    let h = unsafe { gdal_sys::VSIOpenDir(c.as_ptr(), 0, std::ptr::null()) };
    if h.is_null() {
        return Err(format!("could not list {} (check the address, and whether it is public)", svc["url"].as_str().unwrap_or("")));
    }
    let (mut folders, mut files) = (Vec::new(), Vec::new());
    let sub = sub.trim_matches('/');
    loop {
        let e = unsafe { gdal_sys::VSIGetNextDirEntry(h) };
        if e.is_null() {
            break;
        }
        let e = unsafe { &*e };
        let name = unsafe { CStr::from_ptr(e.pszName) }.to_string_lossy().trim_end_matches('/').to_string();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let rel = if sub.is_empty() { name.clone() } else { format!("{sub}/{name}") };
        let is_dir = e.bModeKnown != 0 && (e.nMode & 0o170000) == 0o040000;
        if is_dir {
            folders.push(json!({ "id": rel, "title": name, "type": "folder" }));
        } else if let Some(kind) = crate::browse::kind_of(Path::new(&name)) {
            if matches!(kind, "raster" | "vector") {
                let size = (e.bSizeKnown != 0).then_some(e.nSize);
                files.push(json!({ "id": rel, "title": name, "type": "file", "kind": kind, "size": size }));
            }
        }
    }
    unsafe { gdal_sys::VSICloseDir(h) };
    let by = |a: &Value, b: &Value| a["title"].as_str().unwrap_or("").to_lowercase().cmp(&b["title"].as_str().unwrap_or("").to_lowercase());
    folders.sort_by(by);
    files.sort_by(by);
    folders.extend(files);
    Ok(folders)
}

/// Put one file of the connection on the map: a raster is read in place, a vector into a layer.
pub fn open(engine: &Arc<Engine>, svc: &Value, sub: &str) -> Result<Value, String> {
    let path = path_in(svc, sub)?;
    let p = Path::new(&path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "cloud".into());
    match crate::browse::kind_of(p) {
        Some("raster") => {
            let h = engine.register_raster(p, &crate::raster::sanitize(&stem))?;
            Ok(json!({ "layers": [], "rasters": [h.info.id.clone()] }))
        }
        Some("vector") if path.to_lowercase().ends_with(".parquet") => crate::geoparquet::open_file(engine, &path, None),
        Some("vector") => {
            let hs = crate::catalog::load_layers(p)?;
            if hs.is_empty() {
                return Err(format!("{stem}: no layers"));
            }
            Ok(json!({ "layers": engine.register_layers(hs), "rasters": [] }))
        }
        _ => Err(format!("{stem}: GeoSpaX opens GeoTIFFs and vector files from cloud storage")),
    }
}
