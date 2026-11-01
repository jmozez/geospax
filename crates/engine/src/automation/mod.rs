//! Automation engine v0 (docs/AUTOMATION.md): recipes, a dependency-ordered runner, triggers and
//! the built-in steps that make "maps make themselves" real.
//!
//! * A **recipe** is YAML: inputs, triggers and steps (`recipe.rs`).
//! * A **run** executes the steps in dependency order on its own thread, records what each step
//!   did and why, and writes artifacts to `<state>/runs/<run-id>/` (this file).
//! * **Triggers** start runs when a device is plugged in, files arrive, a schedule fires or
//!   another recipe finishes (`triggers.rs`).
//! * **Steps** do the work: import, analysis, AutoMap styling, layout/export, report, R/Python
//!   (`steps.rs`, `automap.rs`, `cartography.rs`, `report.rs`, `sidecar.rs`).

pub mod automap;
pub mod providers;
pub mod raster_steps;
pub mod cartography;
pub mod charts;
pub mod data_steps;
pub mod detect_steps;
pub mod taxa_steps;
pub mod embed_steps;
pub mod tool_step;
pub mod cli;
pub mod features;
pub mod furniture;
pub mod hydro_steps;
pub mod lidar_steps;
pub mod recipe;
pub mod report;
pub mod report_docx;
pub mod scene_steps;
pub mod sidecar;
pub mod stats_steps;
pub mod steps;
pub mod triggers;
pub mod zonal_steps;
pub mod combine_steps;

use crate::jobs::{Job, Status};
use crate::Engine;
use recipe::{Origin, Recipe, Trigger};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

/// Recipes shipped with GeoSpaX (`recipes/` at the repository root).
pub const GALLERY: &[(&str, &str)] = &[
    ("photos-to-map", include_str!("../../../../recipes/photos-to-map.yaml")),
    ("track-to-map", include_str!("../../../../recipes/track-to-map.yaml")),
    ("drone-flight-report", include_str!("../../../../recipes/drone-flight-report.yaml")),
    ("points-to-hexbins", include_str!("../../../../recipes/points-to-hexbins.yaml")),
    ("zonal-statistics", include_str!("../../../../recipes/zonal-statistics.yaml")),
    ("combine-layers", include_str!("../../../../recipes/combine-layers.yaml")),
    ("values-at-points", include_str!("../../../../recipes/values-at-points.yaml")),
    ("check-topology", include_str!("../../../../recipes/check-topology.yaml")),
    ("points-to-hotspots", include_str!("../../../../recipes/points-to-hotspots.yaml")),
    ("interpolate-samples", include_str!("../../../../recipes/interpolate-samples.yaml")),
    ("python-spatial-stats", include_str!("../../../../recipes/python-spatial-stats.yaml")),
    ("r-kriging", include_str!("../../../../recipes/r-kriging.yaml")),
    ("terrain-report", include_str!("../../../../recipes/terrain-report.yaml")),
    ("lidar-to-terrain", include_str!("../../../../recipes/lidar-to-terrain.yaml")),
    ("latest-ndvi", include_str!("../../../../recipes/latest-ndvi.yaml")),
    ("landforms-grass", include_str!("../../../../recipes/landforms-grass.yaml")),
    ("wetness-saga", include_str!("../../../../recipes/wetness-saga.yaml")),
    ("sensor-log-to-map", include_str!("../../../../recipes/sensor-log-to-map.yaml")),
    ("air-quality-alert", include_str!("../../../../recipes/air-quality-alert.yaml")),
    // domain kits (Biodiversity, Climate, Conservation, Forestry, Land cover, Agriculture, Disaster, Soil)
    ("kit-species-distribution", include_str!("../../../../recipes/kit-species-distribution.yaml")),
    ("kit-climate-range-shift", include_str!("../../../../recipes/kit-climate-range-shift.yaml")),
    ("kit-survey-diversity", include_str!("../../../../recipes/kit-survey-diversity.yaml")),
    ("kit-protection-gaps", include_str!("../../../../recipes/kit-protection-gaps.yaml")),
    ("kit-forest-fragmentation", include_str!("../../../../recipes/kit-forest-fragmentation.yaml")),
    ("kit-land-cover-change", include_str!("../../../../recipes/kit-land-cover-change.yaml")),
    ("kit-vegetation-change", include_str!("../../../../recipes/kit-vegetation-change.yaml")),
    ("kit-steep-slopes", include_str!("../../../../recipes/kit-steep-slopes.yaml")),
    ("kit-soil-properties", include_str!("../../../../recipes/kit-soil-properties.yaml")),
    ("kit-ndvi-year-change", include_str!("../../../../recipes/kit-ndvi-year-change.yaml")),
    ("kit-burn-severity", include_str!("../../../../recipes/kit-burn-severity.yaml")),
];

#[derive(Debug, Clone, Default)]
pub struct AutomationConfig {
    /// Extra folders with recipes (*.yaml, *.yml, *.json).
    pub recipe_dirs: Vec<PathBuf>,
    /// Recipes whose triggers are on from the start (`all` = every recipe).
    pub auto: Vec<String>,
    /// Run the trigger service (device, folder, schedule, after).
    pub triggers: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepRecord {
    pub id: String,
    #[serde(rename = "use")]
    pub uses: String,
    pub title: String,
    pub status: &'static str,
    pub ms: f64,
    pub why: Vec<String>,
    pub outputs: Value,
    pub error: Option<String>,
}

#[derive(Default)]
struct RunState {
    steps: Vec<StepRecord>,
    outputs: Value,
    artifacts: Vec<String>,
    layers: Vec<String>,
    rasters: Vec<String>,
    styles: Map<String, Value>,
    extent: Option<[f64; 4]>,
    error: Option<String>,
    finished_at: Option<String>,
}

pub struct Run {
    pub id: String,
    pub recipe: Arc<Recipe>,
    pub dir: PathBuf,
    pub job: Arc<Job>,
    pub inputs: Map<String, Value>,
    pub trigger: Value,
    pub started_at: String,
    state: Mutex<RunState>,
}

impl Run {
    fn set_step(&self, n: usize, f: impl FnOnce(&mut StepRecord)) {
        if let Some(r) = self.state.lock().unwrap().steps.get_mut(n) {
            f(r);
        }
    }

