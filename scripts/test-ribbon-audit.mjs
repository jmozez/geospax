// Functional audit of every ribbon item: clicks each button (and each entry of every dropdown
// and split button) through the real ribbon in headless Chromium, on the test data, and records
// what it did: a dialog, a file, a pane, a map change, a tool that stays pressed …
//
//   node scripts/test-ribbon-audit.mjs <base-url> <out-dir> [--strict] [--only=tab,tab]
//
// With --strict (CI) every item must show the effect expected for it (EXPECT below), toggles
// must stay pressed until clicked again, only one map tool may be pressed at a time, and every
// export entry must produce a non-empty file. Results go to <out-dir>/ribbon-audit.json.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const base = (process.argv[2] || 'http://127.0.0.1:18120').replace(/\/$/, '');
const out = process.argv[3] || '/tmp/ribbon-audit';
const strict = process.argv.includes('--strict');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });
const dlDir = path.join(out, 'downloads');
fs.mkdirSync(dlDir, { recursive: true });

// ------------------------------------------------------------------ what each item should do
// kinds: dialog, file, pane:<dock>/<tab>, view, tool:<map tool>, state:<dataset key>, popup,
// docs, print, clipboard, chooser, layer (a layer added), overlay, menu, status (feedback only:
// for items that need something the test data does not have, e.g. a DEM or the internet)
const EXPECT = {
  // Home
  'home.new': 'dialog', 'home.open': 'dialog', 'home.save': 'dialog|status', 'home.saveAs': 'dialog', 'home.rename': 'dialog',
  'home.settings': 'dialog|pane', 'home.refresh': 'status', 'home.start': 'overlay',
  'home.addData': 'chooser|dialog|pane', 'home.basemap': 'menu|dialog|overlay', 'home.contents': 'pane|status', 'home.zoomLayer': 'view',
  'view.zoomIn': 'view', 'view.zoomOut': 'view', 'view.zoomAll': 'view', 'home.prevExtent': 'view', 'home.nextExtent': 'view',
  'home.goto': 'dialog', 'view.bookmarks': 'pane|menu|dialog', 'view.addBookmark': 'dialog|status',
  'sel.attributes': 'dialog', 'sel.location': 'dialog', 'home.attributes': 'pane', 'sel.zoom': 'view', 'sel.clear': 'state', 'home.lasso': 'tool:edit:lasso',
  'home.identify': 'tool:identify', 'home.findPlace': 'dialog', 'measure.distance': 'tool:measure:distance', 'measure.area': 'tool:measure:area', 'measure.clear': 'status|state',
  'home.coords': 'dialog|state|status', 'style.panel': 'pane|status', 'home.labels': 'state', 'style.auto': 'status', 'style.autoAll': 'status', 'style.attributes': 'pane|status', 'style.legend': 'pane|status',
  // View
  'view.swipe': 'tool:swipe', 'view.spyglass': 'tool:spyglass', 'view.time': 'dialog', 'view.grid': 'state', 'view.scale': 'dialog', 'view.lockscale': 'state', 'view.crs': 'dialog',
  'view.projMercator': 'state', 'view.projGlobe': 'state', 'view.terrain3d': 'status|state|dialog',
  'view.basemapGallery': 'dialog|overlay|menu', 'view.basemapOffline': 'state|view|status', 'view.basemapOsm': 'state|view', 'view.basemapNone': 'state|view',
  'view.themeLight': 'state', 'view.themeDark': 'state', 'view.themeSystem': 'state',
  'view.palette': 'overlay|dialog', 'view.dockLeft': 'pane', 'view.dockRight': 'pane', 'view.dockBottom': 'pane', 'view.resetLayout': 'pane|status',
  'view.ribbonAutoHide': 'state|pane', 'view.ribbonGallery': 'state|status', 'view.ribbonList': 'state|status', 'view.fullscreen': 'state',
  // Edit
  'edit.point': 'tool:edit:point', 'edit.line': 'tool:edit:line', 'edit.polygon': 'tool:edit:polygon', 'edit.trace': 'state', 'edit.gps': 'status',
  'edit.select': 'tool:edit:select', 'edit.box': 'tool:edit:box', 'edit.vertices': 'tool:edit:vertices|dialog', 'edit.attributes': 'dialog', 'edit.delete': 'dialog|state',
  'edit.lasso': 'tool:edit:lasso', 'edit.split': 'tool:edit:split|dialog', 'edit.merge': 'dialog|state|status', 'edit.cut': 'tool:edit:cut|dialog', 'edit.reshape': 'tool:edit:reshape|dialog',
  'edit.copy': 'status', 'design.copyFeatures': 'status|clipboard', 'design.pasteFeatures': 'status|dialog|state', 'edit.paste': 'status|dialog', 'edit.copyalong': 'dialog|tool:edit:copyalong|status',
  'edit.calculate': 'dialog', 'edit.addField': 'dialog', 'edit.table': 'pane', 'edit.defquery': 'dialog', 'edit.rules': 'dialog',
  'edit.undo': 'status', 'edit.redo': 'status', 'edit.snap': 'state', 'edit.new': 'dialog', 'edit.discard': 'dialog|status', 'edit.topology': 'pane',
  'edit.sel.attributes': 'dialog', 'edit.sel.location': 'dialog', 'edit.sel.zoom': 'view', 'edit.sel.clear': 'state',
  'edit.measure.distance': 'tool:measure:distance', 'edit.measure.area': 'tool:measure:area', 'edit.measure.clear': 'status|state',
  // Share
  'home.finish': 'dialog|overlay', 'share.layout': 'dialog|overlay|popup', 'edit.export': 'dialog|layer|status',
  'home.exportPng': 'file', 'home.copyLink': 'clipboard|status',
  'share.map.pdf': 'file', 'share.map.svg': 'file', 'share.map.png': 'file', 'share.map.report': 'file',
  'share.data.gpkg': 'file', 'share.data.shp': 'file', 'share.data.kml': 'file', 'share.data.csv': 'file', 'share.data.geojson': 'file', 'share.data.parquet': 'file',
  'share.publish': 'file', 'share.package': 'file', 'share.print': 'print',
  // Help
  'help.tutorials': 'dialog', 'help.search': 'overlay|dialog', 'help.guide': 'docs', 'help.faq': 'docs', 'help.automation': 'docs', 'help.whatsnew': 'docs', 'help.matrix': 'docs',
  'help.updates': 'docs', 'help.report': 'popup', 'help.keys': 'dialog|docs|overlay', 'help.credits': 'docs', 'help.about': 'docs', 'help.diagnostics': 'pane', 'analyze.bench': 'status|pane|dialog', 'analyze.deck': 'status|state|view',
  // Layer (contextual)
  'data.rasters': 'pane|status', 'analyze.gallery': 'pane|status',
  'layer.zoom': 'view', 'layer.table': 'pane',
};
// families by prefix
const famExpect = (id) => {
  if (EXPECT[id]) return EXPECT[id];
  if (/^design\.(line|polyline|polygon|rect|circle|arc|ellipse|point|text|offset|road|move|copy|rotate|scale|mirror|trim|extend|fillet|array|arraypolar|divide|measure|block|lock|union|subtract|intersect|explode|join|break|lengthen|chamfer|stretch|list|align|erase|dimension|dimangle|leader)$/.test(id))
    return `tool:cad:${id.slice(7)}|status`;
  if (/^design\.(snap|ortho|polar)$/.test(id)) return 'state';
  if (/^design\.(undo|redo)$/.test(id)) return 'status';
  if (/^design\./.test(id)) return 'dialog|chooser|file|status';
  if (/^analyze\.tool\.|^analyze\.(zonal|servicearea|closest|route)$|^imagery\.(ndi|index|hillshade|slope|aspect|tri|twi|viewshed|profile|change|clip|mosaic|reproject|resample)$/.test(id)) return 'pane';
  // recipes: a run starts (body data-recipe-run) and a status reports the outcome
  if (/^imagery\.(ndvi|terrain|landforms|lidar)$|^analyze\.(hotspots|kriging)$|^modelling\./.test(id)) return 'dialog|pane|status|run';
  if (/^imagery\.(embeddings|similar|groups|classifyEmb|embChange|detect|models)$/.test(id)) return 'dialog';
  if (/^(analyze|imagery|data|automate)\./.test(id)) return 'pane|dialog';
  if (/^layer\./.test(id)) return 'pane|dialog|view|state|status|file';
  return 'any';
};

