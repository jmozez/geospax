//! Raster, terrain and remote-sensing steps (docs/AUTOMATION.md §4): dem.fetch, terrain.derive,
//! terrain.contours, raster.classify, raster.sample, rs.search, rs.index, rs.fetch.
//!
//! Everything reads only the area of interest: Copernicus DEM tiles and Sentinel-2 bands are
//! cloud-optimised GeoTIFFs, so GDAL fetches just the needed byte ranges over HTTP.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use gdal::spatial_ref::CoordTransform;
use gdal::vector::{LayerAccess, LayerOptions};
use gdal::DriverManager;
use serde_json::{json, Value};

use super::features::{self, Feat, FeatureSet, Val};
use super::steps::{p_f64, p_list, p_str, sanitize, StepCtx, StepOut};
use crate::catalog::GeomKind;
use crate::raster::{self, RasterHandle, NODATA};
use crate::wkb::Geom;

pub const EARTH_SEARCH: &str = "https://earth-search.aws.element84.com/v1";

fn km(b: [f64; 4]) -> (f64, f64) {
    let lat = (b[1] + b[3]) / 2.0;
    ((b[2] - b[0]) * 111.32 * lat.to_radians().cos(), (b[3] - b[1]) * 110.57)
}

/// Area of interest in lon/lat: `aoi: [w, s, e, n]`, a layer/raster id, or auto (the area an earlier
/// step chose, else what the run touched). A margin (`buffer` metres; default 10 %, ≥ 300 m) is added
/// unless the area came from an earlier step.
pub(super) fn aoi(sc: &mut StepCtx, p: &Value) -> Result<([f64; 4], String), String> {
    let (b, what, reuse) = match p.get("aoi") {
        Some(Value::Array(a)) if a.len() == 4 && a.iter().all(Value::is_number) => {
            let v: Vec<f64> = a.iter().filter_map(Value::as_f64).collect();
            ([v[0], v[1], v[2], v[3]], "the given box".to_string(), false)
        }
        Some(Value::String(s)) if s != "auto" && !s.is_empty() => match sc.engine.raster(s) {
            Some(r) => (r.info.bounds, r.info.title.clone(), false),
            None => {
                let l = sc.layer(s)?;
                (l.info.bounds, sc.title_of(&l), false)
            }
        },
        _ => {
            if let Some(a) = sc.aoi {
                (a, "the run's area of interest".to_string(), true)
            } else {
                let mut b = None;
                let mut names = Vec::new();
                for id in sc.touched.clone() {
                    if let Ok(l) = sc.layer(&id) {
                        b = features::union_bounds(b, Some(l.info.bounds));
                        names.push(sc.title_of(&l));
                    }
                }
                if b.is_none() {
                    for id in &sc.rasters {
                        if let Some(r) = sc.engine.raster(id) {
                            b = features::union_bounds(b, Some(r.info.bounds));
                            names.push(r.info.title.clone());
                        }
                    }
                }
                let b = b.or(sc.extent).ok_or("no area of interest: set aoi: [west, south, east, north] or a layer id, or open a layer first")?;
                (b, names.join(" + "), false)
            }
        }
    };
    if reuse {
        return Ok((b, what));
    }
    let (wk, hk) = km(b);
    let buffer_m = match p.get("buffer").and_then(Value::as_f64) {
        Some(m) => m.max(0.0),
        None => (wk.max(hk) * 1000.0 * 0.1).max(300.0),
    };
    let lat = (b[1] + b[3]) / 2.0;
    let (dx, dy) = (buffer_m / (111_320.0 * lat.to_radians().cos()), buffer_m / 110_570.0);
    let out = [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
    let (wk, hk) = km(out);
    let max_km = p_f64(p, "max_km").unwrap_or(120.0);
    if wk.max(hk) > max_km {
        return Err(format!("area of interest is {wk:.0} × {hk:.0} km; the limit is {max_km:.0} km (set max_km: to allow more, or pass a smaller aoi:)"));
    }
    sc.aoi = Some(out);
    let what = if buffer_m > 0.0 { format!("{what} + {}", features::fmt_distance(buffer_m)) } else { what };
    Ok((out, what))
}

/// A raster by id or path/URL, or (auto) the newest raster of the wanted kinds this run made.
pub(super) fn pick_raster(sc: &mut StepCtx, spec: Option<&Value>, kinds: &[&str], avoid: &[&str]) -> Result<Arc<RasterHandle>, String> {
    let ok = |r: &RasterHandle| (kinds.is_empty() || kinds.contains(&r.info.kind.as_str())) && !avoid.contains(&r.info.kind.as_str());
    match spec.and_then(Value::as_str) {
        Some(s) if s != "auto" && !s.is_empty() => {
            if let Some(r) = sc.engine.raster(s).or_else(|| sc.engine.raster(&format!("{}.{s}", sc.recipe_id))) {
                return Ok(r);
            }
            let path = if s.starts_with("http://") || s.starts_with("https://") { PathBuf::from(format!("/vsicurl/{s}")) } else { sc.resolve_path(s).ok_or(format!("raster '{s}' not found"))? };
            let stem = path.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_else(|| "raster".into());
            let id = format!("{}.{}", sc.recipe_id, raster::sanitize(&stem));
            let h = sc.engine.register_raster(&path, &id)?;
            sc.rasters.retain(|x| x != &id);
            sc.rasters.push(id);
            Ok(h)
        }
        _ => {
            for id in sc.rasters.iter().rev() {
                if let Some(r) = sc.engine.raster(id) {
                    if ok(&r) {
                        return Ok(r);
                    }
                }
            }
            sc.engine.rasters().into_iter().rev().find(|r| ok(r)).ok_or_else(|| {
                if kinds.is_empty() { "no raster yet: run dem.fetch or rs.index first, or name one with raster:".to_string() } else { format!("no {} raster yet: run dem.fetch or rs.index first, or name one", kinds.join("/")) }
            })
        }
    }
}

/// Write the sidecar, register the raster under `<recipe>.<name>` and remember it for later steps.
pub(super) fn register(sc: &mut StepCtx, path: &Path, name: &str, side: Value) -> Result<Arc<RasterHandle>, String> {
    raster::write_sidecar(path, &side)?;
    let id = format!("{}.{name}", sc.recipe_id);
    let h = sc.engine.register_raster(path, &id)?;
    sc.rasters.retain(|x| x != &id);
    sc.rasters.push(id.clone());
    sc.names.insert(id, h.info.title.clone());
    Ok(h)
}

pub(super) fn out_path(sc: &StepCtx, name: &str) -> Result<PathBuf, String> {
    let dir = sc.outputs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.join(format!("{name}.tif")))
}

pub(super) fn fmt0(v: f64) -> String {
    super::cartography::fmt_num(v.round())
}

// ------------------------------------------------------------------ DEM

