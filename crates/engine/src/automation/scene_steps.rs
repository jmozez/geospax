//! 3D scene step (docs/AUTOMATION.md §6d): `scene.3d` turns a DEM, plus the buildings, trees and
//! point-cloud sample a run made, into a glTF model, a self-contained interactive viewer and a
//! rendered 3D view for the report (the geometry and rendering are in crate::scene3d).

use std::sync::Arc;
use std::time::Instant;

use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use serde_json::{json, Value};

use super::cartography;
use super::features;
use super::raster_steps::{fmt0, pick_raster};
use super::report::View3d;
use super::steps::{p_f64, p_list, p_str, sanitize, StepCtx, StepOut};
use crate::catalog::{GeomKind, LayerHandle};
use crate::lidar::{self, SamplePoint};
use crate::raster::{self, RasterHandle, NODATA};
use crate::scene3d::{self, Dem, Footprint, PointIn, Scene, Texture, TreeIn, View};
use crate::wkb::Geom;

/// Largest DEM side read (finer DEMs are averaged down while reading).
const MAX_READ: usize = 4096;

struct DemIn {
    dem: Dem,
    srs: SpatialRef,
    wkt: String,
    epsg: Option<u32>,
    note: String,
}

/// The DEM as a north-up grid in metres (geographic, rotated or feet-based DEMs are warped to UTM).
fn read_dem(h: &RasterHandle) -> Result<DemIn, String> {
    let src = raster::open(&h.info.path)?;
    let gt0 = src.geo_transform().map_err(|e| format!("{}: no georeferencing ({e})", h.info.title))?;
    let metric = raster::srs_of(&src).is_some_and(|s| s.is_projected() && (s.linear_units() - 1.0).abs() < 1e-9);
    let rotated = gt0[2] != 0.0 || gt0[4] != 0.0 || gt0[5] > 0.0;
    let (ds, note) = if !metric || rotated {
        let b = h.info.bounds;
        let epsg = features::utm_epsg((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
        let px = h.info.pixel_m.max(0.1);
        let mut a = raster::strings(&["-of", "MEM", "-r", "bilinear", "-dstnodata", "-9999"]);
        a.extend(["-t_srs".into(), format!("EPSG:{epsg}"), "-tr".into(), px.to_string(), px.to_string()]);
        (raster::warp(&[&src], "", &a)?, format!(" (warped to UTM, EPSG:{epsg}, so distances and heights are in metres)"))
    } else {
        (src, String::new())
    };
    let gt = ds.geo_transform().map_err(|e| e.to_string())?;
    let (w, hh) = ds.raster_size();
    let scale = (w.max(hh) as f64 / MAX_READ as f64).max(1.0);
    let (bw, bh) = (((w as f64 / scale).round() as usize).max(2), ((hh as f64 / scale).round() as usize).max(2));
    let band = ds.rasterband(1).map_err(|e| e.to_string())?;
    let nd = band.no_data_value().or(h.info.nodata);
    let buf = band.read_as::<f32>((0, 0), (w, hh), (bw, bh), Some(gdal::raster::ResampleAlg::Average)).map_err(|e| e.to_string())?;
    let (_, vals) = buf.into_shape_and_vec();
    let z: Vec<f32> = vals
        .into_iter()
        .map(|v| if !v.is_finite() || v <= -1e20 || v as f64 == NODATA || nd.is_some_and(|n| (v as f64 - n).abs() <= 1e-6 * n.abs().max(1.0)) { f32::NAN } else { v })
        .collect();
    let gt2 = [gt[0], gt[1] * w as f64 / bw as f64, 0.0, gt[3], 0.0, gt[5] * hh as f64 / bh as f64];
    let mut srs = ds.spatial_ref().map_err(|e| format!("{}: no coordinate system ({e})", h.info.title))?;
    srs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let wkt = srs.to_wkt().map_err(|e| e.to_string())?;
    let epsg = srs.auth_code().ok().map(|c| c as u32);
    Ok(DemIn { dem: Dem { z, w: bw, h: bh, gt: gt2 }, srs, wkt, epsg, note })
}

/// Texture size: about the DEM's own pixels (doubled for coarse DEMs, for smoother shading), each
/// side the nearest power of two from 256 to 2048 so every viewer can mipmap it.
fn texture_size(w: usize, h: usize) -> (usize, usize) {
    let f = if w.max(h) < 1024 { 2.0 } else { 1.0 };
    // rounded with a 25 % lean upwards: a 700 px DEM gets 1024, not 512
    let pot = |n: usize| 2f64.powf((n as f64 * f * 1.25).max(1.0).log2().round()).clamp(256.0, 2048.0) as usize;
    (pot(w), pot(h))
}

fn hex(c: &str) -> [u8; 3] {
    raster::hex_rgb(c)
}

/// Vector layers painted onto the terrain texture (contours, boundaries, tracks), in their map colours.
fn overlay(sc: &StepCtx, ids: &[String], d: &DemIn, tw: usize, th: usize, rgb: &mut [u8]) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let ext = d.dem.extent();
    let ct = CoordTransform::new(&raster::wgs84(), &d.srs).map_err(|e| e.to_string())?;
    let lw = (tw.max(th) as f64 / 850.0).max(1.0);
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{tw}\" height=\"{th}\">");
    let mut names = Vec::new();
    let px_path = |line: &[[f64; 2]], close: bool, out: &mut String| -> Result<(), String> {
        let mut xs: Vec<f64> = line.iter().map(|c| c[0]).collect();
        let mut ys: Vec<f64> = line.iter().map(|c| c[1]).collect();
        let mut zs = vec![0.0; xs.len()];
        ct.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
        for i in 0..xs.len() {
            let x = (xs[i] - ext[0]) / (ext[2] - ext[0]) * tw as f64;
            let y = (ext[3] - ys[i]) / (ext[3] - ext[1]) * th as f64;
            out.push_str(&format!("{}{:.1} {:.1}", if i == 0 { "M" } else { "L" }, x, y));
        }
        if close {
            out.push('Z');
        }
        Ok(())
    };
    for id in ids {
        let l = sc.layer(id)?;
        let fs = features::read_layer(sc.engine, &l, None, None, 300_000)?;
        let style = sc.styles.get(id).map(|(s, _, _)| s.clone()).unwrap_or(Value::Null);
        let default = match l.info.geometry {
            GeomKind::Line => "#7a5230",
            GeomKind::Polygon => "#c0392b",
            _ => "#1f6fb2",
        };
        let mut color = style["symbology"]["color"].as_str().unwrap_or(default).to_string();
        // white points (the 2D rule for points over a thematic layer) read as snow on terrain
        let [r, g, b] = hex(&color);
        if l.info.geometry == GeomKind::Point && 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64 > 215.0 {
            color = "#c0392b".into();
        }
        let ix = fs.field("index");
        let (mut thin, mut bold, mut polys) = (String::new(), String::new(), String::new());
        let mut dots = String::new();
        for f in &fs.feats {
            match &f.geom {
                Geom::Lines(ls) => {
                    let target = if ix.is_some_and(|k| f.props[k].as_f64() == Some(1.0)) { &mut bold } else { &mut thin };
                    for line in ls.iter().filter(|l| l.len() >= 2) {
                        px_path(line, false, target)?;
                    }
                }
                Geom::Polygons(ps) => {
                    for poly in ps {
                        for ring in poly.iter().filter(|r| r.len() >= 3) {
                            px_path(ring, true, &mut polys)?;
                        }
                    }
                }
                Geom::Points(pts) => {
                    for c in pts {
                        let (mut xs, mut ys, mut zs) = (vec![c[0]], vec![c[1]], vec![0.0]);
                        ct.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
                        let x = (xs[0] - ext[0]) / (ext[2] - ext[0]) * tw as f64;
                        let y = (ext[3] - ys[0]) / (ext[3] - ext[1]) * th as f64;
                        dots.push_str(&format!("<circle cx=\"{x:.1}\" cy=\"{y:.1}\" r=\"{:.1}\"/>", lw * 2.2));
                    }
                }
                Geom::Empty => {}
            }
        }
        for (dd, w) in [(&thin, lw), (&bold, lw * 2.2)] {
            if !dd.is_empty() {
                svg.push_str(&format!("<path d=\"{dd}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{w:.2}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-opacity=\"0.9\"/>"));
            }
        }
        if !polys.is_empty() {
            svg.push_str(&format!("<path d=\"{polys}\" fill=\"{color}\" fill-opacity=\"0.12\" fill-rule=\"evenodd\" stroke=\"{color}\" stroke-width=\"{:.2}\" stroke-linejoin=\"round\"/>", lw * 1.8));
        }
        if !dots.is_empty() {
            svg.push_str(&format!("<g fill=\"{color}\" stroke=\"#ffffff\" stroke-width=\"{:.2}\">{dots}</g>", lw * 0.8));
        }
        names.push(sc.title_of(&l));
    }
    svg.push_str("</svg>");
    let tree = resvg::usvg::Tree::from_str(&svg, &resvg::usvg::Options::default()).map_err(|e| format!("overlay: {e}"))?;
    let mut pm = resvg::tiny_skia::Pixmap::new(tw as u32, th as u32).ok_or("overlay: bad size")?;
    resvg::render(&tree, resvg::tiny_skia::Transform::identity(), &mut pm.as_mut());
    for (i, px) in pm.data().chunks_exact(4).enumerate() {
        let a = px[3] as f32 / 255.0;
        if a > 0.0 {
            for k in 0..3 {
                rgb[i * 3 + k] = (px[k] as f32 + rgb[i * 3 + k] as f32 * (1.0 - a)).round().min(255.0) as u8;
            }
        }
    }
    Ok(names)
}

