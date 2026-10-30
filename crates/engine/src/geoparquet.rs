//! GeoParquet, local or remote, and Overture Maps. The GDAL builds GeoSpaX ships with have no Parquet
//! driver, so the file is read here with the `parquet` crate, fetching byte ranges through GDAL's file
//! systems (a local path, /vsis3/, /vsigs/, /vsiaz/, /vsicurl/): only the footer and the row groups
//! that can touch the area are downloaded. A row group is skipped when its `bbox` statistics (the
//! GeoParquet 1.1 covering column, as Overture writes it) fall outside the area; each row is then
//! checked against the area. The features are written to a GeoPackage and put on the map.
//!
//! Overture Maps (buildings, roads, places, water, land use, boundaries, addresses) is read from its
//! public S3 bucket, newest release first.

use crate::Engine;
use crate::jobs::Status;
use arrow_array::cast::AsArray;
use arrow_array::types::{Float32Type, Float64Type, Int32Type, Int64Type};
use arrow_array::{Array, ArrayRef, RecordBatch, StructArray};
use arrow_schema::DataType;
use bytes::Bytes;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::errors::ParquetError;
use parquet::file::metadata::ParquetMetaData;
use parquet::file::reader::{ChunkReader, Length};
use parquet::file::statistics::Statistics;
use serde_json::{Value, json};
use std::ffi::CString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

// ---------------------------------------------------------------- byte ranges through GDAL

/// A file read in byte ranges through GDAL's virtual file systems.
pub struct VsiFile {
    path: String,
    len: u64,
}

struct Handle(*mut gdal_sys::VSILFILE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { gdal_sys::VSIFCloseL(self.0) };
    }
}

fn open(path: &str) -> Result<Handle, String> {
    let c = CString::new(path).map_err(|e| e.to_string())?;
    let m = CString::new("rb").unwrap();
    let h = unsafe { gdal_sys::VSIFOpenL(c.as_ptr(), m.as_ptr()) };
    if h.is_null() {
        return Err(format!("could not open {path}"));
    }
    Ok(Handle(h))
}

impl VsiFile {
    pub fn open(path: &str) -> Result<Self, String> {
        let h = open(path)?;
        let len = unsafe {
            gdal_sys::VSIFSeekL(h.0, 0, 2);
            gdal_sys::VSIFTellL(h.0)
        };
        if len < 12 {
            return Err(format!("{path}: not a Parquet file"));
        }
        Ok(Self {
            path: path.to_string(),
            len,
        })
    }

    fn read_at(&self, start: u64, len: usize) -> Result<Vec<u8>, String> {
        let h = open(&self.path)?;
        let mut buf = vec![0u8; len];
        let n = unsafe {
            gdal_sys::VSIFSeekL(h.0, start, 0);
            gdal_sys::VSIFReadL(buf.as_mut_ptr() as *mut _, 1, len, h.0)
        };
        buf.truncate(n);
        Ok(buf)
    }
}

impl Length for VsiFile {
    fn len(&self) -> u64 {
        self.len
    }
}

/// Reads the rest of the file from `pos`, in chunks (the crate asks for a reader at an offset).
pub struct VsiRead {
    h: Handle,
}

impl Read for VsiRead {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        Ok(unsafe { gdal_sys::VSIFReadL(buf.as_mut_ptr() as *mut _, 1, buf.len(), self.h.0) })
    }
}

impl ChunkReader for VsiFile {
    type T = VsiRead;
    fn get_read(&self, start: u64) -> parquet::errors::Result<VsiRead> {
        let h = open(&self.path).map_err(ParquetError::General)?;
        unsafe { gdal_sys::VSIFSeekL(h.0, start, 0) };
        Ok(VsiRead { h })
    }
    fn get_bytes(&self, start: u64, length: usize) -> parquet::errors::Result<Bytes> {
        let b = self.read_at(start, length).map_err(ParquetError::General)?;
        if b.len() < length {
            return Err(ParquetError::EOF(format!(
                "{}: short read at {start}",
                self.path
            )));
        }
        Ok(Bytes::from(b))
    }
}

// ---------------------------------------------------------------- reading

/// What one file holds for an area: its metadata, and the row groups that may touch the area.
pub struct Plan {
    pub path: String,
    meta: Arc<ParquetMetaData>,
    pub groups: Vec<usize>,
    pub rows: i64,
}

