//! Device and sensor hub (docs/DEVICES.md).
//!
//! * Finds connected devices: removable mounts, phone MTP/PTP mounts (gvfs), and `--watch` folders.
//! * Scans them (bounded) for geotagged photos (EXIF GPS + DJI XMP) and tracks (GPX/KML via GDAL,
//!   NMEA logs, DJI `.SRT` telemetry).
//! * Imports a device into `<state>/devices/<id>.gpkg` (photos, tracks, waypoints) and hot-registers
//!   the layers. With `auto_import`, new devices import themselves: the first automation trigger.
//! * Keeps live GNSS positions from the phone page, NMEA (serial/TCP/file) and gpsd.

use crate::jobs::{Job, Status};
use crate::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const POLL: Duration = Duration::from_secs(5);
const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 50_000;
const MAX_EXIF_READS: usize = 10_000;
const LIVE_FIXES: usize = 2_000;

#[derive(Debug, Clone, Default)]
pub struct DevicesConfig {
    /// Extra folders treated as devices (synced phone folders, SD-card dumps, field inboxes).
    pub watch: Vec<PathBuf>,
    /// Import new devices with geodata automatically (device trigger).
    pub auto_import: bool,
    /// Live GNSS sources: `/dev/ttyUSB0`, `serial:///dev/ttyACM0?baud=9600`, `tcp://host:port`,
    /// `gpsd://host:2947`, `file:///path/log.nmea?rate=10`.
    pub gps: Vec<String>,
    /// Look at removable and phone mounts (adapters turn this on; tests leave it off).
    pub scan_mounts: bool,
    /// MQTT subscriptions for live sensors, OwnTracks phones and LoRaWAN network servers (TTN, ChirpStack):
    /// `mqtt://[user:pass@]host[:1883]/topic/#`, `mqtts://…:8883/…[?ca=ca.pem&cert=c.pem&key=k.pem]`.
    pub mqtt: Vec<String>,
    /// OGC SensorThings services polled for live stations: `https://host/v1.1[?every=60]`.
    pub sta: Vec<String>,
    /// Drop folders (desktop: `~/GeoSpaX/Inbox`; server: `--inbox DIR`). Watched like `watch`, but putting
    /// files here is the consent: matching device recipes run even when their Auto switch is off.
    /// Plugged-in devices still need Auto (or a click), as DEVICES.md §5 promises.
    pub inbox: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Photo {
    pub path: String,
    pub lon: f64,
    pub lat: f64,
    pub alt: Option<f64>,
    pub direction: Option<f64>,
    pub taken_at: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub gimbal_yaw: Option<f64>,
    pub rel_alt: Option<f64>,
    /// How a photo without its own GPS got its position: "sidecar" (an XMP file next to it, e.g. written by the
    /// phone link's camera mode) or "track" (placed on a GPS track by capture time). None = EXIF GPS.
    pub placed: Option<&'static str>,
}

/// A photo with a capture time but no position (yet): a candidate for `place_by_time`.
#[derive(Debug, Clone, PartialEq)]
pub struct Unlocated {
    pub path: String,
    /// Local capture time, `YYYY-MM-DDTHH:MM:SS` (EXIF DateTimeOriginal).
    pub taken_at: String,
    /// EXIF OffsetTimeOriginal (`+10:00`), when the camera wrote one; otherwise this computer's time zone is used.
    pub offset: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
}

impl Unlocated {
    /// Capture time as Unix seconds.
    pub fn epoch(&self) -> Option<f64> {
        use chrono::{NaiveDateTime, TimeZone};
        let naive = NaiveDateTime::parse_from_str(&self.taken_at, "%Y-%m-%dT%H:%M:%S").ok()?;
        let off = self.offset.as_deref().and_then(|o| chrono::DateTime::parse_from_rfc3339(&format!("2000-01-01T00:00:00{o}")).ok()).map(|d| *d.offset());
        let t = match off {
            Some(o) => o.from_local_datetime(&naive).single()?.timestamp(),
            None => chrono::Local.from_local_datetime(&naive).earliest()?.timestamp(),
        };
        Some(t as f64)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Track {
    pub source: String,
    pub name: String,
    pub parts: Vec<Vec<(f64, f64)>>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Waypoint {
    pub source: String,
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub ele: Option<f64>,
}

/// A LAS/LAZ file found on a device (header only; `lidar.grid` reads the points).
#[derive(Debug, Clone, Default)]
pub struct PointCloud {
    /// path relative to the device root
    pub source: String,
    pub points: u64,
    pub bytes: u64,
    /// "EPSG:32755", "WKT" or "none"
    pub crs: String,
    pub version: String,
    pub format: u8,
    pub z: (f64, f64),
    /// footprint in lon/lat when the coordinate system is known
    pub lonlat: Option<[f64; 4]>,
}

/// Most LAS/LAZ headers read per scan (a drive of national tiles can hold thousands).
const MAX_CLOUD_HEADERS: usize = 2000;

#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub photos: Vec<Photo>,
    pub images: usize,
    pub tracks: Vec<Track>,
    pub waypoints: Vec<Waypoint>,
    pub track_files: usize,
    pub entries: usize,
    pub truncated: bool,
    pub ms: f64,
    pub has_dcim: bool,
    pub has_android: bool,
    pub has_garmin: bool,
    pub has_dji: bool,
    /// Geotagged sensor readings (logger CSV/JSON, FIT activities); values index `reading_fields`.
    pub readings: Vec<crate::sensors::Reading>,
    /// (name, unit) of every measurement in `readings`.
    pub reading_fields: Vec<(String, Option<String>)>,
    pub sensor_files: usize,
    pub has_fit: bool,
    /// Photos with a capture time but no position that no track could place.
    pub unlocated: Vec<Unlocated>,
    /// Timestamped positions from tracks, NMEA logs and sensor readings: (unix s, lon, lat).
    pub timed: Vec<(f64, f64, f64)>,
    /// LiDAR point clouds (LAS/LAZ), from their headers only.
    pub point_clouds: Vec<PointCloud>,
}

impl ScanResult {
    pub fn has_geodata(&self) -> bool {
        !self.photos.is_empty() || !self.tracks.is_empty() || !self.waypoints.is_empty() || !self.readings.is_empty() || !self.point_clouds.is_empty()
    }

    /// Points in all LAS/LAZ files.
    pub fn cloud_points(&self) -> u64 {
        self.point_clouds.iter().map(|c| c.points).sum()
    }

    pub fn field_names(&self) -> Vec<&str> {
        self.reading_fields.iter().map(|(n, _)| n.as_str()).collect()
    }
}

struct DeviceEntry {
    id: String,
    name: String,
    kind: &'static str,
    root: PathBuf,
    connected: bool,
    signature: (usize, u64),
    scan: Option<Arc<ScanResult>>,
    imported: Option<Value>,
    error: Option<String>,
}

/// One GNSS fix. `t` is Unix time in seconds (receive time if the source has no clock).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Fix {
    pub lon: f64,
    pub lat: f64,
    pub alt: Option<f64>,
    pub speed: Option<f64>,
    pub course: Option<f64>,
    pub accuracy: Option<f64>,
    pub sats: Option<u32>,
    pub quality: Option<u32>,
    pub t: f64,
}

struct LiveDevice {
    name: String,
    source: String,
    kind: &'static str,
    fixes: VecDeque<Fix>,
    readings: VecDeque<LiveReading>,
    last: Instant,
}

/// A live sensor reading (HTTP or MQTT push).
#[derive(Debug, Clone)]
pub struct LiveReading {
    pub t: f64,
    pub lon: f64,
    pub lat: f64,
    pub values: Vec<(String, f64)>,
}

/// Every live position or reading: what `sensor` triggers see.
#[derive(Debug, Clone)]
pub struct SensorEvent {
    pub device_id: String,
    pub name: String,
    pub kind: &'static str,
    pub source: String,
    pub lon: f64,
    pub lat: f64,
    pub t: f64,
    pub values: Vec<(String, f64)>,
}

pub type SensorHook = Box<dyn Fn(&SensorEvent) + Send + Sync>;

/// A device with geodata appeared or changed: what device triggers see.
#[derive(Debug, Clone)]
pub struct DeviceEvent {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub root: PathBuf,
    pub photos: usize,
    pub tracks: usize,
    pub waypoints: usize,
    pub readings: usize,
    pub point_clouds: usize,
    /// The device is a drop folder (`DevicesConfig::inbox`): recipes take it without Auto.
    pub inbox: bool,
}

/// Called for each device event; returns true if a recipe took the device (then the plain
/// auto-import is skipped).
pub type DeviceHook = Box<dyn Fn(&DeviceEvent) -> bool + Send + Sync>;

pub struct Hub {
    hook: Mutex<Option<DeviceHook>>,
    sensor_hook: Mutex<Option<SensorHook>>,
    mqtt: Mutex<Vec<crate::sensors::MqttStatus>>,
    sta: Mutex<Vec<crate::sta::StaStatus>>,
    cfg: DevicesConfig,
    devices: Mutex<HashMap<String, DeviceEntry>>,
    live: Mutex<HashMap<String, LiveDevice>>,
    rescan: AtomicBool,
    started: AtomicBool,
    /// Imports from earlier sessions (device id -> info), applied when the device shows up again.
    restored: Mutex<HashMap<String, Value>>,
    /// Content signature each device had when a recipe or the auto-import last handled it
    /// (`<state>/devices/seen.json`). A device that stays plugged in across a restart with the
    /// same content is listed but not processed again.
    seen: Mutex<HashMap<String, (usize, u64)>>,
    /// Drop folders added while running (the phone link's inbox when no `--inbox` is configured).
    extra_inbox: Mutex<Vec<PathBuf>>,
}

/// `<state>/devices/seen.json`: `{ "<device id>": { "files": n, "newest": unix_s } }`.
fn load_seen(state_dir: &Path) -> HashMap<String, (usize, u64)> {
    let Ok(bytes) = std::fs::read(state_dir.join("devices").join("seen.json")) else { return HashMap::new() };
    let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&bytes) else { return HashMap::new() };
    m.into_iter()
        .filter_map(|(id, v)| Some((id, (v.get("files")?.as_u64()? as usize, v.get("newest")?.as_u64()?))))
        .collect()
}

fn save_seen(state_dir: &Path, seen: &HashMap<String, (usize, u64)>) {
    let dir = state_dir.join("devices");
    let doc: Map<String, Value> = seen.iter().map(|(id, (n, newest))| (id.clone(), json!({ "files": n, "newest": newest }))).collect();
    let tmp = dir.join("seen.json.tmp");
    let res = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&tmp, serde_json::to_vec_pretty(&Value::Object(doc)).unwrap_or_default()))
        .and_then(|_| std::fs::rename(&tmp, dir.join("seen.json")));
    if let Err(e) = res {
        eprintln!("devices: could not save seen.json: {e}");
    }
}