/// The draped image: the DEM in its own colours (or imagery), overlays, then relief shading from
/// the same sun as the baked lighting of buildings and trees.
fn drape_texture(sc: &mut StepCtx, p: &Value, demh: &RasterHandle, d: &DemIn, k: f64) -> Result<(Texture, Vec<String>), String> {
    let (tw, th) = texture_size(d.dem.w, d.dem.h);
    let zt = d.dem.resample(tw, th);
    let mut notes = Vec::new();
    let base = raster::colorize(&demh.style(), std::slice::from_ref(&zt), None, Some(NODATA));
    let mut rgb = vec![0u8; tw * th * 3];
    for i in 0..tw * th {
        let a = base[i * 4 + 3];
        for c in 0..3 {
            rgb[i * 3 + c] = if a > 0 { base[i * 4 + c] } else { 214 };
        }
    }
    // drapes: explicit rasters, or (auto) the newest imagery this run fetched
    let mut drapes: Vec<Arc<RasterHandle>> = Vec::new();
    match p.get("drape") {
        Some(Value::String(s)) if s == "none" => {}
        Some(v) if !(v.is_string() && v.as_str() == Some("auto")) && !v.is_null() => {
            for id in p_list(p, "drape") {
                drapes.push(pick_raster(sc, Some(&json!(id)), &[], &[])?);
            }
        }
        _ => {
            if let Some(r) = sc.rasters.iter().rev().filter_map(|id| sc.engine.raster(id)).find(|r| r.info.kind == "rgb") {
                drapes.push(r);
            }
        }
    }
    let ext = d.dem.extent();
    let mut imagery = false;
    for r in &drapes {
        if r.info.kind == "hillshade" {
            continue;
        }
        let src = raster::open(&r.info.path)?;
        let mut a = raster::strings(&["-of", "MEM", "-r", "bilinear"]);
        a.extend(["-t_srs".into(), d.wkt.clone(), "-te".into(), ext[0].to_string(), ext[1].to_string(), ext[2].to_string(), ext[3].to_string(), "-ts".into(), tw.to_string(), th.to_string()]);
        let ds = raster::warp(&[&src], "", &a)?;
        let nb = ds.raster_count().min(3);
        let mut bands = Vec::new();
        for b in 1..=nb {
            bands.push(raster::read_full(&ds, b)?.0);
        }
        let style = r.style();
        let over = raster::colorize(&style, &bands, None, r.info.nodata);
        let op = style["opacity"].as_f64().unwrap_or(1.0).clamp(0.0, 1.0) as f32;
        let mut covered = 0usize;
        for i in 0..tw * th {
            if over[i * 4 + 3] > 0 {
                covered += 1;
                for c in 0..3 {
                    rgb[i * 3 + c] = (over[i * 4 + c] as f32 * op + rgb[i * 3 + c] as f32 * (1.0 - op)).round() as u8;
                }
            }
        }
        imagery |= r.info.kind == "rgb";
        notes.push(format!("{} draped ({:.0} % of the terrain)", r.info.title, covered as f64 / (tw * th) as f64 * 100.0));
    }
    let painted = overlay(sc, &p_list(p, "overlay"), d, tw, th, &mut rgb)?;
    if !painted.is_empty() {
        notes.push(format!("painted on the terrain: {}", painted.join(", ")));
    }
    // relief shading (stronger for gentle relief, softer under imagery)
    let (lo, hi) = d.dem.range().unwrap_or((0.0, 1.0));
    let zf = k * if (hi - lo) < 60.0 { 2.0 } else { 1.0 };
    let hs = scene3d::hillshade(&zt, tw, th, (ext[2] - ext[0]) / tw as f64, (ext[3] - ext[1]) / th as f64, zf, 315.0, 45.0);
    for i in 0..tw * th {
        let f = scene3d::shade_factor(hs[i]);
        let f = if imagery { 0.45 + 0.55 * f } else { f };
        for c in 0..3 {
            rgb[i * 3 + c] = (rgb[i * 3 + c] as f32 * f).round().min(255.0) as u8;
        }
    }
    Ok((Texture { w: tw, h: th, rgb }, notes))
}

