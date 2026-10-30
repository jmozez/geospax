//! Phone link (docs/DEVICES.md §3a): send photos, tracks and sensor logs from a phone to GeoSpaX over Wi-Fi,
//! with no cable and no app. GeoSpaX shows a QR code; the phone opens it and gets the phone page.
//!
//! A small HTTPS listener serves that page and a few endpoints. Its certificate is self-signed, because
//! phone browsers only give a page location access in a secure context. Every request must carry the
//! pairing token from the QR code, and anything beyond upload and commit is a short whitelist forwarded to
//! the normal API. Uploads collect in a batch folder that moves into the drop folder when the phone says
//! it is done (or after two quiet minutes), so the matching recipe runs once per batch, not once per photo.
//! On commit the phone's live track (if it shared one) is written into the batch as a timed GPX, which lets
//! the scanner place photos without GPS by their capture time (devices::place_by_time).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};

use crate::Engine;
use crate::devices::Fix;
use crate::router::{ApiRequest, pct_decode};

pub const DEFAULT_PORT: u16 = 8765;
const MAX_UPLOAD: u64 = 64 << 20;
const MAX_BODY: u64 = 1 << 20;
const MAX_HEAD: usize = 16 << 10;
const MAX_CONNECTIONS: usize = 32;
const BATCH_IDLE: Duration = Duration::from_secs(120);
static PHONE_PAGE: &str = include_str!("../../../web/public/phone.html");
static PHONE_JS: &str = include_str!("../../../web/public/phone.js");
/// The phone page runs only its own script file, never inline code.
const PHONE_CSP: &str =
    "default-src 'self'; img-src 'self' blob: data:; style-src 'unsafe-inline'; script-src 'self'";

/// Adapter settings: `--phone` / `--phone-port` (server), `GEOSPAX_PHONE` / `GEOSPAX_PHONE_PORT` (desktop).
#[derive(Debug, Clone)]
pub struct PhoneConfig {
    /// Start the phone link even if it was never switched on in the UI.
    pub enable: bool,
    pub port: u16,
}

impl Default for PhoneConfig {
    fn default() -> Self {
        PhoneConfig {
            enable: false,
            port: DEFAULT_PORT,
        }
    }
}

/// What survives restarts: `<state>/phone/link.json`. The token stays the same until "New code", so a phone
/// that bookmarked the page keeps working.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Saved {
    enabled: bool,
    token: String,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

pub struct PhoneLink {
    dir: PathBuf,
    cfg: PhoneConfig,
    saved: Mutex<Saved>,
    running: Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
}

