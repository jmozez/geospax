//! OGC 3D Tiles 1.1 writer for point clouds (docs/AUTOMATION.md, `lidar.3dtiles`).
//!
//! A tileset is `<name>.tileset.json` plus glTF 2.0 binary tiles (`<name>-<i>.glb`, `POINTS`
//! primitives with `POSITION` and `COLOR_0`), all in one folder so the files can be copied as they
//! are to any web server and opened in CesiumJS, deck.gl's Tile3DLayer, QGIS 3.34+ or ArcGIS. The
//! root tile carries a thinned overview and `REPLACE` refinement; a grid of child tiles carries
//! every kept point. Coordinates are local east/north/up metres around the centre (float32 is
//! millimetre exact over tens of kilometres) and the root `transform` places them on the WGS 84
//! ellipsoid. glTF is y-up; 3D Tiles turns it z-up, so positions are written as (east, up, -north).

use serde_json::{json, Value};
use std::path::Path;

const A: f64 = 6_378_137.0;
const E2: f64 = 6.694_379_990_141_316e-3;

/// One point: longitude, latitude (degrees), ellipsoidal height (m), colour.
#[derive(Debug, Clone, Copy)]
pub struct Pt {
    pub lon: f64,
    pub lat: f64,
    pub h: f64,
    pub rgb: [u8; 3],
}

pub fn ecef(lon: f64, lat: f64, h: f64) -> [f64; 3] {
    let (l, p) = (lon.to_radians(), lat.to_radians());
    let n = A / (1.0 - E2 * p.sin().powi(2)).sqrt();
    [(n + h) * p.cos() * l.cos(), (n + h) * p.cos() * l.sin(), (n * (1.0 - E2) + h) * p.sin()]
}

/// East, north and up unit vectors at a place.
fn enu_axes(lon: f64, lat: f64) -> [[f64; 3]; 3] {
    let (l, p) = (lon.to_radians(), lat.to_radians());
    [[-l.sin(), l.cos(), 0.0], [-p.sin() * l.cos(), -p.sin() * l.sin(), p.cos()], [p.cos() * l.cos(), p.cos() * l.sin(), p.sin()]]
}

/// A glTF binary with one `POINTS` primitive. `xyz` are local (east, north, up) metres.
pub fn points_glb(xyz: &[[f32; 3]], rgb: &[[u8; 3]], generator: &str) -> Vec<u8> {
    let n = xyz.len();
    let mut bin = Vec::with_capacity(n * 16);
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for p in xyz {
        let g = [p[0], p[2], -p[1]];
        for k in 0..3 {
            lo[k] = lo[k].min(g[k]);
            hi[k] = hi[k].max(g[k]);
            bin.extend_from_slice(&g[k].to_le_bytes());
        }
    }
    let col_off = bin.len();
    for c in rgb {
        bin.extend_from_slice(&[c[0], c[1], c[2], 255]);
    }
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    if n == 0 {
        lo = [0.0; 3];
        hi = [0.0; 3];
    }
    let doc = json!({
        "asset": { "version": "2.0", "generator": generator },
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0, "scenes": [{ "nodes": [0] }], "nodes": [{ "mesh": 0 }],
        "materials": [{ "pbrMetallicRoughness": { "baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1 }, "extensions": { "KHR_materials_unlit": {} } }],
        "meshes": [{ "primitives": [{ "mode": 0, "material": 0, "attributes": { "POSITION": 0, "COLOR_0": 1 } }] }],
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": n * 12, "target": 34962 },
            { "buffer": 0, "byteOffset": col_off, "byteLength": n * 4, "target": 34962 }
        ],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": n, "type": "VEC3", "min": lo, "max": hi },
            { "bufferView": 1, "componentType": 5121, "normalized": true, "count": n, "type": "VEC4" }
        ]
    });
    let mut js = serde_json::to_vec(&doc).unwrap_or_default();
    while js.len() % 4 != 0 {
        js.push(b' ');
    }
    let total = 12 + 8 + js.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(js.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&js);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    out
}

fn bbox(xyz: &[[f32; 3]]) -> Value {
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for p in xyz {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k] as f64);
            hi[k] = hi[k].max(p[k] as f64);
        }
    }
    let c: Vec<f64> = (0..3).map(|k| (lo[k] + hi[k]) / 2.0).collect();
    let e: Vec<f64> = (0..3).map(|k| ((hi[k] - lo[k]) / 2.0).max(0.01)).collect();
    json!([c[0], c[1], c[2], e[0], 0, 0, 0, e[1], 0, 0, 0, e[2]])
}

