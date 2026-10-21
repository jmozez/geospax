//! Automatic cartography (docs/AUTOMATION.md §4 "Layout"): a finished map page with title,
//! legend, scale bar, north arrow, graticule, labels and credits, as SVG. PNG via resvg.
//!
//! Geometry is clipped to the frame and simplified in pixel space (Douglas-Peucker, 0.35 px), and
//! features that share a colour share one SVG path, so a page stays small even for big layers.

use super::automap::{device_role, Colorer, NULL_COLOR};
use super::features::FeatureSet;
use super::furniture;
pub use super::furniture::Furniture;
use crate::catalog::GeomKind;
use crate::wkb::Geom;
use serde_json::Value;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::fmt::Write as _;

pub struct MapLayer {
    pub id: String,
    pub title: String,
    pub kind: GeomKind,
    pub style: Value,
    pub fs: FeatureSet,
    pub label_field: Option<String>,
    /// Background context (land, roads): drawn muted, not in the legend.
    pub context: bool,
    /// Text next to a single-symbol legend swatch ("12 photos").
    pub legend_note: String,
}

/// A raster drawn under the vector layers: a PNG already rendered for the map frame.
pub struct MapRaster {
    pub id: String,
    pub title: String,
    pub png: Vec<u8>,
    pub opacity: f64,
    /// e.g. "multiply" for relief shading over a colour layer.
    pub blend: Option<String>,
    /// raster::legend() JSON.
    pub legend: Value,
}

pub struct MapSpec {
    pub rasters: Vec<MapRaster>,
    pub title: String,
    pub subtitle: String,
    pub credits: String,
    pub layers: Vec<MapLayer>,
    pub labels: bool,
    pub grid: bool,
    /// Index map of a map series: each page's extent (lon/lat) outlined and labelled.
    pub frames: Vec<([f64; 4], String)>,
    /// Scale bar, north arrow, legend and inset: styles and places.
    pub furniture: Furniture,
    pub inset: Option<Inset>,
}

/// The overview map: land around the study area, the study area to box.
pub struct Inset {
    pub land: FeatureSet,
    pub study: [f64; 4],
    pub around: [f64; 4],
}

pub struct MapOut {
    pub svg: String,
    pub drawn: usize,
    pub labels: usize,
    pub scale_denominator: f64,
}

const MARGIN: f64 = 28.0;
const HEADER: f64 = 98.0;
const FOOTER: f64 = 46.0;
const LEGEND_W: f64 = 300.0;
const FONT: &str = "DejaVu Sans, Arial, Helvetica, sans-serif";
/// Print resolution assumed for the scale statement.
pub const DPI: f64 = 150.0;

fn merc(lon: f64, lat: f64) -> [f64; 2] {
    let lat = lat.clamp(-85.051_128_78, 85.051_128_78).to_radians();
    [(lon + 180.0) / 360.0, (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / PI) / 2.0]
}

fn inv_merc(x: f64, y: f64) -> [f64; 2] {
    [x * 360.0 - 180.0, (PI * (1.0 - 2.0 * y)).sinh().atan().to_degrees()]
}

/// Page size in px: named paper sizes at 150 dpi (landscape), "WxH", or auto from the extent.
pub fn page_size(size: &str, extent: [f64; 4]) -> (f64, f64) {
    let s = size.trim().to_ascii_lowercase();
    if let Some((w, h)) = s.split_once('x') {
        if let (Ok(w), Ok(h)) = (w.trim().parse::<f64>(), h.trim().parse::<f64>()) {
            return (w.clamp(600.0, 8000.0), h.clamp(400.0, 8000.0));
        }
    }
    match s.as_str() {
        "a4" => (1754.0, 1240.0),
        "a4-portrait" => (1240.0, 1754.0),
        "a3" => (2480.0, 1754.0),
        "letter" => (1650.0, 1275.0),
        "letter-portrait" => (1275.0, 1650.0),
        _ => {
            let (a, b) = (merc(extent[0], extent[1]), merc(extent[2], extent[3]));
            let aspect = ((b[0] - a[0]).abs() / (a[1] - b[1]).abs().max(1e-12)).clamp(0.2, 5.0);
            // the map frame takes the data's shape (fixed width, matching height), so raster maps
            // neither crop the data nor float in empty margins
            let w = if aspect < 0.8 { 1240.0 } else { 1600.0 };
            let fw = w - 2.0 * MARGIN - LEGEND_W - 18.0;
            (w, (HEADER + FOOTER + fw / aspect).clamp(1000.0, 1800.0).round())
        }
    }
}

/// Map frame and projection (Web Mercator, north up) for a data extent on a page.
/// How an extent fills the map frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    /// the extent with a margin around it
    Margin,
    /// exactly the extent
    Exact,
    /// the extent covers the frame (one axis cropped)
    Cover,
}

#[derive(Debug, Clone, Copy)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub fx: f64,
    pub fy: f64,
    pub fw: f64,
    pub fh: f64,
    s: f64,
    cx: f64,
    cy: f64,
}

impl Layout {
    pub fn new(extent: [f64; 4], width: f64, height: f64) -> Layout {
        Layout::fit(extent, width, height, Fit::Margin, true)
    }

    /// Exactly the extent (a map series sheet): no margin, so neighbouring sheets do not overlap.
    pub fn new_exact(extent: [f64; 4], width: f64, height: f64) -> Layout {
        Layout::fit(extent, width, height, Fit::Exact, true)
    }

    /// Zoom so the extent covers the whole frame (no padding; one axis is cropped). Used for raster
    /// maps, so the frame is filled with data instead of showing empty margins.
    pub fn new_cover(extent: [f64; 4], width: f64, height: f64) -> Layout {
        Layout::fit(extent, width, height, Fit::Cover, true)
    }

    /// The map frame on a page: beside a legend column, or the full width when the legend sits inside
    /// the map or is switched off.
    pub fn fit(extent: [f64; 4], width: f64, height: f64, fit: Fit, legend_column: bool) -> Layout {
        let fw = width - 2.0 * MARGIN - if legend_column { LEGEND_W + 18.0 } else { 0.0 };
        let fh = height - HEADER - FOOTER;
        let a = merc(extent[0], extent[1]);
        let b = merc(extent[2], extent[3]);
        let (mut x0, mut x1, mut y0, mut y1) = (a[0].min(b[0]), a[0].max(b[0]), a[1].min(b[1]), a[1].max(b[1]));
        if fit == Fit::Cover {
            let s = (fw / (x1 - x0).max(1e-12)).max(fh / (y1 - y0).max(1e-12));
            return Layout { width, height, fx: MARGIN, fy: HEADER, fw, fh, s, cx: (x0 + x1) / 2.0, cy: (y0 + y1) / 2.0 };
        }
        let pad = if fit == Fit::Exact { 1.0 } else { 1.16 };
        // at least ~400 m across, so a single photo still gets a sensible map
        let lat_c = (extent[1] + extent[3]) / 2.0;
        let min_span = 400.0 / (40_075_016.686 * lat_c.to_radians().cos().max(0.05));
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let (w, h) = ((x1 - x0).max(min_span) * pad, (y1 - y0).max(min_span) * pad);
        x0 = cx - w / 2.0;
        x1 = cx + w / 2.0;
        y0 = cy - h / 2.0;
        y1 = cy + h / 2.0;
        let s = (fw / (x1 - x0)).min(fh / (y1 - y0));
        Layout { width, height, fx: MARGIN, fy: HEADER, fw, fh, s, cx, cy }
    }

