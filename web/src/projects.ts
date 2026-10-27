// Home › Project: New, Open, Save, Save as and Rename (docs/USER_GUIDE.md "Projects").
//
// The open project is still the one file the app autosaves (api/project). A named project is a
// copy of it under the state folder (api/projects/<id>): Save writes the open project there, Open
// loads one back, Save as starts a copy under a new name and Rename renames the file. The name is
// shown in the window title and on the left of the status bar.
import type { Backend } from './backend';
import { dialog, say } from './editing';
import type { Project } from './symbology';

export interface ProjectHost {
  backend: Backend;
  get(): Project;
  /** layer ids now on the map (a new project starts with them taken off, kept in the Catalog) */
  layerIds(): string[];
  /** write the open project to api/project now (no autosave delay) */
  flush(): Promise<void>;
  /** stop autosaving: the next page load opens the project just written */
  hold(): void;
  /** the address to load the switched-to project from */
  reloadUrl(): string;
  setStatus(text: string, ms?: number): void;
  guest: boolean;
}

interface Listed { id: string; name: string; saved: number; path: string }
interface Listing { folder: string; projects: Listed[] }

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BAD = /[\\/:*?"<>|]/;

/** A file id from a name: "Lae Roads 2026" → "lae-roads-2026". */
export function slugify(name: string): string {
  const s = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'project';
}

/** Why a name cannot be used, or '' when it can. */
export function nameProblem(name: string, taken: Listed[], self?: string): string {
  const n = name.trim();
  if (!n) return 'Type a name for the project.';
  if (n.length > 60) return 'Keep the name to 60 characters or fewer.';
  if (BAD.test(n)) return 'A name cannot contain \\ / : * ? " < > or |.';
  const slug = slugify(n);
  const clash = taken.find((p) => p.id === slug && p.id !== self);
  if (clash) return `There is already a project called "${clash.name}". Choose another name, or open that one.`;
  return '';
}

/** Show the open project's name in the title bar and the status bar. */
export function showProjectName(p: Project) {
  const name = p.name?.trim() || 'Untitled project';
  document.title = `${name} · GeoSpaX`;
  let sb = document.querySelector<HTMLElement>('#sb-project');
  if (!sb) {
    sb = Object.assign(document.createElement('span'), { id: 'sb-project' });
    document.querySelector('#statusbar')?.prepend(sb);
  }
  sb.textContent = name;
  sb.classList.toggle('unnamed', !p.name);
  document.body.dataset.project = p.slug ?? '';
}

export function wireProjects(h: ProjectHost) {
  showProjectName(h.get());
  const list = () => h.backend.json<Listing>('api/projects');
  const put = (slug: string, p: Project) =>
    h.backend.json(`api/projects/${slug}`, { method: 'PUT', body: JSON.stringify(p), headers: { 'content-type': 'application/json' } });
  const putOpen = (p: Project) =>
    h.backend.json('api/project', { method: 'PUT', body: JSON.stringify(p), headers: { 'content-type': 'application/json' } });
  const when = (ms: number) => new Date(ms).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });

  /** The name dialog: checks the name as you type; resolves with the name or null. */
  async function askName(title: string, ok: string, intro: string, start: string, self?: string): Promise<string | null> {
    const l = await list().catch(() => ({ folder: '', projects: [] as Listed[] }));
    const r = await dialog(title, `
      <p>${intro}</p>
      <label class="dlg-field">Project name
        <input name="name" value="${esc(start)}" maxlength="60" autocomplete="off" spellcheck="false" autofocus required aria-describedby="pj-msg">
      </label>
      <p class="dim small" data-where>${l.folder ? `Saved in ${esc(l.folder)}` : ''}</p>
      <p id="pj-msg" data-msg class="dlg-msg"></p>`,
      [['ok', ok], ['', 'Cancel']], {
        onOpen: (root) => {
          const input = root.querySelector<HTMLInputElement>('input[name=name]')!;
          const okBtn = root.querySelector<HTMLButtonElement>('button[data-btn=ok]')!;
          const check = () => {
            const why = nameProblem(input.value, l.projects, self);
            say(root, why, why ? 'err' : '');
            input.setAttribute('aria-invalid', String(!!why));
            okBtn.disabled = !!why;
          };
          input.addEventListener('input', check);
          input.select();
          check();
        },
        onButton: (_b, v, root) => {
          const why = nameProblem(v.name ?? '', l.projects, self);
          if (why) { say(root, why, 'err'); return false; }
          return true;
        },
      });
    return r.button === 'ok' ? r.values.name.trim() : null;
  }

  /** Keep the open project before switching: under its own name, or as "Untitled <date>". */
  async function keepCurrent(): Promise<string> {
    const p = h.get();
    await h.flush();
    if (p.slug) { await put(p.slug, p); return p.name ?? p.slug; }
    if (!p.order.length) return '';
    const name = `Untitled ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}`;
    await put(slugify(name), { ...p, name, slug: slugify(name) });
    return name;
  }

  async function doNew() {
    const name = await askName('New project', 'Create', 'Give the new project a name. It starts with an empty map; your data folders stay connected, so every layer is still in the Catalog to add.', '');
    if (!name) return;
    const kept = await keepCurrent();
    const slug = slugify(name);
    const p: Project = { version: 1, order: [], layers: {}, name, slug, removed: h.layerIds() };
    await put(slug, p);
    h.hold();
    await putOpen(p);
    h.setStatus(`New project ${name} created${kept ? ` (${kept} saved)` : ''}`);
    reload();
  }

  async function doOpen() {
    const l = await list();
    const cur = h.get().slug;
    const rows = l.projects.length
      ? l.projects.map((p, i) => `<label class="pj-row"><input type="radio" name="id" value="${esc(p.id)}" ${i === 0 ? 'checked' : ''}${p.id === cur ? ' data-current' : ''}>
          <span class="pj-name">${esc(p.name)}${p.id === cur ? ' <span class="dim">(open now)</span>' : ''}</span><span class="dim small">${when(p.saved)}</span></label>`).join('')
      : '<p class="dim">No saved projects yet. Use New project or Save as to make one.</p>';
    const r = await dialog('Open project', `<div class="pj-list" role="radiogroup" aria-label="Saved projects">${rows}</div>
      <p class="dim small">${l.folder ? `Projects are kept in ${esc(l.folder)}` : ''}</p><p data-msg class="dlg-msg"></p>`,
      l.projects.length ? [['ok', 'Open'], ['', 'Cancel']] : [['', 'Close']], { wide: true });
    if (r.button !== 'ok' || !r.values.id) return;
    const kept = await keepCurrent();
    const p = await h.backend.json<Project>(`api/projects/${r.values.id}`);
    p.slug = r.values.id;
    p.name = p.name || r.values.id;
    h.hold();
    await putOpen(p);
    h.setStatus(`Opened ${p.name}${kept ? ` (${kept} saved)` : ''}`);
    reload();
  }

  async function doSave() {
    const p = h.get();
    if (!p.slug) return doSaveAs();
    await h.flush();
    await put(p.slug, p);
    h.setStatus(`Project saved: ${p.name}`);
  }

  async function doSaveAs() {
    const p = h.get();
    const name = await askName('Save project as', 'Save', p.slug ? `Save a copy of ${esc(p.name ?? p.slug)} under a new name. You carry on working in the copy.` : 'Give this project a name to save it.', p.name ? `${p.name} copy` : '');
    if (!name) return;
    p.name = name;
    p.slug = slugify(name);
    await h.flush();
    await put(p.slug, p);
    showProjectName(p);
    h.setStatus(`Project saved as ${name}`);
  }

  async function doRename() {
    const p = h.get();
    const old = p.slug;
    const name = await askName('Rename project', 'Rename', old ? `New name for ${esc(p.name ?? old)}:` : 'Give this project a name. It is saved under that name.', p.name ?? '', old);
    if (!name) return;
    const slug = slugify(name);
    if (old && old !== slug) await h.backend.json(`api/projects/${old}/rename?to=${slug}`, { method: 'POST' }).catch(() => null);
    p.name = name;
    p.slug = slug;
    await h.flush();
    await put(slug, p);
    showProjectName(p);
    h.setStatus(old ? `Project renamed to ${name}` : `Project saved as ${name}`);
  }

  const reload = () => {
    // a short pause so the status is readable, then start again on the chosen project
    setTimeout(() => {
      const to = h.reloadUrl();
      // the project's own view, not the one in the address
      if (to === location.href.replace(/#.*$/, '') && !location.hash) location.reload();
      else location.replace(to);
    }, 400);
  };

  document.addEventListener('geospax:project', (e) => {
    const what = (e as CustomEvent<string>).detail;
    if (h.guest && what !== 'save') {
      h.setStatus('Named projects are in the full app; the guest demo keeps one project in this browser', 8000);
      return;
    }
    if (h.guest) { void h.flush().then(() => h.setStatus('Project saved')); return; }
    const go = { new: doNew, open: doOpen, save: doSave, saveAs: doSaveAs, rename: doRename }[what];
    go?.().catch((err) => h.setStatus(`Project: ${err instanceof Error ? err.message : err}`, 10000));
  });
}
