//! Plugins (docs/PLUGINS.md).
//!
//! A plugin is a folder (or a package) with a **manifest** and one or more **tools**.
//! GeoSpaX reads the manifest formats of the four ecosystems users keep asking about, so
//! the same tool shows up in the ribbon whether it was written for GeoSpaX, RustGIS,
//! GeoLibre, QGIS or ArcGIS Pro:
//!
//! | Source | Manifest we read | What runs |
//! | --- | --- | --- |
//! | native | `plugin.yaml` | `process` / `recipe` / `python` / `r` / `wasm` |
//! | RustGIS | `plugin.json` (+ `entry` WASM) | the WASM module through a WASI runner |
//! | GeoLibre | `plugin.json`, WASM tool bundle | the WASI tool runner (`geolibre-cli`-shaped) |
//! | QGIS | `metadata.txt` | processing algorithms through `qgis_process` |
//! | ArcGIS Pro | `Config.daml` (+ `Toolboxes/*.pyt`) | Python toolbox tools through `python3` |
//!
//! What cannot run is reported, not hidden: a QGIS *UI* plugin needs PyQt + the QGIS API
//! and a Pro *.NET* add-in needs the CLR, so those are listed as `runnable: false` with
//! `needs: "…"`. Their declared tools and ribbon buttons are still imported.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::RwLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::automation;

// ---------------------------------------------------------------- manifest types

/// One parameter of a tool. Kinds map onto the ribbon's form widgets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSpec {
    pub name: String,
    #[serde(default)]
    pub label: String,
    /// `number` · `text` · `bool` · `layer` · `field` · `file` · `choice` · `raster` · `rasters`
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub choices: Vec<String>,
}

fn default_kind() -> String {
    "text".to_string()
}

/// A geoprocessing tool contributed by a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    /// Ribbon group (and the toolbox name in the Geoprocessing list).
    #[serde(default)]
    pub group: String,
    /// Always serialised (even when empty): the front end reads `tool.params` directly.
    #[serde(default)]
    pub params: Vec<ParamSpec>,
    /// `recipe` plugins only: which recipe this tool runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe: Option<String>,
    /// Icon name for the ribbon (see web/src/commands.ts ICONS).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Ribbon tab for the tool: home, data, style, analyze, imagery, modelling … (default: Plugins).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
}

/// A ribbon button contributed by a plugin (RustGIS/GeoLibre/ArcGIS declare these).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandSpec {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub help: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub group: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// `native` · `rustgis` · `geolibre` · `qgis` · `arcgis`
    pub source: String,
    /// `recipe` · `process` · `python` · `r` · `wasm` · `ui`
    pub kind: String,
    /// False when the runtime is missing: `needs` says what to install.
    pub runnable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs: Option<String>,
    pub path: String,
    pub tools: Vec<ToolSpec>,
    pub commands: Vec<CommandSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// Part of GeoSpaX itself (the GSX and GeoLibre tools): shipped with the app, shown with the
    /// built-in tools, not in the plugin manager, never uninstalled.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub builtin: bool,
    /// A tool library other plugins run: not on the ribbon, in the Toolbox or the plugin list, but its
    /// tools still run from recipes, the API and MCP.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub library: bool,
    /// A default plugin: shipped with GeoSpaX and listed in the plugin manager, not removable.
    #[serde(rename = "default", skip_serializing_if = "std::ops::Not::not")]
    pub default_set: bool,
}

/// Tool sets that ship with GeoSpaX and are part of it, though they run on Node and WebAssembly
/// through the plugin contract.
pub const BUILTIN: &[&str] = &["gsx", "geolibre-tools"];

// native plugin.yaml
#[derive(Debug, Deserialize)]
struct NativeManifest {
    plugin: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    /// recipe · process · python · r · wasm
    #[serde(default)]
    kind: Option<String>,
    /// Command template for process/python/r/wasm (${plugin} = plugin folder, ${tool} = tool id).
    #[serde(default)]
    run: Option<String>,
    /// The tool reads GeoJSON: every layer named by a `layer` parameter is written to the workdir as
    /// GeoJSON (whatever its source format) and passed in `layer_geojson` {id: path}.
    #[serde(default)]
    geojson: bool,
    #[serde(default)]
    tools: Vec<ToolSpec>,
    #[serde(default)]
    commands: Vec<CommandSpec>,
    /// A shared tool library for other plugins: its tools run (recipes, API, MCP) but are not listed.
    #[serde(default)]
    library: bool,
    /// One of GeoSpaX's default plugins (honoured only when shipped with the app).
    #[serde(default, rename = "default")]
    default_set: bool,
}

// RustGIS / GeoLibre plugin.json
#[derive(Debug, Deserialize)]
struct JsonManifest {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    commands: Vec<JsonCommand>,
    #[serde(default)]
    tools: Vec<JsonTool>,
}

#[derive(Debug, Deserialize)]
struct JsonCommand {
    id: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    help: Option<String>,
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonTool {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    toolbox: Option<String>,
    #[serde(default)]
    params: Vec<JsonParam>,
}

#[derive(Debug, Deserialize)]
struct JsonParam {
    name: String,
    #[serde(default)]
    label: Option<String>,
    /// RustGIS kinds: vectorLayer, rasterLayer, bool, number, string, choice…
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    default: Option<serde_json::Value>,
    #[serde(default)]
    description: Option<String>,
}

impl JsonTool {
    fn to_spec(&self) -> ToolSpec {
        ToolSpec {
            id: self.id.clone(),
            name: self.name.clone().unwrap_or_else(|| self.id.clone()),
            summary: self.summary.clone().unwrap_or_default(),
            group: self.toolbox.clone().unwrap_or_else(|| "Plugins".to_string()),
            params: self
                .params
                .iter()
                .map(|p| ParamSpec {
                    name: p.name.clone(),
                    label: p.label.clone().unwrap_or_else(|| p.name.clone()),
                    kind: map_kind(p.kind.as_deref().unwrap_or("string")),
                    required: p.required,
                    default: p.default.clone(),
                    description: p.description.clone(),
                    choices: vec![],
                })
                .collect(),
            recipe: None,
            icon: None,
            tab: None,
        }
    }
}

fn map_kind(k: &str) -> String {
    match k {
        "number" | "int" | "integer" | "float" | "double" | "real" => "number",
        "bool" | "boolean" => "bool",
        "layer" | "vectorLayer" | "rasterLayer" | "featureLayer" | "mapLayer" => "layer",
        "field" => "field",
        "file" | "path" | "folder" => "file",
        "choice" | "enum" | "options" => "choice",
        _ => "text",
    }
    .to_string()
}

// ---------------------------------------------------------------- registry

#[derive(Debug, Clone, Default)]
pub struct PluginsConfig {
    /// Extra folders that hold plugin folders (repeatable; state_dir/plugins is always read).
    pub dirs: Vec<PathBuf>,
}

pub struct Plugins {
    dirs: Vec<PathBuf>,
    plugins: RwLock<Vec<PluginInfo>>,
}

impl Plugins {
    pub fn new(dirs: Vec<PathBuf>) -> Self {
        let p = Plugins { dirs, plugins: RwLock::new(Vec::new()) };
        p.reload();
        p
    }

