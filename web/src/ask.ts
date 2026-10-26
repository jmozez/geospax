// The Ask pane (right dock): questions about the map data in plain words, answered by a language model
// that looks at the data through GeoSpaX's tools (engine ai.rs, docs/AI.md). The model runs where the
// user chooses: Ollama on this computer (nothing leaves it), any OpenAI-compatible server, or Claude
// with the user's own API key. Each answer lists the tools it used, and selections or zooms the model
// asked for are carried out on the map.
import type { Backend } from './backend';
import { icon } from './commands';
import { dialog, say } from './editing';

export interface AskHost {
  backend: Backend;
  select: (layer: string, fids: number[]) => void;
  zoom: (layer: string) => void;
  showRun: (run: string) => void;
  layerName: (id: string) => string;
  setStatus: (t: string, ms?: number) => void;
  /** The layer selected on the map, shown as the conversation's context */
  activeId?: () => string | null;
}

const TURNS_KEY = 'geospax.ask.turns';

interface Settings { provider: 'ollama' | 'openai' | 'anthropic'; url: string; model: string; has_key: boolean; tools: string[] }
interface Step { tool: string; args: Record<string, unknown>; ok: boolean; error?: string }
interface Turn { role: 'user' | 'assistant'; text: string; steps?: Step[]; error?: boolean }

const PROVIDERS: Record<Settings['provider'], { title: string; where: string; url: string }> = {
  ollama: { title: 'Ollama (on this computer)', where: 'Nothing leaves this computer.', url: 'http://127.0.0.1:11434' },
  openai: { title: 'OpenAI-compatible server', where: 'LM Studio, llama.cpp, vLLM… on this computer stay on it; a cloud server gets your question and the data the tools return.', url: 'http://127.0.0.1:1234' },
  anthropic: { title: 'Claude (your API key)', where: 'Your question and the data the tools return (layer names, field values) are sent to Anthropic.', url: 'https://api.anthropic.com' },
};

const SUGGESTIONS = ['What layers do I have, and what is in them?', 'Summarise the fields of the active layer', 'Which features have the highest values? Select them'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Minimal Markdown for answers: paragraphs, lists, **bold**, `code`. */
function md(s: string): string {
  const inline = (t: string) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; };
  for (const para of s.split(/\n{2,}/)) {
    for (const line of para.split('\n')) {
      const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (m) list.push(m[1]);
      else { flush(); if (line.trim()) out.push(`<p>${inline(line)}</p>`); }
    }
    flush();
  }
  return out.join('');
}

export class AskPane {
  private turns: Turn[] = [];
  private busy = false;
  private settings: Settings | null = null;

  /** the conversation survives a reload (kept in this browser, the last 40 messages) */
  private keep() {
    try { localStorage.setItem(TURNS_KEY, JSON.stringify(this.turns.slice(-40))); } catch { /* session only */ }
  }

