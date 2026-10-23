//! Web services in the Explorer (as ArcGIS Pro's server connections and QGIS's WMS/WMTS, WFS, OGC API
//! and ArcGIS REST entries): XYZ tiles, WMS, WMTS, ArcGIS MapServer (map images) and WFS, OGC API
//! Features, ArcGIS FeatureServer (features). Connections are kept in `<state>/services.json`.
//!
//! Map images are relayed through the engine (`GET /api/services/{id}/tile/{z}/{x}/{y}?layer=…`):
//! many map servers do not allow a web page to read their images (CORS), and the engine is the one
//! place that can. Features are downloaded for an area into a GeoPackage and put on the map like any
//! other layer, so they keep working offline and in exports.

use crate::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const KINDS: &[(&str, &str)] = &[
    ("xyz", "XYZ tiles"),
    ("wms", "WMS"),
    ("wmts", "WMTS"),
    ("arcgis-map", "ArcGIS MapServer"),
    ("wfs", "WFS"),
    ("ogcapi", "OGC API Features"),
    ("arcgis-feature", "ArcGIS FeatureServer"),
    ("stac", "STAC catalog"),
    ("cloud", "Cloud storage (S3, Google Cloud, Azure, web folder)"),
];

fn file(state: &Path) -> PathBuf {
    state.join("services.json")
}

pub fn load(state: &Path) -> Vec<Value> {
    std::fs::read(file(state)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(state: &Path, list: &[Value]) -> Result<(), String> {
    std::fs::create_dir_all(state).map_err(|e| e.to_string())?;
    std::fs::write(file(state), serde_json::to_vec_pretty(list).unwrap()).map_err(|e| e.to_string())
}

pub fn list(engine: &Engine) -> Value {
    json!({
        "services": load(&engine.state_dir),
        "kinds": KINDS.iter().map(|(k, t)| json!({ "id": k, "title": t })).collect::<Vec<_>>(),
        "stac_catalogs": crate::stac::KNOWN.iter().map(|(t, u)| json!({ "title": t, "url": u })).collect::<Vec<_>>(),
    })
}

pub fn get(engine: &Engine, id: &str) -> Result<Value, String> {
    load(&engine.state_dir).into_iter().find(|s| s["id"] == id).ok_or_else(|| format!("no web service {id}"))
}

fn base(url: &str) -> String {
    url.trim().trim_end_matches(['?', '&']).to_string()
}

/// Add a connection after checking that the service answers and has layers.
pub fn add(engine: &Engine, kind: &str, url: &str, title: Option<&str>, opts: &Value) -> Result<Value, String> {
    if !KINDS.iter().any(|(k, _)| *k == kind) {
        return Err(format!("unknown service type {kind}"));
    }
    let url = base(url);
    let cloud = kind == "cloud" && ["s3://", "gs://", "az://"].iter().any(|p| url.starts_with(p));
    if !(cloud || url.starts_with("http://") || url.starts_with("https://")) {
        return Err(if kind == "cloud" { "a cloud address starts with s3://, gs://, az:// or https://" } else { "the address must start with http:// or https://" }.into());
    }
    let mut probe = json!({ "id": "probe", "kind": kind, "url": url });
    if kind == "cloud" {
        // public (read without signing) unless asked otherwise; the S3 endpoint/region and Azure account
        probe["public"] = json!(opts["public"].as_bool().unwrap_or(true));
        for k in ["endpoint", "region", "account"] {
            if let Some(v) = opts[k].as_str().map(str::trim).filter(|v| !v.is_empty()) {
                probe[k] = json!(v);
            }
        }
    }
    let found = layers_of(&probe)?;
    if found.is_empty() {
        return Err("the service answered but lists no layers".into());
    }
    let mut list = load(&engine.state_dir);
    let n = list.iter().filter_map(|s| s["id"].as_str()?.strip_prefix("svc").and_then(|x| x.parse::<u32>().ok())).max().unwrap_or(0) + 1;
    let host = url.split('/').nth(2).unwrap_or("service").to_string();
    let mut svc = probe;
    svc["id"] = json!(format!("svc{n}"));
    svc["title"] = json!(title.filter(|t| !t.trim().is_empty()).map(str::to_string).unwrap_or(host));
    list.push(svc.clone());
    save(&engine.state_dir, &list)?;
    Ok(json!({ "service": svc, "layers": found.len() }))
}

pub fn remove(engine: &Engine, id: &str) -> Result<Value, String> {
    let mut list = load(&engine.state_dir);
    let n = list.len();
    list.retain(|s| s["id"] != id);
    if list.len() == n {
        return Err(format!("no web service {id}"));
    }
    save(&engine.state_dir, &list)?;
    Ok(json!({ "removed": id }))
}

pub fn layers(engine: &Engine, id: &str) -> Result<Value, String> {
    let svc = get(engine, id)?;
    Ok(json!({ "service": svc, "layers": layers_of(&svc)? }))
}

#[allow(dead_code)]
fn query_value(s: &str, key: &str) -> Option<String> {
    let lower = s.to_lowercase();
    let k = format!("{}=", key.to_lowercase());
    let i = lower.find(&k)? + k.len();
    let rest = &s[i..];
    Some(crate::router::pct_decode(rest.split('&').next().unwrap_or(rest)))
}

/// Text between `<tag ...>` and `</tag>` (no namespaces needed for the few WMTS fields read).
fn tag_text<'a>(s: &'a str, tag: &str) -> Option<&'a str> {
    let i = s.find(&format!("<{tag}"))?;
    let j = s[i..].find('>')? + i + 1;
    let k = s[j..].find(&format!("</{tag}"))? + j;
    Some(s[j..k].trim())
}

