//! Local profiles: several people sharing one OS login (docs/USER_GUIDE.md "Profiles").
//!
//! Profiles live inside the workspace for this computer and OS account (workspace.rs). Each has its own
//! folder (projects, recent list, settings, workflows, plugins and cache). The first profile made is the
//! admin and keeps the workspace folder itself, so nothing moves when profiles are turned on; others live
//! in `profiles/<id>/`. An optional PIN is kept only as a salted PBKDF2-HMAC-SHA256 hash.
//!
//! Profiles are a convenience, not OS-level security: anyone who can log in to the OS account can read
//! every profile's files. Use separate OS accounts to keep people's data apart.
use crate::workspace::{audit, getrandom_fill, pin_hash};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn file(root: &Path) -> PathBuf {
    root.join("profiles.json")
}

pub fn load(root: &Path) -> Value {
    fs::read(file(root))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|v: &Value| v["profiles"].is_array())
        .unwrap_or_else(|| json!({ "profiles": [], "last": null }))
}

fn save(root: &Path, v: &Value) -> Result<(), String> {
    fs::write(file(root), serde_json::to_vec_pretty(v).unwrap_or_default()).map_err(|e| e.to_string())
}

fn find<'a>(v: &'a Value, id: &str) -> Option<&'a Value> {
    v["profiles"].as_array()?.iter().find(|p| p["id"] == id)
}

/// The folder a profile works in.
pub fn dir(root: &Path, p: &Value) -> PathBuf {
    if p["admin"] == true {
        root.to_path_buf()
    } else {
        root.join("profiles").join(p["id"].as_str().unwrap_or("x"))
    }
}

/// The profile to open: the last one used (or the admin), or None when profiles are not set up.
pub fn current(root: &Path) -> Option<Value> {
    let v = load(root);
    let last = v["last"].as_str().unwrap_or("");
    find(&v, last).or_else(|| v["profiles"].as_array().and_then(|a| a.first())).cloned()
}

pub fn public(p: &Value) -> Value {
    json!({ "id": p["id"], "name": p["name"], "admin": p["admin"] == true, "pin": p["pinHash"].is_string(),
            "restricted": p["restricted"] == true })
}

pub fn list(root: &Path) -> Vec<Value> {
    load(root)["profiles"].as_array().map(|a| a.iter().map(public).collect()).unwrap_or_default()
}

fn pin_ok(pin: &str) -> bool {
    (4..=12).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

fn set_pin(p: &mut Value, pin: Option<&str>) -> Result<(), String> {
    match pin.filter(|s| !s.is_empty()) {
        None => {
            p.as_object_mut().map(|o| {
                o.remove("pinHash");
                o.remove("pinSalt")
            });
        }
        Some(pin) => {
            if !pin_ok(pin) {
                return Err("the PIN is 4 to 12 digits".into());
            }
            let mut b = [0u8; 16];
            getrandom_fill(&mut b).map_err(|e| e.to_string())?;
            let salt: String = b.iter().map(|x| format!("{x:02x}")).collect();
            p["pinHash"] = json!(pin_hash(&salt, pin));
            p["pinSalt"] = json!(salt);
        }
    }
    Ok(())
}

pub fn check_pin(p: &Value, pin: &str) -> bool {
    match (p["pinHash"].as_str(), p["pinSalt"].as_str()) {
        (Some(h), Some(s)) => pin_hash(s, pin) == h,
        _ => true,
    }
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 {
        return Err("a profile name is 1 to 40 characters".into());
    }
    Ok(n.to_string())
}

/// Add a profile. The first one is the admin (and keeps the workspace folder).
pub fn add(root: &Path, name: &str, pin: Option<&str>) -> Result<Value, String> {
    let mut v = load(root);
    let name = clean_name(name)?;
    let arr = v["profiles"].as_array().cloned().unwrap_or_default();
    if arr.iter().any(|p| p["name"].as_str().map(|s| s.eq_ignore_ascii_case(&name)) == Some(true)) {
        return Err("a profile with that name already exists".into());
    }
    let mut b = [0u8; 6];
    getrandom_fill(&mut b).map_err(|e| e.to_string())?;
    let id: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let mut p = json!({ "id": id, "name": name, "admin": arr.is_empty(), "restricted": false });
    set_pin(&mut p, pin)?;
    let d = dir(root, &p);
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    if arr.is_empty() {
        v["last"] = json!(id);
    }
    v["profiles"].as_array_mut().unwrap().push(p.clone());
    save(root, &v)?;
    audit(root, "profile added", json!({ "id": id, "admin": p["admin"] }));
    Ok(public(&p))
}

fn update(root: &Path, id: &str, f: impl FnOnce(&mut Value) -> Result<(), String>) -> Result<Value, String> {
    let mut v = load(root);
    let p = v["profiles"]
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|p| p["id"] == id))
        .ok_or("no such profile")?;
    f(p)?;
    let out = public(p);
    save(root, &v)?;
    Ok(out)
}

