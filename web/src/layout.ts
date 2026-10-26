// GeoSpaX Layout (layout.html): the finished map page in a window of its own, like ArcGIS Pro's layout view
// or QGIS's print layout. Move it to a second monitor or full screen; zoom and pan the page; while "Live"
// is on it redraws whenever the main window's map, layers or styles change. "Make final files" asks the main
// window to make the PNG, PDF, SVG and the report (HTML and Word); their links show here when ready.
// The two windows talk over a BroadcastChannel (same origin: browser tabs and Tauri windows alike).
import './style.css';
import { createBackend } from './backend';
import { FINISH_RECIPE, LAYOUT_CHANNEL, type LayoutMsg, type LayoutSpec } from './finish';

const backend = createBackend();
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const stage = $('#lv-stage');
const page = $('#lv-page');
const state = $('#lv-state');
const live = $<HTMLInputElement>('#lv-live');
const chan = 'BroadcastChannel' in window ? new BroadcastChannel(LAYOUT_CHANNEL) : null;
const send = (m: LayoutMsg) => chan?.postMessage(m);

// ---------------------------------------------------------------- zoom and pan
let scale = 1;
let tx = 0;
let ty = 0;
let pageW = 0;
let pageH = 0;
let fitted = true; // follow the window size until the user zooms or pans

function apply() {
  page.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  $('#lv-pct').textContent = `${Math.round(scale * 100)}%`;
}
function fit() {
  if (!pageW) return;
  const r = stage.getBoundingClientRect();
  scale = Math.min((r.width - 48) / pageW, (r.height - 48) / pageH);
  tx = (r.width - pageW * scale) / 2;
  ty = (r.height - pageH * scale) / 2;
  fitted = true;
  apply();
}
/** zoom by a factor around a point of the stage (the cursor, or the middle) */
function zoom(f: number, cx?: number, cy?: number) {
  const r = stage.getBoundingClientRect();
  const x = cx ?? r.width / 2;
  const y = cy ?? r.height / 2;
  const s = Math.min(Math.max(scale * f, 0.05), 16);
  tx = x - ((x - tx) * s) / scale;
  ty = y - ((y - ty) * s) / scale;
  scale = s;
  fitted = false;
  apply();
}
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
let drag: { x: number; y: number; tx: number; ty: number } | null = null;
stage.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, tx, ty };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  tx = drag.tx + e.clientX - drag.x;
  ty = drag.ty + e.clientY - drag.y;
  fitted = false;
  apply();
});
const endDrag = () => {
  drag = null;
  stage.classList.remove('dragging');
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('dblclick', fit);
$('#lv-in').onclick = () => zoom(1.25);
$('#lv-out').onclick = () => zoom(0.8);
$('#lv-pct').onclick = () => zoom(1 / scale);
$('#lv-fit').onclick = fit;
$('#lv-full').onclick = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
window.addEventListener('resize', () => fitted && fit());
document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === '+' || e.key === '=') zoom(1.25);
  else if (e.key === '-') zoom(0.8);
  else if (e.key === '0') fit();
  else if (e.key === '1') zoom(1 / scale);
  else if (e.key === 'f' || e.key === 'F') $('#lv-full').click();
});

// ---------------------------------------------------------------- the page
let spec: LayoutSpec | null = null;
let seq = 0;

/** Draw the page as SVG (sharp at every zoom) from the main window's current map. Newer requests win. */
async function draw() {
  if (!spec) return;
  const n = ++seq;
  state.textContent = 'Updating…';
  state.className = 'lv-state busy';
  try {
    const r = await fetch(backend.url('api/preview/map'), {
      method: 'POST',
      body: JSON.stringify({ styles: spec.styles, map: spec.map, format: 'svg', dpi: 96 }),
      headers: { 'content-type': 'application/json' },
    });
    if (n !== seq) return;
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
    const svg = await r.text();
    if (n !== seq) return;
    page.innerHTML = svg;
    const el = page.querySelector('svg');
    pageW = Number(el?.getAttribute('width')) || el?.viewBox.baseVal.width || 1600;
    pageH = Number(el?.getAttribute('height')) || el?.viewBox.baseVal.height || 1000;
    page.style.width = `${pageW}px`;
    page.style.height = `${pageH}px`;
    if (fitted) fit();
    else apply();
    state.textContent = `Up to date · ${new Date().toLocaleTimeString()}`;
    state.className = 'lv-state';
  } catch (e) {
    if (n !== seq) return;
    state.textContent = `Not updated: ${String((e as Error).message ?? e)}`;
    state.className = 'lv-state err';
  }
}

// ---------------------------------------------------------------- final files
async function files() {
  const box = $('#lv-files');
  try {
    const s = await backend.json<{ recipes: { id: string; last_run?: { id: string; status: string; started_at?: string; artifacts?: string[] } | null }[] }>('api/recipes');
    const run = s.recipes.find((r) => r.id === FINISH_RECIPE)?.last_run;
    if (!run || run.status !== 'done' || !run.artifacts?.length) {
      box.innerHTML = '<span class="dim">No final files yet: “Make final files” makes the PNG, PDF, SVG and the report.</span>';
      return;
    }
    const label = (f: string) => {
      if (f.endsWith('.docx')) return 'Report (Word)';
      if (f.endsWith('report.html')) return 'Report (web page)';
      return f.split('.').pop()!.toUpperCase();
    };
    const order = (f: string) => ['.png', '.pdf', '.svg', '.docx', '.html'].findIndex((x) => f.endsWith(x));
    const shown = run.artifacts.filter((f) => order(f) >= 0).sort((a, b) => order(a) - order(b));
    box.innerHTML = `<span class="dim">Final files${run.started_at ? ` from ${esc(new Date(run.started_at).toLocaleString())}` : ''}:</span>${shown
      .map((f) => `<a href="${esc(backend.url(`api/runs/${run.id}/files/${f}`))}" download="${esc(f.split('/').pop())}" title="${esc(f)}">${esc(label(f))}</a>`)
      .join('')}`;
  } catch {
    box.textContent = '';
  }
}

$('#lv-make').onclick = () => {
  state.textContent = 'Making the final files in the main window…';
  state.className = 'lv-state busy';
  send({ type: 'make' });
};

chan?.addEventListener('message', (e: MessageEvent<LayoutMsg>) => {
  const m = e.data;
  if (m.type === 'spec') {
    spec = m.spec;
    $('#lv-title').textContent = m.spec.title ?? '';
    document.title = `${m.spec.title ? `${m.spec.title} · ` : ''}GeoSpaX Layout`;
    if (live.checked || !page.querySelector('svg')) void draw();
    else {
      state.textContent = 'The map changed: switch Live on, or press R to redraw';
      state.className = 'lv-state';
    }
  } else if (m.type === 'finished') {
    state.textContent = m.ok ? 'Final files ready' : `The final files could not be made: ${m.error ?? ''}`;
    state.className = m.ok ? 'lv-state' : 'lv-state err';
    void files();
  }
});
live.addEventListener('change', () => live.checked && void draw());
document.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && !(e.target as HTMLElement).closest('input')) void draw();
});
window.addEventListener('beforeunload', () => send({ type: 'bye' }));

if (!chan) page.innerHTML = '<p class="lv-empty">This browser cannot link two windows (no BroadcastChannel).</p>';
send({ type: 'hello' });
void files();
