//! Editing, selection and attribute queries (docs/USER_GUIDE.md §5a "Edit and query data").
//!
//! * **Edit copies.** The first edit to a layer copies it, with its CRS and every field, into a
//!   GeoPackage under `<state>/edits/` and the layer (same id, same style) reads the copy from then
//!   on. The original file is never written, so an edit can always be reverted; *Export* writes the
//!   edited data wherever the user wants it. Copies are listed in `edits/index.json` and come back
//!   at the next start.
//! * **Features and fields:** add, change, delete (GeoJSON in WGS 84; converted to the layer's CRS),
//!   add and delete fields, the field calculator (SQLite SQL expressions, as ArcGIS Pro's SQL and
//!   QGIS's expressions cover) and *Calculate geometry* (geodesic area, length, x, y).
//! * **Queries:** select by attributes (an SQL WHERE clause), select by location (intersect, within,
//!   contain, within a distance of another layer's features), definition queries (see
//!   `LayerHandle::set_filter`) and the attribute table's sorted, filtered pages.

use crate::catalog::{self, LayerHandle};
use crate::wkb::{self, Geom};
use crate::Engine;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::vector::sql::Dialect;
use gdal::vector::{Feature, FieldDefn, FieldValue, Geometry, LayerAccess, LayerOptions, OGRFieldType, OGRwkbGeometryType as G};
use gdal::{Dataset, DatasetOptions, DriverManager, GdalOpenFlags};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// One edit at a time: each one rewrites the copy and swaps the layer handle.
static EDIT: Mutex<()> = Mutex::new(());
/// Largest selection returned (fids).
pub const MAX_SELECT: usize = 2_000_000;
const EARTH_R: f64 = 6_371_008.8;

fn gerr(e: gdal::errors::GdalError) -> String {
    tidy(&e.to_string())
}

/// GDAL's error text without its wrapping: "CPL error class: '3', error number: '1', error msg:
/// 'In ExecuteSQL(): sqlite3_prepare_v2(…): no such column: x'" → "no such column: x".
pub fn tidy(msg: &str) -> String {
    let m = msg.split_once("error msg: '").map(|(_, m)| m.trim_end_matches('\'')).unwrap_or(msg);
    let m = m.rsplit_once("):").map(|(_, t)| t).unwrap_or(m);
    let m = m.trim();
    if m.is_empty() { msg.to_string() } else { m.to_string() }
}

/// `"name"` for SQL (double quotes doubled).
pub fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// `'text'` for SQL.
pub fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn open_update(path: &Path) -> Result<Dataset, String> {
    let opts = DatasetOptions { open_flags: GdalOpenFlags::GDAL_OF_VECTOR | GdalOpenFlags::GDAL_OF_UPDATE, ..Default::default() };
    Dataset::open_ex(path, opts).map_err(|e| format!("{}: {e}", path.display()))
}

fn fid_column<L: LayerAccess>(lyr: &L) -> String {
    let p = unsafe { gdal_sys::OGR_L_GetFIDColumn(lyr.c_layer()) };
    if p.is_null() {
        return String::new();
    }
    unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().to_string()
}

fn ogr_type(kind: &str) -> Result<OGRFieldType::Type, String> {
    Ok(match kind {
        "integer" | "int" | "long" | "short" => OGRFieldType::OFTInteger64,
        "real" | "double" | "float" | "number" => OGRFieldType::OFTReal,
        "string" | "text" => OGRFieldType::OFTString,
        "date" => OGRFieldType::OFTDate,
        "datetime" => OGRFieldType::OFTDateTime,
        _ => return Err(format!("unknown field type '{kind}' (integer, real, text, date or datetime)")),
    })
}

/// FieldValue → JSON.
pub fn value_json(v: Option<FieldValue>) -> Value {
    match v {
        None => Value::Null,
        Some(FieldValue::IntegerValue(i)) => i.into(),
        Some(FieldValue::Integer64Value(i)) => i.into(),
        Some(FieldValue::RealValue(r)) if r.is_finite() => r.into(),
        Some(FieldValue::StringValue(s)) => s.into(),
        Some(FieldValue::DateValue(d)) => d.to_string().into(),
        Some(FieldValue::DateTimeValue(d)) => d.to_rfc3339().into(),
        Some(other) => format!("{other:?}").into(),
    }
}

/// JSON → the field's type (numbers from text too, so table edits can arrive as typed).
fn set_value(f: &mut Feature, idx: usize, t: OGRFieldType::Type, v: &Value) -> Result<(), String> {
    let name = || f.field_count().to_string();
    let _ = name;
    if v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty() && t != OGRFieldType::OFTString) {
        return f.set_field_null(idx).map_err(gerr);
    }
    let as_f = || v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok()));
    match t {
        OGRFieldType::OFTInteger | OGRFieldType::OFTInteger64 => {
            let x = as_f().ok_or_else(|| format!("'{}' is not a whole number", v.as_str().map(String::from).unwrap_or(v.to_string())))?;
            if x.fract() != 0.0 {
                return Err(format!("{x} is not a whole number"));
            }
            f.set_field_integer64(idx, x as i64).map_err(gerr)
        }
        OGRFieldType::OFTReal => {
            let x = as_f().ok_or_else(|| format!("'{}' is not a number", v.as_str().map(String::from).unwrap_or(v.to_string())))?;
            f.set_field_double(idx, x).map_err(gerr)
        }
        _ => {
            let s = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            f.set_field_string(idx, &s).map_err(gerr)
        }
    }
}

fn wgs84() -> Result<SpatialRef, String> {
    catalog::wgs84()
}

/// GeoJSON geometry (WGS 84) → the layer's CRS and geometry type (single → multi when the layer
/// holds multi-part geometries).
fn geometry_in<L: LayerAccess>(lyr: &L, g: &Value) -> Result<Geometry, String> {
    let mut geom = Geometry::from_geojson(&g.to_string()).map_err(|e| format!("bad geometry: {e}"))?;
    if !geom.is_valid() && geom.geometry_type() != G::wkbPoint {
        // allowed (the user may still be shaping it) but say so in the server log
        eprintln!("edit: invalid geometry saved as drawn");
    }
    if let Some(srs) = lyr.spatial_ref()
        && !catalog::is_wgs84(&srs) {
            let mut dst = srs.clone();
            dst.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
            let ct = CoordTransform::new(&wgs84()?, &dst).map_err(gerr)?;
            geom.transform_inplace(&ct).map_err(gerr)?;
        }
    let want = gdal::vector::geometry_type_flatten(lyr.defn().geometry_type());
    let have = gdal::vector::geometry_type_flatten(geom.geometry_type());
    let multi = match (want, have) {
        (G::wkbMultiPoint, G::wkbPoint) | (G::wkbMultiLineString, G::wkbLineString) | (G::wkbMultiPolygon, G::wkbPolygon) => Some(want),
        _ => None,
    };
    if let Some(m) = multi {
        let mut out = Geometry::empty(m).map_err(gerr)?;
        out.add_geometry(geom).map_err(gerr)?;
        geom = out;
    } else if want != G::wkbUnknown && want != have && !matches!(want, G::wkbGeometryCollection) {
        let kind = |t| gdal::vector::geometry_type_to_name(t);
        return Err(format!("this layer holds {} geometries; a {} cannot be added", kind(want), kind(have)));
    }
    Ok(geom)
}

/// A geometry in the layer's CRS → GeoJSON in WGS 84.
fn geometry_out(g: &Geometry, srs: Option<&SpatialRef>) -> Result<Value, String> {
    let mut g = g.clone();
    if let Some(s) = srs.filter(|s| !catalog::is_wgs84(s)) {
        let mut src = s.clone();
        src.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        let ct = CoordTransform::new(&src, &wgs84()?).map_err(gerr)?;
        g.transform_inplace(&ct).map_err(gerr)?;
    }
    serde_json::from_str(&g.json().map_err(gerr)?).map_err(|e| e.to_string())
}

