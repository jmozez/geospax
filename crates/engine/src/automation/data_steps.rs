//! `data.fetch`: online data for an area, without API keys.
//!
//! Climate and soil rasters are read as windows straight from the providers' files (GDAL over HTTP,
//! `/vsicurl/` and `/vsizip/`), so only the study area is downloaded. Species occurrences come from
//! the GBIF, OBIS and iNaturalist APIs (paged), boundaries from GADM. Every result carries its
//! citation in the run's methods and in the layer's description, ready for a methods section.
//!
//! `base:` points a source at a mirror (a URL or a local folder with the provider's layout); the
//! tests use it with local files, and institutions use it for a shared cache.
use std::path::Path;
use std::time::Instant;

use gdal::vector::LayerAccess;
use serde_json::{json, Value};

use super::features::{Feat, FeatureSet, Val};
use super::raster_steps::{aoi, out_path, register};
use super::steps::{p_f64, p_list, p_str, sanitize, StepCtx, StepOut};
use crate::catalog::GeomKind;
use crate::raster;
use crate::wkb::Geom;

pub const SOURCES: &str = "worldclim, worldclim-monthly, worldclim-future, chelsa, soilgrids, gebco, hansen, ecoregions, gbif, obis, inat, gadm";

/// GEBCO 2026 Grid, cloud-optimised copy on Source Cooperative (giswqs/gebco-bathymetry), checked
/// against GEBCO's grid geometry (86,400 × 43,200 at 15″) and known depths and heights.
pub const GEBCO_BASE: &str = "https://data.source.coop/giswqs/gebco-bathymetry";
/// The map credit: short enough for a footer, keeping what GEBCO's terms require.
pub const GEBCO_CREDIT: &str = "GEBCO Compilation Group (2026) GEBCO 2026 Grid · not for navigation";
pub const GEBCO_CITATION: &str = "GEBCO Compilation Group (2026) GEBCO 2026 Grid (doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa). Public domain; not to be used for navigation or for any purpose involving safety at sea.";

/// Hansen Global Forest Change v1.13 (2000–2025), 10° tiles of 1″ cells on Google Cloud Storage.
pub const HANSEN_BASE: &str = "https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13";
pub const HANSEN_CITATION: &str = "Hansen, M. C., P. V. Potapov, R. Moore, M. Hancher, S. A. Turubanova, A. Tyukavina, D. Thau, S. V. Stehman, S. J. Goetz, T. R. Loveland, A. Kommareddy, A. Egorov, L. Chini, C. O. Justice, and J. R. G. Townshend. 2013. High-Resolution Global Maps of 21st-Century Forest Cover Change. Science 342: 850–53. Global Forest Change 2000–2025 v1.13, https://glad.earthengine.app/view/global-forest-change (CC-BY 4.0).";
pub const HANSEN_CREDIT: &str = "Source: Hansen/UMD/Google/USGS/NASA (CC-BY 4.0)";
/// The largest area side Hansen is read for: its tiles have no overviews, so a bigger area means
/// reading most of a 10° tile at 30 m.
pub const HANSEN_MAX_DEG: f64 = 2.0;

/// Hansen tiles covering a box: names of their top-left corners ("10S_140E" covers 10–20°S, 140–150°E).
pub fn hansen_tiles(b: [f64; 4]) -> Vec<String> {
    let mut out = Vec::new();
    let mut top = (b[3] / 10.0).ceil() as i32 * 10;
    while (top as f64) > b[1] {
        let mut left = (b[0] / 10.0).floor() as i32 * 10;
        while (left as f64) < b[2] {
            let lat = if top >= 0 { format!("{:02}N", top) } else { format!("{:02}S", -top) };
            let lon = if left >= 0 { format!("{:03}E", left) } else { format!("{:03}W", -left) };
            out.push(format!("{lat}_{lon}"));
            left += 10;
        }
        top -= 10;
    }
    out
}

/// GEBCO Type Identifier (TID) codes: how each cell's depth was obtained (GEBCO Grid
/// documentation, Table 2), with a colour by kind: grey land, blues for direct measurements, oranges
/// for indirect ones, purples for unknown sources.
pub const GEBCO_TID: [(u32, &str, &str); 21] = [
    (0, "Land", "#bdbdbd"),
    (10, "Single beam echo-sounder", "#08519c"),
    (11, "Multibeam echo-sounder", "#2171b5"),
    (12, "Seismic", "#4292c6"),
    (13, "Isolated sounding", "#6baed6"),
    (14, "Electronic Navigation Chart (ENC) sounding", "#9ecae1"),
    (15, "Bathymetric lidar", "#3182bd"),
    (16, "Optical light sensor", "#c6dbef"),
    (17, "Combination of direct measurements", "#084594"),
    (40, "Predicted from satellite gravity", "#fdae6b"),
    (41, "Interpolated (computer algorithm)", "#fd8d3c"),
    (42, "Contours from charts", "#f16913"),
    (43, "Contours from ENCs", "#d94801"),
    (44, "Multiple sources, gravity-guided", "#feb24c"),
    (45, "Predicted from airborne gravity", "#fec44f"),
    (46, "Grounded iceberg draft", "#fee391"),
    (47, "Grounded Argo float", "#e6550d"),
    (48, "Animal-borne data loggers", "#a63603"),
    (70, "Pre-generated grid (mixed sources)", "#9e9ac8"),
    (71, "Unknown source", "#756bb1"),
    (72, "Steering points", "#54278f"),
];

/// A raster to cut from a provider: where it is, which band, what it is.
#[derive(Debug, Clone, PartialEq)]
pub struct RasterSource {
    pub name: String,
    pub path: String,
    pub band: Option<u32>,
    pub title: String,
    pub units: String,
    /// degrees per pixel at the source resolution
    pub res_deg: f64,
    /// how the raster is drawn: `surface`, `bathymetry` (sea level split) or `gebco-tid` (classes)
    pub kind: &'static str,
}

