//! Small inline SVG charts for reports: the fitted variogram behind a kriged surface and the
//! distance search behind a hot spot map, so the automatic choices can be seen, not just read.
//! They are drawn the way ggplot2 draws: a theme (theme_grey by default, or bw, minimal, classic,
//! light, dark) and a discrete palette (ggplot2's hue palette by default), both chosen in Settings
//! and shared with the app's own charts and with R (the R prelude calls theme_set with the same).

use super::cartography::{esc, fmt_num};
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::sync::RwLock;

pub enum Kind {
    /// dots, optionally sized (radius in px per point)
    Dots(Option<Vec<f64>>),
    Line,
    Dashed,
}

pub struct Series {
    pub label: String,
    pub color: String,
    pub width: f64,
    pub kind: Kind,
    pub points: Vec<(f64, f64)>,
}

pub struct Chart {
    pub x_label: String,
    pub y_label: String,
    pub series: Vec<Series>,
    /// vertical reference lines: (x, label, colour)
    pub marks: Vec<(f64, String, String)>,
    /// horizontal reference lines: (y, label)
    pub hlines: Vec<(f64, String)>,
    /// force the y axis to start at zero
    pub y_zero: bool,
}

fn nice(range: f64, target: usize) -> f64 {
    let raw = (range / target.max(1) as f64).max(1e-12);
    let p = 10f64.powf(raw.log10().floor());
    let m = raw / p;
    p * if m <= 1.0 {
        1.0
    } else if m <= 2.0 {
        2.0
    } else if m <= 2.5 {
        2.5
    } else if m <= 5.0 {
        5.0
    } else {
        10.0
    }
}

/// The chart look chosen in Settings (kept in `<state>/charts.json`).
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    pub theme: String,
    pub palette: String,
    pub base_size: f64,
}

impl Default for Style {
    fn default() -> Self {
        Style { theme: "grey".into(), palette: "ggplot2".into(), base_size: 11.0 }
    }
}

pub const THEMES: &[&str] = &["grey", "bw", "minimal", "classic", "light", "dark"];
pub const PALETTES: &[&str] = &["ggplot2", "viridis", "okabe-ito", "set2", "dark2"];

static STYLE: RwLock<Option<Style>> = RwLock::new(None);

pub fn style() -> Style {
    STYLE.read().unwrap().clone().unwrap_or_default()
}

impl Style {
    pub fn json(&self) -> Value {
        json!({ "theme": self.theme, "palette": self.palette, "base_size": self.base_size, "themes": THEMES, "palettes": PALETTES })
    }
    /// A style from JSON, keeping what is valid and the defaults for the rest.
    pub fn from_json(v: &Value) -> Style {
        let d = Style::default();
        let pick = |k: &str, list: &[&str], dflt: String| v[k].as_str().filter(|t| list.contains(t)).map(str::to_string).unwrap_or(dflt);
        Style {
            theme: pick("theme", THEMES, d.theme),
            palette: pick("palette", PALETTES, d.palette),
            base_size: v["base_size"].as_f64().filter(|b| (6.0..=24.0).contains(b)).unwrap_or(d.base_size),
        }
    }
}

