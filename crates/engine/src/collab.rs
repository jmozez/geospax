//! Review for shared projects on a self-hosted web edition (docs/USER_GUIDE.md, "Reviewing a
//! shared project"): every save of a named project keeps the version it replaced, and comments are
//! pinned to a place on the map (and optionally a feature).
//!
//! Files live beside the projects, out of the project list: `<projects>/.history/<slug>/<stamp>.json`
//! and `<projects>/.review/<slug>.json`. The web edition's token decides who may reach them; the
//! author shown on a comment is the name the reviewer typed until sign-in (OIDC) gives real
//! identities and roles.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Versions kept per project (oldest dropped first).
pub const KEEP: usize = 50;

fn history_dir(projects: &Path, slug: &str) -> PathBuf {
    projects.join(".history").join(slug)
}

fn review_file(projects: &Path, slug: &str) -> PathBuf {
    projects.join(".review").join(format!("{slug}.json"))
}

fn valid_version(v: &str) -> bool {
    !v.is_empty() && v.len() <= 40 && v.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

/// Keep the current file of `slug` (if any) as a version before it is overwritten.
pub fn keep_version(projects: &Path, slug: &str) -> Result<Option<String>, String> {
    let cur = projects.join(format!("{slug}.json"));
    if !cur.exists() {
        return Ok(None);
    }
    let dir = history_dir(projects, slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let mut n = 1;
    while dir.join(format!("{stamp}.json")).exists() {
        n += 1;
        stamp = format!("{}-{n}", &stamp[..19]);
    }
    std::fs::copy(&cur, dir.join(format!("{stamp}.json"))).map_err(|e| e.to_string())?;
    let mut all = versions(projects, slug);
    while all.len() > KEEP {
        if let Some(v) = all.pop() {
            let _ = std::fs::remove_file(dir.join(format!("{}.json", v["version"].as_str().unwrap_or_default())));
        }
    }
    Ok(Some(stamp))
}

/// The kept versions of `slug`, newest first.
pub fn versions(projects: &Path, slug: &str) -> Vec<Value> {
    let mut out: Vec<(String, Value)> = vec![];
    if let Ok(rd) = std::fs::read_dir(history_dir(projects, slug)) {
        for e in rd.flatten() {
            let p = e.path();
            let Some(v) = p.file_stem().and_then(|s| s.to_str()).filter(|v| valid_version(v)).map(str::to_string) else { continue };
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            let name = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|j| j.get("name").and_then(Value::as_str).map(str::to_string));
            out.push((v.clone(), json!({ "version": v, "bytes": size, "name": name })));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|x| x.1).collect()
}

/// One kept version.
pub fn version(projects: &Path, slug: &str, v: &str) -> Result<Value, String> {
    if !valid_version(v) {
        return Err(format!("'{v}' is not a version"));
    }
    let b = std::fs::read(history_dir(projects, slug).join(format!("{v}.json"))).map_err(|_| format!("no version {v} of '{slug}'"))?;
    serde_json::from_slice(&b).map_err(|e| e.to_string())
}

/// Put version `v` back as the project (the current one is kept as a version first).
pub fn restore(projects: &Path, slug: &str, v: &str) -> Result<Value, String> {
    let doc = version(projects, slug, v)?;
    let kept = keep_version(projects, slug)?;
    let cur = projects.join(format!("{slug}.json"));
    std::fs::write(&cur, serde_json::to_vec_pretty(&doc).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(json!({ "restored": v, "kept": kept }))
}

pub fn comments(projects: &Path, slug: &str) -> Vec<Value> {
    std::fs::read(review_file(projects, slug)).ok().and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok()).unwrap_or_default()
}

fn save_comments(projects: &Path, slug: &str, all: &[Value]) -> Result<(), String> {
    let f = review_file(projects, slug);
    std::fs::create_dir_all(f.parent().unwrap_or(projects)).map_err(|e| e.to_string())?;
    let tmp = f.with_extension("json.part");
    std::fs::write(&tmp, serde_json::to_vec_pretty(all).unwrap_or_default()).and_then(|_| std::fs::rename(&tmp, &f)).map_err(|e| e.to_string())
}

fn text(v: &Value, k: &str, max: usize) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(max).collect())
}

