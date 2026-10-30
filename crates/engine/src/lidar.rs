//! LiDAR point clouds → terrain (docs/AUTOMATION.md §4 `lidar.grid`, docs/DEVICES.md).
//!
//! LAS 1.0–1.4 and LAZ (including COPC) are streamed once through `las` + `laz-rs` (pure Rust,
//! so the Windows build needs nothing extra) into per-cell grids, and then:
//!
//! * **ground (DTM)**: the file's own classification when it has one (class 2, as delivered by
//!   national LiDAR programmes and drone software), else SMRF, the simple morphological filter
//!   (Pingel, Clarke & McBride 2013, ISPRS J. 77:21-30; the algorithm behind PDAL's
//!   `filters.smrf`) on a minimum-elevation grid; gaps (under buildings, water) are filled by
//!   GDAL's inverse-distance fill;
//! * **surface (DSM)**: the highest return per cell, with isolated spikes (birds, multipath)
//!   removed;
//! * **height above ground (CHM / nDSM)** = DSM − DTM;
//! * **buildings**: the building class when the file has one, else planar regions ≥ 20 m² that
//!   stand ≥ 2.5 m above the ground, polygonised;
//! * **tree tops**: local maxima of the smoothed CHM in a window as wide as the expected crown
//!   (Popescu & Wynne 2004: crown width = 2.51503 + 0.00901 h²), outside buildings.
//!
//! Grids are f32 with NaN for "no data"; rows run north to south (GDAL order). Coordinates stay
//! in the file's projected CRS when it is metric; geographic or foot-based files are gridded in
//! their UTM zone (heights converted to metres).

use gdal::raster::Buffer;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::vector::{LayerAccess, LayerOptions};
use gdal::DriverManager;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// Largest grid (cells) built in memory; an automatic resolution coarsens until the area fits.
pub const MAX_CELLS: usize = 6_000_000;
/// Candidate cell sizes in metres, finest first.
pub const NICE_RES: [f64; 12] = [0.05, 0.1, 0.2, 0.25, 0.5, 1.0, 2.0, 2.5, 5.0, 10.0, 20.0, 50.0];
const BATCH: u64 = 250_000;
const NODATA: f32 = -9999.0;

/// ASPRS LAS classification codes 0–18 (LAS 1.4 R15, table 17).
pub fn class_name(c: u8) -> String {
    match c {
        0 => "never classified",
        1 => "unclassified",
        2 => "ground",
        3 => "low vegetation",
        4 => "medium vegetation",
        5 => "high vegetation",
        6 => "building",
        7 => "low noise",
        8 => "model key point",
        9 => "water",
        10 => "rail",
        11 => "road surface",
        12 => "overlap",
        13 => "wire guard",
        14 => "wire conductor",
        15 => "transmission tower",
        16 => "wire connector",
        17 => "bridge deck",
        18 => "high noise",
        _ => return format!("class {c}"),
    }
    .to_string()
}

pub fn is_cloud_file(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("las") || e.eq_ignore_ascii_case("laz"))
}

/// LAS/LAZ files in a folder (recursively, sorted), or the file itself.
pub fn find_clouds(root: &Path, max: usize) -> Vec<PathBuf> {
    if root.is_file() {
        return if is_cloud_file(root) { vec![root.to_path_buf()] } else { vec![] };
    }
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            // follow symlinks (a linked folder of tiles); the depth limit ends any loop
            let md = match e.file_type() {
                Ok(t) if t.is_symlink() => std::fs::metadata(&p),
                _ => e.metadata(),
            };
            match md {
                Ok(m) if m.is_dir() && depth < 6 => stack.push((p, depth + 1)),
                Ok(m) if m.is_file() && is_cloud_file(&p) => out.push(p),
                _ => {}
            }
            if out.len() >= max {
                break;
            }
        }
    }
    out.sort();
    out
}

// ------------------------------------------------------------------ headers

/// What a LAS/LAZ header says (read without touching the points).
#[derive(Debug, Clone, Default)]
pub struct CloudHeader {
    pub path: PathBuf,
    pub version: String,
    pub format: u8,
    pub compressed: bool,
    pub points: u64,
    /// min x, min y, min z, max x, max y, max z in file units
    pub bounds: [f64; 6],
    pub epsg: Option<u32>,
    pub wkt: Option<String>,
    pub software: String,
    pub date: Option<String>,
    pub bytes: u64,
}

pub fn read_header(path: &Path) -> Result<CloudHeader, String> {
    let r = las::Reader::from_path(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let h = r.header();
    let b = h.bounds();
    let v = h.version();
    let wkt = h
        .get_wkt_crs_bytes()
        .map(|w| String::from_utf8_lossy(w).trim_matches(char::from(0)).trim().to_string())
        .filter(|w| w.len() > 10);
    let usable = |c: Option<u16>| c.filter(|c| (1024..32767).contains(c)).map(u32::from);
    let epsg = match h.get_geotiff_crs() {
        Ok(Some(g)) => usable(g.get_projected_crs_geo_key_value()).or_else(|| usable(g.get_geodetic_crs_geo_key_value())),
        _ => None,
    };
    let fmt = h.point_format();
    Ok(CloudHeader {
        path: path.to_path_buf(),
        version: format!("{}.{}", v.major, v.minor),
        format: fmt.to_u8().unwrap_or(0),
        compressed: fmt.is_compressed,
        points: h.number_of_points(),
        bounds: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z],
        epsg,
        wkt,
        software: h.generating_software().trim().to_string(),
        date: h.date().map(|d| d.to_string()),
        bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    })
}

fn gis_order(mut s: SpatialRef) -> SpatialRef {
    s.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    s
}

pub fn wgs84() -> SpatialRef {
    gis_order(SpatialRef::from_epsg(4326).expect("EPSG:4326"))
}

impl CloudHeader {
    /// "EPSG:32755", "WKT" (a coordinate system without an EPSG code) or "none".
    pub fn crs_label(&self) -> String {
        match (&self.epsg, &self.wkt) {
            (Some(e), _) => format!("EPSG:{e}"),
            (None, Some(w)) => SpatialRef::from_wkt(w).ok().and_then(|s| s.auth_code().ok()).map(|c| format!("EPSG:{c}")).unwrap_or_else(|| "WKT".into()),
            _ => "none".into(),
        }
    }

    /// The file's coordinate system (`force` overrides whatever the file says).
    pub fn srs(&self, force: Option<u32>) -> Result<SpatialRef, String> {
        let s = if let Some(e) = force {
            SpatialRef::from_epsg(e).map_err(|x| format!("EPSG:{e}: {x}"))?
        } else if let Some(w) = &self.wkt {
            SpatialRef::from_wkt(w).map_err(|x| format!("{}: unreadable WKT coordinate system ({x})", self.path.display()))?
        } else if let Some(e) = self.epsg {
            SpatialRef::from_epsg(e).map_err(|x| format!("EPSG:{e}: {x}"))?
        } else {
            return Err(format!(
                "{} has no coordinate system (no WKT or GeoTIFF keys in its header); pass epsg: with the EPSG code of the survey, e.g. epsg: 32755",
                self.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
            ));
        };
        Ok(gis_order(s))
    }

    /// Footprint in lon/lat ([west, south, east, north]) when the coordinate system is known.
    pub fn lonlat_bounds(&self) -> Option<[f64; 4]> {
        lonlat_of(&self.srs(None).ok()?, [self.bounds[0], self.bounds[1], self.bounds[3], self.bounds[4]])
    }
}

/// A box in `srs` as lon/lat ([west, south, east, north]).
fn lonlat_of(srs: &SpatialRef, b: [f64; 4]) -> Option<[f64; 4]> {
    if srs.is_geographic() {
        return Some(b);
    }
    let ct = CoordTransform::new(srs, &wgs84()).ok()?;
    ct.transform_bounds(&b, 21).ok()
}

// ------------------------------------------------------------------ gridding

#[derive(Debug, Clone)]
pub struct GridSpec {
    pub x0: f64,
    pub y1: f64,
    pub res: f64,
    pub w: usize,
    pub h: usize,
    pub wkt: String,
    pub epsg: Option<u32>,
}

impl GridSpec {
    pub fn geo_transform(&self) -> [f64; 6] {
        [self.x0, self.res, 0.0, self.y1, 0.0, -self.res]
    }

    #[inline]
    fn cell(&self, x: f64, y: f64) -> Option<usize> {
        let cx = ((x - self.x0) / self.res).floor();
        let cy = ((self.y1 - y) / self.res).floor();
        if cx < 0.0 || cy < 0.0 || cx >= self.w as f64 || cy >= self.h as f64 {
            return None;
        }
        Some(cy as usize * self.w + cx as usize)
    }

