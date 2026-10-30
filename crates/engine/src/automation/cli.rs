//! Command line (docs/AUTOMATION.md §9), shared by `geospax-server` and the desktop `geospax`:
//!
//!   geospax run <recipe.yaml | recipe-id> [--input key=value]... [--data DIR]... [--state-dir DIR] [--json]
//!   geospax check <recipe.yaml | recipe-id>
//!   geospax watch [--only id,id] [--watch DIR]... [--data DIR]...   (triggers on, no UI)
//!   geospax recipes
//!   geospax steps

use super::recipe::{Origin, Recipe};
use super::{Automation, AutomationConfig, StepRecord};
use crate::devices::DevicesConfig;
use crate::{Engine, EngineConfig};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const COMMANDS: &[&str] = &["run", "check", "watch", "recipes", "steps"];

const USAGE: &str = "usage:
  geospax run <recipe.yaml | id> [--input key=value]... [--data DIR]... [--state-dir DIR] [--watch DIR]... [--json] [--quiet]
  geospax check <recipe.yaml | id>
  geospax watch [--only id,id] [--data DIR]... [--state-dir DIR] [--watch DIR]... [--recipes DIR]...
  geospax recipes [--state-dir DIR]
  geospax steps";

/// If `args[0]` is an automation command, run it and return the exit code.
/// The recipe command line's usage text (`--help` of both binaries).
pub fn usage() -> &'static str {
    USAGE
}

pub fn main_if_subcommand(args: &[String]) -> Option<i32> {
    let cmd = args.first()?.as_str();
    if !COMMANDS.contains(&cmd) {
        return None;
    }
    Some(match real_main(cmd, &args[1..]) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}\n{USAGE}");
            2
        }
    })
}

#[derive(Default)]
struct Opts {
    data: Vec<PathBuf>,
    state: Option<PathBuf>,
    watch: Vec<PathBuf>,
    gps: Vec<String>,
    inputs: Map<String, Value>,
    recipe_dirs: Vec<PathBuf>,
    only: Vec<String>,
    json: bool,
    quiet: bool,
    mounts: bool,
    positional: Vec<String>,
}

fn parse(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts {
        mounts: true,
        ..Default::default()
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("missing value for {a}"))
        };
        match a.as_str() {
            "--data" => o.data.push(val()?.into()),
            "--state-dir" => o.state = Some(val()?.into()),
            "--watch" => o.watch.push(val()?.into()),
            "--gps" => o.gps.push(val()?),
            "--recipes" => o.recipe_dirs.push(val()?.into()),
            "--only" => o.only.extend(
                val()?
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            ),
            "--input" | "-i" => {
                let kv = val()?;
                let (k, v) = kv
                    .split_once('=')
                    .ok_or_else(|| format!("--input expects key=value, got '{kv}'"))?;
                // numbers and booleans keep their type; everything else is text
                let v = serde_json::from_str::<Value>(v)
                    .ok()
                    .filter(|x| x.is_number() || x.is_boolean())
                    .unwrap_or_else(|| Value::from(v));
                o.inputs.insert(k.trim().to_string(), v);
            }
            "--json" => o.json = true,
            "--quiet" | "-q" => o.quiet = true,
            "--no-device-mounts" => o.mounts = false,
            "-h" | "--help" => return Err("help".into()),
            s if s.starts_with('-') => return Err(format!("unknown option {s}")),
            s => o.positional.push(s.to_string()),
        }
    }
    Ok(o)
}

fn engine_for(o: &Opts, triggers: bool) -> Result<Arc<Engine>, String> {
    let data = if o.data.is_empty() {
        if Path::new("data").exists() {
            vec![PathBuf::from("data")]
        } else {
            vec![]
        }
    } else {
        o.data.clone()
    };
    let auto = if triggers {
        if o.only.is_empty() {
            vec!["all".to_string()]
        } else {
            o.only.clone()
        }
    } else {
        vec![]
    };
    let cfg = EngineConfig {
        data,
        state_dir: o.state.clone(),
        devices: DevicesConfig {
            watch: o.watch.clone(),
            gps: o.gps.clone(),
            scan_mounts: o.mounts,
            auto_import: false,
            sta: Vec::new(),
            mqtt: Vec::new(),
            inbox: Vec::new(),
        },
        automation: AutomationConfig {
            recipe_dirs: o.recipe_dirs.clone(),
            auto,
            triggers,
        },
        ..Default::default()
    };
    Engine::open(cfg).map(Arc::new)
}

