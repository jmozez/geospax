//! Public guest demo (`geospax-server --public`): anyone can open the web edition without signing in.
//! Each visitor keeps a project of their own (the browser sends `?ws=<id>`), so nobody sees another
//! visitor's map; what could misuse the server is refused; and guest files are deleted after a week.

use crate::router::{ApiRequest, ApiResponse};
use crate::Engine;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// Largest file a guest may upload (the server's disk is shared by every visitor).
pub const MAX_UPLOAD: usize = 64 << 20;
/// ...and the most a guest's zip may unpack to.
pub const MAX_UNZIPPED: u64 = 256 << 20;
/// Guests' uploads together may not grow past this (older ones go after 7 days).
const MAX_GUEST_STORAGE: u64 = 4 << 30;
/// New layers and rasters belong to the one visitor who asked for something this recently.
const CLAIM_WINDOW: Duration = Duration::from_secs(15 * 60);

/// How long a guest's project and files are kept after they were last touched.
pub const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

/// Requests a guest may not make: running code, installing things, folders of the server, server-wide
/// settings, devices, and adding web addresses for the server to fetch.
pub fn refused(method: &str, segs: &[&str]) -> Option<&'static str> {
    let why = match (method, segs) {
        (_, ["api", "folders", ..]) | (_, ["api", "browse", ..]) => "folders of the server",
        ("POST", ["api", "r", ..]) | ("POST", ["api", "python", ..]) => "installing R or Python packages",
        (m, ["api", "plugins", ..]) if m != "GET" && !matches!(segs, [_, _, _, "tools", _, "run"]) => "installing or removing plugins",
        (m, ["api", "models", ..]) if m != "GET" => "adding AI models",
        (m, ["api", "recipes", ..]) if m != "GET" && !matches!(segs, [_, _, _, "run"] | [_, _, "validate"]) => "saving recipes",
        ("PUT", ["api", "ai", ..]) | ("POST", ["api", "ask"]) => "the AI assistant",
        ("POST", ["api", "settings", ..]) | ("POST", ["api", "cache", ..]) | ("POST", ["api", "bench"]) => "server settings",
        ("POST", ["api", "devices", ..]) | ("POST", ["api", "phone", ..]) | ("POST", ["api", "hooks", ..]) => "devices and phones",
        ("POST", ["api", "services"]) | ("POST", ["api", "stac", "add"]) => "adding web services",
        (_, ["api", "sync", ..]) | (_, ["api", "layers", _, "field-package"]) => "field sync (files on the server)",
        _ => return None,
    };
    Some(why)
}

/// A visitor's workspace id from `?ws=`: 8 to 64 letters, digits or dashes, else none.
pub fn workspace(ws: Option<&str>) -> Option<String> {
    let w = ws?.trim();
    ((8..=64).contains(&w.len()) && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then(|| w.to_ascii_lowercase())
}

/// Where a visitor's project is kept.
pub fn project_path(state_dir: &Path, ws: &str) -> PathBuf {
    state_dir.join("guests").join(format!("{ws}.json"))
}

/// Delete guest projects, uploaded or downloaded files and run results not touched for a week.
/// Returns how many files and folders went.
pub fn clean(state_dir: &Path, data_dirs: &[PathBuf]) -> usize {
    let old = |p: &Path| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .map(|t| SystemTime::now().duration_since(t).unwrap_or_default() > KEEP)
            .unwrap_or(false)
    };
    let mut n = 0;
    // files anywhere below `dir` not touched for a week, then the folders left empty
    fn sweep(dir: &Path, old: &dyn Fn(&Path) -> bool, n: &mut usize) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if p.is_dir() {
                sweep(&p, old, n);
                if std::fs::read_dir(&p).map(|mut d| d.next().is_none()).unwrap_or(false) && std::fs::remove_dir(&p).is_ok() {
                    *n += 1;
                }
            } else if old(&p) && std::fs::remove_file(&p).is_ok() {
                *n += 1;
            }
        }
    }
    sweep(&state_dir.join("guests"), &old, &mut n);
    sweep(&state_dir.join("runs"), &old, &mut n);
    for d in data_dirs.iter().filter(|d| d.is_dir()) {
        sweep(d, &old, &mut n);
    }
    n
}