    pub fn center(&self, i: usize) -> (f64, f64) {
        (self.x0 + ((i % self.w) as f64 + 0.5) * self.res, self.y1 - ((i / self.w) as f64 + 0.5) * self.res)
    }
}

/// Cell size from point density: about 1.6 / √density (≈ 2–3 points per cell), snapped to a
/// round value, then coarsened until the area fits in `MAX_CELLS`.
pub fn auto_resolution(density: f64, area_m2: f64) -> f64 {
    let raw = if density > 0.0 { 1.6 / density.sqrt() } else { 1.0 };
    let mut i = 0;
    for (j, r) in NICE_RES.iter().enumerate() {
        if (r / raw).ln().abs() < (NICE_RES[i] / raw).ln().abs() {
            i = j;
        }
    }
    while i + 1 < NICE_RES.len() && area_m2 / (NICE_RES[i] * NICE_RES[i]) > MAX_CELLS as f64 {
        i += 1;
    }
    NICE_RES[i]
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GroundMode {
    Auto,
    Classes,
    Smrf,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Cell size in metres (None = from the point density).
    pub resolution: Option<f64>,
    /// Force this coordinate system for every file.
    pub epsg: Option<u32>,
    pub ground: GroundMode,
    /// Only this lon/lat box.
    pub aoi: Option<[f64; 4]>,
    /// Lowest tree top reported (m).
    pub min_tree: f64,
    /// SMRF maximum window radius (m): buildings up to about twice this wide are removed.
    pub window: f64,
    /// Refuse more points than this (reading 1e9 LAZ points takes minutes).
    pub max_points: u64,
    /// Keep about this many evenly spread points (every n-th) for 3D views; 0 = none.
    pub sample: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { resolution: None, epsg: None, ground: GroundMode::Auto, aoi: None, min_tree: 3.0, window: 18.0, max_points: 2_000_000_000, sample: 0 }
    }
}

/// One kept point (grid CRS metres) for 3D views.
#[derive(Debug, Clone, Copy)]
pub struct SamplePoint {
    pub x: f64,
    pub y: f64,
    pub z: f32,
    pub class: u8,
    /// colour from the file (16-bit as stored; 0 when the format has none)
    pub rgb: [u16; 3],
}

/// Byte offset of the red/green/blue fields in a raw point record, for formats that have them.
fn rgb_offset(format: u8) -> Option<usize> {
    match format {
        2 => Some(20),
        3 | 5 => Some(28),
        7 | 8 | 10 => Some(30),
        _ => None,
    }
}

/// Per-cell accumulators from one pass over the points.
pub struct Grids {
    pub spec: GridSpec,
    /// lowest and highest kept return per cell (metres)
    pub zmin: Vec<f32>,
    pub zmax: Vec<f32>,
    /// ground and water (classes 2, 9) points: sum of (z − zref) and count
    gsum: Vec<f32>,
    gcnt: Vec<u16>,
    zref: f64,
    /// highest vegetation (classes 3-5) return per cell
    pub vmax: Vec<f32>,
    /// a building (class 6) point fell in the cell
    pub building: Vec<bool>,
    pub classes: [u64; 256],
    pub sample: Vec<SamplePoint>,
    pub read: u64,
    pub used: u64,
    pub noise: u64,
    pub withheld: u64,
    pub outside: u64,
}

struct Src {
    header: CloudHeader,
    ct: Option<CoordTransform>,
    zscale: f64,
}

/// Plan the grid for a set of files: target CRS, extent, resolution.
fn plan(headers: Vec<CloudHeader>, o: &Options) -> Result<(Vec<Src>, GridSpec, f64, Vec<String>), String> {
    let mut notes = Vec::new();
    let first = headers.first().ok_or("no LAS/LAZ files")?;
    let srs0 = first.srs(o.epsg)?;
    let metric = srs0.is_projected() && (srs0.linear_units() - 1.0).abs() < 1e-9;
    let target = if metric {
        srs0.clone()
    } else {
        let ll = lonlat_of(&srs0, [first.bounds[0], first.bounds[1], first.bounds[3], first.bounds[4]]).ok_or("cannot place the point cloud on Earth (its coordinate system has no transformation to longitude/latitude)")?;
        let e = crate::automation::features::utm_epsg((ll[0] + ll[2]) / 2.0, (ll[1] + ll[3]) / 2.0);
        notes.push(if srs0.is_geographic() {
            format!("the points are in longitude/latitude, so they were gridded in UTM (EPSG:{e}) to keep cells square and slopes in metres")
        } else {
            format!("the coordinates are in {} ({:.4} m), so they were gridded in UTM (EPSG:{e}) with heights converted to metres", srs0.linear_units_name().unwrap_or_else(|| "feet".into()), srs0.linear_units())
        });
        gis_order(SpatialRef::from_epsg(e).map_err(|x| x.to_string())?)
    };
    let mut srcs = Vec::new();
    let mut ext: Option<[f64; 4]> = None;
    let mut area = 0.0;
    let mut points = 0u64;
    for h in headers {
        let srs = h.srs(o.epsg)?;
        let same = srs == target;
        let zscale = if srs.is_projected() { srs.linear_units() } else { 1.0 };
        let ct = if same { None } else { Some(CoordTransform::new(&srs, &target).map_err(|x| format!("{}: {x}", h.path.display()))?) };
        let b = [h.bounds[0], h.bounds[1], h.bounds[3], h.bounds[4]];
        let tb = match &ct {
            Some(c) => c.transform_bounds(&b, 21).map_err(|x| format!("{}: {x}", h.path.display()))?,
            None => b,
        };
        area += ((tb[2] - tb[0]) * (tb[3] - tb[1])).max(1.0);
        points += h.points;
        ext = Some(match ext {
            None => tb,
            Some(e) => [e[0].min(tb[0]), e[1].min(tb[1]), e[2].max(tb[2]), e[3].max(tb[3])],
        });
        srcs.push(Src { header: h, ct, zscale });
    }
    let mut ext = ext.ok_or("no LAS/LAZ files")?;
    if points > o.max_points {
        return Err(format!("{points} points is more than max_points ({}); pass aoi: to grid part of the area, or raise max_points:", o.max_points));
    }
    let density = points as f64 / area.max(1.0);
    if let Some(a) = o.aoi {
        let ct = CoordTransform::new(&wgs84(), &target).map_err(|x| x.to_string())?;
        let t = ct.transform_bounds(&a, 21).map_err(|x| x.to_string())?;
        ext = [ext[0].max(t[0]), ext[1].max(t[1]), ext[2].min(t[2]), ext[3].min(t[3])];
        if ext[0] >= ext[2] || ext[1] >= ext[3] {
            return Err("the area of interest does not overlap the point cloud".into());
        }
        // only the tiles that touch the area
        srcs.retain(|s| {
            let b = [s.header.bounds[0], s.header.bounds[1], s.header.bounds[3], s.header.bounds[4]];
            let tb = s.ct.as_ref().and_then(|c| c.transform_bounds(&b, 5).ok()).unwrap_or(b);
            tb[0] < ext[2] && tb[2] > ext[0] && tb[1] < ext[3] && tb[3] > ext[1]
        });
    }
    // headers are written before coordinates are rounded to the file's scale, so a point can sit
    // a fraction of a millimetre outside them: pad by 1 cm
    let ext = [ext[0] - 0.01, ext[1] - 0.01, ext[2] + 0.01, ext[3] + 0.01];
    let ext_area = (ext[2] - ext[0]) * (ext[3] - ext[1]);
    let res = match o.resolution.filter(|r| *r > 0.0) {
        Some(r) if ext_area / (r * r) <= MAX_CELLS as f64 => r,
        Some(r) => {
            let a = auto_resolution(0.0, ext_area).max(r);
            let a = NICE_RES.iter().copied().find(|n| *n >= r && ext_area / (n * n) <= MAX_CELLS as f64).unwrap_or(a);
            notes.push(format!("{r} m cells would need {:.0} million cells for this area, so {a} m was used", ext_area / (r * r) / 1e6));
            a
        }
        None => auto_resolution(density, ext_area),
    };
    let x0 = (ext[0] / res).floor() * res;
    let y1 = (ext[3] / res).ceil() * res;
    // floor + 1 keeps points that sit exactly on the east or south edge
    let w = ((ext[2] - x0) / res).floor() as usize + 1;
    let h = ((y1 - ext[1]) / res).floor() as usize + 1;
    let epsg = target.auth_code().ok().map(|c| c as u32);
    let wkt = target.to_wkt().map_err(|x| x.to_string())?;
    Ok((srcs, GridSpec { x0, y1, res, w, h, wkt, epsg }, density, notes))
}