    /// A map frame at a given place on the page showing exactly `extent` (no margin): the extent fits
    /// the frame and the longer side is matched, so a frame shaped like the extent shows exactly it.
    /// Used for the panels of a multi-panel page.
    pub fn in_rect(extent: [f64; 4], fx: f64, fy: f64, fw: f64, fh: f64) -> Layout {
        let a = merc(extent[0], extent[1]);
        let b = merc(extent[2], extent[3]);
        let (x0, x1, y0, y1) = (a[0].min(b[0]), a[0].max(b[0]), a[1].min(b[1]), a[1].max(b[1]));
        let s = (fw / (x1 - x0).max(1e-12)).min(fh / (y1 - y0).max(1e-12));
        Layout { width: 0.0, height: 0.0, fx, fy, fw, fh, s, cx: (x0 + x1) / 2.0, cy: (y0 + y1) / 2.0 }
    }

    pub fn px(&self, c: [f64; 2]) -> [f64; 2] {
        let m = merc(c[0], c[1]);
        [self.fx + self.fw / 2.0 + (m[0] - self.cx) * self.s, self.fy + self.fh / 2.0 + (m[1] - self.cy) * self.s]
    }

    pub fn lonlat(&self, x: f64, y: f64) -> [f64; 2] {
        inv_merc(self.cx + (x - self.fx - self.fw / 2.0) / self.s, self.cy + (y - self.fy - self.fh / 2.0) / self.s)
    }

    /// Lon/lat bounds of the visible frame (what to read from each layer).
    pub fn view(&self) -> [f64; 4] {
        let a = self.lonlat(self.fx, self.fy + self.fh);
        let b = self.lonlat(self.fx + self.fw, self.fy);
        [a[0], a[1], b[0], b[1]]
    }

    pub fn meters_per_px(&self) -> f64 {
        let lat = self.lonlat(self.fx + self.fw / 2.0, self.fy + self.fh / 2.0)[1];
        40_075_016.686 * lat.to_radians().cos() / self.s
    }

    pub fn scale_denominator(&self) -> f64 {
        self.meters_per_px() / (0.0254 / DPI)
    }

    fn clip_rect(&self) -> [f64; 4] {
        [self.fx - 20.0, self.fy - 20.0, self.fx + self.fw + 20.0, self.fy + self.fh + 20.0]
    }
}

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// 1,234,567 / 12.5 / 0.125: legend-friendly numbers.
pub fn fmt_num(v: f64) -> String {
    let a = v.abs();
    if a >= 1000.0 {
        let i = v.round() as i64;
        let s = i.abs().to_string();
        let mut out = String::new();
        for (k, ch) in s.chars().enumerate() {
            if k > 0 && (s.len() - k) % 3 == 0 {
                out.push(',');
            }
            out.push(ch);
        }
        return if i < 0 { format!("-{out}") } else { out };
    }
    let s = if a >= 100.0 {
        format!("{v:.0}")
    } else if a >= 10.0 {
        format!("{v:.1}")
    } else if a >= 1.0 {
        format!("{v:.2}")
    } else {
        format!("{v:.3}")
    };
    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 {
        return ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0);
    ((p[0] - a[0] - t * dx).powi(2) + (p[1] - a[1] - t * dy).powi(2)).sqrt()
}

/// Douglas-Peucker in pixel space.
fn simplify(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (mut idx, mut dmax) = (0, 0.0);
        for i in a + 1..b {
            let d = seg_dist(pts[i], pts[a], pts[b]);
            if d > dmax {
                idx = i;
                dmax = d;
            }
        }
        if dmax > tol {
            keep[idx] = true;
            stack.push((a, idx));
            stack.push((idx, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// Sutherland-Hodgman clip of a ring against a rectangle [x0, y0, x1, y1].
fn clip_ring(ring: &[[f64; 2]], r: [f64; 4]) -> Vec<[f64; 2]> {
    let mut out = ring.to_vec();
    for edge in 0..4 {
        if out.len() < 3 {
            return vec![];
        }
        let input = std::mem::take(&mut out);
        let inside = |p: &[f64; 2]| match edge {
            0 => p[0] >= r[0],
            1 => p[0] <= r[2],
            2 => p[1] >= r[1],
            _ => p[1] <= r[3],
        };
        let cut = |a: &[f64; 2], b: &[f64; 2]| -> [f64; 2] {
            if edge < 2 {
                let x = if edge == 0 { r[0] } else { r[2] };
                let t = (x - a[0]) / (b[0] - a[0]);
                [x, a[1] + t * (b[1] - a[1])]
            } else {
                let y = if edge == 2 { r[1] } else { r[3] };
                let t = (y - a[1]) / (b[1] - a[1]);
                [a[0] + t * (b[0] - a[0]), y]
            }
        };
        let n = input.len();
        for i in 0..n {
            let (prev, cur) = (&input[(i + n - 1) % n], &input[i]);
            match (inside(prev), inside(cur)) {
                (true, true) => out.push(*cur),
                (true, false) => out.push(cut(prev, cur)),
                (false, true) => {
                    out.push(cut(prev, cur));
                    out.push(*cur);
                }
                (false, false) => {}
            }
        }
    }
    out
}

/// Liang-Barsky segment clip; returns the clipped segment and whether each end was cut.
fn clip_seg(a: [f64; 2], b: [f64; 2], r: [f64; 4]) -> Option<([f64; 2], [f64; 2], bool, bool)> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [(-dx, a[0] - r[0]), (dx, r[2] - a[0]), (-dy, a[1] - r[1]), (dy, r[3] - a[1])] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                if t > t1 {
                    return None;
                }
                t0 = t0.max(t);
            } else {
                if t < t0 {
                    return None;
                }
                t1 = t1.min(t);
            }
        }
    }
    Some(([a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy], t0 > 0.0, t1 < 1.0))
}

