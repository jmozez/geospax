//! AutoMap: rules that turn a layer into a good-looking, explainable style without a human
//! (docs/AUTOMATION.md §4). Output is the same `LayerStyle` JSON the web UI edits
//! (web/src/symbology.ts), plus a plain-language "why" for each decision.

use super::features::FeatureSet;
use crate::catalog::{GeomKind, LayerHandle};
use crate::classify::{self, Method};
use crate::reader::ColumnValues;
use crate::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;

pub struct Ramp {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: &'static str,
    pub colors: &'static [&'static str],
}

/// Same ramps, same order as web/src/symbology.ts (colour-blind-safe sequential/diverging sets).
pub const RAMPS: &[Ramp] = &[
    Ramp { id: "viridis", name: "Viridis", kind: "sequential", colors: &["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"] },
    Ramp { id: "magma", name: "Magma", kind: "sequential", colors: &["#000004", "#51127c", "#b73779", "#fc8961", "#fcfdbf"] },
    Ramp { id: "ylorrd", name: "Yellow-Orange-Red", kind: "sequential", colors: &["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"] },
    Ramp { id: "blues", name: "Blues", kind: "sequential", colors: &["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"] },
    Ramp { id: "greens", name: "Greens", kind: "sequential", colors: &["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"] },
    Ramp { id: "rdylbu", name: "Red-Yellow-Blue", kind: "diverging", colors: &["#d7191c", "#fdae61", "#ffffbf", "#abd9e9", "#2c7bb6"] },
    Ramp { id: "tableau", name: "Tableau 10", kind: "categorical", colors: &["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"] },
    Ramp { id: "set2", name: "Pastel (Set2)", kind: "categorical", colors: &["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3"] },
    Ramp { id: "bold", name: "Bold", kind: "categorical", colors: &["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff"] },
];

pub const NULL_COLOR: &str = "#6b7785";
pub const OTHER_COLOR: &str = "#9aa5b1";
/// Device-hub layers keep the colours the web UI gives them.
const DEVICE_COLORS: [(&str, &str, &str); 3] = [
    ("photos", "#ff8c42", "photos from a device: one bold colour with a white ring so every photo stands out"),
    ("tracks", "#e040fb", "GPS tracks: one bright line colour over a white casing, readable on any background"),
    ("waypoints", "#40c4ff", "waypoints: a contrasting colour, labelled with their names"),
];
/// Single-colour palette (Tableau 10 minus greys): a stable pick per layer id, so two
/// single-colour layers on one map do not share a colour.
pub const SINGLE: [&str; 8] = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7"];

/// Two colours a reader could confuse (RGB distance).
pub fn similar(a: &str, b: &str) -> bool {
    let (x, y) = (hex2rgb(a), hex2rgb(b));
    ((x[0] - y[0]).powi(2) + (x[1] - y[1]).powi(2) + (x[2] - y[2]).powi(2)).sqrt() < 90.0
}

/// First palette colour not similar to any colour already on the map.
pub fn distinct_color(used: &[String]) -> &'static str {
    SINGLE.iter().copied().find(|c| !used.iter().any(|u| similar(u, c))).unwrap_or(SINGLE[0])
}

pub fn device_color(id: &str) -> Option<&'static str> {
    let role = device_role(id)?;
    DEVICE_COLORS.iter().find(|(r, _, _)| *r == role).map(|(_, c, _)| *c)
}

fn single_color(id: &str) -> &'static str {
    let h = id.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3));
    SINGLE[(h % SINGLE.len() as u64) as usize]
}

pub fn ramp(id: &str) -> &'static Ramp {
    RAMPS.iter().find(|r| r.id == id).unwrap_or(&RAMPS[0])
}

fn hex2rgb(h: &str) -> [f64; 3] {
    let v = u32::from_str_radix(h.trim_start_matches('#'), 16).unwrap_or(0);
    [((v >> 16) & 255) as f64, ((v >> 8) & 255) as f64, (v & 255) as f64]
}

