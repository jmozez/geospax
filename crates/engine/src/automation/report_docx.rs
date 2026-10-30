//! The report as a Word document (report.docx), next to report.html: the same title, map, numbers,
//! method notes, decisions, data and provenance, as real headings, paragraphs, tables and pictures, so
//! it can be edited in Word, LibreOffice or Google Docs. The run log stays in the HTML report.

use super::report::ReportInput;
use std::fmt::Write as _;
use std::io::Write as _;

/// width of the picture on an A4 page with 2.5 cm margins, in EMU (16 cm)
const PAGE_EMU: u64 = 5_760_000;

fn x(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// width and height of a PNG from its header
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

fn para(style: Option<&str>, text: &str) -> String {
    let p = style
        .map(|s| format!("<w:pPr><w:pStyle w:val=\"{s}\"/></w:pPr>"))
        .unwrap_or_default();
    format!(
        "<w:p>{p}<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        x(text)
    )
}

fn cell(text: &str, bold: bool) -> String {
    let rpr = if bold { "<w:rPr><w:b/></w:rPr>" } else { "" };
    format!(
        "<w:tc><w:p><w:r>{rpr}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:p></w:tc>",
        x(text)
    )
}

fn table(head: &[&str], rows: &[Vec<String>]) -> String {
    let mut t = String::from(
        "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"5000\" w:type=\"pct\"/></w:tblPr>",
    );
    if !head.is_empty() {
        t.push_str("<w:tr>");
        for h in head {
            t.push_str(&cell(h, true));
        }
        t.push_str("</w:tr>");
    }
    for r in rows {
        t.push_str("<w:tr>");
        for c in r {
            t.push_str(&cell(c, false));
        }
        t.push_str("</w:tr>");
    }
    t.push_str("</w:tbl>");
    t
}

fn picture(rid: &str, id: usize, name: &str, (w, h): (u32, u32)) -> String {
    let cx = PAGE_EMU;
    let cy = (PAGE_EMU as f64 * h as f64 / w as f64).round() as u64;
    format!(
        "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/>\
<wp:docPr id=\"{id}\" name=\"{n}\"/><a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{n}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
        n = x(name)
    )
}

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="4A5A68"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="5B6B78"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:hanging="240"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="C9D1D8"/><w:left w:val="single" w:sz="4" w:color="C9D1D8"/><w:bottom w:val="single" w:sz="4" w:color="C9D1D8"/><w:right w:val="single" w:sz="4" w:color="C9D1D8"/><w:insideH w:val="single" w:sz="4" w:color="C9D1D8"/><w:insideV w:val="single" w:sz="4" w:color="C9D1D8"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>"#;

/// The report as a .docx file. `map_png` is the main map; `r.figures` and `r.views` follow it.
pub fn render(r: &ReportInput, map_png: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut body = String::new();
    let mut media: Vec<(String, Vec<u8>, &'static str)> = Vec::new(); // (file, bytes, extension)
    let mut pic =
        |body: &mut String, bytes: &[u8], ext: &'static str, name: &str, size: (u32, u32)| {
            let n = media.len() + 1;
            let file = format!("image{n}.{ext}");
            body.push_str(&picture(&format!("rIdImg{n}"), n, name, size));
            media.push((file, bytes.to_vec(), ext));
        };

    body.push_str(&para(Some("Title"), &r.title));
    body.push_str(&para(Some("Subtitle"), &r.subtitle));
    if !r.cards.is_empty() {
        let rows: Vec<Vec<String>> = r
            .cards
            .iter()
            .map(|(big, label)| vec![big.clone(), label.clone()])
            .collect();
        body.push_str(&table(&[], &rows));
    }
    if let Some(png) = map_png {
        if let Some(size) = png_size(png) {
            pic(&mut body, png, "png", "Map", size);
            body.push_str(&para(Some("Caption"), &format!("Figure 1. {}", r.title)));
        }
    }
    for (i, f) in r.figures.iter().enumerate() {
        if let Some(size) = png_size(&f.png) {
            body.push_str(&para(Some("Heading1"), &f.title));
            pic(&mut body, &f.png, "png", &f.title, size);
            body.push_str(&para(
                Some("Caption"),
                &format!("Figure {}. {}", i + 2, f.title),
            ));
        }
    }
    for (i, (title, _, caption)) in r.charts.iter().enumerate() {
        if let Some(png) = r.chart_pngs.get(i) {
            if let Some(size) = png_size(png) {
                body.push_str(&para(Some("Heading1"), title));
                pic(&mut body, png, "png", title, size);
                body.push_str(&para(Some("Caption"), caption));
            }
        }
    }
    for v in &r.views {
        // a 3D still is a JPEG; Word needs its size, so it is placed at the page width, 16:9
        body.push_str(&para(Some("Heading1"), "3D view"));
        pic(&mut body, &v.jpeg, "jpeg", "3D view", (16, 9));
        body.push_str(&para(Some("Caption"), &v.caption));
    }
    if let Some(n) = &r.notes {
        body.push_str(&para(Some("Heading1"), "Notes"));
        body.push_str(&para(None, n));
    }
    if !r.methods.is_empty() {
        body.push_str(&para(Some("Heading1"), "How this map was made"));
        for m in &r.methods {
            body.push_str(&para(Some("ListBullet"), &format!("• {m}")));
        }
    }
    if !r.decisions.is_empty() {
        body.push_str(&para(Some("Heading1"), "Automatic decisions"));
        let rows: Vec<Vec<String>> = r
            .decisions
            .iter()
            .map(|(l, why)| vec![l.clone(), why.clone()])
            .collect();
        body.push_str(&table(&["Layer", "Decision and why"], &rows));
    }
    if !r.layers.is_empty() {
        body.push_str(&para(Some("Heading1"), "Data"));
        let rows: Vec<Vec<String>> = r
            .layers
            .iter()
            .map(|l| {
                let details: Vec<String> =
                    l.rows.iter().map(|(k, v)| format!("{k}: {v}")).collect();
                vec![
                    l.title.clone(),
                    l.kind.clone(),
                    super::cartography::fmt_num(l.features as f64),
                    details.join("; "),
                ]
            })
            .collect();
        body.push_str(&table(&["Layer", "Type", "Features", "Details"], &rows));
    }
    if !r.provenance.is_empty() {
        body.push_str(&para(Some("Heading1"), "Provenance"));
        let rows: Vec<Vec<String>> = r
            .provenance
            .iter()
            .map(|(k, v)| vec![k.clone(), v.clone()])
            .collect();
        body.push_str(&table(&[], &rows));
    }
    body.push_str(&para(
        Some("Caption"),
        "Generated by GeoSpaX. The full run log is in report.html next to this file.",
    ));

    let mut doc = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\"><w:body>",
    );
    doc.push_str(&body);
    // A4 portrait, 2.5 cm margins
    doc.push_str("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1418\" w:right=\"1418\" w:bottom=\"1418\" w:left=\"1418\" w:header=\"709\" w:footer=\"709\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>");

    let mut rels = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>",
    );
    for (i, (file, _, _)) in media.iter().enumerate() {
        let _ = write!(
            rels,
            "<Relationship Id=\"rIdImg{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/{file}\"/>",
            i + 1
        );
    }
    rels.push_str("</Relationships>");

    let types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>";
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>";
    let core = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>GeoSpaX</dc:creator></cp:coreProperties>",
        x(&r.title)
    );

    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opt = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let parts: [(&str, &[u8]); 5] = [
            ("[Content_Types].xml", types.as_bytes()),
            ("_rels/.rels", root_rels.as_bytes()),
            ("docProps/core.xml", core.as_bytes()),
            ("word/document.xml", doc.as_bytes()),
            ("word/styles.xml", STYLES.as_bytes()),
        ];
        for (name, data) in parts {
            z.start_file(name, opt).map_err(|e| e.to_string())?;
            z.write_all(data).map_err(|e| e.to_string())?;
        }
        z.start_file("word/_rels/document.xml.rels", opt)
            .map_err(|e| e.to_string())?;
        z.write_all(rels.as_bytes()).map_err(|e| e.to_string())?;
        for (file, bytes, _) in &media {
            // pictures are already compressed
            z.start_file(format!("word/media/{file}"), stored)
                .map_err(|e| e.to_string())?;
            z.write_all(bytes).map_err(|e| e.to_string())?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn input() -> ReportInput {
        ReportInput {
            title: "Hotspots & <roads>".into(),
            subtitle: "Recipe 'finished-map'".into(),
            map_svg: None,
            map_files: vec![],
            cards: vec![("32".into(), "features mapped".into())],
            methods: vec!["laid out automatically".into()],
            decisions: vec![("hotspots".into(), "quantiles".into())],
            layers: vec![],
            steps: vec![],
            provenance: vec![("Recipe".into(), "finished-map".into())],
            notes: None,
            views: vec![],
            charts: vec![],
            chart_files: vec![],
            chart_pngs: vec![],
            figures: vec![],
            word: None,
        }
    }

    #[test]
    fn docx_is_a_zip_with_the_map_and_escaped_text() {
        // a 2×1 PNG header is enough for the size
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&2u32.to_be_bytes());
        png.extend_from_slice(&1u32.to_be_bytes());
        let bytes = render(&input(), Some(&png)).unwrap();
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        z.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert!(doc.contains("Hotspots &amp; &lt;roads&gt;"));
        assert!(
            doc.contains("r:embed=\"rIdImg1\"") && doc.contains("cx=\"5760000\" cy=\"2880000\"")
        );
        assert!(z.by_name("word/media/image1.png").is_ok());
        let mut rels = String::new();
        z.by_name("word/_rels/document.xml.rels")
            .unwrap()
            .read_to_string(&mut rels)
            .unwrap();
        assert!(rels.contains("media/image1.png"));
    }

    #[test]
    fn without_a_map_there_is_no_picture() {
        let bytes = render(&input(), None).unwrap();
        let z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(
            z.file_names()
                .all(|n| !n.unwrap().starts_with("word/media/"))
        );
    }
}
