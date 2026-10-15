//! Rasters (docs/AUTOMATION.md "Rasters"): catalogue, GDAL utilities (warp, translate, DEM
//! processing, HTTP), statistics, automatic styling and Web Mercator overlays shared by the web map
//! (a MapLibre `image` source) and the map composer (an embedded PNG under the vector layers).

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use gdal::raster::{Buffer, ResampleAlg};
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::{Dataset, DatasetOptions, DriverManager, GdalOpenFlags};
use serde_json::{json, Value};

use crate::Engine;

pub const EXTENSIONS: &[&str] = &["tif", "tiff", "vrt", "jp2", "img", "asc", "hgt"];
pub const MAX_OVERLAY: usize = 2048;
pub const NODATA: f64 = -9999.0;

// ------------------------------------------------------------------ GDAL plumbing

/// Cloud-optimised reads over HTTP (Copernicus DEM, Sentinel-2 COGs) without directory probing.
pub fn configure_gdal() {
    // Bundled data (Windows edition / portable ZIP): <exe dir>\share\gdal and <exe dir>\share\proj.
    // System installs (Linux packages, OSGeo4W, conda) find their own data, and env vars always win.
    if let Some(dir) = crate::exe_dir() {
        let gdal_data = dir.join("share").join("gdal");
        if std::env::var_os("GDAL_DATA").is_none() && gdal_data.is_dir() {
            let _ = gdal::config::set_config_option("GDAL_DATA", &gdal_data.to_string_lossy());
        }
        let proj = dir.join("share").join("proj");
        if std::env::var_os("PROJ_DATA").is_none() && std::env::var_os("PROJ_LIB").is_none() && proj.join("proj.db").is_file() {
            if let Ok(p) = CString::new(proj.to_string_lossy().as_bytes()) {
                let paths = [p.as_ptr(), std::ptr::null()];
                unsafe { gdal_sys::OSRSetPROJSearchPaths(paths.as_ptr()) };
            }
        }
    }
    for (k, v) in [
        ("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR"),
        ("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.TIF,.vrt,.jp2"),
        ("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES"),
        ("GDAL_HTTP_MULTIPLEX", "YES"),
        ("VSI_CACHE", "TRUE"),
        ("GDAL_HTTP_MAX_RETRY", "3"),
        ("GDAL_HTTP_RETRY_DELAY", "1"),
        ("GDAL_PAM_ENABLED", "NO"),
    ] {
        if std::env::var(k).is_err() {
            let _ = gdal::config::set_config_option(k, v);
        }
    }
}

pub fn last_error() -> String {
    unsafe {
        let p = gdal_sys::CPLGetLastErrorMsg();
        if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
    }
}

struct Argv {
    _keep: Vec<CString>,
    ptrs: Vec<*mut c_char>,
}

