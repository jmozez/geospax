# Deploying GeoSpaX

Two parts, hosted separately:

| Part | What it is | Where |
|---|---|---|
| Home page (`site/`) | Static page: screenshots, plugins, downloads | Vercel (or any static host) |
| Web edition | The GeoSpaX app in a browser: a server with GDAL and storage | Fly.io (or any container host) |

## Home page on Vercel

1. **Add New › Project**, import the repository.
2. **Root Directory:** `site`. Framework Preset: **Other**. No build command.
3. **Settings › Domains:** add your domain (for example `geospax.in4metrix.dev`) and create the DNS record Vercel shows.

The download buttons read the newest GitHub release by themselves. Once the web edition is online, set
`WEBAPP_URL` at the top of `site/main.js` if visitors should get an "Open the web app" button.

## Web edition on Fly.io

`fly.toml` runs the web edition as a **public guest demo** (`GEOSPAX_PUBLIC=1`, or `--public`):

- no sign-in: anyone with the address can use it;
- each visitor gets a workspace of their own (kept in their browser's id, `?ws=`), so nobody sees anyone
  else's map, and starts clean: dark, Lazy mode, on the globe;
- what could misuse the server is refused: R and Python code, installing plugins or packages, folders of
  the server, devices, saved recipes, server settings and the AI assistant;
- uploads, downloads, run results and guest projects not touched for 7 days are deleted (checked hourly).

One machine runs (the data volume pins it) and it stops when idle, so you pay mostly while it is used.
Also set a monthly spending limit in the Fly billing settings.

Install `flyctl` (<https://fly.io/docs/flyctl/install/>), sign in with `fly auth login`, then from the
repository folder:

```sh
fly launch --copy-config --no-deploy          # creates the app from fly.toml; choose a unique name if asked
fly volumes create geospax_data --size 10 --region syd
fly deploy
```

**A private workspace instead** (one workspace for you, everything allowed): remove the `[env]`
`GEOSPAX_PUBLIC` line from `fly.toml`, run `fly secrets set GEOSPAX_TOKEN=$(openssl rand -hex 24)` and
`fly deploy`, then open `https://<app>.fly.dev/?token=<your token>` once. Keep the token private.

**Your own subdomain:** `fly certs add app.geospax.in4metrix.dev`, then add the CNAME record it shows
(to `<app>.fly.dev`) at your DNS provider.

**Updates:** `fly deploy` pulls the newest release image (`ghcr.io/jmozez/geospax:latest`). Data, runs and
settings stay on the volume.

**Size and cost:** `fly.toml` asks for a shared 2-CPU machine with 2 GB of memory that **stops when idle** and
starts again on the next visit (a few seconds' wait), so you pay mostly while you use it; the volume is billed
all the time. Recipes, triggers and downloads run only while the machine is up: to keep it running, set
`auto_stop_machines = "off"` and `min_machines_running = 1`. Large rasters need more memory:
`fly scale memory 4096`.

## Flathub (the Linux app store)

The Flatpak (`packaging/flatpak/io.github.jmozez.GeoSpaX.yml`) is built and checked in CI. Flathub builds every
app on its own servers without network access, so its copy of the manifest lists the Rust crates and npm
packages as sources. To submit:

1. The offline manifest and both lists are ready in `packaging/flatpak/flathub/`, pointing at tag `v3.0.3`.
   For a later release, change the tag and regenerate the lists with the Flatpak builder tools
   (<https://github.com/flatpak/flatpak-builder-tools>):
   `flatpak-cargo-generator Cargo.lock -o packaging/flatpak/flathub/cargo-sources.json` and
   `flatpak-node-generator npm web/package-lock.json -o packaging/flatpak/flathub/node-sources.json`.
2. Once the tag exists, add `commit: <sha of the tag>` under the `tag:` line (Flathub requires both).
3. Follow <https://docs.flathub.org/docs/for-app-authors/submission>: fork `flathub/flathub`, add the three
   files from `packaging/flatpak/flathub/` on a branch named after the app ID, and open the pull request. Flathub reviews it; the
   app ID `io.github.jmozez.GeoSpaX` is verified from the `jmozez` GitHub account.

After that, each GeoSpaX release is a small pull request to the app's Flathub repository (new tag and commit).

## Publishing a release without pushing a tag

Actions → ci → **Run workflow** on `main`, with *release_tag* set to the new version (for example `v3.0.2`).
The run builds every package and the release job creates the tag and the GitHub release with all files.
Add the `TAURI_SIGNING_PRIVATE_KEY` and Android keystore secrets first, so the update feed and the APK are
signed with the permanent keys.
