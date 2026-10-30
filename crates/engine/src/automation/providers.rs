//! External GIS engines as recipe steps (docs/AUTOMATION.md §4 "Providers"). GRASS runs headless in
//! a temporary project (`grass --tmp-project <file> --exec`), SAGA through `saga_cmd`. Inputs and
//! outputs move as GeoTIFF / GeoPackage files and come back as ordinary GeoSpaX rasters and layers —
//! categorical GRASS outputs keep GRASS's own class labels and colours in the legend.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::features;
use super::raster_steps::pick_raster;
use super::steps::{p_f64, p_str, sanitize, StepCtx, StepOut};
use crate::raster;

/// An executable from an env override, PATH, or the usual install folders.
pub fn find_tool(name: &str, env: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env) {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".bat", ".cmd", ""] } else { &[""] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/Applications/GRASS-8.4.app/Contents/MacOS", "C:\\OSGeo4W\\bin", "C:\\Program Files\\SAGA"].iter().map(PathBuf::from));
    if cfg!(windows) {
        // standalone installers: C:\\Program Files\\GRASS GIS 8.4, SAGA 9.x, QGIS 3.x (bin\\ inside)
        for var in ["ProgramFiles", "ProgramW6432"] {
            let Some(base) = std::env::var_os(var) else { continue };
            for e in std::fs::read_dir(base).into_iter().flatten().flatten() {
                let n = e.file_name().to_string_lossy().to_uppercase();
                if n.starts_with("GRASS") || n.starts_with("SAGA") || n.starts_with("QGIS") {
                    dirs.extend([e.path(), e.path().join("bin")]);
                }
            }
        }
    }
    for d in dirs {
        for e in exts {
            let c = d.join(format!("{name}{e}"));
            if c.is_file() {
                return Some(c);
            }
        }
        // Windows GRASS launchers are versioned: grass84.bat, grass85.bat
        if cfg!(windows) && name == "grass" {
            let mut versioned: Vec<PathBuf> = std::fs::read_dir(&d).into_iter().flatten().flatten().map(|e| e.path())
                .filter(|p| p.file_name().and_then(|f| f.to_str()).is_some_and(|f| f.to_lowercase().starts_with("grass8") && f.to_lowercase().ends_with(".bat")))
                .collect();
            versioned.sort();
            if let Some(newest) = versioned.pop() {
                return Some(newest);
            }
        }
    }
    None
}

pub fn version(exe: &Path, arg: &str) -> String {
    crate::command(exe)
        .arg(arg)
        .stdin(Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr))
        .and_then(|s| s.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string()))
        .unwrap_or_default()
}

/// Run a command with a timeout and the run's cancel flag; output goes to `<dir>/<log>`.
fn run_logged(cmd: &mut Command, dir: &Path, log: &str, timeout: Duration, cancel: &AtomicBool) -> Result<(String, f64), String> {
    let path = dir.join(log);
    let f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let f2 = f.try_clone().map_err(|e| e.to_string())?;
    cmd.current_dir(dir).stdin(Stdio::null()).stdout(f).stderr(f2);
    let t0 = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("could not start {:?}: {e}", cmd.get_program()))?;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if cancel.load(Ordering::Relaxed) || t0.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if cancel.load(Ordering::Relaxed) { "cancelled".into() } else { format!("timed out after {} s", timeout.as_secs()) });
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if !status.success() {
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        return Err(format!("exited with {}: {}", status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into()), lines[lines.len().saturating_sub(6)..].join(" | ")));
    }
    Ok((text, t0.elapsed().as_secs_f64()))
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// An input for an external tool: a raster file, or a vector layer exported to GeoPackage.
fn input_file(sc: &mut StepCtx, spec: &str, work: &Path, name: &str) -> Result<(bool, PathBuf), String> {
    if let Some(r) = sc.engine.raster(spec).or_else(|| sc.engine.raster(&format!("{}.{spec}", sc.recipe_id))) {
        return Ok((true, r.info.path.clone()));
    }
    if let Ok(l) = sc.layer(spec) {
        let fs = features::read_layer(sc.engine, &l, None, None, 2_000_000)?;
        let path = work.join(format!("in_{name}.gpkg"));
        features::write_features(&path, "GPKG", name, &fs)?;
        return Ok((false, path));
    }
    let p = sc.resolve_path(spec).ok_or(format!("input '{spec}' is not a raster, layer or file"))?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    Ok((raster::EXTENSIONS.contains(&ext.as_str()), p))
}

