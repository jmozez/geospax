//! Your own ONNX model on an image (docs/AI.md §4): `ai.detect` runs an object-detection model
//! (YOLOv5/v8/v11-style outputs) or a segmentation model over a raster in tiles, on this computer,
//! and maps the result: boxes as a polygon layer (class, score, area), segments as a class raster.
//!
//! Models are data, not code: tract (pure Rust) evaluates the graph, nothing in the file is executed.
//! GeoSpaX ships no model; you add one with its licence (`<state>/models/<name>.onnx` and an optional
//! `<name>.json` with `labels`, `licence`, `source`, `task`, `bands`, `scale`, `mean`, `std`), and the
//! licence is written into the methods of every run that uses it.

use std::path::{Path, PathBuf};
use std::time::Instant;

use gdal::spatial_ref::CoordTransform;
use serde_json::{json, Value};
use tract_onnx::prelude::*;
use tract_onnx::tract_hir::infer::Factoid;

use super::features::{FeatureSet, Feat, Val};
use super::raster_steps::{out_path, register};
use super::steps::{p_f64, p_str, sanitize, StepCtx, StepOut};
use crate::catalog::GeomKind;
use crate::raster;
use crate::wkb::Geom;

/// Most tiles one run may infer (a 640 px model: about 26 000 × 26 000 px).
const MAX_TILES: usize = 1600;

pub fn models_dir(state: &Path) -> PathBuf {
    state.join("models")
}

/// What a model file says about itself, plus its sidecar.
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub path: PathBuf,
    pub name: String,
    /// input [n, c, h, w]; None = any size
    pub channels: usize,
    pub size: (Option<usize>, Option<usize>),
    pub labels: Vec<String>,
    pub licence: String,
    pub source: String,
    pub task: String,
    pub side: Value,
}

impl ModelInfo {
    pub fn json(&self) -> Value {
        json!({
            "name": self.name, "path": self.path, "task": self.task, "channels": self.channels,
            "input": [self.size.0, self.size.1], "labels": self.labels, "licence": self.licence, "source": self.source,
        })
    }
}

/// `{0: 'tree', 1: 'house'}` (Ultralytics metadata) or `["tree", "house"]` → labels.
fn parse_names(s: &str) -> Vec<String> {
    if let Ok(v) = serde_json::from_str::<Vec<String>>(s) {
        return v;
    }
    let mut out: Vec<(usize, String)> = Vec::new();
    for part in s.trim().trim_start_matches('{').trim_end_matches('}').split(',') {
        if let Some((k, v)) = part.split_once(':') {
            if let Ok(i) = k.trim().parse::<usize>() {
                out.push((i, v.trim().trim_matches(|c| c == '\'' || c == '"').to_string()));
            }
        }
    }
    out.sort_by_key(|x| x.0);
    out.into_iter().map(|x| x.1).collect()
}

fn load(path: &Path) -> Result<InferenceModel, String> {
    tract_onnx::onnx().model_for_path(path).map_err(|e| format!("{}: not a model GeoSpaX can read ({e})", path.display()))
}

