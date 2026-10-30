//! hydro.network (docs/AUTOMATION.md §4): streams, Strahler order, drainage basins and flow
//! accumulation from a DEM, natively.
//!
//! Every pass is a loop over a queue, never recursion, so large rasters with wide flat areas (the
//! sea, a valley floor, a lake) take memory in proportion to the cells and nothing else:
//!   1. priority-flood fill with an epsilon gradient (Barnes, Lehman & Mulla 2014), so every cell
//!      drains and flats get a gentle slope towards their outlet;
//!   2. D8 flow directions (steepest descent on the filled surface, distance-weighted diagonals);
//!   3. flow accumulation in topological order (Kahn), in cells and km²;
//!   4. streams where the upstream area passes a threshold, Strahler-ordered on the way down;
//!   5. drainage basins: every cell labelled with the outlet it reaches at the edge of the data.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};

use gdal::DriverManager;
use gdal::spatial_ref::CoordTransform;
use gdal::vector::{LayerAccess, LayerOptions};
use serde_json::{Value, json};

use super::features::{self, Feat, FeatureSet, Val};
use super::raster_steps::{fmt0, out_path, pick_raster, register};
use super::steps::{StepCtx, StepOut, p_f64, p_str, sanitize};
use crate::catalog::GeomKind;
use crate::raster;
use crate::wkb::Geom;

