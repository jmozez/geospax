# Security

## Who can reach GeoSpaX

The web edition's API can save and run recipes, which may contain R or Python code, and install plugins.
**Anyone who can call the API can run programs on the computer that hosts it**, so access is restricted:

| How it is started | Who can connect | What they need |
| --- | --- | --- |
| `geospax-server` (default `--host 127.0.0.1`) | this computer only | nothing, but requests must be addressed to `localhost`, and other web sites cannot post to it |
| `geospax-server --host 0.0.0.0` (or any non-local address) | the network | the access token |
| Docker (`docker compose up -d`) | this computer (ports are published on `127.0.0.1`) | the access token |

The access token comes from `--token T`, the `GEOSPAX_TOKEN` environment variable, or, if neither is set,
is generated at start (32 random bytes) and printed as a link: `http://host:8080/?token=…`. Opening the
link stores the token in an `HttpOnly`, `SameSite=Strict` cookie. Scripts send `Authorization: Bearer <token>`.

Whoever has the token can use everything, as on the host computer: connect its folders in the Explorer,
add web services and cloud storage, and download (STAC, Overture Maps, online data), all of which make the
host fetch web addresses. Start with `--restricted` (or `GEOSPAX_RESTRICTED=1`) when the token is shared with a
class or a group: folder connections, new web services and downloads are then refused.

Always open: the static web UI files, `GET /api/health`, and webhook URLs (`/api/hooks/<secret>`), each of
which carries its own secret.

The **phone link** (`--phone`, port 8765) is a separate HTTPS listener with its own pairing secret in the QR code.
The desktop app does not listen on the network.

## Advice

- Treat the token like a password. Use HTTPS (a reverse proxy) when the server is reachable beyond a trusted network.
- Only install plugins and recipes you trust: they run with your user's permissions.
- The bundled MQTT broker allows anonymous access; add a password file before exposing it.

## Supply chain

- **Advisory gate.** Every push runs `cargo audit` against the RustSec database and `npm audit` (high and
  critical) for the web app, the desktop shell and the field app. A GitHub release needs this job to pass,
  so a build with a known vulnerability cannot be published. Unmaintained or unsound warnings are listed in
  the log but do not fail the build.
- **SBOM.** Each release carries CycloneDX 1.5 software bills of materials (`*.cdx.json`) for the Rust
  packages (engine, server, desktop) and the npm apps. Make them locally with `scripts/sbom.sh OUT_DIR`
  (needs `cargo install --locked cargo-cyclonedx`).
- **Update signatures.** Installed copies only accept updates signed with the GeoSpaX updater key
  (minisign, public key in `apps/desktop/src-tauri/tauri.conf.json`).
- **Code signing.** The Windows installer is signed when the repository has the `WINDOWS_SIGN_PFX_BASE64`
  and `WINDOWS_SIGN_PASSWORD` secrets (an OV or EV Authenticode certificate as a base64 `.pfx`). Without
  them the installer is built unsigned and Windows SmartScreen warns on first run. macOS builds are not
  packaged yet, so there is no notarisation.

## Reporting a vulnerability

Please report it privately through GitHub's **Security → Report a vulnerability** on
<https://github.com/jmozez/geospax>, not in a public issue.
