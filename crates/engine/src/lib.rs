//! GeoSpaX engine: the GIS data plane shared by the web and desktop editions.
//!
//! GDAL vector sources -> on-the-fly Mapbox Vector Tiles, pre-built overview
//! pyramids (PMTiles), Arrow IPC, field statistics. The engine is
//! transport-agnostic: [`Engine::handle`] answers a plain request struct and
//! thin adapters expose it over HTTP (Axum, web edition) or a Tauri custom
//! URI scheme / `invoke` (desktop edition).

#[cfg(feature = "arrow")]
pub mod ai;
pub mod arrow_export;
pub mod automation;
pub mod browse;
pub mod services;
pub mod stac;
pub mod cloud;
pub mod geoparquet;
pub mod pyenv;
pub mod github;
pub mod db;
pub mod design;
pub mod catalog;
pub mod classify;
pub mod crs;
pub mod devices;
pub mod docs;
pub mod edit;
pub mod geostats;
pub mod guest;
pub mod sensors;
pub mod sql;
pub mod sta;
pub mod jobs;
pub mod lidar;
pub mod mvt;
pub mod overview;
pub mod phone;
pub mod plugins;
pub mod pmtiles_io;
pub mod project_import;
pub mod raster;
pub mod reader;
pub mod router;
pub mod rsetup;
pub mod samples;
pub mod scene3d;
pub mod tile;
pub mod tiles3d;
pub mod upload;
pub mod wkb;

pub use catalog::{GeomKind, LayerInfo};
pub use reader::ReadMode;
pub use router::{ApiRequest, ApiResponse};

use catalog::{Handle, LayerHandle};

/// Folder of the running executable. The Windows edition and the portable ZIP keep GDAL/PROJ data
/// (`share\gdal`, `share\proj`), fonts and the web UI next to geospax.exe.
pub fn exe_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

/// A child process that never opens a console window: without CREATE_NO_WINDOW every Python, R, GRASS or
/// SAGA step started from the Windows desktop app would flash a black console.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

use gdal::spatial_ref::CoordTransform;
use gdal::vector::LayerAccess;
use lru::LruCache;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

/// Hard cap per tile; dense layers should get a higher minzoom or overviews.
pub const MAX_FEATURES_PER_TILE: u32 = 100_000;
/// Max attribute columns a tile request may ask for (`?fields=`).
pub const MAX_REQUEST_FIELDS: usize = 16;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub data: Vec<PathBuf>,
    /// LRU tile cache capacity in tiles (0 disables the cache).
    pub cache_tiles: usize,
    /// Worker threads for tile rendering (0 = available parallelism).
    pub threads: usize,
    /// Optional JSONL file that receives benchmark reports posted by the UI.
    pub bench_log: Option<PathBuf>,
    /// GDAL read path: columnar Arrow stream (default) or per-feature.
    pub read_mode: ReadMode,
    /// Where overviews and the project file live
    /// (default: `<first data dir>/.geospax`).
    pub state_dir: Option<PathBuf>,
    /// Device and sensor hub (docs/DEVICES.md).
    pub devices: devices::DevicesConfig,
    /// Recipes, runs and triggers (docs/AUTOMATION.md).
    pub automation: automation::AutomationConfig,
    /// Phone link: phones send photos and tracks over Wi-Fi (docs/DEVICES.md §3a).
    pub phone: phone::PhoneConfig,
    /// Plugin folders (docs/PLUGINS.md).
    pub plugins: plugins::PluginsConfig,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            data: vec![PathBuf::from("data")],
            cache_tiles: 4096,
            threads: 0,
            bench_log: None,
            read_mode: ReadMode::Arrow,
            state_dir: None,
            devices: devices::DevicesConfig::default(),
            automation: automation::AutomationConfig::default(),
            phone: phone::PhoneConfig::default(),
            plugins: plugins::PluginsConfig::default(),
        }
    }
}

/// One rendered tile plus where the time went.
#[derive(Debug, Clone, Default)]
pub struct TileResult {
    pub bytes: Vec<u8>,
    pub features: u32,
    /// Density cells emitted (overview tiles only).
    pub density_cells: u32,
    /// Largest feature count in one density cell (overview tiles only).
    pub density_max: u32,
    pub scanned: u32,
    pub truncated: bool,
    pub read_ms: f64,
    pub proc_ms: f64,
    pub enc_ms: f64,
    /// checkout + layer lookup + spatial filter (before the first feature)
    pub setup_ms: f64,
    /// iterator/statement teardown + handle check-in
    pub teardown_ms: f64,
    pub total_ms: f64,
    /// "live" (rendered from source) or "overview" (pre-built pyramid)
    pub source: &'static str,
}

