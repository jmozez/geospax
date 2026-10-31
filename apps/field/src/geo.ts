// The phone's position: Tauri's geolocation plugin in the app (asks for the permission once), the browser's
// own geolocation when the page runs in a browser (development, tests).

export interface Fix {
  lon: number;
  lat: number;
  /** horizontal accuracy, metres */
  acc: number;
  /** height above the WGS 84 ellipsoid, metres (not above sea level: see elevation.ts) */
  ele: number | null;
  /** vertical accuracy, metres, when the phone reports it */
  altAcc?: number | null;
  t: number;
  /** ground speed, m/s, when the phone reports it */
  speed?: number | null;
  /** direction of travel, degrees from true north, when moving */
  heading?: number | null;
}

export const inApp = '__TAURI_INTERNALS__' in window;

/** Follow the position until the returned function is called. */
export async function watchPosition(onFix: (f: Fix) => void, onError: (msg: string) => void): Promise<() => void> {
  const opts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
  if (inApp) {
    const g = await import('@tauri-apps/plugin-geolocation');
    let perm = await g.checkPermissions();
    if (perm.location !== 'granted') perm = await g.requestPermissions(['location']);
    if (perm.location !== 'granted') {
      onError('Location is off for GeoSpaX Field: allow it in the phone settings.');
      return () => {};
    }
    const id = await g.watchPosition(opts, (pos, err) => {
      if (err || !pos) return onError(String(err ?? 'no position'));
      const c = pos.coords;
      onFix({ lon: c.longitude, lat: c.latitude, acc: c.accuracy, ele: c.altitude ?? null, altAcc: c.altitudeAccuracy ?? null, t: pos.timestamp, speed: c.speed ?? null, heading: c.heading ?? null });
    });
    return () => void g.clearWatch(id);
  }
  if (!navigator.geolocation) {
    onError('This device has no location service.');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({ lon: pos.coords.longitude, lat: pos.coords.latitude, acc: pos.coords.accuracy, ele: pos.coords.altitude, altAcc: pos.coords.altitudeAccuracy, t: pos.timestamp, speed: pos.coords.speed, heading: pos.coords.heading }),
    (e) => onError(e.message || 'no position'),
    opts,
  );
  return () => navigator.geolocation.clearWatch(id);
}

/**
 * Cleans the raw fixes before they are used. Phones hand out a cached last position when the app wakes, a
 * cell-tower or Wi-Fi guess before the GPS locks on, and now and then a jump of hundreds of metres; a
 * point saved from one of those lands in the wrong place. So a fix is only used when it is
 *  - fresh (taken after the app started following the position, not a cached one from before),
 *  - not a coarse network guess (accuracy 100 m or better), and
 *  - not a jump faster than 70 m/s (250 km/h) from the last good fix, unless it is much more accurate.
 * A jump is held back, not thrown away. It is taken as a real move (the last good fix was the wrong one,
 * or the phone really went somewhere else) when
 *  - three jumping fixes in a row agree with each other, or
 *  - nothing has contradicted it for 15 s and it is good to 50 m or better: no fix back near the last good one has come in since. Some
 *    phones (and the Android emulator) only report a new fix when the position changes, so after a move
 *    the second and third fix may never come; `tick()` checks this between fixes.
 * Any fix close to the last good one again cancels the held jump.
 * `best()` then averages the good fixes from the 10 s up to the latest one, weighted by 1/accuracy², which
 * steadies a point taken while standing still; the accuracy it reports is the best single fix's, never
 * better. (Some phones only report a new fix when the position changes, so the window ends at the latest
 * fix rather than now; after 2 minutes without one there is no position.)
 */
export class FixFilter {
  private recent: Fix[] = [];
  /** jumping fixes held back, oldest first, all close to each other */
  private held: Fix[] = [];
  /** when the first held fix came in (the clock of the caller, so a phone's odd timestamps do not matter) */
  private heldSince = 0;
  last: Fix | null = null;

  private since: number;

  /** `since`: when the app started asking for the position (a fix from before that is a cached one). */
  constructor(since = Date.now()) {
    this.since = since;
  }

  /** Returns the fix when it is good enough to use, otherwise null. `now`: when it came in. */
  add(f: Fix, now = f.t): Fix | null {
    if (!Number.isFinite(f.lon) || !Number.isFinite(f.lat) || !Number.isFinite(f.acc)) return null;
    if (f.t < this.since - 5_000 || f.acc > 100) return null;
    const p = this.last;
    if (p && f.t <= p.t) return null; // the same fix again, or an older one
    if (p) {
      const speed = metres([p.lon, p.lat], [f.lon, f.lat]) / ((f.t - p.t) / 1000);
      if (speed > 70 && f.acc > p.acc / 2) {
        const h = this.held[this.held.length - 1];
        if (h && f.t <= h.t) return null;
        // a jump to somewhere else than the held ones starts again from this one
        if (!h || metres([h.lon, h.lat], [f.lon, f.lat]) > Math.max(50, 2 * Math.max(h.acc, f.acc))) {
          this.held = [];
          this.heldSince = now;
        }
        this.held.push(f);
        if (this.held.length < 3) return this.tick(now);
        return this.moved();
      }
    }
    this.held = [];
    this.last = f;
    this.recent = [...this.recent.filter((r) => f.t - r.t <= 10_000), f];
    return f;
  }

  /**
   * Call now and then between fixes (every second or so): a held jump that nothing has contradicted for
   * 15 s becomes the position. Returns the new fix when that happens, otherwise null.
   */
  tick(now = Date.now()): Fix | null {
    const h = this.held[this.held.length - 1];
    if (!h || h.acc > 50 || now - this.heldSince < 15_000) return null;
    return this.moved();
  }

  /** The held jump is a real move: the fixes before it do not belong in the average. */
  private moved(): Fix {
    const h = this.held;
    this.held = [];
    this.last = h[h.length - 1];
    this.recent = h.filter((r) => this.last!.t - r.t <= 10_000);
    return this.last;
  }

  /** The steadiest position for saving a point now, or null with no good fix in the last 2 minutes. */
  best(now = Date.now()): Fix | null {
    if (!this.last || now - this.last.t > 120_000) return null;
    const rs = this.recent;
    const top = Math.min(...rs.map((r) => r.acc));
    // only fixes close to the best one: one poor fix does not pull a good average away
    const use = rs.filter((r) => r.acc <= Math.max(top * 2, 5));
    let w = 0, lon = 0, lat = 0, ele = 0, we = 0, va = Infinity;
    for (const r of use) {
      const k = 1 / Math.max(r.acc, 1) ** 2;
      w += k; lon += r.lon * k; lat += r.lat * k;
      if (r.ele != null) { ele += r.ele * k; we += k; if (r.altAcc != null) va = Math.min(va, r.altAcc); }
    }
    const lastT = use[use.length - 1].t;
    return { lon: lon / w, lat: lat / w, acc: top, ele: we ? ele / we : null, altAcc: we && va < Infinity ? va : null, t: lastT };
  }
}

/** Distance in metres (haversine). */
export function metres(a: [number, number], b: [number, number]): number {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
