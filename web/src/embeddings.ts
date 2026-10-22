// Imagery › Satellite embeddings: AlphaEarth Foundations annual embeddings (Google DeepMind, CC-BY 4.0)
// for the map view or a layer's area, and what they are for: places like your samples, groups of alike
// landscape, a classification from labelled points, or change between two years. Like Data › Online
// data, each request becomes a small recipe ("satellite-embeddings", replaced each time), so it has run
// history, a report and its citation (engine automation/embed_steps.rs).
import type { Backend } from './backend';
import { dialog, say } from './editing';

export const EMB_RECIPE = 'satellite-embeddings';

export interface EmbHost {
  backend: Backend;
  view: () => [number, number, number, number];
  layers: () => { id: string; name: string; geometry: string; fields: { name: string; kind: string }[] }[];
  run: (recipe: string) => Promise<void>;
  setStatus: (t: string, ms?: number) => void;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const TASKS: [string, string, string][] = [
  ['look', 'Look at the embeddings', 'Three of the 64 axes as colours: alike places get alike colours. A first view of the landscape.'],
  ['similar', 'Find places like my samples', 'Points on the kind of place you are after (a forest type, a crop, a reef): every pixel gets how alike it is.'],
  ['cluster', 'Group the landscape', 'No samples needed: k groups of alike places for you to name from what you know.'],
  ['classify', 'Classify from labelled samples', 'Points with a class field (e.g. forest, garden, grassland): a map of the classes with an accuracy figure.'],
  ['change', 'Change between two years', 'How much each pixel changed between two years: clearing, new gardens, floods, building.'],
];

/** Area of a lon/lat box in km (width, height). */
function km(b: [number, number, number, number]): [number, number] {
  const lat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  return [(b[2] - b[0]) * 111.32 * Math.cos(lat), (b[3] - b[1]) * 110.57];
}

export async function openEmbeddings(host: EmbHost, task = 'look') {
  const layers = host.layers();
  const points = layers.filter((l) => l.geometry === 'point');
  const [w, h] = km(host.view());
  const years = Array.from({ length: 2025 - 2017 + 1 }, (_, i) => 2017 + i).reverse();
  const yearSel = (name: string, v: number) => `<select name="${name}">${years.map((y) => `<option${y === v ? ' selected' : ''}>${y}</option>`).join('')}</select>`;
  const layerSel = (name: string, list: typeof layers, empty: string) =>
    list.length ? `<select name="${name}">${list.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select>` : `<p class="hint">${esc(empty)}</p>`;
  const fieldSel = () => `<select name="field">${points.flatMap((l) => l.fields.filter((f) => f.kind === 'string' || f.kind === 'integer').map((f) => `<option data-layer="${esc(l.id)}" value="${esc(f.name)}">${esc(f.name)}</option>`)).join('')}</select>`;
  await dialog('Satellite embeddings', `
    <p class="hint">AlphaEarth Foundations (Google DeepMind): 64 numbers per 10 m pixel that sum up a year of radar, optical, elevation and climate observations. Read for the area only, from the public copy (CC-BY 4.0).</p>
    ${TASKS.map(([v, t, d]) => `<label class="ask-prov"><input type="radio" name="task" value="${v}"${v === task ? ' checked' : ''}><span><b>${esc(t)}</b><br><span class="dim">${esc(d)}</span></span></label>`).join('')}
    <label>Area ${`<select name="area"><option value="view">The map view (${w.toFixed(1)} × ${h.toFixed(1)} km)</option>${layers.map((l) => `<option value="${esc(l.id)}">Around ${esc(l.name)}</option>`).join('')}</select>`}</label>
    <div class="row2"><label>Year ${yearSel('year', 2024)}</label><label data-for="change">Compared with ${yearSel('year2', 2018)}</label></div>
    <div data-for="similar classify"><label>Samples (points) ${layerSel('samples', points, 'Add or draw a point layer first (Edit › New layer).')}</label></div>
    <div data-for="classify"><label>Class field ${fieldSel()}</label></div>
    <div data-for="cluster"><label>Groups <input name="classes" type="number" min="2" max="20" value="8"></label></div>
    <p class="hint">Up to 60 km a side; areas larger than about 20 km are read coarser than 10 m. The first time an area's UTM zone is used, GeoSpaX reads that zone's file list (a few seconds; kept for next time).</p>
    <div class="dlg-msg" data-msg></div>`, [['ok', 'Run'], ['', 'Cancel']], {
    wide: true,
    onOpen: (root) => {
      const sync = () => {
        const t = root.querySelector<HTMLInputElement>('input[name="task"]:checked')?.value ?? 'look';
        root.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => { el.hidden = !el.dataset.for!.split(' ').includes(t); });
        const lid = root.querySelector<HTMLSelectElement>('select[name="samples"]')?.value;
        root.querySelectorAll<HTMLOptionElement>('select[name="field"] option').forEach((o) => { o.hidden = o.dataset.layer !== lid; });
        const f = root.querySelector<HTMLSelectElement>('select[name="field"]');
        if (f && f.selectedOptions[0]?.hidden) f.value = [...f.options].find((o) => !o.hidden)?.value ?? '';
      };
      root.addEventListener('change', sync);
      sync();
    },
    onButton: async (b, v, root) => {
      if (b !== 'ok') return true;
      const t = v.task || 'look';
      if ((t === 'similar' || t === 'classify') && !v.samples) { say(root, 'Choose a point layer with your samples', 'err'); return false; }
      if (t === 'classify' && !v.field) { say(root, 'Choose the field that holds the classes', 'err'); return false; }
      if (t === 'change' && v.year === v.year2) { say(root, 'Choose two different years', 'err'); return false; }
      const aoi = v.area === 'view' ? host.view().map((x) => Number(x.toFixed(6))) : v.area;
      const fetch = (id: string, year: string) => ({ id, use: 'embeddings.fetch', with: { aoi, buffer: v.area === 'view' ? 0 : 500, year: Number(year), name: `embeddings_${year}` } });
      const steps: { id: string; use: string; needs?: string[]; with: Record<string, unknown> }[] = [fetch('fetch', v.year)];
      if (t === 'similar') steps.push({ id: 'similar', use: 'embeddings.similar', with: { embeddings: '${fetch.raster}', samples: v.samples } });
      if (t === 'cluster') steps.push({ id: 'groups', use: 'embeddings.cluster', with: { embeddings: '${fetch.raster}', classes: Number(v.classes || 8) } });
      if (t === 'classify') steps.push({ id: 'classify', use: 'embeddings.classify', with: { embeddings: '${fetch.raster}', samples: v.samples, field: v.field } });
      if (t === 'change') {
        const [y1, y2] = [v.year, v.year2].map(Number).sort((a, c) => a - c);
        steps[0] = fetch('fetch', String(y1));
        steps.push(fetch('fetch2', String(y2)), { id: 'change', use: 'embeddings.change', with: { before: '${fetch.raster}', after: '${fetch2.raster}' } });
      }
      const title = TASKS.find((x) => x[0] === t)?.[1] ?? 'Satellite embeddings';
      steps.push({ id: 'map', use: 'export.map', needs: [steps[steps.length - 1].id], with: { name: 'satellite-embeddings', title } });
      steps.push({ id: 'report', use: 'export.report', with: { title: `${title} · \${run.date}` } });
      // JSON is valid YAML: parameters go in as JSON so ids with ':' stay intact
      const yaml = [
        `# Made by Imagery › Satellite embeddings on ${new Date().toLocaleString()}; replaced the next time.`,
        `recipe: ${EMB_RECIPE}`, 'version: 1', `title: ${JSON.stringify('Satellite embeddings')}`, 'steps:',
        ...steps.flatMap((s) => [`  - id: ${s.id}`, `    use: ${s.use}`, ...(s.needs ? [`    needs: ${JSON.stringify(s.needs)}`] : []), `    with: ${JSON.stringify(s.with)}`]),
        'outputs: [report]', '',
      ].join('\n');
      try {
        say(root, 'Starting…');
        await host.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      } catch (e) {
        say(root, e instanceof Error ? e.message : String(e), 'err');
        return false;
      }
      host.setStatus('Reading satellite embeddings for the area…', 10000);
      void host.run(EMB_RECIPE);
      return true;
    },
  });
}