/// Neighbour offsets, clockwise from east; diagonals at odd indices.
const DX: [isize; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
const DY: [isize; 8] = [0, 1, 1, 1, 0, -1, -1, -1];
const NONE: u32 = u32::MAX;

#[derive(PartialEq)]
struct Cell(f64, u32);
impl Eq for Cell {}
impl Ord for Cell {
    // a min-heap on elevation; ties broken by index so the order is deterministic
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.total_cmp(&self.0).then_with(|| o.1.cmp(&self.1))
    }
}
impl PartialOrd for Cell {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Flow routing over a grid: `down[i]` is the cell i drains to (NONE = leaves the data),
/// `order` lists the cells upstream-first.
pub struct Flow {
    pub down: Vec<u32>,
    pub order: Vec<u32>,
}

fn neighbour(i: usize, k: usize, w: usize, h: usize) -> Option<usize> {
    let (x, y) = ((i % w) as isize + DX[k], (i / w) as isize + DY[k]);
    (x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h).then(|| y as usize * w + x as usize)
}

/// Fill depressions (priority-flood + epsilon) and route flow (D8). `z` NaN = no data.
pub fn route(z: &[f64], w: usize, h: usize) -> Flow {
    let n = w * h;
    let mut f = z.to_vec();
    let mut done = vec![false; n];
    let mut heap = BinaryHeap::new();
    let mut pit: VecDeque<u32> = VecDeque::new();
    // seeds: data cells on the grid edge or next to no data, where water can leave
    for i in 0..n {
        if f[i].is_nan() {
            done[i] = true;
            continue;
        }
        let edge = (0..8).any(|k| neighbour(i, k, w, h).is_none_or(|j| z[j].is_nan()));
        if edge {
            done[i] = true;
            heap.push(Cell(f[i], i as u32));
        }
    }
    let mut parent = vec![NONE; n];
    while let Some(c) = pit.pop_front().or_else(|| heap.pop().map(|Cell(_, i)| i)) {
        let c = c as usize;
        for k in 0..8 {
            let Some(j) = neighbour(c, k, w, h) else {
                continue;
            };
            if done[j] {
                continue;
            }
            done[j] = true;
            parent[j] = c as u32;
            // the smallest step that keeps the value strictly above its parent
            let up = f[c] + f[c].abs().max(1.0) * 1e-9;
            if f[j] <= up {
                f[j] = up;
                pit.push_back(j as u32);
            } else {
                heap.push(Cell(f[j], j as u32));
            }
        }
    }
    // D8 on the filled surface; the flood parent is the fallback (it is always lower)
    let mut down = vec![NONE; n];
    for i in 0..n {
        if f[i].is_nan() {
            continue;
        }
        let mut best = (0.0, NONE);
        let mut leaves = false;
        for k in 0..8 {
            match neighbour(i, k, w, h) {
                Some(j) if !f[j].is_nan() => {
                    let drop = (f[i] - f[j])
                        / if k % 2 == 1 {
                            std::f64::consts::SQRT_2
                        } else {
                            1.0
                        };
                    if drop > best.0 {
                        best = (drop, j as u32);
                    }
                }
                _ => leaves = true,
            }
        }
        down[i] = if best.1 != NONE {
            best.1
        } else if leaves {
            NONE
        } else {
            parent[i]
        };
    }
    // upstream-first order (Kahn): cells with nothing flowing in go first
    let mut indeg = vec![0u32; n];
    for &d in &down {
        if d != NONE {
            indeg[d as usize] += 1;
        }
    }
    let mut q: VecDeque<u32> = (0..n as u32)
        .filter(|&i| !f[i as usize].is_nan() && indeg[i as usize] == 0)
        .collect();
    let mut order = Vec::with_capacity(n);
    while let Some(i) = q.pop_front() {
        order.push(i);
        let d = down[i as usize];
        if d != NONE {
            indeg[d as usize] -= 1;
            if indeg[d as usize] == 0 {
                q.push_back(d);
            }
        }
    }
    Flow { down, order }
}

/// Cells draining through each cell, itself included.
pub fn accumulate(fl: &Flow, n: usize) -> Vec<u32> {
    let mut acc = vec![0u32; n];
    for &i in &fl.order {
        acc[i as usize] += 1;
        let d = fl.down[i as usize];
        if d != NONE {
            acc[d as usize] += acc[i as usize];
        }
    }
    acc
}

/// Strahler order of stream cells (0 = not a stream).
pub fn strahler(fl: &Flow, stream: &[bool]) -> Vec<u8> {
    let n = stream.len();
    let (mut best, mut count) = (vec![0u8; n], vec![0u8; n]);
    let mut ord = vec![0u8; n];
    for &i in &fl.order {
        let i = i as usize;
        if !stream[i] {
            continue;
        }
        ord[i] = if best[i] == 0 {
            1
        } else if count[i] >= 2 {
            best[i] + 1
        } else {
            best[i]
        };
        let d = fl.down[i];
        if d != NONE && stream[d as usize] {
            let d = d as usize;
            match ord[i].cmp(&best[d]) {
                Ordering::Greater => (best[d], count[d]) = (ord[i], 1),
                Ordering::Equal => count[d] = count[d].saturating_add(1),
                Ordering::Less => {}
            }
        }
    }
    ord
}

/// The outlet (cell index + 1) each cell drains to; 0 = no data.
pub fn basins(fl: &Flow, n: usize) -> Vec<u32> {
    let mut b = vec![0u32; n];
    for &i in fl.order.iter().rev() {
        let d = fl.down[i as usize];
        b[i as usize] = if d == NONE { i + 1 } else { b[d as usize] };
    }
    b
}

pub(super) fn hydro_network(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let dem = pick_raster(sc, p.get("dem"), &["dem"], &[])?;
    let src0 = raster::open(&dem.info.path)?;
    // areas and lengths need metres: warp a geographic DEM to its UTM zone first
    let ds = if dem.info.geographic {
        let b = dem.info.bounds;
        let epsg = features::utm_epsg((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
        let mut a = raster::strings(&["-of", "MEM", "-r", "bilinear", "-dstnodata", "-9999"]);
        a.extend([
            "-t_srs".into(),
            format!("EPSG:{epsg}"),
            "-tr".into(),
            dem.info.pixel_m.to_string(),
            dem.info.pixel_m.to_string(),
        ]);
        raster::warp(&[&src0], "", &a)?
    } else {
        src0
    };
    let gt = ds.geo_transform().map_err(|e| e.to_string())?;
    let srs = raster::srs_of(&ds).ok_or("the DEM has no coordinate system")?;
    let nodata = ds.rasterband(1).ok().and_then(|b| b.no_data_value());
    let (v, w, h) = raster::read_full(&ds, 1)?;
    let n = w * h;
    // the sea at 0 m (Copernicus, SRTM) is no data for rivers, unless asked otherwise
    let sea = p
        .get("sea_is_nodata")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let z: Vec<f64> = v
        .iter()
        .map(|&x| {
            let x = x as f64;
            if !x.is_finite()
                || nodata.is_some_and(|nd| x == nd)
                || x <= -1000.0
                || (sea && x <= 0.0)
            {
                f64::NAN
            } else {
                x
            }
        })
        .collect();
    let valid = z.iter().filter(|x| !x.is_nan()).count();
    if valid < 9 {
        return Err("the DEM has no land cells to route water over".into());
    }
    let cell_km2 = (gt[1] * gt[5]).abs() / 1e6;
    let t0 = std::time::Instant::now();
    let fl = route(&z, w, h);
    let acc = accumulate(&fl, n);
    // streams start where about 1 km² drains (a common first choice); `threshold_km2` changes it
    let thr_km2 = p_f64(p, "threshold_km2")
        .filter(|t| *t > 0.0)
        .unwrap_or(1.0);
    let thr = ((thr_km2 / cell_km2).ceil() as u32).max(2);
    let stream: Vec<bool> = acc.iter().map(|&a| a >= thr).collect();
    let ord = strahler(&fl, &stream);
    let bas = basins(&fl, n);
    let secs = t0.elapsed().as_secs_f64();

    let ct = CoordTransform::new(&srs, &raster::wgs84()).map_err(|e| e.to_string())?;
    let centre = |i: usize| {
        [
            gt[0] + ((i % w) as f64 + 0.5) * gt[1],
            gt[3] + ((i / w) as f64 + 0.5) * gt[5],
        ]
    };
    let to_ll = |pts: &[[f64; 2]]| -> Option<Vec<[f64; 2]>> {
        let (mut xs, mut ys): (Vec<f64>, Vec<f64>) = pts.iter().map(|p| (p[0], p[1])).unzip();
        let mut zs = vec![0.0; xs.len()];
        ct.transform_coords(&mut xs, &mut ys, &mut zs).ok()?;
        Some(xs.into_iter().zip(ys).map(|(x, y)| [x, y]).collect())
    };

    // stream links: from a source or a confluence down to the next confluence or outlet
    let mut inflows = vec![0u8; n];
    for i in 0..n {
        let d = fl.down[i];
        if stream[i] && d != NONE && stream[d as usize] {
            inflows[d as usize] = inflows[d as usize].saturating_add(1);
        }
    }
    let starts = (0..n).filter(|&i| stream[i] && (inflows[i] == 0 || inflows[i] >= 2));
    let mut fs = FeatureSet::new(
        GeomKind::Line,
        vec![
            ("strahler".into(), "integer"),
            ("length_km".into(), "real"),
            ("upstream_km2".into(), "real"),
        ],
    );
    let mut max_order = 0u8;
    for s in starts {
        let mut pts = vec![centre(s)];
        let mut c = s;
        let mut len = 0.0;
        loop {
            let d = fl.down[c];
            if d == NONE || !stream[d as usize] {
                break;
            }
            let d = d as usize;
            let (a, b) = (centre(c), centre(d));
            len += ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            pts.push(b);
            c = d;
            if inflows[d] >= 2 {
                break; // a confluence starts the next link
            }
        }
        if pts.len() < 2 {
            continue;
        }
        let Some(line) = to_ll(&pts) else { continue };
        max_order = max_order.max(ord[s]);
        fs.feats.push(Feat {
            geom: Geom::Lines(vec![line]),
            props: vec![
                Val::Int(ord[s] as i64),
                Val::Num((len / 10.0).round() / 100.0),
                Val::Num((acc[c] as f64 * cell_km2 * 10.0).round() / 10.0),
            ],
        });
    }
    if fs.feats.is_empty() {
        return Err(format!(
            "no streams: nowhere drains {thr_km2} km² (lower threshold_km2)"
        ));
    }
    fs.total = fs.feats.len() as u64;
    let base = sanitize(p_str(p, "name").unwrap_or("hydro"));
    let n_links = fs.feats.len();
    let streams_id = sc.write_output(
        &format!("{base}_streams"),
        &fs,
        format!("Streams (Strahler, ≥ {} km²)", fmt0(thr_km2)),
    )?;
    sc.hints.insert(streams_id.clone(), json!({ "field": "strahler", "why": "streams coloured and widened by Strahler order: headwaters thin, main rivers bold" }));

    // drainage basins larger than min_basin_km2 (default 1 % of the area, at least 1 km²)
    let min_km2 = p_f64(p, "min_basin_km2").unwrap_or((valid as f64 * cell_km2 / 100.0).max(1.0));
    let mut size = std::collections::HashMap::<u32, u32>::new();
    for &b in &bas {
        if b != 0 {
            *size.entry(b).or_default() += 1;
        }
    }
    let keep: std::collections::HashMap<u32, i32> = {
        let mut big: Vec<(u32, u32)> = size
            .iter()
            .filter(|(_, c)| **c as f64 * cell_km2 >= min_km2)
            .map(|(b, c)| (*b, *c))
            .collect();
        big.sort_by_key(|x| std::cmp::Reverse(x.1));
        big.into_iter()
            .enumerate()
            .map(|(k, (b, _))| (b, k as i32 + 1))
            .collect()
    };
    let labels: Vec<i32> = bas
        .iter()
        .map(|b| keep.get(b).copied().unwrap_or(0))
        .collect();
    let basins_id = polygonize_basins(sc, &labels, w, h, gt, &srs, &ct, cell_km2, &base)?;

    // flow accumulation (upstream area, km²) as a raster, for maps and further steps
    let acc_km2: Vec<f32> = (0..n)
        .map(|i| {
            if z[i].is_nan() {
                raster::NODATA as f32
            } else {
                (acc[i] as f64 * cell_km2) as f32
            }
        })
        .collect();
    let out = out_path(sc, &format!("{base}_flow_accumulation"))?;
    raster::write_tif_f32(
        &out,
        w,
        h,
        gt,
        &srs.to_wkt().map_err(|e| e.to_string())?,
        acc_km2,
        Some(raster::NODATA),
    )?;
    let acc_h = register(
        sc,
        &out,
        &format!("{base}_flow_accumulation"),
        json!({ "kind": "flow", "title": "Flow accumulation", "units": "km²", "description": format!("upstream area, from {}", dem.info.title), "credit": dem.info.credit }),
    )?;

    let largest = acc.iter().max().copied().unwrap_or(0) as f64 * cell_km2;
    sc.cards.push((
        "Stream links".into(),
        format!("{n_links} (Strahler 1–{max_order})"),
    ));
    sc.cards.push((
        "Drainage basins".into(),
        format!("{} ≥ {} km²", keep.len(), fmt0(min_km2)),
    ));
    sc.cards
        .push(("Largest catchment".into(), format!("{} km²", fmt0(largest))));
    sc.methods.push(format!(
        "Streams and basins were derived from {} ({}×{} cells, {} m) natively in GeoSpaX: priority-flood depression filling with an epsilon gradient (Barnes et al. 2014), D8 flow directions, flow accumulation, streams where at least {} km² drains, Strahler stream order, and basins by outlet ({:.1} s).",
        dem.info.title, w, h, fmt0(gt[1].abs()), fmt0(thr_km2), secs
    ));
    Ok(StepOut {
        outputs: json!({ "layers": [streams_id, basins_id], "rasters": [acc_h.info.id], "streams": streams_id, "basins": basins_id, "flow_accumulation": acc_h.info.id, "max_order": max_order }),
        why: vec![
            format!(
                "{n_links} stream links up to Strahler order {max_order}, starting where {} km² drains",
                fmt0(thr_km2)
            ),
            format!(
                "{} drainage basins of at least {} km²; the largest catchment drains {} km²",
                keep.len(),
                fmt0(min_km2),
                fmt0(largest)
            ),
        ],
    })
}

/// Basin labels (0 = none) → polygons in WGS 84 with their area.
#[allow(clippy::too_many_arguments)]
fn polygonize_basins(
    sc: &mut StepCtx,
    labels: &[i32],
    w: usize,
    h: usize,
    gt: [f64; 6],
    srs: &gdal::spatial_ref::SpatialRef,
    ct: &CoordTransform,
    cell_km2: f64,
    base: &str,
) -> Result<String, String> {
    let e = |x: gdal::errors::GdalError| x.to_string();
    let mem = DriverManager::get_driver_by_name("MEM").map_err(e)?;
    let mut rds = mem
        .create_with_band_type::<i32, _>("", w, h, 1)
        .map_err(e)?;
    rds.set_geo_transform(&gt).map_err(e)?;
    rds.set_spatial_ref(srs).map_err(e)?;
    {
        let mut b = rds.rasterband(1).map_err(e)?;
        b.set_no_data_value(Some(0.0)).map_err(e)?;
        let mut buf = gdal::raster::Buffer::new((w, h), labels.to_vec());
        b.write((0, 0), (w, h), &mut buf).map_err(e)?;
    }
    let drv = DriverManager::get_driver_by_name("Memory").map_err(e)?;
    let mut vds = drv.create_vector_only("").map_err(e)?;
    let lyr = vds
        .create_layer(LayerOptions {
            name: "basins",
            srs: Some(srs),
            ty: gdal_sys::OGRwkbGeometryType::wkbPolygon,
            options: None,
        })
        .map_err(e)?;
    lyr.create_defn_fields(&[("basin", gdal_sys::OGRFieldType::OFTInteger)])
        .map_err(e)?;
    let band = rds.rasterband(1).map_err(e)?;
    let err = unsafe {
        let mask = gdal_sys::GDALGetMaskBand(band.c_rasterband());
        gdal_sys::GDALPolygonize(
            band.c_rasterband(),
            mask,
            lyr.c_layer(),
            0,
            std::ptr::null_mut(),
            None,
            std::ptr::null_mut(),
        )
    };
    if err != gdal_sys::CPLErr::CE_None {
        return Err(format!("basins: {}", raster::last_error()));
    }
    let mut lyr = vds.layer(0).map_err(e)?;
    let tol = gt[1].abs() * 0.75; // smooth the cell staircase, keep shared edges shared
    let mut parts: std::collections::BTreeMap<i64, Vec<Vec<Vec<[f64; 2]>>>> = Default::default();
    for f in lyr.features() {
        let id = f.field_as_integer(0).ok().flatten().unwrap_or(0) as i64;
        let Some(g) = f.geometry() else { continue };
        let g = g
            .simplify_preserve_topology(tol)
            .unwrap_or_else(|_| g.clone());
        let mut poly = Vec::new();
        for r in 0..g.geometry_count() {
            let ring = g.get_geometry(r);
            let (mut xs, mut ys): (Vec<f64>, Vec<f64>) = (0..ring.point_count())
                .map(|i| {
                    let (x, y, _) = ring.get_point(i as i32);
                    (x, y)
                })
                .unzip();
            let mut zs = vec![0.0; xs.len()];
            if xs.len() >= 4 && ct.transform_coords(&mut xs, &mut ys, &mut zs).is_ok() {
                poly.push(xs.into_iter().zip(ys).map(|(x, y)| [x, y]).collect());
            }
        }
        if !poly.is_empty() {
            parts.entry(id).or_default().push(poly);
        }
    }
    let mut count = std::collections::HashMap::<i32, u64>::new();
    for &l in labels {
        *count.entry(l).or_default() += 1;
    }
    let mut fs = FeatureSet::new(
        GeomKind::Polygon,
        vec![("basin".into(), "integer"), ("area_km2".into(), "real")],
    );
    for (id, polys) in parts {
        let area = count.get(&(id as i32)).copied().unwrap_or(0) as f64 * cell_km2;
        fs.feats.push(Feat {
            geom: Geom::Polygons(polys),
            props: vec![Val::Int(id), Val::Num((area * 10.0).round() / 10.0)],
        });
    }
    fs.total = fs.feats.len() as u64;
    let id = sc.write_output(&format!("{base}_basins"), &fs, "Drainage basins".into())?;
    sc.hints.insert(id.clone(), json!({ "color": "#7fdbff", "fill": false, "width": 1.4, "field": "none", "why": "basin outlines only, so the land and the streams show through" }));
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tilted plane with a pit in the middle and a wide flat: everything must still reach the edge.
    #[test]
    fn fills_pits_and_flats_and_drains_everything() {
        let (w, h) = (60, 40);
        let mut z: Vec<f64> = (0..w * h).map(|i| ((i % w) as f64) * 0.5 + 10.0).collect();
        z[20 * w + 30] = 0.5; // a pit
        for y in 5..35 {
            for x in 35..55 {
                z[y * w + x] = 25.0; // a flat
            }
        }
        let fl = route(&z, w, h);
        assert_eq!(fl.order.len(), w * h, "every cell is ordered (no cycles)");
        let acc = accumulate(&fl, w * h);
        let total: u32 = (0..w * h)
            .filter(|&i| fl.down[i] == NONE)
            .map(|i| acc[i])
            .sum();
        assert_eq!(total as usize, w * h, "all water leaves the grid");
        let b = basins(&fl, w * h);
        assert!(b.iter().all(|&x| x > 0));
    }

    /// Two first-order streams meet: order 2 below the confluence; a third tributary of order 1 keeps it 2.
    #[test]
    fn strahler_orders() {
        // cells 0,1 → 2; 3 → 4; 2,4 → 5; 6 → 5; 5 → out
        let fl = Flow {
            down: vec![2, 2, 5, 4, 5, NONE, 5],
            order: vec![0, 1, 3, 6, 2, 4, 5],
        };
        let o = strahler(&fl, &[true; 7]);
        assert_eq!(o[2], 2);
        assert_eq!(o[4], 1);
        assert_eq!(o[5], 2);
    }

    /// A large flat (the case that crashed the WebAssembly tools) routes without recursion.
    #[test]
    fn big_flat_does_not_overflow() {
        let (w, h) = (1500, 1500);
        let z = vec![5.0; w * h];
        let fl = route(&z, w, h);
        assert_eq!(fl.order.len(), w * h);
    }
}
