// Coordinate reference systems the surveying tools know by EPSG code, without a network lookup:
// WGS84 and UTM, Papua New Guinea (PNG94, PNGMG94, AGD66 and AMG66), Australia (GDA94, GDA2020,
// MGA) and New Zealand (NZGD2000, NZTM). Any other system can be given as a PROJ string or WKT.
import proj4 from 'proj4';

// AGD66 to WGS84, the national seven-parameter set (Position Vector), about 1 m.
const AGD66 = '+ellps=aust_SA +towgs84=-117.808,-51.536,137.784,0.303,0.446,0.234,-0.29';
const utm = (zone: number, south: boolean, datum = '+datum=WGS84') => `+proj=utm +zone=${zone}${south ? ' +south' : ''} ${datum} +units=m +no_defs`;

export const NAMED: Record<string, { name: string; def: string }> = {
  'EPSG:4326': { name: 'WGS 84 (latitude, longitude)', def: '+proj=longlat +datum=WGS84 +no_defs' },
  'EPSG:3857': { name: 'WGS 84 / Pseudo-Mercator', def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs' },
  'EPSG:5546': { name: 'PNG94 (latitude, longitude)', def: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs' },
  'EPSG:5550': { name: 'PNG94 / PNGMG94 zone 54', def: utm(54, true, '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0') },
  'EPSG:5551': { name: 'PNG94 / PNGMG94 zone 55', def: utm(55, true, '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0') },
  'EPSG:5552': { name: 'PNG94 / PNGMG94 zone 56', def: utm(56, true, '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0') },
  'EPSG:4202': { name: 'AGD66 (latitude, longitude)', def: `+proj=longlat ${AGD66} +no_defs` },
  'EPSG:20254': { name: 'AGD66 / AMG zone 54', def: utm(54, true, AGD66) },
  'EPSG:20255': { name: 'AGD66 / AMG zone 55', def: utm(55, true, AGD66) },
  'EPSG:20256': { name: 'AGD66 / AMG zone 56', def: utm(56, true, AGD66) },
  'EPSG:4283': { name: 'GDA94 (latitude, longitude)', def: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs' },
  'EPSG:7844': { name: 'GDA2020 (latitude, longitude)', def: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs' },
  'EPSG:4167': { name: 'NZGD2000 (latitude, longitude)', def: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs' },
  'EPSG:2193': { name: 'NZGD2000 / New Zealand Transverse Mercator 2000', def: '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
};
for (let z = 49; z <= 56; z++) {
  NAMED[`EPSG:${28300 + z}`] = { name: `GDA94 / MGA zone ${z}`, def: utm(z, true, '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0') };
  NAMED[`EPSG:${7800 + z}`] = { name: `GDA2020 / MGA zone ${z}`, def: utm(z, true, '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0') };
}

/** a PROJ definition for an EPSG code, a PROJ string or WKT */
export function crsDef(text: string): { code: string; name: string; def: string } {
  const t = text.trim();
  if (!t) throw new Error('Give a coordinate system (an EPSG code such as EPSG:32755, or a PROJ string)');
  const m = /^(?:epsg:?\s*)?(\d{4,5})$/i.exec(t);
  if (m) {
    const code = `EPSG:${m[1]}`;
    const n = Number(m[1]);
    if (NAMED[code]) return { code, ...NAMED[code] };
    if (n >= 32601 && n <= 32660) return { code, name: `WGS 84 / UTM zone ${n - 32600}N`, def: utm(n - 32600, false) };
    if (n >= 32701 && n <= 32760) return { code, name: `WGS 84 / UTM zone ${n - 32700}S`, def: utm(n - 32700, true) };
    throw new Error(`${code} is not in the built-in list; give its PROJ string instead (from epsg.io)`);
  }
  if (t.startsWith('+proj') || /^(PROJCS|GEOGCS|PROJCRS|GEOGCRS)\[/i.test(t)) return { code: 'custom', name: 'custom', def: t };
  throw new Error(`'${t}' is not an EPSG code, a PROJ string or WKT`);
}
export const isGeographic = (def: string) => /\+proj=longlat|^GEOGCS|^GEOGCRS/i.test(def);
export function converter(from: string, to: string) {
  const a = crsDef(from), b = crsDef(to);
  const c = proj4(a.def, b.def);
  return { from: a, to: b, forward: (p: number[]) => c.forward([p[0], p[1]]) as [number, number], inverse: (p: number[]) => c.inverse([p[0], p[1]]) as [number, number] };
}
/** the WGS 84 UTM zone (EPSG) for a longitude and latitude */
export const utmFor = (lon: number, lat: number) => `EPSG:${lat < 0 ? 327 : 326}${String(Math.floor((lon + 180) / 6) + 1).padStart(2, '0')}`;
