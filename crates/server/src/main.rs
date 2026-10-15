//! GeoSpaX web edition: a thin Axum adapter over `engine::Engine::handle`.
//!
//!   geospax-server [--data DIR]... [--host 0.0.0.0] [--port 8080] [--web web/dist]
//!                [--no-cache] [--no-gzip] [--threads N] [--bench-log FILE]
//!                [--reader arrow|features] [--state-dir DIR]
//!                [--watch DIR]... [--auto-import] [--gps SRC]... [--mqtt URL]... [--sta URL]... [--no-device-mounts]
//!                [--recipes DIR]... [--auto ID|all]... [--no-triggers]
//!
//!   geospax-server run|check|watch|recipes|steps …   automation without the web UI
//!                                                  (docs/AUTOMATION.md §9)

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use geospax_engine::{ApiRequest, ApiResponse, Engine, EngineConfig};
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

struct Args {
    cfg: EngineConfig,
    host: String,
    port: u16,
    web: PathBuf,
    gzip: bool,
}

fn parse_args() -> Args {
    let mut a = Args {
        cfg: EngineConfig {
            data: vec![],
            devices: geospax_engine::devices::DevicesConfig { scan_mounts: true, ..Default::default() },
            automation: geospax_engine::automation::AutomationConfig { triggers: true, ..Default::default() },
            ..Default::default()
        },
        host: "0.0.0.0".into(),
        port: 8080,
        web: "web/dist".into(),
        gzip: true,
    };
    let mut it = std::env::args().skip(1);
    let mut web_given = false;
    while let Some(k) = it.next() {
        let mut v = || it.next().unwrap_or_else(|| usage_exit(&format!("missing value for {k}")));
        match k.as_str() {
            "--data" => a.cfg.data.push(v().into()),
            "--host" => a.host = v(),
            "--port" => a.port = v().parse().expect("port"),
            "--web" => {
                a.web = v().into();
                web_given = true;
            }
            "--threads" => a.cfg.threads = v().parse().expect("threads"),
            "--bench-log" => a.cfg.bench_log = Some(v().into()),
            "--no-cache" => a.cfg.cache_tiles = 0,
            "--no-gzip" => a.gzip = false,
            "--reader" => a.cfg.read_mode = v().parse().unwrap_or_else(|e| panic!("{e}")),
            "--state-dir" => a.cfg.state_dir = Some(v().into()),
            // Device and sensor hub (docs/DEVICES.md)
            "--watch" => a.cfg.devices.watch.push(v().into()),
            // drop folder: device recipes take whatever lands here, without an Auto switch
            "--inbox" => a.cfg.devices.inbox.push(v().into()),
            "--auto-import" => a.cfg.devices.auto_import = true,
            "--gps" => a.cfg.devices.gps.push(v()),
            "--mqtt" => a.cfg.devices.mqtt.push(v()),
            "--sta" => a.cfg.devices.sta.push(v()),
            "--no-device-mounts" => a.cfg.devices.scan_mounts = false,
            // Automation (docs/AUTOMATION.md)
            "--recipes" => a.cfg.automation.recipe_dirs.push(v().into()),
            "--auto" => a.cfg.automation.auto.extend(v().split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from)),
            "--no-triggers" => a.cfg.automation.triggers = false,
            "--phone" => a.cfg.phone.enable = true,
            "--phone-port" => a.cfg.phone.port = v().parse().unwrap_or_else(|_| usage_exit("--phone-port needs a number")),
            other => usage_exit(&format!("unknown argument {other}")),
        }
    }
    if a.cfg.data.is_empty() {
        a.cfg.data.push("data".into());
    }
    // Installed layouts: .deb/Docker (/usr/bin/geospax-server serves /usr/share/geospax/web) and the
    // Windows edition / portable ZIP (web\ next to geospax-server.exe)
    if !web_given && !a.web.is_dir() {
        let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|p| p.to_path_buf()));
        let candidates = exe_dir.iter().flat_map(|d| [d.join("web"), d.parent().unwrap_or(d).join("share/geospax/web")]);
        if let Some(p) = candidates.into_iter().find(|p| p.join("index.html").is_file()) {
            a.web = p;
        }
    }
    a
}

/// Every /api and /tiles request goes through the same engine router the
/// desktop app uses; the work runs on the engine's worker pool.
async fn api(State(engine): State<Arc<Engine>>, req: Request) -> Response {
    let method = req.method().to_string();
    let uri = req.uri().clone();
    let body = to_bytes(req.into_body(), 16 << 20).await.unwrap_or_default();
    let api_req = ApiRequest {
        method,
        path: uri.path().to_string(),
        query: uri.query().unwrap_or("").to_string(),
        body: body.to_vec(),
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<ApiResponse>();
    engine.dispatch(api_req, move |r| {
        let _ = tx.send(r);
    });
    let r = match rx.await {
        Ok(r) => r,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "worker dropped").into_response_body(),
    };
    let mut res = Response::builder()
        .status(r.status)
        .header(header::CONTENT_TYPE, r.content_type);
    for (k, v) in ApiResponse::common_headers() {
        res = res.header(k, v);
    }
    for (k, v) in r.headers {
        if let Ok(v) = HeaderValue::from_str(&v) {
            res = res.header(k, v);
        }
    }
    res.body(Body::from(r.body)).unwrap()
}

