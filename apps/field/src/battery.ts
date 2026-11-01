// Battery saver: on by choice, or automatically when the battery runs low and the phone is not charging.
// It keeps the GPS at full accuracy while it is in use (points need it), but stops it while the app is in
// the background with nothing being recorded, draws the map at a lower resolution, refreshes the
// navigation box less often and lets the screen turn off.
export type SaverMode = 'off' | 'auto' | 'on';
export const SAVER_LABEL: Record<SaverMode, string> = { off: 'Off', auto: 'When the battery is below 20%', on: 'Always' };
export interface Battery { level: number; charging: boolean }

/** Whether the saver is on now. */
export function saverOn(mode: SaverMode, b: Battery | null, threshold = 0.2): boolean {
  if (mode === 'on') return true;
  if (mode === 'off' || !b) return false;
  return !b.charging && b.level <= threshold;
}
/** Whether the GPS should run: always in front; in the background only when something is being recorded or followed. */
export function gpsWanted(saver: boolean, hidden: boolean, busy: boolean): boolean {
  return !saver || !hidden || busy;
}
export interface Plan { pixelRatio: number | null; navMs: number; keepAwake: boolean }
/** What the saver changes: map resolution (null = the screen's own), navigation refresh, screen kept on. */
export function plan(saver: boolean, keepAwake: boolean, dpr: number): Plan {
  return saver ? { pixelRatio: Math.min(dpr, 1), navMs: 1000, keepAwake: false } : { pixelRatio: null, navMs: 300, keepAwake };
}
export const fmtBattery = (b: Battery | null) => (b ? `${Math.round(b.level * 100)}%${b.charging ? ', charging' : ''}` : 'not reported');

interface BatteryManager extends Battery { addEventListener(t: string, f: () => void): void }
/** Follows the battery where the browser reports it (Chrome and the Android web view do). */
export async function watchBattery(on: (b: Battery) => void): Promise<boolean> {
  const g = (navigator as unknown as { getBattery?: () => Promise<BatteryManager> }).getBattery;
  if (!g) return false;
  try {
    const m = await g.call(navigator);
    const send = () => on({ level: m.level, charging: m.charging });
    m.addEventListener('levelchange', send);
    m.addEventListener('chargingchange', send);
    send();
    return true;
  } catch { return false; }
}