fn argv(args: &[String]) -> Result<Argv, String> {
    let keep: Vec<CString> = args.iter().map(|a| CString::new(a.as_str()).map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
    let mut ptrs: Vec<*mut c_char> = keep.iter().map(|s| s.as_ptr() as *mut c_char).collect();
    ptrs.push(std::ptr::null_mut());
    Ok(Argv { _keep: keep, ptrs })
}

/// A NULL-terminated C string list (CSLConstList) that lives as long as this value.
pub struct Csl(Argv);

impl Csl {
    pub fn ptr(&self) -> gdal_sys::CSLConstList {
        self.0.ptrs.as_ptr() as gdal_sys::CSLConstList
    }
}

pub fn csl(args: &[String]) -> Result<Csl, String> {
    Ok(Csl(argv(args)?))
}

pub fn strings(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

pub fn open(path: &Path) -> Result<Dataset, String> {
    let opts = DatasetOptions { open_flags: GdalOpenFlags::GDAL_OF_RASTER | GdalOpenFlags::GDAL_OF_READONLY, ..Default::default() };
    Dataset::open_ex(path, opts).map_err(|e| format!("{}: {e}", path.display()))
}

/// `gdalwarp` in-process (several sources are mosaicked). `dest` "" with `-of MEM` stays in memory.
pub fn warp(srcs: &[&Dataset], dest: &str, args: &[String]) -> Result<Dataset, String> {
    let a = argv(args)?;
    let dest_c = CString::new(dest).map_err(|e| e.to_string())?;
    unsafe {
        gdal_sys::CPLErrorReset();
        let opts = gdal_sys::GDALWarpAppOptionsNew(a.ptrs.as_ptr() as *mut *mut c_char, std::ptr::null_mut());
        if opts.is_null() {
            return Err(format!("gdalwarp options: {}", last_error()));
        }
        let mut handles: Vec<gdal_sys::GDALDatasetH> = srcs.iter().map(|d| d.c_dataset()).collect();
        let mut usage: c_int = 0;
        let out = gdal_sys::GDALWarp(dest_c.as_ptr(), std::ptr::null_mut(), handles.len() as c_int, handles.as_mut_ptr(), opts, &mut usage);
        gdal_sys::GDALWarpAppOptionsFree(opts);
        if out.is_null() {
            return Err(format!("gdalwarp: {}", last_error()));
        }
        Ok(Dataset::from_c_dataset(out))
    }
}

/// `gdal_translate` in-process.
pub fn translate(src: &Dataset, dest: &str, args: &[String]) -> Result<Dataset, String> {
    let a = argv(args)?;
    let dest_c = CString::new(dest).map_err(|e| e.to_string())?;
    unsafe {
        gdal_sys::CPLErrorReset();
        let opts = gdal_sys::GDALTranslateOptionsNew(a.ptrs.as_ptr() as *mut *mut c_char, std::ptr::null_mut());
        if opts.is_null() {
            return Err(format!("gdal_translate options: {}", last_error()));
        }
        let mut usage: c_int = 0;
        let out = gdal_sys::GDALTranslate(dest_c.as_ptr(), src.c_dataset(), opts, &mut usage);
        gdal_sys::GDALTranslateOptionsFree(opts);
        if out.is_null() {
            return Err(format!("gdal_translate: {}", last_error()));
        }
        Ok(Dataset::from_c_dataset(out))
    }
}

/// `gdaldem <processing>` in-process (hillshade, slope, aspect, TRI, TPI, roughness, color-relief).
pub fn dem(src: &Dataset, dest: &str, processing: &str, args: &[String]) -> Result<Dataset, String> {
    let a = argv(args)?;
    let dest_c = CString::new(dest).map_err(|e| e.to_string())?;
    let proc_c = CString::new(processing).map_err(|e| e.to_string())?;
    unsafe {
        gdal_sys::CPLErrorReset();
        let opts = gdal_sys::GDALDEMProcessingOptionsNew(a.ptrs.as_ptr() as *mut *mut c_char, std::ptr::null_mut());
        if opts.is_null() {
            return Err(format!("gdaldem options: {}", last_error()));
        }
        let mut usage: c_int = 0;
        let out = gdal_sys::GDALDEMProcessing(dest_c.as_ptr(), src.c_dataset(), proc_c.as_ptr(), std::ptr::null(), opts, &mut usage);
        gdal_sys::GDALDEMProcessingOptionsFree(opts);
        if out.is_null() {
            return Err(format!("gdaldem {processing}: {}", last_error()));
        }
        Ok(Dataset::from_c_dataset(out))
    }
}

// GDAL's libcurl client (honours GDAL_HTTP_PROXY etc., so no second TLS stack is needed).
#[repr(C)]
struct CplHttpResult {
    status: c_int,
    content_type: *mut c_char,
    err_buf: *mut c_char,
    data_len: c_int,
    data_alloc: c_int,
    data: *mut u8,
    headers: *mut *mut c_char,
    mime_part_count: c_int,
    mime_parts: *mut c_void,
}

unsafe extern "C" {
    fn CPLHTTPFetch(url: *const c_char, options: *mut *mut c_char) -> *mut CplHttpResult;
    fn CPLHTTPDestroyResult(r: *mut CplHttpResult);
}

/// GET (or POST a JSON body) and return the response bytes.
pub fn http(url: &str, post_json: Option<&str>, timeout_s: u32) -> Result<Vec<u8>, String> {
    let mut opts = vec![format!("TIMEOUT={timeout_s}"), format!("USERAGENT=GeoSpaX/{}", env!("CARGO_PKG_VERSION")), "MAX_RETRY=2".into(), "RETRY_DELAY=1".into()];
    match post_json {
        Some(body) => {
            opts.push(format!("POSTFIELDS={body}"));
            opts.push("HEADERS=Content-Type: application/json\r\nAccept: application/geo+json, application/json".into());
        }
        None => opts.push("HEADERS=Accept: application/geo+json, application/json".into()),
    }
    let a = argv(&opts)?;
    let url_c = CString::new(url).map_err(|e| e.to_string())?;
    unsafe {
        gdal_sys::CPLErrorReset();
        let r = CPLHTTPFetch(url_c.as_ptr(), a.ptrs.as_ptr() as *mut *mut c_char);
        if r.is_null() {
            return Err(format!("{url}: {}", last_error()));
        }
        let res = &*r;
        let body = if res.data.is_null() || res.data_len <= 0 { Vec::new() } else { std::slice::from_raw_parts(res.data, res.data_len as usize).to_vec() };
        let err = if res.err_buf.is_null() { None } else { Some(CStr::from_ptr(res.err_buf).to_string_lossy().into_owned()) };
        let status = res.status;
        CPLHTTPDestroyResult(r);
        if let Some(e) = err {
            let snippet: String = String::from_utf8_lossy(&body).chars().take(300).collect();
            return Err(format!("{e} {snippet}").trim().to_string());
        }
        if status != 0 && body.is_empty() {
            return Err(format!("{url}: HTTP client error {status}: {}", last_error()));
        }
        Ok(body)
    }
}

// ------------------------------------------------------------------ catalogue

#[derive(Clone, Debug, Default)]
pub struct BandStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub std: f64,
    pub p2: f64,
    pub p98: f64,
    /// Fraction of pixels with data.
    pub valid: f64,
    /// Value counts for integer bands with few distinct values (categorical rasters).
    pub distinct: Option<Vec<(f64, u64)>>,
}

#[derive(Clone, Debug)]
pub struct RasterInfo {
    pub id: String,
    pub name: String,
    pub title: String,
    pub path: PathBuf,
    pub width: usize,
    pub height: usize,
    pub bands: usize,
    pub dtype: String,
    pub crs: String,
    pub epsg: Option<u32>,
    pub geographic: bool,
    /// lon/lat bounds [w, s, e, n].
    pub bounds: [f64; 4],
    pub pixel_m: f64,
    pub nodata: Option<f64>,
    /// dem, hillshade, slope, aspect, tri, tpi, roughness, ndvi, ndwi, nbr, ndmi, savi, evi, classes, rgb, raster
    pub kind: String,
    pub units: String,
    pub description: String,
    /// Short attribution for map credits ("Copernicus Sentinel-2 data 2026").
    pub credit: String,
    /// (value, label, colour) for categorical rasters.
    pub classes: Vec<(f64, String, String)>,
    pub stats: Vec<BandStats>,
}

pub struct RasterHandle {
    pub info: RasterInfo,
    pub style: RwLock<Value>,
    pub why: RwLock<String>,
    overlays: Mutex<Vec<(String, Arc<Vec<u8>>)>>,
}

pub fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c.to_ascii_lowercase() } else { '_' }).collect()
}

fn sidecar_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".gsx.json");
    PathBuf::from(s)
}

/// Facts a step knows about the raster it wrote (kind, title, classes, units), kept next to the file
/// so they survive restarts.
pub fn write_sidecar(path: &Path, v: &Value) -> Result<(), String> {
    std::fs::write(sidecar_path(path), serde_json::to_vec_pretty(v).unwrap_or_default()).map_err(|e| e.to_string())
}

