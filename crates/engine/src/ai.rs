//! AI on the user's own terms (docs/AI.md):
//!
//! * **Ask** (`POST /api/ask`): a question in plain words, answered by a language model that looks at
//!   the data through GeoSpaX's tools: the layers and their fields, field statistics, attribute
//!   queries, selections, recipes. It runs on the user's computer through Ollama, on any server that
//!   speaks the OpenAI chat API (LM Studio, llama.cpp, vLLM…), or on Claude with the user's own key.
//!   Nothing is sent anywhere until the user picks a provider; the key stays in the state folder and
//!   is never sent back to the browser.
//! * **MCP server** (`geospax-server mcp`): the same tools for any MCP client (Claude Desktop, Claude
//!   Code, editors), over stdio.
//!
//! Every tool is a call to the engine's own API, so the assistant can do nothing a user could not do
//! from the app, and recipes that run Python or R code are refused.

use crate::router::ApiRequest;
use crate::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::Arc;

/// Tool results longer than this are cut (the model sees that they were).
const MAX_RESULT: usize = 12_000;
/// Model ↔ tool round trips per question.
const MAX_ROUNDS: usize = 8;
const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Claude models that take `fallbacks: "default"` (a declined request is retried on another model).
const FALLBACK_MODELS: &[&str] = &["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"];

const SYSTEM: &str = "You are the assistant inside GeoSpaX, a desktop GIS. Answer questions about the user's \
map data by calling the tools: list_layers first when you do not know the layer ids or fields. Never invent \
numbers, names or fields: every figure you give must come from a tool result, and say which layer (and which \
filter) it came from. Filters are SQL WHERE clauses on the layer's own field names, e.g. \
\"elevation_m > 2000 AND transect = 'YUS'\". When the user asks to see or pick features, use select_features \
(it highlights them on the map) or zoom_to_layer. Recipes are whole workflows (maps, hot spots, reports); run \
one only when the user asks for that result. Keep answers short and plain; use units.";