const BIOCLIM: [(&str, &str); 19] = [
    ("Annual mean temperature", "°C"),
    ("Mean diurnal range", "°C"),
    ("Isothermality", "%"),
    ("Temperature seasonality", "°C × 100"),
    ("Max temperature of warmest month", "°C"),
    ("Min temperature of coldest month", "°C"),
    ("Temperature annual range", "°C"),
    ("Mean temperature of wettest quarter", "°C"),
    ("Mean temperature of driest quarter", "°C"),
    ("Mean temperature of warmest quarter", "°C"),
    ("Mean temperature of coldest quarter", "°C"),
    ("Annual precipitation", "mm"),
    ("Precipitation of wettest month", "mm"),
    ("Precipitation of driest month", "mm"),
    ("Precipitation seasonality", "CV %"),
    ("Precipitation of wettest quarter", "mm"),
    ("Precipitation of driest quarter", "mm"),
    ("Precipitation of warmest quarter", "mm"),
    ("Precipitation of coldest quarter", "mm"),
];

/// "1,12" / [1, 12] / "all" → bioclim numbers (default: 1 and 12).
fn bio_list(p: &Value) -> Result<Vec<u32>, String> {
    let raw = p_list(p, "variables");
    if raw.is_empty() {
        return Ok(vec![1, 12]);
    }
    if raw.iter().any(|v| v == "all") {
        return Ok((1..=19).collect());
    }
    raw.iter()
        .flat_map(|v| v.split(',').map(|s| s.trim().trim_start_matches("bio").trim_start_matches('_').to_string()).collect::<Vec<_>>())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u32>().ok().filter(|n| (1..=19).contains(n)).ok_or(format!("bioclim variable '{s}' is not 1–19")))
        .collect()
}

/// WorldClim resolutions and their pixel size in degrees.
fn wc_res(p: &Value) -> Result<(&'static str, f64), String> {
    match p_str(p, "resolution").unwrap_or("10m") {
        "10m" | "10" => Ok(("10m", 1.0 / 6.0)),
        "5m" | "5" => Ok(("5m", 1.0 / 12.0)),
        "2.5m" | "2.5" => Ok(("2.5m", 1.0 / 24.0)),
        "30s" | "30" | "1km" => Ok(("30s", 1.0 / 120.0)),
        other => Err(format!("resolution '{other}': use 10m, 5m, 2.5m or 30s")),
    }
}

/// GDAL path for a file under `base` (a URL or a local folder), inside a zip when `member` is given.
fn gdal_path(base: &str, rel: &str, member: Option<&str>) -> String {
    let base = base.trim_end_matches('/');
    let file = if base.starts_with("http://") || base.starts_with("https://") { format!("/vsicurl/{base}/{rel}") } else { format!("{base}/{rel}") };
    match member {
        Some(m) => format!("/vsizip/{file}/{m}"),
        None => file,
    }
}

