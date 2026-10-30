// Review (Share › Review): comments pinned to the map and the version history of a named project,
// for teams sharing one self-hosted web edition (docs/USER_GUIDE.md, "Reviewing a shared project").
import type { CommandHost } from './commands';
import { dialog, say } from './editing';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Comment { id: number; text: string; author: string; lon: number | null; lat: number | null; layer: string | null; reply_to: number | null; at: string; resolved: boolean }
interface Version { version: string; bytes: number; name: string | null }

const post = <T>(h: CommandHost, path: string, body: unknown = {}) =>
  h.backend.json<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const when = (v: string) => `${v.slice(6, 8)}/${v.slice(4, 6)}/${v.slice(0, 4)} ${v.slice(9, 11)}:${v.slice(11, 13)}`;

export async function openReview(h: CommandHost): Promise<void> {
  const slug = document.body.dataset.project ?? '';
  if (!slug) {
    await dialog('Review', '<p>Save the project with a name first (Home › Save as): comments and versions belong to a named project.</p>', [['', 'Close']]);
    return;
  }
  const base = `api/projects/${encodeURIComponent(slug)}`;
  const render = async (root: HTMLElement) => {
    const [{ comments }, { versions }] = await Promise.all([
      h.backend.json<{ comments: Comment[] }>(`${base}/comments`),
      h.backend.json<{ versions: Version[] }>(`${base}/history`),
    ]);
    const top = comments.filter((c) => c.reply_to == null);
    root.querySelector<HTMLElement>('[data-comments]')!.innerHTML = top.length
      ? top
          .map((c) => {
            const replies = comments.filter((r) => r.reply_to === c.id).map((r) => `<div class="dim">↳ ${esc(r.author)}: ${esc(r.text)}</div>`).join('');
            return `<div class="${c.resolved ? 'dim' : ''}" style="margin:.4em 0"><b>${esc(c.author)}</b> ${esc(c.at.slice(0, 16).replace('T', ' '))}${c.layer ? ` on ${esc(c.layer)}` : ''}${c.resolved ? ' (resolved)' : ''}
              <div>${esc(c.text)}</div>${replies}
              <button type="button" data-go="${c.id}">Show</button> <button type="button" data-reply="${c.id}">Reply</button>
              <button type="button" data-${c.resolved ? 'reopen' : 'resolve'}="${c.id}">${c.resolved ? 'Reopen' : 'Resolve'}</button></div>`;
          })
          .join('')
      : '<p class="dim">No comments yet.</p>';
    root.querySelector<HTMLElement>('[data-versions]')!.innerHTML = versions.length
      ? `<table class="attr"><tbody>${versions.map((v) => `<tr><td>${when(v.version)}</td><td>${esc(v.name ?? '')}</td><td><button type="button" data-restore="${esc(v.version)}">Restore</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="dim">No earlier versions yet: one is kept each time the project is saved.</p>';
    return comments;
  };
  let comments: Comment[] = [];
  const body = `<p class="dim">Comments are pinned to the centre of the map when you add them. Each save keeps the version it replaced (the last 50).</p>
    <p><label>Your name <input name="author" value="${esc(localStorage.getItem('gx-review-author') ?? '')}" maxlength="80"></label></p>
    <p><label>Comment <textarea name="text" rows="3" style="width:100%"></textarea></label></p>
    <p data-msg class="dlg-msg"></p>
    <h4>Comments</h4><div data-comments style="max-height:30vh;overflow:auto"></div>
    <h4>Versions</h4><div data-versions style="max-height:20vh;overflow:auto"></div>`;
  let replyTo: number | null = null;
  await dialog(`Review: ${slug}`, body, [['add', 'Add comment'], ['', 'Close']], {
    wide: true,
    onOpen: (root) => {
      void render(root).then((c) => (comments = c)).catch((e) => say(root, String((e as Error).message ?? e), 'err'));
      root.addEventListener('click', async (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-go],button[data-reply],button[data-resolve],button[data-reopen],button[data-restore]');
        if (!b) return;
        try {
          if (b.dataset.go) {
            const c = comments.find((x) => x.id === Number(b.dataset.go));
            if (c?.lon != null && c.lat != null) h.map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(h.map.getZoom(), 14) });
          } else if (b.dataset.reply) {
            replyTo = Number(b.dataset.reply);
            say(root, `Replying to comment ${replyTo}: type it above and press Add comment.`);
          } else if (b.dataset.resolve || b.dataset.reopen) {
            await post(h, `${base}/comments/${b.dataset.resolve ?? b.dataset.reopen}/${b.dataset.resolve ? 'resolve' : 'reopen'}`);
            comments = await render(root);
          } else if (b.dataset.restore) {
            await post(h, `${base}/history/${b.dataset.restore}/restore`);
            say(root, 'Restored. Open the project again (Home › Open) to load it; the version it replaced was kept.', 'ok');
            comments = await render(root);
          }
        } catch (err) {
          say(root, String((err as Error).message ?? err), 'err');
        }
      });
    },
    onButton: async (_b, v, root) => {
      if (!v.text?.trim()) {
        say(root, 'Type a comment first.', 'err');
        return false;
      }
      localStorage.setItem('gx-review-author', v.author ?? '');
      const c = h.map.getCenter();
      try {
        await post(h, `${base}/comments`, { text: v.text, author: v.author || undefined, lon: c.lng, lat: c.lat, reply_to: replyTo ?? undefined });
        replyTo = null;
        root.querySelector<HTMLTextAreaElement>('[name=text]')!.value = '';
        say(root, 'Comment added.', 'ok');
        comments = await render(root);
      } catch (err) {
        say(root, String((err as Error).message ?? err), 'err');
      }
      return false;
    },
  });
}