fn stat_f64(s: &Statistics, max: bool) -> Option<f64> {
    match s {
        Statistics::Double(v) => (if max { v.max_opt() } else { v.min_opt() }).copied(),
        Statistics::Float(v) => (if max { v.max_opt() } else { v.min_opt() }).map(|x| *x as f64),
        _ => None,
    }
}

/// Read the footer and keep the row groups whose `bbox` statistics meet `area` (all of them when the
/// file has no bbox column or no statistics).
pub fn plan(path: &str, area: Option<[f64; 4]>) -> Result<Plan, String> {
    let f = VsiFile::open(path)?;
    let b = ParquetRecordBatchReaderBuilder::try_new(f).map_err(|e| format!("{path}: {e}"))?;
    let meta = b.metadata().clone();
    let mut groups = Vec::new();
    let mut rows = 0;
    for (i, rg) in meta.row_groups().iter().enumerate() {
        let keep = match area {
            None => true,
            Some(a) => {
                let get = |name: &str, max: bool| {
                    rg.columns()
                        .iter()
                        .find(|c| c.column_path().string() == name)
                        .and_then(|c| c.statistics())
                        .and_then(|s| stat_f64(s, max))
                };
                match (
                    get("bbox.xmin", false),
                    get("bbox.ymin", false),
                    get("bbox.xmax", true),
                    get("bbox.ymax", true),
                ) {
                    (Some(x0), Some(y0), Some(x1), Some(y1)) => {
                        x0 <= a[2] && x1 >= a[0] && y0 <= a[3] && y1 >= a[1]
                    }
                    _ => true,
                }
            }
        };
        if keep {
            groups.push(i);
            rows += rg.num_rows();
        }
    }
    Ok(Plan {
        path: path.to_string(),
        meta,
        groups,
        rows,
    })
}

/// The geometry column named by the file's "geo" metadata (GeoParquet), else "geometry".
fn geometry_column(meta: &ParquetMetaData) -> String {
    meta.file_metadata()
        .key_value_metadata()
        .and_then(|kv| kv.iter().find(|k| k.key == "geo"))
        .and_then(|k| k.value.as_deref())
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .and_then(|v| v["primary_column"].as_str().map(str::to_string))
        .unwrap_or_else(|| "geometry".into())
}

/// A plain value of a column, as text for the GeoPackage; nested values are skipped, except
/// Overture's `names.primary` (the feature's name) and `categories.primary` (a place's category).
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Int,
    Real,
    Text,
}

fn column_kind(t: &DataType) -> Option<Kind> {
    Some(match t {
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32 => Kind::Int,
        DataType::Float32 | DataType::Float64 => Kind::Real,
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View | DataType::Boolean => Kind::Text,
        _ => return None,
    })
}

fn cell(a: &ArrayRef, i: usize) -> Option<String> {
    if a.is_null(i) {
        return None;
    }
    Some(match a.data_type() {
        DataType::Utf8 => a.as_string::<i32>().value(i).to_string(),
        DataType::LargeUtf8 => a.as_string::<i64>().value(i).to_string(),
        DataType::Utf8View => a.as_string_view().value(i).to_string(),
        DataType::Boolean => a.as_boolean().value(i).to_string(),
        DataType::Float32 => a.as_primitive::<Float32Type>().value(i).to_string(),
        DataType::Float64 => a.as_primitive::<Float64Type>().value(i).to_string(),
        DataType::Int32 => a.as_primitive::<Int32Type>().value(i).to_string(),
        DataType::Int64 => a.as_primitive::<Int64Type>().value(i).to_string(),
        DataType::Int8 => a
            .as_primitive::<arrow_array::types::Int8Type>()
            .value(i)
            .to_string(),
        DataType::Int16 => a
            .as_primitive::<arrow_array::types::Int16Type>()
            .value(i)
            .to_string(),
        DataType::UInt8 => a
            .as_primitive::<arrow_array::types::UInt8Type>()
            .value(i)
            .to_string(),
        DataType::UInt16 => a
            .as_primitive::<arrow_array::types::UInt16Type>()
            .value(i)
            .to_string(),
        DataType::UInt32 => a
            .as_primitive::<arrow_array::types::UInt32Type>()
            .value(i)
            .to_string(),
        _ => return None,
    })
}