    fn record(&self, n: usize) -> Option<StepRecord> {
        self.state.lock().unwrap().steps.get(n).cloned()
    }

    fn records_json(&self) -> Vec<Value> {
        self.state.lock().unwrap().steps.iter().map(|s| serde_json::to_value(s).unwrap_or_default()).collect()
    }

    pub fn status(&self) -> Status {
        self.job.status()
    }

    pub fn json(&self) -> Value {
        let s = self.state.lock().unwrap();
        let j = self.job.json();
        let current = s.steps.iter().find(|r| r.status == "running").map(|r| r.title.clone());
        json!({
            "id": self.id,
            "recipe": self.recipe.id,
            "title": self.recipe.title,
            "status": j["status"],
            "progress": j["progress"],
            "elapsed_ms": j["elapsed_ms"],
            "message": j["message"],
            "transfer": j["transfer"],
            "current": current,
            "trigger": self.trigger,
            "inputs": self.inputs,
            "started_at": self.started_at,
            "finished_at": s.finished_at,
            "steps": s.steps,
            "outputs": s.outputs,
            "artifacts": s.artifacts,
            "layers": s.layers,
            "rasters": s.rasters,
            "styles": s.styles,
            "extent": s.extent,
            "error": s.error,
            "dir": self.dir,
            "job": self.job.id,
        })
    }

