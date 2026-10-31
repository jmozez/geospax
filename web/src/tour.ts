// First-start guided tour, What's new after an upgrade, and Help › Take the tour.
// The state (tour seen, last version run, "Don't show again") is kept per local profile in the
// engine (api/ui-state, ui.json in the profile's folder), so every new profile sees the tour once.
import { renderMarkdown } from './docs';

export interface TourStep {
  /** CSS selector of what to spotlight (nothing: a card in the middle of the window) */
  at?: string;
  title: string;
  text: string;
  before?: () => void;
}

interface UiState { tourSeen?: boolean; tourOff?: boolean; lastVersion?: string }

interface TourBackend { json<T>(path: string, init?: RequestInit): Promise<T> }

const tab = (t: string) => () => document.querySelector<HTMLElement>(`#ribbon-tabs [data-tab="${t}"]`)?.click();
const pane = (t: string) => () => document.querySelector<HTMLElement>(`.dock-tabs [data-tab="${t}"]`)?.click();

export const FIRST_TOUR: TourStep[] = [
  { title: 'Welcome to GeoSpaX', text: 'A one minute tour of where things are. Use Next or the arrow keys to move on, and Skip or Esc to leave at any time. Help › Take the tour brings it back.' },
  { at: '#ribbon-tabs', before: tab('home'), title: 'The ribbon', text: 'Every command sits on a tab: Home for projects and adding data, Edit, Analyze, View, Share and Help. Ctrl+K finds any command by name.' },
  { at: '.dock-tabs [data-tab="contents"]', before: pane('contents'), title: 'Contents', text: 'The layers on the map, top draws on top. Click one to select it; the Layer panel on the right then styles it. The Explorer tab beside it is where you add data.' },
  { at: '#ribbon-tabs [data-tab="view"]', before: tab('view'), title: '2D, globe and 3D', text: 'View › Projection switches between the flat 2D map and the globe, and 3D terrain tilts the map over an elevation model.' },
  { at: '#mode-switch', title: 'Lazy and Pro modes', text: 'Lazy mode keeps the screen simple and styles layers for you. Pro mode shows the full symbology, the layer tree and every tool.' },
  { at: '.dock-tabs [data-tab="ask"]', before: pane('ask'), title: 'Ask', text: 'Ask questions about your data in plain words. When the assistant proposes a workflow it shows the plan first, and nothing runs until you press Run.' },
  { at: '.dock-tabs [data-tab="automate"]', before: pane('automate'), title: 'Automate', text: 'Recipes repeat a workflow on new data: run one now, on a schedule, or when files arrive in a folder.' },
  { at: '#ribbon-tabs [data-tab="help"]', before: tab('help'), title: 'Help', text: "Tutorials, the user guide, What's new and Report a problem are on the Help tab. That is the tour; enjoy GeoSpaX." },
];

/** The tools new in this version, for the optional mini-tour from What's new. */
export const NEW_TOOLS_TOUR: TourStep[] = [
  { at: '#ribbon-tabs [data-tab="home"]', before: tab('home'), title: 'Workspace and profiles', text: 'Home › Workspace shows this computer\'s projects, storage and tool settings. Switch profile lets several people share one login, each with their own projects.' },
  { at: '#profile-btn', title: 'Switch profile', text: 'The title bar shows who is working. Click it to switch profile; the project closes cleanly first.' },
  { at: '#ribbon-tabs [data-tab="help"]', before: tab('help'), title: 'Help › Open sample project', text: 'Sample data no longer loads by itself: a new start is an empty map. Open a sample project from the Help tab when you want one.' },
  { at: '#ribbon-tabs [data-tab="help"]', before: tab('help'), title: 'Help › Take the tour', text: 'Replay the first-start tour at any time from the Help tab.' },
];