/// Copy a layer (or the features matching `filter`) into a new GeoPackage layer: same CRS,
/// geometry type and fields. Returns the number of features copied.
fn copy_layer(src: &Path, src_layer: &str, filter: Option<&str>, dst: &Path, dst_layer: &str) -> Result<u64, String> {
    let ds = catalog::open_vector(src)?;
    let mut sl = ds.layer_by_name(src_layer).map_err(gerr)?;
    if let Some(w) = filter {
        sl.set_attribute_filter(w).map_err(|e| format!("{w}: {e}"))?;
    }
    let drv = DriverManager::get_driver_by_name("GPKG").map_err(gerr)?;
    let _ = std::fs::remove_file(dst);
    let mut out = drv.create_vector_only(dst).map_err(gerr)?;
    let srs = sl.spatial_ref();
    let ty = sl.defn().geometry_type();
    let fields: Vec<(String, OGRFieldType::Type, i32, i32)> =
        sl.defn().fields().map(|f| (f.name(), f.field_type(), f.width(), f.precision())).collect();
    let mut n = 0u64;
    let mut txn = out.start_transaction().map_err(gerr)?;
    {
        let opts = ["FID=fid", "GEOMETRY_NAME=geom"];
        let dl = txn.create_layer(LayerOptions { name: dst_layer, srs: srs.as_ref(), ty, options: Some(&opts) }).map_err(gerr)?;
        let mut slot = Vec::with_capacity(fields.len());
        for (name, t, w, p) in &fields {
            let fd = FieldDefn::new(name, *t).map_err(gerr)?;
            if *w > 0 {
                fd.set_width(*w);
                fd.set_precision(*p);
            }
            fd.add_to_layer(&dl).map_err(|e| format!("field {name}: {e}"))?;
            slot.push(dl.defn().fields().position(|f| f.name().eq_ignore_ascii_case(name)));
        }
        for feat in sl.features() {
            let mut nf = Feature::new(dl.defn()).map_err(gerr)?;
            // keep the source's feature ids: the map, the table and the selection all refer to
            // features by id, and an edit must change the feature the user picked
            if let Some(fid) = feat.fid() {
                unsafe { gdal_sys::OGR_F_SetFID(nf.c_feature(), fid as i64) };
            }
            if let Some(g) = feat.geometry() {
                nf.set_geometry(g.clone()).map_err(gerr)?;
            }
            for (i, s) in slot.iter().enumerate() {
                if let (Some(s), Ok(Some(v))) = (s, feat.field(i)) {
                    nf.set_field(*s, &v).map_err(gerr)?;
                }
            }
            nf.create(&dl).map_err(gerr)?;
            n += 1;
        }
    }
    txn.commit().map_err(gerr)?;
    Ok(n)
}

// ---------------------------------------------------------------- geodesic measures

pub(crate) fn ring_area_m2(r: &[[f64; 2]]) -> f64 {
    // spherical excess (Chamberlain & Duquette 2007, as Turf and QGIS's ellipsoidal fallback)
    let n = r.len();
    if n < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let (p1, p2, p3) = (r[i], r[(i + 1) % n], r[(i + 2) % n]);
        s += (p3[0] - p1[0]).to_radians() * p2[1].to_radians().sin();
    }
    (s * EARTH_R * EARTH_R / 2.0).abs()
}

fn line_length_m(l: &[[f64; 2]]) -> f64 {
    l.windows(2)
        .map(|w| {
            let (a, b) = (w[0], w[1]);
            let (la1, la2) = (a[1].to_radians(), b[1].to_radians());
            let dla = la2 - la1;
            let dlo = (b[0] - a[0]).to_radians();
            let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
            2.0 * EARTH_R * h.sqrt().min(1.0).asin()
        })
        .sum()
}

/// Geodesic (spherical) measures of a WGS 84 geometry: (area m², length or perimeter m, anchor).
pub fn measure(g: &Geom) -> (f64, f64, Option<[f64; 2]>) {
    match g {
        Geom::Empty => (0.0, 0.0, None),
        Geom::Points(p) => (0.0, 0.0, p.first().copied()),
        Geom::Lines(ls) => (0.0, ls.iter().map(|l| line_length_m(l)).sum(), crate::automation::features::anchor(g)),
        Geom::Polygons(ps) => {
            let area = ps.iter().map(|rings| rings.iter().enumerate().map(|(i, r)| if i == 0 { ring_area_m2(r) } else { -ring_area_m2(r) }).sum::<f64>()).sum();
            let perim = ps.iter().flat_map(|rings| rings.iter()).map(|r| line_length_m(r)).sum();
            (area, perim, crate::automation::features::anchor(g))
        }
    }
}

// ---------------------------------------------------------------- index of edit copies

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
struct Entry {
    copy: PathBuf,
    layer: String,
    #[serde(default)]
    source: Option<PathBuf>,
    #[serde(default)]
    source_layer: Option<String>,
    name: String,
}

/// Where a selection comes from for select by location.
pub struct Location {
    pub layer: String,
    pub relation: String,
    pub distance_m: f64,
    pub fids: Option<Vec<u64>>,
}

/// Options for one page of the attribute table.
#[derive(Default)]
pub struct TableQuery {
    pub offset: usize,
    pub limit: usize,
    pub sort: Option<String>,
    pub desc: bool,
    pub where_: Option<String>,
    pub fids: Option<Vec<u64>>,
}

impl Engine {
    pub fn edits_dir(&self) -> PathBuf {
        self.state_dir.join("edits")
    }

