// Energy, utilities, oil and gas, and mining: corridor and clearance zones, LiDAR clearance,
// tower inventories, tenure (lease and tenement) checks, well sites, least-cost routes and
// cut and fill volumes between two DEMs.
import buffer from '@turf/buffer';
import difference from '@turf/difference';
import intersect from '@turf/intersect';
import union from '@turf/union';
import { featureCollection } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import type { Grid, Tool } from '../tools';
import {
  bool, cellCentre, cellMetres, cellOf, choiceP, dist, fieldP, fix, gridProj, haText, inRings, layerP, leastCostPath, lineDist, lineFeature, linesOf,
  localMetric, need, needRaster, num, numP, optNum, pointFeature, pointOf, polygonsOf, rasterP, ringsArea, sameGrid, slopeDegrees, str, textP, timeOf,
} from './common';

const ENERGY = 'Energy and utilities';
const TENURE = 'Tenure and leases';
const ROUTE = 'Route planning';
const VOLUME = 'Earthworks';

/** "name:metres, …" zones, sorted by width */
export function parseZones(text: string): { name: string; m: number }[] {
  const z = text.split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, m] = s.split(':').map((x) => x.trim());
    const v = Number(m ?? name);
    if (!(v > 0)) throw new Error(`'${s}': write a zone as name:metres (for example easement:20)`);
    return { name: m === undefined ? `${v} m` : name, m: v };
  });
  if (!z.length) throw new Error('Give at least one zone as name:metres');
  return z.sort((a, b) => a.m - b.m);
}

const areaHa = (f: Feature | null) => {
  if (!f) return 0;
  const m = localMetric([f]);
  return polygonsOf(f.geometry).reduce((s, rings) => s + ringsArea(rings.map((r) => r.map(m.fwd))), 0) / 10000;
};

/** cells of a grid whose centre lies inside any of the polygons (lon/lat) */
function maskInside(g: Grid, polys: Feature[] | null): Uint8Array | null {
  if (!polys?.length) return null;
  const pr = gridProj(g);
  const rings = polys.flatMap((f) => polygonsOf(f.geometry));
  const out = new Uint8Array(g.width * g.height);
  for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
    const ll = pr.toLL(cellCentre(g, c, r));
    if (rings.some((rg) => inRings(ll, rg))) out[r * g.width + c] = 1;
  }
  return out;
}

