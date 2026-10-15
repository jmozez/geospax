// "Send from phone" card in the Devices panel (docs/DEVICES.md §3a): switches the phone link on and shows the
// QR code a phone on the same Wi-Fi scans to send photos, tracks and sensor logs, with no cable and no app.
import type { Backend } from './backend';

interface PhoneState {
  enabled: boolean;
  running: boolean;
  port: number | null;
  url: string | null;
  urls: string[];
  qr_svg: string | null;
  computer: string;
  inbox: string | null;
  error: string | null;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class PhoneCard {
  private state: PhoneState | null = null;
  private open = false;

  constructor(
    private el: HTMLElement,
    private backend: Backend,
  ) {
    el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button[data-phone]') as HTMLButtonElement | null;
      if (b) void this.act(b.dataset.phone!);
    });
  }

  async start() {
    this.state = await this.backend.json<PhoneState>('api/phone').catch(() => null);
    this.render();
  }

  private async act(what: string) {
    if (what === 'toggle') {
      this.open = !this.open;
      return this.render();
    }
    this.el.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    try {
      this.state = await this.backend.json<PhoneState>(`api/phone/${what}`, { method: 'POST' });
    } catch (e) {
      if (this.state) this.state = { ...this.state, error: String((e as Error).message ?? e) };
    }
    if (what === 'enable' || what === 'reset') this.open = true;
    this.render();
  }

  private render() {
    const s = this.state;
    if (!s) {
      this.el.innerHTML = '';
      return;
    }
    const head = (sub: string, button: string) =>
      `<div class="phone-head"><span class="phone-ico">📱</span><div class="phone-title"><b>Send from phone</b><span>${sub}</span></div>${button}</div>`;
    if (!s.running) {
      this.el.innerHTML = `<div class="phone-card" data-state="off">${head('Photos, tracks and logs over Wi-Fi: no cable, no app.', '<button data-phone="enable" class="primary">Turn on</button>')}${
        s.error ? `<p class="phone-err">${esc(s.error)}</p>` : ''
      }</div>`;
      return;
    }
    const others = s.urls.slice(1).map((u) => `<code>${esc(u.split('#')[0])}</code>`).join(' ');
    this.el.innerHTML = `<div class="phone-card" data-state="on">${head(
      `On · ${esc(s.computer)}:${s.port}`,
      `<button data-phone="toggle">${this.open ? 'Hide' : 'Show code'}</button>`,
    )}${
      this.open
        ? `<div class="phone-qr" title="${esc(s.url)}">${s.qr_svg ?? ''}</div>
      <ol class="phone-steps">
        <li>On a phone on the same Wi-Fi, point the camera at the code.</li>
        <li>The phone warns once about the certificate: it is this computer's own. Choose <i>Advanced → Continue</i>.</li>
        <li>Pick photos or tracks, or take a photo: the map makes itself${s.inbox ? ` (files land in <code>${esc(s.inbox)}</code>)` : ''}.</li>
      </ol>
      <p class="phone-url">${esc((s.url ?? '').split('#')[0])}${others ? `<br/>also ${others}` : ''}</p>
      <div class="phone-actions"><button data-phone="reset" title="Phones paired before must scan again">New code</button><button data-phone="disable">Turn off</button></div>`
        : ''
    }</div>`;
  }
}
