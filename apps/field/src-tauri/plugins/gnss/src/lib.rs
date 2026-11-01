//! NMEA from a Bluetooth GNSS receiver on Android. The Android web view has no Web Bluetooth, so the
//! Kotlin plugin (android/src/main/java/GnssPlugin.kt) lists paired and nearby receivers, connects over
//! Bluetooth Classic (the serial port profile) or Bluetooth LE (a Nordic UART or HM-10 serial service)
//! and streams the receiver's text to the web view, where the same NMEA parser as in the browser reads it.
//! Nothing here on other platforms: the commands are only forwarded to the Kotlin plugin.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gnss")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("app.geospax.gnss", "GnssPlugin")?;
            Ok(())
        })
        .build()
}
