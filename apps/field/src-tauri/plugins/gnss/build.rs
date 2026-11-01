// The commands the web view may call (each becomes an allow-* permission); they are carried out by the
// Kotlin plugin in android/.
const COMMANDS: &[&str] = &["devices", "connect", "disconnect", "check_permissions", "request_permissions"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
