// OGC API – Features (Part 1: Core, GeoJSON) for the layers on the map, so QGIS, ArcGIS Pro,
// GDAL/OGR and web maps can connect to GeoSpaX as a standard feature service:
//   /ogc                                   landing page
//   /ogc/conformance                       conformance classes
//   /ogc/collections                       one collection per layer
//   /ogc/collections/{id}                  a collection, with its extent
//   /ogc/collections/{id}/items            features (bbox, limit, offset), GeoJSON, with paging links
//   /ogc/collections/{id}/items/{fid}      one feature
// Coordinates are WGS 84 longitude/latitude (CRS84), as the standard's default.

use serde_json::{json, Map, Value};

use crate::automation::features::{self, Val};
use crate::router::{param, ApiResponse};
use crate::wkb::Geom;
use crate::Engine;

const GEOJSON: &str = "application/geo+json";

pub fn geometry(g: &Geom) -> Value {
    let pt = |c: &[f64; 2]| json!([c[0], c[1]]);
    let line = |l: &Vec<[f64; 2]>| Value::Array(l.iter().map(pt).collect());
    let poly = |p: &Vec<Vec<[f64; 2]>>| Value::Array(p.iter().map(line).collect());
    match g {
        Geom::Empty => Value::Null,
        Geom::Points(p) if p.len() == 1 => json!({ "type": "Point", "coordinates": pt(&p[0]) }),
        Geom::Points(p) => json!({ "type": "MultiPoint", "coordinates": p.iter().map(pt).collect::<Vec<_>>() }),
        Geom::Lines(l) if l.len() == 1 => json!({ "type": "LineString", "coordinates": line(&l[0]) }),
        Geom::Lines(l) => json!({ "type": "MultiLineString", "coordinates": l.iter().map(line).collect::<Vec<_>>() }),
        Geom::Polygons(p) if p.len() == 1 => json!({ "type": "Polygon", "coordinates": poly(&p[0]) }),
        Geom::Polygons(p) => json!({ "type": "MultiPolygon", "coordinates": p.iter().map(poly).collect::<Vec<_>>() }),
    }
}

fn value(v: &Val) -> Value {
    match v {
        Val::Null => Value::Null,
        Val::Int(i) => json!(i),
        Val::Num(f) if f.is_finite() => json!(f),
        Val::Num(_) => Value::Null,
        Val::Str(s) => json!(s),
    }
}

fn base(host: &str) -> String {
    format!("{}/ogc", host.trim_end_matches('/'))
}

fn links(self_href: &str, extra: &[(&str, &str, &str, &str)]) -> Value {
    let mut v = vec![json!({ "href": self_href, "rel": "self", "type": "application/json", "title": "this document" })];
    for (href, rel, ty, title) in extra {
        v.push(json!({ "href": href, "rel": rel, "type": ty, "title": title }));
    }
    Value::Array(v)
}

