// Help › User guide, Automation, Credits … and About: the guides are built into the program
// (GET api/docs/<name>) and shown here, so they open the same in a browser, the desktop window and
// on a phone. A small Markdown renderer: everything is escaped first, then headings, lists, tables,
// code, links, bold and italics are added back. Links to other guides open in place.

import { findUpdate, showUpdate } from './updates';

export interface DocsBackend {
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown on already-escaped text. */
function inline(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: alt text only (the guides are text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
      const doc = /^(?:\.\.?\/)*(?:docs\/)?([A-Za-z_]+)\.md(#.*)?$/.exec(href);
      if (doc) return `<a href="#" data-doc="${doc[1]}">${text}</a>`;
      if (/^https?:\/\//.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      if (href.startsWith('#')) return `<a href="#" data-anchor="${href.slice(1)}">${text}</a>`;
      return text;
    })
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

export function renderMarkdown(md: string): string {
  const lines = esc(md.replace(/\r/g, '')).split('\n');
  const out: string[] = [];
  let i = 0;
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      const text = inline(h[2]);
      out.push(`<h${h[1].length} id="${slug(text)}">${text}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = cells(l);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m && !/^\s{4,}/.test(lines[i])) items.push(m[1]);
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^&gt;\s?/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^&gt;\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (!l.trim() || /^&lt;\/?(p|div|img|br|picture|source|h1|a)\b/.test(l.trim())) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*\||\s*([-*]|\d+\.)\s+|&gt;)/.test(lines[i])) para.push(lines[i++]);
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    else i++;
  }
  return out.join('\n');
}

/** Open the help page on a guide (`USER_GUIDE`, `FAQ/installing`); false when it could not open. */
export async function openHelpPage(route: string, edition?: string): Promise<boolean> {
  const url = `help.html#${route}`;
  if (edition === 'desktop') {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const open = await WebviewWindow.getByLabel('help');
      if (open) {
        await open.emit('geospax:help', route).catch(() => undefined);
        await open.setFocus();
        return true;
      }
      const w = new WebviewWindow('help', { url, title: 'GeoSpaX Help', width: 1200, height: 860 });
      return await new Promise<boolean>((resolve) => {
        void w.once('tauri://created', () => resolve(true));
        void w.once('tauri://error', () => resolve(false));
      });
    } catch {
      return false;
    }
  }
  return !!window.open(url, 'geospax-help');
}

export class DocsViewer {
  private modal: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private history: string[] = [];

  constructor(private backend: DocsBackend) {
    this.modal = document.createElement('div');
    this.modal.className = 'modal docs-modal';
    this.modal.hidden = true;
    this.modal.innerHTML = `<div class="sheet docs-sheet" role="dialog" aria-modal="true" aria-label="Help">
      <header><button type="button" class="docs-back" aria-label="Back" hidden>←</button><b class="docs-title">Help</b>
      <button type="button" data-close aria-label="Close">✕</button></header>
      <div class="body docs-body"></div></div>`;
    document.body.append(this.modal);
    this.body = this.modal.querySelector('.docs-body')!;
    this.title = this.modal.querySelector('.docs-title')!;
    const back = this.modal.querySelector<HTMLButtonElement>('.docs-back')!;
    this.modal.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.modal || t.closest('[data-close]')) return this.close();
      if (t === back) {
        this.history.pop();
        const prev = this.history.pop();
        if (prev) void this.open(prev);
        return;
      }
      const a = t.closest('a') as HTMLAnchorElement | null;
      if (a?.dataset.doc) {
        e.preventDefault();
        void this.open(a.dataset.doc);
      } else if (a?.dataset.anchor) {
        e.preventDefault();
        this.body.querySelector(`#${CSS.escape(a.dataset.anchor)}`)?.scrollIntoView({ block: 'start' });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.modal.hidden) this.close();
    });
  }

  close() {
    this.modal.hidden = true;
    this.history = [];
  }

  private show(title: string, html: string) {
    this.title.textContent = title;
    this.body.innerHTML = html;
    this.body.scrollTop = 0;
    this.modal.querySelector<HTMLButtonElement>('.docs-back')!.hidden = this.history.length < 2;
    this.modal.hidden = false;
  }

