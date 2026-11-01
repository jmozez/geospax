//! GeoSpaX Field: the phone app. The UI (apps/field/src) does the work; this adds the plugins it needs:
//! GPS, the camera as a QR scanner (pairing with the desktop) and HTTP that accepts the desktop phone
//! link's self-signed certificate, the barometer for heights and Bluetooth GNSS receivers (plugins/gnss).

mod barometer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![barometer::barometer_hpa]);
    #[cfg(mobile)]
    {
        app = app.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_gnss::init());
    }
    app.run(tauri::generate_context!()).expect("error while running GeoSpaX Field");
}