/// A run layer whose id or name mentions `word` and has the wanted geometry (newest first).
fn auto_layer(sc: &StepCtx, word: &str, kind: GeomKind) -> Option<Arc<LayerHandle>> {
    sc.touched.iter().rev().filter_map(|id| sc.engine.layer(id)).find(|l| l.info.geometry == kind && (l.info.id.to_ascii_lowercase().contains(word) || l.info.name.to_ascii_lowercase().contains(word)))
}

fn layer_param(sc: &StepCtx, p: &Value, key: &str, word: &str, kind: GeomKind) -> Result<Option<Arc<LayerHandle>>, String> {
    match p_str(p, key) {
        Some("none") | Some("false") => Ok(None),
        None | Some("auto") => Ok(auto_layer(sc, word, kind)),
        Some(id) => Ok(Some(sc.layer(id)?)),
    }
}

fn to_crs(ct: &CoordTransform, ring: &[[f64; 2]]) -> Result<Vec<[f64; 2]>, String> {
    let mut xs: Vec<f64> = ring.iter().map(|c| c[0]).collect();
    let mut ys: Vec<f64> = ring.iter().map(|c| c[1]).collect();
    let mut zs = vec![0.0; xs.len()];
    ct.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
    Ok(xs.into_iter().zip(ys).map(|(x, y)| [x, y]).collect())
}

