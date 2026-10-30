//! Geotagged sensor data (docs/DEVICES.md §5): logger CSV/JSON files, Garmin FIT activities,
//! and live readings pushed over HTTP or MQTT.
//!
//! Everything here turns "a position plus some numbers" into [`Reading`]s. The device hub keeps
//! them per device (scans) or per live sensor (pushes), writes them as a `readings` point
//! layer, and fires `sensor` triggers (docs/AUTOMATION.md §3).

use crate::devices::haversine;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Readings kept per file (a 1 Hz logger runs for 55 hours before this cuts in).
pub const MAX_READINGS: usize = 200_000;
/// Measurement columns kept per file (phone sensor apps export 70+ columns).
const MAX_FIELDS: usize = 32;

/// One geotagged measurement. `values` index into the owner's field list.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reading {
    pub source: String,
    pub lon: f64,
    pub lat: f64,
    pub t: Option<String>,
    pub values: Vec<(u16, f64)>,
}

/// What one sensor file holds.
#[derive(Debug, Clone, Default)]
pub struct SensorLog {
    /// (field name, unit)
    pub fields: Vec<(String, Option<String>)>,
    pub readings: Vec<Reading>,
    /// A moving logger's path (timed rows, small steps); none for station lists.
    pub track: Option<Vec<(f64, f64)>>,
    pub format: &'static str,
    /// Rows without a usable position (no fix yet, 0/0, out of range).
    pub skipped: usize,
}

impl SensorLog {
    fn field(&mut self, name: &str, unit: Option<String>) -> Option<u16> {
        if let Some(i) = self.fields.iter().position(|(n, _)| n == name) {
            return Some(i as u16);
        }
        if self.fields.len() >= MAX_FIELDS {
            return None;
        }
        self.fields.push((name.to_string(), unit));
        Some((self.fields.len() - 1) as u16)
    }
}

// ---------------------------------------------------------------- field names

/// Latin letters with accents → ASCII, so names stay readable in every language ("Température" → "temperature",
/// "verfügbare Fahrräder" → "verfugbare_fahrrader", "Straße" → "strasse").
fn fold_accent(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => "A",
        'ç' | 'ć' | 'č' => "c",
        'Ç' | 'Ć' | 'Č' => "C",
        'ď' | 'đ' | 'ð' => "d",
        'Ď' | 'Đ' | 'Ð' => "D",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ė' | 'Ę' | 'Ě' => "E",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => "i",
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' | 'Į' | 'İ' => "I",
        'ł' | 'ľ' | 'ĺ' => "l",
        'Ł' | 'Ľ' | 'Ĺ' => "L",
        'ñ' | 'ń' | 'ň' => "n",
        'Ñ' | 'Ń' | 'Ň' => "N",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o",
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' | 'Ő' => "O",
        'ŕ' | 'ř' => "r",
        'Ŕ' | 'Ř' => "R",
        'ś' | 'š' | 'ş' | 'ș' => "s",
        'Ś' | 'Š' | 'Ş' | 'Ș' => "S",
        'ť' | 'ţ' | 'ț' => "t",
        'Ť' | 'Ţ' | 'Ț' => "T",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => "u",
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ů' | 'Ű' | 'Ų' => "U",
        'ý' | 'ÿ' => "y",
        'Ý' | 'Ÿ' => "Y",
        'ź' | 'ż' | 'ž' => "z",
        'Ź' | 'Ż' | 'Ž' => "Z",
        'ß' => "ss",
        'æ' => "ae",
        'Æ' => "AE",
        'œ' => "oe",
        'Œ' => "OE",
        'þ' => "th",
        'Þ' => "TH",
        _ => return None,
    })
}

/// "PM2.5 (µg/m³)" -> ("pm2_5", Some("µg/m³")); "locationLatitude(WGS84)" -> "location_latitude".
pub fn clean_field(h: &str) -> (String, Option<String>) {
    let h = h.trim().trim_matches('"').trim();
    let (base, unit) = match h.find(['(', '[']) {
        Some(i) if i > 0 => {
            let u = h[i + 1..].trim_end_matches([')', ']']).trim();
            (&h[..i], (!u.is_empty()).then(|| u.to_string()))
        }
        _ => (h, None),
    };
    let base: String = base.chars().map(|c| fold_accent(c).map(str::to_string).unwrap_or_else(|| c.to_string())).collect();
    let mut s = String::new();
    let mut prev_lower = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() {
            if c.is_ascii_uppercase() && prev_lower && !s.ends_with('_') {
                s.push('_');
            }
            prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
            s.push(c.to_ascii_lowercase());
        } else {
            prev_lower = false;
            if !s.is_empty() && !s.ends_with('_') {
                s.push('_');
            }
        }
    }
    let mut s = s.trim_matches('_').to_string();
    for (from, to) in [("pm_2_5", "pm2_5"), ("pm25", "pm2_5"), ("pm_10", "pm10"), ("pm_1_0", "pm1"), ("pm1_0", "pm1")] {
        if s == from || s.starts_with(&format!("{from}_")) {
            s = format!("{to}{}", &s[from.len()..]);
        }
    }
    if s.is_empty() {
        s = "value".into();
    } else if s.starts_with(|c: char| c.is_ascii_digit()) {
        s = format!("v_{s}");
    }
    (s, unit)
}

pub fn is_lat(n: &str) -> bool {
    n == "lat" || n.contains("latitude") || n.ends_with("_lat") || n.starts_with("lat_")
}

pub fn is_lon(n: &str) -> bool {
    matches!(n, "lon" | "lng" | "long") || n.contains("longitude") || n.ends_with("_lon") || n.ends_with("_lng") || n.ends_with("_long") || n.starts_with("lon_") || n.starts_with("lng_")
}

pub fn is_time(n: &str) -> bool {
    matches!(n, "time" | "t" | "ts" | "tst" | "timestamp" | "datetime" | "date_time" | "utc" | "date" | "created_at" | "recorded_at" | "epoch")
        || n.ends_with("_time")
        || n.starts_with("time_")
        || n.contains("timestamp")
}

/// Columns that are bookkeeping, not measurements.
fn skip_name(n: &str) -> bool {
    matches!(n, "id" | "fid" | "index" | "idx" | "seq" | "n" | "row" | "record" | "sample" | "device" | "name" | "source" | "sensor" | "sensor_id" | "device_id" | "values")
        || n.ends_with("_id")
        || ["accuracy", "hdop", "vdop", "pdop", "satellites", "bearing", "course", "heading", "since1970"].iter().any(|w| n.contains(w))
}

fn num_text(s: &str, decimal_comma: bool) -> Option<f64> {
    let s = s.trim().trim_matches('"').trim();
    if s.is_empty() {
        return None;
    }
    let v: Option<f64> = if decimal_comma && s.contains(',') && !s.contains('.') { s.replace(',', ".").parse().ok() } else { s.parse().ok() };
    v.filter(|x| x.is_finite())
}

