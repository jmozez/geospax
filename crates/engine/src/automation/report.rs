//! One-page HTML report (docs/AUTOMATION.md §2 `export.report`): the map, headline numbers, an
//! auto-written "how this map was made" section, every automatic decision with its reason, the
//! run log and provenance. Self-contained (inline CSS and SVG), so it opens anywhere, offline.

use super::cartography::esc;
use serde_json::Value;
use std::fmt::Write as _;

pub struct LayerSummary {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub features: u64,
    pub rows: Vec<(String, String)>,
}

pub struct ReportInput {
    pub title: String,
    pub subtitle: String,
    pub map_svg: Option<String>,
    pub map_files: Vec<String>,
    pub cards: Vec<(String, String)>,
    pub methods: Vec<String>,
    pub decisions: Vec<(String, String)>,
    pub layers: Vec<LayerSummary>,
    pub steps: Vec<Value>,
    pub provenance: Vec<(String, String)>,
    pub notes: Option<String>,
    /// 3D views (scene.3d): a still picture plus links to the viewer and the model
    pub views: Vec<View3d>,
    /// Inline SVG charts: (title, svg, caption)
    pub charts: Vec<(String, String, String)>,
    /// Further maps of the run (after the main one), as PNG pictures
    pub figures: Vec<Figure>,
    /// the same report as a Word document, next to this one (linked at the top)
    pub word: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Figure {
    pub png: Vec<u8>,
    pub title: String,
    pub file: String,
}

#[derive(Clone, Debug)]
pub struct View3d {
    pub jpeg: Vec<u8>,
    pub caption: String,
    /// interactive viewer and glTF file names (next to the report)
    pub html: String,
    pub glb: String,
}

const CSS: &str = r#"
*{box-sizing:border-box}body{margin:0;font:15px/1.5 "DejaVu Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1b2631;background:#eef1f4}
main{max-width:1180px;margin:0 auto;padding:28px 22px 60px}
header h1{margin:0;font-size:28px;line-height:1.2}header p{margin:6px 0 0;color:#4a5a68}
.badge{display:inline-block;background:#ff6b35;color:#fff;border-radius:10px;padding:1px 9px;font-size:12px;font-weight:600;vertical-align:middle;margin-left:8px}
.card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(20,33,43,.12);padding:18px 20px;margin-top:18px}
.map svg{width:100%;height:auto;display:block;border-radius:6px}
.files a{margin-right:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:18px}
.cards div{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 1px 3px rgba(20,33,43,.12)}
.cards b{display:block;font-size:24px;color:#14212b}.cards span{color:#5b6b78;font-size:13px}
h2{font-size:18px;margin:0 0 10px}
ul.methods li{margin:4px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e8ec;vertical-align:top}
th{color:#5b6b78;font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:#2e8b57;font-weight:600}.failed{color:#c0392b;font-weight:600}.skipped{color:#8a96a3}
code{background:#f1f4f7;border-radius:4px;padding:1px 5px;font-size:12.5px}
footer{color:#6b7785;font-size:12px;margin-top:26px}
"#;

pub fn render(r: &ReportInput) -> String {
    let mut h = String::with_capacity(64 * 1024);
    let _ = write!(
        h,
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>{}</title><style>{CSS}</style></head><body><main><header><h1>{}<span class=\"badge\">made automatically</span></h1><p>{}</p></header>",
        esc(&r.title),
        esc(&r.title),
        esc(&r.subtitle)
    );
    if let Some(w) = &r.word {
        let _ = write!(h, "<p class=\"files\">Edit this report: <a href=\"{w}\" download>Word document ({w})</a></p>", w = esc(w));
    }
    if !r.cards.is_empty() {
        h.push_str("<section class=\"cards\">");
        for (big, label) in &r.cards {
            let _ = write!(h, "<div><b>{}</b><span>{}</span></div>", esc(big), esc(label));
        }
        h.push_str("</section>");
    }
    if let Some(svg) = &r.map_svg {
        let _ = write!(h, "<section class=\"card map\">{svg}");
        if !r.map_files.is_empty() {
            h.push_str("<p class=\"files\">Download: ");
            for f in &r.map_files {
                let _ = write!(h, "<a href=\"{}\" download>{}</a>", esc(f), esc(f));
            }
            h.push_str("</p>");
        }
        h.push_str("</section>");
    }
    for v in &r.views {
        let _ = write!(
            h,
            "<section class=\"card map\"><h2>3D view</h2><a href=\"{html}\" title=\"Open the interactive 3D view\"><img alt=\"3D view\" style=\"width:100%;height:auto;display:block;border-radius:6px\" src=\"data:image/jpeg;base64,{}\"></a><p class=\"files\">{} · Open: <a href=\"{html}\">interactive 3D ({html})</a><a href=\"{glb}\" download>3D model ({glb}, glTF)</a></p></section>",
            super::cartography::base64(&v.jpeg),
            esc(&v.caption),
            html = esc(&v.html),
            glb = esc(&v.glb)
        );
    }
    for f in &r.figures {
        let _ = write!(
            h,
            "<section class=\"card map\"><h2>{}</h2><img alt=\"{}\" style=\"width:100%;height:auto;display:block;border-radius:6px\" src=\"data:image/png;base64,{}\"><p class=\"files\">Download: <a href=\"{file}\" download>{file}</a></p></section>",
            esc(&f.title),
            esc(&f.title),
            super::cartography::base64(&f.png),
            file = esc(&f.file)
        );
    }
    for (title, svg, caption) in &r.charts {
        let _ = write!(h, "<section class=\"card chart\"><h2>{}</h2>{svg}<p class=\"files\">{}</p></section>", esc(title), esc(caption));
    }
    if let Some(n) = &r.notes {
        let _ = write!(h, "<section class=\"card\"><h2>Notes</h2><p>{}</p></section>", esc(n));
    }
    if !r.methods.is_empty() {
        h.push_str("<section class=\"card\"><h2>How this map was made</h2><ul class=\"methods\">");
        for m in &r.methods {
            let _ = write!(h, "<li>{}</li>", esc(m));
        }
        h.push_str("</ul></section>");
    }
    if !r.decisions.is_empty() {
        h.push_str("<section class=\"card\"><h2>Automatic decisions</h2><table><tr><th>Layer</th><th>Decision and why</th></tr>");
        for (l, why) in &r.decisions {
            let _ = write!(h, "<tr><td><code>{}</code></td><td>{}</td></tr>", esc(l), esc(why));
        }
        h.push_str("</table></section>");
    }
    if !r.layers.is_empty() {
        h.push_str("<section class=\"card\"><h2>Data</h2><table><tr><th>Layer</th><th>Type</th><th class=\"num\">Features</th><th>Details</th></tr>");
        for l in &r.layers {
            let rows: Vec<String> = l.rows.iter().map(|(k, v)| format!("{}: <b>{}</b>", esc(k), esc(v))).collect();
            let _ = write!(
                h,
                "<tr><td>{}<br><code>{}</code></td><td>{}</td><td class=\"num\">{}</td><td>{}</td></tr>",
                esc(&l.title),
                esc(&l.id),
                esc(&l.kind),
                super::cartography::fmt_num(l.features as f64),
                rows.join("<br>")
            );
        }
        h.push_str("</table></section>");
    }
    if !r.steps.is_empty() {
        h.push_str("<section class=\"card\"><h2>Run log</h2><table><tr><th>Step</th><th>Tool</th><th>Status</th><th class=\"num\">Time</th><th>Result</th></tr>");
        for s in &r.steps {
            let status = s["status"].as_str().unwrap_or("");
            let class = match status {
                "done" => "ok",
                "failed" => "failed",
                _ => "skipped",
            };
            let why: Vec<String> = s["why"].as_array().into_iter().flatten().filter_map(Value::as_str).map(esc).collect();
            let detail = if let Some(e) = s["error"].as_str() { esc(e) } else { why.join("<br>") };
            let _ = write!(
                h,
                "<tr><td><code>{}</code></td><td><code>{}</code></td><td class=\"{class}\">{}</td><td class=\"num\">{}</td><td>{}</td></tr>",
                esc(s["id"].as_str().unwrap_or("")),
                esc(s["use"].as_str().unwrap_or("")),
                esc(status),
                s["ms"].as_f64().map(|m| if m >= 1000.0 { format!("{:.1} s", m / 1000.0) } else { format!("{m:.0} ms") }).unwrap_or_default(),
                detail
            );
        }
        h.push_str("</table></section>");
    }
    if !r.provenance.is_empty() {
        h.push_str("<section class=\"card\"><h2>Provenance</h2><table>");
        for (k, v) in &r.provenance {
            let _ = write!(h, "<tr><th>{}</th><td><code>{}</code></td></tr>", esc(k), esc(v));
        }
        h.push_str("</table></section>");
    }
    h.push_str("<footer>Generated by GeoSpaX. Re-run the recipe to reproduce this report exactly; the recipe and its inputs are listed under Provenance.</footer></main></body></html>");
    h
}
