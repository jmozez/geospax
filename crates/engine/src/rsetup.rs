//! R setup (docs/R.md): find R, install it when it is missing, and install R packages into
//! GeoSpaX's own library (`<state>/r-library`), so the user's R setup is never changed.
//!
//! Packages come as ready-built binaries: CRAN's on Windows and macOS, Posit Public Package
//! Manager's on Linux (Ubuntu, Debian, RHEL and relatives), so nothing is compiled.
//! Installing R itself: Windows runs CRAN's installer for the current user (no admin rights);
//! macOS runs CRAN's .pkg (asks for the admin password); Linux uses the system package manager
//! through pkexec (asks for the password). Without a desktop to ask on (a server), it says
//! which command to run instead.

use crate::automation::sidecar::{self, Lang};
use crate::jobs::{Job, Status};
use crate::Engine;
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Package kits, in the order the R tab shows them: (id, title, packages).
pub const KITS: &[(&str, &str, &[&str])] = &[
    ("spatial", "Spatial data (sf, terra, stars)", &["sf", "terra", "stars"]),
    ("maps", "Publication maps (tmap, ggplot2)", &["tmap", "ggplot2", "ggspatial", "patchwork", "viridisLite"]),
    ("relief", "3D relief (rayshader)", &["rayshader"]),
    ("sdm", "Species distribution models (biomod2, MaxEnt)", &["biomod2", "maxnet", "dismo", "predicts"]),
    ("ml", "Machine learning (tidymodels)", &["tidymodels", "ranger"]),
    ("data", "Data wrangling and databases (tidyverse, dbplyr)", &["tidyverse", "dbplyr", "DBI", "RSQLite", "duckdb"]),
    ("stats", "Spatial statistics (gstat, spdep, spatstat)", &["gstat", "spdep", "spatstat"]),
    ("online", "Online data (geodata, rgbif)", &["geodata", "rgbif"]),
    ("gee", "Google Earth Engine (rgee)", &["rgee"]),
];

/// Kits a new installation gets.
pub const DEFAULT_KITS: &[&str] = &["spatial", "maps", "stats"];

fn library() -> PathBuf {
    sidecar::r_library().cloned().unwrap_or_else(|| PathBuf::from("r-library"))
}

fn all_packages() -> Vec<&'static str> {
    let mut v: Vec<&str> = KITS.iter().flat_map(|k| k.2.iter().copied()).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Packages of the given kits (unknown kit ids are taken as package names).
pub fn packages_of(kits: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for k in kits {
        match KITS.iter().find(|x| x.0 == k) {
            Some(kit) => out.extend(kit.2.iter().map(|s| s.to_string())),
            None => out.push(k.clone()),
        }
    }
    out.dedup();
    out
}

/// R string literal.
fn rs(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Is R there, which version, and which packages are installed (GeoSpaX's library first).
pub fn status() -> Value {
    let kits: Vec<Value> = KITS.iter().map(|(id, title, pk)| json!({ "id": id, "title": title, "packages": pk })).collect();
    let lib = library();
    let Some((cmd, version)) = sidecar::find(Lang::R) else {
        return json!({ "installed": false, "library": lib, "kits": kits, "packages": {}, "can_install_r": can_install_r().is_ok(), "install_note": can_install_r().err(), "hint": sidecar::install_hint(Lang::R) });
    };
    let names: Vec<String> = all_packages().iter().map(|p| rs(p)).collect();
    let script = format!(
        "lib <- {lib}; if (dir.exists(lib)) .libPaths(c(lib, .libPaths()))\nfor (p in c({names})) {{ v <- tryCatch(as.character(utils::packageVersion(p)), error = function(e) \"\"); cat(p, v, \"\\n\", sep = \"\\t\") }}\n",
        lib = rs(&lib.to_string_lossy()),
        names = names.join(", ")
    );
    let mut packages = Map::new();
    if let Ok(out) = crate::command(&cmd).args(["-e", &script]).stdin(Stdio::null()).output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut it = line.split('\t');
            if let (Some(p), Some(v)) = (it.next(), it.next()) {
                packages.insert(p.to_string(), if v.is_empty() { Value::Null } else { Value::from(v) });
            }
        }
    }
    json!({ "installed": true, "rscript": cmd, "version": version, "library": lib, "kits": kits, "packages": packages, "repo": repo() })
}

/// Where binaries come from: CRAN (Windows, macOS) or Posit Public Package Manager (Linux).
fn repo() -> String {
    if cfg!(target_os = "linux") {
        if let Some(distro) = ppm_distro(&std::fs::read_to_string("/etc/os-release").unwrap_or_default()) {
            return format!("https://packagemanager.posit.co/cran/__linux__/{distro}/latest");
        }
    }
    "https://cloud.r-project.org".into()
}

