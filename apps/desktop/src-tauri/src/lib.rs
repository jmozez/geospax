//! GeoSpaX desktop edition: a thin Tauri 2 adapter over the same engine the web
//! server uses. Two tile transports, selectable in the UI:
//!   * `gis://` custom URI scheme  -> `Engine::handle` (same router as HTTP)
//!   * `invoke("tile")`            -> raw bytes via `tauri::ipc::Response`
//! All GDAL work runs on the engine's worker pool, never on the UI thread.

use geospax_engine::{ApiRequest, ApiResponse, Engine, EngineConfig};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::http::Response;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Data sources: CLI args, else GEOSPAX_DATA (OS path list), else ./data when it exists (source
/// checkout). None means "installed app started from the menu": use the home layout below.
fn data_paths() -> Option<Vec<PathBuf>> {
    let args: Vec<PathBuf> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from).collect();
    if !args.is_empty() {
        return Some(args);
    }
    if let Some(v) = std::env::var_os("GEOSPAX_DATA") {
        return Some(std::env::split_paths(&v).collect());
    }
    let dev = PathBuf::from("data");
    dev.is_dir().then(|| vec![dev])
}

/// Installed-app defaults: everything lives in one visible folder, `~/GeoSpaX`.
///   Data/      GIS layers (GeoPackage, Shapefile, GeoTIFF, ...) -> the layer list
///   Inbox/     photos, GPS tracks, drone logs, sensor logs -> a drop folder: the matching device
///              recipe turns whatever lands here into a finished map (no Auto switch needed)
///   .geospax/  state: recipe runs (maps, reports, PDFs), overviews, project
struct HomeLayout {
    data: PathBuf,
    inbox: PathBuf,
    state: PathBuf,
}

fn home_layout() -> Option<HomeLayout> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)?;
    let root = home.join("GeoSpaX");
    let l = HomeLayout { data: root.join("Data"), inbox: root.join("Inbox"), state: root.join(".geospax") };
    for d in [&l.data, &l.inbox, &l.state] {
        std::fs::create_dir_all(d).ok()?;
    }
    let readme = root.join("README.txt");
    if !readme.exists() {
        let _ = std::fs::write(&readme, HOME_README);
    }
    Some(l)
}

const HOME_README: &str = "GeoSpaX folder\n\
==============\n\
\n\
Inbox/  Drop photos, GPS tracks (GPX/KML/NMEA), drone logs or sensor logs (CSV/FIT) here\n\
        and the matching recipe makes the map for you, no switches needed.\n\
        Plugged-in phones, GPS units, cameras and loggers are listed in the app: map them\n\
        with one click, or turn on a recipe's Auto switch to have them mapped on plug-in.\n\
Data/   Put GIS layers here (GeoPackage, Shapefile, GeoJSON, GeoTIFF, ...). They appear in\n\
        the layer list the next time GeoSpaX starts.\n\
\n\
Finished maps, reports and PDFs show up in the app's Automate section and are stored\n\
under .geospax/runs/. Turn recipes on or off with their Auto switch there.\n";


#[tauri::command]
async fn tile(
    engine: tauri::State<'_, Arc<Engine>>,
    layer: String,
    z: u8,
    x: u32,
    y: u32,
    fields: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let engine = engine.inner().clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let e = engine.clone();
    engine.spawn(move || {
        let _ = tx.send(e.tile(&layer, z, x, y, fields.as_deref()).map(|(t, _)| t.bytes.clone()));
    });
    let bytes = rx.await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// An update found by `update_check`, kept until `update_install` downloads it.
#[derive(Default)]
struct PendingUpdate(std::sync::Mutex<Option<Update>>);

/// How this copy is updated: "installer" (Windows, installed with the setup program: the update is
/// downloaded, its signature checked and installed in place) or "notice" (the .deb, the portable ZIP:
/// the app only says a new version is out and links to it).
#[tauri::command]
fn update_kind() -> &'static str {
    let installed = geospax_engine::exe_dir().is_some_and(|d| d.join("uninstall.exe").is_file());
    if cfg!(windows) && installed { "installer" } else { "notice" }
}

/// Ask the release feed for a newer version; returns its version, notes and date, or null.
#[tauri::command]
async fn update_check(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<Option<serde_json::Value>, String> {
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|u| serde_json::json!({ "version": u.version, "notes": u.body, "date": u.date.map(|d| d.to_string()) }));
    *pending.0.lock().unwrap() = found;
    Ok(info)
}

