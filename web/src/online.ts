// Online data (Data › Online data): climate, future climate, soil, species occurrences, boundaries
// and elevation for the area on the map, without API keys. Each form becomes a one-step recipe
// ("online-data", replaced each time) using the engine's data.fetch or dem.fetch step, so the
// download has run history, provenance and its citation in the methods, like any other result.
import type { Backend } from './backend';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const ONLINE_RECIPE = 'online-data';

export interface OnlineHost {
  backend: Backend;
  /** the map's current bounds [w, s, e, n] */
  view: () => [number, number, number, number];
  /** layer ids (an area can come from a layer) */
  layers: () => string[];
  run: (recipe: string) => Promise<void>;
  setStatus: (t: string, ms?: number) => void;
}

const BIO = [
  'Annual mean temperature', 'Mean diurnal range', 'Isothermality', 'Temperature seasonality', 'Max temperature of warmest month',
  'Min temperature of coldest month', 'Temperature annual range', 'Mean temperature of wettest quarter', 'Mean temperature of driest quarter',
  'Mean temperature of warmest quarter', 'Mean temperature of coldest quarter', 'Annual precipitation', 'Precipitation of wettest month',
  'Precipitation of driest month', 'Precipitation seasonality', 'Precipitation of wettest quarter', 'Precipitation of driest quarter',
  'Precipitation of warmest quarter', 'Precipitation of coldest quarter',
];

const GCMS = ['ACCESS-CM2', 'BCC-CSM2-MR', 'CMCC-ESM2', 'EC-Earth3-Veg', 'GISS-E2-1-G', 'HadGEM3-GC31-LL', 'INM-CM5-0', 'IPSL-CM6A-LR', 'MIROC6', 'MPI-ESM1-2-HR', 'MRI-ESM2-0', 'UKESM1-0-LL'];