/// Who owns what in the guest demo. Every visitor shares the server's data folders, so each layer,
/// raster, run and job is tied to the workspace that made it; the rest is invisible to that visitor
/// and cannot be read, changed or deleted. What was on the server before is nobody's.
#[derive(Default)]
pub struct Owners {
    /// "l:<layer>", "r:<raster>", "run:<id>", "job:<id>" -> workspace ("" = nobody)
    map: Mutex<HashMap<String, String>>,
    /// workspace -> when it last asked for a change
    writers: Mutex<HashMap<String, Instant>>,
    /// one guest change at a time, so new jobs and runs are credited to the right visitor
    write_lock: Mutex<()>,
    path: Mutex<Option<PathBuf>>,
}

impl Owners {
    /// Start: everything already on the server belongs to nobody; earlier claims are read back.
    pub fn init(&self, engine: &Engine) {
        let path = engine.state_dir.join("guests").join("owners.json");
        let mut map: HashMap<String, String> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        for k in current_items(engine) {
            map.entry(k).or_default();
        }
        *self.map.lock().unwrap() = map;
        *self.path.lock().unwrap() = Some(path);
        self.save();
    }

    fn save(&self) {
        if let Some(p) = self.path.lock().unwrap().as_ref() {
            let _ = std::fs::create_dir_all(p.parent().unwrap());
            let map = self.map.lock().unwrap();
            let _ = std::fs::write(p, serde_json::to_vec(&*map).unwrap_or_default());
        }
    }

    fn set(&self, key: String, ws: &str) {
        self.map.lock().unwrap().insert(key, ws.to_string());
        self.save();
    }

    /// Does `ws` own `key`? A layer or raster seen for the first time goes to the one visitor who
    /// asked for a change in the last 15 minutes; with none or several, to nobody (never shown).
    fn owns(&self, key: &str, ws: &str) -> bool {
        if let Some(o) = self.map.lock().unwrap().get(key) {
            return o == ws;
        }
        if !(key.starts_with("l:") || key.starts_with("r:")) {
            return false;
        }
        let now = Instant::now();
        let recent: Vec<String> = self.writers.lock().unwrap().iter().filter(|(_, t)| now.duration_since(**t) < CLAIM_WINDOW).map(|(w, _)| w.clone()).collect();
        let owner = if recent.len() == 1 { recent[0].clone() } else { String::new() };
        self.set(key.to_string(), &owner);
        owner == ws
    }
}

fn current_items(engine: &Engine) -> Vec<String> {
    let mut v: Vec<String> = engine.layers().iter().map(|l| format!("l:{}", l.info.id)).collect();
    v.extend(engine.rasters().iter().map(|r| format!("r:{}", r.info.id)));
    v.extend(ids_in(&engine.jobs.json()).into_iter().map(|i| format!("job:{i}")));
    v.extend(ids_in(&Value::Array(engine.automation.runs_json(10_000))).into_iter().map(|i| format!("run:{i}")));
    v
}

/// `id` of every object in a JSON array.
fn ids_in(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|o| match &o["id"] { Value::String(s) => Some(s.clone()), Value::Number(n) => Some(n.to_string()), _ => None }).collect())
        .unwrap_or_default()
}

/// Server folders out of every string of a reply: `/srv/data/Uploads/a.gpkg` -> `…/Uploads/a.gpkg`.
fn scrub(v: &mut Value, roots: &[String]) {
    match v {
        Value::String(s) => {
            for r in roots {
                if s.contains(r.as_str()) {
                    *s = s.replace(r.as_str(), "…");
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| scrub(x, roots)),
        Value::Object(o) => {
            o.retain(|k, x| !(matches!(k.as_str(), "saved" | "path") && x.as_str().is_some_and(|s| roots.iter().any(|r| s.starts_with(r.as_str())))));
            o.values_mut().for_each(|x| scrub(x, roots));
        }
        _ => {}
    }
}

fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| match e.metadata() { Ok(m) if m.is_dir() => dir_size(&e.path()), Ok(m) => m.len(), Err(_) => 0 }).sum())
        .unwrap_or(0)
}

/// Every string in a JSON value (to find layer ids a request names in its body).
fn strings<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    match v {
        Value::String(s) => out.push(s),
        Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        Value::Object(o) => o.values().for_each(|x| strings(x, out)),
        _ => {}
    }
}

fn not_found() -> ApiResponse {
    ApiResponse::error(404, "not found")
}

/// Requests a visitor may make without a workspace (nothing in them belongs to anyone).
fn open_without_workspace(method: &str, segs: &[&str]) -> bool {
    method == "GET"
        && matches!(
            segs,
            ["api", "about"] | ["api", "health"] | ["api", "docs", ..] | ["api", "samples"] | ["api", "plugins", ..] | ["api", "recipes", ..]
                | ["api", "steps"] | ["api", "providers"] | ["api", "raster", "ramps"] | ["api", "settings", "charts"] | ["api", "rev"]
        )
}

