//! Recipe model (docs/AUTOMATION.md §2): parse YAML or JSON, validate, resolve `${…}`
//! expressions and order the steps by their dependencies.
//!
//! A recipe is plain data. Validation happens before anything runs, so a typo in a step name or a
//! reference to a step that does not exist is reported with the line it concerns, not halfway
//! through a run.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

/// Where a recipe came from. Gallery and user recipes are trusted; anything else needs approval
/// before code steps run (AUTOMATION.md §8).
#[derive(Debug, Clone, PartialEq)]
pub enum Origin {
    Gallery,
    User(PathBuf),
    File(PathBuf),
    Api,
}

impl Origin {
    pub fn as_str(&self) -> &'static str {
        match self {
            Origin::Gallery => "gallery",
            Origin::User(_) => "user",
            Origin::File(_) => "file",
            Origin::Api => "api",
        }
    }
}

#[derive(Debug, Clone)]
pub enum Trigger {
    /// A device with geodata is connected (phone, camera, drone card, GPS unit, watched folder).
    Device { kinds: Vec<String>, has: Vec<String> },
    /// Files in a folder appear or change.
    Folder { path: String, pattern: Option<String>, on_start: bool },
    /// A fixed interval or a cron expression (local time).
    Schedule { every: Option<Duration>, cron: Option<Cron>, on_start: bool },
    /// Another recipe finished successfully.
    After { recipe: String },
    /// A new satellite pass over the area (STAC search every `every`; fires once per newer scene).
    Stac { every: Duration, area: Option<[f64; 4]>, collection: String, max_cloud: f64, endpoint: String },
    /// An HTTP call to POST /api/hooks/<token> (the JSON body becomes the run's inputs).
    Webhook { token: String },
    /// A live sensor or phone (HTTP, MQTT, GNSS): a reading crosses a threshold and/or the
    /// device enters a geofence (polygons of a layer). Fires at most once per `cooldown` per device.
    Sensor { field: Option<String>, above: Option<f64>, below: Option<f64>, device: Option<String>, inside: Option<String>, cooldown: Duration },
}

impl Trigger {
    pub fn kind(&self) -> &'static str {
        match self {
            Trigger::Device { .. } => "device",
            Trigger::Folder { .. } => "folder",
            Trigger::Schedule { .. } => "schedule",
            Trigger::After { .. } => "after",
            Trigger::Stac { .. } => "stac",
            Trigger::Webhook { .. } => "webhook",
            Trigger::Sensor { .. } => "sensor",
        }
    }

    /// Plain-language description for the UI.
    pub fn describe(&self) -> String {
        match self {
            Trigger::Device { kinds, has } => {
                let k = if kinds.is_empty() { "device".to_string() } else { join_or(kinds) };
                let h = if has.is_empty() { "geodata".to_string() } else { join_or(&has.iter().map(|h| h.replace("geotagged-", "").replace(['-', '_'], " ")).collect::<Vec<_>>()) };
                format!("when a {k} with {h} is plugged in")
            }
            Trigger::Folder { path, pattern, .. } => match pattern {
                Some(p) => format!("when {p} files change in {path}"),
                None => format!("when files change in {path}"),
            },
            Trigger::Schedule { every: Some(d), .. } => format!("every {}", human_duration(*d)),
            Trigger::Schedule { cron: Some(c), .. } => format!("on schedule '{}'", c.text),
            Trigger::Schedule { .. } => "on a schedule".into(),
            Trigger::After { recipe } => format!("after '{recipe}' succeeds"),
            Trigger::Stac { every, collection, max_cloud, .. } => format!("when a new {} pass (< {max_cloud:.0} % cloud) covers the area · checked every {}", if collection.starts_with("sentinel-2") { "Sentinel-2".to_string() } else { collection.clone() }, human_duration(*every)),
            Trigger::Webhook { .. } => "when its webhook URL is called".into(),
            Trigger::Sensor { field, above, below, device, inside, cooldown } => {
                let who = device.as_deref().map(|d| format!("sensor {d}")).unwrap_or_else(|| "a live sensor".into());
                let mut what = Vec::new();
                if let (Some(f), Some(a)) = (field, above) {
                    what.push(format!("reports {f} above {}", super::features::num_text(*a)));
                }
                if let (Some(f), Some(b)) = (field, below) {
                    what.push(format!("reports {f} below {}", super::features::num_text(*b)));
                }
                let mut text = format!("when {who} {}", if what.is_empty() { "moves".to_string() } else { what.join(" or ") });
                if let Some(l) = inside {
                    text.push_str(&if field.is_some() { format!(" inside {l}") } else { format!(" into {l}") });
                }
                format!("{text} · at most once every {} per device", human_duration(*cooldown))
            }
        }
    }

    pub fn json(&self) -> Value {
        let mut v = match self {
            Trigger::Device { kinds, has } => json!({ "kind": "device", "kinds": kinds, "has": has }),
            Trigger::Folder { path, pattern, on_start } => json!({ "kind": "folder", "path": path, "pattern": pattern, "on_start": on_start }),
            Trigger::Schedule { every, cron, on_start } => json!({
                "kind": "schedule",
                "every_s": every.map(|d| d.as_secs()),
                "cron": cron.as_ref().map(|c| c.text.clone()),
                "on_start": on_start,
            }),
            Trigger::After { recipe } => json!({ "kind": "after", "recipe": recipe }),
            Trigger::Stac { every, area, collection, max_cloud, endpoint } => json!({ "kind": "stac", "every_s": every.as_secs(), "area": area, "collection": collection, "max_cloud": max_cloud, "endpoint": endpoint }),
            Trigger::Webhook { token } => json!({ "kind": "webhook", "url": format!("/api/hooks/{token}") }),
            Trigger::Sensor { field, above, below, device, inside, cooldown } => json!({ "kind": "sensor", "field": field, "above": above, "below": below, "device": device, "inside": inside, "cooldown_s": cooldown.as_secs() }),
        };
        v["text"] = self.describe().into();
        v
    }
}

