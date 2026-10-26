// Help › Tutorials: short guided lessons on the real app. Each step points at a part of the window
// (a ring around it), says what to do there, and moves on with Next; Esc or ✕ ends the lesson.
// Steps may run a command first (open a tab, a pane) so the part they point at is showing.

export interface TutorialStep {
  /** CSS selector of what to point at (nothing: a card in the middle of the window) */
  at?: string;
  title: string;
  text: string;
  /** run before the step is shown, e.g. open a ribbon tab */
  before?: () => void;
}

export interface Tutorial {
  id: string;
  title: string;
  summary: string;
  steps: TutorialStep[];
}

const tab = (t: string) => () => (document.querySelector<HTMLElement>(`#ribbon-tabs [data-tab="${t}"]`))?.click();
const pane = (dock: string, t: string) => () => (document.querySelector<HTMLElement>(`.dock-tabs[data-dock="${dock}"] [data-tab="${t}"]`) ?? document.querySelector<HTMLElement>(`[data-tab="${t}"]`))?.click();

export const TUTORIALS: Tutorial[] = [
  {
    id: 'first-map',
    title: 'Your first map',
    summary: 'Add data, look at it, style it automatically. 5 steps.',
    steps: [
      { title: 'Welcome', text: 'This lesson adds data to the map and styles it. It takes two minutes; Next moves on, Esc ends it at any time.' },
      { at: '.dock-tabs [data-tab="catalog"]', before: pane('left', 'catalog'), title: 'The Explorer', text: 'Everything you can add is here: your folders, web services, online data (climate, soil, species, boundaries) and Sample data. Open Sample data and click a file to add it.' },
      { at: '.dock-tabs [data-tab="contents"]', before: pane('left', 'contents'), title: 'Contents', text: 'Added layers are listed here, top draws on top. Click a layer to select it: the Layer tab of the ribbon and the panel on the right then work on it.' },
      { at: '#dock-right', before: pane('right', 'layer'), title: 'Style', text: 'The Layer panel styles the selected layer. "Style automatically" picks a fitting field, classes and colours for you (AutoMap).' },
      { at: '#statusbar', title: 'The status bar', text: 'The position under the pointer, the scale and the selected layer. Home › Coordinates shows positions as UTM, MGRS or any EPSG system.' },
    ],
  },
  {
    id: 'edit',
    title: 'Edit a layer',
    summary: 'Draw, select, split and merge features; consistent attributes. 6 steps.',
    steps: [
      { at: '#ribbon-tabs [data-tab="edit"]', before: tab('edit'), title: 'The Edit tab', text: 'Select a layer in Contents first: edits go into it. The original file is never changed; GeoSpaX keeps an edit copy you can export or discard.' },
      { at: '#ribbon-body', before: tab('edit'), title: 'Create', text: 'Point, Line and Polygon draw new features; Trace makes new edges follow existing features, and GPS point adds a point at the live position of a connected phone or GNSS receiver.' },
      { at: '#ribbon-body', before: tab('edit'), title: 'Select', text: 'Select (click, Shift adds), Select by rectangle and Lasso select pick the features to work on.' },
      { at: '#ribbon-body', before: tab('edit'), title: 'Modify', text: 'Split cuts the selected features along a line you draw; Merge joins them; Cut takes an area out as a new feature; Reshape redraws part of a boundary. Every edit can be undone with Ctrl+Z.' },
      { at: '#ribbon-body', before: tab('edit'), title: 'Attribute rules', text: 'Attribute rules give fields a list of allowed values, a default and a required mark, so everyone records data the same way.' },
      { at: '#ribbon-body', before: tab('edit'), title: 'Check topology', text: 'Check topology finds overlaps, gaps and invalid shapes in a polygon layer and maps each problem, ready to fix.' },
    ],
  },
  {
    id: 'analyse',
    title: 'Analyse and share',
    summary: 'Run a tool, compare layers, make a finished map and a web map. 6 steps.',
    steps: [
      { at: '#ribbon-tabs [data-tab="analyze"]', before: tab('analyze'), title: 'Analysis', text: 'The Tools group holds the everyday tools (Buffer, Clip, Intersect, Dissolve, Spatial join, Zonal statistics); Network finds service areas and the closest facility along roads.' },
      { at: '#dock-right', before: pane('right', 'toolbox'), title: 'The Toolbox', text: 'Every tool GeoSpaX has, searchable by name, including the ArcGIS Pro and QGIS names it stands in for. Results join the map automatically.' },
      { at: '#ribbon-tabs [data-tab="view"]', before: tab('view'), title: 'Compare', text: 'View › Swipe drags a divider across the map to see it with and without the selected layer; Time slider steps a dated layer through time.' },
      { at: '#ribbon-tabs [data-tab="share"]', before: tab('share'), title: 'Share', text: 'Export map makes PDF, SVG, PNG or a Word report; Export data saves the selected layer as GeoPackage, Shapefile, KML, CSV, GeoJSON or GeoParquet.' },
      { at: '#ribbon-body', before: tab('share'), title: 'Web map', text: 'Publish › Web map makes an interactive map in one HTML file: layer switches, legend and pop-ups. Open it in a browser or put it on any website.' },
      { title: 'Done', text: 'Ctrl+K finds any command by name. Help › User guide has the full manual.' },
    ],
  },
];

