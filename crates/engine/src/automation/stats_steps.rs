//! Spatial statistics steps (docs/AUTOMATION.md §6e), native so they run on every OS without R or
//! Python:
//!
//! * `stats.hotspots`: Getis-Ord Gi* hot and cold spots. Incidents are counted in auto-sized
//!   hexagons, the distance band comes from an incremental spatial autocorrelation search, and
//!   significance is corrected with the false discovery rate (the behaviour ArcGIS documents
//!   for Optimized Hot Spot Analysis).
//! * `interpolate.auto`: an empirical variogram fitted with three models, ordinary kriging with
//!   the best one, and IDW. Both are cross-validated and the lower error wins; kriging also maps
//!   its standard error, so the reader can see where the surface is a guess.

use super::automap;
use super::cartography::fmt_num;
use super::charts::{self, Chart, Kind, Series};
use super::features::{self, Feat, FeatureSet, Val};
use super::raster_steps::{out_path, register};
use super::steps::{auto_layer, convex_hull, hex_center, hex_of, idw_at, idw_cv, p_f64, p_str, point_in_ring, sanitize, StepCtx, StepOut};
use crate::catalog::{GeomKind, LayerHandle};
use crate::geostats::{self, Index, Kriging, Model, Neighbours, Vgm, P2};
use crate::raster;
use crate::wkb::Geom;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

const SQRT3: f64 = 1.732_050_807_568_877_2;
const NODATA: f64 = -9999.0;

/// Hot/cold classes: Gi_Bin, label and the conventional diverging colours.
pub const CLASSES: [(i8, &str, &str); 7] = [
    (3, "Hot spot · 99 % sure", "#d62f27"),
    (2, "Hot spot · 95 % sure", "#ed7551"),
    (1, "Hot spot · 90 % sure", "#fab984"),
    (0, "Not significant", "#d3d3cc"),
    (-1, "Cold spot · 90 % sure", "#c0ccbe"),
    (-2, "Cold spot · 95 % sure", "#849eba"),
    (-3, "Cold spot · 99 % sure", "#4575b5"),
];

fn class_of(bin: i8) -> &'static str {
    CLASSES.iter().find(|c| c.0 == bin).map(|c| c.1).unwrap_or("Not significant")
}

/// lon/lat ↔ UTM for a set of points: exact metres for distances and output grids.
struct Utm {
    epsg: u32,
    fwd: CoordTransform,
    inv: CoordTransform,
    wkt: String,
}

impl Utm {
    fn for_points(ll: &[P2]) -> Result<Utm, String> {
        let n = ll.len().max(1) as f64;
        let (lon, lat) = (ll.iter().map(|p| p[0]).sum::<f64>() / n, ll.iter().map(|p| p[1]).sum::<f64>() / n);
        let epsg = features::utm_epsg(lon, lat);
        let e = |x: gdal::errors::GdalError| x.to_string();
        let wgs = raster::wgs84();
        let mut utm = SpatialRef::from_epsg(epsg).map_err(e)?;
        utm.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        let wkt = utm.to_wkt().map_err(e)?;
        Ok(Utm { epsg, fwd: CoordTransform::new(&wgs, &utm).map_err(e)?, inv: CoordTransform::new(&utm, &wgs).map_err(e)?, wkt })
    }

    fn run(ct: &CoordTransform, pts: &[P2]) -> Result<Vec<P2>, String> {
        if pts.is_empty() {
            return Ok(vec![]);
        }
        let mut xs: Vec<f64> = pts.iter().map(|p| p[0]).collect();
        let mut ys: Vec<f64> = pts.iter().map(|p| p[1]).collect();
        let mut zs = vec![0.0; xs.len()];
        ct.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
        Ok(xs.into_iter().zip(ys).map(|(x, y)| [x, y]).collect())
    }

    fn fwd(&self, pts: &[P2]) -> Result<Vec<P2>, String> {
        Self::run(&self.fwd, pts)
    }

    fn inv(&self, pts: &[P2]) -> Result<Vec<P2>, String> {
        Self::run(&self.inv, pts)
    }
}

fn ring_area(r: &[P2]) -> f64 {
    let mut a = 0.0;
    for i in 0..r.len() {
        let (p, q) = (r[i], r[(i + 1) % r.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

/// Area-weighted centroid of polygons (holes subtracted); a representative point otherwise.
pub fn centroid(g: &Geom) -> Option<P2> {
    let Geom::Polygons(polys) = g else { return features::anchor(g) };
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for poly in polys {
        for (k, ring) in poly.iter().enumerate() {
            if ring.len() < 3 {
                continue;
            }
            let sign = if k == 0 { 1.0 } else { -1.0 };
            let ra = ring_area(ring);
            if ra.abs() < 1e-18 {
                continue;
            }
            let (mut sx, mut sy) = (0.0, 0.0);
            for i in 0..ring.len() {
                let (p, q) = (ring[i], ring[(i + 1) % ring.len()]);
                let c = p[0] * q[1] - q[0] * p[1];
                sx += (p[0] + q[0]) * c;
                sy += (p[1] + q[1]) * c;
            }
            // centroid of this ring = (sx, sy) / (6 ra); weight by |area|
            let w = sign * ra.abs();
            cx += w * sx / (6.0 * ra);
            cy += w * sy / (6.0 * ra);
            a += w;
        }
    }
    if a.abs() > 1e-18 { Some([cx / a, cy / a]) } else { features::anchor(g) }
}

fn bbox(pts: &[P2]) -> [f64; 4] {
    pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])])
}

fn numeric_field(sc: &StepCtx, l: &LayerHandle, want: Option<&str>) -> Result<(String, usize), String> {
    let field = match want.filter(|f| *f != "auto") {
        Some(f) => f.to_string(),
        None => {
            let st = automap::style_layer(sc.engine, l, None, None);
            match st.style["symbology"]["kind"].as_str() {
                Some("graduated") => st.field.unwrap_or_default(),
                _ => l
                    .info
                    .fields
                    .iter()
                    .find(|f| matches!(f.kind, "integer" | "real") && !automap::is_id_like(&f.name))
                    .map(|f| f.name.clone())
                    .ok_or_else(|| format!("{} has no numeric field to analyse", l.info.id))?,
            }
        }
    };
    let fi = l.field_index(&field).ok_or_else(|| format!("{} has no field '{field}'", l.info.id))?;
    if !matches!(l.info.fields[fi].kind, "integer" | "real") {
        return Err(format!("'{field}' is not numeric"));
    }
    Ok((field, fi))
}