/// How filtered (bbox) GeoPackage reads are done in Arrow mode.
///
/// GDAL < 3.12 has a race in the GPKG driver's asynchronous Arrow path (the
/// one taken whenever a spatial filter is set). The consumer can pick up a
/// batch the SQLite worker thread is still filling, which corrupts memory.
/// It was fixed upstream in 3.12.0 (explicit `bThreadReady` handshake). On
/// older GDAL we route around it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpkgFiltered {
    /// GDAL's native asynchronous Arrow path (GDAL >= 3.12).
    Async,
    /// GDAL's generic OGRLayer Arrow implementation (`OGR_GPKG_STREAM_BASE_IMPL`).
    Base,
    /// Our per-feature reader.
    Features,
}

impl GpkgFiltered {
    pub fn as_str(self) -> &'static str {
        match self {
            GpkgFiltered::Async => "async",
            GpkgFiltered::Base => "base",
            GpkgFiltered::Features => "features",
        }
    }
}

/// Runtime GDAL version as a number (3.10.3 -> 3100300).
pub fn gdal_version_num() -> u32 {
    gdal::version::version_info("VERSION_NUM").trim().parse().unwrap_or(0)
}

/// How to render a tile.
#[derive(Debug, Clone, Default)]
pub struct RenderOpts {
    /// Overview mode: render below the layer's live minzoom and aggregate
    /// sub-pixel features into density points.
    pub overview: bool,
    /// OGR field indices to encode as attributes (None = layer defaults).
    pub fields: Option<Vec<usize>>,
}

#[derive(Default)]
struct Stats {
    tiles: u64,
    cache_hits: u64,
    overview_tiles: u64,
    empty: u64,
    bytes: u64,
    features: u64,
    render_ms: f64,
    recent_ms: VecDeque<f64>,
}

type CacheKey = (u32, u8, u32, u32, u64);

/// Layers in load order. Append-only indexes (the tile cache keys on them); an id that is
/// registered again (re-imported device) replaces its handle in place.
#[derive(Default)]
struct Registry {
    layers: Vec<Arc<LayerHandle>>,
    by_id: HashMap<String, usize>,
}

pub struct Engine {
    reg: RwLock<Registry>,
    pub(crate) devices: devices::Hub,
    /// Recipes, runs and triggers (docs/AUTOMATION.md).
    pub automation: automation::Automation,
    /// Phone link (docs/DEVICES.md §3a).
    pub(crate) phone: phone::PhoneLink,
    /// Plugins: tools and ribbon commands from GeoSpaX, RustGIS, GeoLibre, QGIS and
    /// ArcGIS Pro packages (docs/PLUGINS.md).
    pub plugins: plugins::Plugins,
    /// Rasters (data folders + recipe outputs); see raster.rs.
    pub(crate) rasters: RwLock<Vec<Arc<raster::RasterHandle>>>,
    /// Data folders/files the engine was opened with (relative paths in recipes resolve here).
    pub(crate) data_dirs: Vec<PathBuf>,
    /// Folder connections added in the Explorer (kept in `<state>/folders.json`): browsed like the
    /// data folders, but nothing in them is put on the map until it is opened.
    pub(crate) connections: RwLock<Vec<PathBuf>>,
    /// The web edition answers other devices (`--host` not loopback): folder connections can then
    /// not be added, since one would let those devices list any folder of this computer.
    pub shared: std::sync::atomic::AtomicBool,
    /// Public guest demo (`--public`): no sign-in, a project per visitor (`?ws=`), and what could
    /// misuse the server (code, installs, folders, settings) refused; see `guest.rs`.
    pub guest: std::sync::atomic::AtomicBool,
    /// Guest demo: who made which layer, raster, run and job (guest.rs).
    pub owners: guest::Owners,
    cache: Option<Mutex<LruCache<CacheKey, Arc<TileResult>>>>,
    pool: rayon::ThreadPool,
    pub(crate) job_pool: rayon::ThreadPool,
    /// Small separate pool for control-plane requests (see `dispatch`).
    ctl_pool: rayon::ThreadPool,
    pub(crate) jobs: jobs::Jobs,
    stats: Mutex<Stats>,
    started: Instant,
    pub read_mode: ReadMode,
    pub gpkg_filtered: GpkgFiltered,
    pub state_dir: PathBuf,
    pub(crate) bench: Mutex<Option<serde_json::Value>>,
    pub(crate) bench_log: Option<PathBuf>,
    pub(crate) project_lock: Mutex<()>,
    pub warnings: Vec<String>,
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// Reproject a parsed geometry in place (one batched PROJ call per feature).
pub(crate) fn transform_geom(g: &mut wkb::Geom, ct: &CoordTransform) -> bool {
    fn each(g: &mut wkb::Geom, f: &mut dyn FnMut(&mut [f64; 2])) {
        match g {
            wkb::Geom::Points(p) => p.iter_mut().for_each(f),
            wkb::Geom::Lines(ls) => ls.iter_mut().flatten().for_each(f),
            wkb::Geom::Polygons(ps) => ps.iter_mut().flatten().flatten().for_each(f),
            _ => {}
        }
    }
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    each(g, &mut |c| {
        xs.push(c[0]);
        ys.push(c[1]);
    });
    if xs.is_empty() {
        return true;
    }
    let mut zs = vec![0.0; xs.len()];
    if ct.transform_coords(&mut xs, &mut ys, &mut zs).is_err() {
        return false;
    }
    let mut i = 0;
    each(g, &mut |c| {
        *c = [xs[i], ys[i]];
        i += 1;
    });
    true
}

/// Per-tile read bookkeeping.
#[derive(Default)]
struct ReadTimes {
    setup_ms: f64,
    read_ms: f64,
    proc_ms: f64,
    scanned: u32,
    truncated: bool,
    teardown_start: Option<Instant>,
}

/// One row of the attribute table: the feature id, a bbox to zoom to, and its values.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Row {
    pub fid: u64,
    pub bbox: Option<[f64; 4]>,
    pub values: Vec<serde_json::Value>,
}

