//! Per-computer workspaces with no server and no sign-in (docs/USER_GUIDE.md "Workspaces").
//!
//! Each pair of computer and OS user account gets its own workspace folder holding its projects, recent
//! list, settings, recipes and workflows, cache, plugin state and audit log. The pair is identified by the
//! operating system's machine ID (`/etc/machine-id` on Linux, `MachineGuid` on Windows; the Android field
//! app uses `ANDROID_ID`) and the account name, hashed together with SHA-256. Neither raw value is stored:
//! a MAC or IP address is never used, because IP addresses change and MAC addresses can be randomised.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Folders in a workspace that only hold what can be made again (cleared by Clear cache).
pub const CACHE_DIRS: &[&str] = &["overviews", "preview", "outputs", "plugin-results", "samples", "downloads", "cache"];
/// Tool groups a workspace can switch off (Workspace › Tools).
pub const TOOL_GROUPS: &[&str] = &["edit", "design", "analysis", "automate", "ai", "devices", "online", "plugins", "export"];
/// What Restricted mode hides.
pub const RESTRICTED_HIDES: &[&str] = &["edit", "design", "delete", "export"];

/// The workspace id for a machine ID and an account name: SHA-256 of both, hex.
pub fn workspace_id(machine_id: &str, user: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"geospax-workspace\0");
    h.update(machine_id.trim().as_bytes());
    h.update(b"\0");
    h.update(user.trim().as_bytes());
    hex(&h.finalize())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The operating system's machine ID, or None when the OS gives none.
