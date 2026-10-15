//! Trigger service (docs/AUTOMATION.md §3). Device triggers arrive from the device hub's hook
//! (`Automation::on_device`); `after:` triggers fire when a run finishes. This thread handles
//! folder and schedule triggers for every recipe whose "Auto" switch is on.

use super::recipe::Trigger;
use crate::Engine;
use chrono::{Datelike, Timelike};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const TICK: Duration = Duration::from_secs(2);
const FOLDER_POLL: Duration = Duration::from_secs(4);

/// Glob with `*` and `?` (case-insensitive), e.g. `*.gpx`.
pub fn glob(pattern: &str, name: &str) -> bool {
    fn m(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => m(&p[1..], n) || (!n.is_empty() && m(p, &n[1..])),
            (Some('?'), Some(_)) => m(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b) && m(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    m(&p, &n)
}

/// Files (name, size, mtime) in a folder and its sub-folders (2 levels), filtered by pattern.
pub fn listing(dir: &Path, pattern: Option<&str>) -> HashSet<(String, u64, u64)> {
    fn walk(base: &Path, dir: &Path, depth: usize, pattern: Option<&str>, out: &mut HashSet<(String, u64, u64)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                if depth > 0 {
                    walk(base, &p, depth - 1, pattern, out);
                }
            } else if pattern.is_none_or(|pat| glob(pat, &name)) {
                let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().to_string();
                let mtime = md.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                out.insert((rel, md.len(), mtime));
                if out.len() > 20_000 {
                    return;
                }
            }
        }
    }
    let mut out = HashSet::new();
    walk(dir, dir, 2, pattern, &mut out);
    out
}

struct FolderState {
    seen: Option<HashSet<(String, u64, u64)>>,
    last: Instant,
    /// Files changed but still being written: wait one more poll before firing.
    settling: Option<HashSet<(String, u64, u64)>>,
}

/// One STAC poll: is there a scene newer than the one the last run used? Runs on its own thread.
fn stac_poll(engine: Arc<Engine>, recipe: Arc<super::recipe::Recipe>, idx: usize, inflight: Arc<std::sync::atomic::AtomicBool>, fired: Arc<std::sync::Mutex<HashMap<(String, usize), String>>>) {
    let Trigger::Stac { area, collection, max_cloud, endpoint, every } = &recipe.triggers[idx] else { return };
    let memo = engine.automation.memo(&recipe.id);
    let aoi = area.or_else(|| {
        let a = memo["aoi"].as_array()?;
        Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?, a.get(3)?.as_f64()?])
    });
    let key = (recipe.id.clone(), idx);
    let done = || inflight.store(false, std::sync::atomic::Ordering::SeqCst);
    let Some(b) = aoi else {
        // never ran: run once so the recipe settles its area (and makes a first map)
        if fired.lock().unwrap().insert(key, "first".into()).is_none() {
            fire(&engine, &recipe, json!({ "kind": "stac", "text": "first run: settles the area to watch for new satellite passes" }), None);
        }
        return done();
    };
    let last = memo["scene"]["date"].as_str().unwrap_or("").to_string();
    let days = (every.as_secs_f64() / 86400.0 * 3.0).max(20.0);
    let end = chrono::Utc::now();
    let start = end - chrono::Duration::seconds((days * 86400.0) as i64);
    let body = json!({
        "collections": [collection], "bbox": b, "limit": 5,
        "datetime": format!("{}/{}", start.format("%Y-%m-%dT%H:%M:%SZ"), end.format("%Y-%m-%dT%H:%M:%SZ")),
        "query": { "eo:cloud_cover": { "lt": max_cloud } },
        "sortby": [{ "field": "properties.datetime", "direction": "desc" }],
    });
    let res = crate::raster::http(&format!("{}/search", endpoint.trim_end_matches('/')), Some(&body.to_string()), 45).and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string()));
    match res {
        Ok(v) => {
            let newest = v["features"].as_array().into_iter().flatten().filter_map(|f| Some((f["properties"]["datetime"].as_str()?.get(..10)?.to_string(), f["id"].as_str()?.to_string(), f["properties"]["eo:cloud_cover"].as_f64().unwrap_or(0.0)))).max_by(|a, b| a.0.cmp(&b.0));
            if let Some((date, id, cloud)) = newest {
                let already = fired.lock().unwrap().get(&key) == Some(&date);
                if date > last && !already {
                    fired.lock().unwrap().insert(key, date.clone());
                    let trig = json!({ "kind": "stac", "text": format!("new {collection} pass {date} ({cloud:.0} % cloud){}", if last.is_empty() { String::new() } else { format!(", newer than {last}") }), "scene": id, "date": date });
                    fire(&engine, &recipe, trig, None);
                }
            }
        }
        Err(e) => eprintln!("automation: {} stac check failed: {e}", recipe.id),
    }
    done();
}

pub fn start(engine: Arc<Engine>) {
    std::thread::Builder::new()
        .name("automation-triggers".into())
        .spawn(move || {
            let mut folders: HashMap<(String, usize), FolderState> = HashMap::new();
            let mut schedules: HashMap<(String, usize), Instant> = HashMap::new();
            let mut cron_minute: HashMap<(String, usize), i64> = HashMap::new();
            let mut stac: HashMap<(String, usize), (Instant, Arc<std::sync::atomic::AtomicBool>)> = HashMap::new();
            let fired: Arc<std::sync::Mutex<HashMap<(String, usize), String>>> = Arc::default();
            let started = Instant::now();
            loop {
                tick(&engine, &mut folders, &mut schedules, &mut cron_minute, started);
                stac_tick(&engine, &mut stac, &fired);
                std::thread::sleep(TICK);
            }
        })
        .expect("spawn trigger thread");
}

