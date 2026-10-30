//! 3D scenes (docs/AUTOMATION.md §6d): a terrain mesh from a DEM with a draped texture, extruded
//! buildings, modelled trees and a point-cloud sample, written three ways:
//!
//! * **glTF 2.0 binary** (`.glb`): opens in Blender, Windows 3D Viewer, ArcGIS Pro, CesiumJS,
//!   three.js and most 3D tools; the georeference is in `asset.extras.geospax`;
//! * a **self-contained interactive viewer** (`.html`): WebGL, the model embedded, no network;
//! * a **still perspective view** (`.png`) from a small software rasteriser, so reports get a 3D
//!   picture on machines without a GPU.
//!
//! Coordinates are metres east/north/up from `Scene::origin` (in the DEM's projected CRS); glTF gets
//! them as X = east, Y = up, Z = south. Lighting is baked into the colours with the hillshade's sun
//! (north-west, 45° up) and every material is unlit, so the scene looks the same in every viewer.
//! Terrain heights may be exaggerated; buildings and trees keep their true heights on top.

use serde_json::{Value, json};

/// Vertices per primitive, so indices fit in 16 bits (65,535 is reserved by glTF).
pub const MAX_VERTS: usize = 65_535;
/// Unit vector towards the sun (east, north, up): north-west, 45° up.
const SUN: [f64; 3] = [-0.5, 0.5, std::f64::consts::FRAC_1_SQRT_2];
const VIEWER: &str = include_str!("../assets/scene-viewer.html");
/// The CSP hash source of the viewer's one inline script. The app shows a scene in a sandboxed srcdoc
/// frame, which inherits the app's Content-Security-Policy (no inline scripts), so the web server and
/// the desktop app (tauri.conf.json) allow exactly this script. The test `viewer_script_hash_is_allowed`
/// fails when the viewer changes and this hash, the server CSP or tauri.conf.json is not updated.
pub const VIEWER_SCRIPT_CSP: &str = "'sha256-CukmEDrXQ+NcquTHa0xtWUz1SXEI/xQOC6exFB3iaf0='";

// ------------------------------------------------------------------ geometry containers

#[derive(Clone, Debug)]
pub struct Prim {
    /// viewer toggle: terrain, buildings, trees, points
    pub group: &'static str,
    /// mesh name in the glTF
    pub name: &'static str,
    /// east, north, up (metres from the origin; terrain heights exaggerated)
    pub pos: Vec<[f32; 3]>,
    /// baked colour per vertex (empty when textured)
    pub col: Vec<[u8; 4]>,
    pub uv: Vec<[f32; 2]>,
    pub idx: Vec<u16>,
    pub points: bool,
    pub texture: Option<usize>,
}

impl Prim {
    fn new(group: &'static str, name: &'static str) -> Prim {
        Prim {
            group,
            name,
            pos: vec![],
            col: vec![],
            uv: vec![],
            idx: vec![],
            points: false,
            texture: None,
        }
    }

    pub fn triangles(&self) -> usize {
        self.idx.len() / 3
    }
}

/// Collects geometry for one mesh, starting a new primitive before one passes 65,535 vertices.
struct Acc {
    cur: Prim,
    out: Vec<Prim>,
}

impl Acc {
    fn new(group: &'static str, name: &'static str) -> Acc {
        Acc {
            cur: Prim::new(group, name),
            out: vec![],
        }
    }

    /// Room for `n` more vertices; returns the index the next vertex gets.
    fn reserve(&mut self, n: usize) -> u16 {
        if self.cur.pos.len() + n > MAX_VERTS {
            let next = Prim::new(self.cur.group, self.cur.name);
            self.out.push(std::mem::replace(&mut self.cur, next));
        }
        self.cur.pos.len() as u16
    }

    fn vert(&mut self, p: [f64; 3], c: [u8; 4]) {
        self.cur.pos.push([p[0] as f32, p[1] as f32, p[2] as f32]);
        self.cur.col.push(c);
    }

    fn tri(&mut self, a: u16, b: u16, c: u16) {
        self.cur.idx.extend([a, b, c]);
    }

    fn finish(mut self) -> Vec<Prim> {
        if !self.cur.pos.is_empty() {
            self.out.push(self.cur);
        }
        self.out
    }
}

/// RGB image draped over the terrain (row 0 = north edge of the DEM).
#[derive(Clone, Debug)]
pub struct Texture {
    pub w: usize,
    pub h: usize,
    pub rgb: Vec<u8>,
}

impl Texture {
    pub fn jpeg(&self, quality: u8) -> Result<Vec<u8>, String> {
        jpeg_bytes(&self.rgb, self.w, self.h, quality)
    }

    fn sample(&self, u: f32, v: f32) -> [f32; 3] {
        let x = (u * self.w as f32 - 0.5).clamp(0.0, (self.w - 1) as f32);
        let y = (v * self.h as f32 - 0.5).clamp(0.0, (self.h - 1) as f32);
        let (x0, y0) = (x as usize, y as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let px = |xx: usize, yy: usize, k: usize| self.rgb[(yy * self.w + xx) * 3 + k] as f32;
        [0, 1, 2].map(|k| {
            let top = px(x0, y0, k) * (1.0 - fx) + px(x1, y0, k) * fx;
            let bot = px(x0, y1, k) * (1.0 - fx) + px(x1, y1, k) * fx;
            (top * (1.0 - fy) + bot * fy) / 255.0
        })
    }
}

pub fn jpeg_bytes(rgb: &[u8], w: usize, h: usize, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut out, quality);
    enc.encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("JPEG: {e}"))?;
    Ok(out)
}

// ------------------------------------------------------------------ elevation

/// A north-up elevation grid in a projected CRS (metres); NaN = no data.
#[derive(Clone, Debug)]
pub struct Dem {
    pub z: Vec<f32>,
    pub w: usize,
    pub h: usize,
    /// GDAL geotransform (north-up: gt[2] = gt[4] = 0)
    pub gt: [f64; 6],
}

impl Dem {
    pub fn cell(&self) -> (f64, f64) {
        (self.gt[1].abs(), self.gt[5].abs())
    }

    /// [west, south, east, north]
    pub fn extent(&self) -> [f64; 4] {
        let (cx, cy) = self.cell();
        [
            self.gt[0],
            self.gt[3] - cy * self.h as f64,
            self.gt[0] + cx * self.w as f64,
            self.gt[3],
        ]
    }

    pub fn range(&self) -> Option<(f32, f32)> {
        let mut r: Option<(f32, f32)> = None;
        for v in self.z.iter().filter(|v| v.is_finite()) {
            r = Some(match r {
                None => (*v, *v),
                Some((a, b)) => (a.min(*v), b.max(*v)),
            });
        }
        r
    }

    /// Value at fractional pixel coordinates (pixel centres at i + 0.5), bilinear, NaN-aware.
    pub fn bilinear(&self, u: f64, v: f64) -> f32 {
        bilinear_nan(&self.z, self.w, self.h, u - 0.5, v - 0.5)
    }

    /// Resample to `tw` × `th` cells covering the same extent: box filter when shrinking, bilinear
    /// otherwise. Values are at the new cell centres.
    pub fn resample(&self, tw: usize, th: usize) -> Vec<f32> {
        let (sx, sy) = (self.w as f64 / tw as f64, self.h as f64 / th as f64);
        let mut out = vec![f32::NAN; tw * th];
        for j in 0..th {
            for i in 0..tw {
                out[j * tw + i] = if sx > 1.5 || sy > 1.5 {
                    let (a0, a1) = (
                        (i as f64 * sx) as usize,
                        (((i + 1) as f64 * sx).ceil() as usize).min(self.w),
                    );
                    let (b0, b1) = (
                        (j as f64 * sy) as usize,
                        (((j + 1) as f64 * sy).ceil() as usize).min(self.h),
                    );
                    let (mut s, mut n) = (0.0f64, 0u32);
                    for y in b0..b1.max(b0 + 1).min(self.h) {
                        for x in a0..a1.max(a0 + 1).min(self.w) {
                            let v = self.z[y * self.w + x];
                            if v.is_finite() {
                                s += v as f64;
                                n += 1;
                            }
                        }
                    }
                    if n > 0 {
                        (s / n as f64) as f32
                    } else {
                        f32::NAN
                    }
                } else {
                    self.bilinear((i as f64 + 0.5) * sx, (j as f64 + 0.5) * sy)
                };
            }
        }
        out
    }
}