fn copernicus_tiles(b: [f64; 4], res: u32) -> Vec<String> {
    let (bucket, code) = if res == 90 { ("copernicus-dem-90m", "30") } else { ("copernicus-dem-30m", "10") };
    let mut out = Vec::new();
    let (la0, la1) = (b[1].floor() as i32, (b[3] - 1e-9).floor() as i32);
    let (lo0, lo1) = (b[0].floor() as i32, (b[2] - 1e-9).floor() as i32);
    for lat in la0..=la1 {
        for lon in lo0..=lo1 {
            let n = format!(
                "Copernicus_DSM_COG_{code}_{}{:02}_00_{}{:03}_00_DEM",
                if lat < 0 { 'S' } else { 'N' },
                lat.abs(),
                if lon < 0 { 'W' } else { 'E' },
                lon.abs()
            );
            out.push(format!("/vsicurl/https://{bucket}.s3.amazonaws.com/{n}/{n}.tif"));
        }
    }
    out
}

pub(super) fn dem_fetch(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let (b, what) = aoi(sc, p)?;
    let source = p_str(p, "source").unwrap_or("copernicus").to_string();
    let (paths, label, res_default) = match source.as_str() {
        "copernicus" | "copernicus-30" | "glo30" | "glo-30" => (copernicus_tiles(b, 30), "Copernicus GLO-30 DEM (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA)", 30.0),
        "copernicus-90" | "glo90" | "glo-90" => (copernicus_tiles(b, 90), "Copernicus GLO-90 DEM (ESA)", 90.0),
        other => {
            let path = if other.starts_with("http") { format!("/vsicurl/{other}") } else { sc.resolve_path(other).ok_or(format!("DEM '{other}' not found"))?.to_string_lossy().to_string() };
            (vec![path], "the given DEM", 0.0)
        }
    };
    let mut srcs = Vec::new();
    let mut missing = 0;
    for path in &paths {
        match raster::open(Path::new(path)) {
            Ok(d) => srcs.push(d),
            Err(_) if paths.len() > 1 || source.starts_with("copernicus") || source.starts_with("glo") => missing += 1,
            Err(e) => return Err(e),
        }
    }
    if srcs.is_empty() {
        return Err(format!("no DEM coverage for the area ({} tile(s) missing; open ocean has no Copernicus tiles)", paths.len()));
    }
    let lon = (b[0] + b[2]) / 2.0;
    let lat = (b[1] + b[3]) / 2.0;
    let epsg = p_f64(p, "epsg").map(|e| e as u32).unwrap_or_else(|| features::utm_epsg(lon, lat));
    let res = p_f64(p, "resolution").unwrap_or(if res_default > 0.0 { res_default } else { 30.0 });
    let name = sanitize(p_str(p, "name").unwrap_or("dem"));
    let out = out_path(sc, &name)?;
    let tmp = out.with_extension("part.tif");
    let mut args = raster::strings(&["-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3", "-co", "TILED=YES", "-ot", "Float32", "-r", "bilinear", "-dstnodata", "-9999", "-overwrite"]);
    args.extend(["-t_srs".into(), format!("EPSG:{epsg}"), "-te_srs".into(), "EPSG:4326".into(), "-te".into(), b[0].to_string(), b[1].to_string(), b[2].to_string(), b[3].to_string(), "-tr".into(), res.to_string(), res.to_string()]);
    let refs: Vec<&gdal::Dataset> = srcs.iter().collect();
    drop(raster::warp(&refs, &tmp.to_string_lossy(), &args)?);
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    let zone = if (32701..=32760).contains(&epsg) { format!("UTM {}S", epsg - 32700) } else if (32601..=32660).contains(&epsg) { format!("UTM {}N", epsg - 32600) } else { format!("EPSG:{epsg}") };
    let h = register(sc, &out, &name, json!({ "kind": "dem", "title": p_str(p, "title").unwrap_or("Elevation"), "units": "m", "description": label, "credit": if label.starts_with("Copernicus") { "Copernicus DEM (ESA; © DLR, Airbus)" } else { "" } }))?;
    let s = h.info.stats[0].clone();
    let (wk, hk) = km(b);
    sc.cards.push(("Elevation".into(), format!("{}–{} m", fmt0(s.min), fmt0(s.max))));
    sc.methods.push(format!(
        "Elevation: {label}, read over HTTP for a {wk:.1} × {hk:.1} km area ({what}) and resampled (bilinear) to {res:.0} m in {zone}."
    ));
    Ok(StepOut {
        outputs: json!({ "raster": h.info.id, "path": out, "tiles": paths.len() - missing, "epsg": epsg, "resolution": res, "size": [h.info.width, h.info.height],
                         "min": s.min, "max": s.max, "mean": s.mean, "aoi": b, "seconds": t0.elapsed().as_secs_f64() }),
        why: vec![
            format!("area {wk:.1} × {hk:.1} km ({what})"),
            format!("{} {} tile(s) read as cloud-optimised GeoTIFF windows{}", paths.len() - missing, if source.starts_with("copernicus") || source.starts_with("glo") { "Copernicus" } else { "DEM" }, if missing > 0 { format!(" ({missing} missing, e.g. ocean)") } else { String::new() }),
            format!("reprojected to {zone} at {res:.0} m so slopes and distances are in metres: {} × {} px, {}–{} m (mean {})", h.info.width, h.info.height, fmt0(s.min), fmt0(s.max), fmt0(s.mean)),
        ],
    })
}

// ------------------------------------------------------------------ terrain

