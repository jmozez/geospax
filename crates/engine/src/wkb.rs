//! Minimal WKB reader (ISO + extended/EWKB flags, both byte orders).
//!
//! GDAL hands us one WKB blob per feature (a single FFI call); parsing it in
//! Rust is much cheaper than walking the geometry vertex-by-vertex over FFI.
//! Geometry collections are flattened to their highest dimension.

#[derive(Debug, Clone, PartialEq)]
pub enum Geom {
    Empty,
    /// One feature may hold many points (MultiPoint).
    Points(Vec<[f64; 2]>),
    Lines(Vec<Vec<[f64; 2]>>),
    /// polygons -> rings (first = exterior) -> coordinates
    Polygons(Vec<Vec<Vec<[f64; 2]>>>),
}

#[derive(Debug)]
pub enum WkbError {
    Truncated,
    Unsupported(u32),
}

impl std::fmt::Display for WkbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WkbError::Truncated => write!(f, "truncated WKB"),
            WkbError::Unsupported(t) => write!(f, "unsupported WKB geometry type {t}"),
        }
    }
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    #[inline]
    fn take<const N: usize>(&mut self) -> Result<[u8; N], WkbError> {
        let s = self.b.get(self.p..self.p + N).ok_or(WkbError::Truncated)?;
        self.p += N;
        Ok(s.try_into().unwrap())
    }
    #[inline]
    fn u8(&mut self) -> Result<u8, WkbError> {
        Ok(self.take::<1>()?[0])
    }
    #[inline]
    fn u32(&mut self, le: bool) -> Result<u32, WkbError> {
        let a = self.take::<4>()?;
        Ok(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    }
    #[inline]
    fn f64(&mut self, le: bool) -> Result<f64, WkbError> {
        let a = self.take::<8>()?;
        Ok(if le { f64::from_le_bytes(a) } else { f64::from_be_bytes(a) })
    }
    #[inline]
    fn skip(&mut self, n: usize) -> Result<(), WkbError> {
        if self.p + n > self.b.len() {
            return Err(WkbError::Truncated);
        }
        self.p += n;
        Ok(())
    }
}

#[derive(Default)]
struct Acc {
    points: Vec<[f64; 2]>,
    lines: Vec<Vec<[f64; 2]>>,
    polys: Vec<Vec<Vec<[f64; 2]>>>,
}

/// Parse a WKB blob into lon/lat (or source-CRS) coordinates.
pub fn parse(buf: &[u8]) -> Result<Geom, WkbError> {
    let mut r = Reader { b: buf, p: 0 };
    let mut acc = Acc::default();
    read_geometry(&mut r, &mut acc)?;
    Ok(if !acc.polys.is_empty() {
        Geom::Polygons(acc.polys)
    } else if !acc.lines.is_empty() {
        Geom::Lines(acc.lines)
    } else if !acc.points.is_empty() {
        Geom::Points(acc.points)
    } else {
        Geom::Empty
    })
}

fn read_coords(r: &mut Reader, le: bool, extra: usize, n: usize) -> Result<Vec<[f64; 2]>, WkbError> {
    // Guard against absurd counts in corrupt blobs before allocating.
    if n.saturating_mul(16 + extra) > r.b.len().saturating_sub(r.p) {
        return Err(WkbError::Truncated);
    }
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        let x = r.f64(le)?;
        let y = r.f64(le)?;
        r.skip(extra)?;
        v.push([x, y]);
    }
    Ok(v)
}

fn read_geometry(r: &mut Reader, acc: &mut Acc) -> Result<(), WkbError> {
    let le = r.u8()? == 1;
    let raw = r.u32(le)?;
    let mut has_z = raw & 0x8000_0000 != 0; // EWKB Z flag (also OGR 2.5D)
    let mut has_m = raw & 0x4000_0000 != 0; // EWKB M flag
    let has_srid = raw & 0x2000_0000 != 0; // EWKB SRID flag
    let t = raw & 0x0FFF_FFFF;
    let (base, iso) = (t % 1000, t / 1000);
    match iso {
        1 => has_z = true,
        2 => has_m = true,
        3 => {
            has_z = true;
            has_m = true
        }
        _ => {}
    }
    if has_srid {
        r.u32(le)?;
    }
    let extra = 8 * (has_z as usize + has_m as usize);
    match base {
        1 => {
            let x = r.f64(le)?;
            let y = r.f64(le)?;
            r.skip(extra)?;
            if !(x.is_nan() || y.is_nan()) {
                acc.points.push([x, y]); // NaN coordinates encode POINT EMPTY
            }
        }
        2 => {
            let n = r.u32(le)? as usize;
            let line = read_coords(r, le, extra, n)?;
            if line.len() >= 2 {
                acc.lines.push(line);
            }
        }
        3 => {
            let nrings = r.u32(le)? as usize;
            let mut rings = Vec::with_capacity(nrings.min(1024));
            for _ in 0..nrings {
                let n = r.u32(le)? as usize;
                rings.push(read_coords(r, le, extra, n)?);
            }
            if !rings.is_empty() && rings[0].len() >= 4 {
                acc.polys.push(rings);
            }
        }
        4..=7 => {
            let n = r.u32(le)? as usize;
            for _ in 0..n {
                read_geometry(r, acc)?;
            }
        }
        other => return Err(WkbError::Unsupported(other)),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn le_point(x: f64, y: f64) -> Vec<u8> {
        let mut b = vec![1u8];
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&x.to_le_bytes());
        b.extend_from_slice(&y.to_le_bytes());
        b
    }

    #[test]
    fn point_both_endians() {
        assert_eq!(parse(&le_point(1.5, -2.0)).unwrap(), Geom::Points(vec![[1.5, -2.0]]));
        let mut be = vec![0u8];
        be.extend_from_slice(&1u32.to_be_bytes());
        be.extend_from_slice(&3.0f64.to_be_bytes());
        be.extend_from_slice(&4.0f64.to_be_bytes());
        assert_eq!(parse(&be).unwrap(), Geom::Points(vec![[3.0, 4.0]]));
    }

    #[test]
    fn iso_z_polygon_and_multipoint() {
        // POLYGON Z with one ring of 4 points
        let mut b = vec![1u8];
        b.extend_from_slice(&1003u32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&4u32.to_le_bytes());
        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)] {
            for v in [x, y, 9.0f64] {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        match parse(&b).unwrap() {
            Geom::Polygons(p) => assert_eq!(p[0][0][2], [1.0, 1.0]),
            g => panic!("{g:?}"),
        }
        let mut mp = vec![1u8];
        mp.extend_from_slice(&4u32.to_le_bytes());
        mp.extend_from_slice(&2u32.to_le_bytes());
        mp.extend(le_point(1.0, 2.0));
        mp.extend(le_point(3.0, 4.0));
        assert_eq!(parse(&mp).unwrap(), Geom::Points(vec![[1.0, 2.0], [3.0, 4.0]]));
    }

    #[test]
    fn truncated_is_error() {
        assert!(parse(&le_point(1.0, 2.0)[..10]).is_err());
    }
}