    fn edit_index(&self) -> BTreeMap<String, Entry> {
        std::fs::read(self.edits_dir().join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Ids of edited layers whose original is `file` (the Catalog counts those as on the map).
    pub(crate) fn edited_from(&self, file: &Path) -> Vec<String> {
        let f = std::fs::canonicalize(file).ok();
        self.edit_index()
            .into_iter()
            .filter(|(id, e)| f.is_some() && e.source.as_ref().and_then(|s| std::fs::canonicalize(s).ok()) == f && self.layer(id).is_some())
            .map(|(id, _)| id)
            .collect()
    }

    fn save_edit_index(&self, idx: &BTreeMap<String, Entry>) -> Result<(), String> {
        std::fs::create_dir_all(self.edits_dir()).map_err(|e| e.to_string())?;
        std::fs::write(self.edits_dir().join("index.json"), serde_json::to_vec_pretty(idx).unwrap_or_default()).map_err(|e| e.to_string())
    }

    /// True when the layer reads an edit copy (or a layer made in GeoSpaX).
    pub fn is_edited(&self, l: &LayerHandle) -> bool {
        l.path().starts_with(self.edits_dir())
    }

    /// Re-attach edit copies and new layers from earlier sessions (called once at start).
    pub fn load_edits(&self) {
        for (id, e) in self.edit_index() {
            if e.copy.is_file()
                && let Err(err) = self.reload_layer(&id, &e.copy, &e.layer, &e.name) {
                    eprintln!("warning: edited copy of {id} not loaded: {err}");
                }
        }
    }

    fn reload_layer(&self, id: &str, path: &Path, layer: &str, name: &str) -> Result<Arc<LayerHandle>, String> {
        let prev = self.layer(id);
        let mut hs = catalog::load_layers(path)?;
        let i = hs.iter().position(|h| h.layer_name() == layer).unwrap_or(0);
        if hs.is_empty() {
            return Err(format!("{} has no layers", path.display()));
        }
        let mut h = hs.swap_remove(i);
        h.info.id = id.to_string();
        h.info.name = name.to_string();
        if let Some(p) = &prev {
            let _ = h.set_filter(p.filter());
        }
        self.register_layers(vec![h]);
        self.layer(id).ok_or_else(|| format!("layer {id} vanished"))
    }

    fn reload(&self, l: &LayerHandle) -> Result<Arc<LayerHandle>, String> {
        self.reload_layer(&l.info.id, l.path(), l.layer_name(), &l.info.name.clone())
    }

    /// The layer, made editable: the first call copies it into `<state>/edits` (see module docs).
    pub fn edit_layer(&self, id: &str) -> Result<Arc<LayerHandle>, String> {
        let l = self.layer(id).ok_or_else(|| format!("unknown layer '{id}'"))?;
        if self.is_edited(&l) {
            return Ok(l);
        }
        let dir = self.edits_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = catalog::sanitize(id).replace('.', "_");
        let copy = dir.join(format!("{stem}.gpkg"));
        let n = copy_layer(l.path(), l.layer_name(), None, &copy, &stem)?;
        if n != l.info.feature_count && l.info.feature_count > 0 {
            eprintln!("edit: {id}: copied {n} of {} features", l.info.feature_count);
        }
        let mut idx = self.edit_index();
        idx.insert(
            id.to_string(),
            Entry { copy: copy.clone(), layer: stem.clone(), source: Some(l.path().to_path_buf()), source_layer: Some(l.layer_name().to_string()), name: l.info.name.clone() },
        );
        self.save_edit_index(&idx)?;
        self.reload_layer(id, &copy, &stem, &l.info.name)
    }

    /// Throw the edits away: the layer reads its original file again. A layer made in GeoSpaX
    /// (no original) is removed from the map.
    pub fn revert_edits(&self, id: &str) -> Result<Option<Arc<LayerHandle>>, String> {
        let _g = EDIT.lock().unwrap();
        let mut idx = self.edit_index();
        let e = idx.remove(id).ok_or_else(|| format!("{id} has no edits"))?;
        self.save_edit_index(&idx)?;
        let out = match (&e.source, &e.source_layer) {
            (Some(src), Some(sl)) if src.exists() => Some(self.reload_layer(id, src, sl, &e.name)?),
            _ => {
                self.remove_layer(id);
                None
            }
        };
        let _ = std::fs::remove_file(&e.copy);
        Ok(out)
    }

    /// One feature as GeoJSON (WGS 84, every field).
    pub fn feature_json(&self, l: &LayerHandle, fid: u64) -> Result<Value, String> {
        let ds = catalog::open_vector(l.path())?;
        let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
        let f = lyr.feature(fid).ok_or_else(|| format!("{} has no feature {fid}", l.info.id))?;
        let srs = lyr.spatial_ref();
        let geometry = match f.geometry() {
            Some(g) => geometry_out(g, srs.as_ref())?,
            None => Value::Null,
        };
        let mut props = Map::new();
        for (i, fd) in lyr.defn().fields().enumerate() {
            props.insert(fd.name(), value_json(f.field(i).ok().flatten()));
        }
        Ok(json!({ "type": "Feature", "id": fid, "geometry": geometry, "properties": props }))
    }

    /// Add a feature (GeoJSON, WGS 84). Returns its fid.
    pub fn feature_add(&self, id: &str, body: &Value) -> Result<(u64, Arc<LayerHandle>), String> {
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        let fid = {
            let ds = open_update(l.path())?;
            let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
            let types: Vec<(String, OGRFieldType::Type)> = lyr.defn().fields().map(|f| (f.name(), f.field_type())).collect();
            let mut f = Feature::new(lyr.defn()).map_err(gerr)?;
            match body.get("geometry").filter(|g| !g.is_null()) {
                Some(g) => f.set_geometry(geometry_in(&lyr, g)?).map_err(gerr)?,
                None => return Err("a new feature needs a geometry".into()),
            }
            if let Some(p) = body.get("properties").and_then(|p| p.as_object()) {
                for (k, v) in p {
                    if let Some(i) = types.iter().position(|(n, _)| n.eq_ignore_ascii_case(k)) {
                        set_value(&mut f, i, types[i].1, v).map_err(|e| format!("{k}: {e}"))?;
                    }
                }
            }
            f.create(&lyr).map_err(gerr)?;
            f.fid().ok_or("the new feature got no id")?
        };
        Ok((fid, self.reload(&l)?))
    }

    /// Change a feature's geometry and/or attributes (only the properties given).
    pub fn feature_update(&self, id: &str, fid: u64, body: &Value) -> Result<Arc<LayerHandle>, String> {
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        {
            let ds = open_update(l.path())?;
            let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
            let types: Vec<(String, OGRFieldType::Type)> = lyr.defn().fields().map(|f| (f.name(), f.field_type())).collect();
            let mut f = lyr.feature(fid).ok_or_else(|| format!("no feature {fid}"))?;
            if let Some(g) = body.get("geometry").filter(|g| !g.is_null()) {
                f.set_geometry(geometry_in(&lyr, g)?).map_err(gerr)?;
            }
            if let Some(p) = body.get("properties").and_then(|p| p.as_object()) {
                for (k, v) in p {
                    let i = types.iter().position(|(n, _)| n.eq_ignore_ascii_case(k)).ok_or_else(|| format!("there is no field '{k}'"))?;
                    set_value(&mut f, i, types[i].1, v).map_err(|e| format!("{k}: {e}"))?;
                }
            }
            lyr.set_feature(f).map_err(gerr)?;
        }
        self.reload(&l)
    }

    /// Delete features. Returns how many were deleted.
    pub fn features_delete(&self, id: &str, fids: &[u64]) -> Result<(usize, Arc<LayerHandle>), String> {
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        let mut n = 0;
        {
            let mut ds = open_update(l.path())?;
            let txn = ds.start_transaction().map_err(gerr)?;
            {
                let lyr = txn.layer_by_name(l.layer_name()).map_err(gerr)?;
                for &fid in fids {
                    let err = unsafe { gdal_sys::OGR_L_DeleteFeature(lyr.c_layer(), fid as i64) };
                    if err == gdal_sys::OGRErr::OGRERR_NONE {
                        n += 1;
                    }
                }
            }
            txn.commit().map_err(gerr)?;
        }
        Ok((n, self.reload(&l)?))
    }

    /// Add a field (`kind`: integer, real, text, date, datetime).
    pub fn field_add(&self, id: &str, name: &str, kind: &str) -> Result<Arc<LayerHandle>, String> {
        let name = name.trim();
        if name.is_empty() || name.len() > 63 || name.contains('"') {
            return Err("a field name needs 1–63 characters and no double quotes".into());
        }
        let t = ogr_type(kind)?;
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        if l.info.fields.iter().any(|f| f.name.eq_ignore_ascii_case(name)) {
            return Err(format!("{} already has a field '{name}'", l.info.name));
        }
        {
            let ds = open_update(l.path())?;
            let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
            FieldDefn::new(name, t).map_err(gerr)?.add_to_layer(&lyr).map_err(gerr)?;
        }
        self.reload(&l)
    }

    pub fn field_delete(&self, id: &str, name: &str) -> Result<Arc<LayerHandle>, String> {
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        {
            let ds = open_update(l.path())?;
            let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
            let i = lyr.defn().fields().position(|f| f.name() == name).ok_or_else(|| format!("there is no field '{name}'"))?;
            let err = unsafe { gdal_sys::OGR_L_DeleteField(lyr.c_layer(), i as i32) };
            if err != gdal_sys::OGRErr::OGRERR_NONE {
                return Err(format!("could not delete field '{name}' (OGR error {err})"));
            }
        }
        self.reload(&l)
    }

    /// WHERE clause for the features a calculation or selection works on.
    fn scope_sql(fid_col: &str, where_: Option<&str>, fids: Option<&[u64]>) -> String {
        let mut parts = Vec::new();
        if let Some(w) = where_.map(str::trim).filter(|w| !w.is_empty()) {
            parts.push(format!("({w})"));
        }
        if let Some(f) = fids {
            let list: Vec<String> = f.iter().map(|x| x.to_string()).collect();
            parts.push(format!("{} IN ({})", ident(fid_col), if list.is_empty() { "NULL".into() } else { list.join(",") }));
        }
        if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) }
    }

    /// Field calculator: `field = expression` (SQLite SQL: arithmetic, `||`, CASE WHEN, round(),
    /// substr(), upper(), coalesce() …) for every feature, the selected ones (`fids`) or those
    /// matching `where_`. Creates the field first when `kind` is given and it does not exist.
    pub fn calculate(&self, id: &str, field: &str, expr: &str, kind: Option<&str>, where_: Option<&str>, fids: Option<&[u64]>) -> Result<(u64, Arc<LayerHandle>), String> {
        if expr.trim().is_empty() {
            return Err("write an expression, e.g. \"elevation_m\" / 1000 or CASE WHEN \"cover\" > 50 THEN 'forest' ELSE 'open' END".into());
        }
        if expr.contains(';') {
            return Err("one expression only (no ';')".into());
        }
        let l = self.layer(id).ok_or_else(|| format!("unknown layer '{id}'"))?;
        if !l.info.fields.iter().any(|f| f.name == field) {
            match kind {
                Some(k) => {
                    self.field_add(id, field, k)?;
                }
                None => return Err(format!("there is no field '{field}' (choose a type to create it)")),
            }
        }
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        let n = {
            let ds = open_update(l.path())?;
            let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
            let fid_col = fid_column(&lyr);
            let fid_col = if fid_col.is_empty() { "fid".to_string() } else { fid_col };
            let scope = Self::scope_sql(&fid_col, where_, fids);
            let table = ident(l.layer_name());
            let n = count(&ds, &format!("SELECT COUNT(*) FROM {table}{scope}"))?;
            // try the expression on one row first: a bad expression is an error, not a half-done table
            ds.execute_sql(format!("SELECT ({expr}) FROM {table} LIMIT 1"), None, Dialect::DEFAULT).map_err(|e| format!("the expression did not work: {}", tidy(&e.to_string())))?;
            ds.execute_sql(format!("UPDATE {table} SET {} = ({expr}){scope}", ident(field)), None, Dialect::DEFAULT)
                .map_err(|e| format!("the calculation failed: {}", tidy(&e.to_string())))?;
            n
        };
        Ok((n, self.reload(&l)?))
    }

