//! Native spatial statistics (docs/AUTOMATION.md §6e): neighbour search, global Moran's I,
//! Getis-Ord Gi* hot spots with false-discovery-rate bins, the incremental spatial
//! autocorrelation scale search, empirical and fitted variograms, and ordinary kriging with
//! cross-validation. Plain f64 maths on projected (metre) coordinates, so the hot spot and
//! kriging recipes run without R or Python, on every OS.
//!
//! Clean-room from the published formulas: Moran (1950) with the Cliff & Ord (1981) moments,
//! Getis & Ord (1992), Ord & Getis (1995), Benjamini & Hochberg (1995), Matheron (1963),
//! Cressie (1993), Dubrule (1983). `scripts/test-stats.py` checks the results against R spdep
//! (`localG`, `moran.test`) and gstat (`variogram`, `fit.variogram`, `krige`, `krige.cv`).

pub type P2 = [f64; 2];

fn dist(a: P2, b: P2) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

pub fn mean_sd(v: &[f64]) -> (f64, f64) {
    if v.is_empty() {
        return (f64::NAN, f64::NAN);
    }
    let n = v.len() as f64;
    let m = v.iter().sum::<f64>() / n;
    (m, (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / n).sqrt())
}

pub fn median(v: &[f64]) -> f64 {
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
}

// ------------------------------------------------------------------ neighbour search

/// Uniform-grid index over points (about two points per cell): radius and k-nearest queries.
pub struct Index {
    pub pts: Vec<P2>,
    x0: f64,
    y0: f64,
    cell: f64,
    nx: usize,
    ny: usize,
    start: Vec<u32>,
    items: Vec<u32>,
}

impl Index {
    pub fn new(pts: &[P2]) -> Index {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for p in pts {
            x0 = x0.min(p[0]);
            y0 = y0.min(p[1]);
            x1 = x1.max(p[0]);
            y1 = y1.max(p[1]);
        }
        if pts.is_empty() {
            (x0, y0, x1, y1) = (0.0, 0.0, 1.0, 1.0);
        }
        let (w, h) = ((x1 - x0).max(1e-9), (y1 - y0).max(1e-9));
        let mut cell = (w * h / pts.len().max(1) as f64 * 2.0).sqrt().max(w.max(h) / 1024.0).max(1e-9);
        if (w / cell) as usize >= 2048 || (h / cell) as usize >= 2048 {
            cell = w.max(h) / 2047.0;
        }
        let (nx, ny) = ((w / cell) as usize + 1, (h / cell) as usize + 1);
        let cid = |p: &P2| (((p[1] - y0) / cell) as usize).min(ny - 1) * nx + (((p[0] - x0) / cell) as usize).min(nx - 1);
        let mut start = vec![0u32; nx * ny + 1];
        for p in pts {
            start[cid(p) + 1] += 1;
        }
        for i in 0..nx * ny {
            start[i + 1] += start[i];
        }
        let mut fill = start.clone();
        let mut items = vec![0u32; pts.len()];
        for (i, p) in pts.iter().enumerate() {
            let c = cid(p);
            items[fill[c] as usize] = i as u32;
            fill[c] += 1;
        }
        Index { pts: pts.to_vec(), x0, y0, cell, nx, ny, start, items }
    }

    pub fn len(&self) -> usize {
        self.pts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pts.is_empty()
    }

    fn cell_xy(&self, p: P2) -> (i64, i64) {
        (((p[0] - self.x0) / self.cell).floor() as i64, ((p[1] - self.y0) / self.cell).floor() as i64)
    }

    fn bucket(&self, cx: i64, cy: i64) -> &[u32] {
        if cx < 0 || cy < 0 || cx >= self.nx as i64 || cy >= self.ny as i64 {
            return &[];
        }
        let c = cy as usize * self.nx + cx as usize;
        &self.items[self.start[c] as usize..self.start[c + 1] as usize]
    }

    /// Every point within `r` of `p` (itself included when `p` is one of the points).
    pub fn within(&self, p: P2, r: f64, out: &mut Vec<(usize, f64)>) {
        out.clear();
        let (ax, ay) = self.cell_xy([p[0] - r, p[1] - r]);
        let (bx, by) = self.cell_xy([p[0] + r, p[1] + r]);
        for cy in ay.max(0)..=by.min(self.ny as i64 - 1) {
            for cx in ax.max(0)..=bx.min(self.nx as i64 - 1) {
                for &i in self.bucket(cx, cy) {
                    let d = dist(p, self.pts[i as usize]);
                    if d <= r {
                        out.push((i as usize, d));
                    }
                }
            }
        }
    }

