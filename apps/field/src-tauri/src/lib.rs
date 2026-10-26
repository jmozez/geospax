//! GeoSpaX Field: the phone app. The UI (apps/field/src) does the work; this adds the plugins it needs:
//! GPS, the camera as a QR scanner (pairing with the desktop) and HTTP that accepts the desktop phone
//! link's self-signed certificate.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(mobile)]
    {
        app = app.plugin(tauri_plugin_barcode_scanner::init());
    }
    app.run(tauri::generate_context!()).expect("error while running GeoSpaX Field");
}