/// Building footprints and heights (field, number, or auto: height_m / height / levels × 3 m).
fn footprints(sc: &StepCtx, l: &LayerHandle, p: &Value, ct: &CoordTransform) -> Result<(Vec<Footprint>, String), String> {
    let fs = features::read_layer(sc.engine, l, None, None, 200_000)?;
    let fixed = p_f64(p, "height").filter(|_| p.get("height").is_some_and(|v| v.is_number() || v.as_str().is_some_and(|s| s.trim().parse::<f64>().is_ok())));
    let named = p_str(p, "height").filter(|s| *s != "auto" && fixed.is_none());
    let field = |names: &[&str]| names.iter().find_map(|n| fs.field(n).map(|i| (i, n.to_string())));
    let (hfield, levels) = match named {
        Some(n) => (Some((fs.field(n).ok_or_else(|| format!("height: '{n}' is not a field of {}", l.info.id))?, n.to_string())), None),
        None => (field(&["height_m", "height", "hgt", "building_height", "bldg_hgt", "relh"]), field(&["building:levels", "building_levels", "levels", "storeys", "floors"])),
    };
    let mut out = Vec::new();
    for f in &fs.feats {
        let Geom::Polygons(ps) = &f.geom else { continue };
        let h = fixed
            .or_else(|| hfield.as_ref().and_then(|(i, _)| f.props[*i].as_f64()).filter(|v| *v > 0.0))
            .or_else(|| levels.as_ref().and_then(|(i, _)| f.props[*i].as_f64()).filter(|v| *v > 0.0).map(|n| n * 3.0 + 1.0))
            .unwrap_or(8.0);
        for poly in ps {
            let rings: Vec<Vec<[f64; 2]>> = poly.iter().map(|r| to_crs(ct, r)).collect::<Result<_, _>>()?;
            out.push(Footprint { rings, height: h });
        }
    }
    let src = match (fixed, hfield, levels) {
        (Some(v), _, _) => format!("{v} m for every building"),
        (None, Some((_, n)), _) => format!("heights from the '{n}' field"),
        (None, None, Some((_, n))) => format!("heights from '{n}' × 3 m + 1 m"),
        _ => "no height field, so 8 m each".to_string(),
    };
    // biggest first, so a capped scene keeps the landmarks
    out.sort_by(|a, b| {
        let area = |f: &Footprint| f.rings.first().map(|r| r.windows(2).map(|w| w[0][0] * w[1][1] - w[1][0] * w[0][1]).sum::<f64>().abs()).unwrap_or(0.0);
        area(b).total_cmp(&area(a))
    });
    out.truncate(25_000);
    Ok((out, src))
}