fn join_or(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        n => format!("{} or {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

#[derive(Debug, Clone)]
pub struct InputSpec {
    pub name: String,
    pub kind: String,
    pub default: Option<Value>,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct Step {
    pub id: String,
    pub uses: String,
    pub with: Value,
    pub needs: Vec<String>,
    pub when: Option<Value>,
    pub title: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Recipe {
    pub id: String,
    pub version: u64,
    pub title: String,
    pub description: String,
    /// Domain kit the recipe belongs to (Biodiversity, Conservation, Terrain …): the gallery and the
    /// Toolbox group kits by it.
    pub kit: String,
    pub triggers: Vec<Trigger>,
    pub inputs: Vec<InputSpec>,
    pub steps: Vec<Step>,
    pub outputs: Vec<String>,
    pub text: String,
    pub origin: Origin,
}

/// Names a step id may not take (they are expression roots).
const RESERVED: &[&str] = &["inputs", "run", "recipe", "trigger"];

pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// YAML (or JSON, if the text starts with `{`) into a JSON value.
pub fn parse_text(text: &str) -> Result<Value, String> {
    let t = text.trim_start();
    if t.starts_with('{') {
        serde_json::from_str(t).map_err(|e| format!("invalid JSON: {e}"))
    } else {
        serde_saphyr::from_str::<Value>(text).map_err(|e| format!("invalid YAML: {e}"))
    }
}

fn as_str_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => vec![],
    }
}

impl Recipe {
    /// Parse and check the structure. Returns every problem found, not just the first.
    pub fn parse(text: &str, origin: Origin) -> Result<Recipe, Vec<String>> {
        match Self::parse_all(text, origin) {
            (Some(r), errs) if errs.is_empty() => Ok(r),
            (_, errs) => Err(errs),
        }
    }

    /// Like `parse`, but also returns the (possibly flawed) recipe so callers can add their own
    /// checks (unknown steps, missing parameters) to the same list of problems.
    pub fn parse_all(text: &str, origin: Origin) -> (Option<Recipe>, Vec<String>) {
        let v = match parse_text(text) {
            Ok(v) => v,
            Err(e) => return (None, vec![e]),
        };
        let Some(obj) = v.as_object() else {
            return (None, vec!["a recipe must be a mapping of keys (recipe:, steps:, …)".into()]);
        };
        let mut errs = Vec::new();
        let id = match obj.get("recipe").or_else(|| obj.get("id")).and_then(Value::as_str) {
            Some(s) if valid_id(s) => s.to_string(),
            Some(s) => {
                errs.push(format!("recipe id '{s}' may only use a-z, 0-9, '-' and '_' (max 64 characters)"));
                s.to_string()
            }
            None => {
                errs.push("missing 'recipe: <id>' (a short name such as photos-to-map)".into());
                String::new()
            }
        };
        let version = obj.get("version").and_then(Value::as_u64).unwrap_or(1);
        let title = obj.get("title").and_then(Value::as_str).unwrap_or(&id).to_string();
        let description = obj.get("description").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let kit = obj.get("kit").and_then(Value::as_str).unwrap_or("").trim().to_string();

        // triggers
        let mut triggers = Vec::new();
        if let Some(t) = obj.get("triggers") {
            let list = match t {
                Value::Array(a) => a.clone(),
                Value::Null => vec![],
                other => vec![other.clone()],
            };
            for (i, item) in list.iter().enumerate() {
                match parse_trigger(item) {
                    Ok(Some(t)) => triggers.push(t),
                    Ok(None) => {}
                    Err(e) => errs.push(format!("triggers[{i}]: {e}")),
                }
            }
        }

        // inputs
        let mut inputs = Vec::new();
        match obj.get("inputs") {
            None | Some(Value::Null) => {}
            Some(Value::Object(m)) => {
                for (name, spec) in m {
                    if !valid_id(name) {
                        errs.push(format!("input name '{name}' may only use a-z, 0-9, '-' and '_'"));
                    }
                    let (kind, default, description) = match spec {
                        Value::Object(s) => (
                            s.get("type").and_then(Value::as_str).unwrap_or("any").to_string(),
                            s.get("default").cloned(),
                            s.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                        ),
                        Value::Null => ("any".to_string(), None, String::new()),
                        scalar => ("any".to_string(), Some(scalar.clone()), String::new()),
                    };
                    inputs.push(InputSpec { name: name.clone(), kind, default, description });
                }
            }
            Some(_) => errs.push("'inputs' must be a mapping of name: { type, default, description }".into()),
        }

        // steps
        let mut steps = Vec::new();
        match obj.get("steps") {
            Some(Value::Array(a)) if !a.is_empty() => {
                let mut seen = HashSet::new();
                for (i, s) in a.iter().enumerate() {
                    let Some(m) = s.as_object() else {
                        errs.push(format!("steps[{i}] must be a mapping with id: and use:"));
                        continue;
                    };
                    let uses = m.get("use").or_else(|| m.get("uses")).and_then(Value::as_str).unwrap_or("").to_string();
                    let id = m.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
                        // default id from the step name: "export.map" -> "map"
                        uses.rsplit('.').next().unwrap_or("step").replace(|c: char| !c.is_ascii_alphanumeric(), "_").to_ascii_lowercase()
                    });
                    if uses.is_empty() {
                        errs.push(format!("step '{id}' has no 'use:' (the step to run, e.g. automap.style)"));
                    }
                    if !valid_id(&id) {
                        errs.push(format!("step id '{id}' may only use a-z, 0-9, '-' and '_'"));
                    } else if RESERVED.contains(&id.as_str()) {
                        errs.push(format!("step id '{id}' is reserved; pick another name"));
                    } else if !seen.insert(id.clone()) {
                        errs.push(format!("two steps are called '{id}'; step ids must be unique"));
                    }
                    let with = match m.get("with") {
                        None | Some(Value::Null) => Value::Object(Map::new()),
                        Some(w @ Value::Object(_)) => w.clone(),
                        Some(_) => {
                            errs.push(format!("step '{id}': 'with' must be a mapping of parameters"));
                            Value::Object(Map::new())
                        }
                    };
                    steps.push(Step {
                        id,
                        uses,
                        with,
                        needs: as_str_list(m.get("needs")),
                        when: m.get("when").cloned(),
                        title: m.get("title").and_then(Value::as_str).map(str::to_string),
                    });
                }
            }
            _ => errs.push("a recipe needs a non-empty 'steps:' list".into()),
        }
        let outputs = as_str_list(obj.get("outputs"));
        let r = Recipe { id, version, title, description, kit, triggers, inputs, steps, outputs, text: text.to_string(), origin };
        if let Err(e) = r.order() {
            errs.push(e);
        }
        for s in &r.steps {
            for n in &s.needs {
                if !r.steps.iter().any(|o| &o.id == n) {
                    errs.push(format!("step '{}' needs '{n}', but there is no such step", s.id));
                }
            }
            let mut heads = Vec::new();
            refs_in(&s.with, &mut heads);
            if let Some(w) = &s.when {
                refs_in(w, &mut heads);
            }
            for h in heads {
                let root = h.split('.').next().unwrap_or("");
                match root {
                    "run" | "recipe" | "trigger" => {}
                    "inputs" => {
                        let name = h.split('.').nth(1).unwrap_or("");
                        if !name.is_empty() && !r.inputs.iter().any(|i| i.name == name) {
                            errs.push(format!("step '{}' uses ${{{h}}}, but the recipe declares no input '{name}'", s.id));
                        }
                    }
                    other if other == s.id => errs.push(format!("step '{}' refers to its own outputs (${{{h}}})", s.id)),
                    other if r.steps.iter().any(|o| o.id == other) => {}
                    other => errs.push(format!("step '{}' refers to ${{{h}}}, but there is no step or input called '{other}'", s.id)),
                }
            }
        }
        (Some(r), errs)
    }

    /// Execution order: declaration order, except that a step always runs after the steps it
    /// references (`${other.x}`) or `needs`. Fails on cycles.
    pub fn order(&self) -> Result<Vec<usize>, String> {
        let n = self.steps.len();
        let idx: HashMap<&str, usize> = self.steps.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
        let mut deps: Vec<HashSet<usize>> = vec![HashSet::new(); n];
        for (i, s) in self.steps.iter().enumerate() {
            let mut heads = Vec::new();
            refs_in(&s.with, &mut heads);
            if let Some(w) = &s.when {
                refs_in(w, &mut heads);
            }
            for h in heads.iter().map(|h| h.split('.').next().unwrap_or("").to_string()).chain(s.needs.iter().cloned()) {
                if let Some(&j) = idx.get(h.as_str())
                    && j != i {
                        deps[i].insert(j);
                    }
            }
        }
        let mut done = vec![false; n];
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            match (0..n).find(|&i| !done[i] && deps[i].iter().all(|&d| done[d])) {
                Some(i) => {
                    done[i] = true;
                    out.push(i);
                }
                None => {
                    let stuck: Vec<String> = (0..n).filter(|&i| !done[i]).map(|i| self.steps[i].id.clone()).collect();
                    return Err(format!("these steps depend on each other in a circle: {}", stuck.join(", ")));
                }
            }
        }
        Ok(out)
    }

    pub fn has_code_steps(&self) -> bool {
        self.steps.iter().any(|s| matches!(s.uses.as_str(), "python" | "r" | "script.python" | "script.r" | "grass" | "saga"))
    }

    /// Steps that download from the internet (open data services, satellite imagery, embeddings).
    pub fn network_steps(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self
            .steps
            .iter()
            .map(|s| s.uses.as_str())
            .filter(|u| matches!(*u, "data.fetch" | "dem.fetch" | "rs.search" | "rs.index" | "rs.fetch" | "embeddings.fetch" | "taxa.worms"))
            .collect();
        v.dedup();
        v
    }

    /// Fill defaults and reject unknown inputs.
    pub fn bind_inputs(&self, given: &Map<String, Value>) -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        for k in given.keys() {
            if !self.inputs.iter().any(|i| &i.name == k) {
                let known: Vec<&str> = self.inputs.iter().map(|i| i.name.as_str()).collect();
                return Err(format!("unknown input '{k}' (this recipe takes: {})", if known.is_empty() { "nothing".into() } else { known.join(", ") }));
            }
        }
        for i in &self.inputs {
            match given.get(&i.name).or(i.default.as_ref()) {
                Some(v) => {
                    out.insert(i.name.clone(), v.clone());
                }
                None => return Err(format!("input '{}' is required ({})", i.name, if i.description.is_empty() { &i.kind } else { &i.description })),
            }
        }
        Ok(out)
    }

    pub fn summary_json(&self) -> Value {
        json!({
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "kit": self.kit,
            "origin": self.origin.as_str(),
            "triggers": self.triggers.iter().map(Trigger::json).collect::<Vec<_>>(),
            "inputs": self.inputs.iter().map(|i| json!({ "name": i.name, "type": i.kind, "default": i.default, "description": i.description })).collect::<Vec<_>>(),
            "steps": self.steps.iter().map(|s| json!({ "id": s.id, "use": s.uses, "title": s.title })).collect::<Vec<_>>(),
            "outputs": self.outputs,
            "code_steps": self.has_code_steps(),
        })
    }
}