/// Which rasters a request means (no network: the paths only).
pub fn raster_sources(source: &str, p: &Value) -> Result<(Vec<RasterSource>, &'static str), String> {
    let base = |dflt: &str| p_str(p, "base").unwrap_or(dflt).to_string();
    match source {
        "worldclim" => {
            let (res, deg) = wc_res(p)?;
            let b = base("https://geodata.ucdavis.edu");
            let out = bio_list(p)?
                .into_iter()
                .map(|n| RasterSource {
                    name: format!("wc_bio{n}"),
                    path: gdal_path(&b, &format!("climate/worldclim/2_1/base/wc2.1_{res}_bio.zip"), Some(&format!("wc2.1_{res}_bio_{n}.tif"))),
                    band: None,
                    title: format!("BIO{n} {} (WorldClim 2.1, 1970–2000)", BIOCLIM[(n - 1) as usize].0),
                    units: BIOCLIM[(n - 1) as usize].1.into(),
                    res_deg: deg,
                    kind: "surface",
                })
                .collect();
            Ok((out, "Fick, S.E. and R.J. Hijmans (2017). WorldClim 2: new 1-km spatial resolution climate surfaces for global land areas. International Journal of Climatology 37: 4302–4315."))
        }
        "worldclim-monthly" => {
            let (res, deg) = wc_res(p)?;
            let var = p_str(p, "variable").unwrap_or("tavg");
            let units = match var {
                "tavg" | "tmin" | "tmax" => "°C",
                "prec" => "mm",
                "srad" => "kJ m⁻² day⁻¹",
                "wind" => "m s⁻¹",
                "vapr" => "kPa",
                other => return Err(format!("variable '{other}': use tavg, tmin, tmax, prec, srad, wind or vapr")),
            };
            let months: Vec<u32> = {
                let m = p_list(p, "months");
                if m.is_empty() {
                    (1..=12).collect()
                } else {
                    m.iter().flat_map(|s| s.split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>()).filter_map(|s| s.parse().ok()).filter(|n| (1..=12).contains(n)).collect()
                }
            };
            if months.is_empty() {
                return Err("months: give numbers from 1 to 12".into());
            }
            let b = base("https://geodata.ucdavis.edu");
            let out = months
                .into_iter()
                .map(|m| RasterSource {
                    name: format!("wc_{var}_{m:02}"),
                    path: gdal_path(&b, &format!("climate/worldclim/2_1/base/wc2.1_{res}_{var}.zip"), Some(&format!("wc2.1_{res}_{var}_{m:02}.tif"))),
                    band: None,
                    title: format!("{var} month {m} (WorldClim 2.1, 1970–2000)"),
                    units: units.into(),
                    res_deg: deg,
                    kind: "surface",
                })
                .collect();
            Ok((out, "Fick, S.E. and R.J. Hijmans (2017). WorldClim 2: new 1-km spatial resolution climate surfaces for global land areas. International Journal of Climatology 37: 4302–4315."))
        }
        "worldclim-future" => {
            let (res, deg) = wc_res(p)?;
            let gcm = p_str(p, "gcm").unwrap_or("ACCESS-CM2");
            let ssp = p_str(p, "ssp").unwrap_or("585").trim_start_matches("ssp").trim_start_matches("SSP");
            if !["126", "245", "370", "585"].contains(&ssp) {
                return Err(format!("ssp '{ssp}': use 126, 245, 370 or 585"));
            }
            let period = p_str(p, "period").unwrap_or("2041-2060");
            if !["2021-2040", "2041-2060", "2061-2080", "2081-2100"].contains(&period) {
                return Err(format!("period '{period}': use 2021-2040, 2041-2060, 2061-2080 or 2081-2100"));
            }
            let b = base("https://geodata.ucdavis.edu");
            let path = gdal_path(&b, &format!("cmip6/{res}/{gcm}/ssp{ssp}/wc2.1_{res}_bioc_{gcm}_ssp{ssp}_{period}.tif"), None);
            let out = bio_list(p)?
                .into_iter()
                .map(|n| RasterSource {
                    name: format!("wc_bio{n}_{gcm}_ssp{ssp}_{}", period.replace('-', "_")),
                    path: path.clone(),
                    band: Some(n),
                    title: format!("BIO{n} {} ({gcm}, SSP{ssp}, {period})", BIOCLIM[(n - 1) as usize].0),
                    units: BIOCLIM[(n - 1) as usize].1.into(),
                    res_deg: deg,
                    kind: "surface",
                })
                .collect();
            Ok((out, "WorldClim 2.1 CMIP6 downscaled projections (Fick & Hijmans 2017; Eyring et al. 2016, CMIP6)."))
        }
        "chelsa" => {
            let b = base("https://os.zhdk.cloud.switch.ch");
            let out = bio_list(p)?
                .into_iter()
                .map(|n| RasterSource {
                    name: format!("chelsa_bio{n}"),
                    path: gdal_path(&b, &format!("chelsav2/GLOBAL/climatologies/1981-2010/bio/CHELSA_bio{n}_1981-2010_V.2.1.tif"), None),
                    band: None,
                    title: format!("BIO{n} {} (CHELSA 2.1, 1981–2010)", BIOCLIM[(n - 1) as usize].0),
                    units: BIOCLIM[(n - 1) as usize].1.into(),
                    res_deg: 1.0 / 120.0,
                    kind: "surface",
                })
                .collect();
            Ok((out, "Karger, D.N. et al. (2017). Climatologies at high resolution for the earth's land surface areas. Scientific Data 4: 170122 (CHELSA V2.1)."))
        }
        "soilgrids" => {
            let prop = p_str(p, "property").unwrap_or("phh2o");
            let units = match prop {
                "phh2o" => "pH × 10",
                "soc" => "dg/kg",
                "clay" | "sand" | "silt" => "g/kg",
                "bdod" => "cg/cm³",
                "cec" => "mmol(c)/kg",
                "nitrogen" => "cg/kg",
                "cfvo" => "cm³/dm³",
                "ocd" => "hg/m³",
                other => return Err(format!("property '{other}': use phh2o, soc, clay, sand, silt, bdod, cec, nitrogen, cfvo or ocd")),
            };
            let depth = p_str(p, "depth").unwrap_or("0-5cm");
            if !["0-5cm", "5-15cm", "15-30cm", "30-60cm", "60-100cm", "100-200cm"].contains(&depth) {
                return Err(format!("depth '{depth}': use 0-5cm, 5-15cm, 15-30cm, 30-60cm, 60-100cm or 100-200cm"));
            }
            let b = base("https://files.isric.org");
            Ok((
                vec![RasterSource {
                    name: format!("soil_{prop}_{}", depth.replace('-', "_")),
                    path: gdal_path(&b, &format!("soilgrids/latest/data/{prop}/{prop}_{depth}_mean.vrt"), None),
                    band: None,
                    title: format!("{prop} {depth} (SoilGrids 2.0 mean)"),
                    units: units.into(),
                    res_deg: 0.0025,
                    kind: "surface",
                }],
                "Poggio, L. et al. (2021). SoilGrids 2.0: producing soil information for the globe with quantified spatial uncertainty. SOIL 7: 217–240.",
            ))
        }
        "gebco" => {
            let b = base(GEBCO_BASE);
            let layer = |what: &str| -> Result<RasterSource, String> {
                match what {
                    "elevation" | "depth" | "bathymetry" => Ok(RasterSource {
                        name: "gebco_2026".into(),
                        path: gdal_path(&b, "gebco_2026/gebco_2026.tif", None),
                        band: None,
                        title: "Elevation and depth (GEBCO 2026 Grid)".into(),
                        units: "m".into(),
                        res_deg: 1.0 / 240.0,
                        kind: "bathymetry",
                    }),
                    "tid" | "source" => Ok(RasterSource {
                        name: "gebco_2026_tid".into(),
                        path: gdal_path(&b, "gebco_2026_tid/gebco_2026_tid.tif", None),
                        band: None,
                        title: "How each depth was obtained (GEBCO 2026 Type Identifier)".into(),
                        units: String::new(),
                        res_deg: 1.0 / 240.0,
                        kind: "gebco-tid",
                    }),
                    other => Err(format!("layers: '{other}' is not a GEBCO layer (use elevation, tid)")),
                }
            };
            let wanted = p_list(p, "layers");
            let wanted: Vec<String> = if wanted.is_empty() { vec!["elevation".into()] } else { wanted.iter().flat_map(|s| s.split(',').map(|x| x.trim().to_ascii_lowercase()).collect::<Vec<_>>()).filter(|s| !s.is_empty()).collect() };
            Ok((wanted.iter().map(|w| layer(w)).collect::<Result<Vec<_>, _>>()?, GEBCO_CITATION))
        }
        "hansen" => {
            let b = base(HANSEN_BASE);
            let layer = |what: &str| -> Result<RasterSource, String> {
                let (file, title, units, kind) = match what {
                    "treecover" | "treecover2000" => ("treecover2000", "Tree canopy cover in 2000 (Hansen GFC v1.13)", "%", "treecover"),
                    "loss" | "lossyear" => ("lossyear", "Year of forest loss 2001–2025 (Hansen GFC v1.13)", "year", "lossyear"),
                    "gain" => ("gain", "Forest gain 2000–2012 (Hansen GFC v1.13)", "", "hansen-gain"),
                    "datamask" | "mask" => ("datamask", "Land and water (Hansen GFC data mask)", "", "hansen-mask"),
                    other => return Err(format!("layers: '{other}' is not a Hansen layer (use treecover, lossyear, gain, datamask)")),
                };
                Ok(RasterSource {
                    name: format!("hansen_{file}"),
                    path: gdal_path(&b, &format!("Hansen_GFC-2025-v1.13_{file}_{{tile}}.tif"), None),
                    band: None,
                    title: title.into(),
                    units: units.into(),
                    res_deg: 1.0 / 3600.0,
                    kind,
                })
            };
            let wanted = p_list(p, "layers");
            let wanted: Vec<String> = if wanted.is_empty() { vec!["treecover".into(), "lossyear".into()] } else { wanted.iter().flat_map(|s| s.split(',').map(|x| x.trim().to_ascii_lowercase()).collect::<Vec<_>>()).filter(|s| !s.is_empty()).collect() };
            Ok((wanted.iter().map(|w| layer(w)).collect::<Result<Vec<_>, _>>()?, HANSEN_CITATION))
        }
        other => Err(format!("unknown source '{other}' (sources: {SOURCES})")),
    }
}