/// Stream every point of every file into the grids.
fn grid_points(srcs: &[Src], spec: GridSpec, sample: usize, cancel: &AtomicBool) -> Result<Grids, String> {
    let n = spec.w * spec.h;
    let total: u64 = srcs.iter().map(|s| s.header.points).sum();
    let every = if sample == 0 { u64::MAX } else { total.div_ceil(sample as u64).max(1) };
    let zref = srcs.iter().map(|s| s.header.bounds[2] * s.zscale).fold(f64::MAX, f64::min);
    let zref = if zref.is_finite() { zref } else { 0.0 };
    let mut g = Grids {
        spec,
        zmin: vec![f32::NAN; n],
        zmax: vec![f32::NAN; n],
        gsum: vec![0.0; n],
        gcnt: vec![0; n],
        zref,
        vmax: vec![f32::NAN; n],
        building: vec![false; n],
        classes: [0; 256],
        sample: Vec::with_capacity(sample.min(4_000_000)),
        read: 0,
        used: 0,
        noise: 0,
        withheld: 0,
        outside: 0,
    };
    let (mut xs, mut ys, mut zs, mut dz) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for s in srcs {
        let mut r = las::Reader::from_path(&s.header.path).map_err(|e| format!("{}: {e}", s.header.path.display()))?;
        let mut data = las::PointDataBuilder::new().for_header(r.header()).build();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let got = r.fill_points(BATCH, &mut data).map_err(|e| format!("{}: {e}", s.header.path.display()))?;
            if got == 0 {
                break;
            }
            xs.clear();
            ys.clear();
            zs.clear();
            xs.extend(data.x());
            ys.extend(data.y());
            zs.extend(data.z());
            if let Some(ct) = &s.ct {
                dz.clear();
                dz.resize(xs.len(), 0.0);
                ct.transform_coords(&mut xs, &mut ys, &mut dz).map_err(|e| format!("reprojecting points: {e}"))?;
            }
            let ext = data.format().is_extended;
            let rgb_at = rgb_offset(data.format().to_u8().unwrap_or(0));
            let rec = data.record_len();
            let raw = data.raw_bytes();
            g.read += got;
            for i in 0..xs.len() {
                let r = &raw[i * rec..(i + 1) * rec];
                let class = if ext { r[16] } else { r[15] & 0x1f };
                let withheld = if ext { r[15] & 0b100 != 0 } else { r[15] & 0x80 != 0 };
                if withheld {
                    g.withheld += 1;
                    continue;
                }
                if class == 7 || class == 18 {
                    g.noise += 1;
                    g.classes[class as usize] += 1;
                    continue;
                }
                let Some(c) = g.spec.cell(xs[i], ys[i]) else {
                    g.outside += 1;
                    continue;
                };
                let z = zs[i] * s.zscale;
                let zf = z as f32;
                g.classes[class as usize] += 1;
                if g.used.is_multiple_of(every) {
                    let rgb = match rgb_at {
                        Some(o) if o + 6 <= rec => [u16::from_le_bytes([r[o], r[o + 1]]), u16::from_le_bytes([r[o + 2], r[o + 3]]), u16::from_le_bytes([r[o + 4], r[o + 5]])],
                        _ => [0; 3],
                    };
                    g.sample.push(SamplePoint { x: xs[i], y: ys[i], z: zf, class, rgb });
                }
                g.used += 1;
                if !(g.zmin[c] <= zf) {
                    g.zmin[c] = zf;
                }
                if !(g.zmax[c] >= zf) {
                    g.zmax[c] = zf;
                }
                match class {
                    // bare earth is the ground and the water surface (as in USGS 3DEP DEMs)
                    2 | 9 if g.gcnt[c] < u16::MAX => {
                        g.gsum[c] += (z - zref) as f32;
                        g.gcnt[c] += 1;
                    }
                    3..=5 => {
                        if !(g.vmax[c] >= zf) {
                            g.vmax[c] = zf;
                        }
                    }
                    6 => g.building[c] = true,
                    _ => {}
                }
            }
        }
    }
    Ok(g)
}

/// Every n-th point of `paths` (about `max` in all) in the coordinate system `target_wkt`
/// (heights in metres), for 3D views of point clouds that were not gridded in this run.
pub fn sample_files(paths: &[PathBuf], target_wkt: &str, epsg: Option<u32>, max: usize, cancel: &AtomicBool) -> Result<(Vec<SamplePoint>, u64), String> {
    let mut target = SpatialRef::from_wkt(target_wkt).map_err(|e| e.to_string())?;
    target.set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);
    let mut srcs = Vec::new();
    for p in paths {
        let h = read_header(p)?;
        if h.points == 0 {
            continue;
        }
        let srs = h.srs(epsg)?;
        let zscale = if srs.is_projected() { srs.linear_units() } else { 1.0 };
        let ct = if srs == target { None } else { Some(CoordTransform::new(&srs, &target).map_err(|x| format!("{}: {x}", h.path.display()))?) };
        srcs.push(Src { header: h, ct, zscale });
    }
    let total: u64 = srcs.iter().map(|s| s.header.points).sum();
    let every = total.div_ceil(max.max(1) as u64).max(1);
    let mut out = Vec::with_capacity(max.min(4_000_000));
    let mut k = 0u64;
    let (mut xs, mut ys, mut zs, mut dz) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for s in &srcs {
        let mut r = las::Reader::from_path(&s.header.path).map_err(|e| format!("{}: {e}", s.header.path.display()))?;
        let mut data = las::PointDataBuilder::new().for_header(r.header()).build();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let got = r.fill_points(BATCH, &mut data).map_err(|e| format!("{}: {e}", s.header.path.display()))?;
            if got == 0 {
                break;
            }
            xs.clear();
            ys.clear();
            zs.clear();
            xs.extend(data.x());
            ys.extend(data.y());
            zs.extend(data.z());
            if let Some(ct) = &s.ct {
                dz.clear();
                dz.resize(xs.len(), 0.0);
                ct.transform_coords(&mut xs, &mut ys, &mut dz).map_err(|e| format!("reprojecting points: {e}"))?;
            }
            let ext = data.format().is_extended;
            let rgb_at = rgb_offset(data.format().to_u8().unwrap_or(0));
            let rec = data.record_len();
            let raw = data.raw_bytes();
            for i in 0..xs.len() {
                let r = &raw[i * rec..(i + 1) * rec];
                let class = if ext { r[16] } else { r[15] & 0x1f };
                let withheld = if ext { r[15] & 0b100 != 0 } else { r[15] & 0x80 != 0 };
                if withheld || class == 7 || class == 18 {
                    continue;
                }
                if k.is_multiple_of(every) {
                    let rgb = match rgb_at {
                        Some(o) if o + 6 <= rec => [u16::from_le_bytes([r[o], r[o + 1]]), u16::from_le_bytes([r[o + 2], r[o + 3]]), u16::from_le_bytes([r[o + 4], r[o + 5]])],
                        _ => [0; 3],
                    };
                    out.push(SamplePoint { x: xs[i], y: ys[i], z: (zs[i] * s.zscale) as f32, class, rgb });
                }
                k += 1;
            }
        }
    }
    Ok((out, total))
}

// ------------------------------------------------------------------ grid filters

/// Running min or max over `line` with window radius `r` (van Herk / Gil-Werman, O(n)).
/// NaN cells are ignored; a window with no values gives NaN.
fn extreme_1d(line: &[f32], out: &mut [f32], r: usize, max: bool, buf: &mut Vec<f32>, g: &mut Vec<f32>, h: &mut Vec<f32>) {
    let n = line.len();
    let k = 2 * r + 1;
    let ident = if max { f32::NEG_INFINITY } else { f32::INFINITY };
    let m = n + 2 * r;
    buf.clear();
    buf.resize(m, ident);
    for (b, v) in buf[r..r + n].iter_mut().zip(line) {
        *b = if v.is_nan() { ident } else { *v };
    }
    g.resize(m, 0.0);
    h.resize(m, 0.0);
    if max {
        for i in 0..m {
            g[i] = if i % k == 0 { buf[i] } else { g[i - 1].max(buf[i]) };
        }
        for i in (0..m).rev() {
            h[i] = if i == m - 1 || (i + 1) % k == 0 { buf[i] } else { h[i + 1].max(buf[i]) };
        }
        for i in 0..n {
            out[i] = h[i].max(g[i + k - 1]);
        }
    } else {
        for i in 0..m {
            g[i] = if i % k == 0 { buf[i] } else { g[i - 1].min(buf[i]) };
        }
        for i in (0..m).rev() {
            h[i] = if i == m - 1 || (i + 1) % k == 0 { buf[i] } else { h[i + 1].min(buf[i]) };
        }
        for i in 0..n {
            out[i] = h[i].min(g[i + k - 1]);
        }
    }
}

