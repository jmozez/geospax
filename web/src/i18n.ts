// Interface language. English is the source; other languages are dictionaries keyed by the English
// text, so an untranslated string simply stays in English. Settings › Appearance › Language picks it;
// the choice is kept in this browser (localStorage) and applied on reload.
//
// Tok Pisin comes first (Papua New Guinea). These translations are a first draft and need review by
// fluent speakers: corrections go in this file (one line per string) and are welcome as PRs.

export type Lang = 'en' | 'tpi' | 'fr' | 'es' | 'id';

export const LANGS: [Lang, string][] = [
  ['en', 'English'],
  ['tpi', 'Tok Pisin'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['id', 'Bahasa Indonesia'],
];

const KEY = 'geospax.lang';

export function currentLang(): Lang {
  try {
    const v = localStorage.getItem(KEY) as Lang | null;
    if (v && LANGS.some(([k]) => k === v)) return v;
  } catch { /* private mode */ }
  return 'en';
}

export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* private mode */ }
}

type Dict = Record<string, string>;

const TPI: Dict = {
  // ribbon tabs
  Home: 'Haus', View: 'Lukluk', Edit: 'Senisim', Design: 'Droim', Imagery: 'Piksa', Analysis: 'Skelim', Share: 'Salim', Help: 'Helpim',
  // groups
  Project: 'Projek', Layer: 'Lea', Navigate: 'Painim rot', Selection: 'Makim', Inquiry: 'Askim', Symbology: 'Ol mak',
  Basemap: 'Bes map', Compare: 'Skelim tupela', Projection: 'Projeksen', Time: 'Taim', 'Map grid': 'Ol lain bilong map',
  Theme: 'Kala', Windows: 'Ol windo', Clipboard: 'Klipbot', Create: 'Wokim nupela', Modify: 'Senisim', Measure: 'Mesarim',
  Draw: 'Droim', Survey: 'Saveim graun', Terrain: 'Graun', Indices: 'Ol indeks', Rasters: 'Ol raster', 'Raster tools': 'Ol tul bilong raster',
  Tools: 'Ol tul', Geoprocessing: 'Wok bilong map', 'Spatial statistics': 'Statistik bilong ples', Interpolation: 'Pulimapim namel',
  Network: 'Ol rot', 'Export map': 'Salim map', 'Export data': 'Salim data', Publish: 'Putim long web', Layout: 'Pes bilong map',
  Docs: 'Ol buk', Learn: 'Lainim', Support: 'Sapot', About: 'Long GeoSpaX', Fields: 'Ol fil', 'Manage edits': 'Lukautim ol senis',
  Precision: 'Stret tru', Construct: 'Wokim', Blocks: 'Ol blok', 'CAD exchange': 'CAD', Assistant: 'Helpim man', 'AI models': 'Ol AI model',
  'Satellite embeddings': 'Satelait embeding',
  // common commands
  New: 'Nupela', 'New project': 'Nupela projek', Open: 'Opim', 'Open project': 'Opim projek', Save: 'Seiv', 'Save as': 'Seiv olsem',
  Rename: 'Senisim nem', Settings: 'Setting', Refresh: 'Kirapim gen', 'Add data': 'Putim data', 'Zoom in': 'Kam klostu', 'Zoom out': 'Go longwe',
  'Full extent': 'Lukim olgeta', 'Zoom to': 'Go long en', Identify: 'Save long en', 'Find a place': 'Painim ples',
  Select: 'Makim', 'Clear selection': 'Rausim mak', Attributes: 'Ol save', Swipe: 'Swaip', Spyglass: 'Glas bilong lukluk',
  Globe: 'Graun raun', Mercator: 'Mercator', '3D terrain': 'Graun 3D', 'Time slider': 'Taim slaida', Grid: 'Grid',
  Light: 'Lait', Dark: 'Tudak', 'Follow the system': 'Bihainim kompyuta', 'Left pane': 'Pes long kais', 'Bottom pane': 'Pes long daunbilo',
  'Details pane': 'Pes bilong ol save', 'Reset layout': 'Stretim gen ol pes', 'Full screen': 'Pulapim skrin', 'Command palette': 'Painim komand',
  Buffer: 'Banis raun', Clip: 'Katim', Intersect: 'Bung namel', Union: 'Bungim', Erase: 'Rausim', 'Zonal statistics': 'Statistik bilong ol hap',
  'Hot spots': 'Ol hat ples', Hillshade: 'Sedo bilong maunten', Slope: 'Skru bilong graun', Contours: 'Ol kontua',
  'Export PDF': 'Salim PDF', 'User guide': 'Buk bilong yusim', FAQ: 'Ol askim', Credits: 'Tenkyu', 'About GeoSpaX': 'Long GeoSpaX',
  'Report a problem': 'Tokim hevi', 'Check for updates': 'Lukim nupela vesen', Keyboard: 'Ki bot', 'Take the tour': 'Wokabaut long app',
  Tutorials: 'Ol skul', Language: 'Tok ples',
};

