//! Pre-built overview pyramids ("tile cache" in ArcGIS terms).
//!
//! Dense layers can't be tiled on the fly at low zoom: a z11 tile of 1M
//! building footprints scans ~100k features. A background job renders z0..=N
//! once into a PMTiles archive. Features smaller than ~2 px are aggregated
//! into a `<layer>:density` point layer (feature counts on a 4 px grid), so
//! low-zoom tiles stay small and the map shows *where* the data is (heatmap)
//! instead of a blank screen. The engine then serves z <= N from the archive
//! and renders z > N live.
//!
//! Archives are keyed by a fingerprint of the source (path, size, mtime,
//! feature count): a stale archive is ignored, never served.

use crate::catalog::LayerHandle;
use crate::pmtiles_io::{PmReader, tile_id};
use crate::{Engine, LayerInfo, RenderOpts, tile};
use pmtiles::{Compression, PmTilesWriter, TileCoord, TileType};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Layers with at least this many features get overviews suggested.
pub const DENSE_FEATURES: u64 = 200_000;
/// Default top of the pyramid for dense layers; live tiles take over above.
pub const DEFAULT_MAX_ZOOM: u8 = 12;
/// Refuse pyramids larger than this (whole-world layers at high zoom).
pub const MAX_TILES: u64 = 200_000;
/// Tiles rendered per parallel batch (also the progress/cancel granularity).
const BATCH: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Fingerprint {
    pub source: String,
    pub layer: String,
    pub size: u64,
    pub mtime: u64,
    pub features: u64,
}

impl Fingerprint {
    pub fn of(layer: &LayerHandle) -> Fingerprint {
        let md = std::fs::metadata(&layer.path).ok();
        Fingerprint {
            source: layer.path.display().to_string(),
            layer: layer.layer_name.clone(),
            size: md.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: md
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            features: layer.info.feature_count,
        }
    }
}

/// What the UI/API shows about an attached overview.
#[derive(Debug, Clone, Serialize)]
pub struct OverviewMeta {
    pub max_zoom: u8,
    pub tiles: u64,
    pub bytes: u64,
    pub built_at: u64,
    pub path: String,
    /// Per zoom: 90th percentile (over tiles) of the densest cell's feature
    /// count. Lets clients normalise density heatmaps without guessing.
    pub density_p90: Vec<u32>,
}

/// Sidecar with build statistics (PMTiles metadata is written before the
/// tiles, so stats gathered while building go next to the archive).
fn sidecar(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".json");
    PathBuf::from(s)
}

pub struct Overview {
    pub meta: OverviewMeta,
    pub reader: PmReader,
}

impl Overview {
    /// Open an archive and verify it was built from `fp`.
    pub fn open(path: &Path, fp: &Fingerprint) -> Result<Overview, String> {
        let reader = PmReader::open(path)?;
        let gx = &reader.metadata["geospax"];
        let stored: Fingerprint = serde_json::from_value(gx["fingerprint"].clone())
            .map_err(|_| format!("{}: no GeoSpaX fingerprint in metadata", path.display()))?;
        if &stored != fp {
            return Err(format!(
                "{}: stale (source changed since the overview was built)",
                path.display()
            ));
        }
        let stats: serde_json::Value = std::fs::read(sidecar(path))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let density_p90 = stats["per_zoom"]
            .as_array()
            .map(|zs| {
                zs.iter()
                    .map(|z| z["density_p90"].as_u64().unwrap_or(0) as u32)
                    .collect()
            })
            .unwrap_or_default();
        let meta = OverviewMeta {
            max_zoom: reader.header.max_zoom,
            tiles: reader.header.addressed_tiles,
            bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            built_at: gx["built_at"].as_u64().unwrap_or(0),
            path: path.display().to_string(),
            density_p90,
        };
        Ok(Overview { meta, reader })
    }
}

pub fn path_for(state_dir: &Path, layer_id: &str) -> PathBuf {
    state_dir
        .join("overviews")
        .join(format!("{layer_id}.pmtiles"))
}

/// Total tiles of a z0..=max pyramid over `b`.
pub fn pyramid_tiles(b: [f64; 4], max_zoom: u8) -> u64 {
    (0..=max_zoom).map(|z| tile::tiles_covering(b, z)).sum()
}