/// Square-window min or max filter of radius `r` cells (rows, then columns).
pub fn filter_square(src: &[f32], w: usize, h: usize, r: usize, max: bool) -> Vec<f32> {
    if r == 0 {
        return src.to_vec();
    }
    let (mut buf, mut g, mut hh) = (Vec::new(), Vec::new(), Vec::new());
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        extreme_1d(&src[y * w..(y + 1) * w], &mut tmp[y * w..(y + 1) * w], r, max, &mut buf, &mut g, &mut hh);
    }
    let mut out = vec![0f32; w * h];
    let (mut col, mut res) = (vec![0f32; h], vec![0f32; h]);
    for x in 0..w {
        for y in 0..h {
            col[y] = tmp[y * w + x];
        }
        // the row pass leaves ±inf where a whole window was empty: the identity of the same op
        extreme_1d(&col, &mut res, r, max, &mut buf, &mut g, &mut hh);
        for y in 0..h {
            let v = res[y];
            out[y * w + x] = if v.is_finite() { v } else { f32::NAN };
        }
    }
    out
}

/// Fill NaN cells by GDAL's inverse-distance interpolation (GDALFillNodata), up to `max_dist`
/// cells from data.
pub fn fill_gaps(data: &mut [f32], w: usize, h: usize, max_dist: f64, smoothing: i32) -> Result<(), String> {
    let gaps = data.iter().filter(|v| v.is_nan()).count();
    if gaps == 0 || gaps == data.len() {
        return Ok(());
    }
    let e = |x: gdal::errors::GdalError| x.to_string();
    let drv = DriverManager::get_driver_by_name("MEM").map_err(e)?;
    let ds = drv.create_with_band_type::<f32, _>("", w, h, 1).map_err(e)?;
    let mut band = ds.rasterband(1).map_err(e)?;
    band.set_no_data_value(Some(NODATA as f64)).map_err(e)?;
    let vals: Vec<f32> = data.iter().map(|v| if v.is_nan() { NODATA } else { *v }).collect();
    let mut buf = Buffer::new((w, h), vals);
    band.write((0, 0), (w, h), &mut buf).map_err(e)?;
    let err = unsafe { gdal_sys::GDALFillNodata(band.c_rasterband(), std::ptr::null_mut(), max_dist, 0, smoothing, std::ptr::null_mut(), None, std::ptr::null_mut()) };
    if err != gdal_sys::CPLErr::CE_None {
        return Err(format!("filling gaps: {}", crate::raster::last_error()));
    }
    let out = band.read_band_as::<f32>().map_err(e)?.into_shape_and_vec().1;
    for (d, v) in data.iter_mut().zip(out) {
        *d = if v == NODATA { f32::NAN } else { v };
    }
    Ok(())
}

/// 3×3 mean that skips NaN (NaN cells stay NaN).
fn smooth3(z: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut out = z.to_vec();
    for y in 0..h {
        for x in 0..w {
            if z[y * w + x].is_nan() {
                continue;
            }
            let (mut s, mut n) = (0.0f32, 0.0f32);
            for yy in y.saturating_sub(1)..(y + 2).min(h) {
                for xx in x.saturating_sub(1)..(x + 2).min(w) {
                    let v = z[yy * w + xx];
                    if !v.is_nan() {
                        s += v;
                        n += 1.0;
                    }
                }
            }
            out[y * w + x] = s / n;
        }
    }
    out
}

/// Bare cells (0) inside a crown — at least 6 of 8 neighbours above 0.5 m — take the mean of
/// those neighbours (laser shots that went through a gap, or no vegetation return in the cell).
fn fill_pinholes(c: &mut [f32], w: usize, h: usize) {
    let src = c.to_vec();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = y * w + x;
            if src[i] != 0.0 {
                continue;
            }
            let (mut s, mut k) = (0f32, 0);
            for (dx, dy) in [(-1i32, -1i32), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)] {
                let v = src[(y as i32 + dy) as usize * w + (x as i32 + dx) as usize];
                if v > 0.5 {
                    s += v;
                    k += 1;
                }
            }
            if k >= 6 {
                c[i] = s / k as f32;
            }
        }
    }
}

/// Gradient magnitude (rise over run) by central differences.
fn gradient(z: &[f32], w: usize, h: usize, cell: f64) -> Vec<f32> {
    let at = |x: usize, y: usize| z[y * w + x];
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(1), (x + 1).min(w - 1));
            let (y0, y1) = (y.saturating_sub(1), (y + 1).min(h - 1));
            let dx = if x1 > x0 { (at(x1, y) - at(x0, y)) as f64 / ((x1 - x0) as f64 * cell) } else { 0.0 };
            let dy = if y1 > y0 { (at(x, y1) - at(x, y0)) as f64 / ((y1 - y0) as f64 * cell) } else { 0.0 };
            let g = (dx * dx + dy * dy).sqrt();
            out[y * w + x] = if g.is_finite() { g as f32 } else { 0.0 };
        }
    }
    out
}