fn tree_list(sc: &StepCtx, l: &LayerHandle, ct: &CoordTransform) -> Result<Vec<TreeIn>, String> {
    let fs = features::read_layer(sc.engine, l, None, None, 500_000)?;
    let hi = ["height_m", "height", "h", "tree_height"].iter().find_map(|n| fs.field(n));
    let ci = ["crown_m", "crown", "crown_width", "crown_diameter"].iter().find_map(|n| fs.field(n));
    let mut out = Vec::new();
    for f in &fs.feats {
        let Geom::Points(pts) = &f.geom else { continue };
        let h = hi.and_then(|i| f.props[i].as_f64()).filter(|v| *v > 0.5).unwrap_or(12.0);
        let crown = ci.and_then(|i| f.props[i].as_f64()).filter(|v| *v > 0.1).unwrap_or_else(|| 2.0 * lidar::crown_radius(h));
        for c in to_crs(ct, pts)? {
            out.push(TreeIn { x: c[0], y: c[1], height: h, crown });
        }
    }
    // tallest first when capped
    out.sort_by(|a, b| b.height.total_cmp(&a.height));
    out.truncate(40_000);
    Ok(out)
}

/// Point colours: the file's own RGB when it has them, else ASPRS classes, else elevation.
fn point_colors(s: &[SamplePoint]) -> (Vec<[u8; 3]>, &'static str) {
    let with_rgb = s.iter().filter(|q| q.rgb != [0, 0, 0]).count();
    if with_rgb * 2 > s.len() {
        let deep = s.iter().any(|q| q.rgb.iter().any(|c| *c > 255));
        let to8 = |c: u16| if deep { (c >> 8) as u8 } else { c.min(255) as u8 };
        return (s.iter().map(|q| [to8(q.rgb[0]), to8(q.rgb[1]), to8(q.rgb[2])]).collect(), "the colours stored in the file");
    }
    let classified = s.iter().filter(|q| q.class >= 2).count() * 2 > s.len();
    let (mut lo, mut hi) = (f32::MAX, f32::MIN);
    for q in s {
        lo = lo.min(q.z);
        hi = hi.max(q.z);
    }
    let ramp = ["#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d", "#ffff8c", "#f9d057", "#f29e2e", "#e76818", "#d7191c"].map(hex);
    let by_z = |z: f32| {
        let t = ((z - lo) / (hi - lo).max(0.01)).clamp(0.0, 1.0) * (ramp.len() - 1) as f32;
        let i = (t.floor() as usize).min(ramp.len() - 2);
        let f = t - i as f32;
        [0, 1, 2].map(|k| (ramp[i][k] as f32 * (1.0 - f) + ramp[i + 1][k] as f32 * f).round() as u8)
    };
    let cols = s
        .iter()
        .map(|q| {
            if !classified {
                return by_z(q.z);
            }
            match q.class {
                2 => hex("#c9b48a"),
                3 => hex("#b5dc7d"),
                4 => hex("#6fbf55"),
                5 => hex("#2f7d3a"),
                6 => hex("#d9603b"),
                9 => hex("#4a90d9"),
                17 => hex("#9a9a9a"),
                _ => by_z(q.z),
            }
        })
        .collect();
    (cols, if classified { "their classes (ground tan, vegetation greens, buildings orange-red, water blue)" } else { "elevation (blue low to red high)" })
}

fn mb(n: usize) -> String {
    if n >= 1_000_000 { format!("{:.1} MB", n as f64 / 1e6) } else { format!("{} KB", (n as f64 / 1e3).round()) }
}