fn wkb(a: &ArrayRef, i: usize) -> Option<&[u8]> {
    if a.is_null(i) {
        return None;
    }
    match a.data_type() {
        DataType::Binary => Some(a.as_binary::<i32>().value(i)),
        DataType::LargeBinary => Some(a.as_binary::<i64>().value(i)),
        DataType::BinaryView => Some(a.as_binary_view().value(i)),
        _ => None,
    }
}

fn sub(s: &StructArray, name: &str) -> Option<ArrayRef> {
    s.column_by_name(name).cloned()
}

/// The columns written for each feature: (output name, how to read it from a batch).
#[derive(Clone)]
enum Source {
    Plain(String),
    Nested(String, String),
}

fn fields_of(schema: &arrow_schema::Schema, geom: &str) -> Vec<(String, Kind, Source)> {
    let mut out = Vec::new();
    for f in schema.fields() {
        let n = f.name();
        if n == geom || n == "bbox" {
            continue;
        }
        if let Some(k) = column_kind(f.data_type()) {
            out.push((n.clone(), k, Source::Plain(n.clone())));
        } else if let DataType::Struct(kids) = f.data_type() {
            if let Some(p) = kids
                .iter()
                .find(|c| c.name() == "primary")
                .filter(|c| column_kind(c.data_type()) == Some(Kind::Text))
            {
                let out_name = if n == "names" {
                    "name".to_string()
                } else {
                    format!("{n}_primary")
                };
                out.push((
                    out_name,
                    Kind::Text,
                    Source::Nested(n.clone(), p.name().clone()),
                ));
            }
        }
    }
    out
}

fn get_col(b: &RecordBatch, s: &Source) -> Option<ArrayRef> {
    match s {
        Source::Plain(n) => b.column_by_name(n).cloned(),
        Source::Nested(n, k) => b
            .column_by_name(n)
            .and_then(|c| c.as_struct_opt().and_then(|s| sub(s, k))),
    }
}

pub struct Written {
    pub features: u64,
    pub path: PathBuf,
}