/// Read a model's input shape, labels and sidecar; guess its task from the output shape.
pub fn inspect(path: &Path) -> Result<ModelInfo, String> {
    let m = load(path)?;
    let fact = m.input_fact(0).map_err(|e| e.to_string())?.clone();
    let dims: Vec<Option<usize>> = fact.shape.dims().map(|d| match d.concretize() { Some(TDim::Val(v)) if v > 0 => Some(v as usize), _ => None }).collect();
    if dims.len() != 4 {
        return Err(format!("{}: the input has {} dimensions; GeoSpaX runs image models with an input [1, bands, height, width]", path.display(), dims.len()));
    }
    let channels = dims[1].unwrap_or(3);
    // metadata (Ultralytics writes names, author, license): straight from the protobuf
    let meta: Vec<(String, String)> = tract_onnx::onnx()
        .proto_model_for_path(path)
        .map(|pm| pm.metadata_props.into_iter().map(|e| (e.key, e.value)).collect())
        .unwrap_or_default();
    let prop = |k: &str| meta.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    let side: Value = std::fs::read(path.with_extension("json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    let mut labels: Vec<String> = side["labels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    if labels.is_empty() {
        labels = prop("names").map(|s| parse_names(&s)).unwrap_or_default();
    }
    if labels.is_empty() {
        if let Ok(t) = std::fs::read_to_string(path.with_extension("txt")) {
            labels = t.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
        }
    }
    let licence = side["licence"].as_str().or(side["license"].as_str()).map(String::from).or_else(|| prop("license")).unwrap_or_default();
    let source = side["source"].as_str().map(String::from).or_else(|| prop("author")).unwrap_or_default();
    let (h, w) = (dims[2], dims[3]);
    // the output shape decides the task: [1, C, H, W] with H, W of the input is segmentation
    let task = match side["task"].as_str() {
        Some(t) => t.to_string(),
        None => {
            let (th, tw) = (h.unwrap_or(64), w.unwrap_or(64));
            let shape = output_shape(path, channels, th, tw).unwrap_or_default();
            if shape.len() == 4 && shape[2] == th && shape[3] == tw { "segment".into() } else if shape.len() == 3 { "detect".into() } else { "unknown".into() }
        }
    };
    let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Ok(ModelInfo { path: path.to_path_buf(), name, channels, size: (h, w), labels, licence, source, task, side })
}

fn plan(path: &Path, c: usize, h: usize, w: usize) -> Result<std::sync::Arc<TypedRunnableModel>, String> {
    load(path)?
        .with_input_fact(0, f32::fact([1, c, h, w]).into())
        .and_then(|m| m.into_optimized())
        .and_then(|m| m.into_runnable())
        .map_err(|e| format!("the model cannot run on a {c} × {h} × {w} input: {e}"))
}

fn output_shape(path: &Path, c: usize, h: usize, w: usize) -> Result<Vec<usize>, String> {
    let p = plan(path, c, h, w)?;
    let out = p.run(tvec!(Tensor::zero::<f32>(&[1, c, h, w]).map_err(|e| e.to_string())?.into())).map_err(|e| e.to_string())?;
    Ok(out[0].shape().to_vec())
}

/// Every model in `<state>/models`.
pub fn list(state: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(models_dir(state)) {
        let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("onnx"))).collect();
        paths.sort();
        for p in paths {
            match inspect(&p) {
                Ok(i) => out.push(i.json()),
                Err(e) => out.push(json!({ "name": p.file_stem().map(|s| s.to_string_lossy().to_string()), "path": p, "error": e })),
            }
        }
    }
    out
}