/// A recipe file path or the id of an installed recipe.
fn load_recipe(engine: &Engine, spec: &str) -> Result<Arc<Recipe>, String> {
    let p = Path::new(spec);
    if p.is_file() {
        let text = std::fs::read_to_string(p).map_err(|e| format!("{spec}: {e}"))?;
        return match engine
            .automation
            .validate(&text, Origin::File(p.to_path_buf()))
        {
            Ok((r, warns)) => {
                for w in warns {
                    eprintln!("warning: {w}");
                }
                Ok(engine.automation.add(r))
            }
            Err(errs) => Err(format!(
                "{spec} is not a valid recipe:\n  - {}",
                errs.join("\n  - ")
            )),
        };
    }
    engine.automation.recipe(spec).ok_or_else(|| {
        let ids: Vec<String> = engine
            .automation
            .recipes()
            .iter()
            .map(|r| r.id.clone())
            .collect();
        format!(
            "no recipe file or installed recipe '{spec}' (installed: {})",
            ids.join(", ")
        )
    })
}

fn secs(ms: f64) -> String {
    if ms >= 1000.0 {
        format!("{:.2} s", ms / 1000.0)
    } else {
        format!("{ms:.0} ms")
    }
}

fn real_main(cmd: &str, args: &[String]) -> Result<i32, String> {
    let o = parse(args)?;
    match cmd {
        "steps" => {
            for s in super::steps::CATALOGUE {
                println!("{:<24} {:<14} {}", s.name, s.family, s.summary);
            }
            Ok(0)
        }
        "recipes" => {
            let a = Automation::new(
                AutomationConfig {
                    recipe_dirs: o.recipe_dirs.clone(),
                    ..Default::default()
                },
                &state_dir(&o),
            );
            for r in a.recipes() {
                let t: Vec<String> = r.triggers.iter().map(|t| t.describe()).collect();
                println!(
                    "{:<24} {:<8} {}{}",
                    r.id,
                    r.origin.as_str(),
                    r.title,
                    if t.is_empty() {
                        String::new()
                    } else {
                        format!("  [{}]", t.join("; "))
                    }
                );
            }
            Ok(0)
        }
        "check" => {
            let spec = o
                .positional
                .first()
                .ok_or("check needs a recipe file or id")?;
            let a = Automation::new(
                AutomationConfig {
                    recipe_dirs: o.recipe_dirs.clone(),
                    ..Default::default()
                },
                &state_dir(&o),
            );
            let text = if Path::new(spec).is_file() {
                std::fs::read_to_string(spec).map_err(|e| e.to_string())?
            } else {
                a.recipe(spec)
                    .map(|r| r.text.clone())
                    .ok_or_else(|| format!("no recipe file or installed recipe '{spec}'"))?
            };
            match a.validate(&text, Origin::File(PathBuf::from(spec))) {
                Ok((r, warns)) => {
                    if o.json {
                        println!(
                            "{}",
                            json!({ "ok": true, "recipe": r.summary_json(), "plan": Automation::plan(&r), "warnings": warns })
                        );
                        return Ok(0);
                    }
                    println!(
                        "✓ {} — {} ({} steps) is valid",
                        r.id,
                        r.title,
                        r.steps.len()
                    );
                    for t in &r.triggers {
                        println!("  trigger: {}", t.describe());
                    }
                    for i in &r.inputs {
                        println!(
                            "  input:   {} ({}){}",
                            i.name,
                            i.kind,
                            i.default
                                .as_ref()
                                .map(|d| format!(", default {d}"))
                                .unwrap_or_default()
                        );
                    }
                    println!("  plan:");
                    for (n, s) in Automation::plan(&r).iter().enumerate() {
                        let after: Vec<&str> = s["after"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect();
                        println!(
                            "    {}. {:<12} {:<22}{}",
                            n + 1,
                            s["id"].as_str().unwrap_or(""),
                            s["use"].as_str().unwrap_or(""),
                            if after.is_empty() {
                                String::new()
                            } else {
                                format!(" after {}", after.join(", "))
                            }
                        );
                    }
                    let net = r.network_steps();
                    println!(
                        "  permissions: reads devices and data; writes the state folder; code steps: {}; network: {}",
                        if r.has_code_steps() {
                            "yes (Python/R run as local processes)"
                        } else {
                            "none"
                        },
                        if net.is_empty() {
                            "none".to_string()
                        } else {
                            format!("downloads ({})", net.join(", "))
                        }
                    );
                    for w in warns {
                        println!("  warning: {w}");
                    }
                    Ok(0)
                }
                Err(errs) => {
                    if o.json {
                        println!("{}", json!({ "ok": false, "errors": errs }));
                    } else {
                        println!("✗ {spec} has {} problem(s):", errs.len());
                        for e in errs {
                            println!("  - {e}");
                        }
                    }
                    Ok(1)
                }
            }
        }
        "run" => {
            let spec = o
                .positional
                .first()
                .ok_or("run needs a recipe file or id")?
                .clone();
            let engine = engine_for(&o, false)?;
            engine.automation.restore_outputs(&engine);
            engine.devices.scan_now(&engine);
            let recipe = load_recipe(&engine, &spec)?;
            if !o.quiet && !o.json {
                println!("▶ {} — {}", recipe.id, recipe.title);
                if !o.inputs.is_empty() {
                    let kv: Vec<String> = o
                        .inputs
                        .iter()
                        .map(|(k, v)| format!("{k}={}", super::recipe::value_text(v)))
                        .collect();
                    println!("  inputs: {}", kv.join(" "));
                }
            }
            let quiet = o.quiet || o.json;
            let progress = move |r: &StepRecord, n: usize, total: usize| {
                if quiet {
                    return;
                }
                let mark = match r.status {
                    "done" => "✓",
                    "failed" => "✗",
                    _ => "·",
                };
                let detail = r.error.clone().unwrap_or_else(|| r.why.join(" | "));
                println!(
                    "  {mark} [{}/{total}] {} ({}) {} — {detail}",
                    n + 1,
                    r.id,
                    r.uses,
                    secs(r.ms)
                );
            };
            let trigger = json!({ "kind": "cli", "text": "command line" });
            let run = engine.automation.run_blocking(
                &engine,
                &recipe.id,
                o.inputs.clone(),
                trigger,
                &progress,
            )?;
            let v = run.json();
            if o.json {
                println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            } else if !o.quiet {
                let ok = v["status"] == "done";
                println!(
                    "{} {} in {} · run {}",
                    if ok { "✓ done" } else { "✗ failed" },
                    recipe.id,
                    secs(v["elapsed_ms"].as_f64().unwrap_or(0.0)),
                    run.id
                );
                if let Some(e) = v["error"].as_str() {
                    println!("  {e}");
                }
                println!("  folder: {}", run.dir.display());
                let files: Vec<&str> = v["artifacts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                if !files.is_empty() {
                    println!("  files:  {}", files.join("  "));
                }
            }
            Ok(if v["status"] == "done" { 0 } else { 1 })
        }
        "watch" => {
            let engine = engine_for(&o, true)?;
            engine.start_services();
            let on: Vec<String> = engine
                .automation
                .enabled_recipes()
                .iter()
                .map(|r| {
                    format!(
                        "{} ({})",
                        r.id,
                        r.triggers
                            .iter()
                            .map(|t| t.describe())
                            .collect::<Vec<_>>()
                            .join("; ")
                    )
                })
                .collect();
            println!("watching with {} recipe(s) on auto:", on.len());
            for r in &on {
                println!("  {r}");
            }
            println!("state: {} · Ctrl-C to stop", engine.state_dir.display());
            loop {
                std::thread::sleep(std::time::Duration::from_secs(3600));
            }
        }
        _ => Err(format!("unknown command {cmd}")),
    }
}

fn state_dir(o: &Opts) -> PathBuf {
    o.state.clone().unwrap_or_else(|| {
        let base = o
            .data
            .first()
            .cloned()
            .unwrap_or_else(|| PathBuf::from("data"));
        let dir = if base.is_dir() {
            base
        } else {
            base.parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        };
        dir.join(".geospax")
    })
}
