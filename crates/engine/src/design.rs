//! Design (the Design tab): DXF exchange with AutoCAD and other CAD programs.
//!
//! Export: the "Design · …" layers into one DXF (AutoCAD 2004+, through GDAL's DXF driver) in the UTM
//! zone of the drawing, in metres, which is what CAD expects. Each design layer becomes a CAD layer
//! (DESIGN_LINES, DESIGN_ROADS …); dimension and annotation labels become MTEXT.
//!
//! Import: a DXF has no coordinate system, so the user names it (an EPSG code); the drawing becomes a
//! GeoPackage in WGS 84 with the CAD layer of each entity kept in its "Layer" field.

use crate::Engine;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::vector::{Feature, FieldDefn, Geometry, LayerAccess, LayerOptions, OGRFieldType, OGRwkbGeometryType};
use serde_json::{json, Value};
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn dir(engine: &Engine) -> PathBuf {
    engine.state_dir.join("design")
}

/// "Design · roads" → DESIGN_ROADS
fn cad_layer(name: &str) -> String {
    let n: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
    let n = n.split('_').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("_");
    if n.is_empty() { "GEOSPAX".into() } else { n }
}

/// The UTM zone (as an EPSG code) of a longitude, latitude.
fn utm(lon: f64, lat: f64) -> u32 {
    let zone = (((lon + 180.0) / 6.0).floor() as u32 % 60) + 1;
    if lat >= 0.0 { 32600 + zone } else { 32700 + zone }
}