    /// Calculate geometry attributes: `what` = area_m2, area_ha, area_km2, length_m, length_km,
    /// perimeter_m, x, y (geodesic, on the sphere; x and y in WGS 84 degrees).
    pub fn calculate_geometry(&self, id: &str, field: &str, what: &str, fids: Option<&[u64]>) -> Result<(u64, Arc<LayerHandle>), String> {
        let f: fn(f64, f64, Option<[f64; 2]>) -> Option<f64> = match what {
            "area_m2" => |a, _, _| Some(a),
            "area_ha" => |a, _, _| Some(a / 1e4),
            "area_km2" => |a, _, _| Some(a / 1e6),
            "length_m" | "perimeter_m" => |_, l, _| Some(l),
            "length_km" | "perimeter_km" => |_, l, _| Some(l / 1e3),
            "x" => |_, _, p| p.map(|p| p[0]),
            "y" => |_, _, p| p.map(|p| p[1]),
            _ => return Err(format!("unknown measure '{what}' (area_m2, area_ha, area_km2, length_m, length_km, perimeter_m, x, y)")),
        };
        let l = self.layer(id).ok_or_else(|| format!("unknown layer '{id}'"))?;
        if !l.info.fields.iter().any(|x| x.name == field) {
            self.field_add(id, field, "real")?;
        }
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        let mut n = 0;
        {
            let mut ds = open_update(l.path())?;
            let txn = ds.start_transaction().map_err(gerr)?;
            {
                let mut lyr = txn.layer_by_name(l.layer_name()).map_err(gerr)?;
                let fi = lyr.defn().fields().position(|x| x.name() == field).ok_or("field vanished")?;
                let to = match lyr.spatial_ref().filter(|s| !catalog::is_wgs84(s)) {
                    Some(s) => Some(catalog::transforms(&s)?.0),
                    None => None,
                };
                let want: Option<HashSet<u64>> = fids.map(|f| f.iter().copied().collect());
                let mut updates = Vec::new();
                for feat in lyr.features() {
                    let Some(fid) = feat.fid() else { continue };
                    if want.as_ref().is_some_and(|w| !w.contains(&fid)) {
                        continue;
                    }
                    let Some(g) = feat.geometry() else { continue };
                    let mut g = g.clone();
                    if let Some(ct) = &to
                        && g.transform_inplace(&ct.0).is_err() {
                            continue;
                        }
                    let Ok(bytes) = g.wkb() else { continue };
                    let Ok(geom) = wkb::parse(&bytes) else { continue };
                    let (a, len, p) = measure(&geom);
                    updates.push((fid, f(a, len, p)));
                }
                for (fid, v) in updates {
                    if let Some(mut feat) = lyr.feature(fid) {
                        match v {
                            Some(x) => feat.set_field_double(fi, x).map_err(gerr)?,
                            None => feat.set_field_null(fi).map_err(gerr)?,
                        }
                        lyr.set_feature(feat).map_err(gerr)?;
                        n += 1;
                    }
                }
                let _ = &mut lyr;
            }
            txn.commit().map_err(gerr)?;
        }
        Ok((n, self.reload(&l)?))
    }

    /// The definition query combined with `extra` (both SQL WHERE clauses).
    fn with_filter(l: &LayerHandle, extra: Option<&str>) -> Option<String> {
        let parts: Vec<String> = [l.filter(), extra.map(str::trim).filter(|s| !s.is_empty()).map(String::from)].into_iter().flatten().map(|w| format!("({w})")).collect();
        (!parts.is_empty()).then(|| parts.join(" AND "))
    }

    /// Select by attributes and/or location. `within` limits the result to an existing selection
    /// (the "select from current selection" method; add/remove are done by the caller).
    pub fn select(&self, l: &LayerHandle, where_: Option<&str>, location: Option<&Location>, within: Option<&[u64]>) -> Result<Vec<u64>, String> {
        let ds = catalog::open_vector(l.path())?;
        let mut lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
        if let Some(w) = Self::with_filter(l, where_) {
            lyr.set_attribute_filter(&w).map_err(|e| format!("'{}' is not a valid query: {}", where_.unwrap_or(""), tidy(&e.to_string())))?;
        }
        let only: Option<HashSet<u64>> = within.map(|w| w.iter().copied().collect());
        let mut out = Vec::new();
        let srs = lyr.spatial_ref();
        let selectors = match location {
            Some(loc) => Some(self.selectors(loc, srs.as_ref())?),
            None => None,
        };
        if let Some((_, bbox, _)) = &selectors {
            lyr.set_spatial_filter_rect(bbox[0], bbox[1], bbox[2], bbox[3]);
        }
        let ignore: Vec<usize> = Vec::new();
        crate::reader::set_ignored_fields(&lyr, &ignore, selectors.is_none())?;
        for f in lyr.features() {
            let Some(fid) = f.fid() else { continue };
            if only.as_ref().is_some_and(|o| !o.contains(&fid)) {
                continue;
            }
            if let (Some((geoms, _, rel)), Some(g)) = (&selectors, f.geometry()) {
                let hit = geoms.iter().any(|s| match rel.as_str() {
                    "within" => g.within(s),
                    "contains" => g.contains(s),
                    _ => g.intersects(s),
                });
                if !hit {
                    continue;
                }
            } else if selectors.is_some() {
                continue;
            }
            out.push(fid);
            if out.len() >= MAX_SELECT {
                break;
            }
        }
        Ok(out)
    }

    /// The selecting layer's geometries in `srs` (buffered by the distance), their bbox and the relation.
    fn selectors(&self, loc: &Location, srs: Option<&SpatialRef>) -> Result<(Vec<Geometry>, [f64; 4], String), String> {
        let other = self.layer(&loc.layer).ok_or_else(|| format!("unknown layer '{}'", loc.layer))?;
        let ds = catalog::open_vector(other.path())?;
        let mut ol = ds.layer_by_name(other.layer_name()).map_err(gerr)?;
        if let Some(w) = other.filter() {
            ol.set_attribute_filter(&w).map_err(gerr)?;
        }
        let want: Option<HashSet<u64>> = loc.fids.as_ref().map(|f| f.iter().copied().collect());
        let mut geoms = Vec::new();
        for f in ol.features() {
            if want.as_ref().is_some_and(|w| f.fid().is_none_or(|x| !w.contains(&x))) {
                continue;
            }
            if let Some(g) = f.geometry() {
                geoms.push(g.clone());
            }
            if geoms.len() > 200_000 {
                return Err(format!("{} has too many features to select with; select some of them first", other.info.name));
            }
        }
        if geoms.is_empty() {
            return Err(format!("{} has no features to select with", other.info.name));
        }
        let mut target = srs.cloned().unwrap_or(wgs84()?);
        target.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        let mut src = ol.spatial_ref().unwrap_or(wgs84()?);
        src.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        let relation = match loc.relation.as_str() {
            "intersects" | "within" | "contains" => loc.relation.clone(),
            "within_distance" | "distance" => "intersects".to_string(),
            r => return Err(format!("unknown relation '{r}' (intersects, within, contains, within_distance)")),
        };
        let buffer = loc.relation.contains("distance") && loc.distance_m > 0.0;
        if buffer {
            // buffer in metres in an azimuthal equidistant projection centred on the selectors
            let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
            let to84 = CoordTransform::new(&src, &wgs84()?).map_err(gerr)?;
            let mut g84 = Vec::with_capacity(geoms.len());
            for g in &geoms {
                let mut g = g.clone();
                g.transform_inplace(&to84).map_err(gerr)?;
                let e = g.envelope();
                b = [b[0].min(e.MinX), b[1].min(e.MinY), b[2].max(e.MaxX), b[3].max(e.MaxY)];
                g84.push(g);
            }
            let mut aeqd = SpatialRef::from_proj4(&format!("+proj=aeqd +lat_0={} +lon_0={} +datum=WGS84 +units=m +no_defs", (b[1] + b[3]) / 2.0, (b[0] + b[2]) / 2.0)).map_err(gerr)?;
            aeqd.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
            let fwd = CoordTransform::new(&wgs84()?, &aeqd).map_err(gerr)?;
            let back = CoordTransform::new(&aeqd, &target).map_err(gerr)?;
            geoms = g84
                .into_iter()
                .map(|mut g| {
                    g.transform_inplace(&fwd).map_err(gerr)?;
                    let mut buf = g.buffer(loc.distance_m, 16).map_err(gerr)?;
                    buf.transform_inplace(&back).map_err(gerr)?;
                    Ok(buf)
                })
                .collect::<Result<_, String>>()?;
        } else if !src.to_wkt().ok().zip(target.to_wkt().ok()).is_some_and(|(a, b)| a == b) {
            let ct = CoordTransform::new(&src, &target).map_err(gerr)?;
            for g in &mut geoms {
                g.transform_inplace(&ct).map_err(gerr)?;
            }
        }
        let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for g in &geoms {
            let e = g.envelope();
            b = [b[0].min(e.MinX), b[1].min(e.MinY), b[2].max(e.MaxX), b[3].max(e.MaxY)];
        }
        Ok((geoms, b, relation))
    }

