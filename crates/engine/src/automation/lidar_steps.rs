//! LiDAR step (docs/AUTOMATION.md §4): `lidar.grid` turns LAS/LAZ point clouds into terrain,
//! surface and canopy rasters plus building and tree-top layers (the work is in crate::lidar).

use std::path::PathBuf;

use serde_json::{Map, Value, json};

use super::features::{Feat, FeatureSet, Val};
use super::raster_steps::{fmt0, out_path, register};
use super::steps::{StepCtx, StepOut, p_f64, p_str, resolve_source, sanitize};
use crate::catalog::GeomKind;
use crate::lidar::{self, GroundMode};
use crate::raster::{self, NODATA};
use crate::wkb::Geom;

fn count_text(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1} billion", n as f64 / 1e9)
    } else if n >= 1_000_000 {
        format!("{:.1} million", n as f64 / 1e6)
    } else {
        fmt0(n as f64)
    }
}

fn area_text(m2: f64) -> String {
    if m2 >= 1e6 {
        format!("{:.2} km²", m2 / 1e6)
    } else if m2 >= 1e4 {
        format!("{:.1} ha", m2 / 1e4)
    } else {
        format!("{} m²", fmt0(m2))
    }
}

fn res_text(r: f64) -> String {
    if r >= 1.0 {
        format!("{r:.0} m")
    } else {
        format!("{} cm", (r * 100.0).round())
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// The point clouds for `source`: a LAS/LAZ file, a folder (searched recursively), a device,
/// or (auto) the device / drop folder / file that triggered the run.
fn cloud_files(sc: &StepCtx, src: &str) -> Result<Vec<PathBuf>, String> {
    let s = src.trim();
    if !s.is_empty() && s != "auto" {
        if let Some(p) = sc.resolve_path(s).filter(|p| p.is_file()) {
            return if lidar::is_cloud_file(&p) {
                Ok(vec![p])
            } else {
                Err(format!("'{s}' is not a LAS or LAZ point cloud"))
            };
        }
    }
    let root = resolve_source(sc, s)?;
    let files = lidar::find_clouds(&root, 5000);
    if files.is_empty() {
        return Err(format!(
            "no LAS/LAZ point clouds in {} (looked for *.las and *.laz, including sub-folders)",
            root.display()
        ));
    }
    Ok(files)
}

fn aoi_of(sc: &mut StepCtx, p: &Value) -> Result<Option<[f64; 4]>, String> {
    match p.get("aoi") {
        Some(Value::Array(a)) if a.len() == 4 && a.iter().all(Value::is_number) => {
            let v: Vec<f64> = a.iter().filter_map(Value::as_f64).collect();
            Ok(Some([v[0], v[1], v[2], v[3]]))
        }
        Some(Value::String(s)) if !s.is_empty() && s != "auto" && s != "none" => {
            if let Some(r) = sc.engine.raster(s) {
                return Ok(Some(r.info.bounds));
            }
            Ok(Some(sc.layer(s)?.info.bounds))
        }
        _ => Ok(None),
    }
}

pub(super) fn lidar_grid(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let files = cloud_files(sc, p_str(p, "source").unwrap_or("auto"))?;
    let mut o = lidar::Options {
        resolution: p_f64(p, "resolution").filter(|r| *r > 0.0),
        epsg: p_f64(p, "epsg").map(|e| e as u32),
        ..Default::default()
    };
    o.ground = match p_str(p, "ground")
        .unwrap_or("auto")
        .to_ascii_lowercase()
        .as_str()
    {
        "auto" => GroundMode::Auto,
        "classes" | "classified" | "class" | "file" => GroundMode::Classes,
        "smrf" | "filter" => GroundMode::Smrf,
        other => {
            return Err(format!(
                "ground: '{other}' is not one of auto, classes, smrf"
            ));
        }
    };
    if let Some(v) = p_f64(p, "min_tree") {
        o.min_tree = v.max(0.5);
    }
    if let Some(v) = p_f64(p, "window") {
        o.window = v.clamp(2.0, 200.0);
    }
    if let Some(v) = p_f64(p, "max_points") {
        o.max_points = v.max(1.0) as u64;
    }
    o.aoi = aoi_of(sc, p)?;
    o.sample = p_f64(p, "sample")
        .map(|v| v.max(0.0) as usize)
        .unwrap_or(300_000)
        .min(5_000_000);
    let mut prod = lidar::process(&files, &o, sc.cancel)?;
    // every n-th point, kept in memory for a 3D view later in the run (scene.3d cloud: auto)
    let sample = std::mem::take(&mut prod.sample);
    if !sample.is_empty() {
        sc.cloud_total = prod.stats.used;
        sc.cloud_sample = Some(std::sync::Arc::new(sample));
    }
    let st = &prod.stats;
    let spec = &prod.spec;
    let prefix = p_str(p, "prefix")
        .map(|s| format!("{}_", sanitize(s)))
        .unwrap_or_default();
    let src_name = if files.len() == 1 {
        files[0]
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        format!("{} tiles", files.len())
    };
    let gt = spec.geo_transform();

    // rasters
    let mut ids = Map::new();
    for (key, data, kind, title, what) in [
        (
            "dtm",
            &prod.dtm,
            "dem",
            "Bare-earth terrain (LiDAR DTM)",
            "ground elevation with buildings and vegetation removed",
        ),
        (
            "dsm",
            &prod.dsm,
            "dsm",
            "Surface (LiDAR DSM)",
            "highest return per cell: ground, roofs and tree tops",
        ),
        (
            "chm",
            &prod.chm,
            "chm",
            "Canopy height (LiDAR CHM)",
            "vegetation height above the ground (buildings removed)",
        ),
    ] {
        let name = format!("{prefix}{key}");
        let out = out_path(sc, &name)?;
        let vals: Vec<f32> = data
            .iter()
            .map(|v| if v.is_nan() { NODATA as f32 } else { *v })
            .collect();
        raster::write_tif_f32(&out, spec.w, spec.h, gt, &spec.wkt, vals, Some(NODATA))?;
        let h = register(
            sc,
            &out,
            &name,
            json!({ "kind": kind, "title": title, "units": "m", "description": format!("{what}; gridded from {src_name} at {}", res_text(spec.res)), "credit": "" }),
        )?;
        ids.insert(key.into(), json!(h.info.id));
    }

    // tree tops
    let trees = if prod.trees.is_empty() {
        Value::Null
    } else {
        let mut fs = FeatureSet::new(
            GeomKind::Point,
            vec![("height_m".into(), "real"), ("crown_m".into(), "real")],
        );
        for t in &prod.trees {
            fs.feats.push(Feat {
                geom: Geom::Points(vec![[t.lon, t.lat]]),
                props: vec![Val::Num(round1(t.height)), Val::Num(round1(t.crown))],
            });
        }
        fs.total = fs.feats.len() as u64;
        let id = sc.write_output(
            &format!("{prefix}trees"),
            &fs,
            format!("Tree tops ({})", fmt0(fs.total as f64)),
        )?;
        // dark green, kept as is: white dots (the usual rule for points over a thematic layer) turn
        // thousands of tree tops into "snow" over the light greens of low canopy
        sc.hints.insert(id.clone(), json!({ "color": "#123b22", "field": "none", "note": format!("{} trees ≥ {} m", fmt0(fs.total as f64), fmt0(o.min_tree)), "why": "one dark-green dot per tree top, so thousands of them read as trees, not speckle, over the canopy colours" }));
        json!(id)
    };

    // buildings
    let buildings = if prod.buildings.is_empty() {
        Value::Null
    } else {
        let mut fs = FeatureSet::new(
            GeomKind::Polygon,
            vec![
                ("height_m".into(), "real"),
                ("area_m2".into(), "real"),
                ("ground_m".into(), "real"),
            ],
        );
        for b in &prod.buildings {
            fs.feats.push(Feat {
                geom: Geom::Polygons(b.polygons.clone()),
                props: vec![
                    Val::Num(round1(b.height)),
                    Val::Num(b.area_m2.round()),
                    Val::Num(round1(b.ground)),
                ],
            });
        }
        fs.total = fs.feats.len() as u64;
        let id = sc.write_output(
            &format!("{prefix}buildings"),
            &fs,
            format!("Buildings ({})", fs.total),
        )?;
        sc.hints.insert(id.clone(), json!({ "color": "#4d4d4d", "field": "none", "opacity": 0.92, "outline": true, "why": "buildings in dark grey, the topographic-map convention, so they never read as water or vegetation" }));
        json!(id)
    };
    if sc.aoi.is_none() {
        sc.aoi = Some(st.lonlat);
    }

    // the story
    sc.cards.push((
        "Point cloud".into(),
        format!("{} points · {:.1} per m²", count_text(st.used), st.density),
    ));
    sc.cards
        .push(("Area covered".into(), area_text(st.coverage_m2)));
    sc.cards.push((
        "Ground elevation".into(),
        format!("{}–{} m", fmt0(st.dtm_min), fmt0(st.dtm_max)),
    ));
    sc.cards.push((
        "Canopy cover".into(),
        format!("{:.0} % taller than 2 m", st.canopy_cover * 100.0),
    ));
    if st.trees > 0 {
        sc.cards.push((
            "Trees".into(),
            format!(
                "{} · tallest {:.0} m",
                fmt0(st.trees as f64),
                st.tallest_tree
            ),
        ));
    }
    if st.buildings > 0 {
        sc.cards.push((
            "Buildings".into(),
            format!(
                "{} · {} of roofs",
                st.buildings,
                area_text(st.building_area_m2)
            ),
        ));
    }
    let ground_text = if st.ground_method == "classes" {
        format!(
            "the ground and water points already classified in the data (classes 2 and 9; {:.0} % of the points are ground)",
            st.ground_share * 100.0
        )
    } else {
        format!(
            "the simple morphological filter SMRF (Pingel, Clarke & McBride 2013: slope 0.15, window {} m, elevation threshold 0.5 m + 1.25 × slope), because the data has no ground class",
            fmt0(o.window)
        )
    };
    let building_text = match st.building_method {
        "classes" => "Buildings are the cells with building-class points, outlined and simplified.".to_string(),
        "planar" => "Buildings are planar roof regions of at least 20 m² standing 2.5 m or more above the ground (3 × 3 plane fits with under 12 cm error), outlined and simplified.".to_string(),
        _ => "The cells are too coarse to outline buildings.".to_string(),
    };
    let canopy_text = if st.canopy_method == "classes" {
        "canopy height (CHM) is the highest vegetation-class return (classes 3–5) above the DTM, so unclassified structures, towers and bridges stay out"
    } else {
        "canopy height (CHM) is DSM − DTM with buildings removed"
    };
    sc.methods.push(format!(
        "LiDAR: {} points from {src_name} ({}) were gridded at {} in one pass. Bare-earth terrain (DTM) comes from {ground_text}; cells without ground (under buildings, water) were filled by inverse-distance interpolation (GDAL) and lightly smoothed (3 × 3 mean). The surface model (DSM) is the highest return per cell with isolated spikes removed; {canopy_text}. {building_text} Tree tops are local maxima of the smoothed CHM at least {} m high, each the highest point within its expected crown radius (Popescu & Wynne 2004).",
        count_text(st.used), st.crs, res_text(spec.res), fmt0(o.min_tree)
    ));
    let mut why = vec![format!(
        "{} file{} with {} points in {}: {} used{}{}",
        st.files,
        if st.files == 1 { "" } else { "s" },
        count_text(st.read),
        st.crs,
        count_text(st.used),
        if st.noise > 0 {
            format!(", {} noise points left out", count_text(st.noise))
        } else {
            String::new()
        },
        if st.withheld > 0 {
            format!(", {} withheld", count_text(st.withheld))
        } else {
            String::new()
        }
    )];
    why.push(match o.resolution {
        Some(r) if (r - spec.res).abs() < 1e-9 => format!(
            "{} cells as asked: {} × {} cells",
            res_text(spec.res),
            spec.w,
            spec.h
        ),
        _ => format!(
            "{} cells for {:.1} points per m² (about {:.1} points per cell): {} × {} cells",
            res_text(spec.res),
            st.density,
            st.density * spec.res * spec.res,
            spec.w,
            spec.h
        ),
    });
    why.push(if st.ground_method == "classes" {
        format!("ground from the data's own classification ({:.0} % of the points are ground)", st.ground_share * 100.0)
    } else {
        "no ground class in the data, so the SMRF filter separated ground from buildings and vegetation".to_string()
    });
    why.push(format!(
        "ground {}–{} m; canopy {} over {:.0} % of the area (median {:.1} m, 95th percentile {:.1} m)",
        fmt0(st.dtm_min),
        fmt0(st.dtm_max),
        if st.canopy_method == "classes" { "from the vegetation classes" } else { "from the surface minus ground and buildings" },
        st.canopy_cover * 100.0,
        st.chm_p50,
        st.chm_p95
    ));
    why.push(if st.trees > 0 {
        format!("{} tree tops at least {} m high (search radius grows with height, 1–8 m); tallest {:.1} m", fmt0(st.trees as f64), fmt0(o.min_tree), st.tallest_tree)
    } else {
        format!("no tree tops of {} m or more", fmt0(o.min_tree))
    });
    why.push(match (st.building_method, st.buildings) {
        (_, 0) if st.building_method == "none" => {
            "cells too coarse to outline buildings".to_string()
        }
        (_, 0) => "no buildings found".to_string(),
        ("classes", n) => format!(
            "{n} buildings from the data's building class, {} of roofs",
            area_text(st.building_area_m2)
        ),
        (_, n) => format!(
            "{n} buildings found as flat or pitched roof planes, {} of roofs",
            area_text(st.building_area_m2)
        ),
    });
    let rate = st.read as f64 / st.read_seconds.max(1e-3) / 1e6;
    why.push(format!(
        "read in {:.1} s ({rate:.1} million points/s), done in {:.1} s",
        st.read_seconds, st.seconds
    ));
    why.extend(st.notes.iter().cloned());
    let classes: Map<String, Value> = st
        .classes
        .iter()
        .map(|(c, n)| (lidar::class_name(*c), json!(n)))
        .collect();
    Ok(StepOut {
        outputs: json!({
            "dtm": ids["dtm"], "dsm": ids["dsm"], "chm": ids["chm"], "trees": trees, "buildings": buildings,
            "files": st.files, "canopy": st.canopy_method, "points": st.used, "points_read": st.read, "density": round1(st.density), "resolution": spec.res,
            "size": [spec.w, spec.h], "epsg": spec.epsg, "crs": st.crs, "ground": st.ground_method,
            "ground_min": round1(st.dtm_min), "ground_max": round1(st.dtm_max), "canopy_cover": (st.canopy_cover * 1000.0).round() / 1000.0,
            "chm_p50": round1(st.chm_p50), "chm_p95": round1(st.chm_p95), "tree_count": st.trees, "tallest_tree": round1(st.tallest_tree),
            "building_count": st.buildings, "building_area_m2": st.building_area_m2.round(), "classes": classes, "aoi": st.lonlat,
            "seconds": (st.seconds * 100.0).round() / 100.0,
        }),
        why,
    })
}
