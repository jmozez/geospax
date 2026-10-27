//! Windows version info for geospax-server.exe (Properties › Details: company, product, version), the same
//! publisher and copyright as the desktop app (bundle.publisher / bundle.copyright in
//! apps/desktop/src-tauri/tauri.conf.json, which tauri-build puts into geospax.exe). Other targets: nothing.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let conf_path = root.join("apps/desktop/src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf_path.display());
    let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&conf_path).expect("tauri.conf.json"))
        .expect("tauri.conf.json is JSON");
    let field = |k: &str| conf["bundle"][k].as_str().unwrap_or_else(|| panic!("bundle.{k} missing in tauri.conf.json")).to_string();
    let (publisher, copyright) = (field("publisher"), field("copyright"));
    let mut res = tauri_winres::WindowsResource::new();
    res.set("CompanyName", &publisher)
        .set("LegalCopyright", &copyright)
        .set("ProductName", "GeoSpaX")
        .set("FileDescription", "GeoSpaX web server and command line")
        .set("OriginalFilename", "geospax-server.exe");
    let icon = root.join("apps/desktop/src-tauri/icons/icon.ico");
    if icon.exists() {
        res.set_icon(icon.to_str().expect("icon path"));
    }
    res.compile().expect("Windows resource for geospax-server.exe");
}