    fn save(&self) {
        let v = self.json();
        let _ = std::fs::write(self.dir.join("run.json"), serde_json::to_vec_pretty(&v).unwrap_or_default());
    }
}

pub struct Automation {
    cfg: AutomationConfig,
    state_dir: PathBuf,
    recipes: RwLock<Vec<Arc<Recipe>>>,
    load_errors: Mutex<Vec<String>>,
    enabled: Mutex<BTreeSet<String>>,
    runs: Mutex<VecDeque<Arc<Run>>>,
    history: Mutex<Vec<Value>>,
    active: Mutex<HashMap<String, Arc<Run>>>,
    /// Runs requested while a recipe was busy: one per distinct input set, in order.
    pending: Mutex<HashMap<String, VecDeque<(Map<String, Value>, Value)>>>,
    started: AtomicBool,
    /// Sensor triggers per (recipe, trigger index, live device): (inside the geofence, last fired).
    sensor_state: Mutex<HashMap<(String, usize, String), (bool, Option<Instant>)>>,
    /// Geofence polygons per layer id, re-read after a minute (a re-run may replace the layer).
    fences: Mutex<HashMap<String, (Instant, Arc<Vec<Vec<Vec<[f64; 2]>>>>)>>,
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pdf" => "application/pdf",
        "html" => "text/html; charset=utf-8",
        "json" => "application/json",
        "glb" => "model/gltf-binary",
        "geojson" => "application/geo+json",
        "gpkg" => "application/geopackage+sqlite3",
        "csv" => "text/csv; charset=utf-8",
        "kml" => "application/vnd.google-earth.kml+xml",
        "yaml" | "yml" => "text/yaml; charset=utf-8",
        "txt" | "py" | "r" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn safe_name(s: &str) -> bool {
    !s.is_empty() && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl Automation {
    /// Area and scene of the last successful run of a recipe (written by execute()).
    pub fn memo(&self, recipe: &str) -> Value {
        std::fs::read(self.state_dir.join("memo").join(format!("{recipe}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
    }

    pub fn new(cfg: AutomationConfig, state_dir: &Path) -> Automation {
        let a = Automation {
            cfg,
            state_dir: state_dir.to_path_buf(),
            recipes: RwLock::new(Vec::new()),
            load_errors: Mutex::new(Vec::new()),
            enabled: Mutex::new(BTreeSet::new()),
            runs: Mutex::new(VecDeque::new()),
            history: Mutex::new(Vec::new()),
            active: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            started: AtomicBool::new(false),
            sensor_state: Mutex::new(HashMap::new()),
            fences: Mutex::new(HashMap::new()),
        };
        a.reload();
        a.load_enabled();
        a.load_history();
        a
    }

    fn user_dir(&self) -> PathBuf {
        self.state_dir.join("recipes")
    }

    /// (Re)load gallery, user and configured recipes. Later sources override earlier ones by id.
    pub fn reload(&self) {
        let mut list: Vec<Arc<Recipe>> = Vec::new();
        let mut errors = Vec::new();
        let mut add = |r: Recipe| {
            list.retain(|x| x.id != r.id);
            list.push(Arc::new(r));
        };
        for (name, text) in GALLERY {
            match Recipe::parse(text, Origin::Gallery) {
                Ok(r) => add(r),
                Err(e) => errors.push(format!("gallery recipe {name}: {}", e.join("; "))),
            }
        }
        let mut dirs = vec![(self.user_dir(), true)];
        dirs.extend(self.cfg.recipe_dirs.iter().map(|d| (d.clone(), false)));
        for (dir, user) in dirs {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml" | "json"))).collect();
            paths.sort();
            for p in paths {
                let text = std::fs::read_to_string(&p).unwrap_or_default();
                let origin = if user { Origin::User(p.clone()) } else { Origin::File(p.clone()) };
                match Recipe::parse(&text, origin) {
                    Ok(r) => add(r),
                    Err(e) => errors.push(format!("{}: {}", p.display(), e.join("; "))),
                }
            }
        }
        for e in &errors {
            eprintln!("automation: {e}");
        }
        *self.recipes.write().unwrap() = list;
        *self.load_errors.lock().unwrap() = errors;
    }

    pub fn recipes(&self) -> Vec<Arc<Recipe>> {
        self.recipes.read().unwrap().clone()
    }

    pub fn recipe(&self, id: &str) -> Option<Arc<Recipe>> {
        self.recipes.read().unwrap().iter().find(|r| r.id == id).cloned()
    }

    /// Register a recipe for this session (e.g. a file given to `geospax run`).
    pub fn add(&self, r: Recipe) -> Arc<Recipe> {
        let r = Arc::new(r);
        let mut list = self.recipes.write().unwrap();
        list.retain(|x| x.id != r.id);
        list.push(r.clone());
        r
    }

    /// Parse plus static checks of every step. Ok = (recipe, warnings).
    pub fn validate(&self, text: &str, origin: Origin) -> Result<(Recipe, Vec<String>), Vec<String>> {
        let (r, mut errs) = Recipe::parse_all(text, origin);
        let Some(r) = r else { return Err(errs) };
        let mut warns = Vec::new();
        for s in &r.steps {
            let (e, w) = steps::check(&s.uses, &s.with);
            errs.extend(e.into_iter().map(|x| format!("step '{}': {x}", s.id)));
            warns.extend(w.into_iter().map(|x| format!("step '{}': {x}", s.id)));
        }
        for t in &r.triggers {
            match t {
                Trigger::After { recipe } if recipe == &r.id => errs.push("a recipe cannot trigger itself".into()),
                Trigger::After { recipe } if self.recipe(recipe).is_none() => warns.push(format!("after: no recipe '{recipe}' is installed yet")),
                Trigger::Folder { path, .. } if !Path::new(path).is_dir() => warns.push(format!("folder {path} does not exist yet; the trigger waits for it")),
                _ => {}
            }
        }
        if errs.is_empty() { Ok((r, warns)) } else { Err(errs) }
    }

    /// Steps in execution order with what each depends on.
    pub fn plan(r: &Recipe) -> Vec<Value> {
        let order = r.order().unwrap_or_default();
        order
            .iter()
            .map(|&i| {
                let s = &r.steps[i];
                let mut refs = Vec::new();
                recipe::refs_in(&s.with, &mut refs);
                let mut after: Vec<String> = refs.iter().filter_map(|h| h.split('.').next()).filter(|h| r.steps.iter().any(|o| o.id == *h)).map(str::to_string).collect();
                after.extend(s.needs.iter().cloned());
                after.sort();
                after.dedup();
                json!({ "id": s.id, "use": s.uses, "after": after, "summary": steps::spec(&s.uses).map(|x| x.summary) })
            })
            .collect()
    }

    /// Save a recipe to `<state>/recipes/<id>.yaml` (replacing a user recipe with the same id).
    pub fn save_user(&self, text: &str) -> Result<(Arc<Recipe>, Vec<String>), Vec<String>> {
        let (r, warns) = self.validate(text, Origin::Api)?;
        if let Some(existing) = self.recipe(&r.id)
            && existing.origin == Origin::Gallery {
                return Err(vec![format!("'{}' is a gallery recipe; save yours under another id", r.id)]);
            }
        let dir = self.user_dir();
        let path = dir.join(format!("{}.yaml", r.id));
        std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, text)).map_err(|e| vec![format!("{}: {e}", path.display())])?;
        let r = Recipe { origin: Origin::User(path), ..r };
        Ok((self.add(r), warns))
    }

    pub fn delete_user(&self, id: &str) -> Result<(), String> {
        let r = self.recipe(id).ok_or_else(|| format!("unknown recipe '{id}'"))?;
        let Origin::User(path) = &r.origin else { return Err(format!("'{id}' is not a user recipe")) };
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        self.recipes.write().unwrap().retain(|x| x.id != id);
        let _ = self.set_enabled(id, false);
        Ok(())
    }

    // -------------------------------------------------------------- trigger switches

    fn load_enabled(&self) {
        let mut set: BTreeSet<String> = std::fs::read(self.state_dir.join("automation.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v["enabled"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()))
            .unwrap_or_default();
        for a in &self.cfg.auto {
            if a == "all" {
                set.extend(self.recipes().iter().filter(|r| !r.triggers.is_empty()).map(|r| r.id.clone()));
            } else {
                set.insert(a.clone());
            }
        }
        *self.enabled.lock().unwrap() = set;
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.enabled.lock().unwrap().contains(id)
    }

    pub fn set_enabled(&self, id: &str, on: bool) -> Result<(), String> {
        if on && self.recipe(id).is_none() {
            return Err(format!("unknown recipe '{id}'"));
        }
        let list: Vec<String> = {
            let mut set = self.enabled.lock().unwrap();
            if on {
                set.insert(id.to_string());
            } else {
                set.remove(id);
            }
            set.iter().cloned().collect()
        };
        std::fs::create_dir_all(&self.state_dir).map_err(|e| e.to_string())?;
        std::fs::write(self.state_dir.join("automation.json"), serde_json::to_vec_pretty(&json!({ "enabled": list })).unwrap_or_default()).map_err(|e| e.to_string())
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.active.lock().unwrap().contains_key(id)
    }

    /// The recipe whose webhook trigger uses this token, and whether it is switched on.
    pub fn by_webhook(&self, token: &str) -> Option<(Arc<Recipe>, bool)> {
        let enabled: Vec<String> = self.enabled_recipes().iter().map(|r| r.id.clone()).collect();
        self.recipes().into_iter().find(|r| r.triggers.iter().any(|t| matches!(t, Trigger::Webhook { token: tk } if tk == token))).map(|r| {
            let on = enabled.contains(&r.id);
            (r, on)
        })
    }

    pub fn enabled_recipes(&self) -> Vec<Arc<Recipe>> {
        self.recipes().into_iter().filter(|r| self.is_enabled(&r.id) && !r.triggers.is_empty()).collect()
    }

    // -------------------------------------------------------------- runs

    fn load_history(&self) {
        let Ok(rd) = std::fs::read_dir(self.state_dir.join("runs")) else { return };
        let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join("run.json").exists()).collect();
        dirs.sort();
        dirs.reverse();
        let mut out = Vec::new();
        for d in dirs.into_iter().take(50) {
            if let Ok(mut v) = serde_json::from_slice::<Value>(&std::fs::read(d.join("run.json")).unwrap_or_default()) {
                if matches!(v["status"].as_str(), Some("running" | "queued")) {
                    v["status"] = "interrupted".into();
                }
                v["previous_session"] = true.into();
                out.push(v);
            }
        }
        *self.history.lock().unwrap() = out;
    }

    pub fn runs_json(&self, limit: usize) -> Vec<Value> {
        let mut out: Vec<Value> = self.runs.lock().unwrap().iter().rev().map(|r| r.json()).collect();
        let active: Vec<Value> = self.active.lock().unwrap().values().map(|r| r.json()).collect();
        for a in active {
            if !out.iter().any(|r| r["id"] == a["id"]) {
                out.insert(0, a);
            }
        }
        for h in self.history.lock().unwrap().iter() {
            if !out.iter().any(|r| r["id"] == h["id"]) {
                out.push(h.clone());
            }
        }
        out.truncate(limit);
        out
    }

    pub fn run(&self, id: &str) -> Option<Arc<Run>> {
        if let Some(r) = self.active.lock().unwrap().values().find(|r| r.id == id) {
            return Some(r.clone());
        }
        self.runs.lock().unwrap().iter().find(|r| r.id == id).cloned()
    }

    pub fn run_json(&self, id: &str) -> Option<Value> {
        self.run(id).map(|r| r.json()).or_else(|| self.history.lock().unwrap().iter().find(|h| h["id"] == id).cloned())
    }

    pub fn last_run(&self, recipe: &str) -> Option<Value> {
        self.runs_json(200).into_iter().find(|r| r["recipe"] == recipe)
    }

    /// Forget a finished run: its folder (map, report, log) and its row in the history. Layers it
    /// added to the map are separate files and stay where they are.
    pub fn delete_run(&self, id: &str) -> Result<(), String> {
        if !safe_name(id) {
            return Err("bad run id".into());
        }
        if self.active.lock().unwrap().values().any(|r| r.id == id) {
            return Err("this run is still going: stop it first".into());
        }
        let dir = self.state_dir.join("runs").join(id);
        let known = self.run_json(id).is_some() || dir.is_dir();
        if !known {
            return Err(format!("no run {id}"));
        }
        self.runs.lock().unwrap().retain(|r| r.id != id);
        self.history.lock().unwrap().retain(|h| h["id"] != id);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        Ok(())
    }

    /// Read an artifact of a run (`<state>/runs/<run>/<name>`).
    pub fn artifact(&self, run: &str, name: &str) -> Result<(Vec<u8>, &'static str), String> {
        if !safe_name(run) || !safe_name(name) {
            return Err("bad artifact path".into());
        }
        let p = self.state_dir.join("runs").join(run).join(name);
        std::fs::read(&p).map(|b| (b, content_type(name))).map_err(|_| format!("no artifact {name} in run {run}"))
    }

    fn create_run(&self, engine: &Arc<Engine>, recipe: Arc<Recipe>, inputs: Map<String, Value>, mut trigger: Value) -> Result<Arc<Run>, String> {
        let now = chrono::Local::now();
        let base = self.state_dir.join("runs");
        let stamp = now.format("%Y%m%d-%H%M%S").to_string();
        let mut id = format!("{stamp}-{}", recipe.id);
        let mut n = 1;
        // the folder is created right away, so its existence alone keeps ids unique (and this
        // runs under the `active` lock in start_run: it must not lock `active` again)
        while base.join(&id).exists() {
            n += 1;
            id = format!("{stamp}-{}-{n}", recipe.id);
        }
        let dir = base.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let _ = std::fs::write(dir.join("recipe.yaml"), &recipe.text);
        if trigger.is_null() {
            trigger = json!({ "kind": "manual", "text": "run by hand" });
        }
        let job = engine.jobs.create("recipe", &recipe.id);
        job.update(|s| s.total = recipe.steps.len() as u64);
        let order = recipe.order().unwrap_or_else(|_| (0..recipe.steps.len()).collect());
        let steps = order
            .iter()
            .map(|&i| {
                let s = &recipe.steps[i];
                StepRecord {
                    id: s.id.clone(),
                    uses: s.uses.clone(),
                    title: s.title.clone().unwrap_or_else(|| steps::spec(&s.uses).map(|x| x.running.to_string()).unwrap_or_else(|| s.uses.clone())),
                    status: "pending",
                    ms: 0.0,
                    why: vec![],
                    outputs: Value::Null,
                    error: None,
                }
            })
            .collect();
        Ok(Arc::new(Run {
            id,
            recipe,
            dir,
            job,
            inputs,
            trigger,
            started_at: now.to_rfc3339(),
            state: Mutex::new(RunState { steps, ..Default::default() }),
        }))
    }

    /// Start a run on its own thread. If the recipe is already running, one re-run is queued.
    pub fn start_run(&self, engine: &Arc<Engine>, id: &str, given: Map<String, Value>, trigger: Value) -> Result<Arc<Run>, String> {
        let recipe = self.recipe(id).ok_or_else(|| format!("unknown recipe '{id}'"))?;
        let inputs = recipe.bind_inputs(&given)?;
        let run = {
            let mut active = self.active.lock().unwrap();
            if let Some(r) = active.get(id) {
                let mut pending = self.pending.lock().unwrap();
                let q = pending.entry(id.to_string()).or_default();
                if let Some(i) = q.iter().position(|(g, _)| *g == given) {
                    q[i].1 = trigger; // same inputs: one re-run is enough
                } else if q.len() < 20 {
                    q.push_back((given, trigger));
                }
                return Err(format!("'{id}' is already running (run {}); queued to run again when it finishes", r.id));
            }
            let run = self.create_run(engine, recipe, inputs, trigger)?;
            active.insert(id.to_string(), run.clone());
            run
        };
        let (e, r) = (engine.clone(), run.clone());
        std::thread::Builder::new()
            .name(format!("recipe-{id}"))
            .spawn(move || {
                e.automation.execute(&e, &r, None);
                e.automation.finished(&e, &r);
            })
            .map_err(|x| x.to_string())?;
        Ok(run)
    }

    /// A quick look at a finished map before making it (Finish my map's preview): `style.apply` with
    /// `styles`, then `export.map` with `map` at low resolution, PNG only, in a temporary folder.
    /// Nothing is added to the run history.
    /// `"format": "svg"` returns the page as SVG instead (the live layout window: sharp at any zoom).
    pub fn preview_map(&self, engine: &Arc<Engine>, body: &Value) -> Result<Vec<u8>, String> {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = engine.state_dir.join("preview").join(format!("{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let (trigger, inputs) = (json!({ "kind": "preview" }), Map::new());
        let mut sc = steps::StepCtx::new(engine, "finished-map", "Preview", "", "preview", &dir, &cancel, &trigger, &inputs);
        let result = (|| {
            if let Some(st) = body.get("styles").filter(|v| v.is_object()) {
                sc.step_id = "style".into();
                steps::execute(&mut sc, "style.apply", &json!({ "styles": st, "save": false }))?;
            }
            let mut p = body.get("map").cloned().unwrap_or_else(|| json!({}));
            let o = p.as_object_mut().ok_or("map: expected the export.map parameters")?;
            let svg = body.get("format").and_then(Value::as_str) == Some("svg");
            o.insert("format".into(), json!([if svg { "svg" } else { "png" }]));
            o.insert("name".into(), json!("preview"));
            o.insert("dpi".into(), json!(body.get("dpi").and_then(Value::as_f64).unwrap_or(60.0).clamp(36.0, 150.0)));
            o.remove("to");
            sc.step_id = "map".into();
            steps::execute(&mut sc, "export.map", &p)?;
            std::fs::read(dir.join(if svg { "preview.svg" } else { "preview.png" })).map_err(|e| e.to_string())
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    /// Run in the calling thread (CLI). `progress` sees each finished step.
    pub fn run_blocking(&self, engine: &Arc<Engine>, id: &str, given: Map<String, Value>, trigger: Value, progress: &dyn Fn(&StepRecord, usize, usize)) -> Result<Arc<Run>, String> {
        let recipe = self.recipe(id).ok_or_else(|| format!("unknown recipe '{id}'"))?;
        let inputs = recipe.bind_inputs(&given)?;
        let run = self.create_run(engine, recipe, inputs, trigger)?;
        self.active.lock().unwrap().insert(id.to_string(), run.clone());
        self.execute(engine, &run, Some(progress));
        self.finished(engine, &run);
        Ok(run)
    }

    fn execute(&self, engine: &Arc<Engine>, run: &Arc<Run>, progress: Option<&dyn Fn(&StepRecord, usize, usize)>) {
        run.job.update(|s| s.status = Status::Running);
        let t0 = Instant::now();
        let recipe = run.recipe.clone();
        let order = recipe.order().unwrap_or_else(|_| (0..recipe.steps.len()).collect());
        let now = chrono::Local::now();
        let run_meta = json!({
            "id": run.id, "date": now.format("%Y-%m-%d").to_string(), "time": now.format("%H:%M").to_string(),
            "datetime": now.to_rfc3339(), "dir": run.dir,
        });
        let mut outs: HashMap<String, Value> = HashMap::new();
        let mut sc = steps::StepCtx::new(engine, &recipe.id, &recipe.title, &recipe.text, &run.id, &run.dir, &run.job.cancel, &run.trigger, &run.inputs);
        sc.job = Some(run.job.clone());
        let total = order.len();
        let mut failure: Option<String> = None;
        for (n, &i) in order.iter().enumerate() {
            let step = &recipe.steps[i];
            if failure.is_some() {
                run.set_step(n, |r| {
                    r.status = "skipped";
                    r.why = vec!["not run: an earlier step failed".into()];
                });
                continue;
            }
            if run.job.cancel.load(Ordering::Relaxed) {
                failure = Some("cancelled".into());
                run.set_step(n, |r| r.status = "skipped");
                continue;
            }
            run.set_step(n, |r| r.status = "running");
            let title = run.record(n).map(|r| r.title).unwrap_or_default();
            run.job.update(|s| {
                s.done = n as u64;
                s.message = format!("{}/{total} {title}", n + 1);
            });
            let ctx = recipe::Ctx { inputs: &run.inputs, run: &run_meta, recipe: &recipe.id, trigger: &run.trigger, steps: &outs };
            if let Some(w) = &step.when {
                match recipe::resolve(w, &ctx) {
                    Ok(v) if !recipe::truthy(&v) => {
                        run.set_step(n, |r| {
                            r.status = "skipped";
                            r.why = vec![format!("skipped: condition {} is false", recipe::value_text(w))];
                        });
                        outs.insert(step.id.clone(), json!({ "skipped": true }));
                        if let (Some(cb), Some(rec)) = (progress, run.record(n)) {
                            cb(&rec, n, total);
                        }
                        continue;
                    }
                    Err(e) => {
                        run.set_step(n, |r| {
                            r.status = "failed";
                            r.error = Some(e.clone());
                        });
                        failure = Some(format!("step '{}': {e}", step.id));
                        continue;
                    }
                    _ => {}
                }
            }
            let params = match recipe::resolve(&step.with, &ctx) {
                Ok(p) => p,
                Err(e) => {
                    run.set_step(n, |r| {
                        r.status = "failed";
                        r.error = Some(e.clone());
                    });
                    failure = Some(format!("step '{}': {e}", step.id));
                    if let (Some(cb), Some(rec)) = (progress, run.record(n)) {
                        cb(&rec, n, total);
                    }
                    continue;
                }
            };
            sc.step_id = step.id.clone();
            sc.records = run.records_json();
            let t = Instant::now();
            let res = std::panic::catch_unwind(AssertUnwindSafe(|| steps::execute(&mut sc, &step.uses, &params)));
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            match res {
                Ok(Ok(out)) => {
                    run.set_step(n, |r| {
                        r.status = "done";
                        r.ms = ms;
                        r.why = out.why.clone();
                        r.outputs = out.outputs.clone();
                    });
                    outs.insert(step.id.clone(), out.outputs);
                }
                Ok(Err(e)) => {
                    run.set_step(n, |r| {
                        r.status = "failed";
                        r.ms = ms;
                        r.error = Some(e.clone());
                    });
                    failure = Some(format!("step '{}' ({}) failed: {e}", step.id, step.uses));
                }
                Err(p) => {
                    let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into());
                    run.set_step(n, |r| {
                        r.status = "failed";
                        r.ms = ms;
                        r.error = Some(format!("internal error: {msg}"));
                    });
                    failure = Some(format!("step '{}' crashed: {msg}", step.id));
                }
            }
            if let (Some(cb), Some(rec)) = (progress, run.record(n)) {
                cb(&rec, n, total);
            }
            run.save();
        }
        let outputs: Map<String, Value> = if recipe.outputs.is_empty() {
            outs.clone().into_iter().collect()
        } else {
            recipe.outputs.iter().filter_map(|k| outs.get(k).map(|v| (k.clone(), v.clone()))).collect()
        };
        let extent = sc.extent.or_else(|| sc.touched.iter().filter_map(|id| engine.layer(id)).fold(None, |a, l| features::union_bounds(a, Some(l.info.bounds))));
        {
            let mut s = run.state.lock().unwrap();
            s.artifacts = sc.artifacts.clone();
            s.layers = sc.touched.clone();
            s.rasters = sc.rasters.clone();
            s.extent = extent;
            s.styles = sc.styles.iter().map(|(k, (st, _, _))| (k.clone(), st.clone())).collect();
            s.outputs = Value::Object(outputs);
            s.error = failure.clone();
            s.finished_at = Some(chrono::Local::now().to_rfc3339());
        }
        // what this run looked at (area, satellite scene): the stac trigger compares new passes to it
        if failure.is_none() && (sc.aoi.is_some() || !sc.scenes.is_empty()) {
            let memo = json!({
                "aoi": sc.aoi, "run": run.id, "at": chrono::Local::now().to_rfc3339(),
                "scene": sc.scenes.first().map(|s| json!({ "id": s["id"], "date": s["date"] })),
            });
            let dir = self.state_dir.join("memo");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(format!("{}.json", recipe.id)), serde_json::to_vec_pretty(&memo).unwrap_or_default());
        }
        let secs = t0.elapsed().as_secs_f64();
        match failure {
            None => {
                let msg = format!("{total} steps in {secs:.1} s{}", if sc.artifacts.is_empty() { String::new() } else { format!(" → {}", sc.artifacts.join(", ")) });
                run.job.finish(Status::Done, msg, Some(json!({ "run": run.id, "artifacts": sc.artifacts })));
            }
            Some(e) if run.job.cancel.load(Ordering::Relaxed) => run.job.finish(Status::Cancelled, e, None),
            Some(e) => run.job.finish(Status::Failed, e, None),
        }
        run.save();
    }

    fn finished(&self, engine: &Arc<Engine>, run: &Arc<Run>) {
        self.active.lock().unwrap().remove(&run.recipe.id);
        {
            let mut runs = self.runs.lock().unwrap();
            runs.push_back(run.clone());
            while runs.len() > 200 {
                runs.pop_front();
            }
        }
        let status = run.status();
        eprintln!("automation: {} {} ({})", run.id, format!("{status:?}").to_lowercase(), run.job.json()["message"].as_str().unwrap_or(""));
        if status == Status::Done {
            let outputs = run.json()["outputs"].clone();
            for r in self.enabled_recipes() {
                let follows = r.triggers.iter().any(|t| matches!(t, Trigger::After { recipe } if recipe == &run.recipe.id));
                if follows {
                    let trig = json!({ "kind": "after", "text": format!("after '{}' finished", run.recipe.id), "recipe": run.recipe.id, "run": run.id, "outputs": outputs });
                    if let Err(e) = self.start_run(engine, &r.id, Map::new(), trig) {
                        eprintln!("automation: {} (after {}) not started: {e}", r.id, run.recipe.id);
                    }
                }
            }
        }
        let pending = self.pending.lock().unwrap().get_mut(&run.recipe.id).and_then(|q| q.pop_front());
        if let Some((given, trig)) = pending
            && let Err(e) = self.start_run(engine, &run.recipe.id, given, trig) {
                eprintln!("automation: queued re-run of {} failed: {e}", run.recipe.id);
            }
    }

    /// A device with geodata showed up (called by the device hub). True if a recipe took it.
    pub fn on_device(&self, engine: &Arc<Engine>, ev: &crate::devices::DeviceEvent) -> bool {
        let mut claimed = false;
        // a drop folder is consent by action: any device recipe may take it, Auto switch or not
        let candidates: Vec<Arc<Recipe>> = if ev.inbox { self.recipes().into_iter().filter(|r| !r.triggers.is_empty()).collect() } else { self.enabled_recipes() };
        for r in candidates {
            let hit = r.triggers.iter().any(|t| match t {
                Trigger::Device { kinds, has } => {
                    let kind_ok = kinds.is_empty() || kinds.iter().any(|k| k == ev.kind);
                    let has_ok = has.is_empty()
                        || has.iter().any(|h| match h.as_str() {
                            "photos" | "geotagged-photos" => ev.photos > 0,
                            "tracks" => ev.tracks > 0,
                            "waypoints" => ev.waypoints > 0,
                            "readings" | "sensor-readings" => ev.readings > 0,
                            "point-clouds" | "point_clouds" | "lidar" => ev.point_clouds > 0,
                            _ => ev.photos + ev.tracks + ev.waypoints + ev.readings + ev.point_clouds > 0,
                        });
                    kind_ok && has_ok
                }
                _ => false,
            });
            if !hit {
                continue;
            }
            let mut given = Map::new();
            if r.inputs.iter().any(|i| i.name == "source") {
                given.insert("source".into(), Value::from(ev.root.display().to_string()));
            }
            let trig = json!({
                "kind": "device", "text": format!("{} {} plugged in", ev.kind, ev.name), "device": ev.name,
                "device_id": ev.id, "device_kind": ev.kind, "root": ev.root,
            });
            match self.start_run(engine, &r.id, given, trig) {
                Ok(run) => eprintln!("automation: {} started by {} ({})", r.id, ev.name, run.id),
                Err(e) => eprintln!("automation: {} for {}: {e}", r.id, ev.name),
            }
            claimed = true;
        }
        claimed
    }

    /// A live position or sensor reading arrived (called by the device hub for every push).
    pub fn on_sensor(&self, engine: &Arc<Engine>, ev: &crate::devices::SensorEvent) {
        for r in self.enabled_recipes() {
            for (i, t) in r.triggers.iter().enumerate() {
                let Trigger::Sensor { field, above, below, device, inside, cooldown } = t else { continue };
                if device.as_deref().is_some_and(|g| !triggers::glob(g, &ev.device_id) && !triggers::glob(g, &ev.name)) {
                    continue;
                }
                let mut hit = None;
                if let Some(f) = field {
                    let Some(v) = ev.values.iter().find(|(k, _)| k == f).map(|(_, v)| *v) else { continue };
                    if let Some(a) = above.filter(|a| v > *a) {
                        hit = Some((v, "above", a));
                    } else if let Some(b) = below.filter(|b| v < *b) {
                        hit = Some((v, "below", b));
                    } else {
                        continue;
                    }
                }
                let key = (r.id.clone(), i, ev.device_id.clone());
                if let Some(layer) = inside {
                    let polys = match self.fence(engine, layer) {
                        Ok(p) => p,
                        Err(e) => {
                            eprintln!("automation: {} geofence: {e}", r.id);
                            continue;
                        }
                    };
                    let now_in = polys.iter().any(|rings| {
                        rings.first().is_some_and(|outer| steps::point_in_ring([ev.lon, ev.lat], outer)) && !rings.iter().skip(1).any(|hole| steps::point_in_ring([ev.lon, ev.lat], hole))
                    });
                    let mut st = self.sensor_state.lock().unwrap();
                    let entry = st.entry(key.clone()).or_insert((false, None));
                    let was_in = std::mem::replace(&mut entry.0, now_in);
                    // geofence alone fires on entering; with a field, on readings inside
                    if !now_in || (field.is_none() && was_in) {
                        continue;
                    }
                }
                {
                    let mut st = self.sensor_state.lock().unwrap();
                    let entry = st.entry(key).or_insert((false, None));
                    if entry.1.is_some_and(|last| last.elapsed() < *cooldown) {
                        continue;
                    }
                    entry.1 = Some(Instant::now());
                }
                let when = chrono::DateTime::from_timestamp(ev.t as i64, 0).map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
                let text = match (&hit, field, inside) {
                    (Some((v, dir, thr)), Some(f), _) => format!(
                        "{} reported {f} = {} ({dir} {}) at {when}{}",
                        ev.name,
                        features::num_text((v * 100.0).round() / 100.0),
                        features::num_text(*thr),
                        inside.as_ref().map(|l| format!(" inside {l}")).unwrap_or_default()
                    ),
                    (_, _, Some(l)) => format!("{} entered {l} at {when}", ev.name),
                    _ => format!("{} at {when}", ev.name),
                };
                let values: Map<String, Value> = ev.values.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect();
                let trig = json!({
                    "kind": "sensor", "text": text, "device": ev.name, "device_id": ev.device_id, "device_kind": ev.kind, "source": ev.source,
                    "lat": ev.lat, "lon": ev.lon, "t": ev.t, "time": when, "field": field, "value": hit.map(|h| h.0), "threshold": hit.map(|h| h.2),
                    "direction": hit.map(|h| h.1), "inside": inside, "values": values,
                });
                let mut given = Map::new();
                for (k, v) in [("device", Value::from(ev.device_id.clone())), ("lat", Value::from(ev.lat)), ("lon", Value::from(ev.lon))] {
                    if r.inputs.iter().any(|x| x.name == k) {
                        given.insert(k.into(), v);
                    }
                }
                match self.start_run(engine, &r.id, given, trig) {
                    Ok(run) => eprintln!("automation: {} started by sensor {} ({})", r.id, ev.device_id, run.id),
                    Err(e) => eprintln!("automation: {} for sensor {}: {e}", r.id, ev.device_id),
                }
            }
        }
    }

    fn fence(&self, engine: &Engine, layer: &str) -> Result<Arc<Vec<Vec<Vec<[f64; 2]>>>>, String> {
        if let Some((at, p)) = self.fences.lock().unwrap().get(layer)
            && at.elapsed() < std::time::Duration::from_secs(60) {
                return Ok(p.clone());
            }
        let l = engine.layer(layer).ok_or_else(|| format!("unknown layer '{layer}'"))?;
        let fs = features::read_layer(engine, &l, None, Some(&[]), 200_000)?;
        let polys: Vec<Vec<Vec<[f64; 2]>>> = fs.feats.into_iter().flat_map(|f| if let crate::wkb::Geom::Polygons(p) = f.geom { p } else { Vec::new() }).collect();
        if polys.is_empty() {
            return Err(format!("layer '{layer}' has no polygons"));
        }
        let p = Arc::new(polys);
        self.fences.lock().unwrap().insert(layer.to_string(), (Instant::now(), p.clone()));
        Ok(p)
    }

    /// Re-register layers written by earlier runs (`<state>/outputs/<recipe>/<name>.gpkg`).
    pub fn restore_outputs(&self, engine: &Engine) {
        let Ok(rd) = std::fs::read_dir(self.state_dir.join("outputs")) else { return };
        let mut n = 0;
        for dir in rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            let recipe = dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let Ok(files) = std::fs::read_dir(&dir) else { continue };
            for f in files.flatten().map(|e| e.path()) {
                let name = f.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                if name.ends_with(".tif") && !name.ends_with(".part.tif") {
                    let id = format!("{recipe}.{}", name.trim_end_matches(".tif"));
                    if engine.register_raster(&f, &id).is_ok() {
                        n += 1;
                    }
                    continue;
                }
                if !name.ends_with(".gpkg") || name.ends_with(".part.gpkg") {
                    continue;
                }
                let stem = name.trim_end_matches(".gpkg");
                if let Ok(mut handles) = crate::catalog::load_layers(&f) {
                    handles.truncate(1);
                    for h in handles.iter_mut() {
                        h.info.id = format!("{recipe}.{stem}");
                    }
                    n += engine.register_layers(handles).len();
                }
            }
        }
        if n > 0 {
            eprintln!("automation: restored {n} layers and rasters from earlier runs");
        }
    }

    /// Restore outputs, hook the device hub and start the trigger thread (once).
    pub fn start(&self, engine: &Arc<Engine>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.restore_outputs(engine);
        if !self.cfg.triggers {
            return;
        }
        let weak = Arc::downgrade(engine);
        engine.devices.set_hook(Box::new(move |ev| match weak.upgrade() {
            Some(e) => e.automation.on_device(&e, ev),
            None => false,
        }));
        let weak = Arc::downgrade(engine);
        engine.devices.set_sensor_hook(Box::new(move |ev| {
            if let Some(e) = weak.upgrade() {
                e.automation.on_sensor(&e, ev);
            }
        }));
        triggers::start(engine.clone());
    }

    pub fn summary_json(&self) -> Value {
        let recipes: Vec<Value> = self
            .recipes()
            .iter()
            .map(|r| {
                let mut v = r.summary_json();
                v["auto"] = self.is_enabled(&r.id).into();
                v["running"] = self.active.lock().unwrap().get(&r.id).map(|x| Value::from(x.id.clone())).unwrap_or(Value::Null);
                v["last_run"] = self.last_run(&r.id).map(|x| json!({ "id": x["id"], "status": x["status"], "started_at": x["started_at"], "elapsed_ms": x["elapsed_ms"], "artifacts": x["artifacts"], "error": x["error"] })).unwrap_or(Value::Null);
                v
            })
            .collect();
        json!({
            "recipes": recipes,
            "errors": *self.load_errors.lock().unwrap(),
            "triggers_running": self.cfg.triggers,
            "python": sidecar::find(sidecar::Lang::Python).map(|x| x.1),
            "r": sidecar::find(sidecar::Lang::R).map(|x| x.1),
        })
    }
}

pub fn catalogue_json() -> Value {
    Value::Array(
        steps::CATALOGUE
            .iter()
            .map(|s| json!({
                "name": s.name, "family": s.family, "summary": s.summary, "borrowed": s.borrowed,
                "params": s.params.iter().map(|(n, req, d)| json!({ "name": n, "required": req, "description": d })).collect::<Vec<_>>(),
            }))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gallery_recipes_are_valid() {
        let a = Automation::new(AutomationConfig::default(), &std::env::temp_dir().join("geospax-gallery-test"));
        assert!(a.load_errors.lock().unwrap().is_empty(), "{:?}", a.load_errors.lock().unwrap());
        assert_eq!(a.recipes().len(), GALLERY.len());
        for (name, text) in GALLERY {
            match a.validate(text, Origin::Gallery) {
                Ok((r, warns)) => {
                    assert_eq!(&r.id, name);
                    assert!(warns.iter().all(|w| w.contains("does not exist yet")), "{name}: {warns:?}");
                }
                Err(e) => panic!("{name}: {e:?}"),
            }
        }
    }

    #[test]
    fn artifact_paths_are_confined() {
        assert!(safe_name("20261015-101500-photos-to-map") && safe_name("map.png"));
        assert!(!safe_name("../etc") && !safe_name("a/b") && !safe_name(""));
        assert_eq!(content_type("report.html"), "text/html; charset=utf-8");
    }
}
