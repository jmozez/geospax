// Forestry harvest planning, maritime surveillance, aeronautical obstacle surfaces, transport and
// logistics, urban and rural planning, and asset management.
import buffer from '@turf/buffer';
import type { Feature, Position } from 'geojson';
import type { Ctx, Tool } from '../tools';
import {
  buildGraph, cellCentre, cellOf, choiceP, dijkstra, dist, fieldP, fix, gridProj, inRings, layerP, lineDist, lineFeature, linesOf, localMetric,
  need, num, numP, pointFeature, pointOf, polyDist, polyFeature, polygonsOf, rasterP, ringsArea, slopeDegrees, str, textP, timeOf, type Metric,
} from './common';

const FOREST = 'Harvest planning';
const SEA = 'Maritime surveillance';
const AIR = 'Aeronautical';
const MOVE = 'Transport and logistics';
const TOWN = 'Urban planning';
const RURAL = 'Rural planning';
const ASSET = 'Asset management';

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)} %` : '-');

/** count points (optionally distinct ids) in square cells of `size` metres */
function gridCount(pts: Feature[], size: number, idField = '', weightField = '') {
  const m = localMetric(pts);
  const cells = new Map<string, { n: number; w: number; ids: Set<string> }>();
  for (const f of pts) {
    const p = pointOf(f);
    if (!p) continue;
    const [x, y] = m.fwd(p);
    const k = `${Math.floor(x / size)}:${Math.floor(y / size)}`;
    const c = cells.get(k) ?? { n: 0, w: 0, ids: new Set<string>() };
    c.n++;
    const wv = Number(weightField ? f.properties?.[weightField] : 1);
    c.w += Number.isFinite(wv) ? wv : 0;
    if (idField) c.ids.add(String(f.properties?.[idField]));
    cells.set(k, c);
  }
  const ha = (size * size) / 10000;
  const out = [...cells].map(([k, c]) => {
    const [i, j] = k.split(':').map(Number);
    const ring = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1], [i, j]].map(([a, b]) => m.inv([a * size, b * size]));
    return polyFeature(ring, { count: c.n, ...(idField ? { distinct: c.ids.size } : {}), ...(weightField ? { total: Number(c.w.toFixed(3)) } : {}), per_ha: Number(((weightField ? c.w : c.n) / ha).toFixed(3)) });
  });
  return out.sort((a, b) => (b.properties!.count as number) - (a.properties!.count as number));
}

/** sample points every `step` metres inside a polygon feature */
function sampleInside(f: Feature, m: Metric, step: number): Position[] {
  const out: Position[] = [];
  for (const rings of polygonsOf(f.geometry)) {
    const mr = rings.map((r) => r.map(m.fwd));
    const xs = mr[0].map((p) => p[0]), ys = mr[0].map((p) => p[1]);
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) if (inRings([x, y], mr)) out.push([x, y]);
  }
  return out;
}

/** cost from every point to the nearest target: network (minutes or metres) or straight line (metres) */
function nearestCost(ctx: Ctx, from: Feature[], to: Feature[], netName: string, speedField: string, kmh: number) {
  const all = [...from, ...to];
  const net = ctx.layer(netName);
  const m = localMetric(net?.length ? [...net, ...all] : all);
  const tp = to.map((t) => pointOf(t)!).filter(Boolean);
  if (net?.length) {
    const g = buildGraph(net, m, speedField, kmh);
    const src = tp.map((p) => g.nearest(p).node);
    const d = dijkstra(g, src);
    return { unit: g.timed ? 'min' : 'm', costs: from.map((f) => { const s = g.nearest(pointOf(f)!); const c = d.cost[s.node]; return { cost: c, target: d.origin[s.node], snap: s.snap }; }) };
  }
  return { unit: 'm', costs: from.map((f) => { const p = m.fwd(pointOf(f)!); let bi = -1, bd = Infinity; tp.forEach((q, i) => { const dd = dist(p, m.fwd(q)); if (dd < bd) { bd = dd; bi = i; } }); return { cost: bd, target: bi, snap: 0 }; }) };
}

// Annex 14 non-instrument approach and inner horizontal / conical surfaces by code number
const OLS: Record<string, { edge: number; from: number; div: number; len: number; slope: number; ihs: number; con: number }> = {
  '1': { edge: 60, from: 30, div: 0.10, len: 1600, slope: 0.05, ihs: 2000, con: 35 },
  '2': { edge: 80, from: 60, div: 0.10, len: 2500, slope: 0.04, ihs: 2500, con: 55 },
  '3': { edge: 150, from: 60, div: 0.10, len: 3000, slope: 0.0333, ihs: 4000, con: 75 },
  '4': { edge: 150, from: 60, div: 0.10, len: 3000, slope: 0.025, ihs: 4000, con: 100 },
};

/** nearest neighbour then 2-opt on a cost matrix; index 0 is the start */
export function tour(c: number[][], back: boolean): number[] {
  const n = c.length;
  const order = [0], left = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
  while (left.size) { const u = order[order.length - 1]; let b = -1, bd = Infinity; for (const v of left) if (c[u][v] < bd) { bd = c[u][v]; b = v; } order.push(b); left.delete(b); }
  const len = (o: number[]) => o.slice(1).reduce((s, v, i) => s + c[o[i]][v], 0) + (back ? c[o[o.length - 1]][0] : 0);
  let improved = true, best = len(order);
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const o = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
      const l = len(o);
      if (l < best - 1e-9) { order.splice(0, n, ...o); best = l; improved = true; }
    }
  }
  return order;
}

export const SECTOR_TOOLS: Tool[] = [
  {
    id: 'harvest-coupes',
    name: 'Harvest coupe net area (stream buffers, steep slopes)',
    summary: 'Gross and net harvestable area of each logging coupe after stream and river buffers and slopes too steep to log are excluded, with the excluded areas.',
    group: FOREST,
    icon: 'd-forestry',
    params: [layerP('coupes', 'Coupes (polygons)'), layerP('streams', 'Streams and rivers (lines, optional)', false), numP('buffer_m', 'Stream buffer (m each side)', 50, 'The PNG Logging Code of Practice uses 50 m for major rivers and 10 m for streams; use the widest that applies.'), rasterP('dem', 'DEM (optional, for slope)', false), numP('max_slope_deg', 'Steepest loggable slope (°)', 30), numP('step_m', 'Sample spacing (m)', 10)],
    run(ctx) {
      const coupes = need(ctx, 'coupes', 'coupe polygons').filter((f) => polygonsOf(f.geometry).length);
      const streams = ctx.layer('streams') ?? [];
      const dem = ctx.raster('dem');
      const bm = num(ctx, 'buffer_m', 50), ms = num(ctx, 'max_slope_deg', 30), step = Math.max(1, num(ctx, 'step_m', 10));
      const m = localMetric([...coupes, ...streams]);
      const sl = streams.flatMap((s) => linesOf(s.geometry)).map((l) => l.map(m.fwd));
      const slope = dem ? slopeDegrees(dem, dem.bands[0]) : null;
      const pr = dem ? gridProj(dem) : null;
      const a = step * step / 10000;
      let tg = 0, tn = 0;
      const out = coupes.map((f, i) => {
        const pts = sampleInside(f, m, step);
        let s = 0, st = 0, net = 0;
        for (const p of pts) {
          if (sl.length && lineDist(p, sl).d <= bm) { s++; continue; }
          if (slope && pr) { const ci = cellOf(dem!, pr.fromLL(m.inv(p))); if (ci >= 0 && slope[ci] > ms) { st++; continue; } }
          net++;
        }
        const gross = polygonsOf(f.geometry).reduce((t, r) => t + ringsArea(r.map((x) => x.map(m.fwd))), 0) / 10000;
        const k = pts.length ? gross / (pts.length * a) : 1;
        tg += gross; tn += net * a * k;
        return { ...f, properties: { ...(f.properties ?? {}), coupe: f.properties?.name ?? i + 1, gross_ha: Number(gross.toFixed(2)), stream_buffer_ha: Number((s * a * k).toFixed(2)), steep_ha: Number((st * a * k).toFixed(2)), net_ha: Number((net * a * k).toFixed(2)) } };
      });
      return {
        message: `${out.length} coupe(s): ${tg.toFixed(1)} ha gross, ${tn.toFixed(1)} ha net (${pct(tn, tg)})`,
        layers: [{ name: 'Coupe net areas', features: out }],
        table: [['Gross area (ha)', fix(tg, 2)], ['Net harvestable (ha)', fix(tn, 2)], ['Net share', pct(tn, tg)], ...out.map((f) => [`Coupe ${f.properties.coupe}`, `${f.properties.net_ha} of ${f.properties.gross_ha} ha`] as [string, string])],
        notes: ['Areas are sampled on a grid of the chosen spacing and scaled to the exact gross area.'],
      };
    },
  },
  {
    id: 'ais-density',
    name: 'Vessel track density (AIS)',
    summary: 'Square cells counting AIS position reports and distinct vessels: shipping lanes, fishing grounds and anchorages.',
    group: SEA,
    icon: 'grid',
    params: [layerP('pings', 'AIS positions (points)'), fieldP('vessel_field', 'Vessel id field (MMSI)', false), numP('cell_m', 'Cell size (m)', 1000)],
    run(ctx) {
      const pts = need(ctx, 'pings', 'AIS points');
      const out = gridCount(pts, num(ctx, 'cell_m', 1000), str(ctx, 'vessel_field'));
      return { message: `${pts.length} report(s) in ${out.length} cell(s); busiest cell ${out[0]?.properties!.count ?? 0}`, layers: [{ name: 'AIS density', features: out }], table: [['Reports', pts.length], ['Cells', out.length], ['Busiest cell', (out[0]?.properties!.count as number) ?? 0]] };
    },
  },
  {
    id: 'ais-loitering',
    name: 'Vessel loitering and AIS gaps',
    summary: 'Vessels that stay within a small radius for a long time (loitering, possible transhipment or illegal fishing) and gaps in their AIS reports (transponder switched off), from time-stamped positions.',
    group: SEA,
    icon: 'alert',
    params: [layerP('pings', 'AIS positions (points)'), fieldP('vessel_field', 'Vessel id field (MMSI)', true), fieldP('time_field', 'Time field', true), numP('radius_m', 'Loitering radius (m)', 1000), numP('min_hours', 'Loitering for at least (hours)', 2), numP('gap_hours', 'Report gap of at least (hours)', 6), layerP('zone', 'Zone of interest (optional: only events inside)', false)],
    run(ctx) {
      const pts = need(ctx, 'pings', 'AIS points');
      const vf = str(ctx, 'vessel_field'), tf = str(ctx, 'time_field');
      if (!vf || !tf) throw new Error('Choose the vessel id and time fields');
      const R = num(ctx, 'radius_m', 1000), minH = num(ctx, 'min_hours', 2), gapH = num(ctx, 'gap_hours', 6);
      const zone = (ctx.layer('zone') ?? []).flatMap((z) => polygonsOf(z.geometry));
      const inZone = (p: Position) => !zone.length || zone.some((r) => inRings(p, r));
      const m = localMetric(pts);
      const by = new Map<string, { t: number; p: Position }[]>();
      for (const f of pts) { const p = pointOf(f), t = timeOf(f.properties?.[tf]); if (!p || !Number.isFinite(t)) continue; const k = String(f.properties?.[vf]); (by.get(k) ?? by.set(k, []).get(k)!).push({ t, p }); }
      const loiter: Feature[] = [], gaps: Feature[] = [], tracks: Feature[] = [];
      for (const [v, list] of by) {
        list.sort((a, b) => a.t - b.t);
        if (list.length > 1) tracks.push(lineFeature(list.map((x) => x.p), { vessel: v, reports: list.length }));
        let i = 0;
        while (i < list.length) {
          const a = m.fwd(list[i].p);
          let j = i;
          while (j + 1 < list.length && dist(a, m.fwd(list[j + 1].p)) <= R && (list[j + 1].t - list[j].t) / 3.6e6 < gapH) j++;
          const hrs = (list[j].t - list[i].t) / 3.6e6;
          if (hrs >= minH) {
            const seg = list.slice(i, j + 1);
            const c: Position = [seg.reduce((s, x) => s + x.p[0], 0) / seg.length, seg.reduce((s, x) => s + x.p[1], 0) / seg.length];
            if (inZone(c)) loiter.push(pointFeature(c, { vessel: v, start: new Date(list[i].t).toISOString(), end: new Date(list[j].t).toISOString(), hours: Number(hrs.toFixed(2)), reports: seg.length }));
            i = j + 1;
          } else i++;
        }
        for (let k = 1; k < list.length; k++) {
          const h = (list[k].t - list[k - 1].t) / 3.6e6;
          if (h >= gapH && (inZone(list[k].p) || inZone(list[k - 1].p))) gaps.push(lineFeature([list[k - 1].p, list[k].p], { vessel: v, from: new Date(list[k - 1].t).toISOString(), to: new Date(list[k].t).toISOString(), hours: Number(h.toFixed(2)), km: Number((dist(m.fwd(list[k - 1].p), m.fwd(list[k].p)) / 1000).toFixed(2)) }));
        }
      }
      return {
        message: `${by.size} vessel(s): ${loiter.length} loitering event(s), ${gaps.length} AIS gap(s) of ${gapH} h or more`,
        layers: [{ name: 'Vessel tracks', features: tracks }, { name: 'Loitering events', features: loiter }, { name: 'AIS gaps', features: gaps }],
        table: [['Vessels', by.size], ['Loitering events', loiter.length], ['AIS gaps', gaps.length], ...[...by.keys()].map((v) => [`Vessel ${v}`, `${loiter.filter((l) => l.properties!.vessel === v).length} loiter, ${gaps.filter((g) => g.properties!.vessel === v).length} gap`] as [string, string])],
      };
    },
  },
  {
    id: 'ols-surfaces',
    name: 'Obstacle limitation surfaces (airports)',
    summary: 'ICAO Annex 14 approach, inner horizontal and conical surfaces for a runway by code number, and the obstacles (towers, trees, buildings) that penetrate them, by how much.',
    group: AIR,
    icon: 'chart',
    params: [layerP('runway', 'Runway centre line (threshold to threshold)'), numP('elevation_m', 'Aerodrome elevation (m AMSL)', 0), choiceP('code', 'Runway code number', ['3', '4', '2', '1'], 'From the runway length: 1 under 800 m, 2 800 to 1199 m, 3 1200 to 1799 m, 4 1800 m and over.'), layerP('obstacles', 'Obstacles (optional)', false), fieldP('top_field', 'Obstacle top elevation field (m AMSL)', false)],
    run(ctx) {
      const rw = need(ctx, 'runway', 'a runway line');
      const ln = linesOf(rw[0].geometry)[0];
      if (!ln || ln.length < 2) throw new Error('Choose a runway line drawn from one threshold to the other');
      const s = OLS[str(ctx, 'code', '3')] ?? OLS['3'];
      const elev = num(ctx, 'elevation_m', 0);
      const m = localMetric([ln[0], ln[ln.length - 1]]);
      const A = m.fwd(ln[0]), B = m.fwd(ln[ln.length - 1]);
      const L = dist(A, B), ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L;
      const P = (o: Position, along: number, side: number) => m.inv([o[0] + ux * along - uy * side, o[1] + uy * along + ux * side]);
      const appr = (o: Position, dir: number) => {
        const e0 = s.from, e1 = s.from + s.len, h0 = s.edge / 2, h1 = h0 + s.div * s.len;
        return [P(o, dir * e0, -h0), P(o, dir * e0, h0), P(o, dir * e1, h1), P(o, dir * e1, -h1), P(o, dir * e0, -h0)];
      };
      const strip = lineFeature([P(A, -s.from, 0), P(B, s.from, 0)], {});
      const ihs = buffer(strip, s.ihs, { units: 'meters', steps: 32 })!;
      const conR = s.ihs + s.con / 0.05;
      const con = buffer(strip, conR, { units: 'meters', steps: 32 })!;
      const surfaces: Feature[] = [
        { ...con, properties: { surface: 'Conical', height_m: `${elev + 45} to ${elev + 45 + s.con}`, slope: '5 %' } },
        { ...ihs, properties: { surface: 'Inner horizontal', height_m: elev + 45, radius_m: s.ihs } },
        polyFeature(appr(A, -1), { surface: 'Approach (runway end 1)', slope: `${(s.slope * 100).toFixed(2)} %`, length_m: s.len }),
        polyFeature(appr(B, 1), { surface: 'Approach (runway end 2)', slope: `${(s.slope * 100).toFixed(2)} %`, length_m: s.len }),
      ];
      const limit = (p: Position) => {
        const q = m.fwd(p);
        const rel = (o: Position, dir: number) => { const dx = q[0] - o[0], dy = q[1] - o[1]; return { along: dir * (dx * ux + dy * uy), side: Math.abs(-dx * uy + dy * ux) }; };
        let best = Infinity, which = '';
        for (const [o, dir] of [[A, -1], [B, 1]] as [Position, number][]) {
          const r = rel(o, dir);
          const d = r.along - s.from;
          if (d >= 0 && d <= s.len && r.side <= s.edge / 2 + s.div * d) { const h = elev + s.slope * d; if (h < best) { best = h; which = 'approach'; } }
        }
        const sd = lineDist(q, [[m.fwd(P(A, -s.from, 0)), m.fwd(P(B, s.from, 0))]]).d;
        if (sd <= s.ihs && elev + 45 < best) { best = elev + 45; which = 'inner horizontal'; }
        else if (sd > s.ihs && sd <= conR) { const h = elev + 45 + 0.05 * (sd - s.ihs); if (h < best) { best = h; which = 'conical'; } }
        return { best, which };
      };
      const obs = ctx.layer('obstacles') ?? [];
      const tf = str(ctx, 'top_field');
      let pen = 0;
      const checked = obs.filter((o) => pointOf(o)).map((o) => {
        const top = Number(tf ? o.properties?.[tf] : NaN);
        const { best, which } = limit(pointOf(o)!);
        const p = Number.isFinite(best) && Number.isFinite(top) ? top - best : null;
        if (p != null && p > 0) pen++;
        return { ...o, properties: { ...(o.properties ?? {}), surface: which || 'outside', limit_m: Number.isFinite(best) ? Number(best.toFixed(2)) : null, penetration_m: p == null ? null : Number(p.toFixed(2)), penetrates: p != null && p > 0 } };
      });
      return {
        message: `Code ${str(ctx, 'code', '3')} surfaces for a ${L.toFixed(0)} m runway${obs.length ? `; ${pen} of ${obs.length} obstacle(s) penetrate` : ''}`,
        layers: [{ name: 'Obstacle limitation surfaces', features: surfaces }, ...(obs.length ? [{ name: 'Obstacle check', features: checked }] : [])],
        table: [['Runway length (m)', fix(L, 1)], ['Inner horizontal', `${elev + 45} m AMSL, radius ${s.ihs} m`], ['Conical', `5 % to ${elev + 45 + s.con} m AMSL`], ['Approach', `${s.len} m at ${(s.slope * 100).toFixed(2)} %, ${(s.div * 100).toFixed(0)} % divergence`], ...(obs.length ? [['Penetrating obstacles', pen] as [string, number]] : [])],
        notes: ['Non-instrument runway dimensions (ICAO Annex 14, Table 4-1); instrument runways have longer, flatter approaches and transitional surfaces. Confirm with CASA PNG before use.'],
      };
    },
  },
  {
    id: 'service-area',
    name: 'Service areas (drive time or distance)',
    summary: 'The parts of a road network reachable from depots, clinics or other facilities within time or distance bands, and the nearest facility for each demand point.',
    group: MOVE,
    icon: 'road',
    params: [layerP('network', 'Road network (lines)'), layerP('facilities', 'Facilities (points)'), textP('bands', 'Bands (minutes, or metres without a speed)', '10, 20, 30'), fieldP('speed_field', 'Speed field (km/h)', false), numP('speed_kmh', 'Default speed (km/h, 0 = distance)', 40), layerP('demand', 'Demand points (optional)', false)],
    run(ctx) {
      const net = need(ctx, 'network', 'road lines'), fac = need(ctx, 'facilities', 'facility points').filter((f) => pointOf(f));
      const bands = str(ctx, 'bands', '10, 20, 30').split(/[,;\s]+/).map(Number).filter((v) => v > 0).sort((a, b) => a - b);
      if (!bands.length) throw new Error('Give at least one band');
      const m = localMetric([...net, ...fac]);
      const g = buildGraph(net, m, str(ctx, 'speed_field'), num(ctx, 'speed_kmh', 40));
      const unit = g.timed ? 'min' : 'm';
      const d = dijkstra(g, fac.map((f) => g.nearest(pointOf(f)!).node), bands[bands.length - 1]);
      const edges: Feature[] = [];
      const len: number[] = bands.map(() => 0);
      g.adj.forEach((es, a) => es.forEach((e) => {
        if (e.to < a) return;
        const c = Math.max(d.cost[a], d.cost[e.to]);
        const bi = bands.findIndex((b) => c <= b * (1 + 1e-9) + 1e-6);
        if (bi < 0) return;
        len[bi] += e.len;
        edges.push(lineFeature([g.ll[a], g.ll[e.to]], { band: `${bi ? bands[bi - 1] : 0} to ${bands[bi]} ${unit}`, upper: bands[bi], facility: d.origin[a] + 1 }));
      }));
      const dem = ctx.layer('demand') ?? [];
      const dout = dem.filter((f) => pointOf(f)).map((f) => { const s = g.nearest(pointOf(f)!); const c = d.cost[s.node]; return { ...f, properties: { ...(f.properties ?? {}), facility: Number.isFinite(c) ? d.origin[s.node] + 1 : null, [`cost_${unit}`]: Number.isFinite(c) ? Number(c.toFixed(1)) : null, snap_m: Number(s.snap.toFixed(1)) } }; });
      const served = dout.filter((f) => f.properties.facility != null).length;
      return {
        message: `${edges.length} network segment(s) within ${bands[bands.length - 1]} ${unit} of ${fac.length} facility(ies)${dem.length ? `; ${served} of ${dout.length} demand point(s) served` : ''}`,
        layers: [{ name: 'Service areas', features: edges }, ...(dout.length ? [{ name: 'Demand served', features: dout }] : [])],
        table: [...bands.map((b, i) => [`Within ${b} ${unit} (km of road)`, fix(len.slice(0, i + 1).reduce((s, v) => s + v, 0) / 1000, 2)] as [string, number | string]), ...(dout.length ? [['Demand served', `${served} of ${dout.length}`] as [string, string]] : [])],
      };
    },
  },
  {
    id: 'route-optimise',
    name: 'Delivery route optimisation',
    summary: 'The shortest order to visit a set of stops from a depot (nearest neighbour improved by 2-opt), over a road network or in straight lines, with the route and leg lengths.',
    group: MOVE,
    icon: 'roadCentre',
    params: [layerP('stops', 'Stops (points; the first is the depot)'), layerP('network', 'Road network (optional)', false), choiceP('return', 'Return to the depot', ['yes', 'no']), fieldP('speed_field', 'Speed field (km/h)', false), numP('speed_kmh', 'Default speed (km/h, 0 = distance)', 0)],
    run(ctx) {
      const stops = need(ctx, 'stops', 'stop points').filter((f) => pointOf(f));
      if (stops.length < 3) throw new Error('Give a depot and at least two stops');
      if (stops.length > 300) throw new Error('At most 300 stops');
      const back = str(ctx, 'return', 'yes') !== 'no';
      const net = ctx.layer('network');
      const m = localMetric(net?.length ? [...net, ...stops] : stops);
      const n = stops.length;
      let c: number[][], paths: ((i: number, j: number) => Position[]) | null = null, unit = 'm';
      if (net?.length) {
        const g = buildGraph(net, m, str(ctx, 'speed_field'), num(ctx, 'speed_kmh', 0));
        unit = g.timed ? 'min' : 'm';
        const nodes = stops.map((s) => g.nearest(pointOf(s)!).node);
        const runs = nodes.map((nd) => dijkstra(g, [nd]));
        c = nodes.map((_, i) => nodes.map((nj) => runs[i].cost[nj]));
        if (c.some((r) => r.some((v) => !Number.isFinite(v)))) throw new Error('Some stops are on parts of the network not connected to the others');
        paths = (i, j) => runs[i].path(nodes[j]).map((k) => g.ll[k]);
      } else {
        const xy = stops.map((s) => m.fwd(pointOf(s)!));
        c = xy.map((a) => xy.map((b) => dist(a, b)));
      }
      const naive = Array.from({ length: n }, (_, i) => i).slice(1).reduce((s, v) => s + c[v - 1][v], 0) + (back ? c[n - 1][0] : 0);
      const order = tour(c, back);
      const seq = back ? [...order, 0] : order;
      const coords: Position[] = [];
      const legs: [string, number | string][] = [];
      let total = 0;
      for (let k = 1; k < seq.length; k++) {
        const a = seq[k - 1], b = seq[k];
        total += c[a][b];
        coords.push(...(paths ? paths(a, b) : [pointOf(stops[a])!, pointOf(stops[b])!]));
        legs.push([`${k}. stop ${a + 1} to ${b + 1}`, fix(unit === 'm' ? c[a][b] / 1000 : c[a][b], 2)]);
      }
      const show = (v: number) => (unit === 'm' ? `${(v / 1000).toFixed(2)} km` : `${v.toFixed(1)} min`);
      return {
        message: `Visit order ${seq.map((i) => i + 1).join(' > ')}: ${show(total)} (the given order was ${show(naive)})`,
        layers: [{ name: 'Optimised route', features: [lineFeature(coords, { total: Number(total.toFixed(2)), unit })] }, { name: 'Stops in order', features: order.map((i, k) => ({ ...stops[i], properties: { ...(stops[i].properties ?? {}), visit: k + 1 } })) }],
        table: [['Total', show(total)], ['Given order', show(naive)], ['Saving', pct(naive - total, naive)], ...legs],
      };
    },
  },
  {
    id: 'zoning-summary',
    name: 'Zoning summary',
    summary: 'Area and share of each zone (land-use zoning or planning scheme), and the count and density of buildings, parcels or households in each.',
    group: TOWN,
    icon: 'mapOutline',
    params: [layerP('zones', 'Zones (polygons)'), fieldP('zone_field', 'Zone field', true), layerP('features', 'Buildings or households (optional)', false)],
    run(ctx) {
      const zones = need(ctx, 'zones', 'zone polygons');
      const zf = str(ctx, 'zone_field');
      if (!zf) throw new Error('Choose the zone field');
      const feats = ctx.layer('features') ?? [];
      const m = localMetric(zones);
      const by = new Map<string, { ha: number; n: number }>();
      for (const z of zones) {
        const k = String(z.properties?.[zf] ?? '-');
        const rec = by.get(k) ?? { ha: 0, n: 0 };
        const polys = polygonsOf(z.geometry);
        rec.ha += polys.reduce((s, r) => s + ringsArea(r.map((x) => x.map(m.fwd))), 0) / 10000;
        rec.n += feats.filter((f) => { const p = pointOf(f); return p && polys.some((r) => inRings(p, r)); }).length;
        by.set(k, rec);
      }
      const tot = [...by.values()].reduce((s, v) => s + v.ha, 0);
      const rows = [...by].sort((a, b) => b[1].ha - a[1].ha);
      return {
        message: `${rows.length} zone class(es) over ${tot.toFixed(1)} ha`,
        table: rows.map(([k, v]) => [k, `${v.ha.toFixed(2)} ha (${pct(v.ha, tot)})${feats.length ? `, ${v.n} feature(s), ${(v.n / (v.ha || 1)).toFixed(2)} per ha` : ''}`] as [string, string]),
        layers: [{ name: 'Zoning summary', features: zones.map((z) => { const r = by.get(String(z.properties?.[zf] ?? '-'))!; return { ...z, properties: { ...(z.properties ?? {}), class_ha: Number(r.ha.toFixed(2)), class_share: pct(r.ha, tot) } }; }) }],
      };
    },
  },
  {
    id: 'density-grid',
    name: 'Building and population density',
    summary: 'Square cells counting buildings, households or people (from a population field) per hectare: settlement density for city and town planning.',
    group: TOWN,
    icon: 'grid',
    params: [layerP('points', 'Buildings or households (points)'), fieldP('weight_field', 'Population field (optional)', false), numP('cell_m', 'Cell size (m)', 100)],
    run(ctx) {
      const pts = need(ctx, 'points', 'points');
      const wf = str(ctx, 'weight_field');
      const out = gridCount(pts, num(ctx, 'cell_m', 100), '', wf);
      const dens = out.map((f) => f.properties!.per_ha as number).sort((a, b) => b - a);
      return { message: `${out.length} occupied cell(s); peak ${dens[0]?.toFixed(1) ?? 0} ${wf ? 'people' : 'features'} per ha`, layers: [{ name: 'Density', features: out }], table: [['Occupied cells', out.length], ['Peak per ha', fix(dens[0], 2)], ['Median per ha', fix(dens[Math.floor(dens.length / 2)], 2)]] };
    },
  },
  {
    id: 'green-access',
    name: 'Green space access',
    summary: 'Distance from each home or building to the nearest park or green space of a minimum size, and the share within walking distance (for example 400 m, about 5 minutes).',
    group: TOWN,
    icon: 'd-environment',
    params: [layerP('homes', 'Homes or buildings (points)'), layerP('parks', 'Parks and green spaces (polygons)'), numP('walk_m', 'Walking distance (m)', 400), numP('min_ha', 'Smallest park counted (ha)', 0.5), fieldP('weight_field', 'Population field (optional)', false)],
    run(ctx) {
      const homes = need(ctx, 'homes', 'home points').filter((f) => pointOf(f));
      const parks = need(ctx, 'parks', 'park polygons');
      const walk = num(ctx, 'walk_m', 400), minHa = num(ctx, 'min_ha', 0.5), wf = str(ctx, 'weight_field');
      const m = localMetric([...homes, ...parks]);
      const mp = parks.flatMap((p) => polygonsOf(p.geometry)).map((r) => r.map((x) => x.map(m.fwd))).filter((r) => ringsArea(r) / 10000 >= minHa);
      if (!mp.length) throw new Error(`No green space of ${minHa} ha or more`);
      let w = 0, wIn = 0;
      const out = homes.map((h) => {
        const d = polyDist(m.fwd(pointOf(h)!), mp);
        const wt = Number(wf ? h.properties?.[wf] : 1) || 0;
        w += wt; if (d <= walk) wIn += wt;
        return { ...h, properties: { ...(h.properties ?? {}), park_m: Number(d.toFixed(1)), within_walk: d <= walk } };
      });
      return { message: `${pct(wIn, w)} of ${wf ? 'people' : 'homes'} are within ${walk} m of a green space of ${minHa} ha or more`, layers: [{ name: 'Green space access', features: out }], table: [['Green spaces counted', mp.length], [`Within ${walk} m`, pct(wIn, w)], ['Furthest (m)', fix(Math.max(...out.map((f) => f.properties.park_m as number)), 0)]] };
    },
  },
  {
    id: 'service-access',
    name: 'Access to services (clinics, schools, markets)',
    summary: 'Travel distance or time from each village or household to the nearest service, over roads and tracks or in straight lines, with the population beyond each threshold.',
    group: RURAL,
    icon: 'home',
    params: [layerP('settlements', 'Villages or households (points)'), layerP('services', 'Services (points)'), layerP('network', 'Roads and tracks (optional)', false), fieldP('speed_field', 'Speed field (km/h)', false), numP('speed_kmh', 'Default speed (km/h, 0 = distance)', 0), fieldP('pop_field', 'Population field (optional)', false), textP('thresholds', 'Thresholds (km or minutes)', '5, 10, 20')],
    run(ctx) {
      const st = need(ctx, 'settlements', 'settlement points').filter((f) => pointOf(f));
      const sv = need(ctx, 'services', 'service points').filter((f) => pointOf(f));
      const pf = str(ctx, 'pop_field');
      const r = nearestCost(ctx, st, sv, 'network', str(ctx, 'speed_field'), num(ctx, 'speed_kmh', 0));
      const scale = r.unit === 'm' ? 1000 : 1, unit = r.unit === 'm' ? 'km' : 'min';
      const th = str(ctx, 'thresholds', '5, 10, 20').split(/[,;\s]+/).map(Number).filter((v) => v > 0).sort((a, b) => a - b);
      let tot = 0;
      const beyond = th.map(() => 0);
      const out = st.map((f, i) => {
        const c = r.costs[i].cost / scale;
        const pop = Number(pf ? f.properties?.[pf] : 1) || 0;
        tot += pop;
        th.forEach((t, k) => { if (!(c <= t)) beyond[k] += pop; });
        return { ...f, properties: { ...(f.properties ?? {}), [`nearest_${unit}`]: Number.isFinite(c) ? Number(c.toFixed(2)) : null, service: r.costs[i].target >= 0 && Number.isFinite(c) ? (sv[r.costs[i].target].properties?.name ?? r.costs[i].target + 1) : null } };
      });
      return { message: `${st.length} settlement(s): ${th.map((t, k) => `${pct(beyond[k], tot)} beyond ${t} ${unit}`).join(', ')}`, layers: [{ name: 'Service access', features: out }], table: th.map((t, k) => [`${pf ? 'Population' : 'Settlements'} beyond ${t} ${unit}`, `${Math.round(beyond[k])} (${pct(beyond[k], tot)})`] as [string, string]) };
    },
  },
  {
    id: 'asset-register',
    name: 'Asset register (age, inspections, risk)',
    summary: 'For each asset (poles, pumps, bridges, culverts, pipes): age and remaining life, the next inspection and whether it is overdue, and a risk score from condition and criticality.',
    group: ASSET,
    icon: 'database',
    params: [layerP('assets', 'Assets'), fieldP('installed_field', 'Installed date or year field', false), numP('life_years', 'Design life (years)', 40), fieldP('inspected_field', 'Last inspection date field', false), numP('interval_months', 'Inspection interval (months)', 12), fieldP('condition_field', 'Condition field (1 very good to 5 very poor)', false), fieldP('criticality_field', 'Criticality field (1 to 5)', false), textP('as_of', 'As of (date, blank = today)', '')],
    run(ctx) {
      const assets = need(ctx, 'assets', 'asset features');
      const now = str(ctx, 'as_of') ? timeOf(str(ctx, 'as_of')) : Date.now();
      const f = (k: string) => str(ctx, k);
      const life = num(ctx, 'life_years', 40), iv = num(ctx, 'interval_months', 12);
      let overdue = 0, never = 0, end = 0;
      const yr = 365.25 * 86400000;
      const out = assets.map((a) => {
        const p = a.properties ?? {};
        const instRaw = f('installed_field') ? p[f('installed_field')] : null;
        const inst = typeof instRaw === 'number' && instRaw < 3000 ? Date.UTC(instRaw, 6, 1) : timeOf(instRaw);
        const age = Number.isFinite(inst) ? (now - inst) / yr : null;
        const last = f('inspected_field') ? timeOf(p[f('inspected_field')]) : NaN;
        const due = Number.isFinite(last) ? new Date(last).setUTCMonth(new Date(last).getUTCMonth() + iv) : NaN;
        const od = Number.isFinite(due) ? due < now : !!f('inspected_field');
        if (od) overdue++;
        if (f('inspected_field') && !Number.isFinite(last)) never++;
        const cond = Number(f('condition_field') ? p[f('condition_field')] : NaN), crit = Number(f('criticality_field') ? p[f('criticality_field')] : NaN);
        const lifeUsed = age == null ? null : age / life;
        if (lifeUsed != null && lifeUsed >= 1) end++;
        const likelihood = Number.isFinite(cond) ? cond : lifeUsed == null ? 3 : Math.min(5, 1 + lifeUsed * 4);
        const risk = likelihood * (Number.isFinite(crit) ? crit : 3);
        return { ...a, properties: { ...p, age_years: age == null ? null : Number(age.toFixed(1)), remaining_years: age == null ? null : Number((life - age).toFixed(1)), next_inspection: Number.isFinite(due) ? new Date(due).toISOString().slice(0, 10) : null, overdue: od, risk: Number(risk.toFixed(1)), risk_class: risk >= 15 ? 'high' : risk >= 8 ? 'medium' : 'low' } };
      });
      const hi = out.filter((a) => a.properties.risk_class === 'high').length;
      return { message: `${out.length} asset(s): ${overdue} inspection(s) overdue, ${end} past design life, ${hi} high risk`, layers: [{ name: 'Asset register', features: out }], table: [['Assets', out.length], ['Inspections overdue', overdue], ['Never inspected', never], ['Past design life', end], ['High risk', hi], ['Medium risk', out.filter((a) => a.properties.risk_class === 'medium').length]] };
    },
  },
  {
    id: 'change-alert',
    name: 'Asset change alerts (compare two snapshots)',
    summary: 'Assets added, removed, moved or with changed attributes between an earlier and a later snapshot of the same layer, matched by id.',
    group: ASSET,
    icon: 'alert',
    params: [layerP('before', 'Earlier snapshot'), layerP('after', 'Later snapshot'), fieldP('id_field', 'Id field', true), textP('fields', 'Attributes to compare (blank = all)', ''), numP('move_m', 'Moved if shifted more than (m)', 1)],
    run(ctx) {
      const a = need(ctx, 'before', 'the earlier layer'), b = need(ctx, 'after', 'the later layer');
      const idf = str(ctx, 'id_field');
      if (!idf) throw new Error('Choose the id field');
      const fields = str(ctx, 'fields').split(',').map((s) => s.trim()).filter(Boolean);
      const mv = num(ctx, 'move_m', 1);
      const m = localMetric([...a, ...b]);
      const A = new Map(a.map((f) => [String(f.properties?.[idf]), f])), B = new Map(b.map((f) => [String(f.properties?.[idf]), f]));
      const out: Feature[] = [];
      const n = { added: 0, removed: 0, moved: 0, changed: 0 };
      for (const [k, f] of B) if (!A.has(k)) { n.added++; out.push({ ...f, properties: { ...(f.properties ?? {}), change: 'added' } }); }
      for (const [k, f] of A) {
        const g = B.get(k);
        if (!g) { n.removed++; out.push({ ...f, properties: { ...(f.properties ?? {}), change: 'removed' } }); continue; }
        const pa = pointOf(f), pb = pointOf(g);
        const shift = pa && pb ? dist(m.fwd(pa), m.fwd(pb)) : 0;
        const keys = fields.length ? fields : [...new Set([...Object.keys(f.properties ?? {}), ...Object.keys(g.properties ?? {})])];
        const diff = keys.filter((x) => String(f.properties?.[x] ?? '') !== String(g.properties?.[x] ?? ''));
        if (shift > mv) n.moved++;
        if (diff.length) n.changed++;
        if (shift > mv || diff.length) out.push({ ...g, properties: { ...(g.properties ?? {}), change: shift > mv && diff.length ? 'moved and changed' : shift > mv ? 'moved' : 'changed', moved_m: Number(shift.toFixed(2)), changed_fields: diff.map((x) => `${x}: ${f.properties?.[x] ?? ''} > ${g.properties?.[x] ?? ''}`).join('; ') } });
      }
      return { message: `${n.added} added, ${n.removed} removed, ${n.moved} moved, ${n.changed} changed`, layers: [{ name: 'Change alerts', features: out }], table: [['Added', n.added], ['Removed', n.removed], ['Moved', n.moved], ['Attributes changed', n.changed], ['Unchanged', A.size - n.removed - out.filter((f) => /moved|changed/.test(String(f.properties!.change))).length]] };
    },
  },
];
export { cellCentre, rasterP };
