// A field sheet as a PDF, made on the phone with no library: a sketch of the records (no basemap, so it
// prints clearly and needs no map tiles), a numbered table with positions, accuracy, heights, measures and
// form answers, and the photos. The writer is the smallest PDF 1.4 that readers accept: Helvetica in
// WinAnsi encoding, lines and JPEG images.
import type { Rec } from './db';

// ------------------------------------------------------------------ text
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WIN: Record<string, number> = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '…': 0x85, '€': 0x80, '·': 0xb7, '°': 0xb0, '±': 0xb1, '²': 0xb2, '³': 0xb3, 'µ': 0xb5, '×': 0xd7 };
/** Text as WinAnsi bytes (a latin1 string): accents kept where Latin-1 has them, dropped otherwise, other signs as '?'. */
export function winAnsi(s: string): string {
  let out = '';
  for (const ch of s.replace(/[➜→]/g, '>').replace(/[✓✔]/g, 'v')) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127) out += ch;
    else if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else if (c >= 0xa0 && c <= 0xff) out += ch;
    else if (c === 10 || c === 9) out += ' ';
    else {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += base && base.codePointAt(0)! < 0x100 ? base : '?';
    }
  }
  return out;
}
/** Width of text in points (Helvetica; bold is a little wider). */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of winAnsi(s)) { const c = ch.charCodeAt(0); w += c >= 32 && c < 127 ? W[c - 32] : 556; }
  return (w * size * (bold ? 1.06 : 1)) / 1000;
}
/** Text broken into lines no wider than max points (long words are cut). */
export function wrap(s: string, size: number, max: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (textWidth(word, size, bold) > max) {
        let n = word.length - 1;
        while (n > 1 && textWidth(word.slice(0, n), size, bold) > max) n--;
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      const t = line ? `${line} ${word}` : word;
      if (textWidth(t, size, bold) <= max) line = t;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}
const esc = (s: string) => winAnsi(s).replace(/[\\()]/g, (c) => `\\${c}`);
const n2 = (x: number) => (Math.round(x * 100) / 100).toString();

// ------------------------------------------------------------------ JPEG
/** Width, height and colour channels of a JPEG, or null when it is not one. */
export function jpegInfo(b: Uint8Array): { w: number; h: number; c: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], c: b[i + 9] };
    i += 2 + len;
  }
  return null;
}

