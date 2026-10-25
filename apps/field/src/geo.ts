// The phone's position: Tauri's geolocation plugin in the app (asks for the permission once), the browser's
// own geolocation when the page runs in a browser (development, tests).

export interface Fix {
  lon: number;
  lat: number;
  /** horizontal accuracy, metres */
  acc: number;
  ele: number | null;
  t: number;
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
      onFix({ lon: c.longitude, lat: c.latitude, acc: c.accuracy, ele: c.altitude ?? null, t: pos.timestamp });
    });
    return () => void g.clearWatch(id);
  }
  if (!navigator.geolocation) {
    onError('This device has no location service.');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({ lon: pos.coords.longitude, lat: pos.coords.latitude, acc: pos.coords.accuracy, ele: pos.coords.altitude, t: pos.timestamp }),
    (e) => onError(e.message || 'no position'),
    opts,
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** Distance in metres (haversine). */
export function metres(a: [number, number], b: [number, number]): number {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