/// Rewrite band 1 of a raster in place, value by value (nodata stays nodata).
fn recode(path: &Path, f: impl Fn(f32) -> f32) -> Result<(), String> {
    let ds = gdal::Dataset::open_ex(path, gdal::DatasetOptions { open_flags: gdal::GdalOpenFlags::GDAL_OF_UPDATE | gdal::GdalOpenFlags::GDAL_OF_RASTER, ..Default::default() }).map_err(|e| e.to_string())?;
    let mut band = ds.rasterband(1).map_err(|e| e.to_string())?;
    let (w, h) = ds.raster_size();
    let mut buf = band.read_as::<f32>((0, 0), (w, h), (w, h), None).map_err(|e| e.to_string())?;
    for v in buf.data_mut() {
        if *v != -9999.0 {
            *v = f(*v);
        }
    }
    band.write((0, 0), (w, h), &mut buf).map_err(|e| e.to_string())?;
    Ok(())
}

/// Classes for a cut of the GEBCO TID grid: the codes present, with their share of the area.
fn tid_classes(path: &Path) -> Result<Vec<Value>, String> {
    let ds = raster::open(path)?;
    let band = ds.rasterband(1).map_err(|e| e.to_string())?;
    let (w, h) = ds.raster_size();
    let buf = band.read_as::<f32>((0, 0), (w, h), (w, h), None).map_err(|e| e.to_string())?;
    let mut counts = std::collections::BTreeMap::<i64, usize>::new();
    for v in buf.data() {
        if v.is_finite() && *v > -9000.0 {
            *counts.entry(v.round() as i64).or_default() += 1;
        }
    }
    let total: usize = counts.values().sum();
    Ok(counts
        .iter()
        .map(|(code, n)| {
            let (label, color) = GEBCO_TID.iter().find(|t| t.0 as i64 == *code).map(|t| (t.1.to_string(), t.2)).unwrap_or((format!("Code {code}"), "#636363"));
            let share = *n as f64 / total.max(1) as f64 * 100.0;
            json!({ "value": code, "label": format!("{code} {label} · {share:.0} %"), "color": color, "share": (share * 10.0).round() / 10.0 })
        })
        .collect())
}

/// Occurrence API pages: the request URLs for one page.
pub fn occurrence_url(source: &str, name: &str, b: [f64; 4], page: usize, page_size: usize, after: Option<&str>) -> String {
    let enc = |s: &str| s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect::<String>();
    let wkt = format!("POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))", w = b[0], s = b[1], e = b[2], n = b[3]);
    match source {
        "gbif" => format!(
            "https://api.gbif.org/v1/occurrence/search?scientificName={}&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT&geometry={}&limit={page_size}&offset={}",
            enc(name),
            enc(&wkt),
            page * page_size
        ),
        "obis" => format!("https://api.obis.org/v3/occurrence?scientificname={}&geometry={}&size={page_size}{}", enc(name), enc(&wkt), after.map(|a| format!("&after={}", enc(a))).unwrap_or_default()),
        "inat" => format!(
            "https://api.inaturalist.org/v1/observations?taxon_name={}&swlat={}&swlng={}&nelat={}&nelng={}&quality_grade=research&geo=true&per_page={page_size}&page={}&order_by=id&order=asc",
            enc(name),
            b[1],
            b[0],
            b[3],
            b[2],
            page + 1
        ),
        _ => String::new(),
    }
}

pub fn occurrence_fields() -> Vec<(String, &'static str)> {
    ["species", "scientific_name", "year", "date", "basis", "dataset", "record_id", "uncertainty_m", "source"]
        .iter()
        .zip(["string", "string", "integer", "string", "string", "string", "string", "real", "string"])
        .map(|(n, k)| (n.to_string(), k))
        .collect()
}

/// One page of an occurrence API answer → features, whether there is more, and OBIS's next cursor.
pub fn parse_occurrences(source: &str, body: &Value) -> (Vec<Feat>, bool, Option<String>) {
    let s = |v: &Value| v.as_str().map(|x| Val::Str(x.to_string())).unwrap_or(Val::Null);
    let n = |v: &Value| v.as_f64().map(Val::Num).unwrap_or(Val::Null);
    let i = |v: &Value| v.as_i64().map(Val::Int).or_else(|| v.as_str().and_then(|x| x.get(..4)).and_then(|x| x.parse().ok()).map(Val::Int)).unwrap_or(Val::Null);
    let id = |v: &Value| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|x| x.to_string())).map(Val::Str).unwrap_or(Val::Null);
    let src = Val::Str(source.to_string());
    let mut out = Vec::new();
    let empty = vec![];
    match source {
        "gbif" => {
            for r in body["results"].as_array().unwrap_or(&empty) {
                let (Some(x), Some(y)) = (r["decimalLongitude"].as_f64(), r["decimalLatitude"].as_f64()) else { continue };
                out.push(Feat {
                    geom: Geom::Points(vec![[x, y]]),
                    props: vec![s(&r["species"]), s(&r["scientificName"]), i(&r["year"]), s(&r["eventDate"]), s(&r["basisOfRecord"]), s(&r["datasetKey"]), id(&r["gbifID"]).or(id(&r["key"])), n(&r["coordinateUncertaintyInMeters"]), src.clone()],
                });
            }
            (out, body["endOfRecords"].as_bool() == Some(false), None)
        }
        "obis" => {
            let rs = body["results"].as_array().unwrap_or(&empty);
            for r in rs {
                let (Some(x), Some(y)) = (r["decimalLongitude"].as_f64(), r["decimalLatitude"].as_f64()) else { continue };
                out.push(Feat {
                    geom: Geom::Points(vec![[x, y]]),
                    props: vec![s(&r["species"]), s(&r["scientificName"]), i(&r["date_year"]), s(&r["eventDate"]), s(&r["basisOfRecord"]), s(&r["dataset_id"]), id(&r["id"]), n(&r["coordinateUncertaintyInMeters"]), src.clone()],
                });
            }
            let next = rs.last().and_then(|r| r["id"].as_str()).map(str::to_string);
            (out, !rs.is_empty() && next.is_some(), next)
        }
        "inat" => {
            let rs = body["results"].as_array().unwrap_or(&empty);
            for r in rs {
                let c = &r["geojson"]["coordinates"];
                let (Some(x), Some(y)) = (c[0].as_f64(), c[1].as_f64()) else { continue };
                out.push(Feat {
                    geom: Geom::Points(vec![[x, y]]),
                    props: vec![s(&r["taxon"]["name"]), s(&r["taxon"]["name"]), i(&r["observed_on"]), s(&r["observed_on"]), Val::Str("HUMAN_OBSERVATION".into()), Val::Str("iNaturalist research grade".into()), id(&r["id"]), n(&r["positional_accuracy"]), src.clone()],
                });
            }
            let total = body["total_results"].as_u64().unwrap_or(0);
            let page = body["page"].as_u64().unwrap_or(1);
            let per = body["per_page"].as_u64().unwrap_or(1).max(1);
            (out, page * per < total, None)
        }
        _ => (out, false, None),
    }
}

