// GeoSpaX Help: the guides as a web page of their own (help.html), opened by Help › User guide in
// a new browser tab (web edition) or window (desktop). Guides come from the engine (api/docs), so
// the help always matches the program; a sidebar lists them, "On this page" follows the headings,
// and the search box looks through every guide at once.
import './style.css';
import './help.css';
import { createBackend } from './backend';
import { renderMarkdown } from './docs';

interface DocInfo { name: string; title: string }

const backend = createBackend();
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the guides in the order a new user wants them
const SECTIONS: [string, string[]][] = [
  ['Get started', ['USER_GUIDE', 'FAQ', 'CHANGELOG']],
  ['Working with GeoSpaX', ['AUTOMATION', 'GSX', 'R', 'PLUGINS', 'DEVICES', 'AI']],
  ['Reference', ['FEATURE_MATRIX', 'VISION', 'README', 'SECURITY', 'THIRD_PARTY_NOTICES']],
];

let docs: DocInfo[] = [];
const cache = new Map<string, { title: string; markdown: string }>();

async function load(key: string) {
  if (!cache.has(key)) cache.set(key, await backend.json<{ title: string; markdown: string }>(`api/docs/${encodeURIComponent(key)}`));
  return cache.get(key)!;
}

function nav(current: string) {
  const known = new Set(docs.map((d) => d.name));
  const title = (k: string) => docs.find((d) => d.name === k)?.title ?? k;
  const listed = new Set(SECTIONS.flatMap(([, ks]) => ks));
  const extra = docs.filter((d) => !listed.has(d.name)).map((d) => d.name);
  $('#hp-nav').innerHTML = [...SECTIONS, ...(extra.length ? ([['More', extra]] as [string, string[]][]) : [])]
    .map(([h, keys]) => `<div class="hp-sec"><h2>${esc(h)}</h2>${keys
      .filter((k) => known.has(k))
      .map((k) => `<a href="#${k}" class="${k === current ? 'on' : ''}" ${k === current ? 'aria-current="page"' : ''}>${esc(title(k))}</a>`)
      .join('')}</div>`)
    .join('');
}

/** Show a guide (and scroll to a heading in it). */
async function show(key: string, anchor?: string) {
  nav(key);
  const main = $('#hp-main');
  try {
    const d = await load(key);
    document.title = `${d.title} · GeoSpaX Help`;
    main.innerHTML = `<article class="doc">${renderMarkdown(d.markdown)}</article>`;
  } catch (e) {
    main.innerHTML = `<p class="err">This guide could not be opened: ${esc(String((e as Error).message ?? e))}</p>`;
    return;
  }
  // "On this page": the guide's sections
  const heads = [...main.querySelectorAll<HTMLElement>('h2, h3')];
  $('#hp-toc').innerHTML = heads.length
    ? `<h2>On this page</h2>${heads.map((h) => `<a href="#${key}/${h.id}" class="lv${h.tagName[1]}">${esc(h.textContent ?? '')}</a>`).join('')}`
    : '';
  const target = anchor ? document.getElementById(anchor) : null;
  if (target) target.scrollIntoView();
  else main.scrollTop = 0, window.scrollTo(0, 0);
  document.body.classList.remove('nav-open');
}

function route() {
  const [key, anchor] = decodeURIComponent(location.hash.slice(1)).split('/');
  const q = new URLSearchParams(location.search).get('q');
  if (key === 'search') return void search(anchor ?? '');
  if (!key && q) return void search(q);
  void show(key || 'USER_GUIDE', anchor);
}