fn stac_tick(engine: &Arc<Engine>, polls: &mut HashMap<(String, usize), (Instant, Arc<std::sync::atomic::AtomicBool>)>, fired: &Arc<std::sync::Mutex<HashMap<(String, usize), String>>>) {
    let recipes = engine.automation.enabled_recipes();
    polls.retain(|k, _| recipes.iter().any(|r| r.id == k.0));
    for r in &recipes {
        for (i, t) in r.triggers.iter().enumerate() {
            let Trigger::Stac { every, .. } = t else { continue };
            let entry = polls.entry((r.id.clone(), i)).or_insert_with(|| (Instant::now() - *every + Duration::from_secs(3), Arc::default()));
            if entry.0.elapsed() < *every || entry.1.load(std::sync::atomic::Ordering::SeqCst) || engine.automation.is_active(&r.id) {
                continue;
            }
            entry.0 = Instant::now();
            entry.1.store(true, std::sync::atomic::Ordering::SeqCst);
            let (e, rc, flag, f) = (engine.clone(), r.clone(), entry.1.clone(), fired.clone());
            std::thread::spawn(move || stac_poll(e, rc, i, flag, f));
        }
    }
}

fn fire(engine: &Arc<Engine>, recipe: &super::recipe::Recipe, trigger: Value, source: Option<String>) {
    let mut given = Map::new();
    if let Some(s) = source {
        if recipe.inputs.iter().any(|i| i.name == "source") {
            given.insert("source".into(), Value::from(s));
        }
    }
    match engine.automation.start_run(engine, &recipe.id, given, trigger) {
        Ok(run) => eprintln!("automation: {} started ({})", recipe.id, run.id),
        Err(e) => eprintln!("automation: {}: {e}", recipe.id),
    }
}

fn tick(engine: &Arc<Engine>, folders: &mut HashMap<(String, usize), FolderState>, schedules: &mut HashMap<(String, usize), Instant>, cron_minute: &mut HashMap<(String, usize), i64>, started: Instant) {
    let recipes = engine.automation.enabled_recipes();
    let live: HashSet<String> = recipes.iter().map(|r| r.id.clone()).collect();
    folders.retain(|k, _| live.contains(&k.0));
    schedules.retain(|k, _| live.contains(&k.0));
    let now = chrono::Local::now();
    for r in &recipes {
        for (i, t) in r.triggers.iter().enumerate() {
            let key = (r.id.clone(), i);
            match t {
                Trigger::Folder { path, pattern, on_start } => {
                    let st = folders.entry(key).or_insert(FolderState { seen: None, last: Instant::now() - FOLDER_POLL, settling: None });
                    if st.last.elapsed() < FOLDER_POLL {
                        continue;
                    }
                    st.last = Instant::now();
                    let dir = Path::new(path);
                    if !dir.is_dir() {
                        continue;
                    }
                    let now_files = listing(dir, pattern.as_deref());
                    let Some(seen) = &st.seen else {
                        st.seen = Some(now_files.clone());
                        if *on_start && !now_files.is_empty() {
                            let trig = json!({ "kind": "folder", "text": format!("files in {path}"), "path": path, "files": now_files.len() });
                            fire(engine, r, trig, Some(path.clone()));
                        }
                        continue;
                    };
                    let new: Vec<&(String, u64, u64)> = now_files.difference(seen).collect();
                    if new.is_empty() {
                        st.settling = None;
                        continue;
                    }
                    // fire only when the listing is stable across two polls (copies finished)
                    if st.settling.as_ref() != Some(&now_files) {
                        st.settling = Some(now_files);
                        continue;
                    }
                    let names: Vec<String> = new.iter().map(|x| x.0.clone()).take(20).collect();
                    let trig = json!({
                        "kind": "folder", "text": format!("{} new or changed file{} in {path}", new.len(), if new.len() == 1 { "" } else { "s" }),
                        "path": path, "files": names,
                    });
                    st.seen = Some(now_files.clone());
                    st.settling = None;
                    fire(engine, r, trig, Some(path.clone()));
                }
                Trigger::Schedule { every: Some(d), on_start, .. } => {
                    let next = schedules.entry(key).or_insert_with(|| if *on_start { Instant::now() } else { Instant::now() + *d });
                    if Instant::now() >= *next {
                        *next = Instant::now() + *d;
                        let trig = json!({ "kind": "schedule", "text": format!("every {}", super::recipe::human_duration(*d)) });
                        fire(engine, r, trig, None);
                    }
                }
                Trigger::Schedule { cron: Some(c), .. } => {
                    let minute_id = now.timestamp() / 60;
                    if cron_minute.get(&key) == Some(&minute_id) || started.elapsed() < Duration::from_secs(1) {
                        continue;
                    }
                    if c.matches(now.minute(), now.hour(), now.day(), now.month(), now.weekday().num_days_from_sunday()) {
                        cron_minute.insert(key, minute_id);
                        let trig = json!({ "kind": "schedule", "text": format!("schedule '{}'", c.text) });
                        fire(engine, r, trig, None);
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globbing() {
        assert!(glob("*.gpx", "track.GPX"));
        assert!(glob("IMG_????.jpg", "IMG_0042.JPG"));
        assert!(!glob("*.gpx", "track.kml"));
        assert!(glob("*", "anything"));
    }

    #[test]
    fn listing_sees_new_files() {
        let d = std::env::temp_dir().join(format!("geospax-trig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("a.gpx"), "x").unwrap();
        std::fs::write(d.join("sub/b.gpx"), "y").unwrap();
        std::fs::write(d.join("c.txt"), "z").unwrap();
        let l = listing(&d, Some("*.gpx"));
        assert_eq!(l.len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }
}
