//! Databases in the Explorer (as ArcGIS Pro's database connections and QGIS's PostgreSQL browser):
//! a PostGIS database lists its spatial tables and views; clicking one copies it (or, for a big table,
//! the part in the map view) into a GeoPackage under `<state>/databases/` and puts it on the map, so the
//! layer keeps working offline and in exports.
//!
//! No password is stored by GeoSpaX: libpq reads it from PGPASSWORD or ~/.pgpass (pgpass.conf on
//! Windows), as psql and QGIS do, and an address that contains one is refused.

use crate::Engine;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

/// `postgresql://user@host:port/dbname?sslmode=…` as a GDAL "PG:" connection string.
pub fn pg_conn(url: &str) -> Result<String, String> {
    let u = url.trim();
    let rest = u
        .strip_prefix("postgresql://")
        .or_else(|| u.strip_prefix("postgres://"))
        .ok_or("a PostGIS address starts with postgresql://")?;
    let (main, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (auth, hostdb) = match main.rsplit_once('@') {
        Some((a, h)) => (Some(a), h),
        None => (None, main),
    };
    if auth.is_some_and(|a| a.contains(':')) {
        return Err("leave the password out of the address: put it in ~/.pgpass (or PGPASSWORD), where psql and QGIS read it too".into());
    }
    let (hostport, db) = hostdb
        .split_once('/')
        .ok_or("name the database, as in postgresql://user@host:5432/dbname")?;
    if db.is_empty() || db.contains(['/', ' ', '\'']) {
        return Err("name the database, as in postgresql://user@host:5432/dbname".into());
    }
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
        _ => (hostport, None),
    };
    let safe = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    let mut parts = vec![format!("dbname={db}")];
    if !host.is_empty() {
        if !safe(host) {
            return Err(format!("not a host name: {host}"));
        }
        parts.push(format!("host={host}"));
    }
    if let Some(p) = port {
        parts.push(format!("port={p}"));
    }
    if let Some(user) = auth {
        if !safe(user) {
            return Err(format!("not a user name: {user}"));
        }
        parts.push(format!("user={user}"));
    }
    for kv in query.split('&').filter(|s| !s.is_empty()) {
        match kv.split_once('=') {
            Some(("sslmode", v)) if safe(v) => parts.push(format!("sslmode={v}")),
            Some(("schemas", v)) if v.split(',').all(safe) => parts.push(format!("schemas={v}")),
            _ => return Err(format!("unsupported option in the address: {kv}")),
        }
    }
    Ok(format!("PG:{}", parts.join(" ")))
}

fn open(svc: &Value) -> Result<gdal::Dataset, String> {
    let conn = pg_conn(svc["url"].as_str().unwrap_or(""))?;
    // vector only: GDAL would otherwise also look for PostGIS raster tables, and fail without that extension
    crate::catalog::open_vector(Path::new(&conn)).map_err(|e| {
        if e.contains("password") || e.contains("authentication") {
            format!("the database asked for a password: put it in ~/.pgpass ({e})")
        } else {
            format!("could not connect to the database ({e})")
        }
    })
}

/// The spatial tables and views, as Explorer rows (schema.table, geometry type, feature count).
pub fn list(svc: &Value) -> Result<Vec<Value>, String> {
    use gdal::vector::LayerAccess;
    let ds = open(svc)?;
    let mut out = Vec::new();
    for l in ds.layers() {
        let name = l.name();
        let geom = l
            .defn()
            .geom_fields()
            .next()
            .map(|g| crate::browse::geometry_word(&format!("{:?}", g.field_type())))
            .unwrap_or_default();
        if geom.is_empty() {
            continue; // a table without geometry is not a map layer
        }
        out.push(
            json!({ "id": name, "title": name, "type": "file", "kind": "vector", "note": geom }),
        );
    }
    out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(out)
}

/// Copy one table (only the part inside `bbox`, lon/lat, when given) into a GeoPackage and map it.
pub fn open_table(
    engine: &Arc<Engine>,
    svc: &Value,
    table: &str,
    bbox: Option<[f64; 4]>,
) -> Result<Value, String> {
    if !list(svc)?.iter().any(|t| t["id"] == table) {
        return Err(format!("no spatial table {table} in this database"));
    }
    let conn = pg_conn(svc["url"].as_str().unwrap_or(""))?;
    let dir = engine
        .state_dir
        .join("databases")
        .join(svc["id"].as_str().unwrap_or("db"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = crate::raster::sanitize(&table.replace('.', "_"));
    let dest = dir.join(format!("{file}.gpkg"));
    let _ = std::fs::remove_file(&dest);
    let mut args: Vec<String> = ["-f", "GPKG", "-t_srs", "EPSG:4326", "-nln", &file]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(b) = bbox {
        args.extend([
            "-spat".into(),
            b[0].to_string(),
            b[1].to_string(),
            b[2].to_string(),
            b[3].to_string(),
            "-spat_srs".into(),
            "EPSG:4326".into(),
        ]);
    }
    crate::services::vector_translate(&conn, Some(table), &dest, &args)?;
    let hs = crate::catalog::load_layers(&dest)?;
    let n: u64 = hs.iter().map(|h| h.info.feature_count).sum();
    Ok(json!({ "layers": engine.register_layers(hs), "rasters": [], "features": n }))
}

#[cfg(test)]
mod tests {
    use super::pg_conn;

    #[test]
    fn addresses() {
        assert_eq!(
            pg_conn("postgresql://ana@db.example.org:5433/gis").unwrap(),
            "PG:dbname=gis host=db.example.org port=5433 user=ana"
        );
        assert_eq!(
            pg_conn("postgres:///gis?sslmode=require").unwrap(),
            "PG:dbname=gis sslmode=require"
        );
        assert!(
            pg_conn("postgresql://ana:secret@host/gis")
                .unwrap_err()
                .contains("pgpass")
        );
        assert!(pg_conn("postgresql://host/gis?options=-c%20x").is_err());
        assert!(pg_conn("postgresql://ho st/gis").is_err());
        assert!(pg_conn("mysql://host/gis").is_err());
    }
}
