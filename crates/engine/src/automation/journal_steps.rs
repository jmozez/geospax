//! Methods from recent journal articles, in the engine:
//!
//! * `stats.geodetector`: the geographical detector q-statistic (Wang et al. 2010, IJGIS 24:107–127; Wang &
//!   Xu 2017, Acta Geographica Sinica) with optimal discretisation of numeric factors (OPGD: Song, Wang, Ge &
//!   Xu 2020, GIScience & Remote Sensing 57:593–610) and the interaction detector. q = 1 − Σ Nₕσₕ² / (Nσ²): the
//!   share of the variance of Y explained by the strata of a factor X (0 = none, 1 = all).
//! * `model.aoa`: the area of applicability of a spatial prediction model (Meyer & Pebesma 2021, Methods in
//!   Ecology and Evolution 12:1620–1633): the dissimilarity index DI (distance in standardised predictor space
//!   to the nearest training point, divided by the mean distance between training points) for every cell,
//!   and the AOA where DI is below the threshold (the outlier-removed maximum of the training points' own
//!   cross-validated DI). Predictors are weighted equally unless weights are given.
//! * `model.knndm`: k-fold nearest-neighbour distance matching cross-validation folds (Linnenbrink, Milà,
//!   Ludwig & Meyer 2024, Geoscientific Model Development 17:5897–5912): clusters the training points so that
//!   the distances from each test point to the nearest training point of the other folds match the distances
//!   from the prediction area to the training points (Wasserstein distance between the two distributions).

use super::features::{self, Val};
use super::raster_steps::{out_path, pick_raster, register};
use super::steps::{p_list, p_str, sanitize, StepCtx, StepOut};
use crate::classify::{self, Method};
use crate::raster;
use gdal::spatial_ref::CoordTransform;
use serde_json::{json, Value};