pub fn machine_id() -> Option<String> {
    if let Ok(v) = std::env::var("GEOSPAX_MACHINE_ID") {
        return Some(v); // tests, and images that clone a machine ID
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        return s.lines().find(|l| l.contains("MachineGuid")).and_then(|l| l.split_whitespace().last()).map(String::from);
    }
    #[cfg(not(target_os = "windows"))]
    {
        ["/etc/machine-id", "/var/lib/dbus/machine-id"]
            .iter()
            .find_map(|p| fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    }
}

/// The OS user account running GeoSpaX.
pub fn os_user() -> String {
    ["USER", "LOGNAME", "USERNAME"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "user".into())
}

/// The workspace folder for this computer and account under `base` (created, and filled once from an
/// older single state folder so nothing is lost on upgrade). Returns (id, folder).
pub fn resolve(base: &Path) -> (String, PathBuf) {
    let machine = machine_id().unwrap_or_else(|| {
        // no OS machine ID: a random one kept beside the workspaces, so the id stays stable
        let p = base.join("workspaces").join(".machine");
        fs::read_to_string(&p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| {
            let mut b = [0u8; 16];
            let _ = getrandom_fill(&mut b);
            let v = hex(&b);
            let _ = fs::create_dir_all(p.parent().unwrap());
            let _ = fs::write(&p, &v);
            v
        })
    });
    let id = workspace_id(&machine, &os_user());
    let dir = base.join("workspaces").join(&id[..16]);
    let fresh = !dir.exists();
    let _ = fs::create_dir_all(&dir);
    if fresh {
        migrate(base, &dir);
        audit(&dir, "workspace created", json!({}));
    }
    let meta = dir.join("workspace.json");
    if !meta.exists() {
        let _ = fs::write(&meta, serde_json::to_vec_pretty(&json!({ "id": id, "created": now() })).unwrap_or_default());
    }
    (id, dir)
}

pub(crate) fn getrandom_fill(b: &mut [u8]) -> std::io::Result<()> {
    getrandom::getrandom(b).map_err(|e| std::io::Error::other(e.to_string()))
}

/// An older GeoSpaX kept one state folder: the first workspace made on this computer starts with its
/// projects, settings, recipes and plugins (copied; the old folder is left as it was).
fn migrate(base: &Path, dir: &Path) {
    let others = fs::read_dir(base.join("workspaces")).map(|r| r.flatten().filter(|e| e.path().is_dir() && e.path() != dir).count()).unwrap_or(0);
    if others > 0 {
        return;
    }
    for name in ["projects", "recipes", "plugins", "databases", "automation.json", "raster-styles.json", "names.json", "project.json"] {
        let from = base.join(name);
        if from.exists() {
            let _ = copy_all(&from, &dir.join(name));
        }
    }
}

fn copy_all(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)?.flatten() {
            copy_all(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Append a line to the workspace's audit log (audit.log, JSON lines).
pub fn audit(dir: &Path, what: &str, detail: Value) {
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("audit.log")) {
        let _ = writeln!(f, "{}", json!({ "t": now(), "what": what, "detail": detail }));
    }
}

pub fn dir_size(dir: &Path) -> u64 {
    match fs::metadata(dir) {
        Ok(m) if m.is_file() => m.len(),
        Ok(_) => fs::read_dir(dir).map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0),
        Err(_) => 0,
    }
}

/// Storage use by part of the workspace, in bytes.
pub fn storage(dir: &Path) -> Value {
    let cache: u64 = CACHE_DIRS.iter().map(|d| dir_size(&dir.join(d))).sum();
    let projects = dir_size(&dir.join("projects")) + dir_size(&dir.join("project.json"));
    let workflows = dir_size(&dir.join("recipes")) + dir_size(&dir.join("runs"));
    let plugins = dir_size(&dir.join("plugins"));
    // other profiles' folders (profiles.rs) are theirs, not this one's
    let total = dir_size(dir).saturating_sub(dir_size(&dir.join("profiles")));
    json!({ "total": total, "cache": cache, "projects": projects, "workflows": workflows, "plugins": plugins,
            "other": total.saturating_sub(cache + projects + workflows + plugins) })
}

/// Clear cache: delete the folders that only hold what GeoSpaX can make again. Returns bytes freed.
pub fn clear_cache(dir: &Path) -> u64 {
    let mut freed = 0;
    for d in CACHE_DIRS {
        let p = dir.join(d);
        freed += dir_size(&p);
        let _ = fs::remove_dir_all(&p);
    }
    audit(dir, "cache cleared", json!({ "bytes": freed }));
    freed
}

/// Saved workflows (recipes kept in the workspace).
pub fn workflows(dir: &Path) -> Vec<Value> {
    let mut v: Vec<Value> = fs::read_dir(dir.join("recipes"))
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "yaml" || x == "yml"))
                .map(|e| json!({ "id": e.path().file_stem().unwrap_or_default().to_string_lossy(), "bytes": dir_size(&e.path()) }))
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    v
}

// ------------------------------------------------------------------ tool settings and Restricted mode

