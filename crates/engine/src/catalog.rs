//! Source discovery, layer metadata and a per-layer pool of GDAL handles.
//!
//! GDAL datasets are not thread-safe, so every worker checks a private
//! handle (dataset + coordinate transforms) out of the pool and returns it.

use crate::tile;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::vector::{LayerAccess, OGRFieldType};
use gdal::{Dataset, DatasetOptions, GdalOpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};
use crate::overview::Overview;
use std::sync::{Arc, Mutex, RwLock};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GeomKind {
    Point,
    Line,
    Polygon,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldInfo {
    pub name: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct LayerInfo {
    pub id: String,
    pub name: String,
    pub source: String,
    pub driver: String,
    pub geometry: GeomKind,
    pub feature_count: u64,
    /// [west, south, east, north] in EPSG:4326
    pub bounds: [f64; 4],
    pub crs: String,
    pub fields: Vec<FieldInfo>,
    /// Subset of fields encoded into vector tiles.
    pub tile_fields: Vec<String>,
    pub minzoom: u8,
    pub maxzoom: u8,
}

/// OGRCoordinateTransformation is safe to *move* between threads as long as
/// it is never used concurrently; each pooled handle owns its own.
pub(crate) struct SendCt(pub CoordTransform);
unsafe impl Send for SendCt {}

pub(crate) struct Handle {
    pub ds: Dataset,
    pub to_wgs84: Option<SendCt>,
    pub from_wgs84: Option<SendCt>,
}

pub struct LayerHandle {
    pub info: LayerInfo,
    pub(crate) path: PathBuf,
    pub(crate) layer_name: String,
    pub(crate) needs_transform: bool,
    /// Layer extent in its own CRS (what GDAL's spatial filters compare against).
    pub(crate) native_bounds: Option<[f64; 4]>,
    pub(crate) field_idx: Vec<usize>,
    pool: Mutex<Vec<Handle>>,
    /// Pre-built overview pyramid serving z0..=max_zoom, if any.
    overview: RwLock<Option<Arc<Overview>>>,
    /// Definition query (an OGR SQL WHERE clause): only matching features are drawn, listed in
    /// the table and analysed, as ArcGIS Pro's definition query and QGIS's layer filter.
    filter: RwLock<Option<String>>,
}

pub const MAX_ZOOM: u8 = 14;
/// Average features per tile above which a layer is not tiled on the fly
/// (sets the layer's minzoom). Dense layers need pre-built overviews instead.
const TARGET_FEATURES_PER_TILE: f64 = 10_000.0;
const PREFERRED_FIELDS: &[&str] = &[
    "name", "type", "kind", "class", "height", "pop_max", "pop_est", "iso_a3", "continent", "scalerank", "featurecla",
];
const MAX_TILE_FIELDS: usize = 6;
const EXTENSIONS: &[&str] = &["gpkg", "fgb", "shp", "geojson", "json", "gdb", "sqlite", "gml", "kml", "gspx"];

impl LayerHandle {
    pub(crate) fn checkout(&self) -> Result<Handle, String> {
        let h = match self.pool.lock().unwrap().pop() {
            Some(h) => h,
            None => open_handle(&self.path, &self.layer_name, self.needs_transform)?,
        };
        // pooled handles keep their OGR layer state: set (or clear) the definition query each time
        if let Ok(mut lyr) = h.ds.layer_by_name(&self.layer_name) {
            match self.filter().as_deref() {
                Some(w) => lyr.set_attribute_filter(w).map_err(|e| format!("definition query: {e}"))?,
                None => lyr.clear_attribute_filter(),
            }
        }
        Ok(h)
    }

    /// The definition query, if any.
    pub fn filter(&self) -> Option<String> {
        self.filter.read().unwrap().clone()
    }

    /// Set or clear the definition query. Checked against the data first, so a typo is an
    /// error here rather than an empty map.
    pub fn set_filter(&self, filter: Option<String>) -> Result<(), String> {
        let filter = filter.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
        if let Some(w) = &filter {
            let ds = open_vector(&self.path)?;
            let mut lyr = ds.layer_by_name(&self.layer_name).map_err(|e| e.to_string())?;
            lyr.set_attribute_filter(w).map_err(|e| format!("'{w}' is not a valid query: {}", crate::edit::tidy(&e.to_string())))?;
        }
        *self.filter.write().unwrap() = filter;
        Ok(())
    }

    /// Features passing the definition query (all features when there is none).
    pub fn filtered_count(&self) -> u64 {
        if self.filter().is_none() {
            return self.info.feature_count;
        }
        let Ok(h) = self.checkout() else { return self.info.feature_count };
        let n = h.ds.layer_by_name(&self.layer_name).map(|mut l| {
            l.clear_spatial_filter();
            l.feature_count()
        });
        self.checkin(h);
        n.unwrap_or(self.info.feature_count)
    }

    /// The file this layer reads (an edit copy once the layer has been edited).
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn layer_name(&self) -> &str {
        &self.layer_name
    }

    pub(crate) fn checkin(&self, h: Handle) {
        self.pool.lock().unwrap().push(h);
    }

    pub fn overview(&self) -> Option<Arc<Overview>> {
        self.overview.read().unwrap().clone()
    }

    pub(crate) fn set_overview(&self, o: Option<Arc<Overview>>) {
        *self.overview.write().unwrap() = o;
    }

    pub fn field_index(&self, name: &str) -> Option<usize> {
        self.info.fields.iter().position(|f| f.name == name)
    }

    /// Default tile attribute columns (OGR field indices).
    pub fn tile_field_idx(&self) -> &[usize] {
        &self.field_idx
    }

    /// Lon/lat of `n` randomly chosen features (data-weighted tile sampling for benchmarks).
    pub fn sample_lonlat(&self, n: usize, seed: u64) -> Result<Vec<[f64; 2]>, String> {
        let h = self.checkout()?;
        let mut out = Vec::with_capacity(n);
        {
            let lyr = h.ds.layer_by_name(&self.layer_name).map_err(|e| e.to_string())?;
            let count = self.info.feature_count.max(1);
            let mut rng = Rng(seed | 1);
            let mut attempts = 0;
            while out.len() < n && attempts < n * 50 {
                attempts += 1;
                let fid = rng.next() % (count + 1); // covers 0- and 1-based FIDs
                let Some(f) = lyr.feature(fid) else { continue };
                let Some(g) = f.geometry() else { continue };
                let e = g.envelope();
                let (mut x, mut y) = ([(e.MinX + e.MaxX) / 2.0], [(e.MinY + e.MaxY) / 2.0]);
                if let Some(ct) = &h.to_wgs84 {
                    if ct.0.transform_coords(&mut x, &mut y, &mut [0.0]).is_err() {
                        continue;
                    }
                }
                out.push([x[0], y[0]]);
            }
        }
        self.checkin(h);
        Ok(out)
    }
}

/// xorshift64: tiny deterministic PRNG for sampling.
pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}

pub(crate) fn open_vector(path: &Path) -> Result<Dataset, String> {
    let opts = DatasetOptions {
        open_flags: GdalOpenFlags::GDAL_OF_VECTOR | GdalOpenFlags::GDAL_OF_READONLY,
        ..Default::default()
    };
    Dataset::open_ex(path, opts).map_err(|e| format!("{}: {e}", path.display()))
}

pub(crate) fn wgs84() -> Result<SpatialRef, String> {
    let mut s = SpatialRef::from_epsg(4326).map_err(|e| e.to_string())?;
    s.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    Ok(s)
}

pub(crate) fn transforms(src: &SpatialRef) -> Result<(SendCt, SendCt), String> {
    let mut src = src.clone();
    src.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let dst = wgs84()?;
    let to = CoordTransform::new(&src, &dst).map_err(|e| e.to_string())?;
    let from = CoordTransform::new(&dst, &src).map_err(|e| e.to_string())?;
    Ok((SendCt(to), SendCt(from)))
}

fn open_handle(path: &Path, layer: &str, needs_transform: bool) -> Result<Handle, String> {
    let ds = open_vector(path)?;
    let (to_wgs84, from_wgs84) = if needs_transform {
        let srs = {
            let lyr = ds.layer_by_name(layer).map_err(|e| e.to_string())?;
            lyr.spatial_ref().ok_or("layer has no CRS")?
        };
        let (a, b) = transforms(&srs)?;
        (Some(a), Some(b))
    } else {
        (None, None)
    };
    Ok(Handle { ds, to_wgs84, from_wgs84 })
}

/// Expand files/directories into candidate vector datasets.
pub fn discover(paths: &[PathBuf]) -> Vec<PathBuf> {
    fn walk(p: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if p.is_dir() && ext != "gdb" {
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
        } else if EXTENSIONS.contains(&ext.as_str()) {
            out.push(p.to_path_buf());
        }
    }
    let mut out = Vec::new();
    for p in paths {
        walk(p, 3, &mut out);
    }
    out
}

pub(crate) fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c.to_ascii_lowercase() } else { '_' })
        .collect()
}

