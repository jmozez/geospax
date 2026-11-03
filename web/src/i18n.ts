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
  // more commands
  'Print': 'Printim',
  'Web map': 'Map long web',
  'Package project': 'Pasim projek',
  'OGC API service': 'Sevis OGC API',
  'GeoParquet by URL': 'GeoParquet long URL',
  'Layout window': 'Windo bilong pes',
  'Finish my map': 'Pinisim map bilong mi',
  'Contents': 'Ol samting insait',
  'Bookmarks': 'Ol mak bilong ples',
};

const FR: Dict = {
  Home: 'Accueil', View: 'Affichage', Edit: 'Édition', Design: 'Dessin', Imagery: 'Imagerie', Analysis: 'Analyse', Share: 'Partager', Help: 'Aide',
  Project: 'Projet', Layer: 'Couche', Navigate: 'Navigation', Selection: 'Sélection', Inquiry: 'Interrogation', Symbology: 'Symbologie',
  Basemap: 'Fond de carte', Compare: 'Comparer', Projection: 'Projection', Time: 'Temps', Theme: 'Thème', Windows: 'Fenêtres',
  Measure: 'Mesurer', Draw: 'Dessiner', Tools: 'Outils', 'Export map': 'Exporter la carte', 'Export data': 'Exporter les données',
  Docs: 'Documentation', Learn: 'Apprendre', Support: 'Assistance', About: 'À propos', Language: 'Langue',
  // more commands
  'New project': 'Nouveau projet',
  'Open project': 'Ouvrir un projet',
  'Save': 'Enregistrer',
  'Save as': 'Enregistrer sous',
  'Rename': 'Renommer',
  'Settings': 'Paramètres',
  'Refresh': 'Actualiser',
  'Add data': 'Ajouter des données',
  'Zoom in': 'Zoom avant',
  'Zoom out': 'Zoom arrière',
  'Full extent': 'Étendue totale',
  'Identify': 'Identifier',
  'Find a place': 'Trouver un lieu',
  'Select': 'Sélectionner',
  'Clear selection': 'Effacer la sélection',
  'Attributes': 'Attributs',
  'Swipe': 'Balayage',
  'Spyglass': 'Loupe',
  'Globe': 'Globe',
  'Time slider': 'Curseur temporel',
  'Light': 'Clair',
  'Dark': 'Sombre',
  'Follow the system': 'Suivre le système',
  'Reset layout': 'Réinitialiser la disposition',
  'Full screen': 'Plein écran',
  'Buffer': 'Zone tampon',
  'Clip': 'Découper',
  'Intersect': 'Intersection',
  'Union': 'Union',
  'Erase': 'Effacer',
  'Zonal statistics': 'Statistiques zonales',
  'Hot spots': 'Points chauds',
  'Hillshade': 'Ombrage',
  'Slope': 'Pente',
  'Contours': 'Courbes de niveau',
  'User guide': 'Guide de l\'utilisateur',
  'FAQ': 'FAQ',
  'Credits': 'Crédits',
  'About GeoSpaX': 'À propos de GeoSpaX',
  'Report a problem': 'Signaler un problème',
  'Check for updates': 'Rechercher des mises à jour',
  'Keyboard': 'Clavier',
  'Tutorials': 'Tutoriels',
  'Indices': 'Indices',
  'Print': 'Imprimer',
  'Web map': 'Carte web',
  'Package project': 'Empaqueter le projet',
  'OGC API service': 'Service OGC API',
  'GeoParquet by URL': 'GeoParquet par URL',
  'Layout window': 'Fenêtre de mise en page',
  'Finish my map': 'Terminer ma carte',
  'Rasters': 'Rasters',
  'Terrain': 'Terrain',
  'Raster tools': 'Outils raster',
  'Geoprocessing': 'Géotraitement',
  'Spatial statistics': 'Statistiques spatiales',
  'Publish': 'Publier',
  'Layout': 'Mise en page',
  'Contents': 'Contenu',
  'Bookmarks': 'Signets',
};