pub(crate) fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    let out: String = out.chars().take(24).collect();
    if out.is_empty() { "device".into() } else { out }
}

/// Stable id for a device root: readable slug + short hash of the full path.
pub fn device_id(root: &Path) -> String {
    let name = device_label(root);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut h);
    format!("{}-{:04x}", slug(name.rsplit(['=', ':']).find(|p| !p.is_empty()).unwrap_or(&name)), h.finish() & 0xffff)
}

/// Display name of a device root, used in the device list and in map titles: the folder name (Linux and macOS
/// mount cards under their volume name), or for a Windows drive root its volume label ("EOS_DIGITAL",
/// "GARMIN"), falling back to "Drive E:".
pub fn device_label(root: &Path) -> String {
    if let Some(n) = root.file_name() {
        return n.to_string_lossy().to_string();
    }
    let letter = root.to_string_lossy().trim_end_matches(['\\', '/']).trim_end_matches(':').to_string();
    volume_label(root).filter(|l| !l.is_empty()).unwrap_or_else(|| format!("Drive {letter}:"))
}

#[cfg(windows)]
fn volume_label(root: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetVolumeInformationW(root: *const u16, name: *mut u16, name_len: u32, serial: *mut u32, max_component: *mut u32, flags: *mut u32, fs_name: *mut u16, fs_len: u32) -> i32;
    }
    let r: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buf = [0u16; 261];
    let null = std::ptr::null_mut();
    if unsafe { GetVolumeInformationW(r.as_ptr(), buf.as_mut_ptr(), buf.len() as u32, null, null, null, std::ptr::null_mut(), 0) } == 0 {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]).trim().to_string())
}

#[cfg(not(windows))]
fn volume_label(_root: &Path) -> Option<String> {
    None
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub(crate) fn is_image(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "heic" | "heif" | "dng" | "tif" | "tiff" | "png" | "webp")
}

fn is_track_file(p: &Path, ext: &str) -> bool {
    match ext {
        "gpx" | "kml" | "kmz" | "nmea" | "nma" | "srt" => true,
        "log" | "txt" => head_bytes(p, 2048).map(|b| looks_like_nmea(&b)).unwrap_or(false),
        _ => false,
    }
}

fn head_bytes(p: &Path, n: usize) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut buf = vec![0u8; n];
    let k = f.read(&mut buf).ok()?;
    buf.truncate(k);
    Some(buf)
}

fn looks_like_nmea(b: &[u8]) -> bool {
    let s = String::from_utf8_lossy(b);
    ["$GPGGA", "$GNGGA", "$GPRMC", "$GNRMC"].iter().any(|k| s.contains(k))
}

/// Walk a device root (bounded by MAX_DEPTH and MAX_ENTRIES, so symlink loops end): skips hidden
/// entries; symlinks are followed (a drop folder may link to a folder of LiDAR tiles).
fn walk(root: &Path, mut visit: impl FnMut(&Path, &std::fs::Metadata) -> bool) -> (usize, bool) {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut entries = 0;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            entries += 1;
            if entries > MAX_ENTRIES {
                return (entries, true);
            }
            let name = e.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let p = e.path();
            // metadata() of the path follows symlinks (DirEntry::metadata does not)
            let Ok(md) = (match e.file_type() {
                Ok(ft) if ft.is_symlink() => std::fs::metadata(&p),
                _ => e.metadata(),
            }) else {
                continue;
            };
            if md.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    stack.push((p, depth + 1));
                }
            } else if md.is_file() && !visit(&p, &md) {
                return (entries, true);
            }
        }
    }
    (entries, false)
}

/// Cheap change detector: number of candidate files and newest mtime.
fn signature(root: &Path) -> (usize, u64) {
    let (mut n, mut newest) = (0usize, 0u64);
    walk(root, |p, md| {
        let ext = ext_of(p);
        // tracks, flight logs and sensor logs (csv/tsv/json/fit) all count, so appending readings
        // to a logger's CSV is noticed like a new photo
        if is_image(&ext) || matches!(ext.as_str(), "gpx" | "kml" | "kmz" | "nmea" | "nma" | "srt" | "log" | "txt" | "csv" | "tsv" | "json" | "jsonl" | "ndjson" | "fit" | "las" | "laz") {
            n += 1;
            let m = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            newest = newest.max(m);
        }
        true
    });
    (n, newest)
}

pub fn scan(root: &Path) -> ScanResult {
    let t0 = Instant::now();
    let mut r = ScanResult::default();
    let mut track_paths = Vec::new();
    let mut sensor_paths = Vec::new();
    let mut cloud_paths = Vec::new();
    let mut exif_reads = 0;
    let (entries, truncated) = walk(root, |p, _| {
        let lower = p.to_string_lossy().to_ascii_lowercase();
        r.has_dcim |= lower.contains("/dcim/") || lower.contains("\\dcim\\");
        r.has_dji |= lower.contains("dji");
        let ext = ext_of(p);
        if is_image(&ext) && exif_reads < MAX_EXIF_READS {
            exif_reads += 1;
            let (photo, unlocated) = read_photo_full(p);
            let geotiff_like = matches!(ext.as_str(), "tif" | "tiff") && photo.is_none();
            if !geotiff_like {
                r.images += 1;
            }
            if let Some(ph) = photo {
                r.photos.push(ph);
            } else if let Some(u) = unlocated.filter(|_| !geotiff_like) {
                r.unlocated.push(u);
            }
        } else if is_track_file(p, &ext) {
            track_paths.push(p.to_path_buf());
        } else if is_sensor_file(p, &ext) {
            sensor_paths.push(p.to_path_buf());
        } else if matches!(ext.as_str(), "las" | "laz") && cloud_paths.len() < MAX_CLOUD_HEADERS {
            cloud_paths.push(p.to_path_buf());
        }
        true
    });
    for top in ["Android", "Garmin", "GARMIN"] {
        if root.join(top).is_dir() {
            if top == "Android" { r.has_android = true } else { r.has_garmin = true }
        }
    }
    for p in track_paths {
        let src = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().to_string();
        let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("track").to_string();
        let before = (r.tracks.len(), r.waypoints.len());
        match ext_of(&p).as_str() {
            "srt" => {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    let pts = parse_srt(&text);
                    if pts.len() >= 2 {
                        r.tracks.push(Track { source: src.clone(), name, parts: vec![pts], ..Default::default() });
                    }
                }
            }
            "nmea" | "nma" | "log" | "txt" => {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    let mut st = NmeaState::default();
                    let fixes: Vec<Fix> = text.lines().filter_map(|l| st.feed(l)).collect();
                    // fix times are only real when the log has dates (else they are "now"): keep them for photo placing
                    if fixes.first().is_some_and(|f| (now_s() - f.t).abs() > 600.0) {
                        r.timed.extend(fixes.iter().map(|f| (f.t, f.lon, f.lat)));
                    }
                    let pts: Vec<(f64, f64)> = fixes.iter().map(|f| (f.lon, f.lat)).collect();
                    if pts.len() >= 2 {
                        r.tracks.push(Track { source: src.clone(), name, parts: vec![pts], ..Default::default() });
                    }
                }
            }
            _ => read_gdal_tracks(&p, &src, &mut r.tracks, &mut r.waypoints, &mut r.timed),
        }
        if (r.tracks.len(), r.waypoints.len()) != before {
            r.track_files += 1;
        }
    }
    for p in sensor_paths {
        read_sensor_file(root, &p, &mut r);
    }
    // sensor readings with a zoned time (RFC 3339) are timestamped positions too
    r.timed.extend(r.readings.iter().filter_map(|x| {
        let t = chrono::DateTime::parse_from_rfc3339(x.t.as_deref()?).ok()?.timestamp() as f64;
        Some((t, x.lon, x.lat))
    }));
    place_by_time(&mut r);
    cloud_paths.sort();
    for p in cloud_paths {
        if let Ok(h) = crate::lidar::read_header(&p)
            && h.points > 0 {
                r.point_clouds.push(PointCloud {
                    source: p.strip_prefix(root).unwrap_or(&p).to_string_lossy().to_string(),
                    points: h.points,
                    bytes: h.bytes,
                    crs: h.crs_label(),
                    version: h.version.clone(),
                    format: h.format,
                    z: (h.bounds[2], h.bounds[5]),
                    lonlat: h.lonlat_bounds(),
                });
            }
    }
    r.entries = entries;
    r.truncated = truncated;
    r.ms = t0.elapsed().as_secs_f64() * 1000.0;
    r
}

/// Logger CSV/TSV/JSON with lat/lon columns, or a FIT activity (docs/DEVICES.md §5).
fn is_sensor_file(p: &Path, ext: &str) -> bool {
    match ext {
        "fit" => true,
        "csv" | "tsv" | "txt" | "jsonl" | "ndjson" | "json" => head_bytes(p, 4096).map(|b| crate::sensors::sniff(&b, ext)).unwrap_or(false),
        _ => false,
    }
}

fn read_sensor_file(root: &Path, p: &Path, r: &mut ScanResult) {
    const MAX_BYTES: u64 = 256 << 20;
    if std::fs::metadata(p).map(|m| m.len() > MAX_BYTES).unwrap_or(true) {
        return;
    }
    let ext = ext_of(p);
    let log = match ext.as_str() {
        "fit" => {
            r.has_fit = true;
            crate::sensors::read_fit(p)
        }
        "jsonl" | "ndjson" | "json" => std::fs::read_to_string(p).ok().and_then(|t| crate::sensors::read_json(&t)),
        _ => std::fs::read_to_string(p).ok().and_then(|t| crate::sensors::read_csv(&t)),
    };
    let Some(log) = log else { return };
    let src = p.strip_prefix(root).unwrap_or(p).to_string_lossy().to_string();
    let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("log").to_string();
    // this file's fields -> the device's field list
    let map: Vec<Option<u16>> = log
        .fields
        .iter()
        .map(|(n, u)| match r.reading_fields.iter().position(|(e, _)| e == n) {
            Some(i) => Some(i as u16),
            None if r.reading_fields.len() < 64 => {
                r.reading_fields.push((n.clone(), u.clone()));
                Some((r.reading_fields.len() - 1) as u16)
            }
            None => None,
        })
        .collect();
    let (first_t, last_t) = (log.readings.first().and_then(|x| x.t.clone()), log.readings.last().and_then(|x| x.t.clone()));
    for mut rd in log.readings {
        rd.source = src.clone();
        rd.values = rd.values.into_iter().filter_map(|(k, v)| map.get(k as usize).copied().flatten().map(|g| (g, v))).collect();
        r.readings.push(rd);
    }
    if let Some(track) = log.track {
        r.tracks.push(Track { source: src, name, parts: vec![track], started_at: first_t, ended_at: last_t });
    }
    r.sensor_files += 1;
}

