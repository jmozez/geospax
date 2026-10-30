//! STAC catalogs in the Explorer (as ArcGIS Pro's STAC connections and QGIS's STAC browser): a STAC
//! API is a web service of kind `stac` whose layers are its collections. Search a collection for the
//! area on the map, a date range and a cloud limit; the items come back with their footprints and
//! assets. A cloud-optimised GeoTIFF asset can be **streamed** (put on the map in place, read through
//! GDAL's /vsicurl/ a window at a time) or **downloaded** cut to an area, as a background job with the
//! download gauge (bytes, total, speed, time left). Planetary Computer assets are signed first.

use crate::jobs::Status;
use crate::Engine;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Public STAC APIs that need no account, offered when adding a connection.
pub const KNOWN: &[(&str, &str)] = &[
    ("Earth Search (Element 84, AWS)", "https://earth-search.aws.element84.com/v1"),
    ("Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/api/stac/v1"),
    ("Copernicus Data Space", "https://stac.dataspace.copernicus.eu/v1"),
];

pub fn collections(url: &str) -> Result<Vec<Value>, String> {
    let v: Value = serde_json::from_slice(&crate::raster::http(&format!("{}/collections", url.trim_end_matches('/')), None, 30)?).map_err(|e| format!("not a STAC API ({e})"))?;
    let list = v["collections"].as_array().ok_or("not a STAC API: no collections")?;
    Ok(list
        .iter()
        .map(|c| json!({ "id": c["id"], "title": c["title"].as_str().or(c["id"].as_str()).unwrap_or(""), "type": "collection", "description": c["description"].as_str().unwrap_or("").chars().take(200).collect::<String>() }))
        .collect())
}

/// Search one collection: newest first, with footprint, cloud cover, and the assets that GeoSpaX can
/// open (GeoTIFF/COG, plus a preview image when there is one).
pub fn search(engine: &Engine, sid: &str, collection: &str, bbox: [f64; 4], datetime: Option<&str>, max_cloud: Option<f64>, limit: usize) -> Result<Value, String> {
    let svc = crate::services::load(&engine.state_dir).into_iter().find(|s| s["id"] == sid).ok_or("no such STAC connection")?;
    let url = svc["url"].as_str().unwrap_or("").trim_end_matches('/').to_string();
    let mut body = json!({ "collections": [collection], "bbox": bbox, "limit": limit.clamp(1, 100) });
    if let Some(d) = datetime.filter(|d| !d.is_empty()) {
        body["datetime"] = json!(d);
    }
    if let Some(c) = max_cloud {
        body["query"] = json!({ "eo:cloud_cover": { "lte": c } });
    }
    let raw = crate::raster::http(&format!("{url}/search"), Some(&body.to_string()), 45)?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| format!("STAC search: {e}"))?;
    let mut items: Vec<Value> = v["features"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| {
            let pr = &f["properties"];
            let mut assets = Vec::new();
            let mut thumb = Value::Null;
            for (k, a) in f["assets"].as_object().into_iter().flatten() {
                let href = a["href"].as_str().unwrap_or("");
                let ty = a["type"].as_str().unwrap_or("");
                let roles: Vec<&str> = a["roles"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                if roles.contains(&"thumbnail") || k == "thumbnail" || k == "rendered_preview" {
                    if thumb.is_null() && href.starts_with("http") {
                        thumb = json!(href);
                    }
                    continue;
                }
                let tiff = ty.contains("tiff") || href.to_lowercase().split('?').next().unwrap_or("").ends_with(".tif");
                if tiff && href.starts_with("http") {
                    assets.push(json!({ "key": k, "title": a["title"].as_str().unwrap_or(k), "href": href, "cog": ty.contains("cloud-optimized") || ty.contains("profile=cloud") }));
                }
            }
            json!({
                "id": f["id"], "collection": collection, "datetime": pr["datetime"].as_str().or(pr["start_datetime"].as_str()).unwrap_or(""),
                "cloud": pr["eo:cloud_cover"], "platform": pr["platform"], "geometry": f["geometry"], "bbox": f["bbox"],
                "assets": assets, "thumbnail": thumb,
            })
        })
        .collect();
    items.sort_by(|a, b| b["datetime"].as_str().cmp(&a["datetime"].as_str()));
    let matched = v["numberMatched"].as_u64().or(v["context"]["matched"].as_u64());
    Ok(json!({ "items": items, "matched": matched, "service": sid, "collection": collection }))
}

