# Push GeoSpaX to https://github.com/jmozez/geospax

The repository is ready locally: **1 commit on branch `main`, 247 files** (commit `2f466ce`, GeoSpaX 1.6.0),
remote `origin` → https://github.com/jmozez/geospax. This sandbox has no GitHub credentials of its own, so the
push needs you to authorise it once — about 20 seconds, no keys or tokens to copy.

## 1. Authorise (two clicks)

1. Open **https://github.com/login/device**
2. Enter the code the agent printed for you, e.g. `2057-BAC8`
   (codes expire after ~15 minutes — if GitHub says *Expired user code*, ask and a fresh one is issued)
3. **Continue**, then **Authorise GitHub CLI**

The push then runs by itself — a background job is already waiting and pushes as soon as the code is accepted.

## 2. Nothing else to do

The job pushes `main` and verifies it with `git ls-remote`. You get the commit URL when it lands.

## If you would rather do it another way

- **Deploy key** (never expires, good if you are away for a while): https://github.com/jmozez/geospax/settings/keys
  → **Add deploy key** → title `geospax-sandbox`, tick **Allow write access**, key:
  ```
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAhrK8deHpdUsThU98wPoVMYwoi0EWjdeR4XEGXaorbd geospax-deploy@sandbox
  ```
  (Ask for the current key: it lives outside the workspace and is regenerated if the sandbox restarts.)
  Then say "done" and the agent pushes over SSH.
- **Personal access token**: fine-grained, Contents: read+write, this repository only. Paste it and it is used once.
- **From your own machine**: ask for a `.tar.gz` of the source tree; it excludes `target/`, `node_modules/` and
  `releases/`.

## Security notes

- The OAuth token is written to `/var/tmp/geospax-git/token` (mode 600), **outside** the workspace, so it is in
  no saved snapshot, and it is passed to git through an askpass script rather than a URL. The deploy key's private
  half lives there too, for the same reason.
- The repository itself contains no keys, tokens or passwords (checked before committing: no private keys; the only
  token-shaped string is a test fixture in `scripts/test-automation.py`).
- Revoke either credential any time: GitHub → Settings → Applications (Authorised OAuth Apps) for the device login,
  or the deploy-keys page for the key.

## What the first commit contains

| | |
|---|---|
| Source | `crates/` (Rust engine, server, desktop), `web/` (TypeScript + MapLibre UI), `apps/desktop/` (Tauri) |
| Recipes | `recipes/` — 15 gallery recipes |
| Scripts | `scripts/` — 28 tools: data generators, benchmark and test suites, packaging, CI helpers |
| Docs | `README.md`, `CHANGELOG.md`, `docs/` (AUTOMATION, DEVICES, FEATURE_MATRIX, USER_GUIDE, VISION), `bench/RESULTS.md` |
| Packaging | `packaging/`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` |
| Evidence | `bench/screenshots/` (66 PNGs, 39 MB, linked from the docs), `bench/*.json` benchmark results (8 KB) |
| Licences | `LICENSE-APACHE`, `LICENSE-MIT` (dual, like the Rust ecosystem) |

Excluded by `.gitignore`: `target/` (build), `node_modules/`, `web/dist/`, `data/`, Tauri generated schemas,
`releases/` (the 1.6.0 `.deb` and `.exe`, 52 MB — CI publishes those as release assets), generated example scenes,
logs, `.mvt` and `.jsonl` scratch files.