impl PhoneLink {
    pub fn new(state_dir: &Path, cfg: PhoneConfig) -> PhoneLink {
        let dir = state_dir.join("phone");
        let saved = std::fs::read(dir.join("link.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Saved>(&b).ok())
            .filter(|s| s.token.len() >= 16)
            .unwrap_or_else(|| Saved {
                enabled: false,
                token: new_token(),
            });
        PhoneLink {
            dir,
            cfg,
            saved: Mutex::new(saved),
            running: Mutex::new(None),
            error: Mutex::new(None),
        }
    }

    fn save(&self) {
        let s = self.saved.lock().unwrap().clone();
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = std::fs::write(
            self.dir.join("link.json"),
            serde_json::to_vec_pretty(&s).unwrap_or_default(),
        );
    }

    fn token(&self) -> String {
        self.saved.lock().unwrap().token.clone()
    }

    /// Called by `Engine::start_services`: resume the link if it was on (or the adapter asks for it).
    pub fn start_if_enabled(&self, engine: &Arc<Engine>) {
        if self.cfg.enable || self.saved.lock().unwrap().enabled {
            if let Err(e) = self.start(engine) {
                eprintln!("phone link: {e}");
            }
        }
    }

    pub fn enable(&self, engine: &Arc<Engine>) -> Result<Value, String> {
        self.saved.lock().unwrap().enabled = true;
        self.save();
        self.start(engine)?;
        Ok(self.json(engine))
    }

    pub fn disable(&self, engine: &Arc<Engine>) -> Value {
        self.saved.lock().unwrap().enabled = false;
        self.save();
        if let Some(r) = self.running.lock().unwrap().take() {
            r.stop.store(true, Ordering::SeqCst);
        }
        self.json(engine)
    }

    /// New pairing code: phones paired before must scan again.
    pub fn reset(&self, engine: &Arc<Engine>) -> Value {
        self.saved.lock().unwrap().token = new_token();
        self.save();
        self.json(engine)
    }

    /// State for the UI card (`GET /api/phone`): the address to open on the phone and its QR code.
    pub fn json(&self, engine: &Engine) -> Value {
        let port = self.running.lock().unwrap().as_ref().map(|r| r.port);
        let token = self.token();
        let urls: Vec<String> = match port {
            Some(port) => lan_ips()
                .iter()
                .map(|ip| format!("https://{}:{port}/#t={token}", host_of(ip)))
                .collect(),
            None => Vec::new(),
        };
        let qr = urls.first().and_then(|u| qr_svg(u));
        json!({
            "enabled": self.saved.lock().unwrap().enabled,
            "running": port.is_some(),
            "port": port,
            "url": urls.first(),
            "urls": urls,
            "qr_svg": qr,
            "computer": computer_name(),
            "inbox": engine.devices.inbox_dir().map(|p| p.display().to_string()),
            "error": self.error.lock().unwrap().clone(),
        })
    }

    pub fn start(&self, engine: &Arc<Engine>) -> Result<(), String> {
        if self.running.lock().unwrap().is_some() {
            return Ok(());
        }
        let result = (|| {
            let tls = Arc::new(self.tls_config()?);
            // the configured port, or the next free one (the UI always shows the real address)
            let mut last_err = String::new();
            let listener = (0..10)
                .find_map(|i| {
                    match TcpListener::bind(("0.0.0.0", self.cfg.port.saturating_add(i))) {
                        Ok(l) => Some(l),
                        Err(e) => {
                            last_err = e.to_string();
                            None
                        }
                    }
                })
                .ok_or_else(|| format!("no free port from {}: {last_err}", self.cfg.port))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let stop = Arc::new(AtomicBool::new(false));
            let (e, s) = (engine.clone(), stop.clone());
            std::thread::Builder::new()
                .name("phone-link".into())
                .spawn(move || accept_loop(e, listener, tls, s))
                .map_err(|e| e.to_string())?;
            *self.running.lock().unwrap() = Some(Running { port, stop });
            // keep the pairing code across restarts (also when started by --phone, not the UI), so a phone's
            // bookmark of the page keeps working
            if !self.dir.join("link.json").exists() {
                self.save();
            }
            eprintln!(
                "phone link: https://{}:{port}/ (pairing code in the Devices panel)",
                lan_ips().first().map(host_of).unwrap_or_default()
            );
            Ok(())
        })();
        *self.error.lock().unwrap() = result.as_ref().err().cloned();
        result
    }

    /// Self-signed certificate, made once and kept in `<state>/phone/`.
    fn tls_config(&self) -> Result<rustls::ServerConfig, String> {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        let (cert_path, key_path) = (self.dir.join("cert.der"), self.dir.join("key.der"));
        let (cert, key) = match (std::fs::read(&cert_path), std::fs::read(&key_path)) {
            (Ok(c), Ok(k)) => (c, k),
            _ => {
                let mut names = vec!["localhost".to_string(), "geospax.local".to_string()];
                names.extend(lan_ips().iter().map(|ip| ip.to_string()));
                let ck = rcgen::generate_simple_self_signed(names)
                    .map_err(|e| format!("certificate: {e}"))?;
                let (c, k) = (ck.cert.der().to_vec(), ck.signing_key.serialize_der());
                std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
                std::fs::write(&cert_path, &c).map_err(|e| e.to_string())?;
                std::fs::write(&key_path, &k).map_err(|e| e.to_string())?;
                (c, k)
            }
        };
        rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert)],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
        )
        .map_err(|e| format!("certificate: {e}"))
    }
}

