//! Offline field sync (docs/USER_GUIDE.md "Field sync without a network").
//!
//! A field trip starts with **Package for field**: the layer is made editable (its GeoPackage edit
//! copy, see `edit.rs`) and that file is copied twice into `<state>/sync/<layer>/<stamp>/`, as
//! `base.gpkg` (kept on this computer) and `field.gpkg` (carried out on a USB stick, a laptop or a
//! phone and edited there, in GeoSpaX, QGIS or QField). Because both copies are byte copies, every
//! feature keeps its id (fid).
//!
//! Back from the field, **Review** does a three way comparison per feature: base (as it left),
//! ours (this computer now) and theirs (the returned file). Changes made on only one side merge
//! on their own, as do edits to different fields of the same feature. Real conflicts (the same
//! field changed on both sides, or an edit on one side and a delete on the other) are listed for
//! the user to decide; nothing is written until **Apply**, and only through the usual edit
//! functions, so Revert still works.

use crate::catalog;
use crate::edit::geometry_out;
use crate::Engine;
use gdal::vector::LayerAccess;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// fid → `{ "geometry": GeoJSON (WGS 84), "properties": {...} }`.
pub type Features = BTreeMap<u64, Value>;

/// Read every feature of `layer` (or the first layer) in a vector file.
pub fn read_features(path: &Path, layer: &str) -> Result<Features, String> {
    let ds = catalog::open_vector(path)?;
    let lyr = match ds.layer_by_name(layer) {
        Ok(l) => l,
        Err(_) => ds.layer(0).map_err(|e| format!("{}: no layers ({e})", path.display()))?,
    };
    let srs = lyr.spatial_ref();
    let names: Vec<String> = lyr.defn().fields().map(|f| f.name()).collect();
    let mut lyr = lyr;
    let mut out = Features::new();
    for f in lyr.features() {
        let Some(fid) = f.fid() else { continue };
        let geometry = match f.geometry() {
            Some(g) => geometry_out(g, srs.as_ref())?,
            None => Value::Null,
        };
        let mut props = Map::new();
        for (i, n) in names.iter().enumerate() {
            props.insert(n.clone(), crate::edit::value_json(f.field(i).ok().flatten()));
        }
        out.insert(fid, json!({ "geometry": geometry, "properties": props }));
    }
    Ok(out)
}

/// What one side changed relative to base: "geometry" and field names.
fn changed(base: &Value, side: &Value) -> BTreeSet<String> {
    let mut c = BTreeSet::new();
    if !same_geometry(&base["geometry"], &side["geometry"]) {
        c.insert("geometry".to_string());
    }
    if let Some(bp) = base["properties"].as_object() {
        for (k, v) in bp {
            if let Some(sv) = side["properties"].get(k) {
                if !same_value(v, sv) {
                    c.insert(k.clone());
                }
            }
        }
    }
    c
}

/// Coordinates equal within 1e-9 degrees (round trips through a projected CRS are not exact).
fn same_geometry(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => (x.as_f64().unwrap_or(0.0) - y.as_f64().unwrap_or(0.0)).abs() < 1e-9,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_geometry(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_geometry(v, w))),
        _ => a == b,
    }
}

fn same_value(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() <= 1e-12 * x.abs().max(1.0),
        _ => a == b,
    }
}