    pub fn dirs(&self) -> &[PathBuf] {
        &self.dirs
    }

    pub fn reload(&self) {
        // Later folders win: `--plugins DIR` folders first, the state directory last, so an
        // installed plugin shadows a copy you are developing elsewhere under the same id.
        let mut by_id: std::collections::HashMap<String, PluginInfo> = std::collections::HashMap::new();
        for dir in &self.dirs {
            let Ok(entries) = fs::read_dir(dir) else { continue };
            let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            paths.sort();
            for path in paths {
                if let Some(info) = read_plugin(&path) {
                    by_id.insert(info.id.clone(), info);
                }
            }
        }
        let mut out: Vec<PluginInfo> = by_id.into_values().collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        if let Ok(mut w) = self.plugins.write() {
            *w = out;
        }
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        self.plugins.read().map(|r| r.clone()).unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<PluginInfo> {
        self.plugins.read().ok()?.iter().find(|p| p.id == id).cloned()
    }

    /// Which external runtimes are on this machine (`qgis_process`, `python3`, `Rscript`, `wasmtime` …).
    pub fn runtimes(&self) -> serde_json::Value {
        let mut m = BTreeMap::new();
        for bin in ["python3", "python", "Rscript", "qgis_process", "wasmtime", "wasm3", "deno", "node"] {
            m.insert(bin.to_string(), serde_json::json!(which(bin)));
        }
        serde_json::json!(m)
    }
}

fn which(bin: &str) -> Option<String> {
    let out = Command::new("which").arg(bin).output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------- discovery

/// Read a plugin folder (or a package) in any of the five formats.
pub fn read_plugin(path: &Path) -> Option<PluginInfo> {
    if path.is_file() {
        return match path.extension().and_then(|e| e.to_str()) {
            Some("rgplugin") | Some("esriAddInX") | Some("zip") => read_package(path),
            _ => None,
        };
    }
    if !path.is_dir() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    if let Some(i) = read_native(path) {
        return Some(i);
    }
    if let Some(i) = read_json_manifest(path) {
        return Some(i);
    }
    if let Some(i) = read_qgis(path) {
        return Some(i);
    }
    if let Some(i) = read_arcgis(path) {
        return Some(i);
    }
    // No recognised manifest: still show the folder so the user knows where to put one.
    if name.starts_with('.') {
        return None;
    }
    None
}

/// Plugins that ship with GeoSpaX: `$GEOSPAX_PLUGINS`, else the first of `./plugins` (a source
/// checkout), `plugins/` next to the executable (Windows) and `../share/geospax/plugins` (.deb, Docker).
pub fn bundled_dirs() -> Vec<PathBuf> {
    if let Ok(v) = std::env::var("GEOSPAX_PLUGINS") {
        return std::env::split_paths(&v).filter(|p| p.is_dir()).collect();
    }
    let exe = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
    let mut c = vec![PathBuf::from("plugins")];
    if let Some(d) = exe {
        c.push(d.join("plugins"));
        c.push(d.parent().unwrap_or(&d).join("share/geospax/plugins"));
    }
    c.into_iter()
        .filter(|p| p.join("geolibre-tools").is_dir() || p.join("example-python").is_dir())
        .filter_map(|p| p.canonicalize().ok())
        .take(1)
        .collect()
}

/// The program a native `process` plugin starts: the first word of its `run:` command.
fn run_program(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path.join("plugin.yaml")).or_else(|_| fs::read_to_string(path.join("plugin.yml"))).ok()?;
    let m: NativeManifest = serde_saphyr::from_str(&text).ok()?;
    m.run?.split_whitespace().next().map(str::to_string)
}

fn finish(mut i: PluginInfo, path: &Path) -> PluginInfo {
    i.path = path.to_string_lossy().to_string();
    let shipped = bundled_dirs().iter().any(|d| path.starts_with(d));
    i.builtin = shipped && BUILTIN.contains(&i.id.as_str());
    i.default_set &= shipped;
    // A runtime the machine does not have is reported, not silently dropped.
    if i.needs.is_none() {
        match i.kind.as_str() {
            "python" => {
                if which("python3").is_none() && which("python").is_none() {
                    i.runnable = false;
                    i.needs = Some("python3".to_string());
                }
            }
            "r" => {
                if which("Rscript").is_none() {
                    i.runnable = false;
                    i.needs = Some("Rscript".to_string());
                }
            }
            "process" => {
                // the first word of `run:` is the program (node, java, a binary next to the manifest…)
                if let Some(prog) = run_program(path)
                    && !prog.contains('/') && !prog.contains("${") && which(&prog).is_none() {
                        i.runnable = false;
                        i.needs = Some(prog);
                    }
            }
            "wasm"
                if which("wasmtime").is_none() && which("wasm3").is_none() && which("deno").is_none() => {
                    i.runnable = false;
                    i.needs = Some("wasmtime (or wasm3/deno)".to_string());
                }
            _ => {}
        }
    }
    i
}

fn read_native(path: &Path) -> Option<PluginInfo> {
    let text = fs::read_to_string(path.join("plugin.yaml"))
        .or_else(|_| fs::read_to_string(path.join("plugin.yml")))
        .ok()?;
    let m: NativeManifest = match serde_saphyr::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            return Some(finish(
                PluginInfo {
                    builtin: false,
                    library: false,
                    default_set: false,
                    id: path.file_name()?.to_string_lossy().to_string(),
                    name: path.file_name()?.to_string_lossy().to_string(),
                    version: None,
                    description: String::new(),
                    author: None,
                    license: None,
                    homepage: None,
                    source: "native".to_string(),
                    kind: "process".to_string(),
                    runnable: false,
                    needs: None,
                    path: String::new(),
                    tools: vec![],
                    commands: vec![],
                    warning: Some(format!("plugin.yaml does not parse: {e}")),
                },
                path,
            ))
        }
    };
    let kind = m.kind.clone().unwrap_or_else(|| "process".to_string());
    let mut tools = m.tools;
    for t in tools.iter_mut() {
        if t.recipe.is_none() && kind == "recipe" {
            t.recipe = Some(t.id.clone());
        }
        if t.group.is_empty() {
            t.group = m.title.clone().unwrap_or_else(|| m.plugin.clone());
        }
    }
    let mut commands = m.commands;
    for c in commands.iter_mut() {
        if c.group.is_empty() {
            c.group = m.title.clone().unwrap_or_else(|| m.plugin.clone());
        }
    }
    Some(finish(
        PluginInfo {
            builtin: false,
            library: m.library,
            default_set: m.default_set,
            id: m.plugin.clone(),
            name: m.title.clone().unwrap_or(m.plugin),
            version: m.version,
            description: m.description.unwrap_or_default(),
            author: m.author,
            license: m.license,
            homepage: m.homepage,
            source: "native".to_string(),
            kind,
            runnable: true,
            needs: None,
            path: String::new(),
            tools,
            commands,
            warning: None,
        },
        path,
    ))
}