/// Compare without leaking how many leading characters matched (the pairing token).
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn new_token() -> String {
    let mut b = [0u8; 16];
    if rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut b)
        .is_err()
    {
        // never expected; fall back to something unguessable enough for a LAN pairing code
        let t = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        b.copy_from_slice(&(t ^ (std::process::id() as u128) << 64).to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// This computer's addresses on the local network, best first (the route a phone on the same Wi-Fi would use).
/// Connecting a UDP socket sends nothing; it only asks the OS which interface would be used.
pub fn lan_ips() -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    for probe in [
        "192.0.2.1:9",
        "10.254.254.254:9",
        "172.31.255.254:9",
        "192.168.255.254:9",
    ] {
        let ip = UdpSocket::bind("0.0.0.0:0")
            .ok()
            .and_then(|s| s.connect(probe).ok().and_then(|_| s.local_addr().ok()))
            .map(|a| a.ip());
        if let Some(ip) =
            ip.filter(|ip| !ip.is_loopback() && !ip.is_unspecified() && !out.contains(ip))
        {
            out.push(ip);
        }
    }
    if out.is_empty() {
        out.push(IpAddr::from([127, 0, 0, 1]));
    }
    out
}

fn host_of(ip: &IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) => format!("[{v6}]"),
        IpAddr::V4(v4) => v4.to_string(),
    }
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "this computer".into())
}

pub fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(svg::Color("#0f172a"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

// ---------------------------------------------------------------- listener

fn accept_loop(
    engine: Arc<Engine>,
    listener: TcpListener,
    tls: Arc<rustls::ServerConfig>,
    stop: Arc<AtomicBool>,
) {
    let active = Arc::new(AtomicUsize::new(0));
    let mut janitor = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((sock, _peer)) => {
                if active.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    continue; // dropped: the phone retries
                }
                let _ = sock.set_nonblocking(false);
                let _ = sock.set_read_timeout(Some(Duration::from_secs(60)));
                let _ = sock.set_write_timeout(Some(Duration::from_secs(60)));
                active.fetch_add(1, Ordering::SeqCst);
                let (e, t, a) = (engine.clone(), tls.clone(), active.clone());
                let spawned =
                    std::thread::Builder::new()
                        .name("phone-conn".into())
                        .spawn(move || {
                            let _ = serve_connection(&e, t, sock);
                            a.fetch_sub(1, Ordering::SeqCst);
                        });
                if spawned.is_err() {
                    active.fetch_sub(1, Ordering::SeqCst);
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
        if janitor.elapsed() > Duration::from_secs(10) {
            commit_idle_batches(&engine);
            janitor = Instant::now();
        }
    }
}

struct Request {
    method: String,
    path: String,
    query: String,
    length: u64,
    host: String,
    expect_continue: bool,
}

/// Request line and headers. `None` when the connection closed first.
fn read_head(rd: &mut impl BufRead) -> std::io::Result<Option<Request>> {
    let mut lines = Vec::new();
    let mut total = 0;
    loop {
        let mut line = String::new();
        let n = rd.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        total += n;
        if total > MAX_HEAD {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "headers too large",
            ));
        }
        let line = line.trim_end().to_string();
        if line.is_empty() {
            break;
        }
        lines.push(line);
    }
    let first = lines.first().cloned().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let (method, target) = (
        parts.next().unwrap_or("").to_string(),
        parts.next().unwrap_or("/").to_string(),
    );
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    let header = |name: &str| {
        lines.iter().skip(1).find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.trim().eq_ignore_ascii_case(name))
                .map(|(_, v)| v.trim().to_string())
        })
    };
    Ok(Some(Request {
        method,
        path,
        query,
        length: header("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        host: header("host").unwrap_or_default(),
        expect_continue: header("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")),
    }))
}

fn write_response(
    w: &mut impl Write,
    status: u16,
    content_type: &str,
    extra: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        301 => "Moved Permanently",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ if status >= 500 => "Server Error",
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    w.write_all(head.as_bytes())?;
    w.write_all(body)?;
    w.flush()
}

fn json_response(
    status: u16,
    v: &Value,
) -> (u16, &'static str, Vec<(&'static str, String)>, Vec<u8>) {
    (
        status,
        "application/json",
        Vec::new(),
        v.to_string().into_bytes(),
    )
}