pub fn kind_of(root: &Path, s: &ScanResult) -> &'static str {
    let p = root.to_string_lossy();
    if p.contains("mtp:") || (s.has_dcim && s.has_android) {
        "phone"
    } else if s.has_dji || s.tracks.iter().any(|t| t.source.to_ascii_lowercase().ends_with(".srt")) {
        "drone"
    } else if p.contains("gphoto2:") || s.has_dcim {
        "camera"
    } else if !s.point_clouds.is_empty() && s.photos.is_empty() && s.tracks.is_empty() && s.readings.is_empty() {
        "lidar"
    } else if !s.readings.is_empty() && s.photos.is_empty() && !s.has_garmin && !s.has_fit {
        "sensor"
    } else if s.has_garmin || (s.photos.is_empty() && !s.tracks.is_empty()) {
        "gps"
    } else {
        "folder"
    }
}

// ---------------------------------------------------------------- photos (EXIF + DJI XMP)

fn rational3(v: &exif::Value) -> Option<f64> {
    match v {
        exif::Value::Rational(r) if r.len() >= 3 => Some(r[0].to_f64() + r[1].to_f64() / 60.0 + r[2].to_f64() / 3600.0),
        exif::Value::Rational(r) if r.len() == 1 => Some(r[0].to_f64()),
        _ => None,
    }
}

fn rational1(v: &exif::Value) -> Option<f64> {
    match v {
        exif::Value::Rational(r) if !r.is_empty() => Some(r[0].to_f64()).filter(|x| x.is_finite()),
        _ => None,
    }
}