/// RustGIS `.rgplugin` manifest and GeoLibre's `plugin.json` share this shape.
fn read_json_manifest(path: &Path) -> Option<PluginInfo> {
    let text = fs::read_to_string(path.join("plugin.json")).ok()?;
    let m: JsonManifest = serde_json::from_str(&text).ok()?;
    let entry = m.entry.clone().unwrap_or_else(|| "plugin.wasm".to_string());
    let has_module = path.join(&entry).is_file();
    // GeoLibre plugins are TypeScript/React; their WASM tool bundles are not.
    let source = if m.tools.iter().any(|t| t.id.contains("geolibre")) || path.join("tools.mjs").exists() {
        "geolibre"
    } else {
        "rustgis"
    };
    let mut warning = None;
    if !has_module {
        warning = Some(format!(
            "no WebAssembly module ({entry}) next to plugin.json: the tools are listed, but nothing can run them"
        ));
    }
    Some(finish(
        PluginInfo {
            builtin: false,
            library: false,
            default_set: false,
            id: m.id.clone(),
            name: m.name.clone().unwrap_or_else(|| m.id.clone()),
            version: m.version,
            description: m.description.unwrap_or_default(),
            author: m.author,
            license: m.license,
            homepage: m.homepage,
            source: source.to_string(),
            kind: "wasm".to_string(),
            runnable: has_module,
            needs: if has_module { None } else { Some(format!("{entry} next to plugin.json")) },
            path: String::new(),
            tools: m.tools.iter().map(|t| t.to_spec()).collect(),
            commands: m
                .commands
                .iter()
                .map(|c| CommandSpec {
                    id: c.id.clone(),
                    title: c.label.clone().unwrap_or_else(|| c.id.clone()).replace("\\n", " "),
                    help: c.help.clone().unwrap_or_default(),
                    icon: c.icon.clone(),
                    group: m.name.clone().unwrap_or_else(|| m.id.clone()),
                })
                .collect(),
            warning,
        },
        path,
    ))
}

/// QGIS: `metadata.txt` (INI) + processing algorithms through `qgis_process`.
fn read_qgis(path: &Path) -> Option<PluginInfo> {
    let text = fs::read_to_string(path.join("metadata.txt")).ok()?;
    let mut map = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let id = map.get("name").cloned()?;
    let provider = map.get("hasProcessingProvider").map(|v| v == "yes").unwrap_or(false);
    let mut tools = Vec::new();
    let mut warning = None;
    let mut needs = None;
    if provider {
        match qgis_tools(&id) {
            Ok(ts) => tools = ts,
            Err(e) => {
                warning = Some(format!("processing provider declared, but its algorithms could not be listed: {e}"));
                needs = Some("qgis_process".to_string());
            }
        }
    } else {
        warning = Some(
            "QGIS plugin without hasProcessingProvider=yes: its Python UI (PyQt + the QGIS API) cannot run inside GeoSpaX"
                .to_string(),
        );
        needs = Some("a processing provider (or port the algorithm to a GeoSpaX plugin)".to_string());
    }
    Some(finish(
        PluginInfo {
            builtin: false,
            library: false,
            default_set: false,
            id: id.clone(),
            name: id.clone(),
            version: map.get("version").cloned(),
            description: map.get("description").cloned().unwrap_or_default(),
            author: map.get("author").cloned(),
            license: None,
            homepage: map.get("homepage").cloned(),
            source: "qgis".to_string(),
            kind: "process".to_string(),
            runnable: !tools.is_empty(),
            needs,
            path: String::new(),
            tools,
            commands: vec![],
            warning,
        },
        path,
    ))
}

/// `qgis_process list --json` → the algorithms of one provider, as GeoSpaX tools.
fn qgis_tools(provider: &str) -> Result<Vec<ToolSpec>, String> {
    let bin = which("qgis_process").ok_or_else(|| "qgis_process is not on PATH".to_string())?;
    let out = Command::new(bin)
        .args(["list", "--json"])
        .env("QT_QPA_PLATFORM", "offscreen")
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let mut tools = Vec::new();
    if let Some(groups) = v.as_object() {
        for (prov, algs) in groups {
            if prov != provider {
                continue;
            }
            if let Some(arr) = algs.as_array() {
                for a in arr {
                    let id = a.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                    if id.is_empty() {
                        continue;
                    }
                    tools.push(ToolSpec {
                        name: a.get("name").and_then(|x| x.as_str()).unwrap_or(&id).to_string(),
                        id,
                        summary: String::new(),
                        group: prov.clone(),
                        params: vec![],
                        recipe: None,
                        icon: Some("grid".to_string()),
                        tab: Some("analyze".to_string()),
                    });
                }
            }
        }
    }
    Ok(tools)
}

/// ArcGIS Pro: `Config.daml` (the add-in's ribbon) and any `Toolboxes/*.pyt`.
fn read_arcgis(path: &Path) -> Option<PluginInfo> {
    let text = fs::read_to_string(path.join("Config.daml")).ok()?;
    let id = attr(&text, "AddInInfo", "id")
        .map(|s| s.trim_matches(|c| c == '{' || c == '}').to_string())
        .unwrap_or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let name = element_text(&text, "Name")
        .or_else(|| attr(&text, "AddInInfo", "id").map(|_| id.clone()))
        .unwrap_or_else(|| id.clone());
    let description = element_text(&text, "Description").unwrap_or_default();
    let author = element_text(&text, "Author");
    let mut commands = Vec::new();
    for (cid, caption) in buttons(&text) {
        commands.push(CommandSpec {
            id: cid.clone(),
            title: caption.unwrap_or_else(|| cid.clone()),
            help: String::new(),
            icon: None,
            group: name.clone(),
        });
    }
    // Python toolboxes: real tools, if arcpy is installed.
    let mut tools = Vec::new();
    // Always say the .NET part out loud; the .pyt part is added to it.
    let mut warning =
        "ArcGIS Pro add-in: the .NET assembly cannot run in GeoSpaX (no CLR). Its ribbon was imported; \
         port the tool bodies to a GeoSpaX plugin, or ship a Python toolbox (.pyt) inside it."
            .to_string();
    let mut needs = Some("arcpy (for .pyt tools)".to_string());
    let pyts = find_files(path, "pyt");
    if pyts.is_empty() {
        warning.push_str(" No Python toolbox was found inside it.");
    }
    for pyt in pyts {
        match arcgis_pyt_tools(&pyt) {
            Ok(ts) => {
                tools.extend(ts);
                warning = "ArcGIS Pro add-in: the .NET assembly cannot run in GeoSpaX (no CLR), but its Python toolbox tools were imported and run through arcpy. Its ribbon was imported too.".to_string();
                needs = None;
            }
            Err(e) => {
                warning = format!(
                    "ArcGIS Pro add-in: the .NET assembly cannot run in GeoSpaX (no CLR). Its ribbon was imported. \
                     Python toolbox {pyt:?} found, but its tools could not be read: {e}"
                );
            }
        }
    }
    Some(finish(
        PluginInfo {
            builtin: false,
            library: false,
            default_set: false,
            id,
            name,
            version: attr(&text, "AddInInfo", "version"),
            description,
            author,
            license: None,
            homepage: None,
            source: "arcgis".to_string(),
            kind: "python".to_string(),
            runnable: !tools.is_empty(),
            needs,
            path: String::new(),
            tools,
            commands,
            warning: Some(warning),
        },
        path,
    ))
}