fn serve_connection(
    engine: &Arc<Engine>,
    tls: Arc<rustls::ServerConfig>,
    sock: TcpStream,
) -> std::io::Result<()> {
    // Someone typed http://: send them to the https address instead of a TLS error
    let mut first = [0u8; 1];
    if sock.peek(&mut first)? == 1 && first[0].is_ascii_alphabetic() {
        let mut rd = BufReader::new(sock);
        if let Some(req) = read_head(&mut rd)? {
            let host = if req.host.is_empty() {
                "localhost".into()
            } else {
                req.host
            };
            let to = format!("https://{host}{}", req.path);
            write_response(
                rd.get_mut(),
                301,
                "text/plain",
                &[("Location", to.clone())],
                to.as_bytes(),
            )?;
        }
        return Ok(());
    }
    let conn =
        rustls::ServerConnection::new(tls).map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut rd = BufReader::new(rustls::StreamOwned::new(conn, sock));
    let Some(req) = read_head(&mut rd)? else {
        return Ok(());
    };
    if req.expect_continue && req.length > 0 {
        // curl and some apps wait for this before sending a large body
        rd.get_mut().write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        rd.get_mut().flush()?;
    }
    let (status, ctype, headers, body) = route(engine, &req, &mut rd);
    write_response(rd.get_mut(), status, ctype, &headers, &body)?;
    rd.get_mut().conn.send_close_notify();
    let _ = rd.get_mut().flush();
    Ok(())
}

fn param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| pct_decode(&v.replace('+', " ")))
    })
}

type Reply = (u16, &'static str, Vec<(&'static str, String)>, Vec<u8>);

fn route<R: BufRead>(engine: &Arc<Engine>, req: &Request, rd: &mut R) -> Reply {
    let link = &engine.phone;
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/phone.html") => {
            return (
                200,
                "text/html; charset=utf-8",
                vec![("Content-Security-Policy", PHONE_CSP.into())],
                PHONE_PAGE.as_bytes().to_vec(),
            );
        }
        ("GET", "/phone.js") => {
            return (
                200,
                "text/javascript; charset=utf-8",
                Vec::new(),
                PHONE_JS.as_bytes().to_vec(),
            );
        }
        ("GET", "/favicon.ico") => return (404, "text/plain", Vec::new(), Vec::new()),
        _ => {}
    }
    if !same(
        param(&req.query, "t").as_deref().unwrap_or(""),
        &link.token(),
    ) {
        return json_response(
            401,
            &json!({ "error": "This phone is not paired (or the code changed): scan the QR code in GeoSpaX again." }),
        );
    }
    // body for everything but uploads (those stream to disk)
    let small_body = |rd: &mut R| -> Result<Vec<u8>, Reply> {
        if req.length > MAX_BODY {
            return Err(json_response(413, &json!({ "error": "request too large" })));
        }
        let mut b = Vec::with_capacity(req.length as usize);
        rd.by_ref()
            .take(req.length)
            .read_to_end(&mut b)
            .map_err(|e| json_response(400, &json!({ "error": e.to_string() })))?;
        Ok(b)
    };
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/phone/hello") => json_response(
            200,
            &json!({ "ok": true, "link": true, "computer": computer_name(), "version": env!("CARGO_PKG_VERSION"), "max_upload_mb": MAX_UPLOAD >> 20 }),
        ),
        ("POST", "/api/phone/upload") => upload(engine, req, rd),
        ("POST", "/api/phone/commit") => match small_body(rd) {
            Ok(_) => commit(engine, &req.query),
            Err(r) => r,
        },
        // whitelisted engine routes: live positions, run status, finished maps and reports
        ("POST", "/api/devices/live") | ("GET", "/api/runs") | ("GET", "/api/devices") => {
            let body = match small_body(rd) {
                Ok(b) => b,
                Err(r) => return r,
            };
            forward(engine, req, body)
        }
        ("GET", p)
            if p.starts_with("/api/runs/")
                && (p.matches('/').count() == 3 || p.contains("/files/")) =>
        {
            forward(engine, req, Vec::new())
        }
        _ => json_response(404, &json!({ "error": "not found" })),
    }
}