/// The guest demo's door: refused requests, then ownership of whatever the request names, then the
/// request itself, then only this visitor's layers, rasters, runs and jobs in the lists it returns.
pub fn handle(engine: &Arc<Engine>, mut req: ApiRequest) -> ApiResponse {
    let segs_owned: Vec<String> = req.path.trim_matches('/').split('/').filter(|s| !s.is_empty()).map(crate::router::pct_decode).collect();
    let segs: Vec<&str> = segs_owned.iter().map(String::as_str).collect();
    if let Some(why) = refused(&req.method, &segs) {
        return ApiResponse::error(403, format!("not in the guest demo ({why}): download GeoSpaX for the full app"));
    }
    let ws = workspace(req.ws.as_deref()).or_else(|| workspace(crate::router::param(&req.query, "ws").as_deref()));
    let Some(ws) = ws else {
        return if open_without_workspace(&req.method, &segs) { engine.handle_inner(req) } else { ApiResponse::error(403, "guest demo: open the app to get a workspace") };
    };
    if crate::router::param(&req.query, "ws").is_none() {
        req.query = if req.query.is_empty() { format!("ws={ws}") } else { format!("{}&ws={ws}", req.query) };
    }
    let owners = &engine.owners;
    // visitors' text never goes into the server's own log
    if matches!(segs.as_slice(), ["api", "log"]) {
        return ApiResponse::json(200, &serde_json::json!({ "logged": false }));
    }

    // whatever the path names must be this visitor's
    let named = match segs.as_slice() {
        ["tiles", layer, ..] => Some(format!("l:{layer}")),
        ["api", "layers", layer, ..] if *layer != "new" => Some(format!("l:{layer}")),
        ["api", "rasters", id, ..] => Some(format!("r:{id}")),
        ["api", "runs", id, ..] => Some(format!("run:{id}")),
        ["api", "jobs", id, ..] => Some(format!("job:{id}")),
        _ => None,
    };
    if let Some(key) = named {
        if !owners.owns(&key, &ws) {
            return not_found();
        }
    }
    // and so must every layer or raster its body or query names (tool inputs, map previews...)
    if !matches!(segs.as_slice(), ["api", "project", ..]) {
        let known: HashSet<String> = engine.layers().iter().map(|l| l.info.id.clone()).chain(engine.rasters().iter().map(|r| r.info.id.clone())).collect();
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let mut named = Vec::new();
        strings(&body, &mut named);
        let q: Vec<String> = req.query.split('&').filter_map(|kv| kv.split_once('=').map(|(_, v)| crate::router::pct_decode(v))).collect();
        named.extend(q.iter().map(String::as_str));
        for s in named.iter().flat_map(|s| s.split(',')) {
            let s = s.trim();
            if known.contains(s) {
                let is_raster = engine.rasters().iter().any(|r| r.info.id == s);
                let key = if is_raster { format!("r:{s}") } else { format!("l:{s}") };
                if !owners.owns(&key, &ws) {
                    return not_found();
                }
            }
        }
    }

    if matches!(segs.as_slice(), ["api", "upload"]) && dir_size(&crate::upload::upload_dir(engine)) > MAX_GUEST_STORAGE {
        return ApiResponse::error(507, "the guest demo is full right now: try again later, or download GeoSpaX");
    }

    let write = req.method != "GET" && !matches!(segs.as_slice(), ["api", "project", ..] | ["api", "log"]);
    let mut res = if write {
        let _one = owners.write_lock.lock().unwrap();
        owners.writers.lock().unwrap().insert(ws.clone(), Instant::now());
        // what this request makes at once (an upload's layers, a new job or run) is this visitor's;
        // what a job makes later is claimed through the 15-minute window in `owns`
        let before: HashSet<String> = current_items(engine).into_iter().collect();
        let res = engine.handle_inner(req);
        let known = owners.map.lock().unwrap().keys().cloned().collect::<HashSet<_>>();
        for k in current_items(engine) {
            if !before.contains(&k) && !known.contains(&k) {
                owners.set(k, &ws);
            }
        }
        res
    } else {
        engine.handle_inner(req)
    };

    // no folders of the server in replies (where an upload or a tool saved, which file an error is about)
    if res.content_type.starts_with("application/json") {
        if let Ok(mut v) = serde_json::from_slice::<Value>(&res.body) {
            let mut roots: Vec<String> = engine.data_dirs.iter().chain(std::iter::once(&engine.state_dir)).map(|d| d.display().to_string()).filter(|r| r.len() > 1).collect();
            roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
            scrub(&mut v, &roots);
            res.body = serde_json::to_vec(&v).unwrap_or_default();
        }
    }

    // lists show this visitor's own things only
    let list = match segs.as_slice() {
        ["api", "layers"] => Some(("layers", "l:")),
        ["api", "rasters"] => Some(("rasters", "r:")),
        ["api", "runs"] => Some(("runs", "run:")),
        ["api", "jobs"] => Some(("jobs", "job:")),
        _ => None,
    };
    if let (Some((field, prefix)), 200) = (list, res.status) {
        if let Ok(mut v) = serde_json::from_slice::<Value>(&res.body) {
            if let Some(a) = v[field].as_array_mut() {
                a.retain(|o| {
                    let id = match &o["id"] { Value::String(s) => s.clone(), Value::Number(n) => n.to_string(), _ => return false };
                    owners.owns(&format!("{prefix}{id}"), &ws)
                });
            }
            res.body = serde_json::to_vec(&v).unwrap_or_default();
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_keeps_new_files_and_dot_folders() {
        let d = std::env::temp_dir().join(format!("gsx-guest-{}", std::process::id()));
        let (data, state) = (d.join("data"), d.join("state"));
        std::fs::create_dir_all(data.join("Uploads")).unwrap();
        std::fs::create_dir_all(state.join(".geospax")).unwrap();
        std::fs::write(data.join("Uploads/new.geojson"), "{}").unwrap();
        assert_eq!(clean(&state, std::slice::from_ref(&data)), 0);
        assert!(data.join("Uploads/new.geojson").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn guests_cannot_run_code_or_touch_the_server() {
        assert!(refused("POST", &["api", "r", "install"]).is_some());
        assert!(refused("POST", &["api", "python", "update"]).is_some());
        assert!(refused("POST", &["api", "plugins", "import"]).is_some());
        assert!(refused("POST", &["api", "folders"]).is_some());
        assert!(refused("GET", &["api", "folders", "pick"]).is_some());
        assert!(refused("POST", &["api", "recipes"]).is_some());
        assert!(refused("POST", &["api", "services"]).is_some());
        assert!(refused("POST", &["api", "sync", "review"]).is_some());
        assert!(refused("POST", &["api", "layers", "x", "field-package"]).is_some());
        assert!(refused("GET", &["api", "browse"]).is_some());
        // what the demo is for still works
        assert!(refused("POST", &["api", "recipes", "r-rayshader", "run"]).is_none());
        assert!(refused("POST", &["api", "plugins", "gsx", "tools", "buffer", "run"]).is_none());
        assert!(refused("POST", &["api", "upload"]).is_none());
        assert!(refused("POST", &["api", "overture"]).is_none());
        assert!(refused("GET", &["api", "plugins"]).is_none());
    }

    #[test]
    fn new_things_go_to_the_one_recent_visitor_or_nobody() {
        let o = Owners::default();
        o.set("l:a.mine".into(), "aaaaaaaa");
        assert!(o.owns("l:a.mine", "aaaaaaaa") && !o.owns("l:a.mine", "bbbbbbbb"));
        // nobody wrote lately: a layer that turns up belongs to nobody, for good
        assert!(!o.owns("l:old", "aaaaaaaa") && !o.owns("l:old", "bbbbbbbb"));
        o.writers.lock().unwrap().insert("aaaaaaaa".into(), Instant::now());
        assert!(o.owns("l:from-a-job", "aaaaaaaa"));
        // two visitors busy at once: unclear whose, so never shown to either
        o.writers.lock().unwrap().insert("bbbbbbbb".into(), Instant::now());
        assert!(!o.owns("l:unclear", "aaaaaaaa") && !o.owns("l:unclear", "bbbbbbbb"));
        // jobs and runs are only ever credited when they start
        assert!(!o.owns("job:7", "aaaaaaaa"));
    }

    #[test]
    fn workspace_ids_are_checked() {
        assert_eq!(workspace(Some("ab12cd34-ef")).as_deref(), Some("ab12cd34-ef"));
        assert!(workspace(Some("../../etc/passwd")).is_none());
        assert!(workspace(Some("short")).is_none());
        assert!(workspace(None).is_none());
    }
}