/// (name, description, JSON schema, shown to MCP clients)
fn defs() -> Vec<(&'static str, &'static str, Value, bool)> {
    let layer = json!({ "type": "string", "description": "layer id, as list_layers gives it" });
    let where_ = json!({ "type": "string", "description": "SQL WHERE clause on the layer's fields, e.g. \"area_ha > 10\"" });
    vec![
        ("list_layers", "The vector layers (id, name, geometry, feature count, fields and their types, any filter) and rasters on the map.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }), true),
        ("describe_field", "Statistics of one field: min, max, mean, quantiles for numbers; the most frequent values and their counts for text.",
            json!({ "type": "object", "properties": { "layer": layer, "field": { "type": "string" } }, "required": ["layer", "field"], "additionalProperties": false }), true),
        ("query_features", "Attribute rows of a layer, optionally filtered and sorted, with the total number of matching features. At most 50 rows.",
            json!({ "type": "object", "properties": {
                "layer": layer, "where": where_,
                "sort": { "type": "string", "description": "field to sort by" },
                "descending": { "type": "boolean" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
            }, "required": ["layer"], "additionalProperties": false }), true),
        ("select_features", "Select the features matching a WHERE clause; they are highlighted on the map and listed in the attribute table. Returns how many.",
            json!({ "type": "object", "properties": { "layer": layer, "where": where_ }, "required": ["layer", "where"], "additionalProperties": false }), true),
        ("zoom_to_layer", "Zoom the map to a layer.",
            json!({ "type": "object", "properties": { "layer": layer }, "required": ["layer"], "additionalProperties": false }), false),
        ("list_recipes", "The workflows GeoSpaX can run (finished maps, hot spots, interpolation, reports…) with their inputs.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }), true),
        ("run_recipe", "Start a recipe. Returns the run id; the run continues in the background (see get_run).",
            json!({ "type": "object", "properties": {
                "recipe": { "type": "string", "description": "recipe id from list_recipes" },
                "inputs": { "type": "object", "description": "recipe inputs by name, e.g. {\"layer\": \"survey\"}" }
            }, "required": ["recipe"], "additionalProperties": false }), true),
        ("get_run", "Status, message and output files of a recipe run.",
            json!({ "type": "object", "properties": { "run": { "type": "string" } }, "required": ["run"], "additionalProperties": false }), true),
    ]
}

/// Tool names and descriptions for the settings dialog and docs.
pub fn tool_names() -> Vec<&'static str> {
    defs().into_iter().map(|d| d.0).collect()
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn cut(v: &Value) -> String {
    let s = v.to_string();
    if s.len() <= MAX_RESULT {
        return s;
    }
    let mut end = MAX_RESULT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [cut: {} of {} characters shown]", &s[..end], end, s.len())
}

// ------------------------------------------------------------------ settings

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct Settings {
    /// "ollama" | "openai" | "anthropic"
    pub provider: String,
    pub url: String,
    pub model: String,
    #[serde(default)]
    pub key: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { provider: "ollama".into(), url: "http://127.0.0.1:11434".into(), model: "llama3.2".into(), key: String::new() }
    }
}

impl Settings {
    fn base_url(&self) -> String {
        let u = self.url.trim().trim_end_matches('/');
        if u.is_empty() {
            match self.provider.as_str() {
                "anthropic" => "https://api.anthropic.com".into(),
                "openai" => "https://api.openai.com".into(),
                _ => "http://127.0.0.1:11434".into(),
            }
        } else {
            u.to_string()
        }
    }

    /// What the browser may see: everything but the key.
    pub fn public_json(&self) -> Value {
        json!({ "provider": self.provider, "url": self.url, "model": self.model, "has_key": !self.key.is_empty(), "tools": tool_names() })
    }
}

fn settings_path(state: &Path) -> std::path::PathBuf {
    state.join("ai.json")
}

pub fn load_settings(state: &Path) -> Settings {
    std::fs::read(settings_path(state)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Save settings; `key: null` (absent) keeps the stored key, `""` removes it.
pub fn save_settings(state: &Path, body: &Value) -> Result<Settings, String> {
    let mut s = load_settings(state);
    if let Some(p) = body["provider"].as_str() {
        if !matches!(p, "ollama" | "openai" | "anthropic") {
            return Err(format!("unknown provider '{p}' (ollama, openai or anthropic)"));
        }
        s.provider = p.into();
    }
    if let Some(u) = body["url"].as_str() {
        let u = u.trim();
        if !u.is_empty() && !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err("the address must start with http:// or https://".into());
        }
        s.url = u.into();
    }
    if let Some(m) = body["model"].as_str() {
        s.model = m.trim().into();
    }
    if let Some(k) = body["key"].as_str() {
        s.key = k.trim().into();
    }
    std::fs::create_dir_all(state).map_err(|e| e.to_string())?;
    let path = settings_path(state);
    std::fs::write(&path, serde_json::to_vec_pretty(&s).unwrap_or_default()).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(s)
}

// ------------------------------------------------------------------ tools

impl Engine {
    fn api(self: &Arc<Self>, method: &str, path: &str, query: &str, body: Option<Value>) -> Result<Value, String> {
        let r = self.handle(ApiRequest {
            method: method.into(),
            path: path.into(),
            query: query.into(),
            body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
            ws: None,
        });
        let v: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        if r.status >= 400 {
            return Err(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("HTTP {}", r.status)));
        }
        Ok(v)
    }

    fn layer_arg(&self, args: &Value) -> Result<String, String> {
        let id = args["layer"].as_str().ok_or("'layer' is missing")?;
        if self.layer(id).is_some() {
            return Ok(id.to_string());
        }
        // be forgiving with names: the model may use what the user called the layer
        let lower = id.to_lowercase();
        self.layers()
            .iter()
            .find(|l| l.info.name.to_lowercase() == lower || l.info.id.to_lowercase() == lower)
            .map(|l| l.info.id.clone())
            .ok_or_else(|| format!("there is no layer '{id}' (call list_layers for the ids)"))
    }

    /// Run one tool: (result for the model, an action for the app to carry out).
    pub fn ai_tool(self: &Arc<Self>, name: &str, args: &Value) -> Result<(Value, Option<Value>), String> {
        match name {
            "list_layers" => {
                let l = self.api("GET", "/api/layers", "", None)?;
                let layers: Vec<Value> = l["layers"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|x| {
                        json!({
                            "id": x["id"], "name": x["name"], "geometry": x["geometry"], "features": x["feature_count"],
                            "fields": x["fields"].as_array().map(|f| f.iter().map(|f| format!("{} ({})", f["name"].as_str().unwrap_or(""), f["kind"].as_str().unwrap_or(""))).collect::<Vec<_>>()),
                            "filter": x["filter"],
                        })
                    })
                    .collect();
                let rasters: Vec<Value> = self
                    .rasters()
                    .iter()
                    .map(|r| json!({ "id": r.info.id, "title": r.info.title, "kind": r.info.kind, "units": r.info.units, "bounds": r.info.bounds }))
                    .collect();
                Ok((json!({ "layers": layers, "rasters": rasters }), None))
            }
            "describe_field" => {
                let id = self.layer_arg(args)?;
                let field = args["field"].as_str().ok_or("'field' is missing")?;
                let l = self.layer(&id).ok_or("layer vanished")?;
                let fi = l.field_index(field).ok_or_else(|| format!("layer '{id}' has no field '{field}'"))?;
                let base = format!("/api/layers/{}", enc(&id));
                let numeric = matches!(l.info.fields[fi].kind, "integer" | "real");
                let mut v = if numeric {
                    self.api("GET", &format!("{base}/classify"), &format!("field={}&method=quantile&classes=4", enc(field)), None)?
                } else {
                    self.api("GET", &format!("{base}/unique"), &format!("field={}&limit=20", enc(field)), None)?
                };
                // timings and colours mean nothing to the model
                if let Some(o) = v.as_object_mut() {
                    o.retain(|k, _| !k.ends_with("_ms") && k != "colors");
                }
                Ok((json!({ "layer": id, "field": field, "kind": l.info.fields[fi].kind, "summary": v }), None))
            }
            "query_features" => {
                let id = self.layer_arg(args)?;
                let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 50);
                let t = self.api("POST", &format!("/api/layers/{}/table", enc(&id)), "", Some(json!({
                    "where": args["where"], "sort": args["sort"], "desc": args["descending"].as_bool().unwrap_or(false), "limit": limit,
                })))?;
                let fields: Vec<String> = t["fields"].as_array().map(|a| a.iter().filter_map(|f| f.as_str().map(String::from)).collect()).unwrap_or_default();
                let rows: Vec<Value> = t["rows"]
                    .as_array()
                    .map(|rs| {
                        rs.iter()
                            .map(|r| {
                                let mut o = serde_json::Map::new();
                                o.insert("fid".into(), r["fid"].clone());
                                if let Some(vals) = r["values"].as_array() {
                                    for (k, v) in fields.iter().zip(vals) {
                                        o.insert(k.clone(), v.clone());
                                    }
                                }
                                Value::Object(o)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Ok((json!({ "layer": id, "total": t["total"], "rows": rows }), None))
            }
            "select_features" => {
                let id = self.layer_arg(args)?;
                let r = self.api("POST", &format!("/api/layers/{}/select", enc(&id)), "", Some(json!({ "where": args["where"] })))?;
                let action = json!({ "kind": "select", "layer": id, "fids": r["fids"] });
                Ok((json!({ "layer": id, "selected": r["count"], "capped": r["capped"] }), Some(action)))
            }
            "zoom_to_layer" => {
                let id = self.layer_arg(args)?;
                Ok((json!({ "zoomed_to": id }), Some(json!({ "kind": "zoom", "layer": id }))))
            }
            "list_recipes" => {
                let r = self.automation.recipes();
                let list: Vec<Value> = r
                    .iter()
                    .map(|r| {
                        let s = r.summary_json();
                        json!({ "id": s["id"], "title": s["title"], "description": s["description"], "inputs": s["inputs"], "runs_code": s["code_steps"] })
                    })
                    .collect();
                Ok((json!({ "recipes": list }), None))
            }
            "run_recipe" => {
                let id = args["recipe"].as_str().ok_or("'recipe' is missing")?;
                let r = self.automation.recipe(id).ok_or_else(|| format!("there is no recipe '{id}' (call list_recipes)"))?;
                if r.has_code_steps() {
                    return Err(format!("'{id}' runs Python or R code on this computer; start it yourself from the Automate pane"));
                }
                let run = self.api("POST", &format!("/api/recipes/{}/run", enc(id)), "", Some(json!({ "inputs": args["inputs"] })))?;
                let rid = run["id"].clone();
                Ok((json!({ "run": rid, "status": run["status"] }), Some(json!({ "kind": "run", "run": rid }))))
            }
            "get_run" => {
                let id = args["run"].as_str().ok_or("'run' is missing")?;
                let r = self.api("GET", &format!("/api/runs/{}", enc(id)), "", None)?;
                Ok((json!({ "run": id, "status": r["status"], "message": r["message"].clone(), "error": r["error"], "files": r["artifacts"] }), None))
            }
            other => Err(format!("unknown tool '{other}'")),
        }
    }

    fn run_tool(self: &Arc<Self>, name: &str, args: &Value, steps: &mut Vec<Value>, actions: &mut Vec<Value>) -> (String, bool) {
        // In the Ask pane a recipe is never started by the model: it becomes a plan the user reads and
        // approves (Run) or dismisses. MCP clients start runs directly unless the server is --read-only.
        if name == "run_recipe" {
            return match self.recipe_plan(args) {
                Ok(plan) => {
                    steps.push(json!({ "tool": name, "args": args, "ok": true, "plan": true }));
                    actions.push(plan);
                    ("Not started: the plan (recipe, inputs and steps) is shown to the user, who runs it with the Run button. Tell the user what it will do.".into(), false)
                }
                Err(e) => {
                    steps.push(json!({ "tool": name, "args": args, "ok": false, "error": e }));
                    (format!("error: {e}"), true)
                }
            };
        }
        match self.ai_tool(name, args) {
            Ok((v, a)) => {
                if let Some(a) = a {
                    actions.push(a);
                }
                steps.push(json!({ "tool": name, "args": args, "ok": true }));
                (cut(&v), false)
            }
            Err(e) => {
                steps.push(json!({ "tool": name, "args": args, "ok": false, "error": e }));
                (format!("error: {e}"), true)
            }
        }
    }

    /// A recipe run the assistant proposes, as a plan for the user to approve: the recipe, its inputs
    /// (the model's values over the defaults) and the steps it will run, in order.
    pub fn recipe_plan(&self, args: &Value) -> Result<Value, String> {
        let id = args["recipe"].as_str().ok_or("'recipe' is missing")?;
        let r = self.automation.recipe(id).ok_or_else(|| format!("there is no recipe '{id}' (call list_recipes)"))?;
        if r.has_code_steps() {
            return Err(format!("'{id}' runs Python or R code on this computer; start it yourself from the Automate pane"));
        }
        let s = r.summary_json();
        let given = args["inputs"].as_object().cloned().unwrap_or_default();
        if let Some(bad) = given.keys().find(|k| !s["inputs"].as_array().is_some_and(|a| a.iter().any(|i| i["name"] == **k))) {
            return Err(format!("'{id}' has no input '{bad}' (call list_recipes)"));
        }
        let inputs: Vec<Value> = s["inputs"]
            .as_array()
            .map(|a| a.iter().map(|i| json!({ "name": i["name"], "value": given.get(i["name"].as_str().unwrap_or("")).cloned().unwrap_or(i["default"].clone()), "given": given.contains_key(i["name"].as_str().unwrap_or("")) })).collect())
            .unwrap_or_default();
        Ok(json!({ "kind": "plan", "recipe": id, "title": s["title"], "inputs": inputs, "args": Value::Object(given), "steps": s["steps"], "outputs": s["outputs"] }))
    }

    // ------------------------------------------------------------------ Ask

    /// Answer a question with the configured model and the tools above.
    /// `history`: earlier turns as {role: "user"|"assistant", text}.
    pub fn ask(self: &Arc<Self>, question: &str, history: &[Value]) -> Result<Value, String> {
        let s = load_settings(&self.state_dir);
        if question.trim().is_empty() {
            return Err("ask a question".into());
        }
        if s.model.is_empty() {
            return Err("choose a model in the assistant's settings".into());
        }
        if s.provider == "anthropic" && s.key.is_empty() {
            return Err("Claude needs your API key (assistant settings)".into());
        }
        let past: Vec<(String, String)> = history
            .iter()
            .rev()
            .take(12)
            .rev()
            .filter_map(|m| Some((m["role"].as_str()?.to_string(), m["text"].as_str()?.to_string())))
            .filter(|(r, t)| matches!(r.as_str(), "user" | "assistant") && !t.is_empty())
            .collect();
        let (mut steps, mut actions) = (Vec::new(), Vec::new());
        let answer = match s.provider.as_str() {
            "anthropic" => self.ask_anthropic(&s, &past, question, &mut steps, &mut actions)?,
            "openai" => self.ask_chat(&s, true, &past, question, &mut steps, &mut actions)?,
            _ => self.ask_chat(&s, false, &past, question, &mut steps, &mut actions)?,
        };
        Ok(json!({ "answer": answer, "steps": steps, "actions": actions, "provider": s.provider, "model": s.model }))
    }

    /// Ollama (`/api/chat`) and OpenAI-compatible servers (`/v1/chat/completions`).
    fn ask_chat(self: &Arc<Self>, s: &Settings, openai: bool, past: &[(String, String)], q: &str, steps: &mut Vec<Value>, actions: &mut Vec<Value>) -> Result<String, String> {
        let tools: Vec<Value> = defs()
            .into_iter()
            .map(|(n, d, schema, _)| json!({ "type": "function", "function": { "name": n, "description": d, "parameters": schema } }))
            .collect();
        let mut msgs = vec![json!({ "role": "system", "content": SYSTEM })];
        msgs.extend(past.iter().map(|(r, t)| json!({ "role": r, "content": t })));
        msgs.push(json!({ "role": "user", "content": q }));
        let url = if openai { format!("{}/v1/chat/completions", s.base_url()) } else { format!("{}/api/chat", s.base_url()) };
        let auth = format!("Bearer {}", s.key);
        let headers: Vec<(&str, &str)> = if openai && !s.key.is_empty() { vec![("Authorization", auth.as_str())] } else { vec![] };
        for _ in 0..MAX_ROUNDS {
            let mut body = json!({ "model": s.model, "messages": msgs, "tools": tools });
            if !openai {
                body["stream"] = false.into();
            }
            let raw = crate::raster::http_with(&url, Some(&body.to_string()), &headers, 300).map_err(|e| provider_error(&s.provider, &e))?;
            let r: Value = serde_json::from_slice(&raw).map_err(|e| format!("the model server sent something that is not JSON: {e}"))?;
            if let Some(e) = r["error"].as_str().or(r["error"]["message"].as_str()) {
                return Err(format!("{}: {e}", s.provider));
            }
            let msg = if openai { r["choices"][0]["message"].clone() } else { r["message"].clone() };
            let calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();
            if calls.is_empty() {
                return Ok(msg["content"].as_str().unwrap_or("").trim().to_string());
            }
            msgs.push(msg);
            for c in calls {
                let name = c["function"]["name"].as_str().unwrap_or("");
                // OpenAI sends the arguments as a JSON string, Ollama as an object
                let args = match &c["function"]["arguments"] {
                    Value::String(t) => serde_json::from_str(t).unwrap_or(json!({})),
                    v if v.is_object() => v.clone(),
                    _ => json!({}),
                };
                let (out, _) = self.run_tool(name, &args, steps, actions);
                if openai {
                    msgs.push(json!({ "role": "tool", "tool_call_id": c["id"], "content": out }));
                } else {
                    msgs.push(json!({ "role": "tool", "tool_name": name, "content": out }));
                }
            }
        }
        Err(format!("no answer after {MAX_ROUNDS} rounds of tool calls; try a narrower question"))
    }

    /// Claude Messages API: the assistant's content goes back unchanged (thinking blocks included).
    fn ask_anthropic(self: &Arc<Self>, s: &Settings, past: &[(String, String)], q: &str, steps: &mut Vec<Value>, actions: &mut Vec<Value>) -> Result<String, String> {
        let tools: Vec<Value> = defs().into_iter().map(|(n, d, schema, _)| json!({ "name": n, "description": d, "input_schema": schema })).collect();
        let mut msgs: Vec<Value> = past.iter().map(|(r, t)| json!({ "role": r, "content": t })).collect();
        msgs.push(json!({ "role": "user", "content": q }));
        let fallback = FALLBACK_MODELS.contains(&s.model.as_str());
        let mut headers = vec![("x-api-key", s.key.as_str()), ("anthropic-version", ANTHROPIC_VERSION)];
        if fallback {
            headers.push(("anthropic-beta", "server-side-fallback-2026-07-01"));
        }
        let url = format!("{}/v1/messages", s.base_url());
        for _ in 0..MAX_ROUNDS {
            let mut body = json!({ "model": s.model, "max_tokens": 16000, "system": SYSTEM, "tools": tools, "messages": msgs });
            if fallback {
                body["fallbacks"] = "default".into();
            }
            let raw = crate::raster::http_with(&url, Some(&body.to_string()), &headers, 600).map_err(|e| provider_error("anthropic", &e))?;
            let r: Value = serde_json::from_slice(&raw).map_err(|e| format!("Claude sent something that is not JSON: {e}"))?;
            if r["type"] == "error" {
                return Err(format!("Claude: {}", r["error"]["message"].as_str().unwrap_or("error")));
            }
            let content = r["content"].as_array().cloned().unwrap_or_default();
            let text = || {
                content
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_string()
            };
            match r["stop_reason"].as_str().unwrap_or("") {
                "tool_use" => {
                    msgs.push(json!({ "role": "assistant", "content": content }));
                    let mut results = Vec::new();
                    for b in content.iter().filter(|b| b["type"] == "tool_use") {
                        let (out, is_error) = self.run_tool(b["name"].as_str().unwrap_or(""), &b["input"], steps, actions);
                        results.push(json!({ "type": "tool_result", "tool_use_id": b["id"], "content": out, "is_error": is_error }));
                    }
                    // all results of one turn go back in one message
                    msgs.push(json!({ "role": "user", "content": results }));
                }
                "refusal" => {
                    let why = r["stop_details"]["explanation"].as_str().unwrap_or("");
                    return Err(format!("Claude declined to answer this. {why}").trim().to_string());
                }
                "pause_turn" => msgs.push(json!({ "role": "assistant", "content": content })),
                "max_tokens" => return Ok(format!("{}\n\n(The answer was cut at the length limit.)", text())),
                _ => return Ok(text()),
            }
        }
        Err(format!("no answer after {MAX_ROUNDS} rounds of tool calls; try a narrower question"))
    }

    /// Models the configured provider offers (for the settings dialog).
    pub fn ai_models(&self) -> Value {
        let s = load_settings(&self.state_dir);
        let (models, error): (Vec<String>, Option<String>) = match s.provider.as_str() {
            // the current Claude models (docs/AI.md); the user may type another id
            "anthropic" => (vec!["claude-opus-5-5".into(), "claude-sonnet-5-5".into(), "claude-haiku-5-5".into()], None),
            p => {
                let openai = p == "openai";
                let url = if openai { format!("{}/v1/models", s.base_url()) } else { format!("{}/api/tags", s.base_url()) };
                let auth = format!("Bearer {}", s.key);
                let h: Vec<(&str, &str)> = if openai && !s.key.is_empty() { vec![("Authorization", auth.as_str())] } else { vec![] };
                match crate::raster::http_with(&url, None, &h, 8).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) {
                    Ok(v) => {
                        let list = if openai { v["data"].as_array().cloned() } else { v["models"].as_array().cloned() }.unwrap_or_default();
                        let key = if openai { "id" } else { "name" };
                        (list.iter().filter_map(|m| m[key].as_str().map(String::from)).collect(), None)
                    }
                    Err(e) => (vec![], Some(provider_error(p, &e))),
                }
            }
        };
        json!({ "provider": s.provider, "models": models, "error": error })
    }
}

fn provider_error(provider: &str, e: &str) -> String {
    let lower = e.to_lowercase();
    if provider == "ollama" && (lower.contains("connect") || lower.contains("refused") || lower.contains("resolve")) {
        return format!("Ollama is not running on this computer (start it, or install it from ollama.com): {e}");
    }
    if lower.contains("401") || lower.contains("authentication") || lower.contains("invalid x-api-key") {
        return format!("{provider}: the API key was not accepted: {e}");
    }
    format!("{provider}: {e}")
}

// ------------------------------------------------------------------ MCP

/// What an MCP client may do: every tool (the default), only tools that change nothing, or a named
/// list; and an optional JSON Lines audit log of every tool call.
#[derive(Debug, Clone, Default)]
pub struct McpPolicy {
    /// Hide and refuse tools that write files or start work (`run_recipe`).
    pub read_only: bool,
    /// When set, only these tools are listed and callable.
    pub allow: Option<Vec<String>>,
    /// Append one JSON line per tool call (time, tool, arguments, ok, milliseconds, error).
    pub audit: Option<std::path::PathBuf>,
}

/// Tools that create files or start background work; refused in read-only mode.
const WRITES: &[&str] = &["run_recipe"];

impl McpPolicy {
    pub fn allows(&self, tool: &str) -> bool {
        !(self.read_only && WRITES.contains(&tool)) && self.allow.as_ref().is_none_or(|a| a.iter().any(|t| t == tool))
    }

    fn log(&self, tool: &str, args: &Value, res: &Result<Value, String>, ms: u128) {
        let Some(p) = &self.audit else { return };
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let line = json!({ "ts": ts, "tool": tool, "arguments": args, "ok": res.is_ok(), "ms": ms, "error": res.as_ref().err() });
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Serve the tools over MCP (JSON-RPC 2.0, one message per line) until `input` ends.
pub fn mcp_serve(engine: &Arc<Engine>, input: impl BufRead, output: impl Write) -> std::io::Result<()> {
    mcp_serve_with(engine, &McpPolicy::default(), input, output)
}

/// [`mcp_serve`] under a policy (read-only mode, a tool allow list, an audit log).
pub fn mcp_serve_with(engine: &Arc<Engine>, policy: &McpPolicy, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => mcp_handle_with(engine, policy, &msg),
            Err(e) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } })),
        };
        if let Some(r) = reply {
            writeln!(output, "{r}")?;
            output.flush()?;
        }
    }
    Ok(())
}