fn ascii(v: &exif::Value) -> Option<String> {
    match v {
        exif::Value::Ascii(parts) => parts.first().map(|b| String::from_utf8_lossy(b).trim().trim_end_matches('\0').to_string()).filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// `2024:05:01 13:45:10` -> `2024-05-01T13:45:10`
pub fn exif_time(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 19 && s.as_bytes()[4] == b':' && s.as_bytes()[7] == b':' {
        format!("{}-{}-{}T{}", &s[0..4], &s[5..7], &s[8..10], &s[11..19])
    } else {
        s.to_string()
    }
}

/// Decimal degrees from EXIF degree/minute/second + N/S/E/W reference.
pub fn signed(deg: f64, reference: Option<&str>) -> f64 {
    match reference.map(|r| r.trim().to_ascii_uppercase()) {
        Some(r) if r.starts_with('S') || r.starts_with('W') => -deg.abs(),
        _ => deg,
    }
}

pub fn read_photo(path: &Path) -> Option<Photo> {
    read_photo_full(path).0
}

/// A photo's position and metadata: from its EXIF GPS, else from an XMP sidecar (`IMG.jpg.xmp` or `IMG.xmp`, as
/// Lightroom, darktable, digiKam and the phone link's camera mode write them). A photo with a capture time but no
/// position comes back as `Unlocated`, for placing on a GPS track by time.
pub fn read_photo_full(path: &Path) -> (Option<Photo>, Option<Unlocated>) {
    let ex = std::fs::File::open(path).ok().and_then(|file| {
        // Tolerant: real devices (and GDAL) write slightly non-conforming EXIF, e.g. a stray
        // next-IFD pointer; keep every field that parsed instead of rejecting the photo.
        exif::Reader::new()
            .continue_on_error(true)
            .read_from_container(&mut BufReader::new(file))
            .or_else(|e| e.distill_partial_result(|_errors| {}))
            .ok()
    });
    let get = |t: exif::Tag| ex.as_ref().and_then(|ex| ex.get_field(t, exif::In::PRIMARY)).map(|f| &f.value);
    let taken_at = get(exif::Tag::DateTimeOriginal).or_else(|| get(exif::Tag::DateTime)).and_then(ascii).map(|s| exif_time(&s));
    let make = get(exif::Tag::Make).and_then(ascii);
    let model = get(exif::Tag::Model).and_then(ascii);
    let valid = |lat: f64, lon: f64| lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0 && !(lat == 0.0 && lon == 0.0);
    let exif_pos = (|| {
        let lat = signed(rational3(get(exif::Tag::GPSLatitude)?)?, get(exif::Tag::GPSLatitudeRef).and_then(ascii).as_deref());
        let lon = signed(rational3(get(exif::Tag::GPSLongitude)?)?, get(exif::Tag::GPSLongitudeRef).and_then(ascii).as_deref());
        valid(lat, lon).then_some((lat, lon))
    })();
    let (pos, placed, sidecar_time) = match exif_pos {
        Some(p) => (Some(p), None, None),
        None => match xmp_sidecar(path) {
            Some((lat, lon, t)) if valid(lat, lon) => (Some((lat, lon)), Some("sidecar"), t),
            _ => (None, None, None),
        },
    };
    let Some((lat, lon)) = pos else {
        let unlocated = taken_at.map(|taken_at| Unlocated {
            path: path.to_string_lossy().to_string(),
            taken_at,
            offset: get(exif::Tag::OffsetTimeOriginal).and_then(ascii),
            make,
            model,
        });
        return (None, unlocated);
    };
    let below = matches!(get(exif::Tag::GPSAltitudeRef), Some(exif::Value::Byte(b)) if b.first() == Some(&1));
    let alt = if placed.is_none() { get(exif::Tag::GPSAltitude).and_then(rational1).map(|a| if below { -a } else { a }) } else { None };
    let (gimbal_yaw, rel_alt) = dji_xmp(path);
    let photo = Photo {
        path: path.to_string_lossy().to_string(),
        lon,
        lat,
        alt,
        direction: get(exif::Tag::GPSImgDirection).and_then(rational1),
        taken_at: taken_at.or(sidecar_time),
        make,
        model,
        gimbal_yaw,
        rel_alt,
        placed,
    };
    (Some(photo), None)
}

/// XMP sidecar next to a photo: `exif:GPSLatitude="5,52.12345S"` (XMP's `DDD,MM.mmk` or `DDD,MM,SSk`), as an
/// attribute or an element. Returns (lat, lon, capture time).
fn xmp_sidecar(path: &Path) -> Option<(f64, f64, Option<String>)> {
    let mut candidates = vec![PathBuf::from(format!("{}.xmp", path.display())), path.with_extension("xmp"), path.with_extension("XMP")];
    candidates.dedup();
    let text = candidates.iter().find_map(|c| std::fs::read_to_string(c).ok())?;
    let value = |key: &str| -> Option<String> {
        let i = text.find(key)? + key.len();
        let rest = text[i..].trim_start();
        let (open, close) = if let Some(r) = rest.strip_prefix('=') { (r.trim_start(), None) } else { (rest.strip_prefix('>')?, Some('<')) };
        let v = match close {
            Some(c) => &open[..open.find(c)?],
            None => {
                let q = open.chars().next()?;
                let body = &open[1..];
                &body[..body.find(q)?]
            }
        };
        Some(v.trim().to_string())
    };
    let coord = |v: String| -> Option<f64> {
        let hemi = v.chars().last().filter(|c| c.is_ascii_alphabetic());
        let body = if hemi.is_some() { &v[..v.len() - 1] } else { &v[..] };
        let parts: Vec<f64> = body.split(',').map(|x| x.trim().parse::<f64>()).collect::<Result<_, _>>().ok()?;
        let deg = match parts.as_slice() {
            [d] => *d,
            [d, m] => d + m / 60.0,
            [d, m, s] => d + m / 60.0 + s / 3600.0,
            _ => return None,
        };
        Some(if matches!(hemi, Some('S' | 's' | 'W' | 'w')) { -deg } else { deg })
    };
    let lat = coord(value("exif:GPSLatitude")?)?;
    let lon = coord(value("exif:GPSLongitude")?)?;
    let t = value("exif:DateTimeOriginal").or_else(|| value("xmp:CreateDate")).map(|t| t.chars().take(19).collect::<String>());
    Some((lat, lon, t))
}

/// Longest gap between two track points that a photo may be interpolated across, and how far before the first
/// or after the last point it may still snap to it.
const PLACE_MAX_GAP_S: f64 = 300.0;
const PLACE_SNAP_S: f64 = 60.0;

/// Photos without GPS, placed on the device's own GPS tracks by capture time (the GPicSync / Lightroom /
/// digiKam workflow): interpolated between the two track points around the photo time.
pub fn place_by_time(r: &mut ScanResult) {
    if r.unlocated.is_empty() || r.timed.is_empty() {
        return;
    }
    let mut pts = r.timed.clone();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    pts.dedup_by(|a, b| a.0 == b.0);
    let mut keep = Vec::new();
    for u in std::mem::take(&mut r.unlocated) {
        match u.epoch().and_then(|t| interpolate_track(&pts, t)) {
            Some((lon, lat)) => r.photos.push(Photo {
                path: u.path,
                lon,
                lat,
                alt: None,
                direction: None,
                taken_at: Some(u.taken_at),
                make: u.make,
                model: u.model,
                gimbal_yaw: None,
                rel_alt: None,
                placed: Some("track"),
            }),
            None => keep.push(u),
        }
    }
    r.unlocated = keep;
}

/// Position at time `t` on time-sorted (t, lon, lat) points.
pub fn interpolate_track(pts: &[(f64, f64, f64)], t: f64) -> Option<(f64, f64)> {
    let i = pts.partition_point(|p| p.0 < t);
    let before = i.checked_sub(1).map(|j| pts[j]);
    let after = pts.get(i).copied();
    match (before, after) {
        (_, Some(b)) if b.0 == t => Some((b.1, b.2)),
        (Some(a), Some(b)) if b.0 - a.0 <= PLACE_MAX_GAP_S => {
            let f = (t - a.0) / (b.0 - a.0);
            Some((a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f))
        }
        (a, b) => {
            let near = [a, b].into_iter().flatten().min_by(|x, y| (x.0 - t).abs().total_cmp(&(y.0 - t).abs()))?;
            ((near.0 - t).abs() <= PLACE_SNAP_S).then_some((near.1, near.2))
        }
    }
}

fn xmp_attr(xmp: &str, key: &str) -> Option<f64> {
    let i = xmp.find(key)? + key.len();
    let rest = xmp[i..].trim_start().strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"').or_else(|| rest.strip_prefix('\''))?;
    let end = rest.find(['"', '\''])?;
    rest[..end].trim().trim_start_matches('+').parse().ok()
}

/// DJI drones write gimbal yaw and height above take-off into XMP (`drone-dji:` namespace).
fn dji_xmp(path: &Path) -> (Option<f64>, Option<f64>) {
    let Some(b) = head_bytes(path, 128 * 1024) else { return (None, None) };
    let s = String::from_utf8_lossy(&b);
    if !s.contains("drone-dji:") {
        return (None, None);
    }
    (xmp_attr(&s, "drone-dji:GimbalYawDegree"), xmp_attr(&s, "drone-dji:RelativeAltitude"))
}

// ---------------------------------------------------------------- tracks

fn read_gdal_tracks(path: &Path, src: &str, tracks: &mut Vec<Track>, waypoints: &mut Vec<Waypoint>, timed: &mut Vec<(f64, f64, f64)>) {
    use gdal::vector::{geometry_type_flatten, LayerAccess, OGRwkbGeometryType as G};
    let Ok(ds) = gdal::Dataset::open(path) else { return };
    let mut times: Vec<String> = Vec::new();
    let first_track = tracks.len();
    for mut lyr in ds.layers() {
        let lname = lyr.name();
        let defn_names: Vec<String> = lyr.defn().fields().map(|f| f.name()).collect();
        let name_idx = defn_names.iter().position(|n| n.eq_ignore_ascii_case("name"));
        let time_idx = defn_names.iter().position(|n| n == "time");
        let ele_idx = defn_names.iter().position(|n| n == "ele");
        let is_points_of_track = lname == "track_points" || lname == "route_points";
        for f in lyr.features() {
            if is_points_of_track {
                if let Some(Ok(Some(t))) = time_idx.map(|i| f.field_as_string(i)) {
                    if let (Some(epoch), Some(g)) = (gdal_time_epoch(&t), f.geometry()) {
                        let (x, y, _) = g.get_point(0);
                        timed.push((epoch, x, y));
                    }
                    times.push(t);
                }
                continue;
            }
            let Some(g) = f.geometry() else { continue };
            let label = name_idx.and_then(|i| f.field_as_string(i).ok().flatten()).unwrap_or_default();
            match geometry_type_flatten(g.geometry_type()) {
                G::wkbPoint => {
                    let (x, y, _) = g.get_point(0);
                    let ele = ele_idx.and_then(|i| f.field_as_double(i).ok().flatten());
                    waypoints.push(Waypoint { source: src.into(), name: label, lon: x, lat: y, ele });
                }
                G::wkbLineString => {
                    let part = line_points(g);
                    if part.len() >= 2 {
                        tracks.push(Track { source: src.into(), name: label, parts: vec![part], ..Default::default() });
                    }
                }
                G::wkbMultiLineString => {
                    let parts: Vec<_> = (0..g.geometry_count()).map(|i| line_points(&g.get_geometry(i))).filter(|p| p.len() >= 2).collect();
                    if !parts.is_empty() {
                        tracks.push(Track { source: src.into(), name: label, parts, ..Default::default() });
                    }
                }
                _ => {}
            }
        }
    }
    if !times.is_empty() {
        times.sort();
        for t in &mut tracks[first_track..] {
            t.started_at = times.first().cloned();
            t.ended_at = times.last().cloned();
        }
    }
}

/// GDAL's text form of a date-time field ("2026/10/13 08:00:00.5+00", "+10", "+1030", or no zone) as Unix
/// seconds. No zone counts as UTC, which is what GPX times are.
pub fn gdal_time_epoch(t: &str) -> Option<f64> {
    let iso = t.trim().replacen('/', "-", 2).replacen(' ', "T", 1);
    let (body, off) = match iso.rfind(['+', '-']).filter(|&i| i > 10) {
        Some(i) => (&iso[..i], &iso[i..]),
        None => (iso.trim_end_matches('Z'), "+00"),
    };
    let off = match off.len() {
        3 => format!("{off}:00"),
        5 => format!("{}:{}", &off[..3], &off[3..]),
        _ => off.to_string(),
    };
    chrono::DateTime::parse_from_rfc3339(&format!("{body}{off}")).ok().map(|d| d.timestamp_millis() as f64 / 1000.0)
}

fn line_points(g: &gdal::vector::Geometry) -> Vec<(f64, f64)> {
    (0..g.point_count() as i32).map(|i| g.get_point(i)).map(|(x, y, _)| (x, y)).collect()
}

/// DJI `.SRT` telemetry: `[latitude: 22.57] [longitude: 113.86]` (newer) or `GPS(113.86,22.57,19)` (older).
pub fn parse_srt(text: &str) -> Vec<(f64, f64)> {
    let num_after = |s: &str, key: &str| -> Option<f64> {
        let i = s.find(key)? + key.len();
        let rest = s[i..].trim_start().trim_start_matches(':').trim_start();
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(rest.len());
        rest[..end].parse().ok()
    };
    let mut out: Vec<(f64, f64)> = Vec::new();
    for line in text.lines() {
        let p = if let (Some(lat), Some(lon)) = (num_after(line, "latitude"), num_after(line, "longitude")) {
            Some((lon, lat))
        } else if let Some(i) = line.find("GPS(") {
            let inner = &line[i + 4..line[i..].find(')').map(|j| i + j).unwrap_or(line.len())];
            let v: Vec<f64> = inner.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            (v.len() >= 2).then(|| (v[0], v[1]))
        } else {
            None
        };
        if let Some((lon, lat)) = p {
            let valid = lon.abs() <= 180.0 && lat.abs() <= 90.0 && !(lon == 0.0 && lat == 0.0);
            if valid && out.last() != Some(&(lon, lat)) {
                out.push((lon, lat));
            }
        }
    }
    out
}

// ---------------------------------------------------------------- NMEA 0183 and gpsd

pub fn nmea_checksum_ok(line: &str) -> bool {
    let line = line.trim();
    let Some(body) = line.strip_prefix('$') else { return false };
    match body.split_once('*') {
        Some((data, cs)) => match u8::from_str_radix(cs.trim(), 16) {
            Ok(want) => data.bytes().fold(0u8, |a, b| a ^ b) == want,
            Err(_) => false,
        },
        None => true, // checksum is optional in NMEA 0183
    }
}

/// `ddmm.mmmm` + hemisphere -> decimal degrees.
pub fn nmea_coord(v: &str, hemi: &str) -> Option<f64> {
    let x: f64 = v.parse().ok()?;
    let deg = (x / 100.0).trunc();
    let d = deg + (x - deg * 100.0) / 60.0;
    Some(if hemi == "S" || hemi == "W" { -d } else { d })
}

#[derive(Debug, Default)]
pub struct NmeaState {
    fix: Fix,
}

impl NmeaState {
    /// Feed one sentence; returns a fix when a GGA or RMC with a valid position arrives.
    pub fn feed(&mut self, line: &str) -> Option<Fix> {
        if !nmea_checksum_ok(line) {
            return None;
        }
        let data = line.trim().trim_start_matches('$').split('*').next()?;
        let f: Vec<&str> = data.split(',').collect();
        let kind = f.first()?.get(2..)?;
        match kind {
            "GGA" if f.len() >= 10 => {
                let q: u32 = f[6].parse().unwrap_or(0);
                if q == 0 {
                    return None;
                }
                self.fix.lat = nmea_coord(f[2], f[3])?;
                self.fix.lon = nmea_coord(f[4], f[5])?;
                self.fix.quality = Some(q);
                self.fix.sats = f[7].parse().ok();
                let hdop: Option<f64> = f[8].parse().ok();
                self.fix.accuracy = hdop.map(|h| (h * 5.0 * 10.0).round() / 10.0); // rough: HDOP x 5 m
                self.fix.alt = f[9].parse().ok();
            }
            "RMC" if f.len() >= 9 => {
                if f[2] != "A" {
                    return None;
                }
                self.fix.lat = nmea_coord(f[3], f[4])?;
                self.fix.lon = nmea_coord(f[5], f[6])?;
                self.fix.speed = f[7].parse::<f64>().ok().map(|kn| kn * 0.514444);
                self.fix.course = f[8].parse().ok();
            }
            _ => return None,
        }
        self.fix.t = now_s();
        Some(self.fix)
    }
}

/// gpsd JSON `TPV` report -> fix.
pub fn parse_gpsd(line: &str) -> Option<Fix> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("class")?.as_str()? != "TPV" || v.get("mode").and_then(Value::as_u64).unwrap_or(0) < 2 {
        return None;
    }
    let f = |k: &str| v.get(k).and_then(Value::as_f64);
    let acc = match (f("epx"), f("epy")) {
        (Some(x), Some(y)) => Some(x.max(y)),
        _ => f("eph"),
    };
    Some(Fix {
        lat: f("lat")?,
        lon: f("lon")?,
        alt: f("altMSL").or_else(|| f("alt")),
        speed: f("speed"),
        course: f("track"),
        accuracy: acc,
        sats: None,
        quality: v.get("mode").and_then(Value::as_u64).map(|m| m as u32),
        t: now_s(),
    })
}

// ---------------------------------------------------------------- GeoPackage writer

pub(crate) fn write_gpkg(path: &Path, device: &str, s: &ScanResult) -> Result<(), String> {
    use gdal::spatial_ref::{AxisMappingStrategy, SpatialRef};
    use gdal::vector::{Feature, FieldDefn, Geometry, LayerAccess, LayerOptions, OGRFieldType as F, OGRwkbGeometryType as G};
    let e = |x: gdal::errors::GdalError| x.to_string();
    let _ = std::fs::remove_file(path);
    let drv = gdal::DriverManager::get_driver_by_name("GPKG").map_err(e)?;
    let mut ds = drv.create_vector_only(path).map_err(e)?;
    let mut srs = SpatialRef::from_epsg(4326).map_err(e)?;
    srs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let mut txn = ds.start_transaction().map_err(e)?;
    let opt = |s: &Option<String>| s.clone().unwrap_or_default();
    if !s.photos.is_empty() {
        let lyr = txn.create_layer(LayerOptions { name: "photos", srs: Some(&srs), ty: G::wkbPoint, options: None }).map_err(e)?;
        for (n, t) in [("name", F::OFTString), ("taken_at", F::OFTString), ("altitude", F::OFTReal), ("direction", F::OFTReal), ("make", F::OFTString), ("model", F::OFTString), ("gimbal_yaw", F::OFTReal), ("rel_alt", F::OFTReal), ("device", F::OFTString), ("path", F::OFTString), ("placed", F::OFTString)] {
            FieldDefn::new(n, t).map_err(e)?.add_to_layer(&lyr).map_err(e)?;
        }
        for p in &s.photos {
            let mut f = Feature::new(lyr.defn()).map_err(e)?;
            let file = Path::new(&p.path).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
            f.set_field_string(0, &file).map_err(e)?;
            f.set_field_string(1, &opt(&p.taken_at)).map_err(e)?;
            for (i, v) in [(2, p.alt), (3, p.direction), (6, p.gimbal_yaw), (7, p.rel_alt)] {
                if let Some(v) = v { f.set_field_double(i, v).map_err(e)? } else { f.set_field_null(i).map_err(e)? }
            }
            f.set_field_string(4, &opt(&p.make)).map_err(e)?;
            f.set_field_string(5, &opt(&p.model)).map_err(e)?;
            f.set_field_string(8, device).map_err(e)?;
            f.set_field_string(9, &p.path).map_err(e)?;
            f.set_field_string(10, p.placed.unwrap_or("exif")).map_err(e)?;
            f.set_geometry(Geometry::from_wkt(&format!("POINT ({} {})", p.lon, p.lat)).map_err(e)?).map_err(e)?;
            f.create(&lyr).map_err(e)?;
        }
    }
    if !s.tracks.is_empty() {
        let lyr = txn.create_layer(LayerOptions { name: "tracks", srs: Some(&srs), ty: G::wkbMultiLineString, options: None }).map_err(e)?;
        for (n, t) in [("name", F::OFTString), ("source", F::OFTString), ("points", F::OFTInteger), ("length_m", F::OFTReal), ("started_at", F::OFTString), ("ended_at", F::OFTString), ("device", F::OFTString)] {
            FieldDefn::new(n, t).map_err(e)?.add_to_layer(&lyr).map_err(e)?;
        }
        for t in &s.tracks {
            let mut f = Feature::new(lyr.defn()).map_err(e)?;
            let points: usize = t.parts.iter().map(Vec::len).sum();
            let length: f64 = t.parts.iter().map(|p| p.windows(2).map(|w| haversine(w[0], w[1])).sum::<f64>()).sum();
            let wkt = format!(
                "MULTILINESTRING ({})",
                t.parts.iter().map(|p| format!("({})", p.iter().map(|(x, y)| format!("{x} {y}")).collect::<Vec<_>>().join(", "))).collect::<Vec<_>>().join(", ")
            );
            f.set_field_string(0, if t.name.is_empty() { &t.source } else { &t.name }).map_err(e)?;
            f.set_field_string(1, &t.source).map_err(e)?;
            f.set_field_integer(2, points as i32).map_err(e)?;
            f.set_field_double(3, (length * 10.0).round() / 10.0).map_err(e)?;
            f.set_field_string(4, &opt(&t.started_at)).map_err(e)?;
            f.set_field_string(5, &opt(&t.ended_at)).map_err(e)?;
            f.set_field_string(6, device).map_err(e)?;
            f.set_geometry(Geometry::from_wkt(&wkt).map_err(e)?).map_err(e)?;
            f.create(&lyr).map_err(e)?;
        }
    }
    if !s.waypoints.is_empty() {
        let lyr = txn.create_layer(LayerOptions { name: "waypoints", srs: Some(&srs), ty: G::wkbPoint, options: None }).map_err(e)?;
        for (n, t) in [("name", F::OFTString), ("source", F::OFTString), ("ele", F::OFTReal), ("device", F::OFTString)] {
            FieldDefn::new(n, t).map_err(e)?.add_to_layer(&lyr).map_err(e)?;
        }
        for w in &s.waypoints {
            let mut f = Feature::new(lyr.defn()).map_err(e)?;
            f.set_field_string(0, &w.name).map_err(e)?;
            f.set_field_string(1, &w.source).map_err(e)?;
            if let Some(v) = w.ele { f.set_field_double(2, v).map_err(e)? } else { f.set_field_null(2).map_err(e)? }
            f.set_field_string(3, device).map_err(e)?;
            f.set_geometry(Geometry::from_wkt(&format!("POINT ({} {})", w.lon, w.lat)).map_err(e)?).map_err(e)?;
            f.create(&lyr).map_err(e)?;
        }
    }
    if !s.readings.is_empty() {
        let lyr = txn.create_layer(LayerOptions { name: "readings", srs: Some(&srs), ty: G::wkbPoint, options: None }).map_err(e)?;
        for (n, t) in [("time", F::OFTString), ("source", F::OFTString), ("device", F::OFTString)] {
            FieldDefn::new(n, t).map_err(e)?.add_to_layer(&lyr).map_err(e)?;
        }
        for (n, _) in &s.reading_fields {
            FieldDefn::new(n, F::OFTReal).map_err(e)?.add_to_layer(&lyr).map_err(e)?;
        }
        for r in &s.readings {
            let mut f = Feature::new(lyr.defn()).map_err(e)?;
            f.set_field_string(0, r.t.as_deref().unwrap_or("")).map_err(e)?;
            f.set_field_string(1, &r.source).map_err(e)?;
            f.set_field_string(2, device).map_err(e)?;
            for (k, v) in &r.values {
                f.set_field_double(3 + *k as usize, *v).map_err(e)?;
            }
            let mut g = Geometry::empty(G::wkbPoint).map_err(e)?;
            g.add_point_2d((r.lon, r.lat));
            f.set_geometry(g).map_err(e)?;
            f.create(&lyr).map_err(e)?;
        }
    }
    let clouds: Vec<&PointCloud> = s.point_clouds.iter().filter(|c| c.lonlat.is_some()).collect();
    if !clouds.is_empty() {
        let lyr = txn.create_layer(LayerOptions { name: "point_clouds", srs: Some(&srs), ty: G::wkbPolygon, options: None }).map_err(e)?;
        for (n, t) in [("file", F::OFTString), ("points", F::OFTInteger64), ("crs", F::OFTString), ("las", F::OFTString), ("z_min", F::OFTReal), ("z_max", F::OFTReal), ("size_mb", F::OFTReal), ("device", F::OFTString)] {
            FieldDefn::new(n, t).map_err(e)?.add_to_layer(&lyr).map_err(e)?;
        }
        for c in clouds {
            let b = c.lonlat.unwrap();
            let mut f = Feature::new(lyr.defn()).map_err(e)?;
            f.set_field_string(0, &c.source).map_err(e)?;
            f.set_field_integer64(1, c.points as i64).map_err(e)?;
            f.set_field_string(2, &c.crs).map_err(e)?;
            f.set_field_string(3, &format!("LAS {} · format {}", c.version, c.format)).map_err(e)?;
            f.set_field_double(4, (c.z.0 * 10.0).round() / 10.0).map_err(e)?;
            f.set_field_double(5, (c.z.1 * 10.0).round() / 10.0).map_err(e)?;
            f.set_field_double(6, (c.bytes as f64 / 1e5).round() / 10.0).map_err(e)?;
            f.set_field_string(7, device).map_err(e)?;
            let g = Geometry::from_wkt(&format!("POLYGON(({w} {s0}, {e1} {s0}, {e1} {n}, {w} {n}, {w} {s0}))", w = b[0], s0 = b[1], e1 = b[2], n = b[3])).map_err(e)?;
            f.set_geometry(g).map_err(e)?;
            f.create(&lyr).map_err(e)?;
        }
    }
    txn.commit().map_err(e)?;
    Ok(())
}

/// Great-circle distance in metres between two lon/lat points.
pub fn haversine(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, la2) = (a.1.to_radians(), b.1.to_radians());
    let (dla, dlo) = ((b.1 - a.1).to_radians(), (b.0 - a.0).to_radians());
    let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
    2.0 * 6_371_008.8 * h.sqrt().asin()
}