  /** Open a guide by name or link (`USER_GUIDE`, `docs/AUTOMATION.md#2-recipes`): on the help page
   *  (help.html) in a browser tab or, on the desktop, its own window; in this viewer if that fails. */
  async open(name: string) {
    const key = name.replace(/^.*\//, '').replace(/\.md(#.*)?$/, '');
    const anchor = /#(.+)$/.exec(name)?.[1];
    if (await openHelpPage(key + (anchor ? `/${anchor}` : ''), (this.backend as { edition?: string }).edition)) {
      this.close();
      return;
    }
    return this.openHere(key);
  }

  /** The guide inside the app (the fallback when no help page can open). */
  async openHere(key: string) {
    this.history.push(key);
    this.show('Help', '<p class="muted">Loading…</p>');
    try {
      const d = await this.backend.json<{ title: string; markdown: string }>(`api/docs/${encodeURIComponent(key)}`);
      this.show(d.title, `<article class="doc">${renderMarkdown(d.markdown)}</article>`);
    } catch (err) {
      this.show('Help', `<p>This guide could not be opened: ${esc(String((err as Error).message ?? err))}</p>`);
    }
  }

  /** Help › About GeoSpaX: logo, version, a check for updates (GitHub releases) and links. */
  async about(edition: string) {
    let version = '';
    try {
      version = (await this.backend.json<{ version: string }>('api/health')).version;
    } catch {
      /* offline: show the rest */
    }
    this.history = ['about'];
    const repo = 'https://github.com/jmozez/geospax';
    const link = (href: string, label: string, sub: string) =>
      `<a class="about-link" href="${href}" target="_blank" rel="noopener"><b>${esc(label)}</b><small>${esc(sub)}</small><span aria-hidden="true">↗</span></a>`;
    const doc = (key: string, label: string, sub: string) =>
      `<a class="about-link" href="#" data-doc="${key}"><b>${esc(label)}</b><small>${esc(sub)}</small><span aria-hidden="true">›</span></a>`;
    this.show(
      'About GeoSpaX',
      `<div class="about">
        <img src="geospax-logo.png" alt="GeoSpaX logo" class="about-logo" onerror="this.remove()">
        <h2>GeoSpaX</h2>
        <p>Spatial analysis and automatic mapping: data in, a finished map and report out. Desktop, web and phone, from one engine (Rust, GDAL).</p>
        <div class="about-card">
          <div class="about-row"><span>Version</span><code>${esc(version || 'unknown')}</code></div>
          <div class="about-row"><span>Edition</span><code>${esc(edition || 'web')}</code></div>
          <div class="about-row"><button type="button" class="about-check">Check for updates</button><span class="about-update" aria-live="polite"></span></div>
        </div>
        <h3 class="about-h">General</h3>
        <div class="about-card links">
          ${link('https://geospax.in4metrix.dev', 'Official website', 'geospax.in4metrix.dev')}
          ${link('https://geospax.in4metrix.dev/#download', 'Downloads', 'Windows, Linux, Android and the web app')}
          ${link(repo, 'Source code', 'github.com/jmozez/geospax')}
          ${link(`${repo}/issues`, 'Report a problem', 'Bugs and ideas on GitHub')}
          ${doc('USER_GUIDE', 'User guide', 'How to use every part of the program')}
          ${doc('CHANGELOG', "What's new", 'Changes in each version')}
          ${doc('THIRD_PARTY_NOTICES', 'Credits and licences', 'Open-source parts and data sources')}
        </div>
        <p class="about-foot">© <a href="https://www.in4metrix.dev" target="_blank" rel="noopener">in4metrix</a> · MIT licence</p>
      </div>`,
    );
    const btn = document.querySelector<HTMLButtonElement>('.about-check');
    const out = document.querySelector<HTMLElement>('.about-update');
    btn?.addEventListener('click', async () => {
      if (!out) return;
      btn.disabled = true;
      out.className = 'about-update';
      out.textContent = 'Checking…';
      try {
        const u = await findUpdate(version);
        if (u) {
          out.className = 'about-update new';
          showUpdate(out, u);
        } else {
          out.className = 'about-update ok';
          out.textContent = `You have the latest version (${version})`;
        }
      } catch (e) {
        out.className = 'about-update err';
        out.innerHTML = `Could not check (${esc(String((e as Error).message ?? e))}) · <a href="${repo}/releases" target="_blank" rel="noopener">Open the downloads page</a>`;
      } finally {
        btn.disabled = false;
      }
    });
  }
}

/** Is version a newer than b? (1.2.10 > 1.2.9; a pre-release such as 3.0.0-rc1 is older than 3.0.0) */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => { const [core, pre] = v.replace(/^v/, '').split('-'); return { n: core.split('.').map((x) => parseInt(x, 10) || 0), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  return !x.pre && !!y.pre;
}