pub(super) fn terrain_derive(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let dem = pick_raster(sc, p.get("dem"), &["dem"], &[])?;
    let mut products = p_list(p, "products");
    if products.is_empty() {
        products = vec!["hillshade".into(), "slope".into(), "aspect".into()];
    }
    let src0 = raster::open(&dem.info.path)?;
    // slopes need metres: warp geographic DEMs to their UTM zone first
    let (src, note) = if dem.info.geographic {
        let b = dem.info.bounds;
        let epsg = features::utm_epsg((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
        let mut a = raster::strings(&["-of", "MEM", "-r", "bilinear", "-dstnodata", "-9999"]);
        a.extend(["-t_srs".into(), format!("EPSG:{epsg}"), "-tr".into(), dem.info.pixel_m.to_string(), dem.info.pixel_m.to_string()]);
        (raster::warp(&[&src0], "", &a)?, format!(" (warped to EPSG:{epsg} first)"))
    } else {
        (src0, String::new())
    };
    let s = dem.info.stats[0].clone();
    let relief = s.p98 - s.p2;
    let z = p_f64(p, "z").unwrap_or(if relief < 60.0 { 3.0 } else { 1.0 });
    let base = sanitize(p_str(p, "prefix").unwrap_or(""));
    let mut made = Vec::new();
    let mut why = Vec::new();
    for prod in &products {
        let prod = prod.to_ascii_lowercase();
        let (proc_, extra, title, units): (&str, Vec<String>, &str, &str) = match prod.as_str() {
            "hillshade" => ("hillshade", vec!["-multidirectional".into(), "-z".into(), z.to_string()], "Hillshade", ""),
            "slope" => ("slope", vec![], "Slope", "°"),
            "aspect" => ("aspect", vec![], "Aspect", "°"),
            "tri" => ("TRI", raster::strings(&["-alg", "Riley"]), "Terrain ruggedness (TRI)", "m"),
            "tpi" => ("TPI", vec![], "Topographic position (TPI)", "m"),
            "roughness" => ("roughness", vec![], "Roughness", "m"),
            other => return Err(format!("unknown terrain product '{other}' (hillshade, slope, aspect, tri, tpi, roughness)")),
        };
        let name = if base.is_empty() { prod.clone() } else { format!("{base}_{prod}") };
        let out = out_path(sc, &name)?;
        let tmp = out.with_extension("part.tif");
        let mut args = raster::strings(&["-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-compute_edges"]);
        args.extend(extra);
        drop(raster::dem(&src, &tmp.to_string_lossy(), proc_, &args)?);
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        let h = register(sc, &out, &name, json!({ "kind": prod, "title": title, "units": units, "description": format!("from {}", dem.info.title), "credit": dem.info.credit }))?;
        let st = h.info.stats[0].clone();
        match prod.as_str() {
            "slope" => {
                let ds = raster::open(&out)?;
                let (v, _, _) = raster::read_full(&ds, 1)?;
                let valid: Vec<f32> = v.into_iter().filter(|x| x.is_finite() && *x >= 0.0 && *x <= 90.0).collect();
                let steep = valid.iter().filter(|x| **x > 30.0).count() as f64 / valid.len().max(1) as f64 * 100.0;
                sc.cards.push(("Mean slope".into(), format!("{:.1}°", st.mean)));
                sc.cards.push(("Steep (> 30°)".into(), format!("{steep:.0} % of the area")));
                why.push(format!("slope: mean {:.1}°, max {:.0}°, {steep:.0} % steeper than 30°", st.mean, st.max));
            }
            "aspect" => {
                let ds = raster::open(&out)?;
                let (v, _, _) = raster::read_full(&ds, 1)?;
                let mut sectors = [0usize; 8];
                for a in v.iter().filter(|a| a.is_finite() && **a >= 0.0) {
                    sectors[(((*a as f64 + 22.5) % 360.0) / 45.0) as usize % 8] += 1;
                }
                let names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
                let (i, n) = sectors.iter().enumerate().max_by_key(|(_, n)| **n).unwrap();
                let tot: usize = sectors.iter().sum();
                why.push(format!("aspect: most slopes face {} ({:.0} %)", names[i], *n as f64 / tot.max(1) as f64 * 100.0));
            }
            "hillshade" => why.push(format!("hillshade: multidirectional (lit from several azimuths, so no side goes black), z-factor {z}{}", if z > 1.0 { " because the relief is gentle" } else { "" })),
            _ => why.push(format!("{}: {:.1}–{:.1} {units}", title, st.min, st.max)),
        }
        made.push(h.info.id.clone());
    }
    sc.methods.push(format!("Terrain ({}) was derived from {} with GDAL DEM processing (Horn's method){note}.", products.join(", "), dem.info.title));
    Ok(StepOut { outputs: json!({ "rasters": made, "dem": dem.info.id, "z": z }), why })
}

fn nice_step(range: f64, target: f64) -> f64 {
    let raw = (range / target).max(1e-9);
    let mag = 10f64.powf(raw.log10().floor());
    for m in [1.0, 2.0, 2.5, 5.0, 10.0] {
        if m * mag >= raw {
            return m * mag;
        }
    }
    10.0 * mag
}

/// Two rounds of Chaikin corner cutting (endpoints kept; closed rings stay closed).
fn chaikin(pts: &[[f64; 2]], rounds: usize) -> Vec<[f64; 2]> {
    let mut v = pts.to_vec();
    for _ in 0..rounds {
        if v.len() < 3 {
            break;
        }
        let closed = v.first() == v.last();
        let mut o = Vec::with_capacity(v.len() * 2);
        if !closed {
            o.push(v[0]);
        }
        for w in v.windows(2) {
            let (a, b) = (w[0], w[1]);
            o.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
            o.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
        }
        if closed {
            o.push(o[0]);
        } else {
            o.push(*v.last().unwrap());
        }
        v = o;
    }
    v
}

pub(super) fn terrain_contours(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let dem = pick_raster(sc, p.get("dem"), &["dem"], &[])?;
    let ds = raster::open(&dem.info.path)?;
    let s = dem.info.stats[0].clone();
    let interval = match p.get("interval").and_then(Value::as_f64) {
        Some(i) if i > 0.0 => i,
        _ => nice_step(s.max - s.min, 12.0),
    };
    let index_every = p_f64(p, "index").unwrap_or(5.0).max(1.0);
    // fine DEMs (LiDAR, drone surveys) carry centimetre noise that breaks contours into
    // thousands of tiny loops on flat ground: trace them on a 2 m average instead
    let (ds, generalised) = if !dem.info.geographic && dem.info.pixel_m < 1.9 {
        let mut a = raster::strings(&["-of", "MEM", "-r", "average", "-tr", "2", "2"]);
        if let Some(nd) = dem.info.nodata {
            a.extend(["-srcnodata".into(), nd.to_string(), "-dstnodata".into(), nd.to_string()]);
        }
        (raster::warp(&[&ds], "", &a)?, Some(dem.info.pixel_m))
    } else {
        (ds, None)
    };
    let srs = raster::srs_of(&ds).ok_or("DEM has no coordinate system")?;
    let drv = DriverManager::get_driver_by_name("Memory").map_err(|e| e.to_string())?;
    let mut vds = drv.create_vector_only("").map_err(|e| e.to_string())?;
    let lyr = vds
        .create_layer(LayerOptions { name: "contours", srs: Some(&srs), ty: gdal_sys::OGRwkbGeometryType::wkbLineString, options: None })
        .map_err(|e| e.to_string())?;
    lyr.create_defn_fields(&[("id", gdal_sys::OGRFieldType::OFTInteger), ("elev", gdal_sys::OGRFieldType::OFTReal)]).map_err(|e| e.to_string())?;
    let mut opts = vec![format!("LEVEL_INTERVAL={interval}"), "ID_FIELD=0".into(), "ELEV_FIELD=1".into()];
    if let Some(nd) = dem.info.nodata {
        opts.push(format!("NODATA={nd}"));
    }
    let band = ds.rasterband(1).map_err(|e| e.to_string())?;
    let a = raster::csl(&opts)?;
    let err = unsafe { gdal_sys::GDALContourGenerateEx(band.c_rasterband(), lyr.c_layer() as *mut std::ffi::c_void, a.ptr(), None, std::ptr::null_mut()) };
    if err != gdal_sys::CPLErr::CE_None {
        return Err(format!("contours: {}", raster::last_error()));
    }
    drop(lyr);
    let ct = CoordTransform::new(&srs, &raster::wgs84()).map_err(|e| e.to_string())?;
    let mut fs = FeatureSet::new(GeomKind::Line, vec![("elev".into(), "real"), ("index".into(), "integer")]);
    let smooth = p.get("smooth").and_then(Value::as_bool).unwrap_or(true);
    let mut lyr = vds.layer(0).map_err(|e| e.to_string())?;
    let mut n_index = 0;
    for f in lyr.features() {
        let elev = f.field_as_double(1).ok().flatten().unwrap_or(0.0);
        let Some(g) = f.geometry() else { continue };
        let mut parts: Vec<Vec<[f64; 2]>> = Vec::new();
        let mut take = |g: &gdal::vector::Geometry| {
            let n = g.point_count();
            let pts: Vec<[f64; 2]> = (0..n).map(|i| {
                let (x, y, _) = g.get_point(i as i32);
                [x, y]
            }).collect();
            if pts.len() >= 2 {
                parts.push(pts);
            }
        };
        if g.geometry_count() > 0 {
            for i in 0..g.geometry_count() {
                take(&g.get_geometry(i));
            }
        } else {
            take(g);
        }
        let mut lines = Vec::new();
        for pts in parts {
            let pts = if smooth { chaikin(&pts, 2) } else { pts };
            let (mut xs, mut ys): (Vec<f64>, Vec<f64>) = pts.iter().map(|p| (p[0], p[1])).unzip();
            let mut zs = vec![0.0; xs.len()];
            if ct.transform_coords(&mut xs, &mut ys, &mut zs).is_ok() {
                lines.push(xs.into_iter().zip(ys).map(|(x, y)| [x, y]).collect::<Vec<_>>());
            }
        }
        if lines.is_empty() {
            continue;
        }
        let is_index = ((elev / interval).round() as i64) % (index_every as i64) == 0;
        n_index += is_index as usize;
        fs.feats.push(Feat { geom: Geom::Lines(lines), props: vec![Val::Num(elev), Val::Int(is_index as i64)] });
    }
    if fs.feats.is_empty() {
        return Err(format!("no contours at a {interval} m interval (the area is flatter than that; set interval:)"));
    }
    fs.total = fs.feats.len() as u64;
    let name = p_str(p, "name").unwrap_or("contours").to_string();
    let id = sc.write_output(&name, &fs, format!("Contours ({} m)", fmt0(interval)))?;
    sc.hints.insert(id.clone(), json!({ "color": "#8a5a32", "width": 0.6, "opacity": 0.85, "field": "none", "note": format!("{} m · index {} m", fmt0(interval), fmt0(interval * index_every)), "why": "thin brown contour lines with bolder index contours, the cartographic convention for elevation" }));
    let gen_text = generalised.map(|px| format!(" (on a 2 m average of the {px:.2} m DEM, so measurement noise does not break the lines up)")).unwrap_or_default();
    sc.methods.push(format!("Contours every {} m (index contours every {} m) were traced from the DEM with GDAL{gen_text} and smoothed with two rounds of Chaikin corner cutting.", fmt0(interval), fmt0(interval * index_every)));
    Ok(StepOut {
        outputs: json!({ "layer": id, "interval": interval, "lines": fs.feats.len(), "index_lines": n_index }),
        why: vec![format!(
            "interval {} m chosen for a {}–{} m range (≈ 12 levels); {} lines, {} index contours{}",
            fmt0(interval),
            fmt0(s.min),
            fmt0(s.max),
            fs.feats.len(),
            n_index,
            generalised.map(|px| format!(" (traced on a 2 m average of the {px:.2} m DEM)")).unwrap_or_default()
        )],
    })
}

// ------------------------------------------------------------------ classify and sample

fn scheme_for(info: &raster::RasterInfo) -> (Vec<f64>, Vec<String>, Vec<String>) {
    let s = info.stats.first().cloned().unwrap_or_default();
    let strs = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match info.kind.as_str() {
        "slope" => (vec![5.0, 15.0, 30.0], strs(&["flat (< 5°)", "gentle (5–15°)", "moderate (15–30°)", "steep (> 30°)"]), strs(&["#ffffcc", "#fed976", "#fd8d3c", "#bd0026"])),
        "ndvi" | "savi" | "evi" => (
            vec![0.2, 0.4, 0.6],
            strs(&["bare, water or built (< 0.2)", "sparse vegetation (0.2–0.4)", "moderate vegetation (0.4–0.6)", "dense vegetation (> 0.6)"]),
            strs(&["#c8a26a", "#f1e7a6", "#a6d96a", "#1a9641"]),
        ),
        "ndwi" | "ndmi" => (vec![0.0, 0.3], strs(&["dry (< 0)", "moist (0–0.3)", "water / wet (> 0.3)"]), strs(&["#d9c99a", "#9ecae1", "#2171b5"])),
        "chm" => (
            vec![0.5, 2.0, 5.0, 15.0, 30.0],
            strs(&["no vegetation (< 0.5 m)", "low vegetation (0.5–2 m)", "shrubs and young trees (2–5 m)", "trees (5–15 m)", "tall trees (15–30 m)", "very tall trees (> 30 m)"]),
            strs(&["#f0ead6", "#d9f0a3", "#addd8e", "#41ab5d", "#006837", "#00341f"]),
        ),
        "nbr" => (vec![0.1, 0.3, 0.6], strs(&["burnt or bare (< 0.1)", "low vegetation (0.1–0.3)", "moderate (0.3–0.6)", "healthy vegetation (> 0.6)"]), strs(&["#7f2704", "#fdae6b", "#a1d99b", "#238b45"])),
        _ => {
            let step = nice_step(s.p98 - s.p2, 5.0);
            let mut breaks = Vec::new();
            let mut b = (s.p2 / step).ceil() * step;
            while b < s.p98 && breaks.len() < 7 {
                breaks.push(b);
                b += step;
            }
            if breaks.is_empty() {
                breaks.push((s.min + s.max) / 2.0);
            }
            let u = if info.units.is_empty() { String::new() } else { format!(" {}", info.units) };
            let mut labels = Vec::new();
            for i in 0..=breaks.len() {
                labels.push(match i {
                    0 => format!("< {}{u}", fmt0(breaks[0])),
                    i if i == breaks.len() => format!("> {}{u}", fmt0(breaks[i - 1])),
                    i => format!("{}–{}{u}", fmt0(breaks[i - 1]), fmt0(breaks[i])),
                });
            }
            let ramp = if info.kind == "dem" { "terrain" } else { "viridis" };
            let all = raster::ramp_css(ramp);
            let n = labels.len();
            let colors = (0..n).map(|i| all[((i as f64 + 0.5) / n as f64 * all.len() as f64) as usize % all.len()].clone()).collect();
            (breaks, labels, colors)
        }
    }
}

pub(super) fn raster_classify(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let r = pick_raster(sc, p.get("raster"), &[], &["hillshade", "rgb", "classes", "aspect"])?;
    let (mut breaks, mut labels, mut colors) = scheme_for(&r.info);
    let given: Vec<f64> = p.get("breaks").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
    if !given.is_empty() {
        breaks = given;
        labels = p_list(p, "labels");
        if labels.len() != breaks.len() + 1 {
            labels = (0..=breaks.len()).map(|i| match i {
                0 => format!("< {}", breaks[0]),
                i if i == breaks.len() => format!("> {}", breaks[i - 1]),
                i => format!("{}–{}", breaks[i - 1], breaks[i]),
            }).collect();
        }
        let all = raster::ramp_css(p_str(p, "ramp").unwrap_or("viridis"));
        let n = labels.len();
        colors = (0..n).map(|i| all[((i as f64 + 0.5) / n as f64 * all.len() as f64) as usize % all.len()].clone()).collect();
    }
    let custom = p_list(p, "colors");
    if custom.len() == labels.len() {
        colors = custom;
    }
    let ds = raster::open(&r.info.path)?;
    let (v, w, h) = raster::read_full(&ds, 1)?;
    let nd = r.info.nodata;
    let mut counts = vec![0u64; labels.len()];
    let data: Vec<u8> = v
        .iter()
        .map(|x| {
            if !x.is_finite() || nd.is_some_and(|n| (*x as f64 - n).abs() < 1e-6) {
                return 0u8;
            }
            let c = breaks.iter().filter(|b| (*x as f64) >= **b).count();
            counts[c] += 1;
            (c + 1) as u8
        })
        .collect();
    let gt = ds.geo_transform().map_err(|e| e.to_string())?;
    let wkt = ds.spatial_ref().and_then(|s| s.to_wkt()).map_err(|e| e.to_string())?;
    let lat = (r.info.bounds[1] + r.info.bounds[3]) / 2.0;
    let px_m2 = raster::pixel_area_m2(&ds, lat);
    let total: u64 = counts.iter().sum();
    let name = sanitize(p_str(p, "name").map(str::to_string).unwrap_or_else(|| format!("{}_classes", r.info.id.rsplit('.').next().unwrap_or("raster"))).as_str());
    let out = out_path(sc, &name)?;
    raster::write_tif_u8(&out, w, h, gt, &wkt, data, Some(0.0))?;
    let mut table = Vec::new();
    let mut classes = Vec::new();
    for (i, label) in labels.iter().enumerate() {
        let share = counts[i] as f64 / total.max(1) as f64 * 100.0;
        let ha = counts[i] as f64 * px_m2 / 1e4;
        table.push(json!({ "class": i + 1, "label": label, "pixels": counts[i], "area_ha": (ha * 10.0).round() / 10.0, "percent": (share * 10.0).round() / 10.0 }));
        classes.push(json!({ "value": i + 1, "label": format!("{label} · {share:.0} %"), "color": colors[i] }));
    }
    let title = p_str(p, "title").map(str::to_string).unwrap_or_else(|| format!("{} classes", r.info.title));
    let h = register(sc, &out, &name, json!({ "kind": "classes", "title": title, "classes": classes, "description": format!("{} classified", r.info.title) }))?;
    let (bi, bc) = counts.iter().enumerate().max_by_key(|(_, c)| **c).unwrap();
    sc.cards.push((format!("Largest class ({})", r.info.title.split(" · ").next().unwrap_or("")), format!("{} · {:.0} %", labels[bi], *bc as f64 / total.max(1) as f64 * 100.0)));
    sc.methods.push(format!("{} was classified into {} classes (breaks {}); areas use the {:.0} m² pixel area.", r.info.title, labels.len(), breaks.iter().map(|b| super::cartography::fmt_num(*b)).collect::<Vec<_>>().join(", "), px_m2));
    let why = table.iter().map(|t| format!("{}: {} ha ({} %)", t["label"].as_str().unwrap_or(""), t["area_ha"], t["percent"])).collect();
    Ok(StepOut { outputs: json!({ "raster": h.info.id, "classes": table, "source": r.info.id }), why })
}

pub(super) fn raster_sample(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let layer_id = match p_str(p, "layer") {
        Some(l) if l != "auto" => l.to_string(),
        _ => sc.touched.iter().rev().find(|id| sc.layer(id).is_ok_and(|l| l.info.geometry == GeomKind::Point)).cloned().ok_or("raster.sample needs point features: set layer:")?,
    };
    let l = sc.layer(&layer_id)?;
    let mut fs = features::read_layer(sc.engine, &l, None, None, 200_000)?;
    let ids: Vec<String> = match p.get("rasters") {
        Some(v) if !v.is_null() && v.as_str() != Some("auto") => p_list(p, "rasters"),
        _ => sc.rasters.iter().filter(|id| sc.engine.raster(id).is_some_and(|r| !matches!(r.info.kind.as_str(), "hillshade" | "rgb"))).cloned().collect(),
    };
    if ids.is_empty() {
        return Err("no rasters to sample: run dem.fetch / terrain.derive / rs.index first or list rasters:".into());
    }
    let original: Vec<(usize, String)> = fs.fields.iter().enumerate().filter(|(_, (_, t))| *t != "string").map(|(i, (n, _))| (i, n.clone())).collect();
    let mut why = Vec::new();
    let mut added = Vec::new();
    for rid in &ids {
        let r = pick_raster(sc, Some(&json!(rid)), &[], &[])?;
        let ds = raster::open(&r.info.path)?;
        let (v, w, h) = raster::read_full(&ds, 1)?;
        let gt = ds.geo_transform().map_err(|e| e.to_string())?;
        let srs = raster::srs_of(&ds).ok_or("raster has no coordinate system")?;
        let ct = CoordTransform::new(&raster::wgs84(), &srs).map_err(|e| e.to_string())?;
        let mut field = match r.info.kind.as_str() {
            "dem" => "elevation".to_string(),
            "classes" | "raster" => sanitize(&r.info.name),
            k => k.to_string(),
        };
        while fs.field(&field).is_some() {
            field.push_str("_r");
        }
        fs.fields.push((field.clone(), if r.info.kind == "classes" { "integer" } else { "real" }));
        let mut got = 0usize;
        for f in fs.feats.iter_mut() {
            let val = features::anchor(&f.geom).and_then(|c| {
                let (mut xs, mut ys, mut zs) = (vec![c[0]], vec![c[1]], vec![0.0]);
                ct.transform_coords(&mut xs, &mut ys, &mut zs).ok()?;
                let col = ((xs[0] - gt[0]) / gt[1]).floor();
                let row = ((ys[0] - gt[3]) / gt[5]).floor();
                if col < 0.0 || row < 0.0 || col >= w as f64 || row >= h as f64 {
                    return None;
                }
                let x = v[row as usize * w + col as usize];
                (x.is_finite() && !r.info.nodata.is_some_and(|n| (x as f64 - n).abs() < 1e-6)).then_some(x as f64)
            });
            got += val.is_some() as usize;
            f.props.push(match val {
                Some(x) if r.info.kind == "classes" => Val::Int(x as i64),
                Some(x) => Val::Num((x * 10_000.0).round() / 10_000.0),
                None => Val::Null,
            });
        }
        let missing = fs.feats.len() - got;
        why.push(format!("{field} ← {}: {got} values{}", r.info.title, if missing > 0 { format!(" ({missing} outside or masked)") } else { String::new() }));
        added.push(field);
    }
    // quick data-science pass: the strongest correlation between a sampled raster and a measured field
    let mut best: Option<(f64, String, String, usize)> = None;
    for af in &added {
        let ai = fs.field(af).unwrap();
        for (oi, on) in &original {
            let pairs: Vec<(f64, f64)> = fs.feats.iter().filter_map(|f| Some((f.props[ai].as_f64()?, f.props[*oi].as_f64()?))).collect();
            if pairs.len() < 8 {
                continue;
            }
            let n = pairs.len() as f64;
            let (mx, my) = (pairs.iter().map(|p| p.0).sum::<f64>() / n, pairs.iter().map(|p| p.1).sum::<f64>() / n);
            let (sxy, sxx, syy) = pairs.iter().fold((0.0, 0.0, 0.0), |a, (x, y)| (a.0 + (x - mx) * (y - my), a.1 + (x - mx).powi(2), a.2 + (y - my).powi(2)));
            if sxx <= 0.0 || syy <= 0.0 {
                continue;
            }
            let r = sxy / (sxx * syy).sqrt();
            if best.as_ref().is_none_or(|b| r.abs() > b.0.abs()) {
                best = Some((r, af.clone(), on.clone(), pairs.len()));
            }
        }
    }
    let mut corr = Value::Null;
    if let Some((r, a, o, n)) = &best {
        let strength = match r.abs() {
            x if x >= 0.7 => "strong",
            x if x >= 0.4 => "moderate",
            x if x >= 0.2 => "weak",
            _ => "no clear",
        };
        why.push(format!("strongest relationship: {o} vs {a}, Pearson r = {r:.2} ({strength}, n = {n})"));
        sc.cards.push((format!("{o} vs {a}"), format!("r = {r:.2} ({strength})")));
        corr = json!({ "field": o, "raster_field": a, "r": (r * 1000.0).round() / 1000.0, "n": n, "strength": strength });
    }
    let name = p_str(p, "name").map(str::to_string).unwrap_or_else(|| format!("{}_sampled", l.info.name));
    let title = format!("{} + {}", sc.title_of(&l), added.join(", "));
    let id = sc.write_output(&name, &fs, title)?;
    sc.methods.push(format!("Raster values ({}) were extracted at each of the {} points of {} (nearest cell).", added.join(", "), fs.feats.len(), sc.title_of(&l)));
    Ok(StepOut { outputs: json!({ "layer": id, "fields": added, "points": fs.feats.len(), "correlation": corr }), why })
}

// ------------------------------------------------------------------ remote sensing (STAC + COG)

fn scene_summary(s: &Value) -> String {
    format!("{} {} ({:.0} % cloud, tile {})", s["date"].as_str().unwrap_or(""), s["platform"].as_str().unwrap_or(""), s["cloud"].as_f64().unwrap_or(0.0), s["tile"].as_str().unwrap_or("?"))
}

fn covers(geom: &Value, b: [f64; 4]) -> bool {
    let rings: Vec<Vec<[f64; 2]>> = match geom["type"].as_str() {
        Some("Polygon") => geom["coordinates"].as_array().into_iter().flatten().take(1).map(ring).collect(),
        Some("MultiPolygon") => geom["coordinates"].as_array().into_iter().flatten().filter_map(|p| p.as_array().and_then(|r| r.first())).map(ring).collect(),
        _ => vec![],
    };
    fn ring(r: &Value) -> Vec<[f64; 2]> {
        r.as_array().into_iter().flatten().filter_map(|c| Some([c.get(0)?.as_f64()?, c.get(1)?.as_f64()?])).collect()
    }
    [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].iter().all(|c| rings.iter().any(|r| super::steps::point_in_ring(*c, r)))
}

pub(super) fn rs_search(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let (b, what) = aoi(sc, p)?;
    let collection = p_str(p, "collection").unwrap_or("sentinel-2-l2a").to_string();
    let endpoint = p_str(p, "endpoint").unwrap_or(EARTH_SEARCH).trim_end_matches('/').to_string();
    let max_cloud = p_f64(p, "max_cloud").unwrap_or(40.0);
    let days = p_f64(p, "days").unwrap_or(90.0);
    let datetime = match p_str(p, "datetime") {
        Some(d) => d.to_string(),
        None => {
            // `ago` moves the window back (365 = the same season last year), for before / after pairs
            let end = chrono::Utc::now() - chrono::Duration::seconds((p_f64(p, "ago").unwrap_or(0.0).max(0.0) * 86400.0) as i64);
            let start = end - chrono::Duration::seconds((days * 86400.0) as i64);
            format!("{}/{}", start.format("%Y-%m-%dT%H:%M:%SZ"), end.format("%Y-%m-%dT%H:%M:%SZ"))
        }
    };
    let limit = p_f64(p, "limit").unwrap_or(30.0) as usize;
    let body = json!({
        "collections": [collection], "bbox": b, "datetime": datetime, "limit": limit,
        "query": { "eo:cloud_cover": { "lt": max_cloud } },
        "sortby": [{ "field": "properties.datetime", "direction": "desc" }],
    });
    let bytes = raster::http(&format!("{endpoint}/search"), Some(&body.to_string()), 45)?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("STAC search: {e}"))?;
    let mut scenes: Vec<Value> = Vec::new();
    for f in v["features"].as_array().into_iter().flatten() {
        let pr = &f["properties"];
        let epsg = pr["proj:epsg"].as_u64().or_else(|| pr["proj:code"].as_str().and_then(|c| c.trim_start_matches("EPSG:").parse().ok()));
        let mut assets = serde_json::Map::new();
        let baseline: f64 = pr["s2:processing_baseline"].as_str().and_then(|s| s.parse().ok()).unwrap_or(5.0);
        for (k, a) in f["assets"].as_object().into_iter().flatten() {
            let Some(href) = a["href"].as_str() else { continue };
            if !href.starts_with("http") {
                continue;
            }
            let rb = &a["raster:bands"][0];
            let scale = rb["scale"].as_f64().unwrap_or(0.0001);
            // Earth Search stores harmonised values (boa_offset_applied) yet still lists offset -0.1
            let offset = if pr["earthsearch:boa_offset_applied"].as_bool() == Some(true) { 0.0 } else { rb["offset"].as_f64().unwrap_or(if baseline >= 4.0 { -0.1 } else { 0.0 }) };
            assets.insert(k.clone(), json!({ "href": href, "scale": scale, "offset": offset }));
        }
        let tile = pr["s2:mgrs_tile"].as_str().map(str::to_string).unwrap_or_else(|| {
            format!("{}{}{}", pr["mgrs:utm_zone"].as_u64().map(|z| z.to_string()).unwrap_or_default(), pr["mgrs:latitude_band"].as_str().unwrap_or(""), pr["mgrs:grid_square"].as_str().unwrap_or(""))
        });
        scenes.push(json!({
            "id": f["id"], "date": pr["datetime"].as_str().unwrap_or("").get(..10).unwrap_or(""), "datetime": pr["datetime"],
            "cloud": pr["eo:cloud_cover"].as_f64().unwrap_or(100.0), "platform": pr["platform"].as_str().unwrap_or("").to_uppercase().replace("SENTINEL-", "S"),
            "tile": tile, "epsg": epsg, "covers": covers(&f["geometry"], b), "collection": collection, "assets": assets,
        }));
    }
    // newest first; on the same day prefer the tile that covers the whole area, then less cloud
    scenes.sort_by(|a, c| {
        c["date"].as_str().cmp(&a["date"].as_str()).then(c["covers"].as_bool().cmp(&a["covers"].as_bool())).then(a["cloud"].as_f64().partial_cmp(&c["cloud"].as_f64()).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut seen = std::collections::HashSet::new();
    scenes.retain(|s| seen.insert(s["date"].as_str().unwrap_or("").to_string()));
    if scenes.is_empty() {
        return Err(format!("no {collection} scenes over the area in {datetime} with < {max_cloud:.0} % cloud (try days: 180 or max_cloud: 70)"));
    }
    let n = scenes.len();
    sc.scenes = scenes.clone();
    let best = scenes[0].clone();
    let (wk, hk) = km(b);
    Ok(StepOut {
        outputs: json!({ "count": n, "best": best, "scenes": scenes.iter().take(10).map(|s| json!({ "id": s["id"], "date": s["date"], "cloud": s["cloud"], "tile": s["tile"], "covers": s["covers"] })).collect::<Vec<_>>(), "aoi": b, "seconds": t0.elapsed().as_secs_f64() }),
        why: vec![
            format!("searched {collection} on {} for a {wk:.1} × {hk:.1} km area ({what}), last {days:.0} days, < {max_cloud:.0} % cloud", endpoint.trim_start_matches("https://").split('/').next().unwrap_or("")),
            format!("{n} dates found; newest first: {}", scenes.iter().take(3).map(scene_summary).collect::<Vec<_>>().join("; ")),
        ],
    })
}

fn grid_args(epsg: u64, b: [f64; 4], res: f64, resample: &str) -> Vec<String> {
    let mut a = raster::strings(&["-of", "MEM", "-tap", "-r", resample]);
    a.extend(["-t_srs".into(), format!("EPSG:{epsg}"), "-te_srs".into(), "EPSG:4326".into(), "-te".into(), b[0].to_string(), b[1].to_string(), b[2].to_string(), b[3].to_string(), "-tr".into(), res.to_string(), res.to_string()]);
    a
}

fn read_asset(scene: &Value, key: &str, b: [f64; 4], res: f64, resample: &str) -> Result<(gdal::Dataset, Vec<f32>, usize, usize), String> {
    let href = scene["assets"][key]["href"].as_str().ok_or(format!("scene {} has no '{key}' band", scene["id"]))?;
    let epsg = scene["epsg"].as_u64().ok_or("scene has no projection")?;
    let src = raster::open(Path::new(&format!("/vsicurl/{href}")))?;
    let mem = raster::warp(&[&src], "", &grid_args(epsg, b, res, resample))?;
    let (v, w, h) = raster::read_full(&mem, 1)?;
    Ok((mem, v, w, h))
}

fn human_date(d: &str) -> String {
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map(|x| x.format("%-d %b %Y").to_string()).unwrap_or_else(|_| d.to_string())
}

pub(super) fn rs_index(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let index = p_str(p, "index").unwrap_or("ndvi").to_ascii_lowercase();
    let bands: &[&str] = match index.as_str() {
        "ndvi" | "savi" => &["red", "nir"],
        "ndwi" => &["green", "nir"],
        "nbr" => &["nir", "swir22"],
        "ndmi" => &["nir", "swir16"],
        "evi" => &["blue", "red", "nir"],
        other => return Err(format!("unknown index '{other}' (ndvi, ndwi, nbr, ndmi, savi, evi)")),
    };
    let mut why = Vec::new();
    if sc.scenes.is_empty() {
        let s = rs_search(sc, p)?;
        why.extend(s.why);
    }
    let (b, _) = aoi(sc, p)?;
    let mut min_clear = p_f64(p, "min_clear").unwrap_or(0.7);
    if min_clear > 1.0 {
        min_clear /= 100.0;
    }
    let tries = p_f64(p, "max_tries").unwrap_or(5.0) as usize;
    let res = p_f64(p, "resolution").unwrap_or(10.0);
    let mask = p.get("mask").and_then(Value::as_bool).unwrap_or(true);
    let scenes = sc.scenes.clone();
    let mut skipped = Vec::new();
    for scene in scenes.iter().take(tries.max(1)) {
        if sc.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        // cloud check first, on the 20 m scene classification (one small read)
        let (scl_ds, scl, w, h) = read_asset(scene, "scl", b, res, "near")?;
        let total = scl.iter().filter(|c| **c > 0.0).count().max(1);
        let clear = scl.iter().filter(|c| matches!(**c as u8, 2 | 4 | 5 | 6 | 7 | 11)).count();
        let clear_frac = clear as f64 / total as f64;
        if clear_frac < min_clear {
            skipped.push(format!("{}: only {:.0} % clear over the area", scene_summary(scene), clear_frac * 100.0));
            continue;
        }
        let mut refl: Vec<Vec<f32>> = Vec::new();
        for key in bands {
            let (_, v, bw, bh) = read_asset(scene, key, b, res, "bilinear")?;
            if (bw, bh) != (w, h) {
                return Err(format!("band grids differ ({bw}×{bh} vs {w}×{h})"));
            }
            let sc_ = scene["assets"][key]["scale"].as_f64().unwrap_or(0.0001) as f32;
            let off = scene["assets"][key]["offset"].as_f64().unwrap_or(-0.1) as f32;
            refl.push(v.into_iter().map(|dn| if dn <= 0.0 { f32::NAN } else { dn * sc_ + off }).collect());
        }
        let nd = NODATA as f32;
        let mut masked = 0usize;
        let out_v: Vec<f32> = (0..w * h)
            .map(|i| {
                let c = scl[i] as u8;
                if c == 0 || (mask && matches!(c, 1 | 3 | 8 | 9 | 10)) {
                    masked += (c != 0) as usize;
                    return nd;
                }
                let g = |k: usize| refl[k][i];
                let v = match index.as_str() {
                    // bands are [red, nir] for NDVI/SAVI and [first, second] = (a - b) / (a + b) for NDWI, NBR, NDMI
                    "ndvi" => (g(1) - g(0)) / (g(1) + g(0)),
                    "ndwi" | "nbr" | "ndmi" => (g(0) - g(1)) / (g(0) + g(1)),
                    "savi" => 1.5 * (g(1) - g(0)) / (g(1) + g(0) + 0.5),
                    "evi" => 2.5 * (g(2) - g(1)) / (g(2) + 6.0 * g(1) - 7.5 * g(0) + 1.0),
                    _ => f32::NAN,
                };
                if v.is_finite() { v.clamp(-1.0, 1.0) } else { nd }
            })
            .collect();
        let gt = scl_ds.geo_transform().map_err(|e| e.to_string())?;
        let wkt = scl_ds.spatial_ref().and_then(|s| s.to_wkt()).map_err(|e| e.to_string())?;
        let name = sanitize(p_str(p, "name").unwrap_or(&index));
        let out = out_path(sc, &name)?;
        raster::write_tif_f32(&out, w, h, gt, &wkt, out_v, Some(NODATA))?;
        let date = scene["date"].as_str().unwrap_or("").to_string();
        let title = format!("{} · Sentinel-2 · {}", index.to_uppercase(), human_date(&date));
        let desc = format!("{} · {:.0} % cloud in the scene, {:.0} % clear over the area · © Copernicus Sentinel data {}", scene["id"].as_str().unwrap_or(""), scene["cloud"].as_f64().unwrap_or(0.0), clear_frac * 100.0, &date.get(..4).unwrap_or(""));
        let hnd = register(sc, &out, &name, json!({ "kind": index, "title": title, "units": "", "description": desc, "scene": scene["id"], "date": date, "credit": format!("Copernicus Sentinel-2 data {} (ESA)", date.get(..4).unwrap_or("")) }))?;
        let st = hnd.info.stats[0].clone();
        // the chosen scene goes first, so rs.fetch and the report use the same date
        sc.scenes.retain(|s| s["id"] != scene["id"]);
        sc.scenes.insert(0, scene.clone());
        let ds = raster::open(&out)?;
        let (vals, _, _) = raster::read_full(&ds, 1)?;
        let good: Vec<f32> = vals.into_iter().filter(|x| *x > -1.5).collect();
        let dense = good.iter().filter(|x| **x >= 0.6).count() as f64 / good.len().max(1) as f64 * 100.0;
        sc.cards.push((format!("Mean {}", index.to_uppercase()), format!("{:.2} ({})", st.mean, human_date(&date))));
        if index == "ndvi" {
            sc.cards.push(("Dense vegetation".into(), format!("{dense:.0} % of clear pixels")));
        }
        sc.cards.push(("Clear over the area".into(), format!("{:.0} %", clear_frac * 100.0)));
        sc.methods.push(format!(
            "{} was computed from Sentinel-2 L2A surface reflectance ({}, scene {}, tile {}) read as {} m cloud-optimised GeoTIFF windows from Earth Search (AWS); clouds, cloud shadows and cirrus (scene classes 3, 8, 9, 10) were masked{}.",
            index.to_uppercase(),
            human_date(&date),
            scene["id"].as_str().unwrap_or(""),
            scene["tile"].as_str().unwrap_or(""),
            res,
            if skipped.is_empty() { String::new() } else { format!("; {} newer date(s) were skipped as too cloudy", skipped.len()) }
        ));
        why.extend(skipped.iter().map(|s| format!("skipped {s}")));
        why.push(format!("used {}: {:.0} % clear over the area (needed {:.0} %), {} × {} px at {res:.0} m", scene_summary(scene), clear_frac * 100.0, min_clear * 100.0, w, h));
        why.push(format!("{}: mean {:.2}, 2–98 % range {:.2}…{:.2}{}", index.to_uppercase(), st.mean, st.p2, st.p98, if masked > 0 { format!("; {masked} cloudy pixels masked") } else { String::new() }));
        return Ok(StepOut {
            outputs: json!({ "raster": hnd.info.id, "scene": scene["id"], "date": date, "cloud": scene["cloud"], "clear": (clear_frac * 1000.0).round() / 1000.0,
                             "mean": st.mean, "p2": st.p2, "p98": st.p98, "skipped": skipped.len(), "size": [w, h], "seconds": t0.elapsed().as_secs_f64() }),
            why,
        });
    }
    Err(format!("no scene was clear enough over the area (needed {:.0} % clear): {}", min_clear * 100.0, skipped.join("; ")))
}

pub(super) fn rs_fetch(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let mut why = Vec::new();
    if sc.scenes.is_empty() {
        why.extend(rs_search(sc, p)?.why);
    }
    let (b, _) = aoi(sc, p)?;
    let scene = match p_str(p, "scene") {
        Some(id) if id != "auto" => sc.scenes.iter().find(|s| s["id"] == id).cloned().ok_or(format!("scene '{id}' was not in the search results"))?,
        _ => sc.scenes[0].clone(),
    };
    let asset = p_str(p, "asset").unwrap_or("visual").to_string();
    let res = p_f64(p, "resolution").unwrap_or(10.0);
    let href = scene["assets"][&asset]["href"].as_str().ok_or(format!("scene has no '{asset}' asset"))?;
    let epsg = scene["epsg"].as_u64().ok_or("scene has no projection")?;
    let src = raster::open(Path::new(&format!("/vsicurl/{href}")))?;
    let mem = raster::warp(&[&src], "", &grid_args(epsg, b, res, "bilinear"))?;
    let name = sanitize(p_str(p, "name").unwrap_or(if asset == "visual" { "truecolor" } else { &asset }));
    let out = out_path(sc, &name)?;
    raster::save_gtiff(&mem, &out, false)?;
    let date = scene["date"].as_str().unwrap_or("").to_string();
    let title = format!("Sentinel-2 {} · {}", if asset == "visual" { "true colour" } else { asset.as_str() }, human_date(&date));
    let h = register(sc, &out, &name, json!({ "kind": if asset == "visual" { "rgb" } else { "raster" }, "title": title, "description": format!("Sentinel-2 true colour · {} · © Copernicus Sentinel data", human_date(&date)), "credit": format!("Copernicus Sentinel-2 data {} (ESA)", date.get(..4).unwrap_or("")) }))?;
    sc.methods.push(format!("Background imagery: Sentinel-2 {} of {} (scene {}).", if asset == "visual" { "true-colour composite" } else { asset.as_str() }, human_date(&date), scene["id"].as_str().unwrap_or("")));
    why.push(format!("{} of {}: {} × {} px at {res:.0} m", asset, scene_summary(&scene), h.info.width, h.info.height));
    Ok(StepOut { outputs: json!({ "raster": h.info.id, "scene": scene["id"], "date": date }), why })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copernicus_tile_names() {
        let t = copernicus_tiles([144.18, -5.92, 144.30, -5.80], 30);
        assert_eq!(t.len(), 1);
        assert!(t[0].ends_with("Copernicus_DSM_COG_10_S06_00_E144_00_DEM/Copernicus_DSM_COG_10_S06_00_E144_00_DEM.tif"));
        assert_eq!(copernicus_tiles([-0.5, 51.2, 0.5, 51.8], 30).len(), 2);
        assert!(copernicus_tiles([-0.5, 51.2, 0.5, 51.8], 90)[0].contains("COG_30_N51_00_W001_00"));
    }

    #[test]
    fn nice_steps_and_smoothing() {
        assert_eq!(nice_step(1180.0, 12.0), 100.0);
        assert_eq!(nice_step(260.0, 12.0), 25.0);
        assert_eq!(nice_step(9.0, 12.0), 1.0);
        let s = chaikin(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], 2);
        assert_eq!(s.first(), Some(&[0.0, 0.0]));
        assert_eq!(s.last(), Some(&[1.0, 1.0]));
        let ring = chaikin(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]], 1);
        assert_eq!(ring.first(), ring.last());
    }

    #[test]
    fn footprint_cover() {
        let g = json!({ "type": "Polygon", "coordinates": [[[144.0, -6.5], [145.0, -6.5], [145.0, -5.0], [144.0, -5.0], [144.0, -6.5]]] });
        assert!(covers(&g, [144.18, -5.92, 144.30, -5.80]));
        assert!(!covers(&g, [143.9, -5.92, 144.30, -5.80]));
    }
}