// ---------------------------------------------------------------- hub

impl Hub {
    pub fn new(cfg: DevicesConfig) -> Hub {
        Hub { hook: Mutex::new(None), sensor_hook: Mutex::new(None), mqtt: Mutex::new(Vec::new()), sta: Mutex::new(Vec::new()), cfg, devices: Mutex::new(HashMap::new()), live: Mutex::new(HashMap::new()), rescan: AtomicBool::new(false), started: AtomicBool::new(false), restored: Mutex::new(HashMap::new()), seen: Mutex::new(HashMap::new()), extra_inbox: Mutex::new(Vec::new()) }
    }

    /// Device roots to look at right now.
    fn roots(&self) -> Vec<PathBuf> {
        let extra = self.extra_inbox.lock().unwrap().clone();
        let mut out: Vec<PathBuf> = self.cfg.watch.iter().chain(&self.cfg.inbox).chain(&extra).filter(|p| p.is_dir()).cloned().collect();
        if self.cfg.scan_mounts {
            out.extend(mount_roots());
        }
        out.sort();
        out.dedup();
        out
    }

    fn is_inbox(&self, root: &Path) -> bool {
        self.cfg.inbox.iter().any(|p| p == root) || self.extra_inbox.lock().unwrap().iter().any(|p| p == root)
    }

    /// The first drop folder (configured, or added at run time), if any.
    pub(crate) fn inbox_dir(&self) -> Option<PathBuf> {
        self.cfg.inbox.first().cloned().or_else(|| self.extra_inbox.lock().unwrap().first().cloned())
    }

    /// Treat another folder as a drop folder from now on.
    pub(crate) fn add_inbox(&self, dir: PathBuf) {
        let mut v = self.extra_inbox.lock().unwrap();
        if !v.contains(&dir) {
            v.push(dir);
        }
    }

    /// The live fixes held for one live device (phone page, GNSS source, OwnTracks), oldest first.
    pub(crate) fn live_fixes(&self, id: &str) -> Vec<Fix> {
        self.live.lock().unwrap().get(id).map(|d| d.fixes.iter().copied().collect()).unwrap_or_default()
    }