/// GRASS class labels (`r.category`) and colours (`r.colors.out`) for a categorical output.
fn grass_classes(cats: &str, colors: &str) -> Vec<Value> {
    let mut col: Vec<(f64, String)> = Vec::new();
    for l in colors.lines() {
        let mut it = l.split_whitespace();
        let (Some(v), Some(c)) = (it.next(), it.next()) else { continue };
        let (Ok(v), Some(rgb)) = (v.parse::<f64>(), Some(c.split(':').filter_map(|x| x.parse::<u8>().ok()).collect::<Vec<_>>())) else { continue };
        if rgb.len() == 3 {
            col.push((v, format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])));
        }
    }
    let pal = super::automap::ramp_colors("tableau", 12);
    cats.lines()
        .filter_map(|l| {
            let (v, label) = l.split_once('\t')?;
            let v: f64 = v.trim().parse().ok()?;
            let label = label.trim();
            let color = col.iter().find(|(cv, _)| (*cv - v).abs() < 1e-9).map(|(_, c)| c.clone()).unwrap_or_else(|| pal[(v as usize) % pal.len()].clone());
            Some(json!({ "value": v, "label": if label.is_empty() { format!("class {v}") } else { label.to_string() }, "color": color }))
        })
        .collect()
}

struct OutSpec {
    /// GRASS map name / SAGA parameter.
    key: String,
    /// GeoSpaX output name (file and id).
    name: String,
    raster: bool,
    title: Option<String>,
    kind: Option<String>,
    classes: bool,
}

fn out_specs(p: &Value) -> Result<Vec<OutSpec>, String> {
    let mut out = Vec::new();
    for (k, v) in p.get("outputs").and_then(Value::as_object).ok_or("list outputs: {name: raster | vector | {type, title, kind, classes}}")? {
        let ty = v.as_str().or_else(|| v["type"].as_str()).unwrap_or("raster");
        out.push(OutSpec {
            key: k.clone(),
            name: sanitize(v["name"].as_str().unwrap_or(k)),
            raster: ty != "vector",
            title: v["title"].as_str().map(str::to_string),
            kind: v["kind"].as_str().map(str::to_string),
            classes: ty == "classes" || v["classes"].as_bool().unwrap_or(false) || v["kind"] == "classes",
        });
    }
    if out.is_empty() {
        return Err("outputs: is empty".into());
    }
    Ok(out)
}

/// Copy a produced file into the recipe outputs and register it.
fn adopt(sc: &mut StepCtx, o: &OutSpec, produced: &Path, side: Value) -> Result<String, String> {
    let dir = sc.outputs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if o.raster {
        let dest = dir.join(format!("{}.tif", o.name));
        let ds = raster::open(produced)?;
        let float = ds.rasterband(1).map(|b| b.band_type().name().starts_with("Float")).unwrap_or(false);
        raster::save_gtiff(&ds, &dest, float)?;
        raster::write_sidecar(&dest, &side)?;
        let id = format!("{}.{}", sc.recipe_id, o.name);
        let h = sc.engine.register_raster(&dest, &id)?;
        sc.rasters.retain(|x| x != &id);
        sc.rasters.push(id.clone());
        sc.names.insert(id.clone(), h.info.title.clone());
        Ok(id)
    } else {
        let dest = dir.join(format!("{}.gpkg", o.name));
        std::fs::copy(produced, &dest).map_err(|e| e.to_string())?;
        let id = format!("{}.{}", sc.recipe_id, o.name);
        let mut handles = crate::catalog::load_layers(&dest)?;
        handles.truncate(1);
        for h in handles.iter_mut() {
            h.info.id = id.clone();
        }
        sc.engine.register_layers(handles);
        sc.touch(&id);
        sc.names.insert(id.clone(), o.title.clone().unwrap_or_else(|| super::steps::humanize(&o.name)));
        Ok(id)
    }
}