    /// The `k` points nearest to `p`, closest first, leaving out index `skip`.
    pub fn knn(&self, p: P2, k: usize, skip: Option<usize>) -> Vec<(f64, usize)> {
        let mut best: Vec<(f64, usize)> = Vec::with_capacity(k + 1);
        if k == 0 || self.pts.is_empty() {
            return best;
        }
        let (qx, qy) = self.cell_xy(p);
        let last = (qx.abs().max((qx - self.nx as i64 + 1).abs())).max(qy.abs().max((qy - self.ny as i64 + 1).abs()));
        let visit = |cx: i64, cy: i64, best: &mut Vec<(f64, usize)>| {
            for &i in self.bucket(cx, cy) {
                let i = i as usize;
                if Some(i) == skip {
                    continue;
                }
                let d = dist(p, self.pts[i]);
                if best.len() < k || d < best[best.len() - 1].0 {
                    let at = best.partition_point(|b| b.0 <= d);
                    best.insert(at, (d, i));
                    best.truncate(k);
                }
            }
        };
        for r in 0..=last {
            if r == 0 {
                visit(qx, qy, &mut best);
            } else {
                for cx in qx - r..=qx + r {
                    visit(cx, qy - r, &mut best);
                    visit(cx, qy + r, &mut best);
                }
                for cy in qy - r + 1..qy + r {
                    visit(qx - r, cy, &mut best);
                    visit(qx + r, cy, &mut best);
                }
            }
            // anything in rings further out is at least r cells away
            if best.len() == k && best[k - 1].0 <= r as f64 * self.cell {
                break;
            }
        }
        best
    }
}

/// Distance from every point to its closest non-coincident neighbour (infinite when alone).
pub fn nn_distances(ix: &Index) -> Vec<f64> {
    (0..ix.len())
        .map(|i| {
            let mut k = 4;
            loop {
                let nb = ix.knn(ix.pts[i], k, Some(i));
                if let Some(d) = nb.iter().map(|x| x.0).find(|d| *d > 1e-9) {
                    return d;
                }
                if nb.len() < k {
                    return f64::INFINITY;
                }
                k *= 4;
            }
        })
        .collect()
}

/// Locational outliers: nearest-neighbour distance more than three standard deviations above the
/// mean (the rule ArcGIS Optimized Hot Spot Analysis documents).
pub fn locational_outliers(nn: &[f64]) -> Vec<bool> {
    let finite: Vec<f64> = nn.iter().copied().filter(|d| d.is_finite()).collect();
    let (m, sd) = mean_sd(&finite);
    nn.iter().map(|d| !d.is_finite() || *d > m + 3.0 * sd).collect()
}

/// Standard distance: the spatial equivalent of a standard deviation.
pub fn standard_distance(pts: &[P2]) -> f64 {
    let n = pts.len().max(1) as f64;
    let (mx, my) = (pts.iter().map(|p| p[0]).sum::<f64>() / n, pts.iter().map(|p| p[1]).sum::<f64>() / n);
    (pts.iter().map(|p| (p[0] - mx).powi(2) + (p[1] - my).powi(2)).sum::<f64>() / n).sqrt()
}

/// Mean distance from each point to its k-th nearest neighbour.
pub fn mean_knn_distance(ix: &Index, k: usize) -> f64 {
    let k = k.min(ix.len().saturating_sub(1)).max(1);
    let d: Vec<f64> = (0..ix.len()).filter_map(|i| ix.knn(ix.pts[i], k, Some(i)).last().map(|x| x.0)).collect();
    mean_sd(&d).0
}

/// Fixed-distance-band neighbours (binary; a feature is not its own neighbour here).
pub struct Neighbours {
    pub lists: Vec<Vec<u32>>,
}

impl Neighbours {
    /// Features exactly at the band distance count as inside (lattices such as hexagon centres
    /// put many pairs exactly there; the 1e-9 relative slack absorbs rounding).
    pub fn distance_band(ix: &Index, d: f64) -> Neighbours {
        let mut buf = Vec::new();
        let r = d * (1.0 + 1e-9);
        let lists = (0..ix.len())
            .map(|i| {
                ix.within(ix.pts[i], r, &mut buf);
                let mut l: Vec<u32> = buf.iter().filter(|(j, _)| *j != i).map(|(j, _)| *j as u32).collect();
                l.sort_unstable();
                l
            })
            .collect();
        Neighbours { lists }
    }

    /// Largest neighbour count within `d`, stopping early at `cap` (cheap check before building lists).
    pub fn max_count(ix: &Index, d: f64, cap: usize) -> usize {
        let mut buf = Vec::new();
        let mut best = 0;
        for i in 0..ix.len() {
            ix.within(ix.pts[i], d * (1.0 + 1e-9), &mut buf);
            best = best.max(buf.len().saturating_sub(1));
            if best >= cap {
                break;
            }
        }
        best
    }

    pub fn counts(&self) -> (usize, f64, usize) {
        let n = self.lists.len().max(1) as f64;
        let max = self.lists.iter().map(Vec::len).max().unwrap_or(0);
        let mean = self.lists.iter().map(Vec::len).sum::<usize>() as f64 / n;
        let isolated = self.lists.iter().filter(|l| l.is_empty()).count();
        (max, mean, isolated)
    }
}

// ------------------------------------------------------------------ normal distribution

/// Complementary error function (musl's implementation via the libm crate, ~1 ulp).
pub fn erfc(x: f64) -> f64 {
    libm::erfc(x)
}

/// Two-sided p-value of a standard normal z-score.
pub fn p_two_sided(z: f64) -> f64 {
    if !z.is_finite() {
        return if z.is_nan() { 1.0 } else { 0.0 };
    }
    erfc(z.abs() / std::f64::consts::SQRT_2).clamp(0.0, 1.0)
}