// ------------------------------------------------------------------ browser
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
await ctx.addInitScript(() => {
  const w = window;
  // the one-time "Edit this layer?" notice is tested on its own below; "Don't ask again" for the rest
  try { if (!sessionStorage.getItem('audit.askEdit')) localStorage.setItem('geospax.edit.copy-ok', '1'); } catch { /* ignore */ }
  w.__audit = { status: [], opened: [], printed: 0, clip: [], dialogs: [] };
  w.open = (u) => { w.__audit.opened.push(String(u)); return null; };
  w.print = () => { w.__audit.printed++; };
  try {
    const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (navigator.clipboard) navigator.clipboard.writeText = async (t) => { w.__audit.clip.push(String(t)); try { await orig?.(t); } catch { /* headless */ } };
  } catch { /* ignore */ }
  // fullscreen is not allowed headless without a gesture: record the request
  Element.prototype.requestFullscreen = function () { w.__audit.fullscreen = true; document.body.dataset.auditFullscreen = '1'; return Promise.resolve(); };
  new MutationObserver(() => {}).observe(document, { childList: true });
  document.addEventListener('DOMContentLoaded', () => {
    const sb = document.querySelector('#sb-msg');
    if (sb) new MutationObserver(() => w.__audit.status.push(sb.textContent)).observe(sb, { childList: true, characterData: true, subtree: true });
  });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', async (d) => { await page.evaluate((m) => window.__audit.dialogs.push(m), d.message()).catch(() => {}); await d.dismiss().catch(() => {}); });
let downloads = [];
page.on('download', (d) => downloads.push(d));
let chooser = 0;
page.on('filechooser', () => { chooser++; });

await page.goto(`${base}/?fresh`);
await page.waitForFunction(() => window.map && window.workbench && window.map.loaded(), null, { timeout: 120000 });
// a line layer to draw lines into (the sample data has points and polygons only)
const made = await page.evaluate(async () => {
  const have = await fetch('api/layers').then((r) => r.json()).catch(() => []);
  const list = Array.isArray(have) ? have : have.layers ?? [];
  if (list.some((l) => /tracks/.test(l.id ?? l.name ?? ''))) return 'kept';
  const r = await fetch('api/layers/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'tracks', geometry: 'line', fields: [] }) });
  return r.ok ? (await r.json()).layer?.id : `HTTP ${r.status}`;
});
console.log('line layer:', made);
await page.reload();
await page.waitForFunction(() => window.map && window.workbench && window.map.loaded(), null, { timeout: 120000 });
await page.waitForTimeout(1500);
const LINE = await page.evaluate(() => document.querySelector('#contents [data-id*="tracks"]')?.dataset.id ?? '');

const TABS = await page.$$eval('#ribbon-tabs .rb-tab', (bs) => bs.map((b) => b.dataset.tab));

async function selectLayer(id) {
  await page.evaluate((id) => {
    // a click on the card body selects the layer (the swatch would open its style instead)
    const row = () => document.querySelector(`#contents [data-id="${CSS.escape(id)}"]`);
    const r = row();
    if (r && !r.classList.contains('selected')) r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, id);
  await page.waitForTimeout(250);
}
async function selectSome(id, n = 2) {
  await page.evaluate(async ([id, n]) => {
    const r = await fetch(`api/layers/${encodeURIComponent(id)}/table`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: n }) }).then((x) => x.json());
    const fi = r.fields.indexOf('fid');
    const fids = r.rows.map((row, i) => (row.fid ?? (fi >= 0 ? row.values[fi] : i + 1)));
    window.editor?.setSelection(id, fids);
  }, [id, n]).catch(() => {});
}

async function snap() {
  return page.evaluate(() => {
    const m = window.map, wb = window.workbench;
    const vis = (e) => !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const st = m.getStyle();
    return {
      view: [m.getCenter().lng.toFixed(4), m.getCenter().lat.toFixed(4), m.getZoom().toFixed(2), m.getBearing().toFixed(1), m.getPitch().toFixed(1)].join(','),
      styleSig: st.layers.map((l) => l.id + ':' + JSON.stringify(l.layout ?? {}) + JSON.stringify(l.paint ?? {}).length).join('|').length + ':' + st.layers.length + ':' + Object.keys(st.sources).join(','),
      projection: JSON.stringify(m.getProjection?.() ?? null),
      body: JSON.stringify(Object.fromEntries(Object.entries(document.body.dataset).filter(([k]) => !['saved', 'gl', 'auditFullscreen'].includes(k)))), html: JSON.stringify(document.documentElement.dataset),
      layout: JSON.stringify({ tabs: wb.layout?.tabs, collapsed: wb.layout?.collapsed, compact: wb.layout?.compact, pinned: wb.layout?.ribbonPinned }),
      ribbonHidden: document.querySelector('#ribbon-body')?.hidden ?? null,
      modals: [...document.querySelectorAll('.modal, [role=dialog]')].filter(vis).map((x) => (x.querySelector('header b, h2, h3, .title')?.textContent || x.className).trim().slice(0, 60)),
      overlays: [...document.querySelectorAll('.gx-compare, .gx-time, .gx-lens, .gx-swipe-bar, .measure-box, .cad-bar, .maplibregl-popup, .palette, .cmd-palette, #palette, .start-screen, #start, .kbar, .tour, .gx-grid')].filter(vis).map((x) => x.className.split(' ')[0] || x.id),
      menus: [...document.querySelectorAll('.rb-menu, .gx-menu, .ctx-menu, .basemap-gallery')].filter(vis).length,
      layers: document.querySelectorAll('#contents .layer').length,
      title: document.title,
      sbProject: document.querySelector('#sb-project')?.textContent ?? '',
      audit: JSON.stringify({ o: window.__audit.opened.length, p: window.__audit.printed, c: window.__audit.clip.length, d: window.__audit.dialogs.length, f: !!window.__audit.fullscreen }),
      opened: window.__audit.opened.slice(-1)[0] ?? '',
      docs: vis(document.querySelector('.docs-modal')),
      mapTool: document.body.dataset.mapTool ?? '',
      editTool: window.editor?.tool ?? '',
      toolbox: window.toolbox?.current?.key ?? '',
      status: window.__audit.status.slice(),
    };
  });
}

function effects(a, b, dl, ch) {
  const e = [];
  if (b.modals.length > a.modals.length || (b.modals.join() !== a.modals.join() && b.modals.length)) e.push(b.docs ? 'docs' : 'dialog');
  if (b.docs && !a.docs) e.push('docs');
  if (dl.length) e.push('file');
  if (ch) e.push('chooser');
  if (a.view !== b.view) e.push('view');
  if (a.layout !== b.layout || a.toolbox !== b.toolbox) e.push('pane');
  if ((b.editTool && b.editTool !== 'idle' && b.editTool !== a.editTool) || b.overlays.some((o) => /measure|cad-bar|gx-compare/.test(o) && !a.overlays.includes(o))) e.push('tool');
  if (a.body !== b.body || a.html !== b.html || a.projection !== b.projection || a.styleSig !== b.styleSig || a.ribbonHidden !== b.ribbonHidden) e.push('state');
  if (b.mapTool && b.mapTool !== a.mapTool) e.push(`tool:${b.mapTool}`);
  if (b.overlays.join() !== a.overlays.join()) e.push('overlay');
  if (b.menus > a.menus) e.push('menu');
  if (b.layers > a.layers) e.push('layer');
  const au = JSON.parse(a.audit), bu = JSON.parse(b.audit);
  if (bu.o > au.o) e.push(/^https?:/.test(b.opened) ? 'popup' : 'popup');
  if (bu.p > au.p) e.push('print');
  if (bu.c > au.c) e.push('clipboard');
  if (bu.d > au.d) e.push('dialog');
  if (bu.f && !au.f) e.push('state');
  { const ab = JSON.parse(a.body), bb = JSON.parse(b.body);
    if ((bb.recipeRunId && bb.recipeRunId !== ab.recipeRunId) || (bb.recipeRun === 'running' && ab.recipeRun !== 'running')) e.push('run'); }
  const newStatus = b.status.slice(a.status.length).filter((t) => t && t !== 'Ready' && !/…$/.test(t));
  if (newStatus.length) e.push('status');
  return { e: [...new Set(e)], status: newStatus.slice(-1)[0] ?? '', modal: b.modals.filter((m) => !a.modals.includes(m)).join(' / ') };
}

async function reset() {
  // close menus, dialogs, docs, end tools, back to a known layer
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('.rb-menu').forEach((m) => m.remove());
    for (const m of document.querySelectorAll('.modal')) {
      const close = m.querySelector('[data-btn=""], .close, [aria-label=Close], [data-close]');
      if (close && !m.hidden) close.click();
    }
    document.querySelectorAll('.gx-dialog').forEach((m) => m.remove());
    document.querySelector('.docs-modal [aria-label=Close], .docs-modal .close')?.click();
  }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}

