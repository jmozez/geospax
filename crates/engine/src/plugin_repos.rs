//! The plugin manager (docs/PLUGINS.md §Manager), modelled on QGIS's "Manage and Install Plugins":
//! plugins you switch off without removing them, plugin repositories (a JSON index of packages
//! at a URL or a path), and install, upgrade and reinstall from those repositories or a ZIP file.
//!
//! Settings live in `<state>/plugin-manager.json`; the last fetched repository index is cached in
//! `<state>/plugin-repos.json` so the Not installed and Upgradeable lists work offline.
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Repo {
    pub name: String,
    /// `https://…/plugins.json`, `file:///…` or a local path
    pub url: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagerConfig {
    /// Plugin ids switched off: still installed, but their tools and ribbon commands are hidden
    /// and they do not run.
    #[serde(default)]
    pub disabled: Vec<String>,
    #[serde(default)]
    pub repos: Vec<Repo>,
    /// Fetch the repositories when the manager opens.
    #[serde(default = "yes")]
    pub check_updates: bool,
    /// List plugins a repository marks as experimental.
    #[serde(default)]
    pub show_experimental: bool,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        ManagerConfig { disabled: Vec::new(), repos: Vec::new(), check_updates: true, show_experimental: false }
    }
}

/// One package a repository offers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RepoPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// `native` · `rustgis` · `geolibre` · `qgis` · `arcgis`
    #[serde(default = "native")]
    pub source: String,
    /// The package (.zip, .rgplugin, .esriAddInX), absolute or relative to the index.
    pub download: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub experimental: bool,
    /// Filled in on fetch: the repository it came from.
    #[serde(default)]
    pub repo: String,
}

