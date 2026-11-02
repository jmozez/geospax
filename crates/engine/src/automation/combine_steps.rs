//! layers.combine: two layers into one answer, the method chosen from what they hold (Lazy mode's
//! "Combine with …"; the Toolbox and recipes call it too).
//!
//! | target (gets the fields)   | other     | result fields                                          |
//! |----------------------------|-----------|--------------------------------------------------------|
//! | polygons                   | points    | `n_<other>` points inside; with `field`, its sum/mean  |
//! | polygons                   | lines     | `len_m_<other>` length of line inside each polygon     |
//! | polygons                   | polygons  | `ovl_m2_<other>`, `ovl_pct_<other>` overlap area/share |
//! | points                     | polygons  | `in_<other>` the polygon each point lies in (its name) |
//! | points or lines            | points    | `near_m_<other>` distance to the nearest feature       |
//!
//! Points in polygons are counted exactly (even–odd rule, holes respected, a bounding box first); lengths
//! and overlaps are cut with GEOS through GDAL and measured geodesically, as Calculate geometry does.

use super::features::{self, Feat, FeatureSet, Val};
use super::steps::{p_str, sanitize, StepCtx, StepOut};
use crate::catalog::GeomKind;
use crate::wkb::Geom;
use gdal::vector::Geometry;
use serde_json::{json, Value};

const R: f64 = 6_371_008.8;

fn hav(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (la1, la2) = (a[1].to_radians(), b[1].to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((b[0] - a[0]).to_radians() / 2.0).sin().powi(2);
    2.0 * R * h.sqrt().asin()
}

/// Distance (m) from point p to segment a–b, in a local plane around p (fine below ~100 km).
fn seg_dist_m(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let k = R * std::f64::consts::PI / 180.0;
    let kx = k * p[1].to_radians().cos();
    let (ax, ay) = ((a[0] - p[0]) * kx, (a[1] - p[1]) * k);
    let (bx, by) = ((b[0] - p[0]) * kx, (b[1] - p[1]) * k);
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    ((ax + t * dx).powi(2) + (ay + t * dy).powi(2)).sqrt()
}

/// Even–odd point in polygon (all rings: holes subtract).
pub fn point_in_polys(p: [f64; 2], polys: &[Vec<Vec<[f64; 2]>>]) -> bool {
    polys.iter().any(|poly| {
        let mut inside = false;
        for ring in poly {
            let n = ring.len();
            if n < 3 {
                continue;
            }
            let mut j = n - 1;
            for i in 0..n {
                let (a, b) = (ring[i], ring[j]);
                if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                    inside = !inside;
                }
                j = i;
            }
        }
        inside
    })
}

fn bbox_of(g: &Geom) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    features::each_coord(g, &mut |c| {
        b = Some(match b {
            None => [c[0], c[1], c[0], c[1]],
            Some(x) => [x[0].min(c[0]), x[1].min(c[1]), x[2].max(c[0]), x[3].max(c[1])],
        });
    });
    b
}

fn in_box(p: [f64; 2], b: [f64; 4]) -> bool {
    p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]
}