/// n colours along a ramp (categorical ramps cycle), identical to `rampColors` in the web UI.
pub fn ramp_colors(id: &str, n: usize) -> Vec<String> {
    let r = ramp(id);
    if r.kind == "categorical" {
        return (0..n).map(|i| r.colors[i % r.colors.len()].to_string()).collect();
    }
    if n == 1 {
        return vec![r.colors[r.colors.len() / 2].to_string()];
    }
    (0..n)
        .map(|i| {
            let t = i as f64 / (n - 1) as f64 * (r.colors.len() - 1) as f64;
            let j = (t.floor() as usize).min(r.colors.len() - 2);
            let (a, b) = (hex2rgb(r.colors[j]), hex2rgb(r.colors[j + 1]));
            let f = t - j as f64;
            let c: Vec<String> = (0..3).map(|k| format!("{:02x}", (a[k] + (b[k] - a[k]) * f).round() as u8)).collect();
            format!("#{}", c.concat())
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct AutoStyle {
    pub layer: String,
    pub style: Value,
    pub why: String,
    pub field: Option<String>,
    pub label_field: Option<String>,
    pub confidence: f64,
}

pub fn device_role(id: &str) -> Option<&'static str> {
    let last = id.rsplit('.').next()?;
    DEVICE_COLORS.iter().find(|(r, _, _)| *r == last).map(|(r, _, _)| *r)
}

fn base_style(kind: GeomKind, symbology: Value) -> Value {
    json!({
        "visible": true,
        "opacity": if kind == GeomKind::Polygon { 0.8 } else { 1.0 },
        "minzoom": 0,
        "maxzoom": 24,
        "outline": kind == GeomKind::Polygon,
        "symbology": symbology,
    })
}

/// Dense polygon layers (grids, surfaces, many parcels) read better without outlines.
const OUTLINE_MAX_FEATURES: u64 = 400;

pub fn is_id_like(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "fid" | "id" | "gid" | "oid" | "objectid" | "ogc_fid" | "uuid" | "guid" | "path" | "source" | "device" | "make" | "model" | "x" | "y" | "lon" | "lat" | "longitude" | "latitude" | "shape_leng" | "shape_area")
        || n.ends_with("_id")
        || n.starts_with("id_")
        || n.ends_with("_uid")
}

const NUMERIC_HINTS: &[&str] = &["pop", "value", "count", "density", "rate", "total", "height", "elev", "alt", "area", "ndvi", "temp", "rain", "price", "income", "depth", "speed", "score", "index", "ph", "moist", "yield", "conc", "level", "prediction", "mean", "sum", "pm2", "pm10", "no2", "co2", "aqi", "noise", "heart", "humid", "lux", "pressure", "cpm"];
const CATEGORY_HINTS: &[&str] = &["type", "class", "kind", "category", "landuse", "land_use", "status", "zone", "group", "species", "use", "cover", "crop", "soil", "continent", "region"];

fn hint_bonus(name: &str, hints: &[&str]) -> f64 {
    let n = name.to_ascii_lowercase();
    if hints.iter().any(|h| n == *h || n.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == *h)) {
        1.0
    } else if hints.iter().any(|h| h.len() >= 3 && n.contains(h)) {
        0.6
    } else {
        0.0
    }
}

/// Field values for profiling: from features already in memory, else an Arrow column scan.
fn column(engine: &Engine, l: &LayerHandle, fs: Option<&FeatureSet>, fi: usize) -> Option<ColumnValues> {
    let name = &l.info.fields[fi].name;
    if let Some(fs) = fs {
        let k = fs.field(name)?;
        return Some(if matches!(l.info.fields[fi].kind, "integer" | "real") {
            ColumnValues::Num(fs.numbers(k))
        } else {
            ColumnValues::Str(fs.feats.iter().filter_map(|f| match &f.props[k] {
                super::features::Val::Null => None,
                v => Some(v.text()),
            }).collect())
        });
    }
    engine.scan_column(l, fi).ok()
}

