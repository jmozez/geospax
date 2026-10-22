// Right-click menus (long press on touch screens), as in ArcGIS Pro and QGIS: on layers in Contents,
// items in the Catalog and the map. One menu at a time; Esc, a click elsewhere or scrolling closes it.

export interface MenuItem {
  label?: string;
  hint?: string;
  run?: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
  /** a divider line */
  sep?: boolean;
}

let open: HTMLElement | null = null;

export function closeMenu() {
  open?.remove();
  open = null;
}

/** Show a menu at viewport point (x, y), kept inside the window. */
export function showMenu(x: number, y: number, title: string, items: MenuItem[]) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', title);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  m.innerHTML = `<div class="ctx-title">${esc(title)}</div>` +
    items
      .map((it, i) =>
        it.sep
          ? '<div class="ctx-sep" role="separator"></div>'
          : `<button type="button" role="menuitem" data-i="${i}"${it.disabled ? ' disabled' : ''} class="${it.danger ? 'danger' : ''}"${it.hint ? ` title="${esc(it.hint)}"` : ''}>${esc(it.label ?? '')}</button>`,
      )
      .join('');
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  open = m;
  m.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-i]');
    if (!b || b.disabled) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    void it.run?.();
  });
  m.addEventListener('keydown', (e) => {
    const btns = [...m.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    else if (e.key === 'Escape') closeMenu();
  });
  m.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', (e) => {
  if (open && !open.contains(e.target as Node)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
addEventListener('resize', closeMenu);
addEventListener('blur', closeMenu);

/**
 * Call `handler` on right-click inside `root`, and on a long press (550 ms without moving) on touch
 * screens, which have no right button.
 */
export function onContextMenu(root: HTMLElement, handler: (target: HTMLElement, x: number, y: number) => boolean) {
  root.addEventListener('contextmenu', (e) => {
    if (handler(e.target as HTMLElement, e.clientX, e.clientY)) e.preventDefault();
  });
  let timer = 0;
  let start: [number, number] | null = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    start = [e.clientX, e.clientY];
    const t = e.target as HTMLElement;
    timer = window.setTimeout(() => {
      if (start && handler(t, start[0], start[1])) navigator.vibrate?.(15);
      start = null;
    }, 550);
  });
  const cancel = (e: PointerEvent) => {
    if (start && e.type === 'pointermove' && Math.hypot(e.clientX - start[0], e.clientY - start[1]) < 10) return;
    clearTimeout(timer);
    start = null;
  };
  for (const ev of ['pointerup', 'pointercancel', 'pointermove'] as const) root.addEventListener(ev, cancel);
}