/// Bilinear sample of a (filled) grid at fractional cell coordinates (clamped to the edges).
fn bilinear(z: &[f32], w: usize, h: usize, u: f64, v: f64) -> f32 {
    let u = u.clamp(0.0, (w - 1) as f64);
    let v = v.clamp(0.0, (h - 1) as f64);
    let (x0, y0) = (u.floor() as usize, v.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = ((u - x0 as f64) as f32, (v - y0 as f64) as f32);
    let a = z[y0 * w + x0] * (1.0 - fx) + z[y0 * w + x1] * fx;
    let b = z[y1 * w + x0] * (1.0 - fx) + z[y1 * w + x1] * fx;
    a * (1.0 - fy) + b * fy
}

/// Remove isolated low cells (multipath, below-ground noise): more than `drop` below all of at
/// least three valid neighbours.
fn remove_low_outliers(z: &mut [f32], w: usize, h: usize, drop: f32) -> usize {
    let src = z.to_vec();
    let mut n = 0;
    for y in 0..h {
        for x in 0..w {
            let v = src[y * w + x];
            if v.is_nan() {
                continue;
            }
            let (mut lo, mut cnt) = (f32::INFINITY, 0);
            for yy in y.saturating_sub(1)..(y + 2).min(h) {
                for xx in x.saturating_sub(1)..(x + 2).min(w) {
                    let u = src[yy * w + xx];
                    if (yy, xx) != (y, x) && !u.is_nan() {
                        lo = lo.min(u);
                        cnt += 1;
                    }
                }
            }
            if cnt >= 3 && v < lo - drop {
                z[y * w + x] = f32::NAN;
                n += 1;
            }
        }
    }
    n
}

// ------------------------------------------------------------------ ground (SMRF)

#[derive(Debug, Clone)]
pub struct Smrf {
    /// cell size of the minimum surface (m)
    pub cell: f64,
    /// terrain slope that is still ground (rise over run)
    pub slope: f64,
    /// largest window radius (m)
    pub window: f64,
    /// elevation threshold (m) and its slope scaler for the final ground test
    pub threshold: f64,
    pub scalar: f64,
}

impl Default for Smrf {
    fn default() -> Self {
        Smrf { cell: 1.0, slope: 0.15, window: 18.0, threshold: 0.5, scalar: 1.25 }
    }
}

/// SMRF on a minimum-elevation grid (NaN = no points): returns the cells judged ground (their
/// minimum elevation) and NaN elsewhere.
pub fn smrf_ground(zmin: &[f32], w: usize, h: usize, res: f64, p: &Smrf) -> Result<Vec<f32>, String> {
    let k = ((p.cell / res).round() as usize).max(1);
    let c = res * k as f64;
    let (cw, ch) = (w.div_ceil(k), h.div_ceil(k));
    // 1. minimum surface at the SMRF cell size
    let mut zc = vec![f32::NAN; cw * ch];
    for y in 0..h {
        for x in 0..w {
            let v = zmin[y * w + x];
            if !v.is_nan() {
                let j = (y / k) * cw + x / k;
                if !(zc[j] <= v) {
                    zc[j] = v;
                }
            }
        }
    }
    // 2. isolated low outliers would become false ground: drop them
    remove_low_outliers(&mut zc, cw, ch, 1.0);
    let known: Vec<bool> = zc.iter().map(|v| !v.is_nan()).collect();
    if !known.iter().any(|b| *b) {
        return Ok(vec![f32::NAN; w * h]);
    }
    // 3. inpaint empty cells (water, building interiors without returns)
    let mut last = zc.clone();
    fill_gaps(&mut last, cw, ch, (cw.max(ch)) as f64, 0)?;
    let lo = last.iter().copied().filter(|v| !v.is_nan()).fold(f32::INFINITY, f32::min);
    for v in last.iter_mut().filter(|v| v.is_nan()) {
        *v = lo;
    }
    // 4. progressive opening: a cell that drops by more than slope × radius between two
    //    successive openings sits on an object
    let rmax = ((p.window / c).ceil() as usize).max(1);
    let mut obj = vec![false; cw * ch];
    for r in 1..=rmax {
        let eroded = filter_square(&last, cw, ch, r, false);
        let opened = filter_square(&eroded, cw, ch, r, true);
        let thresh = (p.slope * c * r as f64) as f32;
        for j in 0..cw * ch {
            if last[j] - opened[j] > thresh {
                obj[j] = true;
            }
        }
        last = opened;
    }
    // 5. provisional ground surface from the unflagged cells
    let mut prov: Vec<f32> = (0..cw * ch).map(|j| if known[j] && !obj[j] { zc[j] } else { f32::NAN }).collect();
    fill_gaps(&mut prov, cw, ch, (cw.max(ch)) as f64, 0)?;
    if prov.iter().all(|v| v.is_nan()) {
        return Ok(vec![f32::NAN; w * h]);
    }
    for v in prov.iter_mut().filter(|v| v.is_nan()) {
        *v = lo;
    }
    let slope = gradient(&prov, cw, ch, c);
    // 6. a fine cell is ground when it lies within threshold + scalar × slope of that surface
    let mut out = vec![f32::NAN; w * h];
    for y in 0..h {
        for x in 0..w {
            let v = zmin[y * w + x];
            if v.is_nan() {
                continue;
            }
            let (u, vv) = ((x as f64 + 0.5) / k as f64 - 0.5, (y as f64 + 0.5) / k as f64 - 0.5);
            let pz = bilinear(&prov, cw, ch, u, vv);
            let ps = bilinear(&slope, cw, ch, u, vv) as f64;
            if ((v - pz).abs() as f64) <= p.threshold + p.scalar * ps {
                out[y * w + x] = v;
            }
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ buildings and trees

/// 4-connected components of `mask`; returns labels (0 = background) and each component's cells.
fn components(mask: &[bool], w: usize, h: usize) -> (Vec<u32>, Vec<Vec<usize>>) {
    let mut lab = vec![0u32; w * h];
    let mut comps: Vec<Vec<usize>> = Vec::new();
    let mut stack = Vec::new();
    for s in 0..w * h {
        if !mask[s] || lab[s] != 0 {
            continue;
        }
        let id = comps.len() as u32 + 1;
        let mut cells = Vec::new();
        lab[s] = id;
        stack.push(s);
        while let Some(i) = stack.pop() {
            cells.push(i);
            let (x, y) = (i % w, i / w);
            let mut visit = |j: usize| {
                if mask[j] && lab[j] == 0 {
                    lab[j] = id;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < w {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - w);
            }
            if y + 1 < h {
                visit(i + w);
            }
        }
        comps.push(cells);
    }
    (lab, comps)
}

/// Building cells on a grid of cell size `c`: planar 3×3 neighbourhoods (plane-fit RMS < 0.12 m,
/// slope < 60°) at least 2.5 m above the ground, grouped into regions ≥ 20 m² that are at least
/// 3 m across, then grown by 1 m over cells still ≥ 1.5 m high (eaves, ridges).
pub fn planar_buildings(dsm: &[f32], chm: &[f32], w: usize, h: usize, c: f64) -> Vec<bool> {
    let mut planar = vec![false; w * h];
    let c32 = c as f32;
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = y * w + x;
            if !(chm[i] >= 2.5) {
                continue;
            }
            let (mut sz, mut sxz, mut syz, mut szz) = (0f32, 0f32, 0f32, 0f32);
            let mut ok = true;
            let zc = dsm[i];
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let v = dsm[(y as i32 + dy) as usize * w + (x as i32 + dx) as usize];
                    if v.is_nan() {
                        ok = false;
                    }
                    let d = v - zc;
                    sz += d;
                    sxz += dx as f32 * d;
                    syz += dy as f32 * d;
                    szz += d * d;
                }
            }
            if !ok {
                continue;
            }
            // orthogonal 3×3 design: Σx² = Σy² = 6, Σxy = Σx = Σy = 0
            let (a, b, m) = (sxz / 6.0, syz / 6.0, sz / 9.0);
            let sse = (szz - 9.0 * m * m - 6.0 * a * a - 6.0 * b * b).max(0.0);
            let rms = (sse / 9.0).sqrt();
            let tilt = (a * a + b * b).sqrt() / c32;
            if rms < 0.12 && tilt < 1.73 {
                planar[i] = true;
            }
        }
    }
    let (_, comps) = components(&planar, w, h);
    let mut mask = vec![false; w * h];
    let min_cells = (20.0 / (c * c)).ceil() as usize;
    for cells in comps {
        if cells.len() < min_cells {
            continue;
        }
        let (mut x0, mut x1, mut y0, mut y1) = (usize::MAX, 0, usize::MAX, 0);
        for &i in &cells {
            x0 = x0.min(i % w);
            x1 = x1.max(i % w);
            y0 = y0.min(i / w);
            y1 = y1.max(i / w);
        }
        if ((x1 - x0 + 1) as f64 * c) < 3.0 || ((y1 - y0 + 1) as f64 * c) < 3.0 {
            continue;
        }
        for i in cells {
            mask[i] = true;
        }
    }
    let r = (1.0 / c).ceil() as usize;
    let grown = filter_square(&mask.iter().map(|b| if *b { 1.0 } else { 0.0 }).collect::<Vec<f32>>(), w, h, r, true);
    (0..w * h).map(|i| mask[i] || (grown[i] > 0.5 && chm[i] >= 1.5)).collect()
}

/// Expected crown radius (m) for a tree of height `h` (Popescu & Wynne 2004, all species).
pub fn crown_radius(h: f64) -> f64 {
    (0.5 * (2.51503 + 0.00901 * h * h)).clamp(1.0, 8.0)
}

/// Tree tops: cells of the smoothed CHM at least `min_h` high that are the highest within the
/// expected crown radius, outside `mask`. Returns (cell, height).
pub fn tree_tops(chm: &[f32], w: usize, h: usize, res: f64, min_h: f64, mask: &[bool]) -> Vec<(usize, f32)> {
    let raw: Vec<f32> = chm.iter().map(|v| if v.is_nan() { 0.0 } else { *v }).collect();
    // binomial 3×3 smoothing removes single-cell pits and spikes inside crowns
    let mut s = raw.clone();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let at = |dx: i32, dy: i32| raw[(y as i32 + dy) as usize * w + (x as i32 + dx) as usize];
            s[y * w + x] = (4.0 * at(0, 0) + 2.0 * (at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1)) + at(-1, -1) + at(1, -1) + at(-1, 1) + at(1, 1)) / 16.0;
        }
    }
    let higher = |a: usize, b: usize| s[b] > s[a] || (s[b] == s[a] && b < a);
    let mut out = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if (s[i] as f64) < min_h || mask[i] {
                continue;
            }
            let mut top = true;
            'n: for yy in y.saturating_sub(1)..(y + 2).min(h) {
                for xx in x.saturating_sub(1)..(x + 2).min(w) {
                    let j = yy * w + xx;
                    if j != i && higher(i, j) {
                        top = false;
                        break 'n;
                    }
                }
            }
            if !top {
                continue;
            }
            let rc = (crown_radius(s[i] as f64) / res).round().max(1.0) as i64;
            'w: for dy in -rc..=rc {
                for dx in -rc..=rc {
                    if dx * dx + dy * dy > rc * rc {
                        continue;
                    }
                    let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                    if xx < 0 || yy < 0 || xx >= w as i64 || yy >= h as i64 {
                        continue;
                    }
                    let j = yy as usize * w + xx as usize;
                    if j != i && higher(i, j) {
                        top = false;
                        break 'w;
                    }
                }
            }
            if top {
                let mut hmax = 0f32;
                for yy in y.saturating_sub(1)..(y + 2).min(h) {
                    for xx in x.saturating_sub(1)..(x + 2).min(w) {
                        hmax = hmax.max(raw[yy * w + xx]);
                    }
                }
                out.push((i, hmax));
            }
        }
    }
    out
}

// ------------------------------------------------------------------ the whole pipeline

