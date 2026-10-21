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

Always open: the static web UI files, `GET /api/health`, and webhook URLs (`/api/hooks/<secret>`), each of
which carries its own secret.

The **phone link** (`--phone`, port 8765) is a separate HTTPS listener with its own pairing secret in the QR code.
The desktop app does not listen on the network.

## Advice

- Treat the token like a password. Use HTTPS (a reverse proxy) when the server is reachable beyond a trusted network.
- Only install plugins and recipes you trust: they run with your user's permissions.
- The bundled MQTT broker allows anonymous access; add a password file before exposing it.

## Reporting a vulnerability

Please report it privately through GitHub's **Security → Report a vulnerability** on
<https://github.com/jmozez/geospax>, not in a public issue.