trait OrVal {
    fn or(self, other: Val) -> Val;
}
impl OrVal for Val {
    fn or(self, other: Val) -> Val {
        if self == Val::Null { other } else { self }
    }
}

pub(super) fn data_fetch(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let source = p_str(p, "source").ok_or_else(|| format!("source is required ({SOURCES})"))?.to_ascii_lowercase();
    // climate, soil and species data are wanted for whole regions: allow areas up to 5,000 km
    let mut p = p.clone();
    if let Some(o) = p.as_object_mut() {
        o.entry("max_km").or_insert(json!(5000));
    }
    let p = &p;
    match source.as_str() {
        "gbif" | "obis" | "inat" | "inaturalist" => occurrences(sc, p, if source == "inaturalist" { "inat" } else { &source }, t0),
        "gadm" => boundaries(sc, p, t0),
        "ecoregions" | "teow" => ecoregions(sc, p, t0),
        _ => rasters(sc, p, &source, t0),
    }
}

fn rasters(sc: &mut StepCtx, p: &Value, source: &str, t0: Instant) -> Result<StepOut, String> {
    let (list, citation) = raster_sources(source, p)?;
    let (b, what) = aoi(sc, p)?;
    if source == "hansen" && (b[2] - b[0] > HANSEN_MAX_DEG || b[3] - b[1] > HANSEN_MAX_DEG) {
        return Err(format!(
            "Hansen forest change is read at 30 m for areas up to {HANSEN_MAX_DEG}° (about 220 km) a side; this area is {:.1}° × {:.1}°. Zoom in, or choose a smaller layer as the area.",
            b[2] - b[0],
            b[3] - b[1]
        ));
    }
    let prefix = p_str(p, "name").map(sanitize);
    let mut made = Vec::new();
    let mut why = vec![format!("area {:.3}–{:.3}°E, {:.3}–{:.3}°N ({what})", b[0], b[2], b[1], b[3])];
    for r in &list {
        if sc.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        // tiled providers (Hansen): every tile under the area, mosaicked by the warp; tiles that do
        // not exist (open ocean) are skipped
        let paths: Vec<String> = if r.path.contains("{tile}") { hansen_tiles(b).iter().map(|t| r.path.replace("{tile}", t)).collect() } else { vec![r.path.clone()] };
        let mut srcs = Vec::new();
        let mut last_err = String::new();
        for path in &paths {
            match raster::open(Path::new(path)) {
                Ok(d) => srcs.push(d),
                Err(e) => last_err = e,
            }
        }
        if srcs.is_empty() {
            return Err(format!("{}: {last_err} (no internet, or the provider moved the file; `base:` sets a mirror)", r.title));
        }
        let name = match &prefix {
            Some(px) if list.len() > 1 => format!("{px}_{}", r.name),
            Some(px) => px.clone(),
            None => r.name.clone(),
        };
        let out = out_path(sc, &name)?;
        let tmp = out.with_extension("part.tif");
        let mut args = raster::strings(&["-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-ot", "Float32", "-r", "near", "-dstnodata", "-9999", "-overwrite", "-t_srs", "EPSG:4326"]);
        if let Some(band) = r.band {
            args.extend(["-b".into(), band.to_string()]);
        }
        // keep the provider's own grid (no resampling of climate cells), cut to the area
        let snap = |v: f64, up: bool| if up { (v / r.res_deg).ceil() * r.res_deg } else { (v / r.res_deg).floor() * r.res_deg };
        args.extend(["-te".into(), snap(b[0], false).to_string(), snap(b[1], false).to_string(), snap(b[2], true).to_string(), snap(b[3], true).to_string()]);
        // a large area is read at a coarser multiple of the source cells (from the provider's
        // overviews), to stay under 16 million cells
        let cells = ((b[2] - b[0]) / r.res_deg) * ((b[3] - b[1]) / r.res_deg);
        let factor = (cells / 16.0e6).sqrt().ceil().max(1.0);
        let res = r.res_deg * factor;
        if factor > 1.0 {
            why.push(format!("{}: read at {:.4}° ({factor:.0} × the source cell) to keep the area under 16 million cells", r.title, res));
        }
        args.extend(["-tr".into(), res.to_string(), res.to_string()]);
        let refs: Vec<&gdal::Dataset> = srcs.iter().collect();
        drop(raster::warp(&refs, &tmp.to_string_lossy(), &args)?);
        // loss year: the year itself (2001–2025), no loss left empty, so the legend reads in years
        if r.kind == "lossyear" {
            recode(&tmp, |v| if v >= 1.0 && v <= 99.0 { 2000.0 + v } else { -9999.0 })?;
        }
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        let credit = match source {
            "gebco" => GEBCO_CREDIT,
            "hansen" => HANSEN_CREDIT,
            _ => citation,
        };
        let classes: Option<Vec<Value>> = match r.kind {
            "gebco-tid" => Some(tid_classes(&out)?),
            "hansen-gain" => Some(vec![json!({ "value": 1, "label": "Forest gain 2000–2012", "color": "#1a9850" })]),
            "hansen-mask" => Some(vec![json!({ "value": 1, "label": "Land", "color": "#d9d0b4" }), json!({ "value": 2, "label": "Persistent water", "color": "#6baed6" })]),
            _ => None,
        };
        let mut side = json!({ "kind": if classes.is_some() { "classes" } else { r.kind }, "title": r.title, "units": r.units, "description": format!("{} — {citation}", r.title), "credit": credit });
        if let Some(c) = classes {
            side["classes"] = json!(c);
        }
        let h = register(sc, &out, &name, side)?;
        let s = &h.info.stats[0];
        if r.kind == "lossyear" {
            why.push(format!("{}: {} × {} cells, loss mapped from {:.0} to {:.0}", r.title, h.info.width, h.info.height, s.min, s.max));
        } else {
            why.push(format!("{}: {} × {} cells, {}–{} {}", r.title, h.info.width, h.info.height, super::raster_steps::fmt0(s.min), super::raster_steps::fmt0(s.max), r.units));
        }
        made.push(json!({ "raster": h.info.id, "title": r.title, "units": r.units, "path": out }));
    }
    sc.methods.push(format!("{} downloaded for {what} as windows of the provider's own grid ({:.4}° cells), without resampling. Source: {citation}", list.iter().map(|r| r.title.clone()).collect::<Vec<_>>().join("; "), list.first().map(|r| r.res_deg).unwrap_or(0.0)));
    if source == "hansen" {
        sc.methods.push("The Hansen maps are a relative indicator of forest loss trends; per the authors, areas should not be estimated from pixel counts, but with a probability sample stratified by the maps (e.g. Olofsson et al. 2014). Loss before and after 2011–2013 is less comparable (sensor and method changes).".into());
    }
    sc.cards.push((format!("{} raster{}", made.len(), if made.len() == 1 { "" } else { "s" }), source.to_string()));
    let ids: Vec<Value> = made.iter().map(|m| m["raster"].clone()).collect();
    Ok(StepOut { outputs: json!({ "rasters": made, "raster_ids": ids, "raster": ids.first(), "aoi": b, "citation": citation, "seconds": t0.elapsed().as_secs_f64() }), why })
}