/// Planetary Computer assets need a short-lived signature; everything else is used as it is.
fn signed(href: &str) -> Result<String, String> {
    if href.contains(".blob.core.windows.net") && !href.contains("sig=") {
        let api = format!("https://planetarycomputer.microsoft.com/api/sas/v1/sign?href={}", enc(href));
        let v: Value = serde_json::from_slice(&crate::raster::http(&api, None, 30)?).map_err(|e| format!("signing: {e}"))?;
        return v["href"].as_str().map(str::to_string).ok_or_else(|| "the asset could not be signed".to_string());
    }
    Ok(href.to_string())
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Put an asset on the map. `stream`: read in place (/vsicurl/), nothing is copied. Otherwise it is
/// downloaded cut to `bbox` (lon/lat) into `<state>/stac/` as a job with the download gauge.
pub fn add_asset(engine: &Arc<Engine>, href: &str, id: &str, title: &str, stream: bool, bbox: Option<[f64; 4]>) -> Result<Value, String> {
    if !(href.starts_with("https://") || href.starts_with("http://")) {
        return Err("the asset is not a web address".into());
    }
    let rid = crate::raster::sanitize(id);
    if stream {
        let h = engine.register_raster(Path::new(&format!("/vsicurl/{}", signed(href)?)), &rid)?;
        return Ok(json!({ "rasters": [h.info.id.clone()], "streamed": true }));
    }
    let job = engine.jobs.create("stac-download", &rid);
    let (e, j, href, title) = (engine.clone(), job.clone(), href.to_string(), title.to_string());
    engine.job_pool.spawn(move || {
        j.update(|s| {
            s.status = Status::Running;
            s.message = format!("Downloading {title}");
        });
        let res = (|| -> Result<Value, String> {
            let src_path = format!("/vsicurl/{}", signed(&href)?);
            let src = crate::raster::open(Path::new(&src_path))?;
            let dir = e.state_dir.join("stac");
            std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
            let out = dir.join(format!("{rid}.tif"));
            let tmp = dir.join(format!("{rid}.part.tif"));
            let mut args = crate::raster::strings(&["-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-overwrite"]);
            if let Some(b) = bbox {
                args.extend(["-te_srs".into(), "EPSG:4326".into(), "-te".into(), b[0].to_string(), b[1].to_string(), b[2].to_string(), b[3].to_string()]);
            }
            crate::raster::net_reset();
            let t0 = std::time::Instant::now();
            let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
            drop(crate::raster::warp_progress(&[&src], &tmp.to_string_lossy(), &args, |f| {
                if last.elapsed().as_millis() >= 300 {
                    last = std::time::Instant::now();
                    let bytes = crate::raster::net_bytes();
                    let secs = t0.elapsed().as_secs_f64().max(0.001);
                    let est = if f > 0.03 && bytes > 0 { Some((bytes as f64 / f) as u64) } else { None };
                    let eta = if f > 0.02 { Some(secs * (1.0 - f) / f) } else { None };
                    j.update(|s| s.transfer = Some(json!({ "label": title, "fraction": f, "bytes": bytes, "total": est, "rate": bytes as f64 / secs, "eta_s": eta, "elapsed_s": secs })));
                }
                !j.cancel.load(Ordering::Relaxed)
            })?);
            std::fs::rename(&tmp, &out).map_err(|err| err.to_string())?;
            let h = e.register_raster(&out, &rid)?;
            Ok(json!({ "rasters": [h.info.id.clone()], "path": out.display().to_string() }))
        })();
        j.update(|s| s.transfer = None);
        match res {
            Ok(v) => j.finish(Status::Done, format!("{title} downloaded"), Some(v)),
            Err(err) if j.cancel.load(Ordering::Relaxed) => j.finish(Status::Cancelled, err, None),
            Err(err) => j.finish(Status::Failed, err, None),
        }
    });
    Ok(json!({ "job": job.id }))
}
