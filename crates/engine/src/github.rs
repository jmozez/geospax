//! GitHub repositories in the Explorer: connect `owner/repo` (or a github.com link to a branch or a
//! folder), browse its folders, and put its data files on the map. GeoTIFFs are read in place over the
//! web; vector files become layers; a recipe (.yaml) is added to GeoSpaX's recipes.
//!
//! Folders are listed with GitHub's contents API. Without a token GitHub allows 60 listings an hour;
//! a token in GITHUB_TOKEN or GH_TOKEN (as the `gh` command line uses) raises that and opens private
//! repositories. GeoSpaX stores no token. GEOSPAX_GITHUB_API overrides the API address (tests, GitHub
//! Enterprise).

use crate::Engine;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

/// The start of the refusal for a recipe with code steps (the Explorer asks, then sends approve=code).
pub const CODE_RECIPE: &str = "this recipe runs Python or R code on this computer";

fn api() -> String {
    std::env::var("GEOSPAX_GITHUB_API")
        .unwrap_or_else(|_| "https://api.github.com".into())
        .trim_end_matches('/')
        .to_string()
}

fn token() -> Option<String> {
    ["GITHUB_TOKEN", "GH_TOKEN"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|t| !t.is_empty()))
}

fn get(url: &str) -> Result<Value, String> {
    let auth = token().map(|t| format!("Bearer {t}"));
    let mut h: Vec<(&str, &str)> = vec![("X-GitHub-Api-Version", "2022-11-28")];
    if let Some(a) = auth.as_deref() {
        h.push(("Authorization", a));
    }
    let body = crate::raster::http_with(url, None, &h, 30)?;
    let v: Value = serde_json::from_slice(&body).map_err(|_| {
        format!(
            "GitHub did not answer with JSON: {}",
            String::from_utf8_lossy(&body)
                .chars()
                .take(160)
                .collect::<String>()
        )
    })?;
    if let Some(m) = v
        .get("message")
        .and_then(Value::as_str)
        .filter(|_| !v.is_array())
    {
        let hint = if m.contains("rate limit") {
            " (set GITHUB_TOKEN to raise GitHub's limit)"
        } else {
            ""
        };
        return Err(format!("GitHub: {m}{hint}"));
    }
    Ok(v)
}

/// (owner, repo, branch or None, folder) from `owner/repo`, `owner/repo/folder` or a github.com link.
pub fn parse(url: &str) -> Result<(String, String, Option<String>, String), String> {
    let u = url.trim().trim_end_matches('/');
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))
        .or_else(|| u.strip_prefix("github.com/"))
        .unwrap_or(u);
    let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 2
        || parts
            .iter()
            .any(|p| *p == ".." || p.contains(['?', '#', ' ']))
    {
        return Err("a GitHub repository is owner/repository, or its github.com link".into());
    }
    let repo = parts[1].trim_end_matches(".git").to_string();
    let (branch, folder) = match parts.get(2) {
        Some(&"tree") | Some(&"blob") => (
            parts.get(3).map(|b| b.to_string()),
            parts.get(4..).map(|p| p.join("/")).unwrap_or_default(),
        ),
        Some(_) => (None, parts[2..].join("/")),
        None => (None, String::new()),
    };
    Ok((parts[0].to_string(), repo, branch, folder))
}

/// The branch the connection reads (the repository's default one unless the link named one).
fn branch_of(svc: &Value) -> Result<(String, String, String, String), String> {
    let (owner, repo, branch, folder) = parse(svc["url"].as_str().unwrap_or(""))?;
    let branch = match branch.or_else(|| svc["branch"].as_str().map(str::to_string)) {
        Some(b) => b,
        None => get(&format!("{}/repos/{owner}/{repo}", api()))?["default_branch"]
            .as_str()
            .unwrap_or("main")
            .to_string(),
    };
    Ok((owner, repo, branch, folder))
}