/// Workspace › Tools: groups and plugins switched off, Restricted mode and its PIN (salted PBKDF2-HMAC-SHA256).
pub fn settings(dir: &Path) -> Value {
    fs::read(dir.join("tools.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}

/// What the UI sees: never the PIN hash.
pub fn public_settings(dir: &Path) -> Value {
    let s = settings(dir);
    let restricted = s["restricted"].as_bool().unwrap_or(false);
    json!({
        "groups": TOOL_GROUPS,
        "disabledGroups": s["disabledGroups"].as_array().cloned().unwrap_or_default(),
        "disabledPlugins": s["disabledPlugins"].as_array().cloned().unwrap_or_default(),
        "restricted": restricted,
        "hides": if restricted { json!(RESTRICTED_HIDES) } else { json!([]) },
        "pinSet": s["pinHash"].is_string(),
    })
}

pub(crate) fn pin_hash(salt: &str, pin: &str) -> String {
    hex(&pbkdf2_sha256(pin.as_bytes(), salt.as_bytes(), PBKDF2_ROUNDS))
}

fn pin_ok(pin: &str) -> bool {
    (4..=12).contains(&pin.len()) && pin.chars().all(|c| c.is_ascii_digit())
}

/// Change the tool groups and plugins switched off. Refused in Restricted mode.
pub fn save_tools(dir: &Path, body: &Value) -> Result<Value, String> {
    let mut s = settings(dir);
    if s["restricted"].as_bool().unwrap_or(false) {
        return Err("Restricted mode is on: turn it off with the PIN to change the tools".into());
    }
    let list = |k: &str| -> Value {
        json!(body[k].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).map(String::from).collect::<Vec<_>>()).unwrap_or_default())
    };
    s["disabledGroups"] = list("disabledGroups");
    s["disabledPlugins"] = list("disabledPlugins");
    write_settings(dir, &s)?;
    audit(dir, "tools changed", json!({ "disabledGroups": s["disabledGroups"], "disabledPlugins": s["disabledPlugins"] }));
    Ok(public_settings(dir))
}

/// Turn Restricted mode on or off. Turning it on sets the PIN the first time; turning it off needs it.
pub fn set_restricted(dir: &Path, on: bool, pin: &str) -> Result<Value, String> {
    let mut s = settings(dir);
    if !pin_ok(pin) {
        return Err("the PIN is 4 to 12 digits".into());
    }
    let salt = s["pinSalt"].as_str().map(String::from).unwrap_or_else(|| {
        let mut b = [0u8; 16];
        let _ = getrandom_fill(&mut b);
        hex(&b)
    });
    match s["pinHash"].as_str() {
        Some(h) if h != pin_hash(&salt, pin) => {
            audit(dir, "wrong PIN", json!({ "restricted": on }));
            return Err("wrong PIN".into());
        }
        Some(_) => {}
        None if !on => return Err("Restricted mode has no PIN yet".into()),
        None => {
            s["pinSalt"] = json!(salt);
            s["pinHash"] = json!(pin_hash(&salt, pin));
        }
    }
    s["restricted"] = json!(on);
    write_settings(dir, &s)?;
    audit(dir, if on { "restricted mode on" } else { "restricted mode off" }, json!({}));
    Ok(public_settings(dir))
}

pub fn is_restricted(dir: &Path) -> bool {
    settings(dir)["restricted"].as_bool().unwrap_or(false)
}

fn write_settings(dir: &Path, s: &Value) -> Result<(), String> {
    fs::write(dir.join("tools.json"), serde_json::to_vec_pretty(s).unwrap_or_default()).map_err(|e| format!("could not save the tool settings: {e}"))
}

// ------------------------------------------------------------------ backup

/// Export the workspace as a zip (everything but the cache and other profiles).
pub fn export_zip(dir: &Path) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
                let p = e.path();
                let rel = p.strip_prefix(dir).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                let top = rel.split('/').next().unwrap_or("");
                if CACHE_DIRS.contains(&top) || top == "profiles" || rel == "profiles.json" {
                    continue;
                }
                if p.is_dir() {
                    stack.push(p);
                } else {
                    z.start_file(rel, opt).map_err(|e| e.to_string())?;
                    z.write_all(&fs::read(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                }
            }
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    audit(dir, "workspace exported", json!({ "bytes": buf.get_ref().len() }));
    Ok(buf.into_inner())
}

/// Import a backup made by export_zip: its files are written into this workspace (same names replaced).
/// The workspace's own id file and the PIN settings stay as they are.
pub fn import_zip(dir: &Path, bytes: &[u8]) -> Result<usize, String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("not a GeoSpaX workspace backup: {e}"))?;
    let mut n = 0;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { continue };
        if f.is_dir() || rel.starts_with("profiles") || matches!(rel.to_str(), Some("workspace.json" | "tools.json" | "audit.log" | "profiles.json")) {
            continue;
        }
        let to = dir.join(&rel);
        if let Some(p) = to.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut b = Vec::new();
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        fs::write(&to, b).map_err(|e| e.to_string())?;
        n += 1;
    }
    audit(dir, "workspace imported", json!({ "files": n }));
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_differ_by_user_and_machine_and_hide_both() {
        let a = workspace_id("4c1f0d0e9b", "alice");
        let b = workspace_id("4c1f0d0e9b", "bob");
        let c = workspace_id("77aa", "alice");
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, workspace_id("4c1f0d0e9b\n", "alice"), "stable across reads");
        assert!(!a.contains("alice") && !a.contains("4c1f0d0e9b"));
    }

    #[test]
    fn restricted_mode_needs_the_pin() {
        let d = std::env::temp_dir().join(format!("gx-ws-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        assert!(set_restricted(&d, true, "12").is_err());
        assert_eq!(set_restricted(&d, true, "2468").unwrap()["restricted"], true);
        assert!(is_restricted(&d));
        assert!(save_tools(&d, &json!({ "disabledGroups": ["ai"] })).is_err());
        assert!(set_restricted(&d, false, "1111").is_err());
        assert_eq!(set_restricted(&d, false, "2468").unwrap()["restricted"], false);
        assert_eq!(save_tools(&d, &json!({ "disabledGroups": ["ai"] })).unwrap()["disabledGroups"][0], "ai");
        let raw = fs::read_to_string(d.join("tools.json")).unwrap();
        assert!(!raw.contains("2468"), "the PIN is stored hashed");
        assert!(!public_settings(&d).to_string().contains("pinHash"));
        let log = fs::read_to_string(d.join("audit.log")).unwrap();
        assert!(log.contains("wrong PIN") && log.contains("restricted mode on"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn backup_round_trip_leaves_out_the_cache() {
        let d = std::env::temp_dir().join(format!("gx-wsb-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("projects")).unwrap();
        fs::create_dir_all(d.join("overviews")).unwrap();
        fs::write(d.join("projects/lae.json"), b"{}").unwrap();
        fs::write(d.join("overviews/x.bin"), vec![0u8; 1000]).unwrap();
        let zip = export_zip(&d).unwrap();
        let e = d.with_extension("restore");
        let _ = fs::remove_dir_all(&e);
        fs::create_dir_all(&e).unwrap();
        assert_eq!(import_zip(&e, &zip).unwrap(), 1);
        assert!(e.join("projects/lae.json").is_file() && !e.join("overviews").exists());
        assert!(clear_cache(&d) >= 1000 && !d.join("overviews").exists());
        let _ = (fs::remove_dir_all(&d), fs::remove_dir_all(&e));
    }
}

/// PBKDF2 rounds for PINs. A PIN is short, so this slows guessing; it does not make a PIN a password.
pub const PBKDF2_ROUNDS: u32 = 100_000;

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut i = Sha256::new();
    i.update(k.iter().map(|b| b ^ 0x36).collect::<Vec<_>>());
    i.update(msg);
    let mut o = Sha256::new();
    o.update(k.iter().map(|b| b ^ 0x5c).collect::<Vec<_>>());
    o.update(i.finalize());
    o.finalize().into()
}

/// PBKDF2-HMAC-SHA256 with one 32-byte block (RFC 8018).
pub fn pbkdf2_sha256(pw: &[u8], salt: &[u8], rounds: u32) -> [u8; 32] {
    let mut m = salt.to_vec();
    m.extend_from_slice(&1u32.to_be_bytes());
    let mut u = hmac_sha256(pw, &m);
    let mut t = u;
    for _ in 1..rounds {
        u = hmac_sha256(pw, &u);
        for (a, b) in t.iter_mut().zip(u.iter()) {
            *a ^= b;
        }
    }
    t
}

#[cfg(test)]
mod pbkdf2_tests {
    #[test]
    fn rfc7914_vector() {
        // RFC 7914 section 11: PBKDF2-HMAC-SHA256("passwd", "salt", 1)
        let d = super::pbkdf2_sha256(b"passwd", b"salt", 1);
        assert_eq!(super::hex(&d[..8]), "55ac046e56e3089f");
    }
}