/// Benjamini–Hochberg: the largest p-value still significant at false discovery rate `alpha`
/// (None when nothing is).
pub fn bh_threshold(p: &[f64], alpha: f64) -> Option<f64> {
    let mut s: Vec<f64> = p.iter().copied().filter(|x| x.is_finite()).collect();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = s.len() as f64;
    let mut cut = None;
    for (k, pk) in s.iter().enumerate() {
        if *pk <= (k as f64 + 1.0) / m * alpha {
            cut = Some(*pk);
        }
    }
    cut
}

/// Hot/cold confidence bins (−3…3: 99, 95, 90 %) after the FDR correction, as ArcGIS `Gi_Bin`.
pub fn fdr_bins(z: &[f64]) -> (Vec<i8>, [Option<f64>; 3]) {
    let p: Vec<f64> = z.iter().map(|z| p_two_sided(*z)).collect();
    let cuts = [bh_threshold(&p, 0.10), bh_threshold(&p, 0.05), bh_threshold(&p, 0.01)];
    let bins = z
        .iter()
        .zip(&p)
        .map(|(z, p)| {
            let level = cuts.iter().rposition(|c| c.is_some_and(|c| *p <= c)).map(|i| i as i8 + 1).unwrap_or(0);
            if *z < 0.0 { -level } else { level }
        })
        .collect();
    (bins, cuts)
}

// ------------------------------------------------------------------ Moran's I and Gi*

#[derive(Clone, Copy, Debug)]
pub struct Moran {
    pub i: f64,
    pub expected: f64,
    pub variance: f64,
    pub z: f64,
    pub p: f64,
}

/// Global Moran's I with the randomisation variance (as spdep `moran.test` and ArcGIS), binary
/// or row-standardised distance-band weights. Features without neighbours count as R spdep's
/// `zero.policy = TRUE, adjust.n = TRUE` does.
pub fn moran(x: &[f64], nb: &Neighbours, row_standardise: bool) -> Option<Moran> {
    let n_all = x.len();
    let isolated = nb.lists.iter().filter(|l| l.is_empty()).count();
    let n = (n_all - isolated) as f64;
    if n < 4.0 {
        return None;
    }
    let mean = x.iter().sum::<f64>() / n_all as f64;
    let z: Vec<f64> = x.iter().map(|v| v - mean).collect();
    let zz: f64 = z.iter().map(|v| v * v).sum();
    if zz <= 0.0 {
        return None;
    }
    let k: Vec<f64> = nb.lists.iter().map(|l| l.len() as f64).collect();
    let w = |i: usize| if row_standardise { if k[i] > 0.0 { 1.0 / k[i] } else { 0.0 } } else { 1.0 };
    let (mut s0, mut s1, mut s2, mut cross) = (0.0, 0.0, 0.0, 0.0);
    for (i, l) in nb.lists.iter().enumerate() {
        let wi = w(i);
        let mut col = 0.0;
        for &j in l {
            let j = j as usize;
            s0 += wi;
            cross += wi * z[i] * z[j];
            // distance bands are symmetric: j lists i too, with weight w(j)
            s1 += (wi + w(j)).powi(2);
            col += w(j);
        }
        s2 += (wi * l.len() as f64 + col).powi(2);
    }
    s1 /= 2.0;
    if s0 <= 0.0 {
        return None;
    }
    let i_val = n / s0 * cross / zz;
    let expected = -1.0 / (n - 1.0);
    let b2 = n_all as f64 * z.iter().map(|v| v.powi(4)).sum::<f64>() / (zz * zz);
    let var = (n * ((n * n - 3.0 * n + 3.0) * s1 - n * s2 + 3.0 * s0 * s0) - b2 * ((n * n - n) * s1 - 2.0 * n * s2 + 6.0 * s0 * s0)) / ((n - 1.0) * (n - 2.0) * (n - 3.0) * s0 * s0)
        - expected * expected;
    let zs = if var > 0.0 { (i_val - expected) / var.sqrt() } else { f64::NAN };
    Some(Moran { i: i_val, expected, variance: var, z: zs, p: p_two_sided(zs) })
}

/// Getis-Ord Gi* z-scores: binary distance-band weights, each feature its own neighbour
/// (Ord & Getis 1995, eq. 3.3–3.4; identical to spdep `localG` with `include.self`).
pub fn gi_star(x: &[f64], nb: &Neighbours) -> Vec<f64> {
    let n = x.len() as f64;
    let mean = x.iter().sum::<f64>() / n;
    let s = (x.iter().map(|v| v * v).sum::<f64>() / n - mean * mean).max(0.0).sqrt();
    nb.lists
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let wi = 1.0 + l.len() as f64;
            let si = x[i] + l.iter().map(|&j| x[j as usize]).sum::<f64>();
            let den = s * ((n * wi - wi * wi) / (n - 1.0)).max(0.0).sqrt();
            if den > 0.0 { (si - mean * wi) / den } else { 0.0 }
        })
        .collect()
}

/// One distance of the incremental spatial autocorrelation search.
#[derive(Clone, Debug)]
pub struct Band {
    pub distance: f64,
    pub moran: Option<Moran>,
    pub mean_neighbours: f64,
}