enum Choice {
    Graduated(String, Vec<f64>),
    Unique(String, Vec<(String, u64, bool)>),
}

/// Pick a style for one layer. `hint` names the field to map (or "none" for a single colour).
pub fn style_layer(engine: &Engine, l: &LayerHandle, fs: Option<&FeatureSet>, hint: Option<&str>) -> AutoStyle {
    let mut st = style_layer_inner(engine, l, fs, hint);
    if l.info.geometry == GeomKind::Polygon && l.info.feature_count > OUTLINE_MAX_FEATURES {
        st.style["outline"] = json!(false);
    }
    // one to three areas (a coverage, an ellipse, a study area) sit over other data: see-through
    if l.info.geometry == GeomKind::Polygon && l.info.feature_count <= 3 {
        st.style["opacity"] = json!(0.35);
        st.why.push_str("; drawn see-through because it is a single area over other data");
    }
    st
}

fn style_layer_inner(engine: &Engine, l: &LayerHandle, fs: Option<&FeatureSet>, hint: Option<&str>) -> AutoStyle {
    let id = l.info.id.clone();
    let kind = l.info.geometry;
    let label_field = label_field(l);
    let single = |color: &str, why: String, confidence: f64| AutoStyle {
        layer: id.clone(),
        style: base_style(kind, json!({ "kind": "single", "color": color })),
        why,
        field: None,
        label_field: label_field.clone(),
        confidence,
    };
    if hint.is_none()
        && let Some((_, color, why)) = DEVICE_COLORS.iter().find(|(r, _, _)| Some(*r) == device_role(&id)) {
            return single(color, why.to_string(), 0.9);
        }
    // classes with a conventional palette (LISA: Anselin 1995, as GeoDa and ArcGIS Pro draw them)
    let hint = if hint.is_none() && l.info.fields.iter().any(|f| f.name == "lisa_cluster") { Some("lisa_cluster") } else { hint };
    let fallback = single_color(&id);
    if hint == Some("none") {
        return single(fallback, "single colour (requested)".into(), 0.9);
    }
    // candidate fields
    let mut best: Option<(f64, Choice)> = None;
    let mut considered = 0;
    for (fi, f) in l.info.fields.iter().enumerate() {
        let forced = hint.is_some_and(|h| h.eq_ignore_ascii_case(&f.name));
        if hint.is_some() && !forced {
            continue;
        }
        if !forced && (is_id_like(&f.name) || !matches!(f.kind, "integer" | "real" | "string") || considered >= 10) {
            continue;
        }
        considered += 1;
        let Some(col) = column(engine, l, fs, fi) else { continue };
        let (score, choice) = match col {
            ColumnValues::Num(mut v) => {
                v.retain(|x| x.is_finite());
                if v.len() < 2 {
                    continue;
                }
                let mut s = v.clone();
                s.sort_by(|a, b| a.partial_cmp(b).unwrap());
                s.dedup();
                if s.len() < 2 {
                    continue;
                }
                let cat_name = hint_bonus(&f.name, CATEGORY_HINTS);
                if s.len() <= 12 && f.kind == "integer" && cat_name > 0.0 {
                    let mut counts: HashMap<String, u64> = HashMap::new();
                    for x in &v {
                        *counts.entry(super::features::num_text(*x)).or_default() += 1;
                    }
                    let list = counts.into_iter().map(|(k, c)| (k, c, true)).collect();
                    (0.8 + cat_name, Choice::Unique(f.name.clone(), list))
                } else {
                    let lower = f.name.to_ascii_lowercase();
                    // population, and a stream network's order, are what such layers are mapped by
                    let bonus = hint_bonus(&f.name, NUMERIC_HINTS)
                        + if lower.contains("pop") { 0.4 } else { 0.0 }
                        + if lower.contains("strahler") || lower.contains("stream_order") || lower == "shreve" { 1.0 } else { 0.0 };
                    let rank_penalty = if f.name.to_ascii_lowercase().contains("rank") { -0.5 } else { 0.0 };
                    (1.0 + bonus + rank_penalty + if s.len() > 10 { 0.2 } else { 0.0 }, Choice::Graduated(f.name.clone(), v))
                }
            }
            ColumnValues::Str(v) => {
                let mut counts: HashMap<String, u64> = HashMap::new();
                for x in v.iter().filter(|x| !x.is_empty()) {
                    *counts.entry(x.clone()).or_default() += 1;
                }
                if counts.len() < 2 || (counts.len() > 12 && !forced) {
                    continue;
                }
                let list = counts.into_iter().map(|(k, c)| (k, c, false)).collect();
                (0.8 + hint_bonus(&f.name, CATEGORY_HINTS), Choice::Unique(f.name.clone(), list))
            }
        };
        if forced || best.as_ref().is_none_or(|(b, _)| score > *b) {
            best = Some((score, choice));
            if forced {
                break;
            }
        }
    }
    match best {
        None => single(
            fallback,
            if l.info.fields.is_empty() { "no attributes, so one clear colour".into() } else { "no attribute worth mapping (only ids, names or constants), so one clear colour".into() },
            0.5,
        ),
        Some((score, Choice::Graduated(field, v))) => {
            let (sym, why) = graduated(&field, v);
            AutoStyle { layer: id, style: base_style(kind, sym), why, field: Some(field), label_field, confidence: if score >= 1.6 { 0.85 } else { 0.65 } }
        }
        Some((score, Choice::Unique(field, list))) => {
            let (sym, why) = unique(&field, list);
            AutoStyle { layer: id, style: base_style(kind, sym), why, field: Some(field), label_field, confidence: if score >= 1.4 { 0.85 } else { 0.65 } }
        }
    }
}