/// One MCP message; None for notifications.
pub fn mcp_handle(engine: &Arc<Engine>, msg: &Value) -> Option<Value> {
    mcp_handle_with(engine, &McpPolicy::default(), msg)
}

/// The MCP tools an assistant sees under a policy: (name, description, input schema).
pub fn mcp_tools(policy: &McpPolicy) -> Vec<(&'static str, &'static str, Value)> {
    defs().into_iter().filter(|d| d.3 && policy.allows(d.0)).map(|(n, d, s, _)| (n, d, s)).collect()
}

/// [`mcp_handle`] under a policy.
pub fn mcp_handle_with(engine: &Arc<Engine>, policy: &McpPolicy, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let ok = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    let params = &msg["params"];
    match msg["method"].as_str().unwrap_or("") {
        "initialize" => ok(json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "geospax", "title": "GeoSpaX", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "GeoSpaX's map data: list_layers first, then describe_field, query_features or select_features with SQL WHERE clauses on the layer's fields; list_recipes / run_recipe for whole workflows.",
        })),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": mcp_tools(policy).into_iter().map(|(n, d, s)| json!({ "name": n, "description": d, "inputSchema": s })).collect::<Vec<_>>() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            if !mcp_tools(policy).iter().any(|d| d.0 == name) {
                let why = if defs().iter().any(|d| d.0 == name && d.3) { format!("tool '{name}' is not allowed on this server") } else { format!("unknown tool '{name}'") };
                policy.log(name, &params["arguments"], &Err(why.clone()), 0);
                return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": why } }));
            }
            let args = if params["arguments"].is_object() { params["arguments"].clone() } else { json!({}) };
            let t0 = std::time::Instant::now();
            let res = engine.ai_tool(name, &args).map(|(v, _)| v);
            policy.log(name, &args, &res, t0.elapsed().as_millis());
            match res {
                Ok(v) => ok(json!({ "content": [{ "type": "text", "text": cut(&v) }], "structuredContent": v, "isError": false })),
                Err(e) => ok(json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        m => Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method '{m}' not found") } })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_turns_recipe_runs_into_plans() {
        crate::raster::configure_gdal();
        let dir = std::env::temp_dir().join(format!("gx-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let e = Arc::new(Engine::open(crate::EngineConfig { data: vec![dir.clone()], state_dir: Some(dir.join(".state")), ..Default::default() }).unwrap());
        let (mut steps, mut actions) = (Vec::new(), Vec::new());
        let (text, err) = e.run_tool("run_recipe", &json!({ "recipe": "points-to-hexbins" }), &mut steps, &mut actions);
        assert!(!err, "{text}");
        assert!(text.starts_with("Not started"));
        assert_eq!(actions[0]["kind"], "plan");
        assert_eq!(actions[0]["recipe"], "points-to-hexbins");
        assert!(!actions[0]["steps"].as_array().unwrap().is_empty());
        assert!(e.automation.last_run("points-to-hexbins").is_none(), "nothing ran");
        let (_, err) = e.run_tool("run_recipe", &json!({ "recipe": "points-to-hexbins", "inputs": { "nope": 1 } }), &mut steps, &mut actions);
        assert!(err);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mcp_policy_limits_tools() {
        let all = mcp_tools(&McpPolicy::default());
        assert!(all.iter().any(|t| t.0 == "run_recipe"));
        let ro = McpPolicy { read_only: true, ..Default::default() };
        assert!(!mcp_tools(&ro).iter().any(|t| t.0 == "run_recipe"));
        assert!(mcp_tools(&ro).iter().any(|t| t.0 == "list_layers"));
        let only = McpPolicy { allow: Some(vec!["list_layers".into()]), ..Default::default() };
        assert_eq!(mcp_tools(&only).iter().map(|t| t.0).collect::<Vec<_>>(), vec!["list_layers"]);
        // the policy and audit log apply before the engine is touched
        let dir = std::env::temp_dir().join(format!("gx-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("audit.jsonl");
        let p = McpPolicy { read_only: true, audit: Some(log.clone()), ..Default::default() };
        p.log("run_recipe", &json!({ "recipe": "x" }), &Err("tool 'run_recipe' is not allowed on this server".into()), 0);
        let line: Value = serde_json::from_str(std::fs::read_to_string(&log).unwrap().lines().next().unwrap()).unwrap();
        assert_eq!(line["tool"], "run_recipe");
        assert_eq!(line["ok"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schemas_are_strict_objects() {
        for (n, d, s, _) in defs() {
            assert!(!d.is_empty(), "{n}");
            assert_eq!(s["type"], "object", "{n}");
            assert_eq!(s["additionalProperties"], false, "{n}");
        }
    }

    #[test]
    fn long_results_are_cut_on_a_char_boundary() {
        let v = json!("é".repeat(MAX_RESULT));
        let c = cut(&v);
        assert!(c.contains("[cut:"));
    }

    #[test]
    fn settings_keep_the_key_unless_told() {
        let dir = std::env::temp_dir().join(format!("gx-ai-{}", std::process::id()));
        let s = save_settings(&dir, &json!({ "provider": "anthropic", "model": "claude-opus-5-5", "key": "sk-test" })).unwrap();
        assert_eq!(s.key, "sk-test");
        let s = save_settings(&dir, &json!({ "model": "claude-sonnet-5-5" })).unwrap();
        assert_eq!(s.key, "sk-test");
        assert_eq!(s.public_json()["has_key"], true);
        assert!(s.public_json().get("key").is_none());
        assert!(save_settings(&dir, &json!({ "provider": "x" })).is_err());
        assert!(save_settings(&dir, &json!({ "url": "file:///etc" })).is_err());
        let s = save_settings(&dir, &json!({ "key": "" })).unwrap();
        assert!(s.key.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