pub(super) fn scene_3d(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let demh = pick_raster(sc, p.get("dem"), &["dem"], &[])?;
    let d = read_dem(&demh)?;
    let (lo, hi) = d.dem.range().ok_or_else(|| format!("{} has no elevation values", demh.info.title))?;
    let ext = d.dem.extent();
    let (width, depth) = (ext[2] - ext[0], ext[3] - ext[1]);
    let cell = d.dem.cell().0;
    let relief = (hi - lo) as f64;
    let (k, k_why) = match p_f64(p, "exaggeration") {
        Some(v) if v > 0.0 => (v.clamp(0.1, 50.0), "as asked".to_string()),
        _ => {
            let k = scene3d::auto_exaggeration(width.max(depth), relief, demh.info.pixel_m.max(cell));
            (
                k,
                if k > 1.0 {
                    format!("the relief ({} m) is {:.1} % of the width, so it is raised to read clearly", fmt0(relief), relief / width.max(depth) * 100.0)
                } else {
                    format!("the relief ({} m) reads well at true scale", fmt0(relief))
                },
            )
        }
    };
    let grid = p_f64(p, "grid").map(|g| g as usize).unwrap_or(320).clamp(16, 2048);
    let (texture, drape_notes) = drape_texture(sc, p, &demh, &d, k)?;
    let tex_size = (texture.w, texture.h);
    let mut scene = Scene::terrain(&d.dem, grid, k, texture)?;
    let mut why = vec![format!(
        "terrain: {} × {} mesh ({:.1} m spacing) from {}{}, ×{} vertical exaggeration ({k_why})",
        scene.mesh[0],
        scene.mesh[1],
        width / scene.mesh[0] as f64,
        demh.info.title,
        d.note,
        k
    )];
    why.push(format!(
        "drape: {} × {} image of {}{}",
        tex_size.0,
        tex_size.1,
        if drape_notes.iter().any(|n| n.contains("draped")) { "the imagery" } else { "the terrain colours with relief shading" },
        if drape_notes.is_empty() { String::new() } else { format!(" ({})", drape_notes.join("; ")) }
    ));
    let ll = CoordTransform::new(&raster::wgs84(), &d.srs).map_err(|e| e.to_string())?;

    // buildings
    let mut n_buildings = 0;
    let mut building_src = String::new();
    if let Some(l) = layer_param(sc, p, "buildings", "building", GeomKind::Polygon)? {
        let (fp, src) = footprints(sc, &l, p, &ll)?;
        n_buildings = scene.add_buildings(&fp);
        building_src = src;
        why.push(format!("{n_buildings} buildings extruded from {} ({building_src})", sc.title_of(&l)));
    }
    // trees
    let mut n_trees = 0;
    if let Some(l) = layer_param(sc, p, "trees", "tree", GeomKind::Point)? {
        let trees = tree_list(sc, &l, &ll)?;
        n_trees = scene.add_trees(&trees);
        why.push(format!("{} trees modelled from their heights and crown widths{}", fmt0(n_trees as f64), if trees.len() > n_trees { format!(" ({} fell outside the terrain)", trees.len() - n_trees) } else { String::new() }));
    }
    // point cloud
    let max_pts = p_f64(p, "points").map(|v| v.max(0.0) as usize).unwrap_or(250_000).min(3_000_000);
    let (sample, total): (Option<Arc<Vec<SamplePoint>>>, u64) = match p_str(p, "cloud") {
        Some("none") | Some("false") => (None, 0),
        None | Some("auto") => (sc.cloud_sample.clone(), sc.cloud_total),
        Some(src) => {
            let root = sc.resolve_path(src).ok_or_else(|| format!("cloud: '{src}' not found"))?;
            let files = lidar::find_clouds(&root, 5000);
            if files.is_empty() {
                return Err(format!("cloud: no LAS/LAZ files in {}", root.display()));
            }
            let (s, total) = lidar::sample_files(&files, &d.wkt, p_f64(p, "epsg").map(|e| e as u32), max_pts, sc.cancel)?;
            (Some(Arc::new(s)), total)
        }
    };
    let mut n_points = 0;
    let mut point_how = "";
    if let Some(s) = sample.filter(|s| !s.is_empty() && max_pts > 0) {
        let kept: Vec<SamplePoint> = if s.len() > max_pts { (0..max_pts).map(|i| s[i * s.len() / max_pts]).collect() } else { s.to_vec() };
        let (cols, how) = point_colors(&kept);
        point_how = how;
        let pts: Vec<PointIn> = kept.iter().zip(cols).map(|(q, c)| PointIn { x: q.x, y: q.y, z: q.z as f64, rgb: c }).collect();
        n_points = scene.add_points(&pts);
        let shown = if total > 0 { format!(" of {}", fmt0(total as f64)) } else { String::new() };
        why.push(format!("{} points{shown} shown as a point cloud, coloured by {how}", fmt0(n_points as f64)));
    }

    // files
    let name = sanitize(p_str(p, "name").unwrap_or("scene"));
    let title = p_str(p, "title").map(str::to_string).unwrap_or_else(|| format!("{} in 3D", demh.info.title));
    let (lon, lat) = {
        let to_ll = CoordTransform::new(&d.srs, &raster::wgs84()).map_err(|e| e.to_string())?;
        let (mut xs, mut ys, mut zs) = (vec![scene.origin[0]], vec![scene.origin[1]], vec![0.0]);
        to_ll.transform_coords(&mut xs, &mut ys, &mut zs).map_err(|e| e.to_string())?;
        (xs[0], ys[0])
    };
    let extras = json!({
        "title": title,
        "crs_epsg": d.epsg,
        "crs_wkt": d.wkt,
        "origin": scene.origin,
        "origin_lonlat": [lon, lat],
        "axes": "X = east, Y = up, Z = south (metres from the origin; add the origin to get map coordinates and elevation)",
        "vertical_exaggeration": k,
        "terrain_only_exaggerated": true,
        "source": demh.info.title,
        "credit": demh.info.credit,
        "made_by": format!("GeoSpaX {} recipe '{}' run {}", env!("CARGO_PKG_VERSION"), sc.recipe_id, sc.run_id),
    });
    let glb = scene.glb(&format!("GeoSpaX {}", env!("CARGO_PKG_VERSION")), extras, 88)?;
    let groups = scene.groups();
    let mut sub = vec![format!("{} × {} m", fmt0(width), fmt0(depth)), format!("{}–{} m", fmt0(lo as f64), fmt0(hi as f64))];
    if k != 1.0 {
        sub.push(format!("terrain ×{k}"));
    }
    if n_buildings > 0 {
        sub.push(format!("{n_buildings} buildings"));
    }
    if n_trees > 0 {
        sub.push(format!("{} trees", fmt0(n_trees as f64)));
    }
    if n_points > 0 {
        sub.push(format!("{} points", fmt0(n_points as f64)));
    }
    let azimuth = p_f64(p, "azimuth").unwrap_or(200.0);
    let elevation = p_f64(p, "elevation").unwrap_or(35.0).clamp(5.0, 89.0);
    let meta = json!({ "title": title, "subtitle": sub.join(" · "), "view": { "azimuth": azimuth, "elevation": elevation }, "groups": groups, "exaggeration": k });
    let html = Scene::html(&glb, &title, &meta);
    let (pw, ph) = p_str(p, "size").and_then(|s| s.split_once(['x', 'X'])).and_then(|(a, b)| Some((a.trim().parse::<usize>().ok()?, b.trim().parse::<usize>().ok()?))).unwrap_or((1600, 1000));
    let (pw, ph) = (pw.clamp(200, 4000), ph.clamp(150, 4000));
    // the picture shows the point cloud only when there is no model to speckle (as the viewer does)
    let img = scene.render(&View { azimuth, elevation, width: pw, height: ph, fov: 30.0, points: n_buildings == 0 && n_trees == 0 });
    let png = north_arrow(img, k)?;
    let files = [format!("{name}.png"), format!("{name}.html"), format!("{name}.glb")];
    std::fs::write(sc.dir.join(&files[0]), &png.0).map_err(|e| e.to_string())?;
    std::fs::write(sc.dir.join(&files[1]), html.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::write(sc.dir.join(&files[2]), &glb).map_err(|e| e.to_string())?;
    sc.artifacts.extend(files.iter().cloned());

    // the story
    let mut parts = vec![format!(
        "{} was meshed at {:.1} m ({} × {} vertices) with {} and draped with {}",
        demh.info.title,
        width / scene.mesh[0] as f64,
        scene.mesh[0],
        scene.mesh[1],
        if k == 1.0 {
            "true-scale heights".to_string()
        } else if n_buildings + n_trees > 0 {
            format!("{k}× vertical exaggeration (buildings and trees keep their true heights)")
        } else {
            format!("{k}× vertical exaggeration")
        },
        if drape_notes.iter().any(|n| n.contains("draped")) { "the imagery and relief shading" } else { "its map colours and relief shading" }
    )];
    if n_buildings > 0 {
        parts.push(format!("{n_buildings} buildings were extruded as flat-roofed blocks ({building_src})"));
    }
    if n_trees > 0 {
        parts.push(format!("{} trees were modelled from their heights and crown widths", fmt0(n_trees as f64)));
    }
    if n_points > 0 {
        parts.push(format!("{} points are shown, coloured by {point_how}", fmt0(n_points as f64)));
    }
    sc.methods.push(format!(
        "3D scene: {}. Lighting is baked from the north-west, like the relief shading. Saved as glTF 2.0 ({}: Blender, Windows 3D Viewer, ArcGIS Pro, CesiumJS) and as an interactive viewer that works offline in any browser ({}).",
        parts.join("; "),
        files[2],
        files[1]
    ));
    let caption = format!("{} · seen from the {} at {:.0}°", sub.join(" · "), compass(azimuth), elevation);
    let jpeg = scene3d::jpeg_bytes(&png.1, pw, ph, 84)?;
    sc.views.push(View3d { jpeg, caption, html: files[1].clone(), glb: files[2].clone() });
    sc.cards.push(("3D scene".into(), format!("{} triangles{}", count_text(scene.triangles()), if n_points > 0 { format!(" · {} points", count_text(n_points)) } else { String::new() })));
    why.push(format!(
        "{} triangles; {} {}, {} {}, {} {} × {}; done in {:.1} s",
        count_text(scene.triangles()),
        files[2],
        mb(glb.len()),
        files[1],
        mb(html.len()),
        files[0],
        pw,
        ph,
        t0.elapsed().as_secs_f64()
    ));
    Ok(StepOut {
        outputs: json!({
            "glb": sc.dir.join(&files[2]), "html": sc.dir.join(&files[1]), "png": sc.dir.join(&files[0]), "files": files,
            "exaggeration": k, "mesh": scene.mesh, "texture": [tex_size.0, tex_size.1], "triangles": scene.triangles(), "vertices": scene.vertices(),
            "buildings": n_buildings, "trees": n_trees, "points": n_points, "groups": groups, "north": (png.2 * 10.0).round() / 10.0,
            "glb_bytes": glb.len(), "html_bytes": html.len(), "origin": scene.origin, "epsg": d.epsg,
            "seconds": (t0.elapsed().as_secs_f64() * 100.0).round() / 100.0,
        }),
        why,
    })
}

fn count_text(n: usize) -> String {
    if n >= 1_000_000 { format!("{:.1} million", n as f64 / 1e6) } else { fmt0(n as f64) }
}

fn compass(az: f64) -> &'static str {
    const N: [&str; 16] = ["north", "north-north-east", "north-east", "east-north-east", "east", "east-south-east", "south-east", "south-south-east", "south", "south-south-west", "south-west", "west-south-west", "west", "west-north-west", "north-west", "north-north-west"];
    N[((az.rem_euclid(360.0) + 11.25) / 22.5) as usize % 16]
}