fn clip_line(line: &[[f64; 2]], r: [f64; 4]) -> Vec<Vec<[f64; 2]>> {
    let mut parts = Vec::new();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    let flush = |cur: &mut Vec<[f64; 2]>, parts: &mut Vec<Vec<[f64; 2]>>| {
        if cur.len() >= 2 {
            parts.push(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    for w in line.windows(2) {
        match clip_seg(w[0], w[1], r) {
            Some((a, b, cut_a, cut_b)) => {
                if cur.is_empty() || cut_a {
                    flush(&mut cur, &mut parts);
                    cur.push(a);
                }
                cur.push(b);
                if cut_b {
                    flush(&mut cur, &mut parts);
                }
            }
            None => flush(&mut cur, &mut parts),
        }
    }
    flush(&mut cur, &mut parts);
    parts
}

/// Features with the same paint share one path.
#[derive(Default)]
struct Buckets {
    order: Vec<String>,
    paths: HashMap<String, String>,
}

impl Buckets {
    fn get(&mut self, key: &str) -> &mut String {
        if !self.paths.contains_key(key) {
            self.order.push(key.to_string());
            self.paths.insert(key.to_string(), String::new());
        }
        self.paths.get_mut(key).unwrap()
    }
}

fn path_of(pts: &[[f64; 2]], close: bool, d: &mut String) {
    for (i, p) in pts.iter().enumerate() {
        let _ = write!(d, "{}{:.1} {:.1}", if i == 0 { 'M' } else { 'L' }, p[0], p[1]);
    }
    if close {
        d.push('Z');
    }
}

fn circle_path(c: [f64; 2], r: f64, d: &mut String) {
    let _ = write!(d, "M{:.1} {:.1}a{r} {r} 0 1 0 {:.1} 0a{r} {r} 0 1 0 {:.1} 0", c[0] - r, c[1], 2.0 * r, -2.0 * r);
}

struct Labeler {
    boxes: Vec<[f64; 4]>,
    out: String,
    count: usize,
    frame: [f64; 4],
}

impl Labeler {
    fn obstacle(&mut self, b: [f64; 4]) {
        if self.boxes.len() < 4000 {
            self.boxes.push(b);
        }
    }

    fn place(&mut self, x: f64, y: f64, text: &str, size: f64, offset: f64) -> bool {
        let w = text.chars().count() as f64 * size * 0.6 + 2.0;
        let candidates = [(offset, size * 0.35), (-offset - w, size * 0.35), (-w / 2.0, -offset), (-w / 2.0, offset + size * 0.8)];
        for (dx, dy) in candidates {
            let (tx, ty) = (x + dx, y + dy);
            let b = [tx - 1.0, ty - size, tx + w + 1.0, ty + size * 0.3];
            if b[0] < self.frame[0] || b[1] < self.frame[1] || b[2] > self.frame[2] || b[3] > self.frame[3] {
                continue;
            }
            if self.boxes.iter().any(|o| b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) {
                continue;
            }
            let _ = write!(self.out, "<text x=\"{tx:.1}\" y=\"{ty:.1}\" font-size=\"{size}\">{}</text>", esc(text));
            self.boxes.push(b);
            self.count += 1;
            return true;
        }
        false
    }
}

fn context_paint(id: &str, kind: GeomKind) -> (&'static str, &'static str, f64) {
    let lid = id.to_ascii_lowercase();
    if lid.contains("road") {
        ("none", "#b9a27f", 0.9)
    } else if lid.contains("river") || lid.contains("water") || lid.contains("lake") {
        ("#a8c8e4", "#7fa7cc", 0.8)
    } else if kind == GeomKind::Polygon {
        ("#f1eee6", "#c2b9a6", 0.8)
    } else {
        ("none", "#a9a9a9", 0.8)
    }
}

/// Render the page. Layers are drawn bottom first.
pub fn render_svg(spec: &MapSpec, lay: &Layout) -> MapOut {
    let (w, h) = (lay.width, lay.height);
    let mut svg = String::with_capacity(256 * 1024);
    let _ = write!(
        svg,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w:.0}\" height=\"{h:.0}\" viewBox=\"0 0 {w:.0} {h:.0}\" font-family=\"{FONT}\">\
<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\
<defs><clipPath id=\"frame\"><rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\"/></clipPath></defs>",
        lay.fx, lay.fy, lay.fw, lay.fh
    );
    let fur = &spec.furniture;
    let all: Vec<&MapLayer> = spec.layers.iter().collect();
    let legend_layers: Vec<&MapLayer> = spec.layers.iter().rev().filter(|l| !l.context).collect();
    let pl = furniture::place(fur, &all, lay);
    // an inside legend: measured first, then drawn on a panel in its corner
    let inside = (fur.legend == "inside").then(|| {
        let mut tmp = String::new();
        let end = legend(&mut tmp, &legend_layers, &spec.rasters, 0.0, 0.0, lay.fh * 0.85, fur);
        (LEGEND_W + 40.0, end + 4.0)
    });
    let obstacles = furniture::obstacles(&pl, lay, inside);
    let (drawn, n_labels) = draw_frame_with(&mut svg, spec, &all, &spec.rasters, lay, &spec.frames, "frame", &obstacles);
    // title block
    let _ = write!(
        svg,
        "<text x=\"{MARGIN}\" y=\"50\" font-size=\"30\" font-weight=\"bold\" fill=\"#14212b\">{}</text>\
<text x=\"{MARGIN}\" y=\"78\" font-size=\"15\" fill=\"#4a5a68\">{}</text>",
        esc(&spec.title),
        esc(&spec.subtitle)
    );
    draw_furniture(&mut svg, spec, lay, &pl);
    match (fur.legend.as_str(), pl.legend, inside) {
        ("inside", Some(c), Some((lw, lh))) => {
            let (x, y) = furniture::anchor(lay, c, lw, lh, 10.0);
            let _ = write!(svg, "<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{lw:.1}\" height=\"{lh:.1}\" rx=\"6\" fill=\"#ffffff\" fill-opacity=\"0.92\" stroke=\"#c3cbd2\" stroke-width=\"0.8\"/>");
            legend(&mut svg, &legend_layers, &spec.rasters, x + 12.0, y + 2.0, y + lh, fur);
        }
        ("right", _, _) => {
            legend(&mut svg, &legend_layers, &spec.rasters, lay.fx + lay.fw + 18.0, lay.fy, lay.fy + lay.fh, fur);
        }
        _ => {}
    }
    let denom = lay.scale_denominator();
    // footer: credits (trimmed to the page width), then the scale statement
    let max_chars = ((w - 2.0 * MARGIN) / (11.0 * 0.6)) as usize;
    let _ = write!(
        svg,
        "<text x=\"{MARGIN}\" y=\"{:.1}\" font-size=\"11\" fill=\"#6b7785\">{}</text>\
<text x=\"{MARGIN}\" y=\"{:.1}\" font-size=\"11\" fill=\"#6b7785\">Scale ≈ 1:{} at {DPI:.0} dpi · Web Mercator · WGS 84 · north is up</text></svg>",
        h - 22.0,
        esc(&truncate(&spec.credits, max_chars)),
        h - 8.0,
        fmt_num(round_sig(denom, 2))
    );
    MapOut { svg, drawn, labels: n_labels, scale_denominator: denom }
}

/// One map frame: background, rasters, layers, labels, graticule, sheet outlines and the border, drawn
/// into `lay`'s frame rectangle and clipped to it. Returns (features drawn, labels placed).
#[allow(clippy::too_many_arguments)]
fn draw_frame_with(svg: &mut String, spec: &MapSpec, layers: &[&MapLayer], rasters: &[MapRaster], lay: &Layout, frames: &[([f64; 4], String)], clip_id: &str, obstacles: &[[f64; 4]]) -> (usize, usize) {
    let clip = lay.clip_rect();
    if clip_id != "frame" {
        let _ = write!(svg, "<defs><clipPath id=\"{clip_id}\"><rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\"/></clipPath></defs>", lay.fx, lay.fy, lay.fw, lay.fh);
    }
    let has_land = layers.iter().any(|l| l.context && l.kind == GeomKind::Polygon);
    let _ = write!(
        svg,
        "<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"{}\"/><g clip-path=\"url(#{clip_id})\">",
        lay.fx,
        lay.fy,
        lay.fw,
        lay.fh,
        if has_land { "#d3e4f0" } else { "#f6f4ef" }
    );
    let frame = [lay.fx + 4.0, lay.fy + 4.0, lay.fx + lay.fw - 4.0, lay.fy + lay.fh - 4.0];
    let mut labels = Labeler { boxes: Vec::new(), out: String::new(), count: 0, frame };
    // keep the furniture (scale bar, north arrow, inset, an inside legend) free of labels
    for o in obstacles {
        labels.obstacle(*o);
    }
    let mut drawn = 0usize;
    let mut point_layers = Vec::new();
    let mut rasters_done = false;
    for &l in layers {
        if !rasters_done && !(l.context && l.kind == GeomKind::Polygon) {
            draw_rasters(svg, rasters, lay);
            rasters_done = true;
        }
        drawn += draw_layer(svg, l, lay, clip, &mut labels, &mut point_layers);
    }
    if !rasters_done {
        draw_rasters(svg, rasters, lay);
    }
    // labels for point layers go last so every label sits above every symbol
    if spec.labels {
        for (l, pts) in point_layers {
            // photo file names say nothing on a map; waypoint and site names do
            if device_role(&l.id) == Some("photos") {
                continue;
            }
            let Some(fi) = l.label_field.as_ref().and_then(|f| l.fs.field(f)) else { continue };
            if pts.len() > 400 {
                continue;
            }
            for (i, p) in pts {
                let t = l.fs.feats[i].props[fi].text();
                if !t.is_empty() {
                    labels.place(p[0], p[1], &t.chars().take(28).collect::<String>(), 12.0, 8.0);
                }
            }
        }
        if !labels.out.is_empty() {
            let _ = write!(
                svg,
                "<g fill=\"#1b2631\" stroke=\"#ffffff\" stroke-width=\"3\" stroke-linejoin=\"round\" paint-order=\"stroke\">{}</g>",
                labels.out
            );
        }
    }
    if spec.grid {
        graticule(svg, lay);
    }
    for (b, label) in frames {
        let p0 = lay.px([b[0], b[3]]);
        let p1 = lay.px([b[2], b[1]]);
        let (x, y, fw, fh) = (p0[0].min(p1[0]), p0[1].min(p1[1]), (p1[0] - p0[0]).abs(), (p1[1] - p0[1]).abs());
        let _ = write!(
            svg,
            "<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{fw:.1}\" height=\"{fh:.1}\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"5\"/>\
<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{fw:.1}\" height=\"{fh:.1}\" fill=\"none\" stroke=\"#14212b\" stroke-width=\"2.2\"/>\
<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"{:.0}\" font-weight=\"bold\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#14212b\" stroke=\"#ffffff\" stroke-width=\"4\" paint-order=\"stroke\">{}</text>",
            x + fw / 2.0,
            y + fh / 2.0,
            (fw.min(fh) / 4.0).clamp(10.0, 28.0),
            esc(label)
        );
    }
    svg.push_str("</g>");
    let _ = write!(
        svg,
        "<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"none\" stroke=\"#2f3b46\" stroke-width=\"1.2\"/>",
        lay.fx, lay.fy, lay.fw, lay.fh
    );
    (drawn, labels.count)
}

/// Inset, north arrow and scale bar in the corners chosen for them.
fn draw_furniture(svg: &mut String, spec: &MapSpec, lay: &Layout, pl: &furniture::Placement) {
    let fur = &spec.furniture;
    if let (Some(c), Some(i)) = (pl.inset, &spec.inset) {
        furniture::inset(svg, lay, c, &i.land, i.study, i.around);
    }
    if let Some(c) = pl.north {
        furniture::north_arrow(svg, lay, fur, c);
    }
    if let Some(c) = pl.scale {
        furniture::scale_bar(svg, lay, fur, c);
    }
}

/// One panel of a multi-panel map page (patchwork-style): a tag, a title, its own frame, rasters and
/// layers (`None` = every layer of the spec).
pub struct Panel {
    pub tag: String,
    pub title: String,
    pub layout: Layout,
    pub rasters: Vec<MapRaster>,
    pub layers: Option<Vec<String>>,
    /// Layers only this panel draws (a facet: the subset of features for this panel's value).
    pub own: Vec<MapLayer>,
}

const GUTTER: f64 = 26.0;
const PANEL_TITLE: f64 = 30.0;
const PANEL_LEGEND_W: f64 = LEGEND_W;

/// Page size and each panel's frame rectangle for `n` extents in a grid, like R patchwork's
/// `wrap_plots(ncol = …)`: equal cells in rows, each frame shaped like its extent so a panel shows
/// exactly its area. `own_legends` gives each cell room for its own legend; otherwise one legend is
/// collected on the right of the page (`guides = "collect"`).
pub fn panel_grid(extents: &[[f64; 4]], ncol: Option<usize>, own_legends: bool) -> (f64, f64, Vec<[f64; 4]>) {
    let n = extents.len().max(1);
    let aspect = |e: &[f64; 4]| {
        let (a, b) = (merc(e[0], e[1]), merc(e[2], e[3]));
        ((a[1] - b[1]).abs() / (b[0] - a[0]).abs().max(1e-12)).clamp(0.35, 2.5)
    };
    let mut asp: Vec<f64> = extents.iter().map(aspect).collect();
    asp.sort_by(|a, b| a.total_cmp(b));
    let a = asp[asp.len() / 2];
    // columns: a landscape page about 1.4 : 1 (tall panels sit side by side, wide ones stack)
    let ncol = ncol.filter(|&c| c > 0).unwrap_or_else(|| ((1.4 * a * n as f64).sqrt().round() as usize).clamp(1, n)).min(n);
    let nrow = n.div_ceil(ncol);
    let fw = match ncol {
        1 => 1100.0,
        2 => 720.0,
        3 => 560.0,
        _ => 460.0,
    } * if own_legends { 0.85 } else { 1.0 };
    let fh = (fw * a).clamp(260.0, 1200.0);
    let cell_w = fw + if own_legends { 14.0 + PANEL_LEGEND_W } else { 0.0 };
    let cell_h = PANEL_TITLE + fh;
    let w = 2.0 * MARGIN + ncol as f64 * cell_w + (ncol - 1) as f64 * GUTTER + if own_legends { 0.0 } else { 18.0 + LEGEND_W };
    let h = HEADER + nrow as f64 * cell_h + (nrow - 1) as f64 * GUTTER + FOOTER + 8.0;
    let rects = (0..n)
        .map(|i| {
            let (r, c) = (i / ncol, i % ncol);
            [MARGIN + c as f64 * (cell_w + GUTTER), HEADER + r as f64 * (cell_h + GUTTER) + PANEL_TITLE, fw, fh]
        })
        .collect();
    (w, h, rects)
}

/// A multi-panel map page: one title block, panels tagged (a), (b), … each with its title and scale
/// bar, one north arrow, and either one collected legend or a legend beside each panel.
pub fn render_panels(spec: &MapSpec, panels: &[Panel], w: f64, h: f64, own_legends: bool) -> MapOut {
    let mut svg = String::with_capacity(512 * 1024);
    let _ = write!(
        svg,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w:.0}\" height=\"{h:.0}\" viewBox=\"0 0 {w:.0} {h:.0}\" font-family=\"{FONT}\"><rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>"
    );
    let (mut drawn, mut n_labels) = (0, 0);
    let mut max_denom: f64 = 0.0;
    for (i, p) in panels.iter().enumerate() {
        let keep = |l: &&MapLayer| l.context || p.layers.as_ref().is_none_or(|ids| ids.contains(&l.id));
        let sub = MapSpec {
            rasters: Vec::new(),
            title: String::new(),
            subtitle: String::new(),
            credits: String::new(),
            layers: Vec::new(),
            labels: spec.labels,
            grid: spec.grid,
            frames: Vec::new(),
            furniture: spec.furniture.clone(),
            inset: None,
        };
        // draw_frame reads layers from the spec: borrow the panel's subset without copying features
        let lay = &p.layout;
        let shown: Vec<&MapLayer> = spec.layers.iter().filter(keep).chain(p.own.iter()).collect();
        // one north arrow for the page (first panel), a scale bar in every panel
        let mut pf = spec.furniture.clone();
        if i > 0 {
            pf.north_at = furniture::Place::Off;
        }
        pf.inset_at = furniture::Place::Off;
        pf.legend = "right".into();
        let pl = furniture::place(&pf, &shown, lay);
        let obstacles = furniture::obstacles(&pl, lay, None);
        let (d, l) = draw_frame_with(&mut svg, &sub, &shown, &p.rasters, lay, &[], &format!("panel{i}"), &obstacles);
        drawn += d;
        n_labels += l;
        let _ = write!(
            svg,
            "<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"17\" fill=\"#14212b\"><tspan font-weight=\"bold\">{}</tspan> {}</text>",
            lay.fx,
            lay.fy - 9.0,
            if p.tag.is_empty() { String::new() } else { format!("({})", esc(&p.tag)) },
            esc(&p.title)
        );
        let psub = MapSpec { furniture: pf, ..sub };
        draw_furniture(&mut svg, &psub, lay, &pl);
        if own_legends {
            let legend_layers: Vec<&MapLayer> = shown.iter().rev().filter(|l| !l.context).copied().collect();
            legend(&mut svg, &legend_layers, &p.rasters, lay.fx + lay.fw + 14.0, lay.fy - 26.0, lay.fy + lay.fh, &spec.furniture);
        }
        max_denom = max_denom.max(lay.scale_denominator());
    }
    let _ = write!(
        svg,
        "<text x=\"{MARGIN}\" y=\"50\" font-size=\"30\" font-weight=\"bold\" fill=\"#14212b\">{}</text><text x=\"{MARGIN}\" y=\"78\" font-size=\"15\" fill=\"#4a5a68\">{}</text>",
        esc(&spec.title),
        esc(&spec.subtitle)
    );
    if !own_legends {
        let legend_layers: Vec<&MapLayer> = spec.layers.iter().rev().filter(|l| !l.context).collect();
        let x = w - MARGIN - LEGEND_W;
        if spec.furniture.legend != "none" {
            legend(&mut svg, &legend_layers, panels.first().map(|p| p.rasters.as_slice()).unwrap_or(&[]), x, HEADER, h - FOOTER, &spec.furniture);
        }
    }
    let max_chars = ((w - 2.0 * MARGIN) / (11.0 * 0.6)) as usize;
    let _ = write!(
        svg,
        "<text x=\"{MARGIN}\" y=\"{:.1}\" font-size=\"11\" fill=\"#6b7785\">{}</text><text x=\"{MARGIN}\" y=\"{:.1}\" font-size=\"11\" fill=\"#6b7785\">{} panels · each with its own scale bar · Web Mercator · WGS 84 · north is up</text></svg>",
        h - 22.0,
        esc(&truncate(&spec.credits, max_chars)),
        h - 8.0,
        panels.len()
    );
    MapOut { svg, drawn, labels: n_labels, scale_denominator: max_denom }
}

fn round_sig(v: f64, digits: i32) -> f64 {
    if v <= 0.0 || !v.is_finite() {
        return v;
    }
    let p = 10f64.powi(v.log10().floor() as i32 - digits + 1);
    (v / p).round() * p
}

#[allow(clippy::type_complexity)]
fn draw_layer<'a>(
    svg: &mut String,
    l: &'a MapLayer,
    lay: &Layout,
    clip: [f64; 4],
    labels: &mut Labeler,
    point_layers: &mut Vec<(&'a MapLayer, Vec<(usize, [f64; 2])>)>,
) -> usize {
    let sym = l.style.get("symbology").cloned().unwrap_or(Value::Null);
    let opacity = l.style.get("opacity").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.05, 1.0);
    let outline = l.style.get("outline").and_then(Value::as_bool).unwrap_or(l.kind == GeomKind::Polygon);
    let colorer = Colorer::new(&sym);
    let fidx = colorer.field().and_then(|f| l.fs.field(f));
    let color_of = |i: usize| -> String {
        if l.context {
            return String::new();
        }
        colorer.color(fidx.map(|k| &l.fs.feats[i].props[k]))
    };
    let role = device_role(&l.id);
    let mut drawn = 0;
    let mut b = Buckets::default();
    let tol = 0.35;
    match l.kind {
        GeomKind::Polygon => {
            for (i, f) in l.fs.feats.iter().enumerate() {
                let Geom::Polygons(ps) = &f.geom else { continue };
                let mut d = String::new();
                for p in ps {
                    for ring in p {
                        let px: Vec<[f64; 2]> = ring.iter().map(|c| lay.px(*c)).collect();
                        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
                        for q in &px {
                            x0 = x0.min(q[0]);
                            y0 = y0.min(q[1]);
                            x1 = x1.max(q[0]);
                            y1 = y1.max(q[1]);
                        }
                        if x1 < clip[0] || y1 < clip[1] || x0 > clip[2] || y0 > clip[3] || (x1 - x0 < 0.4 && y1 - y0 < 0.4) {
                            continue;
                        }
                        let c = clip_ring(&px, clip);
                        let s = simplify(&c, tol);
                        if s.len() >= 3 {
                            path_of(&s, true, &mut d);
                        }
                    }
                }
                if !d.is_empty() {
                    b.get(&color_of(i)).push_str(&d);
                    drawn += 1;
                }
            }
            let (cf, cs, cw) = context_paint(&l.id, l.kind);
            for key in &b.order {
                let d = &b.paths[key];
                if l.context {
                    let _ = write!(svg, "<path d=\"{d}\" fill=\"{cf}\" fill-rule=\"evenodd\" stroke=\"{cs}\" stroke-width=\"{cw}\"/>");
                } else {
                    // no outline: a hairline in the fill colour hides anti-aliasing seams between cells
                    let stroke = if outline {
                        "stroke=\"#ffffff\" stroke-width=\"0.7\" stroke-opacity=\"0.9\"".to_string()
                    } else {
                        format!("stroke=\"{key}\" stroke-width=\"0.6\" stroke-opacity=\"{opacity:.2}\"")
                    };
                    let _ = write!(svg, "<path d=\"{d}\" fill=\"{key}\" fill-opacity=\"{opacity:.2}\" fill-rule=\"evenodd\" {stroke}/>");
                }
            }
        }
        GeomKind::Line if l.style.get("width").and_then(Value::as_f64).is_some() && !l.context => {
            // thin cartographic lines (contours): no casing; index lines (index = 1) twice as wide
            let w0 = l.style["width"].as_f64().unwrap_or(0.7);
            let color = l.style["symbology"]["color"].as_str().unwrap_or("#8a5a32");
            let ix = l.fs.field("index");
            let (mut thin, mut bold) = (String::new(), String::new());
            for f in &l.fs.feats {
                let Geom::Lines(ls) = &f.geom else { continue };
                let target = if ix.is_some_and(|k| f.props[k].as_f64() == Some(1.0)) { &mut bold } else { &mut thin };
                for line in ls {
                    let px: Vec<[f64; 2]> = line.iter().map(|c| lay.px(*c)).collect();
                    for part in clip_line(&px, clip) {
                        let s = simplify(&part, tol);
                        if s.len() >= 2 {
                            path_of(&s, false, target);
                        }
                    }
                }
                drawn += 1;
            }
            for (d, w) in [(&thin, w0), (&bold, w0 * 2.2)] {
                if !d.is_empty() {
                    let _ = write!(svg, "<path d=\"{d}\" fill=\"none\" stroke=\"{color}\" stroke-opacity=\"{opacity:.2}\" stroke-width=\"{w:.2}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>");
                }
            }
        }
        GeomKind::Line => {
            for (i, f) in l.fs.feats.iter().enumerate() {
                let Geom::Lines(ls) = &f.geom else { continue };
                let mut d = String::new();
                for line in ls {
                    let px: Vec<[f64; 2]> = line.iter().map(|c| lay.px(*c)).collect();
                    for part in clip_line(&px, clip) {
                        let s = simplify(&part, tol);
                        if s.len() >= 2 {
                            path_of(&s, false, &mut d);
                        }
                    }
                }
                if !d.is_empty() {
                    b.get(&color_of(i)).push_str(&d);
                    drawn += 1;
                }
            }
            let (_, cs, cw) = context_paint(&l.id, l.kind);
            let width = if role == Some("tracks") { 3.0 } else { 1.8 };
            for key in &b.order {
                let d = &b.paths[key];
                if l.context {
                    let _ = write!(svg, "<path d=\"{d}\" fill=\"none\" stroke=\"{cs}\" stroke-width=\"{cw}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>");
                } else {
                    let _ = write!(
                        svg,
                        "<path d=\"{d}\" fill=\"none\" stroke=\"#ffffff\" stroke-opacity=\"0.9\" stroke-width=\"{:.1}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\
<path d=\"{d}\" fill=\"none\" stroke=\"{key}\" stroke-opacity=\"{opacity:.2}\" stroke-width=\"{width}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
                        width + 2.6
                    );
                }
            }
        }
        GeomKind::Point | GeomKind::Unknown => {
            let n: usize = l.fs.feats.iter().map(|f| if let Geom::Points(p) = &f.geom { p.len() } else { 1 }).sum();
            if n > 30_000 {
                return density(svg, l, lay);
            }
            let device = role.is_some();
            let (r, stroke_w) = if device { (5.5, 1.6) } else if n > 3000 { (1.6, 0.0) } else if n > 500 { (2.6, 0.5) } else { (4.0, 0.9) };
            let dir_idx = if role == Some("photos") { l.fs.field("direction") } else { None };
            let mut wedges = String::new();
            let mut pts = Vec::new();
            for (i, f) in l.fs.feats.iter().enumerate() {
                let coords: Vec<[f64; 2]> = match &f.geom {
                    Geom::Points(p) => p.clone(),
                    g => super::features::anchor(g).into_iter().collect(),
                };
                let color = color_of(i);
                for c in coords {
                    let p = lay.px(c);
                    if p[0] < clip[0] || p[1] < clip[1] || p[0] > clip[2] || p[1] > clip[3] {
                        continue;
                    }
                    // camera direction wedge for photos (where the photo looks)
                    if let Some(dir) = dir_idx.and_then(|k| f.props[k].as_f64()) {
                        let (a0, a1, rr) = ((dir - 24.0).to_radians(), (dir + 24.0).to_radians(), 20.0);
                        let _ = write!(
                            wedges,
                            "M{:.1} {:.1}L{:.1} {:.1}A{rr} {rr} 0 0 1 {:.1} {:.1}Z",
                            p[0],
                            p[1],
                            p[0] + rr * a0.sin(),
                            p[1] - rr * a0.cos(),
                            p[0] + rr * a1.sin(),
                            p[1] - rr * a1.cos()
                        );
                    }
                    circle_path(p, r, b.get(&color));
                    labels.obstacle([p[0] - r, p[1] - r, p[0] + r, p[1] + r]);
                    pts.push((i, p));
                    drawn += 1;
                }
            }
            if !wedges.is_empty() {
                let c = colorer.color(None);
                let _ = write!(svg, "<path d=\"{wedges}\" fill=\"{}\" fill-opacity=\"0.28\" stroke=\"none\"/>", if c == NULL_COLOR { "#ff8c42" } else { &c });
            }
            let stroke = if device { "#ffffff" } else { "#1d2731" };
            for key in &b.order {
                let d = &b.paths[key];
                if stroke_w > 0.0 {
                    let _ = write!(svg, "<path d=\"{d}\" fill=\"{key}\" fill-opacity=\"{opacity:.2}\" stroke=\"{stroke}\" stroke-width=\"{stroke_w}\"/>");
                } else {
                    let _ = write!(svg, "<path d=\"{d}\" fill=\"{key}\" fill-opacity=\"{opacity:.2}\"/>");
                }
            }
            point_layers.push((l, pts));
        }
    }
    drawn
}