pub fn rename(root: &Path, id: &str, name: &str) -> Result<Value, String> {
    let name = clean_name(name)?;
    let r = update(root, id, |p| {
        p["name"] = json!(name);
        Ok(())
    })?;
    audit(root, "profile renamed", json!({ "id": id }));
    Ok(r)
}

pub fn reset_pin(root: &Path, id: &str, pin: Option<&str>) -> Result<Value, String> {
    let r = update(root, id, |p| set_pin(p, pin))?;
    audit(root, "profile PIN reset", json!({ "id": id, "pin": pin.map(|s| !s.is_empty()).unwrap_or(false) }));
    Ok(r)
}

pub fn set_restricted(root: &Path, id: &str, on: bool) -> Result<Value, String> {
    let r = update(root, id, |p| {
        if p["admin"] == true && on {
            return Err("the admin profile cannot be restricted".into());
        }
        p["restricted"] = json!(on);
        Ok(())
    })?;
    audit(root, if on { "profile restricted" } else { "profile unrestricted" }, json!({ "id": id }));
    Ok(r)
}

/// Remove a profile and its folder. The admin profile cannot be removed.
pub fn remove(root: &Path, id: &str) -> Result<(), String> {
    let mut v = load(root);
    let p = find(&v, id).cloned().ok_or("no such profile")?;
    if p["admin"] == true {
        return Err("the admin profile cannot be removed".into());
    }
    let _ = fs::remove_dir_all(dir(root, &p));
    v["profiles"].as_array_mut().unwrap().retain(|q| q["id"] != id);
    if v["last"] == id {
        v["last"] = v["profiles"][0]["id"].clone();
    }
    save(root, &v)?;
    audit(root, "profile removed", json!({ "id": id }));
    Ok(())
}

/// Remember the profile to open next time (after checking its PIN).
pub fn choose(root: &Path, id: &str, pin: &str) -> Result<Value, String> {
    let mut v = load(root);
    let p = find(&v, id).cloned().ok_or("no such profile")?;
    if !check_pin(&p, pin) {
        audit(root, "wrong profile PIN", json!({ "id": id }));
        return Err("wrong PIN".into());
    }
    v["last"] = json!(id);
    save(root, &v)?;
    Ok(p)
}

/// Before a restart into a profile whose PIN was just checked: a one-use note, good for a minute.
pub fn hand_over(root: &Path, id: &str) {
    let _ = fs::write(root.join(".profile-handover"), json!({ "id": id, "at": now() }).to_string());
}

/// Read and delete the note left by hand_over (None when absent or older than a minute).
pub fn take_handover(root: &Path) -> Option<String> {
    let p = root.join(".profile-handover");
    let v: Value = serde_json::from_slice(&fs::read(&p).ok()?).ok()?;
    let _ = fs::remove_file(&p);
    (now().saturating_sub(v["at"].as_u64()?) <= 60).then(|| v["id"].as_str().map(String::from)).flatten()
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_first_isolated_dirs_and_pin() {
        let root = std::env::temp_dir().join(format!("gx-prof-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let a = add(&root, "Ana", None).unwrap();
        assert_eq!(a["admin"], true);
        let b = add(&root, "Ben", Some("1234")).unwrap();
        assert_eq!(b["admin"], false);
        assert!(add(&root, "ben", None).is_err());
        let v = load(&root);
        let (pa, pb) = (find(&v, a["id"].as_str().unwrap()).unwrap(), find(&v, b["id"].as_str().unwrap()).unwrap());
        assert_eq!(dir(&root, pa), root);
        assert_ne!(dir(&root, pb), root);
        assert!(!fs::read_to_string(file(&root)).unwrap().contains("1234"));
        assert!(choose(&root, b["id"].as_str().unwrap(), "0000").is_err());
        assert!(choose(&root, b["id"].as_str().unwrap(), "1234").is_ok());
        assert_eq!(current(&root).unwrap()["id"], b["id"]);
        assert!(remove(&root, a["id"].as_str().unwrap()).is_err());
        remove(&root, b["id"].as_str().unwrap()).unwrap();
        assert_eq!(list(&root).len(), 1);
        let _ = fs::remove_dir_all(&root);
    }
}