/// Write the features of the planned row groups that lie in `area` to a GeoPackage layer.
/// `progress(groups_done, groups_total)` returns false to stop.
pub fn write_gpkg(
    plans: &[Plan],
    area: Option<[f64; 4]>,
    out: &Path,
    layer: &str,
    limit: u64,
    mut progress: impl FnMut(usize, usize) -> bool,
) -> Result<Written, String> {
    use gdal::spatial_ref::{AxisMappingStrategy, SpatialRef};
    use gdal::vector::{
        Feature, FieldDefn, Geometry, LayerAccess, LayerOptions, OGRFieldType as F,
        OGRwkbGeometryType as G,
    };
    let e = |x: gdal::errors::GdalError| x.to_string();
    let first = plans
        .iter()
        .find(|p| !p.groups.is_empty())
        .or(plans.first())
        .ok_or("no files to read")?;
    let schema = parquet::arrow::parquet_to_arrow_schema(
        first.meta.file_metadata().schema_descr(),
        first.meta.file_metadata().key_value_metadata(),
    )
    .map_err(|x| x.to_string())?;
    let geom = geometry_column(&first.meta);
    if schema.field_with_name(&geom).is_err() {
        return Err(format!("no geometry column ({geom}) in this Parquet file"));
    }
    let fields = fields_of(&schema, &geom);
    let _ = std::fs::remove_file(out);
    if let Some(d) = out.parent() {
        std::fs::create_dir_all(d).map_err(|x| x.to_string())?;
    }
    let drv = gdal::DriverManager::get_driver_by_name("GPKG").map_err(e)?;
    let mut ds = drv.create_vector_only(out).map_err(e)?;
    let mut srs = SpatialRef::from_epsg(4326).map_err(e)?;
    srs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let mut txn = ds.start_transaction().map_err(e)?;
    let lyr = txn
        .create_layer(LayerOptions {
            name: layer,
            srs: Some(&srs),
            ty: G::wkbUnknown,
            options: None,
        })
        .map_err(e)?;
    for (n, k, _) in &fields {
        FieldDefn::new(
            n,
            match k {
                Kind::Int => F::OFTInteger64,
                Kind::Real => F::OFTReal,
                Kind::Text => F::OFTString,
            },
        )
        .map_err(e)?
        .add_to_layer(&lyr)
        .map_err(e)?;
    }
    let total: usize = plans.iter().map(|p| p.groups.len()).sum();
    let mut done = 0usize;
    let mut n = 0u64;
    'files: for p in plans.iter().filter(|p| !p.groups.is_empty()) {
        for &g in &p.groups {
            if !progress(done, total) {
                return Err("stopped".into());
            }
            let reader = ParquetRecordBatchReaderBuilder::try_new(VsiFile::open(&p.path)?)
                .map_err(|x| x.to_string())?
                .with_row_groups(vec![g])
                .with_batch_size(8192)
                .build()
                .map_err(|x| x.to_string())?;
            for batch in reader {
                let b = batch.map_err(|x| x.to_string())?;
                let Some(gcol) = b.column_by_name(&geom).cloned() else {
                    continue;
                };
                let bbox = b
                    .column_by_name("bbox")
                    .and_then(|c| c.as_struct_opt().cloned());
                let bb = |name: &str| {
                    bbox.as_ref()
                        .and_then(|s| sub(s, name))
                        .and_then(|c| arrow_cast_f64(&c))
                };
                let (bx0, by0, bx1, by1) = (bb("xmin"), bb("ymin"), bb("xmax"), bb("ymax"));
                let cols: Vec<Option<ArrayRef>> =
                    fields.iter().map(|(_, _, s)| get_col(&b, s)).collect();
                for i in 0..b.num_rows() {
                    if let (Some(a), Some(x0), Some(y0), Some(x1), Some(y1)) =
                        (area, &bx0, &by0, &bx1, &by1)
                    {
                        if x0[i] > a[2] || x1[i] < a[0] || y0[i] > a[3] || y1[i] < a[1] {
                            continue;
                        }
                    }
                    let Some(w) = wkb(&gcol, i) else { continue };
                    let Ok(gm) = Geometry::from_wkb(w) else {
                        continue;
                    };
                    if let (Some(a), None) = (area, &bx0) {
                        let env = gm.envelope();
                        if env.MinX > a[2] || env.MaxX < a[0] || env.MinY > a[3] || env.MaxY < a[1]
                        {
                            continue;
                        }
                    }
                    let mut f = Feature::new(lyr.defn()).map_err(e)?;
                    for (j, (_, k, _)) in fields.iter().enumerate() {
                        match cols[j].as_ref().and_then(|c| cell(c, i)) {
                            Some(v) => match k {
                                Kind::Int => f
                                    .set_field_integer64(j, v.parse().unwrap_or(0))
                                    .map_err(e)?,
                                Kind::Real => f
                                    .set_field_double(j, v.parse().unwrap_or(f64::NAN))
                                    .map_err(e)?,
                                Kind::Text => f.set_field_string(j, &v).map_err(e)?,
                            },
                            None => f.set_field_null(j).map_err(e)?,
                        }
                    }
                    f.set_geometry(gm).map_err(e)?;
                    f.create(&lyr).map_err(e)?;
                    n += 1;
                    if n >= limit {
                        break 'files;
                    }
                }
            }
            done += 1;
        }
    }
    progress(total, total);
    drop(lyr);
    txn.commit().map_err(e)?;
    Ok(Written {
        features: n,
        path: out.to_path_buf(),
    })
}

fn arrow_cast_f64(a: &ArrayRef) -> Option<Vec<f64>> {
    match a.data_type() {
        DataType::Float32 => Some(
            a.as_primitive::<Float32Type>()
                .values()
                .iter()
                .map(|v| *v as f64)
                .collect(),
        ),
        DataType::Float64 => Some(a.as_primitive::<Float64Type>().values().to_vec()),
        _ => None,
    }
}

// ---------------------------------------------------------------- Overture Maps

/// Overture's themes: (id, title, theme folder, type folder).
pub const OVERTURE: &[(&str, &str, &str, &str)] = &[
    ("buildings", "Buildings", "buildings", "building"),
    ("roads", "Roads and paths", "transportation", "segment"),
    (
        "places",
        "Places (shops, schools, clinics…)",
        "places",
        "place",
    ),
    ("water", "Water", "base", "water"),
    ("land_use", "Land use", "base", "land_use"),
    ("land_cover", "Land cover", "base", "land_cover"),
    (
        "boundaries",
        "Boundaries (countries, regions)",
        "divisions",
        "division_area",
    ),
    ("addresses", "Addresses", "addresses", "address"),
];