/// Too many points to draw one by one: a density grid (6 px cells, log colour scale).
fn density(svg: &mut String, l: &MapLayer, lay: &Layout) -> usize {
    let cell = 6.0;
    let mut grid: HashMap<(i32, i32), u32> = HashMap::new();
    for f in &l.fs.feats {
        let Some(c) = super::features::anchor(&f.geom) else { continue };
        let p = lay.px(c);
        if p[0] < lay.fx || p[1] < lay.fy || p[0] > lay.fx + lay.fw || p[1] > lay.fy + lay.fh {
            continue;
        }
        *grid.entry((((p[0] - lay.fx) / cell) as i32, ((p[1] - lay.fy) / cell) as i32)).or_default() += 1;
    }
    let max = grid.values().copied().max().unwrap_or(1).max(2) as f64;
    let colors = super::automap::ramp_colors("ylorrd", 5);
    let mut b = Buckets::default();
    for ((cx, cy), n) in &grid {
        let t = ((*n as f64).ln() / max.ln()).clamp(0.0, 1.0);
        let k = ((t * 4.0).round() as usize).min(4);
        let _ = write!(b.get(&colors[k]), "M{:.1} {:.1}h{cell}v{cell}h-{cell}Z", lay.fx + *cx as f64 * cell, lay.fy + *cy as f64 * cell);
    }
    for key in &b.order {
        let _ = write!(svg, "<path d=\"{}\" fill=\"{key}\" fill-opacity=\"0.9\"/>", b.paths[key]);
    }
    grid.len()
}