pub fn skewness(v: &[f64]) -> f64 {
    let n = v.len() as f64;
    if n < 3.0 {
        return 0.0;
    }
    let mean = v.iter().sum::<f64>() / n;
    let m2 = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n;
    let m3 = v.iter().map(|x| (x - mean).powi(3)).sum::<f64>() / n;
    if m2 <= 0.0 { 0.0 } else { m3 / m2.powf(1.5) }
}

/// Particulate matter: the WHO 2021 24-hour guideline and interim targets (µg/m³), so classes
/// say something a reader can act on. (label, upper bounds, class names)
pub fn guideline_anchors(field: &str) -> Option<(&'static str, &'static [f64], &'static [&'static str])> {
    let f = field.to_ascii_lowercase();
    let is = |p: &str| f == p || f.starts_with(&format!("{p}_"));
    const NAMES: &[&str] = &["guideline met", "IT-4", "IT-3", "IT-2", "IT-1", "above IT-1"];
    if is("pm2_5") {
        Some(("PM2.5", &[15.0, 25.0, 37.5, 50.0, 75.0], NAMES))
    } else if is("pm10") {
        Some(("PM10", &[45.0, 50.0, 75.0, 100.0, 150.0], NAMES))
    } else {
        None
    }
}

/// Air-quality-index colours (green = within the guideline ... dark red = above all targets).
const AQ_COLORS: [&str; 6] = ["#1a9850", "#a6d96a", "#fee08b", "#fdae61", "#f46d43", "#a50026"];