fn forward(engine: &Arc<Engine>, req: &Request, body: Vec<u8>) -> Reply {
    let query = req
        .query
        .split('&')
        .filter(|kv| !kv.starts_with("t="))
        .collect::<Vec<_>>()
        .join("&");
    let resp = engine.handle(ApiRequest {
        method: req.method.clone(),
        path: req.path.clone(),
        query,
        body,
        ws: None,
    });
    (resp.status, resp.content_type, resp.headers, resp.body)
}

fn incoming_dir(engine: &Engine) -> PathBuf {
    engine.state_dir.join("phone").join("incoming")
}

fn clean_batch(b: Option<String>) -> Option<String> {
    b.filter(|b| {
        !b.is_empty()
            && b.len() <= 40
            && b.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

/// A file name that is safe on every OS: no folders, no reserved characters, not too long.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    out = out.trim().trim_start_matches('.').to_string();
    if out.is_empty() {
        out = "upload".into();
    }
    if out.chars().count() > 120 {
        let ext = Path::new(&out)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        out = format!("{}.{ext}", out.chars().take(100).collect::<String>());
    }
    out
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.into());
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{stem}-{i}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn upload<R: Read>(engine: &Arc<Engine>, req: &Request, rd: &mut R) -> Reply {
    let q = &req.query;
    if req.length == 0 {
        return json_response(411, &json!({ "error": "empty upload" }));
    }
    if req.length > MAX_UPLOAD {
        return json_response(
            413,
            &json!({ "error": format!("too big (over {} MB): videos are not mapped", MAX_UPLOAD >> 20) }),
        );
    }
    let Some(batch) = clean_batch(param(q, "batch")) else {
        return json_response(400, &json!({ "error": "bad batch id" }));
    };
    let name = clean_name(&param(q, "name").unwrap_or_default());
    let dir = incoming_dir(engine).join(&batch);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return json_response(500, &json!({ "error": e.to_string() }));
    }
    let path = unique_path(&dir, &name);
    let written = std::fs::File::create(&path)
        .and_then(|mut f| std::io::copy(&mut rd.by_ref().take(req.length), &mut f));
    match written {
        Ok(n) if n == req.length => {}
        Ok(_) | Err(_) => {
            let _ = std::fs::remove_file(&path);
            return json_response(400, &json!({ "error": "upload interrupted" }));
        }
    }
    // camera mode: the phone sent its position; use it only if the photo has none of its own
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut gps = Value::Null;
    if crate::devices::is_image(&ext) {
        if crate::devices::read_photo(&path).is_some() {
            gps = json!("photo");
        } else if let (Some(lat), Some(lon)) = (
            param(q, "lat").and_then(|v| v.parse::<f64>().ok()),
            param(q, "lon").and_then(|v| v.parse::<f64>().ok()),
        ) {
            if lat.abs() <= 90.0 && lon.abs() <= 180.0 {
                let ts = param(q, "ts")
                    .and_then(|v| v.parse::<f64>().ok())
                    .map(|ms| ms / 1000.0);
                let acc = param(q, "acc").and_then(|v| v.parse::<f64>().ok());
                if std::fs::write(sidecar_path(&path), xmp_sidecar(lat, lon, ts, acc)).is_ok() {
                    gps = json!("phone");
                }
            }
        }
    }
    json_response(
        200,
        &json!({ "ok": true, "file": path.file_name().map(|n| n.to_string_lossy().to_string()), "bytes": req.length, "gps": gps }),
    )
}

fn sidecar_path(photo: &Path) -> PathBuf {
    PathBuf::from(format!("{}.xmp", photo.display()))
}

/// XMP sidecar (Lightroom/darktable/digiKam style) with the phone's position at capture time.
pub fn xmp_sidecar(lat: f64, lon: f64, ts: Option<f64>, accuracy: Option<f64>) -> String {
    let dm = |v: f64, pos: char, neg: char| {
        let a = v.abs();
        format!(
            "{},{:.6}{}",
            a.trunc() as i64,
            (a - a.trunc()) * 60.0,
            if v < 0.0 { neg } else { pos }
        )
    };
    let time = ts
        .and_then(|t| chrono::DateTime::from_timestamp(t.floor() as i64, 0))
        .map(|d| {
            format!(
                " exif:DateTimeOriginal=\"{}\"",
                d.with_timezone(&chrono::Local)
                    .format("%Y-%m-%dT%H:%M:%S%:z")
            )
        })
        .unwrap_or_default();
    let acc = accuracy
        .map(|a| format!(" exif:GPSHPositioningError=\"{:.0}/1\"", a.max(0.0)))
        .unwrap_or_default();
    format!(
        "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\" xmlns:exif=\"http://ns.adobe.com/exif/1.0/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n   exif:GPSVersionID=\"2.3.0.0\" exif:GPSLatitude=\"{}\" exif:GPSLongitude=\"{}\"{time}{acc}\n   xmp:CreatorTool=\"GeoSpaX phone link\"/>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n",
        dm(lat, 'N', 'S'),
        dm(lon, 'E', 'W')
    )
}

/// The phone's live fixes as a GPX track with times (so photos without GPS can be placed by time).
pub fn fixes_gpx(name: &str, fixes: &[Fix]) -> String {
    let mut s = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<gpx version=\"1.1\" creator=\"GeoSpaX phone link\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n <trk><name>{}</name><trkseg>\n",
        name.replace(['<', '>', '&'], "_")
    );
    for f in fixes {
        let time = chrono::DateTime::from_timestamp_millis((f.t * 1000.0) as i64)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default();
        s.push_str(&format!(
            "  <trkpt lat=\"{:.7}\" lon=\"{:.7}\">",
            f.lat, f.lon
        ));
        if let Some(alt) = f.alt {
            s.push_str(&format!("<ele>{alt:.1}</ele>"));
        }
        s.push_str(&format!("<time>{time}</time></trkpt>\n"));
    }
    s.push_str(" </trkseg></trk>\n</gpx>\n");
    s
}