fn layers_of(svc: &Value) -> Result<Vec<Value>, String> {
    let url = svc["url"].as_str().unwrap_or("");
    let kind = svc["kind"].as_str().unwrap_or("");
    let sep = if url.contains('?') { '&' } else { '?' };
    Ok(match kind {
        "xyz" => vec![json!({ "id": "tiles", "title": svc["title"].as_str().unwrap_or("Tiles"), "type": "tiles" })],
        "stac" => crate::stac::collections(url)?,
        "cloud" => crate::cloud::list(svc, "")?,
        "wms" => {
            let raw = String::from_utf8_lossy(&crate::raster::http(&format!("{url}{sep}SERVICE=WMS&REQUEST=GetCapabilities"), None, 30)?).to_string();
            if !raw.contains("Capabilities") {
                return Err(format!("not a WMS: {}", raw.chars().take(160).collect::<String>()));
            }
            // namespace prefixes (wms:Layer) are folded away; every <Layer> with a <Name> is drawable
            let xml = raw.replace("<wms:", "<").replace("</wms:", "</");
            let mut out = Vec::new();
            for seg in xml.split("<Layer").skip(1) {
                let own = seg.split("<Layer").next().unwrap_or(seg);
                let own = own.split("</Layer>").next().unwrap_or(own);
                if let Some(name) = tag_text(own, "Name").filter(|n| !n.is_empty()) {
                    let title = tag_text(own, "Title").unwrap_or(name);
                    out.push(json!({ "id": name, "title": title, "type": "tiles" }));
                }
            }
            out
        }
        "wmts" => {
            let xml = String::from_utf8_lossy(&crate::raster::http(&format!("{url}{sep}SERVICE=WMTS&REQUEST=GetCapabilities"), None, 30)?).to_string();
            let mut out = Vec::new();
            for block in xml.split("<Layer>").skip(1).chain(xml.split("<Layer ").skip(1)) {
                let block = block.split("</Layer>").next().unwrap_or("");
                let Some(id) = tag_text(block, "ows:Identifier") else { continue };
                let title = tag_text(block, "ows:Title").unwrap_or(id);
                // a Web Mercator tile matrix set, and the REST template for it
                let sets: Vec<&str> = block.split("<TileMatrixSet>").skip(1).filter_map(|x| x.split("</TileMatrixSet>").next()).collect();
                let Some(set) = sets.iter().find(|s| s.contains("3857") || s.contains("GoogleMaps") || s.contains("WebMercator")).or(sets.first()) else { continue };
                let Some(t) = block.split("template=\"").nth(1).and_then(|x| x.split('"').next()) else { continue };
                if !out.iter().any(|o: &Value| o["id"] == id) {
                    out.push(json!({ "id": id, "title": title, "type": "tiles", "template": t.replace("&amp;", "&").replace("{TileMatrixSet}", set).replace("{Style}", "default"), "matrix_set": set }));
                }
            }
            out
        }
        "arcgis-map" => {
            let v: Value = serde_json::from_slice(&crate::raster::http(&format!("{url}{sep}f=json"), None, 30)?).map_err(|e| format!("not an ArcGIS service ({e})"))?;
            vec![json!({ "id": "map", "title": v["mapName"].as_str().or(v["documentInfo"]["Title"].as_str()).unwrap_or("Map"), "type": "tiles" })]
        }
        "arcgis-feature" => {
            let v: Value = serde_json::from_slice(&crate::raster::http(&format!("{url}{sep}f=json"), None, 30)?).map_err(|e| format!("not an ArcGIS service ({e})"))?;
            v["layers"].as_array().cloned().unwrap_or_default().iter().map(|l| json!({ "id": l["id"].to_string(), "title": l["name"], "type": "features" })).collect()
        }
        "wfs" | "ogcapi" => {
            use gdal::vector::LayerAccess;
            let conn = if kind == "wfs" { format!("WFS:{url}") } else { format!("OAPIF:{url}") };
            let ds = gdal::Dataset::open(Path::new(&conn)).map_err(|e| format!("the service did not answer as expected ({e})"))?;
            ds.layers().map(|l| json!({ "id": l.name(), "title": l.name(), "type": "features" })).collect()
        }
        _ => vec![],
    })
}

