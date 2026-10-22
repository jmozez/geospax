// Data › Check species names (WoRMS): the engine's taxa.worms step on a layer's names field
// (crates/engine/src/automation/taxa_steps.rs). The layer and field start pre-selected (the
// selected layer when it has a names field, else the first that has one); the result is a copy of
// the layer with WoRMS fields added, and a run report listing every name and its verdict.
import type { Backend } from './backend';
import { dialog, say } from './editing';

export const WORMS_RECIPE = 'check-names';

interface Layer { id: string; name: string; fields?: { name: string; kind: string }[] }

export interface TaxaHost {
  backend: Backend;
  layers: () => Layer[];
  active: () => string | null;
  run: (recipe: string) => Promise<void>;
  setStatus: (t: string, ms?: number) => void;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// the field WoRMS would be asked about, by its name (as the engine picks it)
const NAME_FIELDS = ['species', 'scientificname', 'scientific_name', 'taxon', 'taxon_name', 'name'];
export const namesField = (l: Layer) => (l.fields ?? []).find((f) => f.kind === 'string' && NAME_FIELDS.includes(f.name.toLowerCase()))?.name;

export async function openWorms(host: TaxaHost) {
  const layers = host.layers().filter((l) => (l.fields ?? []).some((f) => f.kind === 'string'));
  if (!layers.length) {
    host.setStatus('No layer with text fields: add species records first (Data › Online data › Species)', 8000);
    return;
  }
  const active = layers.find((l) => l.id === host.active() && namesField(l));
  const start = active ?? layers.find((l) => namesField(l)) ?? layers[0];
  const fieldOpts = (l: Layer) => (l.fields ?? []).filter((f) => f.kind === 'string').map((f) => `<option${f.name === namesField(l) ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
  await dialog('Check species names (WoRMS)', `
    <p class="hint">Each distinct name is matched against the World Register of Marine Species. You get a copy of the layer with the AphiaID, the accepted name for synonyms, the classification, the habitat and a verdict to review (ok, synonym, check spelling, ambiguous, not in WoRMS). Your names are not changed. WoRMS covers marine taxa best; many freshwater and land species are not in it.</p>
    <label>Layer <select name="layer">${layers.map((l) => `<option value="${esc(l.id)}"${l === start ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
    <label>Field with scientific names <select name="field">${fieldOpts(start)}</select></label>
    <label>Only within (optional) <input name="within" placeholder="e.g. Cnidaria, or Animalia: settles names shared by two groups"></label>
    <div class="dlg-msg" data-msg></div>`, [['ok', 'Check names'], ['', 'Cancel']], {
    onOpen: (root) => {
      root.querySelector('[name=layer]')!.addEventListener('change', (e) => {
        const l = layers.find((x) => x.id === (e.target as HTMLSelectElement).value);
        if (l) root.querySelector('[name=field]')!.innerHTML = fieldOpts(l);
      });
    },
    onButton: async (b, v, root) => {
      if (b !== 'ok') return true;
      const w: Record<string, unknown> = { layer: v.layer, field: v.field };
      if (v.within.trim()) w.within = v.within.trim();
      const title = layers.find((l) => l.id === v.layer)?.name ?? v.layer;
      const yaml = [
        `# Made by Data › Check species names on ${new Date().toLocaleString()}; replaced the next time.`,
        `recipe: ${WORMS_RECIPE}`, 'version: 1', `title: ${JSON.stringify(`Species names of ${title} (WoRMS)`)}`, 'steps:',
        '  - id: names', '    use: taxa.worms', `    with: ${JSON.stringify(w)}`,
        '  - id: report', '    use: export.report', '    needs: ["names"]', `    with: ${JSON.stringify({ title: `Species names checked with WoRMS · \${run.date}` })}`,
        'outputs: [report]', '',
      ].join('\n');
      try {
        await host.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      } catch (e) {
        say(root, e instanceof Error ? e.message : String(e), 'err');
        return false;
      }
      host.setStatus(`Checking the names of ${title} with WoRMS…`, 10000);
      void host.run(WORMS_RECIPE);
      return true;
    },
  });
}