/// `python3 -c "…"` over a `.pyt`: ask arcpy for the tool list. No arcpy, no tools.
fn arcgis_pyt_tools(pyt: &Path) -> Result<Vec<ToolSpec>, String> {
    let py = which("python3").or_else(|| which("python")).ok_or("python3 is not on PATH")?;
    let script = format!(
        "import importlib.util, json, sys\n\
         spec = importlib.util.spec_from_file_location('pyt_under_test', {path:?})\n\
         mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n\
         box = mod.Toolbox(); out = []\n\
         for t in box.tools:\n\
         \x20   inst = t(); params = []\n\
         \x20   for p in (inst.getParameterInfo() or []):\n\
         \x20       params.append({{'name': p.name, 'label': p.displayName, 'kind': p.datatype, 'required': p.parameterType == 'Required'}})\n\
         \x20   out.append({{'id': type(inst).__name__, 'name': inst.label, 'summary': getattr(inst, 'description', '') or '', 'group': box.label, 'params': params}})\n\
         print(json.dumps(out))\n",
        path = pyt
    );
    let out = Command::new(py).args(["-c", &script]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("arcpy import failed").to_string());
    }
    let v: serde_json::Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim())
        .map_err(|e| format!("bad JSON from the toolbox: {e}"))?;
    let mut tools = Vec::new();
    for t in v.as_array().cloned().unwrap_or_default() {
        let spec: ToolSpec = serde_json::from_value(t).map_err(|e| e.to_string())?;
        tools.push(spec);
    }
    Ok(tools)
}

fn find_files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(find_files(&p, ext));
        } else if p.extension().and_then(|x| x.to_str()) == Some(ext) {
            out.push(p);
        }
    }
    out
}

/// A package (`.rgplugin`, `.esriAddInX`, `.zip`): read the manifest inside without unpacking.
fn read_package(path: &Path) -> Option<PluginInfo> {
    let file = fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let names: Vec<String> = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().and_then(|f| f.name().ok().map(|n| n.to_string()))).collect();
    let pick = |want: &str| -> Option<String> {
        names
            .iter()
            .find(|n| n.rsplit('/').next().unwrap_or(n.as_str()) == want)
            .cloned()
    };
    if let Some(n) = pick("plugin.json").or_else(|| pick("plugin.yaml")) {
        let mut text = String::new();
        {
            use std::io::Read;
            let mut f = zip.by_name(&n).ok()?;
            if f.size() > 1 << 20 {
                return None;
            }
            f.read_to_string(&mut text).ok()?;
        }
        let json: JsonManifest = serde_json::from_str(&text).ok()?;
        return Some(finish(
            PluginInfo {
                builtin: false,
                library: false,
                default_set: false,
                id: json.id.clone(),
                name: json.name.clone().unwrap_or_else(|| json.id.clone()),
                version: json.version,
                description: json.description.unwrap_or_default(),
                author: json.author,
                license: json.license,
                homepage: json.homepage,
                source: if n == "plugin.json" { "rustgis".to_string() } else { "native".to_string() },
                kind: "wasm".to_string(),
                runnable: false,
                needs: Some("install the package first (Plugins › Install)".to_string()),
                path: String::new(),
                tools: json.tools.iter().map(|t| t.to_spec()).collect(),
                commands: json
                    .commands
                    .iter()
                    .map(|c| CommandSpec {
                        id: c.id.clone(),
                        title: c.label.clone().unwrap_or_else(|| c.id.clone()).replace("\\n", " "),
                        help: c.help.clone().unwrap_or_default(),
                        icon: c.icon.clone(),
                        group: json.name.clone().unwrap_or_else(|| json.id.clone()),
                    })
                    .collect(),
                warning: Some(format!("{} is a package file, not an installed plugin", path.display())),
            },
            path,
        ));
    }
    if let Some(n) = names.iter().find(|x| x.ends_with("Config.daml")).cloned() {
        let mut text = String::new();
        {
            use std::io::Read;
            let mut f = zip.by_name(&n).ok()?;
            if f.size() > 1 << 20 {
                return None;
            }
            f.read_to_string(&mut text).ok()?;
        }
        let id = attr(&text, "AddInInfo", "id").unwrap_or_default();
        let name = element_text(&text, "Name").unwrap_or_else(|| id.clone());
        let mut commands = Vec::new();
        for (cid, caption) in buttons(&text) {
            commands.push(CommandSpec { id: cid.clone(), title: caption.unwrap_or(cid), help: String::new(), icon: None, group: name.clone() });
        }
        return Some(finish(
            PluginInfo {
                builtin: false,
                library: false,
                default_set: false,
                id: id.clone(),
                name,
                version: attr(&text, "AddInInfo", "version"),
                description: element_text(&text, "Description").unwrap_or_default(),
                author: element_text(&text, "Author"),
                license: None,
                homepage: None,
                source: "arcgis".to_string(),
                kind: "python".to_string(),
                runnable: false,
                needs: Some("install the package first (Plugins › Install)".to_string()),
                path: String::new(),
                tools: vec![],
                commands,
                warning: Some(format!("{} is an ArcGIS add-in package: install it to read its toolboxes", path.display())),
            },
            path,
        ));
    }
    None
}

// --- tiny XML helpers for Config.daml (no XML dependency: the file is small and fixed-shape)

fn element_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let open_end = format!("<{tag}>");
    let start = xml.find(&open_end).or_else(|| xml.find(&open))?;
    let from = xml[start..].find('>')? + start + 1;
    let close = format!("</{tag}>");
    let end = xml[from..].find(&close)? + from;
    let t = xml[from..end].trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    }
}

fn attr(xml: &str, tag: &str, key: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}"))?;
    let end = xml[start..].find('>')? + start;
    let head = &xml[start..end];
    let needle = format!("{key}=\"");
    let from = head.find(&needle)? + needle.len();
    let to = head[from..].find('"')? + from;
    Some(head[from..to].to_string())
}

/// `<button id="…" caption="…" …>` / `<tool id="…" caption="…" …>` of an add-in.
fn buttons(xml: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for tag in ["button", "tool"] {
        let mut rest = xml;
        while let Some(p) = rest.find(&format!("<{tag} ")) {
            let head = &rest[p..];
            let end = match head.find('>') {
                Some(e) => e,
                None => break,
            };
            let attrs = &head[..end];
            if let Some(id) = attr_in(attrs, "id") {
                out.push((id, attr_in(attrs, "caption")));
            }
            rest = &head[end..];
        }
    }
    out
}

fn attr_in(attrs: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let from = attrs.find(&needle)? + needle.len();
    let to = attrs[from..].find('"')? + from;
    Some(attrs[from..to].to_string())
}