/// Guideline classes for a sorted column: (breaks, colours, labels, counts).
pub fn guideline_classes(field: &str, sorted: &[f64]) -> Option<(Vec<f64>, Vec<String>, Vec<String>, Vec<u64>)> {
    let (_, anchors, names) = guideline_anchors(field)?;
    let (min, max) = (*sorted.first()?, *sorted.last()?);
    let start = anchors.iter().filter(|a| **a <= min).count();
    let (mut breaks, mut colors, mut labels) = (Vec::new(), Vec::new(), Vec::new());
    for (i, a) in anchors.iter().enumerate().skip(start) {
        if *a >= max {
            break;
        }
        breaks.push(*a);
        colors.push(AQ_COLORS[i].to_string());
        labels.push(names[i].to_string());
    }
    let last = start + breaks.len();
    breaks.push(max);
    colors.push(AQ_COLORS[last.min(5)].to_string());
    labels.push(names[last.min(5)].to_string());
    let counts = classify::class_counts(sorted, &breaks);
    Some((breaks, colors, labels, counts))
}

/// Graduated colours: method from the distribution's shape, ramp from the field's meaning.
pub fn graduated(field: &str, mut v: Vec<f64>) -> (Value, String) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if let Some((breaks, colors, labels, counts)) = guideline_classes(field, &v) {
        let (label, anchors, _) = guideline_anchors(field).unwrap();
        let why = format!(
            "'{field}' is {label}, so classes follow the WHO 2021 24-hour guideline ({} µg/m³) and interim targets ({} µg/m³), coloured like an air-quality index (n = {n})",
            anchors[0],
            anchors[1..].iter().map(|a| super::features::num_text(*a)).collect::<Vec<_>>().join(", ")
        );
        return (json!({ "kind": "graduated", "field": field, "method": "guideline", "ramp": "aqi", "breaks": breaks, "colors": colors, "counts": counts, "labels": labels, "min": v[0] }), why);
    }
    let mut distinct = v.clone();
    distinct.dedup();
    let mut k = if n >= 30 { 5 } else { ((n as f64).log2() + 1.0).ceil().clamp(3.0, 5.0) as usize };
    k = k.min(distinct.len()).max(1);
    let skew = skewness(&v);
    let (method, shape) = if skew.abs() < 0.5 {
        (Method::EqualInterval, "roughly symmetric")
    } else if skew.abs() < 2.0 {
        (Method::NaturalBreaks, if skew > 0.0 { "right-skewed" } else { "left-skewed" })
    } else {
        (Method::Quantile, "heavy-tailed")
    };
    let (min, max) = (v[0], v[n - 1]);
    let neg_share = v.iter().filter(|x| **x < 0.0).count() as f64 / n as f64;
    let lname = field.to_ascii_lowercase();
    let has = |ws: &[&str]| ws.iter().any(|w| lname.contains(w));
    let ramp_id = if min < 0.0 && max > 0.0 && (0.1..=0.9).contains(&neg_share) {
        "rdylbu"
    } else if has(&["water", "rain", "depth", "moist", "precip", "humid"]) {
        "blues"
    } else if has(&["ndvi", "veg", "green", "tree", "forest", "crop", "yield", "biomass"]) {
        "greens"
    } else if has(&["elev", "alt", "height", "dem", "slope", "prediction", "variance", "ph"]) {
        "viridis"
    } else {
        "ylorrd"
    };
    let breaks = classify::breaks(&v, k, method);
    let counts = classify::class_counts(&v, &breaks);
    let colors = ramp_colors(ramp_id, breaks.len());
    let method_name = match method {
        Method::EqualInterval => "equal intervals",
        Method::Quantile => "quantiles (every class equally full)",
        Method::NaturalBreaks => "natural breaks (Jenks)",
    };
    let why = format!(
        "'{field}' is numeric and {shape} (n = {n}, skew {skew:.1}), so {method_name} in {} classes with the colour-blind-safe {} ramp",
        breaks.len(),
        ramp(ramp_id).name
    );
    (json!({ "kind": "graduated", "field": field, "method": method.as_str(), "ramp": ramp_id, "breaks": breaks, "colors": colors, "counts": counts, "min": min }), why)
}

