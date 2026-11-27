// Links to the outside world (GitHub releases, the guide, Overture, plugin home pages). In a browser a
// link with target="_blank" opens a new tab. The desktop window (Tauri) has no tabs and ignores such
// links and window.open(), so there they go to the computer's default browser through the opener plugin.
// Links to the engine itself (gis:, *.localhost, this page's own origin) are left alone.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** true when this page runs inside the desktop app (Tauri) */
export const inDesktop = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** true for an http(s) or mailto address that is not part of the app (`base`: this page's address) */
export function isExternal(href: string, base: string): boolean {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return false;
  }
  if (u.protocol === 'mailto:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost')) return false;
  try {
    if (u.origin === new URL(base).origin) return false;
  } catch {
    /* base without an origin (gis:, tauri:): every http(s) address is outside */
  }
  return true;
}

/** Open `url` outside the app: the default browser on the desktop, a new tab in the web edition. */
export async function openExternal(url: string): Promise<void> {
  if (inDesktop() && isExternal(url, location.href)) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch (e) {
      console.warn('could not open the browser', e);
    }
  }
  window.open(url, '_blank', 'noopener');
}

/**
 * Send clicks on outside links within `root` to `open` (the desktop app: openExternal). Clicks another
 * handler has already dealt with, modified clicks and download links are left to the webview.
 */
export function routeExternalLinks(root: Pick<Document, 'addEventListener'>, base: () => string, open: (url: string) => unknown = openExternal) {
  root.addEventListener('click', (ev: Event) => {
    const e = ev as MouseEvent;
    if (e.defaultPrevented || (e.button ?? 0) !== 0) return;
    const t = e.target as Element | null;
    const a = t && typeof t.closest === 'function' ? (t.closest('a[href]') as HTMLAnchorElement | null) : null;
    if (!a || a.hasAttribute('download')) return;
    const href = a.getAttribute('href') ?? '';
    if (!isExternal(href, base())) return;
    e.preventDefault();
    void open(new URL(href, base()).href);
  });
}

/** Desktop only: every outside link in this window opens in the default browser. */
export function wireExternalLinks() {
  if (inDesktop()) routeExternalLinks(document, () => location.href);
}