fn split_row(line: &str, d: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if quoted && chars.peek() == Some(&'"') {
                cur.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if c == d && !quoted {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

fn header_line(text: &str) -> Option<&str> {
    text.lines().map(|l| l.trim_start_matches('\u{feff}')).find(|l| !l.trim().is_empty() && !l.starts_with('#'))
}

fn delimiter(header: &str) -> char {
    [',', ';', '\t'].into_iter().max_by_key(|d| header.matches(*d).count()).unwrap_or(',')
}

/// Cheap check on the first few KB: a CSV/TSV whose header has latitude and longitude
/// columns, or JSON (lines) whose first object has a position.
pub fn sniff(head: &[u8], ext: &str) -> bool {
    let text = String::from_utf8_lossy(head);
    match ext {
        "csv" | "tsv" | "txt" => header_line(&text).is_some_and(|h| {
            let cols: Vec<String> = split_row(h, delimiter(h)).iter().map(|c| clean_field(c).0).collect();
            cols.iter().any(|c| is_lat(c)) && cols.iter().any(|c| is_lon(c))
        }),
        "jsonl" | "ndjson" | "json" => {
            let first = text.trim_start().trim_start_matches('[').trim_start();
            let line = first.lines().next().unwrap_or("").trim().trim_end_matches(',');
            serde_json::from_str::<Value>(line).ok().and_then(|v| v.as_object().map(|m| position_of(m).is_some())).unwrap_or(false)
        }
        _ => false,
    }
}

// ---------------------------------------------------------------- CSV / TSV

/// A logger or phone-app CSV with latitude/longitude columns (comma, semicolon or tab).
pub fn read_csv(text: &str) -> Option<SensorLog> {
    let header = header_line(text)?;
    let d = delimiter(header);
    let cols: Vec<(String, Option<String>)> = split_row(header, d).iter().map(|h| clean_field(h)).collect();
    let lat = cols.iter().position(|c| is_lat(&c.0))?;
    let lon = cols.iter().position(|c| is_lon(&c.0))?;
    let time = cols.iter().position(|c| is_time(&c.0));
    let decimal_comma = d == ';';
    let mut lines = text.lines().map(|l| l.trim_start_matches('\u{feff}')).filter(|l| !l.trim().is_empty() && !l.starts_with('#'));
    lines.next();
    let rows: Vec<Vec<String>> = lines.take(MAX_READINGS).map(|l| split_row(l, d)).collect();
    let mut meas = Vec::new();
    for (i, (n, _)) in cols.iter().enumerate() {
        if i == lat || i == lon || Some(i) == time || is_time(n) || skip_name(n) || meas.len() >= MAX_FIELDS {
            continue;
        }
        let (mut ok, mut seen) = (0, 0);
        for r in rows.iter().take(500) {
            if let Some(s) = r.get(i).filter(|s| !s.trim().is_empty()) {
                seen += 1;
                ok += num_text(s, decimal_comma).is_some() as usize;
            }
        }
        if seen > 0 && ok * 10 >= seen * 8 {
            meas.push(i);
        }
    }
    let mut log = SensorLog { format: if d == '\t' { "tsv" } else { "csv" }, ..Default::default() };
    let mut idx = Vec::new();
    for &i in &meas {
        let (mut name, unit) = cols[i].clone();
        while log.fields.iter().any(|(n, _)| *n == name) || matches!(name.as_str(), "time" | "source" | "device") {
            name.push_str("_2");
        }
        idx.push(log.field(&name, unit));
    }
    for r in &rows {
        let (Some(y), Some(x)) = (r.get(lat).and_then(|s| num_text(s, decimal_comma)), r.get(lon).and_then(|s| num_text(s, decimal_comma))) else {
            log.skipped += 1;
            continue;
        };
        if y.abs() > 90.0 || x.abs() > 180.0 || (x == 0.0 && y == 0.0) {
            log.skipped += 1;
            continue;
        }
        let values = meas.iter().zip(&idx).filter_map(|(&i, k)| Some((((*k)?), r.get(i).and_then(|s| num_text(s, decimal_comma))?))).collect();
        let t = time.and_then(|i| r.get(i)).map(|s| s.trim().trim_matches('"').to_string()).filter(|s| !s.is_empty());
        log.readings.push(Reading { source: String::new(), lon: x, lat: y, t, values });
    }
    log.track = moving_track(&log.readings, time.is_some());
    (!log.readings.is_empty()).then_some(log)
}

/// A moving logger (timed rows a few metres apart) also gets a track line; a list of fixed
/// stations does not.
fn moving_track(r: &[Reading], timed: bool) -> Option<Vec<(f64, f64)>> {
    if !timed || r.len() < 10 {
        return None;
    }
    let pts: Vec<(f64, f64)> = r.iter().map(|x| (x.lon, x.lat)).collect();
    let mut steps: Vec<f64> = pts.windows(2).map(|w| haversine(w[0], w[1])).collect();
    let total: f64 = steps.iter().sum();
    steps.sort_by(f64::total_cmp);
    (steps[steps.len() / 2] < 500.0 && total > 50.0).then_some(pts)
}

// ---------------------------------------------------------------- JSON lines / arrays

/// Position of a JSON record: lat/lon keys (any naming above), a nested location/position
/// object, or a GeoJSON Point geometry.
pub fn position_of(m: &Map<String, Value>) -> Option<(f64, f64)> {
    let num = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()));
    let (mut lat, mut lon) = (None, None);
    for (k, v) in m {
        let n = clean_field(k).0;
        if lat.is_none() && is_lat(&n) {
            lat = num(v);
        } else if lon.is_none() && is_lon(&n) {
            lon = num(v);
        }
    }
    if let (Some(y), Some(x)) = (lat, lon) {
        return (y.abs() <= 90.0 && x.abs() <= 180.0 && !(x == 0.0 && y == 0.0)).then_some((x, y));
    }
    for k in ["location", "position", "coords", "gps", "geo"] {
        if let Some(Value::Object(inner)) = m.get(k)
            && let Some(p) = position_of(inner) {
                return Some(p);
            }
    }
    let c = m.get("geometry")?.get("coordinates")?.as_array()?;
    let (x, y) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
    (y.abs() <= 90.0 && x.abs() <= 180.0).then_some((x, y))
}

const META_KEYS: &[&str] = &[
    "lat", "lon", "lng", "latitude", "longitude", "t", "ts", "tst", "time", "timestamp", "acc", "accuracy", "alt", "altitude", "vel", "speed", "cog",
    "heading", "course", "bs", "m", "vac", "p", "created_at", "tid", "_type", "_id", "id", "device", "name", "kind", "source", "sensor", "sensor_id",
    "device_id", "topic", "conn", "rad", "values", "location", "position", "geometry", "type", "properties",
];

/// Numeric values of a record: an explicit `values` object, else every numeric key that is not
/// position/time/bookkeeping. Numeric strings count ("12.5"); nested objects are skipped.
pub fn values_of(m: &Map<String, Value>) -> Vec<(String, f64)> {
    let num = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok())).filter(|x| x.is_finite());
    let src: Vec<(&String, &Value)> = match m.get("values").and_then(Value::as_object) {
        Some(vals) => vals.iter().collect(),
        None => m.iter().filter(|(k, _)| !META_KEYS.contains(&k.as_str())).collect(),
    };
    let mut out: Vec<(String, f64)> = Vec::new();
    for (k, v) in src {
        if v.is_object() || v.is_array() || v.is_boolean() {
            continue;
        }
        let (n, _) = clean_field(k);
        if is_lat(&n) || is_lon(&n) || is_time(&n) || skip_name(&n) {
            continue;
        }
        if let Some(x) = num(v)
            && !out.iter().any(|(e, _)| *e == n) && out.len() < MAX_FIELDS {
                out.push((n, x));
            }
    }
    out
}

