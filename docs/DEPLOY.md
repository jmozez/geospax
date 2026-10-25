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

The web edition is **one workspace**: everyone signed in with the access token sees and changes the same
layers and projects, and the token gives full control. Host it as your own GeoSpaX in the browser, not as an
open site for anonymous visitors.

Install `flyctl` (<https://fly.io/docs/flyctl/install/>), sign in with `fly auth login`, then from the
repository folder:

```sh
fly launch --copy-config --no-deploy          # creates the app from fly.toml; choose a unique name if asked
fly volumes create geospax_data --size 10 --region syd
fly secrets set GEOSPAX_TOKEN=$(openssl rand -hex 24)
fly deploy
```

Open `https://<app>.fly.dev/?token=<your token>` once; the browser remembers it. Keep the token private.

**Your own subdomain:** `fly certs add app.geospax.in4metrix.dev`, then add the CNAME record it shows
(to `<app>.fly.dev`) at your DNS provider.

**Updates:** `fly deploy` pulls the newest release image (`ghcr.io/jmozez/geospax:latest`). Data, runs and
settings stay on the volume.

**Size and cost:** `fly.toml` asks for a shared 2-CPU machine with 2 GB of memory that **stops when idle** and
starts again on the next visit (a few seconds' wait), so you pay mostly while you use it; the volume is billed
all the time. Recipes, triggers and downloads run only while the machine is up: to keep it running, set
`auto_stop_machines = "off"` and `min_machines_running = 1`. Large rasters need more memory:
`fly scale memory 4096`.