/// Overview depth worth building for a layer, or None if live tiles suffice.
pub fn suggested_max_zoom(info: &LayerInfo) -> Option<u8> {
    let dense = info.feature_count >= DENSE_FEATURES;
    if !dense && info.minzoom == 0 {
        return None;
    }
    let mut z = if dense {
        DEFAULT_MAX_ZOOM.max(info.minzoom.saturating_sub(1))
    } else {
        info.minzoom - 1
    };
    z = z.min(info.maxzoom.saturating_sub(1));
    while z > 0 && pyramid_tiles(info.bounds, z) > MAX_TILES {
        z -= 1;
    }
    Some(z)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Build summary returned by [`build`].
#[derive(Debug, Clone, Serialize)]
pub struct BuildReport {
    pub layer: String,
    pub max_zoom: u8,
    pub tiles_visited: u64,
    pub tiles_written: u64,
    pub bytes_raw: u64,
    pub file_bytes: u64,
    pub build_ms: f64,
    pub per_zoom: Vec<ZoomReport>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZoomReport {
    pub z: u8,
    pub tiles: u64,
    pub bytes_raw: u64,
    pub max_tile_bytes: u64,
    pub ms: f64,
    /// densest cell over all tiles / 90th percentile of per-tile maxima
    pub density_max: u32,
    pub density_p90: u32,
}

/// Render z0..=max_zoom of `layer` into a PMTiles archive at `out`
/// (written to a temp file and renamed into place on success).
/// Parallelism comes from the rayon pool this runs in.
pub fn build(
    engine: &Engine,
    layer: &LayerHandle,
    max_zoom: u8,
    out: &Path,
    cancel: &AtomicBool,
    progress: &dyn Fn(u64, u64),
) -> Result<BuildReport, String> {
    let t0 = Instant::now();
    let info = &layer.info;
    let b = info.bounds;
    let total = pyramid_tiles(b, max_zoom);
    if total > MAX_TILES {
        return Err(format!(
            "pyramid z0-{max_zoom} would have {total} tiles (limit {MAX_TILES}); lower maxzoom"
        ));
    }
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = out.with_extension("pmtiles.part");
    let fields: serde_json::Map<String, serde_json::Value> = layer
        .field_idx
        .iter()
        .map(|&i| {
            let f = &info.fields[i];
            let t = if f.kind == "string" {
                "String"
            } else {
                "Number"
            };
            (f.name.clone(), serde_json::Value::from(t))
        })
        .collect();
    let metadata = serde_json::json!({
        "name": info.id,
        "description": format!("Overview pyramid z0-{max_zoom} of {} (density points for features < 2 px)", info.id),
        "vector_layers": [
            { "id": info.id, "fields": fields, "minzoom": 0, "maxzoom": max_zoom },
            { "id": format!("{}:density", info.id), "fields": { "count": "Number" }, "minzoom": 0, "maxzoom": max_zoom },
        ],
        "geospax": { "fingerprint": Fingerprint::of(layer), "built_at": now_secs(), "density_cell_px": 4, "min_feature_px": 2 },
    });
    let file = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let mut w = PmTilesWriter::new(TileType::Mvt)
        .tile_compression(Compression::Gzip)
        .internal_compression(Compression::Gzip)
        .min_zoom(0)
        .max_zoom(max_zoom)
        .bounds(b[0], b[1], b[2], b[3])
        .center((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)
        .center_zoom(max_zoom.min(info.minzoom.max(4)))
        .metadata(&metadata.to_string())
        .create(std::io::BufWriter::new(file))
        .map_err(|e| e.to_string())?;

    let opts = RenderOpts {
        overview: true,
        fields: None,
    };
    let (mut done, mut written, mut bytes_raw) = (0u64, 0u64, 0u64);
    let mut per_zoom = Vec::new();
    let result: Result<(), String> = (|| {
        for z in 0..=max_zoom {
            let tz = Instant::now();
            let (x0, y0) = tile::lonlat_to_tile(b[0], b[3], z);
            let (x1, y1) = tile::lonlat_to_tile(b[2], b[1], z);
            let mut coords = Vec::with_capacity(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize);
            for x in x0..=x1 {
                for y in y0..=y1 {
                    coords.push((tile_id(z, x, y)?, x, y));
                }
            }
            coords.sort_unstable();
            let mut zr = ZoomReport {
                z,
                tiles: 0,
                bytes_raw: 0,
                max_tile_bytes: 0,
                ms: 0.0,
                density_max: 0,
                density_p90: 0,
            };
            let mut maxima: Vec<u32> = Vec::new();
            for chunk in coords.chunks(BATCH) {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                let rendered: Vec<Result<(Vec<u8>, u32), String>> = chunk
                    .par_iter()
                    .map(|&(_, x, y)| {
                        engine
                            .render_tile(layer, z, x, y, &opts)
                            .map(|r| (r.bytes, r.density_max))
                    })
                    .collect();
                for (&(_, x, y), r) in chunk.iter().zip(rendered) {
                    let (bytes, dmax) = r?;
                    done += 1;
                    if dmax > 0 {
                        maxima.push(dmax);
                    }
                    if bytes.is_empty() {
                        continue;
                    }
                    let coord = TileCoord::new(z, x, y).map_err(|e| e.to_string())?;
                    w.add_tile(coord, &bytes).map_err(|e| e.to_string())?;
                    written += 1;
                    bytes_raw += bytes.len() as u64;
                    zr.tiles += 1;
                    zr.bytes_raw += bytes.len() as u64;
                    zr.max_tile_bytes = zr.max_tile_bytes.max(bytes.len() as u64);
                }
                progress(done, total);
            }
            zr.ms = tz.elapsed().as_secs_f64() * 1000.0;
            maxima.sort_unstable();
            zr.density_max = maxima.last().copied().unwrap_or(0);
            zr.density_p90 = maxima
                .get((maxima.len().saturating_sub(1) as f64 * 0.9).round() as usize)
                .copied()
                .unwrap_or(0);
            per_zoom.push(zr);
        }
        Ok(())
    })();
    if let Err(e) = result {
        drop(w);
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    w.finalize().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, out).map_err(|e| format!("rename {}: {e}", out.display()))?;
    let report = BuildReport {
        layer: info.id.clone(),
        max_zoom,
        tiles_visited: done,
        tiles_written: written,
        bytes_raw,
        file_bytes: std::fs::metadata(out).map(|m| m.len()).unwrap_or(0),
        build_ms: t0.elapsed().as_secs_f64() * 1000.0,
        per_zoom,
        path: out.display().to_string(),
    };
    let _ = std::fs::write(
        sidecar(out),
        serde_json::to_vec_pretty(&report).unwrap_or_default(),
    );
    Ok(report)
}