trait IntoResponseBody {
    fn into_response_body(self) -> Response;
}
impl IntoResponseBody for (StatusCode, &'static str) {
    fn into_response_body(self) -> Response {
        Response::builder().status(self.0).body(Body::from(self.1)).unwrap()
    }
}

const SERVER_USAGE: &str = "geospax-server: the GeoSpaX web edition (and the command line for recipes)

usage: geospax-server [options]                 serve the app at http://localhost:8080
       geospax-server run|check|watch|recipes|steps ...   recipes without a web server (see below)

options:
  --data DIR|FILE        GIS data to serve (repeatable; default ./data)
  --state-dir DIR        runs, overviews, project (default <first data dir>/.geospax)
  --host ADDR            listen address (default 0.0.0.0)    --port N   (default 8080)
  --web DIR              web UI folder (default web/dist, or the installed copy)
  --inbox DIR            drop folder: files put here are mapped by the matching recipe (repeatable)
  --watch DIR            treat a folder as a device (repeatable)
  --no-device-mounts     don't look at removable drives and phone mounts
  --gps SRC              live GNSS: serial:///dev/ttyUSB0?baud=9600, serial://COM3, tcp://host:port,
                         gpsd://host:2947, file:///log.nmea?rate=1 (repeatable)
  --mqtt URL             live sensors: mqtt://[user:pass@]host[:1883]/topic/# or mqtts://…:8883/…
                         (?ca=ca.pem, ?cert=c.pem&key=k.pem; TTN and ChirpStack uplinks are understood)
  --sta URL              OGC SensorThings service to poll: https://host/v1.1[?every=60&bbox=minlon,minlat,maxlon,maxlat]
                         (also &filter=ODATA, &max=1000; repeatable)
  --phone                start the phone link (https://<this computer>:8765, QR code in the Devices panel)
  --phone-port N         phone link port (default 8765)
  --recipes DIR          extra recipe folder (repeatable)
  --auto ID,ID           recipes whose triggers are on at start
  --no-triggers          no device/folder/schedule/sensor triggers
  --threads N · --no-cache · --no-gzip · --reader arrow|features · --bench-log FILE
  -h, --help · -V, --version

Docs: README.md, docs/USER_GUIDE.md, docs/DEVICES.md, docs/AUTOMATION.md
";

fn usage_exit(msg: &str) -> ! {
    eprintln!("error: {msg}\n\n{SERVER_USAGE}");
    std::process::exit(2)
}

fn main() {
    // `geospax-server run recipe.yaml` etc.: automation from the command line, no web server
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("-h" | "--help" | "help") => {
            println!("{SERVER_USAGE}\n{}", geospax_engine::automation::cli::usage());
            return;
        }
        Some("-V" | "--version" | "version") => {
            println!("geospax-server {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {}
    }
    if let Some(code) = geospax_engine::automation::cli::main_if_subcommand(&argv) {
        std::process::exit(code);
    }
    serve(parse_args());
}

#[tokio::main]
async fn serve(args: Args) {
    let engine = Arc::new(Engine::open(args.cfg.clone()).expect("failed to open engine"));
    engine.start_services(); // device watcher + live GNSS sources
    println!(
        "engine: {} layers, reader={}, state={}",
        engine.layers().len(),
        engine.read_mode.as_str(),
        engine.state_dir.display()
    );
    for h in engine.layers() {
        let ov = h.overview();
        let l = &h.info;
        println!(
            "  {:<34} {:<8} {:>9} features  z{}-{}  [{}]{}",
            l.id,
            format!("{:?}", l.geometry).to_lowercase(),
            l.feature_count,
            l.minzoom,
            l.maxzoom,
            l.driver,
            ov.map(|o| format!("  overview z0-{} ({} tiles)", o.meta.max_zoom, o.meta.tiles)).unwrap_or_default()
        );
    }
    for w in &engine.warnings {
        eprintln!("warning: {w}");
    }
    let index = args.web.join("index.html");
    let static_files = ServeDir::new(&args.web).fallback(ServeFile::new(index));
    let mut app = Router::new()
        .route("/api/{*rest}", any(api))
        .route("/tiles/{*rest}", any(api))
        .with_state(engine)
        .fallback_service(static_files);
    if args.gzip {
        // Gzip vector tiles and JSON, but not Arrow: float64 coordinates barely
        // compress (measured: -13% size for +80% time on 1M points).
        let predicate = DefaultPredicate::new().and(NotForContentType::new("application/vnd.apache.arrow.stream"));
        app = app.layer(CompressionLayer::new().compress_when(predicate));
    }
    let addr = format!("{}:{}", args.host, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("web edition listening on http://{addr}  (static: {})", args.web.display());
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
