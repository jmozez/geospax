//! Feature reading. Two interchangeable paths hand out the same rows
//! (fid, WKB in the layer's CRS, selected attributes):
//!
//! * [`ReadMode::Arrow`]: GDAL's columnar stream (RFC 86, `OGR_L_GetArrowStream`,
//!   GDAL >= 3.6). Batches of up to 16k features cross the FFI boundary at once,
//!   and GPKG, FlatGeobuf, Parquet etc. have specialised fast paths.
//! * [`ReadMode::Features`]: the classic per-feature API (one FFI round trip per
//!   feature, plus one per attribute). Kept as a fallback and for benchmarks.
//!
//! Both honour the layer's spatial filter and the "ignored fields" list, which
//! stops GDAL decoding attribute columns nobody asked for.

use crate::mvt::Val;
use arrow_array::cast::AsArray;
use arrow_array::ffi_stream::{ArrowArrayStreamReader, FFI_ArrowArrayStream};
use arrow_array::types::{Float32Type, Float64Type, Int16Type, Int32Type, Int64Type};
use arrow_array::{Array, ArrayRef, RecordBatchReader};
use arrow_schema::DataType;
use gdal::cpl::CslStringList;
use gdal::vector::{FieldValue, Layer, LayerAccess};
use std::ffi::{c_char, CStr};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReadMode {
    #[default]
    Arrow,
    Features,
}

impl std::str::FromStr for ReadMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "arrow" => Ok(ReadMode::Arrow),
            "features" => Ok(ReadMode::Features),
            o => Err(format!("unknown reader '{o}' (arrow|features)")),
        }
    }
}

impl ReadMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ReadMode::Arrow => "arrow",
            ReadMode::Features => "features",
        }
    }
}

fn gdal_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Tell GDAL to skip every attribute except `keep` (OGR field indices), and
/// optionally the geometry. Replaces any previous ignore list on the layer.
pub(crate) fn set_ignored_fields(lyr: &Layer, keep: &[usize], ignore_geometry: bool) -> Result<(), String> {
    let mut list = CslStringList::new();
    for (i, f) in lyr.defn().fields().enumerate() {
        if !keep.contains(&i) {
            list.add_string(&f.name()).map_err(gdal_err)?;
        }
    }
    list.add_string("OGR_STYLE").map_err(gdal_err)?;
    if ignore_geometry {
        list.add_string("OGR_GEOMETRY").map_err(gdal_err)?;
    }
    let err = unsafe { gdal_sys::OGR_L_SetIgnoredFields(lyr.c_layer(), list.as_ptr() as *mut *const c_char) };
    if err != gdal_sys::OGRErr::OGRERR_NONE {
        return Err(format!("OGR_L_SetIgnoredFields failed ({err})"));
    }
    Ok(())
}

