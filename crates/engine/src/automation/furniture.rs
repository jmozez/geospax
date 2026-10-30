//! Map furniture: scale bars, north arrows, the overview inset and where they go.
//!
//! GeoSpaX places furniture where the data is not: every corner of the frame is scored by how much
//! of the mapped data falls there, and the north arrow, scale bar, inset and an inside legend take the
//! emptiest corners that suit them (north arrow on top, scale bar at the bottom). Any piece can be
//! pinned to a corner instead.
use super::cartography::{Layout, MapLayer};
use super::features::{FeatureSet, each_coord, fmt_distance, nice_floor};
use serde_json::Value;
use std::fmt::Write as _;

/// A corner of the map frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    fn parse(s: &str) -> Option<Corner> {
        match s {
            "tl" | "top-left" => Some(Corner::TopLeft),
            "tr" | "top-right" => Some(Corner::TopRight),
            "bl" | "bottom-left" => Some(Corner::BottomLeft),
            "br" | "bottom-right" => Some(Corner::BottomRight),
            _ => None,
        }
    }
    fn top(self) -> bool {
        matches!(self, Corner::TopLeft | Corner::TopRight)
    }
    fn left(self) -> bool {
        matches!(self, Corner::TopLeft | Corner::BottomLeft)
    }
    const ALL: [Corner; 4] = [
        Corner::TopLeft,
        Corner::TopRight,
        Corner::BottomLeft,
        Corner::BottomRight,
    ];
}

/// Where a piece goes: a pinned corner, wherever the data is not (auto), or nowhere.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Place {
    Auto,
    At(Corner),
    Off,
}

impl Place {
    fn parse(v: Option<&Value>, default: Place) -> Place {
        match v.and_then(Value::as_str) {
            Some("auto") => Place::Auto,
            Some("none") | Some("off") => Place::Off,
            Some(s) => Corner::parse(s).map(Place::At).unwrap_or(default),
            None => match v {
                Some(Value::Bool(false)) => Place::Off,
                Some(Value::Bool(true)) => Place::Auto,
                _ => default,
            },
        }
    }
}

/// Everything about the furniture a map asks for (export.map parameters).
#[derive(Clone, Debug)]
pub struct Furniture {
    /// pill (default), checker, line, ruler
    pub scale_style: String,
    /// metric (default), imperial, both
    pub units: String,
    pub scale_at: Place,
    /// needle (default), compass, rose, minimal
    pub north_style: String,
    pub north_at: Place,
    /// right (default), inside, none
    pub legend: String,
    pub legend_at: Place,
    pub legend_title: String,
    /// {layer id: {title?, hide?, labels?: {old: new}}} and an optional order
    pub legend_edit: Value,
    pub legend_order: Vec<String>,
    pub inset_at: Place,
    /// light (default) or dark page
    pub theme: String,
}

impl Default for Furniture {
    fn default() -> Self {
        Furniture {
            scale_style: "pill".into(),
            units: "metric".into(),
            scale_at: Place::Auto,
            north_style: "needle".into(),
            north_at: Place::Auto,
            legend: "right".into(),
            legend_at: Place::Auto,
            legend_title: "Legend".into(),
            legend_edit: Value::Null,
            legend_order: Vec::new(),
            inset_at: Place::Off,
            theme: "light".into(),
        }
    }
}