fn dist_text(m: f64) -> String {
    features::fmt_distance(m)
}

fn sig(v: f64, digits: usize) -> String {
    if !v.is_finite() {
        return "n/a".into();
    }
    if v == 0.0 {
        return "0".into();
    }
    if v.abs() < 1e-3 || v.abs() >= 1e7 {
        return format!("{v:.prec$e}", prec = digits.saturating_sub(1));
    }
    let mag = v.abs().log10().floor() as i32;
    let dec = (digits as i32 - 1 - mag).max(0) as usize;
    format!("{v:.dec$}")
}

fn p_text(p: f64) -> String {
    if p < 0.001 { "p < 0.001".into() } else { format!("p = {}", sig(p, 2)) }
}

// ------------------------------------------------------------------ hot spots

pub(super) fn hotspots(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = std::time::Instant::now();
    let spec = p_str(p, "layer").unwrap_or("auto");
    let l = if spec == "auto" { auto_layer(sc, None, "incidents")? } else { sc.layer(spec)? };
    let polygons = l.info.geometry == GeomKind::Polygon;
    let field: Option<(String, usize)> = match p_str(p, "field").unwrap_or("auto") {
        "none" | "count" => None,
        "auto" if l.info.geometry == GeomKind::Point => None,
        f => Some(numeric_field(sc, &l, Some(f))?),
    };
    if field.is_none() && l.info.geometry != GeomKind::Point {
        return Err(format!("{} holds {}s: hot spots of areas or lines need a numeric field (field: …)", l.info.id, format!("{:?}", l.info.geometry).to_lowercase()));
    }
    let name = sanitize(p_str(p, "name").unwrap_or(&sc.step_id));
    let fidx: Vec<usize> = field.iter().map(|f| f.1).collect();
    let fs = features::read_layer(sc.engine, &l, None, Some(&fidx), 1_000_000)?;
    let (mut ll, mut vals, mut geoms) = (Vec::new(), Vec::new(), Vec::new());
    let mut skipped = 0usize;
    for f in &fs.feats {
        let c = if polygons { centroid(&f.geom) } else { features::anchor(&f.geom) };
        let Some(c) = c.filter(|c| c[0].is_finite() && c[1].is_finite()) else {
            skipped += 1;
            continue;
        };
        if field.is_some() {
            let Some(v) = f.props.first().and_then(Val::as_f64).filter(|v| v.is_finite()) else {
                skipped += 1;
                continue;
            };
            vals.push(v);
            geoms.push(f.geom.clone());
        }
        ll.push(c);
    }
    let utm = Utm::for_points(&ll)?;
    let xy = utm.fwd(&ll)?;
    let incidents = field.is_none();
    let mut why = Vec::new();
    let mut methods = Vec::new();

    // ---- aggregation (incidents only)
    let shape = match p_str(p, "aggregation").unwrap_or("hexagon") {
        "fishnet" | "grid" | "square" | "squares" => "fishnet",
        _ => "hexagon",
    };
    let (locs, values, cell_info): (Vec<P2>, Vec<f64>, Option<(f64, String, Vec<(i64, i64)>, usize)>) = if incidents {
        if xy.len() < 60 {
            return Err(format!("hot spot analysis of incidents needs at least 60 points to aggregate (found {} in {})", xy.len(), l.info.id));
        }
        let mut uniq: HashMap<(i64, i64), P2> = HashMap::new();
        for q in &xy {
            uniq.entry(((q[0] * 100.0).round() as i64, (q[1] * 100.0).round() as i64)).or_insert(*q);
        }
        let mut ul: Vec<P2> = uniq.into_values().collect();
        ul.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let ixu = Index::new(&ul);
        let nn = geostats::nn_distances(&ixu);
        let out = geostats::locational_outliers(&nn);
        let good: Vec<f64> = nn.iter().zip(&out).filter(|(_, o)| !**o).map(|(d, _)| *d).collect();
        let (ann, mnn) = (geostats::mean_sd(&good).0, geostats::median(&good));
        let hull = convex_hull(xy.clone());
        let area = ring_area(&hull).abs().max(1.0);
        let b = bbox(&xy);
        let max_extent = (b[2] - b[0]).max(b[3] - b[1]).max(1.0);
        let rand_ann = 0.5 * (area / xy.len() as f64).sqrt();
        let set_by_recipe = p_f64(p, "cell").filter(|c| *c > 0.0);
        let (cell, mut cell_why) = match set_by_recipe {
            Some(c) => (c, "set by the recipe".to_string()),
            None if 2.0 * rand_ann < max_extent / 100.0 => (
                max_extent / 100.0,
                format!("the incidents are dense (twice the random-pattern nearest-neighbour distance, {}, is under 1/100 of the {} extent), so 1/100 of the extent", dist_text(2.0 * rand_ann), dist_text(max_extent)),
            ),
            None => (2.0 * ann.max(mnn), format!("twice the larger of the average ({}) and median ({}) nearest-neighbour distance", dist_text(ann), dist_text(mnn))),
        };
        if ul.len() < 30 {
            return Err(format!(
                "the {} incidents in {} sit at only {} distinct places, and hot spot analysis needs at least 30. Records at the same coordinates (common in GBIF and survey data, where many sightings share a site) count as one place. Try Make a surface with a value field, or add records from more places.",
                xy.len(),
                l.info.id,
                ul.len()
            ));
        }
        let count_cells = |cell: f64| {
            let hr = cell * (2.0 / (3.0 * SQRT3)).sqrt(); // hexagon with the area of a cell × cell square
            let mut counts: HashMap<(i64, i64), u32> = HashMap::new();
            for q in &xy {
                let k = if shape == "hexagon" { hex_of(*q, hr) } else { ((q[0] / cell).floor() as i64, (q[1] / cell).floor() as i64) };
                *counts.entry(k).or_insert(0) += 1;
            }
            (hr, counts)
        };
        let mut cell = cell.max(0.5);
        let (mut hr, mut counts) = count_cells(cell);
        // clustered records (many at few sites) leave too few cells at the automatic size: make the
        // cells smaller until there are 30, as long as there are places left to separate
        if set_by_recipe.is_none() && counts.len() < 30 {
            let first = cell;
            for _ in 0..40 {
                if counts.len() >= 30 || cell <= 0.5 {
                    break;
                }
                cell = (cell / 1.25).max(0.5);
                (hr, counts) = count_cells(cell);
            }
            cell_why = format!("{cell_why} gave {}, too few cells for the test, so the cells were made smaller until there were at least 30", dist_text(first));
        }
        let mut keys: Vec<(i64, i64)> = counts.keys().copied().collect();
        keys.sort();
        if keys.len() < 30 {
            return Err(format!(
                "the {} incidents fill only {} cells of {} — too few for hot spot analysis (30 needed); set a smaller cell: or add incidents",
                xy.len(),
                keys.len(),
                dist_text(cell)
            ));
        }
        let vals: Vec<f64> = keys.iter().map(|k| counts[k] as f64).collect();
        if vals.iter().all(|v| *v == vals[0]) {
            return Err(format!("every cell holds the same number of incidents ({}), so there is no pattern to test; try a larger cell:", vals[0]));
        }
        let centres: Vec<P2> = keys.iter().map(|&(a, b)| if shape == "hexagon" { hex_center(a, b, hr) } else { [(a as f64 + 0.5) * cell, (b as f64 + 0.5) * cell] }).collect();
        let n_out = out.iter().filter(|o| **o).count();
        why.push(format!(
            "{} incidents at {} unique locations → {} {} cells of {} ({cell_why}); empty cells left out{}",
            fmt_num(xy.len() as f64),
            fmt_num(ul.len() as f64),
            keys.len(),
            if shape == "hexagon" { "hexagon" } else { "square" },
            dist_text(cell),
            if n_out > 0 { format!("; {n_out} locational outlier{} ignored for the sizing", if n_out == 1 { "" } else { "s" }) } else { String::new() }
        ));
        methods.push(format!(
            "{} incidents ({} unique locations) were counted in {} {} cells of {} ({cell_why}); cells without incidents were left out, as ArcGIS Optimized Hot Spot Analysis does when no study-area boundary is given.",
            fmt_num(xy.len() as f64),
            fmt_num(ul.len() as f64),
            keys.len(),
            if shape == "hexagon" { "hexagonal" } else { "square (fishnet)" },
            dist_text(cell)
        ));
        let nul = ul.len();
        (centres, vals, Some((cell, shape.to_string(), keys, nul)))
    } else {
        if xy.len() < 30 {
            return Err(format!("hot spot analysis needs at least 30 features with a value (found {} in {})", xy.len(), l.info.id));
        }
        let mut distinct = vals.clone();
        distinct.sort_by(|a, b| a.partial_cmp(b).unwrap());
        distinct.dedup();
        if distinct.len() < 2 {
            return Err(format!("every feature has the same value of '{}', so there is no pattern to test", field.as_ref().unwrap().0));
        }
        if distinct.len() == 2 {
            why.push(format!("'{}' holds only two values; Gi* is meant for varied values, so read the result with care", field.as_ref().unwrap().0));
        }
        (xy.clone(), vals.clone(), None)
    };
    let n = locs.len();

    // ---- scale of analysis
    let ix = Index::new(&locs);
    let mut bands: Vec<geostats::Band> = Vec::new();
    let mut peak = None;
    let (distance, rule, scale_why) = match p_f64(p, "distance").filter(|d| *d > 0.0) {
        Some(d) => (d, "recipe", "set by the recipe".to_string()),
        None => {
            let nn = geostats::nn_distances(&ix);
            let out = geostats::locational_outliers(&nn);
            let good: Vec<f64> = nn.iter().zip(&out).filter(|(_, o)| !**o).map(|(d, _)| *d).collect();
            let start = good.iter().copied().fold(0.0, f64::max);
            let ann = geostats::mean_sd(&good).0;
            let b = bbox(&locs);
            let td = ((b[2] - b[0]).powi(2) + (b[3] - b[1]).powi(2)).sqrt() / 2.0;
            let mut inc = ann.min((td - start) / 10.0);
            if !(inc > 0.0) {
                inc = ann.max(start * 0.1).max(1.0);
            }
            let (bs, capped) = geostats::incremental(&ix, &values, start, inc, 10, 500);
            bands = bs;
            if capped {
                let d = geostats::mean_knn_distance(&ix, 30);
                (d, "capped", format!("some features would have 500 or more neighbours, so the average distance to 30 neighbours ({})", dist_text(d)))
            } else if let Some(k) = geostats::first_peak(&bands) {
                peak = Some(k);
                let m = bands[k].moran.unwrap();
                (
                    bands[k].distance,
                    "peak",
                    format!("the first peak of spatial clustering (Moran's I z = {}) among 10 distances from {} in steps of {}", sig(m.z, 3), dist_text(start), dist_text(inc)),
                )
            } else {
                let k = ((0.05 * n as f64).round() as usize).clamp(3, 30);
                let d = geostats::mean_knn_distance(&ix, k);
                let sd = geostats::standard_distance(&locs);
                if d > sd {
                    (sd, "standard_distance", format!("no clustering peak in 10 distances from {}; the average distance to {k} neighbours exceeds one standard distance, so the standard distance", dist_text(start)))
                } else {
                    (d, "knn", format!("no clustering peak in 10 distances from {}, so the average distance to {k} neighbours (5 % of the features, 3–30)", dist_text(start)))
                }
            }
        }
    };
    why.push(format!("distance band {}: {scale_why}", dist_text(distance)));

    // ---- Gi*, FDR, Moran's I
    let nb = Neighbours::distance_band(&ix, distance);
    let (max_nb, mean_nb, isolated) = nb.counts();
    let z = geostats::gi_star(&values, &nb);
    let (bins, cuts) = geostats::fdr_bins(&z);
    let moran = geostats::moran(&values, &nb, true);
    let count_bin = |b: i8| bins.iter().filter(|x| **x == b).count();
    let (hot, cold) = (bins.iter().filter(|b| **b > 0).count(), bins.iter().filter(|b| **b < 0).count());
    why.push(format!(
        "Gi* with the false discovery rate: {hot} hot ({}/{}/{} at 99/95/90 %) and {cold} cold ({}/{}/{}) of {n} {}; {} neighbours on average{}",
        count_bin(3),
        count_bin(2),
        count_bin(1),
        count_bin(-3),
        count_bin(-2),
        count_bin(-1),
        if incidents { "cells" } else { "features" },
        sig(mean_nb, 3),
        if isolated > 0 { format!(", {isolated} without any (only themselves)") } else { String::new() }
    ));

    // ---- output layer
    let value_name = match &field {
        None => "count".to_string(),
        Some((f, _)) => {
            let s = sanitize(f).replace(['.', '-'], "_");
            if s.starts_with("gi_") || s == "neighbors" { format!("value_{s}") } else { s }
        }
    };
    let kind = if incidents { GeomKind::Polygon } else { l.info.geometry };
    let mut out = FeatureSet::new(
        kind,
        vec![
            (value_name.clone(), if incidents { "integer" } else { "real" }),
            ("gi_z".into(), "real"),
            ("gi_p".into(), "real"),
            ("gi_bin".into(), "integer"),
            ("gi_class".into(), "string"),
            ("neighbors".into(), "integer"),
        ],
    );
    let geoms_out: Vec<Geom> = match &cell_info {
        Some((cell, shape, keys, _)) => {
            let hr = cell * (2.0 / (3.0 * SQRT3)).sqrt();
            let mut verts: Vec<P2> = Vec::with_capacity(keys.len() * 7);
            for (i, c) in locs.iter().enumerate() {
                let _ = keys[i];
                if shape == "hexagon" {
                    for k in 0..=6 {
                        let a = (60.0 * k as f64 - 30.0).to_radians();
                        verts.push([c[0] + hr * a.cos(), c[1] + hr * a.sin()]);
                    }
                } else {
                    let h = cell / 2.0;
                    verts.extend([[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h], [c[0] - h, c[1] - h]]);
                }
            }
            let back = utm.inv(&verts)?;
            let per = if shape == "hexagon" { 7 } else { 5 };
            back.chunks(per).map(|r| Geom::Polygons(vec![vec![r.to_vec()]])).collect()
        }
        None => geoms,
    };
    for (i, g) in geoms_out.into_iter().enumerate() {
        let pz = geostats::p_two_sided(z[i]);
        out.feats.push(Feat {
            geom: g,
            props: vec![
                if incidents { Val::Int(values[i] as i64) } else { Val::Num(values[i]) },
                Val::Num((z[i] * 1e6).round() / 1e6),
                Val::Num((pz * 1e8).round() / 1e8),
                Val::Int(bins[i] as i64),
                Val::Str(class_of(bins[i]).into()),
                Val::Int(nb.lists[i].len() as i64 + 1),
            ],
        });
    }
    let title = if incidents { format!("Hot spots of {}", sc.title_of(&l)) } else { format!("Hot spots of {}", field.as_ref().unwrap().0) };
    let id = sc.write_output(&name, &out, title)?;
    let classes: Vec<Value> = CLASSES.iter().filter(|c| c.0 == 0 || count_bin(c.0) > 0).map(|c| json!({ "value": c.1, "color": c.2, "count": count_bin(c.0) })).collect();
    sc.hints.insert(
        id.clone(),
        json!({
            "symbology": { "kind": "unique", "field": "gi_class", "classes": classes, "other": "#cccccc", "othersCount": 0 },
            "outline": !incidents && kind == GeomKind::Polygon,
            "opacity": 0.92,
            "why": "Gi* confidence bins on the conventional diverging scheme: reds are hot spots, blues cold spots, pale = not significant after the false-discovery-rate correction",
        }),
    );

    // ---- chart of the distance search
    if !bands.is_empty() {
        let pts: Vec<(f64, f64)> = bands.iter().filter_map(|b| b.moran.map(|m| (b.distance, m.z))).collect();
        let chart = charts::svg(&Chart {
            x_label: "distance band (m)".into(),
            y_label: "clustering (Moran's I z-score)".into(),
            series: vec![
                Series { label: String::new(), color: "@0".into(), width: 1.0, kind: Kind::Line, points: pts.clone() },
                Series { label: "z-score per distance".into(), color: "@0".into(), width: 1.0, kind: Kind::Dots(None), points: pts },
            ],
            marks: vec![(distance, format!("used: {}", dist_text(distance)), "@1".into())],
            hlines: vec![(1.96, "z = 1.96 (95 %)".into())],
            y_zero: true,
        });
        let caption = match rule {
            "peak" => "Incremental spatial autocorrelation: clustering is strongest at the first peak, so that distance defines the neighbourhoods.".to_string(),
            _ => format!("Incremental spatial autocorrelation found no peak; the band was set by the fallback rule ({scale_why})."),
        };
        sc.charts.push(("How the distance band was chosen".into(), chart, caption));
    }

    // ---- cards, methods, outputs
    sc.cards.push((hot.to_string(), format!("hot spot {} (≥ 90 % confidence, FDR-corrected)", if incidents { "cells" } else { "features" })));
    sc.cards.push((cold.to_string(), format!("cold spot {}", if incidents { "cells" } else { "features" })));
    sc.cards.push((dist_text(distance), "distance band (scale of analysis)".into()));
    if let Some(m) = moran {
        sc.cards.push((sig(m.i, 2), format!("global Moran's I (z = {}, {})", sig(m.z, 3), p_text(m.p))));
    }
    let moran_text = match moran {
        Some(m) if m.p < 0.05 && m.z > 0.0 => format!("Global Moran's I = {} (z = {}, {}): the values are clustered overall.", sig(m.i, 3), sig(m.z, 3), p_text(m.p)),
        Some(m) if m.p < 0.05 => format!("Global Moran's I = {} (z = {}, {}): the values are dispersed overall.", sig(m.i, 3), sig(m.z, 3), p_text(m.p)),
        Some(m) => format!("Global Moran's I = {} (z = {}, {}): no significant clustering overall.", sig(m.i, 3), sig(m.z, 3), p_text(m.p)),
        None => String::new(),
    };
    methods.push(format!(
        "Hot and cold spots were found with the Getis-Ord Gi* statistic, choosing its settings from the data as ArcGIS Optimized Hot Spot Analysis does. The distance band, {} ({scale_why}), sets the neighbours of each {} (fixed band, binary weights, each its own neighbour; {} neighbours on average, at most {max_nb}). Gi* z-scores were corrected for multiple testing and spatial dependence with the false discovery rate (Benjamini–Hochberg) at 90, 95 and 99 % confidence, giving {hot} hot and {cold} cold spots. {moran_text}",
        dist_text(distance),
        if incidents { "cell" } else { "feature" },
        sig(mean_nb, 3)
    ));
    sc.methods.extend(methods);
    let mut bins_json = serde_json::Map::new();
    for c in CLASSES {
        bins_json.insert(c.0.to_string(), json!(count_bin(c.0)));
    }
    Ok(StepOut {
        outputs: json!({
            "layer": id,
            "source": l.info.id,
            "mode": if incidents { "incidents" } else { "values" },
            "field": field.as_ref().map(|f| f.0.clone()),
            "value_field": value_name,
            "features": n,
            "incidents": if incidents { Some(xy.len()) } else { None },
            "unique_locations": cell_info.as_ref().map(|c| c.3),
            "cell_m": cell_info.as_ref().map(|c| c.0),
            "aggregation": cell_info.as_ref().map(|c| c.1.clone()),
            "distance_m": distance,
            "distance_rule": rule,
            "isa": bands.iter().map(|b| json!({ "distance": b.distance, "i": b.moran.map(|m| m.i), "z": b.moran.map(|m| m.z), "mean_neighbours": b.mean_neighbours })).collect::<Vec<_>>(),
            "peak": peak,
            "hot": hot,
            "cold": cold,
            "bins": bins_json,
            "fdr": { "p90": cuts[0], "p95": cuts[1], "p99": cuts[2] },
            "moran": moran.map(|m| json!({ "i": m.i, "expected": m.expected, "variance": m.variance, "z": m.z, "p": m.p })),
            "neighbours": { "mean": mean_nb, "max": max_nb, "isolated": isolated },
            "skipped": skipped,
            "epsg": utm.epsg,
            "seconds": t0.elapsed().as_secs_f64(),
        }),
        why,
    })
}