fn read_sidecar(path: &Path) -> Value {
    std::fs::read(sidecar_path(path)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

pub fn discover(paths: &[PathBuf]) -> Vec<PathBuf> {
    fn walk(p: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if p.is_dir() {
            if depth == 0 {
                return;
            }
            let Ok(rd) = std::fs::read_dir(p) else { return };
            let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            entries.sort();
            for e in entries {
                let name = e.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.starts_with('.') && name != "raw" {
                    walk(&e, depth - 1, out);
                }
            }
        } else {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if EXTENSIONS.contains(&ext.as_str()) {
                out.push(p.to_path_buf());
            }
        }
    }
    let mut out = Vec::new();
    for p in paths {
        walk(p, 3, &mut out);
    }
    out
}

pub fn wgs84() -> SpatialRef {
    let mut s = SpatialRef::from_epsg(4326).expect("EPSG:4326");
    s.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    s
}

pub fn srs_of(ds: &Dataset) -> Option<SpatialRef> {
    let mut s = ds.spatial_ref().ok()?;
    s.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    Some(s)
}

/// lon/lat bounds of a dataset (edges densified, so UTM rasters get the true envelope).
pub fn lonlat_bounds(ds: &Dataset) -> Result<[f64; 4], String> {
    let gt = ds.geo_transform().map_err(|e| format!("no georeferencing: {e}"))?;
    let (w, h) = ds.raster_size();
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    let n = 20;
    for i in 0..=n {
        let t = i as f64 / n as f64;
        for (px, py) in [(t * w as f64, 0.0), (t * w as f64, h as f64), (0.0, t * h as f64), (w as f64, t * h as f64)] {
            xs.push(gt[0] + px * gt[1] + py * gt[2]);
            ys.push(gt[3] + px * gt[4] + py * gt[5]);
        }
    }
    if let Some(src) = srs_of(ds) {
        if !(src.auth_code().ok() == Some(4326)) {
            let ct = CoordTransform::new(&src, &wgs84()).map_err(|e| e.to_string())?;
            let mut zs = vec![0.0; xs.len()];
            ct.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| format!("bounds: {e}"))?;
        }
    }
    let b = xs.iter().zip(&ys).filter(|(x, y)| x.is_finite() && y.is_finite()).fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, (x, y)| [b[0].min(*x), b[1].min(*y), b[2].max(*x), b[3].max(*y)]);
    if b[0] > b[2] {
        return Err("bounds could not be computed".into());
    }
    Ok([b[0].max(-180.0), b[1].max(-85.05), b[2].min(180.0), b[3].min(85.05)])
}

fn is_nodata(v: f32, nd: Option<f64>) -> bool {
    !v.is_finite() || nd.is_some_and(|n| (v as f64 - n).abs() <= 1e-6 * n.abs().max(1.0))
}

/// Pixel values read at reduced resolution (≤ `max` px on the long side; overviews are used).
pub fn band_sample(ds: &Dataset, b: usize, max: usize) -> Result<(Vec<f32>, usize, usize), String> {
    let (w, h) = ds.raster_size();
    let f = (w.max(h) as f64 / max as f64).max(1.0);
    let (sw, sh) = (((w as f64 / f).round() as usize).max(1), ((h as f64 / f).round() as usize).max(1));
    let band = ds.rasterband(b).map_err(|e| e.to_string())?;
    let buf: Buffer<f32> = band.read_as::<f32>((0, 0), (w, h), (sw, sh), Some(ResampleAlg::NearestNeighbour)).map_err(|e| e.to_string())?;
    Ok((buf.into_shape_and_vec().1, sw, sh))
}

pub fn stats_of(vals: &[f32], nd: Option<f64>, integer: bool) -> BandStats {
    let mut v: Vec<f32> = vals.iter().copied().filter(|x| !is_nodata(*x, nd)).collect();
    if v.is_empty() {
        return BandStats::default();
    }
    let n = v.len() as f64;
    let mean = v.iter().map(|x| *x as f64).sum::<f64>() / n;
    let std = (v.iter().map(|x| (*x as f64 - mean).powi(2)).sum::<f64>() / n).sqrt();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let q = |p: f64| v[((n - 1.0) * p).round() as usize] as f64;
    let distinct = if integer {
        let mut m: HashMap<i64, u64> = HashMap::new();
        for x in &v {
            *m.entry(*x as i64).or_default() += 1;
            if m.len() > 32 {
                break;
            }
        }
        if m.len() <= 32 {
            let mut d: Vec<(f64, u64)> = m.into_iter().map(|(k, c)| (k as f64, c)).collect();
            d.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            Some(d)
        } else {
            None
        }
    } else {
        None
    };
    BandStats { min: v[0] as f64, max: v[v.len() - 1] as f64, mean, std, p2: q(0.02), p98: q(0.98), valid: n / vals.len().max(1) as f64, distinct }
}

fn guess_kind(name: &str, bands: usize, dtype: &str, s: &BandStats) -> String {
    let n = name.to_ascii_lowercase();
    let has = |w: &str| n.split(|c: char| !c.is_ascii_alphanumeric()).any(|p| p == w) || n.contains(w);
    if has("wetness") || n.split(|c: char| !c.is_ascii_alphanumeric()).any(|p| p == "twi") {
        return "twi".into();
    }
    for k in ["hillshade", "slope", "aspect", "ndvi", "ndwi", "nbr", "ndmi", "savi", "evi", "roughness"] {
        if has(k) {
            return k.into();
        }
    }
    if n.split(|c: char| !c.is_ascii_alphanumeric()).any(|p| p == "tri" || p == "tpi") {
        return n.split(|c: char| !c.is_ascii_alphanumeric()).find(|p| *p == "tri" || *p == "tpi").unwrap().into();
    }
    if ["dem", "dsm", "dtm", "elev", "srtm", "copernicus", "height", "glo30", "glo-30", "terrain", "altitude"].iter().any(|w| has(w)) {
        return "dem".into();
    }
    if bands >= 3 && dtype == "Byte" {
        return "rgb".into();
    }
    if bands == 1 && s.distinct.as_ref().is_some_and(|d| d.len() <= 16) && !dtype.starts_with("Float") {
        return "classes".into();
    }
    "raster".into()
}