fn parse_trigger(item: &Value) -> Result<Option<Trigger>, String> {
    if let Some(s) = item.as_str() {
        return match s {
            "manual" => Ok(None),
            "device" => Ok(Some(Trigger::Device { kinds: vec![], has: vec![] })),
            other => Err(format!("unknown trigger '{other}' (device, folder, schedule, after, stac, webhook, sensor, manual)")),
        };
    }
    let Some(m) = item.as_object() else { return Err("a trigger must be a mapping such as { device: { kinds: [phone] } }".into()) };
    let Some((kind, spec)) = m.iter().next() else { return Err("empty trigger".into()) };
    if m.len() > 1 {
        return Err("one trigger per list item".into());
    }
    let on_start = spec.get("on_start").and_then(Value::as_bool).unwrap_or(false);
    match kind.as_str() {
        "device" => Ok(Some(Trigger::Device { kinds: as_str_list(spec.get("kinds")), has: as_str_list(spec.get("has")) })),
        "folder" => {
            let path = spec.as_str().or_else(|| spec.get("path").and_then(Value::as_str)).ok_or("folder trigger needs a path")?;
            Ok(Some(Trigger::Folder { path: path.to_string(), pattern: spec.get("pattern").and_then(Value::as_str).map(str::to_string), on_start }))
        }
        "schedule" => {
            let every = spec.get("every").map(parse_duration).transpose()?;
            let cron = spec.get("cron").and_then(Value::as_str).map(Cron::parse).transpose()?;
            if every.is_none() && cron.is_none() {
                return Err("schedule needs every: (e.g. 30m, 6h) or cron: (e.g. \"0 6 * * MON\")".into());
            }
            Ok(Some(Trigger::Schedule { every, cron, on_start }))
        }
        "after" => {
            let r = spec.as_str().or_else(|| spec.get("recipe").and_then(Value::as_str)).ok_or("after: needs a recipe id")?;
            Ok(Some(Trigger::After { recipe: r.to_string() }))
        }
        "manual" => Ok(None),
        "stac" => {
            let every = match spec.get("every") {
                Some(e) => parse_duration(e)?,
                None => Duration::from_secs(6 * 3600),
            };
            if every < Duration::from_secs(10) {
                return Err("stac: every must be at least 10s (satellite passes are days apart; 6h is plenty)".into());
            }
            let area = match spec.get("area") {
                Some(Value::Array(a)) if a.len() == 4 && a.iter().all(Value::is_number) => Some([a[0].as_f64().unwrap(), a[1].as_f64().unwrap(), a[2].as_f64().unwrap(), a[3].as_f64().unwrap()]),
                Some(Value::String(s)) if s != "auto" => return Err(format!("stac: area must be auto (the area of the last run) or [west, south, east, north], not '{s}'")),
                _ => None,
            };
            Ok(Some(Trigger::Stac {
                every,
                area,
                collection: spec.get("collection").and_then(Value::as_str).unwrap_or("sentinel-2-l2a").to_string(),
                max_cloud: spec.get("max_cloud").and_then(Value::as_f64).unwrap_or(40.0),
                endpoint: spec.get("endpoint").and_then(Value::as_str).unwrap_or("https://earth-search.aws.element84.com/v1").to_string(),
            }))
        }
        "webhook" => {
            let token = spec.as_str().or_else(|| spec.get("token").and_then(Value::as_str)).ok_or("webhook: needs token: (a long random string; it is the secret in the URL)")?;
            if token.len() < 16 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                return Err("webhook: token must be at least 16 letters, digits, - or _".into());
            }
            Ok(Some(Trigger::Webhook { token: token.to_string() }))
        }
        "sensor" => {
            let s = |k: &str| spec.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
            let n = |k: &str| spec.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|t| t.trim().parse().ok())));
            let (field, above, below, inside) = (s("field").map(|f| crate::sensors::clean_field(&f).0), n("above"), n("below"), s("inside").or_else(|| s("geofence")));
            if field.is_some() && above.is_none() && below.is_none() {
                return Err("sensor: give above: and/or below: for the field (e.g. { field: pm2_5, above: 35 })".into());
            }
            if field.is_none() && (above.is_some() || below.is_some()) {
                return Err("sensor: above:/below: need a field: (e.g. pm2_5, temperature, heart_rate)".into());
            }
            if field.is_none() && inside.is_none() {
                return Err("sensor: needs a field: with above:/below:, or inside: <polygon layer> for a geofence".into());
            }
            let cooldown = match spec.get("cooldown") {
                Some(c) => parse_duration(c)?,
                None => Duration::from_secs(600),
            };
            Ok(Some(Trigger::Sensor { field, above, below, device: s("device"), inside, cooldown }))
        }
        other => Err(format!("unknown trigger '{other}' (device, folder, schedule, after, stac, webhook, sensor, manual)")),
    }
}