// ---------------------------------------------------------------- running tools

impl Plugins {
    /// Run a plugin tool. Recipe-backed tools go through the automation engine (progress,
    /// artifacts, history); everything else is a subprocess speaking JSON on stdin/stdout.
    pub fn run_tool(
        &self,
        engine: &std::sync::Arc<crate::Engine>,
        plugin_id: &str,
        tool_id: &str,
        params: serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let p = self.get(plugin_id).ok_or_else(|| format!("unknown plugin '{plugin_id}'"))?;
        let tool = p
            .tools
            .iter()
            .find(|t| t.id == tool_id)
            .ok_or_else(|| format!("plugin '{plugin_id}' has no tool '{tool_id}'"))?;
        if !self.is_enabled(plugin_id) {
            return Err(format!("{} is switched off: turn it on in Manage plugins", p.name));
        }
        if !p.runnable {
            return Err(format!(
                "{} cannot run here: install {}",
                p.name,
                p.needs.clone().unwrap_or_else(|| "its runtime".to_string())
            ));
        }
        // 1. a tool that is a recipe: the automation engine does the rest
        if let Some(recipe) = tool.recipe.as_ref() {
            let trigger = serde_json::json!({ "kind": "plugin", "text": format!("{plugin_id}/{tool_id}") });
            let run = engine
                .automation
                .start_run(engine, recipe, params, trigger)
                .map_err(|e| format!("{recipe}: {e}"))?;
            return Ok(serde_json::json!({ "kind": "recipe", "run": run.json() }));
        }
        // 2. QGIS processing algorithms
        if p.source == "qgis" {
            return run_qgis(&p, tool, &params);
        }
        // 3. ArcGIS Python toolbox tools
        if p.source == "arcgis" {
            return run_arcgis(&p, tool, &params);
        }
        // 4. process / python / r / wasm: one command, JSON in, JSON out
        let text = fs::read_to_string(Path::new(&p.path).join("plugin.yaml"))
            .or_else(|_| fs::read_to_string(Path::new(&p.path).join("plugin.yml")))
            .map_err(|_| "plugin.yaml is missing".to_string())?;
        let m: NativeManifest = serde_saphyr::from_str(&text).map_err(|e| format!("plugin.yaml: {e}"))?;
        let template = m.run.clone().ok_or("plugin.yaml has no `run:` command")?;
        let mut parts = template.split_whitespace().map(|s| s.to_string()).collect::<Vec<_>>();
        for part in parts.iter_mut() {
            *part = part
                .replace("${plugin}", &p.path)
                .replace("${tool}", &tool.id)
                .replace("${workdir}", workdir().to_string_lossy().as_ref());
        }
        let (prog, args) = parts.split_first().ok_or("empty `run:` command")?;
        // Results go to <state>/plugin-results/<plugin>/; the tool lists what it wrote in "outputs"
        // and those files join the map (vector layers and rasters) without a restart.
        let out_dir = engine.state_dir.join("plugin-results").join(&p.id);
        let _ = fs::create_dir_all(&out_dir);
        let sources: serde_json::Map<String, serde_json::Value> =
            engine.layers().iter().map(|l| (l.info.id.clone(), serde_json::json!(l.info.source))).collect();
        let mut as_geojson = serde_json::Map::new();
        if m.geojson {
            fs::create_dir_all(workdir()).map_err(|e| format!("{}: {e}", workdir().display()))?;
            for ps in tool.params.iter().filter(|ps| ps.kind == "layer") {
                let Some(id) = params.get(&ps.name).and_then(|v| v.as_str()) else { continue };
                let Some(l) = engine.layer(id) else { continue };
                if as_geojson.contains_key(id) {
                    continue;
                }
                let fs = crate::automation::features::read_layer(engine, &l, None, None, 2_000_000)?;
                let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
                let path = workdir().join(format!("{}-{}.geojson", p.id, safe.trim_end_matches(".geojson").trim_end_matches(".json")));
                crate::automation::features::write_features(&path, "GeoJSON", id, &fs)?;
                as_geojson.insert(id.to_string(), serde_json::json!(path));
            }
        }
        // Rasters go in as plain float32 grids (`<id>.grid.json` + `.f32`, row-major, north up), every
        // raster of one run resampled onto the first one's grid, so a tool can read them with no
        // GDAL of its own (docs/PLUGINS.md).
        let mut grids = serde_json::Map::new();
        let raster_ids: Vec<String> = tool
            .params
            .iter()
            .filter(|ps| ps.kind == "raster" || ps.kind == "rasters")
            .flat_map(|ps| match params.get(&ps.name) {
                Some(serde_json::Value::String(s)) if !s.is_empty() => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                Some(serde_json::Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
                _ => Vec::new(),
            })
            .collect();
        if !raster_ids.is_empty() {
            fs::create_dir_all(workdir()).map_err(|e| format!("{}: {e}", workdir().display()))?;
            let mut template: Option<(usize, usize, [f64; 6], String)> = None;
            for id in &raster_ids {
                if grids.contains_key(id) {
                    continue;
                }
                let r = engine.raster(id).ok_or_else(|| format!("unknown raster '{id}'"))?;
                let path = write_grid(&r, &mut template, &workdir().join(format!("{}-{}", p.id, crate::raster::sanitize(id))))?;
                grids.insert(id.clone(), serde_json::json!(path));
            }
        }
        let payload = serde_json::json!({
            "plugin": p.id, "tool": tool.id, "params": params,
            "raster_grids": grids,
            "layer_geojson": as_geojson,
            "layers": engine.layer_ids(),
            "layer_sources": sources,
            "workdir": workdir(),
            "out_dir": out_dir,
        });
        let child = Command::new(prog)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => return Err(format!("cannot start {prog}: {e}")),
        };
        {
            use std::io::Write;
            // `take()` + drop closes the pipe, which is the EOF the tool's read() waits for.
            if let Some(mut sin) = child.stdin.take() {
                let _ = sin.write_all(payload.to_string().as_bytes());
            }
        }
        let wait = wait_with_timeout(&mut child, Duration::from_secs(600))?;
        let stdout = String::from_utf8_lossy(&wait.stdout).to_string();
        let stderr = String::from_utf8_lossy(&wait.stderr).to_string();
        if !wait.status.success() {
            // exit 1 with a message is the tool refusing its input: say why, in its words
            if wait.status.code() == Some(1)
                && let Some(why) = first_line(&stderr) {
                    return Err(format!("{}: {why}", p.name));
                }
            return Err(format!(
                "{prog} exited with {}: {}",
                wait.status,
                first_line(&stderr).or_else(|| first_line(&stdout)).unwrap_or_else(|| "(no output)".to_string())
            ));
        }
        let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
            .unwrap_or_else(|_| serde_json::json!({ "ok": true, "message": stdout.trim() }));
        let added = add_outputs(engine, &parsed);
        Ok(serde_json::json!({
            "kind": p.kind, "result": parsed, "added": added,
            "stderr": stderr.lines().take(20).collect::<Vec<_>>(),
        }))
    }