pub(super) fn grass(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let exe = find_tool("grass", "GEOSPAX_GRASS").ok_or("GRASS is not installed (Debian/Ubuntu: apt install grass-core · Windows: OSGeo4W · macOS: grass.osgeo.org), or set GEOSPAX_GRASS")?;
    let script = p_str(p, "script").ok_or("grass needs script: GRASS commands, one per line")?.to_string();
    let outs = out_specs(p)?;
    let work = sc.dir.join(format!("grass_{}", sanitize(&sc.step_id)));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let mut inputs: Vec<(String, bool, PathBuf)> = Vec::new();
    match p.get("inputs").and_then(Value::as_object) {
        Some(m) => {
            for (k, v) in m {
                let spec = v.as_str().ok_or(format!("inputs.{k} must be a raster/layer id or a path"))?;
                let (is_r, path) = input_file(sc, spec, &work, k)?;
                inputs.push((sanitize(k), is_r, path));
            }
        }
        None => {
            let dem = pick_raster(sc, None, &["dem"], &[])?;
            inputs.push(("dem".into(), true, dem.info.path.clone()));
        }
    }
    let mut sh = String::from("set -e\nexport GRASS_OVERWRITE=1\n");
    for (name, is_r, path) in &inputs {
        if *is_r {
            sh += &format!("r.import --quiet input={} output={name}\n", sh_quote(&path.to_string_lossy()));
        } else {
            sh += &format!("v.import --quiet input={} output={name}\n", sh_quote(&path.to_string_lossy()));
        }
    }
    if let Some((first, _, _)) = inputs.iter().find(|i| i.1) {
        sh += &format!("g.region raster={first}\n");
    }
    sh += "# ---- recipe script ----\n";
    sh += &script;
    sh += "\n# ---- exports ----\n";
    for o in &outs {
        let f = work.join(&o.name);
        if o.raster {
            sh += &format!("r.out.gdal --quiet -c -m input={n} output={} format=GTiff createopt=COMPRESS=DEFLATE\n", sh_quote(&format!("{}.tif", f.display())), n = o.key);
            if o.classes {
                sh += &format!("r.category map={n} > {}\nr.colors.out map={n} rules={}\n", sh_quote(&format!("{}.cats", f.display())), sh_quote(&format!("{}.colors", f.display())), n = o.key);
            }
        } else {
            sh += &format!("v.out.ogr --quiet input={n} output={} format=GPKG\n", sh_quote(&format!("{}.gpkg", f.display())), n = o.key);
        }
    }
    let job = work.join("job.sh");
    std::fs::write(&job, &sh).map_err(|e| e.to_string())?;
    let project = match inputs.iter().find(|i| i.1) {
        Some((_, _, path)) => path.to_string_lossy().to_string(),
        None => {
            let b = sc.aoi.or(sc.extent).unwrap_or([0.0, 0.0, 0.0, 0.0]);
            format!("EPSG:{}", features::utm_epsg((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0))
        }
    };
    let timeout = Duration::from_secs(p_f64(p, "timeout").unwrap_or(900.0) as u64);
    let ver = version(&exe, "--version");
    let mut cmd = crate::command(&exe);
    cmd.args(["--tmp-project", &project, "--exec", "bash", &job.to_string_lossy()]).env("GRASS_VERBOSE", "0");
    let (log, secs) = match run_logged(&mut cmd, &work, "grass.log", timeout, sc.cancel) {
        Ok(r) => r,
        Err(e) if e.contains("tmp-project") || e.contains("unrecognized") => {
            let mut c2 = crate::command(&exe);
            c2.args(["--tmp-location", &project, "--exec", "bash", &job.to_string_lossy()]);
            run_logged(&mut c2, &work, "grass.log", timeout, sc.cancel).map_err(|e| format!("GRASS {e}"))?
        }
        Err(e) => return Err(format!("GRASS {e} (script and log in {})", work.display())),
    };
    let mut made = Map::new();
    let mut why = vec![format!("{ver}: {} input(s) imported, {} script line(s), {} output(s), {secs:.1} s", inputs.len(), script.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')).count(), outs.len())];
    for o in &outs {
        let f = work.join(&o.name);
        let produced = if o.raster { f.with_extension("tif") } else { f.with_extension("gpkg") };
        if !produced.exists() {
            return Err(format!("GRASS did not produce '{}' (see {})", o.name, work.join("grass.log").display()));
        }
        let mut side = json!({ "title": o.title.clone().unwrap_or_else(|| super::steps::humanize(&o.name)), "description": format!("made with {ver}") });
        if let Some(k) = &o.kind {
            side["kind"] = json!(k);
        }
        if o.classes {
            let cats = std::fs::read_to_string(f.with_extension("cats")).unwrap_or_default();
            let cols = std::fs::read_to_string(f.with_extension("colors")).unwrap_or_default();
            let mut classes = grass_classes(&cats, &cols);
            if let Ok(ds) = raster::open(&f.with_extension("tif"))
                && let Ok((v, _, _)) = raster::read_full(&ds, 1) {
                    let nd = ds.rasterband(1).ok().and_then(|b| b.no_data_value());
                    let valid: Vec<f32> = v.into_iter().filter(|x| x.is_finite() && nd.is_none_or(|n| (*x as f64 - n).abs() > 1e-6)).collect();
                    let tot = valid.len().max(1) as f64;
                    for c in classes.iter_mut() {
                        let cv = c["value"].as_f64().unwrap_or(-1.0);
                        let share = valid.iter().filter(|x| (**x as f64 - cv).abs() < 1e-6).count() as f64 / tot * 100.0;
                        c["share"] = json!((share * 10.0).round() / 10.0);
                        if share >= 0.5 {
                            c["label"] = json!(format!("{} · {share:.0} %", c["label"].as_str().unwrap_or("")));
                        }
                    }
                    classes.retain(|c| c["share"].as_f64().unwrap_or(0.0) > 0.0);
                }
            if !classes.is_empty() {
                why.push(format!("{}: {} classes with GRASS's own labels and colours ({})", o.name, classes.len(), classes.iter().take(4).filter_map(|c| c["label"].as_str()).collect::<Vec<_>>().join(", ")));
                side["kind"] = json!("classes");
                side["classes"] = json!(classes);
            }
        }
        let id = adopt(sc, o, &produced, side)?;
        made.insert(o.name.clone(), json!(id));
    }
    let _ = log;
    sc.methods.push(format!("{ver} ran in a temporary project: {}.", script.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(|l| l.split_whitespace().next().unwrap_or("")).collect::<Vec<_>>().join(", ")));
    Ok(StepOut { outputs: json!({ "outputs": made, "log": work.join("grass.log"), "seconds": secs, "version": ver }), why })
}

pub(super) fn saga(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let exe = find_tool("saga_cmd", "GEOSPAX_SAGA").ok_or("SAGA is not installed (Debian/Ubuntu: apt install saga · Windows/macOS: saga-gis.sourceforge.io), or set GEOSPAX_SAGA")?;
    let tool = p_str(p, "tool").ok_or("saga needs tool: '<library> <tool id>', e.g. 'ta_hydrology 15'")?.to_string();
    let outs = out_specs(p)?;
    let work = sc.dir.join(format!("saga_{}", sanitize(&sc.step_id)));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let mut args: Vec<String> = tool.split_whitespace().map(str::to_string).collect();
    match p.get("inputs").and_then(Value::as_object) {
        Some(m) => {
            for (k, v) in m {
                let spec = v.as_str().ok_or(format!("inputs.{k} must be a raster/layer id or a path"))?;
                let (_, path) = input_file(sc, spec, &work, &k.to_ascii_lowercase())?;
                args.push(format!("-{k}"));
                args.push(path.to_string_lossy().to_string());
            }
        }
        None => {
            let dem = pick_raster(sc, None, &["dem"], &[])?;
            args.push("-ELEVATION".into());
            args.push(dem.info.path.to_string_lossy().to_string());
        }
    }
    for (k, v) in p.get("options").and_then(Value::as_object).into_iter().flatten() {
        args.push(format!("-{k}"));
        args.push(match v {
            Value::Bool(b) => (if *b { "1" } else { "0" }).to_string(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        });
    }
    for o in &outs {
        args.push(format!("-{}", o.key));
        args.push(work.join(format!("{}.sdat", o.name)).to_string_lossy().to_string());
    }
    let ver = version(&exe, "--version");
    let timeout = Duration::from_secs(p_f64(p, "timeout").unwrap_or(900.0) as u64);
    let mut cmd = crate::command(&exe);
    cmd.args(&args);
    let (_log, secs) = run_logged(&mut cmd, &work, "saga.log", timeout, sc.cancel).map_err(|e| format!("SAGA {tool} {e}"))?;
    let mut made = Map::new();
    let mut why = vec![format!("{ver}: saga_cmd {tool} ({secs:.1} s)")];
    for o in &outs {
        let base = work.join(&o.name);
        let produced = [base.with_extension("sdat"), base.with_extension("tif"), base.with_extension("sgrd")].into_iter().find(|f| f.exists()).ok_or(format!("SAGA did not produce '{}' (see {})", o.name, work.join("saga.log").display()))?;
        let mut side = json!({ "title": o.title.clone().unwrap_or_else(|| super::steps::humanize(&o.name)), "description": format!("made with {ver}, tool {tool}") });
        if let Some(k) = &o.kind {
            side["kind"] = json!(k);
        }
        let id = adopt(sc, o, &produced, side)?;
        if let Some(r) = sc.engine.raster(&id) {
            let s = &r.info.stats[0];
            why.push(format!("{}: {:.2}–{:.2} (mean {:.2})", o.name, s.min, s.max, s.mean));
        }
        made.insert(o.name.clone(), json!(id));
    }
    sc.methods.push(format!("{ver} tool '{tool}' was run with saga_cmd."));
    Ok(StepOut { outputs: json!({ "outputs": made, "log": work.join("saga.log"), "seconds": secs, "version": ver }), why })
}

/// GRASS / SAGA / Whitebox availability for `geospax steps` and the API.
pub fn providers_json() -> Value {
    let one = |name: &str, env: &str, arg: &str| match find_tool(name, env) {
        Some(p) => json!({ "available": true, "path": p, "version": version(&p, arg) }),
        None => json!({ "available": false }),
    };
    json!({ "grass": one("grass", "GEOSPAX_GRASS", "--version"), "saga": one("saga_cmd", "GEOSPAX_SAGA", "--version"), "whitebox": one("whitebox_tools", "GEOSPAX_WHITEBOX", "--version") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grass_category_and_colour_parsing() {
        let cats = "1\tflat\n2\tsummit\n3\tridge\n";
        let cols = "1 220:220:220\n2 56:0:0\nnv 255:255:255\ndefault 255:255:255\n";
        let c = grass_classes(cats, cols);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0]["label"], "flat");
        assert_eq!(c[0]["color"], "#dcdcdc");
        assert_eq!(c[1]["color"], "#380000");
        assert!(c[2]["color"].as_str().unwrap().starts_with('#'));
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
    }
}
