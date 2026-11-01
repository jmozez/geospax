// Bluetooth GNSS receivers in the Android app. Its web view has no Web Bluetooth, so the app's own plugin
// (src-tauri/plugins/gnss) lists paired and nearby receivers and connects over Bluetooth Classic (the
// serial port profile) or Bluetooth LE (Nordic UART or HM-10); the text it streams goes through the same
// NMEA parser as in the browser (gnss.ts Nmea).
import { inApp } from './geo';
import { Nmea, type GnssFix, type Receiver } from './gnss';

export interface BtDevice { name: string; address: string; type: 'classic' | 'ble' | 'dual'; paired: boolean }
/** What the plugin sends on the data channel: receiver text, or the end of the connection. */
export interface BtMessage { text?: string; closed?: boolean; error?: string | null }
/** The Tauri calls, separate so the tests can stand in for the phone. */
export interface Bridge {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  channel(on: (m: BtMessage) => void): unknown;
}

export const canNativeBluetooth = () => inApp && /Android/i.test(navigator.userAgent);
/** Classic and dual-mode receivers use the serial port profile (what survey receivers speak); LE-only ones BLE UART. */
export const modeFor = (d: Pick<BtDevice, 'type'>): 'spp' | 'ble' => (d.type === 'ble' ? 'ble' : 'spp');
export const TYPE_LABEL: Record<BtDevice['type'], string> = { classic: 'Bluetooth Classic', ble: 'Bluetooth LE', dual: 'Classic and LE' };

let tauri: Bridge | null = null;
async function bridge(): Promise<Bridge> {
  if (tauri) return tauri;
  const core = await import('@tauri-apps/api/core');
  tauri = {
    invoke: (cmd, args) => core.invoke(cmd, args),
    channel: (on) => { const c = new core.Channel<BtMessage>(); c.onmessage = on; return c; },
  };
  return tauri;
}

/** Ask for Nearby devices (Android 12 and newer) if it is not allowed yet. */
export async function ensurePermission(b?: Bridge) {
  const br = b ?? (await bridge());
  let p = await br.invoke<{ bluetooth?: string } | null>('plugin:gnss|check_permissions');
  if (p?.bluetooth !== 'granted') p = await br.invoke('plugin:gnss|request_permissions', { permissions: ['bluetooth'] });
  if (p?.bluetooth !== 'granted') throw new Error('Bluetooth is not allowed for GeoSpaX Field: allow Nearby devices for it in the phone settings.');
}

/** Paired receivers first, then BLE ones found nearby, each by name. */
export function sortDevices(ds: BtDevice[]): BtDevice[] {
  return [...ds].sort((a, b) => Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name));
}

export async function listDevices(scanMs = 4000, b?: Bridge): Promise<BtDevice[]> {
  const br = b ?? (await bridge());
  await ensurePermission(br);
  const r = await br.invoke<{ devices: BtDevice[] }>('plugin:gnss|devices', { scanMs });
  return sortDevices(r.devices ?? []);
}

export async function connectNative(d: BtDevice, onFix: (f: GnssFix) => void, onGone: (error: string | null) => void, b?: Bridge): Promise<Receiver> {
  const br = b ?? (await bridge());
  await ensurePermission(br);
  const nmea = new Nmea();
  let open = true;
  const ch = br.channel((m) => {
    if (m.text) for (const f of nmea.feed(m.text)) onFix(f);
    if (m.closed && open) { open = false; onGone(m.error ?? null); }
  });
  const r = await br.invoke<{ name?: string }>('plugin:gnss|connect', { address: d.address, mode: modeFor(d), onData: ch });
  return { name: r?.name || d.name, nmea, disconnect: () => { open = false; void br.invoke('plugin:gnss|disconnect'); } };
}
