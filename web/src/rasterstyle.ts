// Raster symbology (like ArcGIS Pro's Symbology pane for rasters and QGIS's Layer Styling): the
// renderer (stretch, unique classes, RGB composite, split at a value), band, colour ramp, the
// stretch range with 2–98 % and full-range presets, invert, values cleared below a threshold,
// class colours and labels, gamma, resampling and opacity. The style is saved by the engine
// (PUT api/rasters/{id}/style, kept in <state>/raster-styles.json) so the map, exports and
// reports all draw it; "Reset to automatic" goes back to the style AutoMap chose.
import type { Backend } from './backend';
import { dialog, say } from './editing';
import type { RasterInfo } from './rasters';

interface Ramp { id: string; name: string; colors: string[] }
type Style = Record<string, unknown>;

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : +v.toPrecision(4));
let ramps: Ramp[] | null = null;

export interface RasterStyleHost {
  backend: Backend;
  /** the engine sent back the raster with its new style and legend */
  updated: (r: RasterInfo) => void;
  opacity: (id: string) => number;
  setOpacity: (id: string, o: number) => void;
}

export async function openRasterStyle(host: RasterStyleHost, r: RasterInfo) {
  if (!ramps) {
    try { ramps = (await host.backend.json<{ ramps: Ramp[] }>('api/raster/ramps')).ramps; } catch { ramps = []; }
  }
  const st = r.style as Style;
  const kind = String(st.kind ?? 'stretch');
  const nb = r.bands ?? 1;
  const stats = r.stats ?? [];
  const band = num(st.band, 1);
  const grad = (id: string, inv = false) => `linear-gradient(${inv ? 270 : 90}deg,${(ramps!.find((x) => x.id === id)?.colors ?? ['#000', '#fff']).join(',')})`;
  const rampSel = (name: string, sel: unknown) =>
    `<select name="${name}" data-ramp>${ramps!.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select><div class="ramp" data-for="${name}" style="background:${grad(String(sel ?? ''), name === 'ramp' && !!st.invert)}"></div>`;
  const bandSel = (name: string, sel: number) =>
    `<select name="${name}">${Array.from({ length: nb }, (_, i) => `<option value="${i + 1}"${i + 1 === sel ? ' selected' : ''}>Band ${i + 1}</option>`).join('')}</select>`;
  const kinds: [string, string][] = [['stretch', 'Stretch (one band on a colour ramp)'], ['classes', 'Unique values (classes)'], ['split', 'Split at a value (two ramps)']];
  if (nb >= 3 || kind === 'rgb') kinds.push(['rgb', 'RGB composite (three bands)']);
  if (kind === 'aspect') kinds.push(['aspect', 'Aspect (compass directions)']);
  const classes = (Array.isArray(st.classes) ? st.classes : []) as { value: number; label?: string; color: string }[];
  const rb = (Array.isArray(st.bands) ? st.bands : [1, 2, 3]) as number[];
  const rmin = (Array.isArray(st.min) ? st.min : [0, 0, 0]) as number[];
  const rmax = (Array.isArray(st.max) ? st.max : [255, 255, 255]) as number[];
  const op = Math.round(host.opacity(r.id) * 100);

  const body = `
    <p class="hint">${esc(r.why || '')}</p>
    <label>Renderer <select name="kind">${kinds.map(([k, n]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <fieldset class="rs" data-kind="stretch">
      ${nb > 1 ? `<label>Band ${bandSel('band', band)}</label>` : ''}
      <label>Colour ramp ${rampSel('ramp', st.ramp ?? 'viridis')}</label>
      <div class="row2"><label>Min <input name="min" type="number" step="any" value="${esc(kind === 'stretch' || kind === 'split' ? round(num(st.min)) : '')}"></label>
      <label>Max <input name="max" type="number" step="any" value="${esc(kind === 'stretch' || kind === 'split' ? round(num(st.max, 1)) : '')}"></label></div>
      <div class="btnrow"><button type="button" data-preset="pct">2–98 %</button><button type="button" data-preset="full">Full range</button><button type="button" data-preset="std">Mean ± 2 SD</button></div>
      <label class="chk"><input type="checkbox" name="invert"${st.invert ? ' checked' : ''}> Invert the ramp</label>
      <label>Leave clear below (optional) <input name="clear_below" type="number" step="any" value="${esc(st.clear_below ?? '')}" placeholder="no threshold"></label>
    </fieldset>
    <fieldset class="rs" data-kind="split">
      <label>Split at <input name="at" type="number" step="any" value="${esc(num(st.at, 0))}"></label>
      <label>Ramp below ${rampSel('below', st.below ?? 'ocean')}</label>
      <label>Ramp above ${rampSel('above', st.above ?? 'terrain')}</label>
    </fieldset>
    <fieldset class="rs" data-kind="classes">
      ${classes.length ? `<table class="classes"><tr><th></th><th>Value</th><th>Label</th></tr>${classes.map((c, i) => `<tr><td><input type="color" name="cc${i}" value="${esc(c.color)}"></td><td>${esc(c.value)}</td><td><input name="cl${i}" value="${esc(c.label ?? c.value)}"></td></tr>`).join('')}</table>`
        : '<p class="hint">This raster has no class list. Unique values suit land cover and other coded rasters; use Stretch for measurements.</p>'}
    </fieldset>
    <fieldset class="rs" data-kind="rgb">
      ${['Red', 'Green', 'Blue'].map((c, i) => `<div class="row3"><label>${c} ${bandSel(`b${i}`, rb[i] ?? i + 1)}</label><label>Min <input name="mn${i}" type="number" step="any" value="${esc(round(num(rmin[i])))}"></label><label>Max <input name="mx${i}" type="number" step="any" value="${esc(round(num(rmax[i], 255)))}"></label></div>`).join('')}
      <label>Gamma <input name="gamma" type="number" min="0.1" max="5" step="0.05" value="${esc(num(st.gamma, 1))}"></label>
      <div class="btnrow"><button type="button" data-preset="rgbpct">2–98 % per band</button></div>
    </fieldset>
    <label>Resampling <select name="resampling">${[['', 'Automatic'], ['nearest', 'Nearest neighbour (sharp cells)'], ['bilinear', 'Bilinear (smooth)']].map(([v, n]) => `<option value="${v}"${(st.resampling ?? '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
    <label>Opacity <input name="opacity" type="range" min="0" max="100" step="5" value="${op}"> <output>${op} %</output></label>
    <div class="dlg-msg" data-msg></div>`;

  const build = (v: Record<string, string>): Style => {
    const k = v.kind;
    const out: Style = { ...st, kind: k };
    for (const key of ['band', 'ramp', 'min', 'max', 'invert', 'clear_below', 'at', 'below', 'above', 'bands', 'gamma', 'resampling']) delete out[key];
    const n = (x: string) => {
      const f = parseFloat(x);
      if (!Number.isFinite(f)) throw new Error('Please fill in every number');
      return f;
    };
    if (k === 'stretch' || k === 'split') {
      out.min = n(v.min);
      out.max = n(v.max);
      if (out.min === out.max) throw new Error('Min and max must differ');
      if (nb > 1) out.band = +v.band;
      if (k === 'stretch') {
        out.ramp = v.ramp;
        if (v.invert) out.invert = true;
        if (v.clear_below.trim()) out.clear_below = n(v.clear_below);
      } else {
        out.at = n(v.at);
        out.below = v.below;
        out.above = v.above;
      }
      if (k === 'stretch' && st.kind !== 'stretch') delete out.labels;
    } else if (k === 'classes') {
      if (!classes.length) throw new Error('This raster has no classes to colour');
      out.classes = classes.map((c, i) => ({ ...c, color: v[`cc${i}`], label: v[`cl${i}`] || String(c.value) }));
    } else if (k === 'rgb') {
      out.bands = [0, 1, 2].map((i) => +v[`b${i}`]);
      out.min = [0, 1, 2].map((i) => n(v[`mn${i}`]));
      out.max = [0, 1, 2].map((i) => n(v[`mx${i}`]));
      out.gamma = n(v.gamma);
    }
    if (v.resampling) out.resampling = v.resampling;
    host.setOpacity(r.id, +v.opacity / 100);
    out.opacity = +v.opacity / 100;
    return out;
  };

  const save = async (v: Record<string, string>, root: HTMLElement, reset = false) => {
    say(root, reset ? 'Going back to the automatic style…' : 'Applying…');
    const id = encodeURIComponent(r.id);
    const info = reset
      ? await host.backend.json<RasterInfo>(`api/rasters/${id}/style`, { method: 'DELETE' })
      : await host.backend.json<RasterInfo>(`api/rasters/${id}/style`, { method: 'PUT', body: JSON.stringify(build(v)), headers: { 'content-type': 'application/json' } });
    host.updated(info);
    say(root, reset ? 'Back to the automatic style' : 'Applied', 'ok');
    return info;
  };

  await dialog(`Symbology · ${r.title}`, body, [['ok', 'Apply and close'], ['apply', 'Apply'], ['reset', 'Reset to automatic'], ['', 'Cancel']], {
    wide: true,
    onOpen: (root) => {
      const show = () => {
        const k = root.querySelector<HTMLSelectElement>('[name=kind]')!.value;
        root.querySelectorAll<HTMLElement>('fieldset.rs').forEach((f) => {
          // a split ramp uses the stretch range and band too
          f.hidden = !(f.dataset.kind === k || (k === 'split' && f.dataset.kind === 'stretch'));
        });
        root.querySelectorAll<HTMLElement>('[data-kind=stretch] [name=ramp], [data-kind=stretch] [data-for=ramp], [data-kind=stretch] [name=invert], [data-kind=stretch] [name=clear_below]').forEach((el) => {
          (el.closest('label') ?? el).toggleAttribute('hidden', k === 'split');
        });
      };
      show();
      root.querySelector('[name=kind]')!.addEventListener('change', show);
      root.addEventListener('change', (e) => {
        const t = e.target as HTMLSelectElement;
        const inv = !!root.querySelector<HTMLInputElement>('[name=invert]')?.checked;
        if (t.dataset.ramp !== undefined) root.querySelector<HTMLElement>(`[data-for=${t.name}]`)!.style.background = grad(t.value, t.name === 'ramp' && inv);
        if (t.name === 'invert') root.querySelector<HTMLElement>('[data-for=ramp]')!.style.background = grad(root.querySelector<HTMLSelectElement>('[name=ramp]')!.value, inv);
      });
      root.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement;
        if (t.name === 'opacity') t.nextElementSibling!.textContent = `${t.value} %`;
      });
      root.addEventListener('click', (e) => {
        const p = (e.target as HTMLElement).dataset.preset;
        if (!p) return;
        const set = (n: string, x: number) => { root.querySelector<HTMLInputElement>(`[name=${n}]`)!.value = String(round(x)); };
        if (p === 'rgbpct') {
          for (const i of [0, 1, 2]) {
            const s = stats[+root.querySelector<HTMLSelectElement>(`[name=b${i}]`)!.value - 1];
            if (s) { set(`mn${i}`, s.p2); set(`mx${i}`, s.p98); }
          }
          return;
        }
        const b = +(root.querySelector<HTMLSelectElement>('[name=band]')?.value ?? 1);
        const s = stats[b - 1];
        if (!s) return say(root, 'No statistics for this band', 'err');
        const [lo, hi] = p === 'pct' ? [s.p2, s.p98] : p === 'full' ? [s.min, s.max] : [s.mean - 2 * s.std, s.mean + 2 * s.std];
        set('min', lo);
        set('max', hi);
      });
    },
    onButton: async (b, v, root) => {
      try {
        await save(v, root, b === 'reset');
      } catch (e) {
        say(root, e instanceof Error ? e.message : String(e), 'err');
        return false;
      }
      return b !== 'apply';
    },
  });
}