fn occurrences(sc: &mut StepCtx, p: &Value, source: &str, t0: Instant) -> Result<StepOut, String> {
    let species = p_str(p, "species").ok_or("species is required (a scientific name, e.g. Paradisaea rudolphi)")?.trim().to_string();
    let (b, what) = aoi(sc, p)?;
    let limit = p_f64(p, "limit").unwrap_or(2000.0).clamp(1.0, 20_000.0) as usize;
    let page_size = match source {
        "gbif" => 300,
        "inat" => 200,
        _ => 500,
    }
    .min(limit);
    let mut fs = FeatureSet::new(GeomKind::Point, occurrence_fields());
    let (mut page, mut after) = (0usize, None::<String>);
    loop {
        if sc.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let url = occurrence_url(source, &species, b, page, page_size, after.as_deref());
        let body = raster::http(&url, None, 60).map_err(|e| format!("{source}: {e} (no internet?)"))?;
        let v: Value = serde_json::from_slice(&body).map_err(|e| format!("{source}: unexpected answer ({e})"))?;
        let (feats, more, next) = parse_occurrences(source, &v);
        let got = feats.len();
        fs.feats.extend(feats);
        page += 1;
        after = next;
        if !more || got == 0 || fs.feats.len() >= limit || page > 200 {
            break;
        }
    }
    fs.feats.truncate(limit);
    if fs.feats.is_empty() {
        return Err(format!("no {source} records of '{species}' with coordinates in {what}"));
    }
    let name = sanitize(p_str(p, "name").unwrap_or(&format!("{source}_{}", species.to_lowercase().replace(' ', "_"))));
    let n = fs.feats.len();
    let today = chrono::Local::now().format("%-d %B %Y");
    let citation = match source {
        "gbif" => format!("GBIF.org ({today}) GBIF Occurrence Search, {species}, https://www.gbif.org/occurrence/search?scientific_name={} (for a publication, make a GBIF download to get its DOI)", species.replace(' ', "+")),
        "obis" => format!("OBIS ({today}) Ocean Biodiversity Information System, Intergovernmental Oceanographic Commission of UNESCO, https://obis.org, {species}"),
        _ => format!("iNaturalist ({today}) research-grade observations of {species}, https://www.inaturalist.org"),
    };
    let id = sc.write_output(&name, &fs, format!("{species} ({})", source.to_uppercase()))?;
    sc.methods.push(format!("{n} occurrence records of {species} with coordinates in {what} from {}. {citation}", source.to_uppercase()));
    sc.cards.push((format!("{n} records"), species.clone()));
    Ok(StepOut {
        outputs: json!({ "layer": id, "records": n, "species": species, "aoi": b, "citation": citation, "seconds": t0.elapsed().as_secs_f64() }),
        why: vec![format!("{n} {source} record(s) of {species} in {what} ({page} page(s))")],
    })
}

/// RESOLVE Ecoregions 2017 (the WWF terrestrial ecoregions, updated), one 149 MB zipped shapefile.
pub const ECOREGIONS_URL: &str = "https://storage.googleapis.com/teow2016/Ecoregions2017.zip";
pub const ECOREGIONS_CITATION: &str = "Dinerstein, E. et al. (2017). An Ecoregion-Based Approach to Protecting Half the Terrestrial Realm. BioScience 67(6): 534–545, doi:10.1093/biosci/bix014. RESOLVE Ecoregions 2017, CC-BY 4.0.";

