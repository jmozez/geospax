//! Field statistics and classification for symbology (graduated colours,
//! unique values). One attribute column is scanned via the Arrow stream with
//! the geometry column ignored, so a 1M-row scan costs ~100-300 ms.
//!
//! Natural breaks = optimal 1-D k-means (Ckmeans.1d.dp: Wang & Song 2011;
//! Grønlund et al. 2017). Dynamic programming over sorted values with
//! divide-and-conquer row optimisation, O(k·n·log n). This is what Jenks'
//! "natural breaks" approximates. It runs on an order-statistics sample
//! (<= 10k values), which preserves the distribution's shape.

use serde_json::{json, Value};
use std::collections::HashMap;

pub const JENKS_SAMPLE: usize = 10_000;
pub const MAX_CLASSES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    EqualInterval,
    Quantile,
    NaturalBreaks,
}

impl std::str::FromStr for Method {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "equal" | "equal_interval" => Ok(Method::EqualInterval),
            "quantile" => Ok(Method::Quantile),
            "jenks" | "natural" | "natural_breaks" => Ok(Method::NaturalBreaks),
            o => Err(format!("unknown classification method '{o}' (equal|quantile|jenks)")),
        }
    }
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::EqualInterval => "equal",
            Method::Quantile => "quantile",
            Method::NaturalBreaks => "jenks",
        }
    }
}

/// Upper bounds of each class (ascending; the last one is the max).
/// `sorted` must be ascending and non-empty.
pub fn breaks(sorted: &[f64], k: usize, method: Method) -> Vec<f64> {
    let (min, max) = (sorted[0], sorted[sorted.len() - 1]);
    let k = k.clamp(1, MAX_CLASSES);
    if min == max {
        return vec![max];
    }
    let mut b = match method {
        Method::EqualInterval => (1..=k).map(|i| if i == k { max } else { min + (max - min) * i as f64 / k as f64 }).collect(),
        Method::Quantile => {
            let n = sorted.len();
            (1..=k).map(|i| if i == k { max } else { sorted[((n as f64 * i as f64 / k as f64).ceil() as usize).clamp(1, n) - 1] }).collect()
        }
        Method::NaturalBreaks => {
            let sample = order_sample(sorted, JENKS_SAMPLE);
            let mut b = ckmeans_breaks(&sample, k);
            if let Some(last) = b.last_mut() {
                *last = max;
            }
            b
        }
    };
    b.dedup_by(|a, b| a == b);
    b
}

/// Evenly spaced order statistics (keeps min and max).
fn order_sample(sorted: &[f64], m: usize) -> Vec<f64> {
    let n = sorted.len();
    if n <= m {
        return sorted.to_vec();
    }
    (0..m).map(|i| sorted[(i as f64 * (n - 1) as f64 / (m - 1) as f64).round() as usize]).collect()
}

/// Optimal univariate k-means class upper bounds on sorted data.
pub fn ckmeans_breaks(x: &[f64], k: usize) -> Vec<f64> {
    let n = x.len();
    // distinct values <= k: every value is its own class
    let mut distinct: Vec<f64> = x.to_vec();
    distinct.dedup();
    if distinct.len() <= k {
        return distinct;
    }
    // prefix sums of (x - shift) for numeric stability
    let shift = x[n / 2];
    let mut s1 = vec![0.0; n + 1];
    let mut s2 = vec![0.0; n + 1];
    for i in 0..n {
        let v = x[i] - shift;
        s1[i + 1] = s1[i] + v;
        s2[i + 1] = s2[i] + v * v;
    }
    // within-class sum of squares of x[j..=i]
    let ssq = |j: usize, i: usize| -> f64 {
        let cnt = (i - j + 1) as f64;
        let sum = s1[i + 1] - s1[j];
        (s2[i + 1] - s2[j] - sum * sum / cnt).max(0.0)
    };
    let mut d = vec![vec![0.0f64; n]; k];
    let mut bt = vec![vec![0usize; n]; k];
    for i in 0..n {
        d[0][i] = ssq(0, i);
    }
    // D[q][i] = min_{q <= j <= i} D[q-1][j-1] + ssq(j, i); the argmin is
    // monotone in i, so each row is solved by divide & conquer.
    fn row(
        q: usize,
        imin: usize,
        imax: usize,
        jmin: usize,
        jmax: usize,
        d: &mut [Vec<f64>],
        bt: &mut [Vec<usize>],
        ssq: &dyn Fn(usize, usize) -> f64,
    ) {
        if imin > imax {
            return;
        }
        let mid = (imin + imax) / 2;
        let (lo, hi) = (jmin.max(q), jmax.min(mid));
        let (mut best, mut best_j) = (f64::INFINITY, lo);
        for j in lo..=hi {
            let c = d[q - 1][j - 1] + ssq(j, mid);
            if c < best {
                best = c;
                best_j = j;
            }
        }
        d[q][mid] = best;
        bt[q][mid] = best_j;
        if mid > imin {
            row(q, imin, mid - 1, jmin, best_j, d, bt, ssq);
        }
        row(q, mid + 1, imax, best_j, jmax, d, bt, ssq);
    }
    for q in 1..k {
        row(q, q, n - 1, q, n - 1, &mut d, &mut bt, &ssq);
    }
    // backtrack: cluster q spans bt[q][i] ..= i
    let mut ub = vec![0.0; k];
    let mut i = n - 1;
    for q in (0..k).rev() {
        ub[q] = x[i];
        if q > 0 {
            i = bt[q][i] - 1;
        }
    }
    ub
}