/// Save an uploaded model (and its sidecar fields) into `<state>/models`.
pub fn save(state: &Path, name: &str, body: &[u8]) -> Result<Value, String> {
    let clean = crate::upload::clean_name(name).ok_or("the model needs a file name")?;
    if !clean.to_lowercase().ends_with(".onnx") {
        return Err("a model is an .onnx file (export it from PyTorch, Ultralytics, TensorFlow or Keras with their ONNX exporter)".into());
    }
    let dir = models_dir(state);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&clean);
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    match inspect(&tmp) {
        Ok(_) => {
            std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            Ok(inspect(&path)?.json())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Labels, licence, source, task and input options for a model (its `.json` sidecar).
pub fn describe(state: &Path, name: &str, body: &Value) -> Result<Value, String> {
    let path = models_dir(state).join(format!("{}.onnx", sanitize(name)));
    if !path.is_file() {
        return Err(format!("there is no model '{name}'"));
    }
    let side_path = path.with_extension("json");
    let mut side: Value = std::fs::read(&side_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    for k in ["labels", "licence", "source", "task", "bands", "scale", "mean", "std"] {
        if let Some(v) = body.get(k) {
            side[k] = v.clone();
        }
    }
    std::fs::write(&side_path, serde_json::to_vec_pretty(&side).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(inspect(&path)?.json())
}

pub fn remove(state: &Path, name: &str) -> Result<(), String> {
    let path = models_dir(state).join(format!("{}.onnx", sanitize(name)));
    std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let _ = std::fs::remove_file(path.with_extension("json"));
    Ok(())
}

// ------------------------------------------------------------------ inference

/// One box in raster pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct Det {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub score: f32,
    pub class: usize,
}

fn iou(a: &Det, b: &Det) -> f64 {
    let ix = (a.x1.min(b.x1) - a.x0.max(b.x0)).max(0.0);
    let iy = (a.y1.min(b.y1) - a.y0.max(b.y0)).max(0.0);
    let inter = ix * iy;
    let union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
    if union > 0.0 { inter / union } else { 0.0 }
}

/// Greedy non-maximum suppression per class.
pub fn nms(mut d: Vec<Det>, thr: f64) -> Vec<Det> {
    d.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<Det> = Vec::new();
    for x in d {
        if !keep.iter().any(|k| k.class == x.class && iou(k, &x) > thr) {
            keep.push(x);
        }
    }
    keep
}

/// Boxes from a YOLO-style output, in input pixels. Layouts: v8/v11 `[1, 4+nc, N]`, v5 `[1, N, 5+nc]`
/// (objectness × class score), or `[1, N, 6]` boxes already decided (x0, y0, x1, y1, score, class).
pub fn decode(shape: &[usize], data: &[f32], format: &str, thr: f32, nc: Option<usize>) -> Result<Vec<Det>, String> {
    if shape.len() != 3 || shape[0] != 1 {
        return Err(format!("a detection model's output should be [1, …, …], not {shape:?}"));
    }
    let (a, b) = (shape[1], shape[2]);
    let fmt = match format {
        // with the number of classes known the shape decides: v8 has 4 + nc rows, v5 5 + nc columns;
        // otherwise the longer side holds the boxes (8400 or 25200 for a 640 px model)
        "auto" | "" => match nc {
            Some(n) if a == 4 + n && b != 5 + n => "yolov8",
            Some(n) if b == 5 + n && a != 4 + n => "yolov5",
            _ if a < b => "yolov8",
            _ => "yolov5",
        },
        f => f,
    };
    let mut out = Vec::new();
    let mut push = |cx: f32, cy: f32, w: f32, h: f32, score: f32, class: usize| {
        if score >= thr && w > 0.0 && h > 0.0 {
            out.push(Det { x0: (cx - w / 2.0) as f64, y0: (cy - h / 2.0) as f64, x1: (cx + w / 2.0) as f64, y1: (cy + h / 2.0) as f64, score, class });
        }
    };
    match fmt {
        "yolov8" => {
            if a < 5 {
                return Err(format!("a YOLOv8 output needs 4 box rows and at least one class, not {shape:?}"));
            }
            let at = |r: usize, i: usize| data[r * b + i];
            for i in 0..b {
                let (c, s) = (4..a).map(|r| (r - 4, at(r, i))).fold((0, f32::MIN), |m, x| if x.1 > m.1 { x } else { m });
                push(at(0, i), at(1, i), at(2, i), at(3, i), s, c);
            }
        }
        "yolov5" => {
            if b < 6 {
                return Err(format!("a YOLOv5 output needs box, objectness and classes, not {shape:?}"));
            }
            for i in 0..a {
                let row = &data[i * b..(i + 1) * b];
                let (c, s) = (5..b).map(|k| (k - 5, row[k])).fold((0, f32::MIN), |m, x| if x.1 > m.1 { x } else { m });
                push(row[0], row[1], row[2], row[3], row[4] * s, c);
            }
        }
        "boxes" => {
            for i in 0..a {
                let r = &data[i * b..(i + 1) * b];
                if b >= 6 && r[4] >= thr {
                    out.push(Det { x0: r[0] as f64, y0: r[1] as f64, x1: r[2] as f64, y1: r[3] as f64, score: r[4], class: r[5].max(0.0) as usize });
                }
            }
        }
        other => return Err(format!("unknown detection format '{other}' (auto, yolov8, yolov5 or boxes)")),
    }
    Ok(out)
}

struct Prep {
    bands: Vec<usize>,
    scale: f32,
    mean: Vec<f32>,
    std: Vec<f32>,
}

fn read_tile(ds: &gdal::Dataset, prep: &Prep, x: usize, y: usize, tw: usize, th: usize, w: usize, h: usize) -> Result<(Tensor, bool), String> {
    let c = prep.bands.len();
    let mut buf = vec![0f32; c * th * tw];
    let (rw, rh) = ((w - x).min(tw), (h - y).min(th));
    let mut any = false;
    for (k, &b) in prep.bands.iter().enumerate() {
        let band = ds.rasterband(b).map_err(|e| e.to_string())?;
        let nd = band.no_data_value();
        let v = band.read_as::<f32>((x as isize, y as isize), (rw, rh), (rw, rh), None).map_err(|e| e.to_string())?.into_shape_and_vec().1;
        for r in 0..rh {
            for cc in 0..rw {
                let raw = v[r * rw + cc];
                if nd.is_some_and(|n| (raw as f64 - n).abs() < 1e-9) {
                    continue;
                }
                any |= raw != 0.0;
                let m = prep.mean.get(k).copied().unwrap_or(0.0);
                let s = prep.std.get(k).copied().unwrap_or(1.0);
                buf[k * th * tw + r * tw + cc] = (raw / prep.scale - m) / s;
            }
        }
    }
    let t = tract_ndarray::Array4::from_shape_vec((1, c, th, tw), buf).map_err(|e| e.to_string())?.into_tensor();
    Ok((t, any))
}

pub(super) fn detect(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let model_arg = p_str(p, "model").ok_or("ai.detect needs model: a model name in Models (Imagery › Models…) or an .onnx path")?;
    let mpath = {
        let in_dir = models_dir(&sc.engine.state_dir).join(format!("{}.onnx", sanitize(model_arg.trim_end_matches(".onnx"))));
        if in_dir.is_file() { in_dir } else { sc.resolve_path(model_arg).ok_or_else(|| format!("no model '{model_arg}' (add it in Imagery › Models…)"))? }
    };
    let info = inspect(&mpath)?;
    let rid = p_str(p, "raster").ok_or("ai.detect needs raster: the image to look at")?;
    let r = sc.engine.raster(rid).ok_or_else(|| format!("no raster '{rid}'"))?;
    let ds = raster::open(&r.info.path)?;
    let (w, h) = ds.raster_size();
    let task = p_str(p, "task").unwrap_or(&info.task).to_string();
    // bands and scaling: step, then the model's sidecar, then the image's type
    let bands: Vec<usize> = p.get("bands").or(info.side.get("bands")).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_u64().map(|b| b as usize)).collect()).unwrap_or_else(|| (1..=info.channels).collect());
    if bands.len() != info.channels {
        return Err(format!("the model takes {} bands; give bands: with {} band numbers", info.channels, info.channels));
    }
    if let Some(b) = bands.iter().find(|&&b| b == 0 || b > ds.raster_count()) {
        return Err(format!("the image has {} bands; band {b} does not exist", ds.raster_count()));
    }
    let dtype = ds.rasterband(1).map(|b| b.band_type().name()).unwrap_or_default();
    let scale = p_f64(p, "scale").or(info.side["scale"].as_f64()).unwrap_or(match dtype.as_str() { "Byte" => 255.0, "UInt16" => 10000.0, _ => 1.0 }) as f32;
    let floats = |k: &str| p.get(k).or(info.side.get(k)).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_f64().map(|v| v as f32)).collect()).unwrap_or_default();
    let prep = Prep { bands, scale, mean: floats("mean"), std: floats("std") };
    let tile = p_f64(p, "tile").map(|t| t as usize).unwrap_or(512);
    let (th, tw) = (info.size.0.unwrap_or(tile.min(h.max(32))), info.size.1.unwrap_or(tile.min(w.max(32))));
    let overlap = if task == "detect" { p_f64(p, "overlap").map(|o| o as usize).unwrap_or(tw / 8) } else { 0 };
    let step_x = tw.saturating_sub(overlap).max(1);
    let step_y = th.saturating_sub(overlap).max(1);
    let xs: Vec<usize> = (0..).map(|i| i * step_x).take_while(|&x| x < w).collect();
    let ys: Vec<usize> = (0..).map(|i| i * step_y).take_while(|&y| y < h).collect();
    if xs.len() * ys.len() > MAX_TILES {
        return Err(format!("{} × {} px is {} tiles of {tw} × {th}; at most {MAX_TILES} (clip the image first)", w, h, xs.len() * ys.len()));
    }
    let runner = plan(&mpath, info.channels, th, tw)?;
    let thr = p_f64(p, "threshold").unwrap_or(0.25) as f32;
    let label = |c: usize| info.labels.get(c).cloned().unwrap_or_else(|| format!("class {c}"));
    let gt = ds.geo_transform().map_err(|e| e.to_string())?;
    let licence_note = if info.licence.is_empty() { "licence not stated: check it before you share the results".to_string() } else { format!("licence: {}", info.licence) };
    let mut tiles = 0usize;
    let name = sanitize(p_str(p, "name").unwrap_or(if task == "segment" { "segments" } else { "detections" }));

    if task == "segment" {
        let mut classes = vec![0u8; w * h];
        let mut nclass = 1usize;
        for &y in &ys {
            for &x in &xs {
                let (t, any) = read_tile(&ds, &prep, x, y, tw, th, w, h)?;
                if !any {
                    continue;
                }
                tiles += 1;
                let out = runner.run(tvec!(t.into())).map_err(|e| format!("the model failed on a tile: {e}"))?;
                let o = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
                let sh = o.shape().to_vec();
                let (c, oh, ow) = match sh.len() {
                    4 => (sh[1], sh[2], sh[3]),
                    3 => (1, sh[1], sh[2]),
                    _ => return Err(format!("a segmentation model's output should be [1, classes, h, w], not {sh:?}")),
                };
                if (oh, ow) != (th, tw) {
                    return Err(format!("the output is {oh} × {ow} but the tile is {th} × {tw}; GeoSpaX maps outputs the size of the input"));
                }
                let flat: Vec<f32> = o.iter().copied().collect();
                nclass = nclass.max(if c == 1 { 2 } else { c });
                for r in 0..th.min(h - y) {
                    for cc in 0..tw.min(w - x) {
                        let i = r * tw + cc;
                        let k = if c == 1 {
                            let v = flat[i];
                            let pr = if (0.0..=1.0).contains(&v) { v } else { 1.0 / (1.0 + (-v).exp()) };
                            (pr >= 0.5) as usize
                        } else {
                            (0..c).max_by(|&a, &b| flat[a * th * tw + i].total_cmp(&flat[b * th * tw + i])).unwrap_or(0)
                        };
                        classes[(y + r) * w + x + cc] = (k + 1).min(255) as u8;
                    }
                }
            }
        }
        let out = out_path(sc, &name)?;
        let drv = gdal::DriverManager::get_driver_by_name("GTiff").map_err(|e| e.to_string())?;
        {
            let opts = gdal::raster::RasterCreationOptions::from_iter(["COMPRESS=DEFLATE", "TILED=YES"]);
            let mut o = drv.create_with_band_type_with_options::<u8, _>(&out, w, h, 1, &opts).map_err(|e| e.to_string())?;
            o.set_geo_transform(&gt).map_err(|e| e.to_string())?;
            if let Some(s) = raster::srs_of(&ds) {
                o.set_spatial_ref(&s).map_err(|e| e.to_string())?;
            }
            let mut band = o.rasterband(1).map_err(|e| e.to_string())?;
            band.set_no_data_value(Some(0.0)).map_err(|e| e.to_string())?;
            let mut buf = gdal::raster::Buffer::new((w, h), classes.clone());
            band.write((0, 0), (w, h), &mut buf).map_err(|e| e.to_string())?;
        }
        let mut count = vec![0usize; nclass];
        for &v in classes.iter().filter(|v| **v > 0) {
            if let Some(c) = count.get_mut(v as usize - 1) {
                *c += 1;
            }
        }
        let total = count.iter().sum::<usize>().max(1);
        let pal = crate::automation::automap::ramp_colors("tableau", nclass);
        let cls: Vec<Value> = (0..nclass).map(|k| json!({ "value": k + 1, "label": format!("{} ({:.1} %)", label(k), count[k] as f64 / total as f64 * 100.0), "color": pal[k % pal.len()] })).collect();
        let hreg = register(sc, &out, &name, json!({ "kind": "classes", "title": p_str(p, "title").unwrap_or(&format!("{} segments", info.name)), "classes": cls,
            "description": format!("Segmentation by the model {} ({licence_note}).", info.name), "credit": if info.licence.is_empty() { format!("model {}", info.name) } else { format!("model {} ({})", info.name, info.licence) } }))?;
        sc.methods.push(format!(
            "Segmentation: the ONNX model {} ({licence_note}{}) was run on {} tiles of {tw} × {th} px of {} (bands {:?}, values ÷ {scale}), on this computer; each pixel took the class with the highest output.",
            info.name, if info.source.is_empty() { String::new() } else { format!("; source: {}", info.source) }, tiles, r.info.title, prep.bands
        ));
        return Ok(StepOut {
            outputs: json!({ "raster": hreg.info.id, "path": out, "classes": (0..nclass).map(label).collect::<Vec<_>>(), "counts": count, "tiles": tiles, "seconds": t0.elapsed().as_secs_f64() }),
            why: vec![format!("{} tiles of {tw} × {th} px through {}", tiles, info.name), licence_note],
        });
    }

    // detection
    let mut dets: Vec<Det> = Vec::new();
    let format = p_str(p, "format").unwrap_or("auto").to_string();
    for &y in &ys {
        for &x in &xs {
            let (t, any) = read_tile(&ds, &prep, x, y, tw, th, w, h)?;
            if !any {
                continue;
            }
            tiles += 1;
            let out = runner.run(tvec!(t.into())).map_err(|e| format!("the model failed on a tile: {e}"))?;
            let o = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
            let shape = o.shape().to_vec();
            let flat: Vec<f32> = o.iter().copied().collect();
            for mut d in decode(&shape, &flat, &format, thr, (!info.labels.is_empty()).then_some(info.labels.len()))? {
                // keep boxes inside the image part of edge tiles
                d.x0 = (d.x0 + x as f64).max(0.0);
                d.x1 = (d.x1 + x as f64).min(w as f64);
                d.y0 = (d.y0 + y as f64).max(0.0);
                d.y1 = (d.y1 + y as f64).min(h as f64);
                if d.x1 > d.x0 && d.y1 > d.y0 {
                    dets.push(d);
                }
            }
        }
    }
    let raw = dets.len();
    let dets = nms(dets, p_f64(p, "iou").unwrap_or(0.45));
    let srs = raster::srs_of(&ds).ok_or("the image has no coordinate system")?;
    let ct = CoordTransform::new(&srs, &raster::wgs84()).map_err(|e| e.to_string())?;
    let px_area = (gt[1] * gt[5]).abs();
    let mut fs = FeatureSet::new(GeomKind::Polygon, vec![("class".into(), "string"), ("class_id".into(), "integer"), ("score".into(), "real"), ("area_m2".into(), "real")]);
    for d in &dets {
        let corners = [(d.x0, d.y0), (d.x1, d.y0), (d.x1, d.y1), (d.x0, d.y1), (d.x0, d.y0)];
        let mut xs: Vec<f64> = corners.iter().map(|(c, r)| gt[0] + c * gt[1] + r * gt[2]).collect();
        let mut ys: Vec<f64> = corners.iter().map(|(c, r)| gt[3] + c * gt[4] + r * gt[5]).collect();
        let mut zs = vec![0.0; 5];
        ct.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
        let ring: Vec<[f64; 2]> = xs.iter().zip(&ys).map(|(a, b)| [*a, *b]).collect();
        // area in the image's own units (metres for projected images)
        let area = if srs.is_projected() { (d.x1 - d.x0) * (d.y1 - d.y0) * px_area } else { f64::NAN };
        fs.feats.push(Feat {
            geom: Geom::Polygons(vec![vec![ring]]),
            props: vec![Val::Str(label(d.class)), Val::Int(d.class as i64), Val::Num((d.score as f64 * 1000.0).round() / 1000.0), if area.is_finite() { Val::Num(area.round()) } else { Val::Null }],
        });
    }
    fs.total = fs.feats.len() as u64;
    let title = p_str(p, "title").map(String::from).unwrap_or_else(|| format!("{} detections", info.name));
    let id = sc.write_output(&name, &fs, title)?;
    let mut by_class: Vec<(String, usize)> = Vec::new();
    for d in &dets {
        let l = label(d.class);
        match by_class.iter_mut().find(|x| x.0 == l) {
            Some(x) => x.1 += 1,
            None => by_class.push((l, 1)),
        }
    }
    by_class.sort_by(|a, b| b.1.cmp(&a.1));
    sc.cards.push(("Detected".into(), format!("{}", dets.len())));
    sc.methods.push(format!(
        "Object detection: the ONNX model {} ({licence_note}{}) was run on {} tiles of {tw} × {th} px (overlap {overlap} px) of {} (bands {:?}, values ÷ {scale}), on this computer. Boxes scoring ≥ {thr} were kept and overlapping boxes of a class merged (non-maximum suppression, IoU {}): {} of {raw}.",
        info.name, if info.source.is_empty() { String::new() } else { format!("; source: {}", info.source) }, tiles, r.info.title, prep.bands, p_f64(p, "iou").unwrap_or(0.45), dets.len()
    ));
    Ok(StepOut {
        outputs: json!({ "layer": id, "count": dets.len(), "raw": raw, "by_class": by_class, "tiles": tiles, "seconds": t0.elapsed().as_secs_f64() }),
        why: vec![
            format!("{} tiles of {tw} × {th} px through {} ({})", tiles, info.name, info.task),
            format!("{raw} boxes ≥ {thr}, {} after merging overlaps: {}", dets.len(), by_class.iter().map(|(l, n)| format!("{n} {l}")).collect::<Vec<_>>().join(", ")),
            licence_note,
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_metadata() {
        assert_eq!(parse_names("{0: 'tree', 1: 'house'}"), vec!["tree", "house"]);
        assert_eq!(parse_names(r#"["a","b"]"#), vec!["a", "b"]);
    }

    #[test]
    fn nms_keeps_the_best_of_overlapping_boxes() {
        let d = |x: f64, s: f32, c: usize| Det { x0: x, y0: 0.0, x1: x + 10.0, y1: 10.0, score: s, class: c };
        let k = nms(vec![d(0.0, 0.8, 0), d(1.0, 0.9, 0), d(1.0, 0.7, 1), d(50.0, 0.5, 0)], 0.45);
        assert_eq!(k.len(), 3);
        assert_eq!(k[0].score, 0.9);
    }

    #[test]
    fn yolo_layouts() {
        // v8: [1, 4+2, 2]: columns are boxes
        let v8 = [10.0, 30.0, /*cy*/ 10.0, 30.0, /*w*/ 4.0, 4.0, /*h*/ 4.0, 4.0, /*c0*/ 0.9, 0.1, /*c1*/ 0.05, 0.6];
        let d = decode(&[1, 6, 2], &v8, "auto", 0.25, Some(2)).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].class, d[1].class), (0, 1));
        assert_eq!((d[0].x0, d[0].y1), (8.0, 12.0));
        // v5: [1, 2, 5+2]: rows are boxes, score = objectness × class
        let v5 = [10.0, 10.0, 4.0, 4.0, 0.5, 0.9, 0.1, 30.0, 30.0, 4.0, 4.0, 0.2, 0.1, 0.9];
        let d = decode(&[1, 2, 7], &v5, "auto", 0.25, Some(2)).unwrap();
        // without labels, the longer side holds the boxes
        assert_eq!(decode(&[1, 6, 8400], &vec![0.0; 6 * 8400], "auto", 0.25, None).unwrap().len(), 0);
        assert_eq!(d.len(), 1);
        assert!((d[0].score - 0.45).abs() < 1e-6);
    }
}