    /// Install a plugin from a folder or a package file into the first plugin directory.
    pub fn install(&self, src: &Path) -> Result<PluginInfo, String> {
        // Installed plugins go in the state directory (the last one): the other folders are
        // development locations you point at with --plugins, and we do not write into them.
        let dest_dir = self.dirs.last().cloned().ok_or("no plugin directory is configured")?;
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = if src.is_dir() {
            let name = src.file_name().ok_or("bad source path")?.to_string_lossy().to_string();
            let d = dest_dir.join(name);
            copy_dir(src, &d)?;
            d
        } else {
            unpack_package(src, &dest_dir)?
        };
        self.reload();
        let id = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        self.get(&id)
            .or_else(|| read_plugin(&dest))
            .ok_or_else(|| "the installed folder has no manifest GeoSpaX recognises".to_string())
    }

    /// Remove an installed plugin. Only plugins that live in the state directory can be
    /// removed: the other folders are development locations you point at with --plugins,
    /// and deleting someone's working copy because an id matched would be rude.
    pub fn uninstall(&self, id: &str) -> Result<String, String> {
        let dest_dir = self.dirs.last().cloned().ok_or("no plugin directory is configured")?;
        let info = self.get(id).ok_or_else(|| format!("unknown plugin '{id}'"))?;
        let path = std::path::PathBuf::from(&info.path);
        // canonicalise both so a symlinked state dir still compares equal
        let inside = path
            .canonicalize()
            .ok()
            .zip(dest_dir.canonicalize().ok())
            .map(|(p, d)| p.starts_with(&d))
            .unwrap_or(false);
        if !inside {
            return Err(format!(
                "'{}' lives in {} — only plugins installed into {} can be uninstalled (remove that folder yourself if you meant it)",
                info.name,
                path.display(),
                dest_dir.display()
            ));
        }
        fs::remove_dir_all(&path).map_err(|e| format!("could not remove {}: {e}", path.display()))?;
        self.reload();
        Ok(format!("uninstalled {} from {}", info.name, path.display()))
    }

    // ------------------------------------------------------------ manager (plugin_repos.rs)

    fn state_dir(&self) -> Result<PathBuf, String> {
        self.dirs.last().cloned().ok_or_else(|| "no plugin directory is configured".to_string())
    }

    /// The manager's settings: switched-off plugins, repositories, update checks.
    pub fn manager_config(&self) -> crate::plugin_repos::ManagerConfig {
        self.dirs.last().map(|d| crate::plugin_repos::load_config(d)).unwrap_or_default()
    }

    pub fn set_manager_config(&self, cfg: &crate::plugin_repos::ManagerConfig) -> Result<(), String> {
        crate::plugin_repos::save_config(&self.state_dir()?, cfg)
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        !self.manager_config().disabled.iter().any(|d| d == id)
    }

    /// The plugins whose tools and commands are offered: everything except those switched off.
    pub fn list_enabled(&self) -> Vec<PluginInfo> {
        let off = self.manager_config().disabled;
        self.list().into_iter().filter(|p| !off.contains(&p.id)).collect()
    }

    /// Switch a plugin on or off without removing it. The tool sets that are part of GeoSpaX stay on.
    pub fn set_enabled(&self, id: &str, on: bool) -> Result<(), String> {
        let info = self.get(id).ok_or_else(|| format!("unknown plugin '{id}'"))?;
        if !on && (info.builtin || info.library) {
            return Err(format!("{} is part of GeoSpaX and cannot be switched off", info.name));
        }
        let mut cfg = self.manager_config();
        cfg.disabled.retain(|d| d != id);
        if !on {
            cfg.disabled.push(id.to_string());
            cfg.disabled.sort();
        }
        self.set_manager_config(&cfg)
    }

    pub fn repo_index(&self) -> crate::plugin_repos::RepoIndex {
        self.dirs.last().map(|d| crate::plugin_repos::load_index(d)).unwrap_or_default()
    }

    pub fn refresh_repos(&self) -> Result<crate::plugin_repos::RepoIndex, String> {
        Ok(crate::plugin_repos::refresh(&self.state_dir()?, &self.manager_config()))
    }

    /// Install a package that arrives as bytes (an uploaded ZIP or a repository download),
    /// replacing an earlier copy of the same plugin in the state directory (upgrade, reinstall).
    pub fn install_bytes(&self, name: &str, bytes: &[u8]) -> Result<PluginInfo, String> {
        let dest_dir = self.state_dir()?;
        let tmp = dest_dir.parent().unwrap_or(&dest_dir).join("tmp").join(format!("pkg-{}", std::process::id()));
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let file = tmp.join(Path::new(name).file_name().ok_or("bad package name")?);
        fs::write(&file, bytes).map_err(|e| e.to_string())?;
        // unpack into a scratch plugin folder first: a broken package must not cost you the copy you have
        let scratch = tmp.join("unpacked");
        let _ = fs::remove_dir_all(&scratch);
        let unpacked = unpack_package(&file, &scratch);
        let _ = fs::remove_file(&file);
        let unpacked = unpacked?;
        let res = (|| {
            let info = read_plugin(&unpacked).ok_or("the package has no manifest GeoSpaX recognises")?;
            if self.get(&info.id).is_some_and(|p| p.builtin || p.default_set) {
                return Err(format!("{} ships with GeoSpaX and is updated with it", info.name));
            }
            let dest = dest_dir.join(unpacked.file_name().ok_or("bad package")?);
            let backup = tmp.join("previous");
            let _ = fs::remove_dir_all(&backup);
            fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
            if dest.exists() {
                fs::rename(&dest, &backup).map_err(|e| e.to_string())?;
            }
            if let Err(e) = copy_dir(&unpacked, &dest) {
                let _ = fs::remove_dir_all(&dest);
                let _ = fs::rename(&backup, &dest);
                return Err(e);
            }
            let _ = fs::remove_dir_all(&backup);
            self.reload();
            let id = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            self.get(&id).or_else(|| read_plugin(&dest)).ok_or_else(|| "the installed folder has no manifest GeoSpaX recognises".to_string())
        })();
        let _ = fs::remove_dir_all(&tmp);
        res
    }

    /// Install, upgrade or reinstall a plugin from the cached repository index.
    pub fn install_from_repo(&self, id: &str) -> Result<PluginInfo, String> {
        let entry = self
            .repo_index()
            .plugins
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no repository offers '{id}' (reload the repositories)"))?;
        let dest_dir = self.state_dir()?;
        let tmp = dest_dir.parent().unwrap_or(&dest_dir).join("tmp").join(format!("dl-{id}"));
        let bytes = crate::plugin_repos::fetch(&entry.download, &tmp)?;
        if let Some(want) = entry.sha256.as_deref() {
            let got = crate::plugin_repos::sha256_hex(&bytes);
            if !got.eq_ignore_ascii_case(want.trim()) {
                return Err(format!("{}: the download does not match its checksum (sha256 {got}, expected {want})", entry.name));
            }
        }
        let ext = Path::new(&entry.download).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "zip".into());
        self.install_bytes(&crate::plugin_repos::package_name(&entry.id, &entry.version, &ext), &bytes)
    }
}