/// Global Moran's I for `bands` distances `start, start + inc, …` (ArcGIS Incremental Spatial
/// Autocorrelation). Stops (returns `true`) when some feature would get `cap` or more neighbours.
pub fn incremental(ix: &Index, x: &[f64], start: f64, inc: f64, bands: usize, cap: usize) -> (Vec<Band>, bool) {
    let mut out = Vec::new();
    for b in 0..bands {
        let d = start + inc * b as f64;
        if Neighbours::max_count(ix, d, cap) >= cap {
            return (out, true);
        }
        let nb = Neighbours::distance_band(ix, d);
        let (_, mean, _) = nb.counts();
        out.push(Band { distance: d, moran: moran(x, &nb, true), mean_neighbours: mean });
    }
    (out, false)
}

/// The first statistically significant (z > 1.96) peak of the z-scores, as an index into `bands`.
pub fn first_peak(bands: &[Band]) -> Option<usize> {
    let z: Vec<f64> = bands.iter().map(|b| b.moran.map(|m| m.z).unwrap_or(f64::NAN)).collect();
    (1..z.len().saturating_sub(1)).find(|&k| z[k] > 1.96 && z[k] > z[k - 1] && z[k] > z[k + 1])
}

// ------------------------------------------------------------------ variograms

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    Sph,
    Exp,
    Gau,
}

impl Model {
    pub const ALL: [Model; 3] = [Model::Sph, Model::Exp, Model::Gau];

