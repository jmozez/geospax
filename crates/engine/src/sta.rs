//! OGC SensorThings API (docs/DEVICES.md §4): poll a SensorThings service (FROST, the many public air-quality
//! and water-level services, a city's IoT platform) and treat every Thing that has a location as a live sensor.
//! One request per page returns the Things with their location and the newest observation of each datastream
//! (`$expand` with `$top=1` per datastream). Values are named after the observed property and carry its unit
//! (`PM2.5` in µg/m³ → `pm2_5`). A station is pushed only when its newest observation is newer than last time,
//! so sensor triggers (docs/AUTOMATION.md §3) fire on SensorThings stations like on any other live sensor.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::sensors::{clean_field, LivePush};
use crate::Engine;

const PAGE: usize = 100;

/// State shown in the Devices pane and `GET /api/devices` (`sta`).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StaStatus {
    pub url: String,
    pub things: usize,
    pub polls: u64,
    pub readings: u64,
    pub last_poll: Option<String>,
    pub error: Option<String>,
}

/// One SensorThings source: `https://host/v1.1[?every=60][&bbox=minlon,minlat,maxlon,maxlat][&filter=ODATA][&max=1000]`.
#[derive(Debug, Clone, PartialEq)]
pub struct StaSource {
    pub root: String,
    /// Seconds between polls (10 s .. 1 day; default 60).
    pub every: u64,
    /// OData `$filter` for the Things: `bbox=` becomes `st_intersects(Locations/location, geography'POLYGON(...)')`,
    /// `filter=` is passed as written; both together are joined with `and`.
    pub filter: Option<String>,
    /// Most stations read per poll (100 .. 10,000; default 1,000).
    pub max: usize,
    /// Goes into the station ids (`sta-<key>-<thing id>`), so two services never share an id: `name=`, or the
    /// telling part of the host name (`iot.hamburg.de` → `hamburg`).
    pub key: String,
}

/// `airquality-frost.k8s.example.de` → `airquality-frost`, `iot.hamburg.de` → `hamburg`, an IP address → `local`.
pub fn source_key(root: &str) -> String {
    let host = root.split("://").nth(1).unwrap_or(root).split('/').next().unwrap_or("");
    if host.starts_with('[') {
        return "local".into();
    }
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() || host.parse::<std::net::Ipv4Addr>().is_ok() {
        return "local".into();
    }
    const GENERIC: [&str; 11] = ["www", "api", "iot", "sta", "sensorthings", "frost", "data", "k8s", "server", "services", "gateway"];
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len().saturating_sub(1).max(1); // without the top-level domain
    let pick = labels[..n].iter().find(|l| !GENERIC.contains(l)).unwrap_or(&labels[0]);
    crate::devices::slug(pick)
}

impl StaSource {
    /// The service root, plus what limits it (for the Devices pane).
    pub fn display(&self) -> String {
        match &self.filter {
            Some(f) => format!("{} ({f})", self.root),
            None => self.root.clone(),
        }
    }
}

pub fn parse_sta_url(s: &str) -> Result<StaSource, String> {
    let s = s.trim();
    let (root, query) = s.split_once('?').unwrap_or((s, ""));
    if !(root.starts_with("http://") || root.starts_with("https://")) {
        return Err(format!("'{s}': SensorThings sources look like https://host/v1.1"));
    }
    let opt = |key: &str| query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| crate::router::pct_decode(v)));
    let every = opt("every").and_then(|v| v.parse::<u64>().ok()).unwrap_or(60).clamp(10, 86_400);
    let max = opt("max").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1000).clamp(PAGE, 10_000);
    let mut filters = Vec::new();
    if let Some(b) = opt("bbox") {
        let v: Vec<f64> = b.split(',').filter_map(|x| x.trim().parse().ok()).collect();
        let [x1, y1, x2, y2] = v[..] else { return Err(format!("'{s}': bbox=minlon,minlat,maxlon,maxlat")) };
        if !(x1 < x2 && y1 < y2 && x1 >= -180.0 && x2 <= 180.0 && y1 >= -90.0 && y2 <= 90.0) {
            return Err(format!("'{s}': bbox=minlon,minlat,maxlon,maxlat in degrees"));
        }
        filters.push(format!("st_intersects(Locations/location, geography'POLYGON(({x1} {y1}, {x2} {y1}, {x2} {y2}, {x1} {y2}, {x1} {y1}))')"));
    }
    if let Some(f) = opt("filter").filter(|f| !f.trim().is_empty()) {
        filters.push(f.trim().to_string());
    }
    let filter = match filters.len() {
        0 => None,
        1 => filters.pop(),
        _ => Some(filters.iter().map(|f| format!("({f})")).collect::<Vec<_>>().join(" and ")),
    };
    let root = root.trim_end_matches('/').to_string();
    let key = opt("name").map(|n| crate::devices::slug(&n)).filter(|k| !k.is_empty()).unwrap_or_else(|| source_key(&root));
    Ok(StaSource { root, every, filter, max, key })
}