/// Files a tool reports in `"outputs": [path, …]` join the map: GeoTIFFs as rasters, everything
/// GDAL opens as vector layers. Returns the new layer / raster ids.
fn add_outputs(engine: &std::sync::Arc<crate::Engine>, result: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    for path in result.get("outputs").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str()) {
        let path = Path::new(path);
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if path.to_string_lossy().ends_with(".grid.json") {
            match read_grid_to_tif(path) {
                Ok(tif) => {
                    let id = tif.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    if let Ok(h) = engine.register_raster(&tif, &id) {
                        ids.push(h.info.id.clone());
                    }
                }
                Err(e) => eprintln!("plugin output {}: {e}", path.display()),
            }
        } else if matches!(ext.as_str(), "tif" | "tiff") {
            let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if let Ok(h) = engine.register_raster(path, &id) {
                ids.push(h.info.id.clone());
            }
        } else if let Ok(handles) = crate::catalog::load_layers(path) {
            ids.extend(engine.register_layers(handles));
        }
    }
    ids
}

/// Re-register the results plugin tools wrote in earlier sessions (`<state>/plugin-results/<plugin>/`):
/// without this a restart drops them from Contents although the files are still there.
pub fn restore_results(engine: &std::sync::Arc<crate::Engine>) {
    let Ok(dirs) = fs::read_dir(engine.state_dir.join("plugin-results")) else { return };
    let mut n = 0;
    for dir in dirs.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let Ok(files) = fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = files.flatten().map(|e| e.path()).collect();
        files.sort();
        for f in files {
            let name = f.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            // a .grid.json was already written out as the .tif beside it; the rest are sidecars
            let keep = [".tif", ".tiff", ".geojson", ".gpkg", ".json", ".csv", ".fgb", ".shp"].iter().any(|x| name.ends_with(x))
                && ![".grid.json", ".gsx.json", ".aux.xml", ".part.tif", ".part.gpkg"].iter().any(|x| name.ends_with(x));
            if keep {
                n += add_outputs(engine, &serde_json::json!({ "outputs": [f.to_string_lossy()] })).len();
            }
        }
    }
    if n > 0 {
        eprintln!("plugins: restored {n} results from earlier runs");
    }
}

/// Write raster `r` as a float32 grid at `stem` (+ .grid.json, .f32). The first raster of a run sets
/// the grid (its own, at most 1,500 cells a side); later ones are warped onto it.
fn write_grid(r: &crate::raster::RasterHandle, template: &mut Option<(usize, usize, [f64; 6], String)>, stem: &Path) -> Result<PathBuf, String> {
    use crate::raster;
    let src = raster::open(&r.info.path)?;
    let ds = match template.as_ref() {
        None => {
            let (w, h) = src.raster_size();
            let k = (w.max(h) as f64 / 1500.0).max(1.0);
            let ds = if k > 1.0 {
                raster::translate(&src, "", &raster::strings(&["-of", "MEM", "-r", "average", "-ot", "Float32", "-outsize", &((w as f64 / k).round() as usize).to_string(), &((h as f64 / k).round() as usize).to_string()]))?
            } else {
                raster::translate(&src, "", &raster::strings(&["-of", "MEM", "-ot", "Float32"]))?
            };
            let (w, h) = ds.raster_size();
            *template = Some((w, h, ds.geo_transform().map_err(|e| e.to_string())?, ds.projection()));
            ds
        }
        Some((w, h, gt, wkt)) => {
            let (minx, maxy) = (gt[0], gt[3]);
            let (maxx, miny) = (gt[0] + gt[1] * *w as f64, gt[3] + gt[5] * *h as f64);
            let mut a = raster::strings(&["-of", "MEM", "-ot", "Float32", "-r", "bilinear", "-dstnodata", "nan"]);
            a.extend(["-te".into(), minx.to_string(), miny.to_string(), maxx.to_string(), maxy.to_string(), "-ts".into(), w.to_string(), h.to_string()]);
            if !wkt.is_empty() {
                a.extend(["-t_srs".into(), wkt.clone()]);
            }
            raster::warp(&[&src], "", &a)?
        }
    };
    let (w, h) = ds.raster_size();
    let bands = ds.raster_count();
    let mut bytes: Vec<u8> = Vec::with_capacity(w * h * bands * 4);
    let mut names = Vec::new();
    for b in 1..=bands {
        let band = ds.rasterband(b).map_err(|e| e.to_string())?;
        let nd = band.no_data_value();
        let (vals, _, _) = raster::read_full(&ds, b)?;
        for v in vals {
            let v = if nd.is_some_and(|n| (v as f64 - n).abs() < 1e-9) || !v.is_finite() { f32::NAN } else { v };
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        names.push(gdal::Metadata::description(&band).ok().filter(|d| !d.is_empty()).unwrap_or_else(|| format!("band {b}")));
    }
    let data = stem.with_extension("f32");
    fs::write(&data, bytes).map_err(|e| format!("{}: {e}", data.display()))?;
    let header = PathBuf::from(format!("{}.grid.json", stem.display()));
    let meta = serde_json::json!({
        "id": r.info.id, "title": r.info.title, "kind": r.info.kind, "units": r.info.units,
        "width": w, "height": h, "bands": bands, "band_names": names,
        "transform": ds.geo_transform().map_err(|e| e.to_string())?, "crs": ds.projection(),
        "geographic": r.info.geographic, "pixel_m": r.info.pixel_m,
        "data": data, "dtype": "float32", "nodata": "NaN",
    });
    fs::write(&header, meta.to_string()).map_err(|e| format!("{}: {e}", header.display()))?;
    Ok(header)
}

/// A grid a tool wrote (`<name>.grid.json` + float32 data, band 1) as a GeoTIFF beside it, with the
/// header's title, kind, units and classes as the raster's sidecar.
fn read_grid_to_tif(header: &Path) -> Result<PathBuf, String> {
    let meta: serde_json::Value = serde_json::from_slice(&fs::read(header).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", header.display()))?;
    let w = meta["width"].as_u64().ok_or("width is missing")? as usize;
    let h = meta["height"].as_u64().ok_or("height is missing")? as usize;
    let gt: Vec<f64> = meta["transform"].as_array().ok_or("transform is missing")?.iter().filter_map(|v| v.as_f64()).collect();
    if gt.len() != 6 {
        return Err("transform must have 6 numbers".into());
    }
    let data_path = meta["data"].as_str().map(PathBuf::from).unwrap_or_else(|| header.with_file_name(header.file_name().unwrap().to_string_lossy().replace(".grid.json", ".f32")));
    let data_path = if data_path.is_relative() { header.parent().unwrap_or(Path::new(".")).join(data_path) } else { data_path };
    let bytes = fs::read(&data_path).map_err(|e| format!("{}: {e}", data_path.display()))?;
    if bytes.len() < w * h * 4 {
        return Err(format!("{} has {} bytes, the header says {w}×{h} float32", data_path.display(), bytes.len()));
    }
    let vals: Vec<f32> = bytes[..w * h * 4].as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let name = header.file_name().unwrap().to_string_lossy().replace(".grid.json", "");
    let tif = header.with_file_name(format!("{name}.tif"));
    crate::raster::write_tif_f32(&tif, w, h, [gt[0], gt[1], gt[2], gt[3], gt[4], gt[5]], meta["crs"].as_str().unwrap_or(""), vals, Some(f32::NAN as f64))?;
    let mut side = serde_json::Map::new();
    for k in ["title", "kind", "units", "description", "classes", "credit"] {
        if let Some(v) = meta.get(k).filter(|v| !v.is_null()) {
            side.insert(k.to_string(), v.clone());
        }
    }
    if !side.is_empty() {
        crate::raster::write_sidecar(&tif, &serde_json::Value::Object(side))?;
    }
    Ok(tif)
}

fn workdir() -> PathBuf {
    std::env::temp_dir().join("geospax-plugin-work")
}

fn first_line(s: &str) -> Option<String> {
    s.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string())
}

fn run_qgis(p: &PluginInfo, tool: &ToolSpec, params: &serde_json::Map<String, serde_json::Value>) -> Result<serde_json::Value, String> {
    let bin = which("qgis_process").ok_or("qgis_process is not on PATH")?;
    let mut cmd = Command::new(bin);
    cmd.arg("run").arg(&tool.id).arg("--json").env("QT_QPA_PLATFORM", "offscreen");
    for (k, v) in params {
        cmd.arg(format!("--{}={}", k.to_uppercase(), value_as_text(v)));
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|_| serde_json::json!(stdout.trim()));
    Ok(serde_json::json!({ "kind": "qgis", "plugin": p.id, "tool": tool.id, "result": parsed }))
}

fn run_arcgis(p: &PluginInfo, tool: &ToolSpec, params: &serde_json::Map<String, serde_json::Value>) -> Result<serde_json::Value, String> {
    let py = which("python3").or_else(|| which("python")).ok_or("python3 is not on PATH")?;
    // arcpy is the only thing that can execute a .pyt; we call the tool class directly.
    let script = format!(
        "import arcpy, json, sys\n\
         params = json.loads(sys.argv[1])\n\
         arcpy.ImportToolbox({toolbox:?})\n\
         res = getattr(arcpy, {tool_id:?})(**params)\n\
         print(json.dumps({{'ok': True, 'result': str(res)}}))\n",
        toolbox = format!("{}/Toolboxes", p.path),
        tool_id = tool.id
    );
    let out = Command::new(py)
        .args(["-c", &script, &serde_json::to_string(params).unwrap_or_default()])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(first_line(&String::from_utf8_lossy(&out.stderr)).unwrap_or("arcpy failed".to_string()));
    }
    let parsed: serde_json::Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim()).unwrap_or_default();
    Ok(serde_json::json!({ "kind": "arcgis", "plugin": p.id, "tool": tool.id, "result": parsed }))
}