/// Features per class (value v falls in the first class with v <= bound).
pub fn class_counts(sorted: &[f64], b: &[f64]) -> Vec<u64> {
    let mut counts = vec![0u64; b.len()];
    let mut start = 0;
    for (c, &ub) in b.iter().enumerate() {
        let end = if c + 1 == b.len() { sorted.len() } else { start + sorted[start..].partition_point(|&v| v <= ub) };
        counts[c] = (end - start) as u64;
        start = end;
    }
    counts
}

/// Summary statistics + class breaks for a numeric column (sorts in place).
pub fn numeric_summary(values: &mut [f64], k: usize, method: Method) -> Value {
    if values.is_empty() {
        return json!({ "count": 0, "breaks": [], "counts": [] });
    }
    values.sort_unstable_by(|a, b| a.total_cmp(b));
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let var = values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n;
    let b = breaks(values, k, method);
    let counts = class_counts(values, &b);
    json!({
        "count": values.len(),
        "min": values[0],
        "max": values[values.len() - 1],
        "mean": mean,
        "std": var.sqrt(),
        "median": values[values.len() / 2],
        "method": method.as_str(),
        "breaks": b,
        "counts": counts,
    })
}

/// Most frequent values (strings or numbers), descending by count.
pub fn unique_strings(values: Vec<String>, limit: usize) -> Value {
    let total = values.len() as u64;
    let mut m: HashMap<String, u64> = HashMap::new();
    for v in values {
        *m.entry(v).or_default() += 1;
    }
    top_n(m.into_iter().map(|(k, c)| (Value::from(k), c)).collect(), total, limit)
}

pub fn unique_numbers(values: Vec<f64>, limit: usize) -> Value {
    let total = values.len() as u64;
    let mut m: HashMap<u64, u64> = HashMap::new();
    for v in values {
        *m.entry(v.to_bits()).or_default() += 1;
    }
    let entries = m
        .into_iter()
        .map(|(bits, c)| {
            let v = f64::from_bits(bits);
            let jv = if v.fract() == 0.0 && v.abs() < 9e15 { Value::from(v as i64) } else { Value::from(v) };
            (jv, c)
        })
        .collect();
    top_n(entries, total, limit)
}

fn top_n(mut entries: Vec<(Value, u64)>, total: u64, limit: usize) -> Value {
    let distinct = entries.len();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_string().cmp(&b.0.to_string())));
    entries.truncate(limit);
    let shown: u64 = entries.iter().map(|e| e.1).sum();
    json!({
        "count": total,
        "distinct": distinct,
        "values": entries.into_iter().map(|(v, c)| json!({ "value": v, "count": c })).collect::<Vec<_>>(),
        "others": total - shown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Brute-force optimal partition for tiny inputs.
    fn brute(x: &[f64], k: usize) -> f64 {
        fn ssq(x: &[f64]) -> f64 {
            let m = x.iter().sum::<f64>() / x.len() as f64;
            x.iter().map(|v| (v - m) * (v - m)).sum()
        }
        fn rec(x: &[f64], k: usize) -> f64 {
            if k == 1 {
                return ssq(x);
            }
            (1..=x.len() - (k - 1)).map(|i| ssq(&x[..i]) + rec(&x[i..], k - 1)).fold(f64::INFINITY, f64::min)
        }
        rec(x, k)
    }

    fn cost(x: &[f64], ub: &[f64]) -> f64 {
        let mut total = 0.0;
        let mut start = 0;
        for (c, &b) in ub.iter().enumerate() {
            let end = if c + 1 == ub.len() { x.len() } else { start + x[start..].partition_point(|&v| v <= b) };
            let s = &x[start..end];
            let m = s.iter().sum::<f64>() / s.len() as f64;
            total += s.iter().map(|v| (v - m) * (v - m)).sum::<f64>();
            start = end;
        }
        total
    }

    #[test]
    fn ckmeans_matches_brute_force() {
        let mut seed = 0x9E3779B97F4A7C15u64;
        for trial in 0..40 {
            let n = 6 + trial % 9;
            let mut x: Vec<f64> = (0..n)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    (seed % 1000) as f64 / 10.0
                })
                .collect();
            x.sort_by(|a, b| a.total_cmp(b));
            x.dedup();
            for k in 2..=4.min(x.len() - 1) {
                let ub = ckmeans_breaks(&x, k);
                assert_eq!(ub.len(), k);
                let (got, want) = (cost(&x, &ub), brute(&x, k));
                assert!((got - want).abs() < 1e-6, "n={} k={k} got {got} want {want} x={x:?}", x.len());
            }
        }
    }

    #[test]
    fn obvious_clusters() {
        let x = [1.0, 1.1, 1.2, 5.0, 5.1, 5.2, 9.0, 9.1, 9.3];
        assert_eq!(ckmeans_breaks(&x, 3), vec![1.2, 5.2, 9.3]);
        assert_eq!(class_counts(&x, &[1.2, 5.2, 9.3]), vec![3, 3, 3]);
    }

    #[test]
    fn quantile_and_equal() {
        let x: Vec<f64> = (1..=100).map(|v| v as f64).collect();
        assert_eq!(breaks(&x, 4, Method::Quantile), vec![25.0, 50.0, 75.0, 100.0]);
        assert_eq!(breaks(&x, 3, Method::EqualInterval), vec![34.0, 67.0, 100.0]);
        assert_eq!(class_counts(&x, &[25.0, 50.0, 75.0, 100.0]), vec![25, 25, 25, 25]);
    }
}