/// Percent-encode an OData expression for a query string (keeps the characters OData itself uses).
fn encode_query(v: &str) -> String {
    let mut out = String::new();
    for b in v.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'(' | b')' | b'\'' | b',' | b'/' | b':' | b'*' | b'@' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// First page of Things with locations and the newest observation of every datastream.
pub fn things_url(src: &StaSource) -> String {
    let filter = src.filter.as_deref().map(|f| format!("&$filter={}", encode_query(f))).unwrap_or_default();
    format!(
        "{}/Things?$top={PAGE}{filter}&$expand=Locations($select=location),Datastreams($select=name,unitOfMeasurement;\
         $expand=ObservedProperty($select=name),Observations($orderby=phenomenonTime%20desc;$top=1;$select=result,phenomenonTime))",
        src.root
    )
}

/// Point position of a SensorThings location (GeoJSON geometry, or a Feature).
fn point(loc: &Value) -> Option<(f64, f64)> {
    let g = if loc.get("type").and_then(Value::as_str) == Some("Feature") { loc.get("geometry")? } else { loc };
    if g.get("type").and_then(Value::as_str) != Some("Point") {
        return None;
    }
    let c = g.get("coordinates")?.as_array()?;
    let (x, y) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
    (x.abs() <= 180.0 && y.abs() <= 90.0 && !(x == 0.0 && y == 0.0)).then_some((x, y))
}

/// `2026-10-15T01:00:00Z` or an interval `start/end` (the end counts) → Unix seconds.
fn phenomenon_time(v: &Value) -> Option<f64> {
    let s = v.as_str()?;
    let s = s.rsplit('/').next().unwrap_or(s);
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis() as f64 / 1000.0)
}

/// One page of Things → live sensors (those with a point location and at least one numeric observation),
/// plus the next page's URL.
pub fn parse_things(page: &Value, key: &str) -> (Vec<LivePush>, Option<String>) {
    let mut out = Vec::new();
    for thing in page.get("value").and_then(Value::as_array).into_iter().flatten() {
        let Some(t) = thing.as_object() else { continue };
        let Some(pos) = t.get("Locations").and_then(Value::as_array).and_then(|ls| ls.iter().find_map(|l| l.get("location").and_then(point))) else { continue };
        let id = match t.get("@iot.id") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => continue,
        };
        let mut values: Vec<(String, f64)> = Vec::new();
        let mut newest: Option<f64> = None;
        for ds in t.get("Datastreams").and_then(Value::as_array).into_iter().flatten() {
            let ds: &Map<String, Value> = match ds.as_object() {
                Some(d) => d,
                None => continue,
            };
            let Some(obs) = ds.get("Observations").and_then(Value::as_array).and_then(|o| o.first()) else { continue };
            let Some(x) = obs.get("result").and_then(|r| r.as_f64().or_else(|| r.as_str().and_then(|s| s.trim().parse().ok()))).filter(|x: &f64| x.is_finite()) else {
                continue;
            };
            let label = ds.get("ObservedProperty").and_then(|p| p.get("name")).and_then(Value::as_str).or_else(|| ds.get("name").and_then(Value::as_str)).unwrap_or("value");
            let unit = ds.get("unitOfMeasurement").and_then(|u| u.get("symbol")).and_then(Value::as_str).filter(|u| !u.is_empty());
            let (name, _) = clean_field(&match unit {
                Some(u) => format!("{label} ({u})"),
                None => label.to_string(),
            });
            // two instruments measuring the same thing (or names in a non-Latin script): pm2_5, pm2_5_2, ...
            let mut unique = name.clone();
            for k in 2.. {
                if !values.iter().any(|(n, _)| *n == unique) {
                    break;
                }
                unique = format!("{name}_{k}");
            }
            values.push((unique, x));
            if let Some(tm) = obs.get("phenomenonTime").and_then(phenomenon_time) {
                newest = Some(newest.map_or(tm, |n: f64| n.max(tm)));
            }
        }
        if values.is_empty() {
            continue;
        }
        let name = t.get("name").and_then(Value::as_str).map(str::to_string);
        out.push(LivePush {
            id: format!("sta-{key}-{}", crate::devices::slug(&id)),
            name,
            kind: "sensor",
            pos: Some(pos),
            alt: None,
            speed: None,
            course: None,
            accuracy: None,
            t: newest,
            values,
            network: Some("SensorThings"),
        });
    }
    let next = page.get("@iot.nextLink").and_then(Value::as_str).map(str::to_string);
    (out, next)
}