fn num(p: &Value, k: &str) -> Option<f64> {
    match p.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

// ------------------------------------------------------------------ geographical detector

/// q-statistic of y over strata (one label per observation).
pub fn q_stat(y: &[f64], strata: &[usize]) -> f64 {
    let n = y.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let mean = y.iter().sum::<f64>() / n;
    let sst: f64 = y.iter().map(|v| (v - mean).powi(2)).sum();
    if sst <= 0.0 {
        return 0.0;
    }
    let k = strata.iter().copied().max().unwrap_or(0) + 1;
    let (mut s, mut c, mut s2) = (vec![0.0; k], vec![0.0; k], vec![0.0; k]);
    for (v, &h) in y.iter().zip(strata) {
        s[h] += v;
        s2[h] += v * v;
        c[h] += 1.0;
    }
    // Σ Nₕσₕ² = Σ (Σv² − (Σv)²/Nₕ)
    let ssw: f64 = (0..k).filter(|&h| c[h] > 0.0).map(|h| s2[h] - s[h] * s[h] / c[h]).sum();
    (1.0 - ssw / sst).clamp(0.0, 1.0)
}

/// Class index of each value for the given upper bounds.
fn stratify(x: &[f64], upper: &[f64]) -> Vec<usize> {
    x.iter().map(|v| upper.iter().position(|b| v <= b).unwrap_or(upper.len().saturating_sub(1))).collect()
}

/// OPGD: the discretisation (method × number of strata) with the largest q, each stratum holding at least
/// two observations. Returns (q, method, k, strata).
pub fn best_strata(y: &[f64], x: &[f64], kmin: usize, kmax: usize) -> Option<(f64, &'static str, usize, Vec<usize>)> {
    let mut sorted = x.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mut best: Option<(f64, &'static str, usize, Vec<usize>)> = None;
    for m in [Method::EqualInterval, Method::Quantile, Method::NaturalBreaks] {
        for k in kmin..=kmax {
            let ub = classify::breaks(&sorted, k, m);
            let st = stratify(x, &ub);
            let mut counts = vec![0usize; ub.len().max(1)];
            for &h in &st {
                counts[h] += 1;
            }
            if counts.iter().any(|&c| c == 1) {
                continue;
            }
            let q = q_stat(y, &st);
            if best.as_ref().is_none_or(|b| q > b.0 + 1e-12) {
                best = Some((q, m.as_str(), ub.len(), st));
            }
        }
    }
    best
}

pub(super) fn geodetector(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let l = sc.layer(p_str(p, "layer").ok_or("layer is required")?)?;
    let fs = features::read_layer(sc.engine, &l, None, None, 500_000)?;
    let yname = p_str(p, "y").ok_or("y is required (the variable to explain)")?;
    let yi = fs.field(yname).ok_or_else(|| format!("no field '{yname}'"))?;
    let mut xs = p_list(p, "x");
    if xs.is_empty() || xs == ["auto"] {
        xs = fs.fields.iter().map(|(n, _)| n.clone()).filter(|n| n != yname && !n.eq_ignore_ascii_case("fid") && !n.eq_ignore_ascii_case("id")).collect();
    }
    let kmax = num(p, "max_strata").unwrap_or(8.0).clamp(3.0, 12.0) as usize;
    // factors: numeric fields are discretised (OPGD), text or few-valued ones are strata as they are
    let mut rows = Vec::new();
    let mut factors: Vec<(String, Vec<Option<usize>>)> = Vec::new();
    for xn in &xs {
        let Some(xi) = fs.field(xn) else { continue };
        let pairs: Vec<(usize, f64, &Val)> = fs.feats.iter().enumerate().filter_map(|(i, f)| Some((i, f.props[yi].as_f64()?, &f.props[xi]))).collect();
        let numeric: Vec<f64> = pairs.iter().filter_map(|(_, _, v)| v.as_f64()).collect();
        let distinct = {
            let mut t: Vec<String> = pairs.iter().map(|(_, _, v)| v.text()).collect();
            t.sort();
            t.dedup();
            t.len()
        };
        let (q, how, strata, idx): (f64, String, usize, Vec<(usize, usize)>) = if numeric.len() == pairs.len() && distinct > kmax {
            let y: Vec<f64> = pairs.iter().map(|p| p.1).collect();
            let Some((q, m, k, st)) = best_strata(&y, &numeric, 3, kmax) else { continue };
            (q, format!("{m}, {k} strata (best of 3 methods × 3–{kmax})"), k, pairs.iter().map(|p| p.0).zip(st).collect())
        } else {
            let mut labels: Vec<String> = Vec::new();
            let st: Vec<usize> = pairs.iter().map(|(_, _, v)| {
                let t = v.text();
                labels.iter().position(|x| *x == t).unwrap_or_else(|| { labels.push(t); labels.len() - 1 })
            }).collect();
            let y: Vec<f64> = pairs.iter().map(|p| p.1).collect();
            (q_stat(&y, &st), "categories".into(), labels.len(), pairs.iter().map(|p| p.0).zip(st).collect())
        };
        let mut full = vec![None; fs.feats.len()];
        for (i, h) in idx {
            full[i] = Some(h);
        }
        factors.push((xn.clone(), full));
        rows.push(json!({ "factor": xn, "q": (q * 10_000.0).round() / 10_000.0, "strata": strata, "discretisation": how }));
    }
    if rows.is_empty() {
        return Err("no usable factors: give x as fields of the layer".into());
    }
    rows.sort_by(|a, b| b["q"].as_f64().unwrap_or(0.0).total_cmp(&a["q"].as_f64().unwrap_or(0.0)));
    // interaction detector for the leading factors (Wang & Xu 2017)
    let ys: Vec<Option<f64>> = fs.feats.iter().map(|f| f.props[yi].as_f64()).collect();
    let qof = |name: &str| rows.iter().find(|r| r["factor"] == name).and_then(|r| r["q"].as_f64()).unwrap_or(0.0);
    let lead: Vec<&(String, Vec<Option<usize>>)> = {
        let mut v: Vec<&(String, Vec<Option<usize>>)> = factors.iter().collect();
        v.sort_by(|a, b| qof(&b.0).total_cmp(&qof(&a.0)));
        v.into_iter().take(5).collect()
    };
    let mut inter = Vec::new();
    for i in 0..lead.len() {
        for j in i + 1..lead.len() {
            let (a, b) = (lead[i], lead[j]);
            let mut y = Vec::new();
            let mut st = Vec::new();
            let mut keys: Vec<(usize, usize)> = Vec::new();
            for k in 0..ys.len() {
                if let (Some(v), Some(ha), Some(hb)) = (ys[k], a.1[k], b.1[k]) {
                    let key = (ha, hb);
                    let id = keys.iter().position(|x| *x == key).unwrap_or_else(|| { keys.push(key); keys.len() - 1 });
                    y.push(v);
                    st.push(id);
                }
            }
            let q12 = q_stat(&y, &st);
            let (q1, q2) = (qof(&a.0), qof(&b.0));
            let kind = if q12 < q1.min(q2) {
                "nonlinear weaken"
            } else if q12 < q1.max(q2) {
                "uni-variable weaken"
            } else if q12 > q1 + q2 {
                "nonlinear enhance"
            } else if (q12 - (q1 + q2)).abs() < 1e-9 {
                "independent"
            } else {
                "bi-variable enhance"
            };
            inter.push(json!({ "a": a.0, "b": b.0, "q": (q12 * 10_000.0).round() / 10_000.0, "interaction": kind }));
        }
    }
    let top = &rows[0];
    let why = vec![format!("strongest factor of {yname}: {} (q = {:.3}, {})", top["factor"].as_str().unwrap_or(""), top["q"].as_f64().unwrap_or(0.0), top["discretisation"].as_str().unwrap_or(""))];
    sc.cards.push((format!("{} explains {yname}", top["factor"].as_str().unwrap_or("")), format!("q = {:.2}", top["q"].as_f64().unwrap_or(0.0))));
    sc.methods.push(format!("The geographical detector (Wang et al. 2010) with optimal discretisation (OPGD, Song et al. 2020) measured how much of the spatial variance of {yname} each factor explains (q), and the interaction detector paired the leading factors."));
    Ok(StepOut { outputs: json!({ "rows": rows, "interactions": inter, "y": yname }), why })
}

// ------------------------------------------------------------------ area of applicability

/// DI of each query vector: distance to the nearest training vector over the mean distance between
/// training vectors (all vectors already standardised and weighted). `skip_self` leaves out the training
/// vector with the same index (cross-validated DI of the training data).
pub fn dissimilarity(train: &[Vec<f64>], query: &[Vec<f64>], skip_self: bool) -> (Vec<f64>, f64) {
    let d = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>().sqrt();
    let n = train.len();
    let mut sum = 0.0;
    let mut cnt = 0.0;
    for i in 0..n {
        for j in i + 1..n {
            sum += d(&train[i], &train[j]);
            cnt += 1.0;
        }
    }
    let mean = if cnt > 0.0 { sum / cnt } else { 1.0 };
    let di = query
        .iter()
        .enumerate()
        .map(|(qi, q)| train.iter().enumerate().filter(|(ti, _)| !(skip_self && *ti == qi)).map(|(_, t)| d(q, t)).fold(f64::INFINITY, f64::min) / mean)
        .collect();
    (di, mean)
}

/// The AOA threshold: the largest training DI that is not an outlier (Q3 + 1.5·IQR), as in Meyer & Pebesma.
pub fn aoa_threshold(train_di: &[f64]) -> f64 {
    let mut v: Vec<f64> = train_di.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let q = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    let lim = q(0.75) + 1.5 * (q(0.75) - q(0.25));
    v.iter().copied().filter(|x| *x <= lim).fold(0.0, f64::max)
}

pub(super) fn aoa(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let l = sc.layer(p_str(p, "layer").ok_or("layer is required (the training points)")?)?;
    let ids = p_list(p, "rasters");
    if ids.len() < 2 {
        return Err("rasters: give two or more predictor rasters (the model's inputs)".into());
    }
    let weights: Vec<f64> = p_list(p, "weights").iter().filter_map(|w| w.parse().ok()).collect();
    // every predictor on the grid of the first one
    let first = pick_raster(sc, Some(&json!(ids[0])), &[], &[])?;
    let ds0 = raster::open(&first.info.path)?;
    let (w, h) = ds0.raster_size();
    if (w as u64) * (h as u64) > 25_000_000 {
        return Err("the first raster has more than 25 million cells: clip or resample it first".into());
    }
    let gt = ds0.geo_transform().map_err(|e| e.to_string())?;
    let srs = raster::srs_of(&ds0).ok_or("the first raster has no coordinate system")?;
    let wkt = srs.to_wkt().map_err(|e| e.to_string())?;
    let mut layers_: Vec<Vec<f32>> = Vec::new();
    let mut nodatas = Vec::new();
    for id in &ids {
        let r = pick_raster(sc, Some(&json!(id)), &[], &[])?;
        let ds = raster::open(&r.info.path)?;
        let (v, _, _) = if r.info.path == first.info.path {
            raster::read_full(&ds, 1)?
        } else {
            let te = [gt[0], gt[3] + gt[5] * h as f64, gt[0] + gt[1] * w as f64, gt[3]];
            let args: Vec<String> = ["-of", "MEM", "-t_srs", &wkt, "-te", &te[0].to_string(), &te[1].to_string(), &te[2].to_string(), &te[3].to_string(), "-ts", &w.to_string(), &h.to_string(), "-r", "bilinear"].iter().map(|s| s.to_string()).collect();
            let warped = raster::warp(&[&ds], "", &args)?;
            raster::read_full(&warped, 1)?
        };
        nodatas.push(r.info.nodata);
        layers_.push(v);
    }
    let np = layers_.len();
    let ok = |v: f32, k: usize| v.is_finite() && !nodatas[k].is_some_and(|n| (v as f64 - n).abs() < 1e-6);
    // standardise by the predictors' mean and sd over the whole grid
    let mut mean = vec![0.0; np];
    let mut sd = vec![0.0; np];
    for k in 0..np {
        let vals: Vec<f64> = layers_[k].iter().filter(|v| ok(**v, k)).map(|v| *v as f64).collect();
        let m = vals.iter().sum::<f64>() / vals.len().max(1) as f64;
        mean[k] = m;
        sd[k] = (vals.iter().map(|v| (v - m).powi(2)).sum::<f64>() / vals.len().max(1) as f64).sqrt().max(1e-12);
    }
    let wgt = |k: usize| weights.get(k).copied().unwrap_or(1.0);
    let vec_at = |cell: usize| -> Option<Vec<f64>> { (0..np).map(|k| { let v = layers_[k][cell]; ok(v, k).then(|| (v as f64 - mean[k]) / sd[k] * wgt(k)) }).collect() };
    // training vectors at the points
    let fs = features::read_layer(sc.engine, &l, None, None, 50_000)?;
    let ct = CoordTransform::new(&raster::wgs84(), &srs).map_err(|e| e.to_string())?;
    let mut train = Vec::new();
    // one training vector per cell: points sharing a cell have the same predictors, and a twin would
    // make the leave-one-out DI (and so the threshold) zero
    let mut seen = std::collections::HashSet::new();
    for f in &fs.feats {
        let Some(c) = features::anchor(&f.geom) else { continue };
        let (mut xs, mut ys, mut zs) = (vec![c[0]], vec![c[1]], vec![0.0]);
        if ct.transform_coords(&mut xs, &mut ys, &mut zs).is_err() {
            continue;
        }
        let (col, row) = (((xs[0] - gt[0]) / gt[1]).floor(), ((ys[0] - gt[3]) / gt[5]).floor());
        if col < 0.0 || row < 0.0 || col >= w as f64 || row >= h as f64 {
            continue;
        }
        let cell = row as usize * w + col as usize;
        if !seen.insert(cell) {
            continue;
        }
        if let Some(v) = vec_at(cell) {
            train.push(v);
        }
    }
    if train.len() < 5 {
        return Err(format!("only {} cells with training points fall on the predictors: need at least 5", train.len()));
    }
    let (train_di, _) = dissimilarity(&train, &train, true);
    let thr = aoa_threshold(&train_di);
    // DI of every cell (in blocks, so a large grid does not hold a second copy of the vectors)
    let mut di = vec![f32::NAN; w * h];
    let mut inside = 0usize;
    let mut valid = 0usize;
    let (_, mean_d) = dissimilarity(&train, &[], false);
    for (cell, out) in di.iter_mut().enumerate() {
        if let Some(v) = vec_at(cell) {
            let dmin = train.iter().map(|t| t.iter().zip(&v).map(|(a, b)| (a - b).powi(2)).sum::<f64>().sqrt()).fold(f64::INFINITY, f64::min);
            let x = dmin / mean_d;
            *out = x as f32;
            valid += 1;
            if x <= thr {
                inside += 1;
            }
        }
    }
    let name = sanitize(p_str(p, "name").unwrap_or("aoa"));
    let di_path = out_path(sc, &format!("{name}_di"))?;
    let aoa_path = out_path(sc, &name)?;
    let drv = gdal::DriverManager::get_driver_by_name("GTiff").map_err(|e| e.to_string())?;
    for (path, data, nod) in [(&di_path, di.clone(), f32::NAN), (&aoa_path, di.iter().map(|x| if x.is_nan() { 255.0 } else if (*x as f64) <= thr { 1.0 } else { 0.0 }).collect::<Vec<f32>>(), 255.0)] {
        let mut out = drv.create_with_band_type::<f32, _>(path, w, h, 1).map_err(|e| e.to_string())?;
        out.set_geo_transform(&gt).map_err(|e| e.to_string())?;
        out.set_spatial_ref(&srs).map_err(|e| e.to_string())?;
        let mut b = out.rasterband(1).map_err(|e| e.to_string())?;
        b.set_no_data_value(Some(nod as f64)).map_err(|e| e.to_string())?;
        let mut buf = gdal::raster::Buffer::new((w, h), data);
        b.write((0, 0), (w, h), &mut buf).map_err(|e| e.to_string())?;
    }
    let hd = register(sc, &di_path, &format!("{name}_di"), json!({ "kind": "raster", "title": "Dissimilarity index (DI)", "units": "" }))?;
    let ha = register(sc, &aoa_path, &name, json!({ "kind": "classes", "title": "Area of applicability", "classes": [{ "value": 0, "label": "outside: predictions not supported", "color": "#d1495b" }, { "value": 1, "label": "inside the AOA", "color": "#66a182" }] }))?;
    let pct = 100.0 * inside as f64 / valid.max(1) as f64;
    let why = vec![format!("{} training points, {} predictors: DI threshold {:.3}; {:.1} % of the area is inside the area of applicability", train.len(), np, thr, pct)];
    sc.cards.push(("Area of applicability".into(), format!("{pct:.0} % of the area")));
    sc.methods.push(format!("The area of applicability (Meyer & Pebesma 2021) was estimated from {} training points and {} standardised predictors: cells whose dissimilarity index exceeds {:.3}, the outlier-removed maximum of the training points' cross-validated DI, lie outside it.", train.len(), np, thr));
    Ok(StepOut { outputs: json!({ "di": hd.info.id, "aoa": ha.info.id, "threshold": thr, "inside_pct": (pct * 10.0).round() / 10.0, "training_points": train.len() }), why })
}

// ------------------------------------------------------------------ kNNDM

/// 1-Wasserstein distance between two samples (via their quantile functions).
pub fn wasserstein(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return f64::INFINITY;
    }
    let mut a = a.to_vec();
    let mut b = b.to_vec();
    a.sort_by(|x, y| x.total_cmp(y));
    b.sort_by(|x, y| x.total_cmp(y));
    let n = 200;
    let qf = |v: &[f64], p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    (0..n).map(|i| (qf(&a, (i as f64 + 0.5) / n as f64) - qf(&b, (i as f64 + 0.5) / n as f64)).abs()).sum::<f64>() / n as f64
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// Test-to-train nearest-neighbour distances of a fold assignment (each point to the nearest point of
/// another fold).
fn cv_nnd(pts: &[[f64; 2]], folds: &[usize]) -> Vec<f64> {
    pts.iter().enumerate().map(|(i, p)| pts.iter().enumerate().filter(|(j, _)| folds[*j] != folds[i]).map(|(_, q)| dist(*p, *q)).fold(f64::INFINITY, f64::min)).collect()
}

/// k-means on coordinates (deterministic start: points spread along the data, Lloyd iterations).
fn kmeans(pts: &[[f64; 2]], q: usize) -> Vec<usize> {
    let n = pts.len();
    let mut c: Vec<[f64; 2]> = (0..q).map(|i| pts[(i * n) / q]).collect();
    let mut lab = vec![0usize; n];
    for _ in 0..40 {
        for (i, p) in pts.iter().enumerate() {
            lab[i] = (0..q).min_by(|a, b| dist(*p, c[*a]).total_cmp(&dist(*p, c[*b]))).unwrap();
        }
        let mut s = vec![[0.0, 0.0, 0.0]; q];
        for (i, p) in pts.iter().enumerate() {
            s[lab[i]][0] += p[0];
            s[lab[i]][1] += p[1];
            s[lab[i]][2] += 1.0;
        }
        for k in 0..q {
            if s[k][2] > 0.0 {
                c[k] = [s[k][0] / s[k][2], s[k][1] / s[k][2]];
            }
        }
    }
    lab
}

/// kNNDM: the fold assignment (k folds) whose CV distances best match `pred_nnd`. Tries random folds and
/// spatial clusters (q clusters merged into k folds by size), keeping the smallest Wasserstein distance.
pub fn knndm(pts: &[[f64; 2]], pred_nnd: &[f64], k: usize) -> (Vec<usize>, f64, String) {
    let n = pts.len();
    // random folds (a fixed shuffle, so runs repeat)
    let mut order: Vec<usize> = (0..n).collect();
    let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
    for i in (1..n).rev() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        order.swap(i, (s % (i as u64 + 1)) as usize);
    }
    let mut random = vec![0; n];
    for (r, &i) in order.iter().enumerate() {
        random[i] = r % k;
    }
    let mut best = (random.clone(), wasserstein(&cv_nnd(pts, &random), pred_nnd), "random".to_string());
    let mut q = k;
    while q < n.min(10 * k + 1) {
        let lab = kmeans(pts, q);
        // merge clusters into k folds, largest first into the smallest fold (balanced sizes)
        let mut sizes: Vec<(usize, usize)> = (0..q).map(|c| (c, lab.iter().filter(|&&l| l == c).count())).collect();
        sizes.sort_by(|a, b| b.1.cmp(&a.1));
        let mut fold_of = vec![0; q];
        let mut load = vec![0usize; k];
        for (c, sz) in sizes {
            let f = (0..k).min_by_key(|f| load[*f]).unwrap();
            fold_of[c] = f;
            load[f] += sz;
        }
        let folds: Vec<usize> = lab.iter().map(|l| fold_of[*l]).collect();
        let w = wasserstein(&cv_nnd(pts, &folds), pred_nnd);
        if w < best.1 {
            best = (folds, w, format!("{q} spatial clusters"));
        }
        q = ((q as f64) * 1.5).ceil() as usize;
    }
    best
}

pub(super) fn knndm_step(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let l = sc.layer(p_str(p, "layer").ok_or("layer is required (the training points)")?)?;
    let area = sc.layer(p_str(p, "area").ok_or("area is required (a polygon layer: where the map will be predicted)")?)?;
    let k = num(p, "folds").unwrap_or(5.0).clamp(2.0, 20.0) as usize;
    let mut fs = features::read_layer(sc.engine, &l, None, None, 20_000)?;
    let polys = features::read_layer(sc.engine, &area, None, None, 10_000)?;
    let ll: Vec<[f64; 2]> = fs.feats.iter().filter_map(|f| features::anchor(&f.geom)).collect();
    if ll.len() < 2 * k {
        return Err(format!("{} training points: need at least {} for {k} folds", ll.len(), 2 * k));
    }
    // a local plane in metres around the points
    let lat0 = ll.iter().map(|c| c[1]).sum::<f64>() / ll.len() as f64;
    let (kx, ky) = (111_320.0 * lat0.to_radians().cos(), 110_540.0);
    let xy = |c: [f64; 2]| [c[0] * kx, c[1] * ky];
    let pts: Vec<[f64; 2]> = ll.iter().map(|c| xy(*c)).collect();
    // prediction locations: a regular grid inside the area polygons
    let b = polys.bounds().ok_or("the area layer is empty")?;
    let rings: Vec<Vec<Vec<[f64; 2]>>> = polys.feats.iter().flat_map(|f| match &f.geom { crate::wkb::Geom::Polygons(p) => p.clone(), _ => vec![] }).collect();
    let mut pred = Vec::new();
    let steps = 60;
    for i in 0..steps {
        for j in 0..steps {
            let c = [b[0] + (b[2] - b[0]) * (i as f64 + 0.5) / steps as f64, b[1] + (b[3] - b[1]) * (j as f64 + 0.5) / steps as f64];
            if super::combine_steps::point_in_polys(c, &rings) {
                pred.push(xy(c));
            }
        }
    }
    if pred.len() < 10 {
        return Err("the area polygons are too small for a prediction grid".into());
    }
    let pred_nnd: Vec<f64> = pred.iter().map(|g| pts.iter().map(|t| dist(*g, *t)).fold(f64::INFINITY, f64::min)).collect();
    let (folds, w, how) = knndm(&pts, &pred_nnd, k);
    let w_random = wasserstein(&cv_nnd(&pts, &{
        let mut r = vec![0; pts.len()];
        for (i, x) in r.iter_mut().enumerate() {
            *x = i % k;
        }
        r
    }), &pred_nnd);
    let mut it = folds.iter();
    let mut fname = "fold".to_string();
    while fs.field(&fname).is_some() {
        fname.push('_');
    }
    fs.fields.push((fname, "integer"));
    for f in fs.feats.iter_mut() {
        let v = if features::anchor(&f.geom).is_some() { it.next().map(|x| Val::Int(*x as i64 + 1)).unwrap_or(Val::Null) } else { Val::Null };
        f.props.push(v);
    }
    let name = p_str(p, "name").map(str::to_string).unwrap_or_else(|| format!("{}_knndm", l.info.name));
    let title = format!("{} · kNNDM folds", sc.title_of(&l));
    let id = sc.write_output(&name, &fs, title)?;
    let why = vec![format!("{k} folds from {how}: Wasserstein distance {:.0} m to the prediction distances (random folds: {:.0} m)", w, w_random)];
    sc.methods.push(format!("Cross-validation folds were assigned with kNNDM (Linnenbrink et al. 2024): {k} folds whose test-to-training nearest-neighbour distances match those from the prediction area to the training points."));
    Ok(StepOut { outputs: json!({ "layer": id, "folds": k, "method": how, "w": (w * 10.0).round() / 10.0, "w_random": (w_random * 10.0).round() / 10.0 }), why })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q_is_one_when_strata_explain_everything_and_zero_when_nothing() {
        let y = [1.0, 1.0, 1.0, 5.0, 5.0, 5.0];
        assert!((q_stat(&y, &[0, 0, 0, 1, 1, 1]) - 1.0).abs() < 1e-12);
        assert!(q_stat(&y, &[0, 1, 0, 1, 0, 1]) < 0.2);
        // textbook example: two strata, within-strata variance known
        let y = [2.0, 4.0, 6.0, 8.0];
        // strata {2,4} and {6,8}: SSW = 2 + 2 = 4, SST = 20 → q = 0.8
        assert!((q_stat(&y, &[0, 0, 1, 1]) - 0.8).abs() < 1e-12);
    }

    #[test]
    fn opgd_finds_the_step_in_a_numeric_factor() {
        // y jumps at x = 50: the best discretisation separates it and q is near 1
        let x: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let y: Vec<f64> = x.iter().map(|v| if *v < 50.0 { 10.0 } else { 30.0 }).collect();
        let (q, _, _, _) = best_strata(&y, &x, 3, 8).unwrap();
        assert!(q > 0.95, "{q}");
    }

    #[test]
    fn di_and_threshold() {
        let train = vec![vec![0.0, 0.0], vec![1.0, 0.0], vec![0.0, 1.0], vec![1.0, 1.0]];
        let (di, mean) = dissimilarity(&train, &[vec![0.5, 0.5], vec![10.0, 10.0]], false);
        assert!(mean > 1.0 && mean < 1.2);
        assert!(di[0] < di[1] && di[1] > 5.0);
        assert!((aoa_threshold(&[0.1, 0.2, 0.3, 0.25, 5.0]) - 0.3).abs() < 1e-12, "5.0 is an outlier");
    }

    #[test]
    fn knndm_beats_random_for_clustered_points_and_a_wide_area() {
        // two tight clusters of training points far apart; predictions spread across the gap
        let mut pts = Vec::new();
        for i in 0..20 {
            pts.push([(i % 5) as f64, (i / 5) as f64]);
            pts.push([1000.0 + (i % 5) as f64, (i / 5) as f64]);
        }
        let pred: Vec<f64> = (0..200).map(|i| ((i as f64) * 2.5).min(500.0)).collect();
        let (_, w, how) = knndm(&pts, &pred, 2);
        let mut r = vec![0; pts.len()];
        for (i, x) in r.iter_mut().enumerate() {
            *x = i % 2;
        }
        let wr = wasserstein(&cv_nnd(&pts, &r), &pred);
        assert!(w < wr, "kNNDM {w} vs random {wr} ({how})");
        assert!(how.contains("spatial"));
        assert!(wasserstein(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]) < 1e-12);
    }
}