/// "90s", "15m", "1h30m", "2d" or a number of seconds.
pub fn parse_duration(v: &Value) -> Result<Duration, String> {
    if let Some(n) = v.as_f64() {
        return if n >= 1.0 { Ok(Duration::from_secs_f64(n)) } else { Err("a schedule interval must be at least 1 s".into()) };
    }
    let s = v.as_str().ok_or("interval must be text like 30m or 6h")?.trim().to_ascii_lowercase();
    let mut total = 0f64;
    let mut num = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
        } else if c.is_whitespace() {
            continue;
        } else {
            let n: f64 = num.parse().map_err(|_| format!("bad interval '{s}'"))?;
            total += n * match c {
                's' => 1.0,
                'm' => 60.0,
                'h' => 3600.0,
                'd' => 86400.0,
                'w' => 604800.0,
                _ => return Err(format!("bad interval unit '{c}' in '{s}' (use s, m, h, d, w)")),
            };
            num.clear();
        }
    }
    if !num.is_empty() {
        total += num.parse::<f64>().map_err(|_| format!("bad interval '{s}'"))?;
    }
    if total < 1.0 {
        return Err(format!("interval '{s}' is too short"));
    }
    Ok(Duration::from_secs_f64(total))
}

pub fn human_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s.is_multiple_of(86400) {
        format!("{} day{}", s / 86400, if s / 86400 == 1 { "" } else { "s" })
    } else if s.is_multiple_of(3600) {
        format!("{} h", s / 3600)
    } else if s.is_multiple_of(60) {
        format!("{} min", s / 60)
    } else {
        format!("{s} s")
    }
}