async function openTab(tab) {
  await page.click(`#ribbon-tabs [data-tab="${tab}"]`);
  await page.waitForTimeout(250);
  // an auto-hidden ribbon opens on a tab click; make sure the body is there
  const hidden = await page.evaluate(() => document.querySelector('#ribbon-body')?.hidden);
  if (hidden) { await page.click(`#ribbon-tabs [data-tab="${tab}"]`); await page.waitForTimeout(250); }
}

/** Every reachable item of a tab: direct buttons, split buttons' main part, and menu entries. */
async function enumerate(tab) {
  await openTab(tab);
  const items = await page.evaluate(() => {
    const body = document.querySelector('#ribbon-body');
    const out = [];
    for (const g of body.querySelectorAll(':scope > .rb-group')) {
      const group = g.querySelector('.rb-title')?.textContent?.trim() ?? '';
      for (const b of g.querySelectorAll('button')) {
        if (b.closest('.rb-title')) continue;
        const label = (b.querySelector('.rb-label')?.textContent ?? b.textContent ?? '').replace(/\s+/g, ' ').replace('▾', '').trim();
        const big = b.classList.contains('big');
        if (b.dataset.split) out.push({ group, label, kind: 'split-main', cmd: b.dataset.cmd, split: b.dataset.split, big });
        else if (b.dataset.splitArrow) out.push({ group, label, kind: 'split-arrow', split: b.dataset.splitArrow, big });
        else if (b.dataset.cmd) out.push({ group, label, kind: 'button', cmd: b.dataset.cmd, big, toggle: b.hasAttribute('aria-pressed') });
        else if (b.dataset.menu) out.push({ group, label, kind: 'menu', menu: b.dataset.menu, big });
        else if (b.dataset.recipe) out.push({ group, label, kind: 'recipe', recipe: b.dataset.recipe });
        else if (b.dataset.pluginTool) out.push({ group, label, kind: 'plugin', tool: b.dataset.pluginTool });
        else if (b.dataset.toolbox) out.push({ group, label, kind: 'toolbox', toolbox: b.dataset.toolbox });
        else if (b.dataset.next) out.push({ group, label, kind: 'next', next: b.dataset.next });
      }
    }
    return out;
  });
  // entries inside menus (split buttons, dropdowns and collapsed groups)
  const res = [];
  for (const it of items) {
    if (it.kind === 'split-arrow' || it.kind === 'menu') {
      const sel = it.kind === 'split-arrow' ? `#ribbon-body [data-split-arrow="${it.split}"]` : `#ribbon-body [data-menu="${it.menu}"]`;
      await page.click(sel);
      await page.waitForTimeout(250);
      const entries = await page.evaluate(() => [...document.querySelectorAll('.rb-menu [data-cmd]')].map((b) => ({
        cmd: b.dataset.cmd, label: (b.querySelector('.rb-label, .rm-name')?.textContent ?? b.textContent).replace(/\s+/g, ' ').trim(),
        desc: b.getAttribute('title') ?? '', toggle: b.hasAttribute('aria-pressed'),
      })));
      const inMenu = await page.evaluate(() => {
        const m = document.querySelector('.rb-menu');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight };
      });
      const recipes = await page.evaluate(() => document.querySelectorAll('.rb-menu [data-recipe]').length);
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelectorAll('.rb-menu').forEach((m) => m.remove()));
      res.push({ ...it, entries: entries.length + recipes, inWindow: inMenu ? inMenu.left >= 0 && inMenu.right <= inMenu.w && inMenu.top >= 0 && inMenu.bottom <= inMenu.h : null });
      for (const en of entries) res.push({ group: it.group, label: en.label, kind: 'menu-entry', cmd: en.cmd, via: sel, parent: it.label, toggle: en.toggle, desc: en.desc });
    } else res.push(it);
  }
  return res;
}

