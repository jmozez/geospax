// Climate time series for a place: monthly rainfall and temperature from the ERA5 reanalysis
// (through Open-Meteo, no key), the anomaly of each month against its 1991–2020 normal, and the
// trend over the years (Mann-Kendall test, Sen's slope). The answer to "is it drier than usual?"
// and "is it getting hotter here?".

use std::time::Instant;

use serde_json::{json, Value};

use super::charts::{self, Chart, Kind, Series};
use super::raster_steps::aoi;
use super::steps::{p_f64, p_str, StepCtx, StepOut};
use crate::raster;

pub const OPEN_METEO: &str = "https://archive-api.open-meteo.com/v1/archive";

/// One month: (year, month 1–12, value).
pub type Month = (i32, u32, f64);

/// Daily values (date "YYYY-MM-DD", value) to monthly sums (`sum`) or means.
pub fn monthly(days: &[(String, f64)], sum: bool) -> Vec<Month> {
    let mut out: Vec<(i32, u32, f64, u32)> = Vec::new();
    for (d, v) in days {
        if !v.is_finite() {
            continue;
        }
        let (Some(y), Some(m)) = (d.get(..4).and_then(|s| s.parse().ok()), d.get(5..7).and_then(|s| s.parse().ok())) else { continue };
        match out.last_mut() {
            Some(l) if l.0 == y && l.1 == m => {
                l.2 += v;
                l.3 += 1;
            }
            _ => out.push((y, m, *v, 1)),
        }
    }
    out.into_iter().map(|(y, m, s, n)| (y, m, if sum { s } else { s / n as f64 })).collect()
}

/// Each month's anomaly against the mean of that calendar month over the base years.
pub fn anomalies(ms: &[Month], base: (i32, i32)) -> Vec<Month> {
    let mut clim = [(0.0, 0u32); 12];
    for (y, m, v) in ms {
        if (base.0..=base.1).contains(y) {
            clim[*m as usize - 1].0 += v;
            clim[*m as usize - 1].1 += 1;
        }
    }
    ms.iter()
        .filter_map(|(y, m, v)| {
            let (s, n) = clim[*m as usize - 1];
            (n > 0).then(|| (*y, *m, v - s / n as f64))
        })
        .collect()
}

/// Mann-Kendall trend test and Sen's slope: (slope per step, Kendall's S, two-sided p-value).
pub fn mann_kendall(x: &[f64]) -> (f64, f64, f64) {
    let n = x.len();
    if n < 4 {
        return (0.0, 0.0, 1.0);
    }
    let mut s = 0.0;
    let mut slopes = Vec::with_capacity(n * (n - 1) / 2);
    for i in 0..n {
        for j in i + 1..n {
            let d = x[j] - x[i];
            s += if d > 0.0 { 1.0 } else if d < 0.0 { -1.0 } else { 0.0 };
            slopes.push((x[j] - x[i]) / (j - i) as f64);
        }
    }
    slopes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let sen = slopes[slopes.len() / 2];
    let nf = n as f64;
    let var = nf * (nf - 1.0) * (2.0 * nf + 5.0) / 18.0;
    let z = if s > 0.0 { (s - 1.0) / var.sqrt() } else if s < 0.0 { (s + 1.0) / var.sqrt() } else { 0.0 };
    (sen, s, 2.0 * (1.0 - phi(z.abs())))
}

/// Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7).
fn phi(z: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * z / std::f64::consts::SQRT_2);
    let erf = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-z * z / 2.0).exp();
    0.5 * (1.0 + erf)
}

/// Yearly totals (rain) or means (temperature) of complete years only.
fn yearly(ms: &[Month], sum: bool) -> Vec<(i32, f64)> {
    let mut out: Vec<(i32, f64, u32)> = Vec::new();
    for (y, _, v) in ms {
        match out.last_mut() {
            Some(l) if l.0 == *y => {
                l.1 += v;
                l.2 += 1;
            }
            _ => out.push((*y, *v, 1)),
        }
    }
    out.into_iter().filter(|o| o.2 == 12).map(|(y, s, n)| (y, if sum { s } else { s / n as f64 })).collect()
}

