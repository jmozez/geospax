//! Request limits for the public guest demo (`--public`): one visitor cannot slow the demo down for
//! everyone. Each client (the address Fly.io's proxy reports) has two
//! token buckets: one for every API and tile request (a map view loads many tiles at once), and a
//! smaller one for requests that change something (uploads, tool runs, edits). Off unless public.

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// (requests per second, burst)
const ALL: (f64, f64) = (40.0, 600.0);
const WRITES: (f64, f64) = (1.0, 30.0);

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn take(&mut self, (rate, burst): (f64, f64), now: Instant) -> bool {
        self.tokens = (self.tokens + now.duration_since(self.at).as_secs_f64() * rate).min(burst);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

pub struct Limits {
    on: bool,
    clients: Mutex<HashMap<String, (Bucket, Bucket)>>,
}

impl Limits {
    pub fn new(on: bool) -> Self {
        Self { on, clients: Mutex::new(HashMap::new()) }
    }

    /// May this client make one more request now?
    fn allow(&self, client: &str, write: bool, now: Instant) -> bool {
        let mut map = self.clients.lock().unwrap();
        if map.len() > 50_000 {
            // forget clients that have been quiet long enough to be full again
            map.retain(|_, (a, _)| now.duration_since(a.at).as_secs_f64() < ALL.1 / ALL.0);
        }
        let (all, writes) = map.entry(client.to_string()).or_insert_with(|| (Bucket { tokens: ALL.1, at: now }, Bucket { tokens: WRITES.1, at: now }));
        all.take(ALL, now) && (!write || writes.take(WRITES, now))
    }
}

/// The visitor's address as Fly.io's proxy reports it (Fly-Client-IP, which the proxy sets itself),
/// else one shared key. X-Forwarded-For is not used: a visitor can write anything there.
fn client(headers: &HeaderMap) -> String {
    headers.get("fly-client-ip").and_then(|v| v.to_str().ok()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or("direct").to_string()
}

pub async fn middleware(State(limits): State<Arc<Limits>>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if limits.on && (path.starts_with("/api/") || path.starts_with("/tiles/")) {
        let write = req.method() != Method::GET && req.method() != Method::HEAD;
        if !limits.allow(&client(req.headers()), write, Instant::now()) {
            return Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::RETRY_AFTER, "5")
                .body(r#"{"error":"too many requests: wait a few seconds"}"#.into())
                .unwrap();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn bursts_then_refills_per_client() {
        let l = Limits::new(true);
        let t0 = Instant::now();
        assert!((0..30).all(|_| l.allow("a", true, t0)));
        assert!(!l.allow("a", true, t0), "the 31st change at once is refused");
        assert!(l.allow("b", true, t0), "another visitor is not affected");
        assert!(l.allow("a", false, t0), "reading still works");
        assert!(l.allow("a", true, t0 + Duration::from_secs(2)), "a token comes back each second");
    }

    #[test]
    fn client_comes_from_the_proxy() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.5".parse().unwrap());
        assert_eq!(client(&h), "direct", "a header the visitor writes is not trusted");
        h.insert("fly-client-ip", "198.51.100.7".parse().unwrap());
        assert_eq!(client(&h), "198.51.100.7");
    }
}
