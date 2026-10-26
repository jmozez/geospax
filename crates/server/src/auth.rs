//! Who may call the web edition's API.
//!
//! The API can save and run recipes (which may hold R or Python code) and install plugins, so it must
//! never be open to whoever can reach the port:
//!
//! - **Token mode** (`--token`, `GEOSPAX_TOKEN`, or generated when listening beyond this computer):
//!   every /api and /tiles request needs the token, as `Authorization: Bearer …`, the `geospax_token`
//!   cookie, or `?token=…` (which also sets the cookie, so the printed link logs the browser in).
//! - **Local mode** (loopback address and no token): only this computer can connect; requests must
//!   name a local `Host` (stops DNS rebinding) and, when a browser sends `Origin`, come from the
//!   same host (stops other web sites posting to localhost).
//!
//! - **Public guest demo** (`--public`): no token and any `Host` (the server sits behind its own
//!   domain), but still same-origin only; what a guest may do is limited in the engine (guest.rs).
//!
//! Always open: static files, `GET /api/health`, and `/api/hooks/{token}` (webhooks carry their own
//! secret token).

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use std::net::IpAddr;
use std::sync::Arc;

pub const COOKIE: &str = "geospax_token";

#[derive(Clone, Debug)]
pub struct Auth {
    /// `None`: local mode
    pub token: Option<String>,
    /// public guest demo: any host name, but still no cross-site requests
    pub public: bool,
}

/// True for 127.0.0.0/8, ::1 and `localhost`.
pub fn is_loopback(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost")
        || h.parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// 32 random bytes as hex, from the operating system's generator.
pub fn new_token() -> String {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("no random source for the access token");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Compare without leaking how many leading bytes matched.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Strip the port from a `Host` value: `localhost:8080` → `localhost`, `[::1]:80` → `[::1]`.
fn host_only(h: &str) -> &str {
    if h.starts_with('[') {
        return h.split_inclusive(']').next().unwrap_or(h);
    }
    h.rsplit_once(':').map(|(a, _)| a).unwrap_or(h)
}

fn query_token(query: &str) -> Option<&str> {
    query.split('&').find_map(|kv| kv.strip_prefix("token="))
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix(COOKIE)?.strip_prefix('='))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn is_public(method: &Method, path: &str) -> bool {
    (method == Method::GET && path == "/api/health") || path.starts_with("/api/hooks/")
}

fn needs_check(path: &str) -> bool {
    path.starts_with("/api/") || path.starts_with("/tiles/")
}

/// Why a request is refused, or `None` if it may go on.
pub fn refuse(
    auth: &Auth,
    method: &Method,
    path: &str,
    query: &str,
    headers: &HeaderMap,
) -> Option<&'static str> {
    if !needs_check(path) || is_public(method, path) {
        return None;
    }
    match &auth.token {
        Some(t) => {
            let given = bearer_token(headers)
                .or_else(|| cookie_token(headers))
                .or_else(|| query_token(query));
            match given {
                Some(g) if same(g, t) => None,
                _ => Some("access token required: open the link geospax-server printed at start"),
            }
        }
        None => {
            let host = headers
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !auth.public && !is_loopback(host_only(host)) {
                return Some("this server only answers requests addressed to localhost");
            }
            if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
                let o = origin.split("://").nth(1).unwrap_or("");
                if !o.eq_ignore_ascii_case(host) {
                    return Some("cross-site request refused");
                }
            }
            None
        }
    }
}