fn field_kind(t: OGRFieldType::Type) -> &'static str {
    match t {
        OGRFieldType::OFTInteger | OGRFieldType::OFTInteger64 => "integer",
        OGRFieldType::OFTReal => "real",
        OGRFieldType::OFTString => "string",
        OGRFieldType::OFTDate | OGRFieldType::OFTDateTime | OGRFieldType::OFTTime => "datetime",
        _ => "other",
    }
}

fn geom_kind(t: u32) -> GeomKind {
    match (t & 0x0FFF_FFFF) % 1000 {
        1 | 4 => GeomKind::Point,
        2 | 5 | 8 | 9 | 11 => GeomKind::Line,
        3 | 6 | 10 | 12 | 15 | 16 | 17 => GeomKind::Polygon,
        _ => GeomKind::Unknown,
    }
}

pub(crate) fn is_wgs84(srs: &SpatialRef) -> bool {
    let code = srs.auth_code().ok();
    match srs.auth_name().as_deref() {
        Some("EPSG") => code == Some(4326),
        Some("OGC") => srs.name().map(|n| n.contains("CRS84") || n.contains("WGS 84")).unwrap_or(false),
        _ => false,
    }
}

/// Smallest zoom at which the *average* tile holds <= TARGET features.
fn auto_minzoom(count: u64, b: [f64; 4]) -> u8 {
    (0..=MAX_ZOOM)
        .find(|&z| count as f64 / tile::tiles_covering(b, z) as f64 <= TARGET_FEATURES_PER_TILE)
        .unwrap_or(MAX_ZOOM)
}