fn graticule(svg: &mut String, lay: &Layout) {
    let v = lay.view();
    let span = (v[2] - v[0]).max(v[3] - v[1]);
    let steps = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 15.0, 30.0];
    let step = steps.iter().copied().find(|s| span / s <= 6.0).unwrap_or(30.0);
    let decimals = (-step.log10().floor()).max(0.0) as usize;
    let mut d = String::new();
    let mut text = String::new();
    let mut lon = (v[0] / step).ceil() * step;
    while lon < v[2] {
        let a = lay.px([lon, v[1]]);
        let _ = write!(d, "M{:.1} {:.1}V{:.1}", a[0], lay.fy, lay.fy + lay.fh);
        if a[0] < lay.fx + 36.0 || a[0] > lay.fx + lay.fw - 90.0 {
            lon += step;
            continue; // label would be clipped or hit the north arrow
        }
        let _ = write!(text, "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\">{:.*}°{}</text>", a[0], lay.fy + 13.0, decimals, lon.abs(), if lon < 0.0 { 'W' } else { 'E' });
        lon += step;
    }
    let mut lat = (v[1] / step).ceil() * step;
    while lat < v[3] {
        let a = lay.px([v[0], lat]);
        let _ = write!(d, "M{:.1} {:.1}H{:.1}", lay.fx, a[1], lay.fx + lay.fw);
        if a[1] < lay.fy + 24.0 || a[1] > lay.fy + lay.fh - 70.0 {
            lat += step;
            continue;
        }
        let _ = write!(text, "<text x=\"{:.1}\" y=\"{:.1}\">{:.*}°{}</text>", lay.fx + 5.0, a[1] - 3.0, decimals, lat.abs(), if lat < 0.0 { 'S' } else { 'N' });
        lat += step;
    }
    let _ = write!(
        svg,
        "<path d=\"{d}\" stroke=\"#5d6d7a\" stroke-opacity=\"0.28\" stroke-width=\"0.7\" fill=\"none\"/>\
<g font-size=\"10\" fill=\"#51606c\" stroke=\"#ffffff\" stroke-width=\"2.5\" paint-order=\"stroke\">{text}</g>"
    );
}