fn native() -> String {
    "native".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RepoIndex {
    /// Unix seconds of the last fetch (0: never).
    pub fetched: u64,
    pub plugins: Vec<RepoPlugin>,
    /// `repo name: message` for each repository that could not be read.
    pub errors: Vec<String>,
}

pub fn config_path(plugin_dir: &Path) -> PathBuf {
    plugin_dir.parent().unwrap_or(plugin_dir).join("plugin-manager.json")
}

pub fn index_path(plugin_dir: &Path) -> PathBuf {
    plugin_dir.parent().unwrap_or(plugin_dir).join("plugin-repos.json")
}

pub fn load_config(plugin_dir: &Path) -> ManagerConfig {
    fs::read(config_path(plugin_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_config(plugin_dir: &Path, cfg: &ManagerConfig) -> Result<(), String> {
    let p = config_path(plugin_dir);
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    fs::write(&p, serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", p.display()))
}

pub fn load_index(plugin_dir: &Path) -> RepoIndex {
    fs::read(index_path(plugin_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Compare two version strings segment by segment, numbers as numbers (`1.10` > `1.9`);
/// a pre-release suffix sorts before the release (`1.2.0-beta` < `1.2.0`).
pub fn version_cmp(a: &str, b: &str) -> Ordering {
    let a = a.trim().trim_start_matches(['v', 'V']);
    let b = b.trim().trim_start_matches(['v', 'V']);
    let (an, ap) = a.split_once('-').map(|(x, y)| (x, Some(y))).unwrap_or((a, None));
    let (bn, bp) = b.split_once('-').map(|(x, y)| (x, Some(y))).unwrap_or((b, None));
    let seg = |s: &str| s.split(['.', '_', '+']).map(|p| p.to_string()).collect::<Vec<_>>();
    let (sa, sb) = (seg(an), seg(bn));
    for i in 0..sa.len().max(sb.len()) {
        let x = sa.get(i).map(String::as_str).unwrap_or("0");
        let y = sb.get(i).map(String::as_str).unwrap_or("0");
        let o = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            _ => x.cmp(y),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    match (ap, bp) {
        (None, None) => Ordering::Equal,
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(y),
    }
}

/// A download URL relative to the index it came from.
pub fn resolve(base: &str, rel: &str) -> String {
    if rel.contains("://") || rel.starts_with('/') || base.is_empty() {
        return rel.to_string();
    }
    match base.rfind(['/', '\\']) {
        Some(i) => format!("{}{}", &base[..=i], rel),
        None => rel.to_string(),
    }
}

/// Read a URL or a path. http(s) goes through GDAL like every other download (raster::download_to).
pub fn fetch(url: &str, tmp: &Path) -> Result<Vec<u8>, String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        fs::create_dir_all(tmp.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
        crate::raster::download_to(url, tmp, None, |n, _| n < 256 << 20)?;
        let b = fs::read(tmp).map_err(|e| e.to_string());
        let _ = fs::remove_file(tmp);
        b
    } else {
        let p = url.strip_prefix("file://").unwrap_or(url);
        fs::read(p).map_err(|e| format!("{p}: {e}"))
    }
}

/// A repository index: `{"plugins": [...]}` or a bare array.
pub fn parse_index(bytes: &[u8], repo: &Repo) -> Result<Vec<RepoPlugin>, String> {
    let v: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| format!("not a plugin index: {e}"))?;
    let arr = v.get("plugins").cloned().unwrap_or(v);
    let mut out: Vec<RepoPlugin> = serde_json::from_value(arr).map_err(|e| format!("not a plugin index: {e}"))?;
    for p in &mut out {
        p.repo = repo.name.clone();
        p.download = resolve(&repo.url, &p.download);
    }
    Ok(out)
}

/// Fetch every enabled repository and cache the result. Where two repositories offer the same
/// id, the newer version wins (as in QGIS).
pub fn refresh(plugin_dir: &Path, cfg: &ManagerConfig) -> RepoIndex {
    let mut idx = RepoIndex::default();
    let tmp = plugin_dir.parent().unwrap_or(plugin_dir).join("tmp").join("plugin-index.json");
    for r in cfg.repos.iter().filter(|r| r.enabled) {
        match fetch(&r.url, &tmp).and_then(|b| parse_index(&b, r)) {
            Ok(list) => {
                for p in list {
                    match idx.plugins.iter_mut().find(|q| q.id == p.id) {
                        Some(q) if version_cmp(&p.version, &q.version) == Ordering::Greater => *q = p,
                        Some(_) => {}
                        None => idx.plugins.push(p),
                    }
                }
            }
            Err(e) => idx.errors.push(format!("{}: {e}", r.name)),
        }
    }
    idx.plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    idx.fetched = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(b) = serde_json::to_vec_pretty(&idx) {
        let _ = fs::write(index_path(plugin_dir), b);
    }
    idx
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A safe file name for a package that arrives as bytes (an upload or a download).
pub fn package_name(id: &str, version: &str, ext: &str) -> String {
    let clean = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' { c } else { '_' }).collect::<String>();
    // the id may hold dashes; the package reader drops what follows the last one, so the
    // version always goes last
    format!("{}-{}.{}", id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect::<String>(), clean(version), clean(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert_eq!(version_cmp("1.10", "1.9"), Ordering::Greater);
        assert_eq!(version_cmp("1.2", "1.2.0"), Ordering::Equal);
        assert_eq!(version_cmp("v2.0.1", "2.0.0"), Ordering::Greater);
        assert_eq!(version_cmp("1.2.0-beta", "1.2.0"), Ordering::Less);
        assert_eq!(version_cmp("0.9", "1.0"), Ordering::Less);
    }

    #[test]
    fn downloads_resolve_against_the_index() {
        assert_eq!(resolve("https://x.org/repo/plugins.json", "a-1.0.zip"), "https://x.org/repo/a-1.0.zip");
        assert_eq!(resolve("/srv/repo/plugins.json", "a.zip"), "/srv/repo/a.zip");
        assert_eq!(resolve("https://x.org/plugins.json", "https://y.org/a.zip"), "https://y.org/a.zip");
    }

    #[test]
    fn index_parses_and_newest_wins() {
        let d = std::env::temp_dir().join(format!("gsx-repo-{}", std::process::id()));
        let plugins = d.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        fs::write(d.join("a.json"), r#"{"plugins":[{"id":"x","name":"X","version":"1.0","download":"x-1.0.zip"}]}"#).unwrap();
        fs::write(d.join("b.json"), r#"[{"id":"x","name":"X","version":"1.2","download":"x-1.2.zip","experimental":true}]"#).unwrap();
        let cfg = ManagerConfig {
            repos: vec![
                Repo { name: "A".into(), url: d.join("a.json").to_string_lossy().into(), enabled: true },
                Repo { name: "B".into(), url: d.join("b.json").to_string_lossy().into(), enabled: true },
                Repo { name: "Gone".into(), url: d.join("none.json").to_string_lossy().into(), enabled: true },
            ],
            ..Default::default()
        };
        let idx = refresh(&plugins, &cfg);
        assert_eq!(idx.plugins.len(), 1);
        assert_eq!(idx.plugins[0].version, "1.2");
        assert_eq!(idx.plugins[0].repo, "B");
        assert!(idx.plugins[0].download.ends_with("x-1.2.zip"));
        assert_eq!(idx.errors.len(), 1);
        assert_eq!(load_index(&plugins).plugins.len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn package_names_keep_the_id() {
        assert_eq!(package_name("my-plugin", "1.2", "zip"), "my-plugin-1.2.zip");
        assert_eq!(package_name("../evil", "1/2", "zip"), "___evil-1_2.zip");
    }

    fn zip_plugin(version: &str) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o: zip::write::SimpleFileOptions = Default::default();
            z.start_file("plugin.json", o).unwrap();
            write!(z, r#"{{"id":"demo-tool","name":"Demo tool","version":"{version}","description":"d","entry":"plugin.wasm","tools":[{{"id":"t","name":"T","summary":"s"}}]}}"#).unwrap();
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn install_switch_off_upgrade_from_a_repository() {
        let d = std::env::temp_dir().join(format!("gsx-mgr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let dir = d.join("state").join("plugins");
        fs::create_dir_all(&dir).unwrap();
        let plugins = crate::plugins::Plugins::new(vec![dir.clone()]);
        // install from an uploaded ZIP
        let info = plugins.install_bytes("demo-tool-1.0.zip", &zip_plugin("1.0")).unwrap();
        assert_eq!(info.id, "demo-tool");
        assert_eq!(plugins.list_enabled().len(), 1);
        // switch off: still installed, not offered
        plugins.set_enabled("demo-tool", false).unwrap();
        assert_eq!(plugins.list().len(), 1);
        assert!(plugins.list_enabled().is_empty());
        assert!(!plugins.is_enabled("demo-tool"));
        plugins.set_enabled("demo-tool", true).unwrap();
        assert!(plugins.is_enabled("demo-tool"));
        // a repository offers 1.1 with its checksum: upgrade replaces the copy in place
        let repo = d.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let pkg = zip_plugin("1.1");
        fs::write(repo.join("demo-tool-1.1.zip"), &pkg).unwrap();
        fs::write(
            repo.join("plugins.json"),
            format!(r#"{{"plugins":[{{"id":"demo-tool","name":"Demo tool","version":"1.1","download":"demo-tool-1.1.zip","sha256":"{}"}}]}}"#, sha256_hex(&pkg)),
        )
        .unwrap();
        let mut cfg = plugins.manager_config();
        cfg.repos.push(Repo { name: "Local".into(), url: repo.join("plugins.json").to_string_lossy().into(), enabled: true });
        plugins.set_manager_config(&cfg).unwrap();
        assert_eq!(plugins.refresh_repos().unwrap().plugins.len(), 1);
        let up = plugins.install_from_repo("demo-tool").unwrap();
        assert_eq!(up.version.as_deref(), Some("1.1"));
        assert_eq!(plugins.list().len(), 1);
        // a tampered download is refused and the installed copy stays
        fs::write(repo.join("demo-tool-1.1.zip"), zip_plugin("6.6")).unwrap();
        assert!(plugins.install_from_repo("demo-tool").unwrap_err().contains("checksum"));
        assert_eq!(plugins.get("demo-tool").unwrap().version.as_deref(), Some("1.1"));
        // a broken upload does not cost the installed copy
        assert!(plugins.install_bytes("demo-tool-2.0.zip", b"not a zip").is_err());
        assert!(plugins.get("demo-tool").is_some());
        let _ = fs::remove_dir_all(&d);
    }
}