// ------------------------------------------------------------------ the writer
export class Pdf {
  readonly w = 595.28;
  readonly h = 841.89;
  pages: { ops: string[]; images: Set<number> }[] = [];
  images: { data: Uint8Array; w: number; h: number; c: number }[] = [];
  get page() { return this.pages[this.pages.length - 1]; }
  addPage() { this.pages.push({ ops: [], images: new Set() }); return this; }
  /** y measured from the top of the page */
  text(x: number, y: number, s: string, size = 10, bold = false, grey = 0) {
    this.page.ops.push(`BT ${grey} g /F${bold ? 2 : 1} ${size} Tf ${n2(x)} ${n2(this.h - y)} Td (${esc(s)}) Tj ET`);
  }
  line(pts: [number, number][], width = 1, rgb: [number, number, number] = [0, 0, 0], close = false, fill: [number, number, number] | null = null, dash = false) {
    if (pts.length < 2) return;
    const p = pts.map(([x, y], i) => `${n2(x)} ${n2(this.h - y)} ${i ? 'l' : 'm'}`).join(' ');
    const f = fill ? `${fill.map(n2).join(' ')} rg ` : '';
    this.page.ops.push(`q ${dash ? '[3 2] 0 d ' : ''}${width} w ${rgb.map(n2).join(' ')} RG ${f}${p} ${close ? 'h ' : ''}${fill ? 'B' : 'S'} Q`);
  }
  rect(x: number, y: number, w: number, h: number, width = 0.5, rgb: [number, number, number] = [0, 0, 0], fill: [number, number, number] | null = null) {
    this.line([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], width, rgb, true, fill);
  }
  circle(x: number, y: number, r: number, rgb: [number, number, number], fill: [number, number, number] | null = null) {
    const k = 0.5523 * r, Y = this.h - y;
    const f = fill ? `${fill.map(n2).join(' ')} rg ` : '';
    this.page.ops.push(`q 1 w ${rgb.map(n2).join(' ')} RG ${f}${n2(x + r)} ${n2(Y)} m ${n2(x + r)} ${n2(Y + k)} ${n2(x + k)} ${n2(Y + r)} ${n2(x)} ${n2(Y + r)} c ${n2(x - k)} ${n2(Y + r)} ${n2(x - r)} ${n2(Y + k)} ${n2(x - r)} ${n2(Y)} c ${n2(x - r)} ${n2(Y - k)} ${n2(x - k)} ${n2(Y - r)} ${n2(x)} ${n2(Y - r)} c ${n2(x + k)} ${n2(Y - r)} ${n2(x + r)} ${n2(Y - k)} ${n2(x + r)} ${n2(Y)} c ${fill ? 'B' : 'S'} Q`);
  }
  /** Adds a JPEG once; returns its number for image(), or -1 when it is not a JPEG. */
  addJpeg(data: Uint8Array): number {
    const i = jpegInfo(data);
    if (!i || (i.c !== 1 && i.c !== 3)) return -1;
    this.images.push({ data, ...i });
    return this.images.length - 1;
  }
  image(n: number, x: number, y: number, w: number, h: number) {
    this.page.images.add(n);
    this.page.ops.push(`q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(this.h - y - h)} cm /Im${n} Do Q`);
  }
  /** The finished file. */
  bytes(title = 'GeoSpaX Field sheet'): Uint8Array {
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let size = 0;
    const put = (s: string | Uint8Array) => { const b = typeof s === 'string' ? latin1(s) : s; chunks.push(b); size += b.length; };
    const obj = (n: number, body: string | (() => void)) => { offsets[n] = size; put(`${n} 0 obj\n`); if (typeof body === 'string') put(body); else body(); put('\nendobj\n'); };
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const img0 = 6, page0 = img0 + this.images.length;
    const kids = this.pages.map((_, i) => `${page0 + i * 2} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(5, `<< /Title (${esc(title)}) /Producer (GeoSpaX Field) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    this.images.forEach((im, i) => obj(img0 + i, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.c === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`);
      put(im.data);
      put('\nendstream');
    }));
    this.pages.forEach((p, i) => {
      const xo = [...p.images].map((n) => `/Im${n} ${img0 + n} 0 R`).join(' ');
      obj(page0 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo ? ` /XObject << ${xo} >>` : ''} >> /Contents ${page0 + i * 2 + 1} 0 R >>`);
      const content = p.ops.join('\n');
      obj(page0 + i * 2 + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });
    const count = page0 + this.pages.length * 2;
    const xref = size;
    put(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1, count).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
    put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}
const latin1 = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

// ------------------------------------------------------------------ the field sheet
export interface SheetOptions {
  title: string;
  /** a measure for a record ("1.2 ha · 480 m"), from the app */
  measure(r: Rec): string;
  /** a form answers summary for a record */
  answers(r: Rec): string;
  /** JPEG bytes for a photo (null to leave it out) */
  photo(r: Rec, i: number): Promise<Uint8Array | null>;
  /** when it was made, for the header */
  now?: number;
  /** photos are left out when false */
  photos?: boolean;
}
const KIND: Record<Rec['kind'], string> = { point: 'Point', line: 'Line', area: 'Area', track: 'Track' };
const COL: Record<Rec['kind'], [number, number, number]> = { point: [0.85, 0.3, 0.1], line: [0.1, 0.45, 0.85], area: [0.15, 0.6, 0.25], track: [0.45, 0.45, 0.5] };
const fmtDate = (t: number) => { const d = new Date(t); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** Fits lon/lat into a box (equirectangular at the mid-latitude, the same scale both ways). */
export function fitBox(recs: Rec[], x: number, y: number, w: number, h: number) {
  const pts = recs.flatMap((r) => r.coords.map((c) => [c[0], c[1]] as [number, number]));
  if (!pts.length) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lo, la] of pts) { minX = Math.min(minX, lo); maxX = Math.max(maxX, lo); minY = Math.min(minY, la); maxY = Math.max(maxY, la); }
  const k = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  const mW = Math.max((maxX - minX) * k * 111320, 20), mH = Math.max((maxY - minY) * 110574, 20);
  const s = Math.min((w - 30) / mW, (h - 30) / mH); // points per metre
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { s, at: ([lo, la]: [number, number]): [number, number] => [x + w / 2 + (lo - cx) * k * 111320 * s, y + h / 2 - (la - cy) * 110574 * s] };
}
/** A round scale bar length in metres for a scale (points per metre), about a fifth of the width. */
export function scaleBar(s: number, width: number): number {
  const want = width / 5 / s;
  const p = 10 ** Math.floor(Math.log10(want));
  return [5, 2, 1].map((m) => m * p).find((m) => m <= want) ?? p;
}

export async function fieldSheet(recs: Rec[], o: SheetOptions): Promise<Uint8Array> {
  const rs = [...recs].sort((a, b) => a.created - b.created);
  const pdf = new Pdf().addPage();
  const M = 40, R = pdf.w - M, now = o.now ?? Date.now();
  pdf.text(M, 52, o.title, 18, true);
  pdf.text(M, 70, `${rs.length} record${rs.length === 1 ? '' : 's'} · made ${fmtDate(now)} · WGS 84, heights above mean sea level (EGM2008)`, 9, false, 0.35);
  // the sketch
  const mapY = 84, mapH = 290, mapW = R - M;
  pdf.rect(M, mapY, mapW, mapH, 0.6, [0.6, 0.6, 0.6]);
  const f = fitBox(rs, M, mapY, mapW, mapH);
  if (f) {
    rs.forEach((r) => {
      const pts = r.coords.map((c) => f.at([c[0], c[1]]));
      if (r.kind === 'area') pdf.line(pts, 1.2, COL.area, true, [0.85, 0.95, 0.87]);
      else if (r.kind !== 'point') pdf.line(pts, r.kind === 'track' ? 0.8 : 1.4, COL[r.kind], false, null, r.kind === 'track');
    });
    // number labels, skipping any that would overlap one already placed (the table still lists them)
    const placed: [number, number, number][] = [];
    rs.forEach((r, i) => {
      const [x, y] = f.at(r.kind === 'area' ? centroid(r) : [r.coords[0][0], r.coords[0][1]]);
      if (r.kind === 'point') pdf.circle(x, y, 2.6, [1, 1, 1], COL.point);
      const lw = textWidth(String(i + 1), 8, true);
      if (placed.some(([px, py, pw]) => x + 4 < px + pw + 2 && px < x + 4 + lw + 2 && Math.abs(py - y) < 9)) return;
      placed.push([x + 4, y, lw]);
      pdf.text(x + 4, y - 3, String(i + 1), 8, true, 0.1);
    });
    const bar = scaleBar(f.s, mapW);
    const by = mapY + mapH - 12;
    pdf.line([[M + 10, by], [M + 10 + bar * f.s, by]], 2);
    pdf.text(M + 14 + bar * f.s, by + 3, bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 8);
    pdf.line([[R - 16, mapY + 30], [R - 16, mapY + 12]], 1.2);
    pdf.line([[R - 20, mapY + 18], [R - 16, mapY + 12], [R - 12, mapY + 18]], 1.2);
    pdf.text(R - 19.5, mapY + 41, 'N', 9, true);
  } else pdf.text(M + 12, mapY + 24, 'Nothing recorded yet.', 10, false, 0.4);
  // the table
  const cols: [string, number][] = [['#', 18], ['Kind', 40], ['Note and answers', 150], ['Latitude, longitude', 104], ['Acc.', 34], ['Height', 44], ['Measure', 52], ['Taken', 73]];
  let y = mapY + mapH + 24;
  const head = () => {
    let x = M;
    pdf.rect(M, y - 10, R - M, 14, 0, [0.9, 0.9, 0.9], [0.92, 0.92, 0.92]);
    for (const [t, w] of cols) { pdf.text(x + 2, y, t, 8, true); x += w; }
    y += 14;
  };
  const newPage = () => { pdf.addPage(); y = 52; };
  head();
  for (const [i, r] of rs.entries()) {
    const c = r.kind === 'area' ? centroid(r) : [r.coords[0]?.[0], r.coords[0]?.[1]];
    const acc = r.coords[0]?.[4];
    const note = [r.note.trim(), o.answers(r)].filter(Boolean).join(' · ') || '-';
    const cells = [String(i + 1), KIND[r.kind], note, c[0] != null ? `${c[1].toFixed(6)}, ${c[0].toFixed(6)}${r.kind === 'area' ? ' (centre)' : ''}` : '-', acc != null ? (acc < 1 ? `±${Math.round(acc * 100)} cm` : `±${acc < 10 ? acc.toFixed(1) : Math.round(acc)} m`) : '-', r.height ? `${r.height.value.toFixed(1)} m` : '-', o.measure(r) || '-', fmtDate(r.created)];
    const wrapped = cells.map((t, k) => wrap(t, 8, cols[k][1] - 4));
    const lines = Math.max(...wrapped.map((w) => w.length));
    if (y + lines * 10 > pdf.h - 50) { newPage(); head(); }
    let x = M;
    wrapped.forEach((ls, k) => { ls.forEach((l, j) => pdf.text(x + 2, y + j * 10, l, 8, k === 0)); x += cols[k][1]; });
    y += lines * 10 + 4;
    pdf.line([[M, y - 9], [R, y - 9]], 0.3, [0.8, 0.8, 0.8]);
  }
  // the photos, three to a row
  if (o.photos !== false) {
    const list: { r: number; name: string; img: number; w: number; h: number; cap: string }[] = [];
    for (const [i, r] of rs.entries()) {
      for (const [k, p] of r.photos.entries()) {
        const b = await o.photo(r, k).catch(() => null);
        const n = b ? pdf.addJpeg(b) : -1;
        if (n < 0) continue;
        list.push({ r: i + 1, name: p.name, img: n, w: pdf.images[n].w, h: pdf.images[n].h, cap: `#${i + 1}${p.bearing != null ? ` facing ${Math.round(p.bearing)}°` : ''}` });
      }
    }
    if (list.length) {
      const cw = (R - M - 20) / 3, ch = cw * 0.75;
      y += 10;
      if (y + 20 + ch > pdf.h - 50) newPage();
      pdf.text(M, y, 'Photos', 11, true);
      y += 10;
      list.forEach((p, j) => {
        if (j % 3 === 0 && j) y += ch + 22;
        if (y + ch + 14 > pdf.h - 40) newPage();
        const x = M + (j % 3) * (cw + 10);
        const s = Math.min(cw / p.w, ch / p.h);
        pdf.image(p.img, x + (cw - p.w * s) / 2, y + (ch - p.h * s) / 2, p.w * s, p.h * s);
        pdf.text(x, y + ch + 10, p.cap, 8, false, 0.3);
      });
    }
  }
  pdf.pages.forEach((p, i) => {
    p.ops.push(`BT 0.5 g /F1 8 Tf ${M} 24 Td (${esc(`GeoSpaX Field · page ${i + 1} of ${pdf.pages.length}`)}) Tj ET`);
  });
  return pdf.bytes(o.title);
}
function centroid(r: Rec): [number, number] {
  const n = r.coords.length || 1;
  return [r.coords.reduce((s, c) => s + c[0], 0) / n, r.coords.reduce((s, c) => s + c[1], 0) / n];
}