async function click(it) {
  if (it.kind === 'menu-entry') {
    await page.click(it.via);
    await page.waitForTimeout(200);
    await page.click(`.rb-menu [data-cmd="${it.cmd}"]`);
  } else if (it.kind === 'split-main') await page.click(`#ribbon-body [data-split="${it.split}"]`);
  else await page.click(`#ribbon-body [data-cmd="${it.cmd}"]`);
}

const isPressed = (cmd) => page.evaluate((cmd) => {
  const bs = [...document.querySelectorAll(`#ribbon-body [data-cmd="${cmd}"], #ribbon-body [data-split][data-cmd="${cmd}"]`)];
  return bs.some((b) => b.getAttribute('aria-pressed') === 'true' && b.classList.contains('on'));
}, cmd);
const pressedCount = () => page.evaluate(() => document.querySelectorAll('#ribbon-body [aria-pressed=true][data-maptool]').length);

const results = [];
const layerFor = (id) => (/edit\.(point)|design\.|view\.time/.test(id) ? 'survey.geojson' : /^edit\.line$/.test(id) && LINE ? LINE : 'reserves.geojson');
// tools that work on one feature (vertices, attributes, split, reshape) get exactly one selected
const oneFeature = (id) => /^edit\.(vertices|attributes|split|reshape|cut)$/.test(id);
for (const tab of TABS) {
  if (only.length && !only.includes(tab)) continue;
  await reset();
  await selectLayer('reserves.geojson');
  const items = await enumerate(tab);
  await page.screenshot({ path: path.join(out, `tab-${tab}.png`), clip: { x: 0, y: 0, width: 1600, height: 170 } });
  for (const it of items) {
    if (!it.cmd || it.kind === 'split-arrow') { results.push({ tab, ...it, result: it.kind === 'split-arrow' || it.kind === 'menu' ? (it.entries ? 'ok' : 'empty') : 'n/a', effects: [] }); continue; }
    if (/^(view\.fullscreen)$/.test(it.cmd) && false) continue;
    await reset();
    await page.evaluate(() => window.workbench && window.__audit && (window.__audit.status.length = window.__audit.status.length));
    const lid = layerFor(it.cmd);
    await selectLayer(lid);
    await selectSome(lid, oneFeature(it.cmd) ? 1 : 2);
    // clearing measurements needs one to clear
    if (/measure\.clear$/.test(it.cmd)) await page.evaluate(() => document.dispatchEvent(new CustomEvent('geospax:measure', { detail: 'distance' }))).catch(() => {});
    if (/^home\.nextExtent$/.test(it.cmd)) { await page.evaluate(() => window.map.zoomIn({ duration: 0 })); await page.waitForTimeout(200); await page.evaluate(() => document.dispatchEvent(new CustomEvent('geospax:extent', { detail: 'back' }))); await page.waitForTimeout(300); }
    if (/^home\.prevExtent$/.test(it.cmd)) { await page.evaluate(() => window.map.zoomOut({ duration: 0 })); await page.waitForTimeout(300); }
    if (/sel\.zoom$/.test(it.cmd)) { await page.evaluate(() => window.map.jumpTo({ zoom: 2, center: [0, 0] })); await page.waitForTimeout(200); }
    await page.evaluate(() => {
      const wb = window.workbench;
      if (wb.layout.tabs.right !== 'layer') wb.showTab('right', 'layer');
      if (wb.layout.tabs.bottom !== 'automate') wb.showTab('bottom', 'automate');
      if (wb.layout.tabs.left !== 'contents') wb.showTab('left', 'contents');
      if (window.toolbox) window.toolbox.current = undefined;
    });
    await openTab(tab);
    downloads = []; chooser = 0;
    const pre = it.toggle ? await isPressed(it.cmd) : false;
    const a = await snap();
    let err = '';
    try { await click(it); } catch (e) { err = String(e.message).split('\n')[0]; }
    const exp = famExpect(it.cmd);
    const wantFile = /file/.test(exp);
    await page.waitForTimeout(wantFile ? 900 : 700);
    // a dialog that asks before writing a file: accept it, then wait for the file
    if (wantFile) {
      for (let i = 0; i < 25 && !downloads.length; i++) {
        const ok = await page.$('.modal:not([hidden]) footer button.primary, .modal:not([hidden]) [data-btn=ok]');
        if (ok && i % 5 === 0) await ok.click().catch(() => {});
        await page.waitForTimeout(400);
      }
    }
    const b = await snap();
    const { e, status, modal } = effects(a, b, downloads, chooser);
    let files = [];
    for (const d of downloads) {
      const name = d.suggestedFilename();
      const p = path.join(dlDir, `${it.cmd}__${name}`);
      try { await d.saveAs(p); files.push({ name, size: fs.statSync(p).size }); } catch (x) { files.push({ name, size: 0, err: String(x) }); }
    }
    const alts = exp.split('|');
    let ok = exp === 'any' ? e.length > 0 : alts.some((k) => (k === 'pane' ? e.includes('pane') || e.some((x) => x.startsWith('pane')) : k.startsWith('tool:') ? e.includes(k) : e.includes(k)));
    if (wantFile && alts.length === 1) ok = files.some((f) => f.size > 0);
    // a choice that was already the selected one (a theme, a basemap) only confirms it
    if (!ok && pre && e.includes('status') && (await isPressed(it.cmd))) ok = true;
    // toggles: stay pressed until clicked again, then released
    let toggle = '';
    let worksNoHighlight = false;
    if (!ok && exp.startsWith('tool:') && e.includes('tool')) worksNoHighlight = true;
    if (exp.startsWith('tool:') || it.toggle) {
      const p1 = await isPressed(it.cmd);
      const exclusive = await pressedCount();
      await page.waitForTimeout(1200);
      const p2 = await isPressed(it.cmd);
      toggle = `pressed=${p1}/${p2} exclusive=${exclusive}`;
      if (strict && exp.startsWith('tool:') && (!p1 || !p2 || exclusive > 1)) ok = false;
      // second click (or Esc) releases it
      if (exp.startsWith('tool:')) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        const p3 = await isPressed(it.cmd);
        toggle += ` afterEsc=${p3}`;
        if (strict && p3) ok = false;
      }
    }
    // command buttons never stay highlighted
    if (!exp.startsWith('tool:') && !it.toggle) {
      const stuck = await page.evaluate((cmd) => [...document.querySelectorAll(`#ribbon-body [data-cmd="${cmd}"]`)].some((x) => x.getAttribute('aria-pressed') === 'true'), it.cmd);
      if (stuck) { toggle = 'command stays pressed'; if (strict) ok = false; }
    }
    results.push({ tab, ...it, expect: exp, effects: e, status, modal, files, toggle, err, result: err ? 'error' : ok ? 'ok' : worksNoHighlight ? 'no-highlight' : 'fail' });
    const r = results[results.length - 1];
    console.log(`${r.result.padEnd(5)} ${tab}/${it.group}/${it.label} [${it.cmd}] expect=${exp} got=${e.join(',')} ${files.map((f) => `${f.name}:${f.size}`).join(' ')} ${toggle} ${modal ? `[${modal}] ` : ''}${status.slice(0, 90)} ${err}`);
    // undo what an item did to the window (theme, panes, ribbon) so the next one starts clean
    if (/^view\.(dockLeft|dockRight|dockBottom|ribbonAutoHide|ribbonList|ribbonGallery)$/.test(it.cmd) || /^home\.(contents|settings)$/.test(it.cmd)) {
      await page.evaluate(() => { window.workbench?.command('view.resetLayout'); });
      await page.waitForTimeout(300);
    }
    if (/^view\.(themeLight|themeSystem)$/.test(it.cmd)) await page.evaluate(() => window.workbench?.command('view.themeDark'));
    if (/^view\.(projGlobe)$/.test(it.cmd)) await page.evaluate(() => window.workbench?.command('view.projMercator'));
    if (/^(view\.grid|view\.lockscale|edit\.trace|edit\.snap|home\.labels|design\.(snap|ortho|polar))$/.test(it.cmd)) { await openTab(tab); await click(it).catch(() => {}); await page.waitForTimeout(300); }
  }
}
await reset();
const tested = results.filter((r) => r.cmd);
const okN = tested.filter((r) => r.result === 'ok').length;
fs.writeFileSync(path.join(out, 'ribbon-audit.json'), JSON.stringify({ base, tested: tested.length, ok: okN, errors, results }, null, 1));
console.log(`\n${okN}/${tested.length} ribbon items did what they should; page errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('  page error:', e);
await browser.close();
if (strict && (okN < tested.length || errors.length)) {
  for (const r of tested.filter((x) => x.result !== 'ok')) console.log(`FAIL ${r.tab}/${r.group}/${r.label} [${r.cmd}] expected ${r.expect}, got ${r.effects.join(',') || 'nothing'} ${r.toggle} ${r.err}`);
  process.exit(1);
}