/// Where the releases are: Overture's public bucket, or GEOSPAX_OVERTURE_ROOT (a GDAL path; tests).
fn overture_root() -> String {
    if let Ok(r) = std::env::var("GEOSPAX_OVERTURE_ROOT") {
        return r;
    }
    let bucket = "/vsis3/overturemaps-us-west-2";
    for (k, v) in [("AWS_NO_SIGN_REQUEST", "YES"), ("AWS_REGION", "us-west-2")] {
        let (p, k, v) = (
            CString::new(bucket).unwrap(),
            CString::new(k).unwrap(),
            CString::new(v).unwrap(),
        );
        unsafe { gdal_sys::VSISetPathSpecificOption(p.as_ptr(), k.as_ptr(), v.as_ptr()) };
    }
    format!("{bucket}/release")
}

fn read_dir(path: &str) -> Vec<String> {
    let c = CString::new(path).unwrap();
    let list = unsafe { gdal_sys::VSIReadDir(c.as_ptr()) };
    if list.is_null() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        let p = unsafe { *list.add(i) };
        if p.is_null() {
            break;
        }
        out.push(
            unsafe { std::ffi::CStr::from_ptr(p) }
                .to_string_lossy()
                .trim_end_matches('/')
                .to_string(),
        );
        i += 1;
    }
    unsafe { gdal_sys::CSLDestroy(list) };
    out
}

/// The newest release folder (named by date, e.g. 2026-09-17.0).
pub fn latest_release() -> Result<String, String> {
    let root = overture_root();
    let mut r: Vec<String> = read_dir(&root)
        .into_iter()
        .filter(|n| n.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .collect();
    r.sort();
    r.pop()
        .map(|x| format!("{root}/{x}"))
        .ok_or_else(|| "could not reach Overture Maps (no releases listed)".into())
}

/// Download one Overture theme for `area` (lon/lat, at most about 0.5° across) as a job with the
/// download gauge; the layer is added to the map when it is done.
pub fn overture(engine: &Arc<Engine>, theme: &str, area: [f64; 4]) -> Result<Value, String> {
    let &(id, title, tfolder, kind) = OVERTURE
        .iter()
        .find(|t| t.0 == theme)
        .ok_or_else(|| format!("unknown Overture theme {theme}"))?;
    if !(area[0] < area[2] && area[1] < area[3])
        || area[2] - area[0] > 0.5
        || area[3] - area[1] > 0.5
    {
        return Err(
            "zoom in: Overture data is fetched for an area up to about 50 km across".into(),
        );
    }
    let job = engine.jobs.create("overture", id);
    let (e, j) = (engine.clone(), job.clone());
    engine.job_pool.spawn(move || {
        j.update(|s| {
            s.status = Status::Running;
            s.message = format!("Overture {title}: finding the files for the area");
        });
        crate::raster::net_reset();
        let t0 = std::time::Instant::now();
        let res = (|| -> Result<Value, String> {
            let rel = latest_release()?;
            let dir = format!("{rel}/theme={tfolder}/type={kind}");
            let files: Vec<String> = read_dir(&dir).into_iter().filter(|f| f.ends_with(".parquet") || f.starts_with("part-")).map(|f| format!("{dir}/{f}")).collect();
            if files.is_empty() {
                return Err(format!("no Overture files in {dir}"));
            }
            use rayon::prelude::*;
            let plans: Vec<Plan> = files.par_iter().map(|f| plan(f, Some(area))).collect::<Result<Vec<_>, _>>()?;
            let release = rel.rsplit('/').next().unwrap_or("").to_string();
            // one file per theme and area (a later download of the same area replaces it)
            let key = area.iter().fold(0u64, |h, v| h.wrapping_mul(1_000_003).wrapping_add((v * 1e4).round() as i64 as u64)) % 0xffff_ff;
            let out = e.state_dir.join("overture").join(format!("overture_{id}_{key:06x}.gpkg"));
            let layer = id.to_string();
            let w = write_gpkg(&plans, Some(area), &out, &layer, 2_000_000, |done, total| {
                let bytes = crate::raster::net_bytes();
                let secs = t0.elapsed().as_secs_f64().max(0.001);
                let f = if total == 0 { 1.0 } else { done as f64 / total as f64 };
                let eta = (f > 0.02).then(|| secs * (1.0 - f) / f);
                let est = (f > 0.05 && bytes > 0).then(|| (bytes as f64 / f) as u64);
                j.update(|s| s.transfer = Some(json!({ "label": format!("Overture {title}"), "fraction": f, "bytes": bytes, "total": est, "rate": bytes as f64 / secs, "eta_s": eta, "elapsed_s": secs })));
                !j.cancel.load(Ordering::Relaxed)
            })?;
            if w.features == 0 {
                return Err(format!("Overture has no {} in this area", title.to_lowercase()));
            }
            let hs = crate::catalog::load_layers(&w.path)?;
            let ids = e.register_layers(hs);
            Ok(json!({ "layers": ids, "rasters": [], "features": w.features, "release": release, "path": w.path.display().to_string() }))
        })();
        j.update(|s| s.transfer = None);
        match res {
            Ok(v) => {
                let n = v["features"].as_u64().unwrap_or(0);
                j.finish(Status::Done, format!("Overture {title}: {n} features"), Some(v))
            }
            Err(err) if j.cancel.load(Ordering::Relaxed) => j.finish(Status::Cancelled, err, None),
            Err(err) => j.finish(Status::Failed, err, None),
        }
    });
    Ok(json!({ "job": job.id }))
}

/// A GeoParquet file (local or remote GDAL path) for an optional area, as a layer on the map.
pub fn open_file(
    engine: &Arc<Engine>,
    path: &str,
    area: Option<[f64; 4]>,
) -> Result<Value, String> {
    let p = plan(path, area)?;
    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "geoparquet".into());
    let id = crate::raster::sanitize(&stem);
    let out = engine
        .state_dir
        .join("geoparquet")
        .join(format!("{id}.gpkg"));
    let w = write_gpkg(&[p], area, &out, &id, 5_000_000, |_, _| true)?;
    let ids = engine.register_layers(crate::catalog::load_layers(&w.path)?);
    Ok(json!({ "layers": ids, "rasters": [], "features": w.features }))
}