/// Terrestrial ecoregions for the area, clipped to it, in RESOLVE's own colours. The file has no
/// spatial index, so it is downloaded once into `<state>/catalog/` and read locally after that.
fn ecoregions(sc: &mut StepCtx, p: &Value, t0: Instant) -> Result<StepOut, String> {
    let (b, what) = aoi(sc, p)?;
    let local = sc.engine.state_dir.join("catalog").join("Ecoregions2017.zip");
    let mut why = Vec::new();
    let path = match p_str(p, "base") {
        // a mirror: a folder holding Ecoregions2017.zip, or a URL to it
        Some(base) => gdal_path(base, "Ecoregions2017.zip", Some("Ecoregions2017.shp")),
        None => {
            if !local.exists() {
                let body = raster::http(ECOREGIONS_URL, None, 900).map_err(|e| format!("ecoregions: {e} (no internet?)"))?;
                if body.len() < 1_000_000 {
                    return Err(format!("ecoregions: the download is only {} bytes (expected about 149 MB)", body.len()));
                }
                std::fs::create_dir_all(local.parent().unwrap()).map_err(|e| e.to_string())?;
                let part = local.with_extension("part");
                std::fs::write(&part, &body).map_err(|e| e.to_string())?;
                std::fs::rename(&part, &local).map_err(|e| e.to_string())?;
                why.push(format!("downloaded the ecoregions once ({:.0} MB), kept in {}", body.len() as f64 / 1e6, local.display()));
            }
            format!("/vsizip/{}/Ecoregions2017.shp", local.display())
        }
    };
    let ds = gdal::Dataset::open(Path::new(&path)).map_err(|e| format!("ecoregions: {e}"))?;
    let mut layer = ds.layer(0).map_err(|e| e.to_string())?;
    layer.set_spatial_filter_rect(b[0], b[1], b[2], b[3]);
    let ring = format!("POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))", w = b[0], s = b[1], e = b[2], n = b[3]);
    let clip = gdal::vector::Geometry::from_wkt(&ring).map_err(|e| e.to_string())?;
    let fields = [("ecoregion", "ECO_NAME"), ("biome", "BIOME_NAME"), ("realm", "REALM"), ("eco_id", "ECO_ID"), ("protection", "NNH_NAME"), ("color", "COLOR")];
    let mut fs = FeatureSet::new(GeomKind::Polygon, fields.iter().map(|(n, _)| (n.to_string(), if *n == "eco_id" { "integer" } else { "string" })).chain([("area_km2".to_string(), "real")]).collect());
    for f in layer.features() {
        let Some(g) = f.geometry() else { continue };
        let Some(part) = g.intersection(&clip) else { continue };
        if part.is_empty() {
            continue;
        }
        let Ok(geom) = crate::wkb::parse(&part.wkb().map_err(|e| e.to_string())?) else { continue };
        let area = crate::edit::measure(&geom).0 / 1e6;
        if area <= 0.0 {
            continue;
        }
        let mut props: Vec<Val> = fields
            .iter()
            .map(|(_, src)| match f.field_index(*src).ok().and_then(|i| if *src == "ECO_ID" { f.field_as_integer64(i).ok().flatten().map(Val::Int) } else { f.field_as_string(i).ok().flatten().map(Val::Str) }) {
                Some(v) => v,
                None => Val::Null,
            })
            .collect();
        props.push(Val::Num((area * 10.0).round() / 10.0));
        fs.feats.push(Feat { geom, props });
    }
    // ecoregion 0 is "Rock and Ice"; lakes and sea are not ecoregions
    if fs.feats.is_empty() {
        return Err(format!("no terrestrial ecoregion in {what} (open sea?)"));
    }
    fs.feats.sort_by(|a, b| b.props[6].as_f64().partial_cmp(&a.props[6].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    let name = sanitize(p_str(p, "name").unwrap_or("ecoregions"));
    let n = fs.feats.len();
    let id = sc.write_output(&name, &fs, "Terrestrial ecoregions (RESOLVE 2017, CC-BY 4.0)".into())?;
    // RESOLVE's own colours, one per ecoregion
    let classes: Vec<Value> = fs.feats.iter().map(|f| json!({ "value": f.props[0].text(), "color": f.props[5].text(), "count": 1 })).collect();
    let style = json!({ "visible": true, "opacity": 0.8, "minzoom": 0, "maxzoom": 24, "outline": true,
        "symbology": { "kind": "unique", "field": "ecoregion", "ramp": "fixed", "classes": classes, "other": "#cccccc", "othersCount": 0 } });
    let why_style = "each ecoregion in the colour RESOLVE gives it, so maps match the published ecoregion map".to_string();
    sc.styles.insert(id.clone(), (style.clone(), Some("ecoregion".into()), why_style));
    super::steps::project_upsert(sc.engine, &[(id.clone(), style)])?;
    let list: Vec<String> = fs.feats.iter().take(8).map(|f| format!("{} ({} km²)", f.props[0].text(), super::raster_steps::fmt0(f.props[6].as_f64().unwrap_or(0.0)))).collect();
    sc.methods.push(format!("Terrestrial ecoregions ({n}) in {what}, clipped to the area, from {ECOREGIONS_CITATION}"));
    sc.cards.push(("Ecoregions".into(), n.to_string()));
    why.push(format!("{n} ecoregion(s): {}{}", list.join(", "), if n > 8 { " …" } else { "" }));
    let table: Vec<Value> = fs.feats.iter().map(|f| json!({ "ecoregion": f.props[0].text(), "biome": f.props[1].text(), "realm": f.props[2].text(), "protection": f.props[4].text(), "area_km2": f.props[6].as_f64() })).collect();
    Ok(StepOut { outputs: json!({ "layer": id, "ecoregions": n, "table": table, "citation": ECOREGIONS_CITATION, "seconds": t0.elapsed().as_secs_f64() }), why })
}

fn boundaries(sc: &mut StepCtx, p: &Value, t0: Instant) -> Result<StepOut, String> {
    let iso = p_str(p, "country").ok_or("country is required (ISO 3166 alpha-3 code, e.g. PNG)")?.trim().to_ascii_uppercase();
    if iso.len() != 3 || !iso.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(format!("country '{iso}': use a three-letter ISO code such as PNG, KEN or BRA"));
    }
    let level = p_f64(p, "level").unwrap_or(1.0) as u32;
    if level > 3 {
        return Err("level: 0 (country) to 3".into());
    }
    let base = p_str(p, "base").unwrap_or("https://geodata.ucdavis.edu");
    let path = gdal_path(base, &format!("gadm/gadm4.1/json/gadm41_{iso}_{level}.json.zip"), Some(&format!("gadm41_{iso}_{level}.json")));
    let ds = gdal::Dataset::open(Path::new(&path)).map_err(|e| format!("GADM {iso} level {level}: {e} (no internet?)"))?;
    let mut layer = ds.layer(0).map_err(|e| e.to_string())?;
    let names: Vec<String> = layer.defn().fields().map(|f| f.name()).filter(|n| n.starts_with("NAME_") || n.starts_with("GID_") || n == "COUNTRY" || n.starts_with("TYPE_") || n.starts_with("ENGTYPE_")).collect();
    let mut fs = FeatureSet::new(GeomKind::Polygon, names.iter().map(|n| (n.to_lowercase(), "string")).collect());
    for f in layer.features() {
        let Some(g) = f.geometry() else { continue };
        let Ok(geom) = crate::wkb::parse(&g.wkb().map_err(|e| e.to_string())?) else { continue };
        let props = names.iter().map(|n| f.field_index(n).and_then(|i| f.field_as_string(i)).ok().flatten().map(Val::Str).unwrap_or(Val::Null)).collect();
        fs.feats.push(Feat { geom, props });
    }
    if fs.feats.is_empty() {
        return Err(format!("GADM {iso} level {level} has no areas"));
    }
    let name = sanitize(p_str(p, "name").unwrap_or(&format!("gadm_{}_{level}", iso.to_lowercase())));
    let n = fs.feats.len();
    let citation = "GADM version 4.1 (https://gadm.org), free for academic and other non-commercial use; redistribution or commercial use is not allowed without permission.";
    let id = sc.write_output(&name, &fs, format!("{iso} boundaries, level {level} (GADM 4.1)"))?;
    sc.methods.push(format!("Administrative boundaries of {iso} at level {level} ({n} areas) from {citation}"));
    Ok(StepOut { outputs: json!({ "layer": id, "areas": n, "citation": citation, "seconds": t0.elapsed().as_secs_f64() }), why: vec![format!("{n} level-{level} area(s) of {iso}")] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worldclim_paths() {
        let (r, cite) = raster_sources("worldclim", &json!({ "variables": "1, 12", "resolution": "5m" })).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].path, "/vsizip//vsicurl/https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_5m_bio.zip/wc2.1_5m_bio_12.tif");
        assert_eq!(r[1].units, "mm");
        assert!(cite.contains("Fick"));
        let (all, _) = raster_sources("worldclim", &json!({ "variables": "all" })).unwrap();
        assert_eq!(all.len(), 19);
        assert!(raster_sources("worldclim", &json!({ "variables": "20" })).is_err());
        // a local mirror: no /vsicurl/
        let (m, _) = raster_sources("worldclim", &json!({ "base": "/data/mirror" })).unwrap();
        assert!(m[0].path.starts_with("/vsizip//data/mirror/climate/"));
    }

    #[test]
    fn future_and_soil_paths() {
        let (r, _) = raster_sources("worldclim-future", &json!({ "variables": [1], "ssp": "245", "period": "2061-2080" })).unwrap();
        assert!(r[0].path.ends_with("cmip6/10m/ACCESS-CM2/ssp245/wc2.1_10m_bioc_ACCESS-CM2_ssp245_2061-2080.tif"));
        assert_eq!(r[0].band, Some(1));
        assert!(raster_sources("worldclim-future", &json!({ "ssp": "999" })).is_err());
        let (s, _) = raster_sources("soilgrids", &json!({ "property": "soc", "depth": "5-15cm" })).unwrap();
        assert!(s[0].path.ends_with("soilgrids/latest/data/soc/soc_5-15cm_mean.vrt"));
        let (c, _) = raster_sources("chelsa", &json!({ "variables": "bio12" })).unwrap();
        assert!(c[0].path.ends_with("CHELSA_bio12_1981-2010_V.2.1.tif"));
    }

    #[test]
    fn gebco_paths_and_codes() {
        let (r, cite) = raster_sources("gebco", &json!({})).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].path, "/vsicurl/https://data.source.coop/giswqs/gebco-bathymetry/gebco_2026/gebco_2026.tif");
        assert_eq!((r[0].kind, r[0].units.as_str()), ("bathymetry", "m"));
        assert!((r[0].res_deg * 240.0 - 1.0).abs() < 1e-12, "15 arc-seconds");
        assert!(cite.contains("doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa") && cite.contains("not to be used for navigation"));
        let (both, _) = raster_sources("gebco", &json!({ "layers": "elevation, tid" })).unwrap();
        assert_eq!(both[1].path, "/vsicurl/https://data.source.coop/giswqs/gebco-bathymetry/gebco_2026_tid/gebco_2026_tid.tif");
        assert_eq!(both[1].kind, "gebco-tid");
        assert!(raster_sources("gebco", &json!({ "layers": "sst" })).is_err());
        // GEBCO's Table 2: land, eight direct, nine indirect and three unknown-source codes
        assert_eq!(GEBCO_TID.iter().filter(|t| t.0 == 0).count(), 1);
        assert_eq!(GEBCO_TID.iter().filter(|t| (10..=17).contains(&t.0)).count(), 8);
        assert_eq!(GEBCO_TID.iter().filter(|t| (40..=48).contains(&t.0)).count(), 9);
        assert_eq!(GEBCO_TID.iter().filter(|t| (70..=72).contains(&t.0)).count(), 3);
        assert!(GEBCO_CREDIT.contains("not for navigation"));
    }

    #[test]
    fn occurrence_requests_and_answers() {
        let u = occurrence_url("gbif", "Paradisaea rudolphi", [143.0, -7.0, 147.0, -5.0], 2, 300, None);
        assert!(u.contains("scientificName=Paradisaea%20rudolphi") && u.contains("offset=600") && u.contains("POLYGON"));
        let gbif = json!({ "endOfRecords": false, "results": [
            { "decimalLongitude": 145.1, "decimalLatitude": -6.2, "species": "Paradisaea rudolphi", "scientificName": "Paradisaea rudolphi (Finsch, 1885)", "year": 2019, "basisOfRecord": "HUMAN_OBSERVATION", "gbifID": "123" },
            { "species": "no coordinates" } ] });
        let (f, more, _) = parse_occurrences("gbif", &gbif);
        assert_eq!(f.len(), 1);
        assert!(more);
        assert_eq!(f[0].props[2], Val::Int(2019));
        let inat = json!({ "total_results": 3, "page": 1, "per_page": 2, "results": [{ "geojson": { "coordinates": [145.0, -6.0] }, "taxon": { "name": "Ornithoptera alexandrae" }, "observed_on": "2021-05-03", "id": 9 }] });
        let (f, more, _) = parse_occurrences("inat", &inat);
        assert_eq!((f.len(), more), (1, true));
        assert_eq!(f[0].props[2], Val::Int(2021));
        let obis = json!({ "results": [{ "decimalLongitude": 150.0, "decimalLatitude": -9.0, "scientificName": "Chelonia mydas", "id": "abc" }] });
        let (f, more, next) = parse_occurrences("obis", &obis);
        assert_eq!((f.len(), more, next.as_deref()), (1, true, Some("abc")));
    }
}