/// Add a comment: `{ text, author?, lon, lat, layer?, fid?, reply_to? }`.
pub fn add_comment(projects: &Path, slug: &str, body: &Value) -> Result<Value, String> {
    let t = text(body, "text", 4000).ok_or("text is needed")?;
    let lon = body.get("lon").and_then(Value::as_f64).filter(|v| (-180.0..=180.0).contains(v));
    let lat = body.get("lat").and_then(Value::as_f64).filter(|v| (-90.0..=90.0).contains(v));
    let mut all = comments(projects, slug);
    let reply_to = body.get("reply_to").and_then(Value::as_u64);
    if let Some(r) = reply_to {
        if !all.iter().any(|c| c["id"].as_u64() == Some(r)) {
            return Err(format!("no comment {r} to reply to"));
        }
    } else if lon.is_none() || lat.is_none() {
        return Err("lon and lat (WGS 84 degrees) are needed to pin a comment".into());
    }
    if all.len() >= 10_000 {
        return Err("this project has 10000 comments; resolve and clear some first".into());
    }
    let id = all.iter().filter_map(|c| c["id"].as_u64()).max().unwrap_or(0) + 1;
    let c = json!({
        "id": id, "text": t, "author": text(body, "author", 80).unwrap_or_else(|| "Reviewer".into()),
        "lon": lon, "lat": lat, "layer": text(body, "layer", 200), "fid": body.get("fid").and_then(Value::as_i64),
        "reply_to": reply_to, "at": chrono::Local::now().to_rfc3339(), "resolved": false,
    });
    all.push(c.clone());
    save_comments(projects, slug, &all)?;
    Ok(c)
}

/// Mark a comment (and its replies) resolved or open again.
pub fn resolve(projects: &Path, slug: &str, id: u64, resolved: bool) -> Result<Value, String> {
    let mut all = comments(projects, slug);
    let mut hit = 0;
    for c in all.iter_mut() {
        if c["id"].as_u64() == Some(id) || c["reply_to"].as_u64() == Some(id) {
            c["resolved"] = json!(resolved);
            hit += 1;
        }
    }
    if hit == 0 {
        return Err(format!("no comment {id}"));
    }
    save_comments(projects, slug, &all)?;
    Ok(json!({ "id": id, "resolved": resolved, "changed": hit }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gx-collab-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn versions_are_kept_and_restored() {
        let d = tmp("v");
        let cur = d.join("mine.json");
        assert_eq!(keep_version(&d, "mine").unwrap(), None);
        std::fs::write(&cur, br#"{"name":"one"}"#).unwrap();
        let v1 = keep_version(&d, "mine").unwrap().unwrap();
        std::fs::write(&cur, br#"{"name":"two"}"#).unwrap();
        assert_eq!(versions(&d, "mine").len(), 1);
        restore(&d, "mine", &v1).unwrap();
        let now: Value = serde_json::from_slice(&std::fs::read(&cur).unwrap()).unwrap();
        assert_eq!(now["name"], "one");
        assert_eq!(versions(&d, "mine").len(), 2, "restore keeps the replaced version");
        assert!(version(&d, "mine", "../x").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn comments_pin_reply_and_resolve() {
        let d = tmp("c");
        assert!(add_comment(&d, "p", &json!({ "text": "no place" })).is_err());
        let c = add_comment(&d, "p", &json!({ "text": "Check this boundary", "author": "Dr. Moses", "lon": 147.18, "lat": -9.44, "layer": "llg", "fid": 7 })).unwrap();
        assert_eq!(c["id"], 1);
        let r = add_comment(&d, "p", &json!({ "text": "Fixed", "reply_to": 1 })).unwrap();
        assert_eq!(r["reply_to"], 1);
        assert!(add_comment(&d, "p", &json!({ "text": "x", "reply_to": 9 })).is_err());
        assert_eq!(resolve(&d, "p", 1, true).unwrap()["changed"], 2);
        assert!(comments(&d, "p").iter().all(|c| c["resolved"] == true));
        let _ = std::fs::remove_dir_all(&d);
    }
}