/// Unique colours for up to 12 categories (largest first), the rest as "other".
/// Fixed colours for known class fields: (field, [(value, colour)], why).
const FIXED_CLASSES: &[(&str, &[(&str, &str)], &str)] = &[(
    "lisa_cluster",
    &[
        ("High-High cluster", "#d7191c"),
        ("Low-Low cluster", "#2c7bb6"),
        ("High-Low outlier", "#fdae61"),
        ("Low-High outlier", "#abd9e9"),
        ("Not significant", "#d3d3d3"),
        ("No neighbours", "#f7f7f7"),
    ],
    "LISA classes in their conventional colours: red high-high, blue low-low, orange and light blue outliers, grey not significant",
)];

/// The conventional colour of a land-cover class named in plain words (ESA WorldCover / Dynamic World
/// style): green forest, blue water, red built-up… None when the name is not a land-cover class.
pub fn land_cover_color(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    let has = |w: &[&str]| w.iter().any(|x| n.contains(x));
    Some(if has(&["mangrove"]) {
        "#00cf75"
    } else if has(&["forest", "tree", "woodland", "plantation"]) {
        "#1b7837"
    } else if has(&["shrub", "scrub", "bush"]) {
        "#ffbb22"
    } else if has(&["grass", "pasture", "savanna", "meadow"]) {
        "#e6e65c"
    } else if has(&["crop", "agri", "farm", "garden"]) {
        "#f096ff"
    } else if has(&["built", "urban", "settlement", "city", "town", "building", "impervious"]) {
        "#e31a1c"
    } else if has(&["bare", "sand", "rock", "gravel", "soil"]) {
        "#b4b4b4"
    } else if has(&["snow", "ice", "glacier"]) {
        "#f0f0f0"
    } else if has(&["wetland", "swamp", "marsh", "bog"]) {
        "#0096a0"
    } else if has(&["water", "river", "lake", "sea", "ocean", "reservoir"]) {
        "#1f78b4"
    } else if has(&["cloud"]) {
        "#ffffff"
    } else {
        return None;
    })
}

pub fn unique(field: &str, mut list: Vec<(String, u64, bool)>) -> (Value, String) {
    // land-cover classes in plain words get their conventional colours
    if list.len() >= 2 && list.len() <= 12 && list.iter().all(|x| land_cover_color(&x.0).is_some()) {
        list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let classes: Vec<Value> = list.iter().map(|(v, c, _)| json!({ "value": v, "color": land_cover_color(v), "count": c })).collect();
        return (
            json!({ "kind": "unique", "field": field, "ramp": "fixed", "classes": classes, "other": OTHER_COLOR, "othersCount": 0 }),
            format!("'{field}' holds land-cover classes, so each gets its conventional colour: green forest, blue water, red built-up"),
        );
    }
    if let Some((_, colors, why)) = FIXED_CLASSES.iter().find(|(f, _, _)| *f == field) {
        let classes: Vec<Value> = colors
            .iter()
            .filter_map(|(v, c)| list.iter().find(|x| x.0 == *v).map(|x| json!({ "value": v, "color": c, "count": x.1 })))
            .collect();
        return (json!({ "kind": "unique", "field": field, "ramp": "fixed", "classes": classes, "other": OTHER_COLOR, "othersCount": 0 }), why.to_string());
    }
    list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let total = list.len();
    let ramp_id = if total > 10 { "bold" } else { "tableau" };
    let shown = list.len().min(12);
    let colors = ramp_colors(ramp_id, shown);
    let classes: Vec<Value> = list[..shown]
        .iter()
        .zip(colors)
        .map(|((v, c, numeric), color)| {
            let value = if *numeric { v.parse::<f64>().map(Value::from).unwrap_or_else(|_| v.clone().into()) } else { Value::from(v.clone()) };
            json!({ "value": value, "color": color, "count": c })
        })
        .collect();
    let others: u64 = list[shown..].iter().map(|x| x.1).sum();
    let why = format!(
        "'{field}' has {total} categor{}, so unique colours from the qualitative {} palette{}",
        if total == 1 { "y" } else { "ies" },
        ramp(ramp_id).name,
        if others > 0 { format!(" (the {} rarest grouped as 'other')", total - shown) } else { String::new() }
    );
    (json!({ "kind": "unique", "field": field, "ramp": ramp_id, "classes": classes, "other": OTHER_COLOR, "othersCount": others }), why)
}

