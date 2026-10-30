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
/// `blocks` ([{name, geometry}] in metres around the base point) and `inserts` ([{block, layer, fid, at, angle}])
/// make AutoCAD block references: the placed features go out as INSERTs of a block definition.
/// `pens` ({layer id: {color, width, dash, hollow}}) give each layer its colour, linetype and lineweight.
pub fn export_dxf(engine: &Engine, ids: &[String], hatch: &Value, blocks: &Value, inserts: &Value, pens: &Value) -> Result<Value, String> {
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
    // block definitions first: GDAL writes a "blocks" layer into the BLOCKS section
    let mut defined = std::collections::HashSet::new();
    let block_list: Vec<&Value> = blocks.as_array().into_iter().flatten().collect();
    if !block_list.is_empty() {
        let bl = ds.create_layer(LayerOptions { name: "blocks", srs: None, ty: OGRwkbGeometryType::wkbUnknown, options: None }).map_err(e)?;
        let _ = FieldDefn::new("Layer", OGRFieldType::OFTString).map_err(e)?.add_to_layer(&bl);
        // GDAL names a definition's field "Block"; the INSERTs that use it carry "BlockName"
        let _ = FieldDefn::new("Block", OGRFieldType::OFTString).map_err(e)?.add_to_layer(&bl);
        let bi = bl.defn().field_index("Block").map_err(e)?;
        let li = bl.defn().field_index("Layer").map_err(e)?;
        for b in block_list {
            let Some(name) = b["name"].as_str().map(block_name) else { continue };
            let Ok(g) = Geometry::from_geojson(&b["geometry"].to_string()) else { continue };
            let mut f = Feature::new(bl.defn()).map_err(e)?;
            f.set_field_string(bi, &name).map_err(e)?;
            f.set_field_string(li, "0").map_err(e)?;
            f.set_geometry(g).map_err(e)?;
            f.create(&bl).map_err(e)?;
            defined.insert(name);
        }
    }
    // (layer id, fid) → (block, insertion point in lon/lat, angle)
    let mut refs = std::collections::HashMap::new();
    for i in inserts.as_array().into_iter().flatten() {
        let (Some(b), Some(l), Some(fid), Some(x), Some(y)) = (i["block"].as_str(), i["layer"].as_str(), i["fid"].as_u64(), i["at"][0].as_f64(), i["at"][1].as_f64()) else { continue };
        if defined.contains(&block_name(b)) {
            refs.insert((l.to_string(), fid), (block_name(b), x, y, i["angle"].as_f64().unwrap_or(0.0)));
        }
    }
    let out = ds.create_layer(LayerOptions { name: "entities", srs: None, ty: OGRwkbGeometryType::wkbUnknown, options: None }).map_err(e)?;
    let _ = FieldDefn::new("Layer", OGRFieldType::OFTString).map_err(e)?.add_to_layer(&out);
    let layer_idx = out.defn().field_index("Layer").map_err(e)?;
    let _ = FieldDefn::new("BlockName", OGRFieldType::OFTString).map_err(e)?.add_to_layer(&out);
    let _ = FieldDefn::new("BlockAngle", OGRFieldType::OFTReal).map_err(e)?.add_to_layer(&out);
    let (bn_idx, ba_idx) = (out.defn().field_index("BlockName").map_err(e)?, out.defn().field_index("BlockAngle").map_err(e)?);
    let mut count = 0u64;
    for l in &layers {
        let src = crate::catalog::open_vector(l.path())?;
        let mut sl = src.layer_by_name(l.layer_name()).or_else(|_| src.layer(0)).map_err(e)?;
        let cad = cad_layer(&l.info.name);
        let pattern = hatch[l.info.id.as_str()].as_str();
        let pen = pen_style(&pens[l.info.id.as_str()]);
        let hollow = pens[l.info.id.as_str()]["hollow"].as_bool().unwrap_or(false);
        let fill_color = pens[l.info.id.as_str()]["color"].as_str().filter(|c| is_hex(c));
        let label_field = ["label", "text", "name"].into_iter().find(|f| sl.defn().fields().any(|x| x.name() == *f));
        for f in sl.features() {
            // a placed block: one INSERT at its insertion point instead of its linework
            if let Some((name, x, y, angle)) = f.fid().and_then(|fid| refs.get(&(l.info.id.clone(), fid))) {
                let mut pt = Geometry::from_wkt(&format!("POINT ({x} {y})")).map_err(e)?;
                if pt.transform_inplace(&ct).is_ok() {
                    let mut nf = Feature::new(out.defn()).map_err(e)?;
                    nf.set_field_string(layer_idx, &cad).map_err(e)?;
                    nf.set_field_string(bn_idx, name).map_err(e)?;
                    nf.set_field_double(ba_idx, *angle).map_err(e)?;
                    nf.set_geometry(pt).map_err(e)?;
                    nf.create(&out).map_err(e)?;
                    count += 1;
                    continue;
                }
            }
            let Some(g) = f.geometry() else { continue };
            let mut g = g.clone();
            if g.transform_inplace(&ct).is_err() {
                continue;
            }
            let label = label_field.and_then(|lf| f.field_index(lf).ok().and_then(|i| f.field_as_string(i).ok().flatten())).filter(|s| !s.is_empty());
            let mut nf = Feature::new(out.defn()).map_err(e)?;
            nf.set_field_string(layer_idx, &cad).map_err(e)?;
            let is_text = matches!(g.geometry_type(), OGRwkbGeometryType::wkbPoint) && label.is_some();
            let is_area = matches!(g.geometry_type(), OGRwkbGeometryType::wkbPolygon | OGRwkbGeometryType::wkbMultiPolygon);
            if is_text {
                set_style(&nf, &format!("LABEL(f:\"Arial\",t:\"{}\",s:2.5g)", label.as_deref().unwrap_or("").replace('"', "'")));
            } else if is_area && !hollow {
                // GDAL writes a polygon as a HATCH: filled in the layer's colour, with its outline added below
                if let Some(c) = fill_color {
                    set_style(&nf, &format!("BRUSH(fc:{c})"));
                }
            } else if let Some(p) = &pen {
                set_style(&nf, p);
            }
            // an outline-only shape is its outline (a closed polyline), not a solid HATCH
            let body = if is_area && hollow { outline(&g).unwrap_or_else(|| g.clone()) } else { g.clone() };
            nf.set_geometry(body).map_err(e)?;
            nf.create(&out).map_err(e)?;
            count += 1;
            if is_area && !hollow && pen.is_some() {
                if let Some(edge) = outline(&g) {
                    let mut of = Feature::new(out.defn()).map_err(e)?;
                    of.set_field_string(layer_idx, &cad).map_err(e)?;
                    set_style(&of, pen.as_deref().unwrap_or_default());
                    of.set_geometry(edge).map_err(e)?;
                    of.create(&out).map_err(e)?;
                    count += 1;
                }
            }
            // a hatched shape's pattern, as lines on its own <LAYER>-HATCH layer
            if let Some(pat) = pattern {
                for h in hatch_lines(&g, pat) {
                    let mut hf = Feature::new(out.defn()).map_err(e)?;
                    hf.set_field_string(layer_idx, &format!("{cad}-HATCH")).map_err(e)?;
                    hf.set_geometry(h).map_err(e)?;
                    hf.create(&out).map_err(e)?;
                    count += 1;
                }
            }
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

/// Hatch lines clipped to a polygon (in metres), as AutoCAD's ANSI31 and friends draw them:
/// the angles of the pattern, about 40 lines across the shape (0.5 to 5 m apart).
pub fn hatch_lines(g: &Geometry, pattern: &str) -> Vec<Geometry> {
    if !matches!(g.geometry_type(), OGRwkbGeometryType::wkbPolygon | OGRwkbGeometryType::wkbMultiPolygon) {
        return vec![];
    }
    let angles: &[f64] = match pattern {
        "back" => &[135.0],
        "cross" => &[45.0, 135.0],
        "grid" => &[0.0, 90.0],
        "horizontal" | "brick" => &[0.0],
        "vertical" => &[90.0],
        _ => &[45.0],
    };
    let env = g.envelope();
    let (cx, cy) = ((env.MinX + env.MaxX) / 2.0, (env.MinY + env.MaxY) / 2.0);
    let r = ((env.MaxX - env.MinX).powi(2) + (env.MaxY - env.MinY).powi(2)).sqrt() / 2.0;
    if !(r > 0.0) {
        return vec![];
    }
    let gap = (r / 20.0).clamp(0.5, 5.0);
    let mut out = vec![];
    for a in angles {
        let (dx, dy) = (a.to_radians().cos(), a.to_radians().sin());
        let steps = (r / gap).ceil() as i64;
        for i in -steps..=steps {
            let o = i as f64 * gap;
            let (px, py) = (cx - dy * o, cy + dx * o);
            let wkt = format!("LINESTRING ({} {}, {} {})", px - dx * r, py - dy * r, px + dx * r, py + dy * r);
            let Ok(line) = Geometry::from_wkt(&wkt) else { continue };
            if let Some(c) = line.intersection(g) {
                if !c.is_empty() {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// A polygon's rings as lines (a MULTILINESTRING), as AutoCAD draws an outline.
fn outline(g: &Geometry) -> Option<Geometry> {
    let mut rings = vec![];
    let mut add = |poly: &Geometry| {
        for i in 0..poly.geometry_count() {
            let mut pts = vec![];
            poly.get_geometry(i).get_points(&mut pts);
            if pts.len() > 1 {
                rings.push(format!("({})", pts.iter().map(|p| format!("{} {}", p.0, p.1)).collect::<Vec<_>>().join(", ")));
            }
        }
    };
    match g.geometry_type() {
        OGRwkbGeometryType::wkbPolygon => add(g),
        OGRwkbGeometryType::wkbMultiPolygon => {
            for i in 0..g.geometry_count() {
                add(&g.get_geometry(i));
            }
        }
        _ => return None,
    }
    if rings.is_empty() {
        return None;
    }
    Geometry::from_wkt(&format!("MULTILINESTRING ({})", rings.join(", "))).ok()
}

fn is_hex(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

/// An OGR pen for a layer: its colour, lineweight (screen px → mm) and linetype (dashes in metres).
fn pen_style(p: &Value) -> Option<String> {
    let c = p["color"].as_str().filter(|c| is_hex(c))?;
    let w = (p["width"].as_f64().unwrap_or(1.0) * 0.25).clamp(0.05, 2.11);
    let pat = match p["dash"].as_str() {
        Some("dashed") => ",p:\"2g 1g\"",
        Some("dotted") => ",p:\"0.2g 0.8g\"",
        _ => "",
    };
    Some(format!("PEN(c:{c},w:{w:.2}mm{pat})"))
}

/// UNION / SUBTRACT / INTERSECT of two GeoJSON shapes (lon/lat); `null` when nothing is left.
pub fn boolean(op: &str, a: &Value, b: &Value) -> Result<Value, String> {
    let ga = Geometry::from_geojson(&a.to_string()).map_err(|e| e.to_string())?;
    let gb = Geometry::from_geojson(&b.to_string()).map_err(|e| e.to_string())?;
    let out = match op {
        "union" => ga.union(&gb),
        "subtract" => ga.difference(&gb),
        "intersect" => ga.intersection(&gb),
        _ => return Err(format!("unknown operation {op}")),
    };
    let geometry = match out.filter(|g| !g.is_empty()) {
        Some(g) => serde_json::from_str::<Value>(&g.json().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        None => Value::Null,
    };
    Ok(json!({ "geometry": geometry }))
}

/// A block name AutoCAD accepts: letters, digits, - and _ (others become _).
fn block_name(s: &str) -> String {
    let n: String = s.trim().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if n.is_empty() { "BLOCK".into() } else { n }
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

    #[test]
    fn booleans() {
        let a = serde_json::json!({"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]});
        let b = serde_json::json!({"type": "Polygon", "coordinates": [[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]]});
        let area = |v: &serde_json::Value| gdal::vector::Geometry::from_geojson(&v["geometry"].to_string()).unwrap().area();
        assert!((area(&super::boolean("union", &a, &b).unwrap()) - 7.0).abs() < 1e-9);
        assert!((area(&super::boolean("subtract", &a, &b).unwrap()) - 3.0).abs() < 1e-9);
        assert!((area(&super::boolean("intersect", &a, &b).unwrap()) - 1.0).abs() < 1e-9);
        let far = serde_json::json!({"type": "Polygon", "coordinates": [[[9, 9], [10, 9], [10, 10], [9, 9]]]});
        assert!(super::boolean("intersect", &a, &far).unwrap()["geometry"].is_null());
    }

    #[test]
    fn pens() {
        let p = super::pen_style(&serde_json::json!({"color": "#ff6b9a", "width": 2, "dash": "dashed"})).unwrap();
        assert_eq!(p, "PEN(c:#ff6b9a,w:0.50mm,p:\"2g 1g\")");
        assert!(super::pen_style(&serde_json::json!({"color": "red"})).is_none());
    }

    #[test]
    fn hatch_inside_the_shape() {
        let sq = gdal::vector::Geometry::from_wkt("POLYGON ((0 0, 40 0, 40 40, 0 40, 0 0))").unwrap();
        let lines = super::hatch_lines(&sq, "diagonal");
        assert!(lines.len() > 20, "{} lines", lines.len());
        for l in &lines {
            let e = l.envelope();
            assert!(e.MinX >= -1e-9 && e.MaxX <= 40.0 + 1e-9 && e.MinY >= -1e-9 && e.MaxY <= 40.0 + 1e-9);
        }
        assert_eq!(super::hatch_lines(&sq, "cross").len(), lines.len() * 2);
        let o = super::outline(&sq).unwrap();
        assert_eq!(o.geometry_count(), 1);
        let line = gdal::vector::Geometry::from_wkt("LINESTRING (0 0, 1 1)").unwrap();
        assert!(super::hatch_lines(&line, "diagonal").is_empty());
    }
}