fn time_of(m: &Map<String, Value>) -> Option<String> {
    for (k, v) in m {
        if !is_time(&clean_field(k).0) {
            continue;
        }
        if let Some(s) = v.as_str().filter(|s| s.len() > 4) {
            return Some(s.to_string());
        }
        if let Some(x) = v.as_f64() {
            let secs = if x > 1e12 { x / 1000.0 } else { x };
            if secs > 1e8 {
                return chrono::DateTime::from_timestamp(secs as i64, 0).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            }
        }
    }
    None
}

/// JSON lines (`.jsonl`, `.ndjson`) or a JSON array of records with positions.
pub fn read_json(text: &str) -> Option<SensorLog> {
    let mut log = SensorLog { format: "json", ..Default::default() };
    let records: Box<dyn Iterator<Item = Value>> = if text.trim_start().starts_with('[') {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Array(a)) => Box::new(a.into_iter()),
            _ => return None,
        }
    } else {
        Box::new(text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()))
    };
    let mut timed = false;
    for v in records.take(MAX_READINGS) {
        let Some(m) = v.as_object() else { continue };
        let props = m.get("properties").and_then(Value::as_object).unwrap_or(m);
        let Some((x, y)) = position_of(m) else {
            log.skipped += 1;
            continue;
        };
        let t = time_of(props).or_else(|| time_of(m));
        timed |= t.is_some();
        let mut values = Vec::new();
        for (n, val) in values_of(props) {
            if let Some(k) = log.field(&n, None) {
                values.push((k, val));
            }
        }
        log.readings.push(Reading { source: String::new(), lon: x, lat: y, t, values });
    }
    log.track = moving_track(&log.readings, timed);
    (!log.readings.is_empty()).then_some(log)
}

// ---------------------------------------------------------------- Garmin FIT

/// FIT activity (watch, bike computer, many fitness sensors): track + per-second readings
/// (heart rate, altitude, speed, cadence, power, temperature ...).
pub fn read_fit(path: &Path) -> Option<SensorLog> {
    use fitparser::profile::MesgNum;
    use fitparser::Value as V;
    let mut file = std::fs::File::open(path).ok()?;
    let records = fitparser::from_reader(&mut file).ok()?;
    let mut log = SensorLog { format: "fit", ..Default::default() };
    let semis = |v: &V, units: &str| -> Option<f64> {
        let x: f64 = v.clone().try_into().ok()?;
        let deg = if units == "semicircles" || x.abs() > 180.0 { x * (180.0 / 2f64.powi(31)) } else { x };
        (deg.abs() <= 180.0 && x != 0.0).then_some(deg)
    };
    let skip = |n: &str| ["unknown", "fractional_", "accumulated_", "compressed_", "left_", "right_", "time_", "device_index", "activity_type", "cycles", "zone"].iter().any(|w| n.starts_with(w));
    for r in records.iter().filter(|r| r.kind() == MesgNum::Record) {
        let (mut lat, mut lon, mut t) = (None, None, None);
        let mut vals: Vec<(String, f64, String)> = Vec::new();
        for f in r.fields() {
            match f.name() {
                "position_lat" => lat = semis(f.value(), f.units()),
                "position_long" => lon = semis(f.value(), f.units()),
                "timestamp" => {
                    if let V::Timestamp(ts) = f.value() {
                        t = Some(ts.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
                    }
                }
                name if !skip(name) => {
                    if matches!(f.value(), V::Enum(_) | V::String(_) | V::Array(_) | V::Byte(_) | V::Invalid | V::Timestamp(_)) {
                        continue;
                    }
                    let Ok(x) = TryInto::<f64>::try_into(f.value().clone()) else { continue };
                    if !x.is_finite() {
                        continue;
                    }
                    let n = name.strip_prefix("enhanced_").unwrap_or(name).to_string();
                    let enhanced = name.starts_with("enhanced_");
                    match vals.iter().position(|(e, _, _)| *e == n) {
                        Some(i) if enhanced => vals[i] = (n, x, f.units().to_string()),
                        Some(_) => {}
                        None => vals.push((n, x, f.units().to_string())),
                    }
                }
                _ => {}
            }
        }
        let (Some(y), Some(x)) = (lat, lon) else {
            log.skipped += 1;
            continue;
        };
        let mut values = Vec::new();
        for (n, v, u) in vals {
            let unit = (!u.is_empty()).then(|| if u == "C" { "°C".to_string() } else { u });
            if let Some(k) = log.field(&n, unit) {
                values.push((k, v));
            }
        }
        log.readings.push(Reading { source: String::new(), lon: x, lat: y, t, values });
        if log.readings.len() >= MAX_READINGS {
            break;
        }
    }
    if log.readings.is_empty() {
        return None;
    }
    let pts: Vec<(f64, f64)> = log.readings.iter().map(|r| (r.lon, r.lat)).collect();
    log.track = (pts.len() >= 2).then_some(pts);
    Some(log)
}

// ---------------------------------------------------------------- live pushes (HTTP + MQTT)

/// One live message after parsing: a phone position, a sensor reading, or both.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LivePush {
    pub id: String,
    pub name: Option<String>,
    pub kind: &'static str,
    pub pos: Option<(f64, f64)>,
    pub alt: Option<f64>,
    pub speed: Option<f64>,
    pub course: Option<f64>,
    pub accuracy: Option<f64>,
    /// Unix seconds.
    pub t: Option<f64>,
    pub values: Vec<(String, f64)>,
    /// Where it came from, when that is more telling than the transport ("LoRaWAN · TTN", "SensorThings").
    pub network: Option<&'static str>,
}

/// Parse a live JSON message. Understands the GeoSpaX phone page, generic sensor JSON
/// (`{"id": "aq-01", "lat": .., "lon": .., "values": {"pm2_5": 41}}` or flat numeric keys)
/// and OwnTracks location messages. `topic` (MQTT) names the device when the body does not.
pub fn parse_live(body: &[u8], topic: Option<&str>) -> Result<LivePush, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("not JSON: {e}"))?;
    let m = v.as_object().ok_or("expected a JSON object")?;
    if let Some(p) = parse_lorawan(m)? {
        return Ok(p);
    }
    let f = |k: &str| m.get(k).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())));
    let pos = position_of(m);
    if pos.is_none() && (m.contains_key("lat") || m.contains_key("lon")) {
        return Err("lat/lon out of range".into());
    }
    let id = ["device", "id", "sensor_id", "sensor", "device_id", "tid"]
        .iter()
        .find_map(|k| m.get(*k).and_then(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string()))))
        .or_else(|| topic.map(|t| t.trim_matches('/').replace('/', "-")))
        .map(|s| crate::devices::slug(&s))
        .filter(|s| !s.is_empty());
    let owntracks = m.get("_type").and_then(Value::as_str) == Some("location");
    let t = if owntracks {
        f("tst")
    } else {
        // the phone page sends `t` in milliseconds; sensors send seconds, ms or ISO text
        ["t", "ts", "timestamp", "time"].iter().find_map(|k| match m.get(*k) {
            Some(Value::Number(n)) => n.as_f64().map(|x| if x > 1e11 { x / 1000.0 } else { x }),
            Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis() as f64 / 1000.0),
            _ => None,
        })
    };
    let values = values_of(m);
    let kind = if values.is_empty() || owntracks { "phone" } else { "sensor" };
    let mut values = values;
    if owntracks {
        values.retain(|(n, _)| n == "batt");
    }
    Ok(LivePush {
        id: id.unwrap_or_else(|| if kind == "phone" { "phone".into() } else { "sensor".into() }),
        name: m.get("name").and_then(Value::as_str).map(str::to_string),
        kind,
        pos,
        alt: f("altitude").or_else(|| f("alt")),
        speed: f("speed").or_else(|| f("vel").map(|kmh| kmh / 3.6)),
        course: f("heading").or_else(|| f("cog")).or_else(|| f("course")),
        accuracy: f("accuracy").or_else(|| f("acc")),
        t,
        values,
        network: None,
    })
}

