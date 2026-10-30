//! Mapbox Vector Tile v2.1 encoder with tile-space geometry processing:
//! project -> Douglas-Peucker simplify -> clip (buffered tile) -> quantise ->
//! fix winding order. Hand-rolled protobuf keeps the hot path allocation-light
//! and dependency-free; production code could swap in martin-core or geozero.

use crate::tile::TileProjector;
use crate::wkb::Geom;
use std::collections::HashMap;

pub const EXTENT: u32 = 4096;
pub const BUFFER: f64 = 64.0;

const MOVE_TO: u32 = 1;
const LINE_TO: u32 = 2;
const CLOSE_PATH: u32 = 7;

#[inline]
fn command(id: u32, count: u32) -> u32 {
    (id & 0x7) | (count << 3)
}
#[inline]
fn zigzag(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

/// Tiny protobuf writer (varint / length-delimited / packed).
pub mod pb {
    #[inline]
    pub fn varint(buf: &mut Vec<u8>, mut v: u64) {
        while v >= 0x80 {
            buf.push((v as u8) | 0x80);
            v >>= 7;
        }
        buf.push(v as u8);
    }
    #[inline]
    pub fn key(buf: &mut Vec<u8>, field: u32, wire: u32) {
        varint(buf, ((field << 3) | wire) as u64);
    }
    pub fn bytes(buf: &mut Vec<u8>, field: u32, data: &[u8]) {
        key(buf, field, 2);
        varint(buf, data.len() as u64);
        buf.extend_from_slice(data);
    }
    pub fn packed(buf: &mut Vec<u8>, field: u32, vals: &[u32], tmp: &mut Vec<u8>) {
        if vals.is_empty() {
            return;
        }
        tmp.clear();
        for &v in vals {
            varint(tmp, v as u64);
        }
        bytes(buf, field, tmp);
    }
}

/// Per-zoom generalisation parameters, in tile units (extent 4096; a 512 px
/// tile => 8 units per CSS pixel).
#[derive(Clone, Copy, Debug, Default)]
pub struct Params {
    pub tolerance: f64,
    pub min_size: f64,
    /// Overview mode: features smaller than `min_size` are not dropped but
    /// counted on a grid of `density_cell` tile units (0 = off) and emitted
    /// as a separate `<layer>:density` point layer with a `count` attribute.
    pub density_cell: f64,
    /// Overview mode for point layers: every point goes into the density grid.
    pub points_density: bool,
}

/// Feature counts on a regular grid over the tile (overview "density points").
pub struct Density {
    cell: f64,
    n: usize,
    counts: Vec<u32>,
    pub total: u64,
}

impl Density {
    fn new(cell: f64) -> Density {
        let n = (EXTENT as f64 / cell).ceil().max(1.0) as usize;
        Density { cell, n, counts: vec![0; n * n], total: 0 }
    }

    /// Count a feature at tile-space position `c`. Only the tile proper (no
    /// buffer) counts, so every feature lands in exactly one tile per zoom.
    #[inline]
    fn add(&mut self, c: [f64; 2]) {
        let e = EXTENT as f64;
        if c[0] >= 0.0 && c[0] < e && c[1] >= 0.0 && c[1] < e {
            let (col, row) = ((c[0] / self.cell) as usize, (c[1] / self.cell) as usize);
            self.counts[row.min(self.n - 1) * self.n + col.min(self.n - 1)] += 1;
            self.total += 1;
        }
    }

    pub fn cells(&self) -> usize {
        self.counts.iter().filter(|&&c| c > 0).count()
    }

    /// Largest feature count in one cell.
    pub fn max(&self) -> u32 {
        self.counts.iter().copied().max().unwrap_or(0)
    }

    /// Encode as an MVT layer of points (cell centres) with a `count` tag.
    pub fn encode(&self, name: &str) -> Option<Vec<u8>> {
        let mut enc = LayerEncoder::new(name, vec!["count".to_string()]);
        for (i, &c) in self.counts.iter().enumerate() {
            if c == 0 {
                continue;
            }
            let (row, col) = (i / self.n, i % self.n);
            let x = ((col as f64 + 0.5) * self.cell).round() as i32;
            let y = ((row as f64 + 0.5) * self.cell).round() as i32;
            enc.add_raw_point(x, y, vec![(0, Val::Int(c as i64))]);
        }
        (!enc.is_empty()).then(|| enc.finish())
    }
}

/// Attribute value to encode as a tag.
#[derive(Debug, Clone)]
pub enum Val {
    Str(String),
    Int(i64),
    Dbl(f64),
}

#[derive(Hash, PartialEq, Eq)]
enum ValKey {
    Str(String),
    Int(i64),
    Dbl(u64),
}

#[derive(Default)]
struct Scratch {
    a: Vec<[f64; 2]>,
    b: Vec<[f64; 2]>,
    c: Vec<[f64; 2]>,
    d: Vec<[f64; 2]>,
    ints: Vec<[i32; 2]>,
    parts: Vec<Vec<[f64; 2]>>,
    keep: Vec<bool>,
    stack: Vec<(usize, usize)>,
}

/// Builds one MVT layer.
pub struct LayerEncoder {
    name: String,
    keys: Vec<String>,
    values: Vec<u8>,
    value_index: HashMap<ValKey, u32>,
    features: Vec<u8>,
    pub count: u32,
    cmds: Vec<u32>,
    tags: Vec<u32>,
    fbuf: Vec<u8>,
    tmp: Vec<u8>,
    s: Scratch,
    /// Grid of sub-pixel features (overview mode only).
    pub density: Option<Density>,
}

impl LayerEncoder {
    pub fn new(name: &str, keys: Vec<String>) -> Self {
        LayerEncoder {
            name: name.to_string(),
            keys,
            values: Vec::new(),
            value_index: HashMap::new(),
            features: Vec::with_capacity(64 * 1024),
            count: 0,
            cmds: Vec::new(),
            tags: Vec::new(),
            fbuf: Vec::new(),
            tmp: Vec::new(),
            s: Scratch::default(),
            density: None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    fn value_idx(&mut self, v: Val) -> u32 {
        let key = match &v {
            Val::Str(s) => ValKey::Str(s.clone()),
            Val::Int(i) => ValKey::Int(*i),
            Val::Dbl(d) => ValKey::Dbl(d.to_bits()),
        };
        if let Some(&i) = self.value_index.get(&key) {
            return i;
        }
        let mut m = Vec::with_capacity(16);
        match v {
            Val::Str(s) => pb::bytes(&mut m, 1, s.as_bytes()),
            Val::Dbl(d) => {
                pb::key(&mut m, 3, 1);
                m.extend_from_slice(&d.to_le_bytes());
            }
            Val::Int(i) if i >= 0 => {
                pb::key(&mut m, 5, 0);
                pb::varint(&mut m, i as u64);
            }
            Val::Int(i) => {
                pb::key(&mut m, 6, 0);
                pb::varint(&mut m, ((i << 1) ^ (i >> 63)) as u64);
            }
        }
        pb::bytes(&mut self.values, 4, &m);
        let idx = self.value_index.len() as u32;
        self.value_index.insert(key, idx);
        idx
    }

    /// Process + encode one feature. Returns false if nothing survived
    /// clipping/generalisation (the feature is then omitted).
    pub fn add(&mut self, id: Option<u64>, attrs: Vec<(u32, Val)>, geom: &Geom, proj: &TileProjector, p: Params) -> bool {
        self.cmds.clear();
        if p.density_cell > 0.0 && self.density.is_none() {
            self.density = Some(Density::new(p.density_cell));
        }
        if p.points_density {
            if let (Geom::Points(pts), Some(d)) = (geom, self.density.as_mut()) {
                for &[lon, lat] in pts {
                    d.add(proj.project(lon, lat));
                }
                return false;
            }
        }
        let mut tiny = None;
        let gtype = match geom {
            Geom::Points(pts) if encode_points(pts, proj, &mut self.s, &mut self.cmds) => 1,
            Geom::Lines(ls) if encode_lines(ls, proj, p, &mut self.s, &mut self.cmds, &mut tiny) => 2,
            Geom::Polygons(ps) if encode_polygons(ps, proj, p, &mut self.s, &mut self.cmds, &mut tiny) => 3,
            _ => {
                if let (Some(c), Some(d)) = (tiny, self.density.as_mut()) {
                    d.add(c);
                }
                return false;
            }
        };
        self.write_feature(id, attrs, gtype);
        true
    }

    /// A single point feature already in tile coordinates (density layers).
    fn add_raw_point(&mut self, x: i32, y: i32, attrs: Vec<(u32, Val)>) {
        self.cmds.clear();
        self.cmds.push(command(MOVE_TO, 1));
        self.cmds.push(zigzag(x));
        self.cmds.push(zigzag(y));
        self.write_feature(None, attrs, 1);
    }

    fn write_feature(&mut self, id: Option<u64>, attrs: Vec<(u32, Val)>, gtype: u64) {
        self.tags.clear();
        for (k, v) in attrs {
            let vi = self.value_idx(v);
            self.tags.push(k);
            self.tags.push(vi);
        }
        self.fbuf.clear();
        if let Some(id) = id {
            pb::key(&mut self.fbuf, 1, 0);
            pb::varint(&mut self.fbuf, id);
        }
        pb::packed(&mut self.fbuf, 2, &self.tags, &mut self.tmp);
        pb::key(&mut self.fbuf, 3, 0);
        pb::varint(&mut self.fbuf, gtype);
        pb::packed(&mut self.fbuf, 4, &self.cmds, &mut self.tmp);
        pb::bytes(&mut self.features, 2, &self.fbuf);
        self.count += 1;
    }

    /// Serialise the Layer message.
    pub fn finish(self) -> Vec<u8> {
        let mut m = Vec::with_capacity(self.features.len() + self.values.len() + 256);
        pb::bytes(&mut m, 1, self.name.as_bytes());
        m.extend_from_slice(&self.features);
        for k in &self.keys {
            pb::bytes(&mut m, 3, k.as_bytes());
        }
        m.extend_from_slice(&self.values);
        pb::key(&mut m, 5, 0);
        pb::varint(&mut m, EXTENT as u64);
        pb::key(&mut m, 15, 0);
        pb::varint(&mut m, 2);
        m
    }
}

/// Wrap encoded layers into a Tile message.
pub fn tile(layers: &[Vec<u8>]) -> Vec<u8> {
    let mut t = Vec::with_capacity(layers.iter().map(|l| l.len() + 8).sum());
    for l in layers {
        pb::bytes(&mut t, 3, l);
    }
    t
}

// ---------------------------------------------------------------------------
// geometry processing

const LO: f64 = -BUFFER;
const HI: f64 = EXTENT as f64 + BUFFER;

#[derive(Clone, Copy)]
struct BBox {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl BBox {
    fn of(pts: &[[f64; 2]]) -> BBox {
        let mut b = BBox { x0: f64::INFINITY, y0: f64::INFINITY, x1: f64::NEG_INFINITY, y1: f64::NEG_INFINITY };
        for &[x, y] in pts {
            b.x0 = b.x0.min(x);
            b.y0 = b.y0.min(y);
            b.x1 = b.x1.max(x);
            b.y1 = b.y1.max(y);
        }
        b
    }
    fn outside(&self) -> bool {
        self.x1 < LO || self.x0 > HI || self.y1 < LO || self.y0 > HI
    }
    fn inside(&self) -> bool {
        self.x0 >= LO && self.x1 <= HI && self.y0 >= LO && self.y1 <= HI
    }
    fn tiny(&self, min: f64) -> bool {
        min > 0.0 && (self.x1 - self.x0) < min && (self.y1 - self.y0) < min
    }
    fn center(&self) -> [f64; 2] {
        [(self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0]
    }
}

#[inline]
fn push_delta(cmds: &mut Vec<u32>, cur: &mut (i32, i32), q: [i32; 2]) {
    cmds.push(zigzag(q[0] - cur.0));
    cmds.push(zigzag(q[1] - cur.1));
    *cur = (q[0], q[1]);
}

fn encode_points(pts: &[[f64; 2]], proj: &TileProjector, s: &mut Scratch, cmds: &mut Vec<u32>) -> bool {
    s.ints.clear();
    for &[lon, lat] in pts {
        let [x, y] = proj.project(lon, lat);
        if (LO..=HI).contains(&x) && (LO..=HI).contains(&y) {
            s.ints.push([x.round() as i32, y.round() as i32]);
        }
    }
    if s.ints.is_empty() {
        return false;
    }
    cmds.push(command(MOVE_TO, s.ints.len() as u32));
    let mut cur = (0, 0);
    for &q in &s.ints {
        push_delta(cmds, &mut cur, q);
    }
    true
}

fn emit_line(pts: &[[f64; 2]], ints: &mut Vec<[i32; 2]>, cmds: &mut Vec<u32>, cur: &mut (i32, i32)) -> bool {
    ints.clear();
    for &[x, y] in pts {
        let q = [x.round() as i32, y.round() as i32];
        if ints.last() != Some(&q) {
            ints.push(q);
        }
    }
    if ints.len() < 2 {
        return false;
    }
    cmds.push(command(MOVE_TO, 1));
    push_delta(cmds, cur, ints[0]);
    cmds.push(command(LINE_TO, (ints.len() - 1) as u32));
    for &q in &ints[1..] {
        push_delta(cmds, cur, q);
    }
    true
}

fn encode_lines(
    lines: &[Vec<[f64; 2]>],
    proj: &TileProjector,
    p: Params,
    s: &mut Scratch,
    cmds: &mut Vec<u32>,
    tiny: &mut Option<[f64; 2]>,
) -> bool {
    let mut cur = (0, 0);
    let mut any = false;
    for line in lines {
        s.a.clear();
        s.a.extend(line.iter().map(|&[lon, lat]| proj.project(lon, lat)));
        if s.a.len() < 2 {
            continue;
        }
        let bb = BBox::of(&s.a);
        if bb.outside() {
            continue;
        }
        if bb.tiny(p.min_size) {
            tiny.get_or_insert(bb.center());
            continue;
        }
        simplify(&s.a, p.tolerance, &mut s.b, &mut s.keep, &mut s.stack);
        if bb.inside() {
            any |= emit_line(&s.b, &mut s.ints, cmds, &mut cur);
        } else {
            clip_line(&s.b, &mut s.parts);
            for part in &s.parts {
                any |= emit_line(part, &mut s.ints, cmds, &mut cur);
            }
        }
    }
    any
}

fn signed_area2(r: &[[i32; 2]]) -> i64 {
    let n = r.len();
    let mut a = 0i64;
    for i in 0..n {
        let [x0, y0] = r[i];
        let [x1, y1] = r[(i + 1) % n];
        a += x0 as i64 * y1 as i64 - x1 as i64 * y0 as i64;
    }
    a
}

fn encode_polygons(
    polys: &[Vec<Vec<[f64; 2]>>],
    proj: &TileProjector,
    p: Params,
    s: &mut Scratch,
    cmds: &mut Vec<u32>,
    tiny: &mut Option<[f64; 2]>,
) -> bool {
    let mut cur = (0, 0);
    let mut any = false;
    for rings in polys {
        for (ri, ring) in rings.iter().enumerate() {
            let exterior = ri == 0;
            s.a.clear();
            s.a.extend(ring.iter().map(|&[lon, lat]| proj.project(lon, lat)));
            if s.a.len() >= 2 && s.a.first() == s.a.last() {
                s.a.pop(); // work on open rings
            }
            if s.a.len() < 3 {
                if exterior { break } else { continue }
            }
            let bb = BBox::of(&s.a);
            if bb.outside() {
                if exterior { break } else { continue } // no exterior => drop holes too
            }
            if bb.tiny(p.min_size) {
                if exterior {
                    tiny.get_or_insert(bb.center());
                    break;
                }
                continue;
            }
            let first = s.a[0];
            s.a.push(first);
            simplify(&s.a, p.tolerance, &mut s.b, &mut s.keep, &mut s.stack);
            s.b.pop();
            if s.b.len() < 3 {
                if exterior { break } else { continue }
            }
            let pts: &[[f64; 2]] = if bb.inside() {
                &s.b
            } else {
                clip_ring(&s.b, &mut s.c, &mut s.d);
                &s.c
            };
            s.ints.clear();
            for &[x, y] in pts {
                let q = [x.round() as i32, y.round() as i32];
                if s.ints.last() != Some(&q) {
                    s.ints.push(q);
                }
            }
            while s.ints.len() > 1 && s.ints.first() == s.ints.last() {
                s.ints.pop();
            }
            if s.ints.len() < 3 {
                if exterior { break } else { continue }
            }
            let area = signed_area2(&s.ints);
            if area == 0 {
                if exterior { break } else { continue }
            }
            // MVT: exterior rings have positive surveyor's area in tile space
            // (clockwise on screen, y down); holes negative.
            if (area > 0) != exterior {
                s.ints.reverse();
            }
            cmds.push(command(MOVE_TO, 1));
            push_delta(cmds, &mut cur, s.ints[0]);
            cmds.push(command(LINE_TO, (s.ints.len() - 1) as u32));
            for i in 1..s.ints.len() {
                let q = s.ints[i];
                push_delta(cmds, &mut cur, q);
            }
            cmds.push(command(CLOSE_PATH, 1));
            any = true;
        }
    }
    any
}

#[inline]
fn seg_dist2(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let (ex, ey) = if len2 == 0.0 {
        (p[0] - a[0], p[1] - a[1])
    } else {
        let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
        (p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
    };
    ex * ex + ey * ey
}

/// Iterative Douglas-Peucker.
fn simplify(pts: &[[f64; 2]], tol: f64, out: &mut Vec<[f64; 2]>, keep: &mut Vec<bool>, stack: &mut Vec<(usize, usize)>) {
    out.clear();
    let n = pts.len();
    if n <= 2 || tol <= 0.0 {
        out.extend_from_slice(pts);
        return;
    }
    keep.clear();
    keep.resize(n, false);
    keep[0] = true;
    keep[n - 1] = true;
    stack.clear();
    stack.push((0, n - 1));
    let tol2 = tol * tol;
    while let Some((s, e)) = stack.pop() {
        let (mut max, mut idx) = (0.0, 0);
        for i in s + 1..e {
            let d = seg_dist2(pts[i], pts[s], pts[e]);
            if d > max {
                max = d;
                idx = i;
            }
        }
        if max > tol2 {
            keep[idx] = true;
            stack.push((s, idx));
            stack.push((idx, e));
        }
    }
    out.extend(pts.iter().zip(keep.iter()).filter(|(_, k)| **k).map(|(p, _)| *p));
}

/// Sutherland-Hodgman clip of an open ring against the buffered tile square.
fn clip_ring(input: &[[f64; 2]], out: &mut Vec<[f64; 2]>, tmp: &mut Vec<[f64; 2]>) {
    out.clear();
    out.extend_from_slice(input);
    for edge in 0..4 {
        if out.is_empty() {
            return;
        }
        tmp.clear();
        let n = out.len();
        for i in 0..n {
            let cur = out[i];
            let prev = out[(i + n - 1) % n];
            let (ci, pi) = (inside(edge, cur), inside(edge, prev));
            if ci {
                if !pi {
                    tmp.push(intersect(edge, prev, cur));
                }
                tmp.push(cur);
            } else if pi {
                tmp.push(intersect(edge, prev, cur));
            }
        }
        std::mem::swap(out, tmp);
    }
}

#[inline]
fn inside(edge: u8, p: [f64; 2]) -> bool {
    match edge {
        0 => p[0] >= LO,
        1 => p[0] <= HI,
        2 => p[1] >= LO,
        _ => p[1] <= HI,
    }
}

#[inline]
fn intersect(edge: u8, a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    match edge {
        0 | 1 => {
            let x = if edge == 0 { LO } else { HI };
            let t = (x - a[0]) / (b[0] - a[0]);
            [x, a[1] + t * (b[1] - a[1])]
        }
        _ => {
            let y = if edge == 2 { LO } else { HI };
            let t = (y - a[1]) / (b[1] - a[1]);
            [a[0] + t * (b[0] - a[0]), y]
        }
    }
}

/// Liang-Barsky segment clip; endpoints are returned bit-exact when unclipped.
fn clip_segment(a: [f64; 2], b: [f64; 2]) -> Option<([f64; 2], [f64; 2])> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [(-dx, a[0] - LO), (dx, HI - a[0]), (-dy, a[1] - LO), (dy, HI - a[1])] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                if r > t1 {
                    return None;
                }
                t0 = t0.max(r);
            } else {
                if r < t0 {
                    return None;
                }
                t1 = t1.min(r);
            }
        }
    }
    let pa = if t0 == 0.0 { a } else { [a[0] + t0 * dx, a[1] + t0 * dy] };
    let pb = if t1 == 1.0 { b } else { [a[0] + t1 * dx, a[1] + t1 * dy] };
    Some((pa, pb))
}

fn clip_line(pts: &[[f64; 2]], parts: &mut Vec<Vec<[f64; 2]>>) {
    parts.clear();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    for w in pts.windows(2) {
        match clip_segment(w[0], w[1]) {
            Some((a, b)) => {
                if cur.last() != Some(&a) {
                    if cur.len() >= 2 {
                        parts.push(std::mem::take(&mut cur));
                    }
                    cur.clear();
                    cur.push(a);
                }
                cur.push(b);
                if b != w[1] {
                    // segment leaves the tile: close this part
                    if cur.len() >= 2 {
                        parts.push(std::mem::take(&mut cur));
                    }
                    cur.clear();
                }
            }
            None => {
                if cur.len() >= 2 {
                    parts.push(std::mem::take(&mut cur));
                }
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        parts.push(cur);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_and_commands() {
        assert_eq!(zigzag(0), 0);
        assert_eq!(zigzag(-1), 1);
        assert_eq!(zigzag(1), 2);
        assert_eq!(zigzag(-2), 3);
        assert_eq!(command(MOVE_TO, 1), 9);
        assert_eq!(command(CLOSE_PATH, 1), 15);
    }

    #[test]
    fn ring_clip_keeps_inside_part() {
        let ring = [[-100.0, -100.0], [5000.0, -100.0], [5000.0, 5000.0], [-100.0, 5000.0]];
        let (mut out, mut tmp) = (Vec::new(), Vec::new());
        clip_ring(&ring, &mut out, &mut tmp);
        let bb = BBox::of(&out);
        assert!(bb.x0 >= LO && bb.x1 <= HI && bb.y0 >= LO && bb.y1 <= HI);
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn line_clip_splits_parts() {
        let line = [[-500.0, 100.0], [100.0, 100.0], [100.0, 9000.0], [200.0, 9000.0], [200.0, 200.0]];
        let mut parts = Vec::new();
        clip_line(&line, &mut parts);
        assert_eq!(parts.len(), 2, "{parts:?}");
    }

    #[test]
    fn simplify_removes_collinear() {
        let pts: Vec<[f64; 2]> = (0..=10).map(|i| [i as f64 * 10.0, 0.0]).collect();
        let (mut out, mut keep, mut stack) = (Vec::new(), Vec::new(), Vec::new());
        simplify(&pts, 1.0, &mut out, &mut keep, &mut stack);
        assert_eq!(out, vec![[0.0, 0.0], [100.0, 0.0]]);
    }

    #[test]
    fn polygon_orientation_is_positive() {
        let proj = TileProjector::new(0, 0, 0, EXTENT);
        // counter-clockwise lon/lat square (would be negative on screen)
        let sq = vec![vec![[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0], [-10.0, -10.0]]];
        let mut enc = LayerEncoder::new("t", vec![]);
        assert!(enc.add(Some(1), vec![], &Geom::Polygons(vec![sq]), &proj, Params { tolerance: 0.0, min_size: 0.0, ..Default::default() }));
        assert!(!enc.finish().is_empty());
    }

    #[test]
    fn tiny_polygons_become_density_points() {
        use crate::tile::{tile_bounds, TileProjector};
        let (z, x, y) = (8u8, 233u32, 135u32);
        let b = tile_bounds(z, x, y);
        let proj = TileProjector::new(z, x, y, EXTENT);
        let p = Params { tolerance: 2.0, min_size: 16.0, density_cell: 32.0, points_density: false };
        let mut enc = LayerEncoder::new("t", vec![]);
        // 200 tiny squares (~1e-5 deg) in the same corner cell + one big polygon.
        let (lon, lat) = (b[0] + 1e-4, b[3] - 1e-4);
        for i in 0..200 {
            let d = 1e-6 * i as f64;
            let sq = vec![vec![[lon + d, lat], [lon + d + 1e-5, lat], [lon + d + 1e-5, lat - 1e-5], [lon + d, lat - 1e-5], [lon + d, lat]]];
            assert!(!enc.add(Some(i), vec![], &Geom::Polygons(vec![sq]), &proj, p));
        }
        let big = vec![vec![[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]], [b[0], b[3]]]];
        assert!(enc.add(Some(999), vec![], &Geom::Polygons(vec![big]), &proj, p));
        let d = enc.density.as_ref().expect("density grid");
        assert_eq!(d.total, 200);
        assert_eq!(d.cells(), 1);
        assert!(d.encode("t:density").is_some());
        assert_eq!(enc.count, 1);
    }
}