    /// A page of the attribute table: every field, sorted, filtered (definition query, a WHERE
    /// clause and/or a list of fids). SQLite SQL, so the same queries work on every format.
    pub fn table(&self, l: &LayerHandle, q: &TableQuery) -> Result<Value, String> {
        let native = matches!(l.info.driver.as_str(), "GPKG" | "SQLite");
        if !native {
            // GDAL's SQLite dialect cannot build its virtual table when a field shares the fid
            // column's name (GeoJSON `id` properties, very common), so other formats are paged
            // through the feature API with OGR SQL, the same dialect as their definition queries
            return self.table_ogr(l, q);
        }
        let ds = catalog::open_vector(l.path())?;
        let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
        let dialect = if native { Dialect::DEFAULT } else { Dialect::SQLITE };
        let fid_col = if native { fid_column(&lyr) } else { String::new() };
        let fid_expr = if fid_col.is_empty() { "rowid".to_string() } else { ident(&fid_col) };
        let fields: Vec<(String, &'static str)> = l.info.fields.iter().map(|f| (f.name.clone(), f.kind)).collect();
        let srs = lyr.spatial_ref();
        drop(lyr);
        let mut parts = Vec::new();
        if let Some(w) = Self::with_filter(l, q.where_.as_deref()) {
            parts.push(w);
        }
        if let Some(f) = &q.fids {
            let list: Vec<String> = f.iter().map(|x| x.to_string()).collect();
            parts.push(format!("{fid_expr} IN ({})", if list.is_empty() { "NULL".into() } else { list.join(",") }));
        }
        let scope = if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) };
        let table = ident(l.layer_name());
        let total = {
            let sql = format!("SELECT COUNT(*) FROM {table}{scope}");
            match dialect {
                Dialect::SQLITE => count_dialect(&ds, &sql, Dialect::SQLITE),
                _ => count(&ds, &sql),
            }
            .map_err(|e| format!("query: {}", tidy(&e.to_string())))?
        };
        let order = match &q.sort {
            Some(s) if fields.iter().any(|(n, _)| n == s) => format!(" ORDER BY {} {} NULLS LAST, {fid_expr}", ident(s), if q.desc { "DESC" } else { "ASC" }),
            Some(s) if s == "fid" || s == "$fid" => format!(" ORDER BY {fid_expr} {}", if q.desc { "DESC" } else { "ASC" }),
            _ => format!(" ORDER BY {fid_expr}"),
        };
        // SELECT *: geometry and every field come back under their own names on every format; on
        // GeoPackage the id column becomes the feature id, elsewhere SQLite's rowid is the OGR fid
        let sql = format!(
            "SELECT {}* FROM {table}{scope}{order} LIMIT {} OFFSET {}",
            if native { "" } else { "rowid AS gsx_fid, " },
            q.limit.clamp(1, 5000),
            q.offset
        );
        let to84 = match srs.filter(|s| !catalog::is_wgs84(s)) {
            Some(s) => Some(catalog::transforms(&s)?.0),
            None => None,
        };
        let mut rows = Vec::new();
        {
            let rs = ds.execute_sql(&sql, None, dialect).map_err(|e| format!("query: {}", tidy(&e.to_string())))?;
            if let Some(mut rs) = rs {
                // result columns by name (never by position: GDAL may drop or reorder some)
                let names: Vec<String> = rs.defn().fields().map(|f| f.name()).collect();
                let slot: Vec<Option<usize>> = fields.iter().map(|(n, _)| names.iter().position(|x| x == n)).collect();
                let fid_slot = names.iter().position(|x| x == "gsx_fid");
                for f in rs.features() {
                    let fid = fid_slot
                        .and_then(|i| f.field(i).ok().flatten())
                        .and_then(|v| v.into_int64())
                        .map(|x| x as u64)
                        .or(f.fid())
                        .unwrap_or(0);
                    let values: Vec<Value> = slot.iter().map(|i| i.map(|i| value_json(f.field(i).ok().flatten())).unwrap_or(Value::Null)).collect();
                    let bbox = f.geometry().filter(|g| !g.is_empty()).map(|g| {
                        let e = g.envelope();
                        let mut xs = [e.MinX, e.MaxX];
                        let mut ys = [e.MinY, e.MaxY];
                        if let Some(ct) = &to84 {
                            let _ = ct.0.transform_coords(&mut xs, &mut ys, &mut [0.0, 0.0]);
                        }
                        [xs[0], ys[0], xs[1], ys[1]]
                    });
                    rows.push(json!({ "fid": fid, "bbox": bbox, "values": values }));
                }
            }
        }
        Ok(json!({
            "total": total,
            "offset": q.offset,
            "fields": fields.iter().map(|(n, _)| n).collect::<Vec<_>>(),
            "kinds": fields.iter().map(|(_, k)| k).collect::<Vec<_>>(),
            "rows": rows,
            "edited": self.is_edited(l),
            "filter": l.filter(),
        }))
    }

    /// The attribute table for formats without a SQL engine of their own: filter with OGR SQL,
    /// sort in memory on (sort key, fid) only, then read the page's features by fid.
    fn table_ogr(&self, l: &LayerHandle, q: &TableQuery) -> Result<Value, String> {
        let ds = catalog::open_vector(l.path())?;
        let mut lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
        let fields: Vec<(String, &'static str)> = l.info.fields.iter().map(|f| (f.name.clone(), f.kind)).collect();
        let defn_names: Vec<String> = lyr.defn().fields().map(|f| f.name()).collect();
        let slot: Vec<Option<usize>> = fields.iter().map(|(n, _)| defn_names.iter().position(|x| x == n)).collect();
        // OGR SQL spells the search box's text cast differently from SQLite
        let w = q.where_.as_deref().map(|w| w.replace(" AS TEXT)", " AS CHARACTER(254))"));
        if let Some(w) = Self::with_filter(l, w.as_deref()) {
            lyr.set_attribute_filter(&w).map_err(|e| format!("query: '{}' is not valid here ({})", q.where_.as_deref().unwrap_or(""), tidy(&e.to_string())))?;
        }
        let want: Option<HashSet<u64>> = q.fids.as_ref().map(|f| f.iter().copied().collect());
        let sort_slot = q.sort.as_ref().and_then(|s| fields.iter().position(|(n, _)| n == s)).and_then(|i| slot[i]);
        let by_fid = q.sort.as_deref().is_some_and(|s| s == "fid" || s == "$fid");
        // (key, fid) for every matching feature
        let mut keys: Vec<(Value, u64)> = Vec::new();
        {
            let keep: Vec<usize> = sort_slot.into_iter().collect();
            crate::reader::set_ignored_fields(&lyr, &keep, true)?;
            for f in lyr.features() {
                let Some(fid) = f.fid() else { continue };
                if want.as_ref().is_some_and(|w| !w.contains(&fid)) {
                    continue;
                }
                let key = sort_slot.map(|i| value_json(f.field(i).ok().flatten())).unwrap_or(Value::Null);
                keys.push((key, fid));
            }
            crate::reader::set_ignored_fields(&lyr, &(0..defn_names.len()).collect::<Vec<_>>(), false)?;
        }
        let total = keys.len();
        if sort_slot.is_some() || by_fid {
            let cmp = |a: &Value, b: &Value| -> std::cmp::Ordering {
                use std::cmp::Ordering::*;
                match (a, b) {
                    (Value::Null, Value::Null) => Equal,
                    (Value::Null, _) => Greater, // nulls last, both directions
                    (_, Value::Null) => Less,
                    (Value::Number(x), Value::Number(y)) => x.as_f64().partial_cmp(&y.as_f64()).unwrap_or(Equal),
                    _ => a.as_str().unwrap_or_default().cmp(b.as_str().unwrap_or_default()),
                }
            };
            keys.sort_by(|a, b| {
                let o = if by_fid { a.1.cmp(&b.1) } else { cmp(&a.0, &b.0) };
                let o = if q.desc && !(a.0.is_null() || b.0.is_null()) || (q.desc && by_fid) { o.reverse() } else { o };
                o.then(a.1.cmp(&b.1))
            });
        } else {
            keys.sort_by_key(|k| k.1);
        }
        let to84 = match lyr.spatial_ref().filter(|s| !catalog::is_wgs84(s)) {
            Some(s) => Some(catalog::transforms(&s)?.0),
            None => None,
        };
        lyr.clear_attribute_filter();
        let mut rows = Vec::new();
        for (_, fid) in keys.iter().skip(q.offset).take(q.limit.clamp(1, 5000)) {
            let Some(f) = lyr.feature(*fid) else { continue };
            let values: Vec<Value> = slot.iter().map(|i| i.map(|i| value_json(f.field(i).ok().flatten())).unwrap_or(Value::Null)).collect();
            let bbox = f.geometry().filter(|g| !g.is_empty()).map(|g| {
                let e = g.envelope();
                let (mut xs, mut ys) = ([e.MinX, e.MaxX], [e.MinY, e.MaxY]);
                if let Some(ct) = &to84 {
                    let _ = ct.0.transform_coords(&mut xs, &mut ys, &mut [0.0, 0.0]);
                }
                [xs[0], ys[0], xs[1], ys[1]]
            });
            rows.push(json!({ "fid": fid, "bbox": bbox, "values": values }));
        }
        Ok(json!({
            "total": total,
            "offset": q.offset,
            "fields": fields.iter().map(|(n, _)| n).collect::<Vec<_>>(),
            "kinds": fields.iter().map(|(_, k)| k).collect::<Vec<_>>(),
            "rows": rows,
            "edited": self.is_edited(l),
            "filter": l.filter(),
        }))
    }

    /// Write features (a selection, a query or the whole layer) to a new GeoPackage layer on the
    /// map, kept with the edits. Returns the new layer's id.
    pub fn export_features(&self, l: &LayerHandle, name: &str, where_: Option<&str>, fids: Option<&[u64]>) -> Result<String, String> {
        let stem = catalog::sanitize(name.trim()).replace('.', "_");
        if stem.trim_matches('_').is_empty() {
            return Err("give the new layer a name".into());
        }
        let id = format!("{stem}.gpkg");
        if self.layer(&id).is_some() {
            return Err(format!("a layer '{id}' already exists; choose another name"));
        }
        let dir = self.edits_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let copy = dir.join(format!("{stem}.gpkg"));
        let filter = {
            let ds = catalog::open_vector(l.path())?;
            let lyr = ds.layer_by_name(l.layer_name()).map_err(gerr)?;
            let fc = fid_column(&lyr);
            let fid_expr = if fc.is_empty() { "FID".to_string() } else { ident(&fc) };
            let mut parts: Vec<String> = Self::with_filter(l, where_).into_iter().collect();
            if let Some(f) = fids {
                let list: Vec<String> = f.iter().map(|x| x.to_string()).collect();
                parts.push(format!("{fid_expr} IN ({})", if list.is_empty() { "-1".into() } else { list.join(",") }));
            }
            (!parts.is_empty()).then(|| parts.join(" AND "))
        };
        let n = copy_layer(l.path(), l.layer_name(), filter.as_deref(), &copy, &stem)?;
        if n == 0 {
            let _ = std::fs::remove_file(&copy);
            return Err("no features to export".into());
        }
        let mut idx = self.edit_index();
        idx.insert(id.clone(), Entry { copy: copy.clone(), layer: stem.clone(), source: None, source_layer: None, name: name.trim().to_string() });
        self.save_edit_index(&idx)?;
        self.reload_layer(&id, &copy, &stem, name.trim())?;
        Ok(id)
    }

    /// A new, empty layer to digitise into (WGS 84 GeoPackage, kept with the edits).
    pub fn create_layer(&self, name: &str, geometry: &str, fields: &[(String, String)]) -> Result<String, String> {
        let stem = catalog::sanitize(name.trim()).replace('.', "_");
        if stem.trim_matches('_').is_empty() {
            return Err("give the new layer a name".into());
        }
        let id = format!("{stem}.gpkg");
        if self.layer(&id).is_some() {
            return Err(format!("a layer '{id}' already exists; choose another name"));
        }
        let ty = match geometry {
            "point" | "points" => G::wkbPoint,
            "line" | "lines" | "linestring" => G::wkbLineString,
            "polygon" | "polygons" | "area" => G::wkbPolygon,
            g => return Err(format!("unknown geometry '{g}' (point, line or polygon)")),
        };
        let dir = self.edits_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{stem}.gpkg"));
        let _ = std::fs::remove_file(&path);
        {
            let drv = DriverManager::get_driver_by_name("GPKG").map_err(gerr)?;
            let mut ds = drv.create_vector_only(&path).map_err(gerr)?;
            let srs = wgs84()?;
            let opts = ["FID=fid", "GEOMETRY_NAME=geom"];
            let lyr = ds.create_layer(LayerOptions { name: &stem, srs: Some(&srs), ty, options: Some(&opts) }).map_err(gerr)?;
            for (n, k) in fields {
                FieldDefn::new(n.trim(), ogr_type(k)?).map_err(gerr)?.add_to_layer(&lyr).map_err(gerr)?;
            }
        }
        let mut idx = self.edit_index();
        idx.insert(id.clone(), Entry { copy: path.clone(), layer: stem.clone(), source: None, source_layer: None, name: name.trim().to_string() });
        self.save_edit_index(&idx)?;
        self.reload_layer(&id, &path, &stem, name.trim())?;
        Ok(id)
    }
}

