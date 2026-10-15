// Automate section (docs/AUTOMATION.md): the recipe gallery with one-click Run, an Auto switch per
// recipe (device / folder / schedule / after triggers), live run progress, the finished map and
// report, and "Save this map as a recipe".
import type { Backend } from './backend';

export interface RecipeInfo {
  id: string;
  title: string;
  description: string;
  origin: 'gallery' | 'user' | 'file' | 'api';
  triggers: { kind: string; text: string }[];
  inputs: { name: string; type: string; default: unknown; description: string }[];
  steps: { id: string; use: string }[];
  code_steps: boolean;
  auto: boolean;
  running: string | null;
  last_run: { id: string; status: string; started_at: string; elapsed_ms: number; artifacts: string[]; error: string | null } | null;
}

export interface StepInfo {
  id: string;
  use: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  ms: number;
  why: string[];
  error: string | null;
}

export interface RunInfo {
  id: string;
  recipe: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  progress: number;
  elapsed_ms: number;
  current: string | null;
  steps: StepInfo[];
  artifacts: string[];
  layers: string[];
  rasters?: string[];
  styles: Record<string, unknown>;
  extent: [number, number, number, number] | null;
  error: string | null;
  trigger: { kind: string; text: string };
}

interface RecipesState {
  recipes: RecipeInfo[];
  errors: string[];
  python: string | null;
  r: string | null;
}

/** What "Save this map as a recipe" needs from the map. */
export interface MapSnapshot {
  layers: { id: string; style: unknown }[];
  title: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Files written by the scene.3d step (scene.png / .html / .glb, or another name: given). */
const isScene = (f: string) => /(^|\/)scene[^/]*\.(html|glb|png)$/.test(f) || f.endsWith('.glb');
const ICON: Record<string, string> = { device: '🔌', folder: '📁', schedule: '⏱', after: '↪' };
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const finished = (s: string) => s === 'done' || s === 'failed' || s === 'cancelled' || s === 'interrupted';

export class AutomatePane {
  private state: RecipesState = { recipes: [], errors: [], python: null, r: null };
  private tracking = new Map<string, RunInfo>(); // recipe id -> latest run
  private announced = new Set<string>(); // run ids already handed to onRunFinished
  private expanded = new Set<string>(); // cards whose full description is open
  private lastHtml = '';
  private modal: HTMLDivElement;