/// Typed accessor over the Arrow arrays GDAL emits for OGR fields.
enum Col<'a> {
    Str(&'a arrow_array::StringArray),
    LStr(&'a arrow_array::LargeStringArray),
    I16(&'a arrow_array::Int16Array),
    I32(&'a arrow_array::Int32Array),
    I64(&'a arrow_array::Int64Array),
    F32(&'a arrow_array::Float32Array),
    F64(&'a arrow_array::Float64Array),
    Bool(&'a arrow_array::BooleanArray),
    Other,
}

impl<'a> Col<'a> {
    fn new(a: &'a ArrayRef) -> Self {
        match a.data_type() {
            DataType::Utf8 => Col::Str(a.as_string::<i32>()),
            DataType::LargeUtf8 => Col::LStr(a.as_string::<i64>()),
            DataType::Int16 => Col::I16(a.as_primitive::<Int16Type>()),
            DataType::Int32 => Col::I32(a.as_primitive::<Int32Type>()),
            DataType::Int64 => Col::I64(a.as_primitive::<Int64Type>()),
            DataType::Float32 => Col::F32(a.as_primitive::<Float32Type>()),
            DataType::Float64 => Col::F64(a.as_primitive::<Float64Type>()),
            DataType::Boolean => Col::Bool(a.as_boolean()),
            _ => Col::Other,
        }
    }

    #[inline]
    fn get(&self, i: usize) -> Option<Val> {
        macro_rules! val {
            ($a:expr, $f:expr) => {
                if $a.is_null(i) { None } else { Some($f($a.value(i))) }
            };
        }
        match self {
            Col::Str(a) => val!(a, |v: &str| Val::Str(v.to_string())),
            Col::LStr(a) => val!(a, |v: &str| Val::Str(v.to_string())),
            Col::I16(a) => val!(a, |v: i16| Val::Int(v as i64)),
            Col::I32(a) => val!(a, |v: i32| Val::Int(v as i64)),
            Col::I64(a) => val!(a, |v: i64| Val::Int(v)),
            Col::F32(a) => val!(a, |v: f32| Val::Dbl(v as f64)),
            Col::F64(a) => val!(a, |v: f64| Val::Dbl(v)),
            Col::Bool(a) => val!(a, |v: bool| Val::Int(v as i64)),
            Col::Other => None,
        }
    }

    /// Numeric view (for classification).
    #[inline]
    fn num(&self, i: usize) -> Option<f64> {
        match self.get(i)? {
            Val::Int(v) => Some(v as f64),
            Val::Dbl(v) if v.is_finite() => Some(v),
            _ => None,
        }
    }
}

enum Wkb<'a> {
    B(&'a arrow_array::BinaryArray),
    L(&'a arrow_array::LargeBinaryArray),
}

impl<'a> Wkb<'a> {
    #[inline]
    fn get(&self, i: usize) -> Option<&'a [u8]> {
        match self {
            Wkb::B(a) => (!a.is_null(i)).then(|| a.value(i)),
            Wkb::L(a) => (!a.is_null(i)).then(|| a.value(i)),
        }
    }
}

fn open_stream(lyr: &mut Layer, include_fid: bool) -> Result<ArrowArrayStreamReader, String> {
    let mut opts = CslStringList::new();
    opts.set_name_value("INCLUDE_FID", if include_fid { "YES" } else { "NO" }).map_err(gdal_err)?;
    opts.set_name_value("MAX_FEATURES_IN_BATCH", "16384").map_err(gdal_err)?;
    let mut stream = FFI_ArrowArrayStream::empty();
    // FFI_ArrowArrayStream and GDAL's ArrowArrayStream are both the Arrow C
    // stream interface struct, so the pointer cast is layout-compatible.
    unsafe { lyr.read_arrow_stream(&mut stream as *mut FFI_ArrowArrayStream as *mut gdal::ArrowArrayStream, &opts) }
        .map_err(|e| format!("OGR_L_GetArrowStream: {e}"))?;
    ArrowArrayStreamReader::try_new(stream).map_err(gdal_err)
}

fn fid_column(lyr: &Layer) -> String {
    let p = unsafe { gdal_sys::OGR_L_GetFIDColumn(lyr.c_layer()) };
    let name = if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() };
    if name.is_empty() { "OGC_FID".to_string() } else { name }
}

/// Columnar read: call `f(fid, wkb, attrs)` per row until it returns false.
/// `fields` = (tile key index, OGR field name). Returns rows scanned.
pub(crate) fn for_each_arrow(
    lyr: &mut Layer,
    fields: &[(u32, String)],
    mut f: impl FnMut(Option<u64>, &[u8], Vec<(u32, Val)>) -> bool,
) -> Result<u32, String> {
    let fid_name = fid_column(lyr);
    let reader = open_stream(lyr, true)?;
    let schema = reader.schema();
    let geom_idx = schema
        .fields()
        .iter()
        .position(|fd| fd.metadata().get("ARROW:extension:name").is_some_and(|n| n.ends_with("wkb")))
        .or_else(|| schema.fields().iter().position(|fd| matches!(fd.data_type(), DataType::Binary | DataType::LargeBinary)))
        .ok_or("no WKB geometry column in the Arrow stream")?;
    let fid_idx = schema.index_of(&fid_name).ok();
    let cols: Vec<(u32, Option<usize>)> = fields.iter().map(|(k, n)| (*k, schema.index_of(n).ok())).collect();
    let mut scanned = 0u32;
    let validate = std::env::var_os("GEOSPAX_VALIDATE_ARROW").is_some();
    let mut nbatch = 0;
    for batch in reader {
        let batch = batch.map_err(gdal_err)?;
        nbatch += 1;
        if validate {
            for (i, c) in batch.columns().iter().enumerate() {
                if let Err(e) = c.to_data().validate_full() {
                    return Err(format!(
                        "invalid Arrow column {i} ({}: {}) in batch {nbatch} ({} rows, {scanned} rows before): {e}",
                        schema.field(i).name(),
                        c.data_type(),
                        batch.num_rows()
                    ));
                }
            }
        }
        let g = batch.column(geom_idx);
        let wkb = match g.data_type() {
            DataType::Binary => Wkb::B(g.as_binary::<i32>()),
            DataType::LargeBinary => Wkb::L(g.as_binary::<i64>()),
            t => return Err(format!("unexpected geometry column type {t}")),
        };
        let fids = fid_idx.and_then(|i| batch.column(i).as_primitive_opt::<Int64Type>());
        let attr_cols: Vec<(u32, Col)> =
            cols.iter().filter_map(|(k, ci)| ci.map(|ci| (*k, Col::new(batch.column(ci))))).collect();
        for row in 0..batch.num_rows() {
            scanned += 1;
            let Some(w) = wkb.get(row) else { continue };
            let fid = fids.and_then(|a| (!a.is_null(row)).then(|| a.value(row) as u64));
            let attrs = attr_cols.iter().filter_map(|(k, c)| c.get(row).map(|v| (*k, v))).collect();
            if !f(fid, w, attrs) {
                return Ok(scanned);
            }
        }
    }
    Ok(scanned)
}

/// Per-feature read with the same contract as [`for_each_arrow`].
/// `fields` = (tile key index, OGR field index).
pub(crate) fn for_each_feature(
    lyr: &mut Layer,
    fields: &[(u32, usize)],
    mut f: impl FnMut(Option<u64>, &[u8], Vec<(u32, Val)>) -> bool,
) -> Result<u32, String> {
    let mut scanned = 0u32;
    for feat in lyr.features() {
        scanned += 1;
        let Some(g) = feat.geometry() else { continue };
        let Ok(wkb) = g.wkb() else { continue };
        let mut attrs = Vec::with_capacity(fields.len());
        for &(k, fi) in fields {
            let v = match feat.field(fi) {
                Ok(Some(FieldValue::StringValue(s))) => Val::Str(s),
                Ok(Some(FieldValue::IntegerValue(i))) => Val::Int(i as i64),
                Ok(Some(FieldValue::Integer64Value(i))) => Val::Int(i),
                Ok(Some(FieldValue::RealValue(d))) => Val::Dbl(d),
                _ => continue,
            };
            attrs.push((k, v));
        }
        let fid = feat.fid();
        drop(feat); // OGR_F_Destroy before handing control back
        if !f(fid, &wkb, attrs) {
            break;
        }
    }
    Ok(scanned)
}

/// Values of one attribute column (geometry skipped), for classification.
pub enum ColumnValues {
    Num(Vec<f64>),
    Str(Vec<String>),
}

/// Scan a single attribute over the whole layer with the Arrow stream.
pub(crate) fn scan_column(lyr: &mut Layer, field_idx: usize) -> Result<ColumnValues, String> {
    let name = lyr.defn().fields().nth(field_idx).map(|f| f.name()).ok_or("bad field index")?;
    lyr.clear_spatial_filter();
    set_ignored_fields(lyr, &[field_idx], true)?;
    let reader = open_stream(lyr, false)?;
    let ci = reader.schema().index_of(&name).map_err(gdal_err)?;
    let (mut nums, mut strs) = (Vec::new(), Vec::new());
    for batch in reader {
        let batch = batch.map_err(gdal_err)?;
        let col = batch.column(ci);
        let c = Col::new(col);
        match c {
            Col::Str(_) | Col::LStr(_) => {
                for i in 0..batch.num_rows() {
                    if let Some(Val::Str(s)) = c.get(i) {
                        strs.push(s);
                    }
                }
            }
            Col::Other => return Err(format!("field '{name}' has an unsupported type ({})", col.data_type())),
            _ => nums.extend((0..batch.num_rows()).filter_map(|i| c.num(i))),
        }
    }
    Ok(if strs.is_empty() { ColumnValues::Num(nums) } else { ColumnValues::Str(strs) })
}
