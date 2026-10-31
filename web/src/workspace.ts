// Home › Workspace and local profiles ("Who's working?"). No accounts and no server: the workspace is
// this computer and OS account (workspace.rs); profiles are for several people sharing one OS login
// (profiles.rs). Profiles are a convenience, not OS-level security.

interface WsBackend { json<T>(path: string, init?: RequestInit): Promise<T>; edition: string }
interface Profile { id: string; name: string; admin: boolean; pin: boolean; restricted: boolean }
interface Profiles { available: boolean; profiles: Profile[]; current: Profile | null; unlocked: boolean; showPicker: boolean; isAdmin: boolean; note: string }
interface Tools { disabledGroups: string[]; disabledPlugins: string[]; restricted: boolean; pinSet: boolean; groups: string[] }
interface Ws {
  id: string | null; perUser: boolean; folder: string; projects: { projects?: { id: string; name: string }[] } | { id: string; name: string }[];
  dataSources: string[]; layers: number; workflows: { id?: string; name?: string; title?: string }[];
  storage: Record<string, number>; tools: Tools;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
const JSONH = { 'content-type': 'application/json' };

function modal(title: string, html: string, cls = ''): HTMLElement {
  document.querySelector('.gx-ws-modal')?.remove();
  const el = document.createElement('div');
  el.className = `modal gx-dialog gx-ws-modal ${cls}`;
  el.innerHTML = `<div class="sheet wide" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><b>${esc(title)}</b><button type="button" data-x aria-label="Close">✕</button></header><div class="body">${html}</div></div>`;
  document.body.append(el);
  el.addEventListener('click', (e) => { const t = e.target as HTMLElement; if (t.closest('[data-x]') || t === el) el.remove(); });
  // Esc closes it, except "Who's working?" while a profile is locked (it has no close button then)
  const esc_ = (e: KeyboardEvent) => {
    if (!el.isConnected) return document.removeEventListener('keydown', esc_);
    if (e.key === 'Escape' && el.querySelector('[data-x]')) { el.remove(); document.removeEventListener('keydown', esc_); }
  };
  document.addEventListener('keydown', esc_);
  return el;
}

export class WorkspaceUi {
  constructor(private b: WsBackend, private status: (t: string) => void, private closeProject: () => Promise<void>) {}

  private post<T>(path: string, body: unknown, method = 'POST') {
    return this.b.json<T>(path, { method, body: JSON.stringify(body ?? {}), headers: JSONH });
  }

  async profiles(): Promise<Profiles> {
    return this.b.json<Profiles>('api/profiles').catch(() => ({ available: false, profiles: [], current: null, unlocked: true, showPicker: false, isAdmin: false, note: '' }));
  }

  /** At startup: "Who's working?" when there is more than one profile (or a PIN to enter); the title bar button. */
  async startup(): Promise<boolean> {
    const p = await this.profiles();
    const btn = document.querySelector<HTMLButtonElement>('#profile-btn');
    if (btn && p.available) {
      btn.hidden = false;
      btn.textContent = p.current ? p.current.name : 'Profiles';
      btn.onclick = () => void this.picker(false);
    }
    if (p.showPicker) {
      await this.picker(true);
      return true;
    }
    return false;
  }