#[derive(Debug, Clone)]
pub struct Tree {
    pub lon: f64,
    pub lat: f64,
    pub height: f64,
    pub crown: f64,
}

#[derive(Debug, Clone)]
pub struct Building {
    /// polygons → rings → lon/lat
    pub polygons: Vec<Vec<Vec<[f64; 2]>>>,
    pub area_m2: f64,
    pub height: f64,
    pub ground: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub files: usize,
    pub header_points: u64,
    pub read: u64,
    pub used: u64,
    pub noise: u64,
    pub withheld: u64,
    pub outside: u64,
    pub classes: Vec<(u8, u64)>,
    /// "classes" or "smrf"
    pub ground_method: &'static str,
    pub ground_share: f64,
    pub density: f64,
    pub coverage_m2: f64,
    pub res: f64,
    pub dtm_min: f64,
    pub dtm_max: f64,
    pub canopy_cover: f64,
    pub chm_p50: f64,
    pub chm_p95: f64,
    pub chm_max: f64,
    pub trees: usize,
    pub tallest_tree: f64,
    pub buildings: usize,
    pub building_area_m2: f64,
    /// "classes", "planar" or "none"
    pub building_method: &'static str,
    /// "classes" (vegetation classes 3-5) or "surface" (DSM − DTM without buildings)
    pub canopy_method: &'static str,
    pub crs: String,
    pub lonlat: [f64; 4],
    pub seconds: f64,
    pub read_seconds: f64,
    pub notes: Vec<String>,
}

pub struct Products {
    pub spec: GridSpec,
    pub dtm: Vec<f32>,
    pub dsm: Vec<f32>,
    pub chm: Vec<f32>,
    pub trees: Vec<Tree>,
    pub buildings: Vec<Building>,
    pub stats: Stats,
    /// every n-th point (Options::sample), for 3D views
    pub sample: Vec<SamplePoint>,
}

fn percentile(v: &mut [f32], q: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let k = ((v.len() - 1) as f64 * q).round() as usize;
    let (_, x, _) = v.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
    *x as f64
}

pub fn process(paths: &[PathBuf], o: &Options, cancel: &AtomicBool) -> Result<Products, String> {
    let t0 = Instant::now();
    let mut headers = Vec::new();
    let mut skipped = Vec::new();
    for p in paths {
        match read_header(p) {
            Ok(h) if h.points > 0 => headers.push(h),
            Ok(_) => skipped.push(format!("{} has no points", p.display())),
            Err(e) => skipped.push(e),
        }
    }
    if headers.is_empty() {
        return Err(skipped.first().cloned().unwrap_or_else(|| "no LAS/LAZ files".into()));
    }
    let crs = headers[0].crs_label();
    let header_points: u64 = headers.iter().map(|h| h.points).sum();
    let (srcs, spec, density0, mut notes) = plan(headers, o)?;
    notes.extend(skipped.into_iter().map(|s| format!("skipped: {s}")));
    let files = srcs.len();
    let mut g = grid_points(&srcs, spec, o.sample, cancel)?;
    let sample = std::mem::take(&mut g.sample);
    let read_seconds = t0.elapsed().as_secs_f64();
    let spec = g.spec.clone();
    let (w, h, res) = (spec.w, spec.h, spec.res);
    let n = w * h;
    if g.used == 0 {
        return Err(format!("none of the {} points could be used ({} noise, {} withheld, {} outside the area)", g.read, g.noise, g.withheld, g.outside));
    }

    // coverage: cells with points, closed over holes up to ~30 m (buildings, water, shadows)
    let has: Vec<f32> = g.zmin.iter().map(|v| if v.is_nan() { 0.0 } else { 1.0 }).collect();
    let rc = ((15.0 / res).round() as usize).clamp(1, 200);
    let covered: Vec<bool> = filter_square(&filter_square(&has, w, h, rc, true), w, h, rc, false).iter().map(|v| *v > 0.5).collect();
    let cov_cells = covered.iter().filter(|b| **b).count();
    let data_cells = has.iter().filter(|v| **v > 0.5).count();

    // ground
    let ground_pts = g.classes[2];
    let share = ground_pts as f64 / g.used.max(1) as f64;
    let use_classes = match o.ground {
        GroundMode::Classes => {
            if ground_pts == 0 {
                return Err("ground: classes was asked for, but the files have no ground (class 2) points; use ground: auto".into());
            }
            true
        }
        GroundMode::Smrf => false,
        GroundMode::Auto => share >= 0.005,
    };
    let fill_dist = (100.0 / res).clamp(10.0, 3000.0);
    let mut dtm: Vec<f32> = if use_classes {
        (0..n).map(|i| if g.gcnt[i] > 0 { (g.zref + (g.gsum[i] / g.gcnt[i] as f32) as f64) as f32 } else { f32::NAN }).collect()
    } else {
        let p = Smrf { window: o.window, ..Smrf::default() };
        smrf_ground(&g.zmin, w, h, res, &p)?
    };
    let ground_cells = dtm.iter().filter(|v| !v.is_nan()).count();
    if ground_cells == 0 {
        return Err("no ground was found in the point cloud".into());
    }
    fill_gaps(&mut dtm, w, h, fill_dist, 0)?;
    // a light 3 × 3 mean takes out the centimetre noise that relief shading would exaggerate
    dtm = smooth3(&dtm, w, h);
    for i in 0..n {
        if !covered[i] {
            dtm[i] = f32::NAN;
        }
    }

    // surface: highest return, isolated spikes removed, pinholes filled
    let mut dsm = g.zmax.clone();
    {
        let src = dsm.clone();
        for y in 0..h {
            for x in 0..w {
                let v = src[y * w + x];
                if v.is_nan() {
                    continue;
                }
                let (mut hi, mut cnt) = (f32::NEG_INFINITY, 0);
                for yy in y.saturating_sub(1)..(y + 2).min(h) {
                    for xx in x.saturating_sub(1)..(x + 2).min(w) {
                        let u = src[yy * w + xx];
                        if (yy, xx) != (y, x) && !u.is_nan() {
                            hi = hi.max(u);
                            cnt += 1;
                        }
                    }
                }
                if cnt >= 3 && v > hi + 5.0 {
                    dsm[y * w + x] = hi;
                }
            }
        }
    }
    fill_gaps(&mut dsm, w, h, (1.5 / res).max(2.0), 0)?;
    for i in 0..n {
        if !covered[i] {
            dsm[i] = f32::NAN;
        } else if dsm[i].is_nan() || dsm[i] < dtm[i] {
            dsm[i] = dtm[i];
        }
    }
    // everything above the ground (buildings are found and measured on this)
    let ndsm: Vec<f32> = (0..n).map(|i| if dsm[i].is_nan() || dtm[i].is_nan() { f32::NAN } else { (dsm[i] - dtm[i]).max(0.0) }).collect();
    let chm = &ndsm;

    // buildings
    let to_ll = CoordTransform::new(&gis_order(SpatialRef::from_wkt(&spec.wkt).map_err(|e| e.to_string())?), &wgs84()).map_err(|e| e.to_string())?;
    let class_buildings = g.classes[6] as f64 / g.used.max(1) as f64 >= 0.001;
    let (bmask, bgrid, bk, building_method) = if class_buildings {
        let f: Vec<f32> = g.building.iter().map(|b| if *b { 1.0 } else { 0.0 }).collect();
        let closed = filter_square(&filter_square(&f, w, h, 1, true), w, h, 1, false);
        let m: Vec<bool> = (0..n).map(|i| closed[i] > 0.5 && chm[i] >= 1.5).collect();
        (m.clone(), m, 1usize, "classes")
    } else if res <= 2.5 {
        // planarity is judged on cells of at least 0.5 m (finer cells see LiDAR noise, not roofs)
        let k = ((0.5 / res).round() as usize).max(1);
        let (cw, ch) = (w.div_ceil(k), h.div_ceil(k));
        let mut cd = vec![f32::NAN; cw * ch];
        let mut cc = vec![f32::NAN; cw * ch];
        for i in 0..n {
            let j = (i / w / k) * cw + (i % w) / k;
            if !dsm[i].is_nan() && !(cd[j] >= dsm[i]) {
                cd[j] = dsm[i];
            }
            if !chm[i].is_nan() && !(cc[j] >= chm[i]) {
                cc[j] = chm[i];
            }
        }
        let coarse = planar_buildings(&cd, &cc, cw, ch, res * k as f64);
        let fine: Vec<bool> = (0..n).map(|i| coarse[(i / w / k) * cw + (i % w) / k]).collect();
        (fine, coarse, k, "planar")
    } else {
        (vec![false; n], vec![false; n], 1, "none")
    };
    let mut buildings = Vec::new();
    {
        let (bw, bh) = (w.div_ceil(bk), h.div_ceil(bk));
        let (labels, comps) = components(&bgrid, bw, bh);
        let bres = res * bk as f64;
        let min_cells = (10.0 / (bres * bres)).ceil() as usize;
        let keep: Vec<bool> = comps.iter().map(|c| c.len() >= min_cells).collect();
        if keep.iter().any(|k| *k) {
            let lab: Vec<i32> = labels.iter().map(|l| if *l > 0 && keep[*l as usize - 1] { *l as i32 } else { 0 }).collect();
            let polys = polygonize(&lab, bw, bh, [spec.x0, bres, 0.0, spec.y1, 0.0, -bres], &spec.wkt, bres * 0.75, &to_ll)?;
            for (label, rings) in polys {
                let cells = &comps[label as usize - 1];
                let mut hs: Vec<f32> = Vec::new();
                let mut gs = 0.0;
                for &cidx in cells {
                    let (cx, cy) = (cidx % bw, cidx / bw);
                    for yy in cy * bk..((cy + 1) * bk).min(h) {
                        for xx in cx * bk..((cx + 1) * bk).min(w) {
                            let i = yy * w + xx;
                            if !chm[i].is_nan() {
                                hs.push(chm[i]);
                                gs += dtm[i] as f64;
                            }
                        }
                    }
                }
                if hs.is_empty() {
                    continue;
                }
                let cnt = hs.len() as f64;
                let height = percentile(&mut hs, 0.9);
                buildings.push(Building { polygons: rings, area_m2: cells.len() as f64 * bres * bres, height, ground: gs / cnt });
            }
        }
    }

    // canopy: from the vegetation classes when the data has them (then unclassified structures,
    // towers and bridges stay out), else everything above the ground except buildings
    let veg_pts = g.classes[3] + g.classes[4] + g.classes[5];
    let veg_classes = veg_pts as f64 / g.used.max(1) as f64 >= 0.005;
    let chm: Vec<f32> = if veg_classes {
        let mut c: Vec<f32> = (0..n)
            .map(|i| if !covered[i] || dtm[i].is_nan() { f32::NAN } else if g.vmax[i].is_nan() { 0.0 } else { (g.vmax[i] - dtm[i]).max(0.0) })
            .collect();
        fill_pinholes(&mut c, w, h);
        c
    } else {
        ndsm.clone()
    };
    // roofs keep their heights on the building polygons, not in the canopy; one extra cell
    // around each building also goes (roof edges smeared by the pinhole fill).
    let bmask: Vec<bool> = if bmask.iter().any(|b| *b) {
        let r = ((0.5 / res).ceil() as usize).max(1);
        filter_square(&bmask.iter().map(|b| if *b { 1.0 } else { 0.0 }).collect::<Vec<f32>>(), w, h, r, true).iter().map(|v| *v > 0.5).collect()
    } else {
        bmask
    };
    let mut chm = chm;
    for i in 0..n {
        if bmask[i] && !chm[i].is_nan() {
            chm[i] = 0.0;
        }
    }

    // trees
    let tops = tree_tops(&chm, w, h, res, o.min_tree, &bmask);
    let (mut xs, mut ys): (Vec<f64>, Vec<f64>) = tops.iter().map(|(i, _)| spec.center(*i)).unzip();
    let mut zs = vec![0.0; xs.len()];
    if !xs.is_empty() {
        to_ll.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
    }
    let trees: Vec<Tree> = tops.iter().enumerate().map(|(k, (_, hgt))| Tree { lon: xs[k], lat: ys[k], height: *hgt as f64, crown: 2.0 * crown_radius(*hgt as f64) }).collect();

    // statistics
    let mut canopy: Vec<f32> = (0..n).filter(|i| covered[*i] && !bmask[*i] && chm[*i] >= 2.0).map(|i| chm[i]).collect();
    let canopy_cover = canopy.len() as f64 / cov_cells.max(1) as f64;
    let chm_max = canopy.iter().copied().fold(0f32, f32::max) as f64;
    let chm_p50 = percentile(&mut canopy, 0.5);
    let chm_p95 = percentile(&mut canopy, 0.95);
    let (dmin, dmax) = dtm.iter().filter(|v| !v.is_nan()).fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(*v as f64), b.max(*v as f64)));
    let gb = [spec.x0, spec.y1 - h as f64 * res, spec.x0 + w as f64 * res, spec.y1];
    let lonlat = to_ll.transform_bounds(&gb, 21).unwrap_or([0.0; 4]);
    let coverage_m2 = data_cells as f64 * res * res;
    let classes: Vec<(u8, u64)> = g.classes.iter().enumerate().filter(|(_, c)| **c > 0).map(|(k, c)| (k as u8, *c)).collect();
    let stats = Stats {
        files,
        header_points,
        read: g.read,
        used: g.used,
        noise: g.noise,
        withheld: g.withheld,
        outside: g.outside,
        classes,
        ground_method: if use_classes { "classes" } else { "smrf" },
        ground_share: share,
        density: if coverage_m2 > 0.0 { g.used as f64 / coverage_m2 } else { density0 },
        coverage_m2,
        res,
        dtm_min: dmin,
        dtm_max: dmax,
        canopy_cover,
        chm_p50,
        chm_p95,
        chm_max,
        trees: trees.len(),
        tallest_tree: trees.iter().map(|t| t.height).fold(0.0, f64::max),
        buildings: buildings.len(),
        building_area_m2: buildings.iter().map(|b| b.area_m2).sum(),
        building_method,
        canopy_method: if veg_classes { "classes" } else { "surface" },
        crs,
        lonlat,
        seconds: t0.elapsed().as_secs_f64(),
        read_seconds,
        notes,
    };
    Ok(Products { spec, dtm, dsm, chm, trees, buildings, stats, sample })
}