/// The three way comparison. Each change: `{fid, action, fields, theirs, ours, base, reason}` with
/// action `add`, `update`, `delete` (applied by default) or `conflict` (the user decides).
pub fn diff(base: &Features, ours: &Features, theirs: &Features) -> Vec<Value> {
    let mut out = Vec::new();
    let fids: BTreeSet<u64> = base.keys().chain(theirs.keys()).copied().collect();
    for fid in fids {
        let (b, o, t) = (base.get(&fid), ours.get(&fid), theirs.get(&fid));
        match (b, t) {
            (Some(b), Some(t)) => {
                let tc = changed(b, t);
                if tc.is_empty() {
                    continue;
                }
                match o {
                    None => out.push(json!({ "fid": fid, "action": "conflict", "reason": "edited in the field, deleted here", "fields": tc, "theirs": t, "base": b })),
                    Some(o) => {
                        let oc = changed(b, o);
                        let both: Vec<&String> = tc.intersection(&oc).filter(|k| !same_field(k, o, t)).collect();
                        let theirs_only: BTreeSet<String> = tc.iter().filter(|k| !oc.contains(*k)).cloned().collect();
                        if !both.is_empty() {
                            out.push(json!({ "fid": fid, "action": "conflict", "reason": format!("changed on both sides: {}", both.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")), "fields": tc, "theirs": t, "ours": o, "base": b }));
                        } else if !theirs_only.is_empty() {
                            out.push(json!({ "fid": fid, "action": "update", "fields": theirs_only, "theirs": t, "ours": o, "base": b }));
                        }
                    }
                }
            }
            (Some(b), None) => match o {
                None => {}
                Some(o) if changed(b, o).is_empty() => out.push(json!({ "fid": fid, "action": "delete", "fields": [], "ours": o, "base": b })),
                Some(o) => out.push(json!({ "fid": fid, "action": "conflict", "reason": "deleted in the field, edited here", "fields": [], "ours": o, "base": b })),
            },
            (None, Some(t)) => out.push(json!({ "fid": fid, "action": "add", "fields": [], "theirs": t })),
            (None, None) => {}
        }
    }
    out
}

fn same_field(k: &str, o: &Value, t: &Value) -> bool {
    if k == "geometry" {
        same_geometry(&o["geometry"], &t["geometry"])
    } else {
        same_value(&o["properties"][k], &t["properties"][k])
    }
}

impl Engine {
    fn sync_root(&self) -> PathBuf {
        self.state_dir.join("sync")
    }

    /// A package directory given by the client, confined to `<state>/sync`.
    fn sync_dir(&self, package: &str) -> Result<PathBuf, String> {
        let root = std::fs::canonicalize(self.sync_root()).map_err(|_| "no field packages yet".to_string())?;
        let p = std::fs::canonicalize(root.join(package)).map_err(|_| format!("no field package '{package}'"))?;
        if !p.starts_with(&root) || !p.join("base.gpkg").is_file() {
            return Err(format!("no field package '{package}'"));
        }
        Ok(p)
    }

    /// Package a layer for the field: returns `{package, field, base, features}`.
    pub fn sync_package(&self, id: &str) -> Result<Value, String> {
        let l = self.edit_layer(id)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let rel = format!("{}/{stamp}", catalog::sanitize(id).replace('.', "_"));
        let dir = self.sync_root().join(&rel);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for name in ["base.gpkg", "field.gpkg"] {
            std::fs::copy(l.path(), dir.join(name)).map_err(|e| format!("copy {name}: {e}"))?;
        }
        let manifest = json!({ "layer": id, "layer_name": l.layer_name(), "name": l.info.name, "created": chrono::Local::now().to_rfc3339(), "applied": null });
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
        Ok(json!({ "package": rel, "field": dir.join("field.gpkg"), "base": dir.join("base.gpkg"), "features": l.info.feature_count }))
    }

    /// Field packages on this computer, newest first.
    pub fn sync_packages(&self) -> Value {
        let mut v = Vec::new();
        let root = self.sync_root();
        for layer in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            for p in std::fs::read_dir(layer.path()).into_iter().flatten().flatten() {
                if let Ok(m) = std::fs::read(p.path().join("manifest.json")) {
                    if let Ok(mut m) = serde_json::from_slice::<Value>(&m) {
                        m["package"] = json!(format!("{}/{}", layer.file_name().to_string_lossy(), p.file_name().to_string_lossy()));
                        m["field"] = json!(p.path().join("field.gpkg"));
                        v.push(m);
                    }
                }
            }
        }
        v.sort_by(|a, b| b["created"].as_str().cmp(&a["created"].as_str()));
        json!({ "packages": v })
    }

    fn sync_sides(&self, package: &str, returned: Option<&str>) -> Result<(PathBuf, Value, Features, Features, Features), String> {
        let dir = self.sync_dir(package)?;
        let m: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let id = m["layer"].as_str().ok_or("bad manifest")?.to_string();
        let lname = m["layer_name"].as_str().unwrap_or("").to_string();
        let l = self.layer(&id).ok_or_else(|| format!("layer '{id}' is not on the map"))?;
        let theirs_path = match returned.filter(|s| !s.trim().is_empty()) {
            Some(p) => PathBuf::from(p),
            None => dir.join("field.gpkg"),
        };
        if !theirs_path.is_file() {
            return Err(format!("{} not found", theirs_path.display()));
        }
        let base = read_features(&dir.join("base.gpkg"), &lname)?;
        let ours = read_features(l.path(), l.layer_name())?;
        let theirs = read_features(&theirs_path, &lname)?;
        Ok((dir, m, base, ours, theirs))
    }

    /// Compare a returned field copy (default: the package's own field.gpkg) with this computer.
    pub fn sync_review(&self, package: &str, returned: Option<&str>) -> Result<Value, String> {
        let (_, m, base, ours, theirs) = self.sync_sides(package, returned)?;
        let changes = diff(&base, &ours, &theirs);
        let count = |a: &str| changes.iter().filter(|c| c["action"] == a).count();
        Ok(json!({ "layer": m["layer"], "package": package, "summary": { "add": count("add"), "update": count("update"), "delete": count("delete"), "conflict": count("conflict") }, "changes": changes }))
    }

    /// Apply the review. `choices` maps a conflicting fid to "theirs" or "ours" (default ours, so
    /// an unresolved conflict changes nothing). Returns what was done.
    pub fn sync_apply(&self, package: &str, returned: Option<&str>, choices: &Map<String, Value>) -> Result<Value, String> {
        let (dir, mut m, base, ours, theirs) = self.sync_sides(package, returned)?;
        let id = m["layer"].as_str().unwrap_or("").to_string();
        let changes = diff(&base, &ours, &theirs);
        let (mut added, mut updated, mut deleted, mut kept) = (0, 0, 0, 0);
        let mut dels = Vec::new();
        for c in &changes {
            let fid = c["fid"].as_u64().unwrap_or(0);
            let mut action = c["action"].as_str().unwrap_or("").to_string();
            if action == "conflict" {
                if choices.get(&fid.to_string()).and_then(Value::as_str) != Some("theirs") {
                    kept += 1;
                    continue;
                }
                action = match (c.get("theirs"), c.get("ours")) {
                    (None, _) => "delete".into(),
                    (Some(_), None) => "add".into(),
                    _ => "replace".into(),
                };
            }
            let t = &c["theirs"];
            match action.as_str() {
                "add" => {
                    let body = json!({ "geometry": t["geometry"], "properties": t["properties"] });
                    self.feature_add(&id, &body)?;
                    added += 1;
                }
                "update" | "replace" => {
                    let mut props = Map::new();
                    let mut geometry = Value::Null;
                    let all = action == "replace";
                    for f in c["fields"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        if f == "geometry" {
                            geometry = t["geometry"].clone();
                        } else {
                            props.insert(f.to_string(), t["properties"][f].clone());
                        }
                    }
                    if all {
                        geometry = t["geometry"].clone();
                        props = t["properties"].as_object().cloned().unwrap_or_default();
                        let known = ours.get(&fid).and_then(|o| o["properties"].as_object().cloned()).unwrap_or_default();
                        props.retain(|k, _| known.contains_key(k));
                    }
                    self.feature_update(&id, fid, &json!({ "geometry": geometry, "properties": props }))?;
                    updated += 1;
                }
                "delete" => dels.push(fid),
                _ => {}
            }
        }
        if !dels.is_empty() {
            deleted = self.features_delete(&id, &dels)?.0;
        }
        m["applied"] = json!(chrono::Local::now().to_rfc3339());
        let _ = std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap_or_default());
        Ok(json!({ "layer": id, "added": added, "updated": updated, "deleted": deleted, "conflicts_kept": kept }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(x: f64, name: &str, n: i64) -> Value {
        json!({ "geometry": { "type": "Point", "coordinates": [x, -9.4] }, "properties": { "name": name, "n": n } })
    }

    #[test]
    fn three_way_merge_rules() {
        let base: Features = [(1, f(147.0, "a", 1)), (2, f(147.1, "b", 1)), (3, f(147.2, "c", 1)), (4, f(147.3, "d", 1)), (5, f(147.4, "e", 1))].into();
        let mut ours = base.clone();
        let mut theirs = base.clone();
        // 1: field changes name, we change n -> merges as an update of name only
        theirs.insert(1, f(147.0, "a2", 1));
        ours.insert(1, f(147.0, "a", 9));
        // 2: both change name differently -> conflict
        theirs.insert(2, f(147.1, "x", 1));
        ours.insert(2, f(147.1, "y", 1));
        // 3: deleted in the field, untouched here -> delete
        theirs.remove(&3);
        // 4: deleted here, edited in the field -> conflict
        ours.remove(&4);
        theirs.insert(4, f(147.35, "d", 1));
        // 5: same edit on both sides -> nothing
        theirs.insert(5, f(147.4, "e", 2));
        ours.insert(5, f(147.4, "e", 2));
        // 10: new in the field -> add
        theirs.insert(10, f(148.0, "new", 1));
        let d = diff(&base, &ours, &theirs);
        let act = |fid: u64| d.iter().find(|c| c["fid"] == fid).map(|c| c["action"].as_str().unwrap().to_string());
        assert_eq!(act(1).as_deref(), Some("update"));
        assert_eq!(d.iter().find(|c| c["fid"] == 1).unwrap()["fields"], json!(["name"]));
        assert_eq!(act(2).as_deref(), Some("conflict"));
        assert_eq!(act(3).as_deref(), Some("delete"));
        assert_eq!(act(4).as_deref(), Some("conflict"));
        assert_eq!(act(5), None);
        assert_eq!(act(10).as_deref(), Some("add"));
    }

    #[test]
    fn package_review_apply_round_trip() {
        crate::raster::configure_gdal();
        let dir = std::env::temp_dir().join(format!("gx-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plots.geojson"), r#"{"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"name":"p1","n":1},"geometry":{"type":"Point","coordinates":[147.2,-9.4]}},
            {"type":"Feature","properties":{"name":"p2","n":2},"geometry":{"type":"Point","coordinates":[147.3,-9.5]}}]}"#).unwrap();
        let e = Engine::open(crate::EngineConfig { data: vec![dir.clone()], state_dir: Some(dir.join(".state")), ..Default::default() }).unwrap();
        let id = e.layer_ids().into_iter().find(|i| i.contains("plots")).unwrap();
        let pkg = e.sync_package(&id).unwrap();
        let rel = pkg["package"].as_str().unwrap().to_string();
        // edit the field copy the way another program would: straight into the GeoPackage
        {
            use gdal::vector::Feature;
            let field = PathBuf::from(pkg["field"].as_str().unwrap());
            let ds = gdal::Dataset::open_ex(&field, gdal::DatasetOptions { open_flags: gdal::GdalOpenFlags::GDAL_OF_VECTOR | gdal::GdalOpenFlags::GDAL_OF_UPDATE, ..Default::default() }).unwrap();
            let mut lyr = ds.layer(0).unwrap();
            let fids: Vec<u64> = lyr.features().filter_map(|f| f.fid()).collect();
            let mut first = lyr.feature(fids[0]).unwrap();
            first.set_field_string(first.field_index("name").unwrap(), "p1 checked").unwrap();
            lyr.set_feature(first).unwrap();
            let mut nf = Feature::new(lyr.defn()).unwrap();
            nf.set_geometry(gdal::vector::Geometry::from_wkt("POINT (147.25 -9.45)").unwrap()).unwrap();
            nf.set_field_string(nf.field_index("name").unwrap(), "p3").unwrap();
            nf.create(&lyr).unwrap();
        }
        let r = e.sync_review(&rel, None).unwrap();
        assert_eq!(r["summary"], json!({ "add": 1, "update": 1, "delete": 0, "conflict": 0 }), "{r}");
        let a = e.sync_apply(&rel, None, &Map::new()).unwrap();
        assert_eq!((a["added"].as_u64(), a["updated"].as_u64()), (Some(1), Some(1)), "{a}");
        let l = e.layer(&id).unwrap();
        let now = read_features(l.path(), l.layer_name()).unwrap();
        assert_eq!(now.len(), 3);
        assert!(now.values().any(|v| v["properties"]["name"] == "p1 checked"));
        assert!(e.sync_review("../../etc", None).is_err());
        assert_eq!(e.sync_packages()["packages"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