/// Five-field cron (minute hour day-of-month month day-of-week), evaluated in local time.
#[derive(Debug, Clone)]
pub struct Cron {
    pub text: String,
    min: Vec<bool>,
    hour: Vec<bool>,
    dom: Vec<bool>,
    mon: Vec<bool>,
    dow: Vec<bool>,
    dom_any: bool,
    dow_any: bool,
}

impl Cron {
    pub fn parse(s: &str) -> Result<Cron, String> {
        let f: Vec<&str> = s.split_whitespace().collect();
        if f.len() != 5 {
            return Err(format!("cron '{s}' needs 5 fields: minute hour day month weekday"));
        }
        const MONTHS: [&str; 12] = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        const DAYS: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
        let field = |text: &str, lo: u32, hi: u32, names: &[&str], name_base: u32| -> Result<Vec<bool>, String> {
            let mut set = vec![false; hi as usize + 1];
            for part in text.split(',') {
                let (range, step) = match part.split_once('/') {
                    Some((r, st)) => (r, st.parse::<u32>().map_err(|_| format!("bad step in cron '{s}'"))?.max(1)),
                    None => (part, 1),
                };
                let val = |t: &str| -> Result<u32, String> {
                    let u = t.to_ascii_uppercase();
                    if let Some(i) = names.iter().position(|n| *n == u) {
                        return Ok(i as u32 + name_base);
                    }
                    t.parse::<u32>().map_err(|_| format!("bad value '{t}' in cron '{s}'"))
                };
                let (a, b) = if range == "*" {
                    (lo, hi)
                } else if let Some((x, y)) = range.split_once('-') {
                    (val(x)?, val(y)?)
                } else {
                    let v = val(range)?;
                    (v, if step > 1 { hi } else { v })
                };
                if a < lo || b > hi || a > b {
                    return Err(format!("value out of range in cron '{s}'"));
                }
                let mut v = a;
                while v <= b {
                    set[v as usize] = true;
                    v += step;
                }
            }
            Ok(set)
        };
        let mut dow = field(f[4], 0, 7, &DAYS, 0)?;
        if dow[7] {
            dow[0] = true; // 7 = Sunday too
        }
        dow.truncate(7);
        Ok(Cron {
            text: s.to_string(),
            min: field(f[0], 0, 59, &[], 0)?,
            hour: field(f[1], 0, 23, &[], 0)?,
            dom: field(f[2], 1, 31, &[], 0)?,
            mon: field(f[3], 1, 12, &MONTHS, 1)?,
            dow,
            dom_any: f[2] == "*",
            dow_any: f[4] == "*",
        })
    }

