//! Minimal synchronous PMTiles v3 reader (the `pmtiles` crate's readers are
//! async-only; writing uses the crate's `PmTilesWriter`).
//!
//! Layout: 127-byte header -> root directory -> JSON metadata -> leaf
//! directories -> tile data. Directories are (optionally gzipped) varint
//! columns: count, tile-id deltas, run lengths, lengths, offsets.
//! Spec: <https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md>

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};

const HEADER_LEN: usize = 127;
const MAX_DEPTH: usize = 4;

#[derive(Debug, Clone, Copy)]
struct Entry {
    tile_id: u64,
    offset: u64,
    length: u32,
    run_length: u32,
}

#[derive(Debug, Clone)]
pub struct Header {
    pub root_offset: u64,
    pub root_length: u64,
    pub metadata_offset: u64,
    pub metadata_length: u64,
    pub leaf_offset: u64,
    pub data_offset: u64,
    pub addressed_tiles: u64,
    pub tile_entries: u64,
    pub tile_contents: u64,
    pub internal_compression: u8,
    pub tile_compression: u8,
    pub tile_type: u8,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// [west, south, east, north]
    pub bounds: [f64; 4],
}

pub struct PmReader {
    file: File,
    pub header: Header,
    pub metadata: serde_json::Value,
    root: Arc<Vec<Entry>>,
    leaves: Mutex<HashMap<u64, Arc<Vec<Entry>>>>,
}

fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn i32_at(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

#[cfg(unix)]
fn read_at(f: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.read_exact_at(buf, offset)
}

#[cfg(windows)]
fn read_at(f: &File, mut buf: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        let n = f.seek_read(buf, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf = &mut buf[n..];
        offset += n as u64;
    }
    Ok(())
}

fn decompress(data: Vec<u8>, compression: u8) -> Result<Vec<u8>, String> {
    match compression {
        0 | 1 => Ok(data), // unknown / none
        2 => {
            let mut out = Vec::with_capacity(data.len() * 4);
            flate2::read::GzDecoder::new(&data[..]).read_to_end(&mut out).map_err(|e| format!("gunzip: {e}"))?;
            Ok(out)
        }
        c => Err(format!("unsupported PMTiles compression {c} (only none/gzip)")),
    }
}

fn varint(b: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut v = 0u64;
    let mut shift = 0;
    loop {
        let byte = *b.get(*pos).ok_or("truncated PMTiles directory")?;
        *pos += 1;
        v |= ((byte & 0x7f) as u64) << shift;
        if byte < 0x80 {
            return Ok(v);
        }
        shift += 7;
        if shift > 63 {
            return Err("bad varint".into());
        }
    }
}

fn parse_directory(b: &[u8]) -> Result<Vec<Entry>, String> {
    let mut pos = 0;
    let n = varint(b, &mut pos)? as usize;
    if n > 10_000_000 {
        return Err("implausible PMTiles directory size".into());
    }
    let mut e = vec![Entry { tile_id: 0, offset: 0, length: 0, run_length: 0 }; n];
    let mut last = 0u64;
    for x in e.iter_mut() {
        last += varint(b, &mut pos)?;
        x.tile_id = last;
    }
    for x in e.iter_mut() {
        x.run_length = varint(b, &mut pos)? as u32;
    }
    for x in e.iter_mut() {
        x.length = varint(b, &mut pos)? as u32;
    }
    for i in 0..n {
        let v = varint(b, &mut pos)?;
        e[i].offset = if v == 0 && i > 0 { e[i - 1].offset + e[i - 1].length as u64 } else { v.saturating_sub(1) };
    }
    Ok(e)
}

/// Hilbert tile id (PMTiles spec), via the pmtiles crate.
pub fn tile_id(z: u8, x: u32, y: u32) -> Result<u64, String> {
    let c = pmtiles::TileCoord::new(z, x, y).map_err(|e| e.to_string())?;
    Ok(pmtiles::TileId::from(c).value())
}

impl PmReader {
    pub fn open(path: &Path) -> Result<PmReader, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut h = [0u8; HEADER_LEN];
        read_at(&file, &mut h, 0).map_err(|e| format!("{}: {e}", path.display()))?;
        if &h[0..7] != b"PMTiles" || h[7] != 3 {
            return Err(format!("{}: not a PMTiles v3 archive", path.display()));
        }
        let e7 = |o| i32_at(&h, o) as f64 / 1e7;
        let header = Header {
            root_offset: u64_at(&h, 8),
            root_length: u64_at(&h, 16),
            metadata_offset: u64_at(&h, 24),
            metadata_length: u64_at(&h, 32),
            leaf_offset: u64_at(&h, 40),
            data_offset: u64_at(&h, 56),
            addressed_tiles: u64_at(&h, 72),
            tile_entries: u64_at(&h, 80),
            tile_contents: u64_at(&h, 88),
            internal_compression: h[97],
            tile_compression: h[98],
            tile_type: h[99],
            min_zoom: h[100],
            max_zoom: h[101],
            bounds: [e7(102), e7(106), e7(110), e7(114)],
        };
        let read = |off: u64, len: u64| -> Result<Vec<u8>, String> {
            if len > 256 << 20 {
                return Err("implausible PMTiles section length".into());
            }
            let mut buf = vec![0u8; len as usize];
            read_at(&file, &mut buf, off).map_err(|e| e.to_string())?;
            Ok(buf)
        };
        let root = parse_directory(&decompress(read(header.root_offset, header.root_length)?, header.internal_compression)?)?;
        let metadata = if header.metadata_length > 0 {
            let raw = decompress(read(header.metadata_offset, header.metadata_length)?, header.internal_compression)?;
            serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null)
        } else {
            serde_json::Value::Null
        };
        Ok(PmReader { file, header, metadata, root: Arc::new(root), leaves: Mutex::new(HashMap::new()) })
    }

    fn leaf(&self, offset: u64, length: u32) -> Result<Arc<Vec<Entry>>, String> {
        if let Some(d) = self.leaves.lock().unwrap().get(&offset) {
            return Ok(d.clone());
        }
        let mut buf = vec![0u8; length as usize];
        read_at(&self.file, &mut buf, self.header.leaf_offset + offset).map_err(|e| e.to_string())?;
        let dir = Arc::new(parse_directory(&decompress(buf, self.header.internal_compression)?)?);
        let mut cache = self.leaves.lock().unwrap();
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(offset, dir.clone());
        Ok(dir)
    }

    /// Decompressed tile bytes, or None if the archive has no such tile.
    pub fn get(&self, z: u8, x: u32, y: u32) -> Result<Option<Vec<u8>>, String> {
        if z < self.header.min_zoom || z > self.header.max_zoom {
            return Ok(None);
        }
        let id = tile_id(z, x, y)?;
        let mut dir = self.root.clone();
        for _ in 0..MAX_DEPTH {
            // last entry with tile_id <= id
            let i = dir.partition_point(|e| e.tile_id <= id);
            if i == 0 {
                return Ok(None);
            }
            let e = dir[i - 1];
            if e.run_length == 0 {
                dir = self.leaf(e.offset, e.length)?;
                continue;
            }
            if id >= e.tile_id + e.run_length as u64 {
                return Ok(None);
            }
            let mut buf = vec![0u8; e.length as usize];
            read_at(&self.file, &mut buf, self.header.data_offset + e.offset).map_err(|err| err.to_string())?;
            return decompress(buf, self.header.tile_compression).map(Some);
        }
        Err("PMTiles directory nesting too deep".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pmtiles::{Compression, PmTilesWriter, TileCoord, TileType};

    #[test]
    fn roundtrip_with_crate_writer() {
        let dir = std::env::temp_dir().join(format!("pmt-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.pmtiles");
        let f = std::io::BufWriter::new(File::create(&path).unwrap());
        let mut w = PmTilesWriter::new(TileType::Mvt)
            .tile_compression(Compression::Gzip)
            .min_zoom(0)
            .max_zoom(6)
            .bounds(140.0, -10.0, 150.0, -2.0)
            .metadata(r#"{"hello":"world"}"#)
            .create(f)
            .unwrap();
        // every tile of z0..=6 inside the bbox, in tile-id order, distinct payloads
        let mut expected = Vec::new();
        for z in 0..=6u8 {
            let (x0, y0) = crate::tile::lonlat_to_tile(140.0, -2.0, z);
            let (x1, y1) = crate::tile::lonlat_to_tile(150.0, -10.0, z);
            let mut ids: Vec<(u64, u32, u32)> =
                (x0..=x1).flat_map(|x| (y0..=y1).map(move |y| (tile_id(z, x, y).unwrap(), x, y))).collect();
            ids.sort();
            for (_, x, y) in ids {
                let payload = format!("tile {z}/{x}/{y}").into_bytes();
                w.add_tile(TileCoord::new(z, x, y).unwrap(), &payload).unwrap();
                expected.push((z, x, y, payload));
            }
        }
        w.finalize().unwrap();
        let r = PmReader::open(&path).unwrap();
        assert_eq!(r.header.max_zoom, 6);
        assert_eq!(r.metadata["hello"], "world");
        for (z, x, y, payload) in &expected {
            assert_eq!(r.get(*z, *x, *y).unwrap().as_ref(), Some(payload), "{z}/{x}/{y}");
        }
        assert_eq!(r.get(6, 0, 0).unwrap(), None);
        assert_eq!(r.get(7, 0, 0).unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
