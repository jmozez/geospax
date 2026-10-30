//! SQL across every layer on the map (`POST /api/sql`).
//!
//! Statements run in GDAL's SQLite dialect with SpatiaLite functions (`ST_Intersects`, `ST_Buffer`,
//! `ST_Area`, ...), so one query can join a GeoPackage, a shapefile, a FlatGeobuf and a CSV. A layer is
//! named by its id in double quotes, as the Contents pane shows it: `SELECT * FROM "roads"`. A result
//! with geometry becomes a new layer (`sql.<name>`); a result without geometry comes back as rows.
//! Statements are read only: anything other than `SELECT` or `WITH` is refused.

use crate::catalog;
use crate::Engine;
use gdal::vector::LayerAccess;
use serde_json::{json, Map, Value};

/// Rows returned for a table result (the rest are counted, not sent).
pub const MAX_ROWS: usize = 5000;

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Replace `"<layer id>"` with `"<file>"."<layer>"`, longest ids first so `a.b` wins over `a`.
pub fn rewrite(sql: &str, layers: &[(String, String, String)]) -> String {
    let mut ls: Vec<&(String, String, String)> = layers.iter().collect();
    ls.sort_by_key(|l| std::cmp::Reverse(l.0.len()));
    let mut out = sql.to_string();
    for (id, path, name) in ls {
        out = out.replace(&quote(id), &format!("{}.{}", quote(path), quote(name)));
    }
    out
}

/// Only read statements: one SELECT or WITH, no ATTACH, PRAGMA or writes.
pub fn check(sql: &str) -> Result<(), String> {
    let s = sql.trim().trim_end_matches(';').trim();
    let head = s.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    if head != "SELECT" && head != "WITH" {
        return Err("only SELECT (or WITH ... SELECT) statements can run here".into());
    }
    if s.contains(';') {
        return Err("run one statement at a time".into());
    }
    // words outside quotes, so a column called "last_update" or a value 'drop' is fine
    let mut bare = String::new();
    let mut q: Option<char> = None;
    for c in s.chars() {
        match q {
            Some(open) if c == open => q = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => q = Some(c),
            None => bare.push(c),
        }
    }
    for w in bare.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        let w = w.to_ascii_uppercase();
        if ["ATTACH", "DETACH", "PRAGMA", "LOAD_EXTENSION", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "REPLACE", "VACUUM"].contains(&w.as_str()) {
            return Err(format!("{w} is not allowed in a query"));
        }
    }
    // a quoted name that looks like a path would let a query read any file: only layer ids are allowed
    let mut in_q = false;
    let mut name = String::new();
    for c in s.chars() {
        if c == '"' {
            if in_q && (name.contains('/') || name.contains('\\') || name.contains(':')) {
                return Err(format!("\"{name}\" is not a layer on the map; name layers by their id"));
            }
            in_q = !in_q;
            name.clear();
        } else if in_q {
            name.push(c);
        }
    }
    Ok(())
}

fn field_json(f: &gdal::vector::Feature, i: usize) -> Value {
    match f.field(i) {
        Ok(Some(gdal::vector::FieldValue::IntegerValue(x))) => json!(x),
        Ok(Some(gdal::vector::FieldValue::Integer64Value(x))) => json!(x),
        Ok(Some(gdal::vector::FieldValue::RealValue(x))) => json!(x),
        _ => f.field_as_string(i).ok().flatten().map(Value::from).unwrap_or(Value::Null),
    }
}