/// Read every vector layer of one dataset.
pub fn load_layers(path: &Path) -> Result<Vec<LayerHandle>, String> {
    // projects from GeoSpaX 1.4.2 (.gspx) and 2.0 (.geolibre.json): their embedded layers
    if crate::project_import::is_project(path) {
        return crate::project_import::load(path);
    }
    load_layers_plain(path)
}

/// Every layer GDAL finds in a file.
pub(crate) fn load_layers_plain(path: &Path) -> Result<Vec<LayerHandle>, String> {
    let ds = open_vector(path)?;
    let driver = ds.driver().short_name();
    let stem = sanitize(path.file_stem().and_then(|s| s.to_str()).unwrap_or("data"));
    let ext = sanitize(path.extension().and_then(|s| s.to_str()).unwrap_or(""));
    let n_layers = ds.layer_count();
    let mut out = Vec::new();
    for mut lyr in ds.layers() {
        let name = lyr.name();
        // Single-layer formats are identified by file + extension
        // (synthetic_buildings.fgb); containers by file + layer (synthetic.buildings).
        let single_layer_format = matches!(ext.as_str(), "fgb" | "shp" | "geojson" | "json" | "gml" | "kml");
        let id = if n_layers == 1 && single_layer_format {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}.{}", sanitize(&name))
        };
        let srs = lyr.spatial_ref();
        let (crs, needs_transform) = match &srs {
            None => ("unknown (assumed EPSG:4326)".to_string(), false),
            Some(s) => {
                let label = match (s.auth_name(), s.auth_code()) {
                    (Some(a), Ok(c)) => format!("{a}:{c}"),
                    _ => s.name().unwrap_or_else(|| "custom".into()),
                };
                (label, !is_wgs84(s))
            }
        };
        let feature_count = lyr.feature_count();
        let native_bounds = lyr.get_extent().ok().map(|e| [e.MinX, e.MinY, e.MaxX, e.MaxY]);
        let bounds = match lyr.get_extent() {
            Ok(e) => {
                let b = [e.MinX, e.MinY, e.MaxX, e.MaxY];
                match (&srs, needs_transform) {
                    (Some(s), true) => {
                        let (to, _) = transforms(s)?;
                        to.0.transform_bounds(&b, 21).map_err(|e| e.to_string())?
                    }
                    _ => b,
                }
            }
            Err(_) => [-180.0, -85.0, 180.0, 85.0],
        };
        let mut geometry = geom_kind(lyr.defn().geometry_type());
        if geometry == GeomKind::Unknown {
            if let Some(f) = lyr.features().next() {
                if let Some(g) = f.geometry() {
                    geometry = geom_kind(g.geometry_type());
                }
            }
        }
        let fields: Vec<FieldInfo> =
            lyr.defn().fields().map(|f| FieldInfo { name: f.name(), kind: field_kind(f.field_type()) }).collect();
        // Tile attributes: preferred names first, then others, max MAX_TILE_FIELDS.
        let usable: Vec<usize> =
            (0..fields.len()).filter(|&i| matches!(fields[i].kind, "integer" | "real" | "string")).collect();
        let mut field_idx: Vec<usize> = usable
            .iter()
            .copied()
            .filter(|&i| PREFERRED_FIELDS.contains(&fields[i].name.to_ascii_lowercase().as_str()))
            .collect();
        for &i in &usable {
            if field_idx.len() >= MAX_TILE_FIELDS {
                break;
            }
            if !field_idx.contains(&i) {
                field_idx.push(i);
            }
        }
        field_idx.truncate(MAX_TILE_FIELDS);
        field_idx.sort();
        let tile_fields = field_idx.iter().map(|&i| fields[i].name.clone()).collect();
        out.push(LayerHandle {
            info: LayerInfo {
                id,
                name: name.clone(),
                source: path.display().to_string(),
                driver: driver.clone(),
                geometry,
                feature_count,
                bounds,
                crs,
                fields,
                tile_fields,
                minzoom: auto_minzoom(feature_count, bounds),
                maxzoom: MAX_ZOOM,
            },
            path: path.to_path_buf(),
            layer_name: name,
            needs_transform,
            native_bounds,
            field_idx,
            pool: Mutex::new(Vec::new()),
            overview: RwLock::new(None),
            filter: RwLock::new(None),
        });
    }
    Ok(out)
}