fn boxes_meet(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

fn points_of(g: &Geom) -> Vec<[f64; 2]> {
    match g {
        Geom::Points(p) => p.clone(),
        _ => features::anchor(g).into_iter().collect(),
    }
}

fn to_ogr(g: &Geom) -> Option<Geometry> {
    let v = match g {
        Geom::Polygons(p) => json!({ "type": "MultiPolygon", "coordinates": p }),
        Geom::Lines(l) => json!({ "type": "MultiLineString", "coordinates": l }),
        Geom::Points(p) => json!({ "type": "MultiPoint", "coordinates": p }),
        Geom::Empty => return None,
    };
    Geometry::from_geojson(&v.to_string()).ok()
}

/// Geodesic length (m) of every line in a GeoJSON geometry.
fn length_m(v: &Value) -> f64 {
    fn walk(c: &Value, depth: usize) -> f64 {
        let Some(a) = c.as_array() else { return 0.0 };
        if depth == 0 {
            let pts: Vec<[f64; 2]> = a.iter().filter_map(|p| Some([p[0].as_f64()?, p[1].as_f64()?])).collect();
            return pts.windows(2).map(|w| hav(w[0], w[1])).sum();
        }
        a.iter().map(|x| walk(x, depth - 1)).sum()
    }
    match v["type"].as_str() {
        Some("LineString") => walk(&v["coordinates"], 0),
        Some("MultiLineString") => walk(&v["coordinates"], 1),
        Some("GeometryCollection") => v["geometries"].as_array().map(|g| g.iter().map(length_m).sum()).unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Geodesic area (m²) of every polygon in a GeoJSON geometry.
fn area_m2(v: &Value) -> f64 {
    let ring = |r: &Value| -> Vec<[f64; 2]> { r.as_array().map(|a| a.iter().filter_map(|p| Some([p[0].as_f64()?, p[1].as_f64()?])).collect()).unwrap_or_default() };
    let poly = |p: &Value| -> f64 { p.as_array().map(|rs| rs.iter().enumerate().map(|(i, r)| if i == 0 { crate::edit::ring_area_m2(&ring(r)) } else { -crate::edit::ring_area_m2(&ring(r)) }).sum()).unwrap_or(0.0) };
    match v["type"].as_str() {
        Some("Polygon") => poly(&v["coordinates"]),
        Some("MultiPolygon") => v["coordinates"].as_array().map(|a| a.iter().map(poly).sum()).unwrap_or(0.0),
        Some("GeometryCollection") => v["geometries"].as_array().map(|g| g.iter().map(area_m2).sum()).unwrap_or(0.0),
        _ => 0.0,
    }
}

fn as_json(g: &Geometry) -> Value {
    g.json().ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// A short field-name stem for the other layer (`n_clinics`, `len_m_roads`).
fn stem(name: &str) -> String {
    // "wells.geojson" → "wells": the file name without extensions
    let base = name.split('.').next().unwrap_or(name);
    let s: String = sanitize(base).to_lowercase().chars().take(16).collect();
    if s.is_empty() { "layer".into() } else { s }
}

/// What the combination will do, in words, for a pair of geometry kinds (also used by the UI).
pub fn method(target: GeomKind, other: GeomKind) -> Option<&'static str> {
    use GeomKind::*;
    Some(match (target, other) {
        (Polygon, Point) => "count",
        (Polygon, Line) => "length",
        (Polygon, Polygon) => "overlap",
        (Point, Polygon) => "within",
        (Point, Point) | (Line, Point) => "nearest",
        _ => return None,
    })
}

pub(super) fn layers_combine(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t = sc.layer(p_str(p, "layer").ok_or("layer is required (the layer that gets the new fields)")?)?;
    let o = sc.layer(p_str(p, "other").ok_or("other is required (the layer to combine with)")?)?;
    let how = match p_str(p, "how").filter(|h| *h != "auto") {
        Some(h) => h.to_string(),
        None => method(t.info.geometry, o.info.geometry)
            .ok_or_else(|| format!("no combination for {:?} with {:?}: try the other layer first", t.info.geometry, o.info.geometry))?
            .to_string(),
    };
    let mut fs = features::read_layer(sc.engine, &t, None, None, 300_000)?;
    let other = features::read_layer(sc.engine, &o, None, None, 300_000)?;
    let st = stem(&o.info.name);
    let field = p_str(p, "field").filter(|f| !f.is_empty() && *f != "auto").map(str::to_string);
    let fi = field.as_ref().and_then(|f| other.field(f));
    let obox: Vec<Option<[f64; 4]>> = other.feats.iter().map(|f| bbox_of(&f.geom)).collect();
    let mut why = Vec::new();
    let add_field = |fs: &mut FeatureSet, name: String, kind: &'static str| -> String {
        let mut n = name;
        while fs.field(&n).is_some() {
            n.push('_');
        }
        fs.fields.push((n.clone(), kind));
        n
    };
    match how.as_str() {
        "count" => {
            add_field(&mut fs, format!("n_{st}"), "integer");
            let (sf, mf) = if fi.is_some() {
                let f = field.clone().unwrap();
                (Some(add_field(&mut fs, format!("sum_{}", stem(&f)), "real")), Some(add_field(&mut fs, format!("mean_{}", stem(&f)), "real")))
            } else {
                (None, None)
            };
            let pts: Vec<([f64; 2], Option<f64>)> = other.feats.iter().flat_map(|f| {
                let v = fi.and_then(|i| f.props[i].as_f64());
                points_of(&f.geom).into_iter().map(move |p| (p, v))
            }).collect();
            let mut total = 0usize;
            for f in fs.feats.iter_mut() {
                let (mut n, mut sum, mut cnt) = (0i64, 0.0, 0usize);
                if let (Geom::Polygons(polys), Some(b)) = (&f.geom, bbox_of(&f.geom)) {
                    for (pt, v) in &pts {
                        if in_box(*pt, b) && point_in_polys(*pt, polys) {
                            n += 1;
                            if let Some(x) = v {
                                sum += x;
                                cnt += 1;
                            }
                        }
                    }
                }
                total += n as usize;
                f.props.push(Val::Int(n));
                if sf.is_some() {
                    f.props.push(if cnt > 0 { Val::Num(r2(sum)) } else { Val::Null });
                    f.props.push(if cnt > 0 { Val::Num(r2(sum / cnt as f64)) } else { Val::Null });
                }
            }
            let _ = mf;
            why.push(format!("{total} of {} points of {} fall inside the {} areas", pts.len(), sc.title_of(&o), fs.feats.len()));
        }
        "within" => {
            let name_i = other.fields.iter().position(|(_, k)| *k == "string");
            let wf = add_field(&mut fs, format!("in_{st}"), "string");
            let _ = wf;
            let mut hit = 0;
            for f in fs.feats.iter_mut() {
                let p = features::anchor(&f.geom);
                let found = p.and_then(|p| other.feats.iter().enumerate().find(|(j, g)| obox[*j].is_some_and(|b| in_box(p, b)) && matches!(&g.geom, Geom::Polygons(ps) if point_in_polys(p, ps))));
                f.props.push(match found {
                    Some((j, g)) => {
                        hit += 1;
                        Val::Str(name_i.map(|i| g.props[i].text()).filter(|s| !s.is_empty()).unwrap_or_else(|| (j + 1).to_string()))
                    }
                    None => Val::Null,
                });
            }
            why.push(format!("{hit} of {} features lie inside an area of {}", fs.feats.len(), sc.title_of(&o)));
        }
        "length" | "overlap" => {
            let og: Vec<Option<Geometry>> = other.feats.iter().map(|f| to_ogr(&f.geom)).collect();
            let (f1, f2) = if how == "length" {
                (add_field(&mut fs, format!("len_m_{st}"), "real"), None)
            } else {
                (add_field(&mut fs, format!("ovl_m2_{st}"), "real"), Some(add_field(&mut fs, format!("ovl_pct_{st}"), "real")))
            };
            let _ = f1;
            let mut grand = 0.0;
            for f in fs.feats.iter_mut() {
                let (Some(b), Some(g)) = (bbox_of(&f.geom), to_ogr(&f.geom)) else {
                    f.props.push(Val::Null);
                    if f2.is_some() {
                        f.props.push(Val::Null);
                    }
                    continue;
                };
                let mut acc = 0.0;
                for (j, x) in og.iter().enumerate() {
                    let (Some(x), Some(ob)) = (x, obox[j]) else { continue };
                    if !boxes_meet(b, ob) || !g.intersects(x) {
                        continue;
                    }
                    if let Some(cut) = g.intersection(x) {
                        let v = as_json(&cut);
                        acc += if how == "length" { length_m(&v) } else { area_m2(&v) };
                    }
                }
                grand += acc;
                f.props.push(Val::Num(r2(acc)));
                if f2.is_some() {
                    let own = area_m2(&as_json(&g));
                    f.props.push(if own > 0.0 { Val::Num(r2((100.0 * acc / own).min(100.0))) } else { Val::Null });
                }
            }
            why.push(if how == "length" {
                format!("{:.1} km of {} inside the {} areas", grand / 1000.0, sc.title_of(&o), fs.feats.len())
            } else {
                format!("{:.1} ha of overlap with {}", grand / 10_000.0, sc.title_of(&o))
            });
        }
        "nearest" => {
            let nf = add_field(&mut fs, format!("near_m_{st}"), "real");
            let _ = nf;
            let targets: Vec<[f64; 2]> = other.feats.iter().flat_map(|f| points_of(&f.geom)).collect();
            if targets.is_empty() {
                return Err(format!("{} has no points to measure to", sc.title_of(&o)));
            }
            let mut ds = Vec::new();
            for f in fs.feats.iter_mut() {
                // distance from each target point to the feature: its segments for lines (the nearest
                // point along them, not just a vertex), its points otherwise
                let d = match &f.geom {
                    Geom::Lines(ls) => targets.iter().map(|t| ls.iter().flat_map(|l| l.windows(2).map(|w| seg_dist_m(*t, w[0], w[1]))).fold(f64::INFINITY, f64::min)).fold(f64::INFINITY, f64::min),
                    g => {
                        let mut verts = Vec::new();
                        features::each_coord(g, &mut |c| verts.push(*c));
                        verts.iter().flat_map(|v| targets.iter().map(move |t| hav(*v, *t))).fold(f64::INFINITY, f64::min)
                    }
                };
                if d.is_finite() {
                    ds.push(d);
                    f.props.push(Val::Num(r2(d)));
                } else {
                    f.props.push(Val::Null);
                }
            }
            ds.sort_by(|a, b| a.total_cmp(b));
            if let Some(m) = ds.get(ds.len() / 2) {
                why.push(format!("median distance to the nearest of {}: {:.0} m", sc.title_of(&o), m));
            }
        }
        other_how => return Err(format!("unknown combination '{other_how}' (count, within, length, overlap, nearest)")),
    }
    let name = p_str(p, "name").map(str::to_string).unwrap_or_else(|| format!("{}_with_{}", t.info.name, stem(&o.info.name)));
    let title = format!("{} + {}", sc.title_of(&t), sc.title_of(&o));
    let id = sc.write_output(&name, &fs, title)?;
    sc.methods.push(format!("{} was combined with {} ({how}).", sc.title_of(&t), sc.title_of(&o)));
    let _: Vec<Feat> = Vec::new();
    Ok(StepOut { outputs: json!({ "layer": id, "how": how }), why })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_in_polygon_with_a_hole() {
        let poly = vec![vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]], vec![[4.0, 4.0], [6.0, 4.0], [6.0, 6.0], [4.0, 6.0], [4.0, 4.0]]]];
        assert!(point_in_polys([1.0, 1.0], &poly));
        assert!(!point_in_polys([5.0, 5.0], &poly), "inside the hole");
        assert!(!point_in_polys([11.0, 5.0], &poly));
    }

    #[test]
    fn methods_by_geometry() {
        use GeomKind::*;
        assert_eq!(method(Polygon, Point), Some("count"));
        assert_eq!(method(Polygon, Line), Some("length"));
        assert_eq!(method(Point, Polygon), Some("within"));
        assert_eq!(method(Line, Point), Some("nearest"));
        assert_eq!(method(Line, Line), None);
    }
}
