// An external GNSS receiver over Bluetooth: reads its NMEA sentences (GGA, RMC, GST, GSA) and turns them into
// fixes like the phone's own, with the fix quality (single, DGPS, RTK float or fixed), satellites and DOP.
// Browsers with Web Bluetooth connect to receivers that send NMEA over a BLE serial service (Nordic UART,
// HM-10 and similar). On a phone without that, receivers are used through the phone's mock location setting.
import type { Fix } from './geo';

export type Quality = 'none' | 'single' | 'dgps' | 'pps' | 'rtk-fixed' | 'rtk-float' | 'estimated' | 'manual' | 'sim';
export const QUALITY_LABEL: Record<Quality, string> = {
  none: 'No fix', single: 'GPS', dgps: 'DGPS', pps: 'PPS', 'rtk-fixed': 'RTK fixed', 'rtk-float': 'RTK float', estimated: 'Dead reckoning', manual: 'Manual', sim: 'Simulated',
};
const GGA_QUALITY: Quality[] = ['none', 'single', 'dgps', 'pps', 'rtk-fixed', 'rtk-float', 'estimated', 'manual', 'sim'];
/** A rough 1-sigma error per unit of HDOP for each kind of fix, used when the receiver sends no GST. */
const UERE: Partial<Record<Quality, number>> = { single: 4, dgps: 1, pps: 3, 'rtk-fixed': 0.015, 'rtk-float': 0.3, estimated: 10 };

export interface GnssFix extends Fix { quality: Quality; sats: number | null; hdop: number | null; pdop?: number | null; vdop?: number | null; age?: number | null }

/** Checks an NMEA sentence's checksum and splits it: ['GGA', ...fields] (talker ID dropped), or null. */
export function sentence(line: string): string[] | null {
  const m = line.trim().match(/^\$([A-Z]{2})([A-Z]{3}),(.*)\*([0-9A-Fa-f]{2})$/);
  if (!m) return null;
  const body = `${m[1]}${m[2]},${m[3]}`;
  let x = 0;
  for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
  if (x !== parseInt(m[4], 16)) return null;
  return [m[2], ...m[3].split(',')];
}

/** ddmm.mmmm with a hemisphere to signed degrees. */
export function nmeaDeg(v: string, hemi: string): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const d = Math.floor(n / 100);
  const out = d + (n - d * 100) / 60;
  return hemi === 'S' || hemi === 'W' ? -out : out;
}
const num = (s: string | undefined) => (s != null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);

/** Builds fixes from a stream of NMEA text: one fix per GGA, using the latest RMC, GST and GSA with it. */
export class Nmea {
  private buf = '';
  private speed: number | null = null;
  private heading: number | null = null;
  private date: string | null = null;
  private gst: { t: string; lat: number; lon: number; alt: number | null } | null = null;
  private dop: { p: number | null; h: number | null; v: number | null } | null = null;
  /** sentences read and rejected (bad checksum), for the status page */
  good = 0;
  bad = 0;

  /** Feeds text as it arrives (it may split sentences anywhere); returns the fixes completed by it. */
  feed(text: string, now = Date.now()): GnssFix[] {
    this.buf += text;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() ?? '';
    if (this.buf.length > 4096) this.buf = '';
    const out: GnssFix[] = [];
    for (const l of lines) {
      if (!l.trim().startsWith('$')) continue;
      const s = sentence(l);
      if (!s) { this.bad++; continue; }
      this.good++;
      const f = this.read(s, now);
      if (f) out.push(f);
    }
    return out;
  }