/// Read the saved style at start.
pub fn load(state: &std::path::Path) {
    let v = std::fs::read(state.join("charts.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or(Value::Null);
    *STYLE.write().unwrap() = Some(Style::from_json(&v));
}

/// Save a new style (from Settings); R steps pick it up through GEOSPAX_CHART_* (sidecar.rs).
pub fn save(state: &std::path::Path, v: &Value) -> Result<Style, String> {
    let st = Style::from_json(v);
    std::fs::create_dir_all(state).map_err(|e| e.to_string())?;
    std::fs::write(state.join("charts.json"), serde_json::to_vec_pretty(&st.json()).unwrap()).map_err(|e| e.to_string())?;
    *STYLE.write().unwrap() = Some(st.clone());
    Ok(st)
}

/// sRGB hex of an HCL colour (CIE LCh(uv), D65), as R's grDevices::hcl() and so scales::hue_pal().
fn hcl(h: f64, c: f64, l: f64) -> String {
    let (un, vn) = (0.197_839_8, 0.468_336_1); // D65 white point u', v'
    let y = if l > 8.0 { ((l + 16.0) / 116.0).powi(3) } else { l / 903.3 };
    let (hr, u, v) = (h.to_radians(), 0.0, 0.0);
    let (u, v) = (u + c * hr.cos(), v + c * hr.sin());
    let (up, vp) = if l > 0.0 { (u / (13.0 * l) + un, v / (13.0 * l) + vn) } else { (un, vn) };
    let x = 9.0 * y * up / (4.0 * vp);
    let z = -x / 3.0 - 5.0 * y + 3.0 * y / vp;
    let lin = [3.240_454 * x - 1.537_138_5 * y - 0.498_531_4 * z, -0.969_266 * x + 1.876_010_8 * y + 0.041_556 * z, 0.055_643_4 * x - 0.204_025_9 * y + 1.057_225_2 * z];
    let g = |t: f64| {
        let t = if t > 0.003_130_8 { 1.055 * t.powf(1.0 / 2.4) - 0.055 } else { 12.92 * t };
        (t.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    format!("#{:02X}{:02X}{:02X}", g(lin[0]), g(lin[1]), g(lin[2]))
}

/// `n` colours of a palette, as ggplot2 would give them.
pub fn palette(name: &str, n: usize) -> Vec<String> {
    let fixed: &[&str] = match name {
        "viridis" => &["#440154", "#3B528B", "#21908C", "#5DC863", "#FDE725", "#482878", "#2C728E", "#27AD81"],
        "okabe-ito" => &["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#999999"],
        "set2" => &["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
        "dark2" => &["#1B9E77", "#D95F02", "#7570B3", "#E7298A", "#66A61E", "#E6AB02", "#A6761D", "#666666"],
        _ => &[],
    };
    if !fixed.is_empty() {
        // viridis is sequential: spread the n colours over the whole ramp, as scale_colour_viridis_d
        if name == "viridis" {
            let ramp = ["#440154", "#482878", "#3E4A89", "#31688E", "#26828E", "#1F9E89", "#35B779", "#6DCD59", "#B4DE2C", "#FDE725"];
            return (0..n).map(|i| ramp[if n <= 1 { 0 } else { i * (ramp.len() - 1) / (n - 1).max(1) }].to_string()).collect();
        }
        return (0..n).map(|i| fixed[i % fixed.len()].to_string()).collect();
    }
    // scales::hue_pal(h = c(0, 360) + 15, c = 100, l = 65)
    let n = n.max(1);
    (0..n).map(|i| hcl(15.0 + 360.0 * i as f64 / n as f64, 100.0, 65.0)).collect()
}

/// What a ggplot2 theme draws: panel fill and border, grid, axis lines and ticks, text colours.
struct Look {
    bg: &'static str,
    panel: Option<&'static str>,
    border: Option<&'static str>,
    grid: Option<(&'static str, f64)>,
    axis_line: Option<&'static str>,
    ticks: bool,
    text: &'static str,
    tick_text: &'static str,
}

fn look(theme: &str) -> Look {
    match theme {
        "bw" => Look { bg: "#FFFFFF", panel: Some("#FFFFFF"), border: Some("#333333"), grid: Some(("#EBEBEB", 1.1)), axis_line: None, ticks: true, text: "#000000", tick_text: "#4D4D4D" },
        "minimal" => Look { bg: "#FFFFFF", panel: None, border: None, grid: Some(("#EBEBEB", 1.1)), axis_line: None, ticks: false, text: "#000000", tick_text: "#4D4D4D" },
        "classic" => Look { bg: "#FFFFFF", panel: None, border: None, grid: None, axis_line: Some("#000000"), ticks: true, text: "#000000", tick_text: "#4D4D4D" },
        "light" => Look { bg: "#FFFFFF", panel: Some("#FFFFFF"), border: Some("#B3B3B3"), grid: Some(("#DEDEDE", 0.55)), axis_line: None, ticks: true, text: "#000000", tick_text: "#4D4D4D" },
        "dark" => Look { bg: "#FFFFFF", panel: Some("#7F7F7F"), border: None, grid: Some(("#6B6B6B", 1.1)), axis_line: None, ticks: true, text: "#000000", tick_text: "#4D4D4D" },
        // theme_grey (theme_gray), ggplot2's default
        _ => Look { bg: "#FFFFFF", panel: Some("#EBEBEB"), border: None, grid: Some(("#FFFFFF", 1.1)), axis_line: None, ticks: true, text: "#000000", tick_text: "#4D4D4D" },
    }
}

/// A colour of the chart: "@0", "@1" … are the palette's colours, anything else is used as given.
fn colour(c: &str, pal: &[String]) -> String {
    c.strip_prefix('@').and_then(|i| i.parse::<usize>().ok()).and_then(|i| pal.get(i).cloned()).unwrap_or_else(|| c.to_string())
}

/// A 680 × 320 chart in the chosen ggplot2 theme, legend on the right as ggplot2 puts it.
pub fn svg(c: &Chart) -> String {
    svg_styled(c, &style())
}

pub fn svg_styled(c: &Chart, st: &Style) -> String {
    let lk = look(&st.theme);
    let n_pal = c.series.iter().map(|s| &s.color).chain(c.marks.iter().map(|m| &m.2)).filter_map(|c| c.strip_prefix('@')?.parse::<usize>().ok()).max().map(|m| m + 1).unwrap_or(1);
    let pal = palette(&st.palette, n_pal);
    let fs = st.base_size * 1.15; // pt → px at 96 dpi on a 680 px wide figure
    let small = fs * 0.8;
    let legend: Vec<&Series> = c.series.iter().filter(|s| !s.label.is_empty()).collect();
    let char_w = small * 0.55;
    let leg_w = if legend.is_empty() { 0.0 } else { 34.0 + legend.iter().map(|s| s.label.chars().count() as f64 * char_w).fold(0.0, f64::max).min(240.0) };
    let w = 680.0;
    let h = 320.0;
    let (l, r, t, b) = (14.0 + fs + 46.0, 12.0 + leg_w, 12.0, 18.0 + fs * 2.4);
    let pts = c.series.iter().flat_map(|s| s.points.iter()).filter(|p| p.0.is_finite() && p.1.is_finite());
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for p in pts {
        x0 = x0.min(p.0);
        x1 = x1.max(p.0);
        y0 = y0.min(p.1);
        y1 = y1.max(p.1);
    }
    for (x, _, _) in &c.marks {
        x0 = x0.min(*x);
        x1 = x1.max(*x);
    }
    for (y, _) in &c.hlines {
        y0 = y0.min(*y);
        y1 = y1.max(*y);
    }
    if x0 > x1 {
        (x0, x1, y0, y1) = (0.0, 1.0, 0.0, 1.0);
    }
    x0 = x0.min(0.0);
    if c.y_zero {
        y0 = y0.min(0.0);
    }
    if y1 - y0 < 1e-12 {
        y1 = y0 + 1.0;
    }
    // ggplot2 expands continuous scales by 5 % on each side
    let (xe, ye) = ((x1 - x0) * 0.05, (y1 - y0) * 0.05);
    let (xs, ys) = (nice(x1 - x0, 5), nice(y1 - y0, 5));
    let (x0, x1, y0, y1) = (x0 - xe, x1 + xe, y0 - ye, y1 + ye);
    let px = |x: f64| l + (x - x0) / (x1 - x0) * (w - l - r);
    let py = |y: f64| h - b - (y - y0) / (y1 - y0) * (h - t - b);
    let (pl, pr, pt_, pb) = (l, w - r, t, h - b);
    let mut s = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\" style=\"width:100%;height:auto;display:block\" font-family=\"'DejaVu Sans', Arial, sans-serif\"><rect width=\"{w}\" height=\"{h}\" fill=\"{}\"/>",
        lk.bg
    );
    if let Some(f) = lk.panel {
        let _ = write!(s, "<rect x=\"{pl:.1}\" y=\"{pt_:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"{f}\"/>", pr - pl, pb - pt_);
    }
    // grid: major lines at the breaks, minor halfway between (thinner), as ggplot2
    let first = |lo: f64, step: f64| (lo / step).ceil() * step;
    let xb: Vec<f64> = std::iter::successors(Some(first(x0, xs)), |v| Some(v + xs)).take_while(|v| *v <= x1 + 1e-9).collect();
    let yb: Vec<f64> = std::iter::successors(Some(first(y0, ys)), |v| Some(v + ys)).take_while(|v| *v <= y1 + 1e-9).collect();
    if let Some((gc, gw)) = lk.grid {
        for v in std::iter::successors(Some(first(x0, xs / 2.0)), |v| Some(v + xs / 2.0)).take_while(|v| *v <= x1) {
            let _ = write!(s, "<line x1=\"{0:.1}\" y1=\"{pt_:.1}\" x2=\"{0:.1}\" y2=\"{pb:.1}\" stroke=\"{gc}\" stroke-width=\"{1}\"/>", px(v), gw / 2.0);
        }
        for v in std::iter::successors(Some(first(y0, ys / 2.0)), |v| Some(v + ys / 2.0)).take_while(|v| *v <= y1) {
            let _ = write!(s, "<line x1=\"{pl:.1}\" y1=\"{0:.1}\" x2=\"{pr:.1}\" y2=\"{0:.1}\" stroke=\"{gc}\" stroke-width=\"{1}\"/>", py(v), gw / 2.0);
        }
        for v in &xb {
            let _ = write!(s, "<line x1=\"{0:.1}\" y1=\"{pt_:.1}\" x2=\"{0:.1}\" y2=\"{pb:.1}\" stroke=\"{gc}\" stroke-width=\"{gw}\"/>", px(*v));
        }
        for v in &yb {
            let _ = write!(s, "<line x1=\"{pl:.1}\" y1=\"{0:.1}\" x2=\"{pr:.1}\" y2=\"{0:.1}\" stroke=\"{gc}\" stroke-width=\"{gw}\"/>", py(*v));
        }
    }
    if let Some(bc) = lk.border {
        let _ = write!(s, "<rect x=\"{pl:.1}\" y=\"{pt_:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"none\" stroke=\"{bc}\" stroke-width=\"1\"/>", pr - pl, pb - pt_);
    }
    if let Some(ac) = lk.axis_line {
        let _ = write!(s, "<line x1=\"{pl:.1}\" y1=\"{pb:.1}\" x2=\"{pr:.1}\" y2=\"{pb:.1}\" stroke=\"{ac}\"/><line x1=\"{pl:.1}\" y1=\"{pt_:.1}\" x2=\"{pl:.1}\" y2=\"{pb:.1}\" stroke=\"{ac}\"/>");
    }
    let tick = if lk.ticks { 3.7 } else { 0.0 };
    for v in &xb {
        if lk.ticks {
            let _ = write!(s, "<line x1=\"{0:.1}\" y1=\"{pb:.1}\" x2=\"{0:.1}\" y2=\"{1:.1}\" stroke=\"#333333\"/>", px(*v), pb + tick);
        }
        let _ = write!(s, "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" font-size=\"{small:.1}\" fill=\"{}\">{}</text>", px(*v), pb + tick + small + 2.0, lk.tick_text, fmt_num(*v));
    }
    for v in &yb {
        if lk.ticks {
            let _ = write!(s, "<line x1=\"{0:.1}\" y1=\"{1:.1}\" x2=\"{pl:.1}\" y2=\"{1:.1}\" stroke=\"#333333\"/>", pl - tick, py(*v));
        }
        let _ = write!(s, "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"end\" font-size=\"{small:.1}\" fill=\"{}\">{}</text>", pl - tick - 3.0, py(*v) + small * 0.35, lk.tick_text, fmt_num(*v));
    }
    let _ = write!(s, "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" font-size=\"{fs:.1}\" fill=\"{}\">{}</text>", (pl + pr) / 2.0, h - 6.0, lk.text, esc(&c.x_label));
    let _ = write!(s, "<text transform=\"translate({:.1} {:.1}) rotate(-90)\" text-anchor=\"middle\" font-size=\"{fs:.1}\" fill=\"{}\">{}</text>", fs + 2.0, (pt_ + pb) / 2.0, lk.text, esc(&c.y_label));
    for (yv, label) in &c.hlines {
        let _ = write!(s, "<line x1=\"{pl:.1}\" y1=\"{0:.1}\" x2=\"{pr:.1}\" y2=\"{0:.1}\" stroke=\"#4D4D4D\" stroke-dasharray=\"4 3\"/><text x=\"{1:.1}\" y=\"{2:.1}\" text-anchor=\"end\" font-size=\"{small:.1}\" fill=\"#4D4D4D\">{3}</text>", py(*yv), pr - 4.0, py(*yv) - 4.0, esc(label));
    }
    for (xv, label, color) in &c.marks {
        let col = colour(color, &pal);
        let _ = write!(s, "<line x1=\"{0:.1}\" y1=\"{pt_:.1}\" x2=\"{0:.1}\" y2=\"{pb:.1}\" stroke=\"{1}\" stroke-width=\"1.5\" stroke-dasharray=\"6 4\"/><text x=\"{2:.1}\" y=\"{3:.1}\" font-size=\"{small:.1}\" fill=\"{1}\">{4}</text>", px(*xv), esc(&col), px(*xv) + 5.0, pt_ + small + 4.0, esc(label));
    }
    for se in &c.series {
        let col = esc(&colour(&se.color, &pal));
        match &se.kind {
            Kind::Dots(sizes) => {
                for (i, p) in se.points.iter().enumerate() {
                    if !(p.0.is_finite() && p.1.is_finite()) {
                        continue;
                    }
                    let rad = sizes.as_ref().and_then(|v| v.get(i)).copied().unwrap_or(3.0);
                    let _ = write!(s, "<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"{rad:.1}\" fill=\"{col}\"/>", px(p.0), py(p.1));
                }
            }
            Kind::Line | Kind::Dashed => {
                let d: Vec<String> = se.points.iter().filter(|p| p.0.is_finite() && p.1.is_finite()).map(|p| format!("{:.1},{:.1}", px(p.0), py(p.1))).collect();
                if d.len() > 1 {
                    let dash = if matches!(se.kind, Kind::Dashed) { " stroke-dasharray=\"6 4\"" } else { "" };
                    let _ = write!(s, "<polyline points=\"{}\" fill=\"none\" stroke=\"{col}\" stroke-width=\"{}\" stroke-linejoin=\"round\"{dash}/>", d.join(" "), se.width);
                }
            }
        }
    }
    // legend on the right, keys on grey boxes as ggplot2's theme_grey (white for the other themes)
    if !legend.is_empty() {
        let lx = pr + 14.0;
        let mut ly = pt_ + (pb - pt_) / 2.0 - legend.len() as f64 * 11.0;
        let key_bg = if st.theme == "grey" || st.theme == "dark" { "#F2F2F2" } else { "#FFFFFF" };
        for se in legend {
            let col = esc(&colour(&se.color, &pal));
            let _ = write!(s, "<rect x=\"{lx:.1}\" y=\"{ly:.1}\" width=\"17\" height=\"17\" fill=\"{key_bg}\"/>");
            let (cx, cy) = (lx + 8.5, ly + 8.5);
            let sw = match se.kind {
                Kind::Dots(_) => format!("<circle cx=\"{cx:.1}\" cy=\"{cy:.1}\" r=\"3\" fill=\"{col}\"/>"),
                Kind::Line => format!("<line x1=\"{:.1}\" y1=\"{cy:.1}\" x2=\"{:.1}\" y2=\"{cy:.1}\" stroke=\"{col}\" stroke-width=\"{}\"/>", lx + 1.5, lx + 15.5, se.width),
                Kind::Dashed => format!("<line x1=\"{:.1}\" y1=\"{cy:.1}\" x2=\"{:.1}\" y2=\"{cy:.1}\" stroke=\"{col}\" stroke-width=\"{}\" stroke-dasharray=\"4 2\"/>", lx + 1.5, lx + 15.5, se.width),
            };
            let _ = write!(s, "{sw}<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"{small:.1}\" fill=\"{}\">{}</text>", lx + 22.0, ly + 12.5, lk.text, esc(&se.label));
            ly += 22.0;
        }
    }
    s.push_str("</svg>");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chart_is_valid_svg_with_series_and_marks() {
        let c = Chart {
            x_label: "distance (m)".into(),
            y_label: "semivariance".into(),
            series: vec![
                Series { label: "pairs".into(), color: "#33414d".into(), width: 1.0, kind: Kind::Dots(Some(vec![3.0, 5.0])), points: vec![(100.0, 0.2), (200.0, 0.5)] },
                Series { label: "spherical".into(), color: "#c0392b".into(), width: 2.0, kind: Kind::Line, points: vec![(0.0, 0.1), (300.0, 0.6)] },
            ],
            marks: vec![(250.0, "range 250 m".into(), "#c0392b".into())],
            hlines: vec![(0.6, "sill".into())],
            y_zero: true,
        };
        let s = svg(&c);
        assert!(s.starts_with("<svg") && s.ends_with("</svg>"));
        assert_eq!(s.matches("<circle").count(), 3); // two dots + legend swatch
        assert!(s.contains("range 250 m") && s.contains("polyline"));
        resvg::usvg::Tree::from_str(&s, &resvg::usvg::Options::default()).expect("parses");
    }

    #[test]
    fn ggplot2_hue_palette_matches_scales() {
        // scales::hue_pal()(3) in R: "#F8766D" "#00BA38" "#619CFF"
        assert_eq!(palette("ggplot2", 3), vec!["#F8766D", "#00BA38", "#619CFF"]);
        assert_eq!(palette("ggplot2", 2), vec!["#F8766D", "#00BFC4"]);
        for th in THEMES {
            let c = Chart { x_label: "x".into(), y_label: "y".into(), series: vec![Series { label: "a".into(), color: "@0".into(), width: 1.0, kind: Kind::Line, points: vec![(0.0, 1.0), (1.0, 2.0)] }], marks: vec![], hlines: vec![], y_zero: false };
            let s = svg_styled(&c, &Style { theme: th.to_string(), ..Default::default() });
            resvg::usvg::Tree::from_str(&s, &resvg::usvg::Options::default()).expect("parses");
        }
    }
}
