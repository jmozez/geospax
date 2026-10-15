//! Web Mercator tile math (XYZ / slippy-map scheme, y down).

use std::f64::consts::PI;

pub const MAX_LAT: f64 = 85.051_128_779_806_59;

/// Lon/lat bounds of tile z/x/y: [west, south, east, north].
pub fn tile_bounds(z: u8, x: u32, y: u32) -> [f64; 4] {
    let n = (1u64 << z) as f64;
    let lon = |x: f64| x / n * 360.0 - 180.0;
    let lat = |y: f64| (PI * (1.0 - 2.0 * y / n)).sinh().atan().to_degrees();
    [lon(x as f64), lat(y as f64 + 1.0), lon(x as f64 + 1.0), lat(y as f64)]
}

/// Tile containing lon/lat at zoom z.
pub fn lonlat_to_tile(lon: f64, lat: f64, z: u8) -> (u32, u32) {
    let n = (1u64 << z) as f64;
    let lat = lat.clamp(-MAX_LAT, MAX_LAT).to_radians();
    let x = ((lon + 180.0) / 360.0 * n).floor();
    let y = ((1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / PI) / 2.0 * n).floor();
    let max = n - 1.0;
    (x.clamp(0.0, max) as u32, y.clamp(0.0, max) as u32)
}

/// Number of tiles at zoom z touching a lon/lat bbox.
pub fn tiles_covering(b: [f64; 4], z: u8) -> u64 {
    let (x0, y0) = lonlat_to_tile(b[0], b[3], z);
    let (x1, y1) = lonlat_to_tile(b[2], b[1], z);
    (x1.saturating_sub(x0) as u64 + 1) * (y1.saturating_sub(y0) as u64 + 1)
}

pub fn intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

/// Projects lon/lat straight into tile-local coordinates (0..extent, y down).
pub struct TileProjector {
    scale: f64,
    ox: f64,
    oy: f64,
}

impl TileProjector {
    pub fn new(z: u8, x: u32, y: u32, extent: u32) -> Self {
        let scale = (1u64 << z) as f64 * extent as f64;
        TileProjector { scale, ox: x as f64 * extent as f64, oy: y as f64 * extent as f64 }
    }

    #[inline]
    pub fn project(&self, lon: f64, lat: f64) -> [f64; 2] {
        let s = lat.clamp(-MAX_LAT, MAX_LAT).to_radians().sin();
        let xw = (lon + 180.0) / 360.0;
        let yw = 0.5 - ((1.0 + s) / (1.0 - s)).ln() / (4.0 * PI);
        [xw * self.scale - self.ox, yw * self.scale - self.oy]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_tile_bounds() {
        let b = tile_bounds(0, 0, 0);
        assert!((b[0] + 180.0).abs() < 1e-9 && (b[3] - MAX_LAT).abs() < 1e-6);
        let (x, y) = lonlat_to_tile(144.23, -5.86, 12);
        let tb = tile_bounds(12, x, y);
        assert!(tb[0] <= 144.23 && 144.23 <= tb[2] && tb[1] <= -5.86 && -5.86 <= tb[3]);
    }

    #[test]
    fn projector_maps_tile_corners() {
        let (z, x, y) = (10, 922, 528);
        let b = tile_bounds(z, x, y);
        let p = TileProjector::new(z, x, y, 4096);
        let nw = p.project(b[0], b[3]);
        let se = p.project(b[2], b[1]);
        assert!(nw[0].abs() < 1e-6 && nw[1].abs() < 1e-6, "{nw:?}");
        assert!((se[0] - 4096.0).abs() < 1e-6 && (se[1] - 4096.0).abs() < 1e-6, "{se:?}");
    }
}
