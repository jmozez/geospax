// One interactive map tool at a time (ArcGIS Pro's "active tool").
//
// Swipe, Spyglass, Identify, Measure, the Edit tools and the Design (CAD) tools all take over
// map clicks. A module that starts one calls claimMapTool(name, stop): the tool that held the map
// before is stopped first, so two tools never fight over the same click. stop() is called when
// another tool starts, when the same ribbon button is clicked again, or when Esc is pressed.
// The ribbon listens for 'geospax:toolstate' and keeps the active button pressed (aria-pressed).

type Holder = { name: string; stop: () => void };
let holder: Holder | null = null;

const changed = () => {
  if (holder) document.body.dataset.mapTool = holder.name;
  else delete document.body.dataset.mapTool;
  document.dispatchEvent(new CustomEvent('geospax:toolstate', { detail: holder?.name ?? null }));
};

/** The name of the tool that holds the map, or null. */
export const mapTool = (): string | null => holder?.name ?? null;

/** True when the named tool (or, with a trailing ':', any tool of that family) holds the map. */
export const isMapTool = (name: string): boolean =>
  !!holder && (name.endsWith(':') ? holder.name.startsWith(name) : holder.name === name);

/** Start a map tool: stops the one that held the map before (unless it is the same tool). */
export function claimMapTool(name: string, stop: () => void): void {
  const prev = holder;
  holder = { name, stop };
  if (prev && prev.name !== name) {
    try { prev.stop(); } catch (e) { console.warn('stopping', prev.name, e); }
  }
  holder = { name, stop };
  changed();
}

/** A tool ended by itself: forget it (only when it is still the holder). */
export function releaseMapTool(name: string): void {
  if (!holder || holder.name !== name) return;
  holder = null;
  changed();
}

/** End the active map tool (ribbon button clicked again, or Esc). */
export function stopMapTool(): void {
  const h = holder;
  if (!h) return;
  holder = null;
  try { h.stop(); } catch (e) { console.warn('stopping', h.name, e); }
  changed();
}

/** Something else changed a toggle (grid, labels, theme …): ask the ribbon to refresh pressed states. */
export const toolStateChanged = (): void => { document.dispatchEvent(new CustomEvent('geospax:toolstate', { detail: holder?.name ?? null })); };

// Esc ends the active map tool, as in ArcGIS Pro and QGIS (not while typing in a field or a dialog)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !holder) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, [contenteditable], dialog, .modal')) return;
  stopMapTool();
});