fn swatch(svg: &mut String, kind: GeomKind, x: f64, y: f64, color: &str, role: Option<&str>, opacity: f64) {
    match kind {
        GeomKind::Polygon => {
            let _ = write!(svg, "<rect x=\"{x:.1}\" y=\"{:.1}\" width=\"20\" height=\"13\" fill=\"{color}\" fill-opacity=\"{opacity:.2}\" stroke=\"#56636e\" stroke-width=\"0.6\"/>", y - 10.0);
        }
        GeomKind::Line => {
            let w = if role == Some("tracks") { 3.0 } else { 2.0 };
            let _ = write!(
                svg,
                "<path d=\"M{x:.1} {:.1}h20\" stroke=\"#c7ced4\" stroke-width=\"{:.1}\" stroke-linecap=\"round\"/><path d=\"M{x:.1} {:.1}h20\" stroke=\"{color}\" stroke-width=\"{w}\" stroke-linecap=\"round\"/>",
                y - 4.0,
                w + 2.4,
                y - 4.0
            );
        }
        _ => {
            let stroke = if role.is_some() { "#56636e" } else { "#1d2731" };
            let _ = write!(svg, "<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"5.5\" fill=\"{color}\" stroke=\"{stroke}\" stroke-width=\"0.9\"/>", x + 10.0, y - 4.0);
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n - 1).collect::<String>()) }
}