export const ENERGY_TOOLS: Tool[] = [
  {
    id: 'corridor-zones',
    name: 'Corridor and clearance zones (power lines, pipelines, roads)',
    summary: 'Nested zones either side of lines (easement, clearance, consultation …) as polygons with their areas, and every feature of a second layer that falls inside a zone (encroachments), with its distance.',
    group: ENERGY,
    icon: 'tBuffer',
    params: [
      layerP('lines', 'Lines (power lines, pipelines, roads)'),
      textP('zones', 'Zones (name:half-width in metres)', 'easement:20, clearance:40, consultation:100', 'Half-widths either side of the centre line, for example easement:20, clearance:40.'),
      layerP('features', 'Features to check (buildings, trees, wells …)', false),
    ],
    run(ctx) {
      const lines = need(ctx, 'lines', 'line features');
      const zones = parseZones(str(ctx, 'zones', 'easement:20, clearance:40, consultation:100'));
      const out: Feature[] = [];
      let inner: Feature<Polygon | MultiPolygon> | null = null;
      const table: [string, string | number][] = [];
      for (const z of zones) {
        const bufs = lines.map((l) => buffer(l, z.m, { units: 'meters' })).filter(Boolean) as Feature<Polygon | MultiPolygon>[];
        const all = (bufs.length > 1 ? union(featureCollection(bufs)) : bufs[0] ?? null) as Feature<Polygon | MultiPolygon> | null;
        if (!all) continue;
        const ring = inner ? difference(featureCollection([all, inner])) : all;
        const a = areaHa(ring as Feature);
        if (ring) out.push({ ...ring, properties: { zone: z.name, from_m: inner ? zones[zones.indexOf(z) - 1].m : 0, to_m: z.m, area_ha: Number(a.toFixed(4)) } });
        table.push([`${z.name} (to ${z.m} m)`, `${a.toFixed(2)} ha`]);
        inner = all;
      }
      const check = ctx.layer('features');
      const hits: Feature[] = [];
      if (check?.length) {
        const m = localMetric(lines);
        const ml = lines.flatMap((l) => linesOf(l.geometry)).map((ln) => ln.map(m.fwd));
        for (const f of check) {
          const p = pointOf(f);
          if (!p) continue;
          const d = lineDist(m.fwd(p), ml).d;
          const z = zones.find((zz) => d <= zz.m);
          if (z) hits.push({ ...f, properties: { ...(f.properties ?? {}), zone: z.name, distance_m: Number(d.toFixed(2)) } });
        }
        for (const z of zones) table.push([`Features in ${z.name}`, hits.filter((h) => h.properties!.zone === z.name).length]);
      }
      return {
        message: `${out.length} zone(s) around ${lines.length} line(s)${check ? `; ${hits.length} of ${check.length} feature(s) inside a zone` : ''}`,
        layers: [{ name: `${ctx.layerName('lines')} corridor zones`, features: out }, ...(hits.length ? [{ name: 'Encroachments', features: hits }] : [])],
        table,
      };
    },
  },
  {
    id: 'lidar-clearance',
    name: 'LiDAR vegetation and obstacle clearance',
    summary: 'Cells of a canopy or obstacle height model (from LiDAR) inside a line corridor that rise closer than the required clearance to the conductor: where to trim, with the excess height and area.',
    group: ENERGY,
    icon: 'pointcloud',
    params: [
      rasterP('chm', 'Canopy or obstacle height (m above ground)', true, 'A height above ground raster, for example a LiDAR canopy height model (DSM minus DTM).'),
      layerP('lines', 'Conductors or pipelines'),
      fieldP('height_field', 'Conductor height field (m above ground)', false, 'The lowest conductor height (at maximum sag) on each line; blank uses the height below.'),
      numP('conductor_m', 'Conductor height (m above ground)', 12),
      numP('clearance_m', 'Required clearance (m)', 3, 'The vegetation clearance the regulator or utility requires.'),
      numP('corridor_m', 'Corridor half-width (m)', 15),
    ],
    run(ctx) {
      const g = needRaster(ctx, 'chm', 'a canopy height raster');
      const lines = need(ctx, 'lines', 'line features');
      const hf = str(ctx, 'height_field');
      const dflt = num(ctx, 'conductor_m', 12), clear = num(ctx, 'clearance_m', 3), half = num(ctx, 'corridor_m', 15);
      const m = localMetric(lines);
      const ml = lines.map((l) => linesOf(l.geometry).map((ln) => ln.map(m.fwd)));
      const hts = lines.map((l) => { const v = Number(hf ? l.properties?.[hf] : NaN); return Number.isFinite(v) ? v : dflt; });
      const pr = gridProj(g);
      const band = g.bands[0];
      const exc = new Float32Array(g.width * g.height).fill(NaN);
      const { w, h } = cellMetres(g);
      const pts: Feature[] = [];
      let inCorridor = 0, viol = 0, maxEx = 0;
      const perLine = lines.map(() => 0);
      for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
        const i = r * g.width + c;
        const v = band[i];
        if (!Number.isFinite(v)) continue;
        const ll = pr.toLL(cellCentre(g, c, r));
        const xy = m.fwd(ll);
        let best = -1, bd = Infinity;
        ml.forEach((ls, li) => { const d = lineDist(xy, ls).d; if (d < bd) { bd = d; best = li; } });
        if (bd > half) continue;
        inCorridor++;
        const ex = v - (hts[best] - clear);
        exc[i] = ex > 0 ? ex : 0;
        if (ex > 0) {
          viol++; perLine[best]++; maxEx = Math.max(maxEx, ex);
          if (pts.length < 20000) pts.push(pointFeature(ll, { height_m: Number(v.toFixed(2)), allowed_m: Number((hts[best] - clear).toFixed(2)), excess_m: Number(ex.toFixed(2)), offset_m: Number(bd.toFixed(1)), line: best + 1 }));
        }
      }
      if (!inCorridor) throw new Error('no raster cell lies within the corridor: check that the raster covers the lines');
      return {
        message: `${viol} of ${inCorridor} corridor cell(s) breach the ${clear} m clearance (${haText(viol * w * h)}); worst excess ${maxEx.toFixed(2)} m`,
        layers: [{ name: 'Clearance breaches', features: pts }],
        rasters: [{ name: 'Clearance excess (m)', like: g, data: exc, units: 'm', description: 'Height above the allowed vegetation height, inside the corridor (0 = clear)' }],
        table: [['Corridor cells', inCorridor], ['Breaching cells', viol], ['Breach area', haText(viol * w * h)], ['Worst excess (m)', fix(maxEx)], ...perLine.map((n, i) => [`Line ${i + 1} breaches`, n] as [string, number])],
        notes: ['Conductor height is taken as constant along each line (the lowest point at maximum sag). For catenary-exact checks, model the sag per span.'],
      };
    },
  },
  {
    id: 'tower-inventory',
    name: 'Transmission tower inventory (spans and angles)',
    summary: 'Towers or poles in line order: span lengths, line deviation at each structure, a suggested structure type (suspension, angle, terminal) and spans longer than allowed.',
    group: ENERGY,
    icon: 'pin',
    params: [layerP('towers', 'Towers or poles (points)'), layerP('line', 'Line route (optional, orders the towers)', false), fieldP('id_field', 'Tower number field', false), numP('max_span_m', 'Longest allowed span (m)', 450), numP('angle_deg', 'Deviation for an angle structure (°)', 3), numP('terminal_deg', 'Deviation for a terminal structure (°)', 30)],
    run(ctx) {
      const towers = need(ctx, 'towers', 'tower points').filter((f) => pointOf(f));
      if (towers.length < 2) throw new Error('Give at least two towers');
      const m = localMetric(towers);
      const xy = towers.map((f) => m.fwd(pointOf(f)!));
      const line = ctx.layer('line');
      const idf = str(ctx, 'id_field');
      let order = towers.map((_, i) => i);
      if (line?.length) {
        const ml = line.flatMap((l) => linesOf(l.geometry)).map((ln) => ln.map(m.fwd));
        const along = xy.map((p) => { const d = lineDist(p, ml); return d.line * 1e9 + d.along; });
        order.sort((a, b) => along[a] - along[b]);
      } else if (idf) {
        order.sort((a, b) => String(towers[a].properties?.[idf]).localeCompare(String(towers[b].properties?.[idf]), 'en', { numeric: true }));
      } else {
        // a chain from one end: start at the tower farthest from the centroid, then nearest neighbour
        const cx = xy.reduce((s, p) => s + p[0], 0) / xy.length, cy = xy.reduce((s, p) => s + p[1], 0) / xy.length;
        let cur = xy.reduce((bi, p, i) => (dist(p, [cx, cy]) > dist(xy[bi], [cx, cy]) ? i : bi), 0);
        const left = new Set(order); left.delete(cur);
        order = [cur];
        while (left.size) { let best = -1, bd = Infinity; for (const j of left) { const d = dist(xy[cur], xy[j]); if (d < bd) { bd = d; best = j; } } order.push(best); left.delete(best); cur = best; }
      }
      const maxSpan = num(ctx, 'max_span_m', 450), angT = num(ctx, 'angle_deg', 3), termT = num(ctx, 'terminal_deg', 30);
      const brg = (a: Position, b: Position) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
      const out: Feature[] = [], spans: Feature[] = [];
      let long = 0, total = 0;
      const types: Record<string, number> = { suspension: 0, angle: 0, terminal: 0 };
      order.forEach((ti, k) => {
        const prev = k > 0 ? xy[order[k - 1]] : null, next = k < order.length - 1 ? xy[order[k + 1]] : null;
        let dev = 0;
        if (prev && next) { dev = Math.abs(((brg(xy[ti], next) - brg(prev, xy[ti]) + 540) % 360) - 180); }
        const type = !prev || !next || dev >= termT ? 'terminal' : dev >= angT ? 'angle' : 'suspension';
        types[type]++;
        const span = next ? dist(xy[ti], next) : null;
        if (span != null) {
          total += span;
          if (span > maxSpan) long++;
          spans.push(lineFeature([pointOf(towers[ti])!, pointOf(towers[order[k + 1]])!], { from: k + 1, to: k + 2, span_m: Number(span.toFixed(1)), too_long: span > maxSpan }));
        }
        out.push({ ...towers[ti], properties: { ...(towers[ti].properties ?? {}), seq: k + 1, deviation_deg: Number(dev.toFixed(2)), structure: type, span_ahead_m: span == null ? null : Number(span.toFixed(1)) } });
      });
      const sp = spans.map((s) => s.properties!.span_m as number);
      return {
        message: `${out.length} structures, ${spans.length} spans (${(total / 1000).toFixed(2)} km): ${types.suspension} suspension, ${types.angle} angle, ${types.terminal} terminal; ${long} span(s) over ${maxSpan} m`,
        layers: [{ name: 'Tower inventory', features: out }, { name: 'Spans', features: spans }],
        table: [['Structures', out.length], ['Line length (km)', fix(total / 1000, 3)], ['Mean span (m)', fix(total / spans.length, 1)], ['Shortest span (m)', fix(Math.min(...sp), 1)], ['Longest span (m)', fix(Math.max(...sp), 1)], ['Spans over limit', long], ['Suspension', types.suspension], ['Angle', types.angle], ['Terminal', types.terminal]],
      };
    },
  },
  {
    id: 'tenure-check',
    name: 'Tenure check (leases, licences, tenements)',
    summary: 'Areas of petroleum leases, mining tenements or other licences, overlaps between them, overlaps with constraint areas (protected or customary land) and licences expired or expiring.',
    group: TENURE,
    icon: 'mapOutline',
    params: [layerP('tenures', 'Leases or tenements (polygons)'), fieldP('name_field', 'Name or number field', false), fieldP('expiry_field', 'Expiry date field', false), numP('warn_days', 'Warn this many days before expiry', 180), layerP('constraints', 'Constraint areas (optional)', false), textP('as_of', 'Check as of (date, blank = today)', '')],
    run(ctx) {
      const ts = need(ctx, 'tenures', 'lease or tenement polygons').filter((f) => polygonsOf(f.geometry).length);
      if (!ts.length) throw new Error('the layer has no polygons');
      const nf = str(ctx, 'name_field'), ef = str(ctx, 'expiry_field');
      const now = str(ctx, 'as_of') ? timeOf(str(ctx, 'as_of')) : Date.now();
      const warn = num(ctx, 'warn_days', 180);
      const name = (f: Feature, i: number) => String((nf && f.properties?.[nf]) ?? `Tenure ${i + 1}`);
      const overlaps: Feature[] = [];
      const ov = ts.map(() => 0);
      for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
        const x = intersect(featureCollection([ts[i] as Feature<Polygon>, ts[j] as Feature<Polygon>]));
        if (!x) continue;
        const a = areaHa(x);
        if (a < 1e-6) continue;
        ov[i] += a; ov[j] += a;
        overlaps.push({ ...x, properties: { a: name(ts[i], i), b: name(ts[j], j), overlap_ha: Number(a.toFixed(4)), kind: 'tenure overlap' } });
      }
      const cons = ctx.layer('constraints') ?? [];
      const conHa = ts.map(() => 0);
      ts.forEach((t, i) => cons.forEach((c) => {
        if (!polygonsOf(c.geometry).length) return;
        const x = intersect(featureCollection([t as Feature<Polygon>, c as Feature<Polygon>]));
        if (!x) return;
        const a = areaHa(x);
        if (a < 1e-6) return;
        conHa[i] += a;
        overlaps.push({ ...x, properties: { a: name(t, i), b: 'constraint', overlap_ha: Number(a.toFixed(4)), kind: 'constraint overlap' } });
      }));
      let expired = 0, expiring = 0;
      const out = ts.map((t, i) => {
        const area = areaHa(t);
        const exp = ef ? timeOf(t.properties?.[ef]) : NaN;
        const days = Number.isFinite(exp) ? Math.floor((exp - now) / 86400000) : null;
        const status = days == null ? 'no expiry date' : days < 0 ? 'expired' : days <= warn ? 'expiring' : 'current';
        if (status === 'expired') expired++;
        if (status === 'expiring') expiring++;
        return { ...t, properties: { ...(t.properties ?? {}), tenure: name(t, i), area_ha: Number(area.toFixed(4)), overlap_ha: Number(ov[i].toFixed(4)), constraint_ha: Number(conHa[i].toFixed(4)), days_to_expiry: days, status } };
      });
      const total = out.reduce((s, f) => s + (f.properties.area_ha as number), 0);
      return {
        message: `${out.length} tenure(s), ${total.toFixed(2)} ha; ${overlaps.filter((o) => o.properties!.kind === 'tenure overlap').length} overlap(s) between tenures, ${overlaps.filter((o) => o.properties!.kind === 'constraint overlap').length} with constraints; ${expired} expired, ${expiring} expiring`,
        layers: [{ name: `${ctx.layerName('tenures')} tenure check`, features: out }, ...(overlaps.length ? [{ name: 'Tenure overlaps', features: overlaps }] : [])],
        table: [['Tenures', out.length], ['Total area', `${total.toFixed(2)} ha`], ['Expired', expired], [`Expiring within ${warn} days`, expiring], ...out.map((f) => [String(f.properties.tenure), `${f.properties.area_ha} ha, ${f.properties.status}`] as [string, string])],
      };
    },
  },
  {
    id: 'well-sites',
    name: 'Well sites (spacing and lease check)',
    summary: 'Wells or drill holes: the lease each is in, wells outside every lease, the distance to the nearest other well and wells closer than the minimum spacing.',
    group: TENURE,
    icon: 'point',
    params: [layerP('wells', 'Wells or drill holes (points)'), layerP('leases', 'Leases (polygons, optional)', false), fieldP('lease_name', 'Lease name field', false), numP('min_spacing_m', 'Minimum spacing (m)', 400)],
    run(ctx) {
      const wells = need(ctx, 'wells', 'well points').filter((f) => pointOf(f));
      const leases = ctx.layer('leases') ?? [];
      const lf = str(ctx, 'lease_name');
      const minS = num(ctx, 'min_spacing_m', 400);
      const m = localMetric(wells);
      const xy = wells.map((w) => m.fwd(pointOf(w)!));
      const per = new Map<string, number>();
      let outside = 0, close = 0;
      const out = wells.map((w, i) => {
        let nd = Infinity;
        xy.forEach((p, j) => { if (j !== i) nd = Math.min(nd, dist(p, xy[i])); });
        const ll = pointOf(w)!;
        const li = leases.findIndex((l) => polygonsOf(l.geometry).some((rg) => inRings(ll, rg)));
        const lease = li < 0 ? null : String((lf && leases[li].properties?.[lf]) ?? `Lease ${li + 1}`);
        if (leases.length && !lease) outside++;
        if (lease) per.set(lease, (per.get(lease) ?? 0) + 1);
        const tooClose = nd < minS;
        if (tooClose) close++;
        return { ...w, properties: { ...(w.properties ?? {}), lease, outside_lease: leases.length ? !lease : null, nearest_well_m: Number.isFinite(nd) ? Number(nd.toFixed(1)) : null, too_close: tooClose } };
      });
      return {
        message: `${out.length} well(s): ${close} closer than ${minS} m to another${leases.length ? `, ${outside} outside every lease` : ''}`,
        layers: [{ name: 'Well site check', features: out }],
        table: [['Wells', out.length], [`Closer than ${minS} m`, close], ...(leases.length ? [['Outside every lease', outside] as [string, number]] : []), ...[...per].map(([k, v]) => [`Wells in ${k}`, v] as [string, number])],
      };
    },
  },
  {
    id: 'route-suitability',
    name: 'Least-cost route (pipelines, haul and logging roads)',
    summary: 'The cheapest route between two points across a DEM (grade-limited) or a cost surface, avoiding no-go areas: for pipeline, haul road and logging road alignments, with length and grades.',
    group: ROUTE,
    icon: 'roadCentre',
    params: [
      rasterP('surface', 'DEM or cost surface'),
      layerP('ends', 'Start and end (points: first and last)'),
      choiceP('surface_kind', 'The surface is', ['dem', 'cost'], 'dem: cost grows with slope and cells steeper than the maximum grade are impassable; cost: the raster values are the cost per metre.'),
      numP('max_grade_deg', 'Maximum grade (°)', 12, 'For a DEM: cells steeper than this are impassable (haul roads are often 6 to 10 %, about 3.5 to 5.7°).'),
      layerP('avoid', 'No-go areas (optional)', false, 'Protected areas, villages, water bodies: never crossed.'),
    ],
    run(ctx) {
      const g = needRaster(ctx, 'surface', 'a DEM or cost raster');
      const ends = need(ctx, 'ends', 'start and end points').filter((f) => pointOf(f));
      if (ends.length < 2) throw new Error('Give two points: the start (first) and the end (last)');
      const kind = str(ctx, 'surface_kind', 'dem');
      const maxG = num(ctx, 'max_grade_deg', 12);
      const band = g.bands[0];
      const slope = kind === 'dem' ? slopeDegrees(g, band) : null;
      const cost = new Float32Array(band.length);
      for (let i = 0; i < band.length; i++) {
        if (!Number.isFinite(band[i])) { cost[i] = NaN; continue; }
        if (slope) cost[i] = slope[i] > maxG ? NaN : 1 + (slope[i] / maxG) ** 2 * 4;
        else cost[i] = band[i] > 0 ? band[i] : NaN;
      }
      const avoid = maskInside(g, ctx.layer('avoid'));
      if (avoid) avoid.forEach((v, i) => { if (v) cost[i] = NaN; });
      const pr = gridProj(g);
      const a = cellOf(g, pr.fromLL(pointOf(ends[0])!)), b = cellOf(g, pr.fromLL(pointOf(ends[ends.length - 1])!));
      if (a < 0 || b < 0) throw new Error('the start or the end is outside the raster');
      const r = leastCostPath(g, cost, a, b);
      const coords = r.cells.map((i) => pr.toLL(cellCentre(g, i % g.width, Math.floor(i / g.width))));
      const grades = slope ? r.cells.map((i) => slope[i]) : [];
      const meanG = grades.length ? grades.reduce((s, v) => s + v, 0) / grades.length : null;
      const maxRoute = grades.length ? Math.max(...grades) : null;
      return {
        message: `Route of ${(r.length / 1000).toFixed(2)} km${maxRoute != null ? `, grades up to ${maxRoute.toFixed(1)}° (mean ${meanG!.toFixed(1)}°)` : ''}`,
        layers: [{ name: 'Least-cost route', features: [lineFeature(coords, { length_m: Number(r.length.toFixed(1)), cost: Number(r.cost.toFixed(1)), mean_grade_deg: meanG == null ? null : Number(meanG.toFixed(2)), max_grade_deg: maxRoute == null ? null : Number(maxRoute.toFixed(2)) })] }],
        table: [['Length (km)', fix(r.length / 1000, 3)], ['Straight line (km)', fix(dist(localMetric([pointOf(ends[0])!, pointOf(ends[ends.length - 1])!]).fwd(pointOf(ends[0])!), localMetric([pointOf(ends[0])!, pointOf(ends[ends.length - 1])!]).fwd(pointOf(ends[ends.length - 1])!)) / 1000, 3)], ['Accumulated cost', fix(r.cost, 1)], ...(maxRoute != null ? [['Mean grade (°)', fix(meanG, 2)], ['Steepest cell (°)', fix(maxRoute, 2)]] as [string, number | string][] : [])],
        notes: ['The route follows cell centres (8 directions); smooth and survey the alignment before design.'],
      };
    },
  },
  {
    id: 'volume-change',
    name: 'Cut and fill volumes (open pit, stockpiles)',
    summary: 'Volume removed and added between two DEMs of the same grid (open pits, waste dumps, stockpiles, earthworks), within an optional boundary, with the change raster.',
    group: VOLUME,
    icon: 'cube',
    params: [rasterP('before', 'DEM before'), rasterP('after', 'DEM after'), layerP('boundary', 'Boundary (optional)', false), numP('min_change_m', 'Ignore changes smaller than (m)', 0.1, 'Survey noise threshold.')],
    run(ctx) {
      const a = needRaster(ctx, 'before', 'the earlier DEM'), b = needRaster(ctx, 'after', 'the later DEM');
      if (!sameGrid(a, b)) throw new Error('the two DEMs must share one grid (same size, cell and origin); resample one to the other first');
      const mask = maskInside(a, ctx.layer('boundary'));
      const tol = num(ctx, 'min_change_m', 0.1);
      const { w, h } = cellMetres(a);
      const cell = w * h;
      const out = new Float32Array(a.width * a.height).fill(NaN);
      let cut = 0, fill = 0, cutA = 0, fillA = 0, n = 0, deepest = 0;
      for (let i = 0; i < out.length; i++) {
        if (mask && !mask[i]) continue;
        const d = b.bands[0][i] - a.bands[0][i];
        if (!Number.isFinite(d)) continue;
        n++;
        out[i] = Math.abs(d) < tol ? 0 : d;
        if (d <= -tol) { cut += -d * cell; cutA += cell; deepest = Math.min(deepest, d); }
        else if (d >= tol) { fill += d * cell; fillA += cell; }
      }
      if (!n) throw new Error('no overlapping cells with data (inside the boundary)');
      const fmt = (v: number) => `${Math.round(v).toLocaleString('en-NZ')} m³`;
      return {
        message: `Cut ${fmt(cut)} over ${haText(cutA)}, fill ${fmt(fill)} over ${haText(fillA)}; net ${fmt(fill - cut)}`,
        rasters: [{ name: 'Elevation change (m)', like: a, data: out, units: 'm', description: 'After minus before: negative = cut (excavation), positive = fill' }],
        table: [['Cut volume', fmt(cut)], ['Fill volume', fmt(fill)], ['Net (fill - cut)', fmt(fill - cut)], ['Cut area', haText(cutA)], ['Fill area', haText(fillA)], ['Deepest cut (m)', fix(deepest)], ['Cell (m)', `${fix(w, 2)} × ${fix(h, 2)}`]],
        notes: ['Volumes are cell-by-cell prism sums; both DEMs must be on the same vertical datum.'],
      };
    },
  },
];
export { bool, optNum };