    /// minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6 (Sunday = 0)
    pub fn matches(&self, minute: u32, hour: u32, day: u32, month: u32, weekday: u32) -> bool {
        let g = |v: &Vec<bool>, i: u32| v.get(i as usize).copied().unwrap_or(false);
        if !g(&self.min, minute) || !g(&self.hour, hour) || !g(&self.mon, month) {
            return false;
        }
        let (d, w) = (g(&self.dom, day), g(&self.dow, weekday));
        match (self.dom_any, self.dow_any) {
            (true, true) => true,
            (true, false) => w,
            (false, true) => d,
            (false, false) => d || w, // classic cron: either restricted field matches
        }
    }
}

// ------------------------------------------------------------------ expressions

/// What `${…}` can see while a run executes.
pub struct Ctx<'a> {
    pub inputs: &'a Map<String, Value>,
    pub run: &'a Value,
    pub recipe: &'a str,
    pub trigger: &'a Value,
    pub steps: &'a HashMap<String, Value>,
}

/// Every `${path}` inside strings of `v` (the paths, without `${}`).
pub fn refs_in(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            let mut rest = s.as_str();
            while let Some(i) = rest.find("${") {
                let after = &rest[i + 2..];
                match after.find('}') {
                    Some(j) => {
                        out.push(after[..j].trim().to_string());
                        rest = &after[j + 1..];
                    }
                    None => break,
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| refs_in(x, out)),
        Value::Object(o) => o.values().for_each(|x| refs_in(x, out)),
        _ => {}
    }
}