/// The legend at (x, y0), down to max_y; returns where it ended. Titles, hidden layers, renamed class
/// labels and the order come from the furniture's legend edits.
fn legend(svg: &mut String, layers: &[&MapLayer], rasters: &[MapRaster], x: f64, y0: f64, max_y: f64, fur: &Furniture) -> f64 {
    let shown: Vec<&MapRaster> = rasters.iter().rev().filter(|r| r.legend["type"] != "none" && !fur.edit_for(&r.id).1).collect();
    let mut layers: Vec<&MapLayer> = layers.iter().copied().filter(|l| !fur.edit_for(&l.id).1).collect();
    if !fur.legend_order.is_empty() {
        let rank = |id: &str| fur.legend_order.iter().position(|o| o == id || id.ends_with(&format!(".{o}"))).unwrap_or(usize::MAX);
        layers.sort_by_key(|l| rank(&l.id));
    }
    if layers.is_empty() && shown.is_empty() {
        return y0;
    }
    let mut y = y0 + 16.0;
    if !fur.legend_title.is_empty() {
        let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"17\" font-weight=\"bold\" fill=\"#14212b\">{}</text>", esc(&fur.legend_title));
        y += 28.0;
    } else {
        y += 4.0;
    }
    let row = 20.0;
    for l in layers {
        let (title, _, renames) = fur.edit_for(&l.id);
        let rename = |t: &str| -> String {
            for (old, new) in &renames {
                if let Some(rest) = t.strip_prefix(old.as_str()) {
                    return format!("{new}{rest}");
                }
            }
            t.to_string()
        };
        if y > max_y - 30.0 {
            let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"12\" fill=\"#6b7785\">…</text>");
            break;
        }
        let role = device_role(&l.id);
        let op = l.style.get("opacity").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.2, 1.0);
        let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"13\" font-weight=\"bold\" fill=\"#1b2631\">{}</text>", esc(&truncate(title.as_deref().unwrap_or(&l.title), 34)));
        y += row;
        let sym = l.style.get("symbology").cloned().unwrap_or(Value::Null);
        let text = |svg: &mut String, y: f64, t: &str| {
            let _ = write!(svg, "<text x=\"{:.1}\" y=\"{y:.1}\" font-size=\"12\" fill=\"#33414e\">{}</text>", x + 30.0, esc(&truncate(&rename(t), 32)));
        };
        if l.fs.feats.len() > 30_000 && l.kind == GeomKind::Point {
            let colors = super::automap::ramp_colors("ylorrd", 5);
            for (i, c) in colors.iter().enumerate() {
                let _ = write!(svg, "<rect x=\"{:.1}\" y=\"{:.1}\" width=\"12\" height=\"12\" fill=\"{c}\"/>", x + i as f64 * 12.0, y - 10.0);
            }
            let _ = write!(svg, "<text x=\"{:.1}\" y=\"{y:.1}\" font-size=\"12\" fill=\"#33414e\">density: few → many points</text>", x + 70.0);
            y += row + 8.0;
            continue;
        }
        match sym.get("kind").and_then(Value::as_str) {
            Some("unique") => {
                let field = sym["field"].as_str().unwrap_or("");
                let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"11\" fill=\"#6b7785\">by {}</text>", esc(field));
                y += row - 3.0;
                for c in sym["classes"].as_array().into_iter().flatten().take(12) {
                    if y > max_y - 12.0 {
                        break;
                    }
                    swatch(svg, l.kind, x, y, c["color"].as_str().unwrap_or(NULL_COLOR), role, op);
                    text(svg, y, &format!("{}  ({})", super::recipe::value_text(&c["value"]), c["count"]));
                    y += row;
                }
                let others = sym["othersCount"].as_u64().unwrap_or(0);
                if others > 0 {
                    swatch(svg, l.kind, x, y, sym["other"].as_str().unwrap_or("#9aa5b1"), role, op);
                    text(svg, y, &format!("other  ({others})"));
                    y += row;
                }
            }
            Some("graduated") => {
                let field = sym["field"].as_str().unwrap_or("");
                let method = match sym["method"].as_str().unwrap_or("") {
                    "jenks" => "natural breaks",
                    "quantile" => "quantiles",
                    "guideline" => "WHO 24-h guideline · IT = interim target",
                    _ => "equal intervals",
                };
                let labels: Vec<&str> = sym["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"11\" fill=\"#6b7785\">{} · {method}</text>", esc(field));
                y += row - 3.0;
                let breaks: Vec<f64> = sym["breaks"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
                let colors: Vec<&str> = sym["colors"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let counts: Vec<u64> = sym["counts"].as_array().into_iter().flatten().filter_map(Value::as_u64).collect();
                let mut lo = sym["min"].as_f64().unwrap_or(0.0);
                for (i, b) in breaks.iter().enumerate() {
                    if y > max_y - 12.0 {
                        break;
                    }
                    swatch(svg, l.kind, x, y, colors.get(i).copied().unwrap_or(NULL_COLOR), role, op);
                    let count = counts.get(i).map(|c| format!("  ({c})")).unwrap_or_default();
                    let note = labels.get(i).map(|n| format!(" · {n}")).unwrap_or_default();
                    text(svg, y, &format!("{} – {}{note}{count}", fmt_num(lo), fmt_num(*b)));
                    lo = *b;
                    y += row;
                }
            }
            _ => {
                let color = sym.get("color").and_then(Value::as_str).unwrap_or("#9aa5b1");
                swatch(svg, l.kind, x, y, color, role, op);
                text(svg, y, &l.legend_note);
                y += row;
            }
        }
        y += 10.0;
    }
    raster_legend(svg, &shown, x, y, max_y)
}

fn raster_legend(svg: &mut String, rasters: &[&MapRaster], x: f64, mut y: f64, max_y: f64) -> f64 {
    let row = 20.0;
    for (i, r) in rasters.iter().enumerate() {
        if y > max_y - 40.0 {
            break;
        }
        let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"13\" font-weight=\"bold\" fill=\"#1b2631\">{}</text>", esc(&truncate(&r.title, 34)));
        y += row - 2.0;
        let lg = &r.legend;
        match lg["type"].as_str().unwrap_or("") {
            "ramp" => {
                let colors: Vec<&str> = lg["colors"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let n = colors.len().max(2) - 1;
                let _ = write!(svg, "<defs><linearGradient id=\"rl{i}\" x1=\"0\" x2=\"1\" y1=\"0\" y2=\"0\">");
                for (k, c) in colors.iter().enumerate() {
                    let _ = write!(svg, "<stop offset=\"{:.3}\" stop-color=\"{c}\"/>", k as f64 / n as f64);
                }
                let _ = write!(svg, "</linearGradient></defs><rect x=\"{x:.1}\" y=\"{:.1}\" width=\"220\" height=\"13\" fill=\"url(#rl{i})\" stroke=\"#8a96a3\" stroke-width=\"0.6\"/>", y - 10.0);
                let u = lg["units"].as_str().unwrap_or("");
                let lab = |v: &Value| v.as_f64().map(|f| format!("{}{}", fmt_num(round_sig(f, 3)), if u.is_empty() { String::new() } else if u == "°" { u.to_string() } else { format!(" {u}") })).unwrap_or_default();
                y += 15.0;
                let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"11\" fill=\"#33414e\">{}</text><text x=\"{:.1}\" y=\"{y:.1}\" font-size=\"11\" fill=\"#33414e\" text-anchor=\"end\">{}</text>", esc(&lab(&lg["min"])), x + 220.0, esc(&lab(&lg["max"])));
                y += row;
            }
            "classes" => {
                for c in lg["items"].as_array().into_iter().flatten().take(14) {
                    if y > max_y - 12.0 {
                        break;
                    }
                    let _ = write!(svg, "<rect x=\"{x:.1}\" y=\"{:.1}\" width=\"18\" height=\"12\" fill=\"{}\" stroke=\"#8a96a3\" stroke-width=\"0.5\"/>", y - 10.0, c["color"].as_str().unwrap_or("#888888"));
                    let _ = write!(svg, "<text x=\"{:.1}\" y=\"{y:.1}\" font-size=\"12\" fill=\"#33414e\">{}</text>", x + 30.0, esc(&truncate(c["label"].as_str().unwrap_or(""), 34)));
                    y += row;
                }
            }
            _ => {
                let _ = write!(svg, "<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"11\" fill=\"#6b7785\">{}</text>", esc(&truncate(lg["label"].as_str().unwrap_or(""), 40)));
                y += row;
            }
        }
        y += 8.0;
    }
    y
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn draw_rasters(svg: &mut String, rasters: &[MapRaster], lay: &Layout) {
    for r in rasters {
        let blend = r.blend.as_deref().map(|b| format!(" style=\"mix-blend-mode:{b}\"")).unwrap_or_default();
        let _ = write!(
            svg,
            "<image x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" preserveAspectRatio=\"none\" opacity=\"{:.2}\"{blend} href=\"data:image/png;base64,{}\"/>",
            lay.fx,
            lay.fy,
            lay.fw,
            lay.fh,
            r.opacity,
            base64(&r.png)
        );
    }
}

