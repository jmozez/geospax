// Photo bearings and voice notes. The bearing is where the camera faced when the photo was taken, from the
// phone's compass (magnetic north, averaged over the last two seconds so a shaky hand does not swing it).
// Voice notes are recorded on the phone and kept with the record, the same as photos.

/** One compass reading from a deviceorientation event (Android: absolute alpha; iOS: webkitCompassHeading). */
export interface Orientation { alpha?: number | null; absolute?: boolean; webkitCompassHeading?: number | null }

/** Compass bearing in degrees (0 = north, clockwise) for the back camera, or null when the event has none. */
export function headingFrom(e: Orientation, screenAngle = 0): number | null {
  if (e.webkitCompassHeading != null && Number.isFinite(e.webkitCompassHeading)) return norm(e.webkitCompassHeading + screenAngle);
  if (e.absolute && e.alpha != null && Number.isFinite(e.alpha)) return norm(360 - e.alpha + screenAngle);
  return null;
}
export const norm = (d: number) => ((d % 360) + 360) % 360;

/** Mean of angles (350° and 10° average to 0°, not 180°); null for none or when they cancel out. */
export function meanAngle(degs: number[]): number | null {
  if (!degs.length) return null;
  let x = 0, y = 0;
  for (const d of degs) { x += Math.cos((d * Math.PI) / 180); y += Math.sin((d * Math.PI) / 180); }
  if (Math.hypot(x, y) / degs.length < 0.2) return null;
  return norm((Math.atan2(y, x) * 180) / Math.PI);
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** 237 → "237° WSW" */
export function fmtBearing(d: number | null | undefined): string {
  if (d == null) return 'no compass';
  return `${Math.round(norm(d)) % 360}° ${POINTS[Math.round(norm(d) / 22.5) % 16]}`;
}

/** Keeps the last two seconds of compass readings. */
export class Compass {
  private readings: { t: number; d: number }[] = [];
  private windowMs: number;
  constructor(windowMs = 2000) { this.windowMs = windowMs; }
  add(d: number | null, t: number) {
    if (d == null) return;
    this.readings.push({ t, d });
    this.readings = this.readings.filter((r) => t - r.t <= this.windowMs);
  }
  bearing(now: number): number | null {
    return meanAngle(this.readings.filter((r) => now - r.t <= this.windowMs).map((r) => r.d));
  }
}

let compass: Compass | null = null;
/** Start listening to the compass (once); returns the shared reader. */
export function startCompass(): Compass {
  if (compass) return compass;
  compass = new Compass();
  const c = compass;
  const on = (e: Event) => {
    const angle = (screen as unknown as { orientation?: { angle?: number } }).orientation?.angle ?? 0;
    c.add(headingFrom(e as unknown as Orientation, angle), Date.now());
  };
  // Android Chrome and WebView send absolute readings on their own event; iOS on the ordinary one
  window.addEventListener('deviceorientationabsolute', on);
  window.addEventListener('deviceorientation', on);
  return c;
}
/** iOS asks before giving the compass; elsewhere this does nothing. Call from a tap. */
export async function askCompass() {
  const D = (globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  try { await D?.requestPermission?.(); } catch { /* refused: photos are saved without a bearing */ }
}

// ------------------------------------------------------------------ voice notes
export interface Voice { id: string; name: string; blob: Blob; ts: number; ms: number; lon: number | null; lat: number | null }

const MIMES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
/** The first recording format the phone supports ('' lets the phone choose). */
export function pickMime(supported: (m: string) => boolean): string {
  return MIMES.find((m) => { try { return supported(m); } catch { return false; } }) ?? '';
}
export function voiceExt(mime: string) {
  return mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
}
export function voiceName(ts: number, mime: string) {
  return `voice-${new Date(ts).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${voiceExt(mime)}`;
}
/** 75000 → "1:15" */
export function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** The longest voice note: five minutes, so one note never fills the phone. */
export const MAX_VOICE_MS = 5 * 60_000;

export interface Recording { stop(): Promise<{ blob: Blob; ms: number; mime: string }>; cancel(): void; started: number }
/** Start recording from the microphone. Throws with a plain message when there is none or it is refused. */
export async function startVoice(): Promise<Recording> {
  const MR = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR || !navigator.mediaDevices?.getUserMedia) throw new Error('This phone cannot record sound here');
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { throw new Error('No microphone, or it was not allowed'); }
  const mime = pickMime((m) => MR.isTypeSupported(m));
  const rec = new MR(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const started = Date.now();
  rec.start(1000);
  const end = () => stream.getTracks().forEach((t) => t.stop());
  return {
    started,
    stop: () => new Promise((resolve) => {
      rec.onstop = () => { end(); const type = rec.mimeType || mime || 'audio/webm'; resolve({ blob: new Blob(chunks, { type }), ms: Date.now() - started, mime: type }); };
      rec.stop();
    }),
    cancel: () => { rec.onstop = end; if (rec.state !== 'inactive') rec.stop(); else end(); },
  };
}
