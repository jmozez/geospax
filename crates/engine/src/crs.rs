//! Coordinate systems from PROJ's database (View › Coordinate system): search by code, name or area,
//! and a system's PROJ string so the web map can show coordinates in it (proj4js).

use serde_json::{json, Value};
use std::ffi::CStr;
use std::sync::OnceLock;

#[derive(Clone)]
pub struct CrsInfo {
    pub code: String,
    pub name: String,
    pub kind: &'static str,
    pub area: String,
    pub bbox: Option<[f64; 4]>,
}

fn text(p: *const std::ffi::c_char) -> String {
    if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().to_string() }
}

/// Every non-deprecated EPSG geographic and projected CRS (read once).
pub fn all() -> &'static [CrsInfo] {
    static LIST: OnceLock<Vec<CrsInfo>> = OnceLock::new();
    LIST.get_or_init(|| {
        let mut out = Vec::new();
        let auth = std::ffi::CString::new("EPSG").unwrap();
        let mut n: std::ffi::c_int = 0;
        // SAFETY: the list is read and destroyed here; strings are copied out first.
        unsafe {
            let list = gdal_sys::OSRGetCRSInfoListFromDatabase(auth.as_ptr(), std::ptr::null(), &mut n);
            if list.is_null() {
                return out;
            }
            for i in 0..n.max(0) as usize {
                let c = &**list.add(i);
                if c.bDeprecated != 0 {
                    continue;
                }
                let kind = match c.eType {
                    gdal_sys::OSRCRSType::OSR_CRS_TYPE_GEOGRAPHIC_2D => "geographic",
                    gdal_sys::OSRCRSType::OSR_CRS_TYPE_PROJECTED => "projected",
                    _ => continue,
                };
                out.push(CrsInfo {
                    code: text(c.pszCode),
                    name: text(c.pszName),
                    kind,
                    area: text(c.pszAreaName),
                    bbox: (c.bBboxValid != 0).then_some([c.dfWestLongitudeDeg, c.dfSouthLatitudeDeg, c.dfEastLongitudeDeg, c.dfNorthLatitudeDeg]),
                });
            }
            gdal_sys::OSRDestroyCRSInfoList(list);
        }
        out
    })
}

/// Search: every word must appear in the code, name or area. With `lon`/`lat`, systems whose area
/// of use holds that point come first (the ones that suit the map's centre).
pub fn search(q: &str, at: Option<(f64, f64)>, limit: usize) -> Value {
    let words: Vec<String> = q.split_whitespace().map(|w| w.to_lowercase()).collect();
    let mut hits: Vec<(i32, &CrsInfo)> = all()
        .iter()
        .filter(|c| {
            let hay = format!("{} {} {}", c.code, c.name, c.area).to_lowercase();
            words.iter().all(|w| hay.contains(w.trim_start_matches("epsg:")))
        })
        .map(|c| {
            let mut s = 0;
            if words.len() == 1 && c.code == words[0].trim_start_matches("epsg:") {
                s += 1000;
            }
            if let (Some((lon, lat)), Some(b)) = (at, c.bbox) {
                if lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] {
                    // the smaller the area of use, the better it fits the place
                    s += 100 - (((b[2] - b[0]) * (b[3] - b[1])).sqrt() as i32).min(99);
                }
            }
            if c.kind == "projected" {
                s += 1;
            }
            (s, c)
        })
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.code.len().cmp(&b.1.code.len())));
    json!({ "total": hits.len(), "systems": hits.iter().take(limit).map(|(_, c)| json!({ "code": format!("EPSG:{}", c.code), "name": c.name, "kind": c.kind, "area": c.area })).collect::<Vec<_>>() })
}

/// One system: its name and PROJ string (for proj4js), or an error for an unknown code.
pub fn describe(code: &str) -> Result<Value, String> {
    let n: u32 = code.trim().trim_start_matches("EPSG:").trim_start_matches("epsg:").parse().map_err(|_| format!("'{code}' is not an EPSG code"))?;
    let srs = gdal::spatial_ref::SpatialRef::from_epsg(n).map_err(|e| format!("EPSG:{n}: {e}"))?;
    let proj4 = srs.to_proj4().map_err(|e| e.to_string())?;
    let info = all().iter().find(|c| c.code == n.to_string());
    Ok(json!({
        "code": format!("EPSG:{n}"),
        "name": info.map(|c| c.name.clone()).or_else(|| srs.name()).unwrap_or_default(),
        "kind": info.map(|c| c.kind).unwrap_or(if srs.is_geographic() { "geographic" } else { "projected" }),
        "area": info.map(|c| c.area.clone()).unwrap_or_default(),
        "proj4": proj4,
        "units": if srs.is_geographic() { "degrees" } else { "metres" },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_png_grids_and_describes_them() {
        crate::raster::configure_gdal();
        let r = search("PNG94 MG", Some((147.2, -9.4)), 20);
        let codes: Vec<&str> = r["systems"].as_array().unwrap().iter().map(|s| s["code"].as_str().unwrap()).collect();
        assert!(codes.iter().any(|c| *c == "EPSG:5550" || *c == "EPSG:5551" || *c == "EPSG:5552"), "{codes:?}");
        let d = describe("EPSG:32755").unwrap();
        assert!(d["proj4"].as_str().unwrap().contains("+zone=55"));
        assert!(d["name"].as_str().unwrap().contains("UTM zone 55S"));
        assert!(describe("EPSG:nope").is_err());
    }
}