// ---------------------------------------------------------------- writing

/// One layer of a vector file (GeoPackage, GeoJSON …) as GeoParquet 1.1: the attributes as typed
/// columns, the geometry as WKB in `geometry`. Coordinates are written as they are in the source:
/// pass a file in WGS 84 (lon/lat) for the default OGC:CRS84. Returns the number of rows.
pub fn write_file(src: &Path, layer: Option<&str>, out: &Path) -> Result<u64, String> {
    use arrow_array::builder::{
        BinaryBuilder, BooleanBuilder, Float64Builder, Int64Builder, StringBuilder,
    };
    use arrow_schema::{Field, Schema};
    use gdal::vector::{FieldValue, LayerAccess, OGRFieldType};
    use parquet::arrow::ArrowWriter;
    use parquet::basic::{Compression, ZstdLevel};
    use parquet::file::properties::WriterProperties;
    let gerr = |e: gdal::errors::GdalError| e.to_string();
    let ds = gdal::Dataset::open(src).map_err(gerr)?;
    let mut lyr = match layer {
        Some(n) => ds.layer_by_name(n).map_err(gerr)?,
        None => ds.layer(0).map_err(gerr)?,
    };
    #[derive(Clone, Copy)]
    enum K {
        Int,
        Real,
        Bool,
        Text,
    }
    let fields: Vec<(String, K)> =
        lyr.defn()
            .fields()
            .map(|f| {
                let k = match f.field_type() {
                    OGRFieldType::OFTInteger | OGRFieldType::OFTInteger64 => {
                        if f.name().is_empty() { K::Text } else { K::Int }
                    }
                    OGRFieldType::OFTReal => K::Real,
                    _ => K::Text,
                };
                (f.name(), k)
            })
            .collect();
    let _ = K::Bool; // booleans arrive as integers from GDAL; kept for completeness
    let mut cols: Vec<Field> = fields
        .iter()
        .map(|(n, k)| {
            Field::new(
                n,
                match k {
                    K::Int => DataType::Int64,
                    K::Real => DataType::Float64,
                    K::Bool => DataType::Boolean,
                    K::Text => DataType::Utf8,
                },
                true,
            )
        })
        .collect();
    cols.push(Field::new("geometry", DataType::Binary, true));
    // bounds and geometry types for the "geo" metadata
    let mut bbox = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut types: std::collections::BTreeSet<String> = Default::default();
    let mut ints: Vec<Int64Builder> = Vec::new();
    let mut reals: Vec<Float64Builder> = Vec::new();
    let mut bools: Vec<BooleanBuilder> = Vec::new();
    let mut texts: Vec<StringBuilder> = Vec::new();
    let mut slot = Vec::with_capacity(fields.len());
    for (_, k) in &fields {
        slot.push(match k {
            K::Int => {
                ints.push(Int64Builder::new());
                ints.len() - 1
            }
            K::Real => {
                reals.push(Float64Builder::new());
                reals.len() - 1
            }
            K::Bool => {
                bools.push(BooleanBuilder::new());
                bools.len() - 1
            }
            K::Text => {
                texts.push(StringBuilder::new());
                texts.len() - 1
            }
        });
    }
    let mut geoms = BinaryBuilder::new();
    let mut n = 0u64;
    for f in lyr.features() {
        for (i, (_, k)) in fields.iter().enumerate() {
            let v = f.field(i).ok().flatten();
            let j = slot[i];
            match k {
                K::Int => ints[j].append_option(match v {
                    Some(FieldValue::IntegerValue(x)) => Some(x as i64),
                    Some(FieldValue::Integer64Value(x)) => Some(x),
                    _ => None,
                }),
                K::Real => reals[j].append_option(match v {
                    Some(FieldValue::RealValue(x)) => Some(x),
                    Some(FieldValue::IntegerValue(x)) => Some(x as f64),
                    _ => None,
                }),
                K::Bool => bools[j].append_option(match v {
                    Some(FieldValue::IntegerValue(x)) => Some(x != 0),
                    _ => None,
                }),
                K::Text => texts[j].append_option(v.map(|v| match v {
                    FieldValue::StringValue(s) => s,
                    FieldValue::DateValue(d) => d.to_string(),
                    FieldValue::DateTimeValue(d) => d.to_rfc3339(),
                    other => format!("{other:?}"),
                })),
            }
        }
        match f.geometry() {
            Some(g) => {
                let e = g.envelope();
                bbox = [
                    bbox[0].min(e.MinX),
                    bbox[1].min(e.MinY),
                    bbox[2].max(e.MaxX),
                    bbox[3].max(e.MaxY),
                ];
                types.insert(g.geometry_name().to_ascii_lowercase());
                geoms.append_value(g.wkb().map_err(gerr)?);
            }
            None => geoms.append_null(),
        }
        n += 1;
    }
    let names: Vec<String> = types
        .iter()
        .map(|t| {
            match t.as_str() {
                "point" => "Point",
                "linestring" => "LineString",
                "polygon" => "Polygon",
                "multipoint" => "MultiPoint",
                "multilinestring" => "MultiLineString",
                "multipolygon" => "MultiPolygon",
                _ => "GeometryCollection",
            }
            .to_string()
        })
        .collect();
    let mut col = json!({ "encoding": "WKB", "geometry_types": names });
    if bbox[0].is_finite() {
        col["bbox"] = json!(bbox);
    }
    let geo =
        json!({ "version": "1.1.0", "primary_column": "geometry", "columns": { "geometry": col } });
    let schema = Arc::new(
        Schema::new(cols).with_metadata(
            [("geo".to_string(), geo.to_string())]
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>(),
        ),
    );
    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(fields.len() + 1);
    for (i, (_, k)) in fields.iter().enumerate() {
        let j = slot[i];
        arrays.push(match k {
            K::Int => Arc::new(ints[j].finish()),
            K::Real => Arc::new(reals[j].finish()),
            K::Bool => Arc::new(bools[j].finish()),
            K::Text => Arc::new(texts[j].finish()),
        });
    }
    arrays.push(Arc::new(geoms.finish()));
    let batch = RecordBatch::try_new(schema.clone(), arrays).map_err(|e| e.to_string())?;
    let props = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::default()))
        .build();
    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut w = ArrowWriter::try_new(file, schema, Some(props)).map_err(|e| e.to_string())?;
    w.write(&batch).map_err(|e| e.to_string())?;
    w.close().map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::{BinaryArray, Float32Array, Int64Array, StringArray};
    use arrow_schema::{Field, Fields, Schema};
    use parquet::arrow::ArrowWriter;
    use parquet::file::properties::WriterProperties;

    fn point_wkb(x: f64, y: f64) -> Vec<u8> {
        let mut v = vec![1u8, 1, 0, 0, 0];
        v.extend(x.to_le_bytes());
        v.extend(y.to_le_bytes());
        v
    }

    /// An Overture-like file: id, names.primary, height, bbox struct, WKB geometry; 3 row groups
    /// of 4 points each, the groups 10° apart so the statistics separate them.
    pub fn fixture(path: &Path) {
        let bbox_fields = Fields::from(vec![
            Field::new("xmin", DataType::Float32, true),
            Field::new("ymin", DataType::Float32, true),
            Field::new("xmax", DataType::Float32, true),
            Field::new("ymax", DataType::Float32, true),
        ]);
        let names_fields = Fields::from(vec![Field::new("primary", DataType::Utf8, true)]);
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("names", DataType::Struct(names_fields.clone()), true),
            Field::new("height", DataType::Int64, true),
            Field::new("bbox", DataType::Struct(bbox_fields.clone()), true),
            Field::new("geometry", DataType::Binary, true),
        ])
        .with_metadata([("geo".to_string(), r#"{"version":"1.1.0","primary_column":"geometry","columns":{"geometry":{"encoding":"WKB"}}}"#.to_string())].into_iter().collect::<std::collections::HashMap<_, _>>()));
        let props = WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .build();
        let mut w = ArrowWriter::try_new(
            std::fs::File::create(path).unwrap(),
            schema.clone(),
            Some(props),
        )
        .unwrap();
        for g in 0..3 {
            let xs: Vec<f64> = (0..4).map(|i| g as f64 * 10.0 + i as f64 * 0.01).collect();
            let ys: Vec<f64> = (0..4).map(|i| 5.0 + i as f64 * 0.01).collect();
            let f32s = |v: &Vec<f64>| {
                Arc::new(Float32Array::from(
                    v.iter().map(|x| *x as f32).collect::<Vec<_>>(),
                )) as ArrayRef
            };
            let bbox = StructArray::new(
                bbox_fields.clone(),
                vec![f32s(&xs), f32s(&ys), f32s(&xs), f32s(&ys)],
                None,
            );
            let names = StructArray::new(
                names_fields.clone(),
                vec![Arc::new(StringArray::from(
                    (0..4).map(|i| format!("b{g}{i}")).collect::<Vec<_>>(),
                )) as ArrayRef],
                None,
            );
            let geoms: Vec<Vec<u8>> = xs.iter().zip(&ys).map(|(x, y)| point_wkb(*x, *y)).collect();
            let batch = RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(StringArray::from(
                        (0..4).map(|i| format!("id{g}{i}")).collect::<Vec<_>>(),
                    )),
                    Arc::new(names),
                    Arc::new(Int64Array::from(vec![3, 6, 9, 12])),
                    Arc::new(bbox),
                    Arc::new(BinaryArray::from(
                        geoms.iter().map(|g| g.as_slice()).collect::<Vec<_>>(),
                    )),
                ],
            )
            .unwrap();
            w.write(&batch).unwrap();
            w.flush().unwrap();
        }
        w.close().unwrap();
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gx-gpq-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_only_the_row_groups_for_the_area() {
        crate::raster::configure_gdal();
        let dir = tmp("rg");
        let f = dir.join("b.parquet");
        fixture(&f);
        let all = plan(f.to_str().unwrap(), None).unwrap();
        assert_eq!(all.groups, vec![0, 1, 2]);
        // around the second group only, cutting off its last point
        let area = [9.99, 4.99, 10.025, 5.1];
        let p = plan(f.to_str().unwrap(), Some(area)).unwrap();
        assert_eq!(p.groups, vec![1]);
        let out = dir.join("o.gpkg");
        let w = write_gpkg(&[p], Some(area), &out, "b", 100, |_, _| true).unwrap();
        assert_eq!(w.features, 3);
        let hs = crate::catalog::load_layers(&out).unwrap();
        let ds = gdal::Dataset::open(&out).unwrap();
        use gdal::vector::LayerAccess;
        let mut l = ds.layer(0).unwrap();
        let names: Vec<String> = l
            .features()
            .filter_map(|f| {
                f.field_index("name")
                    .ok()
                    .and_then(|i| f.field_as_string(i).ok().flatten())
            })
            .collect();
        assert_eq!(names, vec!["b10", "b11", "b12"]);
        assert!(!hs.is_empty());
    }

    #[test]
    fn overture_layout_newest_release() {
        crate::raster::configure_gdal();
        let dir = tmp("ov");
        for r in ["2026-01-01.0", "2026-09-17.0"] {
            let d = dir.join(r).join("theme=buildings/type=building");
            std::fs::create_dir_all(&d).unwrap();
            fixture(&d.join("part-00000.parquet"));
        }
        unsafe { std::env::set_var("GEOSPAX_OVERTURE_ROOT", &dir) };
        assert!(latest_release().unwrap().ends_with("2026-09-17.0"));
    }
}
