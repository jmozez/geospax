// Field sync (Edit › Field sync): package a layer for work away from any network, then bring the
// field copy back and merge it, feature by feature, with conflicts shown for a decision
// (docs/USER_GUIDE.md, "Field sync without a network"). Nothing is written until Apply.
import type { CommandHost } from './commands';
import { dialog, say } from './editing';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Pkg { package: string; layer: string; name?: string; field: string; created: string; applied: string | null }
interface Change { fid: number; action: 'add' | 'update' | 'delete' | 'conflict'; reason?: string; fields: string[]; theirs?: { properties: Record<string, unknown> }; ours?: { properties: Record<string, unknown> } }
interface Review { summary: Record<string, number>; changes: Change[] }

const post = <T>(h: CommandHost, path: string, body: unknown) =>
  h.backend.json<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function label(c: Change): string {
  const p = (c.theirs ?? c.ours)?.properties ?? {};
  const first = Object.entries(p).find(([, v]) => typeof v === 'string' && v);
  return `#${c.fid}${first ? ` ${esc(first[1])}` : ''}`;
}

export async function openFieldSync(h: CommandHost): Promise<void> {
  const layers = h.layers();
  const { packages } = await h.backend.json<{ packages: Pkg[] }>('api/sync');
  const opts = layers.map((l) => `<option value="${esc(l.id)}">${esc(l.name ?? l.id)}</option>`).join('');
  const rows = packages
    .map((p) => `<tr><td>${esc(p.name ?? p.layer)}</td><td>${esc(p.created.slice(0, 16).replace('T', ' '))}</td><td>${p.applied ? 'merged' : 'out in the field'}</td>
      <td><button type="button" data-review="${esc(p.package)}">Review</button></td></tr>`)
    .join('');
  const body = `<p class="dim">1. Package a layer: GeoSpaX keeps a base copy and writes <code>field.gpkg</code> for a USB stick, laptop or phone (GeoSpaX, QGIS or QField).
      2. Back from the field, review the returned file: one-sided changes merge on their own, conflicts wait for you.</p>
    <p><label>Layer <select name="layer">${opts}</select></label></p>
    <p data-msg class="dlg-msg"></p>
    <h4>Packages</h4>
    ${rows ? `<table class="attr"><tbody>${rows}</tbody></table>` : '<p class="dim">None yet.</p>'}
    <p><label>Returned file (leave empty if the field copy was edited in place) <input name="returned" style="width:100%" placeholder="/media/usb/field.gpkg"></label></p>
    <div data-out style="max-height:40vh;overflow:auto"></div>`;
  let current = '';
  await dialog('Field sync', body, [['package', 'Package for field'], ['apply', 'Apply'], ['', 'Close']], {
    wide: true,
    onOpen: (root) => {
      root.addEventListener('click', async (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-review]');
        if (!b) return;
        current = b.dataset.review!;
        const returned = root.querySelector<HTMLInputElement>('[name=returned]')!.value.trim() || undefined;
        say(root, 'Comparing…');
        try {
          const r = await post<Review>(h, 'api/sync/review', { package: current, returned });
          const s = r.summary;
          say(root, `${s.add} new, ${s.update} changed, ${s.delete} deleted, ${s.conflict} conflict(s). Choose for each conflict, then Apply.`, 'ok');
          root.querySelector<HTMLElement>('[data-out]')!.innerHTML = `<table class="attr"><thead><tr><th>Feature</th><th>Change</th><th>Keep</th></tr></thead><tbody>${r.changes
            .map((c) => `<tr><td>${label(c)}</td><td>${esc(c.action === 'conflict' ? c.reason : `${c.action} ${c.fields.join(', ')}`)}</td><td>${
              c.action === 'conflict'
                ? `<label><input type="radio" name="c${c.fid}" value="ours" checked> this computer</label> <label><input type="radio" name="c${c.fid}" value="theirs"> field</label>`
                : 'field'
            }</td></tr>`).join('')}</tbody></table>`;
        } catch (err) {
          say(root, String((err as Error).message ?? err), 'err');
        }
      });
    },
    onButton: async (b, v, root) => {
      if (b === 'package') {
        const r = await post<{ field: string; features: number }>(h, `api/layers/${encodeURIComponent(v.layer)}/field-package`, {});
        say(root, `Packaged ${r.features} features. Copy ${r.field} to the field device; reopen Field sync to review it when it comes back.`, 'ok');
        return false;
      }
      if (!current) {
        say(root, 'Review a package first.', 'err');
        return false;
      }
      const choices: Record<string, string> = {};
      root.querySelectorAll<HTMLInputElement>('input[type=radio]:checked').forEach((i) => (choices[i.name.slice(1)] = i.value));
      const r = await post<{ added: number; updated: number; deleted: number; conflicts_kept: number }>(h, 'api/sync/apply', { package: current, returned: v.returned || undefined, choices });
      say(root, `Merged: ${r.added} added, ${r.updated} updated, ${r.deleted} deleted; ${r.conflicts_kept} conflict(s) kept as on this computer. Edit › Revert still undoes all edits.`, 'ok');
      await h.reload();
      return false;
    },
  });
}