/// Where batches go: the drop folder (desktop `~/GeoSpaX/Inbox`, server `--inbox`), or `<state>/phone/From phone`,
/// which then becomes a drop folder.
fn inbox(engine: &Engine) -> Result<PathBuf, String> {
    if let Some(d) = engine.devices.inbox_dir() {
        return Ok(d);
    }
    let d = engine.state_dir.join("phone").join("From phone");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    engine.devices.add_inbox(d.clone());
    Ok(d)
}

fn commit(engine: &Arc<Engine>, query: &str) -> Reply {
    let Some(batch) = clean_batch(param(query, "batch")) else {
        return json_response(400, &json!({ "error": "bad batch id" }));
    };
    let src = incoming_dir(engine).join(&batch);
    if !src.is_dir() {
        return json_response(404, &json!({ "error": "nothing received for this batch" }));
    }
    let mut track_points = 0;
    if let Some(live) = param(query, "live").filter(|s| !s.is_empty()) {
        let fixes = engine.devices.live_fixes(&live);
        if !fixes.is_empty() {
            track_points = fixes.len();
            let _ = std::fs::write(
                src.join(format!("{}-live-track.gpx", crate::devices::slug(&live))),
                fixes_gpx("Live track (phone link)", &fixes),
            );
        }
    }
    let at = chrono::Utc::now().to_rfc3339();
    match finish_batch(engine, &src) {
        Ok((folder, files)) => json_response(
            200,
            // `at` and `inbox` let the phone find the run this batch starts (its clock may differ from ours)
            &json!({ "ok": true, "folder": folder, "files": files, "live_track_points": track_points, "at": at,
                     "inbox": inbox(engine).ok().map(|p| p.display().to_string()) }),
        ),
        Err(e) => json_response(500, &json!({ "error": e })),
    }
}

/// Move a batch into the drop folder as `Phone 2026-10-15 11.42.07` and look at it right away.
fn finish_batch(engine: &Arc<Engine>, src: &Path) -> Result<(String, usize), String> {
    let files = std::fs::read_dir(src)
        .map(|rd| rd.flatten().filter(|e| e.path().is_file()).count())
        .unwrap_or(0);
    let inbox = inbox(engine)?;
    let name = format!("Phone {}", chrono::Local::now().format("%Y-%m-%d %H.%M.%S"));
    let dst = unique_path(&inbox, &name);
    if std::fs::rename(src, &dst).is_err() {
        // different file systems (server: --state-dir and --inbox on different disks)
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            std::fs::copy(e.path(), dst.join(e.file_name())).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_dir_all(src);
    }
    engine.devices.request_rescan();
    Ok((
        dst.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        files,
    ))
}