/// Polygonise a label raster (0 = background) into simplified lon/lat polygons per label.
fn polygonize(labels: &[i32], w: usize, h: usize, gt: [f64; 6], wkt: &str, tolerance: f64, to_ll: &CoordTransform) -> Result<Vec<(i32, Vec<Vec<Vec<[f64; 2]>>>)>, String> {
    let e = |x: gdal::errors::GdalError| x.to_string();
    let drv = DriverManager::get_driver_by_name("MEM").map_err(e)?;
    let mut ds = drv.create_with_band_type::<i32, _>("", w, h, 1).map_err(e)?;
    ds.set_geo_transform(&gt).map_err(e)?;
    ds.set_projection(wkt).map_err(e)?;
    let mut band = ds.rasterband(1).map_err(e)?;
    let mut buf = Buffer::new((w, h), labels.to_vec());
    band.write((0, 0), (w, h), &mut buf).map_err(e)?;
    band.set_no_data_value(Some(0.0)).map_err(e)?;
    let srs = gis_order(SpatialRef::from_wkt(wkt).map_err(e)?);
    let vdrv = DriverManager::get_driver_by_name("Memory").map_err(e)?;
    let mut vds = vdrv.create_vector_only("").map_err(e)?;
    let lyr = vds.create_layer(LayerOptions { name: "buildings", srs: Some(&srs), ty: gdal_sys::OGRwkbGeometryType::wkbPolygon, options: None }).map_err(e)?;
    lyr.create_defn_fields(&[("label", gdal_sys::OGRFieldType::OFTInteger)]).map_err(e)?;
    let mask = unsafe { gdal_sys::GDALGetMaskBand(band.c_rasterband()) };
    let err = unsafe { gdal_sys::GDALPolygonize(band.c_rasterband(), mask, lyr.c_layer(), 0, std::ptr::null_mut(), None, std::ptr::null_mut()) };
    if err != gdal_sys::CPLErr::CE_None {
        return Err(format!("outlining buildings: {}", crate::raster::last_error()));
    }
    let mut lyr = vds.layer(0).map_err(e)?;
    let mut out: Vec<(i32, Vec<Vec<Vec<[f64; 2]>>>)> = Vec::new();
    for f in lyr.features() {
        let label = f.field_as_integer(0).ok().flatten().unwrap_or(0);
        let Some(geom) = f.geometry() else { continue };
        let simple = geom.simplify_preserve_topology(tolerance).unwrap_or_else(|_| geom.clone());
        let mut ll = simple.clone();
        if ll.transform_inplace(to_ll).is_err() {
            continue;
        }
        let Ok(wkb) = ll.wkb() else { continue };
        let Ok(crate::wkb::Geom::Polygons(polys)) = crate::wkb::parse(&wkb) else { continue };
        match out.iter_mut().find(|(l, _)| *l == label) {
            Some((_, v)) => v.extend(polys),
            None => out.push((label, polys)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_tiles_are_found() {
        let d = std::env::temp_dir().join(format!("gx-links-{}", std::process::id()));
        let tiles = d.join("tiles");
        std::fs::create_dir_all(&tiles).unwrap();
        std::fs::write(tiles.join("a.laz"), b"x").unwrap();
        let inbox = d.join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&tiles, inbox.join("survey")).unwrap();
            std::os::unix::fs::symlink(tiles.join("a.laz"), inbox.join("b.laz")).unwrap();
            // a loop back to the inbox must not hang
            std::os::unix::fs::symlink(&inbox, inbox.join("survey-loop")).unwrap();
            let found = find_clouds(&inbox, 100);
            assert!(found.iter().any(|p| p.ends_with("survey/a.laz")), "{found:?}");
            assert!(found.iter().any(|p| p.ends_with("b.laz")), "{found:?}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    fn brute(line: &[f32], r: usize, max: bool) -> Vec<f32> {
        (0..line.len())
            .map(|i| {
                let a = i.saturating_sub(r);
                let b = (i + r).min(line.len() - 1);
                let vals: Vec<f32> = line[a..=b].iter().copied().filter(|v| !v.is_nan()).collect();
                if vals.is_empty() {
                    f32::NAN
                } else if max {
                    vals.iter().copied().fold(f32::NEG_INFINITY, f32::max)
                } else {
                    vals.iter().copied().fold(f32::INFINITY, f32::min)
                }
            })
            .collect()
    }

    #[test]
    fn running_extremes_match_brute_force() {
        let mut seed = 7u64;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) % 1000) as f32 / 10.0
        };
        for len in [1usize, 2, 5, 17, 64] {
            let mut line: Vec<f32> = (0..len).map(|_| rnd()).collect();
            if len > 3 {
                line[2] = f32::NAN;
            }
            for r in [1usize, 2, 3, 7, 40] {
                for max in [false, true] {
                    let (mut b, mut g, mut h) = (Vec::new(), Vec::new(), Vec::new());
                    let mut out = vec![0f32; len];
                    extreme_1d(&line, &mut out, r, max, &mut b, &mut g, &mut h);
                    let want = brute(&line, r, max);
                    for (o, w) in out.iter().zip(&want) {
                        assert!(o == w || (w.is_nan() && o.is_infinite()), "len {len} r {r} max {max}: {out:?} vs {want:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn resolution_follows_density_and_area() {
        assert_eq!(auto_resolution(2.0, 1e6), 1.0);
        assert_eq!(auto_resolution(8.0, 1e6), 0.5);
        assert_eq!(auto_resolution(100.0, 1e5), 0.2);
        assert_eq!(auto_resolution(500.0, 1e4), 0.1);
        // 100 km² at 0.5 m would be 400 M cells: coarsened until ≤ 6 M
        assert_eq!(auto_resolution(8.0, 1e8), 5.0);
    }

    /// Sloping terrain with a hill, a 10 × 10 m building (6 m) and a 3 m-wide hedge row.
    fn scene(res: f64) -> (Vec<f32>, Vec<f32>, usize, usize) {
        let (w, h) = ((80.0 / res) as usize, (60.0 / res) as usize);
        let mut ground = vec![0f32; w * h];
        let mut surface = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let (mx, my) = ((x as f64 + 0.5) * res, (y as f64 + 0.5) * res);
                let r2 = (mx - 55.0).powi(2) + (my - 30.0).powi(2);
                let gz = 100.0 + 0.08 * mx + 4.0 * (-r2 / 300.0).exp();
                let mut sz = gz;
                if (10.0..20.0).contains(&mx) && (10.0..20.0).contains(&my) {
                    sz += 6.0;
                }
                ground[y * w + x] = gz as f32;
                surface[y * w + x] = sz as f32;
            }
        }
        (ground, surface, w, h)
    }

    #[test]
    fn smrf_removes_the_building_and_keeps_the_hill() {
        let res = 0.5;
        let (ground, surface, w, h) = scene(res);
        let out = smrf_ground(&surface, w, h, res, &Smrf::default()).unwrap();
        let (mut on_bldg, mut bldg, mut kept, mut open) = (0, 0, 0, 0);
        for y in 0..h {
            for x in 0..w {
                let (mx, my) = ((x as f64 + 0.5) * res, (y as f64 + 0.5) * res);
                let i = y * w + x;
                let inside = (10.0..20.0).contains(&mx) && (10.0..20.0).contains(&my);
                if inside {
                    bldg += 1;
                    on_bldg += !out[i].is_nan() as usize;
                } else if !(8.0..22.0).contains(&mx) || !(8.0..22.0).contains(&my) {
                    open += 1;
                    kept += (!out[i].is_nan() && (out[i] - ground[i]).abs() < 0.01) as usize;
                }
            }
        }
        assert_eq!(on_bldg, 0, "{on_bldg} of {bldg} roof cells taken as ground");
        assert!(kept as f64 > 0.98 * open as f64, "only {kept} of {open} open-ground cells kept");
    }

    #[test]
    fn tree_tops_find_cones_and_skip_masked_cells() {
        let res = 0.5;
        let (w, h) = (120, 80);
        let mut chm = vec![0f32; w * h];
        let trees: [(f64, f64, f64); 5] = [(10.0, 10.0, 12.0), (25.0, 12.0, 18.0), (40.0, 30.0, 8.0), (15.0, 30.0, 22.0), (50.0, 12.0, 15.0)];
        for &(tx, ty, th) in &trees {
            let cr = crown_radius(th);
            for y in 0..h {
                for x in 0..w {
                    // a CHM cell holds its highest return: the cell's point nearest the apex
                    let nx = tx.clamp(x as f64 * res, (x + 1) as f64 * res);
                    let ny = ty.clamp(y as f64 * res, (y + 1) as f64 * res);
                    let d = ((nx - tx).powi(2) + (ny - ty).powi(2)).sqrt();
                    let z = th * (1.0 - d / (cr * 1.2));
                    if z > 0.0 {
                        chm[y * w + x] = chm[y * w + x].max(z as f32);
                    }
                }
            }
        }
        let mut mask = vec![false; w * h];
        let tops = tree_tops(&chm, w, h, res, 3.0, &mask);
        assert_eq!(tops.len(), trees.len(), "{tops:?}");
        for (i, ht) in &tops {
            let (mx, my) = ((i % w) as f64 * res + 0.25, (i / w) as f64 * res + 0.25);
            let t = trees.iter().find(|t| (t.0 - mx).abs() < 1.0 && (t.1 - my).abs() < 1.0).expect("top near a tree");
            assert!((*ht as f64 - t.2).abs() < 0.6, "height {ht} vs {}", t.2);
        }
        // a masked tree (inside a building footprint) is not reported
        for y in 50..70 {
            for x in 20..40 {
                mask[y * w + x] = true;
            }
        }
        assert_eq!(tree_tops(&chm, w, h, res, 3.0, &mask).len(), trees.len() - 1);
    }

    #[test]
    fn planar_roofs_become_buildings_but_crowns_do_not() {
        let c = 0.5;
        let (w, h) = (80, 60);
        let mut dsm = vec![100f32; w * h];
        let mut chm = vec![0f32; w * h];
        // a gabled roof 12 × 8 m, eaves 5 m, ridge 7 m
        for y in 10..26 {
            for x in 10..34 {
                let d = ((y as f32 + 0.5) * c as f32 - 9.0).abs();
                let z = 7.0 - d * 0.5;
                dsm[y * w + x] = 100.0 + z;
                chm[y * w + x] = z;
            }
        }
        // a round crown 10 m tall, 4 m radius
        for y in 0..h {
            for x in 0..w {
                let d = (((x as f64 + 0.5) * c - 30.0).powi(2) + ((y as f64 + 0.5) * c - 22.0).powi(2)).sqrt();
                if d < 4.0 {
                    let z = (10.0 * (1.0 - (d / 4.0).powi(2))).max(0.0) as f32;
                    if z > chm[y * w + x] {
                        chm[y * w + x] = z;
                        dsm[y * w + x] = 100.0 + z;
                    }
                }
            }
        }
        let m = planar_buildings(&dsm, &chm, w, h, c);
        let roof = (12..24).flat_map(|y| (12..32).map(move |x| (x, y))).filter(|(x, y)| m[y * w + x]).count();
        assert!(roof > 200, "only {roof} of 240 roof cells found");
        let crown = (40..48).flat_map(|y| (56..64).map(move |x| (x, y))).filter(|(x, y)| m[y * w + x]).count();
        assert_eq!(crown, 0, "{crown} crown cells taken for a roof");
    }
}