/// Posit Package Manager's name for this Linux (noble, jammy, bookworm, rhel9 …).
fn ppm_distro(os_release: &str) -> Option<String> {
    let get = |k: &str| os_release.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).map(|v| v.trim_matches('"').to_string());
    let id = get("ID").unwrap_or_default();
    let like = get("ID_LIKE").unwrap_or_default();
    let code = get("UBUNTU_CODENAME").or_else(|| get("VERSION_CODENAME")).unwrap_or_default();
    let major = get("VERSION_ID").unwrap_or_default().split('.').next().unwrap_or("").to_string();
    match id.as_str() {
        "ubuntu" | "debian" if !code.is_empty() => Some(code),
        _ if like.contains("ubuntu") && !code.is_empty() => Some(code),
        "rhel" | "rocky" | "almalinux" | "centos" | "ol" if !major.is_empty() => Some(format!("rhel{major}")),
        "opensuse-leap" | "sles" if !major.is_empty() => Some(format!("opensuse{}", get("VERSION_ID").unwrap_or_default().replace('.', ""))),
        _ => None,
    }
}

/// Whether GeoSpaX can install R itself here (and if not, what to do instead).
fn can_install_r() -> Result<(), String> {
    if cfg!(windows) || cfg!(target_os = "macos") {
        return Ok(());
    }
    let desktop = std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    let pkexec = crate::command("pkexec").arg("--version").stdin(Stdio::null()).output().map(|o| o.status.success()).unwrap_or(false);
    if desktop && pkexec {
        Ok(())
    } else {
        Err("install R with your package manager: sudo apt install r-base-core (Debian/Ubuntu) or sudo dnf install R (Fedora/RHEL); then press Check again".into())
    }
}

/// Install R (when `with_r` and it is missing) and then `packages`, as a background job.
pub fn start_install(engine: &Arc<Engine>, with_r: bool, packages: Vec<String>) -> Result<Arc<Job>, String> {
    if let Some(j) = engine.jobs.active("r-setup", "r") {
        return Err(format!("R setup job {} is already running", j.id));
    }
    let need_r = sidecar::find(Lang::R).is_none();
    if need_r && !with_r {
        return Err(format!("R is not installed: {}", sidecar::install_hint(Lang::R)));
    }
    if need_r {
        can_install_r()?;
    }
    let job = engine.jobs.create("r-setup", "r");
    job.update(|s| s.total = packages.len() as u64 + u64::from(need_r));
    let (e, j) = (engine.clone(), job.clone());
    engine.job_pool.spawn(move || {
        j.update(|s| s.status = Status::Running);
        let res = (|| -> Result<String, String> {
            if need_r {
                j.update(|s| s.message = "Installing R".into());
                install_r(&e.state_dir.join("downloads"))?;
                if sidecar::find(Lang::R).is_none() {
                    return Err("R was installed but Rscript was not found; restart GeoSpaX".into());
                }
                j.update(|s| s.done += 1);
            }
            if packages.is_empty() {
                return Ok("R is ready".into());
            }
            install_packages(&j, &packages)
        })();
        match res {
            Ok(msg) => j.finish(Status::Done, msg, Some(status())),
            Err(err) if j.cancel.load(Ordering::Relaxed) => j.finish(Status::Cancelled, err, None),
            Err(err) => j.finish(Status::Failed, err, None),
        }
    });
    Ok(job)
}

fn install_packages(job: &Job, packages: &[String]) -> Result<String, String> {
    let (cmd, _) = sidecar::find(Lang::R).ok_or("R is not installed")?;
    let lib = library();
    std::fs::create_dir_all(&lib).map_err(|e| format!("{}: {e}", lib.display()))?;
    let list: Vec<String> = packages.iter().map(|p| rs(p)).collect();
    // one package at a time so the job can show progress; failures are collected, not fatal
    let script = format!(
        r#"lib <- {lib}
.libPaths(c(lib, .libPaths()))
options(repos = c(CRAN = {repo}), HTTPUserAgent = sprintf("R/%s R (%s)", getRversion(), paste(getRversion(), R.version$platform, R.version$arch, R.version$os)), timeout = 600)
pk <- c({list})
failed <- character()
for (i in seq_along(pk)) {{
  cat("GSX", i, length(pk), pk[i], "\n")
  if (!requireNamespace(pk[i], quietly = TRUE)) {{
    tryCatch(utils::install.packages(pk[i], lib = lib, dependencies = c("Depends", "Imports", "LinkingTo"), quiet = TRUE),
      error = function(e) message(conditionMessage(e)), warning = function(w) message(conditionMessage(w)))
    if (!requireNamespace(pk[i], quietly = TRUE)) failed <- c(failed, pk[i])
  }}
}}
cat("GSXFAILED", failed, "\n")
"#,
        lib = rs(&lib.to_string_lossy()),
        repo = rs(&repo()),
        list = list.join(", ")
    );
    let mut child = crate::command(&cmd).args(["-e", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("could not start {cmd}: {e}"))?;
    let stdout = child.stdout.take().ok_or("no output from R")?;
    let base = job.json()["done"].as_u64().unwrap_or(0);
    let mut failed: Vec<String> = Vec::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if job.cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.first() {
            Some(&"GSX") if parts.len() >= 4 => {
                let i: u64 = parts[1].parse().unwrap_or(1);
                let p = parts[3].to_string();
                job.update(|s| {
                    s.done = base + i - 1;
                    s.message = format!("Installing {p} ({i} of {})", parts[2]);
                });
            }
            Some(&"GSXFAILED") => failed = parts[1..].iter().map(|s| s.to_string()).collect(),
            _ => {}
        }
    }
    let st = child.wait().map_err(|e| e.to_string())?;
    if !st.success() {
        return Err(format!("R exited with {st}"));
    }
    job.update(|s| s.done = s.total);
    if failed.is_empty() {
        Ok(format!("{} R package(s) ready in {}", packages.len(), lib.display()))
    } else {
        Err(format!("could not install {} (see the R console for details; some need system libraries or an internet connection)", failed.join(", ")))
    }
}