/// Batches the phone never finished (connection lost, page closed) are committed after two quiet minutes.
fn commit_idle_batches(engine: &Arc<Engine>) {
    let Ok(rd) = std::fs::read_dir(incoming_dir(engine)) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let newest = std::fs::read_dir(&p)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|f| f.metadata().ok()?.modified().ok())
                    .max()
            })
            .ok()
            .flatten()
            .or_else(|| e.metadata().ok()?.modified().ok());
        if newest
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > BATCH_IDLE)
        {
            let has_files = std::fs::read_dir(&p)
                .map(|mut rd| rd.next().is_some())
                .unwrap_or(false);
            if has_files {
                if let Ok((folder, n)) = finish_batch(engine, &p) {
                    eprintln!("phone link: committed an unfinished batch ({n} files) as {folder}");
                }
            } else {
                let _ = std::fs::remove_dir(&p);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_batches_and_params() {
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("C:\\Users\\x\\IMG_1.JPG"), "IMG_1.JPG");
        assert_eq!(clean_name("a<b>:c?.jpg"), "a_b__c_.jpg");
        assert_eq!(clean_name(".hidden"), "hidden");
        assert_eq!(clean_name(""), "upload");
        assert!(clean_batch(Some("b-123_x".into())).is_some());
        assert!(clean_batch(Some("../x".into())).is_none());
        assert_eq!(
            param("t=abc&name=IMG%201.jpg&x", "name").as_deref(),
            Some("IMG 1.jpg")
        );
        assert_eq!(param("t=abc", "batch"), None);
    }

    #[test]
    fn phone_page_has_no_inline_script() {
        // both servers send a CSP without 'unsafe-inline' for scripts: inline code would never run
        assert!(PHONE_PAGE.contains(r#"<script src="phone.js"></script>"#));
        assert_eq!(PHONE_PAGE.matches("<script").count(), 1);
        assert!(
            PHONE_CSP.ends_with("script-src 'self'")
                && !PHONE_CSP.contains("script-src 'unsafe-inline'")
        );
        assert!(PHONE_JS.contains("watchPosition"));
    }

    #[test]
    fn pairing_code_survives_restart() {
        let dir = std::env::temp_dir().join(format!("gx-phone-code-{}", std::process::id()));
        let a = PhoneLink::new(&dir, PhoneConfig::default());
        a.save();
        let b = PhoneLink::new(&dir, PhoneConfig::default());
        assert_eq!(a.token(), b.token());
        assert_eq!(a.token().len(), 32);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_round_trip() {
        let dir = std::env::temp_dir().join(format!("gx-phone-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let photo = dir.join("IMG_0001.jpg");
        std::fs::write(&photo, b"not really a jpeg").unwrap();
        std::fs::write(
            sidecar_path(&photo),
            xmp_sidecar(-5.8721, 144.2214, Some(1_791_878_400.0), Some(4.0)),
        )
        .unwrap();
        let (p, u) = crate::devices::read_photo_full(&photo);
        let p = p.expect("placed from the sidecar");
        assert!(u.is_none());
        assert_eq!(p.placed, Some("sidecar"));
        assert!(
            (p.lat + 5.8721).abs() < 1e-6 && (p.lon - 144.2214).abs() < 1e-6,
            "{p:?}"
        );
        assert!(p.taken_at.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn gpx_of_fixes_is_read_back_with_times() {
        let fixes: Vec<Fix> = (0..5)
            .map(|i| Fix {
                lon: 144.0 + i as f64 * 0.001,
                lat: -5.8,
                t: 1_791_878_400.0 + i as f64 * 10.0,
                ..Default::default()
            })
            .collect();
        let dir = std::env::temp_dir().join(format!("gx-phone-gpx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t.gpx"), fixes_gpx("t", &fixes)).unwrap();
        let r = crate::devices::scan(&dir);
        assert_eq!(r.tracks.len(), 1);
        assert_eq!(r.timed.len(), 5, "{:?}", r.timed);
        assert_eq!(r.timed[0].0, 1_791_878_400.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