/** Search every guide: matching headings first, then paragraphs, with the words marked. */
async function search(q: string) {
  q = q.trim();
  ($('#hp-q') as HTMLInputElement).value = q;
  nav('');
  $('#hp-toc').innerHTML = '';
  const main = $('#hp-main');
  if (q.length < 2) {
    main.innerHTML = '<p class="dim">Type at least two letters.</p>';
    return;
  }
  main.innerHTML = '<p class="dim">Searching…</p>';
  await Promise.all(docs.map((d) => load(d.name).catch(() => null)));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const mark = (s: string) => words.reduce((t, w) => t.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'), esc(s));
  const hits: { key: string; title: string; heading: string; anchor: string; text: string; score: number }[] = [];
  for (const d of docs) {
    const doc = cache.get(d.name);
    if (!doc) continue;
    let heading = d.title;
    let anchor = '';
    for (const raw of doc.markdown.split(/\n\s*\n/)) {
      const h = /^#{1,4}\s+(.*)$/m.exec(raw);
      if (h) {
        heading = h[1].replace(/[*`]/g, '');
        anchor = heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
      }
      const text = raw.replace(/^#{1,6}\s+/gm, '').replace(/[*`|]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
      const low = text.toLowerCase();
      if (!words.every((w) => low.includes(w))) continue;
      const at = low.indexOf(words[0]);
      const snippet = (at > 80 ? '…' : '') + text.slice(Math.max(0, at - 80), at + 180) + (text.length > at + 180 ? '…' : '');
      hits.push({ key: d.name, title: d.title, heading, anchor, text: snippet, score: (h && words.every((w) => heading.toLowerCase().includes(w)) ? 10 : 0) + (d.name === 'FAQ' ? 3 : d.name === 'USER_GUIDE' ? 2 : 0) });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  document.title = `Search: ${q} · GeoSpaX Help`;
  main.innerHTML = `<article class="doc"><h1>Search: ${esc(q)}</h1><p class="dim">${hits.length ? `${hits.length} place${hits.length === 1 ? '' : 's'} in the guides` : 'Nothing found. Try fewer or other words, or the FAQ.'}</p>
    ${hits.slice(0, 60).map((h) => `<a class="hp-hit" href="#${h.key}${h.anchor ? `/${h.anchor}` : ''}"><b>${mark(h.heading)}</b><span class="dim"> · ${esc(h.title)}</span><p>${mark(h.text)}</p></a>`).join('')}</article>`;
}

// links inside a guide: other guides and headings become help pages, the web opens outside
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a');
  if (!a) return;
  const key = location.hash.slice(1).split('/')[0] || 'USER_GUIDE';
  if (a.dataset.doc) {
    e.preventDefault();
    location.hash = a.dataset.doc;
  } else if (a.dataset.anchor) {
    e.preventDefault();
    location.hash = `${key}/${a.dataset.anchor}`;
  }
});

// theme: the app's choice (light, dark or the system's), switchable here too
const THEME_KEY = 'geospax.theme';
const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
const applyTheme = () => {
  let t = 'system';
  try { t = localStorage.getItem(THEME_KEY) ?? 'system'; } catch { /* private mode */ }
  document.documentElement.dataset.theme = t === 'system' ? (systemDark?.matches ? 'dark' : 'light') : t;
  $('#hp-theme').textContent = t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'System';
  $('#hp-theme').title = 'Theme: light, dark or the system\'s (click to change)';
};
$('#hp-theme').addEventListener('click', () => {
  let t = 'system';
  try { t = localStorage.getItem(THEME_KEY) ?? 'system'; } catch { /* */ }
  const next = t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* */ }
  applyTheme();
});
systemDark?.addEventListener?.('change', applyTheme);
applyTheme();

let timer: number | undefined;
$('#hp-q').addEventListener('input', (e) => {
  clearTimeout(timer);
  const v = (e.target as HTMLInputElement).value;
  timer = window.setTimeout(() => { if (v.trim().length >= 2) location.hash = `search/${encodeURIComponent(v.trim())}`; }, 250);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#hp-q').focus();
  }
});
$('#hp-menu').addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  $('#hp-menu').setAttribute('aria-expanded', String(open));
});
window.addEventListener('hashchange', route);
// desktop: Help › … in the app points this window at another guide
if ('__TAURI_INTERNALS__' in window) {
  void import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) =>
    getCurrentWebviewWindow().listen<string>('geospax:help', (e) => { location.hash = e.payload; }),
  ).catch(() => undefined);
}

(async () => {
  try {
    docs = (await backend.json<{ docs: DocInfo[] }>('api/docs')).docs;
  } catch {
    $('#hp-main').innerHTML = '<p class="err">The help needs GeoSpaX running: start GeoSpaX, then open Help › User guide.</p>';
    return;
  }
  route();
})();
