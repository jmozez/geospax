//! Transport-agnostic request router. The Axum server and the Tauri custom
//! URI scheme both translate their native request into [`ApiRequest`] and
//! send the [`ApiResponse`] back, so web and desktop share one code path.

use crate::catalog::LayerHandle;
use crate::classify::{self, Method};
use crate::jobs::Status;
use crate::reader::ColumnValues;
use crate::{overview, Engine};
use serde_json::{json, Value};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, Default)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Vec<u8>,
    /// Public guest demo: the visitor's workspace (the `geospax_ws` cookie), see guest.rs.
    pub ws: Option<String>,
}

impl ApiRequest {
    /// Data-plane requests read features through GDAL (tiles, Arrow export, column scans).
    /// Everything else is control plane (layers, jobs, project, stats, log) and must never
    /// queue behind them: see `Engine::dispatch`.
    pub fn is_heavy(&self) -> bool {
        let p = self.path.trim_matches('/');
        p.starts_with("tiles/")
            || (p.starts_with("api/services/") && p.contains("/tile/"))
            || (p.starts_with("api/rasters/") && (p.contains("/terrain/") || p.contains("/tiles/")))
            || (p.starts_with("api/layers/")
                && (p.ends_with("/arrow") || p.ends_with("/classify") || p.ends_with("/unique") || p.ends_with("/autostyle")))
    }
}

#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl ApiResponse {
    pub fn json(status: u16, v: &serde_json::Value) -> Self {
        ApiResponse { status, content_type: "application/json", headers: vec![], body: v.to_string().into_bytes() }
    }
    pub fn error(status: u16, msg: impl Into<String>) -> Self {
        Self::json(status, &json!({ "error": msg.into() }))
    }
    /// Headers every response carries (custom-scheme fetches are cross-origin).
    pub fn common_headers() -> [(&'static str, &'static str); 6] {
        [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"),
            // the desktop page (tauri.localhost) calls the engine on another origin (gis.localhost on
            // Windows), so a request with a Content-Type (JSON, YAML) is preflighted and needs this
            ("Access-Control-Allow-Headers", "*"),
            ("Access-Control-Max-Age", "86400"),
            (
                "Access-Control-Expose-Headers",
                "Server-Timing, X-Tile-Features, X-Tile-Cache, X-Tile-Source, X-Tile-Truncated, X-Arrow-Rows",
            ),
            ("Timing-Allow-Origin", "*"),
        ]
    }
}

/// Percent-decode a query component ('+' = space).
pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() => {
                let hex = |c: u8| (c as char).to_digit(16).unwrap() as u8;
                out.push(hex(b[i + 1]) << 4 | hex(b[i + 2]));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Raw (still percent-encoded) query parameter.
pub fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| v)
}

fn body_json(body: &[u8]) -> serde_json::Value {
    serde_json::from_slice(body).unwrap_or_default()
}

/// `[1, 2, 3]` (or absent/null → None).
fn fid_list(v: &serde_json::Value) -> Option<Vec<u64>> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
}

pub(crate) fn param(query: &str, key: &str) -> Option<String> {
    query_param(query, key).map(pct_decode)
}

impl Engine {
    fn profile_restricted(&self) -> bool {
        self.profile.as_ref().is_some_and(|p| {
            let id = p["id"].as_str().unwrap_or("");
            self.workspace_root
                .as_deref()
                .map(|r| crate::profiles::list(r).iter().any(|q| q["id"] == id && q["restricted"] == true))
                .unwrap_or(false)
        })
    }

    /// Restricted mode: set in Home › Workspace (with a PIN) or by the admin profile for this profile.
    pub fn restricted(&self) -> bool {
        self.workspace_id.is_some() && (crate::workspace::is_restricted(&self.state_dir) || self.profile_restricted())
    }

    /// Workspace › Tools, with Restricted mode as it applies here (also when the admin profile set it).
    fn tools_json(&self) -> Value {
        let mut v = crate::workspace::public_settings(&self.state_dir);
        if self.profile_restricted() {
            v["restricted"] = json!(true);
            v["byAdmin"] = json!(true);
            v["hides"] = json!(crate::workspace::RESTRICTED_HIDES);
        }
        v
    }