export class Tour {
  private card: HTMLElement | null = null;
  private veil: HTMLElement | null = null;
  private steps: TourStep[] = [];
  private i = 0;
  private name = '';
  private done: (() => void) | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (!this.card) return;
    if (e.key === 'Escape') { e.preventDefault(); this.end(true); }
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !(e.target as HTMLElement).closest('button, input'))) { e.preventDefault(); this.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.back(); }
  };
  private onResize = () => this.place();

  constructor(private backend: TourBackend, private version: string, private openUrl: (u: string) => void) {}

  private async state(): Promise<UiState> {
    return this.backend.json<UiState>('api/ui-state').catch(() => ({}));
  }

  private save(s: UiState) {
    return this.backend.json('api/ui-state', { method: 'PUT', body: JSON.stringify(s), headers: { 'content-type': 'application/json' } }).catch(() => undefined);
  }

  /** At startup: the tour on a profile's first run, What's new after an upgrade. */
  async startup() {
    const s = await this.state();
    if (!s.tourSeen && !s.tourOff) {
      await this.save({ lastVersion: this.version });
      this.start(FIRST_TOUR, 'Getting started');
      return;
    }
    if (s.lastVersion && s.lastVersion !== this.version) {
      await this.save({ lastVersion: this.version });
      await this.whatsNew();
      return;
    }
    if (!s.lastVersion) await this.save({ lastVersion: this.version });
  }

  /** Help › Take the tour. */
  replay() { this.start(FIRST_TOUR, 'Getting started'); }

  start(steps: TourStep[], name: string, done?: () => void) {
    this.end(false);
    this.steps = steps;
    this.name = name;
    this.i = 0;
    this.done = done ?? null;
    document.addEventListener('keydown', this.onKey, true);
    addEventListener('resize', this.onResize);
    this.show();
  }

  private next() { if (this.i < this.steps.length - 1) { this.i++; this.show(); } else this.end(true); }
  private back() { if (this.i > 0) { this.i--; this.show(); } }

  private show() {
    const s = this.steps[this.i];
    s.before?.();
    this.card?.remove();
    this.veil?.remove();
    const n = this.steps.length;
    const last = this.i === n - 1;
    const veil = document.createElement('div');
    veil.className = 'gx-tour-veil';
    const card = document.createElement('div');
    card.className = 'gx-tour';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'gx-tour-title');
    card.innerHTML = `<div class="gx-tour-top"><span class="gx-tour-name"></span><span class="gx-tour-count">Step ${this.i + 1} of ${n}</span></div>
      <div class="gx-tour-bar" role="progressbar" aria-valuemin="1" aria-valuemax="${n}" aria-valuenow="${this.i + 1}"><i style="width:${((this.i + 1) / n) * 100}%"></i></div>
      <h3 id="gx-tour-title"></h3><p></p>
      <div class="gx-tour-dots" aria-hidden="true">${this.steps.map((_, k) => `<b class="${k === this.i ? 'on' : k < this.i ? 'past' : ''}"></b>`).join('')}</div>
      <div class="gx-tour-nav">
        <label class="gx-tour-off"><input type="checkbox" data-off> Don't show again</label>
        <span class="gx-tour-sp"></span>
        <button type="button" class="gx-tour-skip" data-skip>Skip</button>
        <button type="button" data-back ${this.i ? '' : 'disabled'}>Back</button>
        <button type="button" class="gx-tour-next" data-next>${last ? 'Finish' : 'Next'}</button>
      </div>`;
    card.querySelector('.gx-tour-name')!.textContent = this.name;
    card.querySelector('h3')!.textContent = s.title;
    card.querySelector('p')!.textContent = s.text;
    card.addEventListener('click', (e) => {
      const b = e.target as HTMLElement;
      if (b.closest('[data-skip]')) this.end(true);
      else if (b.closest('[data-back]')) this.back();
      else if (b.closest('[data-next]')) this.next();
    });
    card.querySelector<HTMLInputElement>('[data-off]')!.addEventListener('change', (e) => {
      void this.save({ tourOff: (e.target as HTMLInputElement).checked });
    });
    document.body.append(veil, card);
    this.card = card;
    this.veil = veil;
    this.place();
    card.querySelector<HTMLElement>('[data-next]')!.focus();
  }

  /** The spotlight (a hole in the veil around the target) and the card beside it. */
  private place() {
    const card = this.card, veil = this.veil;
    if (!card || !veil) return;
    const s = this.steps[this.i];
    const t = s.at ? document.querySelector<HTMLElement>(s.at) : null;
    const r = t?.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) {
      veil.classList.add('full');
      veil.style.cssText = '';
      card.classList.add('center');
      card.style.left = card.style.top = '';
      return;
    }
    veil.classList.remove('full');
    card.classList.remove('center');
    const pad = 6;
    Object.assign(veil.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const h = card.offsetHeight, w = card.offsetWidth;
    const below = r.bottom + 14 + h < innerHeight;
    const top = below ? r.bottom + 14 : r.top - h - 14 >= 8 ? r.top - h - 14 : Math.max(8, (innerHeight - h) / 2);
    card.style.top = `${top}px`;
    card.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2))}px`;
  }

  end(finished: boolean) {
    const was = !!this.card;
    this.card?.remove();
    this.veil?.remove();
    this.card = this.veil = null;
    document.removeEventListener('keydown', this.onKey, true);
    removeEventListener('resize', this.onResize);
    if (was && finished) {
      if (this.steps === FIRST_TOUR) void this.save({ tourSeen: true });
      const d = this.done;
      this.done = null;
      d?.();
    }
  }

  /** What's new: this version's highlights from the changelog, with an optional mini-tour of new tools. */
  async whatsNew() {
    let md = '';
    try {
      md = (await this.backend.json<{ markdown: string }>('api/docs/CHANGELOG')).markdown;
    } catch { /* offline docs missing: the link below still opens the changelog */ }
    const v = this.version.replace(/[.]/g, '\\.');
    const m = new RegExp(`^## \\[?${v}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## )`, 'm').exec(md + '\n## ');
    const body = m ? renderMarkdown(m[1].trim()) : '<p>See the changelog for this version\'s changes.</p>';
    document.querySelector('.gx-whatsnew')?.remove();
    const el = document.createElement('div');
    el.className = 'modal gx-dialog gx-whatsnew';
    el.innerHTML = `<div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="gx-wn-title">
      <header><b id="gx-wn-title">What's new in GeoSpaX ${this.version.replace(/[<>&"]/g, '')}</b><button type="button" data-x aria-label="Close">✕</button></header>
      <div class="body"><article class="doc">${body}</article></div>
      <footer class="gx-wn-foot"><button type="button" data-log>Full changelog</button><span class="gx-tour-sp"></span>
        <button type="button" data-mini>Show me the new tools</button><button type="button" class="primary" data-x>Close</button></footer></div>`;
    document.body.append(el);
    const close = () => el.remove();
    el.addEventListener('click', (e) => {
      const b = e.target as HTMLElement;
      if (b.closest('[data-mini]')) { close(); this.start(NEW_TOOLS_TOUR, `New in ${this.version}`); }
      else if (b.closest('[data-log]')) this.openUrl('CHANGELOG.md');
      else if (b.closest('[data-x]') || b === el) close();
    });
    const onKey = (e: KeyboardEvent) => { if (!el.isConnected) return document.removeEventListener('keydown', onKey); if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    el.querySelector<HTMLElement>('.primary')!.focus();
  }
}