  read(s: string[], now = Date.now()): GnssFix | null {
    const [type] = s;
    if (type === 'RMC') {
      if (s[2] !== 'A') { this.speed = null; this.heading = null; return null; }
      const kn = num(s[7]);
      this.speed = kn != null ? kn * 0.514444 : null;
      this.heading = num(s[8]);
      this.date = s[9] || null;
      return null;
    }
    if (type === 'GST') {
      const lat = num(s[6]), lon = num(s[7]);
      this.gst = lat != null && lon != null ? { t: s[1], lat, lon, alt: num(s[8]) } : null;
      return null;
    }
    if (type === 'GSA') {
      this.dop = { p: num(s[15]), h: num(s[16]), v: num(s[17]?.split('*')[0]) };
      return null;
    }
    if (type !== 'GGA') return null;
    const quality = GGA_QUALITY[Number(s[6])] ?? 'none';
    const lat = nmeaDeg(s[2], s[3]), lon = nmeaDeg(s[4], s[5]);
    if (quality === 'none' || lat == null || lon == null) return null;
    const hdop = num(s[8]);
    const msl = num(s[9]), sep = num(s[11]);
    // GST errors for this epoch when the receiver sends them, otherwise HDOP times a typical error
    const g = this.gst && this.gst.t === s[1] ? this.gst : null;
    const acc = g ? Math.hypot(g.lat, g.lon) : (hdop ?? 2) * (UERE[quality] ?? 5);
    return {
      lon, lat, acc,
      ele: msl != null ? msl + (sep ?? 0) : null,
      altAcc: g?.alt ?? (this.dop?.v != null ? this.dop.v * (UERE[quality] ?? 5) : null),
      t: utc(s[1], this.date, now),
      speed: this.speed, heading: this.speed != null && this.speed > 0.5 ? this.heading : null,
      quality, sats: num(s[7]), hdop, pdop: this.dop?.p ?? null, vdop: this.dop?.v ?? null, age: num(s[13]),
    };
  }
}

/** The receiver's UTC time of day (and date from RMC when known) as a timestamp; the clock's date otherwise. */
export function utc(hhmmss: string, ddmmyy: string | null, now: number): number {
  const m = hhmmss.match(/^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/);
  if (!m) return now;
  const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
  if (ddmmyy && /^\d{6}$/.test(ddmmyy)) return Date.UTC(2000 + Number(ddmmyy.slice(4)), Number(ddmmyy.slice(2, 4)) - 1, Number(ddmmyy.slice(0, 2))) + ms;
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + ms;
  // just after midnight UTC a fix from just before it belongs to yesterday
  if (t - now > 12 * 3600_000) t -= 86_400_000;
  return t;
}

/** Accuracy as people read it: centimetres under a metre. */
export function fmtAcc(m: number): string {
  if (m < 0.995) return `±${Math.max(1, Math.round(m * 100))} cm`;
  return m < 9.95 ? `±${m.toFixed(1)} m` : `±${Math.round(m)} m`;
}

// ------------------------------------------------------------------ Web Bluetooth
const SERVICES = [
  { service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', rx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e' }, // Nordic UART
  { service: '0000ffe0-0000-1000-8000-00805f9b34fb', rx: '0000ffe1-0000-1000-8000-00805f9b34fb' }, // HM-10 style
];
interface BtChar { startNotifications(): Promise<unknown>; addEventListener(t: string, f: (e: Event) => void): void; value?: DataView }
interface BtDevice { name?: string; gatt?: { connect(): Promise<{ getPrimaryService(u: string): Promise<{ getCharacteristic(u: string): Promise<BtChar> }> }>; disconnect(): void; connected: boolean }; addEventListener(t: string, f: () => void): void }
interface BtNav { bluetooth?: { requestDevice(o: unknown): Promise<BtDevice> } }

export const canBluetooth = () => !!(navigator as unknown as BtNav).bluetooth;

export interface Receiver { name: string; nmea: Nmea; disconnect(): void }
/** Asks for a receiver, connects and streams its fixes until it is disconnected. */
export async function connectReceiver(onFix: (f: GnssFix) => void, onGone: () => void): Promise<Receiver> {
  const bt = (navigator as unknown as BtNav).bluetooth;
  if (!bt) throw new Error('This browser has no Bluetooth. Pair the receiver in the phone settings and turn on its mock location instead.');
  const dev = await bt.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES.map((s) => s.service) });
  const server = await dev.gatt!.connect();
  let ch: BtChar | null = null;
  for (const s of SERVICES) {
    try { ch = await (await server.getPrimaryService(s.service)).getCharacteristic(s.rx); break; } catch { /* not this one */ }
  }
  if (!ch) { dev.gatt!.disconnect(); throw new Error(`${dev.name ?? 'That device'} has no Bluetooth serial service GeoSpaX Field can read NMEA from.`); }
  const nmea = new Nmea();
  const dec = new TextDecoder();
  ch.addEventListener('characteristicvaluechanged', (e) => {
    const v = (e.target as unknown as BtChar).value;
    if (v) for (const f of nmea.feed(dec.decode(v, { stream: true }))) onFix(f);
  });
  await ch.startNotifications();
  dev.addEventListener('gattserverdisconnected', onGone);
  return { name: dev.name || 'GNSS receiver', nmea, disconnect: () => dev.gatt?.connected && dev.gatt.disconnect() };
}