    fn is_admin(&self) -> bool {
        self.profile.as_ref().is_some_and(|p| p["admin"] == true) && self.unlocked.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn profiles_json(&self) -> Value {
        let Some(root) = self.workspace_root.as_deref() else {
            return json!({ "available": false, "profiles": [] });
        };
        let list = crate::profiles::list(root);
        let cur = self.profile.as_ref().map(crate::profiles::public);
        let unlocked = self.unlocked.load(std::sync::atomic::Ordering::Relaxed);
        let picked = self.picked.load(std::sync::atomic::Ordering::Relaxed);
        json!({
            "available": true,
            "profiles": list,
            "current": cur,
            "unlocked": unlocked,
            // "Who's working?" shows at startup when more than one profile exists, or to enter a PIN
            "showPicker": !picked && (list.len() > 1 || !unlocked),
            "isAdmin": self.is_admin(),
            "note": "Profiles are a convenience for people sharing one OS login, not OS-level security.",
        })
    }

    fn profiles_add(&self, b: &Value) -> ApiResponse {
        let Some(root) = self.workspace_root.as_deref() else {
            return ApiResponse::error(400, "profiles need a per-user workspace (the desktop app, or the server with --per-user-workspace)");
        };
        let first = crate::profiles::list(root).is_empty();
        if !first && !self.is_admin() {
            return ApiResponse::error(403, "only the admin profile can add profiles");
        }
        match crate::profiles::add(root, b["name"].as_str().unwrap_or(""), b["pin"].as_str()) {
            Ok(p) => {
                if first {
                    // the first profile is the admin and already owns this workspace folder: open it now
                    crate::profiles::hand_over(root, p["id"].as_str().unwrap_or(""));
                    self.schedule_restart();
                    return ApiResponse::json(201, &json!({ "profile": p, "restart": true }));
                }
                ApiResponse::json(201, &json!({ "profile": p, "restart": false }))
            }
            Err(e) => ApiResponse::error(400, e),
        }
    }

    fn profiles_choose(&self, b: &Value) -> ApiResponse {
        let Some(root) = self.workspace_root.as_deref() else {
            return ApiResponse::error(400, "profiles are not available here");
        };
        let id = b["id"].as_str().unwrap_or("");
        match crate::profiles::choose(root, id, b["pin"].as_str().unwrap_or("")) {
            Ok(p) => {
                let same = self.profile.as_ref().is_some_and(|c| c["id"] == p["id"]);
                if same {
                    self.unlocked.store(true, std::sync::atomic::Ordering::Relaxed);
                    self.picked.store(true, std::sync::atomic::Ordering::Relaxed);
                    return ApiResponse::json(200, &json!({ "profile": crate::profiles::public(&p), "restart": false }));
                }
                // another profile: its folder opens after a restart, with the PIN already checked
                crate::profiles::hand_over(root, id);
                self.schedule_restart();
                ApiResponse::json(200, &json!({ "profile": crate::profiles::public(&p), "restart": true }))
            }
            Err(e) => ApiResponse::error(403, e),
        }
    }

    /// Run the restart hook shortly after the response has gone out.
    pub fn schedule_restart(&self) {
        let hook = self.restart_hook.lock().unwrap().take();
        if let Some(h) = hook {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                h();
            });
        }
    }

    fn profiles_admin(&self, id: &str, action: &str, b: &Value) -> ApiResponse {
        let Some(root) = self.workspace_root.as_deref() else {
            return ApiResponse::error(400, "profiles are not available here");
        };
        if !self.is_admin() {
            return ApiResponse::error(403, "only the admin profile can change profiles");
        }
        let r = match action {
            "rename" => crate::profiles::rename(root, id, b["name"].as_str().unwrap_or("")),
            "pin" => crate::profiles::reset_pin(root, id, b["pin"].as_str()),
            "restricted" => crate::profiles::set_restricted(root, id, b["on"].as_bool().unwrap_or(false)),
            "remove" => {
                if self.profile.as_ref().is_some_and(|p| p["id"] == id) {
                    return ApiResponse::error(400, "switch to another profile before removing this one");
                }
                crate::profiles::remove(root, id).map(|_| json!({ "removed": id }))
            }
            _ => return ApiResponse::error(404, format!("unknown profile action '{action}'")),
        };
        match r {
            Ok(v) => ApiResponse::json(200, &v),
            Err(e) => ApiResponse::error(400, e),
        }
    }

    pub fn handle(self: &Arc<Self>, req: ApiRequest) -> ApiResponse {
        if self.guest.load(std::sync::atomic::Ordering::Relaxed) {
            return crate::guest::handle(self, req);
        }
        self.handle_inner(req)
    }

    pub(crate) fn handle_inner(self: &Arc<Self>, req: ApiRequest) -> ApiResponse {
        let segs: Vec<String> = req.path.trim_matches('/').split('/').filter(|s| !s.is_empty()).map(pct_decode).collect();
        let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
        let q = req.query.as_str();
        let guest = self.guest.load(std::sync::atomic::Ordering::Relaxed);
        // Restricted mode (Home › Workspace): editing, deleting and exporting are refused here too, not only hidden
        // a profile with a PIN opens locked until the PIN is entered at "Who's working?" (profiles.rs)
        if !self.unlocked.load(std::sync::atomic::Ordering::Relaxed)
            && segs.first() == Some(&"api")
            && !matches!(segs.get(1), Some(&("profiles" | "health" | "about" | "docs" | "version")))
        {
            return ApiResponse::error(423, "enter this profile's PIN first (Who's working?)");
        }
        if self.restricted() {
            let blocked = match (req.method.as_str(), segs.as_slice()) {
                ("DELETE", ["api", "layers" | "projects" | "rasters", ..]) => true,
                ("POST", ["api", "layers", _, "edit" | "export" | "features" | "fields" | "geometry-edit" | "calculate" | "revert" | "download"]) => true,
                ("GET", ["api", "layers", _, "download"]) => true,
                _ => false,
            };
            if blocked {
                return ApiResponse::error(403, "Restricted mode is on in this workspace: editing, deleting and exporting are turned off");
            }
        }
        match (req.method.as_str(), segs.as_slice()) {
            ("GET", ["api", "docs"]) => ApiResponse::json(
                200,
                &json!({ "docs": crate::docs::DOCS.iter().map(|(n, t, _)| json!({ "name": n, "title": t })).collect::<Vec<_>>() }),
            ),
            ("GET", ["api", "docs", name]) => match crate::docs::find(name) {
                Some((n, t, md)) => ApiResponse::json(200, &json!({ "name": n, "title": t, "markdown": md, "version": env!("CARGO_PKG_VERSION") })),
                None => ApiResponse::error(404, format!("there is no guide '{name}'")),
            },
            ("GET", ["api", "samples"]) => ApiResponse::json(200, &json!({ "samples": crate::samples::list() })),
            ("POST", ["api", "samples", set]) => match crate::samples::open(self, set) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "browse"]) => match crate::browse::list(self, param(q, "path").as_deref()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(403, e),
            },
            ("GET", ["api", "folders", "pick"]) => match crate::browse::pick(self, param(q, "path").as_deref()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(if e.starts_with("GeoSpaX is open") { 403 } else { 400 }, e),
            },
            ("POST", ["api", "folders"]) => match crate::browse::connect(self, &param(q, "path").unwrap_or_default()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(if e.starts_with("GeoSpaX is open") { 403 } else { 400 }, e),
            },
            ("DELETE", ["api", "folders"]) => match crate::browse::disconnect(self, &param(q, "path").unwrap_or_default()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(404, e),
            },
            ("GET", ["api", "services"]) => ApiResponse::json(200, &crate::services::list(self)),
            ("POST", ["api", "services"]) => {
                if self.shared.load(std::sync::atomic::Ordering::Relaxed) {
                    return ApiResponse::error(403, "this GeoSpaX was started with --restricted, so web services cannot be added from here");
                }
                let opts = json!({ "public": param(q, "public").map(|v| v != "0" && v != "false"), "endpoint": param(q, "endpoint"), "region": param(q, "region"), "account": param(q, "account") });
                match crate::services::add(self, &param(q, "kind").unwrap_or_default(), &param(q, "url").unwrap_or_default(), param(q, "title").as_deref(), &opts) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("DELETE", ["api", "services", id]) => match crate::services::remove(self, id) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(404, e),
            },
            ("POST", ["api", "stac", "search"]) => {
                let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let b: Vec<f64> = v["bbox"].as_array().into_iter().flatten().filter_map(|x| x.as_f64()).collect();
                if b.len() != 4 {
                    return ApiResponse::error(400, "bbox [west, south, east, north] is needed");
                }
                match crate::stac::search(self, v["service"].as_str().unwrap_or(""), v["collection"].as_str().unwrap_or(""), [b[0], b[1], b[2], b[3]], v["datetime"].as_str(), v["max_cloud"].as_f64(), v["limit"].as_u64().unwrap_or(40) as usize) {
                    Ok(r) => ApiResponse::json(200, &r),
                    Err(e) => ApiResponse::error(502, e),
                }
            }
            ("POST", ["api", "stac", "add"]) => {
                let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let b: Vec<f64> = v["bbox"].as_array().into_iter().flatten().filter_map(|x| x.as_f64()).collect();
                let bbox = (b.len() == 4).then(|| [b[0], b[1], b[2], b[3]]);
                let href = v["href"].as_str().unwrap_or("");
                if self.shared.load(std::sync::atomic::Ordering::Relaxed) {
                    return ApiResponse::error(403, "this GeoSpaX was started with --restricted: it does not fetch web addresses");
                }
                if !(href.starts_with("https://") || href.starts_with("http://")) {
                    return ApiResponse::error(400, "the asset is not a web address");
                }
                match crate::stac::add_asset(self, v["href"].as_str().unwrap_or(""), v["id"].as_str().unwrap_or("stac_asset"), v["title"].as_str().unwrap_or("STAC asset"), v["stream"].as_bool().unwrap_or(false), bbox) {
                    Ok(r) => ApiResponse::json(200, &r),
                    Err(e) => ApiResponse::error(502, e),
                }
            }
            // Design tab: DXF export (the design layers, in UTM metres) and import (with the drawing's EPSG)
            ("POST", ["api", "design", "dxf"]) => {
                let b = body_json(&req.body);
                let ids: Vec<String> = b["layers"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
                match crate::design::export_dxf(self, &ids, &b["hatch"], &b["blocks"], &b["inserts"], &b["pens"]) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("GET", ["api", "design", "dxf"]) => match crate::design::exported(self, &param(q, "path").unwrap_or_default()) {
                Ok(body) => ApiResponse { status: 200, content_type: "image/vnd.dxf", headers: vec![("Content-Disposition", "attachment; filename=\"geospax-design.dxf\"".to_string())], body },
                Err(e) => ApiResponse::error(404, e),
            },
            ("POST", ["api", "design", "boolean"]) => {
                let b = body_json(&req.body);
                match crate::design::boolean(b["op"].as_str().unwrap_or(""), &b["a"], &b["b"]) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("POST", ["api", "design", "dxf-import"]) => match param(q, "epsg").and_then(|v| v.trim().trim_start_matches("EPSG:").parse::<u32>().ok()) {
                Some(epsg) => match crate::design::import_dxf(self, &param(q, "name").unwrap_or_else(|| "drawing.dxf".into()), epsg, &req.body) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                },
                None => ApiResponse::error(400, "epsg=… (the drawing's coordinate system) is needed"),
            },
            // Overture Maps: its themes, and one theme downloaded for an area (a job with the gauge)
            ("GET", ["api", "overture"]) => ApiResponse::json(200, &json!({ "themes": crate::geoparquet::OVERTURE.iter().map(|t| json!({ "id": t.0, "title": t.1 })).collect::<Vec<_>>() })),
            ("POST", ["api", "overture"]) => {
                if self.shared.load(std::sync::atomic::Ordering::Relaxed) && !guest {
                    return ApiResponse::error(403, "this GeoSpaX was started with --restricted: it does not download");
                }
                let b: Vec<f64> = param(q, "bbox").unwrap_or_default().split(',').filter_map(|x| x.trim().parse().ok()).collect();
                if b.len() != 4 {
                    return ApiResponse::error(400, "bbox=west,south,east,north is needed");
                }
                match crate::geoparquet::overture(self, &param(q, "theme").unwrap_or_default(), [b[0], b[1], b[2], b[3]]) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            // cloud storage: one folder of a connection, and a file of it put on the map
            ("GET", ["api", "services", id, "list"]) => match crate::services::get(self, id).and_then(|s| {
                let p = param(q, "path").unwrap_or_default();
                match s["kind"].as_str() {
                    Some("github") => crate::github::list(&s, &p),
                    Some("postgis") => crate::db::list(&s),
                    _ => crate::cloud::list(&s, &p),
                }
            }) {
                Ok(v) => ApiResponse::json(200, &json!({ "layers": v })),
                Err(e) => ApiResponse::error(502, e),
            },
            ("POST", ["api", "services", id, "open"]) => match crate::services::get(self, id).and_then(|s| {
                let p = param(q, "path").unwrap_or_default();
                match s["kind"].as_str() {
                    Some("github") => crate::github::open(self, &s, &p, param(q, "approve").as_deref() == Some("code")),
                    Some("postgis") => {
                        // a table: all of it, or the part in the map view (bbox=w,s,e,n)
                        let b: Vec<f64> = param(q, "bbox").unwrap_or_default().split(',').filter_map(|x| x.parse().ok()).collect();
                        crate::db::open_table(self, &s, &p, (b.len() == 4).then(|| [b[0], b[1], b[2], b[3]]))
                    }
                    _ => crate::cloud::open(self, &s, &p),
                }
            }) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(502, e),
            },
            ("GET", ["api", "services", id, "layers"]) => match crate::services::layers(self, id) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(502, e),
            },
            ("GET", ["api", "services", id, "tile", z, x, y]) => {
                let n = |s: &str| s.trim_end_matches(".png").parse::<u32>().ok();
                match (n(z), n(x), n(y)) {
                    (Some(z), Some(x), Some(y)) => match crate::services::tile(self, id, &param(q, "layer").unwrap_or_default(), z, x, y) {
                        Ok((body, ct)) => ApiResponse { status: 200, content_type: ct, headers: vec![("Cache-Control", "max-age=86400".to_string())], body },
                        Err(e) => ApiResponse::error(502, e),
                    },
                    _ => ApiResponse::error(400, "bad tile address"),
                }
            }
            ("POST", ["api", "services", id, "fetch"]) => {
                let b: Vec<f64> = param(q, "bbox").unwrap_or_default().split(',').filter_map(|v| v.parse().ok()).collect();
                if b.len() != 4 {
                    return ApiResponse::error(400, "bbox=west,south,east,north is needed");
                }
                match crate::services::fetch(self, id, &param(q, "layer").unwrap_or_default(), [b[0], b[1], b[2], b[3]]) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(502, e),
                }
            }
            ("GET", ["api", "browse", "inside"]) => match crate::browse::inside(self, &param(q, "path").unwrap_or_default()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "browse", "preview"]) => match crate::browse::preview(self, &param(q, "path").unwrap_or_default(), param(q, "layer").as_deref()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("POST", ["api", "browse", "add"]) => match crate::browse::add(self, &param(q, "path").unwrap_or_default(), param(q, "layer").as_deref()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "project", "info"]) => ApiResponse::json(200, &json!({
                "path": self.project_path().display().to_string(), "exists": self.project_path().exists(),
            })),
            ("GET", ["api", "ai", "settings"]) => ApiResponse::json(200, &crate::ai::load_settings(&self.state_dir).public_json()),
            ("PUT", ["api", "ai", "settings"]) => match crate::ai::save_settings(&self.state_dir, &body_json(&req.body)) {
                Ok(s) => ApiResponse::json(200, &s.public_json()),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "ai", "models"]) => ApiResponse::json(200, &self.ai_models()),
            ("POST", ["api", "ask"]) => {
                let b = body_json(&req.body);
                let history = b["history"].as_array().cloned().unwrap_or_default();
                match self.ask(b["question"].as_str().unwrap_or(""), &history) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(502, e),
                }
            }
            // what is on the map, as one number: the app polls it so results from anywhere (a recipe, a
            // tool, the assistant, a trigger, an upload) join Contents without a reload
            ("GET", ["api", "rev"]) => {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                for l in self.layers() {
                    (&l.info.id, l.info.feature_count, l.filter()).hash(&mut h);
                }
                for r in self.rasters() {
                    (&r.info.id, r.info.width, r.info.height).hash(&mut h);
                }
                ApiResponse::json(200, &json!({ "rev": format!("{:x}", h.finish()), "layers": self.layers().len(), "rasters": self.rasters().len() }))
            }
            // your own ONNX models (automation/detect_steps.rs)
            ("GET", ["api", "models"]) => ApiResponse::json(200, &json!({ "models": crate::automation::detect_steps::list(&self.state_dir), "folder": crate::automation::detect_steps::models_dir(&self.state_dir) })),
            ("POST", ["api", "models"]) => match crate::automation::detect_steps::save(&self.state_dir, &param(q, "name").unwrap_or_default(), &req.body) {
                Ok(v) => ApiResponse::json(201, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("PUT", ["api", "models", name]) => match crate::automation::detect_steps::describe(&self.state_dir, name, &body_json(&req.body)) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("DELETE", ["api", "models", name]) => match crate::automation::detect_steps::remove(&self.state_dir, name) {
                Ok(()) => ApiResponse::json(200, &json!({ "removed": name })),
                Err(e) => ApiResponse::error(404, e),
            },
            ("GET", ["api", "health"]) => ApiResponse::json(200, &json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })),
            // Settings › About this installation: where the data and the results live
            ("GET", ["api", "about"]) => ApiResponse::json(200, &if guest {
                json!({ "version": env!("CARGO_PKG_VERSION"), "guest": true, "keep_days": crate::guest::KEEP.as_secs() / 86400 })
            } else {
                json!({ "version": env!("CARGO_PKG_VERSION"), "data": self.data_dirs, "state": self.state_dir })
            }),
            ("GET", ["api", "layers"]) => {
                let layers: Vec<_> = self.layers().iter().map(|l| self.layer_json(l)).collect();
                ApiResponse::json(200, &json!({ "layers": layers, "warnings": self.warnings, "reader": self.read_mode.as_str() }))
            }
            ("GET", ["api", "stats"]) => ApiResponse::json(200, &self.stats_json()),
            // a file dropped on the app: saved next to the data and put on the map (upload.rs)
            ("POST", ["api", "upload"]) => match crate::upload::upload(self, &param(q, "name").unwrap_or_default(), &req.body) {
                Ok(v) => ApiResponse::json(201, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("POST", ["api", "cache", "clear"]) => {
                self.clear_cache();
                ApiResponse::json(200, &json!({ "cleared": true }))
            }
            ("POST", ["api", "bench"]) => self.store_bench(&req.body),
            ("POST", ["api", "log"]) => self.client_log(&req.body),
            ("GET", ["api", "bench"]) => {
                let v = self.bench.lock().unwrap().clone().unwrap_or(serde_json::Value::Null);
                ApiResponse::json(200, &v)
            }
            ("GET", ["tiles", layer, z, x, y]) => self.tile_response(layer, z, x, y, q),
            #[cfg(feature = "arrow")]
            ("GET", ["api", "layers", layer, "arrow"]) => self.arrow_response(layer, q),
            ("GET", ["api", "layers", layer, "classify"]) => self.with_layer(layer, |l| self.classify_response(l, q)),
            ("GET", ["api", "layers", layer, "unique"]) => self.with_layer(layer, |l| self.unique_response(l, q)),
            // Attribute table (web/src/attributes.ts): a page of rows with a bbox each.
            // ---- editing, selection and the attribute table (edit.rs)
            // remove from the map for this session (the file is not touched; it opens again at the next start)
            ("DELETE", ["api", "layers", layer]) => {
                if self.remove_layer(layer) {
                    ApiResponse::json(200, &json!({ "removed": layer }))
                } else {
                    ApiResponse::error(404, format!("unknown layer '{layer}'"))
                }
            }
            ("POST", ["api", "layers", "new"]) => {
                let b = body_json(&req.body);
                let fields: Vec<(String, String)> = b["fields"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|f| Some((f["name"].as_str()?.to_string(), f["kind"].as_str().unwrap_or("text").to_string())))
                    .collect();
                match self.create_layer(b["name"].as_str().unwrap_or(""), b["geometry"].as_str().unwrap_or("point"), &fields) {
                    Ok(id) => self.layer_reply(&id, 201, json!({})),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("POST", ["api", "layers", layer, "edit"]) => match self.edit_layer(layer) {
                Ok(l) => ApiResponse::json(200, &json!({ "layer": self.layer_json(&l) })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("POST", ["api", "layers", layer, "field-package"]) => match self.sync_package(layer) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "sync"]) => ApiResponse::json(200, &self.sync_packages()),
            ("POST", ["api", "sync", what]) if *what == "review" || *what == "apply" => {
                let b = body_json(&req.body);
                let pkg = b["package"].as_str().unwrap_or("");
                let ret = b["returned"].as_str();
                let r = if *what == "review" { self.sync_review(pkg, ret) } else { self.sync_apply(pkg, ret, &b["choices"].as_object().cloned().unwrap_or_default()) };
                match r {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("POST", ["api", "layers", layer, "revert"]) => match self.revert_edits(layer) {
                Ok(Some(l)) => ApiResponse::json(200, &json!({ "layer": self.layer_json(&l) })),
                Ok(None) => ApiResponse::json(200, &json!({ "removed": layer })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "layers", layer, "features", fid]) => self.with_layer(layer, |l| match fid.parse::<u64>() {
                Ok(fid) => match self.feature_json(l, fid) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(404, e),
                },
                Err(_) => ApiResponse::error(400, "bad feature id"),
            }),
            ("POST", ["api", "layers", layer, "features"]) => match self.feature_add(layer, &body_json(&req.body)) {
                Ok((fid, l)) => ApiResponse::json(201, &json!({ "fid": fid, "layer": self.layer_json(&l) })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("PUT", ["api", "layers", layer, "features", fid]) => match fid.parse::<u64>() {
                Ok(fid) => match self.feature_update(layer, fid, &body_json(&req.body)) {
                    Ok(l) => ApiResponse::json(200, &json!({ "fid": fid, "layer": self.layer_json(&l) })),
                    Err(e) => ApiResponse::error(400, e),
                },
                Err(_) => ApiResponse::error(400, "bad feature id"),
            },
            ("DELETE", ["api", "layers", layer, "features", fid]) => match fid.parse::<u64>() {
                Ok(fid) => self.delete_reply(layer, &[fid]),
                Err(_) => ApiResponse::error(400, "bad feature id"),
            },
            ("POST", ["api", "layers", layer, "geometry-edit"]) => match self.geometry_edit(layer, &body_json(&req.body)) {
                Ok((fids, l)) => ApiResponse::json(200, &json!({ "fids": fids, "layer": self.layer_json(&l) })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("POST", ["api", "layers", layer, "features", "delete"]) => {
                let fids = fid_list(&body_json(&req.body)["fids"]).unwrap_or_default();
                self.delete_reply(layer, &fids)
            }
            ("POST", ["api", "layers", layer, "fields"]) => {
                let b = body_json(&req.body);
                match self.field_add(layer, b["name"].as_str().unwrap_or(""), b["kind"].as_str().unwrap_or("text")) {
                    Ok(l) => ApiResponse::json(201, &json!({ "layer": self.layer_json(&l) })),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("DELETE", ["api", "layers", layer, "fields", name]) => match self.field_delete(layer, name) {
                Ok(l) => ApiResponse::json(200, &json!({ "layer": self.layer_json(&l) })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("POST", ["api", "layers", layer, "calculate"]) => {
                let b = body_json(&req.body);
                let field = b["field"].as_str().unwrap_or("").trim().to_string();
                let fids = fid_list(&b["fids"]);
                let r = match b["geometry"].as_str() {
                    Some(what) => self.calculate_geometry(layer, &field, what, fids.as_deref()),
                    None => self.calculate(layer, &field, b["expression"].as_str().unwrap_or(""), b["kind"].as_str(), b["where"].as_str(), fids.as_deref()),
                };
                match r {
                    Ok((n, l)) => ApiResponse::json(200, &json!({ "updated": n, "layer": self.layer_json(&l) })),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("POST", ["api", "layers", layer, "select"]) => self.with_layer(layer, |l| {
                let b = body_json(&req.body);
                let loc = b.get("location").filter(|v| v.is_object()).map(|v| crate::edit::Location {
                    layer: v["layer"].as_str().unwrap_or("").to_string(),
                    relation: v["relation"].as_str().unwrap_or("intersects").to_string(),
                    distance_m: v["distance_m"].as_f64().unwrap_or(0.0),
                    fids: fid_list(&v["fids"]),
                });
                let within = fid_list(&b["within"]);
                match self.select(l, b["where"].as_str(), loc.as_ref(), within.as_deref()) {
                    Ok(fids) => ApiResponse::json(200, &json!({ "count": fids.len(), "fids": fids, "capped": fids.len() >= crate::edit::MAX_SELECT })),
                    Err(e) => ApiResponse::error(400, e),
                }
            }),
            ("PUT", ["api", "layers", layer, "filter"]) => self.with_layer(layer, |l| {
                let b = body_json(&req.body);
                match l.set_filter(b["where"].as_str().map(String::from)) {
                    Ok(()) => {
                        self.clear_cache();
                        let mut v = self.layer_json(l);
                        v["filtered_count"] = l.filtered_count().into();
                        ApiResponse::json(200, &json!({ "layer": v }))
                    }
                    Err(e) => ApiResponse::error(400, e),
                }
            }),
            ("POST", ["api", "layers", layer, "table"]) => self.with_layer(layer, |l| {
                let b = body_json(&req.body);
                let tq = crate::edit::TableQuery {
                    offset: b["offset"].as_u64().unwrap_or(0) as usize,
                    limit: b["limit"].as_u64().unwrap_or(200) as usize,
                    sort: b["sort"].as_str().map(String::from),
                    desc: b["desc"].as_bool().unwrap_or(false),
                    where_: b["where"].as_str().map(String::from),
                    fids: fid_list(&b["fids"]),
                };
                match self.table(l, &tq) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }),
            ("GET", ["api", "layers", layer, "download"]) => self.with_layer(layer, |l| {
                match self.layer_download(l, query_param(&req.query, "format").unwrap_or("gpkg")) {
                    Ok((bytes, name, ctype)) => ApiResponse {
                        status: 200,
                        content_type: ctype,
                        headers: vec![("Content-Disposition", format!("attachment; filename=\"{}\"", name.replace('"', "")))],
                        body: bytes,
                    },
                    Err(e) => ApiResponse::error(400, e),
                }
            }),
            ("POST", ["api", "layers", layer, "export"]) => self.with_layer(layer, |l| {
                let b = body_json(&req.body);
                let fids = fid_list(&b["fids"]);
                match self.export_features(l, b["name"].as_str().unwrap_or(""), b["where"].as_str(), fids.as_deref()) {
                    Ok(id) => self.layer_reply(&id, 201, json!({})),
                    Err(e) => ApiResponse::error(400, e),
                }
            }),
            ("GET", ["api", "layers", layer, "rows"]) => self.with_layer(layer, |l| {
                let offset = param(q, "offset").and_then(|s| s.parse().ok()).unwrap_or(0usize);
                let limit = param(q, "limit").and_then(|s| s.parse().ok()).unwrap_or(250usize).clamp(1, 2000);
                match self.rows(l, offset, limit) {
                    Ok(page) => ApiResponse::json(200, &serde_json::to_value(page).unwrap_or(serde_json::Value::Null)),
                    Err(e) => ApiResponse::error(500, e),
                }
            }),

            // AutoMap's choice for one layer (what recipes use), so one-click imports look finished too
            ("GET", ["api", "layers", layer, "autostyle"]) => self.with_layer(layer, |l| {
                let st = crate::automation::automap::style_layer(self, l, None, None);
                ApiResponse::json(200, &json!({ "layer": st.layer, "style": st.style, "why": st.why, "field": st.field, "label_field": st.label_field }))
            }),
            ("POST", ["api", "layers", layer, "overviews"]) => {
                let mz = param(q, "maxzoom").and_then(|s| s.parse::<u8>().ok());
                match self.start_overview_job(layer, mz) {
                    Ok(job) => ApiResponse::json(202, &job.json()),
                    Err(e) if e.starts_with("unknown layer") => ApiResponse::error(404, e),
                    Err(e) => ApiResponse::error(409, e),
                }
            }
            ("DELETE", ["api", "layers", layer, "overviews"]) => self.with_layer(layer, |l| {
                l.set_overview(None);
                self.clear_cache();
                let path = overview::path_for(&self.state_dir, &l.info.id);
                let removed = std::fs::remove_file(&path).is_ok();
                let _ = std::fs::remove_file(format!("{}.json", path.display()));
                ApiResponse::json(200, &json!({ "removed": removed, "layer": self.layer_json(l) }))
            }),
            ("GET", ["api", "jobs"]) => ApiResponse::json(200, &json!({ "jobs": self.jobs.json() })),
            ("GET", ["api", "jobs", id]) => match id.parse().ok().and_then(|id| self.jobs.get(id)) {
                Some(j) => ApiResponse::json(200, &j.json()),
                None => ApiResponse::error(404, "unknown job"),
            },
            ("POST", ["api", "jobs", id, "cancel"]) => match id.parse().ok().and_then(|id| self.jobs.get(id)) {
                Some(j) => {
                    j.cancel.store(true, Ordering::Relaxed);
                    ApiResponse::json(200, &j.json())
                }
                None => ApiResponse::error(404, "unknown job"),
            },
            ("GET", ["api", "devices"]) => ApiResponse::json(200, &self.devices.json()),
            // Phone link (docs/DEVICES.md §3a): the QR card in the Devices panel
            ("GET", ["api", "phone"]) => ApiResponse::json(200, &self.phone.json(self)),
            // the phone page asks this to tell the phone link (link: true, answered there) from the web edition
            ("GET", ["api", "phone", "hello"]) => ApiResponse::json(200, &json!({ "ok": true, "link": false })),
            ("POST", ["api", "phone", "enable"]) => match self.phone.enable(self) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(500, e),
            },
            ("POST", ["api", "phone", "disable"]) => ApiResponse::json(200, &self.phone.disable(self)),
            ("POST", ["api", "phone", "reset"]) => ApiResponse::json(200, &self.phone.reset(self)),
            ("POST", ["api", "devices", "rescan"]) => {
                self.devices.request_rescan();
                ApiResponse::json(202, &json!({ "ok": true }))
            }
            ("GET", ["api", "devices", "live"]) => ApiResponse::json(200, &self.devices.live_geojson()),
            ("POST", ["api", "devices", "live"]) => match self.devices.push_json(&req.body) {
                Ok(id) => ApiResponse::json(200, &json!({ "ok": true, "device": id })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "devices", "readings"]) => {
                let q = req.query.as_str();
                let minutes = param(q, "minutes").and_then(|m| m.parse::<f64>().ok()).unwrap_or(60.0).clamp(0.1, 10_080.0);
                ApiResponse::json(200, &self.devices.readings_geojson(param(q, "device").as_deref(), minutes))
            }
            ("POST", ["api", "devices", id, "import"]) => match self.devices.import(self, id) {
                Ok(job) => ApiResponse::json(202, &job.json()),
                Err(e) if e.starts_with("unknown device") => ApiResponse::error(404, e),
                Err(e) => ApiResponse::error(409, e),
            },
            // ---- automation (docs/AUTOMATION.md §9)
            ("GET", ["api", "rasters"]) => ApiResponse::json(200, &self.rasters_json()),
            ("GET", ["api", "raster", "ramps"]) => ApiResponse::json(200, &crate::raster::ramps_json()),
            ("GET", ["api", "rasters", id]) => match self.raster(id) {
                Some(r) => ApiResponse::json(200, &r.json()),
                None => ApiResponse::error(404, format!("unknown raster '{id}'")),
            },
            ("GET", ["api", "rasters", id, "value"]) => {
                let q = req.query.as_str();
                let num = |k: &str| query_param(q, k).and_then(|v| v.parse::<f64>().ok());
                match (self.raster(id), num("lon"), num("lat")) {
                    (None, _, _) => ApiResponse::error(404, format!("unknown raster '{id}'")),
                    (Some(r), Some(lon), Some(lat)) => match r.value_at(lon, lat) {
                        Ok(v) => ApiResponse::json(200, &v),
                        Err(e) => ApiResponse::error(400, e),
                    },
                    _ => ApiResponse::error(400, "lon and lat are needed".to_string()),
                }
            }
            ("GET", ["api", "rasters", id, "histogram"]) => match self.raster(id) {
                Some(r) => {
                    let bins = query_param(req.query.as_str(), "bins").and_then(|v| v.parse().ok()).unwrap_or(24);
                    match r.histogram(bins) {
                        Ok(v) => ApiResponse::json(200, &v),
                        Err(e) => ApiResponse::error(500, e),
                    }
                }
                None => ApiResponse::error(404, format!("unknown raster '{id}'")),
            },
            // a raster in its style as map tiles (sharp at every zoom)
            ("GET", ["api", "rasters", id, "tiles", z, x, y]) => {
                let n = |s: &str| s.trim_end_matches(".png").parse::<u32>().ok();
                match (self.raster(id), n(z), n(x), n(y)) {
                    (Some(r), Some(z), Some(x), Some(y)) if z <= 22 => match r.tile_png(z, x, y) {
                        Ok(png) => ApiResponse { status: 200, content_type: "image/png", headers: vec![("Cache-Control", "max-age=3600".to_string())], body: png },
                        Err(e) => ApiResponse::error(500, e),
                    },
                    (None, ..) => ApiResponse::error(404, format!("unknown raster '{id}'")),
                    _ => ApiResponse::error(400, "tile is z/x/y.png"),
                }
            }
            // 3D terrain: an elevation raster as Terrarium tiles (MapLibre raster-dem)
            ("GET", ["api", "rasters", id, "terrain", z, x, y]) => {
                let n = |s: &str| s.trim_end_matches(".png").parse::<u32>().ok();
                match (self.raster(id), n(z), n(x), n(y)) {
                    (Some(r), Some(z), Some(x), Some(y)) if z <= 18 => match crate::raster::terrain_tile(&r.info.path, z, x, y) {
                        Ok(png) => ApiResponse { status: 200, content_type: "image/png", headers: vec![("Cache-Control", "max-age=3600".to_string())], body: png },
                        Err(e) => ApiResponse::error(500, e),
                    },
                    (None, ..) => ApiResponse::error(404, format!("unknown raster '{id}'")),
                    _ => ApiResponse::error(400, "tile is z/x/y.png"),
                }
            }
            ("GET", ["api", "rasters", id, "overlay.png"]) => match self.raster(id) {
                Some(r) => {
                    let max = param(q, "max").and_then(|m| m.parse().ok()).unwrap_or(1600);
                    match r.overlay_png(max) {
                        Ok(png) => ApiResponse { status: 200, content_type: "image/png", headers: vec![("Cache-Control", "max-age=3600".to_string())], body: png.as_ref().clone() },
                        Err(e) => ApiResponse::error(500, e),
                    }
                }
                None => ApiResponse::error(404, format!("unknown raster '{id}'")),
            },
            ("PUT", ["api", "rasters", id, "style"]) => match (self.raster(id), serde_json::from_slice::<serde_json::Value>(&req.body)) {
                (Some(_), Ok(v)) if v.is_object() => match self.set_raster_style(id, Some(v)) {
                    Ok(r) => ApiResponse::json(200, &r.json()),
                    Err(e) => ApiResponse::error(400, e),
                },
                (None, _) => ApiResponse::error(404, format!("unknown raster '{id}'")),
                _ => ApiResponse::error(400, "style must be a JSON object"),
            },
            // back to the automatic style
            ("DELETE", ["api", "rasters", id, "style"]) => match self.set_raster_style(id, None) {
                Ok(r) => ApiResponse::json(200, &r.json()),
                Err(e) => ApiResponse::error(404, e),
            },
            // Python environments (pyenv.rs): which are on this computer, their packages, which one steps use
            ("GET", ["api", "python"]) => ApiResponse::json(200, &crate::pyenv::list(self)),
            ("GET", ["api", "python", "packages"]) => match crate::pyenv::packages(self, &param(q, "path").unwrap_or_default()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "python", "outdated"]) => match crate::pyenv::outdated(self, &param(q, "path").unwrap_or_default()) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(502, e),
            },
            ("POST", ["api", "python", "update"]) => {
                if self.shared.load(std::sync::atomic::Ordering::Relaxed) {
                    return ApiResponse::error(403, "this GeoSpaX was started with --restricted: Python packages cannot be changed from here");
                }
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let pk: Vec<String> = body["packages"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                match crate::pyenv::start_update(self, body["path"].as_str().unwrap_or(""), pk) {
                    Ok(job) => ApiResponse::json(202, &job.json()),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("POST", ["api", "python", "use"]) => {
                if self.shared.load(std::sync::atomic::Ordering::Relaxed) {
                    return ApiResponse::error(403, "this GeoSpaX was started with --restricted: the Python environment cannot be changed from here");
                }
                match crate::pyenv::choose(self, &param(q, "path").unwrap_or_default()) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            // R (docs/R.md): is R there, which packages, and install what is missing
            // chart look (ggplot2 theme, palette, text size), shared by reports, the app's charts and R
            ("GET", ["api", "settings", "charts"]) => ApiResponse::json(200, &crate::automation::charts::style().json()),
            ("POST", ["api", "settings", "charts"]) => {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                match crate::automation::charts::save(&self.state_dir, &body) {
                    Ok(st) => ApiResponse::json(200, &st.json()),
                    Err(e) => ApiResponse::error(500, e),
                }
            }
            ("GET", ["api", "r"]) => ApiResponse::json(200, &crate::rsetup::status()),
            ("GET", ["api", "r", "available"]) => match crate::rsetup::available() {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(502, e),
            },
            ("GET", ["api", "r", "outdated"]) => match crate::rsetup::outdated() {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(502, e),
            },
            ("POST", ["api", "r", "install"]) => {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let list = |k: &str| body.get(k).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();
                let mut kits = list("kits");
                kits.extend(list("packages"));
                if kits.is_empty() {
                    kits = crate::rsetup::DEFAULT_KITS.iter().map(|s| s.to_string()).collect();
                }
                let with_r = body.get("r").and_then(|v| v.as_bool()).unwrap_or(true);
                let update = body.get("update").and_then(|v| v.as_bool()).unwrap_or(false);
                match crate::rsetup::start_install(self, with_r, crate::rsetup::packages_of(&kits), update) {
                    Ok(job) => ApiResponse::json(202, &job.json()),
                    Err(e) => ApiResponse::error(400, e),
                }
            },
            // Plugins (docs/PLUGINS.md): tools and ribbon commands from GeoSpaX, RustGIS,
            // GeoLibre, QGIS and ArcGIS Pro packages.
            ("GET", ["api", "plugins"]) => ApiResponse::json(200, &json!({
                "plugins": self.plugins.list(),
                "runtimes": self.plugins.runtimes(),
                "dirs": self.plugins.dirs(),
            })),
            ("POST", ["api", "plugins", "reload"]) => {
                self.plugins.reload();
                ApiResponse::json(200, &json!({ "plugins": self.plugins.list() }))
            },
            ("POST", ["api", "plugins", "import"]) => {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
                if path.is_empty() {
                    ApiResponse::error(400, "import needs {\"path\": \"…\"}")
                } else {
                    match self.plugins.install(std::path::Path::new(path)) {
                        Ok(info) => ApiResponse::json(200, &json!({ "plugin": info, "plugins": self.plugins.list() })),
                        Err(e) => ApiResponse::error(400, e),
                    }
                }
            },
            ("DELETE", ["api", "plugins", id]) => match self.plugins.uninstall(id) {
                Ok(msg) => ApiResponse::json(200, &json!({ "ok": true, "message": msg, "plugins": self.plugins.list() })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "plugins", id]) => match self.plugins.get(id) {
                Some(info) => ApiResponse::json(200, &serde_json::to_value(info).unwrap_or(serde_json::Value::Null)),
                None => ApiResponse::error(404, format!("unknown plugin '{id}'")),
            },
            ("POST", ["api", "plugins", id, "tools", tool, "run"]) => {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let params = body.get("params").and_then(|v| v.as_object()).cloned().unwrap_or_default();
                match self.plugins.run_tool(self, id, tool, params) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            },
            ("GET", ["api", "recipes"]) => ApiResponse::json(200, &self.automation.summary_json()),
            ("GET", ["api", "crs"]) => {
                let q = param(&req.query, "q").unwrap_or_default();
                let at = match (param(&req.query, "lon").and_then(|v| v.parse().ok()), param(&req.query, "lat").and_then(|v| v.parse().ok())) {
                    (Some(lon), Some(lat)) => Some((lon, lat)),
                    _ => None,
                };
                ApiResponse::json(200, &crate::crs::search(&q, at, 40))
            }
            ("POST", ["api", "sql"]) => {
                let b = body_json(&req.body);
                match self.sql_query(b["sql"].as_str().unwrap_or(""), b["name"].as_str()) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("GET", ["api", "crs", "pacific"]) => ApiResponse::json(200, &crate::crs::pacific()),
            ("GET", ["api", "crs", code]) => match crate::crs::describe(code) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(404, e),
            },
            ("GET", ["api", "steps"]) => ApiResponse::json(200, &json!({ "steps": crate::automation::catalogue_json() })),
            ("POST", ["api", "preview", "map"]) => {
                let body: serde_json::Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(e) => return ApiResponse::error(400, format!("preview: {e}")),
                };
                let content_type = if body.get("format").and_then(|v| v.as_str()) == Some("svg") { "image/svg+xml" } else { "image/png" };
                match self.automation.preview_map(self, &body) {
                    Ok(bytes) => ApiResponse { status: 200, content_type, headers: vec![("Cache-Control", "no-store".to_string())], body: bytes },
                    Err(e) => ApiResponse::error(422, e),
                }
            }
            ("POST", ["api", "recipes", "validate"]) => self.recipe_validate(&req.body),
            ("POST", ["api", "recipes"]) => self.recipe_save(&req.body, q),
            ("GET", ["api", "recipes", id]) => match self.automation.recipe(id) {
                Some(r) => {
                    let mut v = r.summary_json();
                    v["yaml"] = r.text.clone().into();
                    v["plan"] = crate::automation::Automation::plan(&r).into();
                    v["auto"] = self.automation.is_enabled(id).into();
                    v["last_run"] = self.automation.last_run(id).unwrap_or_default();
                    ApiResponse::json(200, &v)
                }
                None => ApiResponse::error(404, format!("unknown recipe '{id}'")),
            },
            ("DELETE", ["api", "recipes", id]) => match self.automation.delete_user(id) {
                Ok(()) => ApiResponse::json(200, &json!({ "deleted": id })),
                Err(e) if e.starts_with("unknown") => ApiResponse::error(404, e),
                Err(e) => ApiResponse::error(409, e),
            },
            ("POST", ["api", "hooks", token]) => match self.automation.by_webhook(token) {
                None => ApiResponse::error(404, "unknown webhook"),
                Some((r, false)) => ApiResponse::error(409, format!("recipe '{}' is switched off; turn on its automation first", r.id)),
                Some((r, true)) => {
                    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                    // declared inputs come from the JSON body; the whole body is kept on the trigger
                    let inputs: serde_json::Map<String, serde_json::Value> = body.as_object().map(|m| m.iter().filter(|(k, _)| r.inputs.iter().any(|i| &i.name == *k)).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
                    let trigger = json!({ "kind": "webhook", "text": "webhook call", "payload": body });
                    match self.automation.start_run(self, &r.id, inputs, trigger) {
                        Ok(run) => ApiResponse::json(202, &run.json()),
                        Err(e) if e.contains("already running") => ApiResponse::error(409, e),
                        Err(e) => ApiResponse::error(400, e),
                    }
                }
            },
            ("GET", ["api", "providers"]) => ApiResponse::json(200, &crate::automation::providers::providers_json()),
            ("POST", ["api", "recipes", id, "run"]) => {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let inputs = body.get("inputs").and_then(|v| v.as_object()).cloned().unwrap_or_default();
                let trigger = json!({ "kind": "manual", "text": "run from the app" });
                match self.automation.start_run(self, id, inputs, trigger) {
                    Ok(run) => ApiResponse::json(202, &run.json()),
                    Err(e) if e.starts_with("unknown recipe") => ApiResponse::error(404, e),
                    Err(e) if e.contains("already running") => ApiResponse::error(409, e),
                    Err(e) => ApiResponse::error(400, e),
                }
            }
            ("PUT", ["api", "recipes", id, "auto"]) => {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let on = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
                match self.automation.set_enabled(id, on) {
                    Ok(()) => ApiResponse::json(200, &json!({ "id": id, "auto": on })),
                    Err(e) if e.starts_with("unknown") => ApiResponse::error(404, e),
                    Err(e) => ApiResponse::error(500, e),
                }
            }
            ("GET", ["api", "runs"]) => ApiResponse::json(200, &json!({ "runs": self.automation.runs_json(50) })),
            ("GET", ["api", "runs", id]) => match self.automation.run_json(id) {
                Some(v) => ApiResponse::json(200, &v),
                None => ApiResponse::error(404, format!("unknown run '{id}'")),
            },
            ("DELETE", ["api", "runs", id]) => match self.automation.delete_run(id) {
                Ok(()) => ApiResponse::json(200, &json!({ "deleted": id })),
                Err(e) => ApiResponse::json(if e.starts_with("no run") { 404 } else { 409 }, &json!({ "error": e })),
            },
            ("POST", ["api", "runs", id, "cancel"]) => match self.automation.run(id) {
                Some(r) => {
                    r.job.cancel.store(true, Ordering::Relaxed);
                    ApiResponse::json(200, &r.json())
                }
                None => ApiResponse::error(404, format!("unknown run '{id}'")),
            },
            ("GET", ["api", "runs", id, "files", name]) => match self.automation.artifact(id, name) {
                // reports open as pages of this site: they may show data anyone uploaded, so never run its scripts
                Ok((bytes, ct)) => ApiResponse {
                    status: 200,
                    content_type: ct,
                    headers: vec![("Cache-Control", "no-store".to_string()), ("Content-Security-Policy", "sandbox; default-src 'self' data: 'unsafe-inline'; script-src 'none'".to_string())],
                    body: bytes,
                },
                Err(e) => ApiResponse::error(404, e),
            },
            // Named projects (Home › New, Open, Save as, Rename): one JSON file each in
            // <state>/projects/<slug>.json. The working project stays api/project.
            // Home › Workspace (workspace.rs): this computer and account's own folder
            ("GET", ["api", "workspace"]) if !guest => ApiResponse::json(200, &json!({
                "id": self.workspace_id,
                "perUser": self.workspace_id.is_some(),
                "folder": self.state_dir,
                "projects": self.projects_list(),
                "dataSources": self.data_dirs,
                "layers": self.layers().len(),
                "workflows": crate::workspace::workflows(&self.state_dir),
                "storage": crate::workspace::storage(&self.state_dir),
                "tools": self.tools_json(),
            })),
            ("POST", ["api", "workspace", "cache", "clear"]) if !guest => {
                let freed = crate::workspace::clear_cache(&self.state_dir);
                ApiResponse::json(200, &json!({ "freed": freed, "storage": crate::workspace::storage(&self.state_dir) }))
            }
            ("GET", ["api", "workspace", "tools"]) => ApiResponse::json(200, &self.tools_json()),
            ("PUT", ["api", "workspace", "tools"]) if !guest && self.profile_restricted() => {
                ApiResponse::error(403, "the admin profile set Restricted mode for this profile")
            }
            ("PUT", ["api", "workspace", "tools"]) if !guest => match crate::workspace::save_tools(&self.state_dir, &body_json(&req.body)) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(403, e),
            },
            ("POST", ["api", "workspace", "restricted"]) if !guest && self.profile_restricted() => {
                ApiResponse::error(403, "the admin profile set Restricted mode for this profile")
            }
            ("POST", ["api", "workspace", "import"]) if !guest && self.restricted() => {
                ApiResponse::error(403, "Restricted mode is on in this workspace: importing is turned off")
            }
            // Per-profile UI state (tour seen, last version run, "Don't show again"): ui.json in the
            // profile's folder, so every new profile sees the first-start tour once
            ("GET", ["api", "ui-state"]) => ApiResponse::json(
                200,
                &std::fs::read(self.state_dir.join("ui.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or_else(|| json!({})),
            ),
            ("PUT", ["api", "ui-state"]) if !guest => {
                let mut cur: Value = std::fs::read(self.state_dir.join("ui.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}));
                let b = body_json(&req.body);
                if let (Some(c), Some(n)) = (cur.as_object_mut(), b.as_object()) {
                    for (k, v) in n.iter().take(32) {
                        c.insert(k.clone(), v.clone());
                    }
                }
                let _ = std::fs::create_dir_all(&self.state_dir);
                match std::fs::write(self.state_dir.join("ui.json"), serde_json::to_vec_pretty(&cur).unwrap_or_default()) {
                    Ok(_) => ApiResponse::json(200, &cur),
                    Err(e) => ApiResponse::error(500, e.to_string()),
                }
            }
            // Local profiles (profiles.rs): several people sharing one OS login. A convenience, not security.
            ("GET", ["api", "profiles"]) if !guest => ApiResponse::json(200, &self.profiles_json()),
            ("POST", ["api", "profiles"]) if !guest => self.profiles_add(&body_json(&req.body)),
            ("POST", ["api", "profiles", "choose"]) if !guest => self.profiles_choose(&body_json(&req.body)),
            ("POST", ["api", "profiles", id, action]) if !guest => self.profiles_admin(id, action, &body_json(&req.body)),
            ("DELETE", ["api", "profiles", id]) if !guest => self.profiles_admin(id, "remove", &json!({})),
            ("POST", ["api", "workspace", "restricted"]) if !guest => {
                let b = body_json(&req.body);
                match crate::workspace::set_restricted(&self.state_dir, b["on"].as_bool().unwrap_or(false), b["pin"].as_str().unwrap_or("")) {
                    Ok(v) => ApiResponse::json(200, &v),
                    Err(e) => ApiResponse::error(403, e),
                }
            }
            ("GET", ["api", "workspace", "export"]) if !guest => {
                if self.restricted() {
                    return ApiResponse::error(403, "Restricted mode is on in this workspace: exporting is turned off");
                }
                match crate::workspace::export_zip(&self.state_dir) {
                    Ok(b) => {
                        ApiResponse { status: 200, content_type: "application/zip", headers: vec![("Content-Disposition", "attachment; filename=\"geospax-workspace.zip\"".into())], body: b }
                    }
                    Err(e) => ApiResponse::error(500, e),
                }
            }
            ("POST", ["api", "workspace", "import"]) if !guest => match crate::workspace::import_zip(&self.state_dir, &req.body) {
                Ok(n) => ApiResponse::json(200, &json!({ "files": n })),
                Err(e) => ApiResponse::error(400, e),
            },
            ("GET", ["api", "projects"]) if !guest => ApiResponse::json(200, &self.projects_list()),
            ("GET", ["api", "projects", slug]) if !guest => match self.named_project(slug) {
                Ok(p) if p.exists() => self.project_get(&p),
                Ok(_) => ApiResponse::error(404, format!("no project '{slug}'")),
                Err(e) => e,
            },
            ("PUT", ["api", "projects", slug]) if !guest => match self.named_project(slug) {
                Ok(p) => {
                    let kept = {
                        let _g = self.project_lock.lock().unwrap();
                        crate::collab::keep_version(&self.projects_dir(), slug)
                    };
                    match kept {
                        Ok(_) => self.project_put(&p, &req.body),
                        Err(e) => ApiResponse::error(500, format!("could not keep the previous version: {e}")),
                    }
                }
                Err(e) => e,
            },
            // Review (collab.rs): version history and comments pinned to the map.
            ("GET", ["api", "projects", slug, "history"]) if !guest => match self.named_project(slug) {
                Ok(_) => ApiResponse::json(200, &json!({ "versions": crate::collab::versions(&self.projects_dir(), slug), "keep": crate::collab::KEEP })),
                Err(e) => e,
            },
            ("GET", ["api", "projects", slug, "history", v]) if !guest => match self.named_project(slug) {
                Ok(_) => match crate::collab::version(&self.projects_dir(), slug, v) {
                    Ok(doc) => ApiResponse::json(200, &doc),
                    Err(e) => ApiResponse::error(404, e),
                },
                Err(e) => e,
            },
            ("POST", ["api", "projects", slug, "history", v, "restore"]) if !guest => match self.named_project(slug) {
                Ok(p) if p.exists() => {
                    let _g = self.project_lock.lock().unwrap();
                    match crate::collab::restore(&self.projects_dir(), slug, v) {
                        Ok(r) => ApiResponse::json(200, &r),
                        Err(e) => ApiResponse::error(404, e),
                    }
                }
                Ok(_) => ApiResponse::error(404, format!("no project '{slug}'")),
                Err(e) => e,
            },
            ("GET", ["api", "projects", slug, "comments"]) if !guest => match self.named_project(slug) {
                Ok(_) => ApiResponse::json(200, &json!({ "comments": crate::collab::comments(&self.projects_dir(), slug) })),
                Err(e) => e,
            },
            ("POST", ["api", "projects", slug, "comments"]) if !guest => match (self.named_project(slug), serde_json::from_slice::<serde_json::Value>(&req.body)) {
                (Ok(p), _) if !p.exists() => ApiResponse::error(404, format!("no project '{slug}'")),
                (Ok(_), Ok(body)) => {
                    let _g = self.project_lock.lock().unwrap();
                    match crate::collab::add_comment(&self.projects_dir(), slug, &body) {
                        Ok(c) => ApiResponse::json(201, &c),
                        Err(e) => ApiResponse::error(400, e),
                    }
                }
                (Ok(_), Err(_)) => ApiResponse::error(400, "invalid JSON"),
                (Err(e), _) => e,
            },
            ("POST", ["api", "projects", slug, "comments", id, action @ ("resolve" | "reopen")]) if !guest => match (self.named_project(slug), id.parse::<u64>()) {
                (Ok(_), Ok(n)) => {
                    let _g = self.project_lock.lock().unwrap();
                    match crate::collab::resolve(&self.projects_dir(), slug, n, *action == "resolve") {
                        Ok(r) => ApiResponse::json(200, &r),
                        Err(e) => ApiResponse::error(404, e),
                    }
                }
                (Ok(_), Err(_)) => ApiResponse::error(400, format!("'{id}' is not a comment id")),
                (Err(e), _) => e,
            },
            ("DELETE", ["api", "projects", slug]) if !guest => match self.named_project(slug) {
                Ok(p) => match std::fs::remove_file(&p) {
                    Ok(()) => ApiResponse::json(200, &json!({ "deleted": slug })),
                    Err(e) => ApiResponse::error(404, format!("{}: {e}", p.display())),
                },
                Err(e) => e,
            },
            ("POST", ["api", "projects", slug, "rename"]) if !guest => {
                let to = param(q, "to").unwrap_or_default();
                match (self.named_project(slug), self.named_project(&to)) {
                    (Ok(from), Ok(dest)) => {
                        if !from.exists() {
                            ApiResponse::error(404, format!("no project '{slug}'"))
                        } else if dest.exists() && dest != from {
                            ApiResponse::error(409, format!("a project called '{to}' already exists"))
                        } else {
                            let _g = self.project_lock.lock().unwrap();
                            match std::fs::rename(&from, &dest) {
                                Ok(()) => ApiResponse::json(200, &json!({ "renamed": to, "path": dest.display().to_string() })),
                                Err(e) => ApiResponse::error(500, e.to_string()),
                            }
                        }
                    }
                    (Err(e), _) | (_, Err(e)) => e,
                }
            }
            ("GET", ["api", "project"]) => match self.project_file(guest, q) {
                Ok(p) => self.project_get(&p),
                Err(e) => e,
            },
            ("PUT", ["api", "project"]) => match self.project_file(guest, q) {
                Ok(p) => self.project_put(&p, &req.body),
                Err(e) => e,
            },
            ("OPTIONS", _) => ApiResponse { status: 204, content_type: "text/plain", headers: vec![], body: vec![] },
            _ => ApiResponse::error(404, format!("no route for {} {}", req.method, req.path)),
        }
    }

    fn layer_reply(&self, id: &str, status: u16, mut extra: serde_json::Value) -> ApiResponse {
        match self.layer(id) {
            Some(l) => {
                extra["layer"] = self.layer_json(&l);
                ApiResponse::json(status, &extra)
            }
            None => ApiResponse::error(500, format!("layer {id} was not added")),
        }
    }

    fn delete_reply(&self, layer: &str, fids: &[u64]) -> ApiResponse {
        match self.features_delete(layer, fids) {
            Ok((n, l)) => ApiResponse::json(200, &json!({ "deleted": n, "layer": self.layer_json(&l) })),
            Err(e) => ApiResponse::error(400, e),
        }
    }

    fn with_layer(&self, id: &str, f: impl FnOnce(&Arc<LayerHandle>) -> ApiResponse) -> ApiResponse {
        match self.layer(id) {
            Some(l) => f(&l),
            None => ApiResponse::error(404, format!("unknown layer '{id}'")),
        }
    }

    fn tile_response(&self, layer: &str, z: &str, x: &str, y: &str, query: &str) -> ApiResponse {
        let y = y.split('.').next().unwrap_or(y);
        let (Ok(z), Ok(x), Ok(y)) = (z.parse::<u8>(), x.parse::<u32>(), y.parse::<u32>()) else {
            return ApiResponse::error(400, "bad tile coordinates");
        };
        let fields = query_param(query, "fields");
        match self.tile(layer, z, x, y, fields) {
            Ok((t, hit)) => {
                let timing = if hit {
                    "cache;desc=hit, total;dur=0".to_string()
                } else if t.source == "overview" {
                    format!("cache;desc=overview, read;dur={:.2}, total;dur={:.2}", t.read_ms, t.total_ms)
                } else {
                    format!(
                        "cache;desc=miss, setup;dur={:.2}, read;dur={:.2}, proc;dur={:.2}, enc;dur={:.2}, teardown;dur={:.2}, total;dur={:.2}",
                        t.setup_ms, t.read_ms, t.proc_ms, t.enc_ms, t.teardown_ms, t.total_ms
                    )
                };
                ApiResponse {
                    status: 200,
                    content_type: "application/vnd.mapbox-vector-tile",
                    headers: vec![
                        ("Server-Timing", timing),
                        ("X-Tile-Features", t.features.to_string()),
                        ("X-Tile-Cache", if hit { "hit" } else { "miss" }.to_string()),
                        ("X-Tile-Source", t.source.to_string()),
                        ("X-Tile-Truncated", t.truncated.to_string()),
                        ("Cache-Control", "no-store".to_string()),
                    ],
                    body: t.bytes.clone(),
                }
            }
            Err(e) if e.starts_with("unknown layer") => ApiResponse::error(404, e),
            Err(e) if e.starts_with("unknown field") || e.starts_with("invalid tile") || e.contains("cannot be encoded") => {
                ApiResponse::error(400, e)
            }
            Err(e) => ApiResponse::error(500, e),
        }
    }

    fn field_for(l: &LayerHandle, query: &str) -> Result<usize, ApiResponse> {
        let name = param(query, "field").ok_or_else(|| ApiResponse::error(400, "missing ?field="))?;
        l.field_index(&name).ok_or_else(|| ApiResponse::error(400, format!("unknown field '{name}'")))
    }

    fn classify_response(&self, l: &LayerHandle, query: &str) -> ApiResponse {
        let fi = match Self::field_for(l, query) {
            Ok(i) => i,
            Err(r) => return r,
        };
        let wanted = param(query, "method").unwrap_or_else(|| "jenks".into());
        let guideline = wanted == "guideline";
        let method: Method = match if guideline { "jenks" } else { wanted.as_str() }.parse() {
            Ok(m) => m,
            Err(e) => return ApiResponse::error(400, e),
        };
        let k = param(query, "classes").and_then(|s| s.parse().ok()).unwrap_or(5usize);
        if !matches!(l.info.fields[fi].kind, "integer" | "real") {
            return ApiResponse::error(400, format!("field '{}' is not numeric", l.info.fields[fi].name));
        }
        let t0 = Instant::now();
        let mut values = match self.scan_column(l, fi) {
            Ok(ColumnValues::Num(v)) => v,
            Ok(ColumnValues::Str(_)) => return ApiResponse::error(400, "field is not numeric"),
            Err(e) => return ApiResponse::error(500, e),
        };
        let scan_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let mut v = classify::numeric_summary(&mut values, k, method);
        if guideline {
            values.sort_by(f64::total_cmp);
            match crate::automation::automap::guideline_classes(&l.info.fields[fi].name, &values) {
                Some((breaks, colors, labels, counts)) => {
                    v["breaks"] = breaks.into();
                    v["counts"] = counts.into();
                    v["colors"] = colors.into();
                    v["labels"] = labels.into();
                    v["method"] = "guideline".into();
                }
                None => v["note"] = "no WHO guideline for this field: natural breaks used".into(),
            }
        }
        v["field"] = l.info.fields[fi].name.clone().into();
        v["scan_ms"] = scan_ms.into();
        v["classify_ms"] = (t1.elapsed().as_secs_f64() * 1000.0).into();
        ApiResponse::json(200, &v)
    }

    fn unique_response(&self, l: &LayerHandle, query: &str) -> ApiResponse {
        let fi = match Self::field_for(l, query) {
            Ok(i) => i,
            Err(r) => return r,
        };
        let limit = param(query, "limit").and_then(|s| s.parse().ok()).unwrap_or(50usize).clamp(1, 1000);
        let t0 = Instant::now();
        let mut v = match self.scan_column(l, fi) {
            Ok(ColumnValues::Str(s)) => classify::unique_strings(s, limit),
            Ok(ColumnValues::Num(n)) => classify::unique_numbers(n, limit),
            Err(e) => return ApiResponse::error(500, e),
        };
        v["field"] = l.info.fields[fi].name.clone().into();
        v["scan_ms"] = (t0.elapsed().as_secs_f64() * 1000.0).into();
        ApiResponse::json(200, &v)
    }

    /// Start (or refuse) an overview build for a layer.
    pub fn start_overview_job(self: &Arc<Self>, layer_id: &str, max_zoom: Option<u8>) -> Result<Arc<crate::jobs::Job>, String> {
        let layer = self.layer(layer_id).ok_or_else(|| format!("unknown layer '{layer_id}'"))?.clone();
        let mz = match max_zoom.or_else(|| overview::suggested_max_zoom(&layer.info)) {
            Some(z) => z.min(layer.info.maxzoom.saturating_sub(1)),
            None => return Err("layer renders live at every zoom; pass ?maxzoom=N to build anyway".into()),
        };
        if let Some(j) = self.jobs.active("overviews", layer_id) {
            return Err(format!("overview job {} is already running for this layer", j.id));
        }
        let total = overview::pyramid_tiles(layer.info.bounds, mz);
        if total > overview::MAX_TILES {
            return Err(format!("z0-{mz} would be {total} tiles (limit {})", overview::MAX_TILES));
        }
        let job = self.jobs.create("overviews", layer_id);
        job.update(|s| s.total = total);
        let (engine, j) = (self.clone(), job.clone());
        self.job_pool.spawn(move || {
            j.update(|s| s.status = Status::Running);
            let out = overview::path_for(&engine.state_dir, &layer.info.id);
            let res = overview::build(&engine, &layer, mz, &out, &j.cancel, &|done, total| {
                j.update(|s| {
                    s.done = done;
                    s.total = total;
                })
            });
            let res = res.and_then(|report| {
                let ov = overview::Overview::open(&out, &overview::Fingerprint::of(&layer))?;
                layer.set_overview(Some(Arc::new(ov)));
                engine.clear_cache();
                Ok(report)
            });
            match res {
                Ok(r) => {
                    let msg = format!(
                        "z0-{} -> {} tiles, {:.1} MB in {:.1} s",
                        r.max_zoom,
                        r.tiles_written,
                        r.file_bytes as f64 / 1e6,
                        r.build_ms / 1000.0
                    );
                    j.finish(Status::Done, msg, serde_json::to_value(&r).ok());
                }
                Err(e) if j.cancel.load(Ordering::Relaxed) => j.finish(Status::Cancelled, e, None),
                Err(e) => j.finish(Status::Failed, e, None),
            }
        });
        Ok(job)
    }

    fn recipe_validate(&self, body: &[u8]) -> ApiResponse {
        let text = String::from_utf8_lossy(body);
        match self.automation.validate(&text, crate::automation::recipe::Origin::Api) {
            Ok((r, warnings)) => ApiResponse::json(200, &json!({
                "ok": true, "recipe": r.summary_json(), "plan": crate::automation::Automation::plan(&r), "warnings": warnings,
            })),
            Err(errors) => ApiResponse::json(200, &json!({ "ok": false, "errors": errors })),
        }
    }

    /// Save a user recipe. Recipes with Python/R steps run code on this machine, so saving one
    /// through the API needs `?approve=code` (AUTOMATION.md §8).
    fn recipe_save(&self, body: &[u8], query: &str) -> ApiResponse {
        if body.len() > 1 << 20 {
            return ApiResponse::error(413, "recipe too large (1 MB max)");
        }
        let text = String::from_utf8_lossy(body).into_owned();
        if let Ok(r) = crate::automation::recipe::Recipe::parse(&text, crate::automation::recipe::Origin::Api)
            && r.has_code_steps() && param(query, "approve").as_deref() != Some("code") {
                return ApiResponse::error(403, "this recipe runs Python/R code on this machine; save it with ?approve=code once you trust it");
            }
        match self.automation.save_user(&text) {
            Ok((r, warnings)) => ApiResponse::json(201, &json!({ "recipe": r.summary_json(), "warnings": warnings })),
            Err(errors) => ApiResponse::json(400, &json!({ "error": errors.join("; "), "errors": errors })),
        }
    }

    fn projects_dir(&self) -> std::path::PathBuf {
        self.state_dir.join("projects")
    }

    /// `<state>/projects/<slug>.json`; a slug is 1 to 64 of a-z, 0-9, '-' and '_'.
    fn named_project(&self, slug: &str) -> Result<std::path::PathBuf, ApiResponse> {
        let ok = !slug.is_empty() && slug.len() <= 64 && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
        if !ok {
            return Err(ApiResponse::error(400, format!("'{slug}' is not a valid project id (a-z, 0-9, - and _, up to 64)")));
        }
        Ok(self.projects_dir().join(format!("{slug}.json")))
    }

    /// The named projects, newest first: id, name (from the file), when saved and where.
    fn projects_list(&self) -> serde_json::Value {
        let mut out: Vec<(std::time::SystemTime, serde_json::Value)> = vec![];
        if let Ok(rd) = std::fs::read_dir(self.projects_dir()) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let slug = p.file_stem().and_then(|x| x.to_str()).unwrap_or_default().to_string();
                let modified = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                let name = std::fs::read(&p)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .unwrap_or_else(|| slug.clone());
                let ms = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                out.push((modified, json!({ "id": slug, "name": name, "saved": ms, "path": p.display().to_string() })));
            }
        }
        out.sort_by(|a, b| b.0.cmp(&a.0));
        json!({ "folder": self.projects_dir().display().to_string(), "projects": out.into_iter().map(|x| x.1).collect::<Vec<_>>() })
    }

    fn project_path(&self) -> std::path::PathBuf {
        self.state_dir.join("project.json")
    }

    /// The project file: the one of this installation, or in the guest demo the visitor's own (`?ws=`).
    fn project_file(&self, guest: bool, q: &str) -> Result<std::path::PathBuf, ApiResponse> {
        if !guest {
            return Ok(self.project_path());
        }
        crate::guest::workspace(param(q, "ws").as_deref())
            .map(|ws| crate::guest::project_path(&self.state_dir, &ws))
            .ok_or_else(|| ApiResponse::error(400, "guest demo: ws=<workspace id> is needed"))
    }

    fn project_get(&self, path: &std::path::Path) -> ApiResponse {
        let _g = self.project_lock.lock().unwrap();
        match std::fs::read(path) {
            Ok(b) => match serde_json::from_slice::<serde_json::Value>(&b) {
                Ok(v) => ApiResponse::json(200, &v),
                Err(e) => ApiResponse::error(500, format!("corrupt project file: {e}")),
            },
            Err(_) => ApiResponse::json(200, &serde_json::Value::Null),
        }
    }

    fn project_put(&self, path: &std::path::Path, body: &[u8]) -> ApiResponse {
        if body.len() > 4 << 20 {
            return ApiResponse::error(413, "project too large (4 MB max)");
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else {
            return ApiResponse::error(400, "invalid JSON");
        };
        let _g = self.project_lock.lock().unwrap();
        let tmp = path.with_extension("json.part");
        let res = std::fs::create_dir_all(path.parent().unwrap_or(&self.state_dir))
            .and_then(|_| std::fs::write(&tmp, serde_json::to_vec_pretty(&v).unwrap_or_default()))
            .and_then(|_| std::fs::rename(&tmp, path));
        match res {
            Ok(()) => ApiResponse::json(200, &json!({ "saved": true, "path": path.display().to_string() })),
            Err(e) => ApiResponse::error(500, format!("{}: {e}", path.display())),
        }
    }

    /// Client-side errors/warnings (release webviews have no devtools): echo
    /// to stderr and append to the bench log.
    fn client_log(&self, body: &[u8]) -> ApiResponse {
        let text = String::from_utf8_lossy(&body[..body.len().min(4096)]).into_owned();
        eprintln!("[client] {text}");
        if let Some(path) = &self.bench_log
            && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{}", json!({ "kind": "client-log", "message": text }));
            }
        ApiResponse::json(200, &json!({ "logged": true }))
    }

    fn store_bench(&self, body: &[u8]) -> ApiResponse {
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else {
            return ApiResponse::error(400, "invalid JSON");
        };
        if let Some(path) = &self.bench_log
            && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{v}");
            }
        *self.bench.lock().unwrap() = Some(v);
        ApiResponse::json(200, &json!({ "stored": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_allows_request_headers() {
        // the desktop page calls the engine cross-origin (Windows: gis.localhost); without this every
        // POST/PUT with a Content-Type failed in WebView2 with "Failed to fetch"
        let h = ApiResponse::common_headers();
        assert!(h.iter().any(|(k, v)| *k == "Access-Control-Allow-Headers" && *v == "*"));
    }

    #[test]
    fn decodes_query_components() {
        assert_eq!(pct_decode("POP%5FEST"), "POP_EST");
        assert_eq!(pct_decode("a+b%20c"), "a b c");
        assert_eq!(pct_decode("%E2%82%AC"), "€");
        assert_eq!(pct_decode("100%"), "100%");
        assert_eq!(pct_decode("%zz"), "%zz");
    }
}

#[cfg(test)]
mod lane_tests {
    use super::ApiRequest;

    fn req(method: &str, path: &str) -> ApiRequest {
        ApiRequest { method: method.into(), path: path.into(), ..Default::default() }
    }

    #[test]
    fn data_plane_vs_control_plane() {
        for p in ["/tiles/a.b/11/1850/1060", "/api/layers/a.b/arrow", "/api/layers/a.b/classify", "/api/layers/a.b/unique", "/api/layers/a.b/autostyle"] {
            assert!(req("GET", p).is_heavy(), "{p} should use the tile pool");
        }
        for (m, p) in [("GET", "/api/project"), ("PUT", "/api/project"), ("GET", "/api/jobs"), ("GET", "/api/jobs/3"),
                       ("POST", "/api/jobs/3/cancel"), ("GET", "/api/layers"), ("GET", "/api/stats"), ("POST", "/api/log"),
                       ("POST", "/api/layers/a.b/overviews"), ("GET", "/api/health"), ("GET", "/api/recipes"),
                       ("POST", "/api/recipes/photos-to-map/run"), ("GET", "/api/runs/x/files/map.png")] {
            assert!(!req(m, p).is_heavy(), "{m} {p} should use the control pool");
        }
    }
}