fn enc_path(p: &str) -> String {
    p.split('/')
        .map(|s| {
            s.bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn kind_of(name: &str) -> Option<&'static str> {
    match crate::browse::kind_of(Path::new(name))? {
        k @ ("raster" | "vector" | "recipe") => Some(k),
        _ => None,
    }
}

/// One folder of the repository: sub-folders, then the files GeoSpaX can open, as Explorer rows.
/// `sub` is relative to the connection's folder.
pub fn list(svc: &Value, sub: &str) -> Result<Vec<Value>, String> {
    let (owner, repo, branch, folder) = branch_of(svc)?;
    let sub = sub.trim_matches('/');
    if sub.split('/').any(|s| s == ".." || s == ".") {
        return Err("not a path inside this repository".into());
    }
    let full = [folder.as_str(), sub]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("/");
    let v = get(&format!(
        "{}/repos/{owner}/{repo}/contents/{}?ref={}",
        api(),
        enc_path(&full),
        enc_path(&branch)
    ))?;
    let items = v.as_array().ok_or("that is a file, not a folder")?;
    let rel = |name: &str| {
        if sub.is_empty() {
            name.to_string()
        } else {
            format!("{sub}/{name}")
        }
    };
    let (mut folders, mut files) = (Vec::new(), Vec::new());
    for it in items {
        let name = it["name"].as_str().unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        match it["type"].as_str() {
            Some("dir") => {
                folders.push(json!({ "id": rel(name), "title": name, "type": "folder" }))
            }
            Some("file") => {
                if let Some(k) = kind_of(name) {
                    files.push(json!({ "id": rel(name), "title": name, "type": "file", "kind": k, "size": it["size"] }));
                }
            }
            _ => {}
        }
    }
    folders.extend(files);
    Ok(folders)
}

/// The raw address of a file of the repository.
fn raw_url(svc: &Value, sub: &str) -> Result<(String, String), String> {
    let (owner, repo, branch, folder) = branch_of(svc)?;
    let sub = sub.trim_matches('/');
    if sub.is_empty() || sub.split('/').any(|s| s == ".." || s == ".") {
        return Err("not a file of this repository".into());
    }
    let full = [folder.as_str(), sub]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("/");
    // the contents API gives the download address (raw.githubusercontent.com, or the test server's)
    let v = get(&format!(
        "{}/repos/{owner}/{repo}/contents/{}?ref={}",
        api(),
        enc_path(&full),
        enc_path(&branch)
    ))?;
    let url = v["download_url"]
        .as_str()
        .ok_or("that is a folder, not a file")?
        .to_string();
    Ok((url, full))
}

/// Put one file of the repository on the map (or, for a recipe, add it to GeoSpaX's recipes).
/// A recipe that runs Python or R code is only added with `approve_code` (the user trusts it).
pub fn open(
    engine: &Arc<Engine>,
    svc: &Value,
    sub: &str,
    approve_code: bool,
) -> Result<Value, String> {
    let (url, full) = raw_url(svc, sub)?;
    let name = full.rsplit('/').next().unwrap_or(&full).to_string();
    let stem = Path::new(&name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "github".into());
    match kind_of(&name) {
        Some("raster") => {
            let h = engine.register_raster(
                Path::new(&format!("/vsicurl/{url}")),
                &crate::raster::sanitize(&stem),
            )?;
            Ok(json!({ "layers": [], "rasters": [h.info.id.clone()] }))
        }
        Some("vector") => {
            // copied next to GeoSpaX's state, so the layer keeps working offline and can be edited
            let dir = engine
                .state_dir
                .join("github")
                .join(svc["id"].as_str().unwrap_or("repo"));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let dest = dir.join(&name);
            let body = crate::raster::http(&url, None, 120)?;
            std::fs::write(&dest, &body).map_err(|e| e.to_string())?;
            let (layers, rasters, _, skipped) = crate::upload::register_files(engine, &[dest]);
            if layers.is_empty() && rasters.is_empty() {
                return Err(skipped
                    .first()
                    .cloned()
                    .unwrap_or_else(|| format!("{name}: nothing GeoSpaX can draw")));
            }
            Ok(json!({ "layers": layers, "rasters": rasters }))
        }
        Some("recipe") => {
            let body = crate::raster::http(&url, None, 60)?;
            let text = String::from_utf8(body).map_err(|_| format!("{name} is not a text file"))?;
            if let Ok(r) = crate::automation::recipe::Recipe::parse(
                &text,
                crate::automation::recipe::Origin::Api,
            ) {
                if r.has_code_steps() && !approve_code {
                    return Err(format!("{CODE_RECIPE}: {name}"));
                }
            }
            let (r, _) = engine
                .automation
                .save_user(&text)
                .map_err(|e| e.join("; "))?;
            Ok(json!({ "layers": [], "rasters": [], "recipe": r.summary_json() }))
        }
        _ => Err(format!(
            "{name}: GeoSpaX opens data files and recipes from GitHub"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn repository_addresses() {
        assert_eq!(
            parse("jmozez/geospax").unwrap(),
            ("jmozez".into(), "geospax".into(), None, "".into())
        );
        assert_eq!(
            parse("https://github.com/o/r.git").unwrap(),
            ("o".into(), "r".into(), None, "".into())
        );
        assert_eq!(
            parse("https://github.com/o/r/tree/dev/data/vec").unwrap(),
            (
                "o".into(),
                "r".into(),
                Some("dev".into()),
                "data/vec".into()
            )
        );
        assert_eq!(
            parse("o/r/data").unwrap(),
            ("o".into(), "r".into(), None, "data".into())
        );
        assert!(parse("just-a-name").is_err());
        assert!(parse("o/r/../x").is_err());
    }
}