/// Substitute expressions. A string that is exactly one `${…}` keeps the referenced JSON type
/// (so `layers: "${import.layers}"` yields a list); otherwise values are interpolated as text.
pub fn resolve(v: &Value, ctx: &Ctx) -> Result<Value, String> {
    match v {
        Value::String(s) => resolve_str(s, ctx),
        Value::Array(a) => a.iter().map(|x| resolve(x, ctx)).collect::<Result<Vec<_>, _>>().map(Value::Array),
        Value::Object(o) => {
            let mut m = Map::new();
            for (k, x) in o {
                m.insert(k.clone(), resolve(x, ctx)?);
            }
            Ok(Value::Object(m))
        }
        other => Ok(other.clone()),
    }
}

fn resolve_str(s: &str, ctx: &Ctx) -> Result<Value, String> {
    let t = s.trim();
    if t.starts_with("${") && t.ends_with('}') {
        let inner = &t[2..t.len() - 1];
        if !inner.contains("${") && !inner.contains('}') {
            return lookup(inner.trim(), ctx);
        }
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let j = after.find('}').ok_or_else(|| format!("unclosed '${{' in \"{s}\""))?;
        out.push_str(&value_text(&lookup(after[..j].trim(), ctx)?));
        rest = &after[j + 1..];
    }
    out.push_str(rest);
    Ok(Value::String(out))
}

/// `a.b.0.c` lookup with an optional fallback: `${inputs.title ?? Field map}`.
pub fn lookup(path: &str, ctx: &Ctx) -> Result<Value, String> {
    if let Some((p, fallback)) = path.split_once("??") {
        return match lookup(p.trim(), ctx) {
            Ok(v) if !v.is_null() => Ok(v),
            _ => Ok(Value::String(fallback.trim().trim_matches('"').to_string())),
        };
    }
    let mut parts = path.split('.');
    let head = parts.next().unwrap_or("");
    let mut cur: Value = match head {
        "inputs" => Value::Object(ctx.inputs.clone()),
        "run" => ctx.run.clone(),
        "recipe" => Value::String(ctx.recipe.to_string()),
        "trigger" => ctx.trigger.clone(),
        id => ctx.steps.get(id).cloned().ok_or_else(|| format!("${{{path}}}: step '{id}' has not produced outputs (did it run?)"))?,
    };
    for p in parts {
        cur = match &cur {
            Value::Object(o) => match o.get(p) {
                Some(v) => v.clone(),
                None => {
                    let keys: Vec<&str> = o.keys().map(String::as_str).collect();
                    return Err(format!("${{{path}}}: no '{p}' here (available: {})", keys.join(", ")));
                }
            },
            Value::Array(a) => p.parse::<usize>().ok().and_then(|i| a.get(i).cloned()).ok_or_else(|| format!("${{{path}}}: no item '{p}'"))?,
            Value::Null => Value::Null,
            other => return Err(format!("${{{path}}}: cannot look inside {other}")),
        };
    }
    Ok(cur)
}

