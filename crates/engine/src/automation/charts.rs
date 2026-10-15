//! Small inline SVG charts for reports: the fitted variogram behind a kriged surface and the
//! distance search behind a hot spot map, so the automatic choices can be seen, not just read.

use super::cartography::{esc, fmt_num};
use std::fmt::Write as _;

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

/// A 680 × 300 chart that scales with the page width.
pub fn svg(c: &Chart) -> String {
    let (w, h) = (680.0, 300.0);
    let (l, r, t, b) = (64.0, 18.0, 30.0, 46.0);
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
    let (xs, ys) = (nice(x1 - x0, 6), nice(y1 - y0, 5));
    let (x0, x1) = ((x0 / xs).floor() * xs, (x1 / xs).ceil() * xs);
    let (y0, y1) = ((y0 / ys).floor() * ys, ((y1 + (y1 - y0) * 0.04) / ys).ceil() * ys);
    let px = |x: f64| l + (x - x0) / (x1 - x0) * (w - l - r);
    let py = |y: f64| h - b - (y - y0) / (y1 - y0) * (h - t - b);
    let mut s = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" style=\"width:100%;height:auto;display:block;font:12px 'DejaVu Sans',sans-serif\"><rect width=\"{w}\" height=\"{h}\" fill=\"#fff\"/>"
    );
    // grid and ticks
    let mut x = x0;
    while x <= x1 + xs * 0.01 {
        let _ = write!(s, "<line x1=\"{0:.1}\" y1=\"{t}\" x2=\"{0:.1}\" y2=\"{1:.1}\" stroke=\"#e6eaee\"/><text x=\"{0:.1}\" y=\"{2:.1}\" text-anchor=\"middle\" fill=\"#5b6b78\">{3}</text>", px(x), h - b, h - b + 16.0, fmt_num(x));
        x += xs;
    }
    let mut y = y0;
    while y <= y1 + ys * 0.01 {
        let _ = write!(s, "<line x1=\"{l}\" y1=\"{0:.1}\" x2=\"{1:.1}\" y2=\"{0:.1}\" stroke=\"#e6eaee\"/><text x=\"{2:.1}\" y=\"{3:.1}\" text-anchor=\"end\" fill=\"#5b6b78\">{4}</text>", py(y), w - r, l - 6.0, py(y) + 4.0, fmt_num(y));
        y += ys;
    }
    let _ = write!(s, "<line x1=\"{l}\" y1=\"{0:.1}\" x2=\"{1:.1}\" y2=\"{0:.1}\" stroke=\"#8a96a3\"/><line x1=\"{l}\" y1=\"{t}\" x2=\"{l}\" y2=\"{0:.1}\" stroke=\"#8a96a3\"/>", h - b, w - r);
    let _ = write!(s, "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" fill=\"#33414d\">{}</text>", (l + w - r) / 2.0, h - 8.0, esc(&c.x_label));
    let _ = write!(s, "<text transform=\"translate(14 {:.1}) rotate(-90)\" text-anchor=\"middle\" fill=\"#33414d\">{}</text>", (t + h - b) / 2.0, esc(&c.y_label));
    for (yv, label) in &c.hlines {
        let _ = write!(s, "<line x1=\"{l}\" y1=\"{0:.1}\" x2=\"{1:.1}\" y2=\"{0:.1}\" stroke=\"#8a96a3\" stroke-dasharray=\"2 3\"/><text x=\"{2:.1}\" y=\"{3:.1}\" text-anchor=\"end\" fill=\"#5b6b78\">{4}</text>", py(*yv), w - r, w - r - 4.0, py(*yv) - 4.0, esc(label));
    }
    for (xv, label, color) in &c.marks {
        let _ = write!(s, "<line x1=\"{0:.1}\" y1=\"{t}\" x2=\"{0:.1}\" y2=\"{1:.1}\" stroke=\"{2}\" stroke-width=\"1.5\" stroke-dasharray=\"5 4\"/><text x=\"{3:.1}\" y=\"{4:.1}\" fill=\"{2}\">{5}</text>", px(*xv), h - b, esc(color), px(*xv) + 5.0, t + 12.0, esc(label));
    }
    for se in &c.series {
        match &se.kind {
            Kind::Dots(sizes) => {
                for (i, p) in se.points.iter().enumerate() {
                    if !(p.0.is_finite() && p.1.is_finite()) {
                        continue;
                    }
                    let rad = sizes.as_ref().and_then(|v| v.get(i)).copied().unwrap_or(3.5);
                    let _ = write!(s, "<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"{rad:.1}\" fill=\"{}\" fill-opacity=\"0.85\" stroke=\"#fff\" stroke-width=\"0.8\"/>", px(p.0), py(p.1), esc(&se.color));
                }
            }
            Kind::Line | Kind::Dashed => {
                let d: Vec<String> = se.points.iter().filter(|p| p.0.is_finite() && p.1.is_finite()).map(|p| format!("{:.1},{:.1}", px(p.0), py(p.1))).collect();
                if d.len() > 1 {
                    let dash = if matches!(se.kind, Kind::Dashed) { " stroke-dasharray=\"6 4\"" } else { "" };
                    let _ = write!(s, "<polyline points=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\"{dash}/>", d.join(" "), esc(&se.color), se.width);
                }
            }
        }
    }
    // legend (top left, inside the plot)
    let mut ly = t + 4.0;
    for se in c.series.iter().filter(|s| !s.label.is_empty()) {
        let sw = match se.kind {
            Kind::Dots(_) => format!("<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"4\" fill=\"{}\"/>", l + 18.0, ly + 6.0, esc(&se.color)),
            Kind::Line => format!("<line x1=\"{:.1}\" y1=\"{:.1}\" x2=\"{:.1}\" y2=\"{:.1}\" stroke=\"{}\" stroke-width=\"{}\"/>", l + 10.0, ly + 6.0, l + 26.0, ly + 6.0, esc(&se.color), se.width),
            Kind::Dashed => format!("<line x1=\"{:.1}\" y1=\"{:.1}\" x2=\"{:.1}\" y2=\"{:.1}\" stroke=\"{}\" stroke-width=\"{}\" stroke-dasharray=\"6 4\"/>", l + 10.0, ly + 6.0, l + 26.0, ly + 6.0, esc(&se.color), se.width),
        };
        let _ = write!(s, "{sw}<text x=\"{:.1}\" y=\"{:.1}\" fill=\"#33414d\">{}</text>", l + 32.0, ly + 10.0, esc(&se.label));
        ly += 17.0;
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
}