fn value_as_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn wait_with_timeout(child: &mut std::process::Child, limit: Duration) -> Result<std::process::Output, String> {
    // `Child::wait_timeout` would need a crate; poll instead — plugin tools are short.
    let start = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let out = child.stdout.take().map(read_all).unwrap_or_default();
            let err = child.stderr.take().map(read_all_stderr).unwrap_or_default();
            return Ok(std::process::Output { status, stdout: out, stderr: err });
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            return Err("plugin tool timed out after 10 minutes".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn read_all(mut r: std::process::ChildStdout) -> Vec<u8> {
    use std::io::Read;
    let mut v = Vec::new();
    let _ = r.read_to_end(&mut v);
    v
}

fn read_all_stderr(mut r: std::process::ChildStderr) -> Vec<u8> {
    use std::io::Read;
    let mut v = Vec::new();
    let _ = r.read_to_end(&mut v);
    v
}

// ---------------------------------------------------------------- install helpers

fn unpack_package(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("not a zip package: {e}"))?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "plugin".to_string());
    // drop a trailing version: my-plugin-1.2.3.rgplugin -> my-plugin
    let id = stem
        .rsplit_once('-')
        .filter(|(a, _)| !a.is_empty())
        .map(|(a, _)| a.to_string())
        .unwrap_or(stem);
    let dest = dest_dir.join(&id);
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.size() > 64 << 20 {
            return Err("package member is larger than 64 MB".to_string());
        }
        let fname = f.name().map_err(|e| e.to_string())?.to_string();
        let rel = safe_join(&dest, &fname)?;
        if fname.ends_with('/') {
            fs::create_dir_all(&rel).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = rel.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&rel).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        set_executable(&rel, f.unix_mode());
    }
    Ok(dest)
}

/// Reject `../` and absolute paths inside a package (RustGIS validates the same way).
fn safe_join(root: &Path, name: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for part in Path::new(name).components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir => return Err(format!("package member '{name}' escapes the plugin folder")),
            Component::RootDir | Component::Prefix(_) => return Err(format!("package member '{name}' is absolute")),
        }
    }
    Ok(out)
}

#[cfg(unix)]
fn set_executable(path: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(m) = mode {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(m & 0o777));
    }
}

#[cfg(not(unix))]
fn set_executable(_path: &Path, _mode: Option<u32>) {}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let to = dest.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Shown next to a plugin that is installed but whose runtime is missing.
pub fn runtime_hint(info: &PluginInfo) -> Option<String> {
    match (info.runnable, info.needs.as_deref()) {
        (false, Some(n)) => Some(format!("needs {n}")),
        _ => None,
    }
}

/// The `Plugins` tab of the ribbon is built from this (web/src/plugins.ts mirrors it).
pub fn to_json(list: &[PluginInfo]) -> serde_json::Value {
    serde_json::json!({ "plugins": list })
}

/// Sanity check used by `geospax plugins check`: a manifest is valid and its tools have ids.
pub fn check(path: &Path) -> Result<String, String> {
    let info = read_plugin(path).ok_or("no manifest GeoSpaX recognises (plugin.yaml, plugin.json, metadata.txt, Config.daml)")?;
    if let Some(w) = &info.warning {
        return Err(format!("{} — {}", info.name, w));
    }
    Ok(format!(
        "{} {} · {} · {} tool(s), {} command(s) · {}",
        info.name,
        info.version.as_deref().unwrap_or("?"),
        info.source,
        info.tools.len(),
        info.commands.len(),
        if info.runnable {
            "runnable".to_string()
        } else {
            info.needs.clone().unwrap_or_default()
        }
    ))
}

/// Where recipes can be found for `kind: recipe` plugins (docs/PLUGINS.md §4).
pub fn recipe_dirs(list: &[PluginInfo]) -> Vec<PathBuf> {
    list.iter()
        .filter(|p| p.kind == "recipe")
        .map(|p| PathBuf::from(&p.path))
        .collect()
}

// silence unused warnings for helpers kept for the CLI
#[allow(dead_code)]
fn _unused(a: &automation::Automation) -> usize {
    a.recipes().len()
}