/// A page of attribute rows.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RowsPage {
    pub total: usize,
    pub offset: usize,
    /// Field names, in the same order as `Row::values`.
    pub fields: Vec<String>,
    pub rows: Vec<Row>,
}

impl Engine {
    pub fn open(cfg: EngineConfig) -> Result<Engine, String> {
        raster::configure_gdal();
        let mut layers = Vec::new();
        let mut warnings = Vec::new();
        let rasters = raster::load_all(&cfg.data, &mut warnings);
        for path in catalog::discover(&cfg.data) {
            match catalog::load_layers(&path) {
                Ok(ls) => layers.extend(ls.into_iter().map(Arc::new)),
                Err(e) => warnings.push(e),
            }
        }
        let mut by_id = HashMap::new();
        for (i, l) in layers.iter().enumerate() {
            if by_id.insert(l.info.id.clone(), i).is_some() {
                warnings.push(format!("duplicate layer id {}", l.info.id));
            }
        }
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
        let threads = if cfg.threads == 0 { cpus.max(2) } else { cfg.threads };
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("tile-worker-{i}"))
            .build()
            .map_err(|e| e.to_string())?;
        let job_pool = rayon::ThreadPoolBuilder::new()
            .num_threads(cpus.max(1))
            .thread_name(|i| format!("job-worker-{i}"))
            .build()
            .map_err(|e| e.to_string())?;
        let ctl_pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .thread_name(|i| format!("ctl-worker-{i}"))
            .build()
            .map_err(|e| e.to_string())?;
        let cache = NonZeroUsize::new(cfg.cache_tiles).map(|n| Mutex::new(LruCache::new(n)));
        let gdal_num = gdal_version_num();
        let gpkg_filtered = match std::env::var("GEOSPAX_GPKG_FILTERED").ok().as_deref() {
            Some("async") => GpkgFiltered::Async,
            Some("base") => GpkgFiltered::Base,
            Some("features") => GpkgFiltered::Features,
            _ if gdal_num >= 3_120_000 => GpkgFiltered::Async,
            // measured: GDAL's generic Arrow path beats our per-feature reader by 20-30%
            _ => GpkgFiltered::Base,
        };
        if cfg.read_mode == ReadMode::Arrow && gpkg_filtered != GpkgFiltered::Async {
            warnings.push(format!(
                "GDAL {} < 3.12: bbox reads on GeoPackage use the '{}' path instead of GDAL's async Arrow path (race fixed in GDAL 3.12)",
                gdal::version::version_info("RELEASE_NAME"),
                gpkg_filtered.as_str()
            ));
        }
        let state_dir = cfg.state_dir.clone().unwrap_or_else(|| {
            let base = cfg.data.first().cloned().unwrap_or_else(|| PathBuf::from("."));
            let dir = if base.is_dir() { base } else { base.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")) };
            dir.join(".geospax")
        });
        // Re-attach overview pyramids built in earlier sessions (if still fresh).
        for l in &layers {
            let path = overview::path_for(&state_dir, &l.info.id);
            if path.exists() {
                match overview::Overview::open(&path, &overview::Fingerprint::of(l)) {
                    Ok(o) => l.set_overview(Some(Arc::new(o))),
                    Err(e) => warnings.push(format!("overview ignored: {e}")),
                }
            }
        }
        let devices = devices::Hub::new(cfg.devices.clone());
        // the plugins that ship with GeoSpaX (GeoLibre tools, examples) first, then --plugins
        // folders, then <state>/plugins where imports are installed
        let mut plugin_dirs = plugins::bundled_dirs();
        plugin_dirs.extend(cfg.plugins.dirs.iter().cloned());
        plugin_dirs.push(state_dir.join("plugins"));
        plugin_dirs.dedup();
        let plugins = plugins::Plugins::new(plugin_dirs);
        // A `kind: recipe` plugin ships GeoSpaX recipes in its `recipes/` folder: hand them
        // to the automation engine so its tools are ordinary, triggerable recipes.
        let mut automation_cfg = cfg.automation.clone();
        for p in plugins.list() {
            if p.kind == "recipe" {
                let dir = std::path::Path::new(&p.path).join("recipes");
                if dir.is_dir() {
                    automation_cfg.recipe_dirs.push(dir);
                }
            }
        }
        let automation = automation::Automation::new(automation_cfg, &state_dir);
        automation::sidecar::set_r_library(state_dir.join("r-library"));
        pyenv::apply_saved(&state_dir);
        automation::charts::load(&state_dir);
        let phone = phone::PhoneLink::new(&state_dir, cfg.phone.clone());
        let engine = Engine {
            reg: RwLock::new(Registry { layers, by_id }),
            devices,
            automation,
            plugins,
            phone,
            rasters: RwLock::new(rasters),
            data_dirs: cfg.data.clone(),
            connections: RwLock::new(browse::load_connections(&state_dir)),
            shared: std::sync::atomic::AtomicBool::new(false),
            guest: std::sync::atomic::AtomicBool::new(false),
            owners: Default::default(),
            cache,
            pool,
            job_pool,
            ctl_pool,
            jobs: jobs::Jobs::default(),
            stats: Mutex::new(Stats::default()),
            started: Instant::now(),
            read_mode: cfg.read_mode,
            gpkg_filtered,
            state_dir,
            bench: Mutex::new(None),
            bench_log: cfg.bench_log,
            project_lock: Mutex::new(()),
            warnings,
        };
        // layers edited (or made) in earlier sessions read their copies again
        engine.load_edits();
        // raster styles set by hand in earlier sessions
        engine.apply_saved_raster_styles();
        Ok(engine)
    }

