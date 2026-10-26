// Turns docs/*.md into pages of the home page (site/docs/<page>.html) so the user guide, FAQ and the rest
// read on geospax.in4metrix.dev instead of GitHub. Run after changing a doc and commit the output:
//   npm i --prefix /tmp/md marked@12 && NODE_PATH=/tmp/md/node_modules node scripts/build-site-docs.cjs
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');

const root = path.join(__dirname, '..');
const out = path.join(root, 'site', 'docs');

// page slug, source file, title in the sidebar
const PAGES = [
  ['guide', 'USER_GUIDE.md', 'User guide'],
  ['faq', 'FAQ.md', 'FAQ'],
  ['features', 'FEATURE_MATRIX.md', 'Features'],
  ['plugins', 'PLUGINS.md', 'Domain plugins'],
  ['automation', 'AUTOMATION.md', 'Automation and recipes'],
  ['devices', 'DEVICES.md', 'Devices and sensors'],
  ['r', 'R.md', 'R and Python'],
  ['ai', 'AI.md', 'AI assistant'],
  ['gsx', 'GSX.md', 'GSX tools'],
  ['deploy', 'DEPLOY.md', 'Web edition and servers'],
  ['development', 'DEVELOPMENT.md', 'Development'],
];
const bySource = Object.fromEntries(PAGES.map(([slug, file]) => [file, slug]));

// GitHub-style heading anchors, so links inside the docs keep working
const slugify = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');

const images = new Set();
const fixLink = (href) => {
  if (!href || /^(https?:|mailto:|#)/.test(href)) return href;
  const [file, hash] = href.split('#');
  const base = path.basename(file);
  if (bySource[base]) return `/docs/${bySource[base]}${hash ? `#${hash}` : ''}`;
  if (/^(\.\.\/)?(docs\/)?assets\//.test(file)) { images.add(base); return `/docs/assets/${base}`; }
  return `https://github.com/jmozez/geospax/blob/main/${file.replace(/^\.\.\//, '')}${hash ? `#${hash}` : ''}`;
};

const nav = (current) => PAGES.map(([slug, , title]) =>
  `<a href="/docs/${slug}"${slug === current ? ' aria-current="page"' : ''}>${title}</a>`).join('');

const page = (slug, title, body, toc) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · GeoSpaX</title>
  <meta name="description" content="GeoSpaX ${title.toLowerCase()}: the open-source GIS where maps make themselves." />
  <meta name="theme-color" content="#07090c" />
  <link rel="icon" type="image/png" href="/img/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/style.css" />
  <link rel="stylesheet" href="/docs.css" />
</head>
<body class="docs">
  <header class="nav">
    <div class="wrap nav-in">
      <a class="brand" href="/"><img src="/img/geospax-logo.png" alt="" width="28" height="28" /> GeoSpaX <span class="crumb">Docs</span></a>
      <nav aria-label="Sections"><a href="/#platform">Platform</a><a href="/#plugins">Plugins</a><a href="/docs/guide">Docs</a></nav>
      <div class="nav-cta"><a class="btn small primary" href="/#download">Download</a></div>
    </div>
  </header>
  <div class="wrap doc-layout">
    <aside class="doc-nav"><p class="kicker">Documentation</p>${nav(slug)}</aside>
    <article class="prose">${body}</article>
    <aside class="doc-toc"><p class="kicker">On this page</p>${toc}</aside>
  </div>
  <footer><div class="wrap legal mono">© <a href="https://www.in4metrix.dev" rel="noopener">in4metrix</a> · GeoSpaX is MIT-licensed · <a href="https://github.com/jmozez/geospax/blob/main/docs/${PAGES.find((p) => p[0] === slug)[1]}" rel="noopener">Edit this page</a></div></footer>
</body>
</html>
`;

fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
for (const [slug, file, title] of PAGES) {
  const headings = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(text, level) {
        const id = slugify(text);
        if (level === 2) headings.push([id, text.replace(/<[^>]+>/g, '')]);
        return `<h${level} id="${id}"><a class="anchor" href="#${id}">#</a>${text}</h${level}>\n`;
      },
      link(href, title, text) {
        const h = fixLink(href);
        const ext = /^https?:/.test(h) ? ' rel="noopener" target="_blank"' : '';
        return `<a href="${h}"${title ? ` title="${title}"` : ''}${ext}>${text}</a>`;
      },
      image(href, title, text) {
        return `<img src="${fixLink(href)}" alt="${text}" loading="lazy" />`;
      },
      table(header, body) {
        return `<div class="table"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
      },
    },
  });
  const body = marked.parse(fs.readFileSync(path.join(root, 'docs', file), 'utf8'));
  const toc = headings.map(([id, t]) => `<a href="#${id}">${t}</a>`).join('');
  fs.writeFileSync(path.join(out, `${slug}.html`), page(slug, title, body, toc));
}
for (const img of images) {
  const src = path.join(root, 'docs', 'assets', img);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, 'assets', img));
}
console.log(`${PAGES.length} pages, ${images.size} images → site/docs`);