const ES: Dict = {
  Home: 'Inicio', View: 'Vista', Edit: 'Editar', Design: 'Diseño', Imagery: 'Imágenes', Analysis: 'Análisis', Share: 'Compartir', Help: 'Ayuda',
  Project: 'Proyecto', Layer: 'Capa', Navigate: 'Navegar', Selection: 'Selección', Inquiry: 'Consulta', Symbology: 'Simbología',
  Basemap: 'Mapa base', Compare: 'Comparar', Projection: 'Proyección', Time: 'Tiempo', Theme: 'Tema', Windows: 'Ventanas',
  Measure: 'Medir', Draw: 'Dibujar', Tools: 'Herramientas', 'Export map': 'Exportar mapa', 'Export data': 'Exportar datos',
  Docs: 'Documentación', Learn: 'Aprender', Support: 'Soporte', About: 'Acerca de', Language: 'Idioma',
  // more commands
  'New project': 'Nuevo proyecto',
  'Open project': 'Abrir proyecto',
  'Save': 'Guardar',
  'Save as': 'Guardar como',
  'Rename': 'Renombrar',
  'Settings': 'Configuración',
  'Refresh': 'Actualizar',
  'Add data': 'Agregar datos',
  'Zoom in': 'Acercar',
  'Zoom out': 'Alejar',
  'Full extent': 'Extensión completa',
  'Identify': 'Identificar',
  'Find a place': 'Buscar un lugar',
  'Select': 'Seleccionar',
  'Clear selection': 'Borrar selección',
  'Attributes': 'Atributos',
  'Swipe': 'Deslizar',
  'Spyglass': 'Lupa',
  'Globe': 'Globo',
  'Time slider': 'Control deslizante de tiempo',
  'Light': 'Claro',
  'Dark': 'Oscuro',
  'Follow the system': 'Seguir el sistema',
  'Reset layout': 'Restablecer diseño',
  'Full screen': 'Pantalla completa',
  'Buffer': 'Zona de influencia',
  'Clip': 'Recortar',
  'Intersect': 'Intersecar',
  'Union': 'Unión',
  'Erase': 'Borrar',
  'Zonal statistics': 'Estadísticas zonales',
  'Hot spots': 'Puntos calientes',
  'Hillshade': 'Sombreado',
  'Slope': 'Pendiente',
  'Contours': 'Curvas de nivel',
  'User guide': 'Guía del usuario',
  'FAQ': 'Preguntas frecuentes',
  'Credits': 'Créditos',
  'About GeoSpaX': 'Acerca de GeoSpaX',
  'Report a problem': 'Informar un problema',
  'Check for updates': 'Buscar actualizaciones',
  'Keyboard': 'Teclado',
  'Tutorials': 'Tutoriales',
  'Indices': 'Índices',
  'Print': 'Imprimir',
  'Web map': 'Mapa web',
  'Package project': 'Empaquetar proyecto',
  'OGC API service': 'Servicio OGC API',
  'GeoParquet by URL': 'GeoParquet por URL',
  'Layout window': 'Ventana de diseño',
  'Finish my map': 'Terminar mi mapa',
  'Rasters': 'Ráster',
  'Terrain': 'Terreno',
  'Raster tools': 'Herramientas ráster',
  'Geoprocessing': 'Geoprocesamiento',
  'Spatial statistics': 'Estadística espacial',
  'Publish': 'Publicar',
  'Layout': 'Diseño',
  'Contents': 'Contenido',
  'Bookmarks': 'Marcadores',
};

const ID: Dict = {
  Home: 'Beranda', View: 'Tampilan', Edit: 'Sunting', Design: 'Desain', Imagery: 'Citra', Analysis: 'Analisis', Share: 'Bagikan', Help: 'Bantuan',
  Project: 'Proyek', Layer: 'Lapisan', Navigate: 'Navigasi', Selection: 'Pilihan', Inquiry: 'Kueri', Symbology: 'Simbologi',
  Basemap: 'Peta dasar', Compare: 'Bandingkan', Projection: 'Proyeksi', Time: 'Waktu', Theme: 'Tema', Windows: 'Jendela',
  Measure: 'Ukur', Draw: 'Gambar', Tools: 'Alat', 'Export map': 'Ekspor peta', 'Export data': 'Ekspor data',
  Docs: 'Dokumentasi', Learn: 'Belajar', Support: 'Dukungan', About: 'Tentang', Language: 'Bahasa',
  // more commands
  'New project': 'Proyek baru',
  'Open project': 'Buka proyek',
  'Save': 'Simpan',
  'Save as': 'Simpan sebagai',
  'Rename': 'Ganti nama',
  'Settings': 'Pengaturan',
  'Refresh': 'Muat ulang',
  'Add data': 'Tambah data',
  'Zoom in': 'Perbesar',
  'Zoom out': 'Perkecil',
  'Full extent': 'Seluruh cakupan',
  'Identify': 'Identifikasi',
  'Find a place': 'Cari tempat',
  'Select': 'Pilih',
  'Clear selection': 'Hapus pilihan',
  'Attributes': 'Atribut',
  'Swipe': 'Geser',
  'Spyglass': 'Kaca pembesar',
  'Globe': 'Bola dunia',
  'Time slider': 'Penggeser waktu',
  'Light': 'Terang',
  'Dark': 'Gelap',
  'Follow the system': 'Ikuti sistem',
  'Reset layout': 'Atur ulang tata letak',
  'Full screen': 'Layar penuh',
  'Buffer': 'Buffer',
  'Clip': 'Potong',
  'Intersect': 'Irisan',
  'Union': 'Gabungan',
  'Erase': 'Hapus',
  'Zonal statistics': 'Statistik zonal',
  'Hot spots': 'Titik panas',
  'Hillshade': 'Bayangan bukit',
  'Slope': 'Kemiringan',
  'Contours': 'Kontur',
  'User guide': 'Panduan pengguna',
  'FAQ': 'Tanya jawab',
  'Credits': 'Kredit',
  'About GeoSpaX': 'Tentang GeoSpaX',
  'Report a problem': 'Laporkan masalah',
  'Check for updates': 'Periksa pembaruan',
  'Keyboard': 'Papan ketik',
  'Tutorials': 'Tutorial',
  'Indices': 'Indeks',
  'Print': 'Cetak',
  'Web map': 'Peta web',
  'Package project': 'Kemas proyek',
  'OGC API service': 'Layanan OGC API',
  'GeoParquet by URL': 'GeoParquet dari URL',
  'Layout window': 'Jendela tata letak',
  'Finish my map': 'Selesaikan peta saya',
  'Rasters': 'Raster',
  'Terrain': 'Medan',
  'Raster tools': 'Alat raster',
  'Geoprocessing': 'Geoproses',
  'Spatial statistics': 'Statistik spasial',
  'Publish': 'Terbitkan',
  'Layout': 'Tata letak',
  'Contents': 'Isi',
  'Bookmarks': 'Penanda',
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
