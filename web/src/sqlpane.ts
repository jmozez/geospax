// The SQL window (Analyze › SQL): one read-only query across every layer on the map, in GDAL's SQLite
// dialect with SpatiaLite functions (docs/USER_GUIDE.md, "SQL across layers"). Layers are named by
// their id in double quotes. A result with geometry joins Contents as a new layer; a table shows here.
import type { CommandHost } from './commands';
import { dialog, say } from './editing';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface SqlResult { kind: 'rows' | 'layer'; columns?: string[]; rows?: Record<string, unknown>[]; count?: number; truncated?: boolean; layer?: string; features?: number; ms: number }

let last = '';

export async function openSql(h: CommandHost): Promise<void> {
  const layers = h.layers();
  const first = layers[0]?.id ?? 'my_layer';
  const sample = last || `SELECT *\nFROM "${first}"\nLIMIT 100`;
  const list = layers.map((l) => `<button type="button" class="link" data-ins="${esc(l.id)}">"${esc(l.id)}"</button>`).join(' ');
  const body = `<p class="dim">Read only. SQLite and SpatiaLite functions (ST_Intersects, ST_Buffer, ST_Area, ...). Name layers by id in double quotes. A result with geometry becomes a new layer.</p>
    <p>${list || '<span class="dim">No layers on the map yet.</span>'}</p>
    <textarea name="sql" rows="8" spellcheck="false" style="width:100%;font-family:monospace" autofocus>${esc(sample)}</textarea>
    <label>Result layer name <input name="name" value="query"></label>
    <p data-msg class="dlg-msg"></p>
    <div data-out style="max-height:40vh;overflow:auto"></div>`;
  await dialog('SQL across layers', body, [['run', 'Run'], ['', 'Close']], {
    wide: true,
    onOpen: (root) => {
      root.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ins]');
        if (!b) return;
        const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
        const s = ta.selectionStart;
        ta.setRangeText(`"${b.dataset.ins}"`, s, ta.selectionEnd, 'end');
        ta.focus();
      });
    },
    onButton: async (_b, v, root) => {
      last = v.sql;
      say(root, 'Running…');
      const r = await h.backend.json<SqlResult>('api/sql', { method: 'POST', body: JSON.stringify({ sql: v.sql, name: v.name }), headers: { 'content-type': 'application/json' } });
      const out = root.querySelector<HTMLElement>('[data-out]')!;
      if (r.kind === 'layer') {
        out.innerHTML = '';
        say(root, `${r.features ?? 0} features in layer ${r.layer} (${r.ms} ms). It is in Contents.`, 'ok');
        await h.reload();
        return false;
      }
      const cols = r.columns ?? [];
      out.innerHTML = `<table class="attr"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${(r.rows ?? [])
        .map((row) => `<tr>${cols.map((c) => `<td>${esc(row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      say(root, `${r.count} row(s)${r.truncated ? `, first ${r.rows?.length} shown` : ''} (${r.ms} ms)`, 'ok');
      return false;
    },
  });
}
