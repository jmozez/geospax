// GeoSpaX home page: the plugin gallery, an enlarged view of each map, and download buttons that point
// straight at the files of the newest GitHub release (falling back to the releases page).

// Where the hosted web app lives. Empty: the buttons explain how to run the web edition yourself.
const WEBAPP_URL = '';
const REPO = 'jmozez/geospax';

const PLUGINS = [
  ['agriculture', 'Agriculture', 'Cropland suitability from gentle slope, open land and low ground; forest kept out.'],
  ['biodiversity', 'Biodiversity', 'Species richness of OBIS seafloor records per 0.1° cell: 987 taxa, up to 133 in one cell.'],
  ['climate', 'Climate', "Coastal flood exposure of Lae's low-lying coast (10 m and below) from elevation and built-up land."],
  ['conservation', 'Conservation', 'Weighted hotspot grid of marine records on 10 km hexagons.'],
  ['disaster', 'Disaster', 'Landslide susceptibility from slope, local relief and tree cover.'],
  ['environment', 'Environment', 'Elevation profile of a 38.9 km transect to the Huon Gulf: 20 m to 1,175 m.'],
  ['forestry', 'Forestry', '136 forest patches, 28,797 ha of core forest and the links joining them within 500 m.'],
  ['geoscience', 'Geoscience', 'Slope zones of the Markham valley from the Copernicus 30 m DEM.'],
  ['lulc', 'Land use and land cover', 'Forest change 2000–2023 east of Lae: 3,800 ha lost.'],
  ['marine', 'Marine', '409 fish records in 9 DBSCAN clusters over GEBCO bathymetry.'],
  ['soil', 'Soil', 'RUSLE-style erosion potential: slope steepness times vegetation cover.'],
];

const box = document.querySelector('[data-plugins]');
if (box) {
  box.innerHTML = PLUGINS.map(([id, name, text]) => `
    <figure class="shot plugin" tabindex="0" data-full="/img/plugin-${id}.webp">
      <img loading="lazy" src="/img/plugin-${id}.webp" alt="GeoSpaX ${name} plugin" />
      <figcaption><b>${name}.</b> ${text}</figcaption>
    </figure>`).join('') + `
    <figure class="shot plugin" tabindex="0" data-full="/img/tour-hydrology.webp">
      <img loading="lazy" src="/img/tour-hydrology.webp" alt="GeoSpaX Hydrology plugin" />
      <figcaption><b>Hydrology.</b> Strahler-ordered streams and drainage basins from a DEM.</figcaption>
    </figure>`;
}

// enlarge a map
const dlg = document.querySelector('.lightbox');
const open = (fig) => {
  dlg.querySelector('img').src = fig.dataset.full;
  dlg.querySelector('img').alt = fig.querySelector('img').alt;
  dlg.querySelector('p').innerHTML = fig.querySelector('figcaption').innerHTML;
  dlg.showModal();
};
document.addEventListener('click', (e) => {
  const fig = e.target.closest('[data-full]');
  if (fig) open(fig);
  else if (e.target === dlg || e.target.closest('.lightbox button')) dlg.close();
});
document.addEventListener('keydown', (e) => {
  const fig = e.target.closest?.('[data-full]');
  if (fig && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(fig); }
});

// the hosted web app, once there is one
if (WEBAPP_URL) {
  for (const a of document.querySelectorAll('[data-webapp]')) { a.href = WEBAPP_URL; a.textContent = 'Open the web app'; }
  const t = document.querySelector('[data-webapp-text]');
  if (t) t.textContent = 'Use GeoSpaX in your browser, nothing to install.';
}

// which download suits this computer
const ua = navigator.userAgent;
const os = /Windows/.test(ua) ? 'windows' : /Fedora|Red Hat|Rocky|AlmaLinux/.test(ua) ? 'fedora' : /Ubuntu|Debian/.test(ua) ? 'debian' : /Linux|X11/.test(ua) && !/Android/.test(ua) ? 'linux' : null;
if (os) document.querySelector(`.dl[data-os="${os}"]`)?.classList.add('mine');

// newest release: version and direct links to its files
fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((rel) => {
    const v = rel.tag_name.replace(/^v/, '');
    for (const el of document.querySelectorAll('[data-version]')) el.textContent = `Version ${v}`;
    const r = document.querySelector('[data-release]');
    if (r) {
      const a = Object.assign(document.createElement('a'), { href: rel.html_url, rel: 'noopener', textContent: v });
      const when = new Date(rel.published_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
      r.replaceChildren('Version ', a, `, released ${when}`);
    }
    for (const a of document.querySelectorAll('[data-asset]')) {
      const f = rel.assets.find((x) => x.name.endsWith(a.dataset.asset));
      if (f) { a.href = f.browser_download_url; a.title = `${f.name} · ${(f.size / 1e6).toFixed(0)} MB`; }
    }
    const mine = os && document.querySelector(`.dl[data-os="${os}"] [data-asset]`);
    const hero = document.querySelector('[data-primary-download]');
    if (mine && hero) { hero.href = mine.href; hero.textContent = `Download for ${os === 'windows' ? 'Windows' : os === 'fedora' ? 'Fedora / RHEL' : os === 'debian' ? 'Debian / Ubuntu' : 'Linux'}`; }
  })
  .catch(() => { /* offline or rate-limited: the links still lead to the releases page */ });
