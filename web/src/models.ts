// Imagery › Models… and Detect objects: your own ONNX models (engine automation/detect_steps.rs).
// GeoSpaX ships no model: you add one (exported from PyTorch, Ultralytics YOLO, TensorFlow or Keras)
// with its labels and licence, and run it over an image. Detection gives a polygon layer (class, score,
// area), segmentation a class raster; each run is a small recipe ("detect-objects") with a report whose
// methods name the model and its licence.
import type { Backend } from './backend';
import { dialog, say } from './editing';

export const DETECT_RECIPE = 'detect-objects';

interface Model { name: string; task: string; channels: number; input: [number | null, number | null]; labels: string[]; licence: string; source: string; error?: string }

export interface ModelsHost {
  backend: Backend;
  run: (recipe: string) => Promise<void>;
  setStatus: (t: string, ms?: number) => void;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const size = (m: Model) => (m.input[0] && m.input[1] ? `${m.input[1]} × ${m.input[0]} px` : 'any size');

async function list(host: ModelsHost): Promise<Model[]> {
  return (await host.backend.json<{ models: Model[] }>('api/models')).models;
}

const rows = (ms: Model[]) =>
  ms.length
    ? `<table class="props models"><tr><th>Model</th><th>Task</th><th>Input</th><th>Classes</th><th>Licence</th><th></th></tr>${ms
        .map((m) => m.error
          ? `<tr><td>${esc(m.name)}</td><td colspan="4" class="err">${esc(m.error)}</td><td><button type="button" data-del="${esc(m.name)}">Remove</button></td></tr>`
          : `<tr><td><b>${esc(m.name)}</b>${m.source ? `<br><span class="dim">${esc(m.source)}</span>` : ''}</td><td>${esc(m.task)}</td><td>${m.channels} bands, ${size(m)}</td>
            <td title="${esc(m.labels.join(', '))}">${m.labels.length || '–'}</td><td>${m.licence ? esc(m.licence) : '<span class="warn">not stated</span>'}</td>
            <td><button type="button" data-edit="${esc(m.name)}">Edit</button> <button type="button" data-del="${esc(m.name)}">Remove</button></td></tr>`)
        .join('')}</table>`
    : '<p class="pane-empty">No models yet. Add an .onnx file below.</p>';

/** Imagery › Models…: add, describe and remove models. */
export async function openModels(host: ModelsHost) {
  let ms = await list(host).catch(() => [] as Model[]);
  await dialog('Your models', `
    <p class="hint">Object detection (YOLOv5, v8, v11 and models with the same output) or segmentation models in ONNX format, run on this computer. GeoSpaX ships no model: add one whose licence lets you use it, and state the licence: it is printed in every report made with the model.</p>
    <div data-list>${rows(ms)}</div>
    <fieldset class="add-model"><legend>Add a model</legend>
      <label>ONNX file <input type="file" name="file" accept=".onnx"></label>
      <label>Classes, one per line or comma-separated (optional: read from the model when it has them) <textarea name="labels" rows="2"></textarea></label>
      <label>Licence <input name="licence" placeholder="e.g. AGPL-3.0 (Ultralytics), Apache-2.0, CC-BY-4.0, your own"></label>
      <label>Source <input name="source" placeholder="where it comes from: a URL, a paper, your training run"></label>
    </fieldset>
    <div class="dlg-msg" data-msg></div>`, [['ok', 'Add model'], ['', 'Close']], {
    wide: true,
    onOpen: (root) => {
      root.addEventListener('click', async (e) => {
        const t = e.target as HTMLElement;
        const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
        const edit = t.closest<HTMLElement>('[data-edit]')?.dataset.edit;
        if (del) {
          await host.backend.json(`api/models/${encodeURIComponent(del)}`, { method: 'DELETE' }).catch(() => null);
          ms = await list(host);
          root.querySelector('[data-list]')!.innerHTML = rows(ms);
          say(root, `Removed ${del}`);
        } else if (edit) {
          const m = ms.find((x) => x.name === edit);
          if (!m) return;
          (root.querySelector('[name=labels]') as HTMLTextAreaElement).value = m.labels.join('\n');
          (root.querySelector('[name=licence]') as HTMLInputElement).value = m.licence;
          (root.querySelector('[name=source]') as HTMLInputElement).value = m.source;
          root.dataset.editing = edit;
          say(root, `Editing ${edit}: change the classes, licence or source and press Add model to save (no file needed).`);
        }
      });
    },
    onButton: async (b, v, root) => {
      if (b !== 'ok') return true;
      const file = (root.querySelector('[name=file]') as HTMLInputElement).files?.[0];
      const editing = root.dataset.editing;
      if (!file && !editing) { say(root, 'Choose an .onnx file', 'err'); return false; }
      const labels = v.labels.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      try {
        let name = editing ?? '';
        if (file) {
          say(root, `Reading ${file.name}…`);
          const m = await host.backend.json<Model>(`api/models?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } });
          name = m.name;
        }
        const desc: Record<string, unknown> = { licence: v.licence.trim(), source: v.source.trim() };
        if (labels.length) desc.labels = labels;
        await host.backend.json(`api/models/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(desc), headers: { 'content-type': 'application/json' } });
        ms = await list(host);
        root.querySelector('[data-list]')!.innerHTML = rows(ms);
        delete root.dataset.editing;
        (root.querySelector('form') as HTMLFormElement | null)?.querySelectorAll<HTMLInputElement>('.add-model input, .add-model textarea').forEach((i) => { i.value = ''; });
        const m = ms.find((x) => x.name === name);
        say(root, `${name}: ${m?.task ?? '?'} model, ${m?.labels.length ?? 0} classes${m?.licence ? '' : ', licence not stated'}`);
      } catch (e) {
        say(root, e instanceof Error ? e.message : String(e), 'err');
      }
      return false;
    },
  });
}

/** Imagery › Detect objects: run a model over an image. */
export async function openDetect(host: ModelsHost) {
  const ms = (await list(host).catch(() => [] as Model[])).filter((m) => !m.error);
  if (!ms.length) {
    host.setStatus('Add a model first (Imagery › Models…)', 6000);
    return openModels(host);
  }
  const rasters = (await host.backend.json<{ rasters: { id: string; title: string; kind: string; bands: number; width: number; height: number; pixel_m: number }[] }>('api/rasters')).rasters
    .filter((r) => !['classes', 'embedding', 'similarity', 'dissimilarity'].includes(r.kind));
  if (!rasters.length) {
    host.setStatus('No image to look at: add a GeoTIFF (drone orthophoto, satellite image) to a data folder or drop it on the map', 8000);
    return;
  }
  await dialog('Detect objects', `
    <label>Model <select name="model">${ms.map((m) => `<option value="${esc(m.name)}">${esc(m.name)} · ${esc(m.task)} · ${m.labels.length} classes${m.licence ? '' : ' · licence not stated'}</option>`).join('')}</select></label>
    <label>Image <select name="raster">${rasters.map((r) => `<option value="${esc(r.id)}">${esc(r.title)} · ${r.bands} band${r.bands > 1 ? 's' : ''} · ${r.width} × ${r.height} px · ${r.pixel_m} m</option>`).join('')}</select></label>
    <div class="row2"><label>Lowest score kept <input name="threshold" type="number" min="0.05" max="0.95" step="0.05" value="0.25"></label>
      <label>Bands for the model <input name="bands" placeholder="1,2,3"></label></div>
    <p class="hint">The image is read in tiles of the model's size at its own resolution, so use imagery close to the resolution the model was trained on (e.g. 10–50 cm for buildings and trees). Runs on this computer; large images take a while.</p>
    <div class="dlg-msg" data-msg></div>`, [['ok', 'Run'], ['', 'Cancel']], {
    wide: true,
    onButton: async (b, v, root) => {
      if (b !== 'ok') return true;
      const w: Record<string, unknown> = { model: v.model, raster: v.raster, threshold: Number(v.threshold || 0.25) };
      const bands = v.bands.split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
      if (bands.length) w.bands = bands;
      const yaml = [
        `# Made by Imagery › Detect objects on ${new Date().toLocaleString()}; replaced the next time.`,
        `recipe: ${DETECT_RECIPE}`, 'version: 1', `title: ${JSON.stringify(`Detect objects (${v.model})`)}`, 'steps:',
        '  - id: detect', '    use: ai.detect', `    with: ${JSON.stringify(w)}`,
        '  - id: map', '    use: export.map', '    needs: ["detect"]', `    with: ${JSON.stringify({ name: 'detections', title: `${v.model} on ${rasters.find((r) => r.id === v.raster)?.title ?? v.raster}` })}`,
        '  - id: report', '    use: export.report', '    needs: ["map"]', `    with: ${JSON.stringify({ title: `Detect objects · \${run.date}` })}`,
        'outputs: [report]', '',
      ].join('\n');
      try {
        await host.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      } catch (e) {
        say(root, e instanceof Error ? e.message : String(e), 'err');
        return false;
      }
      host.setStatus(`Running ${v.model}…`, 10000);
      void host.run(DETECT_RECIPE);
      return true;
    },
  });
}