/// The map frame's Web Mercator box [xmin, ymin, xmax, ymax] (rasters are rendered for it).
pub fn frame_merc(lay: &Layout) -> [f64; 4] {
    let bl = lay.lonlat(lay.fx, lay.fy + lay.fh);
    let tr = lay.lonlat(lay.fx + lay.fw, lay.fy);
    // metres (EPSG:3857), not the normalised tile space of this module's merc()
    let (a, b) = (crate::raster::merc(bl[0], bl[1]), crate::raster::merc(tr[0], tr[1]));
    [a[0], a[1], b[0], b[1]]
}

pub(crate) fn fonts() -> std::sync::Arc<resvg::usvg::fontdb::Database> {
    use std::sync::{Arc, OnceLock};
    static FONTS: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = resvg::usvg::fontdb::Database::new();
            db.load_system_fonts();
            // Windows edition / portable ZIP: DejaVu Sans ships in <exe dir>\fonts so maps look the same everywhere
            if let Some(dir) = crate::exe_dir() {
                db.load_fonts_dir(dir.join("fonts"));
            }
            db.set_sans_serif_family("DejaVu Sans");
            Arc::new(db)
        })
        .clone()
}

/// Vector PDF of the map page (text stays selectable; the page is sized for 150 dpi).
pub fn svg_to_pdf(svg: &str) -> Result<Vec<u8>, String> {
    use krilla_svg::SurfaceExt;
    let opt = resvg::usvg::Options { fontdb: fonts(), ..Default::default() };
    let tree = resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| format!("SVG: {e}"))?;
    let (w, h) = (tree.size().width() * 72.0 / DPI as f32, tree.size().height() * 72.0 / DPI as f32);
    let mut doc = krilla::Document::new();
    {
        let mut page = doc.start_page_with(krilla::page::PageSettings::from_wh(w, h).ok_or("bad page size")?);
        let mut surface = page.surface();
        surface.draw_svg(&tree, krilla::geom::Size::from_wh(w, h).ok_or("bad page size")?, krilla_svg::SvgSettings { embed_text: true, filter_scale: 2.0 }).ok_or("the map could not be drawn into the PDF")?;
        surface.finish();
        page.finish();
    }
    doc.finish().map_err(|e| format!("PDF: {e:?}"))
}

/// Several map pages (SVG) as one multi-page PDF, in order; each page keeps its own size.
pub fn svgs_to_pdf(svgs: &[String]) -> Result<Vec<u8>, String> {
    use krilla_svg::SurfaceExt;
    let opt = resvg::usvg::Options { fontdb: fonts(), ..Default::default() };
    let mut doc = krilla::Document::new();
    for svg in svgs {
        let tree = resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| format!("SVG: {e}"))?;
        let (w, h) = (tree.size().width() * 72.0 / DPI as f32, tree.size().height() * 72.0 / DPI as f32);
        let mut page = doc.start_page_with(krilla::page::PageSettings::from_wh(w, h).ok_or("bad page size")?);
        let mut surface = page.surface();
        surface.draw_svg(&tree, krilla::geom::Size::from_wh(w, h).ok_or("bad page size")?, krilla_svg::SvgSettings { embed_text: true, filter_scale: 2.0 }).ok_or("a map page could not be drawn into the PDF")?;
        surface.finish();
        page.finish();
    }
    doc.finish().map_err(|e| format!("PDF: {e:?}"))
}

/// Rasterise the SVG (system fonts are loaded once per process).
pub fn svg_to_png(svg: &str, scale: f32) -> Result<Vec<u8>, String> {
    use resvg::{tiny_skia, usvg};
    let opt = usvg::Options { fontdb: fonts(), ..Default::default() };
    let tree = usvg::Tree::from_str(svg, &opt).map_err(|e| format!("SVG: {e}"))?;
    let size = tree.size().to_int_size();
    let (w, h) = ((size.width() as f32 * scale).ceil() as u32, (size.height() as f32 * scale).ceil() as u32);
    let mut pm = tiny_skia::Pixmap::new(w, h).ok_or("cannot allocate the image")?;
    pm.fill(tiny_skia::Color::WHITE);
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pm.as_mut());
    pm.encode_png().map_err(|e| format!("PNG: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_pdf_has_one_page_per_map() {
        let page = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/></svg>"##.to_string();
        let pdf = svgs_to_pdf(&[page.clone(), page.clone(), page]).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        let t = text.replace("/Type /", "/Type/");
        assert_eq!(t.matches("/Type/Page").count() - t.matches("/Type/Pages").count(), 3);
    }

    #[test]
    fn clipping_and_simplification() {
        let r = [0.0, 0.0, 10.0, 10.0];
        let ring = vec![[-5.0, -5.0], [15.0, -5.0], [15.0, 15.0], [-5.0, 15.0]];
        let c = clip_ring(&ring, r);
        assert!(c.iter().all(|p| p[0] >= 0.0 && p[0] <= 10.0 && p[1] >= 0.0 && p[1] <= 10.0));
        assert_eq!(c.len(), 4);
        let parts = clip_line(&[[-5.0, 5.0], [5.0, 5.0], [15.0, 5.0], [20.0, 20.0]], r);
        assert_eq!(parts, vec![vec![[0.0, 5.0], [5.0, 5.0], [10.0, 5.0]]]);
        let line: Vec<[f64; 2]> = (0..100).map(|i| [i as f64, (i % 2) as f64 * 0.1]).collect();
        assert_eq!(simplify(&line, 0.35).len(), 2);
    }

    #[test]
    fn layout_scale_and_numbers() {
        let lay = Layout::new([144.20, -5.90, 144.28, -5.82], 1600.0, 1100.0);
        let v = lay.view();
        assert!(v[0] < 144.20 && v[2] > 144.28 && v[1] < -5.90 && v[3] > -5.82, "{v:?}");
        let p = lay.px([144.24, -5.86]);
        let back = lay.lonlat(p[0], p[1]);
        assert!((back[0] - 144.24).abs() < 1e-9 && (back[1] + 5.86).abs() < 1e-9);
        // ~11 km across ~1250 px -> ~10 m per px
        assert!((5.0..20.0).contains(&lay.meters_per_px()), "{}", lay.meters_per_px());
        assert_eq!(fmt_num(1234567.0), "1,234,567");
        assert_eq!(fmt_num(12.5), "12.5");
        assert_eq!(fmt_num(5.20), "5.2");
        assert_eq!(round_sig(23456.0, 2), 23000.0);
        assert_eq!(page_size("a4", [0.0, 0.0, 1.0, 1.0]), (1754.0, 1240.0));
    }
}