/// Poll one SensorThings service for ever.
pub fn run_sta(engine: &Arc<Engine>, url: &str, status: &dyn Fn(&mut dyn FnMut(&mut StaStatus))) {
    let src = match parse_sta_url(url) {
        Ok(v) => v,
        Err(e) => {
            status(&mut |s| s.error = Some(e.clone()));
            eprintln!("devices: {e}");
            return;
        }
    };
    let (root, every) = (src.root.clone(), src.every);
    status(&mut |s| s.url = src.display());
    let mut last: HashMap<String, f64> = HashMap::new();
    loop {
        let mut next = Some(things_url(&src));
        let (mut things, mut pushed, mut error) = (0usize, 0u64, None);
        for _ in 0..src.max.div_ceil(PAGE) {
            let Some(u) = next.take() else { break };
            let page = crate::raster::http(&u, None, 30).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| format!("not SensorThings JSON: {e}")));
            match page {
                Ok(v) => {
                    if let Some(msg) = v.get("message").and_then(Value::as_str).filter(|_| v.get("value").is_none()) {
                        error = Some(format!("service says: {msg}"));
                        break;
                    }
                    let (sensors, n) = parse_things(&v, &src.key);
                    things += sensors.len();
                    for p in sensors {
                        let t = p.t.unwrap_or(0.0);
                        if last.get(&p.id).is_some_and(|&prev| prev >= t) {
                            continue; // nothing new since the last poll
                        }
                        let id = p.id.clone();
                        if engine.devices.push_live(p, "sta").is_ok() {
                            last.insert(id, t);
                            pushed += 1;
                        }
                    }
                    next = n;
                }
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        if let Some(e) = &error {
            eprintln!("devices: SensorThings {root}: {e}");
        }
        status(&mut |s| {
            s.polls += 1;
            s.readings += pushed;
            s.last_poll = Some(now.clone());
            if error.is_none() || things > 0 {
                s.things = things;
            }
            s.error = error.clone();
        });
        std::thread::sleep(Duration::from_secs(every));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let s = parse_sta_url("https://h/FROST/v1.1/?every=30").unwrap();
        assert_eq!((s.root.as_str(), s.every, s.max, s.filter.as_deref()), ("https://h/FROST/v1.1", 30, 1000, None));
        assert_eq!(parse_sta_url("http://h/v1.0").unwrap().every, 60);
        assert_eq!(parse_sta_url("https://h/v1.1?every=1&max=50000").unwrap().every, 10);
        assert_eq!(parse_sta_url("https://h/v1.1?max=50000").unwrap().max, 10_000);
        assert!(parse_sta_url("mqtt://h").is_err());
        assert!(parse_sta_url("https://h/v1.1?bbox=1,2,3").is_err());
        assert!(parse_sta_url("https://h/v1.1?bbox=10,2,3,4").is_err(), "min > max");
        assert!(things_url(&s).starts_with("https://h/FROST/v1.1/Things?$top=100&$expand="));
        let b = parse_sta_url("https://h/v1.1?bbox=147.1,-9.5,147.3,-9.3&filter=substringof(%27PM%27,name)").unwrap();
        assert_eq!(
            b.filter.as_deref(),
            Some("(st_intersects(Locations/location, geography'POLYGON((147.1 -9.5, 147.3 -9.5, 147.3 -9.3, 147.1 -9.3, 147.1 -9.5))')) and (substringof('PM',name))")
        );
        let u = things_url(&b);
        assert!(u.contains("&$filter=(st_intersects(Locations/location,%20geography'POLYGON((147.1%20-9.5,%20147.3%20-9.5,"), "{u}");
        assert!(!u.contains(' '));
        assert!(b.display().starts_with("https://h/v1.1 (("));
        assert_eq!(parse_sta_url("https://iot.hamburg.de/v1.1").unwrap().key, "hamburg");
        assert_eq!(parse_sta_url("https://iot.hamburg.de/v1.1?name=HH%20Verkehr").unwrap().key, "hh-verkehr");
        assert_eq!(source_key("https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1"), "airquality-frost");
        assert_eq!(source_key("http://127.0.0.1:8133/v1.1"), "local");
        assert_eq!(source_key("http://localhost:8080/FROST-Server/v1.1"), "localhost");
        assert_eq!(source_key("https://sensorthings.example.org/v1.0"), "example");
    }

    #[test]
    fn things_to_live_sensors() {
        let page: Value = serde_json::from_str(
            r#"{"value":[
              {"@iot.id":7,"name":"Station Waigani","Locations":[{"location":{"type":"Point","coordinates":[147.18,-9.43]}}],
               "Datastreams":[
                 {"name":"PM2.5 at Waigani","unitOfMeasurement":{"symbol":"µg/m³"},"ObservedProperty":{"name":"PM2.5"},
                  "Observations":[{"result":38.5,"phenomenonTime":"2026-10-15T01:00:00Z"}]},
                 {"name":"Temp","unitOfMeasurement":{"symbol":"°C"},"ObservedProperty":{"name":"Air temperature"},
                  "Observations":[{"result":"29.1","phenomenonTime":"2026-10-15T00:50:00Z/2026-10-15T01:10:00Z"}]},
                 {"name":"PM2.5 (second sensor)","unitOfMeasurement":{"symbol":"µg/m³"},"ObservedProperty":{"name":"PM2.5"},
                  "Observations":[{"result":40.1,"phenomenonTime":"2026-10-15T01:00:00Z"}]},
                 {"name":"Status","ObservedProperty":{"name":"Status"},"Observations":[{"result":"ok"}]},
                 {"name":"Empty","ObservedProperty":{"name":"NO2"},"Observations":[]}]},
              {"@iot.id":"no-location","name":"Lab","Locations":[],"Datastreams":[{"ObservedProperty":{"name":"pH"},"Observations":[{"result":7}]}]},
              {"@iot.id":9,"name":"Feature form","Locations":[{"location":{"type":"Feature","geometry":{"type":"Point","coordinates":[147.2,-9.4,35]}}}],
               "Datastreams":[{"ObservedProperty":{"name":"Water level"},"unitOfMeasurement":{"symbol":"cm"},"Observations":[{"result":112}]}]}
            ],"@iot.nextLink":"https://h/v1.1/Things?$skip=100"}"#,
        )
        .unwrap();
        let (sensors, next) = parse_things(&page, "pom");
        assert_eq!(next.as_deref(), Some("https://h/v1.1/Things?$skip=100"));
        assert_eq!(sensors.len(), 2, "the Thing without a location is skipped");
        let s = &sensors[0];
        assert_eq!((s.id.as_str(), s.name.as_deref(), s.pos), ("sta-pom-7", Some("Station Waigani"), Some((147.18, -9.43))));
        assert_eq!(s.values, vec![("pm2_5".to_string(), 38.5), ("air_temperature".to_string(), 29.1), ("pm2_5_2".to_string(), 40.1)]);
        assert_eq!(s.t, Some(1_792_026_600.0), "newest observation (interval end 01:10)");
        assert_eq!(s.network, Some("SensorThings"));
        assert_eq!(sensors[1].pos, Some((147.2, -9.4)));
        assert_eq!(sensors[1].values[0].1, 112.0);
    }
}