/// How far off a position taken from a LoRaWAN gateway can be (it is the gateway's, not the sensor's).
pub const GATEWAY_ACCURACY_M: f64 = 2000.0;

/// LoRaWAN uplinks as network servers publish them over MQTT: The Things Stack (TTN v3,
/// `v3/{app}@{tenant}/devices/{device}/up`) and ChirpStack (v4 `application/{id}/device/{eui}/event/up`, v3).
/// `Ok(None)`: not a LoRaWAN message. Values: the decoded payload (one level of nesting flattened) plus the
/// strongest gateway's `rssi` and `snr` and the number of `gateways`. Position: from the decoded payload (GPS
/// trackers), else the device location set in the network console, else the strongest gateway's location
/// (approximate: accuracy GATEWAY_ACCURACY_M).
pub fn parse_lorawan(m: &Map<String, Value>) -> Result<Option<LivePush>, String> {
    type Place = (f64, f64, Option<f64>);
    fn obj(v: Option<&Value>) -> Option<&Map<String, Value>> {
        v.and_then(Value::as_object)
    }
    fn text(v: Option<&Value>) -> Option<String> {
        v.and_then(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string())))
    }
    fn num(v: Option<&Value>) -> Option<f64> {
        v.and_then(Value::as_f64)
    }
    fn place(l: &Map<String, Value>) -> Option<Place> {
        let (lat, lon) = (num(l.get("latitude"))?, num(l.get("longitude"))?);
        (lat.abs() <= 90.0 && lon.abs() <= 180.0 && !(lat == 0.0 && lon == 0.0)).then_some((lon, lat, num(l.get("altitude"))))
    }
    /// (rssi, snr, location) per receiving gateway
    fn gateways(list: Option<&Value>, snr_key: &str) -> Vec<(Option<f64>, Option<f64>, Option<Place>)> {
        list.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|g| {
                        let g = g.as_object()?;
                        Some((num(g.get("rssi")).or_else(|| num(g.get("channel_rssi"))), num(g.get(snr_key)), obj(g.get("location")).and_then(place)))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    let (network, id, decoded, time, console, gws) = if let Some(ids) = obj(m.get("end_device_ids")) {
        let up = obj(m.get("uplink_message")).ok_or("LoRaWAN message without an uplink (join, downlink or ack): ignored")?;
        let id = text(ids.get("device_id")).or_else(|| text(ids.get("dev_eui"))).ok_or("TTN uplink without a device id")?;
        let console = obj(up.get("locations")).and_then(|ls| {
            ["frm-payload", "user"].iter().find_map(|k| obj(ls.get(*k)).and_then(place)).or_else(|| ls.values().find_map(|v| v.as_object().and_then(place)))
        });
        let time = text(m.get("received_at")).or_else(|| text(up.get("received_at")));
        ("LoRaWAN · TTN", id, obj(up.get("decoded_payload")), time, console, gateways(up.get("rx_metadata"), "snr"))
    } else if let Some(info) = obj(m.get("deviceInfo")) {
        if !(m.contains_key("object") || m.contains_key("rxInfo") || m.contains_key("data")) {
            return Err("ChirpStack event without an uplink (join, status or ack): ignored".into());
        }
        let id = text(info.get("deviceName")).or_else(|| text(info.get("devEui"))).ok_or("ChirpStack uplink without a device")?;
        ("LoRaWAN · ChirpStack", id, obj(m.get("object")), text(m.get("time")), None, gateways(m.get("rxInfo"), "snr"))
    } else if m.contains_key("devEUI") && (m.contains_key("object") || m.contains_key("rxInfo")) {
        let id = text(m.get("deviceName")).or_else(|| text(m.get("devEUI"))).ok_or("ChirpStack uplink without a device")?;
        ("LoRaWAN · ChirpStack", id, obj(m.get("object")), text(m.get("time")), None, gateways(m.get("rxInfo"), "loRaSNR"))
    } else {
        return Ok(None);
    };
    let mut values = decoded.map(values_of).unwrap_or_default();
    if let Some(d) = decoded {
        for (k, v) in d {
            if let (Some(inner), false) = (v.as_object(), ["location", "position", "gps", "geo", "coords"].contains(&k.as_str())) {
                let prefix = clean_field(k).0;
                for (n, x) in values_of(inner) {
                    if values.len() < MAX_FIELDS {
                        values.push((format!("{prefix}_{n}"), x));
                    }
                }
            }
        }
    }
    let best = gws.iter().max_by(|a, b| a.0.unwrap_or(-1e9).total_cmp(&b.0.unwrap_or(-1e9)));
    if let Some((rssi, snr, _)) = best {
        values.extend(rssi.map(|r| ("rssi".to_string(), r)));
        values.extend(snr.map(|s| ("snr".to_string(), s)));
    }
    if !gws.is_empty() {
        values.push(("gateways".into(), gws.len() as f64));
    }
    let from_payload = decoded.and_then(|d| position_of(d).map(|p| (p, d.get("altitude").or_else(|| d.get("alt")).and_then(Value::as_f64))));
    let (pos, alt, accuracy) = match (from_payload, console, best.and_then(|b| b.2)) {
        (Some((p, a)), _, _) => (Some(p), a, decoded.and_then(|d| num(d.get("hdop")).map(|h| h * 5.0))),
        (None, Some((x, y, a)), _) => (Some((x, y)), a, None),
        (None, None, Some((x, y, a))) => (Some((x, y)), a, Some(GATEWAY_ACCURACY_M)),
        _ => (None, None, None),
    };
    let t = time.and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok()).map(|d| d.timestamp_millis() as f64 / 1000.0);
    Ok(Some(LivePush { id: crate::devices::slug(&id), name: Some(id), kind: "sensor", pos, alt, speed: None, course: None, accuracy, t, values, network: Some(network) }))
}

// ---------------------------------------------------------------- MQTT 3.1.1 subscriber

#[derive(Debug, Clone, PartialEq)]
pub struct MqttUrl {
    pub host: String,
    pub port: u16,
    pub topic: String,
    pub user: Option<String>,
    pub pass: Option<String>,
    /// `mqtts://`: TLS (server checked against Mozilla's CA list, or `ca`)
    pub tls: bool,
    /// PEM file with the CA that signed a private broker's certificate (`?ca=`)
    pub ca: Option<PathBuf>,
    /// Client certificate and key for brokers that want one (AWS IoT Core and the like: `?cert=&key=`)
    pub cert: Option<PathBuf>,
    pub key: Option<PathBuf>,
}

impl MqttUrl {
    /// The URL with the password hidden (for logs and the Devices pane).
    pub fn display(&self) -> String {
        format!(
            "{}://{}{}:{}/{}",
            if self.tls { "mqtts" } else { "mqtt" },
            self.user.as_ref().map(|u| format!("{u}:***@")).unwrap_or_default(),
            self.host,
            self.port,
            self.topic
        )
    }
}