  /** Who's working? Choosing another profile closes the project and opens that profile. */
  async picker(atStart: boolean) {
    const p = await this.profiles();
    if (!p.available) return this.status('Profiles need the desktop app (or the server with --per-user-workspace).');
    const cards = p.profiles.map((x) => `<button type="button" class="gx-prof" data-id="${esc(x.id)}"><span class="gx-av">${esc(x.name.slice(0, 1).toUpperCase())}</span><b>${esc(x.name)}</b><small>${x.admin ? 'Admin' : ''}${x.pin ? ' · PIN' : ''}${x.restricted ? ' · Restricted' : ''}${p.current?.id === x.id ? ' · last used' : ''}</small></button>`).join('');
    const el = modal("Who's working?", `<div class="gx-prof-grid">${cards}<button type="button" class="gx-prof add" data-add><span class="gx-av">+</span><b>Add profile</b><small>${p.profiles.length ? 'admin only' : 'the first is the admin'}</small></button></div>
      <form class="gx-pin" hidden><label>PIN for <b data-who></b> <input name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="PIN"></label><button class="primary">Open</button></form>
      <p class="dlg-msg" data-msg></p><p class="dim small">${esc(p.note || 'Profiles are a convenience for people sharing one OS login, not OS-level security.')}</p>`, 'gx-picker');
    if (atStart && !p.unlocked) el.querySelector('[data-x]')?.remove();
    const msg = el.querySelector<HTMLElement>('[data-msg]')!;
    const form = el.querySelector<HTMLFormElement>('.gx-pin')!;
    let chosen: Profile | null = null;
    const choose = async (x: Profile, pin: string) => {
      const same = p.current?.id === x.id;
      if (!same) await this.closeProject();
      try {
        const r = await this.post<{ restart: boolean }>('api/profiles/choose', { id: x.id, pin });
        el.remove();
        if (r.restart) { this.status(`Opening ${x.name}'s workspace…`); setTimeout(() => location.reload(), 1500); }
        else if (atStart && !p.unlocked) location.reload();
      } catch (e) { msg.textContent = String((e as Error).message ?? e); }
    };
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const card = t.closest<HTMLElement>('.gx-prof[data-id]');
      if (card) {
        chosen = p.profiles.find((x) => x.id === card.dataset.id) ?? null;
        if (!chosen) return;
        const needPin = chosen.pin && !(p.current?.id === chosen.id && p.unlocked);
        if (needPin) { form.hidden = false; el.querySelector('[data-who]')!.textContent = chosen.name; form.querySelector('input')!.focus(); }
        else void choose(chosen, '');
      } else if (t.closest('[data-add]')) void this.addProfile(p);
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); if (chosen) void choose(chosen, form.querySelector('input')!.value); });
  }

  private async addProfile(p: Profiles) {
    if (p.profiles.length && !p.isAdmin) return this.status('Only the admin profile can add profiles.');
    const el = modal('Add profile', `<form class="gx-add"><label>Name <input name="name" maxlength="40" required></label>
      <label>PIN (optional, 4 to 12 digits) <input name="pin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password"></label>
      <p class="dim small">${p.profiles.length ? '' : 'The first profile is the admin: it can add, remove and rename profiles, reset PINs and restrict a profile. '}A PIN is stored only as a salted hash.</p>
      <p class="dlg-msg" data-msg></p><button class="primary">Add profile</button></form>`);
    const f = el.querySelector<HTMLFormElement>('form')!;
    f.querySelector('input')!.focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      try {
        const r = await this.post<{ restart: boolean }>('api/profiles', { name: d.get('name'), pin: d.get('pin') || undefined });
        el.remove();
        this.status('Profile added');
        if (r.restart) setTimeout(() => location.reload(), 1500);
        else void this.picker(false);
      } catch (err) { el.querySelector('[data-msg]')!.textContent = String((err as Error).message ?? err); }
    });
  }

  /** Home › Workspace. */
  async open() {
    let w: Ws;
    try { w = await this.b.json<Ws>('api/workspace'); } catch (e) { return this.status(`Workspace: ${(e as Error).message ?? e}`); }
    const p = await this.profiles();
    const projects = Array.isArray(w.projects) ? w.projects : w.projects.projects ?? [];
    const st = w.storage;
    const t = w.tools;
    const groups = (t.groups ?? []).map((g) => `<label class="gx-chk"><input type="checkbox" data-group="${esc(g)}" ${t.disabledGroups.includes(g) ? '' : 'checked'} ${t.restricted ? 'disabled' : ''}> ${esc(g)}</label>`).join('');
    const profRows = p.available && p.profiles.length ? `<h4>Profiles</h4><table class="props gx-prof-table">${p.profiles.map((x) => `<tr data-pid="${esc(x.id)}"><td><b>${esc(x.name)}</b>${x.admin ? ' <span class="dim">admin</span>' : ''}</td><td>${x.pin ? 'PIN' : 'no PIN'}</td><td>${x.restricted ? 'Restricted' : ''}</td>
        <td>${p.isAdmin ? `<button data-pa="rename">Rename</button> <button data-pa="pin">Reset PIN</button>${x.admin ? '' : ` <button data-pa="restricted">${x.restricted ? 'Unrestrict' : 'Restrict'}</button> <button data-pa="remove">Remove</button>`}` : ''}</td></tr>`).join('')}</table>` : '';
    const el = modal('Workspace', `
      <p class="dim small">${w.perUser ? `This computer and OS account${p.current ? `, profile ${esc(p.current.name)}` : ''}. Kept in ${esc(w.folder)}.` : `Kept in ${esc(w.folder)}.`} No account or sign-in.</p>
      <div class="gx-ws-grid">
        <section><h4>Projects (${projects.length})</h4><ul>${projects.map((x) => `<li>${esc(x.name)}</li>`).join('') || '<li class="dim">none yet</li>'}</ul></section>
        <section><h4>Data sources (${w.dataSources.length})</h4><ul>${w.dataSources.map((d) => `<li class="mono">${esc(d)}</li>`).join('') || '<li class="dim">none</li>'}</ul></section>
        <section><h4>Saved workflows (${w.workflows.length})</h4><ul>${w.workflows.map((x) => `<li>${esc(x.title ?? x.name ?? x.id)}</li>`).join('') || '<li class="dim">none</li>'}</ul></section>
        <section><h4>Storage</h4><table class="props"><tr><th>Total</th><td data-st="total">${size(st.total)}</td></tr><tr><th>Projects</th><td>${size(st.projects)}</td></tr><tr><th>Workflows</th><td>${size(st.workflows)}</td></tr><tr><th>Plugins</th><td>${size(st.plugins)}</td></tr><tr><th>Cache</th><td data-st="cache">${size(st.cache)}</td></tr></table>
          <button data-clear>Clear cache</button></section>
      </div>
      <h4>Tools</h4><div class="gx-groups">${groups}</div>
      <h4>Restricted mode</h4><p class="dim small">Hides and turns off editing, deleting and exporting. ${t.pinSet ? 'Turning it off needs the PIN.' : 'Turning it on sets a PIN.'}</p>
      <form class="gx-restr"><input name="pin" type="password" inputmode="numeric" maxlength="12" placeholder="PIN" aria-label="Restricted mode PIN"> <button>${t.restricted ? 'Turn off Restricted mode' : 'Turn on Restricted mode'}</button></form>
      ${profRows}
      <h4>Backup</h4><button data-export ${t.restricted ? 'disabled' : ''}>Export workspace</button> <label class="btnlike">Import workspace <input type="file" accept=".zip" data-import hidden></label>
      <p class="dlg-msg" data-msg></p>`, 'gx-ws');
    const msg = el.querySelector<HTMLElement>('[data-msg]')!;
    const fail = (e: unknown) => { msg.textContent = String((e as Error).message ?? e); };
    el.querySelector('[data-clear]')?.addEventListener('click', async () => {
      try { const r = await this.post<{ freed: number }>('api/workspace/cache/clear', {}); msg.textContent = `Cache cleared (${size(r.freed)} freed)`; void this.open(); } catch (e) { fail(e); }
    });
    el.querySelectorAll<HTMLInputElement>('[data-group]').forEach((c) => c.addEventListener('change', async () => {
      const off = [...el.querySelectorAll<HTMLInputElement>('[data-group]')].filter((x) => !x.checked).map((x) => x.dataset.group!);
      try { await this.post('api/workspace/tools', { disabledGroups: off, disabledPlugins: t.disabledPlugins }, 'PUT'); document.dispatchEvent(new CustomEvent('geospax:tools-changed')); msg.textContent = 'Tool settings saved'; } catch (e) { fail(e); }
    }));
    el.querySelector<HTMLFormElement>('.gx-restr')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = (e.target as HTMLFormElement).querySelector('input')!.value;
      try { await this.post('api/workspace/restricted', { on: !t.restricted, pin }); document.dispatchEvent(new CustomEvent('geospax:tools-changed')); void this.open(); } catch (er) { fail(er); }
    });
    el.querySelector('[data-export]')?.addEventListener('click', async () => {
      try {
        const r = await fetch(new URL('api/workspace/export', location.href)).catch(() => null);
        if (!r || !r.ok) throw new Error(r ? await r.text() : 'export failed');
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: 'geospax-workspace.zip' });
        a.click();
      } catch (e) { fail(e); }
    });
    el.querySelector<HTMLInputElement>('[data-import]')!.addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try { const r = await this.b.json<{ files: number }>('api/workspace/import', { method: 'POST', body: await f.arrayBuffer() }); msg.textContent = `${r.files} files imported`; } catch (er) { fail(er); }
    });
    el.querySelectorAll<HTMLButtonElement>('[data-pa]').forEach((bt) => bt.addEventListener('click', async () => {
      const id = bt.closest<HTMLElement>('[data-pid]')!.dataset.pid!;
      const a = bt.dataset.pa!;
      try {
        if (a === 'rename') { const n = prompt('New name'); if (!n) return; await this.post(`api/profiles/${id}/rename`, { name: n }); }
        else if (a === 'pin') { const n = prompt('New PIN (4 to 12 digits; empty for none)'); if (n === null) return; await this.post(`api/profiles/${id}/pin`, { pin: n }); }
        else if (a === 'restricted') await this.post(`api/profiles/${id}/restricted`, { on: bt.textContent === 'Restrict' });
        else if (a === 'remove') { if (!confirm('Remove this profile and its projects?')) return; await this.b.json(`api/profiles/${id}`, { method: 'DELETE' }); }
        void this.open();
      } catch (e) { fail(e); }
    }));
  }

  /** Restricted mode and switched-off tool groups: hide their ribbon commands. */
  async applyTools() {
    const t = await this.b.json<Tools>('api/workspace/tools').catch(() => null);
    const hide = new Set<string>(t ? [...t.disabledGroups, ...(t.restricted ? ['edit', 'design', 'delete', 'export'] : [])] : []);
    document.body.dataset.restricted = t?.restricted ? '1' : '';
    // CSS (style.css) keeps them hidden when the ribbon is drawn again, e.g. on a mode switch
    document.body.dataset.toolsOff = [...hide].join(' ');
    const where: Record<string, string[]> = {
      edit: ['#ribbon-tabs [data-tab="edit"]'],
      design: ['#ribbon-tabs [data-tab="design"]', '[data-cmd="share.layout"]'],
      analysis: ['#ribbon-tabs [data-tab="analyze"]', '.dock-tabs [data-tab="toolbox"]'],
      automate: ['.dock-tabs [data-tab="automate"]'],
      ai: ['.dock-tabs [data-tab="ask"]'],
      devices: ['#devices-box'],
      plugins: ['#plugin-manager'],
      export: ['#ribbon-tabs [data-tab="share"]', '[data-cmd="edit.export"]'],
      delete: ['[data-cmd*="remove"]', '[data-cmd*="delete"]'],
    };
    document.querySelectorAll<HTMLElement>('[data-tools-hidden]').forEach((e) => { e.hidden = false; delete e.dataset.toolsHidden; });
    for (const g of hide) for (const sel of where[g] ?? []) document.querySelectorAll<HTMLElement>(sel).forEach((e) => { e.hidden = true; e.dataset.toolsHidden = '1'; });
  }
}