/// Write the given design layers to a DXF; returns its path, the number of entities and the EPSG used.
pub fn export_dxf(engine: &Engine, ids: &[String]) -> Result<Value, String> {
    let e = |x: gdal::errors::GdalError| x.to_string();
    let layers: Vec<_> = ids.iter().filter_map(|id| engine.layer(id)).collect();
    if layers.is_empty() {
        return Err("no layers to export".into());
    }
    // the drawing's centre picks the UTM zone
    let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
    for l in &layers {
        let b = l.info.bounds;
        if b.iter().all(|v| v.is_finite()) {
            sx += (b[0] + b[2]) / 2.0;
            sy += (b[1] + b[3]) / 2.0;
            n += 1.0;
        }
    }
    if n == 0.0 {
        return Err("the layers are empty".into());
    }
    let epsg = utm(sx / n, sy / n);
    let mut to = SpatialRef::from_epsg(epsg).map_err(e)?;
    to.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let from = crate::catalog::wgs84()?;
    let ct = CoordTransform::new(&from, &to).map_err(e)?;
    std::fs::create_dir_all(dir(engine)).map_err(|x| x.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = dir(engine).join(format!("design-{stamp}.dxf"));
    let drv = gdal::DriverManager::get_driver_by_name("DXF").map_err(e)?;
    let mut ds = drv.create_vector_only(&path).map_err(e)?;
    let out = ds.create_layer(LayerOptions { name: "entities", srs: None, ty: OGRwkbGeometryType::wkbUnknown, options: None }).map_err(e)?;
    let _ = FieldDefn::new("Layer", OGRFieldType::OFTString).map_err(e)?.add_to_layer(&out);
    let layer_idx = out.defn().field_index("Layer").map_err(e)?;
    let mut count = 0u64;
    for l in &layers {
        let src = crate::catalog::open_vector(l.path())?;
        let mut sl = src.layer_by_name(l.layer_name()).or_else(|_| src.layer(0)).map_err(e)?;
        let cad = cad_layer(&l.info.name);
        let label_field = ["label", "text", "name"].into_iter().find(|f| sl.defn().fields().any(|x| x.name() == *f));
        for f in sl.features() {
            let Some(g) = f.geometry() else { continue };
            let mut g = g.clone();
            if g.transform_inplace(&ct).is_err() {
                continue;
            }
            let label = label_field.and_then(|lf| f.field_index(lf).ok().and_then(|i| f.field_as_string(i).ok().flatten())).filter(|s| !s.is_empty());
            let mut nf = Feature::new(out.defn()).map_err(e)?;
            nf.set_field_string(layer_idx, &cad).map_err(e)?;
            let is_text = matches!(g.geometry_type(), OGRwkbGeometryType::wkbPoint) && label.is_some();
            if is_text {
                set_style(&nf, &format!("LABEL(f:\"Arial\",t:\"{}\",s:2.5g)", label.as_deref().unwrap_or("").replace('"', "'")));
            }
            nf.set_geometry(g.clone()).map_err(e)?;
            nf.create(&out).map_err(e)?;
            count += 1;
            // a dimension's length, as text at the middle of the line
            if !is_text && cad.ends_with("DIMENSIONS") {
                if let (Some(t), Some(mid)) = (label.as_deref(), midpoint(&g)) {
                    let mut tf = Feature::new(out.defn()).map_err(e)?;
                    tf.set_field_string(layer_idx, &cad).map_err(e)?;
                    set_style(&tf, &format!("LABEL(f:\"Arial\",t:\"{}\",s:2g)", t.replace('"', "'")));
                    tf.set_geometry(Geometry::from_wkt(&format!("POINT ({} {})", mid.0, mid.1)).map_err(e)?).map_err(e)?;
                    tf.create(&out).map_err(e)?;
                    count += 1;
                }
            }
        }
    }
    drop(out);
    drop(ds);
    Ok(json!({ "path": path.display().to_string(), "features": count, "epsg": epsg }))
}

fn set_style(f: &Feature, style: &str) {
    if let Ok(c) = CString::new(style) {
        unsafe { gdal_sys::OGR_F_SetStyleString(f.c_feature(), c.as_ptr()) };
    }
}

fn midpoint(g: &Geometry) -> Option<(f64, f64)> {
    let n = g.point_count();
    if n < 2 {
        return None;
    }
    let (a, b) = (g.get_point(0), g.get_point(n as i32 - 1));
    Some(((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0))
}

/// A file written by `export_dxf` (only those, under `<state>/design/`).
pub fn exported(engine: &Engine, path: &str) -> Result<Vec<u8>, String> {
    let p = std::fs::canonicalize(path).map_err(|_| "no such DXF".to_string())?;
    let d = std::fs::canonicalize(dir(engine)).map_err(|_| "no such DXF".to_string())?;
    if !p.starts_with(&d) || p.extension().map(|x| x != "dxf").unwrap_or(true) {
        return Err("no such DXF".into());
    }
    std::fs::read(&p).map_err(|e| e.to_string())
}

/// A DXF drawing (its bytes) in the coordinate system `epsg`, as a layer in WGS 84.
pub fn import_dxf(engine: &Arc<Engine>, name: &str, epsg: u32, body: &[u8]) -> Result<Value, String> {
    if !body.starts_with(b"0") && !body.starts_with(b"  0") && !body.starts_with(b"999") && !String::from_utf8_lossy(&body[..body.len().min(200)]).contains("SECTION") {
        return Err("that does not look like a DXF file (ASCII DXF is read; save DWG as DXF first)".into());
    }
    SpatialRef::from_epsg(epsg).map_err(|_| format!("unknown EPSG code {epsg}"))?;
    let stem = crate::raster::sanitize(Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).as_deref().unwrap_or("drawing"));
    let d = dir(engine).join("imports");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let src = d.join(format!("{stem}.dxf"));
    std::fs::write(&src, body).map_err(|e| e.to_string())?;
    let out = d.join(format!("{stem}.gpkg"));
    let _ = std::fs::remove_file(&out);
    let args: Vec<String> = ["-f", "GPKG", "-s_srs", &format!("EPSG:{epsg}"), "-t_srs", "EPSG:4326", "-nln", &stem, "-nlt", "PROMOTE_TO_MULTI"].iter().map(|s| s.to_string()).collect();
    crate::services::vector_translate(&src.to_string_lossy(), None, &out, &args)?;
    let hs = crate::catalog::load_layers(&out)?;
    let n: u64 = hs.iter().map(|h| h.info.feature_count).sum();
    Ok(json!({ "layers": engine.register_layers(hs), "features": n }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn names_and_zones() {
        assert_eq!(super::cad_layer("Design · roads"), "DESIGN_ROADS");
        assert_eq!(super::utm(147.0, -6.7), 32755);
        assert_eq!(super::utm(-3.7, 40.4), 32630);
    }
}