    /// Start the watcher thread (device trigger) and the live GNSS sources.
    pub fn start(&self, engine: Arc<Engine>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.restore_imports(&engine);
        *self.seen.lock().unwrap() = load_seen(&engine.state_dir);
        let e = engine.clone();
        std::thread::Builder::new()
            .name("device-watcher".into())
            .spawn(move || loop {
                e.devices.poll(&e);
                let t0 = Instant::now();
                while t0.elapsed() < POLL && !e.devices.rescan.swap(false, Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(200));
                }
            })
            .expect("spawn device watcher");
        for src in self.cfg.gps.clone() {
            let e = engine.clone();
            std::thread::Builder::new().name("gnss-source".into()).spawn(move || run_gnss_source(&e, &src)).expect("spawn gnss source");
        }
        for (i, url) in self.cfg.mqtt.clone().into_iter().enumerate() {
            let shown = crate::sensors::parse_mqtt_url(&url).map(|u| u.display()).unwrap_or_else(|_| url.clone());
            self.mqtt.lock().unwrap().push(crate::sensors::MqttStatus { url: shown, ..Default::default() });
            let e = engine.clone();
            std::thread::Builder::new()
                .name("mqtt-source".into())
                .spawn(move || {
                    let status = |f: &mut dyn FnMut(&mut crate::sensors::MqttStatus)| {
                        if let Some(s) = e.devices.mqtt.lock().unwrap().get_mut(i) {
                            f(s)
                        }
                    };
                    let on_message = |topic: &str, payload: &[u8]| match crate::sensors::parse_live(payload, Some(topic)) {
                        Ok(p) => e.devices.push_live(p, "mqtt").is_ok(),
                        Err(_) => false,
                    };
                    crate::sensors::run_mqtt(&url, &status, &on_message);
                })
                .expect("spawn mqtt source");
        }
        for (i, url) in self.cfg.sta.clone().into_iter().enumerate() {
            let shown = crate::sta::parse_sta_url(&url).map(|s| s.display()).unwrap_or_else(|_| url.clone());
            self.sta.lock().unwrap().push(crate::sta::StaStatus { url: shown, ..Default::default() });
            let e = engine.clone();
            std::thread::Builder::new()
                .name("sta-source".into())
                .spawn(move || {
                    let status = |f: &mut dyn FnMut(&mut crate::sta::StaStatus)| {
                        if let Some(s) = e.devices.sta.lock().unwrap().get_mut(i) {
                            f(s)
                        }
                    };
                    crate::sta::run_sta(&e, &url, &status);
                })
                .expect("spawn sta source");
        }
    }

    /// Re-register layers imported in earlier sessions (`<state>/devices/*.gpkg`).
    fn restore_imports(&self, engine: &Arc<Engine>) {
        let Ok(rd) = std::fs::read_dir(engine.state_dir.join("devices")) else { return };
        for path in rd.flatten().map(|e| e.path()) {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if !name.ends_with(".gpkg") || name.ends_with(".importing.gpkg") {
                continue;
            }
            match crate::catalog::load_layers(&path) {
                Ok(handles) => {
                    let layers = engine.register_layers(handles);
                    let id = name.trim_end_matches(".gpkg").to_string();
                    eprintln!("devices: restored {} layers from an earlier import of {id}", layers.len());
                    self.restored.lock().unwrap().insert(id, json!({ "layers": layers, "restored": true }));
                }
                Err(e) => eprintln!("devices: could not restore {}: {e}", path.display()),
            }
        }
    }

    pub fn request_rescan(&self) {
        self.rescan.store(true, Ordering::SeqCst);
    }

    fn poll(&self, engine: &Arc<Engine>) {
        let roots = self.roots();
        let ids: Vec<String> = roots.iter().map(|r| device_id(r)).collect();
        {
            let mut d = self.devices.lock().unwrap();
            for entry in d.values_mut() {
                entry.connected = ids.contains(&entry.id);
            }
        }
        for (root, id) in roots.iter().zip(ids) {
            // MTP/PTP mounts are slow: scan once per connection instead of polling signatures.
            let slow = root.to_string_lossy().contains("gvfs");
            let known = self.devices.lock().unwrap().get(&id).map(|e| (e.signature, e.scan.is_some()));
            let sig = if slow && known.map(|k| k.1).unwrap_or(false) { known.unwrap().0 } else { signature(root) };
            if known.map(|k| k.0 == sig && k.1).unwrap_or(false) {
                continue;
            }
            let s = Arc::new(scan(root));
            let kind = kind_of(root, &s);
            let name = device_label(root);
            // first sighting this session, with the content an earlier session already handled
            // (the device stayed plugged in across a restart): list it, but don't re-run recipes
            let unchanged = known.is_none() && self.seen.lock().unwrap().get(&id) == Some(&sig);
            // device trigger: an enabled recipe may take the device (docs/AUTOMATION.md §3)
            let claimed = s.has_geodata() && !unchanged && {
                let ev = DeviceEvent { id: id.clone(), name: name.clone(), kind, root: root.clone(), photos: s.photos.len(), tracks: s.tracks.len(), waypoints: s.waypoints.len(), readings: s.readings.len(), point_clouds: s.point_clouds.len(), inbox: self.is_inbox(root) };
                self.hook.lock().unwrap().as_ref().is_some_and(|h| h(&ev))
            };
            let auto = self.cfg.auto_import && s.has_geodata() && !claimed && !unchanged;
            if claimed || auto {
                let mut seen = self.seen.lock().unwrap();
                seen.insert(id.clone(), sig);
                save_seen(&engine.state_dir, &seen);
            }
            {
                let mut d = self.devices.lock().unwrap();
                let entry = d.entry(id.clone()).or_insert_with(|| DeviceEntry {
                    id: id.clone(),
                    name: name.clone(),
                    kind,
                    root: root.clone(),
                    connected: true,
                    signature: sig,
                    scan: None,
                    imported: self.restored.lock().unwrap().remove(&id),
                    error: None,
                });
                entry.kind = kind;
                entry.signature = sig;
                entry.connected = true;
                entry.scan = Some(s.clone());
                entry.error = None;
            }
            eprintln!(
                "devices: {name} ({kind}) {} geotagged of {} photos, {} tracks, {} waypoints, {} sensor readings, {} point clouds ({} points) [{:.0} ms]{}",
                s.photos.len(),
                s.images,
                s.tracks.len(),
                s.waypoints.len(),
                s.readings.len(),
                s.point_clouds.len(),
                s.cloud_points(),
                s.ms,
                if claimed { " -> recipe" } else if auto { " -> auto-import" } else if unchanged && s.has_geodata() { " (unchanged since last session, not re-processed)" } else { "" }
            );
            if auto
                && let Err(err) = self.import(engine, &id) {
                    eprintln!("devices: auto-import of {id} failed: {err}");
                }
        }
    }

    /// Import a scanned device as layers (a job on the job pool).
    pub fn import(&self, engine: &Arc<Engine>, id: &str) -> Result<Arc<Job>, String> {
        let (scan, name) = {
            let d = self.devices.lock().unwrap();
            let entry = d.get(id).ok_or_else(|| format!("unknown device '{id}'"))?;
            (entry.scan.clone().ok_or("device not scanned yet")?, entry.name.clone())
        };
        if !scan.has_geodata() {
            return Err("no geotagged photos, tracks, sensor readings or point clouds on this device".into());
        }
        if let Some(j) = engine.jobs.active("device-import", id) {
            return Err(format!("import job {} is already running for this device", j.id));
        }
        let job = engine.jobs.create("device-import", id);
        job.update(|s| s.total = (scan.photos.len() + scan.tracks.len() + scan.waypoints.len() + scan.readings.len() + scan.point_clouds.len()) as u64);
        let (e, j, id) = (engine.clone(), job.clone(), id.to_string());
        engine.job_pool.spawn(move || {
            j.update(|s| s.status = Status::Running);
            let t0 = Instant::now();
            let dir = e.state_dir.join("devices");
            let res = std::fs::create_dir_all(&dir).map_err(|x| x.to_string()).and_then(|_| {
                let tmp = dir.join(format!("{id}.importing.gpkg"));
                let out = dir.join(format!("{id}.gpkg"));
                write_gpkg(&tmp, &name, &scan)?;
                std::fs::rename(&tmp, &out).map_err(|x| x.to_string())?;
                let handles = crate::catalog::load_layers(&out)?;
                Ok(e.register_layers(handles))
            });
            match res {
                Ok(layers) => {
                    let info = json!({ "layers": layers, "at": now_s(), "photos": scan.photos.len(), "tracks": scan.tracks.len(), "waypoints": scan.waypoints.len(), "readings": scan.readings.len(), "point_clouds": scan.point_clouds.len() });
                    if let Some(entry) = e.devices.devices.lock().unwrap().get_mut(&id) {
                        entry.imported = Some(info.clone());
                    }
                    j.update(|s| s.done = s.total);
                    let msg = format!("{} photos, {} tracks, {} waypoints, {} sensor readings, {} point clouds -> {} layers in {:.1} s", scan.photos.len(), scan.tracks.len(), scan.waypoints.len(), scan.readings.len(), scan.point_clouds.len(), layers.len(), t0.elapsed().as_secs_f64());
                    j.finish(Status::Done, msg, Some(info));
                }
                Err(err) => {
                    if let Some(entry) = e.devices.devices.lock().unwrap().get_mut(&id) {
                        entry.error = Some(err.clone());
                    }
                    j.finish(Status::Failed, err, None);
                }
            }
        });
        Ok(job)
    }

    /// Device triggers: called for every new or changed device with geodata.
    pub fn set_hook(&self, h: DeviceHook) {
        *self.hook.lock().unwrap() = Some(h);
    }

    /// Restore earlier imports and scan devices once, synchronously (CLI runs).
    pub fn scan_now(&self, engine: &Arc<Engine>) {
        self.restore_imports(engine);
        self.poll(engine);
    }

    /// Note an import done elsewhere (a recipe step), so the Devices pane shows it.
    pub fn record_import(&self, id: &str, info: Value) {
        match self.devices.lock().unwrap().get_mut(id) {
            Some(e) => {
                e.imported = Some(info);
                e.error = None;
            }
            None => {
                self.restored.lock().unwrap().insert(id.to_string(), info);
            }
        }
    }

    /// Root folder of a known device, by id or name (case-insensitive).
    pub fn find_root(&self, key: &str) -> Option<PathBuf> {
        let d = self.devices.lock().unwrap();
        d.values().find(|e| e.id == key || e.name.eq_ignore_ascii_case(key)).map(|e| e.root.clone())
    }

    /// The connected device a recipe with `source: auto` should use: phones and cameras first,
    /// then drones, GPS units and folders; most geodata wins a tie.
    pub fn best_root(&self) -> Option<PathBuf> {
        let rank = |k: &str| match k {
            "phone" => 0,
            "camera" => 1,
            "drone" => 2,
            "gps" => 3,
            "sensor" => 4,
            _ => 5,
        };
        let d = self.devices.lock().unwrap();
        d.values()
            .filter(|e| e.connected && e.scan.as_ref().is_some_and(|s| s.has_geodata()))
            .min_by_key(|e| {
                let s = e.scan.as_ref().unwrap();
                (rank(e.kind), usize::MAX - (s.photos.len() + s.tracks.len() + s.waypoints.len() + s.readings.len()))
            })
            .map(|e| e.root.clone())
    }

    pub fn names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.devices.lock().unwrap().values().map(|e| format!("{} ({})", e.name, e.id)).collect();
        v.sort();
        v
    }

    pub fn json(&self) -> Value {
        let d = self.devices.lock().unwrap();
        let mut list: Vec<&DeviceEntry> = d.values().collect();
        list.sort_by(|a, b| b.connected.cmp(&a.connected).then(a.name.cmp(&b.name)));
        let devices: Vec<Value> = list
            .iter()
            .map(|e| {
                let s = e.scan.as_deref();
                let bounds = s.and_then(|s| {
                    let pts = s.photos.iter().map(|p| (p.lon, p.lat)).chain(s.waypoints.iter().map(|w| (w.lon, w.lat))).chain(s.tracks.iter().flat_map(|t| t.parts.iter().flatten().copied())).chain(s.readings.iter().map(|r| (r.lon, r.lat))).chain(s.point_clouds.iter().filter_map(|c| c.lonlat).flat_map(|b| [(b[0], b[1]), (b[2], b[3])]));
                    pts.fold(None, |acc: Option<[f64; 4]>, (x, y)| Some(match acc { None => [x, y, x, y], Some(b) => [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)] }))
                });
                json!({
                    "id": e.id, "name": e.name, "kind": e.kind, "root": e.root, "connected": e.connected,
                    "photos_geotagged": s.map(|s| s.photos.len()), "photos_total": s.map(|s| s.images),
                    "photos_placed": s.map(|s| s.photos.iter().filter(|p| p.placed.is_some()).count()),
                    "tracks": s.map(|s| s.tracks.len()), "waypoints": s.map(|s| s.waypoints.len()),
                    "track_files": s.map(|s| s.track_files), "scan_ms": s.map(|s| (s.ms * 10.0).round() / 10.0),
                    "readings": s.map(|s| s.readings.len()), "sensor_files": s.map(|s| s.sensor_files), "reading_fields": s.map(|s| s.field_names()),
                    "point_clouds": s.map(|s| s.point_clouds.len()), "cloud_points": s.map(|s| s.cloud_points()),
                    "truncated": s.map(|s| s.truncated), "bounds": bounds,
                    "imported": e.imported, "error": e.error,
                })
            })
            .collect();
        let live = self.live.lock().unwrap();
        let live: Vec<Value> = live
            .iter()
            .map(|(id, l)| {
                let latest: Map<String, Value> = l.readings.back().map(|r| r.values.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect()).unwrap_or_default();
                json!({ "id": id, "name": l.name, "source": l.source, "kind": l.kind, "fixes": l.fixes.len(), "readings": l.readings.len(), "values": latest, "age_s": l.last.elapsed().as_secs_f64().round() })
            })
            .collect();
        let mqtt = serde_json::to_value(&*self.mqtt.lock().unwrap()).unwrap_or_default();
        let sta = serde_json::to_value(&*self.sta.lock().unwrap()).unwrap_or_default();
        json!({ "devices": devices, "live": live, "auto_import": self.cfg.auto_import, "watching": self.cfg.watch, "mounts": self.cfg.scan_mounts, "gps_sources": self.cfg.gps, "mqtt": mqtt, "sta": sta })
    }

    pub fn push_fix(&self, id: &str, name: &str, source: &str, fix: Fix) {
        let shown = {
            let mut live = self.live.lock().unwrap();
            let d = live.entry(id.to_string()).or_insert_with(|| LiveDevice::new(name, source, "gps"));
            if d.fixes.len() >= LIVE_FIXES {
                d.fixes.pop_front();
            }
            d.fixes.push_back(fix);
            d.last = Instant::now();
            if !name.is_empty() {
                d.name = name.to_string();
            }
            (d.name.clone(), d.kind)
        };
        self.emit(SensorEvent { device_id: id.to_string(), name: shown.0, kind: shown.1, source: source.to_string(), lon: fix.lon, lat: fix.lat, t: fix.t, values: Vec::new() });
    }

    /// A parsed live message (phone page, sensor JSON over HTTP, MQTT). Messages without a
    /// position use the device's last one. Returns the live device id.
    pub fn push_live(&self, p: crate::sensors::LivePush, via: &str) -> Result<String, String> {
        let id = match (via, p.kind) {
            ("mqtt" | "sta", _) => p.id.clone(),
            (_, "phone") => format!("phone-{}", p.id.trim_start_matches("phone-")),
            _ => format!("sensor-{}", p.id.trim_start_matches("sensor-")),
        };
        let source = match (via, p.kind) {
            _ if p.network.is_some() => p.network.unwrap_or_default().to_string(),
            ("mqtt", _) => "mqtt".to_string(),
            (_, "phone") => "phone page".to_string(),
            _ => "http".to_string(),
        };
        let t = p.t.unwrap_or_else(now_s);
        let (name, kind, lon, lat) = {
            let mut live = self.live.lock().unwrap();
            let last = live.get(&id).and_then(|d| d.fixes.back().map(|f| (f.lon, f.lat)));
            let (lon, lat) = p.pos.or(last).ok_or_else(|| format!("no position for '{id}' yet: send lat/lon at least once"))?;
            let default_name = if p.kind == "phone" { "Phone".to_string() } else { id.clone() };
            let d = live.entry(id.clone()).or_insert_with(|| LiveDevice::new(p.name.as_deref().unwrap_or(&default_name), &source, p.kind));
            if p.pos.is_some() {
                if d.fixes.len() >= LIVE_FIXES {
                    d.fixes.pop_front();
                }
                d.fixes.push_back(Fix { lon, lat, alt: p.alt, speed: p.speed, course: p.course, accuracy: p.accuracy, sats: None, quality: None, t });
            }
            if !p.values.is_empty() {
                if d.readings.len() >= LIVE_FIXES {
                    d.readings.pop_front();
                }
                d.readings.push_back(LiveReading { t, lon, lat, values: p.values.clone() });
                if p.kind == "sensor" {
                    d.kind = "sensor";
                }
            }
            if let Some(n) = &p.name {
                d.name = n.clone();
            }
            d.last = Instant::now();
            (d.name.clone(), d.kind, lon, lat)
        };
        self.emit(SensorEvent { device_id: id.clone(), name, kind, source, lon, lat, t, values: p.values });
        Ok(id)
    }

    fn emit(&self, ev: SensorEvent) {
        if let Some(h) = self.sensor_hook.lock().unwrap().as_ref() {
            h(&ev);
        }
    }

    /// `sensor` triggers: called for every live position and reading.
    pub fn set_sensor_hook(&self, h: SensorHook) {
        *self.sensor_hook.lock().unwrap() = Some(h);
    }

    /// Live readings since `since` (Unix s), oldest first: (device id, name, reading).
    /// `device` is a glob on the id or name (`aq-*`).
    pub fn live_readings(&self, device: Option<&str>, since: f64) -> Vec<(String, String, LiveReading)> {
        let live = self.live.lock().unwrap();
        let mut out: Vec<(String, String, LiveReading)> = live
            .iter()
            .filter(|(id, d)| device.is_none_or(|g| g == "auto" || g == "all" || crate::automation::triggers::glob(g, id) || crate::automation::triggers::glob(g, &d.name)))
            .flat_map(|(id, d)| d.readings.iter().filter(|r| r.t >= since).map(move |r| (id.clone(), d.name.clone(), r.clone())))
            .collect();
        out.sort_by(|a, b| a.2.t.total_cmp(&b.2.t));
        out
    }

    /// Recent fixes per live device (for snapshot tracks).
    pub fn live_tracks(&self, device: Option<&str>, since: f64) -> Vec<(String, String, Vec<(f64, f64)>)> {
        let live = self.live.lock().unwrap();
        live.iter()
            .filter(|(id, d)| device.is_none_or(|g| g == "auto" || g == "all" || crate::automation::triggers::glob(g, id) || crate::automation::triggers::glob(g, &d.name)))
            .map(|(id, d)| (id.clone(), d.name.clone(), d.fixes.iter().filter(|f| f.t >= since).map(|f| (f.lon, f.lat)).collect::<Vec<_>>()))
            .filter(|(_, _, pts)| pts.len() >= 2 && pts.windows(2).map(|w| haversine(w[0], w[1])).sum::<f64>() > 5.0)
            .collect()
    }

    /// Live readings as GeoJSON points (`GET /api/devices/readings`).
    pub fn readings_geojson(&self, device: Option<&str>, minutes: f64) -> Value {
        let rows = self.live_readings(device, now_s() - minutes * 60.0);
        let feats: Vec<Value> = rows
            .iter()
            .map(|(id, name, r)| {
                let mut props: Map<String, Value> = r.values.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect();
                props.insert("device".into(), id.clone().into());
                props.insert("name".into(), name.clone().into());
                props.insert("t".into(), r.t.into());
                json!({ "type": "Feature", "geometry": { "type": "Point", "coordinates": [r.lon, r.lat] }, "properties": props })
            })
            .collect();
        json!({ "type": "FeatureCollection", "features": feats })
    }

    /// `POST /api/devices/live`: the phone page (position) or any sensor
    /// (`{"id": "aq-01", "lat": .., "lon": .., "values": {"pm2_5": 41}}`). Returns the live id.
    pub fn push_json(&self, body: &[u8]) -> Result<String, String> {
        let p = crate::sensors::parse_live(body, None)?;
        if p.pos.is_none() && p.values.is_empty() {
            return Err("missing lat/lon (and no sensor values)".into());
        }
        self.push_live(p, "http")
    }

    /// Live devices as GeoJSON: a Point (latest fix) and a LineString (recent track) per device.
    pub fn live_geojson(&self) -> Value {
        let live = self.live.lock().unwrap();
        let mut feats = Vec::new();
        for (id, d) in live.iter() {
            let Some(last) = d.fixes.back() else { continue };
            let moved = d.fixes.iter().any(|f| (f.lon - last.lon).abs() > 1e-6 || (f.lat - last.lat).abs() > 1e-6);
            if d.fixes.len() >= 2 && moved {
                let coords: Vec<[f64; 2]> = d.fixes.iter().map(|f| [f.lon, f.lat]).collect();
                feats.push(json!({ "type": "Feature", "geometry": { "type": "LineString", "coordinates": coords }, "properties": { "device": id, "role": "track" } }));
            }
            let mut props = json!({ "device": id, "role": "position", "kind": d.kind, "name": d.name, "source": d.source, "accuracy_m": last.accuracy, "speed_mps": last.speed,
                                    "course": last.course, "altitude": last.alt, "sats": last.sats, "fixes": d.fixes.len(), "readings": d.readings.len(), "age_s": d.last.elapsed().as_secs_f64().round() });
            if let Some(r) = d.readings.back() {
                for (k, v) in &r.values {
                    props[k.as_str()] = Value::from(*v);
                }
            }
            feats.push(json!({ "type": "Feature", "geometry": { "type": "Point", "coordinates": [last.lon, last.lat] }, "properties": props }));
        }
        json!({ "type": "FeatureCollection", "features": feats })
    }
}

