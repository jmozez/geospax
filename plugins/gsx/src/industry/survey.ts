// Surveying and cartography: datum transformation, traverse adjustment (Bowditch), bearings and
// distances, a survey plan sheet with a title block, and map grids (graticules) for layouts.
import type { Feature, Position } from 'geojson';
import type { Tool } from '../tools';
import { converter, crsDef, isGeographic, utmFor } from './crs';
import { coordsOf, esc, fieldP, fix, layerP, linesOf, localMetric, need, num, numP, pointFeature, lineFeature, polygonsOf, ringsArea, str, textP, choiceP } from './common';

const GROUP = 'Surveying and cartography';

// ---------------------------------------------------------------- bearings

/** "45°30'20"", "45 30 20", "45-30-20", "N45°30'E", "45.3020" (DDD.MMSS) or decimal degrees */
export function parseBearing(text: string, format: 'dms' | 'decimal' = 'dms'): number {
  const t = text.trim().toUpperCase().replace(/[″"]/g, ' ').replace(/[′']/g, ' ').replace(/[°º]/g, ' ');
  const q = /^([NS])\s*([\d.\s-]+?)\s*([EW])$/.exec(t);
  const body = q ? q[2] : t;
  const parts = body.split(/[\s-]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) throw new Error(`'${text}' is not a bearing`);
  let deg: number;
  if (parts.length > 1) deg = parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600;
  else if (format === 'dms') {
    const v = parts[0];
    const d = Math.trunc(v);
    const mmss = Math.round((v - d) * 10000);
    const mm = Math.floor(mmss / 100), ss = mmss % 100;
    if (mm >= 60 || ss >= 60) throw new Error(`'${text}' is not DDD.MMSS (minutes and seconds must be under 60)`);
    deg = d + mm / 60 + ss / 3600;
  } else deg = parts[0];
  if (q) {
    if (deg > 90) throw new Error(`'${text}': a quadrant bearing is at most 90°`);
    const [ns, ew] = [q[1], q[3]];
    deg = ns === 'N' ? (ew === 'E' ? deg : 360 - deg) : ew === 'E' ? 180 - deg : 180 + deg;
  }
  if (deg < 0 || deg >= 360) throw new Error(`'${text}': a whole-circle bearing is from 0 to under 360°`);
  return deg;
}
/** 45.5056 → 45°30'20" */
export function dms(deg: number, secDp = 0): string {
  let d = ((deg % 360) + 360) % 360;
  let total = Math.round(d * 3600 * 10 ** secDp) / 10 ** secDp;
  if (total >= 360 * 3600) total -= 360 * 3600;
  d = Math.floor(total / 3600);
  const m = Math.floor((total - d * 3600) / 60);
  const s = total - d * 3600 - m * 60;
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(secDp).padStart(secDp ? 3 + secDp : 2, '0')}"`;
}
export const bearingOf = (a: Position, b: Position) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;

// ---------------------------------------------------------------- traverse

export interface Leg { bearing: number; distance: number }
export function parseLegs(text: string, format: 'dms' | 'decimal'): Leg[] {
  const rows = text.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (!rows.length) throw new Error('Give the legs, one per line or separated by ;, as: bearing distance (for example 45.3020 120.55)');
  return rows.map((r) => {
    const m = /^(.*?)[\s,]+([\d.]+)\s*m?$/i.exec(r);
    if (!m) throw new Error(`'${r}': write a leg as bearing then distance`);
    const distance = Number(m[2]);
    if (!(distance > 0)) throw new Error(`'${r}': the distance must be greater than zero`);
    return { bearing: parseBearing(m[1], format), distance };
  });
}
/** Compass (Bowditch) rule: the misclosure is shared out in proportion to each leg's length. */
export function bowditch(start: [number, number], legs: Leg[], close: [number, number]) {
  const raw: [number, number][] = [start];
  for (const l of legs) {
    const r = (l.bearing * Math.PI) / 180;
    const p = raw[raw.length - 1];
    raw.push([p[0] + l.distance * Math.sin(r), p[1] + l.distance * Math.cos(r)]);
  }
  const end = raw[raw.length - 1];
  const dE = end[0] - close[0], dN = end[1] - close[1];
  const perimeter = legs.reduce((a, l) => a + l.distance, 0);
  const mis = Math.hypot(dE, dN);
  let run = 0;
  const adjusted: [number, number][] = [start];
  const corrections: [number, number][] = [[0, 0]];
  legs.forEach((l, i) => {
    run += l.distance;
    const f = run / perimeter;
    corrections.push([-dE * f, -dN * f]);
    adjusted.push([raw[i + 1][0] - dE * f, raw[i + 1][1] - dN * f]);
  });
  return { raw, adjusted, corrections, dE, dN, misclosure: mis, perimeter, ratio: mis > 0 ? perimeter / mis : Infinity, misBearing: bearingOf([0, 0], [dE, dN]) };
}

// ---------------------------------------------------------------- the survey plan sheet

const SCALES = [100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
interface PlanInput {
  lots: { label: string; rings: [number, number][][]; areaM2: number }[];
  title: string; planNo: string; surveyor: string; firm: string; location: string; date: string; datum: string; sheet: string;
}
/** An A3 landscape plan (mm): drawing frame, lot boundaries with bearings and distances, north
 *  arrow, scale bar, vertex schedule and a title block with the surveyor's certificate. */
export function planSvg(o: PlanInput) {
  const W = 420, H = 297, M = 10, TB = 95;
  const fx0 = M, fy0 = M, fw = W - 2 * M - TB - 4, fh = H - 2 * M;
  const all = o.lots.flatMap((l) => l.rings.flat());
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const [minx, maxx, miny, maxy] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const need = Math.max((maxx - minx) / ((fw - 30) / 1000), (maxy - miny) / ((fh - 50) / 1000), 1);
  const scale = SCALES.find((s) => s >= need) ?? Math.ceil(need / 100000) * 100000;
  const k = 1000 / scale; // mm per metre
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const X = (x: number) => fx0 + fw / 2 + (x - cx) * k, Y = (y: number) => fy0 + (fh - 30) / 2 + 5 - (y - cy) * k;
  const out: string[] = [];
  const schedule: string[][] = [];
  let pt = 0;
  for (const lot of o.lots) {
    for (const ring of lot.rings) {
      const r = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
      out.push(`<polygon points="${r.map((p) => `${X(p[0]).toFixed(2)},${Y(p[1]).toFixed(2)}`).join(' ')}" fill="none" stroke="#000" stroke-width="0.5"/>`);
      r.forEach((a, i) => {
        const b = r[(i + 1) % r.length];
        const brg = bearingOf(a, b), d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const mx = (X(a[0]) + X(b[0])) / 2, my = (Y(a[1]) + Y(b[1])) / 2;
        let ang = (Math.atan2(Y(b[1]) - Y(a[1]), X(b[0]) - X(a[0])) * 180) / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        out.push(`<text x="${mx.toFixed(2)}" y="${my.toFixed(2)}" transform="rotate(${ang.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)})" font-size="2.4" text-anchor="middle" dy="-1">${dms(brg)}  ${d.toFixed(2)}</text>`);
        pt++;
        out.push(`<circle cx="${X(a[0]).toFixed(2)}" cy="${Y(a[1]).toFixed(2)}" r="0.8" fill="#000"/><text x="${(X(a[0]) + 1.5).toFixed(2)}" y="${(Y(a[1]) + 3).toFixed(2)}" font-size="2.2">${pt}</text>`);
        schedule.push([String(pt), a[0].toFixed(3), a[1].toFixed(3)]);
      });
    }
    const c = lot.rings[0];
    const lx = c.reduce((s, p) => s + p[0], 0) / c.length, ly = c.reduce((s, p) => s + p[1], 0) / c.length;
    out.push(`<text x="${X(lx).toFixed(2)}" y="${Y(ly).toFixed(2)}" font-size="4" font-weight="bold" text-anchor="middle">${esc(lot.label)}</text><text x="${X(lx).toFixed(2)}" y="${(Y(ly) + 5).toFixed(2)}" font-size="3" text-anchor="middle">${lot.areaM2 >= 10000 ? `${(lot.areaM2 / 10000).toFixed(4)} ha` : `${lot.areaM2.toFixed(1)} m²`}</text>`);
  }
  // north arrow (grid north) and scale bar
  const na = `<g transform="translate(${fx0 + fw - 14} ${fy0 + 18})"><polygon points="0,-12 4,4 0,1 -4,4" fill="#000"/><text y="-14" font-size="4" text-anchor="middle" font-weight="bold">N</text><text y="9" font-size="2.2" text-anchor="middle">grid north</text></g>`;
  const nice = [1, 2, 2.5, 5].flatMap((m) => [1, 10, 100, 1000, 10000].map((p) => m * p)).sort((a, b) => a - b);
  const barM = nice.filter((v) => v * k <= 60).pop() ?? 1;
  const bx = fx0 + 8, by = fy0 + fh - 12, seg = (barM * k) / 4;
  const bar = [0, 1, 2, 3].map((i) => `<rect x="${(bx + i * seg).toFixed(2)}" y="${by}" width="${seg.toFixed(2)}" height="2" fill="${i % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="0.3"/>`).join('') +
    `<text x="${bx}" y="${by - 1.5}" font-size="2.4">0</text><text x="${(bx + 4 * seg).toFixed(2)}" y="${by - 1.5}" font-size="2.4" text-anchor="middle">${barM} m</text><text x="${bx}" y="${by + 6}" font-size="2.6">Scale 1:${scale.toLocaleString('en-NZ')} (A3)</text>`;
  // title block
  const tx = W - M - TB;
  const rows: [string, string][] = [['Plan', o.planNo], ['Title', o.title], ['Location', o.location], ['Surveyor', o.surveyor], ['Firm', o.firm], ['Date', o.date], ['Scale', `1:${scale.toLocaleString('en-NZ')} at A3`], ['Datum and projection', o.datum], ['Sheet', o.sheet]];
  let ty = M;
  const tb: string[] = [`<rect x="${tx}" y="${M}" width="${TB}" height="${H - 2 * M}" fill="none" stroke="#000" stroke-width="0.5"/>`];
  for (const [k2, v] of rows) {
    tb.push(`<line x1="${tx}" x2="${tx + TB}" y1="${ty + 12}" y2="${ty + 12}" stroke="#000" stroke-width="0.25"/><text x="${tx + 2}" y="${ty + 4}" font-size="2.2" fill="#444">${esc(k2.toUpperCase())}</text><text x="${tx + 2}" y="${ty + 9.5}" font-size="3.4">${esc(v.length > 46 ? `${v.slice(0, 45)}…` : v)}</text>`);
    ty += 12;
  }
  tb.push(`<text x="${tx + 2}" y="${ty + 5}" font-size="2.4" font-weight="bold">COORDINATE SCHEDULE</text><text x="${tx + 2}" y="${ty + 9}" font-size="2.2">Pt</text><text x="${tx + 14}" y="${ty + 9}" font-size="2.2">Easting</text><text x="${tx + 52}" y="${ty + 9}" font-size="2.2">Northing</text>`);
  const room = Math.floor((H - M - 40 - (ty + 10)) / 3.2);
  schedule.slice(0, room).forEach(([p, e, n], i) => tb.push(`<text x="${tx + 2}" y="${ty + 12.5 + i * 3.2}" font-size="2.2">${p}</text><text x="${tx + 14}" y="${ty + 12.5 + i * 3.2}" font-size="2.2">${e}</text><text x="${tx + 52}" y="${ty + 12.5 + i * 3.2}" font-size="2.2">${n}</text>`));
  if (schedule.length > room) tb.push(`<text x="${tx + 2}" y="${ty + 12.5 + room * 3.2}" font-size="2.2">… ${schedule.length - room} more in the table</text>`);
  const cy0 = H - M - 38;
  tb.push(`<line x1="${tx}" x2="${tx + TB}" y1="${cy0}" y2="${cy0}" stroke="#000" stroke-width="0.25"/><text x="${tx + 2}" y="${cy0 + 5}" font-size="2.4" font-weight="bold">SURVEYOR'S CERTIFICATE</text>`,
    `<text x="${tx + 2}" y="${cy0 + 10}" font-size="2.2">I certify that this plan is accurate and that the survey</text><text x="${tx + 2}" y="${cy0 + 13.5}" font-size="2.2">was made by me or under my direction.</text>`,
    `<line x1="${tx + 2}" x2="${tx + 60}" y1="${cy0 + 26}" y2="${cy0 + 26}" stroke="#000" stroke-width="0.25"/><text x="${tx + 2}" y="${cy0 + 29.5}" font-size="2.2">Signature, registered surveyor</text><text x="${tx + 66}" y="${cy0 + 29.5}" font-size="2.2">Date</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" font-family="Arial, Helvetica, sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/><rect x="${fx0}" y="${fy0}" width="${fw}" height="${fh}" fill="none" stroke="#000" stroke-width="0.7"/>
${out.join('\n')}
${na}${bar}
${tb.join('\n')}
</svg>`;
  return { svg, scale, points: schedule.length };
}

// ---------------------------------------------------------------- tools

const crsP = (name: string, label: string, dflt: string, description?: string) => textP(name, label, dflt, description ?? 'EPSG code (for example EPSG:32755, EPSG:5551 PNGMG94 zone 55, EPSG:20255 AMG66 zone 55) or a PROJ string.');

export const SURVEY_TOOLS: Tool[] = [
  {
    id: 'datum-transform',
    name: 'Datum and projection transformation',
    summary: 'Transform coordinates between datums and projections (WGS 84, UTM, PNG94/PNGMG94, AGD66/AMG66, GDA94/GDA2020, MGA, NZTM or any PROJ string), from a layer, its coordinate fields or typed coordinates.',
    group: GROUP,
    icon: 'earth',
    params: [
      layerP('layer', 'Points or features', false, 'Leave empty to transform typed coordinates instead.'),
      fieldP('x_field', 'Easting or longitude field', false, 'When the coordinates are in the attribute table (for example from a CSV) rather than the map position.'),
      fieldP('y_field', 'Northing or latitude field', false),
      textP('coordinates', 'Typed coordinates', '', 'One "x y" pair per line (easting northing, or longitude latitude), used when no layer is chosen.'),
      crsP('source_crs', 'From', 'EPSG:4326', 'The system the coordinates are in. For a layer without coordinate fields this is EPSG:4326, its map position.'),
      crsP('target_crs', 'To', 'auto', '"auto" chooses the WGS 84 UTM zone of the data.'),
    ],
    run(ctx) {
      const layer = ctx.layer('layer');
      const xf = str(ctx, 'x_field'), yf = str(ctx, 'y_field');
      const source = layer?.length && !(xf && yf) ? 'EPSG:4326' : str(ctx, 'source_crs', 'EPSG:4326');
      let target = str(ctx, 'target_crs', 'auto');
      const input: { xy: [number, number]; props: Record<string, unknown> }[] = [];
      if (layer?.length) {
        for (const f of layer) {
          if (xf && yf) {
            const x = Number(f.properties?.[xf]), y = Number(f.properties?.[yf]);
            if (Number.isFinite(x) && Number.isFinite(y)) input.push({ xy: [x, y], props: { ...(f.properties ?? {}) } });
          } else {
            const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : coordsOf(f.geometry)[0];
            if (c) input.push({ xy: [c[0], c[1]], props: { ...(f.properties ?? {}) } });
          }
        }
      } else {
        const lines = str(ctx, 'coordinates').split(/\n|;/).map((s) => s.trim()).filter(Boolean);
        lines.forEach((l, i) => {
          const [x, y] = l.split(/[\s,]+/).map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`'${l}' is not an "x y" pair`);
          input.push({ xy: [x, y], props: { id: i + 1 } });
        });
      }
      if (!input.length) throw new Error('Choose a layer (and its coordinate fields) or type coordinates');
      const toLL = converter(source, 'EPSG:4326');
      const ll = input.map((p) => toLL.forward(p.xy));
      if (target === 'auto') target = utmFor(ll[0][0], ll[0][1]);
      const c = converter(source, target);
      const geo = isGeographic(c.to.def);
      const dp = geo ? 8 : 3;
      const features: Feature[] = input.map((p, i) => {
        const t = c.forward(p.xy);
        const back = c.inverse(t);
        return pointFeature(ll[i], { ...p.props, x_from: p.xy[0], y_from: p.xy[1], x_to: Number(t[0].toFixed(dp)), y_to: Number(t[1].toFixed(dp)), crs_to: c.to.code, roundtrip_error: Number(Math.hypot(back[0] - p.xy[0], back[1] - p.xy[1]).toExponential(2)) });
      });
      const first = features[0].properties!;
      return {
        message: `Transformed ${features.length} point(s) from ${c.from.name} to ${c.to.name}`,
        layers: [{ name: `Transformed to ${c.to.code}`, features }],
        table: [['From', `${c.from.code} ${c.from.name}`], ['To', `${c.to.code} ${c.to.name}`], ['Points', features.length], ['First point (to)', `${first.x_to}, ${first.y_to}`]],
        notes: [`Datum shifts use seven-parameter (Helmert) or null transformations. AGD66 uses the national set (about 1 m); for cadastral work at centimetre level use the official grid files (NTv2) of your survey authority.`, `PROJ definition (to): ${c.to.def}`],
      };
    },
  },
  {
    id: 'traverse-adjust',
    name: 'Traverse adjustment (Bowditch, misclosure report)',
    summary: 'A traverse from a start point and its legs (bearing and distance): misclosure, precision ratio (1 in N), compass-rule (Bowditch) adjustment, adjusted coordinates and the enclosed area.',
    group: GROUP,
    icon: 'calc',
    params: [
      textP('legs', 'Legs (bearing distance)', '', 'One leg per line: whole-circle bearing then distance in metres, for example "45.3020 120.55" (DDD.MMSS), "45°30\'20\\" 120.55" or "N45°30\'E 120.55".'),
      numP('start_e', 'Start easting (m)', 500000),
      numP('start_n', 'Start northing (m)', 9000000),
      textP('close_e', 'Closing easting (blank = back to start)', ''),
      textP('close_n', 'Closing northing (blank = back to start)', ''),
      choiceP('bearing_format', 'Bearing format', ['dms', 'decimal'], 'dms: DDD.MMSS when a bearing is a single number; decimal: decimal degrees.'),
      crsP('crs', 'Coordinate system of the traverse', 'EPSG:32755', 'Used to place the traverse on the map.'),
      numP('min_ratio', 'Required precision (1 in N)', 10000, 'The traverse fails the check when its precision is worse than this (for example 1:10 000 for cadastral work).'),
    ],
    run(ctx) {
      const legs = parseLegs(str(ctx, 'legs'), str(ctx, 'bearing_format', 'dms') === 'decimal' ? 'decimal' : 'dms');
      const start: [number, number] = [num(ctx, 'start_e', 500000), num(ctx, 'start_n', 9000000)];
      const ce = str(ctx, 'close_e'), cn = str(ctx, 'close_n');
      const closed = !ce && !cn;
      const close: [number, number] = closed ? start : [Number(ce), Number(cn)];
      if (!Number.isFinite(close[0]) || !Number.isFinite(close[1])) throw new Error('The closing easting and northing must be numbers');
      const r = bowditch(start, legs, close);
      const minRatio = num(ctx, 'min_ratio', 10000);
      const conv = converter(str(ctx, 'crs', 'EPSG:32755'), 'EPSG:4326');
      const ll = r.adjusted.map((p) => conv.forward(p));
      const pts = r.adjusted.map((p, i) => pointFeature(ll[i], {
        station: i + 1, easting: Number(p[0].toFixed(3)), northing: Number(p[1].toFixed(3)),
        raw_easting: Number(r.raw[i][0].toFixed(3)), raw_northing: Number(r.raw[i][1].toFixed(3)),
        corr_e: Number(r.corrections[i][0].toFixed(4)), corr_n: Number(r.corrections[i][1].toFixed(4)),
      }));
      const legRows = legs.map((l, i) => {
        const a = r.adjusted[i], b = r.adjusted[i + 1];
        return { leg: i + 1, bearing_obs: dms(l.bearing), distance_obs: l.distance, bearing_adj: dms(bearingOf(a, b), 1), distance_adj: Number(Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(3)) };
      });
      const line = lineFeature(ll, { name: 'adjusted traverse', perimeter_m: Number(r.perimeter.toFixed(3)), misclosure_m: Number(r.misclosure.toFixed(4)), precision: r.misclosure > 0 ? `1:${Math.round(r.ratio)}` : 'exact' });
      const area = closed && legs.length >= 3 ? ringsArea([r.adjusted]) : null;
      const passes = r.ratio >= minRatio;
      const legFeatures = legRows.map((row, i) => lineFeature([ll[i], ll[i + 1]], row));
      return {
        message: `Misclosure ${r.misclosure.toFixed(3)} m over ${r.perimeter.toFixed(2)} m: precision ${r.misclosure > 0 ? `1:${Math.round(r.ratio).toLocaleString('en-NZ')}` : 'exact'} (${passes ? 'passes' : 'fails'} 1:${minRatio.toLocaleString('en-NZ')}); adjusted by the Bowditch rule`,
        layers: [{ name: 'Traverse stations (adjusted)', features: pts }, { name: 'Traverse legs (adjusted)', features: legFeatures }, { name: 'Traverse', features: [line] }],
        table: [
          ['Legs', legs.length], ['Perimeter (m)', fix(r.perimeter, 3)], ['Misclosure dE (m)', fix(r.dE, 4)], ['Misclosure dN (m)', fix(r.dN, 4)],
          ['Linear misclosure (m)', fix(r.misclosure, 4)], ['Misclosure bearing', dms(r.misBearing)], ['Precision', r.misclosure > 0 ? `1:${Math.round(r.ratio)}` : 'exact'],
          ['Check', passes ? `passes 1:${minRatio}` : `FAILS 1:${minRatio}`], ...(area != null ? [['Enclosed area', area >= 10000 ? `${(area / 10000).toFixed(4)} ha` : `${area.toFixed(2)} m²`] as [string, string]] : []),
          ...legRows.map((x) => [`Leg ${x.leg}`, `${x.bearing_obs} ${x.distance_obs} → ${x.bearing_adj} ${x.distance_adj}`] as [string, string]),
        ],
        notes: ['Bowditch (compass) rule: each correction is the misclosure times the distance run to that station over the perimeter. It assumes angles and distances are of similar precision; for a least-squares network use a dedicated adjustment package.', ...(passes ? [] : ['The precision is worse than required: check the field book for a blunder (a wrong bearing or a transposed distance) before adjusting.'])],
      };
    },
  },
  {
    id: 'bearing-distance',
    name: 'Bearings and distances (inverse)',
    summary: 'Grid bearing (DMS) and distance of every side of lines and polygons, and the area of each polygon, in a projected system: the figures for a survey plan or field book.',
    group: GROUP,
    icon: 'ruler',
    params: [layerP('layer', 'Lines or polygons'), crsP('crs', 'Grid (projected system)', 'auto', '"auto" uses the WGS 84 UTM zone of the data.')],
    run(ctx) {
      const fs = need(ctx, 'layer', 'lines or polygons');
      let crs = str(ctx, 'crs', 'auto');
      const c0 = coordsOf(fs[0].geometry)[0];
      if (!c0) throw new Error('The layer has no coordinates');
      if (crs === 'auto') crs = utmFor(c0[0], c0[1]);
      const conv = converter('EPSG:4326', crs);
      const sides: Feature[] = [];
      const table: [string, string | number][] = [];
      let total = 0;
      fs.forEach((f, fi) => {
        for (const ln of linesOf(f.geometry)) {
          const g = ln.map((p) => conv.forward(p));
          for (let i = 1; i < g.length; i++) {
            const d = Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]);
            if (d === 0) continue;
            total += d;
            const b = bearingOf(g[i - 1], g[i]);
            sides.push(lineFeature([ln[i - 1], ln[i]], { feature: fi + 1, side: sides.length + 1, bearing: dms(b), bearing_deg: Number(b.toFixed(6)), distance_m: Number(d.toFixed(3)) }));
          }
        }
        const polys = polygonsOf(f.geometry);
        if (polys.length) {
          const a = polys.reduce((s, rings) => s + ringsArea(rings.map((r) => r.map((p) => conv.forward(p)))), 0);
          table.push([`Feature ${fi + 1} area`, a >= 10000 ? `${(a / 10000).toFixed(4)} ha` : `${a.toFixed(2)} m²`]);
        }
      });
      if (!sides.length) throw new Error('The layer has no lines or polygon sides');
      return {
        message: `${sides.length} side(s), ${total.toFixed(2)} m in all, on ${conv.to.name}`,
        layers: [{ name: `${ctx.layerName('layer')} bearings and distances`, features: sides }],
        table: [['Grid', `${conv.to.code} ${conv.to.name}`], ['Sides', sides.length], ['Total length (m)', fix(total, 3)], ...table],
        notes: ['Bearings are grid bearings on the chosen projection, distances are grid distances (not reduced to the ellipsoid).'],
      };
    },
  },
  {
    id: 'survey-plan',
    name: 'Survey plan sheet (title block)',
    summary: 'An A3 survey plan of lot polygons: bearings and distances on every boundary, areas, numbered marks with a coordinate schedule, north arrow, scale bar and a title block with the surveyor\'s certificate.',
    group: GROUP,
    icon: 'print',
    params: [
      layerP('lots', 'Lot or parcel polygons'),
      fieldP('label_field', 'Lot label field', false),
      textP('title', 'Plan title', 'Survey plan'),
      textP('plan_no', 'Plan number', ''),
      textP('location', 'Location', ''),
      textP('surveyor', 'Surveyor', ''),
      textP('firm', 'Firm', 'in4metrix'),
      textP('date', 'Date (blank = today)', ''),
      crsP('crs', 'Grid (projected system)', 'auto'),
    ],
    run(ctx) {
      const fs = need(ctx, 'lots', 'lot polygons');
      let crs = str(ctx, 'crs', 'auto');
      const c0 = coordsOf(fs[0].geometry)[0];
      if (crs === 'auto') crs = utmFor(c0[0], c0[1]);
      const conv = converter('EPSG:4326', crs);
      const lf = str(ctx, 'label_field');
      const lots = fs.flatMap((f, i) => polygonsOf(f.geometry).map((rings) => {
        const g = rings.map((r) => r.map((p) => conv.forward(p)));
        return { label: lf ? String(f.properties?.[lf] ?? `Lot ${i + 1}`) : `Lot ${i + 1}`, rings: g, areaM2: ringsArea(g) };
      }));
      if (!lots.length) throw new Error('The layer has no polygons');
      const date = str(ctx, 'date') || new Date().toISOString().slice(0, 10);
      const p = planSvg({ lots, title: str(ctx, 'title', 'Survey plan'), planNo: str(ctx, 'plan_no', '-'), surveyor: str(ctx, 'surveyor', '-'), firm: str(ctx, 'firm', '-'), location: str(ctx, 'location', '-'), date, datum: `${conv.to.code} ${conv.to.name}`, sheet: '1 of 1' });
      return {
        message: `Survey plan of ${lots.length} lot(s) at 1:${p.scale.toLocaleString('en-NZ')} on A3, ${p.points} marks`,
        table: [['Scale', `1:${p.scale}`], ['Lots', lots.length], ['Marks', p.points], ['Grid', conv.to.name], ...lots.map((l) => [l.label, l.areaM2 >= 10000 ? `${(l.areaM2 / 10000).toFixed(4)} ha` : `${l.areaM2.toFixed(2)} m²`] as [string, string])],
        figures: [{ title: 'Survey plan (A3)', svg: p.svg }],
        notes: ['The plan follows a common cadastral layout. Check it against the plan requirements of your survey authority (for PNG, the Surveyor-General) before lodging.'],
      };
    },
  },
  {
    id: 'map-grid',
    name: 'Map grid and graticule (for layouts)',
    summary: 'Grid lines at a set interval over a layer\'s extent: a latitude and longitude graticule, or an easting and northing grid in any projected system, labelled for a map layout.',
    group: GROUP,
    icon: 'grid',
    params: [layerP('layer', 'Extent of'), crsP('crs', 'Grid system', 'EPSG:4326', 'EPSG:4326 for a graticule, a projected system (or "auto" for UTM) for a grid.'), numP('interval', 'Interval (degrees or metres)', 0, '0 chooses about eight lines across.')],
    run(ctx) {
      const fs = need(ctx, 'layer', 'a layer');
      const pts = fs.flatMap((f) => coordsOf(f.geometry));
      let crs = str(ctx, 'crs', 'EPSG:4326');
      if (crs === 'auto') crs = utmFor(pts[0][0], pts[0][1]);
      const conv = converter('EPSG:4326', crs);
      const g = pts.map((p) => conv.forward(p));
      const [x0, x1, y0, y1] = [Math.min(...g.map((p) => p[0])), Math.max(...g.map((p) => p[0])), Math.min(...g.map((p) => p[1])), Math.max(...g.map((p) => p[1]))];
      let step = num(ctx, 'interval', 0);
      if (!(step > 0)) {
        const raw = Math.max(x1 - x0, y1 - y0) / 8 || 1;
        const p = 10 ** Math.floor(Math.log10(raw));
        step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw)!;
      }
      const geo = isGeographic(conv.to.def);
      const label = (v: number, axis: 'x' | 'y') => geo ? `${Math.abs(v).toFixed(step < 1 ? 2 : 0)}°${axis === 'x' ? (v < 0 ? 'W' : 'E') : v < 0 ? 'S' : 'N'}` : `${Math.round(v)} m${axis === 'x' ? 'E' : 'N'}`;
      const lines: Feature[] = [];
      const n = 40;
      for (let x = Math.ceil(x0 / step) * step; x <= x1 + 1e-9; x += step) lines.push(lineFeature(Array.from({ length: n + 1 }, (_, i) => conv.inverse([x, y0 + ((y1 - y0) * i) / n])), { axis: 'x', value: Number(x.toFixed(6)), label: label(x, 'x') }));
      for (let y = Math.ceil(y0 / step) * step; y <= y1 + 1e-9; y += step) lines.push(lineFeature(Array.from({ length: n + 1 }, (_, i) => conv.inverse([x0 + ((x1 - x0) * i) / n, y])), { axis: 'y', value: Number(y.toFixed(6)), label: label(y, 'y') }));
      if (!lines.length) throw new Error('The interval is larger than the extent; choose a smaller one');
      return {
        message: `${lines.length} grid line(s) every ${step} ${geo ? '°' : 'm'} on ${conv.to.name}`,
        layers: [{ name: geo ? 'Graticule' : `Grid ${conv.to.code}`, features: lines }],
        table: [['System', `${conv.to.code} ${conv.to.name}`], ['Interval', `${step} ${geo ? 'degrees' : 'm'}`], ['Lines', lines.length]],
      };
    },
  },
];