    /// Snapshot of all layers (the registry can grow at runtime, e.g. device imports).
    pub fn layers(&self) -> Vec<Arc<LayerHandle>> {
        self.reg.read().unwrap().layers.clone()
    }

    /// Every layer id, for plugin tools that need to know what is on the map.
    pub fn layer_ids(&self) -> Vec<String> {
        let r = self.reg.read().unwrap();
        r.layers.iter().map(|l| l.info.id.clone()).collect()
    }

    pub fn layer(&self, id: &str) -> Option<Arc<LayerHandle>> {
        let r = self.reg.read().unwrap();
        r.by_id.get(id).map(|&i| r.layers[i].clone())
    }

    /// Add layers at runtime, or replace layers with the same id. Returns their ids.
    pub fn register_layers(&self, handles: Vec<LayerHandle>) -> Vec<String> {
        let mut ids = Vec::new();
        let mut replaced = false;
        {
            let mut r = self.reg.write().unwrap();
            for h in handles {
                let id = h.info.id.clone();
                match r.by_id.get(&id).copied() {
                    Some(i) => {
                        r.layers[i] = Arc::new(h);
                        replaced = true;
                    }
                    None => {
                        let i = r.layers.len();
                        r.layers.push(Arc::new(h));
                        r.by_id.insert(id.clone(), i);
                    }
                }
                ids.push(id);
            }
        }
        if replaced {
            self.clear_cache();
        }
        ids
    }

    /// Take a layer off the map (its file stays). Returns whether it was there.
    pub fn remove_layer(&self, id: &str) -> bool {
        let removed = {
            let mut r = self.reg.write().unwrap();
            let Some(i) = r.by_id.remove(id) else { return false };
            r.layers.remove(i);
            let ids: Vec<(String, usize)> = r.layers.iter().enumerate().map(|(i, l)| (l.info.id.clone(), i)).collect();
            r.by_id = ids.into_iter().collect();
            true
        };
        // tile cache keys hold registry indices, which just shifted
        self.clear_cache();
        removed
    }