pub fn open_info(path: &Path, id: &str) -> Result<RasterInfo, String> {
    let ds = open(path)?;
    let (width, height) = ds.raster_size();
    let bands = ds.raster_count() as usize;
    if bands == 0 {
        return Err(format!("{}: no raster bands", path.display()));
    }
    let gt = ds.geo_transform().map_err(|_| format!("{}: not georeferenced", path.display()))?;
    let bounds = lonlat_bounds(&ds)?;
    let srs = srs_of(&ds);
    let geographic = srs.as_ref().is_none_or(|s| s.is_geographic());
    let epsg = srs.as_ref().and_then(|s| s.auth_code().ok()).map(|c| c as u32);
    let crs = match (&srs, epsg) {
        (_, Some(c)) => format!("EPSG:{c}"),
        (Some(s), None) => s.name().unwrap_or_else(|| "custom".into()),
        _ => "unknown".into(),
    };
    let lat = (bounds[1] + bounds[3]) / 2.0;
    let pixel_m = if geographic { gt[1].abs() * 111_320.0 * lat.to_radians().cos() } else { gt[1].abs() };
    let b1 = ds.rasterband(1).map_err(|e| e.to_string())?;
    let dtype = b1.band_type().name();
    let nodata = b1.no_data_value();
    let integer = !dtype.starts_with("Float") && !dtype.starts_with("CFloat");
    let mut stats = Vec::new();
    for b in 1..=bands.min(4) {
        let (vals, _, _) = band_sample(&ds, b, 1024)?;
        stats.push(stats_of(&vals, nodata, integer));
    }
    let side = read_sidecar(path);
    let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| id.to_string());
    let kind = side["kind"].as_str().map(str::to_string).unwrap_or_else(|| guess_kind(&name, bands, &dtype, &stats[0]));
    let mut classes: Vec<(f64, String, String)> = side["classes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c["value"].as_f64()?, c["label"].as_str().unwrap_or("").to_string(), c["color"].as_str().unwrap_or("").to_string())))
        .collect();
    if kind == "classes" && classes.is_empty() {
        let pal = crate::automation::automap::ramp_colors("tableau", 16);
        classes = stats[0].distinct.iter().flatten().enumerate().map(|(i, (v, _))| (*v, format!("class {v}"), pal[i % pal.len()].clone())).collect();
    }
    let units = side["units"].as_str().map(str::to_string).unwrap_or_else(|| match kind.as_str() {
        "dem" => "m".into(),
        "slope" | "aspect" => "°".into(),
        _ => String::new(),
    });
    let title = side["title"].as_str().map(str::to_string).unwrap_or_else(|| humanize(&name));
    Ok(RasterInfo {
        id: id.to_string(),
        name,
        title,
        path: path.to_path_buf(),
        width,
        height,
        bands,
        dtype,
        crs,
        epsg,
        geographic,
        bounds,
        pixel_m,
        nodata,
        kind,
        units,
        description: side["description"].as_str().unwrap_or("").to_string(),
        credit: side["credit"].as_str().unwrap_or("").to_string(),
        classes,
        stats,
    })
}

