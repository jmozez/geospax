//! `tool` step (docs/AUTOMATION.md): run any Toolbox tool (the built-in conservation, raster and
//! species tools, the 1,062 raster/vector/terrain tools, or a plugin's) inside a recipe. Its layers and
//! rasters become the step's outputs for later steps and the map; its result table and notes go into
//! the run log and the report's methods. This is how the domain kits chain tools.

use super::steps::{StepCtx, StepOut};
use serde_json::{json, Map, Value};

/// A recipe's own name for a layer or raster ("climate_bio1") → the engine id ("kit.climate_bio1").
fn resolve(sc: &StepCtx, v: &Value) -> Value {
    match v {
        Value::String(s) => {
            if sc.engine.layer(s).is_some() || sc.engine.raster(s).is_some() {
                return v.clone();
            }
            let full = format!("{}.{s}", sc.recipe_id);
            if sc.engine.layer(&full).is_some() || sc.engine.raster(&full).is_some() { Value::from(full) } else { v.clone() }
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve(sc, x)).collect()),
        _ => v.clone(),
    }
}

pub fn tool(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let spec = p.get("tool").and_then(Value::as_str).ok_or("tool: is required (plugin/tool, e.g. gsx/sdm)")?;
    let (plugin, tool) = spec.split_once('/').ok_or_else(|| format!("tool '{spec}': write it as plugin/tool, e.g. gsx/sdm"))?;
    let mut params = Map::new();
    for (k, v) in p.get("params").and_then(Value::as_object).cloned().unwrap_or_default() {
        params.insert(k, resolve(sc, &v));
    }
    let res = sc.engine.plugins.run_tool(sc.engine, plugin, tool, params)?;
    let r = &res["result"];
    let added: Vec<String> = res["added"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
    let (mut layers, mut rasters) = (Vec::new(), Vec::new());
    for id in &added {
        if sc.engine.layer(id).is_some() {
            sc.touch(id);
            layers.push(id.clone());
        } else if let Some(h) = sc.engine.raster(id) {
            sc.rasters.retain(|x| x != id);
            sc.rasters.push(id.clone());
            sc.names.insert(id.clone(), h.info.title.clone());
            rasters.push(id.clone());
        }
    }
    let message = r["message"].as_str().unwrap_or("").to_string();
    let table: Vec<(String, String)> = r["table"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| Some((row.get(0)?.as_str()?.to_string(), super::recipe::value_text(row.get(1)?))))
        .collect();
    let name = sc
        .engine
        .plugins
        .get(plugin)
        .and_then(|pl| pl.tools.iter().find(|t| t.id == tool).map(|t| t.name.clone()))
        .unwrap_or_else(|| spec.to_string());
    sc.methods.push(format!(
        "{name}: {message}{}",
        if table.is_empty() { String::new() } else { format!(" ({})", table.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("; ")) }
    ));
    for n in r["notes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        sc.methods.push(n.to_string());
    }
    if let Some((k, v)) = table.first() {
        sc.cards.push((v.clone(), k.clone()));
    }
    Ok(StepOut {
        outputs: json!({
            "layers": layers, "layer": layers.first(), "rasters": rasters, "raster": rasters.first(),
            "message": message, "table": table.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
        }),
        why: vec![format!("{name}: {message}")],
    })
}