const FR: Dict = {
  Home: 'Accueil', View: 'Affichage', Edit: 'Édition', Design: 'Dessin', Imagery: 'Imagerie', Analysis: 'Analyse', Share: 'Partager', Help: 'Aide',
  Project: 'Projet', Layer: 'Couche', Navigate: 'Navigation', Selection: 'Sélection', Inquiry: 'Interrogation', Symbology: 'Symbologie',
  Basemap: 'Fond de carte', Compare: 'Comparer', Projection: 'Projection', Time: 'Temps', Theme: 'Thème', Windows: 'Fenêtres',
  Measure: 'Mesurer', Draw: 'Dessiner', Tools: 'Outils', 'Export map': 'Exporter la carte', 'Export data': 'Exporter les données',
  Docs: 'Documentation', Learn: 'Apprendre', Support: 'Assistance', About: 'À propos', Language: 'Langue',
};

const ES: Dict = {
  Home: 'Inicio', View: 'Vista', Edit: 'Editar', Design: 'Diseño', Imagery: 'Imágenes', Analysis: 'Análisis', Share: 'Compartir', Help: 'Ayuda',
  Project: 'Proyecto', Layer: 'Capa', Navigate: 'Navegar', Selection: 'Selección', Inquiry: 'Consulta', Symbology: 'Simbología',
  Basemap: 'Mapa base', Compare: 'Comparar', Projection: 'Proyección', Time: 'Tiempo', Theme: 'Tema', Windows: 'Ventanas',
  Measure: 'Medir', Draw: 'Dibujar', Tools: 'Herramientas', 'Export map': 'Exportar mapa', 'Export data': 'Exportar datos',
  Docs: 'Documentación', Learn: 'Aprender', Support: 'Soporte', About: 'Acerca de', Language: 'Idioma',
};

const ID: Dict = {
  Home: 'Beranda', View: 'Tampilan', Edit: 'Sunting', Design: 'Desain', Imagery: 'Citra', Analysis: 'Analisis', Share: 'Bagikan', Help: 'Bantuan',
  Project: 'Proyek', Layer: 'Lapisan', Navigate: 'Navigasi', Selection: 'Pilihan', Inquiry: 'Kueri', Symbology: 'Simbologi',
  Basemap: 'Peta dasar', Compare: 'Bandingkan', Projection: 'Proyeksi', Time: 'Waktu', Theme: 'Tema', Windows: 'Jendela',
  Measure: 'Ukur', Draw: 'Gambar', Tools: 'Alat', 'Export map': 'Ekspor peta', 'Export data': 'Ekspor data',
  Docs: 'Dokumentasi', Learn: 'Belajar', Support: 'Dukungan', About: 'Tentang', Language: 'Bahasa',
};

const DICTS: Record<Lang, Dict> = { en: {}, tpi: TPI, fr: FR, es: ES, id: ID };

let dict: Dict = DICTS[currentLang()];

/** The text in the chosen language (the English text when there is no translation yet). */
export function t(en: string): string {
  return dict[en] ?? en;
}

/** Share of these English strings that have a translation (shown next to the language picker). */
export function coverage(lang: Lang, strings: string[]): number {
  if (lang === 'en' || !strings.length) return 1;
  const d = DICTS[lang];
  return strings.filter((s) => s in d).length / strings.length;
}

export function useLang(l: Lang) {
  dict = DICTS[l];
  document.documentElement.lang = l === 'tpi' ? 'tpi' : l;
}

useLang(currentLang());
