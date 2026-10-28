// Retakes the README hero shots (screenshot-lazy, -pro, -globe) at 1600x960 @2x, dark theme.
// Lazy and Pro: Overture places, roads and buildings for central Lae on Esri World Imagery, Roads selected.
// Globe: Pro on an empty project. Usage: node scripts/shots-hero.mjs <base> <lazy|pro> <out.png> [globe]
import { chromium } from 'playwright';
const [,, base, mode, out, kind] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
await p.goto(`${base}/?mode=${mode}&theme=dark${kind==='globe'?'&basemap=esri-imagery':'&basemap=esri-imagery&view=14.4/-6.7265/147.0'}`); await p.waitForTimeout(4000);
if (kind !== 'globe') {
  await p.evaluate(() => { const els=[...document.querySelectorAll('#contents .layer .name, #contents .lc-title')]; (els.find(e=>/roads/i.test(e.textContent))||els[0])?.click(); });
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(3000);
{ await p.evaluate(()=>{const f=document.querySelector('#dock-bottom .dock-fold'); if(f && !document.querySelector('#dock-bottom.collapsed')) f.click();}); await p.waitForTimeout(800); }
await p.waitForTimeout(8000); await p.screenshot({ path: out }); await b.close();