fn collection(engine: &Engine, b: &str, l: &crate::catalog::LayerHandle) -> Value {
    let id = &l.info.id;
    let bb = l.info.bounds;
    let _ = engine;
    json!({
        "id": id,
        "title": l.info.name,
        "description": format!("{} · {} features", l.info.name, l.info.feature_count),
        "extent": { "spatial": { "bbox": [[bb[0], bb[1], bb[2], bb[3]]], "crs": "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
        "itemType": "feature",
        "crs": ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
        "links": [
            { "href": format!("{b}/collections/{id}"), "rel": "self", "type": "application/json", "title": l.info.name },
            { "href": format!("{b}/collections/{id}/items"), "rel": "items", "type": GEOJSON, "title": "features" },
        ],
    })
}

/// Answer one /ogc/... request (`segs` without the leading "ogc"); `host` is scheme://host:port.
pub fn handle(engine: &Engine, segs: &[&str], query: &str, host: &str) -> ApiResponse {
    let b = base(host);
    // a trailing slash (/ogc/, /collections/) means the same document
    let segs: Vec<&str> = segs.iter().copied().filter(|s| !s.is_empty()).collect();
    match segs.as_slice() {
        [] => ApiResponse::json(200, &json!({
            "title": "GeoSpaX",
            "description": "The layers on this GeoSpaX map as an OGC API – Features service",
            "links": links(&b, &[
                (&format!("{b}/conformance"), "conformance", "application/json", "conformance classes"),
                (&format!("{b}/collections"), "data", "application/json", "the layers"),
            ]),
        })),
        ["conformance"] => ApiResponse::json(200, &json!({ "conformsTo": [
            "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
            "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
        ]})),
        ["collections"] => {
            let cols: Vec<Value> = engine.layers().iter().map(|l| collection(engine, &b, l)).collect();
            ApiResponse::json(200, &json!({ "collections": cols, "links": links(&format!("{b}/collections"), &[]) }))
        }
        ["collections", id] => match engine.layer(id) {
            Some(l) => ApiResponse::json(200, &collection(engine, &b, &l)),
            None => ApiResponse::error(404, format!("no collection '{id}'")),
        },
        ["collections", id, "items"] => {
            let Some(l) = engine.layer(id) else { return ApiResponse::error(404, format!("no collection '{id}'")) };
            let limit = param(query, "limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(100).clamp(1, 10_000);
            let offset = param(query, "offset").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
            let bbox = match param(query, "bbox") {
                Some(s) => {
                    let v: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                    if v.len() != 4 {
                        return ApiResponse::error(400, "bbox must be minx,miny,maxx,maxy");
                    }
                    Some([v[0], v[1], v[2], v[3]])
                }
                None => None,
            };
            let fs = match features::read_layer(engine, &l, bbox, None, offset + limit + 1) {
                Ok(f) => f,
                Err(e) => return ApiResponse::error(500, e),
            };
            let more = fs.feats.len() > offset + limit;
            let page: Vec<Value> = fs
                .feats
                .iter()
                .enumerate()
                .skip(offset)
                .take(limit)
                .map(|(i, f)| {
                    let mut props = Map::new();
                    for ((name, _), v) in fs.fields.iter().zip(&f.props) {
                        props.insert(name.clone(), value(v));
                    }
                    json!({ "type": "Feature", "id": i, "geometry": geometry(&f.geom), "properties": props })
                })
                .collect();
            let bq = param(query, "bbox").map(|s| format!("&bbox={s}")).unwrap_or_default();
            let here = format!("{b}/collections/{id}/items?limit={limit}&offset={offset}{bq}");
            let mut ls = vec![json!({ "href": here, "rel": "self", "type": GEOJSON })];
            if more {
                ls.push(json!({ "href": format!("{b}/collections/{id}/items?limit={limit}&offset={}{bq}", offset + limit), "rel": "next", "type": GEOJSON }));
            }
            if offset > 0 {
                ls.push(json!({ "href": format!("{b}/collections/{id}/items?limit={limit}&offset={}{bq}", offset.saturating_sub(limit)), "rel": "prev", "type": GEOJSON }));
            }
            let n = page.len();
            let mut r = ApiResponse::json(200, &json!({
                "type": "FeatureCollection", "features": page, "numberReturned": n,
                "timeStamp": chrono::Utc::now().to_rfc3339(), "links": ls,
            }));
            r.content_type = GEOJSON;
            r
        }
        ["collections", id, "items", fid] => {
            let Some(l) = engine.layer(id) else { return ApiResponse::error(404, format!("no collection '{id}'")) };
            let Ok(k) = fid.parse::<usize>() else { return ApiResponse::error(400, "feature ids are numbers") };
            let fs = match features::read_layer(engine, &l, None, None, k + 1) {
                Ok(f) => f,
                Err(e) => return ApiResponse::error(500, e),
            };
            let Some(f) = fs.feats.get(k) else { return ApiResponse::error(404, format!("no feature {k}")) };
            let mut props = Map::new();
            for ((name, _), v) in fs.fields.iter().zip(&f.props) {
                props.insert(name.clone(), value(v));
            }
            let mut r = ApiResponse::json(200, &json!({ "type": "Feature", "id": k, "geometry": geometry(&f.geom), "properties": props,
                "links": [{ "href": format!("{b}/collections/{id}/items/{k}"), "rel": "self", "type": GEOJSON }, { "href": format!("{b}/collections/{id}"), "rel": "collection", "type": "application/json" }] }));
            r.content_type = GEOJSON;
            r
        }
        // a minimal service description, enough for clients that look for one
        ["api"] => ApiResponse::json(200, &json!({
            "openapi": "3.0.2",
            "info": { "title": "GeoSpaX OGC API – Features", "version": env!("CARGO_PKG_VERSION") },
            "paths": { "/": {}, "/conformance": {}, "/collections": {}, "/collections/{collectionId}": {}, "/collections/{collectionId}/items": {}, "/collections/{collectionId}/items/{featureId}": {} },
        })),
        _ => ApiResponse::error(404, "not an OGC API – Features path"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometries_to_geojson() {
        assert_eq!(geometry(&Geom::Points(vec![[1.0, 2.0]]))["type"], "Point");
        assert_eq!(geometry(&Geom::Lines(vec![vec![[0.0, 0.0], [1.0, 1.0]], vec![[2.0, 2.0], [3.0, 3.0]]]))["type"], "MultiLineString");
        let p = geometry(&Geom::Polygons(vec![vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]]]));
        assert_eq!(p["type"], "Polygon");
        assert_eq!(p["coordinates"][0][2], json!([1.0, 1.0]));
    }
}