pub(super) fn climate_series(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let (b, what) = aoi(sc, p)?;
    let (lon, lat) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
    let start = p_f64(p, "start").unwrap_or(1991.0) as i32;
    let today = chrono::Utc::now().date_naive();
    let end = today - chrono::Duration::days(7);
    let base = p_str(p, "base").unwrap_or("1991-2020");
    let (b0, b1) = base.split_once('-').and_then(|(a, c)| Some((a.trim().parse().ok()?, c.trim().parse().ok()?))).ok_or("base must look like 1991-2020")?;
    let url = format!(
        "{}?latitude={lat:.4}&longitude={lon:.4}&start_date={start}-01-01&end_date={}&daily=precipitation_sum,temperature_2m_mean&timezone=UTC",
        p_str(p, "base_url").unwrap_or(OPEN_METEO),
        end.format("%Y-%m-%d")
    );
    let body: Value = serde_json::from_slice(&raster::http(&url, None, 120)?).map_err(|e| format!("Open-Meteo: {e}"))?;
    if let Some(r) = body["reason"].as_str() {
        return Err(format!("Open-Meteo: {r}"));
    }
    let dates: Vec<String> = body["daily"]["time"].as_array().ok_or("no daily data returned")?.iter().filter_map(|d| d.as_str().map(str::to_string)).collect();
    let col = |k: &str| -> Vec<(String, f64)> {
        dates.iter().zip(body["daily"][k].as_array().into_iter().flatten()).map(|(d, v)| (d.clone(), v.as_f64().unwrap_or(f64::NAN))).collect()
    };
    let rain = monthly(&col("precipitation_sum"), true);
    let temp = monthly(&col("temperature_2m_mean"), false);
    let (ra, ta) = (anomalies(&rain, (b0, b1)), anomalies(&temp, (b0, b1)));
    let (ry, ty) = (yearly(&rain, true), yearly(&temp, false));
    let (rs, _, rp) = mann_kendall(&ry.iter().map(|y| y.1).collect::<Vec<_>>());
    let (tsl, _, tp) = mann_kendall(&ty.iter().map(|y| y.1).collect::<Vec<_>>());
    let x = |y: i32, m: u32| y as f64 + (m as f64 - 0.5) / 12.0;
    let sig = |p: f64| if p < 0.05 { "significant" } else { "not significant" };
    // the last 12 months against normal
    let last12: f64 = ra.iter().rev().take(12).map(|m| m.2).sum();
    let normal12: f64 = rain.iter().rev().take(12).map(|m| m.2).sum::<f64>() - last12;
    let pct = if normal12 > 0.0 { last12 / normal12 * 100.0 } else { 0.0 };
    let latest_t = ta.last().map(|m| m.2).unwrap_or(0.0);

    sc.charts.push((
        "Rainfall anomaly by month".into(),
        charts::svg(&Chart {
            x_label: "year".into(),
            y_label: format!("rain vs {base} normal (mm/month)"),
            series: vec![Series { label: "monthly anomaly".into(), color: "@0".into(), width: 1.2, kind: Kind::Line, points: ra.iter().map(|m| (x(m.0, m.1), m.2)).collect() }],
            marks: vec![],
            hlines: vec![(0.0, "normal".into())],
            y_zero: false,
        }),
        format!("Monthly rainfall minus the {base} average for the same month, at {lat:.2}, {lon:.2}. Below zero is drier than usual. The last 12 months had {pct:.0} % of normal rainfall."),
    ));
    sc.charts.push((
        "Temperature anomaly by month".into(),
        charts::svg(&Chart {
            x_label: "year".into(),
            y_label: format!("temperature vs {base} normal (°C)"),
            series: vec![Series { label: "monthly anomaly".into(), color: "@1".into(), width: 1.2, kind: Kind::Line, points: ta.iter().map(|m| (x(m.0, m.1), m.2)).collect() }],
            marks: vec![],
            hlines: vec![(0.0, "normal".into())],
            y_zero: false,
        }),
        format!("Monthly mean temperature minus the {base} average for the same month. Trend: {:+.2} °C per decade (Sen's slope, Mann-Kendall p = {tp:.3}, {}).", tsl * 10.0, sig(tp)),
    ));
    sc.cards.push(("Rain, last 12 months".into(), format!("{pct:.0} % of normal")));
    sc.cards.push(("Temperature trend".into(), format!("{:+.2} °C per decade ({})", tsl * 10.0, sig(tp))));
    sc.cards.push(("Rainfall trend".into(), format!("{:+.0} mm per decade ({})", rs * 10.0, sig(rp))));
    sc.methods.push(format!(
        "Daily precipitation and 2 m air temperature for {lat:.3}, {lon:.3} ({what}) from {start} to {} were taken from the ERA5 reanalysis (Hersbach et al. 2020) through the Open-Meteo archive API and aggregated to months. Anomalies are against the {base} mean of each calendar month. Trends in yearly totals (rain) and means (temperature) over complete years use the Mann-Kendall test with Sen's slope.",
        end.format("%Y-%m-%d")
    ));
    let csv: String = std::iter::once("year,month,rain_mm,rain_anomaly_mm,temp_c,temp_anomaly_c".to_string())
        .chain(rain.iter().zip(&temp).map(|(r, t)| {
            let a = ra.iter().find(|m| m.0 == r.0 && m.1 == r.1).map(|m| m.2).unwrap_or(f64::NAN);
            let b = ta.iter().find(|m| m.0 == t.0 && m.1 == t.1).map(|m| m.2).unwrap_or(f64::NAN);
            format!("{},{},{:.1},{:.1},{:.2},{:.2}", r.0, r.1, r.2, a, t.2, b)
        }))
        .collect::<Vec<_>>()
        .join("\n");
    let dir = sc.outputs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = super::steps::sanitize(p_str(p, "name").unwrap_or("climate"));
    let path = dir.join(format!("{name}.csv"));
    std::fs::write(&path, csv).map_err(|e| e.to_string())?;
    Ok(StepOut {
        outputs: json!({ "csv": path, "months": rain.len(), "rain_last12_pct": pct.round(), "temp_trend_per_decade": (tsl * 100.0).round() / 10.0, "temp_trend_p": tp, "rain_trend_per_decade": (rs * 10.0).round(), "rain_trend_p": rp, "latest_temp_anomaly": latest_t, "seconds": t0.elapsed().as_secs_f64() }),
        why: vec![
            format!("{} months of ERA5 at {lat:.2}, {lon:.2} ({what})", rain.len()),
            format!("last 12 months: {pct:.0} % of normal rain; temperature trend {:+.2} °C/decade (p = {tp:.3})", tsl * 10.0),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months_and_anomalies() {
        let days: Vec<(String, f64)> = (1..=2).flat_map(|m| (1..=3).map(move |d| (format!("2000-0{m}-0{d}"), m as f64))).collect();
        let ms = monthly(&days, true);
        assert_eq!(ms, vec![(2000, 1, 3.0), (2000, 2, 6.0)]);
        let a = anomalies(&[(2000, 1, 10.0), (2001, 1, 20.0), (2002, 1, 30.0)], (2000, 2001));
        assert_eq!(a[2], (2002, 1, 15.0));
    }

    #[test]
    fn mann_kendall_finds_trend() {
        let up: Vec<f64> = (0..30).map(|i| i as f64 * 0.02 + if i % 2 == 0 { 0.05 } else { -0.05 }).collect();
        let (slope, s, p) = mann_kendall(&up);
        assert!(s > 0.0 && p < 0.01 && (slope - 0.02).abs() < 0.01, "{slope} {s} {p}");
        let flat: Vec<f64> = (0..30).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        assert!(mann_kendall(&flat).2 > 0.05);
    }
}