fn humanize(s: &str) -> String {
    let t = s.replace(['_', '-'], " ");
    let mut c = t.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

// ------------------------------------------------------------------ automatic styling

/// Colour stops (0..1) for the raster ramps; the vector ramps from automap are also accepted.
fn ramp_stops(id: &str) -> Vec<String> {
    let s: &[&str] = match id {
        "terrain" => &["#2f6f3e", "#5d9a4a", "#a8c66c", "#e6dc9a", "#d2a66a", "#a8744a", "#8a6d5a", "#c9c2bb", "#ffffff"],
        "slope" => &["#fbfbe0", "#fde08a", "#fdae61", "#f46d43", "#d73027", "#7f0000"],
        "ndvi" => &["#a50026", "#d73027", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#d9ef8b", "#a6d96a", "#66bd63", "#1a9850", "#006837"],
        "ndwi" => &["#8c6d31", "#d9c99a", "#f7fbff", "#9ecae1", "#3182bd", "#08306b"],
        "gray" => &["#000000", "#ffffff"],
        "rough" => &["#ffffe5", "#fee391", "#fe9929", "#cc4c02", "#662506"],
        "uncert" => &["#fbf7fb", "#e7d4e8", "#c9a5cf", "#a66fb0", "#7b3f8c", "#4d1a5c"],
        "canopy" => &["#f7fcb9", "#d9f0a3", "#addd8e", "#78c679", "#41ab5d", "#238443", "#006837", "#004529"],
        other => return crate::automation::automap::ramp_colors(other, 5),
    };
    s.iter().map(|c| c.to_string()).collect()
}

pub fn hex_rgb(h: &str) -> [u8; 3] {
    let h = h.trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("80"), 16).unwrap_or(128);
    [p(0), p(2), p(4)]
}

fn lut(id: &str) -> Vec<[u8; 3]> {
    let stops: Vec<[u8; 3]> = ramp_stops(id).iter().map(|c| hex_rgb(c)).collect();
    (0..256)
        .map(|i| {
            let t = i as f64 / 255.0 * (stops.len() - 1) as f64;
            let j = (t.floor() as usize).min(stops.len() - 2);
            let f = t - j as f64;
            let (a, b) = (stops[j], stops[j + 1]);
            [0, 1, 2].map(|k| (a[k] as f64 + (b[k] as f64 - a[k] as f64) * f).round() as u8)
        })
        .collect()
}

pub fn ramp_css(id: &str) -> Vec<String> {
    ramp_stops(id)
}

/// AutoMap for rasters: a style and the reason for it, from what the raster is.
pub fn auto_style(info: &RasterInfo) -> (Value, String) {
    let s = info.stats.first().cloned().unwrap_or_default();
    let (lo, hi) = (s.p2, if s.p98 > s.p2 { s.p98 } else { s.max.max(s.p2 + 1e-6) });
    match info.kind.as_str() {
        "dem" => (
            json!({ "kind": "stretch", "ramp": "terrain", "min": lo, "max": hi, "opacity": 1.0 }),
            format!("elevation → hypsometric tint (green lowlands, brown slopes, white peaks) stretched over {:.0}–{:.0} m (2–98 %)", lo, hi),
        ),
        "dsm" => (
            json!({ "kind": "stretch", "ramp": "terrain", "min": lo, "max": hi, "opacity": 1.0 }),
            format!("surface heights (ground, roofs and tree tops) on the hypsometric tint, stretched over {:.0}–{:.0} m (2–98 %)", lo, hi),
        ),
        "chm" => {
            // most cells are bare ground (0 m), so percentiles say little: run to the tallest
            // canopy, rounded up to 5 m (the CHM is already spike-filtered)
            let top = (s.max.max(5.0) / 5.0).ceil() * 5.0;
            (
                json!({ "kind": "stretch", "ramp": "canopy", "min": 0.0, "max": top, "clear_below": 0.5, "opacity": 1.0 }),
                format!("canopy height from pale yellow-green (low) to dark green ({top:.0} m and taller); cells under 0.5 m (bare ground, roads, roofs) are left clear so the relief below shows through"),
            )
        }
        "hillshade" => (
            json!({ "kind": "stretch", "ramp": "gray", "min": 0, "max": 255, "opacity": 0.5, "blend": "multiply" }),
            "relief shading drawn at 50 % with multiply blending, so it darkens whatever is underneath without hiding it".into(),
        ),
        "slope" => (json!({ "kind": "stretch", "ramp": "slope", "min": 0, "max": 45, "opacity": 1.0 }), "slope 0–45° from pale yellow (flat) to dark red (steep)".into()),
        "aspect" => (json!({ "kind": "aspect", "opacity": 1.0 }), "aspect as a colour wheel (hue = compass direction); flat cells grey".into()),
        "ndvi" => (
            json!({ "kind": "stretch", "ramp": "ndvi", "min": -0.2, "max": 0.9, "opacity": 1.0 }),
            "NDVI on the conventional red–yellow–green ramp with a fixed −0.2…0.9 range, so maps from different dates compare".into(),
        ),
        "savi" | "evi" => (json!({ "kind": "stretch", "ramp": "ndvi", "min": -0.2, "max": 0.9, "opacity": 1.0 }), format!("{} on the red–yellow–green vegetation ramp (fixed −0.2…0.9)", info.kind.to_uppercase())),
        "ndwi" | "ndmi" => (json!({ "kind": "stretch", "ramp": "ndwi", "min": -0.6, "max": 0.6, "opacity": 1.0 }), format!("{} from brown (dry) to blue (wet), fixed −0.6…0.6", info.kind.to_uppercase())),
        "nbr" => (json!({ "kind": "stretch", "ramp": "ndvi", "min": -0.5, "max": 0.9, "opacity": 1.0 }), "NBR from red (burnt/bare) to green (healthy vegetation)".into()),
        "twi" => (json!({ "kind": "stretch", "ramp": "blues", "min": lo, "max": hi, "opacity": 1.0 }), "wetness index from pale (dry ridges) to dark blue (where water collects), stretched 2–98 %".into()),
        "tri" | "tpi" | "roughness" => (json!({ "kind": "stretch", "ramp": "rough", "min": lo, "max": hi, "opacity": 1.0 }), format!("{} stretched 2–98 % on a light-to-dark brown ramp", info.kind.to_uppercase())),
        "surface" => (
            json!({ "kind": "stretch", "ramp": "viridis", "min": lo, "max": hi, "opacity": 0.95 }),
            format!("interpolated surface on Viridis (perceptually even, colour-blind safe) stretched over {}–{}{} (2–98 %)", crate::automation::cartography::fmt_num(lo), crate::automation::cartography::fmt_num(hi), if info.units.is_empty() { String::new() } else { format!(" {}", info.units) }),
        ),
        "stderr" => {
            let top = if s.p98 > 0.0 { s.p98 } else { s.max.max(1e-6) };
            (
                json!({ "kind": "stretch", "ramp": "uncert", "min": 0.0, "max": top, "opacity": 0.95 }),
                "kriging standard error from pale (well supported by nearby samples) to dark purple (far from samples: treat the surface as a guess there)".into(),
            )
        }
        "classes" => (
            json!({ "kind": "classes", "classes": info.classes.iter().map(|(v, l, c)| json!({ "value": v, "label": l, "color": c })).collect::<Vec<_>>(), "opacity": 1.0 }),
            format!("{} classes, one colour each", info.classes.len()),
        ),
        "rgb" => {
            // one stretch for all three bands keeps the colour balance (per-band stretches turn vegetation purple)
            let lo = info.stats.iter().take(3).map(|b| b.p2.max(0.0)).fold(f64::MAX, f64::min);
            let hi = info.stats.iter().take(3).map(|b| b.p98).fold(f64::MIN, f64::max);
            let hi = if hi > lo { hi } else { 255.0 };
            (json!({ "kind": "rgb", "bands": [1, 2, 3], "min": [lo, lo, lo], "max": [hi, hi, hi], "gamma": 0.8, "opacity": 1.0 }), format!("true colour (bands 1-2-3), one 2–98 % stretch for all bands ({lo:.0}–{hi:.0}) so colours stay natural, gamma 0.8"))
        }
        _ => (json!({ "kind": "stretch", "ramp": "viridis", "min": lo, "max": hi, "opacity": 1.0 }), "Viridis (colour-blind safe) stretched 2–98 %".into()),
    }
}

/// Legend description shared by the web UI and the map composer.
pub fn legend(info: &RasterInfo, style: &Value) -> Value {
    match style["kind"].as_str().unwrap_or("") {
        "stretch" if style["ramp"] == "gray" => json!({ "type": "none" }),
        "stretch" => json!({ "type": "ramp", "colors": ramp_css(style["ramp"].as_str().unwrap_or("viridis")), "min": style["min"], "max": style["max"], "units": info.units }),
        "aspect" => {
            let items: Vec<Value> = [("#d7191c", "N"), ("#fdae61", "E"), ("#2c7bb6", "S"), ("#1a9641", "W"), ("#bdbdbd", "flat")].iter().map(|(c, l)| json!({ "color": c, "label": l })).collect();
            json!({ "type": "classes", "items": items })
        }
        "classes" => {
            let items: Vec<Value> = style["classes"].as_array().into_iter().flatten().map(|c| json!({ "color": c["color"], "label": c["label"], "share": c.get("share").cloned().unwrap_or(Value::Null) })).collect();
            json!({ "type": "classes", "items": items })
        }
        "rgb" => json!({ "type": "note", "label": format!("natural colour (red, green, blue) · {:.0} m pixels", info.pixel_m) }),
        _ => json!({ "type": "none" }),
    }
}

fn hsv(h: f64, s: f64, v: f64) -> [u8; 3] {
    let c = v * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [((r + m) * 255.0) as u8, ((g + m) * 255.0) as u8, ((b + m) * 255.0) as u8]
}

/// RGBA (premultiplied; alpha is 0 or 255) from band values; `alpha` marks covered pixels.
pub fn colorize(style: &Value, bands: &[Vec<f32>], alpha: Option<&[f32]>, nodata: Option<f64>) -> Vec<u8> {
    let n = bands.first().map(|b| b.len()).unwrap_or(0);
    let mut out = vec![0u8; n * 4];
    let kind = style["kind"].as_str().unwrap_or("stretch");
    let f = |k: &str, d: f64| style[k].as_f64().unwrap_or(d);
    let table = lut(style["ramp"].as_str().unwrap_or("viridis"));
    let classes: Vec<(f64, [u8; 3])> = style["classes"].as_array().into_iter().flatten().filter_map(|c| Some((c["value"].as_f64()?, hex_rgb(c["color"].as_str().unwrap_or("#888888"))))).collect();
    let (lo, hi) = (f("min", 0.0), f("max", 1.0));
    let span = if hi > lo { hi - lo } else { 1.0 };
    let mins: Vec<f64> = (0..3).map(|i| style["min"].get(i).and_then(Value::as_f64).unwrap_or(0.0)).collect();
    let maxs: Vec<f64> = (0..3).map(|i| style["max"].get(i).and_then(Value::as_f64).unwrap_or(255.0)).collect();
    let gamma = style["gamma"].as_f64().unwrap_or(1.0).clamp(0.2, 3.0);
    // stretch styles may leave low values transparent (canopy heights over the relief)
    let clear_below = if kind == "stretch" { style["clear_below"].as_f64() } else { None };
    for i in 0..n {
        if alpha.is_some_and(|a| !(a[i] > 0.0)) {
            continue;
        }
        let v = bands[0][i];
        if is_nodata(v, nodata) && kind != "aspect" {
            continue;
        }
        let rgb = match kind {
            "rgb" if bands.len() >= 3 => {
                let c = |b: usize| (((bands[b][i] as f64 - mins[b]) / (maxs[b] - mins[b]).max(1e-9)).clamp(0.0, 1.0).powf(gamma) * 255.0) as u8;
                if bands.iter().take(3).all(|b| b[i] == 0.0) {
                    continue;
                }
                [c(0), c(1), c(2)]
            }
            "aspect" => {
                if is_nodata(v, nodata) || v < 0.0 {
                    if alpha.is_none() && !v.is_finite() {
                        continue;
                    }
                    [189, 189, 189]
                } else {
                    // compass hue: N red (0), E orange-yellow, S blue, W green
                    let a = v as f64;
                    let hue = if a < 90.0 { a / 90.0 * 40.0 } else if a < 180.0 { 40.0 + (a - 90.0) / 90.0 * 170.0 } else if a < 270.0 { 210.0 - (a - 180.0) / 90.0 * 90.0 } else { 120.0 - (a - 270.0) / 90.0 * 120.0 };
                    hsv(hue, 0.65, 0.92)
                }
            }
            "classes" => match classes.iter().find(|(cv, _)| (*cv - v as f64).abs() < 1e-6) {
                Some((_, c)) => *c,
                None => continue,
            },
            _ => {
                if clear_below.is_some_and(|c| (v as f64) < c) {
                    continue;
                }
                table[(((v as f64 - lo) / span).clamp(0.0, 1.0) * 255.0).round() as usize]
            }
        };
        out[i * 4..i * 4 + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
    }
    out
}

pub fn merc(lon: f64, lat: f64) -> [f64; 2] {
    const R: f64 = 6_378_137.0;
    let lat = lat.clamp(-85.05112878, 85.05112878);
    [lon.to_radians() * R, (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0).tan().ln() * R]
}

pub fn encode_png(rgba: Vec<u8>, w: usize, h: usize) -> Result<Vec<u8>, String> {
    let size = resvg::tiny_skia::IntSize::from_wh(w as u32, h as u32).ok_or("bad image size")?;
    let pm = resvg::tiny_skia::Pixmap::from_vec(rgba, size).ok_or("bad pixmap")?;
    pm.encode_png().map_err(|e| e.to_string())
}

impl RasterHandle {
    pub fn new(info: RasterInfo) -> Self {
        let (style, why) = auto_style(&info);
        RasterHandle { info, style: RwLock::new(style), why: RwLock::new(why), overlays: Mutex::new(Vec::new()) }
    }

    pub fn style(&self) -> Value {
        self.style.read().unwrap().clone()
    }

    pub fn set_style(&self, s: Value) {
        *self.style.write().unwrap() = s;
        self.overlays.lock().unwrap().clear();
    }

    /// Render the raster into a Web Mercator box (`merc` = [xmin, ymin, xmax, ymax]) as RGBA.
    pub fn render_rgba(&self, style: &Value, merc_box: [f64; 4], w: usize, h: usize) -> Result<Vec<u8>, String> {
        let ds = open(&self.info.path)?;
        let kind = style["kind"].as_str().unwrap_or("stretch");
        let mut args = strings(&["-of", "MEM", "-t_srs", "EPSG:3857", "-ot", "Float32", "-dstalpha", "-r"]);
        args.push(if kind == "classes" || kind == "aspect" { "near".into() } else { "bilinear".into() });
        args.extend(["-te".to_string(), merc_box[0].to_string(), merc_box[1].to_string(), merc_box[2].to_string(), merc_box[3].to_string()]);
        args.extend(["-ts".to_string(), w.to_string(), h.to_string()]);
        let nb = if kind == "rgb" { 3.min(self.info.bands) } else { 1 };
        for b in 1..=nb {
            args.extend(["-srcband".to_string(), b.to_string()]);
        }
        if self.info.nodata.is_none() && kind != "rgb" {
            // without a declared nodata value, keep every source pixel and let the alpha band mark coverage
        }
        let out = warp(&[&ds], "", &args)?;
        let mut bands = Vec::new();
        for b in 1..=nb {
            let band = out.rasterband(b).map_err(|e| e.to_string())?;
            bands.push(band.read_band_as::<f32>().map_err(|e| e.to_string())?.into_shape_and_vec().1);
        }
        let alpha = out.rasterband(nb + 1).map_err(|e| e.to_string())?.read_band_as::<f32>().map_err(|e| e.to_string())?.into_shape_and_vec().1;
        Ok(colorize(style, &bands, Some(&alpha), self.info.nodata))
    }

    /// The whole raster as a PNG in Web Mercator for the web map (cached per style and size).
    pub fn overlay_png(&self, max: usize) -> Result<Arc<Vec<u8>>, String> {
        let style = self.style();
        let key = format!("{}:{max}", style);
        if let Some((_, png)) = self.overlays.lock().unwrap().iter().find(|(k, _)| *k == key) {
            return Ok(png.clone());
        }
        let b = self.info.bounds;
        let (a, c) = (merc(b[0], b[1]), merc(b[2], b[3]));
        let (mw, mh) = (c[0] - a[0], c[1] - a[1]);
        let native = (self.info.width.max(self.info.height) as f64 * 1.15).max(64.0) as usize;
        let long = native.min(max.clamp(64, MAX_OVERLAY));
        let (w, h) = if mw >= mh { (long, ((long as f64 * mh / mw).round() as usize).max(1)) } else { (((long as f64 * mw / mh).round() as usize).max(1), long) };
        let rgba = self.render_rgba(&style, [a[0], a[1], c[0], c[1]], w, h)?;
        let png = Arc::new(encode_png(rgba, w, h)?);
        let mut cache = self.overlays.lock().unwrap();
        cache.push((key, png.clone()));
        if cache.len() > 4 {
            cache.remove(0);
        }
        Ok(png)
    }

    pub fn json(&self) -> Value {
        let i = &self.info;
        let style = self.style();
        let b = i.bounds;
        let v = crate::automation::steps::fnv64(&style.to_string());
        let why = self.why.read().unwrap().clone();
        json!({
            "id": i.id, "name": i.name, "title": i.title, "kind": i.kind, "path": i.path, "width": i.width, "height": i.height,
            "bands": i.bands, "dtype": i.dtype, "crs": i.crs, "bounds": b, "pixel_m": (i.pixel_m * 100.0).round() / 100.0, "nodata": i.nodata,
            "units": i.units, "description": i.description,
            "stats": i.stats.iter().map(|s| json!({ "min": s.min, "max": s.max, "mean": s.mean, "std": s.std, "p2": s.p2, "p98": s.p98, "valid": s.valid })).collect::<Vec<_>>(),
            "legend": legend(i, &style), "why": why, "style": style,
            "overlay": { "url": format!("/api/rasters/{}/overlay.png?v={v}", i.id), "coordinates": [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]] },
        })
    }
}

// ------------------------------------------------------------------ writing

/// Write a single-band raster (via MEM + gdal_translate so it ends up a compressed, tiled GeoTIFF).
pub fn write_tif_f32(path: &Path, w: usize, h: usize, gt: [f64; 6], wkt: &str, data: Vec<f32>, nodata: Option<f64>) -> Result<(), String> {
    let drv = DriverManager::get_driver_by_name("MEM").map_err(|e| e.to_string())?;
    let mut ds = drv.create_with_band_type::<f32, _>("", w, h, 1).map_err(|e| e.to_string())?;
    ds.set_geo_transform(&gt).map_err(|e| e.to_string())?;
    ds.set_projection(wkt).map_err(|e| e.to_string())?;
    {
        let mut b = ds.rasterband(1).map_err(|e| e.to_string())?;
        b.set_no_data_value(nodata).map_err(|e| e.to_string())?;
        let mut buf = Buffer::new((w, h), data);
        b.write((0, 0), (w, h), &mut buf).map_err(|e| e.to_string())?;
    }
    save_gtiff(&ds, path, true)
}

pub fn write_tif_u8(path: &Path, w: usize, h: usize, gt: [f64; 6], wkt: &str, data: Vec<u8>, nodata: Option<f64>) -> Result<(), String> {
    let drv = DriverManager::get_driver_by_name("MEM").map_err(|e| e.to_string())?;
    let mut ds = drv.create_with_band_type::<u8, _>("", w, h, 1).map_err(|e| e.to_string())?;
    ds.set_geo_transform(&gt).map_err(|e| e.to_string())?;
    ds.set_projection(wkt).map_err(|e| e.to_string())?;
    {
        let mut b = ds.rasterband(1).map_err(|e| e.to_string())?;
        b.set_no_data_value(nodata).map_err(|e| e.to_string())?;
        let mut buf = Buffer::new((w, h), data);
        b.write((0, 0), (w, h), &mut buf).map_err(|e| e.to_string())?;
    }
    save_gtiff(&ds, path, false)
}

/// Copy any dataset to a compressed GeoTIFF atomically (`.part` then rename).
pub fn save_gtiff(ds: &Dataset, path: &Path, float: bool) -> Result<(), String> {
    let tmp = path.with_extension("part.tif");
    let mut args = strings(&["-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES"]);
    if float {
        args.extend(strings(&["-co", "PREDICTOR=3"]));
    }
    drop(translate(ds, &tmp.to_string_lossy(), &args)?);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Read band 1 at full resolution (the AOI rasters the steps make are small).
pub fn read_full(ds: &Dataset, band: usize) -> Result<(Vec<f32>, usize, usize), String> {
    let (w, h) = ds.raster_size();
    let b = ds.rasterband(band).map_err(|e| e.to_string())?;
    Ok((b.read_band_as::<f32>().map_err(|e| e.to_string())?.into_shape_and_vec().1, w, h))
}

/// Ground area of one pixel in m² (projected rasters; geographic ones use the latitude).
pub fn pixel_area_m2(ds: &Dataset, lat: f64) -> f64 {
    let gt = ds.geo_transform().unwrap_or([0.0, 1.0, 0.0, 0.0, 0.0, -1.0]);
    let geographic = srs_of(ds).is_none_or(|s| s.is_geographic());
    let a = (gt[1] * gt[5]).abs();
    if geographic { a * 111_320.0 * 111_320.0 * lat.to_radians().cos() } else { a }
}

// ------------------------------------------------------------------ engine registry

impl Engine {
    pub fn rasters(&self) -> Vec<Arc<RasterHandle>> {
        self.rasters.read().unwrap().clone()
    }

    pub fn raster(&self, id: &str) -> Option<Arc<RasterHandle>> {
        self.rasters.read().unwrap().iter().find(|r| r.info.id == id).cloned()
    }

    /// Open a raster file and add (or replace) it under `id`.
    pub fn register_raster(&self, path: &Path, id: &str) -> Result<Arc<RasterHandle>, String> {
        let h = Arc::new(RasterHandle::new(open_info(path, id)?));
        let mut r = self.rasters.write().unwrap();
        r.retain(|x| x.info.id != id);
        r.push(h.clone());
        Ok(h)
    }

    pub fn rasters_json(&self) -> Value {
        json!({ "rasters": self.rasters().iter().map(|r| r.json()).collect::<Vec<_>>() })
    }
}

pub fn load_all(paths: &[PathBuf], warnings: &mut Vec<String>) -> Vec<Arc<RasterHandle>> {
    let mut out: Vec<Arc<RasterHandle>> = Vec::new();
    for p in discover(paths) {
        let id = sanitize(&p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
        match open_info(&p, &id) {
            Ok(i) if out.iter().any(|r| r.info.id == i.id) => warnings.push(format!("duplicate raster id {}", i.id)),
            Ok(i) => out.push(Arc::new(RasterHandle::new(i))),
            Err(e) => warnings.push(e),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_and_kinds() {
        let v: Vec<f32> = (0..1000).map(|i| i as f32).chain([NODATA as f32; 10]).collect();
        let s = stats_of(&v, Some(NODATA), false);
        assert_eq!(s.min, 0.0);
        assert_eq!(s.max, 999.0);
        assert!((s.p2 - 20.0).abs() < 1.5 && (s.p98 - 979.0).abs() < 1.5);
        assert!((s.valid - 1000.0 / 1010.0).abs() < 1e-9);
        let c = stats_of(&[1.0, 2.0, 2.0, 3.0, 0.0], Some(0.0), true);
        assert_eq!(c.distinct.as_ref().unwrap().len(), 3);
        assert_eq!(guess_kind("Copernicus_DSM_COG_10_S06", 1, "Float32", &s), "dem");
        assert_eq!(guess_kind("ndvi_2026-10-10", 1, "Float32", &s), "ndvi");
        assert_eq!(guess_kind("site", 3, "Byte", &s), "rgb");
        assert_eq!(guess_kind("landuse", 1, "Byte", &c), "classes");
    }

    #[test]
    fn colorize_ramps_classes_and_nodata() {
        let style = json!({ "kind": "stretch", "ramp": "gray", "min": 0, "max": 10 });
        let px = colorize(&style, &[vec![0.0, 10.0, NODATA as f32]], None, Some(NODATA));
        assert_eq!(&px[0..4], &[0, 0, 0, 255]);
        assert_eq!(&px[4..8], &[255, 255, 255, 255]);
        assert_eq!(px[11], 0, "nodata is transparent");
        let cls = json!({ "kind": "classes", "classes": [{ "value": 1, "color": "#ff0000" }, { "value": 2, "color": "#00ff00" }] });
        let px = colorize(&cls, &[vec![2.0, 1.0, 3.0]], None, None);
        assert_eq!(&px[0..4], &[0, 255, 0, 255]);
        assert_eq!(&px[4..8], &[255, 0, 0, 255]);
        assert_eq!(px[11], 0, "unknown class is transparent");
        let m = merc(180.0, 0.0);
        assert!((m[0] - 20_037_508.34).abs() < 0.1 && m[1].abs() < 1e-6);
    }
}