impl LiveDevice {
    fn new(name: &str, source: &str, kind: &'static str) -> LiveDevice {
        LiveDevice { name: name.to_string(), source: source.to_string(), kind, fixes: VecDeque::new(), readings: VecDeque::new(), last: Instant::now() }
    }
}

/// Removable media and phone mounts for the current OS.
fn mount_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let children = |p: &Path| -> Vec<PathBuf> { std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default() };
    if cfg!(target_os = "linux") {
        let user = std::env::var("USER").unwrap_or_default();
        for base in [format!("/media/{user}"), format!("/run/media/{user}")] {
            out.extend(children(Path::new(&base)));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Ok(md) = std::fs::metadata("/proc/self") {
                out.extend(children(Path::new(&format!("/run/user/{}/gvfs", md.uid()))).into_iter().filter(|p| {
                    let s = p.to_string_lossy();
                    s.contains("mtp:") || s.contains("gphoto2:")
                }));
            }
        }
    } else if cfg!(target_os = "macos") {
        out.extend(children(Path::new("/Volumes")).into_iter().filter(|p| std::fs::read_link(p).is_err() && !p.ends_with("Macintosh HD")));
    } else if cfg!(windows) {
        // Removable drives (SD cards, USB sticks, cameras/GPS units/drones in mass-storage mode), plus any other
        // drive whose top level looks like a camera, GPS or drone card. Fixed data disks are left alone: walking
        // a whole disk every few seconds would be wasteful. (Phones in MTP mode need the WPD API: not yet.)
        for letter in b'D'..=b'Z' {
            let p = PathBuf::from(format!("{}:\\", letter as char));
            if p.is_dir() && (drive_is_removable(letter) || ["DCIM", "GARMIN", "Garmin", "PRIVATE"].iter().any(|m| p.join(m).is_dir())) {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(windows)]
fn drive_is_removable(letter: u8) -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    let root: Vec<u16> = format!("{}:\\", letter as char).encode_utf16().chain(Some(0)).collect();
    unsafe { GetDriveTypeW(root.as_ptr()) == 2 } // DRIVE_REMOVABLE
}

#[cfg(not(windows))]
fn drive_is_removable(_letter: u8) -> bool {
    false
}

// ---------------------------------------------------------------- live GNSS sources

/// Friendly label for a live GNSS source.
pub fn gnss_name(src: &str) -> String {
    let file = |p: &str| Path::new(p.split('?').next().unwrap_or(p)).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string());
    if let Some(r) = src.strip_prefix("file://") {
        format!("GNSS replay · {}", file(r))
    } else if let Some(r) = src.strip_prefix("gpsd://") {
        format!("gpsd · {r}")
    } else if let Some(r) = src.strip_prefix("tcp://") {
        format!("NMEA · {r}")
    } else {
        format!("GNSS · {}", src.strip_prefix("serial://").unwrap_or(src).split('?').next().unwrap_or(src))
    }
}

