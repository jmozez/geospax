//! raster.zonal (exact zonal statistics) and vector.topology (overlaps, gaps and invalid polygons).
//!
//! **Exact zonal statistics.** Most zonal tools count a cell as in or out of a polygon by its centre,
//! which is wrong for small or thin polygons (a 1-cell-wide riparian strip can get no cells at all).
//! Here every cell is weighted by the fraction of it the polygon covers, computed exactly: each ring
//! is clipped to the cell's square (Sutherland–Hodgman against a convex box keeps the signed area
//! exact, holes subtract), as exactextract does (Baston 2022; GDAL 3.12 `gdal raster zonal-stats`).
//! Coverage is computed in the raster's own grid, so the polygon is first projected to its CRS.
//!
//! **Topology.** A polygon layer meant to tile an area (parcels, land cover, admin units) is checked
//! for invalid geometries, overlaps between features and gaps between them (holes of the union that
//! are not holes of any feature, up to `max_gap` m²). Each error becomes a feature of a new layer,
//! with the feature ids it involves and its area, ready to fix with the Edit tools.

use super::features::{self, Feat, FeatureSet, Val};
use super::steps::{p_str, sanitize, StepCtx, StepOut};
use crate::raster;
use crate::wkb::Geom;
use gdal::spatial_ref::CoordTransform;
use gdal::vector::Geometry;
use serde_json::{json, Value};