/// Download the update found by `update_check` (progress as "update-progress" events), check its
/// signature, run the installer and restart into the new version.
#[tauri::command]
async fn update_install(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update to install: check again")?;
    let (events, mut done) = (app.clone(), 0u64);
    update
        .download_and_install(
            move |n, total| {
                done += n as u64;
                let _ = events.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `geospax run recipe.yaml`, `geospax watch`, … (docs/AUTOMATION.md §9): no window
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("-h" | "--help") => {
            println!("geospax: the GeoSpaX desktop app\n\nusage: geospax [DATA_DIR|FILE]...   open the app (default: ~/GeoSpaX)\n       geospax run|check|watch|recipes|steps ...   recipes without a window\n\n{}", geospax_engine::automation::cli::usage());
            return;
        }
        Some("-V" | "--version") => {
            println!("geospax {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {}
    }
    if let Some(code) = geospax_engine::automation::cli::main_if_subcommand(&argv) {
        std::process::exit(code);
    }
    let watch: Vec<PathBuf> = std::env::var_os("GEOSPAX_WATCH").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default();
    let auto: Vec<String> = std::env::var("GEOSPAX_AUTO").map(|v| v.split(',').filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default();
    let mut inbox: Vec<PathBuf> = Vec::new();
    // Overviews + project file; default <first data dir>/.geospax (home layout: ~/GeoSpaX/.geospax)
    let mut state_dir = std::env::var_os("GEOSPAX_STATE").map(PathBuf::from);
    let data = match data_paths() {
        Some(d) => d,
        None => match home_layout() {
            Some(h) => {
                eprintln!("data: {} (drop folder {})", h.data.display(), h.inbox.display());
                // a drop folder: whatever lands here is mapped by the matching device recipe
                // (plugged-in devices still wait for Auto or a click, docs/DEVICES.md §5)
                inbox.push(h.inbox);
                state_dir.get_or_insert(h.state);
                vec![h.data]
            }
            None => vec![PathBuf::from("data")],
        },
    };
    let cfg = EngineConfig {
        data,
        // Benchmark reports posted by the UI are appended here (JSONL).
        bench_log: std::env::var_os("GEOSPAX_BENCH_LOG").map(PathBuf::from),
        state_dir,
        // Device and sensor hub (docs/DEVICES.md): removable/phone mounts are always watched.
        devices: geospax_engine::devices::DevicesConfig {
            watch,
            auto_import: std::env::var("GEOSPAX_AUTO_IMPORT").map(|v| v == "1").unwrap_or(false),
            gps: std::env::var("GEOSPAX_GPS").map(|v| v.split(',').filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default(),
            mqtt: std::env::var("GEOSPAX_MQTT").map(|v| v.split(',').filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default(),
            sta: std::env::var("GEOSPAX_STA").map(|v| v.split(',').filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default(),
            scan_mounts: true,
            inbox,
        },
        // Recipes and triggers (docs/AUTOMATION.md): GEOSPAX_RECIPES (path list), GEOSPAX_AUTO (ids or "all").
        automation: geospax_engine::automation::AutomationConfig {
            recipe_dirs: std::env::var_os("GEOSPAX_RECIPES").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default(),
            auto,
            triggers: true,
        },
        // Phone link: switched on from the Devices panel (remembered); GEOSPAX_PHONE=1 / GEOSPAX_PHONE_PORT for tests
        phone: geospax_engine::phone::PhoneConfig {
            enable: std::env::var("GEOSPAX_PHONE").map(|v| v == "1").unwrap_or(false),
            port: std::env::var("GEOSPAX_PHONE_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(geospax_engine::phone::DEFAULT_PORT),
        },
        ..Default::default()
    };
    let engine = Arc::new(Engine::open(cfg).expect("failed to open engine"));
    eprintln!("engine: {} layers", engine.layers().len());
    engine.start_services();
    for w in &engine.warnings {
        eprintln!("warning: {w}");
    }
    let proto_engine = engine.clone();

    tauri::Builder::default()
        .manage(engine)
        .manage(PendingUpdate::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![tile, update_kind, update_check, update_install])
        .setup(|app| {
            // Headless automation: GEOSPAX_URL_QUERY="bench=1&transport=invoke"
            // reloads the UI with that query (auto-runs the camera-tour benchmark).
            if let (Ok(q), Some(w)) = (std::env::var("GEOSPAX_URL_QUERY"), app.get_webview_window("main")) {
                let mut url = w.url()?;
                url.set_query(Some(&q));
                w.navigate(url)?;
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("gis", move |_ctx, request, responder| {
            let req = ApiRequest {
                method: request.method().to_string(),
                path: request.uri().path().to_string(),
                query: request.uri().query().unwrap_or("").to_string(),
                body: request.body().clone(),
            };
            proto_engine.dispatch(req, move |r| {
                let mut b = Response::builder().status(r.status).header("Content-Type", r.content_type);
                for (k, v) in ApiResponse::common_headers() {
                    b = b.header(k, v);
                }
                for (k, v) in r.headers {
                    b = b.header(k, v);
                }
                responder.respond(b.body(r.body).expect("valid response"));
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running the desktop edition");
}