fn run_gnss_source(engine: &Arc<Engine>, src: &str) {
    let id = format!("gps-{}", slug(src.rsplit("://").next().unwrap_or(src)));
    let name = gnss_name(src);
    let push = |f: Fix| engine.devices.push_fix(&id, &name, src, f);
    let mut backoff = 1u64;
    loop {
        let res: Result<(), String> = (|| {
            if let Some(rest) = src.strip_prefix("gpsd://") {
                let mut s = std::net::TcpStream::connect(rest).map_err(|e| e.to_string())?;
                s.write_all(b"?WATCH={\"enable\":true,\"json\":true}\n").map_err(|e| e.to_string())?;
                for line in BufReader::new(s).lines() {
                    if let Some(f) = parse_gpsd(&line.map_err(|e| e.to_string())?) {
                        push(f);
                    }
                }
                Err("gpsd closed the connection".into())
            } else if let Some(rest) = src.strip_prefix("tcp://") {
                let s = std::net::TcpStream::connect(rest).map_err(|e| e.to_string())?;
                let mut st = NmeaState::default();
                for line in BufReader::new(s).lines() {
                    if let Some(f) = st.feed(&line.map_err(|e| e.to_string())?) {
                        push(f);
                    }
                }
                Err("NMEA stream closed".into())
            } else if let Some(rest) = src.strip_prefix("file://") {
                let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
                let rate: f64 = query.strip_prefix("rate=").and_then(|r| r.parse().ok()).unwrap_or(1.0);
                let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
                let mut st = NmeaState::default();
                for line in text.lines() {
                    if let Some(f) = st.feed(line) {
                        push(f);
                        std::thread::sleep(Duration::from_secs_f64(1.0 / rate.max(0.01)));
                    }
                }
                Ok(()) // replay finished
            } else {
                let (dev, query) = src.strip_prefix("serial://").unwrap_or(src).split_once('?').unwrap_or((src.strip_prefix("serial://").unwrap_or(src), ""));
                let baud = query.strip_prefix("baud=").unwrap_or("9600");
                #[cfg(unix)]
                let _ = std::process::Command::new("stty").args(["-F", dev, baud, "raw", "-echo"]).status();
                // Windows: serial://COM3?baud=4800 → set the line with mode.com, open \\.\COM3
                #[cfg(windows)]
                let dev = &{
                    let port = dev.trim_start_matches("\\\\.\\");
                    let _ = crate::command("mode.com").args([format!("{port}:"), format!("BAUD={baud}"), "PARITY=n".into(), "DATA=8".into(), "STOP=1".into()]).status();
                    format!("\\\\.\\{port}")
                };
                let f = std::fs::File::open(dev).map_err(|e| format!("{dev}: {e}"))?;
                let mut st = NmeaState::default();
                for line in BufReader::new(f).lines() {
                    if let Some(fix) = st.feed(&line.map_err(|e| e.to_string())?) {
                        push(fix);
                    }
                }
                Err("serial port closed".into())
            }
        })();
        match res {
            Ok(()) => return,
            Err(e) => {
                eprintln!("gnss {src}: {e}; retrying in {backoff} s");
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(30);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nmea_gga_rmc() {
        let mut st = NmeaState::default();
        let gga = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47";
        let f = st.feed(gga).expect("gga fix");
        assert!((f.lat - 48.1173).abs() < 1e-4 && (f.lon - 11.516_666).abs() < 1e-4, "{f:?}");
        assert_eq!((f.sats, f.quality, f.alt), (Some(8), Some(1), Some(545.4)));
        let rmc = "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A";
        let f = st.feed(rmc).expect("rmc fix");
        assert!((f.speed.unwrap() - 22.4 * 0.514444).abs() < 1e-6 && f.course == Some(84.4));
        assert!(st.feed("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*48").is_none(), "bad checksum");
        assert!(st.feed("$GPRMC,123519,V,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*7D").is_none(), "void fix");
        assert_eq!(nmea_coord("0947.123", "S").map(|v| (v * 1e4).round() / 1e4), Some(-9.7854));
    }

    #[test]
    fn gpsd_tpv() {
        let f = parse_gpsd(r#"{"class":"TPV","mode":3,"lat":-9.44,"lon":147.18,"altMSL":35.0,"speed":1.5,"track":90,"epx":3.0,"epy":4.5}"#).unwrap();
        assert_eq!((f.lat, f.lon, f.alt, f.accuracy), (-9.44, 147.18, Some(35.0), Some(4.5)));
        assert!(parse_gpsd(r#"{"class":"TPV","mode":1}"#).is_none());
        assert!(parse_gpsd(r#"{"class":"SKY"}"#).is_none());
    }

    #[test]
    fn dji_srt_both_formats() {
        let new = "1\n00:00:00,000 --> 00:00:00,033\n<font size=\"28\">FrameCnt: 1 [iso : 100] [latitude: -6.081234] [longitude: 145.391234] [rel_alt: 50.0 abs_alt: 1650.2]</font>\n\n2\n00:00:00,033 --> 00:00:00,066\n[latitude : -6.081300] [longitude : 145.391300] [rel_alt: 50.1 abs_alt: 1650.3]\n";
        assert_eq!(parse_srt(new), vec![(145.391234, -6.081234), (145.3913, -6.0813)]);
        let old = "1\n00:00:01,000 --> 00:00:02,000\nHOME(145.3900,-6.0800) 2019.01.01 10:00:00\nGPS(145.3912,-6.0812,19) BAROMETER:50.3\n";
        assert_eq!(parse_srt(old), vec![(145.3912, -6.0812)]);
    }

    #[test]
    fn exif_helpers() {
        assert_eq!(signed(9.5, Some("S")), -9.5);
        assert_eq!(signed(147.2, Some("E")), 147.2);
        assert_eq!(exif_time("2026:10:14 09:30:00"), "2026-10-14T09:30:00");
        // GDAL date-time text -> Unix seconds
        assert_eq!(gdal_time_epoch("2026/10/13 08:00:00+00"), Some(1_791_878_400.0));
        assert_eq!(gdal_time_epoch("2026/10/13 18:00:00+10"), Some(1_791_878_400.0));
        assert_eq!(gdal_time_epoch("2026/10/13 18:30:00+1030"), Some(1_791_878_400.0));
        assert_eq!(gdal_time_epoch("2026/10/13 08:00:00.5"), Some(1_791_878_400.5));
        // placing photos on a track by time: between two points, snapping near the ends, never across long gaps
        let pts = [(1000.0, 144.0, -5.0), (1010.0, 144.001, -5.001), (2000.0, 145.0, -6.0)];
        let (x, y) = interpolate_track(&pts, 1005.0).unwrap();
        assert!((x - 144.0005).abs() < 1e-9 && (y + 5.0005).abs() < 1e-9, "{x} {y}");
        assert_eq!(interpolate_track(&pts, 1010.0), Some((144.001, -5.001)));
        assert_eq!(interpolate_track(&pts, 970.0), Some((144.0, -5.0)), "30 s before the first point snaps to it");
        assert_eq!(interpolate_track(&pts, 900.0), None, "100 s before: too far");
        assert_eq!(interpolate_track(&pts, 1500.0), None, "inside a 990 s gap: unknown");
        assert_eq!(interpolate_track(&pts, 1040.0), Some((144.001, -5.001)), "30 s after a point, gap too long: snap");
        // photo time with an EXIF offset
        let u = Unlocated { path: "x.jpg".into(), taken_at: "2026-10-13T18:00:00".into(), offset: Some("+10:00".into()), make: None, model: None };
        assert_eq!(u.epoch(), Some(1_791_878_400.0));
        assert_eq!(xmp_attr(r#"drone-dji:GimbalYawDegree="-12.30" drone-dji:RelativeAltitude="+80.10""#, "drone-dji:RelativeAltitude"), Some(80.1));
        assert_eq!(slug("TEST PHONE (Pixel 8)"), "test-phone-pixel-8");
        assert!(device_id(Path::new("/run/user/1000/gvfs/mtp:host=Google_Pixel_8_ABC")).starts_with("google-pixel-8-abc-"));
        assert!((haversine((147.0, -9.0), (147.0, -10.0)) - 111_195.0).abs() < 50.0);
        assert_eq!(gnss_name("file:///tmp/x/live-replay.nmea?rate=5"), "GNSS replay · live-replay.nmea");
        assert_eq!(gnss_name("serial:///dev/ttyACM0?baud=9600"), "GNSS · /dev/ttyACM0");
        assert_eq!(gnss_name("gpsd://localhost:2947"), "gpsd · localhost:2947");
    }
}