impl Furniture {
    pub fn from_params(p: &Value) -> Result<Furniture, String> {
        let d = Furniture::default();
        let s = |k: &str, dflt: &str, ok: &[&str]| -> Result<String, String> {
            match p.get(k) {
                Some(Value::String(v)) if ok.contains(&v.as_str()) => Ok(v.clone()),
                Some(Value::String(v)) => {
                    Err(format!("{k}: '{v}' is not one of {}", ok.join(", ")))
                }
                Some(Value::Bool(false)) => Ok("none".into()),
                _ => Ok(dflt.into()),
            }
        };
        let scale_style = s(
            "scale_bar",
            &d.scale_style,
            &["pill", "checker", "line", "ruler", "none"],
        )?;
        let north_style = s(
            "north_arrow",
            &d.north_style,
            &["needle", "compass", "rose", "minimal", "none"],
        )?;
        let legend = s("legend", &d.legend, &["right", "inside", "none"])?;
        Ok(Furniture {
            scale_at: if scale_style == "none" {
                Place::Off
            } else {
                Place::parse(p.get("scale_bar_at"), Place::Auto)
            },
            north_at: if north_style == "none" {
                Place::Off
            } else {
                Place::parse(p.get("north_arrow_at"), Place::Auto)
            },
            legend_at: Place::parse(p.get("legend_at"), Place::Auto),
            units: s("units", &d.units, &["metric", "imperial", "both"])?,
            legend_title: p
                .get("legend_title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or(d.legend_title),
            legend_edit: p.get("legend_edit").cloned().unwrap_or(Value::Null),
            legend_order: p
                .get("legend_order")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            inset_at: Place::parse(p.get("inset"), Place::Off),
            theme: s("theme", &d.theme, &["light", "dark"])?,
            scale_style,
            north_style,
            legend,
        })
    }

    /// The legend edits for one layer: (title, hidden, label renames).
    pub fn edit_for(&self, id: &str) -> (Option<String>, bool, Vec<(String, String)>) {
        let e = self.legend_edit.get(id).or_else(|| {
            self.legend_edit.as_object().and_then(|o| {
                o.iter()
                    .find(|(k, _)| {
                        id.ends_with(&format!(".{k}")) || id.starts_with(&format!("{k}."))
                    })
                    .map(|(_, v)| v)
            })
        });
        let Some(e) = e else {
            return (None, false, Vec::new());
        };
        let labels = e
            .get("labels")
            .and_then(Value::as_object)
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        (
            e.get("title").and_then(Value::as_str).map(str::to_string),
            e.get("hide").and_then(Value::as_bool).unwrap_or(false),
            labels,
        )
    }
}

/// Size of each piece in px (width, height), for placement and to keep labels off them.
const SCALE_BOX: (f64, f64) = (240.0, 46.0);
const NORTH_BOX: (f64, f64) = (64.0, 80.0);
pub const INSET_FRAC: f64 = 0.26;

/// The corners chosen for each piece, and their rectangles (labels avoid them).
pub struct Placement {
    pub scale: Option<Corner>,
    pub north: Option<Corner>,
    pub inset: Option<Corner>,
    pub legend: Option<Corner>,
}

/// How much of the data falls in each corner region of the frame (0 = empty).
fn corner_load(layers: &[&MapLayer], lay: &Layout) -> [f64; 4] {
    let mut load = [0.0; 4];
    let (cw, ch) = (lay.fw * 0.34, lay.fh * 0.34);
    for l in layers.iter().filter(|l| !l.context) {
        let n = l.fs.feats.len().max(1);
        let step = (n / 4000).max(1);
        let w = 1.0 / n as f64 * step as f64;
        for f in l.fs.feats.iter().step_by(step) {
            let mut k = 0;
            each_coord(&f.geom, &mut |c| {
                // a few vertices per feature are enough to know where it is
                k += 1;
                if k > 8 {
                    return;
                }
                let p = lay.px(*c);
                let (dx, dy) = (p[0] - lay.fx, p[1] - lay.fy);
                if dx < 0.0 || dy < 0.0 || dx > lay.fw || dy > lay.fh {
                    return;
                }
                for (i, corner) in Corner::ALL.iter().enumerate() {
                    let inx = if corner.left() {
                        dx < cw
                    } else {
                        dx > lay.fw - cw
                    };
                    let iny = if corner.top() {
                        dy < ch
                    } else {
                        dy > lay.fh - ch
                    };
                    if inx && iny {
                        load[i] += w;
                    }
                }
            });
        }
    }
    load
}

/// Put each piece in a corner: pinned ones first, then legend and inset (the biggest) in the emptiest
/// corners, the north arrow in the emptiest top corner left, the scale bar in the emptiest bottom one.
pub fn place(fur: &Furniture, layers: &[&MapLayer], lay: &Layout) -> Placement {
    let load = corner_load(layers, lay);
    let idx = |c: Corner| Corner::ALL.iter().position(|x| *x == c).unwrap();
    let mut taken: Vec<Corner> = Vec::new();
    let pinned = |p: Place, taken: &mut Vec<Corner>| {
        if let Place::At(c) = p {
            taken.push(c);
            Some(c)
        } else {
            None
        }
    };
    let mut legend = if fur.legend == "inside" {
        pinned(fur.legend_at, &mut taken)
    } else {
        None
    };
    let mut inset = pinned(fur.inset_at, &mut taken);
    let mut north = pinned(fur.north_at, &mut taken);
    let mut scale = pinned(fur.scale_at, &mut taken);
    let pick = |want: &dyn Fn(Corner) -> bool, taken: &mut Vec<Corner>, fallback: Corner| {
        let mut c: Vec<Corner> = Corner::ALL
            .iter()
            .copied()
            .filter(|c| want(*c) && !taken.contains(c))
            .collect();
        c.sort_by(|a, b| load[idx(*a)].total_cmp(&load[idx(*b)]));
        let got = c.first().copied().unwrap_or(fallback);
        taken.push(got);
        got
    };
    if fur.legend == "inside" && fur.legend_at == Place::Auto {
        legend = Some(pick(&|_| true, &mut taken, Corner::BottomRight));
    }
    if fur.inset_at == Place::Auto {
        inset = Some(pick(&|_| true, &mut taken, Corner::TopLeft));
    }
    if fur.north_at == Place::Auto {
        north = Some(pick(&|c| c.top(), &mut taken, Corner::TopRight));
    }
    if fur.scale_at == Place::Auto {
        scale = Some(pick(&|c| !c.top(), &mut taken, Corner::BottomLeft));
    }
    Placement {
        scale,
        north,
        inset,
        legend,
    }
}

/// Top-left point of a box of size (w, h) in a corner of the frame, `pad` px inside.
pub fn anchor(lay: &Layout, c: Corner, w: f64, h: f64, pad: f64) -> (f64, f64) {
    let x = if c.left() {
        lay.fx + pad
    } else {
        lay.fx + lay.fw - w - pad
    };
    let y = if c.top() {
        lay.fy + pad
    } else {
        lay.fy + lay.fh - h - pad
    };
    (x, y)
}

/// Rectangles the labels must keep clear of.
pub fn obstacles(pl: &Placement, lay: &Layout, legend_box: Option<(f64, f64)>) -> Vec<[f64; 4]> {
    let mut out = Vec::new();
    let mut add = |c: Option<Corner>, (w, h): (f64, f64)| {
        if let Some(c) = c {
            let (x, y) = anchor(lay, c, w, h, 10.0);
            out.push([x, y, x + w, y + h]);
        }
    };
    add(pl.scale, SCALE_BOX);
    add(pl.north, NORTH_BOX);
    add(pl.inset, inset_size(lay));
    if let Some(b) = legend_box {
        add(pl.legend, b);
    }
    out
}

pub fn inset_size(lay: &Layout) -> (f64, f64) {
    let w = (lay.fw * INSET_FRAC).clamp(150.0, 320.0);
    (w, w * 0.72)
}

// ------------------------------------------------------------------ scale bars

const INK: &str = "#2f3b46";
const MI: f64 = 1609.344;

fn fmt_miles(m: f64) -> String {
    let mi = m / MI;
    if mi >= 1.0 {
        format!("{} mi", super::cartography::fmt_num(mi))
    } else {
        format!("{} ft", super::cartography::fmt_num((m / 0.3048).round()))
    }
}

/// A round length (metres) close to `target` metres, in miles/feet.
fn nice_imperial(target: f64) -> f64 {
    if target >= MI {
        nice_floor(target / MI) * MI
    } else {
        nice_floor(target / 0.3048) * 0.3048
    }
}

pub fn scale_bar(svg: &mut String, lay: &Layout, fur: &Furniture, corner: Corner) {
    let mpp = lay.meters_per_px();
    if !mpp.is_finite() || mpp <= 0.0 {
        return;
    }
    let both = fur.units == "both";
    let imperial = fur.units == "imperial";
    let target = mpp * if lay.fw < 600.0 { 120.0 } else { 170.0 };
    let d = if imperial {
        nice_imperial(target)
    } else {
        nice_floor(target)
    };
    let len = d / mpp;
    let label = |m: f64| {
        if imperial {
            fmt_miles(m)
        } else {
            fmt_distance(m)
        }
    };
    let (bw, bh) = (len + 70.0, if both { 58.0 } else { 40.0 });
    let (bx, by) = anchor(lay, corner, bw.max(SCALE_BOX.0.min(bw)), bh, 10.0);
    let (x, y) = (bx + 24.0, by + if both { 26.0 } else { 24.0 });
    let half = len / 2.0;
    let _ = write!(
        svg,
        "<g class=\"scale-bar\" font-size=\"11\" fill=\"{INK}\"><rect x=\"{bx:.1}\" y=\"{by:.1}\" width=\"{bw:.1}\" height=\"{bh:.1}\" rx=\"{}\" fill=\"#ffffff\" fill-opacity=\"0.88\"/>",
        if fur.scale_style == "pill" {
            bh / 2.0
        } else {
            3.0
        }
    );
    match fur.scale_style.as_str() {
        "line" => {
            let _ = write!(
                svg,
                "<path d=\"M{x:.1} {:.1}v6h{len:.1}v-6\" fill=\"none\" stroke=\"{INK}\" stroke-width=\"1.4\"/><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text>",
                y - 2.0,
                x + half,
                y - 5.0,
                label(d)
            );
        }
        "ruler" => {
            let _ = write!(
                svg,
                "<path d=\"M{x:.1} {:.1}h{len:.1}\" stroke=\"{INK}\" stroke-width=\"1.2\"/>",
                y + 4.0
            );
            for k in 0..=4 {
                let tx = x + len * k as f64 / 4.0;
                let th = if k % 2 == 0 { 9.0 } else { 5.0 };
                let _ = write!(
                    svg,
                    "<path d=\"M{tx:.1} {:.1}v{th}\" stroke=\"{INK}\" stroke-width=\"1.1\"/>",
                    y + 4.0 - th
                );
            }
            let _ = write!(
                svg,
                "<text x=\"{x:.1}\" y=\"{:.1}\" text-anchor=\"middle\">0</text><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text>",
                y - 8.0,
                x + half,
                y - 8.0,
                label(d / 2.0),
                x + len,
                y - 8.0,
                label(d)
            );
        }
        "checker" => {
            let q = len / 4.0;
            for k in 0..4 {
                let fill = if k % 2 == 0 { INK } else { "#ffffff" };
                let _ = write!(
                    svg,
                    "<rect x=\"{:.1}\" y=\"{y:.1}\" width=\"{q:.1}\" height=\"6\" fill=\"{fill}\"/>",
                    x + k as f64 * q
                );
            }
            let _ = write!(
                svg,
                "<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{len:.1}\" height=\"6\" fill=\"none\" stroke=\"{INK}\" stroke-width=\"0.8\"/><text x=\"{x:.1}\" y=\"{:.1}\" text-anchor=\"middle\">0</text><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text>",
                y - 5.0,
                x + half,
                y - 5.0,
                label(d / 2.0),
                x + len,
                y - 5.0,
                label(d)
            );
        }
        _ => {
            // pill: a rounded bar, half dark, the distance written above its end
            let _ = write!(
                svg,
                "<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{len:.1}\" height=\"7\" rx=\"3.5\" fill=\"#ffffff\" stroke=\"{INK}\" stroke-width=\"1\"/>\
<path d=\"M{:.1} {y:.1}h{:.1}v7h-{:.1}a3.5 3.5 0 0 1 0-7z\" fill=\"{INK}\"/>\
<text x=\"{x:.1}\" y=\"{:.1}\" text-anchor=\"middle\">0</text><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text><text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" font-weight=\"bold\">{}</text>",
                x + 3.5,
                half - 3.5,
                half - 3.5,
                y - 5.0,
                x + half,
                y - 5.0,
                label(d / 2.0),
                x + len,
                y - 5.0,
                label(d)
            );
        }
    }
    if both {
        // a second bar in miles under the metric one, its own round length
        let di = nice_imperial(target);
        let li = di / mpp;
        let yy = y + 20.0;
        let _ = write!(
            svg,
            "<path d=\"M{x:.1} {yy:.1}h{li:.1}M{x:.1} {:.1}v8M{:.1} {:.1}v8\" stroke=\"{INK}\" stroke-width=\"1.2\"/><text x=\"{:.1}\" y=\"{:.1}\">{}</text>",
            yy - 4.0,
            x + li,
            yy - 4.0,
            x + li + 4.0,
            yy + 4.0,
            fmt_miles(di)
        );
    }
    svg.push_str("</g>");
}

// ------------------------------------------------------------------ north arrows

pub fn north_arrow(svg: &mut String, lay: &Layout, fur: &Furniture, corner: Corner) {
    let (bx, by) = anchor(lay, corner, NORTH_BOX.0, NORTH_BOX.1, 10.0);
    let (x, y) = (bx + NORTH_BOX.0 / 2.0, by + 48.0);
    let body = match fur.north_style.as_str() {
        "compass" => "<circle r=\"24\" fill=\"#ffffff\" fill-opacity=\"0.85\" stroke=\"#2f3b46\" stroke-width=\"0.8\"/>\
<path d=\"M0 -17 L8 9 L0 4 Z\" fill=\"#2f3b46\"/><path d=\"M0 -17 L-8 9 L0 4 Z\" fill=\"#ffffff\" stroke=\"#2f3b46\" stroke-width=\"0.8\"/>\
<text y=\"-27\" text-anchor=\"middle\" font-size=\"12\" font-weight=\"bold\" fill=\"#2f3b46\">N</text>"
            .to_string(),
        "rose" => {
            let mut s = String::from("<circle r=\"25\" fill=\"#ffffff\" fill-opacity=\"0.85\"/>");
            for k in 0..8 {
                let (r, w) = if k % 2 == 0 { (24.0, 6.0) } else { (14.0, 4.0) };
                let fill = if k == 0 { "#c0392b" } else { "#2f3b46" };
                let _ = write!(s, "<path transform=\"rotate({})\" d=\"M0 -{r} L{w} 0 L0 0 Z\" fill=\"{fill}\"/><path transform=\"rotate({})\" d=\"M0 -{r} L-{w} 0 L0 0 Z\" fill=\"#ffffff\" stroke=\"#2f3b46\" stroke-width=\"0.6\"/>", k * 45, k * 45);
            }
            s.push_str("<text y=\"-29\" text-anchor=\"middle\" font-size=\"12\" font-weight=\"bold\" fill=\"#2f3b46\">N</text>");
            s
        }
        "minimal" => "<path d=\"M0 -22 V14 M-7 -12 L0 -22 L7 -12\" fill=\"none\" stroke=\"#2f3b46\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><text y=\"-28\" text-anchor=\"middle\" font-size=\"13\" font-weight=\"bold\" fill=\"#2f3b46\">N</text>".to_string(),
        // needle: a slim two-tone needle through a ring, N set in the ring's gap
        _ => "<circle r=\"19\" fill=\"#ffffff\" fill-opacity=\"0.88\" stroke=\"#2f3b46\" stroke-width=\"1.2\" stroke-dasharray=\"95 24\" transform=\"rotate(-67)\"/>\
<path d=\"M0 -26 L5 0 L0 3 Z\" fill=\"#c0392b\"/><path d=\"M0 -26 L-5 0 L0 3 Z\" fill=\"#e06150\"/>\
<path d=\"M0 22 L5 0 L0 -3 Z\" fill=\"#2f3b46\"/><path d=\"M0 22 L-5 0 L0 -3 Z\" fill=\"#56636e\"/><circle r=\"2.2\" fill=\"#ffffff\" stroke=\"#2f3b46\" stroke-width=\"0.8\"/>\
<text y=\"-31\" text-anchor=\"middle\" font-size=\"12\" font-weight=\"bold\" fill=\"#2f3b46\">N</text>"
            .to_string(),
    };
    let _ = write!(
        svg,
        "<g class=\"north-arrow\" transform=\"translate({x:.1} {y:.1})\">{body}</g>"
    );
}

// ------------------------------------------------------------------ inset (overview) map

/// The overview: land around the study area (about 8× its size), the study area boxed in red, on a
/// card with a soft shadow.
pub fn inset(
    svg: &mut String,
    lay: &Layout,
    corner: Corner,
    land: &FeatureSet,
    study: [f64; 4],
    around: [f64; 4],
) {
    let (w, h) = inset_size(lay);
    let (x, y) = anchor(lay, corner, w, h, 10.0);
    let il = Layout::in_rect(around, x, y, w, h);
    let mut d = String::new();
    for f in &land.feats {
        if let crate::wkb::Geom::Polygons(ps) = &f.geom {
            for ring in ps.iter().flatten() {
                for (i, c) in ring.iter().enumerate() {
                    let p = il.px(*c);
                    let _ = write!(
                        d,
                        "{}{:.1} {:.1}",
                        if i == 0 { "M" } else { "L" },
                        p[0],
                        p[1]
                    );
                }
                d.push('Z');
            }
        }
    }
    let a = il.px([study[0], study[3]]);
    let b = il.px([study[2], study[1]]);
    let (bx0, by0, bx1, by1) = (
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[0].max(b[0]).max(a[0].min(b[0]) + 4.0),
        a[1].max(b[1]).max(a[1].min(b[1]) + 4.0),
    );
    let _ = write!(
        svg,
        "<g class=\"inset\"><clipPath id=\"inset-clip\"><rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{w:.1}\" height=\"{h:.1}\"/></clipPath>\
<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"#000000\" fill-opacity=\"0.12\" rx=\"4\"/>\
<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{w:.1}\" height=\"{h:.1}\" fill=\"#d3e4f0\"/>\
<g clip-path=\"url(#inset-clip)\"><path d=\"{d}\" fill=\"#f1efe8\" stroke=\"#a9b3bb\" stroke-width=\"0.5\" fill-rule=\"evenodd\"/>\
<rect x=\"{bx0:.1}\" y=\"{by0:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"#c0392b\" fill-opacity=\"0.18\" stroke=\"#c0392b\" stroke-width=\"1.6\"/></g>\
<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{w:.1}\" height=\"{h:.1}\" fill=\"none\" stroke=\"#2f3b46\" stroke-width=\"1.2\"/></g>",
        x + 3.0,
        y + 3.0,
        w,
        h,
        bx1 - bx0,
        by1 - by0,
    );
}

/// The area the inset shows: the study area grown about 8× (at least 12° across), clamped to the world.
pub fn inset_extent(study: [f64; 4]) -> [f64; 4] {
    let (cx, cy) = ((study[0] + study[2]) / 2.0, (study[1] + study[3]) / 2.0);
    let span = ((study[2] - study[0]).max(study[3] - study[1]) * 8.0)
        .max(12.0)
        .min(340.0);
    let h = span * 0.72 / 2.0;
    [
        (cx - span / 2.0).max(-180.0),
        (cy - h).max(-80.0),
        (cx + span / 2.0).min(180.0),
        (cy + h).min(84.0),
    ]
}

// ------------------------------------------------------------------ PNG resolution

/// Write the print resolution into a PNG (pHYs chunk), so word processors and journals see the
/// intended size: a 300 dpi export of an A4 page opens as A4.
pub fn png_with_dpi(png: Vec<u8>, dpi: f64) -> Vec<u8> {
    // signature (8) + IHDR chunk (25): insert pHYs after IHDR
    if png.len() < 33 || &png[1..4] != b"PNG" {
        return png;
    }
    let ppm = (dpi / 0.0254).round() as u32;
    let mut chunk = Vec::with_capacity(21);
    chunk.extend_from_slice(&9u32.to_be_bytes());
    let mut body = Vec::with_capacity(13);
    body.extend_from_slice(b"pHYs");
    body.extend_from_slice(&ppm.to_be_bytes());
    body.extend_from_slice(&ppm.to_be_bytes());
    body.push(1);
    chunk.extend_from_slice(&body);
    chunk.extend_from_slice(&crc32(&body).to_be_bytes());
    let mut out = Vec::with_capacity(png.len() + chunk.len());
    out.extend_from_slice(&png[..33]);
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&png[33..]);
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dpi_chunk_is_valid() {
        // crc32 of "IEND" is the well-known AE426082
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
        let png = super::super::cartography::svg_to_png(r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>"##, 1.0).unwrap();
        let out = png_with_dpi(png.clone(), 300.0);
        assert_eq!(out.len(), png.len() + 21);
        assert_eq!(&out[37..41], b"pHYs");
        assert_eq!(u32::from_be_bytes(out[41..45].try_into().unwrap()), 11811);
    }

    #[test]
    fn furniture_params() {
        let f = Furniture::from_params(&serde_json::json!({"scale_bar": "ruler", "units": "both", "north_arrow": "none", "legend": "inside", "legend_at": "tl", "inset": "auto"})).unwrap();
        assert_eq!(f.scale_style, "ruler");
        assert_eq!(f.north_at, Place::Off);
        assert_eq!(f.legend_at, Place::At(Corner::TopLeft));
        assert_eq!(f.inset_at, Place::Auto);
        assert!(Furniture::from_params(&serde_json::json!({"scale_bar": "fancy"})).is_err());
    }

    #[test]
    fn page_theme_defaults_to_light_and_rejects_unknown_values() {
        assert_eq!(
            Furniture::from_params(&serde_json::json!({}))
                .unwrap()
                .theme,
            "light"
        );
        assert_eq!(
            Furniture::from_params(&serde_json::json!({"theme": "dark"}))
                .unwrap()
                .theme,
            "dark"
        );
        assert!(Furniture::from_params(&serde_json::json!({"theme": "neon"})).is_err());
    }
}