/// Summary of a written tileset.
#[derive(Debug, Clone)]
pub struct Written {
    pub files: Vec<String>,
    pub tiles: usize,
    pub points: usize,
    pub center: [f64; 3],
}

/// Write `<name>.tileset.json` and its tiles into `dir`, at most `per_tile` points per tile.
pub fn write_points(points: &[Pt], dir: &Path, name: &str, per_tile: usize, generator: &str) -> Result<Written, String> {
    if points.is_empty() {
        return Err("no points to write".into());
    }
    let per_tile = per_tile.max(1000);
    let n = points.len() as f64;
    let (clon, clat, ch) = points.iter().fold((0.0, 0.0, 0.0), |a, p| (a.0 + p.lon / n, a.1 + p.lat / n, a.2 + p.h / n));
    let o = ecef(clon, clat, ch);
    let ax = enu_axes(clon, clat);
    let local: Vec<[f32; 3]> = points
        .iter()
        .map(|p| {
            let e = ecef(p.lon, p.lat, p.h);
            let d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
            [0, 1, 2].map(|k| (d[0] * ax[k][0] + d[1] * ax[k][1] + d[2] * ax[k][2]) as f32)
        })
        .collect();
    let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for p in &local {
        x0 = x0.min(p[0]);
        x1 = x1.max(p[0]);
        y0 = y0.min(p[1]);
        y1 = y1.max(p[1]);
    }
    let g = ((points.len() as f64 / per_tile as f64).sqrt().ceil() as usize).max(1);
    let (cw, chh) = (((x1 - x0) / g as f32).max(1e-3), ((y1 - y0) / g as f32).max(1e-3));
    let mut cells: Vec<Vec<usize>> = vec![Vec::new(); g * g];
    for (i, p) in local.iter().enumerate() {
        let cx = (((p[0] - x0) / cw) as usize).min(g - 1);
        let cy = (((p[1] - y0) / chh) as usize).min(g - 1);
        cells[cy * g + cx].push(i);
    }
    let mut files = Vec::new();
    let mut children = Vec::new();
    let mut tiles = 0;
    let write = |file: &str, idx: &[usize]| -> Result<Value, String> {
        let xyz: Vec<[f32; 3]> = idx.iter().map(|&i| local[i]).collect();
        let rgb: Vec<[u8; 3]> = idx.iter().map(|&i| points[i].rgb).collect();
        std::fs::write(dir.join(file), points_glb(&xyz, &rgb, generator)).map_err(|e| format!("{file}: {e}"))?;
        Ok(bbox(&xyz))
    };
    for (ci, idx) in cells.iter().enumerate().filter(|(_, v)| !v.is_empty()) {
        // a cell over the limit (clustered data) is split into consecutive chunks
        for (k, chunk) in idx.chunks(per_tile * 2).enumerate() {
            let file = format!("{name}-{ci}-{k}.glb");
            let bv = write(&file, chunk)?;
            children.push(json!({ "boundingVolume": { "box": bv }, "geometricError": 0, "content": { "uri": file } }));
            files.push(file);
            tiles += 1;
        }
    }
    let step = (points.len() / per_tile).max(1);
    let overview: Vec<usize> = (0..points.len()).step_by(step).collect();
    let root_file = format!("{name}-root.glb");
    write(&root_file, &overview)?;
    files.push(root_file.clone());
    tiles += 1;
    let all: Vec<usize> = (0..points.len()).collect();
    let xyz_all: Vec<[f32; 3]> = all.iter().map(|&i| local[i]).collect();
    // spacing of the overview: refine when it would look sparser than that on screen
    let span = ((x1 - x0) as f64).hypot((y1 - y0) as f64).max(1.0);
    let root_error = span / (overview.len() as f64).sqrt().max(1.0) * 4.0;
    let t = [ax[0][0], ax[0][1], ax[0][2], 0.0, ax[1][0], ax[1][1], ax[1][2], 0.0, ax[2][0], ax[2][1], ax[2][2], 0.0, o[0], o[1], o[2], 1.0];
    let tileset = json!({
        "asset": { "version": "1.1", "generator": generator },
        "geometricError": root_error * 2.0,
        "root": {
            "transform": t, "boundingVolume": { "box": bbox(&xyz_all) }, "geometricError": root_error, "refine": "REPLACE",
            "content": { "uri": root_file }, "children": children
        }
    });
    let ts = format!("{name}.tileset.json");
    std::fs::write(dir.join(&ts), serde_json::to_vec_pretty(&tileset).unwrap_or_default()).map_err(|e| e.to_string())?;
    files.insert(0, ts);
    Ok(Written { files, tiles, points: points.len(), center: [clon, clat, ch] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecef_and_axes_are_consistent() {
        let e = ecef(0.0, 0.0, 0.0);
        assert!((e[0] - A).abs() < 1e-6 && e[1].abs() < 1e-6 && e[2].abs() < 1e-6);
        let ax = enu_axes(147.0, -9.4);
        for v in ax {
            assert!(((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt() - 1.0).abs() < 1e-12);
        }
        // up is along the ellipsoid normal: a point 100 m up is ~100 m along it
        let (a, b) = (ecef(147.0, -9.4, 0.0), ecef(147.0, -9.4, 100.0));
        let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        assert!(((d[0] * ax[2][0] + d[1] * ax[2][1] + d[2] * ax[2][2]) - 100.0).abs() < 1e-6);
    }

    #[test]
    fn writes_a_valid_tileset() {
        let dir = std::env::temp_dir().join(format!("gx-3dt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pts: Vec<Pt> = (0..25_000).map(|i| Pt { lon: 147.15 + (i % 250) as f64 * 1e-5, lat: -9.45 + (i / 250) as f64 * 1e-5, h: 50.0 + (i % 7) as f64, rgb: [10, 200, 30] }).collect();
        let w = write_points(&pts, &dir, "cloud", 5000, "test").unwrap();
        assert!(w.tiles >= 5, "{w:?}");
        let ts: Value = serde_json::from_slice(&std::fs::read(dir.join("cloud.tileset.json")).unwrap()).unwrap();
        assert_eq!(ts["asset"]["version"], "1.1");
        assert_eq!(ts["root"]["transform"].as_array().unwrap().len(), 16);
        let mut total = 0;
        for c in ts["root"]["children"].as_array().unwrap() {
            let b = std::fs::read(dir.join(c["content"]["uri"].as_str().unwrap())).unwrap();
            assert_eq!(&b[0..4], b"glTF");
            assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize, b.len());
            let jl = u32::from_le_bytes(b[12..16].try_into().unwrap()) as usize;
            let doc: Value = serde_json::from_slice(&b[20..20 + jl]).unwrap();
            assert_eq!(doc["meshes"][0]["primitives"][0]["mode"], 0);
            total += doc["accessors"][0]["count"].as_u64().unwrap();
            // the box is near the origin: local metres, not Earth-centred
            assert!(c["boundingVolume"]["box"][0].as_f64().unwrap().abs() < 1000.0);
        }
        assert_eq!(total as usize, pts.len());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
