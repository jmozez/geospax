//! In-memory features for recipe steps: read any registered layer through the engine's read path
//! (Arrow stream, GPKG workarounds, reprojection to EPSG:4326) and write results with GDAL.

use crate::Engine;
use crate::catalog::{GeomKind, LayerHandle};
use crate::mvt;
use crate::wkb::Geom;
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Null,
    Int(i64),
    Num(f64),
    Str(String),
}

impl Val {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Val::Int(i) => Some(*i as f64),
            Val::Num(f) if f.is_finite() => Some(*f),
            Val::Str(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    /// Same text MapLibre's `to-string` produces, so categories match the web map.
    pub fn text(&self) -> String {
        match self {
            Val::Null => String::new(),
            Val::Int(i) => i.to_string(),
            Val::Num(f) => num_text(*f),
            Val::Str(s) => s.clone(),
        }
    }
}

pub fn num_text(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

#[derive(Debug, Clone)]
pub struct Feat {
    pub geom: Geom,
    pub props: Vec<Val>,
}

#[derive(Debug, Clone)]
pub struct FeatureSet {
    pub kind: GeomKind,
    /// (name, "integer" | "real" | "string")
    pub fields: Vec<(String, &'static str)>,
    pub feats: Vec<Feat>,
    /// Features in the source (before any limit).
    pub total: u64,
    pub truncated: bool,
}

impl FeatureSet {
    pub fn new(kind: GeomKind, fields: Vec<(String, &'static str)>) -> Self {
        FeatureSet {
            kind,
            fields,
            feats: Vec::new(),
            total: 0,
            truncated: false,
        }
    }

    pub fn field(&self, name: &str) -> Option<usize> {
        self.fields.iter().position(|(n, _)| n == name).or_else(|| {
            self.fields
                .iter()
                .position(|(n, _)| n.eq_ignore_ascii_case(name))
        })
    }

    pub fn bounds(&self) -> Option<[f64; 4]> {
        let mut b: Option<[f64; 4]> = None;
        for f in &self.feats {
            each_coord(&f.geom, &mut |c| {
                b = Some(match b {
                    None => [c[0], c[1], c[0], c[1]],
                    Some(b) => [
                        b[0].min(c[0]),
                        b[1].min(c[1]),
                        b[2].max(c[0]),
                        b[3].max(c[1]),
                    ],
                });
            });
        }
        b
    }

    pub fn numbers(&self, idx: usize) -> Vec<f64> {
        self.feats
            .iter()
            .filter_map(|f| f.props.get(idx).and_then(Val::as_f64))
            .collect()
    }
}

pub fn each_coord(g: &Geom, f: &mut dyn FnMut(&[f64; 2])) {
    match g {
        Geom::Points(p) => p.iter().for_each(f),
        Geom::Lines(ls) => ls.iter().flatten().for_each(f),
        Geom::Polygons(ps) => ps.iter().flatten().flatten().for_each(f),
        Geom::Empty => {}
    }
}

/// A representative point (point itself, bbox centre otherwise).
pub fn anchor(g: &Geom) -> Option<[f64; 2]> {
    if let Geom::Points(p) = g {
        return p.first().copied();
    }
    let mut b: Option<[f64; 4]> = None;
    each_coord(g, &mut |c| {
        b = Some(match b {
            None => [c[0], c[1], c[0], c[1]],
            Some(b) => [
                b[0].min(c[0]),
                b[1].min(c[1]),
                b[2].max(c[0]),
                b[3].max(c[1]),
            ],
        })
    });
    b.map(|b| [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0])
}

pub fn union_bounds(a: Option<[f64; 4]>, b: Option<[f64; 4]>) -> Option<[f64; 4]> {
    match (a, b) {
        (Some(a), Some(b)) => Some([
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[2].max(b[2]),
            a[3].max(b[3]),
        ]),
        (a, None) => a,
        (None, b) => b,
    }
}

/// Usable attribute columns (OGR indices) of a layer.
pub fn usable_fields(layer: &LayerHandle) -> Vec<usize> {
    let info = &layer.info;
    (0..info.fields.len())
        .filter(|&i| matches!(info.fields[i].kind, "integer" | "real" | "string"))
        .collect()
}

/// Stream a layer's features (geometry in EPSG:4326) through `f` until it returns false.
/// `field_idx` are OGR field indices; `props[k]` is the value of `field_idx[k]`.
pub fn scan_layer(
    engine: &Engine,
    layer: &LayerHandle,
    bbox: Option<[f64; 4]>,
    field_idx: &[usize],
    f: &mut dyn FnMut(&Geom, Vec<Val>) -> bool,
) -> Result<(), String> {
    let b = layer.info.bounds;
    // A rectangle slightly larger than the layer selects GDAL's fast whole-table scan.
    let pad = ((b[2] - b[0]).abs().max((b[3] - b[1]).abs()) * 0.001).max(1e-6);
    let whole = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    let rect = match bbox {
        Some(r)
            if !(r[0] <= whole[0] && r[1] <= whole[1] && r[2] >= whole[2] && r[3] >= whole[3]) =>
        {
            r
        }
        _ => whole,
    };
    if !crate::tile::intersects(rect, b) {
        return Ok(());
    }
    let n = field_idx.len();
    let h = layer.checkout()?;
    let mut rt = crate::ReadTimes::default();
    let res = engine.read_tile(
        layer,
        &h,
        rect,
        field_idx,
        Instant::now(),
        &mut rt,
        &mut |_fid, g, attrs| {
            let mut props = vec![Val::Null; n];
            for (k, v) in attrs {
                if let Some(slot) = props.get_mut(k as usize) {
                    *slot = match v {
                        mvt::Val::Str(s) => Val::Str(s),
                        mvt::Val::Int(i) => Val::Int(i),
                        mvt::Val::Dbl(d) => Val::Num(d),
                    };
                }
            }
            f(g, props)
        },
    );
    layer.checkin(h);
    res
}

/// Read a layer's features (geometry in EPSG:4326), optionally only those intersecting `bbox`,
/// with every usable attribute (or `fields`). Stops after `limit` features.
pub fn read_layer(
    engine: &Engine,
    layer: &LayerHandle,
    bbox: Option<[f64; 4]>,
    fields: Option<&[usize]>,
    limit: usize,
) -> Result<FeatureSet, String> {
    let info = &layer.info;
    let field_idx: Vec<usize> = match fields {
        Some(f) => f.to_vec(),
        None => usable_fields(layer),
    };
    let names: Vec<(String, &'static str)> = field_idx
        .iter()
        .map(|&i| (info.fields[i].name.clone(), info.fields[i].kind))
        .collect();
    let mut fs = FeatureSet::new(info.geometry, names);
    fs.total = info.feature_count;
    let mut truncated = false;
    {
        let feats = &mut fs.feats;
        scan_layer(engine, layer, bbox, &field_idx, &mut |g, props| {
            if feats.len() >= limit {
                truncated = true;
                return false;
            }
            feats.push(Feat {
                geom: g.clone(),
                props,
            });
            true
        })?;
    }
    fs.truncated = truncated;
    if bbox.is_some() && !truncated {
        fs.total = fs.feats.len() as u64;
    }
    Ok(fs)
}

// ------------------------------------------------------------------ writing

fn push_u32(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn push_ring(b: &mut Vec<u8>, ring: &[[f64; 2]], close: bool) {
    let needs_close = close && ring.len() > 1 && ring.first() != ring.last();
    push_u32(b, (ring.len() + needs_close as usize) as u32);
    for c in ring.iter().chain(needs_close.then(|| &ring[0])) {
        b.extend_from_slice(&c[0].to_le_bytes());
        b.extend_from_slice(&c[1].to_le_bytes());
    }
}

/// Little-endian ISO WKB. Lines and polygons are always written as Multi* (matching the layer type).
pub fn to_wkb(g: &Geom, multi_points: bool) -> Option<Vec<u8>> {
    let mut b = Vec::new();
    match g {
        Geom::Empty => return None,
        Geom::Points(p) if p.is_empty() => return None,
        Geom::Points(p) if p.len() == 1 && !multi_points => {
            b.push(1);
            push_u32(&mut b, 1);
            b.extend_from_slice(&p[0][0].to_le_bytes());
            b.extend_from_slice(&p[0][1].to_le_bytes());
        }
        Geom::Points(p) => {
            b.push(1);
            push_u32(&mut b, 4);
            push_u32(&mut b, p.len() as u32);
            for c in p {
                b.push(1);
                push_u32(&mut b, 1);
                b.extend_from_slice(&c[0].to_le_bytes());
                b.extend_from_slice(&c[1].to_le_bytes());
            }
        }
        Geom::Lines(ls) => {
            let ls: Vec<&Vec<[f64; 2]>> = ls.iter().filter(|l| l.len() >= 2).collect();
            if ls.is_empty() {
                return None;
            }
            b.push(1);
            push_u32(&mut b, 5);
            push_u32(&mut b, ls.len() as u32);
            for l in ls {
                b.push(1);
                push_u32(&mut b, 2);
                push_ring(&mut b, l, false);
            }
        }
        Geom::Polygons(ps) => {
            let ps: Vec<&Vec<Vec<[f64; 2]>>> = ps
                .iter()
                .filter(|p| p.first().is_some_and(|r| r.len() >= 3))
                .collect();
            if ps.is_empty() {
                return None;
            }
            b.push(1);
            push_u32(&mut b, 6);
            push_u32(&mut b, ps.len() as u32);
            for p in ps {
                let rings: Vec<&Vec<[f64; 2]>> = p.iter().filter(|r| r.len() >= 3).collect();
                b.push(1);
                push_u32(&mut b, 3);
                push_u32(&mut b, rings.len() as u32);
                for r in rings {
                    push_ring(&mut b, r, true);
                }
            }
        }
    }
    Some(b)
}

/// GDAL driver short name and file extension for an export format.
pub fn driver_for(format: &str) -> Option<(&'static str, &'static str)> {
    Some(match format.to_ascii_lowercase().as_str() {
        "gpkg" | "geopackage" => ("GPKG", "gpkg"),
        "geojson" | "json" => ("GeoJSON", "geojson"),
        "csv" => ("CSV", "csv"),
        "fgb" | "flatgeobuf" => ("FlatGeobuf", "fgb"),
        "kml" => ("KML", "kml"),
        "shp" | "shapefile" => ("ESRI Shapefile", "shp"),
        _ => return None,
    })
}

/// Write `fs` as one layer (EPSG:4326) of a new file. Existing files are replaced.
pub fn write_features(
    path: &Path,
    driver: &str,
    layer_name: &str,
    fs: &FeatureSet,
) -> Result<(), String> {
    use gdal::spatial_ref::{AxisMappingStrategy, SpatialRef};
    use gdal::vector::{LayerOptions, OGRwkbGeometryType as G};
    let e = |x: gdal::errors::GdalError| x.to_string();
    if driver == "ESRI Shapefile" {
        for ext in ["shp", "shx", "dbf", "prj", "cpg"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
    } else {
        let _ = std::fs::remove_file(path);
    }
    let drv = gdal::DriverManager::get_driver_by_name(driver).map_err(e)?;
    let mut ds = drv.create_vector_only(path).map_err(e)?;
    let mut srs = SpatialRef::from_epsg(4326).map_err(e)?;
    srs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let multi_points = fs
        .feats
        .iter()
        .any(|f| matches!(&f.geom, Geom::Points(p) if p.len() > 1));
    let ty = match fs.kind {
        GeomKind::Point if multi_points => G::wkbMultiPoint,
        GeomKind::Point => G::wkbPoint,
        GeomKind::Line => G::wkbMultiLineString,
        GeomKind::Polygon => G::wkbMultiPolygon,
        GeomKind::Unknown => G::wkbUnknown,
    };
    let csv_geom = if fs.kind == GeomKind::Point && !multi_points {
        "GEOMETRY=AS_XY"
    } else {
        "GEOMETRY=AS_WKT"
    };
    let csv_opts = [csv_geom];
    let json_opts = ["RFC7946=YES", "WRITE_BBOX=YES"];
    let options: Option<&[&str]> = match driver {
        "CSV" => Some(&csv_opts),
        "GeoJSON" => Some(&json_opts),
        _ => None,
    };
    let lo = LayerOptions {
        name: layer_name,
        srs: Some(&srs),
        ty,
        options,
    };
    if driver == "GPKG" {
        let mut txn = ds.start_transaction().map_err(e)?;
        {
            let lyr = txn.create_layer(lo).map_err(e)?;
            fill(&lyr, fs, multi_points)?;
        }
        txn.commit().map_err(e)?;
    } else {
        let lyr = ds.create_layer(lo).map_err(e)?;
        fill(&lyr, fs, multi_points)?;
    }
    Ok(())
}

fn fill<L: gdal::vector::LayerAccess>(
    lyr: &L,
    fs: &FeatureSet,
    multi_points: bool,
) -> Result<(), String> {
    use gdal::vector::{Feature, FieldDefn, Geometry, OGRFieldType as F};
    let e = |x: gdal::errors::GdalError| x.to_string();
    // Drivers may add fields of their own (KML: Name, Description) or rename ours (Shapefile:
    // 10 characters), so remember the index each field really got.
    let mut slots: Vec<Option<usize>> = Vec::with_capacity(fs.fields.len());
    for (name, kind) in &fs.fields {
        let t = match *kind {
            "integer" => F::OFTInteger64,
            "real" => F::OFTReal,
            _ => F::OFTString,
        };
        let before = lyr.defn().fields().count();
        let added = FieldDefn::new(name, t)
            .map_err(e)?
            .add_to_layer(lyr)
            .is_ok();
        let after = lyr.defn().fields().count();
        slots.push(if added && after > before {
            Some(after - 1)
        } else {
            lyr.defn()
                .fields()
                .position(|f| f.name().eq_ignore_ascii_case(name))
        });
    }
    for f in &fs.feats {
        let mut feat = Feature::new(lyr.defn()).map_err(e)?;
        for (k, v) in f.props.iter().enumerate().take(fs.fields.len()) {
            let Some(i) = slots[k] else { continue };
            match v {
                Val::Null => feat.set_field_null(i).map_err(e)?,
                Val::Int(x) => feat.set_field_integer64(i, *x).map_err(e)?,
                Val::Num(x) if x.is_finite() => feat.set_field_double(i, *x).map_err(e)?,
                Val::Num(_) => feat.set_field_null(i).map_err(e)?,
                Val::Str(s) => feat.set_field_string(i, s).map_err(e)?,
            }
        }
        if let Some(w) = to_wkb(&f.geom, multi_points) {
            feat.set_geometry(Geometry::from_wkb(&w).map_err(e)?)
                .map_err(e)?;
        }
        feat.create(lyr).map_err(e)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ local metric projection

/// Equirectangular metres around a centre: accurate enough for binning, interpolation grids and
/// distances within a region (a few hundred km). Steps that need exact metric geometry
/// (buffers) use the UTM zone instead (`utm_epsg`).
#[derive(Debug, Clone, Copy)]
pub struct LocalProj {
    pub lon0: f64,
    pub lat0: f64,
    kx: f64,
    ky: f64,
}

impl LocalProj {
    pub fn new(lon0: f64, lat0: f64) -> Self {
        let kx = 111_320.0 * lat0.to_radians().cos().max(0.01);
        LocalProj {
            lon0,
            lat0,
            kx,
            ky: 110_540.0,
        }
    }
    pub fn for_bounds(b: [f64; 4]) -> Self {
        Self::new((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)
    }
    pub fn fwd(&self, c: [f64; 2]) -> [f64; 2] {
        [(c[0] - self.lon0) * self.kx, (c[1] - self.lat0) * self.ky]
    }
    pub fn inv(&self, p: [f64; 2]) -> [f64; 2] {
        [self.lon0 + p[0] / self.kx, self.lat0 + p[1] / self.ky]
    }
}

/// UTM zone EPSG code for a lon/lat (WGS 84 / UTM north 326xx, south 327xx).
pub fn utm_epsg(lon: f64, lat: f64) -> u32 {
    let zone = (((lon + 180.0) / 6.0).floor() as i32).clamp(0, 59) as u32 + 1;
    if lat < 0.0 {
        32700 + zone
    } else {
        32600 + zone
    }
}

/// A "nice" number (1, 2, 2.5 or 5 × 10^k) at or below `x`.
pub fn nice_floor(x: f64) -> f64 {
    if x <= 0.0 || !x.is_finite() {
        return 1.0;
    }
    let p = 10f64.powf(x.log10().floor());
    let m = x / p;
    p * if m >= 5.0 {
        5.0
    } else if m >= 2.5 {
        2.5
    } else if m >= 2.0 {
        2.0
    } else {
        1.0
    }
}

pub fn fmt_distance(m: f64) -> String {
    if m >= 1000.0 {
        let km = m / 1000.0;
        if km.fract() == 0.0 {
            format!("{km:.0} km")
        } else {
            format!("{km:.1} km")
        }
    } else {
        format!("{m:.0} m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wkb_roundtrips_through_our_reader() {
        let g = Geom::Polygons(vec![vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]]]);
        let w = to_wkb(&g, false).unwrap();
        // the ring gets closed
        assert_eq!(
            crate::wkb::parse(&w).unwrap(),
            Geom::Polygons(vec![vec![vec![
                [0.0, 0.0],
                [1.0, 0.0],
                [1.0, 1.0],
                [0.0, 0.0]
            ]]])
        );
        let p = Geom::Points(vec![[144.2, -5.8]]);
        assert_eq!(crate::wkb::parse(&to_wkb(&p, false).unwrap()).unwrap(), p);
        let l = Geom::Lines(vec![vec![[0.0, 0.0], [2.0, 1.0]]]);
        assert_eq!(crate::wkb::parse(&to_wkb(&l, false).unwrap()).unwrap(), l);
        assert!(to_wkb(&Geom::Empty, false).is_none());
    }

    #[test]
    fn projections_and_nice_numbers() {
        assert_eq!(utm_epsg(144.23, -5.86), 32755);
        assert_eq!(utm_epsg(2.35, 48.85), 32631);
        let p = LocalProj::new(144.2, -5.8);
        let back = p.inv(p.fwd([144.25, -5.85]));
        assert!((back[0] - 144.25).abs() < 1e-9 && (back[1] + 5.85).abs() < 1e-9);
        assert_eq!(nice_floor(737.0), 500.0);
        assert_eq!(nice_floor(0.27), 0.25);
        assert_eq!(fmt_distance(2500.0), "2.5 km");
        assert_eq!(Val::Num(3.0).text(), "3");
        assert_eq!(Val::Num(3.5).text(), "3.5");
    }
}