// ------------------------------------------------------------------ interpolation

fn units_of(field: &str) -> &'static str {
    let f = field.to_ascii_lowercase();
    if f.ends_with("_pct") || f.contains("percent") || f.ends_with("pct") {
        "%"
    } else if f.starts_with("pm") && (f.contains("25") || f.contains("10") || f.contains("2_5")) {
        "µg/m³"
    } else if f.contains("temp") || f.ends_with("_c") {
        "°C"
    } else if f.ends_with("_m") || f.contains("elev") || f.contains("depth") || f.contains("height") {
        "m"
    } else {
        ""
    }
}

pub(super) fn interpolate_auto(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = std::time::Instant::now();
    let spec = p_str(p, "layer").unwrap_or("auto");
    let l = if spec == "auto" { auto_layer(sc, Some(GeomKind::Point), "samples")? } else { sc.layer(spec)? };
    if l.info.geometry != GeomKind::Point {
        return Err(format!("interpolation needs point samples; {} is a {:?} layer", l.info.id, l.info.geometry).to_lowercase());
    }
    let (field, fi) = numeric_field(sc, &l, p_str(p, "field"))?;
    let method = p_str(p, "method").unwrap_or("auto");
    if !matches!(method, "auto" | "kriging" | "idw") {
        return Err(format!("method must be auto, kriging or idw (got '{method}')"));
    }
    let name = sanitize(p_str(p, "name").unwrap_or(&sc.step_id));
    let fs = features::read_layer(sc.engine, &l, None, Some(&[fi]), 50_000)?;
    let raw: Vec<(P2, f64)> = fs.feats.iter().filter_map(|f| Some((features::anchor(&f.geom)?, f.props.first()?.as_f64().filter(|v| v.is_finite())?))).collect();
    if raw.len() < 3 {
        return Err(format!("need at least 3 samples with a value of '{field}' (found {})", raw.len()));
    }
    let ll: Vec<P2> = raw.iter().map(|r| r.0).collect();
    let utm = Utm::for_points(&ll)?;
    let xy = utm.fwd(&ll)?;
    // coincident samples (within 1 cm) are averaged: kriging cannot hold two values at one place
    let mut order: Vec<(i64, i64)> = Vec::new();
    let mut groups: HashMap<(i64, i64), (P2, f64, u32)> = HashMap::new();
    for (q, (_, v)) in xy.iter().zip(&raw) {
        let k = ((q[0] * 100.0).round() as i64, (q[1] * 100.0).round() as i64);
        let e = groups.entry(k).or_insert_with(|| {
            order.push(k);
            (*q, 0.0, 0)
        });
        e.1 += v;
        e.2 += 1;
    }
    let pts: Vec<P2> = order.iter().map(|k| groups[k].0).collect();
    let z: Vec<f64> = order.iter().map(|k| groups[k].1 / groups[k].2 as f64).collect();
    let duplicates = raw.len() - pts.len();
    let n = pts.len();
    if n < 3 {
        return Err(format!("the samples sit at fewer than 3 distinct places ({n})"));
    }
    if z.iter().all(|v| (*v - z[0]).abs() < 1e-12) {
        return Err(format!("every sample has the same value of '{field}' ({}), so there is nothing to interpolate", fmt_num(z[0])));
    }

    // ---- IDW, cross-validated over powers
    let samples: Vec<(P2, f64)> = pts.iter().copied().zip(z.iter().copied()).collect();
    let powers: Vec<f64> = match p_f64(p, "power") {
        Some(x) if x > 0.0 => vec![x],
        _ => vec![1.0, 1.5, 2.0, 3.0],
    };
    let idw_all: Vec<(f64, f64, f64)> = powers.iter().map(|&pw| {
        let (rmse, mae) = idw_cv(&samples, pw);
        (pw, rmse, mae)
    }).collect();
    let &(power, idw_rmse, idw_mae) = idw_all.iter().filter(|c| c.1.is_finite()).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).ok_or("IDW cross-validation failed")?;

    // ---- variogram and kriging
    struct Kr {
        vgm: Vgm,
        sse: f64,
        fits: Vec<(Vgm, f64)>,
        lags: Vec<geostats::Lag>,
        cutoff: f64,
        width: f64,
        cv: geostats::Cv,
        nmax: usize,
    }
    let mut kr: Option<Kr> = None;
    let mut kriging_note = String::new();
    if method != "idw" {
        if n < 10 {
            if method == "kriging" {
                return Err(format!("kriging needs at least 10 samples to fit a variogram (found {n})"));
            }
            kriging_note = format!("only {n} samples: too few to fit a variogram, so IDW");
        } else {
            let step = (n / 4000).max(1);
            let vp: Vec<P2> = pts.iter().step_by(step).copied().collect();
            let vz: Vec<f64> = z.iter().step_by(step).copied().collect();
            let (cutoff, width) = match (p_f64(p, "cutoff"), p_f64(p, "width")) {
                (Some(c), Some(w)) if c > 0.0 && w > 0.0 => (c, w),
                (Some(c), _) if c > 0.0 => (c, c / 15.0),
                _ => geostats::default_lags(&vp),
            };
            let lags = geostats::empirical(&vp, &vz, cutoff, width);
            let models: Vec<Model> = match p_str(p, "model").filter(|m| *m != "auto") {
                Some(m) => vec![Model::parse(m).ok_or_else(|| format!("model must be auto, spherical, exponential or gaussian (got '{m}')"))?],
                None => Model::ALL.to_vec(),
            };
            let fits: Vec<(Vgm, f64)> = models.iter().filter_map(|m| geostats::fit(&lags, *m)).collect();
            match fits.iter().min_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).copied() {
                Some((vgm, sse)) if vgm.psill > 0.0 => {
                    let nmax = if n <= 200 { 0 } else { p_f64(p, "neighbours").map(|v| v.clamp(4.0, 200.0) as usize).unwrap_or(32) };
                    match Kriging::new(&pts, &z, vgm, nmax) {
                        Ok(k) => {
                            let (cv, _) = k.cross_validate(1500);
                            kr = Some(Kr { vgm, sse, fits, lags, cutoff, width, cv, nmax });
                        }
                        Err(e) => kriging_note = format!("kriging failed ({e}), so IDW"),
                    }
                }
                Some(_) => kriging_note = "the variogram is flat (pure nugget: nearby samples are no more alike than distant ones), so kriging would predict the mean everywhere; IDW instead".into(),
                None => kriging_note = "the variogram could not be fitted (too few lags), so IDW".into(),
            }
            if method == "kriging" && kr.is_none() {
                return Err(kriging_note.clone());
            }
        }
    }
    let use_kriging = match (&kr, method) {
        (Some(_), "kriging") => true,
        (Some(k), "auto") => k.cv.rmse <= idw_rmse,
        _ => false,
    };
    if !use_kriging && kriging_note.is_empty() {
        if let Some(k) = &kr {
            kriging_note = format!("IDW cross-validated better than kriging (RMSE {} vs {})", sig(idw_rmse, 3), sig(k.cv.rmse, 3));
        }
    }

    // ---- prediction grid (UTM), limited to the samples' convex hull
    let b = bbox(&pts);
    let (w, h) = ((b[2] - b[0]).max(1.0), (b[3] - b[1]).max(1.0));
    let cols = p_f64(p, "cells").map(|c| c.clamp(20.0, 1000.0) as usize).unwrap_or(320);
    let cell = w.max(h) * 1.1 / cols as f64;
    // the hull, grown by 6 % and half a cell, and a grid that covers all of it
    let hull = convex_hull(pts.clone());
    let hc = hull.iter().fold([0.0, 0.0], |a, q| [a[0] + q[0] / hull.len() as f64, a[1] + q[1] / hull.len() as f64]);
    let grown: Vec<P2> = hull.iter().map(|q| [hc[0] + (q[0] - hc[0]) * 1.06 + (q[0] - hc[0]).signum() * cell / 2.0, hc[1] + (q[1] - hc[1]) * 1.06 + (q[1] - hc[1]).signum() * cell / 2.0]).collect();
    let g = bbox(if grown.len() >= 3 { &grown } else { &pts });
    let (g0, g1) = ([g[0].min(b[0]) - cell, g[1].min(b[1]) - cell], [g[2].max(b[2]) + cell, g[3].max(b[3]) + cell]);
    let (nx, ny) = (((g1[0] - g0[0]) / cell).ceil() as usize, ((g1[1] - g0[1]) / cell).ceil() as usize);
    let (x0, ytop) = ((g0[0] + g1[0]) / 2.0 - nx as f64 * cell / 2.0, (g0[1] + g1[1]) / 2.0 + ny as f64 * cell / 2.0);
    let krig = match (&kr, use_kriging) {
        (Some(k), true) => Some(Kriging::new(&pts, &z, k.vgm, k.nmax)?),
        _ => None,
    };
    let cancel = sc.cancel;
    let mut pred = vec![NODATA as f32; nx * ny];
    let mut se = vec![NODATA as f32; if krig.is_some() { nx * ny } else { 0 }];
    {
        let fill_row = |iy: usize, prow: &mut [f32], srow: Option<&mut [f32]>| {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let cy = ytop - (iy as f64 + 0.5) * cell;
            let mut srow = srow;
            for ix in 0..nx {
                let cx = x0 + (ix as f64 + 0.5) * cell;
                if grown.len() >= 3 && !point_in_ring([cx, cy], &grown) {
                    continue;
                }
                match &krig {
                    Some(k) => {
                        let (v, var) = k.predict([cx, cy]);
                        if v.is_finite() {
                            prow[ix] = v as f32;
                            if let Some(s) = srow.as_deref_mut() {
                                s[ix] = var.sqrt() as f32;
                            }
                        }
                    }
                    None => {
                        let v = idw_at([cx, cy], &samples, power, None);
                        if v.is_finite() {
                            prow[ix] = v as f32;
                        }
                    }
                }
            }
        };
        if se.is_empty() {
            pred.par_chunks_mut(nx).enumerate().for_each(|(iy, row)| fill_row(iy, row, None));
        } else {
            pred.par_chunks_mut(nx).zip(se.par_chunks_mut(nx)).enumerate().for_each(|(iy, (row, srow))| fill_row(iy, row, Some(srow)));
        }
    }
    if sc.cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    let valid = pred.iter().filter(|v| **v != NODATA as f32).count();
    let gt = [x0, cell, 0.0, ytop, 0.0, -cell];
    let units = units_of(&field);
    let method_label = if use_kriging { "kriging" } else { "IDW" };
    let path = out_path(sc, &name)?;
    raster::write_tif_f32(&path, nx, ny, gt, &utm.wkt, pred, Some(NODATA))?;
    let what = if use_kriging {
        let k = kr.as_ref().unwrap();
        format!("ordinary kriging ({} variogram) of {n} samples", k.vgm.model.name())
    } else {
        format!("inverse distance weighting (power {}) of {n} samples", fmt_num(power))
    };
    let surf = register(
        sc,
        &path,
        &name,
        json!({ "kind": "surface", "title": format!("{field} ({method_label})"), "units": units, "description": format!("{field} predicted by {what} on {}-m cells", fmt_num(cell)), "credit": "" }),
    )?;
    let mut se_id: Option<String> = None;
    if !se.is_empty() {
        let sname = format!("{name}_se");
        let spath = out_path(sc, &sname)?;
        raster::write_tif_f32(&spath, nx, ny, gt, &utm.wkt, se, Some(NODATA))?;
        let h = register(
            sc,
            &spath,
            &sname,
            json!({ "kind": "stderr", "title": format!("{field} kriging standard error"), "units": units, "description": format!("kriging standard error of {field}: small near samples, large where the surface is a guess"), "credit": "" }),
        )?;
        se_id = Some(h.info.id.clone());
    }

    // ---- variogram chart
    if let Some(k) = &kr {
        let hmax = k.lags.iter().map(|l| l.dist).fold(0.0, f64::max).max(k.cutoff);
        let maxnp = k.lags.iter().map(|l| l.np).max().unwrap_or(1) as f64;
        let mut series = vec![Series {
            label: "pairs of samples (dot size = number of pairs)".into(),
            color: "#333333".into(),
            width: 1.0,
            kind: Kind::Dots(Some(k.lags.iter().map(|l| 2.5 + 4.5 * (l.np as f64 / maxnp).sqrt()).collect())),
            points: k.lags.iter().map(|l| (l.dist, l.gamma)).collect(),
        }];
        for (v, _) in &k.fits {
            let best = v.model == k.vgm.model;
            series.push(Series {
                label: format!("{}{}", v.model.name(), if best { " (best fit)" } else { "" }),
                // one palette colour per model, as ggplot2 maps a discrete variable to colour
                color: match v.model {
                    Model::Sph => "@0",
                    Model::Exp => "@1",
                    Model::Gau => "@2",
                }
                .into(),
                width: if best { 2.5 } else { 1.2 },
                kind: if best { Kind::Line } else { Kind::Dashed },
                points: (0..=120).map(|i| {
                    let hh = hmax * i as f64 / 120.0;
                    (hh, if i == 0 { v.nugget } else { v.gamma(hh) })
                }).collect(),
            });
        }
        let svg = charts::svg(&Chart {
            x_label: "distance between samples (m)".into(),
            y_label: format!("semivariance of {field}"),
            series,
            marks: if k.vgm.practical_range() <= hmax * 1.05 { vec![(k.vgm.practical_range(), format!("range {}", dist_text(k.vgm.practical_range())), "#4D4D4D".into())] } else { vec![] },
            hlines: if k.vgm.practical_range() <= hmax * 1.05 { vec![(k.vgm.sill(), "sill".into())] } else { vec![] },
            y_zero: true,
        });
        sc.charts.push((
            "Variogram: how quickly samples stop resembling each other".into(),
            svg,
            if k.vgm.practical_range() > 2.0 * k.cutoff {
                format!(
                    "Empirical semivariogram of {field} and the fitted models. The {} model fits best, but it keeps rising across all distances measured: there is no sill, the values follow a trend across the area. Nearby samples are still far more alike than distant ones, which is what kriging uses.",
                    k.vgm.model.name()
                )
            } else {
                format!(
                    "Empirical semivariogram of {field} and the fitted models. The {} model fits best: nugget {}, partial sill {}, practical range {}. Beyond the range, samples no longer help predict each other.",
                    k.vgm.model.name(),
                    sig(k.vgm.nugget, 3),
                    sig(k.vgm.psill, 3),
                    dist_text(k.vgm.practical_range())
                )
            },
        ));
    }

    // ---- cards, methods, why
    let zone = utm.epsg % 100;
    let hemi = if utm.epsg >= 32700 { "S" } else { "N" };
    let mut why = Vec::new();
    let idw_text = idw_all.iter().map(|c| format!("{} → {}", fmt_num(c.0), sig(c.1, 3))).collect::<Vec<_>>().join(", ");
    // RMSSE far from 1: the standard errors are mis-scaled (usually a nugget fitted too small)
    let calib = |k: &Kr| -> String {
        if k.cv.rmsse > 1.5 {
            format!(" Note: RMSSE {} means the standard errors are about {:.1}× too small (the fitted nugget is probably too low), so read the uncertainty map as relative: where the surface is weaker, not exact error bars.", sig(k.cv.rmsse, 3), k.cv.rmsse)
        } else if k.cv.rmsse < 0.67 {
            format!(" Note: RMSSE {} means the standard errors are about {:.1}× too large, so the surface is better than the uncertainty map suggests.", sig(k.cv.rmsse, 3), 1.0 / k.cv.rmsse)
        } else {
            String::new()
        }
    };
    match (&kr, use_kriging) {
        (Some(k), true) => {
            sc.cards.push((sig(k.cv.rmse, 3), format!("cross-validated RMSE of {field} (kriging)")));
            if k.vgm.practical_range() > 2.0 * k.cutoff {
                sc.cards.push(("trend".into(), format!("{} variogram keeps rising: {field} changes steadily across the whole area", k.vgm.model.name())));
            } else {
                sc.cards.push((k.vgm.model.name().to_string(), format!("variogram model; range {}", dist_text(k.vgm.practical_range()))));
            }
            if idw_rmse > 0.0 {
                sc.cards.push((format!("{:.0} %", (1.0 - k.cv.rmse / idw_rmse) * 100.0), "lower error than the best IDW".into()));
            }
            why.push(format!(
                "variogram of {n} samples ({} lags up to {}): {} fits best (nugget {}, partial sill {}, practical range {}{}; weighted SSE {})",
                k.lags.len(),
                dist_text(k.cutoff),
                k.vgm.model.name(),
                sig(k.vgm.nugget, 3),
                sig(k.vgm.psill, 3),
                dist_text(k.vgm.practical_range()),
                if k.vgm.practical_range() > 2.0 * k.cutoff { ", far beyond the data: no sill, the values follow a trend" } else { "" },
                sig(k.sse, 3)
            ));
            why.push(format!(
                "leave-one-out: kriging RMSE {} (MAE {}, mean error {}, RMSSE {}) vs best IDW RMSE {} (power {}) → kriging{}",
                sig(k.cv.rmse, 3),
                sig(k.cv.mae, 3),
                sig(k.cv.me, 2),
                sig(k.cv.rmsse, 3),
                sig(idw_rmse, 3),
                fmt_num(power),
                if calib(k).is_empty() { String::new() } else if k.cv.rmsse > 1.5 { "; standard errors too small, read them as relative".to_string() } else { "; standard errors too large".to_string() }
            ));
            sc.methods.push(format!(
                "A continuous surface of '{field}' was predicted from {n} samples{} by ordinary kriging on {}-m cells (UTM zone {zone}{hemi}, EPSG:{}), limited to the samples' convex hull. The empirical semivariogram ({} lags of {} up to {}, gstat defaults) was fitted with spherical, exponential and Gaussian models by weighted least squares (weights = pairs / distance², gstat's default); the {} model fitted best (nugget {}, partial sill {}, range parameter {}, practical range {}){}. Each prediction used {}. Leave-one-out cross-validation gave RMSE {}, MAE {}, mean error {} and RMSSE {} (near 1 means the standard-error map is honest); IDW scored RMSE {} at best (powers {idw_text}), so kriging was kept. The standard-error map shows where the surface is solid (near samples) and where it is a guess.{}",
                if duplicates > 0 { format!(" ({duplicates} coincident samples averaged)") } else { String::new() },
                fmt_num(cell),
                utm.epsg,
                k.lags.len(),
                dist_text(k.width),
                dist_text(k.cutoff),
                k.vgm.model.name(),
                sig(k.vgm.nugget, 3),
                sig(k.vgm.psill, 3),
                dist_text(k.vgm.range),
                dist_text(k.vgm.practical_range()),
                if k.vgm.practical_range() > 2.0 * k.cutoff { "; the range lies far beyond the samples, so the variogram never levels off: the values follow a trend across the area, which ordinary kriging handles as a steadily rising variogram" } else { "" },
                if k.nmax == 0 { "all samples".to_string() } else { format!("the {} nearest samples", k.nmax) },
                sig(k.cv.rmse, 3),
                sig(k.cv.mae, 3),
                sig(k.cv.me, 2),
                sig(k.cv.rmsse, 3),
                sig(idw_rmse, 3),
                calib(k)
            ));
        }
        _ => {
            sc.cards.push((sig(idw_rmse, 3), format!("cross-validated RMSE of {field} (IDW)")));
            why.push(format!("IDW power {} chosen by leave-one-out cross-validation (RMSE {idw_text}){}", fmt_num(power), if kriging_note.is_empty() { String::new() } else { format!("; {kriging_note}") }));
            sc.methods.push(format!(
                "A continuous surface of '{field}' was interpolated from {n} samples by inverse distance weighting on {}-m cells (UTM zone {zone}{hemi}), limited to the samples' convex hull. The power was chosen by leave-one-out cross-validation among {}: power {} gave the lowest error (RMSE {}, MAE {}).{}",
                fmt_num(cell),
                powers.iter().map(|x| fmt_num(*x)).collect::<Vec<_>>().join(", "),
                fmt_num(power),
                sig(idw_rmse, 3),
                sig(idw_mae, 3),
                if kriging_note.is_empty() { String::new() } else { format!(" Kriging was not used: {kriging_note}.") }
            ));
        }
    }
    why.push(format!("{} × {} grid of {}-m cells, {} inside the samples' hull", nx, ny, fmt_num(cell), fmt_num(valid as f64)));
    let surf_id = surf.info.id.clone();
    let _ = Arc::clone(&surf);
    Ok(StepOut {
        outputs: json!({
            "raster": surf_id,
            "se": se_id,
            "has_se": se_id.is_some(),
            "method": if use_kriging { "kriging" } else { "idw" },
            "method_label": method_label,
            "field": field,
            "units": units,
            "samples": n,
            "duplicates": duplicates,
            "cells": valid,
            "cell_m": cell,
            "nx": nx,
            "ny": ny,
            "epsg": utm.epsg,
            "geotransform": gt,
            "source": l.info.id,
            "note": kriging_note,
            "variogram": kr.as_ref().map(|k| json!({
                "model": k.vgm.model.name(), "code": k.vgm.model.code(), "nugget": k.vgm.nugget, "psill": k.vgm.psill, "range": k.vgm.range,
                "practical_range": k.vgm.practical_range(), "sse": k.sse, "cutoff": k.cutoff, "width": k.width,
                "lags": k.lags.iter().map(|l| json!({ "dist": l.dist, "gamma": l.gamma, "np": l.np })).collect::<Vec<_>>(),
                "fits": k.fits.iter().map(|(v, s)| json!({ "model": v.model.name(), "nugget": v.nugget, "psill": v.psill, "range": v.range, "sse": s })).collect::<Vec<_>>(),
                "neighbours": if k.nmax == 0 { json!("all") } else { json!(k.nmax) },
            })),
            "cv": {
                "kriging": kr.as_ref().map(|k| json!({ "rmse": k.cv.rmse, "mae": k.cv.mae, "me": k.cv.me, "rmsse": k.cv.rmsse, "n": k.cv.n })),
                "idw": { "power": power, "rmse": idw_rmse, "mae": idw_mae, "all": idw_all.iter().map(|c| json!({ "power": c.0, "rmse": c.1, "mae": c.2 })).collect::<Vec<_>>() },
            },
            "seconds": t0.elapsed().as_secs_f64(),
        }),
        why,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centroid_of_square_with_hole() {
        let outer = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0], [0.0, 0.0]];
        let hole = vec![[0.0, 0.0], [0.0, 2.0], [2.0, 2.0], [2.0, 0.0], [0.0, 0.0]];
        let c = centroid(&Geom::Polygons(vec![vec![outer.clone()]])).unwrap();
        assert!((c[0] - 2.0).abs() < 1e-12 && (c[1] - 2.0).abs() < 1e-12);
        // removing the lower-left quarter moves the centroid up and right: (16·2 − 4·1) / 12
        let c = centroid(&Geom::Polygons(vec![vec![outer, hole]])).unwrap();
        assert!((c[0] - 28.0 / 12.0).abs() < 1e-12 && (c[1] - 28.0 / 12.0).abs() < 1e-12, "{c:?}");
    }

    #[test]
    fn classes_are_ordered_hot_to_cold() {
        assert_eq!(CLASSES.iter().map(|c| c.0).collect::<Vec<_>>(), vec![3, 2, 1, 0, -1, -2, -3]);
        assert_eq!(class_of(-2), "Cold spot · 95 % sure");
        assert_eq!(units_of("moisture_pct"), "%");
        assert_eq!(units_of("ph"), "");
        assert_eq!(sig(0.012345, 3), "0.0123");
        assert_eq!(sig(1234.6, 3), "1235");
    }
}