    pub fn name(self) -> &'static str {
        match self {
            Model::Sph => "spherical",
            Model::Exp => "exponential",
            Model::Gau => "gaussian",
        }
    }

    /// gstat's `vgm()` code
    pub fn code(self) -> &'static str {
        match self {
            Model::Sph => "Sph",
            Model::Exp => "Exp",
            Model::Gau => "Gau",
        }
    }

    pub fn parse(s: &str) -> Option<Model> {
        match s.to_ascii_lowercase().as_str() {
            "sph" | "spherical" => Some(Model::Sph),
            "exp" | "exponential" => Some(Model::Exp),
            "gau" | "gaussian" => Some(Model::Gau),
            _ => None,
        }
    }

    /// Correlation structure 0…1 at lag `h` for range parameter `a` (gstat parameterisation).
    pub fn shape(self, h: f64, a: f64) -> f64 {
        if h <= 0.0 {
            return 0.0;
        }
        let r = h / a;
        match self {
            Model::Sph => {
                if r >= 1.0 {
                    1.0
                } else {
                    1.5 * r - 0.5 * r * r * r
                }
            }
            Model::Exp => 1.0 - (-r).exp(),
            Model::Gau => 1.0 - (-r * r).exp(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Vgm {
    pub model: Model,
    pub nugget: f64,
    pub psill: f64,
    pub range: f64,
}

impl Vgm {
    pub fn gamma(&self, h: f64) -> f64 {
        if h <= 0.0 { 0.0 } else { self.nugget + self.psill * self.model.shape(h, self.range) }
    }
    pub fn sill(&self) -> f64 {
        self.nugget + self.psill
    }
    pub fn cov(&self, h: f64) -> f64 {
        self.sill() - self.gamma(h)
    }
    /// Distance at which correlation has (practically) vanished.
    pub fn practical_range(&self) -> f64 {
        match self.model {
            Model::Sph => self.range,
            Model::Exp => 3.0 * self.range,
            Model::Gau => 3f64.sqrt() * self.range,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Lag {
    pub dist: f64,
    pub gamma: f64,
    pub np: u64,
}

/// gstat's defaults: cutoff = a third of the data's bounding-box diagonal, 15 lags.
pub fn default_lags(pts: &[P2]) -> (f64, f64) {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let cutoff = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt() / 3.0;
    (cutoff, cutoff / 15.0)
}

/// Matheron's empirical semivariogram: mean half squared difference of all pairs per lag; the
/// lag distance is the mean pair distance (as gstat reports `dist`).
pub fn empirical(pts: &[P2], z: &[f64], cutoff: f64, width: f64) -> Vec<Lag> {
    let nb = (cutoff / width).ceil().max(1.0) as usize;
    let (mut np, mut sd, mut sg) = (vec![0u64; nb], vec![0.0; nb], vec![0.0; nb]);
    for i in 0..pts.len() {
        for j in i + 1..pts.len() {
            let d = dist(pts[i], pts[j]);
            if d > cutoff {
                continue;
            }
            let b = ((d / width) as usize).min(nb - 1);
            np[b] += 1;
            sd[b] += d;
            sg[b] += (z[i] - z[j]).powi(2);
        }
    }
    (0..nb).filter(|&b| np[b] > 0).map(|b| Lag { dist: sd[b] / np[b] as f64, gamma: sg[b] / (2.0 * np[b] as f64), np: np[b] }).collect()
}

/// Weighted least squares for (nugget, partial sill) at a fixed range, both kept ≥ 0.
fn sills_at(lags: &[Lag], model: Model, a: f64) -> (f64, f64, f64) {
    let w: Vec<f64> = lags.iter().map(|l| l.np as f64 / (l.dist * l.dist).max(1e-12)).collect();
    let f: Vec<f64> = lags.iter().map(|l| model.shape(l.dist, a)).collect();
    let sse = |c0: f64, c1: f64| lags.iter().enumerate().map(|(k, l)| w[k] * (l.gamma - c0 - c1 * f[k]).powi(2)).sum::<f64>();
    let (mut sw, mut swf, mut swff, mut swg, mut swfg) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (k, l) in lags.iter().enumerate() {
        sw += w[k];
        swf += w[k] * f[k];
        swff += w[k] * f[k] * f[k];
        swg += w[k] * l.gamma;
        swfg += w[k] * f[k] * l.gamma;
    }
    let mut cands: Vec<(f64, f64)> = Vec::new();
    let det = sw * swff - swf * swf;
    if det.abs() > 1e-300 {
        let c0 = (swg * swff - swf * swfg) / det;
        let c1 = (sw * swfg - swf * swg) / det;
        if c0 >= 0.0 && c1 >= 0.0 {
            cands.push((c0, c1));
        }
    }
    if swff > 0.0 {
        cands.push((0.0, (swfg / swff).max(0.0)));
    }
    if sw > 0.0 {
        cands.push(((swg / sw).max(0.0), 0.0));
    }
    cands.into_iter().map(|(c0, c1)| (c0, c1, sse(c0, c1))).min_by(|a, b| a.2.partial_cmp(&b.2).unwrap()).unwrap_or((0.0, 0.0, f64::INFINITY))
}

/// Fit nugget, partial sill and range by weighted least squares with gstat's default weights
/// (pairs / distance², `fit.method = 7`). Global search over the range, then golden-section
/// refinement; returns the model and its weighted sum of squared errors.
pub fn fit(lags: &[Lag], model: Model) -> Option<(Vgm, f64)> {
    if lags.len() < 3 {
        return None;
    }
    let hmax = lags.iter().map(|l| l.dist).fold(0.0, f64::max);
    let hmin = lags.iter().map(|l| l.dist).fold(f64::MAX, f64::min);
    let (lo, hi) = ((hmin * 0.1).max(hmax * 1e-3).ln(), (hmax * 10.0).ln());
    let steps = 120;
    let grid: Vec<f64> = (0..=steps).map(|i| lo + (hi - lo) * i as f64 / steps as f64).collect();
    let score = |la: f64| sills_at(lags, model, la.exp()).2;
    let (bi, _) = grid.iter().enumerate().map(|(i, la)| (i, score(*la))).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())?;
    let (mut a, mut b) = (grid[bi.saturating_sub(1)], grid[(bi + 1).min(steps)]);
    let g = (5f64.sqrt() - 1.0) / 2.0;
    let (mut c, mut d) = (b - g * (b - a), a + g * (b - a));
    let (mut fc, mut fd) = (score(c), score(d));
    for _ in 0..60 {
        if fc < fd {
            b = d;
            d = c;
            fd = fc;
            c = b - g * (b - a);
            fc = score(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + g * (b - a);
            fd = score(d);
        }
    }
    let la = (a + b) / 2.0;
    let la = if score(la) <= score(grid[bi]) { la } else { grid[bi] };
    let range = la.exp();
    let (nugget, psill, sse) = sills_at(lags, model, range);
    Some((Vgm { model, nugget, psill, range }, sse))
}

// ------------------------------------------------------------------ ordinary kriging

/// Dense LU factorisation with partial pivoting (the kriging systems are small).
struct Lu {
    n: usize,
    a: Vec<f64>,
    piv: Vec<usize>,
}

impl Lu {
    fn factor(mut a: Vec<f64>, n: usize) -> Option<Lu> {
        let mut piv: Vec<usize> = (0..n).collect();
        let scale = a.iter().fold(0.0f64, |m, v| m.max(v.abs())).max(1e-300);
        for k in 0..n {
            let (mut p, mut best) = (k, a[k * n + k].abs());
            for i in k + 1..n {
                if a[i * n + k].abs() > best {
                    best = a[i * n + k].abs();
                    p = i;
                }
            }
            if best <= scale * 1e-13 {
                return None;
            }
            if p != k {
                for j in 0..n {
                    a.swap(k * n + j, p * n + j);
                }
                piv.swap(k, p);
            }
            let d = a[k * n + k];
            for i in k + 1..n {
                let f = a[i * n + k] / d;
                a[i * n + k] = f;
                if f != 0.0 {
                    for j in k + 1..n {
                        a[i * n + j] -= f * a[k * n + j];
                    }
                }
            }
        }
        Some(Lu { n, a, piv })
    }

    fn solve(&self, b: &[f64]) -> Vec<f64> {
        let n = self.n;
        let mut x: Vec<f64> = self.piv.iter().map(|&p| b[p]).collect();
        for i in 0..n {
            let mut s = x[i];
            for j in 0..i {
                s -= self.a[i * n + j] * x[j];
            }
            x[i] = s;
        }
        for i in (0..n).rev() {
            let mut s = x[i];
            for j in i + 1..n {
                s -= self.a[i * n + j] * x[j];
            }
            x[i] = s / self.a[i * n + i];
        }
        x
    }
}

/// Ordinary kriging system `[C 1; 1ᵀ 0]` for a set of sample indices.
fn ok_matrix(pts: &[P2], idx: &[usize], v: &Vgm) -> Vec<f64> {
    let m = idx.len() + 1;
    let mut a = vec![0.0; m * m];
    let c0 = v.sill();
    for (r, &i) in idx.iter().enumerate() {
        for (c, &j) in idx.iter().enumerate().skip(r) {
            let cv = if i == j { c0 * (1.0 + 1e-12) } else { v.cov(dist(pts[i], pts[j])) };
            a[r * m + c] = cv;
            a[c * m + r] = cv;
        }
        a[r * m + m - 1] = 1.0;
        a[(m - 1) * m + r] = 1.0;
    }
    a
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Cv {
    pub n: usize,
    pub rmse: f64,
    pub mae: f64,
    pub me: f64,
    /// root mean square standardised error (≈ 1 when the kriging variance is right)
    pub rmsse: f64,
}

fn cv_stats(rows: &[(f64, f64, f64)]) -> Cv {
    // (observed, predicted, variance)
    let n = rows.len().max(1) as f64;
    let e: Vec<f64> = rows.iter().map(|r| r.1 - r.0).collect();
    let z: Vec<f64> = rows.iter().filter(|r| r.2 > 0.0).map(|r| (r.1 - r.0).powi(2) / r.2).collect();
    Cv {
        n: rows.len(),
        rmse: (e.iter().map(|x| x * x).sum::<f64>() / n).sqrt(),
        mae: e.iter().map(|x| x.abs()).sum::<f64>() / n,
        me: e.iter().sum::<f64>() / n,
        rmsse: if z.is_empty() { f64::NAN } else { (z.iter().sum::<f64>() / z.len() as f64).sqrt() },
    }
}

/// Ordinary kriging with a fitted variogram: all samples ("global", factorised once) or the
/// `nmax` nearest samples per prediction.
pub struct Kriging<'a> {
    pts: &'a [P2],
    z: &'a [f64],
    pub vgm: Vgm,
    pub nmax: usize,
    global: Option<Lu>,
    ix: Option<Index>,
}

impl<'a> Kriging<'a> {
    /// `nmax == 0` (or ≥ the number of samples) means all samples.
    pub fn new(pts: &'a [P2], z: &'a [f64], vgm: Vgm, nmax: usize) -> Result<Kriging<'a>, String> {
        if pts.len() < 3 {
            return Err("kriging needs at least 3 samples".into());
        }
        if nmax == 0 || nmax >= pts.len() {
            let idx: Vec<usize> = (0..pts.len()).collect();
            let lu = Lu::factor(ok_matrix(pts, &idx, &vgm), idx.len() + 1).ok_or("the kriging system is singular (duplicate samples or a degenerate variogram)")?;
            Ok(Kriging { pts, z, vgm, nmax: 0, global: Some(lu), ix: None })
        } else {
            Ok(Kriging { pts, z, vgm, nmax, global: None, ix: Some(Index::new(pts)) })
        }
    }

    fn solve_local(&self, p: P2, idx: &[usize]) -> Option<(f64, f64)> {
        let lu = Lu::factor(ok_matrix(self.pts, idx, &self.vgm), idx.len() + 1)?;
        let mut rhs: Vec<f64> = idx.iter().map(|&i| self.vgm.cov(dist(p, self.pts[i]))).collect();
        rhs.push(1.0);
        let lam = lu.solve(&rhs);
        Some(self.combine(&lam, &rhs, idx))
    }

    fn combine(&self, lam: &[f64], rhs: &[f64], idx: &[usize]) -> (f64, f64) {
        let m = idx.len();
        let pred: f64 = idx.iter().enumerate().map(|(k, &i)| lam[k] * self.z[i]).sum();
        let var = self.vgm.sill() - (0..m).map(|k| lam[k] * rhs[k]).sum::<f64>() - lam[m];
        (pred, var.max(0.0))
    }

    /// Prediction and kriging variance at `p`.
    pub fn predict(&self, p: P2) -> (f64, f64) {
        match (&self.global, &self.ix) {
            (Some(lu), _) => {
                let mut rhs: Vec<f64> = self.pts.iter().map(|q| self.vgm.cov(dist(p, *q))).collect();
                rhs.push(1.0);
                let lam = lu.solve(&rhs);
                let idx: Vec<usize> = (0..self.pts.len()).collect();
                self.combine(&lam, &rhs, &idx)
            }
            (None, Some(ix)) => {
                let idx: Vec<usize> = ix.knn(p, self.nmax, None).into_iter().map(|x| x.1).collect();
                self.solve_local(p, &idx).unwrap_or((f64::NAN, f64::NAN))
            }
            _ => (f64::NAN, f64::NAN),
        }
    }

    /// Kriging weights at `p` (global systems only; for tests and diagnostics).
    pub fn weights(&self, p: P2) -> Option<Vec<f64>> {
        let lu = self.global.as_ref()?;
        let mut rhs: Vec<f64> = self.pts.iter().map(|q| self.vgm.cov(dist(p, *q))).collect();
        rhs.push(1.0);
        let mut lam = lu.solve(&rhs);
        lam.pop();
        Some(lam)
    }

    /// Leave-one-out cross-validation. Global systems use Dubrule's (1983) closed form (one
    /// inverse instead of n refits); local neighbourhoods refit, on at most `max_points` samples.
    pub fn cross_validate(&self, max_points: usize) -> (Cv, Vec<(f64, f64, f64)>) {
        let n = self.pts.len();
        let mut rows = Vec::with_capacity(n.min(max_points));
        if let Some(lu) = &self.global {
            let m = n + 1;
            let mut b = self.z.to_vec();
            b.push(0.0);
            let kb = lu.solve(&b);
            let mut e = vec![0.0; m];
            for i in 0..n {
                e[i] = 1.0;
                let col = lu.solve(&e);
                e[i] = 0.0;
                let d = col[i];
                if d.abs() < 1e-300 {
                    continue;
                }
                // residual z_i − ẑ_(−i) = (K⁻¹b)_i / (K⁻¹)_ii, variance 1 / (K⁻¹)_ii
                let pred = self.z[i] - kb[i] / d;
                rows.push((self.z[i], pred, 1.0 / d));
            }
        } else if let Some(ix) = &self.ix {
            let step = (n / max_points.max(1)).max(1);
            for i in (0..n).step_by(step) {
                let idx: Vec<usize> = ix.knn(self.pts[i], self.nmax, Some(i)).into_iter().map(|x| x.1).collect();
                if let Some((pred, var)) = self.solve_local(self.pts[i], &idx) {
                    rows.push((self.z[i], pred, var));
                }
            }
        }
        (cv_stats(&rows), rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64)
    }

    #[test]
    fn index_matches_brute_force() {
        let mut s = 7u64;
        let pts: Vec<P2> = (0..500).map(|_| [lcg(&mut s) * 1000.0, lcg(&mut s) * 300.0]).collect();
        let ix = Index::new(&pts);
        for q in [[10.0, 10.0], [500.0, 150.0], [-200.0, 900.0], [999.0, 0.0]] {
            let mut brute: Vec<(f64, usize)> = pts.iter().enumerate().map(|(i, p)| (dist(q, *p), i)).collect();
            brute.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let got = ix.knn(q, 12, None);
            assert_eq!(got.iter().map(|x| x.1).collect::<Vec<_>>(), brute[..12].iter().map(|x| x.1).collect::<Vec<_>>());
            let mut w = Vec::new();
            ix.within(q, 120.0, &mut w);
            assert_eq!(w.len(), brute.iter().filter(|b| b.0 <= 120.0).count());
        }
    }

    #[test]
    fn normal_tail_and_fdr() {
        assert!((p_two_sided(1.959964) - 0.05).abs() < 1e-6);
        assert!((p_two_sided(2.575829) - 0.01).abs() < 1e-6);
        assert!((p_two_sided(0.0) - 1.0).abs() < 1e-12);
        assert!((erfc(0.3) - 0.671_373_240_540_872_7).abs() < 1e-13);
        assert!((erfc(5.0) - 1.537_459_794_428_034_8e-12).abs() < 1e-24);
        // Benjamini–Hochberg on a textbook list: 0.01·k/10 thresholds
        let p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
        assert_eq!(bh_threshold(&p, 0.05), Some(0.008));
        assert_eq!(bh_threshold(&p, 0.0001), None);
        let (bins, _) = fdr_bins(&[4.0, -3.0, 0.2, 2.2, -0.1, 0.0, 0.3, 0.5, -0.4, 0.1]);
        assert_eq!(bins[0], 3);
        // p(−3) = 0.0027 would pass a plain 99 % test, but with 10 tests the FDR cut-off for the
        // second-smallest p is 2 × 0.01 / 10 = 0.002, so it is demoted to 95 %
        assert_eq!(bins[1], -2);
        assert_eq!(bins[2], 0);
    }

    #[test]
    fn gi_star_by_hand() {
        // 5 points on a line 1 m apart, band 1 m: neighbours are the adjacent points
        let pts: Vec<P2> = (0..5).map(|i| [i as f64, 0.0]).collect();
        let x = [1.0, 2.0, 3.0, 10.0, 12.0];
        let nb = Neighbours::distance_band(&Index::new(&pts), 1.0);
        let z = gi_star(&x, &nb);
        // hand: mean 5.6, S = sqrt(258/5 − 31.36) = 4.4542; feature 3: W=3, sum=25
        let s = (258.0f64 / 5.0 - 5.6 * 5.6).sqrt();
        let want3 = (25.0 - 5.6 * 3.0) / (s * ((5.0 * 3.0 - 9.0) / 4.0f64).sqrt());
        assert!((z[3] - want3).abs() < 1e-12, "{} vs {want3}", z[3]);
        let want0 = (3.0 - 5.6 * 2.0) / (s * ((5.0 * 2.0 - 4.0) / 4.0f64).sqrt());
        assert!((z[0] - want0).abs() < 1e-12);
    }

    #[test]
    fn moran_detects_clustering_and_randomness() {
        // a smooth gradient on a 10×10 grid is strongly autocorrelated; a checkerboard is negative
        let pts: Vec<P2> = (0..100).map(|i| [(i % 10) as f64, (i / 10) as f64]).collect();
        let nb = Neighbours::distance_band(&Index::new(&pts), 1.0);
        let grad: Vec<f64> = pts.iter().map(|p| p[0] + p[1]).collect();
        let m = moran(&grad, &nb, true).unwrap();
        assert!(m.i > 0.8 && m.z > 8.0, "{m:?}");
        let check: Vec<f64> = pts.iter().map(|p| ((p[0] + p[1]) as i64 % 2) as f64).collect();
        let m = moran(&check, &nb, false).unwrap();
        assert!((m.i + 1.0).abs() < 1e-9 && m.z < -8.0, "{m:?}");
        assert!((m.expected + 1.0 / 99.0).abs() < 1e-12);
    }

    #[test]
    fn variogram_fit_recovers_a_known_model() {
        let truth = Vgm { model: Model::Sph, nugget: 0.2, psill: 1.3, range: 800.0 };
        let lags: Vec<Lag> = (1..=15).map(|k| {
            let h = k as f64 * 70.0;
            Lag { dist: h, gamma: truth.gamma(h), np: 100 + k as u64 * 10 }
        }).collect();
        let (v, sse) = fit(&lags, Model::Sph).unwrap();
        assert!(sse < 1e-6, "sse {sse}");
        assert!((v.range - 800.0).abs() < 1.0 && (v.nugget - 0.2).abs() < 1e-3 && (v.psill - 1.3).abs() < 1e-3, "{v:?}");
        // the exponential model fits the same data worse
        assert!(fit(&lags, Model::Exp).unwrap().1 > sse);
    }

    #[test]
    fn kriging_is_exact_unbiased_and_cv_closed_form_matches_refits() {
        let mut s = 11u64;
        let pts: Vec<P2> = (0..40).map(|_| [lcg(&mut s) * 1000.0, lcg(&mut s) * 1000.0]).collect();
        let z: Vec<f64> = pts.iter().map(|p| (p[0] / 300.0).sin() + p[1] / 1000.0 + lcg(&mut s) * 0.1).collect();
        let v = Vgm { model: Model::Exp, nugget: 0.01, psill: 0.6, range: 300.0 };
        let k = Kriging::new(&pts, &z, v, 0).unwrap();
        // exact at a sample, zero variance there
        let (p0, v0) = k.predict(pts[5]);
        assert!((p0 - z[5]).abs() < 1e-6 && v0 < 1e-6, "{p0} {} {v0}", z[5]);
        // weights sum to one anywhere
        let w = k.weights([500.0, 500.0]).unwrap();
        assert!((w.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        // Dubrule's closed-form leave-one-out equals refitting without each sample
        let (cv, rows) = k.cross_validate(10_000);
        assert_eq!(cv.n, 40);
        for i in [0, 7, 23, 39] {
            let keep: Vec<usize> = (0..40).filter(|&j| j != i).collect();
            let p2: Vec<P2> = keep.iter().map(|&j| pts[j]).collect();
            let z2: Vec<f64> = keep.iter().map(|&j| z[j]).collect();
            let (pred, var) = Kriging::new(&p2, &z2, v, 0).unwrap().predict(pts[i]);
            assert!((rows[i].1 - pred).abs() < 1e-8, "pred {i}: {} vs {pred}", rows[i].1);
            assert!((rows[i].2 - var).abs() < 1e-8, "var {i}: {} vs {var}", rows[i].2);
        }
        // a local neighbourhood with every sample equals the global system
        let kl = Kriging { pts: &pts, z: &z, vgm: v, nmax: 40, global: None, ix: Some(Index::new(&pts)) };
        let (a, b) = (k.predict([123.0, 456.0]), kl.predict([123.0, 456.0]));
        assert!((a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9);
    }

    #[test]
    fn incremental_search_finds_the_cluster_scale() {
        // clusters of high values ~150 m across on a 25 m lattice
        let mut pts = Vec::new();
        let mut x = Vec::new();
        for i in 0..40 {
            for j in 0..40 {
                let p = [i as f64 * 25.0, j as f64 * 25.0];
                let near = [[200.0, 200.0], [700.0, 600.0], [300.0, 800.0]].iter().map(|c| dist(p, *c)).fold(f64::MAX, f64::min);
                pts.push(p);
                x.push(if near < 150.0 { 10.0 } else { 1.0 } + ((i * 7 + j * 3) % 5) as f64 * 0.2);
            }
        }
        let ix = Index::new(&pts);
        let nn = nn_distances(&ix);
        assert!(nn.iter().all(|d| (d - 25.0).abs() < 1e-9));
        let (bands, capped) = incremental(&ix, &x, 25.0, 25.0, 12, 500);
        assert!(!capped);
        let z: Vec<f64> = bands.iter().map(|b| b.moran.unwrap().z).collect();
        assert!(z.iter().all(|v| *v > 10.0), "{z:?}");
        let nb = Neighbours::distance_band(&ix, 100.0);
        let gi = gi_star(&x, &nb);
        let (bins, _) = fdr_bins(&gi);
        // the cluster centres are 99 % hot spots, a far corner is not
        let at = |p: P2| pts.iter().position(|q| dist(*q, p) < 1.0).unwrap();
        assert_eq!(bins[at([200.0, 200.0])], 3);
        assert_eq!(bins[at([700.0, 600.0])], 3);
        assert!(bins[at([975.0, 0.0])] <= 0);
    }
}
