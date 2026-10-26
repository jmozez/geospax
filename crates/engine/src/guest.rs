//! Public guest demo (`geospax-server --public`): anyone can open the web edition without signing in.
//! Each visitor keeps a project of their own (the browser sends `?ws=<id>`), so nobody sees another
//! visitor's map; what could misuse the server is refused; and guest files are deleted after a week.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How long a guest's project and files are kept after they were last touched.
pub const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

/// Requests a guest may not make: running code, installing things, folders of the server, server-wide
/// settings, devices, and adding web addresses for the server to fetch.
pub fn refused(method: &str, segs: &[&str]) -> Option<&'static str> {
    let why = match (method, segs) {
        (_, ["api", "folders", ..]) | (_, ["api", "browse", ..]) => "folders of the server",
        ("POST", ["api", "r", ..]) | ("POST", ["api", "python", ..]) => "installing R or Python packages",
        (m, ["api", "plugins", ..]) if m != "GET" && !matches!(segs, [_, _, _, "tools", _, "run"]) => "installing or removing plugins",
        (m, ["api", "models", ..]) if m != "GET" => "adding AI models",
        (m, ["api", "recipes", ..]) if m != "GET" && !matches!(segs, [_, _, _, "run"] | [_, _, "validate"]) => "saving recipes",
        ("PUT", ["api", "ai", ..]) | ("POST", ["api", "ask"]) => "the AI assistant",
        ("POST", ["api", "settings", ..]) | ("POST", ["api", "cache", ..]) | ("POST", ["api", "bench"]) => "server settings",
        ("POST", ["api", "devices", ..]) | ("POST", ["api", "phone", ..]) | ("POST", ["api", "hooks", ..]) => "devices and phones",
        ("POST", ["api", "services"]) | ("POST", ["api", "stac", "add"]) => "adding web services",
        _ => return None,
    };
    Some(why)
}

/// A visitor's workspace id from `?ws=`: 8 to 64 letters, digits or dashes, else none.
pub fn workspace(ws: Option<&str>) -> Option<String> {
    let w = ws?.trim();
    ((8..=64).contains(&w.len()) && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then(|| w.to_ascii_lowercase())
}

/// Where a visitor's project is kept.
pub fn project_path(state_dir: &Path, ws: &str) -> PathBuf {
    state_dir.join("guests").join(format!("{ws}.json"))
}

/// Delete guest projects, uploaded or downloaded files and run results not touched for a week.
/// Returns how many files and folders went.
pub fn clean(state_dir: &Path, data_dirs: &[PathBuf]) -> usize {
    let old = |p: &Path| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .map(|t| SystemTime::now().duration_since(t).unwrap_or_default() > KEEP)
            .unwrap_or(false)
    };
    let mut n = 0;
    // files anywhere below `dir` not touched for a week, then the folders left empty
    fn sweep(dir: &Path, old: &dyn Fn(&Path) -> bool, n: &mut usize) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if p.is_dir() {
                sweep(&p, old, n);
                if std::fs::read_dir(&p).map(|mut d| d.next().is_none()).unwrap_or(false) && std::fs::remove_dir(&p).is_ok() {
                    *n += 1;
                }
            } else if old(&p) && std::fs::remove_file(&p).is_ok() {
                *n += 1;
            }
        }
    }
    sweep(&state_dir.join("guests"), &old, &mut n);
    sweep(&state_dir.join("runs"), &old, &mut n);
    for d in data_dirs.iter().filter(|d| d.is_dir()) {
        sweep(d, &old, &mut n);
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_keeps_new_files_and_dot_folders() {
        let d = std::env::temp_dir().join(format!("gsx-guest-{}", std::process::id()));
        let (data, state) = (d.join("data"), d.join("state"));
        std::fs::create_dir_all(data.join("Uploads")).unwrap();
        std::fs::create_dir_all(state.join(".geospax")).unwrap();
        std::fs::write(data.join("Uploads/new.geojson"), "{}").unwrap();
        assert_eq!(clean(&state, std::slice::from_ref(&data)), 0);
        assert!(data.join("Uploads/new.geojson").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn guests_cannot_run_code_or_touch_the_server() {
        assert!(refused("POST", &["api", "r", "install"]).is_some());
        assert!(refused("POST", &["api", "python", "update"]).is_some());
        assert!(refused("POST", &["api", "plugins", "import"]).is_some());
        assert!(refused("POST", &["api", "folders"]).is_some());
        assert!(refused("GET", &["api", "folders", "pick"]).is_some());
        assert!(refused("POST", &["api", "recipes"]).is_some());
        assert!(refused("POST", &["api", "services"]).is_some());
        assert!(refused("GET", &["api", "browse"]).is_some());
        // what the demo is for still works
        assert!(refused("POST", &["api", "recipes", "r-rayshader", "run"]).is_none());
        assert!(refused("POST", &["api", "plugins", "gsx", "tools", "buffer", "run"]).is_none());
        assert!(refused("POST", &["api", "upload"]).is_none());
        assert!(refused("POST", &["api", "overture"]).is_none());
        assert!(refused("GET", &["api", "plugins"]).is_none());
    }

    #[test]
    fn workspace_ids_are_checked() {
        assert_eq!(workspace(Some("ab12cd34-ef")).as_deref(), Some("ab12cd34-ef"));
        assert!(workspace(Some("../../etc/passwd")).is_none());
        assert!(workspace(Some("short")).is_none());
        assert!(workspace(None).is_none());
    }
}