pub async fn middleware(State(auth): State<Arc<Auth>>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    if let Some(why) = refuse(&auth, req.method(), &path, &query, req.headers()) {
        let status = if auth.token.is_some() {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        return Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({ "error": why }).to_string()))
            .unwrap();
    }
    // `?token=` on any page: remember it in a cookie so the UI's own requests carry it
    let login = match (&auth.token, query_token(&query)) {
        (Some(t), Some(q)) if same(q, t) => Some(t.clone()),
        _ => None,
    };
    let mut res = next.run(req).await;
    if let Some(t) = login {
        if let Ok(v) =
            HeaderValue::from_str(&format!("{COOKIE}={t}; Path=/; HttpOnly; SameSite=Strict"))
        {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(k.clone(), HeaderValue::from_str(v).unwrap());
        }
        m
    }
    const POST: Method = Method::POST;

    #[test]
    fn token_mode_refuses_unauthenticated_api_calls() {
        let a = Auth {
            token: Some("s3cret".into()),
            public: false,
        };
        let none = HeaderMap::new();
        for p in [
            "/api/recipes",
            "/api/plugins/import",
            "/api/recipes/x/run",
            "/tiles/a/0/0/0.mvt",
        ] {
            assert!(refuse(&a, &POST, p, "", &none).is_some(), "{p}");
        }
        assert!(refuse(&a, &POST, "/api/recipes", "token=wrong", &none).is_some());
        assert!(refuse(
            &a,
            &POST,
            "/api/recipes",
            "",
            &h(&[(header::AUTHORIZATION, "Bearer s3cret")])
        )
        .is_none());
        assert!(refuse(
            &a,
            &POST,
            "/api/recipes",
            "",
            &h(&[(header::COOKIE, "a=1; geospax_token=s3cret")])
        )
        .is_none());
        assert!(refuse(&a, &POST, "/api/recipes", "x=1&token=s3cret", &none).is_none());
    }

    #[test]
    fn public_paths_stay_open() {
        let a = Auth {
            token: Some("s3cret".into()),
            public: false,
        };
        let none = HeaderMap::new();
        assert!(refuse(&a, &Method::GET, "/api/health", "", &none).is_none());
        assert!(refuse(&a, &POST, "/api/hooks/abc", "", &none).is_none());
        assert!(refuse(&a, &Method::GET, "/index.html", "", &none).is_none());
    }

    #[test]
    fn local_mode_refuses_rebinding_and_cross_site() {
        let a = Auth { token: None, public: false };
        let ok = h(&[
            (header::HOST, "localhost:8080"),
            (header::ORIGIN, "http://localhost:8080"),
        ]);
        assert!(refuse(&a, &POST, "/api/recipes", "", &ok).is_none());
        assert!(refuse(
            &a,
            &POST,
            "/api/recipes",
            "",
            &h(&[(header::HOST, "127.0.0.1:8080")])
        )
        .is_none());
        assert!(refuse(
            &a,
            &POST,
            "/api/recipes",
            "",
            &h(&[(header::HOST, "[::1]:8080")])
        )
        .is_none());
        assert!(refuse(
            &a,
            &POST,
            "/api/recipes",
            "",
            &h(&[(header::HOST, "evil.example:8080")])
        )
        .is_some());
        let csrf = h(&[
            (header::HOST, "localhost:8080"),
            (header::ORIGIN, "https://evil.example"),
        ]);
        assert!(refuse(&a, &POST, "/api/recipes", "", &csrf).is_some());
    }

    #[test]
    fn public_demo_answers_its_own_domain_only() {
        let a = Auth { token: None, public: true };
        let ok = h(&[
            (header::HOST, "geospax.fly.dev"),
            (header::ORIGIN, "https://geospax.fly.dev"),
        ]);
        assert!(refuse(&a, &Method::GET, "/api/layers", "", &ok).is_none());
        assert!(refuse(&a, &Method::GET, "/api/layers", "", &h(&[(header::HOST, "geospax.fly.dev")])).is_none());
        let csrf = h(&[
            (header::HOST, "geospax.fly.dev"),
            (header::ORIGIN, "https://evil.example"),
        ]);
        assert!(refuse(&a, &POST, "/api/upload", "", &csrf).is_some());
    }

    #[test]
    fn loopback_and_tokens() {
        assert!(
            is_loopback("127.0.0.1")
                && is_loopback("::1")
                && is_loopback("[::1]")
                && is_loopback("localhost")
        );
        assert!(!is_loopback("0.0.0.0") && !is_loopback("192.168.1.5"));
        let t = new_token();
        assert_eq!(t.len(), 64);
        assert_ne!(t, new_token());
    }
}