/// How a value reads when interpolated into text.
pub fn value_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(value_text).collect::<Vec<_>>().join(", "),
        Value::Object(_) => v.to_string(),
    }
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !matches!(s.trim(), "" | "0" | "false" | "no" | "none"),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: &str = r#"
recipe: demo
title: Demo
triggers:
  - device: { kinds: [phone], has: [photos] }
  - schedule: { every: 1h30m }
inputs:
  source: { type: path, default: auto }
steps:
  - id: map
    use: export.map
    with: { layers: "${import.layers}", title: "Photos ${run.date}" }
  - id: import
    use: devices.import
    with: { source: "${inputs.source}" }
"#;

    #[test]
    fn parses_and_orders_by_reference() {
        let r = Recipe::parse(R, Origin::Api).unwrap();
        assert_eq!(r.id, "demo");
        assert_eq!(r.triggers.len(), 2);
        assert!(matches!(&r.triggers[1], Trigger::Schedule { every: Some(d), .. } if d.as_secs() == 5400));
        let order: Vec<&str> = r.order().unwrap().into_iter().map(|i| r.steps[i].id.as_str()).collect();
        assert_eq!(order, ["import", "map"], "map references import, so import runs first");
    }

    #[test]
    fn reports_every_problem() {
        let bad = "recipe: Bad Name\nsteps:\n  - id: a\n    use: x\n    with: { v: \"${b.out}\" }\n  - id: b\n    use: y\n    with: { v: \"${a.out}\" }\n  - id: c\n    use: z\n    with: { v: \"${nope.x}\", w: \"${inputs.q}\" }\n";
        let errs = Recipe::parse(bad, Origin::Api).unwrap_err();
        let all = errs.join("\n");
        assert!(all.contains("recipe id"), "{all}");
        assert!(all.contains("circle"), "{all}");
        assert!(all.contains("'nope'"), "{all}");
        assert!(all.contains("no input 'q'"), "{all}");
    }

    #[test]
    fn resolves_expressions() {
        let inputs: Map<String, Value> = serde_json::from_value(json!({ "source": "/media/phone" })).unwrap();
        let mut steps = HashMap::new();
        steps.insert("import".to_string(), json!({ "layers": ["a.photos", "a.tracks"], "photos": 12, "device": "PHONE" }));
        let run = json!({ "date": "2026-10-15" });
        let ctx = Ctx { inputs: &inputs, run: &run, recipe: "demo", trigger: &Value::Null, steps: &steps };
        assert_eq!(resolve(&json!("${import.layers}"), &ctx).unwrap(), json!(["a.photos", "a.tracks"]));
        assert_eq!(resolve(&json!("${import.layers.1}"), &ctx).unwrap(), json!("a.tracks"));
        assert_eq!(resolve(&json!("${import.photos} photos on ${import.device}, ${run.date}"), &ctx).unwrap(), json!("12 photos on PHONE, 2026-10-15"));
        assert_eq!(resolve(&json!("${inputs.title ?? Field map}"), &ctx).unwrap(), json!("Field map"));
        assert!(resolve(&json!("${import.nothing}"), &ctx).is_err());
        assert!(!truthy(&json!(0)) && truthy(&json!(3)) && !truthy(&json!([])));
    }

    #[test]
    fn durations_and_cron() {
        assert_eq!(parse_duration(&json!("90s")).unwrap().as_secs(), 90);
        assert_eq!(parse_duration(&json!("1h30m")).unwrap().as_secs(), 5400);
        assert!(parse_duration(&json!("5x")).is_err());
        let c = Cron::parse("0 6 * * MON").unwrap();
        assert!(c.matches(0, 6, 19, 10, 1));
        assert!(!c.matches(0, 6, 20, 10, 2));
        assert!(!c.matches(1, 6, 19, 10, 1));
        let c = Cron::parse("*/15 8-17 * * MON-FRI").unwrap();
        assert!(c.matches(45, 17, 1, 1, 5) && !c.matches(50, 17, 1, 1, 5) && !c.matches(0, 9, 1, 1, 0));
        assert!(Cron::parse("61 * * * *").is_err());
    }
}