/// Web Mercator bounds of an XYZ tile.
fn tile_bbox(z: u32, x: u32, y: u32) -> [f64; 4] {
    let r = 20037508.342789244;
    let n = 2f64.powi(z as i32);
    let size = 2.0 * r / n;
    [-r + x as f64 * size, r - (y as f64 + 1.0) * size, -r + (x as f64 + 1.0) * size, r - y as f64 * size]
}

/// One map tile from a tile service, fetched by the engine.
pub fn tile(engine: &Engine, id: &str, layer: &str, z: u32, x: u32, y: u32) -> Result<(Vec<u8>, &'static str), String> {
    let svc = get(engine, id)?;
    let url = svc["url"].as_str().unwrap_or("");
    let sep = if url.contains('?') { '&' } else { '?' };
    let b = tile_bbox(z, x, y);
    let bbox = format!("{},{},{},{}", b[0], b[1], b[2], b[3]);
    let target = match svc["kind"].as_str().unwrap_or("") {
        "xyz" => url.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string()).replace("{-y}", &(2u32.pow(z) - 1 - y).to_string()),
        "wms" => format!("{url}{sep}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={}&STYLES=&CRS=EPSG:3857&BBOX={bbox}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE", enc(layer)),
        "arcgis-map" => format!("{url}/export?bbox={bbox}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image"),
        "wmts" => {
            let l = layers_of(&svc)?.into_iter().find(|l| l["id"] == layer).ok_or("no such layer")?;
            let t = l["template"].as_str().unwrap_or("");
            // tile matrices are named 0…n, or "<set>:0…n"
            let set = l["matrix_set"].as_str().unwrap_or("");
            let m = if set.contains(':') && !set.starts_with("GoogleMaps") { format!("{set}:{z}") } else { z.to_string() };
            t.replace("{TileMatrix}", &m).replace("{TileCol}", &x.to_string()).replace("{TileRow}", &y.to_string())
        }
        k => return Err(format!("{k} services have features, not map images")),
    };
    let body = crate::raster::http(&target, None, 30)?;
    let ct = if body.starts_with(&[0xFF, 0xD8]) { "image/jpeg" } else { "image/png" };
    if !(body.starts_with(&[0x89, b'P', b'N', b'G']) || body.starts_with(&[0xFF, 0xD8]) || body.starts_with(b"RIFF")) {
        return Err(format!("the service sent no image: {}", String::from_utf8_lossy(&body[..body.len().min(200)])));
    }
    Ok((body, ct))
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~:,".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Download a feature layer for an area (lon/lat) into `<state>/services/` and put it on the map.
pub fn fetch(engine: &Arc<Engine>, id: &str, layer: &str, bbox: [f64; 4]) -> Result<Value, String> {
    let svc = get(engine, id)?;
    let url = svc["url"].as_str().unwrap_or("");
    let (src, src_layer) = match svc["kind"].as_str().unwrap_or("") {
        "wfs" => (format!("WFS:{url}"), Some(layer.to_string())),
        "ogcapi" => (format!("OAPIF:{url}"), Some(layer.to_string())),
        "arcgis-feature" => (
            format!(
                "{}/{}/query?where=1%3D1&outFields=*&f=geojson&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&geometry={},{},{},{}",
                base(url),
                layer,
                bbox[0], bbox[1], bbox[2], bbox[3]
            ),
            None,
        ),
        k => return Err(format!("{k} services have map images: add them as a web layer")),
    };
    // one FlatGeobuf per service layer (<state>/services/<service>/<layer>.fgb): a re-download replaces it
    let dir = engine.state_dir.join("services").join(crate::raster::sanitize(id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let title = layers_of(&svc).ok().and_then(|ls| ls.into_iter().find(|l| l["id"] == layer)).and_then(|l| l["title"].as_str().map(str::to_string)).unwrap_or_else(|| layer.to_string());
    let name = crate::raster::sanitize(&title);
    let out = dir.join(format!("{name}.fgb"));
    let _ = std::fs::remove_file(&out);
    let mut args = vec!["-f".to_string(), "FlatGeobuf".into(), "-t_srs".into(), "EPSG:4326".into(), "-nln".into(), name.clone()];
    if src_layer.is_some() {
        args.extend(["-spat".into(), bbox[0].to_string(), bbox[1].to_string(), bbox[2].to_string(), bbox[3].to_string(), "-spat_srs".into(), "EPSG:4326".into()]);
    }
    // a query URL has no file extension, which GDAL's remote reader refuses: fetch it here
    let input = if src.starts_with("http") {
        let body = crate::raster::http(&src, None, 120)?;
        let tmp = dir.join(format!("{name}.download.geojson"));
        std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
        tmp.display().to_string()
    } else {
        src
    };
    vector_translate(&input, src_layer.as_deref(), &out, &args)?;
    let _ = std::fs::remove_file(dir.join(format!("{name}.download.geojson")));
    let hs = crate::catalog::load_layers(&out)?;
    if hs.iter().all(|h| h.info.feature_count == 0) {
        return Err(format!("no {layer} features in the area on the map"));
    }
    let n: u64 = hs.iter().map(|h| h.info.feature_count).sum();
    let ids = engine.register_layers(hs);
    Ok(json!({ "layers": ids, "features": n, "path": out.display().to_string() }))
}

/// `ogr2ogr` in-process: one layer (or all) of `src` into `dest`.
fn vector_translate(src: &str, layer: Option<&str>, dest: &Path, args: &[String]) -> Result<(), String> {
    use std::ffi::CString;
    let ds = gdal::Dataset::open(Path::new(src)).map_err(|e| format!("could not read the service ({e})"))?;
    let mut all: Vec<String> = args.to_vec();
    if let Some(l) = layer {
        all.push(l.to_string());
    }
    let c: Vec<CString> = all.iter().map(|a| CString::new(a.as_str()).unwrap()).collect();
    let mut ptrs: Vec<*mut std::os::raw::c_char> = c.iter().map(|a| a.as_ptr() as *mut _).collect();
    ptrs.push(std::ptr::null_mut());
    let dest_c = CString::new(dest.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    unsafe {
        let opts = gdal_sys::GDALVectorTranslateOptionsNew(ptrs.as_mut_ptr(), std::ptr::null_mut());
        if opts.is_null() {
            return Err(format!("ogr2ogr options: {}", crate::raster::last_error()));
        }
        let mut src_h = [ds.c_dataset()];
        let mut usage = 0;
        let out = gdal_sys::GDALVectorTranslate(dest_c.as_ptr(), std::ptr::null_mut(), 1, src_h.as_mut_ptr(), opts, &mut usage);
        gdal_sys::GDALVectorTranslateOptionsFree(opts);
        if out.is_null() {
            return Err(format!("download failed: {}", crate::raster::last_error()));
        }
        gdal_sys::GDALClose(out);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_bounds() {
        let b = tile_bbox(0, 0, 0);
        assert!((b[0] + 20037508.342789244).abs() < 1e-6 && (b[3] - 20037508.342789244).abs() < 1e-6);
        let b = tile_bbox(1, 1, 0);
        assert!(b[0].abs() < 1e-6 && b[1].abs() < 1e-6);
    }

    #[test]
    fn layers_from_wms_names() {
        assert_eq!(query_value("WMS:https://x/wms?SERVICE=WMS&LAYERS=topo%3Aroads&SRS=EPSG:4326", "LAYERS").as_deref(), Some("topo:roads"));
    }
}