fn count(ds: &Dataset, sql: &str) -> Result<u64, String> {
    count_dialect(ds, sql, Dialect::DEFAULT)
}

fn count_dialect(ds: &Dataset, sql: &str, d: Dialect) -> Result<u64, String> {
    let rs = ds.execute_sql(sql, None, d).map_err(gerr)?;
    let mut rs = rs.ok_or("no result")?;
    let n = rs.features().next().and_then(|f| f.field(0).ok().flatten()).and_then(|v| v.into_int64()).unwrap_or(0);
    Ok(n.max(0) as u64)
}

// ---------------------------------------------------------------- geometry edits (Edit › Modify)

/// A geometry GEOS made through the OGR C API, copied into an owned `Geometry` (via WKB) and the
/// C one destroyed.
fn take(h: gdal_sys::OGRGeometryH) -> Option<Geometry> {
    if h.is_null() {
        return None;
    }
    // SAFETY: h is a valid geometry we own; the buffer is sized by OGR_G_WkbSize.
    unsafe {
        let n = gdal_sys::OGR_G_WkbSize(h).max(0) as usize;
        let mut buf = vec![0u8; n];
        gdal_sys::OGR_G_ExportToWkb(h, gdal_sys::OGRwkbByteOrder::wkbNDR, buf.as_mut_ptr());
        gdal_sys::OGR_G_DestroyGeometry(h);
        Geometry::from_wkb(&buf).ok()
    }
}