/// The attribute to label features with, if any (names, titles, labels).
pub fn label_field(l: &LayerHandle) -> Option<String> {
    let strings: Vec<&str> = l.info.fields.iter().filter(|f| f.kind == "string").map(|f| f.name.as_str()).collect();
    for want in ["name", "title", "label", "site", "nom", "nombre", "name_en"] {
        if let Some(f) = strings.iter().find(|f| f.eq_ignore_ascii_case(want)) {
            return Some(f.to_string());
        }
    }
    strings.iter().find(|f| f.to_ascii_lowercase().ends_with("_name")).map(|f| f.to_string())
}

/// Colour of one feature value under a symbology (same rules as `colorExpression` in the web UI).
pub struct Colorer {
    kind: u8,
    color: String,
    field: Option<String>,
    unique: HashMap<String, String>,
    other: String,
    breaks: Vec<f64>,
    colors: Vec<String>,
}

impl Colorer {
    pub fn new(sym: &Value) -> Colorer {
        let s = |k: &str| sym.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match sym.get("kind").and_then(Value::as_str) {
            Some("unique") => Colorer {
                kind: 1,
                color: String::new(),
                field: Some(s("field")),
                unique: sym
                    .get("classes")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|c| (super::recipe::value_text(&c["value"]), c["color"].as_str().unwrap_or(OTHER_COLOR).to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
                other: sym.get("other").and_then(Value::as_str).unwrap_or(OTHER_COLOR).to_string(),
                breaks: vec![],
                colors: vec![],
            },
            Some("graduated") => Colorer {
                kind: 2,
                color: String::new(),
                field: Some(s("field")),
                unique: HashMap::new(),
                other: String::new(),
                breaks: sym.get("breaks").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default(),
                colors: sym.get("colors").and_then(Value::as_array).map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            },
            _ => Colorer { kind: 0, color: sym.get("color").and_then(Value::as_str).unwrap_or("#9aa5b1").to_string(), field: None, unique: HashMap::new(), other: String::new(), breaks: vec![], colors: vec![] },
        }
    }

    pub fn field(&self) -> Option<&str> {
        self.field.as_deref()
    }

    pub fn color(&self, v: Option<&super::features::Val>) -> String {
        match self.kind {
            0 => self.color.clone(),
            1 => v.map(|v| v.text()).and_then(|t| self.unique.get(&t).cloned()).unwrap_or_else(|| self.other.clone()),
            _ => {
                let Some(x) = v.and_then(|v| v.as_f64()) else { return NULL_COLOR.to_string() };
                if self.breaks.is_empty() || self.colors.is_empty() {
                    return NULL_COLOR.to_string();
                }
                for (i, b) in self.breaks.iter().enumerate().take(self.breaks.len() - 1) {
                    if x <= *b {
                        return self.colors.get(i).cloned().unwrap_or_else(|| NULL_COLOR.into());
                    }
                }
                self.colors.last().cloned().unwrap_or_else(|| NULL_COLOR.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn who_guideline_classes() {
        let v: Vec<f64> = vec![5.5, 10.0, 14.0, 20.0, 30.0, 61.1];
        let (b, c, l, n) = guideline_classes("pm2_5", &v).unwrap();
        assert_eq!(b, vec![15.0, 25.0, 37.5, 50.0, 61.1]);
        assert_eq!((l[0].as_str(), l[4].as_str()), ("guideline met", "IT-1"));
        assert_eq!((n.iter().sum::<u64>(), c.len()), (6, 5));
        // every reading above the guideline: classes start at interim target 4
        let (b, _, l, _) = guideline_classes("pm2_5_atm", &[20.0, 22.0, 90.0]).unwrap();
        assert_eq!(b, vec![25.0, 37.5, 50.0, 75.0, 90.0]);
        assert_eq!((l[0].as_str(), l[4].as_str()), ("IT-4", "above IT-1"));
        assert_eq!(guideline_classes("pm10", &[10.0, 40.0]).unwrap().0, vec![40.0]);
        assert!(guideline_classes("temperature", &v).is_none());
        assert_eq!(graduated("pm2_5", v.clone()).0["method"], "guideline");
        assert_ne!(graduated("pm1", v).0["method"], "guideline");
    }

    use super::*;

    #[test]
    fn ramp_matches_the_web_ui() {
        // rampColors('ylorrd', 3) in symbology.ts
        assert_eq!(ramp_colors("ylorrd", 3), ["#ffffb2", "#fd8d3c", "#bd0026"]);
        assert_eq!(ramp_colors("tableau", 2), ["#4e79a7", "#f28e2b"]);
        assert_eq!(ramp_colors("viridis", 1), ["#21918c"]);
    }

    #[test]
    fn method_follows_the_distribution() {
        let sym: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let (s, why) = graduated("value", sym);
        assert_eq!(s["method"], "equal", "{why}");
        let skewed: Vec<f64> = (1..200).map(|i| (i as f64 / 20.0).exp()).collect();
        let (s, why) = graduated("pop_est", skewed);
        assert_eq!(s["method"], "quantile", "{why}");
        assert_eq!(s["ramp"], "ylorrd");
        let diverging: Vec<f64> = (-50..50).map(|i| i as f64).collect();
        assert_eq!(graduated("change", diverging).0["ramp"], "rdylbu");
        let ph: Vec<f64> = (0..60).map(|i| 5.0 + (i as f64 / 10.0).sin()).collect();
        assert_eq!(graduated("ph", ph).0["ramp"], "viridis");
    }

    #[test]
    fn land_cover_names_get_conventional_colours() {
        assert_eq!(super::land_cover_color("Forest"), Some("#1b7837"));
        assert_eq!(super::land_cover_color("built-up"), Some("#e31a1c"));
        assert_eq!(super::land_cover_color("mangrove forest"), Some("#00cf75"));
        assert_eq!(super::land_cover_color("Group 3"), None);
    }

    #[test]
    fn unique_groups_the_tail_and_colorer_agrees() {
        let list: Vec<(String, u64, bool)> = (0..15).map(|i| (format!("c{i}"), 100 - i as u64, false)).collect();
        let (s, why) = unique("type", list);
        assert_eq!(s["classes"].as_array().unwrap().len(), 12);
        assert_eq!(s["othersCount"], 88 + 87 + 86);
        assert!(why.contains("other"), "{why}");
        let c = Colorer::new(&s);
        assert_eq!(c.color(Some(&super::super::features::Val::Str("c0".into()))), s["classes"][0]["color"].as_str().unwrap());
        assert_eq!(c.color(Some(&super::super::features::Val::Str("c14".into()))), OTHER_COLOR);
        let (g, _) = graduated("v", (0..10).map(|i| i as f64).collect());
        let c = Colorer::new(&g);
        assert_eq!(c.color(Some(&super::super::features::Val::Int(0))), g["colors"][0].as_str().unwrap());
        assert_eq!(c.color(None), NULL_COLOR);
    }

    #[test]
    fn id_like_fields_are_skipped() {
        assert!(is_id_like("OBJECTID") && is_id_like("site_id") && is_id_like("path"));
        assert!(!is_id_like("pop_est") && !is_id_like("ph"));
    }
}
