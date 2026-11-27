// Outside links in the desktop app (web/src/links.ts): the desktop window ignores target="_blank" and
// window.open(), so the update banner's Download link, About and the guides' links must go to the default
// browser through the opener plugin, while links to the engine itself stay inside the app.
//   node --experimental-strip-types --no-warnings scripts/test-external-links.mjs   (after npm ci in web/)
import assert from 'node:assert/strict';

const calls = [];
const opened = [];
globalThis.location = { href: 'http://tauri.localhost/index.html' };
globalThis.window = {
  __TAURI_INTERNALS__: { invoke: async (cmd, args) => { calls.push([cmd, args]); } },
  open: (...a) => { opened.push(a); return null; },
};
const { isExternal, openExternal, routeExternalLinks, inDesktop } = await import('../web/src/links.ts');

const base = location.href;
assert.ok(inDesktop(), 'the stub counts as the desktop app');
assert.ok(isExternal('https://github.com/jmozez/geospax/releases/tag/v3.2.1', base), 'a GitHub release page is outside');
assert.ok(isExternal('mailto:someone@example.org', base), 'mailto is outside');
assert.ok(!isExternal('http://gis.localhost/api/runs/1/files/report.html', base), 'the engine (gis.localhost) stays inside');
assert.ok(!isExternal('http://127.0.0.1:8080/api/health', base), 'the local web server stays inside');
assert.ok(!isExternal('/help.html#FAQ', base), 'a page of the app stays inside');
assert.ok(!isExternal('#top', base), 'an anchor on this page stays inside');
assert.ok(!isExternal('gis://localhost/api/x', base), 'the gis: scheme stays inside');
assert.ok(!isExternal('javascript:alert(1)', base), 'javascript: is never opened');
assert.ok(isExternal('https://github.com/jmozez/geospax', 'gis://localhost/index.html'), 'a base without an origin still sees GitHub as outside');

// the update banner: a click on Download opens the release page through the opener plugin
await openExternal('https://github.com/jmozez/geospax/releases/tag/v3.2.1');
assert.deepEqual(calls[0], ['plugin:opener|open_url', { url: 'https://github.com/jmozez/geospax/releases/tag/v3.2.1', with: undefined }], 'opener plugin asked to open the release page');
assert.equal(opened.length, 0, 'window.open is not used on the desktop');

// a link inside the app is not sent to the browser
await openExternal('http://gis.localhost/api/design/dxf?path=a.dxf');
assert.equal(calls.length, 1, 'engine files are not given to the opener');
assert.equal(opened.length, 1, 'they keep using window.open');

// the opener failing (no permission) falls back to window.open rather than doing nothing
window.__TAURI_INTERNALS__.invoke = async () => { throw new Error('opener.open_url not allowed'); };
const warn = console.warn; console.warn = () => {};
await openExternal('https://example.org/');
console.warn = warn;
assert.deepEqual(opened.at(-1), ['https://example.org/', '_blank', 'noopener'], 'fallback to window.open');

// the web edition: no Tauri, a plain new tab
delete window.__TAURI_INTERNALS__;
assert.ok(!inDesktop(), 'browser');
await openExternal('https://github.com/jmozez/geospax/releases');
assert.deepEqual(opened.at(-1), ['https://github.com/jmozez/geospax/releases', '_blank', 'noopener'], 'web edition opens a new tab');

// click routing: outside links are taken over, the rest are left to the webview
let handler;
const root = { addEventListener: (type, fn) => { assert.equal(type, 'click'); handler = fn; } };
const sent = [];
routeExternalLinks(root, () => base, (u) => sent.push(u));
const link = (href, attrs = {}) => ({ getAttribute: (n) => (n === 'href' ? href : attrs[n] ?? null), hasAttribute: (n) => n in attrs });
const click = (a, extra = {}) => {
  const e = { button: 0, defaultPrevented: false, target: { closest: () => a }, preventDefault() { this.defaultPrevented = true; }, ...extra };
  handler(e);
  return e.defaultPrevented;
};
assert.ok(click(link('https://github.com/jmozez/geospax/releases/tag/v3.2.1')), 'Download click is taken over');
assert.deepEqual(sent, ['https://github.com/jmozez/geospax/releases/tag/v3.2.1'], 'and sent to the browser');
assert.ok(!click(link('http://gis.localhost/api/runs/1/files/map.png')), 'an engine file link is left alone');
assert.ok(!click(link('https://example.org/data.zip', { download: '' })), 'a download link is left alone');
assert.ok(!click(link('https://example.org/'), { button: 1 }), 'a middle click is left alone');
click(link('https://example.org/'), { defaultPrevented: true });
assert.equal(sent.length, 1, 'a click another handler took is left alone');
assert.ok(!click(null), 'a click outside any link is left alone');
assert.equal(sent.length, 1, 'nothing else was opened');

console.log('external links: all checks passed');