fn boundary(g: &Geometry) -> Option<Geometry> {
    take(unsafe { gdal_sys::OGR_G_Boundary(g.c_geometry()) })
}
fn polygonize(g: &Geometry) -> Option<Geometry> {
    take(unsafe { gdal_sys::OGR_G_Polygonize(g.c_geometry()) })
}
fn point_on_surface(g: &Geometry) -> Option<Geometry> {
    take(unsafe { gdal_sys::OGR_G_PointOnSurface(g.c_geometry()) })
}
fn distance(a: &Geometry, b: &Geometry) -> f64 {
    unsafe { gdal_sys::OGR_G_Distance(a.c_geometry(), b.c_geometry()) }
}
/// The single parts of a geometry (a polygon of a multipolygon, a line of a multilinestring …).
fn parts(g: &Geometry) -> Vec<Geometry> {
    let n = g.geometry_count();
    let t = gdal::vector::geometry_type_flatten(g.geometry_type());
    if n == 0 || matches!(t, G::wkbPolygon | G::wkbLineString | G::wkbPoint) {
        return vec![g.clone()];
    }
    (0..n).flat_map(|i| parts(&g.get_geometry(i).clone())).collect()
}

/// A sketch (GeoJSON in WGS 84) in the layer's CRS, its type kept.
fn sketch_in<L: LayerAccess>(lyr: &L, g: &Value) -> Result<Geometry, String> {
    let mut geom = Geometry::from_geojson(&g.to_string()).map_err(|e| format!("bad sketch: {e}"))?;
    if let Some(srs) = lyr.spatial_ref()
        && !catalog::is_wgs84(&srs) {
            let mut dst = srs.clone();
            dst.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
            let ct = CoordTransform::new(&wgs84()?, &dst).map_err(gerr)?;
            geom.transform_inplace(&ct).map_err(gerr)?;
        }
    Ok(geom)
}

/// Fit a result to the layer's geometry type: parts are wrapped in a multi type when the layer
/// holds those; a single-type layer gets one part per feature.
fn fit_type(want: gdal_sys::OGRwkbGeometryType::Type, g: Geometry) -> Vec<Geometry> {
    let multi = matches!(want, G::wkbMultiPolygon | G::wkbMultiLineString | G::wkbMultiPoint);
    let ps = parts(&g);
    if multi {
        let mut m = Geometry::empty(want).unwrap();
        for p in ps {
            let _ = m.add_geometry(p);
        }
        vec![m]
    } else {
        ps
    }
}

/// A line with both ends pushed out along their last segments by `frac` of the line's extent.
fn extend_ends(line: &Geometry, frac: f64) -> Geometry {
    let mut pts = Vec::new();
    line.get_points(&mut pts);
    if pts.len() < 2 || gdal::vector::geometry_type_flatten(line.geometry_type()) != G::wkbLineString {
        return line.clone();
    }
    let e = line.envelope();
    let d = (e.MaxX - e.MinX).max(e.MaxY - e.MinY) * frac;
    let push = |a: (f64, f64, f64), b: (f64, f64, f64)| -> (f64, f64) {
        let (dx, dy) = (a.0 - b.0, a.1 - b.1);
        let n = (dx * dx + dy * dy).sqrt();
        if n == 0.0 { (a.0, a.1) } else { (a.0 + dx / n * d, a.1 + dy / n * d) }
    };
    let n = pts.len();
    let start = push(pts[0], pts[1]);
    let end = push(pts[n - 1], pts[n - 2]);
    let mut out = Geometry::empty(G::wkbLineString).unwrap();
    out.add_point_2d(start);
    for p in &pts {
        out.add_point_2d((p.0, p.1));
    }
    out.add_point_2d(end);
    out
}

/// Split a polygon by a line: the faces of its boundary noded with the line, inside it.
fn split_polygon(g: &Geometry, line: &Geometry) -> Vec<Geometry> {
    let Some(b) = boundary(g) else { return vec![] };
    let Some(noded) = b.union(line) else { return vec![] };
    let Some(faces) = polygonize(&noded) else { return vec![] };
    parts(&faces).into_iter().filter(|f| point_on_surface(f).is_some_and(|p| g.contains(&p))).collect()
}

/// Split a line where a sketch crosses it.
fn split_line(g: &Geometry, line: &Geometry) -> Vec<Geometry> {
    let Some(noded) = g.union(line) else { return vec![] };
    let tol = (g.envelope().MaxX - g.envelope().MinX).abs().max((g.envelope().MaxY - g.envelope().MinY).abs()) * 1e-9 + 1e-12;
    parts(&noded)
        .into_iter()
        .filter(|p| {
            // a piece of the original line: every vertex lies on it
            let mut pts = Vec::new();
            p.get_points(&mut pts);
            pts.iter().all(|(x, y, _)| {
                let mut pt = Geometry::empty(G::wkbPoint).unwrap();
                pt.add_point_2d((*x, *y));
                distance(&pt, g) <= tol
            })
        })
        .collect()
}

