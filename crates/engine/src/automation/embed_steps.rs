//! Satellite embeddings (docs/AI.md §3): Google DeepMind's AlphaEarth Foundations annual embeddings,
//! 64 numbers per 10 m pixel that summarise a year of Sentinel-1/-2, Landsat, elevation and climate
//! observations. Pixels that look alike over the year have similar vectors, so a few clicks or
//! samples are enough to map places like them, group the landscape, classify it or find change.
//!
//! Steps: embeddings.fetch (read the area from the public copy on Source Cooperative, CC-BY 4.0),
//! embeddings.similar, embeddings.cluster, embeddings.classify, embeddings.change.
//!
//! The copy's GeoTIFFs are stored bottom-up; the `.vrt` next to each one flips it, so only VRTs are
//! read. Which files cover an area is not in their names: a zone's file list and each file's extent
//! (the first 2 KB of its VRT) are read once and cached in `<state>/aef/`.

use std::path::{Path, PathBuf};
use std::time::Instant;

use gdal::spatial_ref::{CoordTransform, SpatialRef};
use rayon::prelude::*;
use serde_json::{json, Value};

use super::features::{self, Val};
use super::raster_steps::{aoi, fmt0, out_path, register};
use super::steps::{p_f64, p_str, sanitize, StepCtx, StepOut};
use crate::raster;

/// The public copy (AWS us-west-2, no account needed). `GEOSPAX_AEF_BASE` points at a mirror.
pub const AEF_BASE: &str = "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/tge-labs/aef/v1/annual";
pub const AEF_CREDIT: &str = "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind (CC-BY 4.0)";
/// Short credit for map credits (every raster made from the embeddings carries it).
const CREDIT_SHORT: &str = "AlphaEarth Foundations (Google, Google DeepMind), CC-BY 4.0";
pub const FIRST_YEAR: i32 = 2017;
pub const LAST_YEAR: i32 = 2025;
const DIMS: usize = 64;
const NODATA_I8: i8 = -128;
/// Largest output, in pixels (64 bytes each).
const MAX_PIXELS: f64 = 4.0e6;

fn base() -> String {
    std::env::var("GEOSPAX_AEF_BASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| AEF_BASE.to_string()).trim_end_matches('/').to_string()
}

/// int8 → value in [-1, 1]: (v / 127.5)² with the sign of v (the dataset's de-quantisation).
fn dequant_table() -> [f32; 256] {
    let mut t = [0f32; 256];
    for (i, slot) in t.iter_mut().enumerate() {
        let v = i as u8 as i8 as f32;
        *slot = (v / 127.5).powi(2) * v.signum();
    }
    t
}

// ------------------------------------------------------------------ which files

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct Tile {
    /// path under the base, e.g. 2024/55S/x03…-0000000000-0000008192.vrt
    path: String,
    epsg: u32,
    /// UTM [west, south, east, north]
    bounds: [f64; 4],
}

/// Zones (e.g. "55S") an area touches.
fn zones(b: [f64; 4]) -> Vec<String> {
    let z = |lon: f64| (((lon + 180.0) / 6.0).floor() as i32).clamp(0, 59) + 1;
    let mut out = Vec::new();
    for zone in z(b[0])..=z(b[2] - 1e-9) {
        if b[1] < 0.0 {
            out.push(format!("{zone}S"));
        }
        if b[3] >= 0.0 {
            out.push(format!("{zone}N"));
        }
    }
    out
}

fn zone_epsg(zone: &str) -> u32 {
    let n: u32 = zone[..zone.len() - 1].parse().unwrap_or(1);
    if zone.ends_with('S') { 32700 + n } else { 32600 + n }
}

fn tag<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{name}>"), format!("</{name}>"));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(&after[..j]);
        rest = &after[j + close.len()..];
    }
    out
}

/// GeoTransform and size from the head of a VRT → UTM bounds.
fn vrt_bounds(head: &str) -> Option<[f64; 4]> {
    let attr = |k: &str| -> Option<f64> {
        let i = head.find(&format!("{k}=\""))? + k.len() + 2;
        head[i..].split('"').next()?.parse().ok()
    };
    let (w, h) = (attr("rasterXSize")?, attr("rasterYSize")?);
    let gt: Vec<f64> = tag(head, "GeoTransform").first()?.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    if gt.len() != 6 {
        return None;
    }
    let (x0, y0) = (gt[0], gt[3]);
    let (x1, y1) = (x0 + w * gt[1], y0 + h * gt[5]);
    Some([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)])
}