    /// Background services: the device watcher, live GNSS sources and the automation triggers
    /// (device, folder, schedule, after). Adapters call this once after wrapping the engine in an `Arc`.
    pub fn start_services(self: &Arc<Self>) {
        self.automation.start(self); // hooks the device hub before its first scan
        plugins::restore_results(self); // plugin tools' earlier results, as recipe outputs are
        self.devices.start(self.clone());
        self.phone.start_if_enabled(self); // only if switched on before (or --phone)
    }

    /// Layer metadata as served by `GET /api/layers`: the static info plus the
    /// *effective* minzoom (0 once an overview pyramid exists) and overview state.
    pub fn layer_json(&self, l: &LayerHandle) -> serde_json::Value {
        let mut v = serde_json::to_value(&l.info).unwrap_or_default();
        let ov = l.overview();
        v["live_minzoom"] = l.info.minzoom.into();
        if ov.is_some() {
            v["minzoom"] = 0.into();
        }
        v["overview"] = match &ov {
            Some(o) => serde_json::to_value(&o.meta).unwrap_or_default(),
            None => serde_json::Value::Null,
        };
        v["overview_suggested"] = overview::suggested_max_zoom(&l.info).map(serde_json::Value::from).unwrap_or_default();
        v["overview_job"] = self.jobs.active("overviews", &l.info.id).map(|j| j.json()).unwrap_or_default();
        // editing and definition query state (edit.rs)
        v["edited"] = self.is_edited(l).into();
        v["filter"] = l.filter().map(serde_json::Value::from).unwrap_or_default();
        v
    }