/// `mqtt://[user[:pass]@]host[:1883]/topic/filter/#` or `mqtts://…[:8883]/…[?ca=ca.pem][&cert=c.pem&key=k.pem]`
/// (default topic `#`; `%23` = `#`, `%2B` = `+`).
pub fn parse_mqtt_url(s: &str) -> Result<MqttUrl, String> {
    let s = s.trim();
    let (tls, rest) = match (s.strip_prefix("mqtts://"), s.strip_prefix("mqtt://")) {
        (Some(r), _) => (true, r),
        (None, Some(r)) => (false, r),
        _ => return Err(format!("'{s}': MQTT sources look like mqtt://host:1883/sensors/# or mqtts://host:8883/sensors/#")),
    };
    let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
    let opt = |key: &str| {
        query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| PathBuf::from(crate::router::pct_decode(v))))
    };
    let (ca, cert, key) = (opt("ca"), opt("cert"), opt("key"));
    if !tls && (ca.is_some() || cert.is_some()) {
        return Err(format!("'{s}': ca/cert/key need mqtts://"));
    }
    if cert.is_some() != key.is_some() {
        return Err(format!("'{s}': a client certificate needs both cert= and key="));
    }
    let (auth_host, topic) = rest.split_once('/').unwrap_or((rest, "#"));
    let topic = if topic.is_empty() { "#".to_string() } else { topic.replace("%23", "#").replace("%2B", "+").replace("%2b", "+") };
    let (auth, hostport) = match auth_host.rsplit_once('@') {
        Some((a, h)) => (Some(a), h),
        None => (None, auth_host),
    };
    let (user, pass) = match auth.map(|a| a.split_once(':').map(|(u, p)| (u, Some(p))).unwrap_or((a, None))) {
        Some((u, p)) => (Some(u.to_string()), p.map(str::to_string)),
        None => (None, None),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().map_err(|_| format!("'{s}': bad port '{p}'"))?),
        None => (hostport.to_string(), if tls { 8883 } else { 1883 }),
    };
    if host.is_empty() {
        return Err(format!("'{s}': missing host"));
    }
    Ok(MqttUrl { host, port, topic, user, pass, tls, ca, cert, key })
}

/// TLS failures in words a user can act on (rustls error text kept in brackets).
pub fn tls_hint(m: String) -> String {
    let hint = if m.contains("UnknownIssuer") || m.contains("BadSignature") {
        "the broker's certificate is not signed by a CA this computer trusts; for a private broker add ?ca=/path/to/ca.pem"
    } else if m.contains("NotValidForName") {
        "the broker's certificate is for another host name"
    } else if m.contains("Expired") || m.contains("NotValidYet") {
        "the broker's certificate has expired or is not valid yet (check the clock)"
    } else if m.contains("CertificateRequired") || m.contains("alert: BadCertificate") || m.contains("alert: HandshakeFailure") {
        "the broker wants a client certificate: add ?cert=client.pem&key=client.key"
    } else if m.contains("CorruptMessage") || m.contains("InvalidContentType") {
        "the broker did not answer TLS (is this the plain MQTT port? mqtts:// is usually 8883)"
    } else {
        return m;
    };
    format!("TLS: {hint} ({m})")
}

/// TLS settings for one `mqtts://` source.
fn tls_client_config(u: &MqttUrl) -> Result<Arc<rustls::ClientConfig>, String> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let mut roots = rustls::RootCertStore::empty();
    match &u.ca {
        Some(ca) => {
            for c in CertificateDer::pem_file_iter(ca).map_err(|e| format!("CA file {}: {e}", ca.display()))? {
                roots.add(c.map_err(|e| format!("CA file {}: {e}", ca.display()))?).map_err(|e| format!("CA file {}: {e}", ca.display()))?;
            }
        }
        None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
    }
    let builder = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots);
    let cfg = match (&u.cert, &u.key) {
        (Some(cert), Some(key)) => {
            let chain: Vec<CertificateDer<'static>> =
                CertificateDer::pem_file_iter(cert).and_then(|it| it.collect::<Result<_, _>>()).map_err(|e| format!("client certificate {}: {e}", cert.display()))?;
            let k = PrivateKeyDer::from_pem_file(key).map_err(|e| format!("client key {}: {e}", key.display()))?;
            builder.with_client_auth_cert(chain, k).map_err(|e| format!("client certificate: {e}"))?
        }
        _ => builder.with_no_client_auth(),
    };
    Ok(Arc::new(cfg))
}

/// A broker connection, plain or TLS. Read timeouts are set on the socket underneath (rustls keeps partial
/// records across them).
enum Conn {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Conn {
    fn set_read_timeout(&self, d: Option<Duration>) -> std::io::Result<()> {
        match self {
            Conn::Plain(s) => s.set_read_timeout(d),
            Conn::Tls(t) => t.sock.set_read_timeout(d),
        }
    }

    fn send(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.write_all(bytes)?;
        self.flush()
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.read(buf),
            Conn::Tls(t) => t.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.write(buf),
            Conn::Tls(t) => t.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Plain(s) => s.flush(),
            Conn::Tls(t) => t.flush(),
        }
    }
}

fn push_len(mut n: usize, out: &mut Vec<u8>) {
    loop {
        let mut b = (n % 128) as u8;
        n /= 128;
        if n > 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            break;
        }
    }
}

fn push_str(s: &str, out: &mut Vec<u8>) {
    out.extend_from_slice(&(s.len() as u16).to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn packet(first: u8, body: &[u8]) -> Vec<u8> {
    let mut v = vec![first];
    push_len(body.len(), &mut v);
    v.extend_from_slice(body);
    v
}

pub fn connect_packet(client_id: &str, user: Option<&str>, pass: Option<&str>, keepalive_s: u16) -> Vec<u8> {
    let mut b = Vec::new();
    push_str("MQTT", &mut b);
    b.push(4); // protocol level 3.1.1
    b.push(0x02 | if user.is_some() { 0x80 } else { 0 } | if pass.is_some() { 0x40 } else { 0 });
    b.extend_from_slice(&keepalive_s.to_be_bytes());
    push_str(client_id, &mut b);
    if let Some(u) = user {
        push_str(u, &mut b);
    }
    if let Some(p) = pass {
        push_str(p, &mut b);
    }
    packet(0x10, &b)
}

pub fn subscribe_packet(packet_id: u16, topic: &str) -> Vec<u8> {
    let mut b = packet_id.to_be_bytes().to_vec();
    push_str(topic, &mut b);
    b.push(0); // QoS 0
    packet(0x82, &b)
}

/// (topic, payload, QoS-1 packet id to acknowledge) of a PUBLISH body.
pub fn parse_publish(first: u8, body: &[u8]) -> Option<(String, &[u8], Option<[u8; 2]>)> {
    let tl = u16::from_be_bytes([*body.first()?, *body.get(1)?]) as usize;
    let topic = String::from_utf8_lossy(body.get(2..2 + tl)?).to_string();
    let qos = (first >> 1) & 3;
    let mut off = 2 + tl;
    let mut ack = None;
    if qos > 0 {
        let id = body.get(off..off + 2)?;
        off += 2;
        if qos == 1 {
            ack = Some([id[0], id[1]]);
        }
    }
    Some((topic, body.get(off..)?, ack))
}

fn read_len(s: &mut impl Read) -> std::io::Result<usize> {
    let (mut len, mut mult) = (0usize, 1usize);
    loop {
        let mut b = [0u8; 1];
        s.read_exact(&mut b)?;
        len += (b[0] & 0x7f) as usize * mult;
        if b[0] & 0x80 == 0 {
            return Ok(len);
        }
        mult *= 128;
        if mult > 128 * 128 * 128 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad MQTT length"));
        }
    }
}

/// Connection state shown in the Devices pane and `GET /api/devices`.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct MqttStatus {
    pub url: String,
    pub connected: bool,
    pub messages: u64,
    pub readings: u64,
    pub ignored: u64,
    pub last_topic: Option<String>,
    pub error: Option<String>,
}

