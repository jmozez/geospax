//! Point layers -> Arrow IPC stream with a GeoArrow `geoarrow.point`
//! (interleaved xy) column. The browser hands the Float64 buffer straight to
//! deck.gl as a binary attribute: no JSON, no per-feature JS objects.

use crate::catalog::LayerHandle;
use crate::router::{query_param, ApiResponse};
use crate::{reader, wkb, Engine, GeomKind, ReadMode};
use arrow_array::{Array, FixedSizeListArray, Float64Array, RecordBatch};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema};
use gdal::vector::LayerAccess;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

pub struct ArrowExport {
    pub bytes: Vec<u8>,
    pub rows: usize,
    pub read_ms: f64,
    pub encode_ms: f64,
}

/// Export points (optionally within a lon/lat bbox) as Arrow IPC.
pub fn export_points(layer: &LayerHandle, bbox: Option<[f64; 4]>, limit: usize, mode: ReadMode) -> Result<ArrowExport, String> {
    if layer.info.geometry != GeomKind::Point {
        return Err("arrow export is implemented for point layers only".into());
    }
    let t0 = Instant::now();
    let cap = (layer.info.feature_count as usize).min(limit).min(1 << 26);
    let (mut xs, mut ys): (Vec<f64>, Vec<f64>) = (Vec::with_capacity(cap), Vec::with_capacity(cap));
    let h = layer.checkout()?;
    let res: Result<(), String> = (|| {
        let mut lyr = h.ds.layer_by_name(&layer.layer_name).map_err(|e| e.to_string())?;
        match bbox {
            Some(b) => {
                let r = match &h.from_wgs84 {
                    Some(ct) => ct.0.transform_bounds(&b, 21).map_err(|e| e.to_string())?,
                    None => b,
                };
                lyr.set_spatial_filter_rect(r[0], r[1], r[2], r[3]);
            }
            None => lyr.clear_spatial_filter(),
        }
        reader::set_ignored_fields(&lyr, &[], false)?; // geometry only
        let mut row = |_fid: Option<u64>, wkb_bytes: &[u8], _attrs: Vec<(u32, crate::mvt::Val)>| -> bool {
            if let Ok(wkb::Geom::Points(pts)) = wkb::parse(wkb_bytes) {
                for [x, y] in pts {
                    xs.push(x);
                    ys.push(y);
                }
            }
            xs.len() < limit
        };
        match mode {
            ReadMode::Arrow => reader::for_each_arrow(&mut lyr, &[], &mut row)?,
            ReadMode::Features => reader::for_each_feature(&mut lyr, &[], &mut row)?,
        };
        xs.truncate(limit);
        ys.truncate(limit);
        // one batched PROJ call for the whole layer
        if let Some(ct) = &h.to_wgs84 {
            let mut zs = vec![0.0; xs.len()];
            ct.0.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    let _ = h.ds.layer_by_name(&layer.layer_name).map(|l| reader::set_ignored_fields(&l, layer.tile_field_idx(), false));
    layer.checkin(h);
    res?;
    let mut coords = Vec::with_capacity(xs.len() * 2);
    for (x, y) in xs.into_iter().zip(ys) {
        coords.push(x);
        coords.push(y);
    }
    let read_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let rows = coords.len() / 2;
    let item = Arc::new(Field::new("xy", DataType::Float64, false));
    let values = Arc::new(Float64Array::from(coords)) as Arc<dyn Array>;
    let geometry = FixedSizeListArray::try_new(item.clone(), 2, values, None).map_err(|e| e.to_string())?;
    let meta = HashMap::from([
        ("ARROW:extension:name".to_string(), "geoarrow.point".to_string()),
        ("ARROW:extension:metadata".to_string(), r#"{"crs":"OGC:CRS84","crs_type":"authority_code"}"#.to_string()),
    ]);
    let schema = Arc::new(Schema::new(vec![
        Field::new("geometry", DataType::FixedSizeList(item, 2), false).with_metadata(meta),
    ]));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(geometry)]).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(rows * 16 + 1024);
    {
        let mut w = StreamWriter::try_new(&mut bytes, &schema).map_err(|e| e.to_string())?;
        w.write(&batch).map_err(|e| e.to_string())?;
        w.finish().map_err(|e| e.to_string())?;
    }
    Ok(ArrowExport { bytes, rows, read_ms, encode_ms: t1.elapsed().as_secs_f64() * 1000.0 })
}

impl Engine {
    pub(crate) fn arrow_response(&self, layer_id: &str, query: &str) -> ApiResponse {
        let Some(layer) = self.layer(layer_id) else {
            return ApiResponse { status: 404, content_type: "text/plain", headers: vec![], body: b"unknown layer".to_vec() };
        };
        let bbox = query_param(query, "bbox").and_then(|s| {
            let v: Vec<f64> = s.split(',').filter_map(|p| p.parse().ok()).collect();
            (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
        });
        let limit = query_param(query, "limit").and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
        match export_points(&layer, bbox, limit, self.read_mode) {
            Ok(x) => ApiResponse {
                status: 200,
                content_type: "application/vnd.apache.arrow.stream",
                headers: vec![
                    ("Server-Timing", format!("read;dur={:.2}, enc;dur={:.2}", x.read_ms, x.encode_ms)),
                    ("X-Arrow-Rows", x.rows.to_string()),
                    ("Cache-Control", "no-store".to_string()),
                ],
                body: x.bytes,
            },
            Err(e) => ApiResponse { status: 400, content_type: "text/plain", headers: vec![], body: e.into_bytes() },
        }
    }
}