impl Engine {
    /// Split, merge, cut or reshape features (Edit › Modify). `body`: `op`, `fids` and, for split,
    /// cut and reshape, `sketch` (GeoJSON in WGS 84: a line, or a polygon for cut). Returns the
    /// changed and created feature ids.
    pub fn geometry_edit(&self, id: &str, body: &Value) -> Result<(Vec<u64>, Arc<LayerHandle>), String> {
        let op = body["op"].as_str().unwrap_or("");
        let fids: Vec<u64> = body["fids"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
        if fids.is_empty() {
            return Err("select the features to change first".into());
        }
        let _g = EDIT.lock().unwrap();
        let l = self.edit_layer(id)?;
        let mut touched = Vec::new();
        {
            let mut ds = open_update(l.path())?;
            let txn = ds.start_transaction().map_err(gerr)?;
            {
                let lyr = txn.layer_by_name(l.layer_name()).map_err(gerr)?;
                let want = gdal::vector::geometry_type_flatten(lyr.defn().geometry_type());
                let polygonal = matches!(want, G::wkbPolygon | G::wkbMultiPolygon);
                let linear = matches!(want, G::wkbLineString | G::wkbMultiLineString);
                let sketch = match body.get("sketch").filter(|s| !s.is_null()) {
                    Some(s) => Some(sketch_in(&lyr, s)?),
                    None => None,
                };
                // copy a feature with a new geometry (same attributes)
                let nfields = lyr.defn().fields().count();
                let values_of = |src: &Feature| -> Vec<Option<FieldValue>> { (0..nfields).map(|i| src.field(i).ok().flatten()).collect() };
                let add_copy = |vals: &[Option<FieldValue>], g: Geometry| -> Result<u64, String> {
                    let mut f = Feature::new(lyr.defn()).map_err(gerr)?;
                    for (i, v) in vals.iter().enumerate() {
                        if let Some(v) = v {
                            let _ = f.set_field(i, v);
                        }
                    }
                    f.set_geometry(g).map_err(gerr)?;
                    f.create(&lyr).map_err(gerr)?;
                    f.fid().ok_or_else(|| "the new feature got no id".to_string())
                };
                match op {
                    "merge" => {
                        if fids.len() < 2 {
                            return Err("select two or more features to merge".into());
                        }
                        let mut acc: Option<Geometry> = None;
                        for &fid in &fids {
                            let f = lyr.feature(fid).ok_or_else(|| format!("no feature {fid}"))?;
                            let g = f.geometry().ok_or("a feature without geometry")?.clone();
                            acc = Some(match acc {
                                None => g,
                                Some(a) => a.union(&g).ok_or("the features could not be merged")?,
                            });
                        }
                        let merged = fit_type(want, acc.unwrap());
                        if merged.len() != 1 {
                            return Err(format!("the merged shape has {} separate parts, but this layer holds single-part features; merge features that touch, or export to a layer with multi-part geometries", merged.len()));
                        }
                        let mut first = lyr.feature(fids[0]).unwrap();
                        first.set_geometry(merged.into_iter().next().unwrap()).map_err(gerr)?;
                        lyr.set_feature(first).map_err(gerr)?;
                        for &fid in &fids[1..] {
                            unsafe { gdal_sys::OGR_L_DeleteFeature(lyr.c_layer(), fid as i64) };
                        }
                        touched.push(fids[0]);
                    }
                    "split" | "cut" | "reshape" => {
                        let sk = sketch.ok_or("draw the line (or area) to split, cut or reshape with")?;
                        for &fid in &fids {
                            let mut f = lyr.feature(fid).ok_or_else(|| format!("no feature {fid}"))?;
                            let g = f.geometry().ok_or("a feature without geometry")?.clone();
                            let pieces: Vec<Geometry> = match op {
                                "split" if polygonal => split_polygon(&g, &sk),
                                "split" if linear => split_line(&g, &sk),
                                "split" => return Err("points cannot be split".into()),
                                "cut" => {
                                    if !polygonal {
                                        return Err("cut works on polygons: draw an area over them".into());
                                    }
                                    let inside = g.intersection(&sk).filter(|x| !x.is_empty() && x.area() > 0.0);
                                    let outside = g.difference(&sk).filter(|x| !x.is_empty() && x.area() > 0.0);
                                    match (outside, inside) {
                                        (Some(o), Some(i)) => vec![o, i],
                                        _ => vec![],
                                    }
                                }
                                _ => {
                                    // reshape: faces the sketch makes with the boundary; outside ones are
                                    // added (the line pushes the boundary out), otherwise the largest
                                    // inside face is kept (the line cuts it in)
                                    if !polygonal {
                                        return Err("reshape works on polygons".into());
                                    }
                                    let b = boundary(&g).ok_or("no boundary")?;
                                    // a sketch drawn from the boundary rarely starts exactly on it: extend
                                    // both ends a little so they cross it (dangling bits are dropped)
                                    let sk = extend_ends(&sk, 0.002);
                                    let noded = b.union(&sk).ok_or("the line could not be noded")?;
                                    let faces = parts(&polygonize(&noded).ok_or("no faces")?);
                                    let (inside, outside): (Vec<Geometry>, Vec<Geometry>) = faces.into_iter().partition(|x| point_on_surface(x).is_some_and(|p| g.contains(&p)));
                                    let shape = if !outside.is_empty() {
                                        outside.iter().try_fold(g.clone(), |a, x| a.union(x))
                                    } else {
                                        inside.into_iter().max_by(|a, b| a.area().total_cmp(&b.area()))
                                    };
                                    shape.into_iter().collect()
                                }
                            };
                            if pieces.is_empty() || (op == "split" && pieces.len() < 2) {
                                continue;
                            }
                            let mut fitted: Vec<Geometry> = Vec::new();
                            for p in pieces {
                                fitted.extend(fit_type(want, p));
                            }
                            let mut it = fitted.into_iter();
                            f.set_geometry(it.next().unwrap()).map_err(gerr)?;
                            let snapshot = values_of(&f);
                            lyr.set_feature(f).map_err(gerr)?;
                            touched.push(fid);
                            for g2 in it {
                                touched.push(add_copy(&snapshot, g2)?);
                            }
                        }
                        if touched.is_empty() {
                            return Err(match op {
                                "split" => "the line does not cross the selected features from side to side",
                                "cut" => "the area does not overlap the selected polygons",
                                _ => "the line does not cross the polygon's boundary twice",
                            }
                            .into());
                        }
                    }
                    other => return Err(format!("unknown edit '{other}' (merge, split, cut or reshape)")),
                }
            }
            txn.commit().map_err(gerr)?;
        }
        Ok((touched, self.reload(&l)?))
    }
}

impl Engine {
    /// A layer as a file to download (Share › Export data): GeoPackage, Shapefile (zipped), KML,
    /// CSV (WKT geometry), GeoJSON or GeoParquet, in WGS 84 except GeoPackage and Shapefile, which
    /// keep the layer's CRS. A definition query applies. Returns (bytes, file name, content type).
    pub fn layer_download(&self, l: &LayerHandle, format: &str) -> Result<(Vec<u8>, String, &'static str), String> {
        let (driver, ext, ctype, wgs, extra): (&str, &str, &'static str, bool, &[&str]) = match format {
            "gpkg" | "geopackage" => ("GPKG", "gpkg", "application/geopackage+sqlite3", false, &[]),
            "shp" | "shapefile" => ("ESRI Shapefile", "shp", "application/zip", false, &["-lco", "ENCODING=UTF-8"]),
            "kml" => ("KML", "kml", "application/vnd.google-earth.kml+xml", true, &[]),
            "csv" => ("CSV", "csv", "text/csv", true, &["-lco", "GEOMETRY=AS_WKT"]),
            "geojson" | "json" => ("GeoJSON", "geojson", "application/geo+json", true, &["-lco", "RFC7946=YES"]),
            "parquet" | "geoparquet" => ("Parquet", "parquet", "application/vnd.apache.parquet", false, &[]),
            f => return Err(format!("unknown format '{f}' (gpkg, shp, kml, csv, geojson, parquet)")),
        };
        // GeoParquet without GDAL's Parquet driver (the builds GeoSpaX ships with have none):
        // a WGS 84 GeoPackage first, then the parquet crate writes the file
        let native_parquet = driver == "Parquet" && DriverManager::get_driver_by_name(driver).is_err();
        if !native_parquet && DriverManager::get_driver_by_name(driver).is_err() {
            return Err(format!("this GDAL has no {driver} driver"));
        }
        let (driver, ext_gdal, wgs) = if native_parquet { ("GPKG", "gpkg", true) } else { (driver, ext, wgs) };
        let stem = {
            let s = catalog::sanitize(&l.info.name).replace('.', "_");
            if s.trim_matches('_').is_empty() { "layer".to_string() } else { s }
        };
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("geospax-dl-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(format!("{stem}.{ext_gdal}"));
        let mut args: Vec<String> = vec!["-f".into(), driver.into(), "-nln".into(), stem.clone()];
        if wgs {
            args.extend(["-t_srs".into(), "EPSG:4326".into()]);
        }
        if let Some(w) = Self::with_filter(l, None) {
            args.extend(["-where".into(), w]);
        }
        args.extend(extra.iter().map(|s| s.to_string()));
        let res = crate::services::vector_translate(&l.path().to_string_lossy(), Some(l.layer_name()), &out, &args);
        let result = res.and_then(|_| {
            if ext == "shp" {
                // the Shapefile's parts in one zip
                let mut buf = std::io::Cursor::new(Vec::new());
                {
                    let mut z = zip::ZipWriter::new(&mut buf);
                    let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
                    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        z.start_file(name, opt).map_err(|e| e.to_string())?;
                        std::io::Write::write_all(&mut z, &std::fs::read(e.path()).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                    }
                    z.finish().map_err(|e| e.to_string())?;
                }
                Ok((buf.into_inner(), format!("{stem}.zip"), ctype))
            } else if native_parquet {
                let pq = dir.join(format!("{stem}.parquet"));
                crate::geoparquet::write_file(&out, Some(&stem), &pq)?;
                Ok((std::fs::read(&pq).map_err(|e| e.to_string())?, format!("{stem}.parquet"), ctype))
            } else {
                Ok((std::fs::read(&out).map_err(|e| e.to_string())?, format!("{stem}.{ext}"), ctype))
            }
        });
        let _ = std::fs::remove_dir_all(&dir);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geodesic_measures() {
        // a 1° × 1° cell at the equator: 12,363.7 km² on the sphere (R = 6,371,008.8 m)
        let sq = Geom::Polygons(vec![vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]]]]);
        let (a, p, _) = measure(&sq);
        let exact = EARTH_R * EARTH_R * 1f64.to_radians() * (1f64.to_radians().sin());
        assert!((a - exact).abs() / exact < 1e-9, "{a} vs {exact}");
        assert!((p / 1000.0 - 444.7).abs() < 0.5, "perimeter {p}");
        // 1° of longitude along the equator: 111.195 km
        let l = Geom::Lines(vec![vec![[0.0, 0.0], [1.0, 0.0]]]);
        assert!((measure(&l).1 - 111_195.08).abs() < 0.1);
    }

    #[test]
    fn sql_quoting() {
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(tidy("CPL error class: '3', error number: '1', error msg: 'In ExecuteSQL(): sqlite3_prepare_v2(SELECT x):\n  no such column: x'"), "no such column: x");
        assert_eq!(literal("O'Neil"), "'O''Neil'");
        assert_eq!(Engine::scope_sql("fid", Some("x > 1"), Some(&[3, 4])), " WHERE (x > 1) AND \"fid\" IN (3,4)");
        assert_eq!(Engine::scope_sql("fid", None, Some(&[])), " WHERE \"fid\" IN (NULL)");
    }
}