  constructor(private host: AskHost, private el: HTMLElement) {
    try { const t = JSON.parse(localStorage.getItem(TURNS_KEY) ?? '[]'); if (Array.isArray(t)) this.turns = t; } catch { /* none */ }
    document.addEventListener('geospax:active', () => { if (!this.busy) this.render(); });
    el.addEventListener('click', (e) => void this.click(e));
    el.addEventListener('submit', (e) => { e.preventDefault(); void this.send(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).id === 'ask-q') { e.preventDefault(); void this.send(); }
    });
    void this.loadSettings();
  }

  private async loadSettings() {
    try {
      this.settings = await this.host.backend.json<Settings>('api/ai/settings');
    } catch { this.settings = null; }
    this.render();
  }

  render() {
    const s = this.settings;
    const who = s ? `${PROVIDERS[s.provider]?.title ?? s.provider} · ${s.model || 'no model'}` : 'assistant unavailable';
    const turns = this.turns.map((t) => {
      if (t.role === 'user') return `<div class="ask-msg user">${esc(t.text)}</div>`;
      const steps = t.steps?.length
        ? `<details class="ask-steps"><summary>${icon('check', 11)} Looked at the data ${t.steps.length} time${t.steps.length > 1 ? 's' : ''}</summary><ol>${t.steps.map((x) => `<li class="${x.ok ? '' : 'bad'}"><code>${esc(x.tool)}</code> ${esc(stepText(x))}${x.error ? ` <span class="err">${esc(x.error)}</span>` : ''}</li>`).join('')}</ol></details>`
        : '';
      return `<div class="ask-msg bot${t.error ? ' error' : ''}">${t.error ? `<p>${esc(t.text)}</p>` : md(t.text)}${steps}</div>`;
    }).join('');
    this.el.innerHTML = `
      <div class="ask-head"><span class="ask-who" title="Where the answers come from">${esc(who)}</span>
        <button type="button" data-act="settings" title="Choose the model">${icon('settings', 14)} Model…</button>
        ${this.turns.length ? `<button type="button" data-act="clear" title="Start a new conversation">${icon('plus', 14)} New chat</button>` : ''}</div>
      <div class="ask-log" aria-live="polite">${turns || `<div class="ask-intro">
        <p>Ask about your data in plain words. The assistant reads your layers through GeoSpaX's own tools, never invents numbers, and can select features on the map.</p>
        <p class="hint">${esc(s ? PROVIDERS[s.provider]?.where ?? '' : '')}</p>
        <div class="ask-sugg">${SUGGESTIONS.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`}
        ${this.busy ? `<div class="ask-msg bot busy"><span class="spinner"></span> Thinking and looking at the data…</div>` : ''}</div>
      ${(() => { const a = this.host.activeId?.(); return a ? `<div class="ask-ctx" title="Questions about “the layer” or “it” mean this one">${icon('layers', 12)} About <b>${esc(this.host.layerName(a))}</b></div>` : ''; })()}
      <form class="ask-form"><textarea id="ask-q" rows="2" placeholder="Ask about your data…" aria-label="Question"${this.busy ? ' disabled' : ''}></textarea>
        <button type="submit" class="primary"${this.busy ? ' disabled' : ''}>Ask</button></form>`;
    const log = this.el.querySelector('.ask-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  /** Ask from elsewhere (ribbon, context menu). */
  async ask(q: string) {
    const ta = this.el.querySelector<HTMLTextAreaElement>('#ask-q');
    if (ta) ta.value = q;
    await this.send();
  }

  private async send() {
    const ta = this.el.querySelector<HTMLTextAreaElement>('#ask-q');
    const q = ta?.value.trim() ?? '';
    if (!q || this.busy) return;
    const history = this.turns.filter((t) => !t.error).map((t) => ({ role: t.role, text: t.text }));
    this.turns.push({ role: 'user', text: q });
    this.busy = true;
    this.render();
    try {
      const r = await this.host.backend.json<{ answer: string; steps: Step[]; actions: { kind: string; layer?: string; fids?: number[]; run?: string }[] }>(
        'api/ask', { method: 'POST', body: JSON.stringify({ question: q, history }), headers: { 'content-type': 'application/json' } });
      this.turns.push({ role: 'assistant', text: r.answer || '(no answer)', steps: r.steps });
      for (const a of r.actions ?? []) {
        if (a.kind === 'select' && a.layer && a.fids) this.host.select(a.layer, a.fids);
        else if (a.kind === 'zoom' && a.layer) this.host.zoom(a.layer);
        else if (a.kind === 'run' && a.run) this.host.showRun(a.run);
      }
    } catch (e) {
      this.turns.push({ role: 'assistant', text: e instanceof Error ? e.message : String(e), error: true });
    }
    this.busy = false;
    this.keep();
    this.render();
    this.el.querySelector<HTMLTextAreaElement>('#ask-q')?.focus();
  }

  private async click(e: Event) {
    const t = e.target as HTMLElement;
    const q = t.closest<HTMLElement>('[data-q]')?.dataset.q;
    if (q) return this.ask(q);
    switch (t.closest<HTMLElement>('[data-act]')?.dataset.act) {
      case 'clear': this.turns = []; this.keep(); return this.render();
      case 'settings': return this.openSettings();
    }
  }

  async openSettings() {
    const s = this.settings ?? { provider: 'ollama', url: '', model: '', has_key: false, tools: [] } as Settings;
    const radios = (Object.keys(PROVIDERS) as Settings['provider'][])
      .map((p) => `<label class="ask-prov"><input type="radio" name="provider" value="${p}"${p === s.provider ? ' checked' : ''}><span><b>${esc(PROVIDERS[p].title)}</b><br><span class="dim">${esc(PROVIDERS[p].where)}</span></span></label>`)
      .join('');
    await dialog('Assistant model', `${radios}
      <label>Address <input name="url" value="${esc(s.url)}" placeholder="${esc(PROVIDERS[s.provider].url)}"></label>
      <label>Model <input name="model" list="ask-models" value="${esc(s.model)}" placeholder="e.g. llama3.2, qwen2.5, claude-opus-5-5"><datalist id="ask-models"></datalist></label>
      <label data-key>API key <input name="key" type="password" autocomplete="off" placeholder="${s.has_key ? 'saved; type to replace, or clear below' : 'only for Claude or a cloud server'}"></label>
      ${s.has_key ? '<label class="chk"><input type="checkbox" name="forget"> Forget the saved key</label>' : ''}
      <p class="hint">The key is kept in the GeoSpaX state folder on this computer (readable only by you) and is never shown again. For Ollama, install it from ollama.com and run <code>ollama pull llama3.2</code> (or another model that supports tools).</p>
      <div class="dlg-msg" data-msg></div>`, [['ok', 'Save'], ['test', 'Save and list models'], ['', 'Cancel']], {
      onOpen: (root) => {
        const sync = () => {
          const p = root.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value as Settings['provider'];
          const url = root.querySelector<HTMLInputElement>('input[name="url"]')!;
          url.placeholder = PROVIDERS[p].url;
          root.querySelector<HTMLElement>('[data-key]')!.hidden = p === 'ollama';
        };
        root.addEventListener('change', sync);
        sync();
      },
      onButton: async (b, v, root) => {
        if (!b) return true;
        const body: Record<string, string> = { provider: v.provider, url: v.url.trim(), model: v.model.trim() };
        if (v.forget === 'on') body.key = '';
        else if (v.key) body.key = v.key;
        try {
          this.settings = await this.host.backend.json<Settings>('api/ai/settings', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
        } catch (e) {
          say(root, e instanceof Error ? e.message : String(e), 'err');
          return false;
        }
        if (b === 'test') {
          say(root, 'Asking the server for its models…');
          const m = await this.host.backend.json<{ models: string[]; error?: string }>('api/ai/models');
          if (m.error) { say(root, m.error, 'err'); return false; }
          root.querySelector('#ask-models')!.innerHTML = m.models.map((x) => `<option value="${esc(x)}">`).join('');
          say(root, m.models.length ? `Models: ${m.models.join(', ')}. Pick one in Model, then Save.` : 'The server has no models yet.');
          return false;
        }
        this.render();
        this.host.setStatus(`Assistant: ${PROVIDERS[this.settings.provider].title} · ${this.settings.model}`);
        return true;
      },
    });
  }
}

function stepText(s: Step): string {
  const a = s.args ?? {};
  const parts = [a.layer, a.field, a.where, a.recipe, a.run].filter((x) => typeof x === 'string' && x) as string[];
  return parts.join(' · ');
}