/// PNG with a north arrow (and the exaggeration) drawn on; also returns the RGB pixels and the
/// arrow's angle.
fn north_arrow(img: scene3d::Rendered, k: f64) -> Result<(Vec<u8>, Vec<u8>, f64), String> {
    let (w, h) = (img.w as f32, img.h as f32);
    let s = (w.min(h) / 1000.0).max(0.4);
    let note = if k != 1.0 { format!("<text x=\"{:.1}\" y=\"{:.1}\" font-family=\"DejaVu Sans\" font-size=\"{:.1}\" fill=\"#33424f\">terrain heights ×{k}</text>", 18.0 * s, h - 18.0 * s, 15.0 * s) } else { String::new() };
    // needle turned to where north is on the picture; the N stays upright just beyond its tip
    let (sn, cn) = img.north.to_radians().sin_cos();
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\"><g transform=\"translate({:.1} {:.1}) scale({s:.3})\"><circle r=\"34\" fill=\"#ffffff\" fill-opacity=\"0.9\" stroke=\"#c5d0da\"/><g transform=\"rotate({:.1})\"><path d=\"M0,-21 L7,0 L-7,0Z\" fill=\"#c0392b\"/><path d=\"M0,21 L7,0 L-7,0Z\" fill=\"#8a96a3\"/></g><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" font-family=\"DejaVu Sans\" font-size=\"12\" font-weight=\"bold\" fill=\"#14212b\">N</text></g>{note}</svg>",
        w - 56.0 * s,
        56.0 * s,
        img.north,
        27.0 * sn,
        -27.0 * cn + 4.5
    );
    let opt = resvg::usvg::Options { fontdb: cartography::fonts(), ..Default::default() };
    let tree = resvg::usvg::Tree::from_str(&svg, &opt).map_err(|e| format!("north arrow: {e}"))?;
    let size = resvg::tiny_skia::IntSize::from_wh(img.w as u32, img.h as u32).ok_or("bad picture size")?;
    let mut pm = resvg::tiny_skia::Pixmap::from_vec(img.rgba, size).ok_or("bad picture")?;
    resvg::render(&tree, resvg::tiny_skia::Transform::identity(), &mut pm.as_mut());
    let rgb: Vec<u8> = pm.data().chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    let png = pm.encode_png().map_err(|e| e.to_string())?;
    Ok((png, rgb, img.north))
}