export class Tutorials {
  private el: HTMLElement | null = null;
  private ring: HTMLElement | null = null;
  private t: Tutorial | null = null;
  private i = 0;
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.end(); };

  /** The list of lessons. */
  chooser() {
    this.end();
    const el = document.createElement('div');
    el.className = 'modal gx-dialog';
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Tutorials"><header><b>Tutorials</b><button type="button" data-x aria-label="Close">✕</button></header>
      <div class="body tut-list">${TUTORIALS.map((t) => `<button type="button" class="tut-item" data-tut="${t.id}"><b>${t.title}</b><small>${t.summary}</small></button>`).join('')}</div></div>`;
    document.body.append(el);
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tut]');
      if (b) { el.remove(); this.start(b.dataset.tut!); }
      else if ((e.target as HTMLElement).closest('[data-x]') || e.target === el) el.remove();
    });
  }

  start(id: string) {
    const t = TUTORIALS.find((x) => x.id === id);
    if (!t) return;
    this.t = t;
    this.i = 0;
    document.addEventListener('keydown', this.onKey);
    this.show();
  }

  private show() {
    const t = this.t!;
    const s = t.steps[this.i];
    s.before?.();
    this.el?.remove();
    this.ring?.remove();
    const target = s.at ? document.querySelector<HTMLElement>(s.at) : null;
    const card = document.createElement('div');
    card.className = 'tut-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', `${t.title}: ${s.title}`);
    const last = this.i === t.steps.length - 1;
    card.innerHTML = `<div class="tut-head"><small>${t.title} · ${this.i + 1} / ${t.steps.length}</small><button type="button" data-x aria-label="End the lesson">✕</button></div>
      <h3></h3><p></p>
      <div class="tut-nav"><button type="button" data-back ${this.i ? '' : 'disabled'}>Back</button><button type="button" class="primary" data-next>${last ? 'Finish' : 'Next'}</button></div>`;
    card.querySelector('h3')!.textContent = s.title;
    card.querySelector('p')!.textContent = s.text;
    document.body.append(card);
    if (target) {
      const r = target.getBoundingClientRect();
      const ring = document.createElement('div');
      ring.className = 'tut-ring';
      Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
      document.body.append(ring);
      this.ring = ring;
      // the card next to the target, inside the window
      const below = r.bottom + 12 + 180 < innerHeight;
      card.style.top = `${below ? r.bottom + 12 : Math.max(12, r.top - card.offsetHeight - 12)}px`;
      card.style.left = `${Math.max(12, Math.min(innerWidth - card.offsetWidth - 12, r.left))}px`;
    } else {
      card.classList.add('center');
    }
    card.addEventListener('click', (e) => {
      const b = e.target as HTMLElement;
      if (b.closest('[data-x]')) this.end();
      else if (b.closest('[data-back]') && this.i > 0) { this.i--; this.show(); }
      else if (b.closest('[data-next]')) { if (last) this.end(); else { this.i++; this.show(); } }
    });
    (card.querySelector('[data-next]') as HTMLElement).focus();
    this.el = card;
  }

  end() {
    this.el?.remove();
    this.ring?.remove();
    this.el = this.ring = null;
    this.t = null;
    document.removeEventListener('keydown', this.onKey);
  }
}