/// Signed area of a ring (shoelace), positive counter-clockwise.
fn signed_area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    if n < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    for i in 0..n {
        let (p, q) = (r[i], r[(i + 1) % n]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

/// Clip a ring to x0 ≤ x ≤ x1, y0 ≤ y ≤ y1 (Sutherland–Hodgman; the box is convex, so the clipped
/// ring's signed area is exactly the area of the ring's interior inside the box).
fn clip_ring(ring: &[[f64; 2]], x0: f64, x1: f64, y0: f64, y1: f64) -> Vec<[f64; 2]> {
    let mut pts: Vec<[f64; 2]> = ring.to_vec();
    if pts.len() > 1 && pts[0] == pts[pts.len() - 1] {
        pts.pop();
    }
    // edge k: 0 left (x ≥ x0), 1 right (x ≤ x1), 2 bottom (y ≥ y0), 3 top (y ≤ y1)
    for k in 0..4 {
        if pts.is_empty() {
            break;
        }
        let inside = |p: &[f64; 2]| match k {
            0 => p[0] >= x0,
            1 => p[0] <= x1,
            2 => p[1] >= y0,
            _ => p[1] <= y1,
        };
        let cross = |a: &[f64; 2], b: &[f64; 2]| -> [f64; 2] {
            match k {
                0 | 1 => {
                    let x = if k == 0 { x0 } else { x1 };
                    let t = (x - a[0]) / (b[0] - a[0]);
                    [x, a[1] + t * (b[1] - a[1])]
                }
                _ => {
                    let y = if k == 2 { y0 } else { y1 };
                    let t = (y - a[1]) / (b[1] - a[1]);
                    [a[0] + t * (b[0] - a[0]), y]
                }
            }
        };
        let mut out = Vec::with_capacity(pts.len() + 4);
        for i in 0..pts.len() {
            let cur = pts[i];
            let prev = pts[(i + pts.len() - 1) % pts.len()];
            let (ci, pi) = (inside(&cur), inside(&prev));
            if ci {
                if !pi {
                    out.push(cross(&prev, &cur));
                }
                out.push(cur);
            } else if pi {
                out.push(cross(&prev, &cur));
            }
        }
        pts = out;
    }
    pts
}

/// Covered fraction (0–1) of every cell a polygon touches, in pixel coordinates (rings already in
/// column/row units). Returns (col, row, fraction) for fractions above 1e-9.
pub fn coverage(rings: &[Vec<[f64; 2]>], cols: usize, rows: usize) -> Vec<(usize, usize, f64)> {
    let mut out = Vec::new();
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for r in rings {
        for p in r {
            minx = minx.min(p[0]);
            miny = miny.min(p[1]);
            maxx = maxx.max(p[0]);
            maxy = maxy.max(p[1]);
        }
    }
    if minx > maxx {
        return out;
    }
    let c0 = minx.floor().max(0.0) as usize;
    let r0 = miny.floor().max(0.0) as usize;
    let c1 = (maxx.ceil() as i64).clamp(0, cols as i64) as usize;
    let r1 = (maxy.ceil() as i64).clamp(0, rows as i64) as usize;
    for row in r0..r1 {
        let (y0, y1) = (row as f64, row as f64 + 1.0);
        // clip once to the row strip, then each cell of it
        let strips: Vec<Vec<[f64; 2]>> = rings.iter().map(|r| clip_ring(r, f64::MIN, f64::MAX, y0, y1)).filter(|r| r.len() >= 3).collect();
        if strips.is_empty() {
            continue;
        }
        for col in c0..c1 {
            let (x0, x1) = (col as f64, col as f64 + 1.0);
            let a: f64 = strips.iter().map(|r| signed_area(&clip_ring(r, x0, x1, y0, y1))).sum::<f64>();
            let f = a.abs().min(1.0);
            if f > 1e-9 {
                out.push((col, row, f));
            }
        }
    }
    out
}

/// Weighted statistics of one zone.
#[derive(Default, Debug, Clone)]
pub struct Zone {
    pub cover: f64,
    pub sum: f64,
    pub sumsq: f64,
    pub min: f64,
    pub max: f64,
    pub values: Vec<(f64, f64)>,
}

impl Zone {
    fn add(&mut self, v: f64, w: f64) {
        if self.cover == 0.0 {
            self.min = v;
            self.max = v;
        }
        self.cover += w;
        self.sum += v * w;
        self.sumsq += v * v * w;
        self.min = self.min.min(v);
        self.max = self.max.max(v);
        self.values.push((v, w));
    }
    pub fn mean(&self) -> Option<f64> {
        (self.cover > 0.0).then(|| self.sum / self.cover)
    }
    fn stdev(&self) -> Option<f64> {
        let m = self.mean()?;
        Some((self.sumsq / self.cover - m * m).max(0.0).sqrt())
    }
    /// The value covering the largest area (categorical rasters).
    fn majority(&self) -> Option<f64> {
        let mut by: Vec<(f64, f64)> = Vec::new();
        for &(v, w) in &self.values {
            match by.iter_mut().find(|(x, _)| *x == v) {
                Some(e) => e.1 += w,
                None => by.push((v, w)),
            }
        }
        by.into_iter().max_by(|a, b| a.1.total_cmp(&b.1)).map(|x| x.0)
    }
    fn median(&self) -> Option<f64> {
        if self.values.is_empty() {
            return None;
        }
        let mut v = self.values.clone();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        let half = self.cover / 2.0;
        let mut acc = 0.0;
        for (x, w) in v {
            acc += w;
            if acc >= half {
                return Some(x);
            }
        }
        None
    }
}

/// A number parameter given as a number or as text (forms send text).
fn num(p: &Value, k: &str) -> Option<f64> {
    match p.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

pub(super) fn raster_zonal(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let layer_id = p_str(p, "layer").ok_or("layer is required (the polygon zones)")?.to_string();
    let l = sc.layer(&layer_id)?;
    let mut fs = features::read_layer(sc.engine, &l, None, None, 500_000)?;
    if !fs.feats.iter().any(|f| matches!(f.geom, Geom::Polygons(_))) {
        return Err("zonal statistics need a polygon layer for the zones".into());
    }
    let r = super::raster_steps::pick_raster(sc, p.get("raster"), &[], &["hillshade", "rgb"])?;
    let band = num(p, "band").unwrap_or(1.0).max(1.0) as usize;
    let ds = raster::open(&r.info.path)?;
    let (cols, rows) = ds.raster_size();
    let gt = ds.geo_transform().map_err(|e| e.to_string())?;
    if gt[2] != 0.0 || gt[4] != 0.0 {
        return Err("rotated rasters are not supported: warp it to a north-up grid first".into());
    }
    let srs = raster::srs_of(&ds).ok_or("the raster has no coordinate system")?;
    let ct = CoordTransform::new(&raster::wgs84(), &srs).map_err(|e| e.to_string())?;
    let rb = ds.rasterband(band).map_err(|e| e.to_string())?;
    let nodata = rb.no_data_value().or(r.info.nodata);
    let cell_area = (gt[1] * gt[5]).abs();
    let geographic = srs.is_geographic();
    let wanted: Vec<String> = match p.get("stats") {
        Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_lowercase()).filter(|x| !x.is_empty()).collect(),
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_lowercase).collect(),
        _ => ["mean", "min", "max", "sum", "count"].iter().map(|s| s.to_string()).collect(),
    };
    for s in &wanted {
        if !["mean", "min", "max", "sum", "count", "stdev", "median", "majority", "area"].contains(&s.as_str()) {
            return Err(format!("unknown statistic '{s}' (mean, min, max, sum, count, stdev, median, majority, area)"));
        }
    }
    let prefix = sanitize(p_str(p, "prefix").unwrap_or(""));
    let fname = |s: &str| if prefix.is_empty() { format!("z_{s}") } else { format!("{prefix}_{s}") };
    let first_field = fs.fields.len();
    for s in &wanted {
        let mut n = fname(s);
        while fs.field(&n).is_some() {
            n.push('_');
        }
        fs.fields.push((n, if *s == "count" || *s == "area" { "real" } else if *s == "majority" { "real" } else { "real" }));
    }
    let mut empty = 0usize;
    let mut means = Vec::new();
    for f in fs.feats.iter_mut() {
        let mut zone = Zone::default();
        if let Geom::Polygons(polys) = &f.geom {
            // project every ring to the raster grid (pixel units)
            let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
            for poly in polys {
                for ring in poly {
                    let mut xs: Vec<f64> = ring.iter().map(|c| c[0]).collect();
                    let mut ys: Vec<f64> = ring.iter().map(|c| c[1]).collect();
                    let mut zs = vec![0.0; xs.len()];
                    if ct.transform_coords(&mut xs, &mut ys, &mut zs).is_err() {
                        continue;
                    }
                    let mut px: Vec<[f64; 2]> = xs.iter().zip(&ys).map(|(x, y)| [(x - gt[0]) / gt[1], (y - gt[3]) / gt[5]]).collect();
                    // keep the orientation of each ring as given: holes are oriented opposite to shells
                    // in valid data; normalise so shells count positive and holes negative
                    let is_shell = std::ptr::eq(ring, &poly[0]);
                    let a = signed_area(&px);
                    if (is_shell && a < 0.0) || (!is_shell && a > 0.0) {
                        px.reverse();
                    }
                    rings.push(px);
                }
            }
            let cov = coverage(&rings, cols, rows);
            if let (Some(c0), Some(r0)) = (cov.iter().map(|c| c.0).min(), cov.iter().map(|c| c.1).min()) {
                let c1 = cov.iter().map(|c| c.0).max().unwrap();
                let r1 = cov.iter().map(|c| c.1).max().unwrap();
                let (w, h) = (c1 - c0 + 1, r1 - r0 + 1);
                let buf = rb.read_as::<f64>((c0 as isize, r0 as isize), (w, h), (w, h), None).map_err(|e| e.to_string())?;
                let data = buf.data();
                for (c, rr, frac) in cov {
                    let v = data[(rr - r0) * w + (c - c0)];
                    if !v.is_finite() || nodata.is_some_and(|n| (v - n).abs() < 1e-9) {
                        continue;
                    }
                    // each covered part of a cell, signed: a hole's shell part was already subtracted
                    zone.add(v, frac);
                }
            }
        }
        if zone.cover == 0.0 {
            empty += 1;
        } else if let Some(m) = zone.mean() {
            means.push(m);
        }
        for s in &wanted {
            let v = match s.as_str() {
                "mean" => zone.mean(),
                "min" => (zone.cover > 0.0).then_some(zone.min),
                "max" => (zone.cover > 0.0).then_some(zone.max),
                "sum" => (zone.cover > 0.0).then_some(zone.sum),
                "count" => Some(zone.cover),
                "stdev" => zone.stdev(),
                "median" => zone.median(),
                "majority" => zone.majority(),
                "area" => Some(if geographic { f64::NAN } else { zone.cover * cell_area }),
                _ => None,
            };
            f.props.push(match v {
                Some(x) if x.is_finite() => Val::Num(round4(x)),
                _ => Val::Null,
            });
        }
    }
    let _ = first_field;
    let name = p_str(p, "name").map(str::to_string).unwrap_or_else(|| format!("{}_zonal", l.info.name));
    let title = format!("{} · zonal statistics of {}", sc.title_of(&l), r.info.title);
    let id = sc.write_output(&name, &fs, title)?;
    let mut why = vec![format!(
        "{} zones × {} ({}): {} with no cells under them",
        fs.feats.len(),
        r.info.title,
        wanted.join(", "),
        empty
    )];
    if !means.is_empty() {
        let lo = means.iter().cloned().fold(f64::MAX, f64::min);
        let hi = means.iter().cloned().fold(f64::MIN, f64::max);
        why.push(format!("zone means range {} to {}", round4(lo), round4(hi)));
    }
    sc.methods.push(format!(
        "Zonal statistics of {} over the {} zones of {} were computed with exact cell coverage: each cell is weighted by the fraction of it inside the zone (as exactextract), not by whether its centre falls inside.",
        r.info.title,
        fs.feats.len(),
        sc.title_of(&l)
    ));
    Ok(StepOut { outputs: json!({ "layer": id, "zones": fs.feats.len(), "empty": empty, "stats": wanted }), why })
}

// ------------------------------------------------------------------ topology

fn to_ogr(g: &Geom) -> Option<Geometry> {
    let Geom::Polygons(ps) = g else { return None };
    let v = json!({ "type": "MultiPolygon", "coordinates": ps });
    Geometry::from_geojson(&v.to_string()).ok()
}

fn ogr_rings(g: &Geometry) -> Vec<Vec<Vec<[f64; 2]>>> {
    let v: Value = g.json().ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    json_rings(&v)
}

fn json_rings(v: &Value) -> Vec<Vec<Vec<[f64; 2]>>> {
    let ring = |r: &Value| -> Vec<[f64; 2]> { r.as_array().map(|a| a.iter().filter_map(|c| Some([c[0].as_f64()?, c[1].as_f64()?])).collect()).unwrap_or_default() };
    let poly = |p: &Value| -> Vec<Vec<[f64; 2]>> { p.as_array().map(|a| a.iter().map(ring).collect()).unwrap_or_default() };
    match v["type"].as_str() {
        Some("Polygon") => vec![poly(&v["coordinates"])],
        Some("MultiPolygon") => v["coordinates"].as_array().map(|a| a.iter().map(poly).collect()).unwrap_or_default(),
        Some("GeometryCollection") => v["geometries"]
            .as_array()
            .map(|gs| {
                gs.iter()
                    .flat_map(|g| match g["type"].as_str() {
                        Some("Polygon") => vec![poly(&g["coordinates"])],
                        Some("MultiPolygon") => g["coordinates"].as_array().map(|a| a.iter().map(poly).collect()).unwrap_or_default(),
                        _ => vec![],
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// Geodesic area in m² of polygons given in lon/lat (spherical, as Calculate geometry).
fn area_m2(polys: &[Vec<Vec<[f64; 2]>>]) -> f64 {
    polys.iter().map(|p| p.iter().enumerate().map(|(i, r)| if i == 0 { crate::edit::ring_area_m2(r) } else { -crate::edit::ring_area_m2(r) }).sum::<f64>()).sum()
}

fn bbox(g: &Geom) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    if let Geom::Polygons(ps) = g {
        for p in ps.iter().flatten().flatten() {
            b = Some(match b {
                None => [p[0], p[1], p[0], p[1]],
                Some(x) => [x[0].min(p[0]), x[1].min(p[1]), x[2].max(p[0]), x[3].max(p[1])],
            });
        }
    }
    b
}

pub(super) fn vector_topology(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let layer_id = p_str(p, "layer").ok_or("layer is required (a polygon layer)")?.to_string();
    let l = sc.layer(&layer_id)?;
    let fs = features::read_layer(sc.engine, &l, None, None, 200_000)?;
    let fid_i = fs.field("fid");
    let _ = &fid_i;
    let max_gap = num(p, "max_gap").unwrap_or(f64::INFINITY);
    let min_area = num(p, "min_area").unwrap_or(0.01);
    let feats: Vec<(usize, Geometry, [f64; 4])> = fs
        .feats
        .iter()
        .enumerate()
        .filter_map(|(i, f)| Some((i, to_ogr(&f.geom)?, bbox(&f.geom)?)))
        .collect();
    if feats.is_empty() {
        return Err("no polygons to check in this layer".into());
    }
    let id_of = |i: usize| -> String {
        fid_i.and_then(|k| match &fs.feats[i].props[k] {
            Val::Int(x) => Some(x.to_string()),
            _ => None,
        }).unwrap_or_else(|| (i + 1).to_string())
    };
    let mut out = FeatureSet::new(fs.kind, vec![("error".into(), "string"), ("features".into(), "string"), ("area_m2".into(), "real"), ("detail".into(), "string")]);
    let mut push = |kind: &str, ids: String, polys: Vec<Vec<Vec<[f64; 2]>>>, detail: String| {
        let a = area_m2(&polys);
        out.feats.push(Feat { geom: Geom::Polygons(polys), props: vec![Val::Str(kind.into()), Val::Str(ids), Val::Num((a * 100.0).round() / 100.0), Val::Str(detail)] });
    };
    // 1. invalid geometries (self-intersections, bad rings)
    let mut invalid = 0;
    for (i, g, _) in &feats {
        if !g.is_valid() {
            invalid += 1;
            push("invalid geometry", id_of(*i), ogr_rings(g), "self-intersection or a ring that is not closed".into());
        }
    }
    // 2. overlaps: pairs whose bounding boxes meet, sorted by min x (sweep)
    let mut order: Vec<usize> = (0..feats.len()).collect();
    order.sort_by(|a, b| feats[*a].2[0].total_cmp(&feats[*b].2[0]));
    let mut overlaps = 0;
    for (k, &a) in order.iter().enumerate() {
        for &b in &order[k + 1..] {
            if feats[b].2[0] > feats[a].2[2] {
                break;
            }
            let (ba, bb) = (feats[a].2, feats[b].2);
            if bb[1] > ba[3] || bb[3] < ba[1] {
                continue;
            }
            let (ga, gb) = (&feats[a].1, &feats[b].1);
            if !ga.is_valid() || !gb.is_valid() || !ga.intersects(gb) {
                continue;
            }
            if let Some(x) = ga.intersection(gb) {
                let polys = ogr_rings(&x);
                let area = area_m2(&polys);
                if area > min_area {
                    overlaps += 1;
                    push("overlap", format!("{} & {}", id_of(feats[a].0), id_of(feats[b].0)), polys, format!("{:.1} m² claimed by both", area));
                }
            }
        }
    }
    // 3. gaps: holes of the union of all features that are not holes of a single feature
    let mut gaps = 0;
    let mut coll = Geometry::empty(gdal::vector::OGRwkbGeometryType::wkbMultiPolygon).map_err(|e| e.to_string())?;
    for (_, g, _) in &feats {
        if !g.is_valid() {
            continue;
        }
        // a multipolygon takes polygons, one per part
        for poly in ogr_rings(g) {
            if let Ok(pg) = Geometry::from_geojson(&json!({ "type": "Polygon", "coordinates": poly }).to_string()) {
                let _ = coll.add_geometry(pg);
            }
        }
    }
    // SAFETY: coll is a valid multipolygon; OGR_G_UnionCascaded (GDAL 3.6 has no UnaryUnion) returns a new geometry that we read as
    // GeoJSON and then destroy; the JSON string is freed with CPLFree.
    let union: Option<Value> = unsafe {
        let h = gdal_sys::OGR_G_UnionCascaded(coll.c_geometry());
        if h.is_null() {
            None
        } else {
            let s = gdal_sys::OGR_G_ExportToJson(h);
            let v = (!s.is_null()).then(|| std::ffi::CStr::from_ptr(s).to_string_lossy().to_string());
            if !s.is_null() {
                gdal_sys::VSIFree(s as *mut std::ffi::c_void);
            }
            gdal_sys::OGR_G_DestroyGeometry(h);
            v.and_then(|t| serde_json::from_str(&t).ok())
        }
    };
    if let Some(u) = union {
        let own_holes: Vec<Vec<[f64; 2]>> = fs.feats.iter().flat_map(|f| match &f.geom {
            Geom::Polygons(ps) => ps.iter().flat_map(|p| p.iter().skip(1).cloned()).collect::<Vec<_>>(),
            _ => vec![],
        }).collect();
        for poly in json_rings(&u) {
            for hole in poly.iter().skip(1) {
                let a = crate::edit::ring_area_m2(hole);
                let same_as_own = own_holes.iter().any(|h| h.len() == hole.len() && (crate::edit::ring_area_m2(h) - a).abs() < 1e-6);
                if a > min_area && a <= max_gap && !same_as_own {
                    gaps += 1;
                    push("gap", String::new(), vec![vec![hole.clone()]], format!("{a:.1} m² between features"));
                }
            }
        }
    }
    let name = p_str(p, "name").map(str::to_string).unwrap_or_else(|| format!("{}_topology_errors", l.info.name));
    let total = out.feats.len();
    let why = vec![format!("{} features checked: {invalid} invalid, {overlaps} overlaps, {gaps} gaps", feats.len())];
    if total == 0 {
        return Ok(StepOut { outputs: json!({ "layer": Value::Null, "invalid": 0, "overlaps": 0, "gaps": 0, "clean": true }), why });
    }
    let title = format!("{} · topology errors", sc.title_of(&l));
    let id = sc.write_output(&name, &out, title)?;
    sc.methods.push(format!("Topology of {} was checked for invalid polygons, overlaps between features and gaps between them (holes of their union).", sc.title_of(&l)));
    Ok(StepOut { outputs: json!({ "layer": id, "invalid": invalid, "overlaps": overlaps, "gaps": gaps, "clean": false }), why })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_coverage_of_a_half_cell_triangle_and_a_square_with_a_hole() {
        // triangle covering exactly half of cell (0,0)
        let tri = vec![vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [0.0, 0.0]]];
        let c = coverage(&tri, 10, 10);
        assert_eq!(c.len(), 1);
        assert!((c[0].2 - 0.5).abs() < 1e-12);
        // 2.5 × 2.5 square from (0.25, 0.25): corner cells covered 0.75² etc., total 6.25
        let sq = vec![vec![[0.25, 0.25], [2.75, 0.25], [2.75, 2.75], [0.25, 2.75], [0.25, 0.25]]];
        let c = coverage(&sq, 10, 10);
        let total: f64 = c.iter().map(|x| x.2).sum();
        assert!((total - 6.25).abs() < 1e-9, "{total}");
        let corner = c.iter().find(|x| x.0 == 0 && x.1 == 0).unwrap().2;
        assert!((corner - 0.5625).abs() < 1e-12);
        // with a 1 × 1 hole in the middle (clockwise when the shell is counter-clockwise): 6.25 − 1
        let hole = vec![[1.0, 1.0], [1.0, 2.0], [2.0, 2.0], [2.0, 1.0], [1.0, 1.0]];
        let c = coverage(&[sq[0].clone(), hole], 10, 10);
        let total: f64 = c.iter().map(|x| x.2).sum();
        assert!((total - 5.25).abs() < 1e-9, "{total}");
        assert!(c.iter().all(|x| !(x.0 == 1 && x.1 == 1)), "the hole's cell has no coverage");
    }

    #[test]
    fn thin_strip_gets_its_share_where_cell_centres_miss_it() {
        // a strip 0.2 cells wide along row 3, between cell centres: centre-based methods give 0 cells
        let strip = vec![vec![[0.0, 3.0], [5.0, 3.0], [5.0, 3.2], [0.0, 3.2], [0.0, 3.0]]];
        let c = coverage(&strip, 10, 10);
        assert_eq!(c.len(), 5);
        assert!(c.iter().all(|x| (x.2 - 0.2).abs() < 1e-12));
    }

    #[test]
    fn weighted_stats() {
        let mut z = Zone::default();
        z.add(10.0, 1.0);
        z.add(20.0, 0.5);
        z.add(30.0, 0.5);
        assert!((z.mean().unwrap() - 17.5).abs() < 1e-12);
        assert_eq!(z.majority(), Some(10.0));
        assert_eq!(z.median(), Some(10.0));
        assert!((z.cover - 2.0).abs() < 1e-12);
    }
}