impl Engine {
    /// Run a read-only query across the loaded layers. `name` names the result layer.
    pub fn sql_query(&self, sql: &str, name: Option<&str>) -> Result<Value, String> {
        check(sql)?;
        let refs: Vec<(String, String, String)> =
            self.layers().iter().map(|l| (l.info.id.clone(), l.path.to_string_lossy().into_owned(), l.layer_name.clone())).collect();
        let used: Vec<String> = refs.iter().filter(|r| sql.contains(&quote(&r.0))).map(|r| r.0.clone()).collect();
        let full = rewrite(sql, &refs);
        // a non-SQLite host, so GDAL's SQLite dialect reads every "file"."layer" as a virtual table
        let drv = gdal::DriverManager::get_driver_by_name("Memory").map_err(|e| e.to_string())?;
        let host = drv.create_vector_only("sql").map_err(|e| e.to_string())?;
        let t0 = std::time::Instant::now();
        let mut rs = host
            .execute_sql(&full, None, gdal::vector::sql::Dialect::SQLITE)
            .map_err(|e| format!("SQL error: {e}"))?
            .ok_or("the statement returned no result set")?;
        if rs.defn().geom_fields().count() == 0 {
            let cols: Vec<String> = rs.defn().fields().map(|f| f.name()).collect();
            let (mut rows, mut total) = (Vec::new(), 0usize);
            for f in rs.features() {
                total += 1;
                if rows.len() < MAX_ROWS {
                    let mut m = Map::new();
                    for (i, c) in cols.iter().enumerate() {
                        m.insert(c.clone(), field_json(&f, i));
                    }
                    rows.push(Value::Object(m));
                }
            }
            return Ok(json!({ "kind": "rows", "columns": cols, "rows": rows, "count": total, "truncated": total > rows.len(), "layers": used, "ms": t0.elapsed().as_millis() as u64 }));
        }
        let name = catalog::sanitize(name.filter(|n| !n.trim().is_empty()).unwrap_or("query"));
        let dir = self.state_dir.join("outputs").join("sql");
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let file = dir.join(format!("{name}.gpkg"));
        let tmp = dir.join(format!("{name}.part.gpkg"));
        let _ = std::fs::remove_file(&tmp);
        {
            let gp = gdal::DriverManager::get_driver_by_name("GPKG").map_err(|e| e.to_string())?;
            let out = gp.create_vector_only(&tmp).map_err(|e| e.to_string())?;
            let cname = std::ffi::CString::new(name.clone()).map_err(|e| e.to_string())?;
            // SAFETY: both handles are valid for the duration of the call; GDAL copies the layer.
            let copied = unsafe { gdal_sys::GDALDatasetCopyLayer(out.c_dataset(), rs.c_layer(), cname.as_ptr(), std::ptr::null_mut()) };
            if copied.is_null() {
                return Err("could not write the query result".into());
            }
        }
        drop(rs);
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
        let id = format!("sql.{name}");
        let mut handles = catalog::load_layers(&file)?;
        handles.truncate(1);
        let count = handles.first().map(|h| h.info.feature_count).unwrap_or(0);
        for h in handles.iter_mut() {
            h.info.id = id.clone();
        }
        self.register_layers(handles);
        Ok(json!({ "kind": "layer", "layer": id, "features": count, "file": file, "layers": used, "ms": t0.elapsed().as_millis() as u64 }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_reads_run() {
        assert!(check("SELECT 1").is_ok());
        assert!(check("with a as (select 1) select * from a;").is_ok());
        assert!(check("DELETE FROM x").is_err());
        assert!(check("SELECT 1; DROP TABLE x").is_err());
        assert!(check("SELECT * FROM x WHERE 1; ATTACH 'y' AS z").is_err());
        assert!(check(r#"SELECT "last_update" FROM x WHERE v = 'drop'"#).is_ok());
        assert!(check(r#"SELECT * FROM "/etc/passwd"."x""#).is_err());
    }

    #[test]
    fn layer_ids_become_file_references() {
        let ls = vec![("a".to_string(), "/d/a.gpkg".to_string(), "a".to_string()), ("a.b".to_string(), "/d/a.gpkg".to_string(), "b".to_string())];
        assert_eq!(rewrite(r#"SELECT * FROM "a.b" JOIN "a""#, &ls), r#"SELECT * FROM "/d/a.gpkg"."b" JOIN "/d/a.gpkg"."a""#);
    }

    #[test]
    fn queries_join_layers_from_different_files() {
        crate::raster::configure_gdal();
        let dir = std::env::temp_dir().join(format!("gx-sql-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pts.geojson"), r#"{"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"v":1},"geometry":{"type":"Point","coordinates":[147.2,-9.4]}},
            {"type":"Feature","properties":{"v":2},"geometry":{"type":"Point","coordinates":[150,-5]}}]}"#).unwrap();
        std::fs::write(dir.join("zone.geojson"), r#"{"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"z":"NCD"},"geometry":{"type":"Polygon","coordinates":[[[147,-10],[148,-10],[148,-9],[147,-9],[147,-10]]]}}]}"#).unwrap();
        let e = Engine::open(crate::EngineConfig { data: vec![dir.clone()], state_dir: Some(dir.join(".state")), ..Default::default() }).unwrap();
        let ids = e.layer_ids();
        let (p, z) = (ids.iter().find(|i| i.contains("pts")).unwrap(), ids.iter().find(|i| i.contains("zone")).unwrap());
        let rows = e.sql_query(&format!(r#"SELECT z.z, count(*) AS n FROM "{p}" p JOIN "{z}" z ON ST_Intersects(p.geometry, z.geometry) GROUP BY z.z"#), None).unwrap();
        assert_eq!(rows["kind"], "rows", "{rows}");
        assert_eq!(rows["rows"][0]["n"], 1);
        let lay = e.sql_query(&format!(r#"SELECT v, ST_Buffer(geometry, 0.1) AS geometry FROM "{p}""#), Some("buffered")).unwrap();
        assert_eq!(lay["layer"], "sql.buffered", "{lay}");
        assert_eq!(lay["features"], 2);
        assert!(e.layer("sql.buffered").is_some());
        assert!(e.sql_query("DELETE FROM x", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