/// The newest file on a CRAN directory page matching `prefix … suffix`.
fn newest_link(html: &str, prefix: &str, suffix: &str) -> Option<String> {
    let mut found: Vec<String> = html
        .split(['"', '\'', '>', '<', ' '])
        .filter(|s| s.starts_with(prefix) && s.ends_with(suffix) && !s.contains('/'))
        .map(str::to_string)
        .collect();
    found.sort_by_key(|f| f.trim_start_matches(prefix).split(|c: char| !c.is_ascii_digit()).filter_map(|n| n.parse::<u32>().ok()).take(3).collect::<Vec<_>>());
    found.pop()
}

fn download(url: &str, dest: &Path) -> Result<(), String> {
    let bytes = crate::raster::http(url, None, 1800)?;
    std::fs::create_dir_all(dest.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    std::fs::write(dest, bytes).map_err(|e| format!("{}: {e}", dest.display()))
}

fn run(c: &mut std::process::Command, what: &str) -> Result<(), String> {
    let out = c.stdin(Stdio::null()).output().map_err(|e| format!("{what}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")))
    }
}

fn install_r(downloads: &Path) -> Result<(), String> {
    const CRAN: &str = "https://cloud.r-project.org";
    if cfg!(windows) {
        let page = String::from_utf8_lossy(&crate::raster::http(&format!("{CRAN}/bin/windows/base/"), None, 60)?).to_string();
        let exe = newest_link(&page, "R-", "-win.exe").ok_or("could not find the R installer on CRAN")?;
        let file = downloads.join(&exe);
        download(&format!("{CRAN}/bin/windows/base/{exe}"), &file)?;
        // for the current user: no admin rights; sidecar::find looks in %LOCALAPPDATA%\Programs\R
        let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("Programs").join("R").join(exe.trim_end_matches("-win.exe"));
        run(crate::command(&file).args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER"]).arg(format!("/DIR={}", dir.display())), "the R installer")
    } else if cfg!(target_os = "macos") {
        let sub = if cfg!(target_arch = "aarch64") { "big-sur-arm64" } else { "big-sur-x86_64" };
        let page = String::from_utf8_lossy(&crate::raster::http(&format!("{CRAN}/bin/macosx/{sub}/base/"), None, 60)?).to_string();
        let suffix = if cfg!(target_arch = "aarch64") { "-arm64.pkg" } else { "-x86_64.pkg" };
        let pkg = newest_link(&page, "R-", suffix).ok_or("could not find the R installer on CRAN")?;
        let file = downloads.join(&pkg);
        download(&format!("{CRAN}/bin/macosx/{sub}/base/{pkg}"), &file)?;
        let script = format!("do shell script \"installer -pkg '{}' -target /\" with administrator privileges", file.display());
        run(crate::command("osascript").args(["-e", &script]), "the R installer")
    } else {
        let os = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let cmd = if os.contains("ID=fedora") || os.contains("rhel") || os.contains("centos") {
            "dnf install -y R-core"
        } else if os.contains("suse") {
            "zypper --non-interactive install R-base"
        } else if os.contains("arch") {
            "pacman -S --noconfirm r"
        } else {
            "apt-get update && apt-get install -y r-base-core"
        };
        run(crate::command("pkexec").args(["sh", "-c", cmd]), "installing R")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_package_repos() {
        assert_eq!(ppm_distro("ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble").as_deref(), Some("noble"));
        assert_eq!(ppm_distro("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\nVERSION_CODENAME=wilma\nUBUNTU_CODENAME=noble").as_deref(), Some("noble"));
        assert_eq!(ppm_distro("ID=debian\nVERSION_CODENAME=bookworm").as_deref(), Some("bookworm"));
        assert_eq!(ppm_distro("ID=\"rocky\"\nVERSION_ID=\"9.4\"").as_deref(), Some("rhel9"));
        assert_eq!(ppm_distro("ID=gentoo"), None);
    }

    #[test]
    fn newest_installer() {
        let html = r#"<a href="R-4.4.3-win.exe">R-4.4.3-win.exe</a> <a href="R-4.5.1-win.exe">x</a> <a href="R-4.5.0-win.exe">"#;
        assert_eq!(newest_link(html, "R-", "-win.exe").as_deref(), Some("R-4.5.1-win.exe"));
        assert_eq!(packages_of(&["maps".into(), "lidR".into()]), ["tmap", "ggplot2", "ggspatial", "patchwork", "viridisLite", "lidR"]);
    }
}