/// Run one MQTT subscription for ever (reconnects with back-off). Each message goes to
/// `on_message(topic, payload)`, which returns whether it was used.
pub fn run_mqtt(url: &str, status: &dyn Fn(&mut dyn FnMut(&mut MqttStatus)), on_message: &dyn Fn(&str, &[u8]) -> bool) {
    let u = match parse_mqtt_url(url) {
        Ok(u) => u,
        Err(e) => {
            status(&mut |s| s.error = Some(e.clone()));
            eprintln!("devices: {e}");
            return;
        }
    };
    status(&mut |s| s.url = u.display());
    let mut backoff = 2;
    loop {
        let t0 = Instant::now();
        let res = mqtt_session(&u, status, on_message);
        status(&mut |s| s.connected = false);
        if let Err(e) = res {
            eprintln!("devices: MQTT {}: {e}", u.display());
            status(&mut |s| s.error = Some(e.clone()));
        }
        if t0.elapsed() > Duration::from_secs(60) {
            backoff = 2;
        }
        std::thread::sleep(Duration::from_secs(backoff));
        backoff = (backoff * 2).min(60);
    }
}

fn mqtt_session(u: &MqttUrl, status: &dyn Fn(&mut dyn FnMut(&mut MqttStatus)), on_message: &dyn Fn(&str, &[u8]) -> bool) -> Result<(), String> {
    let addr = (u.host.as_str(), u.port).to_socket_addrs().map_err(|e| format!("cannot resolve {}: {e}", u.host))?.next().ok_or("no address")?;
    let sock = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).map_err(|e| format!("cannot connect: {e}"))?;
    let _ = sock.set_nodelay(true);
    sock.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let mut s = if u.tls {
        let name = rustls::pki_types::ServerName::try_from(u.host.clone()).map_err(|e| format!("TLS: '{}': {e}", u.host))?;
        let conn = rustls::ClientConnection::new(tls_client_config(u)?, name).map_err(|e| format!("TLS: {e}"))?;
        Conn::Tls(Box::new(rustls::StreamOwned::new(conn, sock)))
    } else {
        Conn::Plain(sock)
    };
    let io = |e: std::io::Error| tls_hint(e.to_string());
    s.send(&connect_packet(&format!("geospax-{}-{}", std::process::id(), u.port), u.user.as_deref(), u.pass.as_deref(), 60)).map_err(io)?;
    let mut first = [0u8; 1];
    s.read_exact(&mut first).map_err(io)?;
    let len = read_len(&mut s).map_err(io)?;
    let mut body = vec![0u8; len];
    s.read_exact(&mut body).map_err(io)?;
    if first[0] >> 4 != 2 || body.len() < 2 {
        return Err("broker did not answer CONNECT".into());
    }
    if body[1] != 0 {
        return Err(match body[1] {
            1 => "broker refused: protocol version".into(),
            2 => "broker refused the client id".into(),
            3 => "broker unavailable".into(),
            4 => "broker refused: bad user name or password".into(),
            5 => "broker refused: not authorised".into(),
            c => format!("broker refused the connection (code {c})"),
        });
    }
    s.send(&subscribe_packet(1, &u.topic)).map_err(io)?;
    status(&mut |st| {
        st.connected = true;
        st.error = None;
    });
    eprintln!("devices: MQTT connected to {}", u.display());
    let mut last_ping = Instant::now();
    s.set_read_timeout(Some(Duration::from_secs(1))).map_err(io)?;
    loop {
        if last_ping.elapsed() > Duration::from_secs(30) {
            s.send(&[0xC0, 0]).map_err(io)?;
            last_ping = Instant::now();
        }
        match s.read(&mut first) {
            Ok(0) => return Err("broker closed the connection".into()),
            Ok(_) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => continue,
            Err(e) => return Err(e.to_string()),
        }
        // a packet started: read the rest without the short poll timeout
        s.set_read_timeout(Some(Duration::from_secs(10))).map_err(io)?;
        let len = read_len(&mut s).map_err(io)?;
        if len > 4 << 20 {
            return Err(format!("{len}-byte message is too large"));
        }
        let mut body = vec![0u8; len];
        s.read_exact(&mut body).map_err(io)?;
        s.set_read_timeout(Some(Duration::from_secs(1))).map_err(io)?;
        match first[0] >> 4 {
            3 => {
                let Some((topic, payload, ack)) = parse_publish(first[0], &body) else { continue };
                if let Some(id) = ack {
                    s.send(&[0x40, 2, id[0], id[1]]).map_err(io)?;
                }
                let used = on_message(&topic, payload);
                status(&mut |st| {
                    st.messages += 1;
                    if used { st.readings += 1 } else { st.ignored += 1 }
                    st.last_topic = Some(topic.clone());
                });
            }
            9 if body.get(2) == Some(&0x80) => return Err(format!("broker refused the subscription to '{}'", u.topic)),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- guidelines (sensor.summary)

/// WHO 2021 global air quality guideline levels (short-term), used to flag readings.
/// (field prefixes, label, level, unit, averaging time)
pub const GUIDELINES: &[(&[&str], &str, f64, &str, &str)] = &[
    (&["pm2_5"], "PM2.5", 15.0, "µg/m³", "24-hour"),
    (&["pm10"], "PM10", 45.0, "µg/m³", "24-hour"),
    (&["no2"], "NO₂", 25.0, "µg/m³", "24-hour"),
    (&["o3", "ozone"], "O₃", 100.0, "µg/m³", "8-hour"),
    (&["so2"], "SO₂", 40.0, "µg/m³", "24-hour"),
    (&["co"], "CO", 4.0, "mg/m³", "24-hour"),
];

pub fn guideline(field: &str) -> Option<&'static (&'static [&'static str], &'static str, f64, &'static str, &'static str)> {
    GUIDELINES.iter().find(|g| g.0.iter().any(|p| field == *p || field.starts_with(&format!("{p}_"))))
}

/// Field a lazy map should show first: a pollutant, then heart rate, CO₂, noise, temperature.
pub fn main_field<'a>(fields: &[&'a str]) -> Option<&'a str> {
    let order = ["pm2_5", "pm10", "no2", "o3", "so2", "co2", "co", "noise", "heart_rate", "temperature", "temp", "humidity", "soil_moisture", "power", "speed", "altitude"];
    for want in order {
        if let Some(f) = fields.iter().find(|f| **f == want || f.starts_with(&format!("{want}_"))) {
            return Some(f);
        }
    }
    fields.first().copied()
}