  constructor(
    private el: HTMLElement,
    private backend: Backend,
    private hooks: {
      onRunFinished: (run: RunInfo) => Promise<void>;
      snapshot: () => MapSnapshot;
    },
  ) {
    this.modal = document.createElement('div');
    this.modal.id = 'artifact-modal';
    this.modal.hidden = true;
    document.body.appendChild(this.modal);
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal || (e.target as HTMLElement).dataset.close !== undefined) this.closeModal();
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.closeModal());
    el.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const run = t.closest<HTMLElement>('[data-run]')?.dataset.run;
      const art = t.closest<HTMLElement>('[data-art]');
      const cancel = t.closest<HTMLElement>('[data-cancel]')?.dataset.cancel;
      if (run) void this.run(run);
      else if (art) void this.openArtifact(art.dataset.runid!, art.dataset.art!);
      else if (cancel) void this.backend.json(`api/runs/${cancel}/cancel`, { method: 'POST' });
      else if (t.id === 'save-recipe') void this.saveAsRecipe();
      else if (t.closest('[data-more]')) {
        const card = t.closest<HTMLElement>('.recipe');
        const id = card?.dataset.recipe;
        if (card && id) {
          card.classList.toggle('open');
          if (card.classList.contains('open')) this.expanded.add(id);
          else this.expanded.delete(id);
        }
      }
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.dataset.auto) void this.setAuto(t.dataset.auto, t.checked);
    });
  }

  start() {
    const tick = async () => {
      await this.refresh().catch(() => {});
      setTimeout(tick, 4000);
    };
    void tick();
  }

  private async refresh() {
    this.state = await this.backend.json<RecipesState>('api/recipes');
    // runs started by a trigger (device plugged in, new files, schedule) show up here
    for (const r of this.state.recipes) {
      if (r.running && this.tracking.get(r.id)?.id !== r.running) void this.follow(r.running);
    }
    this.render();
  }

  async run(id: string) {
    try {
      const run = await this.backend.json<RunInfo>(`api/recipes/${id}/run`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      document.body.dataset.recipeRun = 'running';
      await this.follow(run.id, run);
    } catch (e) {
      this.flash(id, String((e as Error).message ?? e));
    }
  }

  /** Poll a run until it finishes, re-rendering its progress. */
  private async follow(runId: string, first?: RunInfo) {
    let run = first ?? (await this.backend.json<RunInfo>(`api/runs/${runId}`));
    this.tracking.set(run.recipe, run);
    this.render();
    while (!finished(run.status)) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        run = await this.backend.json<RunInfo>(`api/runs/${runId}`);
      } catch {
        continue;
      }
      this.tracking.set(run.recipe, run);
      this.render();
    }
    if (!this.announced.has(run.id)) {
      this.announced.add(run.id);
      document.body.dataset.recipeRun = run.status;
      document.body.dataset.recipeRunId = run.id;
      await this.hooks.onRunFinished(run);
    }
    await this.refresh().catch(() => {});
  }

  private async setAuto(id: string, on: boolean) {
    await this.backend.json(`api/recipes/${id}/auto`, { method: 'PUT', body: JSON.stringify({ enabled: on }), headers: { 'content-type': 'application/json' } });
    await this.refresh();
  }

  private flash(id: string, msg: string) {
    const card = this.el.querySelector(`[data-recipe="${CSS.escape(id)}"] .msg`);
    if (card) card.textContent = msg;
  }

  private stepList(run: RunInfo) {
    const mark: Record<string, string> = { done: '✓', failed: '✗', running: '…', skipped: '–', pending: '·' };
    return `<ol class="steps">${run.steps
      .map((s) => `<li class="${s.status}" title="${esc((s.error ?? s.why.join('\n')) || s.use)}"><span>${mark[s.status] ?? '·'}</span> ${esc(s.title)}${s.ms ? ` <small>${secs(s.ms)}</small>` : ''}</li>`)
      .join('')}</ol>`;
  }

  private artifactLinks(runId: string, files: string[]) {
    const label = (f: string) => {
      if (isScene(f)) return f.endsWith('.html') ? '🧊 3D' : f.endsWith('.glb') ? 'GLB' : '';
      return f.endsWith('.png') ? '🖼 Map' : f.endsWith('.html') ? '📄 Report' : f.endsWith('.svg') ? 'SVG' : f.split('.').pop()!.toUpperCase();
    };
    // one link per kind keeps the card short: map image, report, then data files
    const seen = new Set<string>();
    return files
      .filter((f) => {
        const k = label(f);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((f) => `<button class="link" data-runid="${esc(runId)}" data-art="${esc(f)}">${esc(label(f))}</button>`)
      .join('');
  }

  private render() {
    const { recipes } = this.state;
    if (!recipes.length) {
      this.el.innerHTML = '<p class="muted">No recipes found.</p>';
      return;
    }
    const cards = recipes.map((r) => {
      const run = this.tracking.get(r.id);
      const active = run && !finished(run.status);
      const last = run && finished(run.status) ? run : null;
      const lr = r.last_run;
      let status = '';
      if (active) {
        const n = run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
        status = `<div class="status run">Running ${n + 1}/${run.steps.length}: ${esc(run.current ?? '')} <button class="link" data-cancel="${esc(run.id)}">cancel</button></div>${this.stepList(run)}`;
      } else if (last) {
        status = `<div class="status ${last.status}">${last.status === 'done' ? '✓ Done' : `✗ ${esc(last.status)}`} in ${secs(last.elapsed_ms)} · ${esc(last.trigger?.text ?? '')}</div>
          ${last.error ? `<div class="err">${esc(last.error)}</div>` : ''}
          <div class="arts">${this.artifactLinks(last.id, last.artifacts)}</div>${this.stepList(last)}`;
      } else if (lr) {
        status = `<div class="status ${lr.status}">${lr.status === 'done' ? '✓' : '✗'} last run ${esc(ago(lr.started_at))}${lr.elapsed_ms ? ` · ${secs(lr.elapsed_ms)}` : ''}</div>
          ${lr.error ? `<div class="err">${esc(lr.error)}</div>` : ''}<div class="arts">${this.artifactLinks(lr.id, lr.artifacts ?? [])}</div>`;
      }
      const triggers = r.triggers.length
        ? `<div class="triggers">${r.triggers.map((t) => `<span title="${esc(t.kind)}">${ICON[t.kind] ?? '⚡'} ${esc(t.text)}</span>`).join('')}</div>`
        : '<div class="triggers"><span>▶ run by hand or from the command line</span></div>';
      const needs = r.code_steps ? (r.steps.some((s) => s.use === 'r') ? this.state.r : this.state.python) : 'ok';
      const auto = r.triggers.length
        ? `<label class="switch" title="Run automatically ${esc(r.triggers.map((t) => t.text).join('; '))}"><input type="checkbox" data-auto="${esc(r.id)}" ${r.auto ? 'checked' : ''}/> Auto</label>`
        : '';
      return `<div class="recipe ${r.auto ? 'auto' : ''} ${this.expanded.has(r.id) ? 'open' : ''}" data-recipe="${esc(r.id)}">
        <div class="r-head"><b>${esc(r.title)}</b>${r.origin === 'user' ? '<span class="tag">mine</span>' : ''}</div>
        <div class="r-desc" data-more>${esc(r.description)}</div>
        ${triggers}
        <div class="r-actions"><button class="primary" data-run="${esc(r.id)}" ${active || !needs ? 'disabled' : ''}>${active ? 'Running…' : 'Run'}</button>${auto}
          ${!needs ? `<span class="muted">needs ${r.steps.some((s) => s.use === 'r') ? 'R' : 'Python'}</span>` : ''}<span class="msg"></span></div>
        ${status}</div>`;
    });
    const errs = this.state.errors.length ? `<p class="err">${this.state.errors.map(esc).join('<br>')}</p>` : '';
    const html = cards.join('') + errs +
      `<div class="row save"><button id="save-recipe" title="Turns the visible layers and their styles into a re-runnable recipe">Save this map as a recipe</button></div>`;
    // only touch the DOM when something changed (polling every few seconds must not reset the UI)
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.el.innerHTML = html;
  }

  private closeModal() {
    this.modal.hidden = true;
    const url = this.modal.dataset.url;
    if (url) URL.revokeObjectURL(url);
    this.modal.innerHTML = '';
  }

  async openArtifact(runId: string, name: string) {
    const { bytes, headers } = await this.backend.binary(`api/runs/${runId}/files/${name}`);
    const type = headers.get('content-type') ?? 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    this.modal.dataset.url = url;
    let body: string;
    if (type.startsWith('image/')) body = `<img src="${url}" alt="${esc(name)}"/>`;
    // 3D scenes run their own WebGL viewer: scripts on, but no access to the app (opaque origin)
    else if (type.startsWith('text/html') && isScene(name)) body = `<iframe class="scene3d" sandbox="allow-scripts" title="3D scene" srcdoc="${esc(new TextDecoder().decode(bytes))}"></iframe>`;
    else if (type.startsWith('text/html')) body = `<iframe sandbox="allow-same-origin" srcdoc="${esc(new TextDecoder().decode(bytes))}"></iframe>`;
    else body = `<p>${esc(name)} (${Math.round(bytes.byteLength / 1024)} KB)</p>`;
    this.modal.innerHTML = `<div class="sheet"><header><b>${esc(name)}</b><span><a href="${url}" download="${esc(name)}">Download</a> <button data-close>Close</button></span></header>${body}</div>`;
    this.modal.hidden = false;
    document.body.dataset.artifact = name;
  }

  /** Visible layers + their exact styles -> a recipe that redraws and re-exports this map. */
  async saveAsRecipe() {
    const snap = this.hooks.snapshot();
    if (!snap.layers.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const id = `my-map-${stamp}`;
    const ids = snap.layers.map((l) => l.id);
    const styles = Object.fromEntries(snap.layers.map((l) => [l.id, l.style]));
    // JSON is valid YAML, so styles are embedded as flow mappings
    const yaml = [
      `# Saved from the GeoSpaX map on ${new Date().toLocaleString()}.`,
      `# Re-run it any time (or add triggers:) to redraw and re-export this exact map.`,
      `recipe: ${id}`,
      'version: 1',
      `title: ${JSON.stringify(snap.title)}`,
      'description: The visible layers and their styles, saved from the map.',
      'steps:',
      '  - id: open',
      '    use: io.open',
      `    with: { layers: ${JSON.stringify(ids)} }`,
      '  - id: style',
      '    use: style.apply',
      `    with: { styles: ${JSON.stringify(styles)} }`,
      '  - id: map',
      '    use: export.map',
      '    needs: [open, style]',
      `    with: { layers: ${JSON.stringify(ids)}, title: ${JSON.stringify(snap.title)} }`,
      '  - id: report',
      '    use: export.report',
      '    needs: [map]',
      'outputs: [map, report]',
      '',
    ].join('\n');
    try {
      await this.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      document.body.dataset.savedRecipe = id;
      await this.refresh();
      this.el.querySelector(`[data-recipe="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      alert(`Could not save the recipe: ${(e as Error).message}`);
    }
  }
}
