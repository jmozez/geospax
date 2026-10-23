// The download gauge: while Online data (or any recipe step that downloads) is fetching, a small
// panel over the map shows what is coming, a bar, how much has arrived out of the estimated total,
// the speed and the time left, with a Stop button. The engine measures the bytes GDAL actually
// downloads (GET api/runs/{id} → transfer); when the run ends the panel says what was added to
// Contents, or why it failed.
import type { Backend } from './backend';
import type { RunInfo } from './automate';
import { ONLINE_RECIPE } from './online';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const bytesText = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`;

export const etaText = (s: number | null | undefined) =>
  s === null || s === undefined || !Number.isFinite(s) ? 'working out the time left…' : s < 5 ? 'a few seconds left' : s < 90 ? `about ${Math.round(s)} s left` : s < 5400 ? `about ${Math.round(s / 60)} min left` : `about ${(s / 3600).toFixed(1)} h left`;

export class DownloadGauge {
  private el: HTMLElement;
  private hideTimer = 0;
  private current: string | null = null;
  private cancelUrl: string | null = null;

  constructor(private backend: Backend, private openRun: (id: string) => void) {
    this.el = document.createElement('div');
    this.el.className = 'dl-gauge';
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-dl-stop]') && this.current) void this.backend.json(this.cancelUrl ?? `api/runs/${this.current}/cancel`, { method: 'POST' }).catch(() => undefined);
      if (t.closest('[data-dl-close]')) this.el.hidden = true;
      const open = t.closest<HTMLElement>('[data-dl-open]')?.dataset.dlOpen;
      if (open) this.openRun(open);
    });
    document.addEventListener('geospax:run-progress', (e) => this.show((e as CustomEvent<RunInfo & { cancel_url?: string }>).detail));
  }

  private show(run: RunInfo & { cancel_url?: string }) {
    // the gauge is for downloads: Online data runs, and any run while it reports a transfer
    if (run.recipe !== ONLINE_RECIPE && !run.transfer && this.current !== run.id) return;
    this.current = run.id;
    this.cancelUrl = run.cancel_url ?? null;
    clearTimeout(this.hideTimer);
    const t = run.transfer;
    const running = run.status === 'running' || run.status === 'queued';
    if (running) {
      const frac = t ? Math.max(0.02, t.fraction) : 0;
      const amount = t ? (t.total ? `${bytesText(t.bytes)} of about ${bytesText(t.total)}` : `${bytesText(t.bytes)} so far`) : 'connecting…';
      const rate = t && t.rate > 0 && t.bytes > 0 ? ` · ${bytesText(t.rate)}/s` : '';
      this.el.className = 'dl-gauge running';
      this.el.innerHTML = `<div class="dl-head"><b>Downloading</b><span>${esc(t?.label || run.current || run.title)}</span></div>
        <div class="dl-bar${t ? '' : ' busy'}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(frac * 100)}"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>
        <div class="dl-meta"><span>${esc(amount)}${esc(rate)}</span><span>${t ? `${Math.round(t.fraction * 100)} % · ${esc(etaText(t.eta_s))}` : ''}</span></div>
        <div class="dl-acts"><button data-dl-stop>Stop</button></div>`;
      this.el.hidden = false;
      return;
    }
    const added = [...(run.layers ?? []), ...(run.rasters ?? [])].length;
    if (run.status === 'done') {
      this.el.className = 'dl-gauge done';
      this.el.innerHTML = `<div class="dl-head"><b>✓ Downloaded</b><span>${esc(run.title)}</span></div>
        <p class="dl-note">${added ? `${added} layer${added === 1 ? '' : 's'} added to Contents.` : 'Finished.'}</p>
        <div class="dl-acts">${run.cancel_url ? '' : `<button data-dl-open="${esc(run.id)}">Details</button>`}<button data-dl-close>OK</button></div>`;
      this.hideTimer = window.setTimeout(() => (this.el.hidden = true), 8000);
    } else {
      this.el.className = 'dl-gauge failed';
      this.el.innerHTML = `<div class="dl-head"><b>${run.status === 'cancelled' ? 'Stopped' : 'Download failed'}</b><span>${esc(run.title)}</span></div>
        ${run.error ? `<p class="dl-note">${esc(run.error.replace(/^step '[^']*' \([^)]*\) failed: /, ''))}</p>` : ''}
        <div class="dl-acts"><button data-dl-close>Close</button></div>`;
    }
    this.el.hidden = false;
    this.current = null;
  }
}