pub fn stats(v: &mut [f64]) -> Option<(usize, f64, f64, f64, f64)> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    let mean = v.iter().sum::<f64>() / n as f64;
    let p95 = v[((n as f64 - 1.0) * 0.95).round() as usize];
    Some((n, v[0], mean, p95, v[n - 1]))
}

/// Per-device helper for live stores: the newest values by name.
pub fn latest_values<'a>(readings: impl Iterator<Item = &'a Vec<(String, f64)>>) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for vals in readings {
        for (k, v) in vals {
            out.insert(k.clone(), *v);
        }
    }
    out
}

#[cfg(test)]
mod lorawan_tests {
    use super::*;

    #[test]
    fn ttn_uplink_with_gps_payload() {
        let msg = br#"{"end_device_ids":{"device_id":"aq-node-1","application_ids":{"application_id":"air"},"dev_eui":"70B3D57ED0000001"},
          "received_at":"2026-10-15T01:00:00.5Z","uplink_message":{"f_port":2,"decoded_payload":{"pm2_5":41.2,"temperature":24.5,
          "latitude":-5.8601,"longitude":144.2301,"battery":{"voltage":3.6}},"rx_metadata":[
          {"gateway_ids":{"gateway_id":"gw-a"},"rssi":-97,"snr":6.5,"location":{"latitude":-5.85,"longitude":144.22}},
          {"gateway_ids":{"gateway_id":"gw-b"},"rssi":-80,"snr":9.0,"location":{"latitude":-5.80,"longitude":144.20}}]}}"#;
        let p = parse_live(msg, Some("v3/air@ttn/devices/aq-node-1/up")).unwrap();
        assert_eq!(p.id, "aq-node-1");
        assert_eq!(p.network, Some("LoRaWAN · TTN"));
        assert_eq!(p.pos, Some((144.2301, -5.8601)));
        assert_eq!(p.accuracy, None);
        assert_eq!(p.t, Some(1_792_026_000.5));
        let v: std::collections::HashMap<_, _> = p.values.iter().cloned().collect();
        assert_eq!(v.get("pm2_5"), Some(&41.2));
        assert_eq!(v.get("battery_voltage"), Some(&3.6));
        assert_eq!(v.get("rssi"), Some(&-80.0), "strongest gateway");
        assert_eq!(v.get("snr"), Some(&9.0));
        assert_eq!(v.get("gateways"), Some(&2.0));
        assert!(!v.contains_key("latitude"));
    }

    #[test]
    fn ttn_positions_from_console_then_gateway() {
        let user = br#"{"end_device_ids":{"device_id":"soil-3"},"uplink_message":{"decoded_payload":{"moisture":31},
          "locations":{"user":{"latitude":-5.9,"longitude":144.3,"source":"SOURCE_REGISTRY"}},"rx_metadata":[{"rssi":-90,"location":{"latitude":-5.0,"longitude":144.0}}]}}"#;
        let p = parse_live(user, None).unwrap();
        assert_eq!((p.pos, p.accuracy), (Some((144.3, -5.9)), None));
        let gw = br#"{"end_device_ids":{"device_id":"soil-4"},"uplink_message":{"decoded_payload":{"moisture":28},
          "rx_metadata":[{"rssi":-90,"snr":3,"location":{"latitude":-5.0,"longitude":144.0}}]}}"#;
        let p = parse_live(gw, None).unwrap();
        assert_eq!((p.pos, p.accuracy), (Some((144.0, -5.0)), Some(GATEWAY_ACCURACY_M)));
        let join = br#"{"end_device_ids":{"device_id":"soil-4"},"join_accept":{"session_key_id":"x"}}"#;
        assert!(parse_live(join, None).is_err());
    }

    #[test]
    fn chirpstack_v4_and_v3() {
        let v4 = br#"{"deviceInfo":{"deviceName":"water-tank","devEui":"0102030405060708"},"time":"2026-10-15T01:00:00Z",
          "object":{"level_cm":82.5},"rxInfo":[{"gatewayId":"g1","rssi":-60,"snr":10.25,"location":{"latitude":-5.81,"longitude":144.25}}]}"#;
        let p = parse_live(v4, None).unwrap();
        assert_eq!((p.id.as_str(), p.network), ("water-tank", Some("LoRaWAN · ChirpStack")));
        assert_eq!(p.accuracy, Some(GATEWAY_ACCURACY_M));
        assert!(p.values.contains(&("level_cm".into(), 82.5)) && p.values.contains(&("snr".into(), 10.25)));
        let v3 = br#"{"applicationName":"farm","deviceName":"rain-1","devEUI":"AQIDBAUGBwg=","object":{"rain_mm":1.2,"lat":-5.7,"lon":144.1},
          "rxInfo":[{"rssi":-70,"loRaSNR":7.5}]}"#;
        let p = parse_live(v3, None).unwrap();
        assert_eq!((p.id.as_str(), p.pos), ("rain-1", Some((144.1, -5.7))));
        assert!(p.values.contains(&("snr".into(), 7.5)));
        let status = br#"{"deviceInfo":{"deviceName":"water-tank"},"batteryLevel":80}"#;
        assert!(parse_live(status, None).is_err());
    }

    #[test]
    fn mqtt_urls_with_tls() {
        let u = parse_mqtt_url("mqtts://app@ttn:NNSXS.KEY@eu1.cloud.thethings.network/v3/%2B/devices/%2B/up").unwrap();
        assert!(u.tls);
        assert_eq!((u.host.as_str(), u.port, u.topic.as_str()), ("eu1.cloud.thethings.network", 8883, "v3/+/devices/+/up"));
        assert_eq!((u.user.as_deref(), u.pass.as_deref()), (Some("app@ttn"), Some("NNSXS.KEY")));
        assert_eq!(u.display(), "mqtts://app@ttn:***@eu1.cloud.thethings.network:8883/v3/+/devices/+/up");
        let u = parse_mqtt_url("mqtts://10.0.0.5:8884/sensors/#?ca=/etc/geospax/ca.pem&cert=/c.pem&key=/k.pem").unwrap();
        assert_eq!((u.port, u.topic.as_str()), (8884, "sensors/#"));
        assert_eq!(u.ca.as_deref(), Some(Path::new("/etc/geospax/ca.pem")));
        assert!(u.cert.is_some() && u.key.is_some());
        assert!(parse_mqtt_url("mqtt://h/t?ca=/x.pem").is_err(), "ca needs mqtts");
        assert!(parse_mqtt_url("mqtts://h/t?cert=/c.pem").is_err(), "cert needs key");
        assert_eq!(parse_mqtt_url("mqtt://h").unwrap().port, 1883);
    }

    #[test]
    fn field_names_in_any_language() {
        assert_eq!(clean_field("Anzahl verfügbarer Fahrräder").0, "anzahl_verfugbarer_fahrrader");
        assert_eq!(clean_field("Température (°C)"), ("temperature".to_string(), Some("°C".to_string())));
        assert_eq!(clean_field("Precipitación acumulada [mm]").0, "precipitacion_acumulada");
        assert_eq!(clean_field("Wasserstand über NN, Straße").0, "wasserstand_uber_nn_strasse");
        assert_eq!(clean_field("PM2.5 (ug.m-3)").0, "pm2_5");
        assert_eq!(clean_field("气温").0, "value", "non-Latin names fall back to 'value'");
    }

    #[test]
    fn tls_errors_in_words() {
        assert!(tls_hint("invalid peer certificate: UnknownIssuer".into()).contains("?ca="));
        assert!(tls_hint("received fatal alert: CertificateRequired".into()).contains("?cert="));
        assert!(tls_hint("invalid peer certificate: NotValidForName".into()).contains("host name"));
        assert_eq!(tls_hint("connection reset".into()), "connection reset");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_names() {
        assert_eq!(clean_field("PM2.5 (µg/m³)"), ("pm2_5".into(), Some("µg/m³".into())));
        assert_eq!(clean_field("PM 2.5").0, "pm2_5");
        assert_eq!(clean_field("pm25").0, "pm2_5");
        assert_eq!(clean_field("locationLatitude(WGS84)").0, "location_latitude");
        assert_eq!(clean_field("geo:long").0, "geo_long");
        assert_eq!(clean_field("Temperature [°C]"), ("temperature".into(), Some("°C".into())));
        assert_eq!(clean_field("2nd").0, "v_2nd");
        assert!(is_lat("location_latitude") && is_lon("geo_long") && is_lon("lng") && !is_lon("along_track"));
        assert!(is_time("logging_time") && is_time("timestamp") && !is_time("temperature"));
    }

    #[test]
    fn csv_logs() {
        let csv = "time,lat,lon,PM2.5 (µg/m³),PM10 (µg/m³),Temperature (°C),accuracy,id\n\
                   2026-10-13T08:00:00Z,-5.86,144.23,12.5,20.1,18.2,4,1\n\
                   2026-10-13T08:00:10Z,0,0,99,99,99,4,2\n\
                   2026-10-13T08:00:20Z,-5.8601,144.2302,14.0,,18.4,5,3\n";
        let log = read_csv(csv).unwrap();
        let names: Vec<&str> = log.fields.iter().map(|f| f.0.as_str()).collect();
        assert_eq!(names, ["pm2_5", "pm10", "temperature"]);
        assert_eq!(log.fields[0].1.as_deref(), Some("µg/m³"));
        assert_eq!(log.readings.len(), 2);
        assert_eq!(log.skipped, 1);
        assert_eq!(log.readings[1].values, vec![(0, 14.0), (2, 18.4)]);
        assert_eq!(log.readings[0].t.as_deref(), Some("2026-10-13T08:00:00Z"));
        // semicolons with decimal commas, quoted header
        let eu = "\"Zeit\";\"Breite\";\"latitude\";\"longitude\";\"NO2\"\n\"x\";\"1\";\"-5,86\";\"144,23\";\"31,5\"\n";
        let log = read_csv(eu).unwrap();
        assert_eq!((log.readings[0].lat, log.readings[0].lon), (-5.86, 144.23));
        assert!(log.fields.iter().any(|f| f.0 == "no2"));
        assert!(read_csv("a,b\n1,2\n").is_none());
        assert!(sniff(b"time,latitude,longitude,pm10\n", "csv") && !sniff(b"a,b,c\n", "csv"));
    }

    #[test]
    fn json_logs_and_live_messages() {
        let jl = "{\"ts\": 1781337600, \"location\": {\"lat\": -5.86, \"lng\": 144.23}, \"pm2_5\": \"12.5\", \"device\": \"aq\"}\n\
                  {\"ts\": 1781337610, \"geometry\": {\"type\": \"Point\", \"coordinates\": [144.231, -5.861]}, \"properties\": {\"pm2_5\": 13}}\n";
        let log = read_json(jl).unwrap();
        assert_eq!(log.readings.len(), 2);
        assert_eq!(log.fields[0].0, "pm2_5");
        assert!(log.readings[0].t.as_deref().unwrap().starts_with("2026-"));
        assert!(sniff(jl.as_bytes(), "jsonl"));
        // phone page: position only
        let p = parse_live(br#"{"lat":-5.86,"lon":144.23,"accuracy":5,"t":1781337600000,"device":"pixel","name":"Pixel"}"#, None).unwrap();
        assert_eq!((p.kind, p.id.as_str(), p.values.len(), p.t), ("phone", "pixel", 0, Some(1781337600.0)));
        // sensor with values
        let s = parse_live(br#"{"id":"aq-01","lat":-5.86,"lon":144.23,"values":{"pm2_5":41.2,"rh":80}}"#, None).unwrap();
        assert_eq!((s.kind, s.id.as_str()), ("sensor", "aq-01"));
        assert_eq!(s.values, vec![("pm2_5".to_string(), 41.2), ("rh".to_string(), 80.0)]);
        // flat values, id from the MQTT topic, no position
        let s = parse_live(br#"{"temperature":21.5,"humidity":60}"#, Some("farm/probe-7")).unwrap();
        assert_eq!((s.id.as_str(), s.pos, s.values.len()), ("farm-probe-7", None, 2));
        // OwnTracks
        let o = parse_live(br#"{"_type":"location","lat":-5.86,"lon":144.23,"tst":1781337600,"acc":12,"batt":81,"tid":"jo","vel":18,"bs":1}"#, Some("owntracks/jo/phone")).unwrap();
        assert_eq!((o.kind, o.id.as_str(), o.t, o.accuracy, o.speed), ("phone", "jo", Some(1781337600.0), Some(12.0), Some(5.0)));
        assert_eq!(o.values, vec![("batt".to_string(), 81.0)]);
        assert!(parse_live(br#"{"lat":95,"lon":0}"#, None).is_err());
    }

    #[test]
    fn mqtt_wire_format() {
        let u = parse_mqtt_url("mqtt://jo:secret@broker.local:1884/sensors/%23").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.topic.as_str(), u.user.as_deref(), u.pass.as_deref()), ("broker.local", 1884, "sensors/#", Some("jo"), Some("secret")));
        assert_eq!(u.display(), "mqtt://jo:***@broker.local:1884/sensors/#");
        assert_eq!(parse_mqtt_url("mqtt://localhost").unwrap().topic, "#");
        assert!(parse_mqtt_url("http://x").is_err());
        let c = connect_packet("gx", None, None, 60);
        assert_eq!(c, [0x10, 14, 0, 4, b'M', b'Q', b'T', b'T', 4, 2, 0, 60, 0, 2, b'g', b'x']);
        assert_eq!(subscribe_packet(1, "a/#"), [0x82, 8, 0, 1, 0, 3, b'a', b'/', b'#', 0]);
        let mut long = Vec::new();
        push_len(321, &mut long);
        assert_eq!(long, [0xC1, 0x02]);
        let body = [0, 3, b'a', b'/', b'b', 0, 7, b'{', b'}'];
        let (t, p, ack) = parse_publish(0x32, &body).unwrap();
        assert_eq!((t.as_str(), p, ack), ("a/b", &b"{}"[..], Some([0, 7])));
    }

    #[test]
    fn guidelines_and_main_field() {
        assert_eq!(guideline("pm2_5").unwrap().2, 15.0);
        assert_eq!(guideline("pm10_atm").unwrap().1, "PM10");
        assert!(guideline("co2").is_none() && guideline("temperature").is_none());
        assert_eq!(main_field(&["temperature", "humidity", "pm10", "pm2_5"]), Some("pm2_5"));
        assert_eq!(main_field(&["altitude", "heart_rate", "speed"]), Some("heart_rate"));
        let mut v = vec![3.0, 1.0, 2.0];
        assert_eq!(stats(&mut v), Some((3, 1.0, 2.0, 3.0, 3.0)));
    }
}
