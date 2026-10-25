// Prevents an extra console window on Windows in release builds (desktop test runs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    geospax_field_lib::run()
}