/// Every file of one year and zone with its extent (cached).
fn zone_index(cache: &Path, year: i32, zone: &str) -> Result<Vec<Tile>, String> {
    let file = cache.join(format!("{year}-{zone}.json"));
    if let Ok(b) = std::fs::read(&file) {
        if let Ok(t) = serde_json::from_slice::<Vec<Tile>>(&b) {
            return Ok(t);
        }
    }
    let base = base();
    let epsg = zone_epsg(zone);
    let mut vrts: Vec<String> = Vec::new();
    if base.starts_with("http") {
        // S3 listing of the zone folder (1000 keys a page)
        let (root, prefix) = base.split_once("/tge-labs/").map(|(r, p)| (r.to_string(), format!("tge-labs/{p}"))).ok_or("unexpected embeddings address")?;
        let mut token: Option<String> = None;
        loop {
            let mut url = format!("{root}?list-type=2&prefix={prefix}/{year}/{zone}/");
            if let Some(t) = &token {
                url.push_str(&format!("&continuation-token={}", t.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D")));
            }
            let xml = String::from_utf8_lossy(&raster::http(&url, None, 60)?).into_owned();
            for k in tag(&xml, "Key").into_iter().filter(|k| k.ends_with(".vrt")) {
                vrts.push(k.trim_start_matches(&format!("{prefix}/")).to_string());
            }
            token = tag(&xml, "NextContinuationToken").first().map(|s| s.to_string());
            if token.is_none() {
                break;
            }
        }
    } else {
        let dir = Path::new(&base).join(year.to_string()).join(zone);
        for e in std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.ends_with(".vrt") {
                vrts.push(format!("{year}/{zone}/{n}"));
            }
        }
    }
    if vrts.is_empty() {
        return Err(format!("no embeddings for {year} in UTM zone {zone} (the dataset covers {FIRST_YEAR}–{LAST_YEAR})"));
    }
    // the extent is in the first lines of each VRT: read 2 KB of each, 32 requests at a time (waiting
    // on the network, not the CPU, so a pool of its own rather than the engine's)
    let pool = rayon::ThreadPoolBuilder::new().num_threads(32).build().map_err(|e| e.to_string())?;
    let tiles: Vec<Tile> = pool.install(|| vrts
        .par_iter()
        .with_max_len(1)
        .filter_map(|p| {
            let head = if base.starts_with("http") {
                raster::http_with(&format!("{base}/{p}"), None, &[("Range", "bytes=0-2047")], 60).ok()?
            } else {
                std::fs::read(Path::new(&base).join(p)).ok()?
            };
            let text = String::from_utf8_lossy(&head[..head.len().min(4096)]).into_owned();
            Some(Tile { path: p.clone(), epsg, bounds: vrt_bounds(&text)? })
        })
        .collect());
    if tiles.len() < vrts.len() / 2 {
        return Err(format!("could read the extent of only {} of {} embedding files for {year} {zone}; try again", tiles.len(), vrts.len()));
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let _ = std::fs::write(&file, serde_json::to_vec(&tiles).unwrap_or_default());
    Ok(tiles)
}

/// The area as a UTM box in `epsg` (corners and edge midpoints, so the box contains it).
fn utm_box(b: [f64; 4], epsg: u32) -> Result<[f64; 4], String> {
    let mut dst = SpatialRef::from_epsg(epsg).map_err(|e| e.to_string())?;
    dst.set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);
    let ct = CoordTransform::new(&raster::wgs84(), &dst).map_err(|e| e.to_string())?;
    let (mx, my) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
    let mut xs = vec![b[0], b[2], b[0], b[2], mx, mx, b[0], b[2]];
    let mut ys = vec![b[1], b[1], b[3], b[3], b[1], b[3], my, my];
    let mut zs = vec![0.0; xs.len()];
    ct.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
    Ok([
        xs.iter().cloned().fold(f64::MAX, f64::min),
        ys.iter().cloned().fold(f64::MAX, f64::min),
        xs.iter().cloned().fold(f64::MIN, f64::max),
        ys.iter().cloned().fold(f64::MIN, f64::max),
    ])
}

fn overlaps(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

// ------------------------------------------------------------------ reading an embedding raster

/// A fetched embedding raster in memory: 64 int8 per pixel, row by row.
pub struct Emb {
    pub w: usize,
    pub h: usize,
    pub gt: [f64; 6],
    pub wkt: String,
    pub epsg: Option<u32>,
    pub data: Vec<i8>,
}

impl Emb {
    pub fn open(path: &Path) -> Result<Emb, String> {
        let ds = raster::open(path)?;
        if ds.raster_count() != DIMS {
            return Err(format!("{} has {} bands, not the 64 of an embedding raster", path.display(), ds.raster_count()));
        }
        let (w, h) = ds.raster_size();
        let gt = ds.geo_transform().map_err(|e| e.to_string())?;
        let srs = raster::srs_of(&ds);
        let wkt = srs.as_ref().and_then(|s| s.to_wkt().ok()).unwrap_or_default();
        let epsg = srs.as_ref().and_then(|s| s.auth_code().ok()).map(|c| c as u32);
        let mut data = vec![NODATA_I8; w * h * DIMS];
        for b in 0..DIMS {
            let band = ds.rasterband(b + 1).map_err(|e| e.to_string())?;
            let v = band.read_as::<i8>((0, 0), (w, h), (w, h), None).map_err(|e| e.to_string())?.into_shape_and_vec().1;
            for (i, x) in v.into_iter().enumerate() {
                data[i * DIMS + b] = x;
            }
        }
        Ok(Emb { w, h, gt, wkt, epsg, data })
    }

    pub fn n(&self) -> usize {
        self.w * self.h
    }
    pub fn valid(&self, i: usize) -> bool {
        self.data[i * DIMS] != NODATA_I8
    }
    pub fn vec(&self, i: usize, t: &[f32; 256]) -> [f32; DIMS] {
        let mut v = [0f32; DIMS];
        for (k, slot) in v.iter_mut().enumerate() {
            *slot = t[self.data[i * DIMS + k] as u8 as usize];
        }
        v
    }
    /// Pixel index under a lon/lat point.
    pub fn pixel_at(&self, ct: &CoordTransform, lon: f64, lat: f64) -> Option<usize> {
        let (mut xs, mut ys, mut zs) = (vec![lon], vec![lat], vec![0.0]);
        ct.transform_coords(&mut xs, &mut ys, &mut zs).ok()?;
        let col = ((xs[0] - self.gt[0]) / self.gt[1]).floor();
        let row = ((ys[0] - self.gt[3]) / self.gt[5]).floor();
        (col >= 0.0 && row >= 0.0 && (col as usize) < self.w && (row as usize) < self.h).then(|| row as usize * self.w + col as usize)
    }
    fn to_pixels(&self) -> Result<CoordTransform, String> {
        let mut s = SpatialRef::from_wkt(&self.wkt).map_err(|e| e.to_string())?;
        s.set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);
        CoordTransform::new(&raster::wgs84(), &s).map_err(|e| e.to_string())
    }
    fn pixel_area_ha(&self) -> f64 {
        (self.gt[1] * self.gt[5]).abs() / 10_000.0
    }
}

pub fn dot(a: &[f32; DIMS], b: &[f32; DIMS]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn normalize(v: &mut [f32; DIMS]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

/// Write a one-band result on the embedding's grid.
fn write_band<T: gdal::raster::GdalType + Copy>(e: &Emb, path: &Path, data: Vec<T>, nodata: f64) -> Result<(), String> {
    let drv = gdal::DriverManager::get_driver_by_name("GTiff").map_err(|e| e.to_string())?;
    let tmp = path.with_extension("part.tif");
    {
        let opts = gdal::raster::RasterCreationOptions::from_iter(["COMPRESS=DEFLATE", "TILED=YES"]);
        let mut ds = drv.create_with_band_type_with_options::<T, _>(&tmp, e.w, e.h, 1, &opts).map_err(|e| e.to_string())?;
        ds.set_geo_transform(&e.gt).map_err(|e| e.to_string())?;
        if !e.wkt.is_empty() {
            ds.set_projection(&e.wkt).map_err(|e| e.to_string())?;
        }
        let mut band = ds.rasterband(1).map_err(|e| e.to_string())?;
        band.set_no_data_value(Some(nodata)).map_err(|e| e.to_string())?;
        let mut buf = gdal::raster::Buffer::new((e.w, e.h), data);
        band.write((0, 0), (e.w, e.h), &mut buf).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The embedding raster a step works on: `embeddings:` (raster id or path), else the newest this run made.
fn pick(sc: &StepCtx, p: &Value, key: &str) -> Result<(PathBuf, String), String> {
    match p_str(p, key) {
        Some(s) if s != "auto" => {
            if let Some(r) = sc.engine.raster(s) {
                return Ok((r.info.path.clone(), r.info.title.clone()));
            }
            let path = sc.resolve_path(s).ok_or_else(|| format!("no embedding raster '{s}' (run embeddings.fetch first)"))?;
            Ok((path, s.to_string()))
        }
        _ => sc
            .rasters
            .iter()
            .rev()
            .filter_map(|id| sc.engine.raster(id))
            .find(|r| r.info.kind == "embedding")
            .map(|r| (r.info.path.clone(), r.info.title.clone()))
            .ok_or_else(|| "no embeddings yet: run embeddings.fetch first".into()),
    }
}

// ------------------------------------------------------------------ steps

pub(super) fn fetch(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let (b, what) = aoi(sc, p)?;
    let year = p_f64(p, "year").map(|y| y as i32).unwrap_or(LAST_YEAR - 1);
    if !(FIRST_YEAR..=LAST_YEAR).contains(&year) {
        return Err(format!("embeddings exist for {FIRST_YEAR}–{LAST_YEAR}, not {year}"));
    }
    let (lon, lat) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
    let epsg = p_f64(p, "epsg").map(|e| e as u32).unwrap_or_else(|| features::utm_epsg(lon, lat));
    let ob = utm_box(b, epsg)?;
    let (wm, hm) = (ob[2] - ob[0], ob[3] - ob[1]);
    let max_km = p_f64(p, "max_km").unwrap_or(60.0);
    if wm.max(hm) > max_km * 1000.0 {
        return Err(format!("the area is {:.0} × {:.0} km; embeddings are read for at most {max_km:.0} km a side (zoom in, or set max_km)", wm / 1000.0, hm / 1000.0));
    }
    // 10 m is native; larger areas are read coarser (GDAL takes the file's averaged overviews)
    let mut res = p_f64(p, "resolution").unwrap_or(10.0).max(10.0);
    let mut coarser = false;
    if (wm / res) * (hm / res) > MAX_PIXELS {
        res = ((wm * hm / MAX_PIXELS).sqrt() / 10.0).ceil() * 10.0;
        coarser = true;
    }
    let cache = sc.engine.state_dir.join("aef");
    // each VRT reads its GeoTIFF as /vsis3/us-west-2.opendata.source.coop/…: a public bucket (no
    // signing) whose name has dots (path-style URLs). Set for this thread only, so other S3 reads keep
    // the user's credentials.
    let _s3 = PublicS3::on();
    let mut srcs = Vec::new();
    let mut names = Vec::new();
    for zone in zones(b) {
        let zb = utm_box(b, zone_epsg(&zone))?;
        for t in zone_index(&cache, year, &zone)? {
            if overlaps(t.bounds, zb) {
                let base = base();
                let path = if base.starts_with("http") { format!("/vsicurl/{base}/{}", t.path) } else { format!("{base}/{}", t.path) };
                srcs.push(raster::open(Path::new(&path)).map_err(|e| format!("embeddings file {}: {e}", t.path))?);
                names.push(t.path);
            }
        }
    }
    if srcs.is_empty() {
        return Err(format!("no embeddings cover this area in {year} (open ocean and polar areas are not covered)"));
    }
    let name = sanitize(p_str(p, "name").unwrap_or(&format!("embeddings_{year}")));
    let out = out_path(sc, &name)?;
    let tmp = out.with_extension("part.tif");
    let mut args = raster::strings(&["-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "INTERLEAVE=PIXEL", "-ot", "Int8", "-r", "near", "-srcnodata", "-128", "-dstnodata", "-128", "-overwrite", "-tap", "-multi", "-wo", "NUM_THREADS=ALL_CPUS"]);
    args.extend(["-t_srs".into(), format!("EPSG:{epsg}"), "-te_srs".into(), "EPSG:4326".into(), "-te".into(), b[0].to_string(), b[1].to_string(), b[2].to_string(), b[3].to_string(), "-tr".into(), res.to_string(), res.to_string()]);
    let refs: Vec<&gdal::Dataset> = srcs.iter().collect();
    drop(raster::warp(&refs, &tmp.to_string_lossy(), &args)?);
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    let h = register(sc, &out, &name, json!({
        "kind": "embedding", "title": p_str(p, "title").unwrap_or(&format!("Satellite embeddings {year}")),
        "description": format!("AlphaEarth Foundations annual satellite embedding {year}: 64 axes (A00–A63) per pixel. {AEF_CREDIT}."),
        "credit": CREDIT_SHORT,
    }))?;
    let (wk, hk) = (wm / 1000.0, hm / 1000.0);
    sc.cards.push(("Embeddings".into(), format!("{year}, {} × {} px", h.info.width, h.info.height)));
    sc.methods.push(format!(
        "Satellite embeddings: AlphaEarth Foundations annual embedding for {year} (64 dimensions per pixel; Brown et al. 2025, arXiv:2507.22291), read from the public copy on Source Cooperative for a {wk:.1} × {hk:.1} km area ({what}) at {res:.0} m in EPSG:{epsg}{}. {AEF_CREDIT}.",
        if coarser { " (coarser than the native 10 m because of the area's size; each pixel is the normalised mean of the 10 m pixels under it)" } else { "" }
    ));
    Ok(StepOut {
        outputs: json!({ "raster": h.info.id, "path": out, "year": year, "files": names.len(), "epsg": epsg, "resolution": res, "size": [h.info.width, h.info.height], "aoi": b, "seconds": t0.elapsed().as_secs_f64() }),
        why: vec![
            format!("area {wk:.1} × {hk:.1} km ({what}), year {year}"),
            format!("{} embedding file(s) read as cloud-optimised GeoTIFF windows through their VRTs (which flip the bottom-up files)", names.len()),
            format!("{} × {} px at {res:.0} m in EPSG:{epsg}{}", h.info.width, h.info.height, if coarser { " (coarser than 10 m to stay under 4 million pixels)" } else { "" }),
        ],
    })
}

/// Unsigned, path-style S3 for the reads on this thread; restored on drop.
struct PublicS3;

impl PublicS3 {
    // the files are band-interleaved (64 blocks per window): fetch and decode them in parallel
    const KEYS: [(&'static str, &'static str); 5] = [
        ("AWS_NO_SIGN_REQUEST", "YES"),
        ("AWS_VIRTUAL_HOSTING", "FALSE"),
        ("AWS_REGION", "us-west-2"),
        ("GDAL_NUM_THREADS", "ALL_CPUS"),
        ("GDAL_HTTP_MULTIPLEX", "YES"),
    ];
    fn on() -> PublicS3 {
        for (k, v) in Self::KEYS {
            let _ = gdal::config::set_thread_local_config_option(k, v);
        }
        PublicS3
    }
}

impl Drop for PublicS3 {
    fn drop(&mut self) {
        for (k, _) in Self::KEYS {
            let _ = gdal::config::clear_thread_local_config_option(k);
        }
    }
}

/// Sample points of a layer → (label or "", lon, lat). Polygons and lines give their anchor point.
fn samples(sc: &mut StepCtx, p: &Value, field: Option<&str>) -> Result<(Vec<(String, f64, f64)>, String), String> {
    let id = match p_str(p, "samples") {
        Some(s) if s != "auto" => s.to_string(),
        _ => super::steps::auto_layer(sc, None, "sample")?.info.id.clone(),
    };
    let l = sc.layer(&id)?;
    let fi: Vec<usize> = match field {
        Some(f) => vec![l.field_index(f).ok_or_else(|| format!("{id} has no field '{f}'"))?],
        None => vec![],
    };
    let mut out = Vec::new();
    features::scan_layer(sc.engine, &l, None, &fi, &mut |g, props| {
        if let Some([x, y]) = features::anchor(g) {
            let label = match props.first() {
                Some(Val::Str(s)) => s.clone(),
                Some(Val::Int(i)) => i.to_string(),
                Some(Val::Num(n)) => features::num_text(*n),
                _ => String::new(),
            };
            out.push((label, x, y));
        }
        out.len() < 5000
    })?;
    sc.touch(&id);
    let title = sc.title_of(&l);
    Ok((out, title))
}

pub(super) fn similar(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let (path, src_title) = pick(sc, p, "embeddings")?;
    let e = Emb::open(&path)?;
    let t = dequant_table();
    let ct = e.to_pixels()?;
    let pts: Vec<(String, f64, f64)> = match p.get("point").and_then(Value::as_array) {
        Some(a) if a.len() == 2 => vec![(String::new(), a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0))],
        _ => samples(sc, p, None)?.0,
    };
    let mut q = [0f32; DIMS];
    let mut used = 0;
    for (_, lon, lat) in &pts {
        if let Some(i) = e.pixel_at(&ct, *lon, *lat).filter(|&i| e.valid(i)) {
            let v = e.vec(i, &t);
            q.iter_mut().zip(v).for_each(|(a, b)| *a += b);
            used += 1;
        }
    }
    if used == 0 {
        return Err(format!("none of the {} sample(s) falls on the embeddings; fetch them for the samples' area", pts.len()));
    }
    normalize(&mut q);
    let out_v: Vec<f32> = (0..e.n()).into_par_iter().map(|i| if e.valid(i) { dot(&q, &e.vec(i, &t)) } else { raster::NODATA as f32 }).collect();
    let thr = p_f64(p, "threshold").unwrap_or(0.9) as f32;
    let valid = out_v.iter().filter(|v| **v > raster::NODATA as f32).count().max(1);
    let above = out_v.iter().filter(|v| **v >= thr).count();
    let name = sanitize(p_str(p, "name").unwrap_or("similarity"));
    let out = out_path(sc, &name)?;
    write_band(&e, &out, out_v, raster::NODATA)?;
    let h = register(sc, &out, &name, json!({ "kind": "similarity", "credit": CREDIT_SHORT, "title": p_str(p, "title").unwrap_or("Similarity to the samples"), "units": "cosine",
        "description": format!("Cosine similarity of each pixel's embedding to the mean of {used} sample(s); 1 = alike. {AEF_CREDIT}.") }))?;
    let ha = above as f64 * e.pixel_area_ha();
    sc.cards.push(("Alike (≥ ".to_string() + &format!("{thr:.2})"), format!("{} ha ({:.1} %)", fmt0(ha), above as f64 / valid as f64 * 100.0)));
    sc.methods.push(format!(
        "Similarity search: the {used} sample embedding(s) were averaged and normalised; every pixel's cosine similarity to that vector was mapped (1 = alike, 0 = unrelated). {} ha ({:.1} %) reach {thr:.2} or more.",
        fmt0(ha), above as f64 / valid as f64 * 100.0
    ));
    Ok(StepOut {
        outputs: json!({ "raster": h.info.id, "path": out, "samples": used, "threshold": thr, "area_ha": ha, "share": above as f64 / valid as f64 }),
        why: vec![
            format!("{used} of {} sample(s) on the embeddings ({src_title}) averaged into one vector", pts.len()),
            format!("cosine similarity of every pixel to it; {} ha ({:.1} %) at ≥ {thr:.2}", fmt0(ha), above as f64 / valid as f64 * 100.0),
        ],
    })
}

/// Deterministic k-means++ on unit vectors (spherical k-means): (centroids, iterations).
pub fn kmeans(vs: &[[f32; DIMS]], k: usize, iters: usize, seed: u64) -> (Vec<[f32; DIMS]>, usize) {
    let mut s = seed.max(1);
    let mut rnd = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut c: Vec<[f32; DIMS]> = vec![vs[(rnd() * vs.len() as f64) as usize % vs.len()]];
    while c.len() < k {
        let d: Vec<f64> = vs.par_iter().map(|v| c.iter().map(|ci| (1.0 - dot(v, ci)).max(0.0) as f64).fold(f64::MAX, f64::min)).collect();
        let total: f64 = d.iter().map(|x| x * x).sum();
        if total <= 0.0 {
            break;
        }
        let mut r = rnd() * total;
        let mut pick = vs.len() - 1;
        for (i, x) in d.iter().enumerate() {
            r -= x * x;
            if r <= 0.0 {
                pick = i;
                break;
            }
        }
        c.push(vs[pick]);
    }
    let mut it = 0;
    for _ in 0..iters {
        it += 1;
        let assign: Vec<usize> = vs.par_iter().map(|v| nearest(&c, v)).collect();
        let mut sums = vec![[0f32; DIMS]; c.len()];
        for (v, &a) in vs.iter().zip(&assign) {
            sums[a].iter_mut().zip(v).for_each(|(s, x)| *s += x);
        }
        let mut moved = 0f32;
        for (ci, mut s) in c.iter_mut().zip(sums) {
            if s.iter().all(|x| *x == 0.0) {
                continue;
            }
            normalize(&mut s);
            moved = moved.max(1.0 - dot(ci, &s));
            *ci = s;
        }
        if moved < 1e-5 {
            break;
        }
    }
    (c, it)
}

fn nearest(c: &[[f32; DIMS]], v: &[f32; DIMS]) -> usize {
    let mut best = (0, f32::MIN);
    for (j, cj) in c.iter().enumerate() {
        let d = dot(v, cj);
        if d > best.1 {
            best = (j, d);
        }
    }
    best.0
}

fn palette(n: usize) -> Vec<String> {
    crate::automation::automap::ramp_colors("tableau", n.max(1))
}

pub(super) fn cluster(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let (path, _) = pick(sc, p, "embeddings")?;
    let e = Emb::open(&path)?;
    let t = dequant_table();
    let k = p_f64(p, "classes").unwrap_or(8.0).clamp(2.0, 20.0) as usize;
    let valid: Vec<usize> = (0..e.n()).filter(|&i| e.valid(i)).collect();
    if valid.len() < k * 10 {
        return Err(format!("only {} pixels with embeddings; too few for {k} clusters", valid.len()));
    }
    // fit on an even sample (at most 60 000 pixels), then label every pixel
    let step = (valid.len() / 60_000).max(1);
    let fit: Vec<[f32; DIMS]> = valid.iter().step_by(step).map(|&i| e.vec(i, &t)).collect();
    let (c, iters) = kmeans(&fit, k, 40, p_f64(p, "seed").unwrap_or(7.0) as u64);
    let labels: Vec<u8> = (0..e.n()).into_par_iter().map(|i| if e.valid(i) { nearest(&c, &e.vec(i, &t)) as u8 + 1 } else { 0 }).collect();
    let mut count = vec![0usize; c.len()];
    for &l in labels.iter().filter(|l| **l > 0) {
        count[l as usize - 1] += 1;
    }
    let total = count.iter().sum::<usize>().max(1);
    let pal = palette(c.len());
    let name = sanitize(p_str(p, "name").unwrap_or("clusters"));
    let out = out_path(sc, &name)?;
    write_band(&e, &out, labels, 0.0)?;
    let classes: Vec<Value> = (0..c.len())
        .map(|j| json!({ "value": j + 1, "label": format!("Group {} ({:.1} %)", j + 1, count[j] as f64 / total as f64 * 100.0), "color": pal[j] }))
        .collect();
    let h = register(sc, &out, &name, json!({ "kind": "classes", "title": p_str(p, "title").unwrap_or("Landscape groups"), "credit": CREDIT_SHORT, "classes": classes,
        "description": format!("{} groups of pixels with alike satellite embeddings (k-means). Name them from what you know on the ground. {AEF_CREDIT}.", c.len()) }))?;
    sc.cards.push(("Groups".into(), format!("{}", c.len())));
    sc.methods.push(format!(
        "Unsupervised grouping: spherical k-means (k = {}, k-means++ start, seed fixed so a re-run gives the same groups, {iters} iterations) on {} of {} embedding pixels; every pixel was then given its nearest group. The groups are not named: they are landscapes that look alike over the year.",
        c.len(), fit.len(), valid.len()
    ));
    Ok(StepOut {
        outputs: json!({ "raster": h.info.id, "path": out, "classes": c.len(), "counts": count, "iterations": iters }),
        why: vec![
            format!("k-means with {} groups fitted on {} of {} pixels ({iters} iterations)", c.len(), fit.len(), valid.len()),
            format!("largest group {:.1} %, smallest {:.1} %", *count.iter().max().unwrap_or(&0) as f64 / total as f64 * 100.0, *count.iter().min().unwrap_or(&0) as f64 / total as f64 * 100.0),
        ],
    })
}

pub(super) fn classify(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let (path, _) = pick(sc, p, "embeddings")?;
    let field = p_str(p, "field").ok_or("classify needs field: the samples' class field")?.to_string();
    let e = Emb::open(&path)?;
    let t = dequant_table();
    let ct = e.to_pixels()?;
    let (pts, layer_title) = samples(sc, p, Some(&field))?;
    let mut train: Vec<([f32; DIMS], usize)> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut off = 0;
    for (label, lon, lat) in &pts {
        if label.is_empty() {
            continue;
        }
        let Some(i) = e.pixel_at(&ct, *lon, *lat).filter(|&i| e.valid(i)) else { off += 1; continue };
        let c = match names.iter().position(|n| n == label) {
            Some(c) => c,
            None => {
                names.push(label.clone());
                names.len() - 1
            }
        };
        train.push((e.vec(i, &t), c));
    }
    if names.len() < 2 {
        return Err(format!("classify needs samples of at least two classes in '{field}' on the embeddings ({} usable)", train.len()));
    }
    if names.len() > 30 {
        return Err(format!("'{field}' has {} classes; use at most 30", names.len()));
    }
    let k = p_f64(p, "neighbours").unwrap_or(5.0).max(1.0) as usize;
    let knn = |v: &[f32; DIMS], skip: Option<usize>| -> usize {
        let mut best: Vec<(f32, usize)> = train.iter().enumerate().filter(|(j, _)| Some(*j) != skip).map(|(_, (tv, c))| (dot(v, tv), *c)).collect();
        best.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut votes = vec![0f32; names.len()];
        for (s, c) in best.iter().take(k) {
            votes[*c] += 1.0 + s; // ties go to the closer samples
        }
        votes.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|x| x.0).unwrap_or(0)
    };
    // leave-one-out accuracy on the samples
    let right = (0..train.len()).into_par_iter().filter(|&j| knn(&train[j].0, Some(j)) == train[j].1).count();
    let acc = right as f64 / train.len() as f64;
    let labels: Vec<u8> = (0..e.n()).into_par_iter().map(|i| if e.valid(i) { knn(&e.vec(i, &t), None) as u8 + 1 } else { 0 }).collect();
    let mut count = vec![0usize; names.len()];
    for &l in labels.iter().filter(|l| **l > 0) {
        count[l as usize - 1] += 1;
    }
    // classes named as land cover keep their conventional colours, others a qualitative palette
    let pal: Vec<String> = palette(names.len()).into_iter().zip(&names).map(|(c, n)| crate::automation::automap::land_cover_color(n).map(str::to_string).unwrap_or(c)).collect();
    let ha = e.pixel_area_ha();
    let name = sanitize(p_str(p, "name").unwrap_or("classified"));
    let out = out_path(sc, &name)?;
    write_band(&e, &out, labels, 0.0)?;
    let classes: Vec<Value> = names.iter().enumerate().map(|(j, n)| json!({ "value": j + 1, "label": n, "color": pal[j] })).collect();
    let h = register(sc, &out, &name, json!({ "kind": "classes", "title": p_str(p, "title").unwrap_or("Classified from samples"), "credit": CREDIT_SHORT, "classes": classes,
        "description": format!("{} classes from the samples' '{field}' (k-nearest neighbours on satellite embeddings). {AEF_CREDIT}.", names.len()) }))?;
    let areas: Vec<Value> = names.iter().zip(&count).map(|(n, c)| json!({ "class": n, "area_ha": (*c as f64 * ha).round() })).collect();
    sc.cards.push(("Accuracy (leave-one-out)".into(), format!("{:.0} %", acc * 100.0)));
    sc.methods.push(format!(
        "Supervised classification: {} samples of {} classes ('{field}' of {layer_title}) labelled the embeddings; each pixel took the majority class of its {k} most similar samples (cosine k-nearest neighbours). Leave-one-out accuracy on the samples: {:.0} % ({right} of {}). This is optimistic when samples sit close together; check against independent points.",
        train.len(), names.len(), acc * 100.0, train.len()
    ));
    Ok(StepOut {
        outputs: json!({ "raster": h.info.id, "path": out, "classes": names, "samples": train.len(), "off_raster": off, "accuracy": acc, "areas": areas }),
        why: vec![
            format!("{} samples, {} classes from '{field}'{}", train.len(), names.len(), if off > 0 { format!(" ({off} outside the embeddings)") } else { String::new() }),
            format!("{k}-nearest neighbours by cosine similarity; leave-one-out accuracy {:.0} %", acc * 100.0),
        ],
    })
}

pub(super) fn change(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let (pa, ta) = pick(sc, p, "before")?;
    let (pb, tb) = match p_str(p, "after") {
        Some(_) => pick(sc, p, "after")?,
        None => return Err("change needs before: and after: embedding rasters (two embeddings.fetch steps for two years)".into()),
    };
    let a = Emb::open(&pa)?;
    let b = Emb::open(&pb)?;
    if (a.w, a.h) != (b.w, b.h) || a.gt.iter().zip(&b.gt).any(|(x, y)| (x - y).abs() > 1e-6) {
        return Err("the two embedding rasters are not on the same grid; fetch both for the same area and resolution".into());
    }
    let t = dequant_table();
    let d: Vec<f32> = (0..a.n()).into_par_iter().map(|i| if a.valid(i) && b.valid(i) { 1.0 - dot(&a.vec(i, &t), &b.vec(i, &t)) } else { raster::NODATA as f32 }).collect();
    let thr = p_f64(p, "threshold").unwrap_or(0.3) as f32;
    let valid = d.iter().filter(|v| **v > raster::NODATA as f32).count().max(1);
    let changed = d.iter().filter(|v| **v >= thr).count();
    let ha = changed as f64 * a.pixel_area_ha();
    let name = sanitize(p_str(p, "name").unwrap_or("embedding_change"));
    let out = out_path(sc, &name)?;
    write_band(&a, &out, d, raster::NODATA)?;
    let h = register(sc, &out, &name, json!({ "kind": "dissimilarity", "credit": CREDIT_SHORT, "title": p_str(p, "title").unwrap_or("Change between the years"), "units": "1 − cosine",
        "description": format!("How much each pixel's year changed: 1 − cosine similarity of its embeddings in {ta} and {tb} (0 = the same). {AEF_CREDIT}.") }))?;
    sc.cards.push(("Changed".into(), format!("{} ha ({:.1} %)", fmt0(ha), changed as f64 / valid as f64 * 100.0)));
    sc.methods.push(format!(
        "Change: 1 − cosine similarity between each pixel's embeddings in {ta} and {tb} (0 = alike, 1 = unrelated). {} ha ({:.1} %) changed by {thr:.2} or more. Embedding change shows any change in what the satellites saw over the year (cover, water, cropping, building); check it on imagery before naming it.",
        fmt0(ha), changed as f64 / valid as f64 * 100.0
    ));
    Ok(StepOut {
        outputs: json!({ "raster": h.info.id, "path": out, "threshold": thr, "area_ha": ha, "share": changed as f64 / valid as f64 }),
        why: vec![format!("1 − cosine similarity of {ta} and {tb} for every pixel"), format!("{} ha ({:.1} %) at ≥ {thr:.2}", fmt0(ha), changed as f64 / valid as f64 * 100.0)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dequantisation_matches_the_dataset_formula() {
        let t = dequant_table();
        assert_eq!(t[0], 0.0);
        assert!((t[127] - (127.0f32 / 127.5).powi(2)).abs() < 1e-7);
        assert!((t[(-127i8) as u8 as usize] + (127.0f32 / 127.5).powi(2)).abs() < 1e-7);
        assert!((t[(-64i8) as u8 as usize] + (64.0f32 / 127.5).powi(2)).abs() < 1e-7);
    }

    #[test]
    fn zones_of_an_area() {
        assert_eq!(zones([144.0, -6.5, 145.0, -5.5]), vec!["55S"]);
        assert_eq!(zones([143.5, -1.0, 144.5, 1.0]), vec!["54S", "54N", "55S", "55N"]);
        assert_eq!(zone_epsg("55S"), 32755);
        assert_eq!(zone_epsg("10N"), 32610);
    }

    #[test]
    fn vrt_head_gives_the_extent() {
        let head = r#"<VRTDataset rasterXSize="8192" rasterYSize="8192" subClass="VRTWarpedDataset">
  <GeoTransform>  3.3616000000000000e+05,  1.0000000000000000e+01,  0.0000000000000000e+00,  6.6412800000000000e+06,  0.0000000000000000e+00, -1.0000000000000000e+01</GeoTransform>"#;
        assert_eq!(vrt_bounds(head), Some([336160.0, 6559360.0, 418080.0, 6641280.0]));
    }

    fn unit(seed: u32) -> [f32; DIMS] {
        let mut v = [0f32; DIMS];
        let mut s = seed.wrapping_mul(2654435761).max(1);
        for x in v.iter_mut() {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            *x = (s % 1000) as f32 / 1000.0 - 0.5;
        }
        normalize(&mut v);
        v
    }

    #[test]
    fn kmeans_separates_three_groups() {
        let centres = [unit(1), unit(2), unit(3)];
        let mut vs = Vec::new();
        for (g, c) in centres.iter().enumerate() {
            for i in 0..200 {
                let mut v = *c;
                let n = unit(100 + g as u32 * 1000 + i);
                v.iter_mut().zip(n).for_each(|(a, b)| *a += 0.15 * b);
                normalize(&mut v);
                vs.push(v);
            }
        }
        let (c, _) = kmeans(&vs, 3, 50, 7);
        // each found centre is close to one true centre, and all three are found
        let mut hit = [false; 3];
        for ci in &c {
            let j = (0..3).max_by(|&a, &b| dot(ci, &centres[a]).total_cmp(&dot(ci, &centres[b]))).unwrap();
            assert!(dot(ci, &centres[j]) > 0.95);
            hit[j] = true;
        }
        assert_eq!(hit, [true; 3]);
        // and every point goes to its own group's centre
        for (g, chunk) in vs.chunks(200).enumerate() {
            let target = (0..3).max_by(|&a, &b| dot(&c[a], &centres[g]).total_cmp(&dot(&c[b], &centres[g]))).unwrap();
            assert!(chunk.iter().all(|v| nearest(&c, v) == target));
        }
    }
}
