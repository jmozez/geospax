// GeoSpaX home page: the plugin gallery, an enlarged view of each map, and download buttons that point
// straight at the files of the newest GitHub release (falling back to the releases page).

// Where the hosted web app lives. Empty: the buttons explain how to run the web edition yourself.
const WEBAPP_URL = 'https://geospax.fly.dev';
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
    <figure class="shot plugin" tabindex="0" data-full="/img/tour-landcover.webp">
      <img loading="lazy" src="/img/tour-landcover.webp" alt="ESA WorldCover land cover of Lae" />
      <figcaption><b>Land cover.</b> ESA WorldCover 10 m for Lae, fetched for the area.</figcaption>
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
const os = /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Linux|X11/.test(ua) && !/Android/.test(ua) ? 'linux' : null;
if (os) document.querySelector(`.dl[data-os="${os}"]`)?.classList.add('mine');

// newest release: version and direct links to its files
fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((rel) => {
    const v = rel.tag_name.replace(/^v/, '');
    for (const el of document.querySelectorAll('[data-version]')) el.textContent = `GeoSpaX ${v}`;
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
    if (mine && hero) { hero.href = mine.href; hero.textContent = `Download for ${os === 'android' ? 'Android' : os === 'windows' ? 'Windows' : 'Linux'}`; }
  })
  .catch(() => { /* offline or rate-limited: the links still lead to the releases page */ });

// the year in the footer
for (const el of document.querySelectorAll('[data-year]')) el.textContent = new Date().getFullYear();

// Lazy / Pro / Start tabs
const tabs = document.querySelectorAll('[data-tab]');
for (const t of tabs) t.addEventListener('click', () => {
  for (const o of tabs) o.setAttribute('aria-selected', String(o === t));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t.dataset.tab;
});

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

// sections fade up as they scroll into view; the hero picture flattens
const io = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { rootMargin: '0px 0px -10% 0px' });
for (const el of document.querySelectorAll('section:not(.hero) .wrap > *, .bento article, .tours figure, .dl')) {
  el.classList.add('reveal'); io.observe(el);
}
const shot = document.querySelector('.hero-shot');
if (shot) {
  const flat = () => shot.classList.toggle('flat', scrollY > 80);
  addEventListener('scroll', flat, { passive: true }); flat();
}

// a slowly turning dotted Earth behind the hero (land from Natural Earth, 1.5° spacing)
const cv = document.querySelector('.globe');
if (cv) fetch('/img/land-dots.json').then((r) => r.json()).then((d) => {
  const ctx = cv.getContext('2d');
  const pts = [];
  for (let i = 0; i < d.length; i += 2) {
    const lon = d[i] * Math.PI / 180, lat = d[i + 1] * Math.PI / 180;
    pts.push([Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
  }
  // a few glowing "data" points: Lae, Mt Wilhelm, and other places
  const hot = [[147.0, -6.7], [145.03, -5.78], [-122.4, 37.8], [2.35, 48.85], [36.8, -1.3], [151.2, -33.9], [-47.9, -15.8], [103.8, 1.35]]
    .map(([lo, la]) => { lo *= Math.PI / 180; la *= Math.PI / 180; return [Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)]; });
  let w, h, dpr;
  const size = () => { dpr = Math.min(devicePixelRatio || 1, 2); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; };
  size(); addEventListener('resize', size);
  const tilt = 0.32;
  const draw = (t) => {
    const rot = still ? 2.6 : 2.6 + t / 26000;
    const cr = Math.cos(rot), sr = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt);
    const R = Math.min(w, h) * 0.46 * dpr, cx = w * dpr / 2, cy = h * dpr * 0.46;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const g = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.08);
    g.addColorStop(0, 'rgba(255,122,69,0)'); g.addColorStop(1, 'rgba(255,122,69,0.10)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.08, 0, 7); ctx.fill();
    const proj = ([x, y, z]) => {
      const x1 = x * cr - z * sr, z1 = x * sr + z * cr;
      const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
      return [cx + x1 * R, cy - y2 * R, z2];
    };
    for (const p of pts) {
      const [x, y, z] = proj(p);
      if (z < 0) continue;
      ctx.fillStyle = `rgba(200,215,225,${0.15 + z * 0.55})`;
      ctx.fillRect(x, y, 1.6 * dpr, 1.6 * dpr);
    }
    for (const p of hot) {
      const [x, y, z] = proj(p);
      if (z < 0.05) continue;
      const pulse = still ? 1 : 1 + 0.5 * Math.sin(t / 400 + x);
      ctx.fillStyle = `rgba(255,140,90,${0.25 * z})`; ctx.beginPath(); ctx.arc(x, y, 7 * dpr * pulse, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffb08c'; ctx.beginPath(); ctx.arc(x, y, 2.4 * dpr, 0, 7); ctx.fill();
    }
    if (!still) requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}).catch(() => {});
