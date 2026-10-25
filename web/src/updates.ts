// New versions (Help › About and a check when the desktop app starts). The Windows edition installed
// with the setup program updates itself: Tauri's updater reads latest.json from the newest GitHub
// release, checks the installer's signature against the key built into the app, installs it and
// restarts. The .deb, the portable ZIP and the web edition are told a new version is out, with a link.
import { newer, renderMarkdown } from './docs';

const REPO = 'https://github.com/jmozez/geospax';
const desktop = '__TAURI_INTERNALS__' in window;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface FoundUpdate {
  version: string;
  notes: string;
  /** the release page */
  url: string;
  /** true: installUpdate() can install it in place */
  installable: boolean;
}

async function tauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** The newest release when it is newer than `current`, else null (throws when there is no answer). */
export async function findUpdate(current: string): Promise<FoundUpdate | null> {
  if (desktop && (await tauri<string>('update_kind').catch(() => 'notice')) === 'installer') {
    // a release without an update feed (latest.json) falls through to the plain notice below
    const u = await tauri<{ version: string; notes?: string } | null>('update_check').catch(() => undefined);
    if (u !== undefined) return u ? { version: u.version, notes: u.notes ?? '', url: `${REPO}/releases/tag/v${u.version}`, installable: true } : null;
  }
  const res = await fetch('https://api.github.com/repos/jmozez/geospax/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const r = (await res.json()) as { tag_name: string; html_url: string; body?: string };
  const latest = r.tag_name.replace(/^v/, '');
  return !current || newer(latest, current) ? { version: latest, notes: r.body ?? '', url: r.html_url, installable: false } : null;
}

/** Download, check and install the update findUpdate() found, then restart (desktop installer only). */
export async function installUpdate(progress: (done: number, total: number | null) => void): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event');
  const stop = await listen<{ done: number; total: number | null }>('update-progress', (e) => progress(e.payload.done, e.payload.total));
  try {
    await tauri('update_install');
  } finally {
    stop();
  }
}

/** The "Update available" text and buttons for `u` inside `box` (About, the start-up banner). */
export function showUpdate(box: HTMLElement, u: FoundUpdate, onLater?: () => void) {
  box.innerHTML = `<span>GeoSpaX <b>${esc(u.version)}</b> is available.</span>
    ${u.installable ? '<button type="button" class="upd-install primary">Install and restart</button>' : `<a class="upd-download" href="${esc(u.url)}" target="_blank" rel="noopener">Download</a>`}
    ${onLater ? '<button type="button" class="upd-later">Later</button>' : ''}
    ${u.notes ? `<details><summary>What's new</summary><div class="doc">${renderMarkdown(u.notes)}</div></details>` : ''}
    <span class="upd-msg" aria-live="polite"></span>`;
  box.querySelector('.upd-later')?.addEventListener('click', () => onLater?.());
  const btn = box.querySelector<HTMLButtonElement>('.upd-install');
  const msg = box.querySelector<HTMLElement>('.upd-msg')!;
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    msg.textContent = 'Downloading…';
    try {
      await installUpdate((done, total) => {
        msg.textContent = total ? `Downloading… ${Math.round((done / total) * 100)} %` : `Downloading… ${(done / 1e6).toFixed(1)} MB`;
      });
      msg.textContent = 'Installing; GeoSpaX restarts by itself.';
    } catch (e) {
      btn.disabled = false;
      msg.innerHTML = `Could not update (${esc(String((e as Error).message ?? e))}) · <a href="${esc(u.url)}" target="_blank" rel="noopener">download it yourself</a>`;
    }
  });
}

const KEY = 'geospax.update.v1';

/** Desktop only: look for a new version once a day when the app starts; a banner offers it. */
export async function startupCheck(current: string) {
  if (!desktop || !current) return;
  let seen: { at?: number; later?: string } = {};
  try { seen = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* private window */ }
  if (seen.at && Date.now() - seen.at < 86_400_000) return;
  const save = (v: typeof seen) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } };
  let u: FoundUpdate | null;
  try {
    u = await findUpdate(current);
  } catch {
    return; // offline: try again next start
  }
  save({ ...seen, at: Date.now() });
  if (!u || seen.later === u.version) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  document.body.append(bar);
  showUpdate(bar, u, () => {
    save({ at: Date.now(), later: u!.version });
    bar.remove();
  });
}