const sel = (name: string, opts: [string, string][], value?: string) =>
  `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

const bioPicker = () => `<fieldset class="ol-bio"><legend>Bioclimatic variables</legend>
  <div class="ol-bio-grid">${BIO.map((t, i) => `<label class="ck" title="${esc(t)}"><input type="checkbox" name="bio" value="${i + 1}" ${i === 0 || i === 11 ? 'checked' : ''} /> BIO${i + 1} <span class="dim">${esc(t)}</span></label>`).join('')}</div>
  <div class="ol-bio-quick"><button type="button" data-bio="all">All 19</button><button type="button" data-bio="temp">Temperature (1–11)</button><button type="button" data-bio="prec">Precipitation (12–19)</button><button type="button" data-bio="none">None</button></div></fieldset>`;

const res = () => `<label><span>Resolution</span>${sel('resolution', [['10m', '10 arc-minutes (~18 km)'], ['5m', '5 arc-minutes (~9 km)'], ['2.5m', '2.5 arc-minutes (~4.5 km)'], ['30s', '30 arc-seconds (~1 km)']], '10m')}</label>`;

const FORMS: Record<string, { title: string; lead: string; body: () => string }> = {
  worldclim: {
    title: 'Climate',
    lead: 'Present-day climate surfaces, cut to the area. WorldClim 2.1 (1970–2000) or CHELSA 2.1 (1981–2010, ~1 km).',
    body: () => `<label><span>Dataset</span>${sel('source', [['worldclim', 'WorldClim 2.1 bioclim'], ['worldclim-monthly', 'WorldClim 2.1 monthly'], ['chelsa', 'CHELSA 2.1 bioclim (~1 km)']], 'worldclim')}</label>
      <div data-for="worldclim worldclim-monthly">${res()}</div>
      <div data-for="worldclim-monthly"><label><span>Variable</span>${sel('variable', [['tavg', 'Mean temperature'], ['tmin', 'Minimum temperature'], ['tmax', 'Maximum temperature'], ['prec', 'Precipitation'], ['srad', 'Solar radiation'], ['wind', 'Wind speed'], ['vapr', 'Water vapour pressure']], 'tavg')}</label>
        <label><span>Months</span><input name="months" value="1-12" placeholder="1-12, or 1,4,7,10" /></label></div>
      <div data-for="worldclim chelsa">${bioPicker()}</div>`,
  },
  'worldclim-future': {
    title: 'Future climate',
    lead: 'WorldClim 2.1 CMIP6 downscaled bioclim projections: pick a climate model, a scenario and a period.',
    body: () => `<input type="hidden" name="source" value="worldclim-future" />
      <label><span>Climate model (GCM)</span>${sel('gcm', GCMS.map((g) => [g, g]), 'ACCESS-CM2')}</label>
      <label><span>Scenario</span>${sel('ssp', [['126', 'SSP1-2.6 (low)'], ['245', 'SSP2-4.5 (middle)'], ['370', 'SSP3-7.0 (high)'], ['585', 'SSP5-8.5 (very high)']], '245')}</label>
      <label><span>Period</span>${sel('period', [['2021-2040', '2021–2040'], ['2041-2060', '2041–2060'], ['2061-2080', '2061–2080'], ['2081-2100', '2081–2100']], '2041-2060')}</label>
      ${res()}${bioPicker()}`,
  },
  soilgrids: {
    title: 'Soil',
    lead: 'SoilGrids 2.0 (ISRIC) predicted means at 250 m, cut to the area.',
    body: () => `<input type="hidden" name="source" value="soilgrids" />
      <label><span>Property</span>${sel('property', [['phh2o', 'pH (water)'], ['soc', 'Soil organic carbon'], ['ocd', 'Organic carbon density'], ['clay', 'Clay'], ['sand', 'Sand'], ['silt', 'Silt'], ['bdod', 'Bulk density'], ['cec', 'Cation exchange capacity'], ['nitrogen', 'Nitrogen'], ['cfvo', 'Coarse fragments']], 'phh2o')}</label>
      <label><span>Depth</span>${sel('depth', [['0-5cm', '0–5 cm'], ['5-15cm', '5–15 cm'], ['15-30cm', '15–30 cm'], ['30-60cm', '30–60 cm'], ['60-100cm', '60–100 cm'], ['100-200cm', '100–200 cm']], '0-5cm')}</label>`,
  },
  gbif: {
    title: 'Species occurrences',
    lead: 'Occurrence records with coordinates in the area, with the citation for your methods.',
    body: () => `<label><span>Source</span>${sel('source', [['gbif', 'GBIF (all records)'], ['obis', 'OBIS (marine)'], ['inat', 'iNaturalist (research grade)']], 'gbif')}</label>
      <label><span>Scientific name</span><input name="species" required placeholder="e.g. Paradisaea rudolphi" /></label>
      <label><span>Most records</span><input name="limit" type="number" value="2000" min="1" max="20000" /></label>`,
  },
  gadm: {
    title: 'Boundaries',
    lead: 'GADM 4.1 administrative areas (free for academic and non-commercial use).',
    body: () => `<input type="hidden" name="source" value="gadm" />
      <label><span>Country (ISO code)</span><input name="country" required maxlength="3" placeholder="e.g. PNG" style="text-transform: uppercase" /></label>
      <label><span>Level</span>${sel('level', [['0', '0 · country'], ['1', '1 · provinces / states'], ['2', '2 · districts'], ['3', '3 · local level']], '1')}</label>`,
  },
  gebco: {
    title: 'Ocean depth',
    lead: 'GEBCO 2026 Grid: depth of the sea and height of the land in one surface, 15 arc-seconds (~450 m). Public domain; not for navigation.',
    body: () => `<input type="hidden" name="source" value="gebco" />
      <label class="ck"><input type="checkbox" name="layers" value="elevation" checked /> Depth and height (m, negative below sea level)</label>
      <label class="ck"><input type="checkbox" name="layers" value="tid" /> How each depth was obtained (multibeam, single beam, satellite gravity, interpolation …)</label>`,
  },
  hansen: {
    title: 'Forest change',
    lead: 'Hansen Global Forest Change v1.13 (University of Maryland): tree cover in 2000 and the year of loss 2001–2025 at 30 m, for areas up to about 220 km a side. A relative indicator of loss: do not estimate areas from pixel counts.',
    body: () => `<input type="hidden" name="source" value="hansen" />
      <label class="ck"><input type="checkbox" name="layers" value="treecover" checked /> Tree canopy cover in 2000 (%)</label>
      <label class="ck"><input type="checkbox" name="layers" value="lossyear" checked /> Year of forest loss (2001–2025)</label>
      <label class="ck"><input type="checkbox" name="layers" value="gain" /> Forest gain (2000–2012)</label>
      <label class="ck"><input type="checkbox" name="layers" value="datamask" /> Land and water</label>`,
  },
  ecoregions: {
    title: 'Ecoregions',
    lead: 'RESOLVE Ecoregions 2017 (the WWF terrestrial ecoregions, updated; Dinerstein et al. 2017, CC-BY 4.0): 846 ecoregions in 14 biomes, clipped to the area, in their published colours. The 149 MB file is downloaded once.',
    body: () => `<input type="hidden" name="source" value="ecoregions" />`,
  },
  dem: {
    title: 'Elevation',
    lead: 'Copernicus DEM, read as windows of its cloud-optimised tiles and reprojected to the local UTM zone.',
    body: () => `<label><span>Dataset</span>${sel('dem', [['copernicus', 'Copernicus GLO-30 (30 m)'], ['copernicus-90', 'Copernicus GLO-90 (90 m)']], 'copernicus')}</label>`,
  },
};

/** "1-3,7" → [1,2,3,7] (months). */
export function parseRanges(text: string, lo: number, hi: number): number[] {
  const out = new Set<number>();
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) out.add(i);
    else if (/^\d+$/.test(part)) out.add(Number(part));
  }
  return [...out].filter((n) => n >= lo && n <= hi).sort((a, b) => a - b);
}

export class OnlineData {
  private el: HTMLElement;

  constructor(private host: OnlineHost) {
    this.el = document.createElement('div');
    this.el.id = 'online';
    this.el.className = 'modal';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-close]')) this.close();
      const quick = t.closest<HTMLElement>('[data-bio]')?.dataset.bio;
      if (quick) {
        this.el.querySelectorAll<HTMLInputElement>('input[name=bio]').forEach((c) => {
          const n = Number(c.value);
          c.checked = quick === 'all' || (quick === 'temp' && n <= 11) || (quick === 'prec' && n >= 12);
        });
      }
    });
    this.el.addEventListener('change', () => this.showFor());
    this.el.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.fetch(e.target as HTMLFormElement);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) this.close();
    });
    document.addEventListener('geospax:online', (e) => this.open(String((e as CustomEvent).detail ?? 'worldclim')));
  }

  open(kind: string) {
    if (kind === 'choose') return this.choose();
    const f = FORMS[kind] ?? FORMS.worldclim;
    const layers = this.host.layers();
    this.el.innerHTML = `<form class="sheet fin ol" data-kind="${esc(kind)}">
      <header><b>${esc(f.title)}</b><button type="button" data-close aria-label="Close">✕</button></header>
      <div class="body">
        <p class="fin-lead">${esc(f.lead)}</p>
        ${f.body()}
        ${
          kind === 'gadm'
            ? ''
            : `<fieldset><legend>Area</legend>
          <label class="ck"><input type="radio" name="area" value="view" checked /> The map view</label>
          ${layers.length ? `<label class="ck"><input type="radio" name="area" value="layer" /> Around a layer ${sel('aoi_layer', layers.map((l) => [l, l]))}</label>` : ''}
          <label><span>Margin (km)</span><input name="buffer_km" type="number" value="0" min="0" step="1" /></label></fieldset>`
        }
        <p class="dim">Needs internet. The citation goes into the run's methods and report.</p>
      </div>
      <footer><span class="dim" id="online-msg"></span><button type="button" data-close>Cancel</button><button class="primary" type="submit">Get data</button></footer>
    </form>`;
    this.el.hidden = false;
    this.showFor();
    this.el.querySelector<HTMLElement>('input:not([type=hidden]), select')?.focus();
  }

  /** Every source as a card (Lazy mode's "Online data" task, Data › All sources). */
  private choose() {
    const card = (kind: string, sub: string) => `<button type="button" class="ol-card" data-online="${kind}"><b>${esc(FORMS[kind].title)}</b><small>${esc(sub)}</small></button>`;
    this.el.innerHTML = `<div class="sheet fin ol">
      <header><b>Online data</b><button type="button" data-close aria-label="Close">✕</button></header>
      <div class="body"><p class="fin-lead">Free data for the area on the map, no account needed. Each download keeps its citation.</p>
        <div class="ol-cards">
          ${card('worldclim', 'WorldClim or CHELSA bioclim and monthly climate')}
          ${card('worldclim-future', 'CMIP6 projections by model, SSP and period')}
          ${card('soilgrids', 'SoilGrids pH, carbon, texture by depth')}
          ${card('gbif', 'GBIF, OBIS and iNaturalist records')}
          ${card('gadm', 'GADM administrative areas')}
          ${card('dem', 'Copernicus 30 m / 90 m DEM')}
          ${card('gebco', 'GEBCO 2026 sea depth and land height')}
          ${card('hansen', 'Hansen tree cover 2000 and loss 2001–2025')}
          ${card('ecoregions', 'RESOLVE / WWF terrestrial ecoregions')}
        </div></div>
    </div>`;
    this.el.hidden = false;
    this.el.querySelector<HTMLElement>('.ol-card')?.focus();
    this.el.querySelectorAll<HTMLElement>('[data-online]').forEach((b) => b.addEventListener('click', () => this.open(b.dataset.online!)));
  }

  close() {
    this.el.hidden = true;
  }

  /** show the fields that belong to the chosen dataset */
  private showFor() {
    const src = this.el.querySelector<HTMLSelectElement>('select[name=source]')?.value;
    this.el.querySelectorAll<HTMLElement>('[data-for]').forEach((d) => {
      const hide = !!src && !d.dataset.for!.split(' ').includes(src);
      d.hidden = hide;
      // hidden fields stay out of the request
      d.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((i) => (i.disabled = hide));
    });
  }

  /** the step for the form (exported shape for tests: use + with) */
  step(form: HTMLFormElement): { use: string; with: Record<string, unknown> } | string {
    const f = new FormData(form);
    const kind = form.dataset.kind ?? 'worldclim';
    const w: Record<string, unknown> = {};
    if (kind !== 'gadm') {
      if (f.get('area') === 'layer' && f.get('aoi_layer')) w.aoi = String(f.get('aoi_layer'));
      else w.aoi = this.host.view().map((v) => Math.round(v * 1e4) / 1e4);
      const km = Number(f.get('buffer_km') ?? 0);
      w.buffer = Number.isFinite(km) ? Math.max(0, km) * 1000 : 0;
    }
    if (kind === 'dem') return { use: 'dem.fetch', with: { ...w, source: String(f.get('dem') ?? 'copernicus') } };
    const source = String(f.get('source') ?? kind);
    w.source = source;
    for (const k of ['resolution', 'variable', 'gcm', 'ssp', 'period', 'property', 'depth', 'species', 'country', 'level', 'limit']) {
      const v = f.get(k);
      if (v != null && v !== '') w[k] = ['level', 'limit'].includes(k) ? Number(v) : String(v).trim();
    }
    if (source === 'worldclim-monthly') {
      const months = parseRanges(String(f.get('months') ?? '1-12'), 1, 12);
      if (!months.length) return 'Months: give numbers from 1 to 12';
      w.months = months;
    }
    if (['worldclim', 'worldclim-future', 'chelsa'].includes(source)) {
      const bio = f.getAll('bio').map(Number);
      if (!bio.length) return 'Tick at least one bioclimatic variable';
      w.variables = bio;
    }
    if (source === 'gebco' || source === 'hansen') {
      const layers = f.getAll('layers').map(String);
      if (!layers.length) return `Tick at least one ${source === 'gebco' ? 'GEBCO' : 'Hansen'} layer`;
      w.layers = layers;
    }
    if (source === 'gadm') w.country = String(w.country ?? '').toUpperCase();
    return { use: 'data.fetch', with: w };
  }

  private async fetch(form: HTMLFormElement) {
    const msg = this.el.querySelector<HTMLElement>('#online-msg');
    const s = this.step(form);
    if (typeof s === 'string') {
      if (msg) msg.textContent = s;
      return;
    }
    const title = FORMS[form.dataset.kind ?? 'worldclim']?.title ?? 'Online data';
    // JSON is valid YAML: the parameters go in as JSON so names with ':' stay intact
    const yaml = [
      `# Made by Data › Online data on ${new Date().toLocaleString()}; replaced the next time you get online data.`,
      `recipe: ${ONLINE_RECIPE}`,
      'version: 1',
      `title: ${JSON.stringify(`${title} (online data)`)}`,
      'steps:',
      '  - id: fetch',
      `    use: ${s.use}`,
      `    with: ${JSON.stringify(s.with)}`,
      'outputs: [fetch]',
      '',
    ].join('\n');
    try {
      if (msg) msg.textContent = 'Starting…';
      await this.host.backend.json('api/recipes', { method: 'POST', body: yaml, headers: { 'content-type': 'text/yaml' } });
      this.close();
      this.host.setStatus(`Getting ${title.toLowerCase()} for the area…`, 10000);
      await this.host.run(ONLINE_RECIPE);
    } catch (err) {
      if (msg) msg.textContent = String((err as Error).message ?? err);
    }
  }
}
