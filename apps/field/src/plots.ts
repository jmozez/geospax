// Survey plots and transects: a circle or square laid out around where you stand, and a line on a
// bearing with stations every so many metres to walk to in turn.

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The point a distance (m) away on a bearing (degrees from north), on the sphere. */
export function dest(lon: number, lat: number, bearing: number, m: number): [number, number] {
  const d = m / R, b = rad(bearing), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((deg(l2) + 540) % 360) - 180, deg(p2)];
}

export type Shape = 'circle' | 'square';
/** Standard plot sizes: a radius for circles, a side for squares (m), with the area each covers. */
export const SIZES: Record<Shape, number[]> = { circle: [5.64, 11.28, 12.62, 17.84], square: [10, 20, 50, 100] };
export const plotArea = (shape: Shape, size: number) => (shape === 'circle' ? Math.PI * size * size : size * size);

/** The outline of a plot centred on a point (open ring, first vertex not repeated). Squares turn with `rot`. */
export function plot(lon: number, lat: number, shape: Shape, size: number, rot = 0): [number, number][] {
  if (!(size > 0)) throw new Error('A plot needs a size.');
  if (shape === 'circle') return Array.from({ length: 48 }, (_, i) => dest(lon, lat, (i * 360) / 48, size));
  const h = (size / 2) * Math.SQRT2;
  return [45, 135, 225, 315].map((b) => dest(lon, lat, b + rot, h));
}

export interface Transect { line: [number, number][]; stations: { at: [number, number]; m: number }[] }
/** A transect from a start along a bearing, with a station at the start and every `every` metres to the end. */
export function transect(lon: number, lat: number, bearing: number, length: number, every: number): Transect {
  if (!(length > 0)) throw new Error('A transect needs a length.');
  if (!(every > 0)) throw new Error('Stations need a spacing.');
  if (length / every > 500) throw new Error('That is more than 500 stations; space them further apart.');
  const stations: Transect['stations'] = [];
  for (let m = 0; m < length - 1e-6; m += every) stations.push({ at: m === 0 ? [lon, lat] : dest(lon, lat, bearing, m), m: Math.round(m * 100) / 100 });
  const end = dest(lon, lat, bearing, length);
  stations.push({ at: end, m: length });
  return { line: [[lon, lat], end], stations };
}