    /// Run blocking work on the engine's bounded worker pool. Async adapters
    /// (Axum, Tauri) call this and await a channel, so GDAL never runs on an
    /// async executor thread.
    pub fn spawn<F: FnOnce() + Send + 'static>(&self, f: F) {
        self.pool.spawn(f);
    }

    /// Handle an API request on the right lane and pass the response to `done`.
    /// Data-plane requests (tiles, Arrow, column scans) use the bounded tile pool.
    /// Control-plane requests (jobs, project, layers, stats, log) use a separate small
    /// pool, so job polling and project saves stay fast while the map is busy rendering.
    pub fn dispatch<F>(self: &Arc<Self>, req: router::ApiRequest, done: F)
    where
        F: FnOnce(router::ApiResponse) + Send + 'static,
    {
        let e = Arc::clone(self);
        // the assistant waits on a model for up to minutes: its own thread, never a pool worker
        if req.path.trim_matches('/') == "api/ask" {
            std::thread::spawn(move || done(e.handle(req)));
            return;
        }
        let lane = if req.is_heavy() { &self.pool } else { &self.ctl_pool };
        lane.spawn(move || done(e.handle(req)));
    }

    pub fn clear_cache(&self) {
        if let Some(c) = &self.cache {
            c.lock().unwrap().clear();
        }
    }

    /// Resolve `?fields=a,b` to OGR field indices (None = layer defaults).
    pub fn resolve_fields(&self, layer: &LayerHandle, spec: Option<&str>) -> Result<Option<Vec<usize>>, String> {
        let Some(spec) = spec.filter(|s| !s.is_empty()) else { return Ok(None) };
        let mut idx = Vec::new();
        for name in spec.split(',').map(router::pct_decode) {
            let i = layer.field_index(&name).ok_or_else(|| format!("unknown field '{name}'"))?;
            if !matches!(layer.info.fields[i].kind, "integer" | "real" | "string") {
                return Err(format!("field '{name}' cannot be encoded in tiles"));
            }
            if !idx.contains(&i) {
                idx.push(i);
            }
        }
        if idx.len() > MAX_REQUEST_FIELDS {
            return Err(format!("at most {MAX_REQUEST_FIELDS} fields per tile"));
        }
        idx.sort_unstable();
        Ok(Some(idx))
    }

    /// Tile lookup: overview pyramid (z <= its max zoom) -> LRU cache -> live
    /// render. Returns (tile, cache_hit).
    pub fn tile(&self, layer_id: &str, z: u8, x: u32, y: u32, fields: Option<&str>) -> Result<(Arc<TileResult>, bool), String> {
        let (idx, layer) = {
            let r = self.reg.read().unwrap();
            let idx = *r.by_id.get(layer_id).ok_or_else(|| format!("unknown layer '{layer_id}'"))?;
            (idx, r.layers[idx].clone())
        };
        if z > 24 || x >= (1u32 << z) || y >= (1u32 << z) {
            return Err(format!("invalid tile {z}/{x}/{y}"));
        }
        let layer = &layer;
        if let Some(ov) = layer.overview().filter(|o| z <= o.meta.max_zoom && layer.filter().is_none()) {
            let t0 = Instant::now();
            let bytes = ov.reader.get(z, x, y)?.unwrap_or_default();
            let t = ms(t0);
            let r = Arc::new(TileResult { bytes, read_ms: t, total_ms: t, source: "overview", ..Default::default() });
            self.record(&r, false);
            return Ok((r, false));
        }
        let fields = self.resolve_fields(layer, fields)?;
        let fkey = fields.as_ref().map_or(0, |f| {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            f.hash(&mut h);
            h.finish() | 1
        });
        let key = (idx as u32, z, x, y, fkey);
        if let Some(c) = &self.cache
            && let Some(hit) = c.lock().unwrap().get(&key).cloned() {
                self.record(&hit, true);
                return Ok((hit, true));
            }
        let r = Arc::new(self.render_tile(layer, z, x, y, &RenderOpts { overview: false, fields })?);
        if let Some(c) = &self.cache {
            c.lock().unwrap().put(key, r.clone());
        }
        self.record(&r, false);
        Ok((r, false))
    }

    fn record(&self, r: &TileResult, hit: bool) {
        let mut s = self.stats.lock().unwrap();
        s.tiles += 1;
        s.bytes += r.bytes.len() as u64;
        if r.bytes.is_empty() {
            s.empty += 1;
        }
        if hit {
            s.cache_hits += 1;
        } else if r.source == "overview" {
            s.overview_tiles += 1;
        } else {
            s.features += r.features as u64;
            s.render_ms += r.total_ms;
            s.recent_ms.push_back(r.total_ms);
            if s.recent_ms.len() > 1000 {
                s.recent_ms.pop_front();
            }
        }
    }

    pub fn stats_json(&self) -> serde_json::Value {
        let s = self.stats.lock().unwrap();
        let mut v: Vec<f64> = s.recent_ms.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pct = |p: f64| if v.is_empty() { 0.0 } else { v[((v.len() - 1) as f64 * p).round() as usize] };
        let rendered = s.tiles - s.cache_hits - s.overview_tiles;
        serde_json::json!({
            "uptime_s": self.started.elapsed().as_secs_f64(),
            "workers": self.pool.current_num_threads(),
            "job_workers": self.job_pool.current_num_threads(),
            "reader": self.read_mode.as_str(),
            "gpkg_filtered": self.gpkg_filtered.as_str(),
            "gdal": gdal::version::version_info("RELEASE_NAME"),
            "tiles_served": s.tiles,
            "cache_hits": s.cache_hits,
            "overview_tiles": s.overview_tiles,
            "tiles_rendered": rendered,
            "empty_tiles": s.empty,
            "bytes_served": s.bytes,
            "features_encoded": s.features,
            "render_ms_mean": if rendered > 0 { s.render_ms / rendered as f64 } else { 0.0 },
            "render_ms_p50": pct(0.5),
            "render_ms_p95": pct(0.95),
        })
    }

    /// Render one tile from source (no cache, no overview lookup).
    pub fn render_tile(&self, layer: &LayerHandle, z: u8, x: u32, y: u32, opts: &RenderOpts) -> Result<TileResult, String> {
        let t0 = Instant::now();
        let info = &layer.info;
        let tb = tile::tile_bounds(z, x, y);
        if (!opts.overview && z < info.minzoom) || !tile::intersects(tb, info.bounds) {
            return Ok(TileResult { total_ms: ms(t0), source: "live", ..Default::default() });
        }
        // Buffered filter rect (BUFFER of EXTENT on each side), in lon/lat.
        let f = mvt::BUFFER / mvt::EXTENT as f64;
        let (dw, dh) = ((tb[2] - tb[0]) * f, (tb[3] - tb[1]) * f);
        let rect = [tb[0] - dw, tb[1] - dh, tb[2] + dw, tb[3] + dh];

        let at_max = z >= info.maxzoom;
        let params = if opts.overview {
            // Features under 2 px (16 units) become density points on a 4 px grid.
            mvt::Params { tolerance: 2.0, min_size: 16.0, density_cell: 32.0, points_density: info.geometry == GeomKind::Point }
        } else {
            mvt::Params {
                tolerance: if at_max { 0.5 } else { 2.0 }, // ~0.06 px / 0.25 px at 512 px tiles
                min_size: if at_max { 0.0 } else { 4.0 },  // drop features under ~0.5 px
                ..Default::default()
            }
        };
        let field_idx: Vec<usize> = opts.fields.clone().unwrap_or_else(|| layer.field_idx.clone());
        let keys: Vec<String> = field_idx.iter().map(|&i| info.fields[i].name.clone()).collect();
        let proj = tile::TileProjector::new(z, x, y, mvt::EXTENT);
        let mut enc = mvt::LayerEncoder::new(&info.id, keys);

        let ts = Instant::now();
        let h = layer.checkout()?;
        let mut rt = ReadTimes::default();
        let result = self.read_tile(layer, &h, rect, &field_idx, ts, &mut rt, &mut |fid, geom, attrs| {
            enc.add(fid, attrs, geom, &proj, params);
            enc.count < MAX_FEATURES_PER_TILE
        });
        layer.checkin(h);
        let teardown_ms = rt.teardown_start.map(ms).unwrap_or(0.0);
        result?;

        let te = Instant::now();
        let features = enc.count;
        let density = enc.density.take();
        let mut layers = Vec::with_capacity(2);
        let (mut density_cells, mut density_max) = (0, 0);
        if let Some(d) = &density {
            density_cells = d.cells() as u32;
            density_max = d.max();
            if let Some(l) = d.encode(&format!("{}:density", info.id)) {
                layers.push(l);
            }
        }
        if !enc.is_empty() {
            layers.insert(0, enc.finish());
        }
        let bytes = if layers.is_empty() { Vec::new() } else { mvt::tile(&layers) };
        Ok(TileResult {
            bytes,
            features,
            density_cells,
            density_max,
            scanned: rt.scanned,
            truncated: rt.truncated,
            read_ms: rt.read_ms,
            proc_ms: rt.proc_ms,
            enc_ms: ms(te),
            setup_ms: rt.setup_ms,
            teardown_ms,
            total_ms: ms(t0),
            source: "live",
        })
    }

    /// Stream the features intersecting `rect` (lon/lat) through `sink`
    /// (geometry already in EPSG:4326) until it returns false.
    #[allow(clippy::too_many_arguments)]
    fn read_tile(
        &self,
        layer: &LayerHandle,
        h: &Handle,
        rect: [f64; 4],
        field_idx: &[usize],
        ts: Instant,
        rt: &mut ReadTimes,
        sink: &mut dyn FnMut(Option<u64>, &wkb::Geom, Vec<(u32, mvt::Val)>) -> bool,
    ) -> Result<(), String> {
        let mut lyr = h.ds.layer_by_name(&layer.layer_name).map_err(|e| e.to_string())?;
        let r = match &h.from_wgs84 {
            Some(ct) => ct.0.transform_bounds(&rect, 21).map_err(|e| e.to_string())?,
            None => rect,
        };
        // A filter that covers the whole layer is pointless, and it is also
        // harmful: GDAL 3.10's GPKG driver then swaps the R-tree for an
        // ST_EnvIntersects() SQL filter, which crashes inside its asynchronous
        // Arrow worker thread. Clearing it selects the fast whole-table scan.
        let covers_layer = layer.native_bounds.is_some_and(|b| r[0] <= b[0] && r[1] <= b[1] && r[2] >= b[2] && r[3] >= b[3]);
        if covers_layer {
            lyr.clear_spatial_filter();
        } else {
            lyr.set_spatial_filter_rect(r[0], r[1], r[2], r[3]);
        }
        if layer.filter().is_some() {
            // a definition query may test any field: drivers evaluating it themselves need the
            // fields it names, so read them all (still only `field_idx` goes into the tile)
            let all: Vec<usize> = (0..layer.info.fields.len()).collect();
            reader::set_ignored_fields(&lyr, &all, false)?;
        } else {
            reader::set_ignored_fields(&lyr, field_idx, false)?;
        }
        rt.setup_ms = ms(ts);
        let to_wgs84 = h.to_wgs84.as_ref();
        let (mut read_ms, mut proc_ms, mut truncated) = (0.0, 0.0, false);
        let mut tr = Instant::now();
        let mut row = |fid: Option<u64>, wkb_bytes: &[u8], attrs: Vec<(u32, mvt::Val)>| -> bool {
            read_ms += ms(tr); // time since the previous row returned = GDAL read cost
            let tp = Instant::now();
            let mut more = true;
            if let Ok(mut geom) = wkb::parse(wkb_bytes)
                && to_wgs84.is_none_or(|ct| transform_geom(&mut geom, &ct.0)) {
                    more = sink(fid, &geom, attrs);
                }
            proc_ms += ms(tp);
            truncated |= !more;
            tr = Instant::now();
            more
        };
        let gpkg_workaround =
            if !covers_layer && layer.info.driver == "GPKG" { self.gpkg_filtered } else { GpkgFiltered::Async };
        let mode = match (self.read_mode, gpkg_workaround) {
            (ReadMode::Arrow, GpkgFiltered::Features) => ReadMode::Features,
            (m, _) => m,
        };
        let scanned = match mode {
            ReadMode::Arrow => {
                let named: Vec<(u32, String)> =
                    field_idx.iter().enumerate().map(|(k, &i)| (k as u32, layer.info.fields[i].name.clone())).collect();
                if gpkg_workaround == GpkgFiltered::Base {
                    // thread-local: only this read on this thread is affected
                    let _ = gdal::config::set_thread_local_config_option("OGR_GPKG_STREAM_BASE_IMPL", "YES");
                }
                let r = reader::for_each_arrow(&mut lyr, &named, &mut row);
                if gpkg_workaround == GpkgFiltered::Base {
                    let _ = gdal::config::clear_thread_local_config_option("OGR_GPKG_STREAM_BASE_IMPL");
                }
                r?
            }
            ReadMode::Features => {
                let idx: Vec<(u32, usize)> = field_idx.iter().enumerate().map(|(k, &i)| (k as u32, i)).collect();
                reader::for_each_feature(&mut lyr, &idx, &mut row)?
            }
        };
        read_ms += ms(tr); // end-of-stream detection
        rt.read_ms = read_ms;
        rt.proc_ms = proc_ms;
        rt.truncated = truncated;
        rt.scanned = scanned;
        rt.teardown_start = Some(Instant::now());
        Ok(())
    }

    /// A window of attribute rows for the attribute table (Pro-style): every field of
    /// the layer plus a bbox per row, so the table can page and zoom without holding the
    /// whole layer in memory.
    pub fn rows(&self, layer: &LayerHandle, offset: usize, limit: usize) -> Result<RowsPage, String> {
        let h = layer.checkout()?;
        let res = (|| {
            let mut lyr = h.ds.layer_by_name(&layer.layer_name).map_err(|e| e.to_string())?;
            // Handles are pooled: a tile read may have left a spatial filter on this layer,
            // which would silently shrink the table to one tile's worth of features.
            lyr.clear_spatial_filter();
            let idx: Vec<(u32, usize)> = layer.field_idx.iter().enumerate().map(|(k, &i)| (k as u32, i)).collect();
            let names: Vec<String> = layer
                .field_idx
                .iter()
                .map(|&i| layer.info.fields.get(i).map(|f| f.name.clone()).unwrap_or_default())
                .collect();
            let mut page = RowsPage { total: layer.info.feature_count as usize, offset, fields: names, rows: Vec::new() };
            let mut n = 0usize;
            let r = reader::for_each_feature(&mut lyr, &idx, &mut |fid: Option<u64>, wkb: &[u8], attrs: Vec<(u32, mvt::Val)>| {
                if n >= offset && page.rows.len() < limit {
                    let values = attrs
                        .into_iter()
                        .map(|(_, v)| match v {
                            mvt::Val::Str(s) => serde_json::Value::String(s),
                            mvt::Val::Int(i) => serde_json::Value::from(i),
                            mvt::Val::Dbl(d) => serde_json::Value::from(d),
                        })
                        .collect();
                    page.rows.push(Row { fid: fid.unwrap_or(n as u64), bbox: wkb::bbox(wkb), values });
                }
                n += 1;
                page.rows.len() < limit // stop reading once the window is full
            });
            let _ = reader::set_ignored_fields(&lyr, &layer.field_idx, false);
            r?;
            Ok(page)
        })();
        layer.checkin(h);
        res
    }

    /// All values of one attribute (Arrow scan, geometry ignored).
    pub fn scan_column(&self, layer: &LayerHandle, field_idx: usize) -> Result<reader::ColumnValues, String> {
        let h = layer.checkout()?;
        let res = (|| {
            let mut lyr = h.ds.layer_by_name(&layer.layer_name).map_err(|e| e.to_string())?;
            let r = reader::scan_column(&mut lyr, field_idx);
            // restore: geometry back on for the next tile read on this handle
            let _ = reader::set_ignored_fields(&lyr, &layer.field_idx, false);
            r
        })();
        layer.checkin(h);
        res
    }
}