/// Bilinear interpolation at grid coordinates (x, y) where integer values are cell centres;
/// missing neighbours are skipped and the weights renormalised.
fn bilinear_nan(z: &[f32], w: usize, h: usize, x: f64, y: f64) -> f32 {
    let x = x.clamp(0.0, (w - 1) as f64);
    let y = y.clamp(0.0, (h - 1) as f64);
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (x - x0 as f64, y - y0 as f64);
    let (mut s, mut ws) = (0.0, 0.0);
    for (xx, yy, wt) in [
        (x0, y0, (1.0 - fx) * (1.0 - fy)),
        (x1, y0, fx * (1.0 - fy)),
        (x0, y1, (1.0 - fx) * fy),
        (x1, y1, fx * fy),
    ] {
        let v = z[yy * w + xx];
        if v.is_finite() && wt > 0.0 {
            s += v as f64 * wt;
            ws += wt;
        }
    }
    if ws > 1e-9 {
        (s / ws) as f32
    } else {
        // all four corners missing (or zero weight on the valid ones): nearest valid corner
        [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
            .iter()
            .map(|(a, b)| z[b * w + a])
            .find(|v| v.is_finite())
            .unwrap_or(f32::NAN)
    }
}

/// Relief shading 0..1 (Horn's method, sun from `azimuth`° at `altitude`°); missing cells get 0.7.
pub fn hillshade(
    z: &[f32],
    w: usize,
    h: usize,
    cell_x: f64,
    cell_y: f64,
    zfactor: f64,
    azimuth: f64,
    altitude: f64,
) -> Vec<f32> {
    let az = (360.0 - azimuth + 90.0).to_radians();
    let zen = (90.0 - altitude).to_radians();
    let at = |x: isize, y: isize, c: f32| -> f64 {
        let (xx, yy) = (
            x.clamp(0, w as isize - 1) as usize,
            y.clamp(0, h as isize - 1) as usize,
        );
        let v = z[yy * w + xx];
        if v.is_finite() { v as f64 } else { c as f64 }
    };
    let mut out = vec![0.7f32; w * h];
    for y in 0..h as isize {
        for x in 0..w as isize {
            let c = z[y as usize * w + x as usize];
            if !c.is_finite() {
                continue;
            }
            let (a, b, cc) = (at(x - 1, y - 1, c), at(x, y - 1, c), at(x + 1, y - 1, c));
            let (d, f) = (at(x - 1, y, c), at(x + 1, y, c));
            let (g, hh, i) = (at(x - 1, y + 1, c), at(x, y + 1, c), at(x + 1, y + 1, c));
            let dzdx = ((cc + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * cell_x) * zfactor;
            let dzdy = ((g + 2.0 * hh + i) - (a + 2.0 * b + cc)) / (8.0 * cell_y) * zfactor;
            let slope = (dzdx * dzdx + dzdy * dzdy).sqrt().atan();
            let aspect = if dzdx != 0.0 {
                let mut a = dzdy.atan2(-dzdx);
                if a < 0.0 {
                    a += 2.0 * std::f64::consts::PI;
                }
                a
            } else if dzdy > 0.0 {
                std::f64::consts::FRAC_PI_2
            } else if dzdy < 0.0 {
                1.5 * std::f64::consts::PI
            } else {
                0.0
            };
            let v = zen.cos() * slope.cos() + zen.sin() * slope.sin() * (az - aspect).cos();
            out[y as usize * w + x as usize] = v.clamp(0.0, 1.0) as f32;
        }
    }
    out
}

/// Vertical exaggeration that makes relief readable: aims for relief ≈ 10 % of the scene width,
/// at most 1.5× for detailed surveys (cells under 5 m, where buildings and trees carry the scene)
/// and 3× for regional DEMs; in half steps.
pub fn auto_exaggeration(extent_m: f64, relief_m: f64, cell_m: f64) -> f64 {
    let kmax = if cell_m < 5.0 { 1.5 } else { 3.0 };
    let ratio = relief_m.max(0.1) / extent_m.max(1.0);
    let k = (0.10 / ratio).clamp(1.0, kmax);
    (k * 2.0).round() / 2.0
}

/// Baked light for a surface colour (0..1) facing `n` (unit, east/north/up).
pub fn lit(c: [f64; 3], n: [f64; 3], ambient: f64) -> [u8; 4] {
    let d = (n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]).max(0.0);
    let sky = 0.08 * (n[2] * 0.5 + 0.5);
    let s = ambient + (1.0 - ambient) * d + sky;
    [
        ((c[0] * s).clamp(0.0, 1.0) * 255.0).round() as u8,
        ((c[1] * s).clamp(0.0, 1.0) * 255.0).round() as u8,
        ((c[2] * s).clamp(0.0, 1.0) * 255.0).round() as u8,
        255,
    ]
}

/// Ground shading factor for a hillshade value (matches `lit` on a surface lit by the same sun).
pub fn shade_factor(hs: f32) -> f32 {
    (0.40 + 0.60 * hs + 0.08).min(1.0)
}

fn hash01(a: f64, b: f64) -> f64 {
    let mut h = (a.to_bits() ^ b.to_bits().rotate_left(29)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= h >> 31;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 29;
    (h % 10_000) as f64 / 10_000.0
}

// ------------------------------------------------------------------ the scene

/// The terrain mesh's vertex grid: lets objects stand exactly on the drawn surface.
#[derive(Clone, Debug)]
pub struct Surface {
    pub w: usize,
    pub h: usize,
    /// local x of column 0 and local y of row 0 (the north row)
    pub x0: f64,
    pub y0: f64,
    pub dx: f64,
    pub dy: f64,
    /// scene heights (exaggerated, from the base)
    pub z: Vec<f32>,
    /// true heights (metres)
    pub zt: Vec<f32>,
}

impl Surface {
    fn grid_xy(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let (u, v) = ((x - self.x0) / self.dx, (self.y0 - y) / self.dy);
        (u >= -0.5 && v >= -0.5 && u <= self.w as f64 - 0.5 && v <= self.h as f64 - 0.5)
            .then_some((u, v))
    }

    /// Scene height of the drawn terrain at local (x, y); None outside it or over no data.
    pub fn at(&self, x: f64, y: f64) -> Option<f64> {
        let (u, v) = self.grid_xy(x, y)?;
        let z = bilinear_nan(&self.z, self.w, self.h, u, v);
        z.is_finite().then_some(z as f64)
    }

    /// True ground height (metres) at local (x, y).
    pub fn true_at(&self, x: f64, y: f64) -> Option<f64> {
        let (u, v) = self.grid_xy(x, y)?;
        let z = bilinear_nan(&self.zt, self.w, self.h, u, v);
        z.is_finite().then_some(z as f64)
    }
}

pub struct Footprint {
    /// exterior ring first, then holes; CRS coordinates
    pub rings: Vec<Vec<[f64; 2]>>,
    pub height: f64,
}

pub struct TreeIn {
    pub x: f64,
    pub y: f64,
    pub height: f64,
    /// crown width (diameter), metres
    pub crown: f64,
}

pub struct PointIn {
    pub x: f64,
    pub y: f64,
    /// metres
    pub z: f64,
    pub rgb: [u8; 3],
}

pub struct Scene {
    pub prims: Vec<Prim>,
    pub textures: Vec<Texture>,
    /// CRS x, y of the local origin and the base height (metres) that maps to z = 0
    pub origin: [f64; 3],
    pub exaggeration: f64,
    pub surface: Surface,
    /// width, depth of the terrain (metres) and its true relief
    pub size_m: [f64; 2],
    pub relief: f64,
    pub mesh: [usize; 2],
}

pub struct Rendered {
    pub rgba: Vec<u8>,
    pub w: usize,
    pub h: usize,
    /// direction of north on the picture, degrees clockwise from up (at the scene centre)
    pub north: f64,
}

pub struct View {
    /// compass bearing from the scene to the camera (200 = from the south-south-west)
    pub azimuth: f64,
    /// camera height above the horizon, degrees
    pub elevation: f64,
    pub width: usize,
    pub height: usize,
    /// vertical field of view, degrees
    pub fov: f64,
    /// draw the point cloud too (off when there is a model: points would speckle it)
    pub points: bool,
}

impl Default for View {
    fn default() -> Self {
        View {
            azimuth: 200.0,
            elevation: 35.0,
            width: 1600,
            height: 1000,
            fov: 30.0,
            points: false,
        }
    }
}

/// Signed area (positive = counter-clockwise).
fn ring_area(r: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..r.len() {
        let (p, q) = (r[i], r[(i + 1) % r.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-12);
    [v[0] / l, v[1] / l, v[2] / l]
}

impl Scene {
    /// Terrain mesh (at most `grid` vertices along the longer side) with `texture` draped over the
    /// DEM's extent, plus earth-coloured sides down to a base (a block diagram).
    pub fn terrain(dem: &Dem, grid: usize, k: f64, texture: Texture) -> Result<Scene, String> {
        let (zlo, zhi) = dem.range().ok_or("the DEM has no data")?;
        let s = (dem.w.max(dem.h) as f64 / grid.max(8) as f64).max(1.0);
        let mw = ((dem.w as f64 / s).round() as usize).max(2);
        let mh = ((dem.h as f64 / s).round() as usize).max(2);
        let zt = if mw == dem.w && mh == dem.h {
            dem.z.clone()
        } else {
            dem.resample(mw, mh)
        };
        let ext = dem.extent();
        let (dx, dy) = ((ext[2] - ext[0]) / mw as f64, (ext[3] - ext[1]) / mh as f64);
        let origin = [
            ((ext[0] + ext[2]) / 2.0).round(),
            ((ext[1] + ext[3]) / 2.0).round(),
            (zlo as f64).floor(),
        ];
        let x0 = ext[0] + dx / 2.0 - origin[0];
        let y0 = ext[3] - dy / 2.0 - origin[1];
        let z: Vec<f32> = zt
            .iter()
            .map(|v| {
                if v.is_finite() {
                    ((*v as f64 - origin[2]) * k) as f32
                } else {
                    f32::NAN
                }
            })
            .collect();
        let surface = Surface {
            w: mw,
            h: mh,
            x0,
            y0,
            dx,
            dy,
            z,
            zt,
        };
        let mut prims = Vec::new();

        // the surface, in bands of rows that share their edge row
        let rows_per = (MAX_VERTS / mw).max(2);
        let mut r0 = 0usize;
        while r0 + 1 < mh {
            let r1 = (r0 + rows_per - 1).min(mh - 1);
            let mut p = Prim::new("terrain", "Terrain");
            p.texture = Some(0);
            for j in r0..=r1 {
                for i in 0..mw {
                    let zz = surface.z[j * mw + i];
                    p.pos.push([
                        (x0 + i as f64 * dx) as f32,
                        (y0 - j as f64 * dy) as f32,
                        if zz.is_finite() { zz } else { 0.0 },
                    ]);
                    p.uv.push([(i as f32 + 0.5) / mw as f32, (j as f32 + 0.5) / mh as f32]);
                }
            }
            for j in r0..r1 {
                for i in 0..mw - 1 {
                    let (a, b, c, d) = (
                        j * mw + i,
                        j * mw + i + 1,
                        (j + 1) * mw + i,
                        (j + 1) * mw + i + 1,
                    );
                    if [a, b, c, d].iter().any(|q| !surface.z[*q].is_finite()) {
                        continue;
                    }
                    let l = |q: usize| (q - r0 * mw) as u16;
                    // counter-clockwise seen from above: (sw, se, ne), (sw, ne, nw)
                    p.idx.extend([l(c), l(d), l(b), l(c), l(b), l(a)]);
                }
            }
            prims.push(p);
            r0 = r1;
        }

        // sides: a wall under every edge where the drawn surface stops (the grid border, or the
        // edge of the data for irregular surveys), each facing away from the surface
        let relief_scene = ((zhi - zlo) as f64 * k).max(0.0);
        let width = ext[2] - ext[0];
        let depth = ext[3] - ext[1];
        let floor = -(0.03 * width.max(depth) + 0.15 * relief_scene).max(1.0);
        let solid = |i: isize, j: isize| -> bool {
            if i < 0 || j < 0 || i as usize + 1 >= mw || j as usize + 1 >= mh {
                return false;
            }
            let (i, j) = (i as usize, j as usize);
            [(i, j), (i + 1, j), (i, j + 1), (i + 1, j + 1)]
                .iter()
                .all(|(a, b)| surface.z[b * mw + a].is_finite())
        };
        let mut acc = Acc::new("terrain", "Terrain sides");
        let soil_top = [0.66, 0.55, 0.42];
        let soil_bot = [0.45, 0.36, 0.28];
        for j in 0..mh.saturating_sub(1) {
            for i in 0..mw.saturating_sub(1) {
                let (ii, jj) = (i as isize, j as isize);
                if !solid(ii, jj) {
                    continue;
                }
                // (from, to) vertices walking counter-clockwise around the solid quad
                let mut edges: Vec<((usize, usize), (usize, usize))> = Vec::new();
                if !solid(ii, jj + 1) {
                    edges.push(((i, j + 1), (i + 1, j + 1))); // south side, west → east
                }
                if !solid(ii + 1, jj) {
                    edges.push(((i + 1, j + 1), (i + 1, j))); // east side, south → north
                }
                if !solid(ii, jj - 1) {
                    edges.push(((i + 1, j), (i, j))); // north side, east → west
                }
                if !solid(ii - 1, jj) {
                    edges.push(((i, j), (i, j + 1))); // west side, north → south
                }
                for ((ia, ja), (ib, jb)) in edges {
                    let (za, zb) = (
                        surface.z[ja * mw + ia] as f64,
                        surface.z[jb * mw + ib] as f64,
                    );
                    let pa = [x0 + ia as f64 * dx, y0 - ja as f64 * dy];
                    let pb = [x0 + ib as f64 * dx, y0 - jb as f64 * dy];
                    let n = normalize([pb[1] - pa[1], -(pb[0] - pa[0]), 0.0]);
                    let top = lit(soil_top, n, 0.62);
                    let bot = lit(soil_bot, n, 0.62);
                    let v = acc.reserve(4);
                    acc.vert([pa[0], pa[1], floor], bot);
                    acc.vert([pb[0], pb[1], floor], bot);
                    acc.vert([pb[0], pb[1], zb], top);
                    acc.vert([pa[0], pa[1], za], top);
                    acc.tri(v, v + 1, v + 2);
                    acc.tri(v, v + 2, v + 3);
                }
            }
        }
        prims.extend(acc.finish());
        Ok(Scene {
            prims,
            textures: vec![texture],
            origin,
            exaggeration: k,
            surface,
            size_m: [width, depth],
            relief: (zhi - zlo) as f64,
            mesh: [mw, mh],
        })
    }

    fn local(&self, p: [f64; 2]) -> [f64; 2] {
        [p[0] - self.origin[0], p[1] - self.origin[1]]
    }

    /// Flat-roofed blocks (LOD1) standing on the drawn terrain; returns how many were placed.
    pub fn add_buildings(&mut self, list: &[Footprint]) -> usize {
        let mut acc = Acc::new("buildings", "Buildings");
        let mut placed = 0;
        for b in list {
            let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
            for r in &b.rings {
                let mut pts: Vec<[f64; 2]> = Vec::with_capacity(r.len());
                for p in r {
                    let q = self.local(*p);
                    if pts.last().is_none_or(|l: &[f64; 2]| {
                        (l[0] - q[0]).abs() > 1e-6 || (l[1] - q[1]).abs() > 1e-6
                    }) {
                        pts.push(q);
                    }
                }
                while pts.len() > 1
                    && (pts[0][0] - pts[pts.len() - 1][0]).abs() < 1e-6
                    && (pts[0][1] - pts[pts.len() - 1][1]).abs() < 1e-6
                {
                    pts.pop();
                }
                if pts.len() >= 3 && ring_area(&pts).abs() > 1e-3 {
                    // raster-traced outlines keep cell-sized zig-zags that light as stripes on
                    // the walls: straighten them (tolerance grows with the building, ≤ 1.2 m)
                    let tol = (0.08 * ring_area(&pts).abs().sqrt()).min(1.2);
                    let straight = straighten_ring(&pts, tol);
                    if straight.len() >= 3
                        && (ring_area(&straight).abs() / ring_area(&pts).abs() - 1.0).abs() < 0.15
                    {
                        pts = straight;
                    }
                    // exterior counter-clockwise, holes clockwise
                    if (ring_area(&pts) > 0.0) != rings.is_empty() {
                        pts.reverse();
                    }
                    rings.push(pts);
                } else if rings.is_empty() {
                    break;
                }
            }
            let nverts: usize = rings.iter().map(|r| r.len()).sum();
            if rings.is_empty() || nverts > 8000 || !(b.height > 0.0) {
                continue;
            }
            let Some(ground) = rings[0]
                .iter()
                .filter_map(|p| self.surface.at(p[0], p[1]))
                .reduce(f64::min)
            else {
                continue;
            };
            let top = ground + b.height;
            let bottom = ground - 0.5;
            let j = hash01(rings[0][0][0], rings[0][0][1]);
            let wall = [0.93 - 0.05 * j, 0.91 - 0.05 * j, 0.87 - 0.04 * j];
            let roof = [0.64 + 0.06 * j, 0.46 + 0.04 * j, 0.40 + 0.03 * j];
            // roof
            let flat: Vec<f64> = rings.iter().flatten().flat_map(|p| [p[0], p[1]]).collect();
            let mut holes = Vec::new();
            let mut n = 0;
            for r in &rings[..rings.len() - 1] {
                n += r.len();
                holes.push(n);
            }
            let Ok(tris) = earcutr::earcut(&flat, &holes, 2) else {
                continue;
            };
            let v = acc.reserve(nverts + 4 * nverts);
            let roof_c = lit(roof, [0.0, 0.0, 1.0], 0.40);
            for p in rings.iter().flatten() {
                acc.vert([p[0], p[1], top], roof_c);
            }
            let pt = |i: usize| [flat[2 * i], flat[2 * i + 1]];
            for t in tris.chunks_exact(3) {
                let (a, b2, c) = (pt(t[0]), pt(t[1]), pt(t[2]));
                let ccw = (b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]) > 0.0;
                let (i0, i1, i2) = (v + t[0] as u16, v + t[1] as u16, v + t[2] as u16);
                if ccw {
                    acc.tri(i0, i1, i2)
                } else {
                    acc.tri(i0, i2, i1)
                }
            }
            // walls
            for r in &rings {
                for i in 0..r.len() {
                    let (p, q) = (r[i], r[(i + 1) % r.len()]);
                    let nrm = normalize([q[1] - p[1], -(q[0] - p[0]), 0.0]);
                    let c = lit(wall, nrm, 0.52);
                    let w0 = acc.cur.pos.len() as u16;
                    acc.vert([p[0], p[1], bottom], c);
                    acc.vert([q[0], q[1], bottom], c);
                    acc.vert([q[0], q[1], top], c);
                    acc.vert([p[0], p[1], top], c);
                    acc.tri(w0, w0 + 1, w0 + 2);
                    acc.tri(w0, w0 + 2, w0 + 3);
                }
            }
            placed += 1;
        }
        self.prims.extend(acc.finish());
        placed
    }

    /// Stylised trees (trunk + rounded crown) from height and crown width; returns how many.
    pub fn add_trees(&mut self, list: &[TreeIn]) -> usize {
        let seg = if list.len() > 3000 { 6 } else { 8 };
        let rings: [(f64, f64); 3] = [
            (-50f64.to_radians().sin(), 50f64.to_radians().cos()),
            (-0.08, 0.997),
            (40f64.to_radians().sin(), 40f64.to_radians().cos()),
        ];
        let mut acc = Acc::new("trees", "Trees");
        let mut placed = 0;
        for t in list {
            let [x, y] = self.local([t.x, t.y]);
            let Some(zg) = self.surface.at(x, y) else {
                continue;
            };
            let hgt = t.height.max(1.0);
            let r = (t.crown / 2.0).clamp(0.5, 15.0);
            let zb = zg + 0.32 * hgt;
            let zt = zg + hgt;
            let (zc, a) = ((zb + zt) / 2.0, (zt - zb) / 2.0);
            let j = hash01(t.x, t.y);
            let g = ((hgt - 3.0) / 30.0).clamp(0.0, 1.0);
            let jit = 0.93 + 0.14 * j;
            let green = [
                (0.52 - 0.32 * g) * jit,
                (0.70 - 0.27 * g) * jit,
                (0.33 - 0.12 * g) * jit,
            ];
            let base = acc.reserve(2 + rings.len() * seg + 6);
            // crown: bottom pole, rings, top pole
            acc.vert([x, y, zc - a], lit(green, [0.0, 0.0, -1.0], 0.40));
            for (sz, cr) in rings {
                for k in 0..seg {
                    let th = k as f64 / seg as f64 * std::f64::consts::TAU + j;
                    let (cx, cy) = (th.cos() * cr, th.sin() * cr);
                    let n = normalize([cx / r, cy / r, sz / a.max(0.1)]);
                    acc.vert([x + r * cx, y + r * cy, zc + a * sz], lit(green, n, 0.40));
                }
            }
            acc.vert([x, y, zc + a], lit(green, [0.0, 0.0, 1.0], 0.40));
            let ring = |q: usize, k: usize| base + 1 + (q * seg + k % seg) as u16;
            let top = base + 1 + (rings.len() * seg) as u16;
            for k in 0..seg {
                acc.tri(ring(0, k + 1), ring(0, k), base);
                for q in 0..rings.len() - 1 {
                    acc.tri(ring(q, k), ring(q, k + 1), ring(q + 1, k + 1));
                    acc.tri(ring(q, k), ring(q + 1, k + 1), ring(q + 1, k));
                }
                acc.tri(ring(rings.len() - 1, k), ring(rings.len() - 1, k + 1), top);
            }
            // trunk: a three-sided post from the ground into the crown
            let rt = (0.035 * hgt).clamp(0.1, 0.5);
            let trunk = top + 1;
            for z in [zg - 0.3, zb + 0.3 * a] {
                for s in 0..3 {
                    let th = s as f64 / 3.0 * std::f64::consts::TAU + j;
                    let n = [th.cos(), th.sin(), 0.0];
                    acc.vert(
                        [x + rt * n[0], y + rt * n[1], z],
                        lit([0.42, 0.31, 0.22], n, 0.45),
                    );
                }
            }
            for s in 0..3u16 {
                let s1 = (s + 1) % 3;
                acc.tri(trunk + s, trunk + s1, trunk + 3 + s1);
                acc.tri(trunk + s, trunk + 3 + s1, trunk + 3 + s);
            }
            placed += 1;
        }
        self.prims.extend(acc.finish());
        placed
    }

    /// A point-cloud sample (one primitive drawn as points); heights above the ground stay true
    /// when the terrain is exaggerated.
    pub fn add_points(&mut self, pts: &[PointIn]) -> usize {
        let mut p = Prim::new("points", "Point cloud");
        p.points = true;
        let k = self.exaggeration;
        for q in pts {
            let [x, y] = self.local([q.x, q.y]);
            let z = if (k - 1.0).abs() < 1e-9 {
                q.z - self.origin[2]
            } else {
                match (self.surface.at(x, y), self.surface.true_at(x, y)) {
                    (Some(gs), Some(gt)) => gs + (q.z - gt),
                    _ => (q.z - self.origin[2]) * k,
                }
            };
            p.pos.push([x as f32, y as f32, z as f32]);
            p.col.push([q.rgb[0], q.rgb[1], q.rgb[2], 255]);
        }
        let n = p.pos.len();
        if n > 0 {
            self.prims.push(p);
        }
        n
    }

    pub fn triangles(&self) -> usize {
        self.prims.iter().map(Prim::triangles).sum()
    }

    pub fn vertices(&self) -> usize {
        self.prims.iter().map(|p| p.pos.len()).sum()
    }

    pub fn groups(&self) -> Vec<&'static str> {
        let mut g: Vec<&'static str> = Vec::new();
        for p in &self.prims {
            if !g.contains(&p.group) {
                g.push(p.group);
            }
        }
        g
    }

    // -------------------------------------------------------------- glTF

    /// glTF 2.0 binary. `extras` lands in `asset.extras.geospax` (georeference, credits).
    pub fn glb(&self, generator: &str, extras: Value, jpeg_quality: u8) -> Result<Vec<u8>, String> {
        struct Buf {
            bin: Vec<u8>,
            views: Vec<Value>,
            accs: Vec<Value>,
        }
        impl Buf {
            fn view(&mut self, bytes: &[u8], target: Option<u32>) -> usize {
                while self.bin.len() % 4 != 0 {
                    self.bin.push(0);
                }
                let mut v =
                    json!({ "buffer": 0, "byteOffset": self.bin.len(), "byteLength": bytes.len() });
                if let Some(t) = target {
                    v["target"] = json!(t);
                }
                self.bin.extend_from_slice(bytes);
                self.views.push(v);
                self.views.len() - 1
            }
            fn acc(
                &mut self,
                bytes: &[u8],
                target: Option<u32>,
                ctype: u32,
                count: usize,
                kind: &str,
                normalized: bool,
                minmax: Option<(Vec<f32>, Vec<f32>)>,
            ) -> usize {
                let bv = self.view(bytes, target);
                let mut a = json!({ "bufferView": bv, "componentType": ctype, "count": count, "type": kind });
                if normalized {
                    a["normalized"] = json!(true);
                }
                if let Some((lo, hi)) = minmax {
                    a["min"] = json!(lo);
                    a["max"] = json!(hi);
                }
                self.accs.push(a);
                self.accs.len() - 1
            }
        }
        let mut b = Buf {
            bin: Vec::new(),
            views: Vec::new(),
            accs: Vec::new(),
        };
        let mut images = Vec::new();
        for t in &self.textures {
            let jpg = t.jpeg(jpeg_quality)?;
            let bv = b.view(&jpg, None);
            images.push(json!({ "bufferView": bv, "mimeType": "image/jpeg" }));
        }
        // materials: 0 = draped texture, 1 = baked vertex colours
        let unlit = json!({ "KHR_materials_unlit": {} });
        let mut materials = vec![];
        if !self.textures.is_empty() {
            materials.push(json!({ "name": "terrain", "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 }, "metallicFactor": 0.0, "roughnessFactor": 1.0 }, "extensions": unlit }));
        }
        let vc_material = materials.len();
        materials.push(json!({ "name": "baked colours", "pbrMetallicRoughness": { "baseColorFactor": [1.0, 1.0, 1.0, 1.0], "metallicFactor": 0.0, "roughnessFactor": 1.0 }, "extensions": unlit }));
        // one mesh per name, primitives in order
        let mut names: Vec<&'static str> = Vec::new();
        for p in &self.prims {
            if !names.contains(&p.name) {
                names.push(p.name);
            }
        }
        let mut meshes = Vec::new();
        for name in &names {
            let mut prims = Vec::new();
            let mut group = "";
            for p in self
                .prims
                .iter()
                .filter(|p| p.name == *name && !p.pos.is_empty())
            {
                group = p.group;
                let mut pos = Vec::with_capacity(p.pos.len() * 12);
                let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
                for v in &p.pos {
                    let g = [v[0], v[2], -v[1]]; // east, up, south
                    for k in 0..3 {
                        lo[k] = lo[k].min(g[k]);
                        hi[k] = hi[k].max(g[k]);
                        pos.extend_from_slice(&g[k].to_le_bytes());
                    }
                }
                let mut attrs = json!({ "POSITION": b.acc(&pos, Some(34962), 5126, p.pos.len(), "VEC3", false, Some((lo.to_vec(), hi.to_vec()))) });
                if !p.col.is_empty() {
                    let cols: Vec<u8> = p.col.iter().flatten().copied().collect();
                    attrs["COLOR_0"] =
                        json!(b.acc(&cols, Some(34962), 5121, p.col.len(), "VEC4", true, None));
                }
                if !p.uv.is_empty() {
                    let uvs: Vec<u8> =
                        p.uv.iter()
                            .flatten()
                            .flat_map(|f| f.to_le_bytes())
                            .collect();
                    attrs["TEXCOORD_0"] =
                        json!(b.acc(&uvs, Some(34962), 5126, p.uv.len(), "VEC2", false, None));
                }
                let material = if p.texture.is_some() && !self.textures.is_empty() {
                    0
                } else {
                    vc_material
                };
                let mut prim = json!({ "attributes": attrs, "material": material, "mode": if p.points { 0 } else { 4 } });
                if !p.points {
                    let idx: Vec<u8> = p.idx.iter().flat_map(|i| i.to_le_bytes()).collect();
                    prim["indices"] =
                        json!(b.acc(&idx, Some(34963), 5123, p.idx.len(), "SCALAR", false, None));
                }
                prims.push(prim);
            }
            meshes.push(json!({ "name": name, "primitives": prims, "extras": { "group": group } }));
        }
        let nodes: Vec<Value> = names
            .iter()
            .enumerate()
            .map(|(i, n)| json!({ "name": n, "mesh": i }))
            .collect();
        let mut doc = json!({
            "asset": { "version": "2.0", "generator": generator, "extras": { "geospax": extras } },
            "extensionsUsed": ["KHR_materials_unlit"],
            "scene": 0,
            "scenes": [{ "name": "GeoSpaX scene", "nodes": (0..nodes.len()).collect::<Vec<_>>() }],
            "nodes": nodes,
            "meshes": meshes,
            "materials": materials,
            "accessors": b.accs,
            "bufferViews": b.views,
            "buffers": [{ "byteLength": b.bin.len() }],
        });
        if !images.is_empty() {
            doc["images"] = json!(images);
            doc["samplers"] =
                json!([{ "magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071 }]);
            doc["textures"] = json!([{ "sampler": 0, "source": 0 }]);
        }
        let mut js = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
        while js.len() % 4 != 0 {
            js.push(b' ');
        }
        let mut bin = b.bin;
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        let total = 12 + 8 + js.len() + 8 + bin.len();
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(js.len() as u32).to_le_bytes());
        out.extend_from_slice(b"JSON");
        out.extend_from_slice(&js);
        out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&bin);
        Ok(out)
    }

    /// The interactive viewer with the model inside (no network needed).
    pub fn html(glb: &[u8], title: &str, meta: &Value) -> String {
        let meta = serde_json::to_string(meta)
            .unwrap_or_else(|_| "{}".into())
            .replace("</", "<\\/");
        let (a, rest) = VIEWER.split_once("__TITLE__").unwrap_or((VIEWER, ""));
        let (b, rest) = rest.split_once("__META__").unwrap_or((rest, ""));
        let (c, d) = rest.split_once("__GLB__").unwrap_or((rest, ""));
        let mut out = String::with_capacity(VIEWER.len() + meta.len() + glb.len() * 4 / 3 + 16);
        out.push_str(a);
        out.push_str(&crate::automation::cartography::esc(title));
        out.push_str(b);
        out.push_str(&meta);
        out.push_str(c);
        out.push_str(&crate::automation::cartography::base64(glb));
        out.push_str(d);
        out
    }

    // -------------------------------------------------------------- still picture

    /// Perspective view rendered on the CPU (2 × 2 supersampled), sky behind.
    pub fn render(&self, v: &View) -> Rendered {
        const SS: usize = 2;
        let (w, h) = (v.width.max(16) * SS, v.height.max(16) * SS);
        // what to frame: everything except the point cloud
        let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
        for p in self.prims.iter().filter(|p| !p.points) {
            for q in &p.pos {
                for k in 0..3 {
                    lo[k] = lo[k].min(q[k] as f64);
                    hi[k] = hi[k].max(q[k] as f64);
                }
            }
        }
        if lo[0] > hi[0] {
            lo = [-1.0; 3];
            hi = [1.0; 3];
        }
        let target = [
            (lo[0] + hi[0]) / 2.0,
            (lo[1] + hi[1]) / 2.0,
            (lo[2] + hi[2]) / 2.0,
        ];
        let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2))
            .sqrt()
            .max(1.0);
        let (az, el) = (
            v.azimuth.to_radians(),
            v.elevation.clamp(5.0, 89.0).to_radians(),
        );
        let dir = [az.sin() * el.cos(), az.cos() * el.cos(), el.sin()];
        let dist = diag / (2.0 * (v.fov.to_radians() / 2.0).tan()) * 1.05;
        let eye = [
            target[0] + dir[0] * dist,
            target[1] + dir[1] * dist,
            target[2] + dir[2] * dist,
        ];
        let f = [-dir[0], -dir[1], -dir[2]];
        let r = normalize([f[1], -f[0], 0.0]); // f × up
        let u = [
            r[1] * f[2] - r[2] * f[1],
            r[2] * f[0] - r[0] * f[2],
            r[0] * f[1] - r[1] * f[0],
        ];
        let cam = |p: [f32; 3]| -> [f64; 3] {
            let q = [
                p[0] as f64 - eye[0],
                p[1] as f64 - eye[1],
                p[2] as f64 - eye[2],
            ];
            [
                q[0] * r[0] + q[1] * r[1] + q[2] * r[2],
                q[0] * u[0] + q[1] * u[1] + q[2] * u[2],
                q[0] * f[0] + q[1] * f[1] + q[2] * f[2],
            ]
        };
        // fit: scale the focal length so the projected scene fills the frame, then centre it
        let (mut ax0, mut ax1, mut ay0, mut ay1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for p in self.prims.iter().filter(|p| !p.points) {
            for q in &p.pos {
                let c = cam(*q);
                if c[2] > 1e-6 {
                    let (x, y) = (c[0] / c[2], c[1] / c[2]);
                    ax0 = ax0.min(x);
                    ax1 = ax1.max(x);
                    ay0 = ay0.min(y);
                    ay1 = ay1.max(y);
                }
            }
        }
        let margin = 0.05;
        let fl = ((w as f64 * (1.0 - 2.0 * margin)) / (ax1 - ax0).max(1e-9))
            .min((h as f64 * (1.0 - 2.0 * margin)) / (ay1 - ay0).max(1e-9));
        let cx = w as f64 / 2.0 - fl * (ax0 + ax1) / 2.0;
        let cy = h as f64 / 2.0 + fl * (ay0 + ay1) / 2.0;
        let project = |p: [f32; 3]| -> Option<[f32; 3]> {
            let c = cam(p);
            (c[2] > dist * 1e-3).then(|| {
                [
                    (cx + fl * c[0] / c[2]) as f32,
                    (cy - fl * c[1] / c[2]) as f32,
                    (1.0 / c[2]) as f32,
                ]
            })
        };
        let mut color = vec![[0f32; 3]; w * h];
        let mut depth = vec![0f32; w * h]; // 1/z, 0 = empty
        for p in self.prims.iter().filter(|p| v.points || !p.points) {
            let sv: Vec<Option<[f32; 3]>> = p.pos.iter().map(|q| project(*q)).collect();
            if p.points {
                let rad = SS as f32 * 0.9;
                for (i, s) in sv.iter().enumerate() {
                    let Some(s) = s else { continue };
                    let c = p
                        .col
                        .get(i)
                        .map(|c| {
                            [
                                c[0] as f32 / 255.0,
                                c[1] as f32 / 255.0,
                                c[2] as f32 / 255.0,
                            ]
                        })
                        .unwrap_or([0.5; 3]);
                    let (x0, x1) = (
                        ((s[0] - rad).floor().max(0.0)) as usize,
                        ((s[0] + rad).ceil().min(w as f32 - 1.0)).max(0.0) as usize,
                    );
                    let (y0, y1) = (
                        ((s[1] - rad).floor().max(0.0)) as usize,
                        ((s[1] + rad).ceil().min(h as f32 - 1.0)).max(0.0) as usize,
                    );
                    for y in y0..=y1 {
                        for x in x0..=x1 {
                            let k = y * w + x;
                            if s[2] > depth[k] {
                                depth[k] = s[2];
                                color[k] = c;
                            }
                        }
                    }
                }
                continue;
            }
            let tex = p.texture.and_then(|t| self.textures.get(t));
            for t in p.idx.chunks_exact(3) {
                let (ia, ib, ic) = (t[0] as usize, t[1] as usize, t[2] as usize);
                let (Some(a), Some(b), Some(c)) = (sv[ia], sv[ib], sv[ic]) else {
                    continue;
                };
                let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
                if area >= 0.0 {
                    continue; // facing away (front faces are clockwise on screen, y down)
                }
                let minx = a[0].min(b[0]).min(c[0]).floor().max(0.0) as usize;
                let maxx = (a[0].max(b[0]).max(c[0]).ceil().min(w as f32 - 1.0)).max(0.0) as usize;
                let miny = a[1].min(b[1]).min(c[1]).floor().max(0.0) as usize;
                let maxy = (a[1].max(b[1]).max(c[1]).ceil().min(h as f32 - 1.0)).max(0.0) as usize;
                if minx > maxx || miny > maxy {
                    continue;
                }
                let attr = |i: usize| -> [f32; 3] {
                    match tex {
                        Some(_) => {
                            let q = p.uv.get(i).copied().unwrap_or([0.0, 0.0]);
                            [q[0], q[1], 0.0]
                        }
                        None => p
                            .col
                            .get(i)
                            .map(|c| {
                                [
                                    c[0] as f32 / 255.0,
                                    c[1] as f32 / 255.0,
                                    c[2] as f32 / 255.0,
                                ]
                            })
                            .unwrap_or([0.6; 3]),
                    }
                };
                let (aa, ab, ac) = (attr(ia), attr(ib), attr(ic));
                let inv = 1.0 / area;
                for y in miny..=maxy {
                    let py = y as f32 + 0.5;
                    for x in minx..=maxx {
                        let px = x as f32 + 0.5;
                        let w0 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) * inv;
                        let w1 = ((a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0])) * inv;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5 {
                            continue;
                        }
                        let iz = w0 * a[2] + w1 * b[2] + w2 * c[2];
                        let k = y * w + x;
                        if iz <= depth[k] {
                            continue;
                        }
                        depth[k] = iz;
                        // perspective-correct attributes
                        let (q0, q1, q2) = (w0 * a[2] / iz, w1 * b[2] / iz, w2 * c[2] / iz);
                        let m = [
                            aa[0] * q0 + ab[0] * q1 + ac[0] * q2,
                            aa[1] * q0 + ab[1] * q1 + ac[1] * q2,
                            aa[2] * q0 + ab[2] * q1 + ac[2] * q2,
                        ];
                        color[k] = match tex {
                            Some(t) => t.sample(m[0], m[1]),
                            None => m,
                        };
                    }
                }
            }
        }
        // sky, light haze with distance, then 2 × 2 box filter
        let (top_sky, low_sky) = ([0.74f32, 0.83, 0.92], [0.95f32, 0.96, 0.97]);
        let near_iz = depth.iter().copied().fold(0.0f32, f32::max);
        let mut out = vec![0u8; v.width * v.height * 4];
        for y in 0..v.height {
            for x in 0..v.width {
                let mut acc = [0f32; 3];
                for sy in 0..SS {
                    for sx in 0..SS {
                        let (xx, yy) = (x * SS + sx, y * SS + sy);
                        let k = yy * w + xx;
                        let t = yy as f32 / h as f32;
                        let sky = [0, 1, 2].map(|i| top_sky[i] + (low_sky[i] - top_sky[i]) * t);
                        let c = if depth[k] > 0.0 {
                            let haze = (1.0 - depth[k] / near_iz.max(1e-9)).clamp(0.0, 1.0) * 0.18;
                            [0, 1, 2].map(|i| color[k][i] * (1.0 - haze) + low_sky[i] * haze)
                        } else {
                            sky
                        };
                        for i in 0..3 {
                            acc[i] += c[i];
                        }
                    }
                }
                let o = (y * v.width + x) * 4;
                for i in 0..3 {
                    out[o + i] =
                        ((acc[i] / (SS * SS) as f32).clamp(0.0, 1.0) * 255.0).round() as u8;
                }
                out[o + 3] = 255;
            }
        }
        // where north points on the picture
        let a = project([target[0] as f32, target[1] as f32, lo[2] as f32]);
        let b = project([
            target[0] as f32,
            (target[1] + diag * 0.05) as f32,
            lo[2] as f32,
        ]);
        let north = match (a, b) {
            (Some(a), Some(b)) => ((b[0] - a[0]) as f64)
                .atan2(-(b[1] - a[1]) as f64)
                .to_degrees(),
            _ => 0.0,
        };
        Rendered {
            rgba: out,
            w: v.width,
            h: v.height,
            north,
        }
    }
}

// ------------------------------------------------------------------ tests

/// Douglas–Peucker on an open polyline (keeps both ends).
fn dp_open(pts: &[[f64; 2]], tol: f64, out: &mut Vec<[f64; 2]>) {
    if pts.len() < 3 {
        out.extend_from_slice(&pts[..pts.len().saturating_sub(1)]);
        return;
    }
    let (a, b) = (pts[0], pts[pts.len() - 1]);
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = (dx * dx + dy * dy).sqrt();
    let (mut far, mut fd) = (0, -1.0);
    for (i, p) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
        let d = if len < 1e-12 {
            ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt()
        } else {
            ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len
        };
        if d > fd {
            fd = d;
            far = i;
        }
    }
    if fd > tol {
        dp_open(&pts[..=far], tol, out);
        dp_open(&pts[far..], tol, out);
    } else {
        out.push(a);
    }
}

/// Straighten a closed ring (no repeated last vertex): Douglas–Peucker split at the vertex
/// farthest from the first, then drop vertices where the outline turns by under 12°.
pub fn straighten_ring(ring: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    let n = ring.len();
    if n < 4 {
        return ring.to_vec();
    }
    let d0 = |p: &[f64; 2]| (p[0] - ring[0][0]).powi(2) + (p[1] - ring[0][1]).powi(2);
    let far = (1..n)
        .max_by(|&i, &j| d0(&ring[i]).partial_cmp(&d0(&ring[j])).unwrap())
        .unwrap_or(n / 2);
    let mut out = Vec::new();
    dp_open(&ring[..=far], tol, &mut out);
    let mut back: Vec<[f64; 2]> = ring[far..].to_vec();
    back.push(ring[0]);
    dp_open(&back, tol, &mut out);
    // collinear merge
    let mut changed = true;
    while changed && out.len() > 3 {
        changed = false;
        let m = out.len();
        for i in 0..m {
            let (a, b, c) = (out[(i + m - 1) % m], out[i], out[(i + 1) % m]);
            let (u, v) = ([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]);
            let (lu, lv) = (
                (u[0] * u[0] + u[1] * u[1]).sqrt(),
                (v[0] * v[0] + v[1] * v[1]).sqrt(),
            );
            if lu < 1e-9
                || lv < 1e-9
                || ((u[0] * v[1] - u[1] * v[0]) / (lu * lv)).abs() < 0.2079
                    && (u[0] * v[0] + u[1] * v[1]) > 0.0
            {
                out.remove(i);
                changed = true;
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {

    #[test]
    fn zigzag_outlines_are_straightened() {
        // a 20 × 12 m block whose long sides are 1 m stair-steps around a 1-in-6 slope
        let mut ring: Vec<[f64; 2]> = Vec::new();
        let (mut x, mut y) = (0.0, 0.0);
        ring.push([x, y]);
        for _ in 0..4 {
            x += 6.0;
            ring.push([x, y]);
            y += 1.0;
            ring.push([x, y]);
        }
        ring.push([x, y + 12.0]);
        for _ in 0..4 {
            ring.push([x, y + 12.0]);
            x -= 6.0;
            ring.push([x, y + 12.0]);
            y -= 1.0;
        }
        ring.dedup();
        let s = straighten_ring(&ring, 1.2);
        assert!(s.len() <= 6, "{} vertices: {s:?}", s.len());
        assert!((ring_area(&s).abs() / ring_area(&ring).abs() - 1.0).abs() < 0.15);
        // a clean rectangle is untouched
        let rect = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [0.0, 5.0]];
        assert_eq!(straighten_ring(&rect, 1.2), rect);
    }
    use super::*;

    fn hill(n: usize, cell: f64, peak: f64) -> Dem {
        let mut z = vec![0f32; n * n];
        for j in 0..n {
            for i in 0..n {
                let (dx, dy) = (i as f64 - n as f64 / 2.0, j as f64 - n as f64 / 2.0);
                z[j * n + i] = (100.0
                    + peak * (-(dx * dx + dy * dy) / (n as f64 * n as f64 / 18.0)).exp())
                    as f32;
            }
        }
        Dem {
            z,
            w: n,
            h: n,
            gt: [500_000.0, cell, 0.0, 9_300_000.0, 0.0, -cell],
        }
    }

    fn green_texture(n: usize) -> Texture {
        Texture {
            w: n,
            h: n,
            rgb: (0..n * n).flat_map(|_| [90u8, 160, 80]).collect(),
        }
    }

    fn parse_glb(b: &[u8]) -> (Value, Vec<u8>) {
        assert_eq!(&b[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize,
            b.len()
        );
        let jl = u32::from_le_bytes(b[12..16].try_into().unwrap()) as usize;
        assert_eq!(&b[16..20], b"JSON");
        assert_eq!(jl % 4, 0);
        let doc: Value = serde_json::from_slice(&b[20..20 + jl]).unwrap();
        let bl = u32::from_le_bytes(b[20 + jl..24 + jl].try_into().unwrap()) as usize;
        assert_eq!(&b[24 + jl..28 + jl], b"BIN\0");
        (doc, b[28 + jl..28 + jl + bl].to_vec())
    }

    #[test]
    fn glb_is_well_formed_and_indices_stay_in_range() {
        let dem = hill(300, 10.0, 400.0);
        let mut s = Scene::terrain(&dem, 280, 1.0, green_texture(64)).unwrap();
        assert!(
            s.prims.iter().filter(|p| p.group == "terrain").count() >= 2,
            "a 280 × 280 grid needs several 16-bit primitives"
        );
        let (cx, cy) = (500_000.0 + 1500.0, 9_300_000.0 - 1500.0);
        let sq = |x: f64, y: f64, r: f64| {
            vec![
                [x - r, y - r],
                [x + r, y - r],
                [x + r, y + r],
                [x - r, y + r],
                [x - r, y - r],
            ]
        };
        let n = s.add_buildings(&[Footprint {
            rings: vec![sq(cx - 600.0, cy, 20.0), sq(cx - 600.0, cy, 6.0)],
            height: 12.0,
        }]);
        assert_eq!(n, 1);
        assert_eq!(
            s.add_trees(&[
                TreeIn {
                    x: cx + 500.0,
                    y: cy,
                    height: 20.0,
                    crown: 8.0
                },
                TreeIn {
                    x: 0.0,
                    y: 0.0,
                    height: 20.0,
                    crown: 8.0
                }
            ]),
            1,
            "trees off the terrain are skipped"
        );
        assert_eq!(
            s.add_points(&[PointIn {
                x: cx,
                y: cy,
                z: 500.0,
                rgb: [255, 0, 0]
            }]),
            1
        );
        let glb = s.glb("test", json!({ "epsg": 32755 }), 85).unwrap();
        let (doc, bin) = parse_glb(&glb);
        assert_eq!(doc["asset"]["version"], "2.0");
        assert_eq!(
            doc["buffers"][0]["byteLength"].as_u64().unwrap() as usize,
            bin.len()
        );
        for v in doc["bufferViews"].as_array().unwrap() {
            let (o, l) = (
                v["byteOffset"].as_u64().unwrap() as usize,
                v["byteLength"].as_u64().unwrap() as usize,
            );
            assert!(o + l <= bin.len());
            assert_eq!(o % 4, 0);
        }
        let accs = doc["accessors"].as_array().unwrap();
        for m in doc["meshes"].as_array().unwrap() {
            for p in m["primitives"].as_array().unwrap() {
                let pos = &accs[p["attributes"]["POSITION"].as_u64().unwrap() as usize];
                let count = pos["count"].as_u64().unwrap() as usize;
                assert!(pos["min"].is_array() && pos["max"].is_array());
                if let Some(i) = p["indices"].as_u64() {
                    let a = &accs[i as usize];
                    assert_eq!(a["componentType"], 5123);
                    let bv = &doc["bufferViews"][a["bufferView"].as_u64().unwrap() as usize];
                    let o = bv["byteOffset"].as_u64().unwrap() as usize;
                    let idx: Vec<u16> = bin[o..o + a["count"].as_u64().unwrap() as usize * 2]
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    assert!(idx.iter().all(|i| (*i as usize) < count && *i != u16::MAX));
                    assert_eq!(idx.len() % 3, 0);
                }
            }
        }
        let names: Vec<&str> = doc["meshes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "Terrain",
                "Terrain sides",
                "Buildings",
                "Trees",
                "Point cloud"
            ]
        );
        assert_eq!(doc["images"][0]["mimeType"], "image/jpeg");
        assert_eq!(doc["asset"]["extras"]["geospax"]["epsg"], 32755);
    }

    #[test]
    fn roofs_cover_the_footprint_minus_its_courtyard() {
        let dem = Dem {
            z: vec![50.0; 100 * 100],
            w: 100,
            h: 100,
            gt: [0.0, 1.0, 0.0, 100.0, 0.0, -1.0],
        };
        let mut s = Scene::terrain(&dem, 100, 1.0, green_texture(8)).unwrap();
        // 30 × 20 m block with a 10 × 6 m courtyard, given clockwise (it gets re-oriented)
        let outer = vec![[35.0, 40.0], [35.0, 60.0], [65.0, 60.0], [65.0, 40.0]];
        let hole = vec![[45.0, 47.0], [55.0, 47.0], [55.0, 53.0], [45.0, 53.0]];
        assert_eq!(
            s.add_buildings(&[Footprint {
                rings: vec![outer, hole],
                height: 9.0
            }]),
            1
        );
        let b = s.prims.iter().find(|p| p.group == "buildings").unwrap();
        let mut roof = 0.0;
        let mut walls_up = 0;
        for t in b.idx.chunks_exact(3) {
            let (p, q, r) = (
                b.pos[t[0] as usize],
                b.pos[t[1] as usize],
                b.pos[t[2] as usize],
            );
            // heights are from the base (the lowest ground, 50 m): the roof is at 9 m
            let top =
                (p[2] - 9.0).abs() < 1e-3 && (q[2] - 9.0).abs() < 1e-3 && (r[2] - 9.0).abs() < 1e-3;
            let a = ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) as f64 / 2.0;
            if top {
                assert!(a > 0.0, "roof triangles face up");
                roof += a;
            } else {
                walls_up += 1;
            }
        }
        assert!((roof - (600.0 - 60.0)).abs() < 1e-3, "roof area {roof}");
        assert_eq!(walls_up, 2 * 8, "two triangles per wall, 8 walls");
    }

    #[test]
    fn the_still_view_shows_the_hill_and_the_block() {
        let dem = hill(120, 10.0, 300.0);
        let mut s = Scene::terrain(&dem, 120, 1.0, green_texture(32)).unwrap();
        let (cx, cy) = (500_000.0 + 600.0, 9_300_000.0 - 600.0);
        s.add_buildings(&[Footprint {
            rings: vec![vec![
                [cx - 40.0, cy - 40.0],
                [cx + 40.0, cy - 40.0],
                [cx + 40.0, cy + 40.0],
                [cx - 40.0, cy + 40.0],
            ]],
            height: 120.0,
        }]);
        let img = s.render(&View {
            width: 320,
            height: 200,
            ..Default::default()
        });
        assert_eq!(img.rgba.len(), 320 * 200 * 4);
        let px = |x: usize, y: usize| &img.rgba[(y * 320 + x) * 4..(y * 320 + x) * 4 + 3];
        let greenish = (0..200)
            .flat_map(|y| (0..320).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let p = px(*x, *y);
                // as i32: a bright red channel would overflow a u8 add in debug builds
                p[1] as i32 > p[0] as i32 + 20 && p[1] as i32 > p[2] as i32 + 20
            });
        let share = greenish.count() as f64 / (320.0 * 200.0);
        assert!(share > 0.25, "terrain covers {share:.2} of the picture");
        // the sky is at the top; the block shows as light walls and a grey roof (red ≥ blue,
        // unlike the sky, and not green like the terrain)
        let top = px(160, 2);
        assert!(top[2] > top[0] && top[2] > 200, "sky {top:?}");
        let block = (0..200)
            .flat_map(|y| (0..320).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let p = px(*x, *y);
                p[0] > 90 && p[0] >= p[2] && (p[1] as i32) < p[0] as i32 + 15
            });
        let n = block.count();
        assert!(n > 60, "{n} block pixels");
        assert!(
            img.north.abs() < 45.0,
            "north points up-ish from the south-south-west: {}",
            img.north
        );
    }

    #[test]
    fn irregular_surveys_get_walls_along_the_edge_of_the_data() {
        // 40 × 40 cells, data only inside a diamond
        let n = 40;
        let mut z = vec![f32::NAN; n * n];
        for j in 0..n {
            for i in 0..n {
                if (i as i32 - 20).abs() + (j as i32 - 20).abs() < 15 {
                    z[j * n + i] = 10.0 + i as f32 * 0.1;
                }
            }
        }
        let dem = Dem {
            z,
            w: n,
            h: n,
            gt: [0.0, 1.0, 0.0, 40.0, 0.0, -1.0],
        };
        let s = Scene::terrain(&dem, 40, 1.0, green_texture(8)).unwrap();
        let sides: Vec<&Prim> = s
            .prims
            .iter()
            .filter(|p| p.name == "Terrain sides")
            .collect();
        let walls: usize = sides.iter().map(|p| p.triangles()).sum::<usize>() / 2;
        assert!(walls > 60, "{walls} wall panels around the diamond");
        // every wall faces away from the data: its outward normal points to a no-data side
        let surf = &s.surface;
        for p in &sides {
            for q in p.pos.chunks_exact(4) {
                let (a, b) = (q[0], q[1]);
                let mid = [(a[0] + b[0]) as f64 / 2.0, (a[1] + b[1]) as f64 / 2.0];
                let nrm = normalize([(b[1] - a[1]) as f64, -(b[0] - a[0]) as f64, 0.0]);
                let inside = [mid[0] - nrm[0] * 0.3, mid[1] - nrm[1] * 0.3];
                assert!(
                    surf.at(inside[0], inside[1]).is_some(),
                    "the wall at {mid:?} has the surface behind it"
                );
            }
        }
    }

    #[test]
    fn exaggeration_adapts_to_relief() {
        assert_eq!(auto_exaggeration(30_000.0, 1500.0, 30.0), 2.0);
        assert_eq!(auto_exaggeration(10_000.0, 1200.0, 30.0), 1.0);
        assert_eq!(auto_exaggeration(1_400.0, 12.0, 1.0), 1.5);
        assert_eq!(auto_exaggeration(50_000.0, 50.0, 30.0), 3.0);
    }
}

#[cfg(test)]
mod csp_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn viewer_script_hash_is_allowed() {
        let script = VIEWER
            .split_once("<script>")
            .and_then(|(_, r)| r.split_once("</script>"))
            .map(|(s, _)| s)
            .expect("inline viewer script");
        let want = format!(
            "'sha256-{}'",
            crate::automation::cartography::base64(&Sha256::digest(script.as_bytes()))
        );
        assert_eq!(
            VIEWER_SCRIPT_CSP, want,
            "scene-viewer.html changed: update VIEWER_SCRIPT_CSP and the desktop CSP"
        );
        // exactly one executable inline script (the others are data blocks)
        assert_eq!(VIEWER.matches("<script>").count(), 1);
        let tauri = include_str!("../../../apps/desktop/src-tauri/tauri.conf.json");
        assert!(
            tauri.contains(&format!("script-src 'self' 'wasm-unsafe-eval' {want}")),
            "apps/desktop/src-tauri/tauri.conf.json script-src lacks {want}"
        );
    }
}
