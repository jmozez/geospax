//! GeoSpaX web edition: a thin Axum adapter over `engine::Engine::handle`.
//!
//!   geospax-server [--data DIR]... [--host 127.0.0.1] [--port 8080] [--token T] [--web web/dist]
//!                [--no-cache] [--no-gzip] [--threads N] [--bench-log FILE]
//!                [--reader arrow|features] [--state-dir DIR]
//!                [--watch DIR]... [--auto-import] [--gps SRC]... [--mqtt URL]... [--sta URL]... [--no-device-mounts]
//!                [--recipes DIR]... [--auto ID|all]... [--no-triggers]
//!
//!   geospax-server run|check|watch|recipes|steps …   automation without the web UI
//!                                                  (docs/AUTOMATION.md §9)

mod auth;

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
    token: Option<String>,
}

fn parse_args() -> Args {
    parse_args_from(std::env::args().skip(1).collect())
}

fn parse_args_from(argv: Vec<String>) -> Args {
    let mut a = Args {
        cfg: EngineConfig {
            data: vec![],
            devices: geospax_engine::devices::DevicesConfig { scan_mounts: true, ..Default::default() },
            automation: geospax_engine::automation::AutomationConfig { triggers: true, ..Default::default() },
            ..Default::default()
        },
        host: "127.0.0.1".into(),
        port: 8080,
        web: "web/dist".into(),
        gzip: true,
        token: std::env::var("GEOSPAX_TOKEN").ok().filter(|t| !t.is_empty()),
    };
    let mut it = argv.into_iter();
    let mut web_given = false;
    while let Some(k) = it.next() {
        let mut v = || it.next().unwrap_or_else(|| usage_exit(&format!("missing value for {k}")));
        match k.as_str() {
            "--data" => a.cfg.data.push(v().into()),
            "--host" => a.host = v(),
            "--token" => a.token = Some(v()),
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
            "--plugins" => a.cfg.plugins.dirs.push(v().into()),
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
    // files dropped on the app may be large (GeoPackages, zipped shapefiles); everything else is small
    let limit = if uri.path() == "/api/upload" { 1 << 30 } else { 16 << 20 };
    let body = to_bytes(req.into_body(), limit).await.unwrap_or_default();
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
       geospax-server mcp [--data DIR] [--state-dir DIR]  GeoSpaX's tools for AI assistants (MCP over stdio)

options:
  --data DIR|FILE        GIS data to serve (repeatable; default ./data)
  --state-dir DIR        runs, overviews, project (default <first data dir>/.geospax)
  --host ADDR            listen address (default 127.0.0.1: this computer only)    --port N   (default 8080)
                         Any other address (e.g. 0.0.0.0) requires an access token; one is generated and
                         printed as a login link unless given
  --token T              access token for the API (or GEOSPAX_TOKEN); required by every client
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
  --plugins DIR          extra plugin folder (repeatable; <state>/plugins is always read)
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


/// `geospax-server mcp …`: the assistant's tools for MCP clients (Claude Desktop, Claude Code, editors).
/// stdout carries only MCP messages; everything else goes to stderr. No devices, triggers or web server.
fn mcp(argv: Vec<String>) -> i32 {
    let mut a = parse_args_from(argv);
    a.cfg.devices.scan_mounts = false;
    a.cfg.automation.triggers = false;
    let engine = match Engine::open(a.cfg) {
        Ok(e) => Arc::new(e),
        Err(e) => {
            eprintln!("geospax mcp: {e}");
            return 1;
        }
    };
    eprintln!("geospax mcp: {} layers, {} rasters; waiting for an MCP client on stdin", engine.layers().len(), engine.rasters().len());
    let stdin = std::io::stdin();
    match geospax_engine::ai::mcp_serve(&engine, stdin.lock(), std::io::stdout().lock()) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("geospax mcp: {e}");
            1
        }
    }
}

/// `geospax-server plugins …` — list, check and install plugins without opening a map.
fn plugins_cli(args: &[String]) -> i32 {
    use geospax_engine::plugins;
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                i += 1;
                if let Some(v) = args.get(i) {
                    dirs.push(v.into());
                }
            }
            other => rest.push(other.to_string()),
        }
        i += 1;
    }
    if dirs.is_empty() {
        dirs.push(std::path::PathBuf::from("data/.geospax/plugins"));
    }
    match rest.first().map(String::as_str).unwrap_or("list") {
        "list" => {
            let p = plugins::Plugins::new(dirs);
            let list = p.list();
            if list.is_empty() {
                println!("no plugins installed (plugin folders: {})", p.dirs().iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", "));
                return 0;
            }
            for info in &list {
                let state = if info.runnable {
                    "runnable".to_string()
                } else {
                    format!("needs {}", info.needs.clone().unwrap_or_default())
                };
                println!(
                    "{:<22} {:<9} {:<8} {:>2} tool(s)  {}{}",
                    info.name,
                    info.source,
                    info.kind,
                    info.tools.len(),
                    state,
                    info.warning.as_ref().map(|w| format!("  ⚠ {w}")).unwrap_or_default(),
                );
            }
            0
        }
        "check" => {
            let path = match rest.get(1) {
                Some(p) => std::path::Path::new(p),
                None => {
                    eprintln!("usage: geospax-server plugins check PATH");
                    return 2;
                }
            };
            match plugins::check(path) {
                Ok(s) => {
                    println!("ok  {s}");
                    0
                }
                Err(e) => {
                    eprintln!("bad {e}");
                    1
                }
            }
        }
        "import" => {
            let path = match rest.get(1) {
                Some(p) => std::path::Path::new(p),
                None => {
                    eprintln!("usage: geospax-server plugins import PATH [--dir PLUGINDIR]");
                    return 2;
                }
            };
            let p = plugins::Plugins::new(dirs);
            match p.install(path) {
                Ok(info) => {
                    println!(
                        "installed {} {} ({} tool(s)) into {}",
                        info.name,
                        info.version.as_deref().unwrap_or("?"),
                        info.tools.len(),
                        info.path
                    );
                    0
                }
                Err(e) => {
                    eprintln!("import failed: {e}");
                    1
                }
            }
        }
        "uninstall" => {
            let id = match rest.get(1) {
                Some(p) => p.as_str(),
                None => {
                    eprintln!("usage: geospax-server plugins uninstall ID [--dir PLUGINDIR]");
                    return 2;
                }
            };
            let p = plugins::Plugins::new(dirs);
            match p.uninstall(id) {
                Ok(msg) => {
                    println!("{msg}");
                    0
                }
                Err(e) => {
                    eprintln!("uninstall failed: {e}");
                    1
                }
            }
        }
        other => {
            eprintln!("unknown plugins command '{other}' (try: list, check PATH, import PATH, uninstall ID)");
            2
        }
    }
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
    if argv.first().map(String::as_str) == Some("mcp") {
        std::process::exit(mcp(argv[1..].to_vec()));
    }
    if argv.first().map(String::as_str) == Some("plugins") {
        std::process::exit(plugins_cli(&argv[1..]));
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
    // Beyond this computer, the API needs a token: it can run recipe code and install plugins
    let token = args.token.clone().or_else(|| (!auth::is_loopback(&args.host)).then(auth::new_token));
    let auth = Arc::new(auth::Auth { token: token.clone() });
    let mut app = Router::new()
        .route("/api/{*rest}", any(api))
        .route("/tiles/{*rest}", any(api))
        .with_state(engine)
        .fallback_service(static_files)
        .layer(axum::middleware::from_fn_with_state(auth, auth::middleware));
    if args.gzip {
        // Gzip vector tiles and JSON, but not Arrow: float64 coordinates barely
        // compress (measured: -13% size for +80% time on 1M points).
        let predicate = DefaultPredicate::new().and(NotForContentType::new("application/vnd.apache.arrow.stream"));
        app = app.layer(CompressionLayer::new().compress_when(predicate));
    }
    let addr = format!("{}:{}", args.host, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("web edition listening on http://{addr}  (static: {})", args.web.display());
    match &token {
        Some(t) => {
            let shown = if auth::is_loopback(&args.host) || args.host == "0.0.0.0" || args.host == "::" { "localhost".to_string() } else { args.host.clone() };
            println!("open http://{shown}:{}/?token={t}  (the API refuses requests without this token)", args.port);
        }
        None => println!("open http://localhost:{}  (only this computer can connect)", args.port),
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
