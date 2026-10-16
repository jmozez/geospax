//! Headless engine benchmark: per-zoom tile render latency for chosen layers,
//! sampling tiles where the data actually is (random features -> their tiles).
//!
//!   geospax-bench --data DIR [--layer ID]... [--zooms 11,12,13,14] [--samples 60]
//!               [--reader arrow|features] [--arrow LAYER_ID]
//!               [--overview LAYER_ID[:MAXZOOM]] [--state-dir DIR] [--json out.json]
//!
//! Tile rendering is single-threaded on purpose: it measures per-tile latency,
//! not throughput. `--overview` builds a pyramid (all cores) and then measures
//! serving latency from the archive.

use geospax_engine::{overview, tile, Engine, EngineConfig, ReadMode, RenderOpts};
use std::sync::atomic::AtomicBool;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Instant;

struct Args {
    data: Vec<PathBuf>,
    layers: Vec<String>,
    zooms: Vec<u8>,
    samples: usize,
    arrow: Vec<String>,
    json: Option<PathBuf>,
    reader: ReadMode,
    overviews: Vec<String>,
    state_dir: Option<PathBuf>,
}

fn parse_args() -> Args {
    let mut a = Args {
        data: vec![],
        layers: vec![],
        zooms: vec![11, 12, 13, 14],
        samples: 60,
        arrow: vec![],
        json: None,
        reader: ReadMode::Arrow,
        overviews: vec![],
        state_dir: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().unwrap_or_else(|| panic!("missing value for {k}"));
        match k.as_str() {
            "--data" => a.data.push(v().into()),
            "--layer" => a.layers.push(v()),
            "--zooms" => a.zooms = v().split(',').map(|z| z.trim().parse().expect("zoom")).collect(),
            "--samples" => a.samples = v().parse().expect("samples"),
            "--arrow" => a.arrow.push(v()),
            "--json" => a.json = Some(v().into()),
            "--reader" => a.reader = v().parse().unwrap_or_else(|e| panic!("{e}")),
            "--overview" => a.overviews.push(v()),
            "--state-dir" => a.state_dir = Some(v().into()),
            "-h" | "--help" => {
                println!(
                    "geospax-bench --data DIR [--layer ID]... [--zooms 11,12,13,14] [--samples 60] [--reader arrow|features] \
                     [--arrow ID] [--overview ID[:MAXZOOM]] [--state-dir DIR] [--json FILE]"
                );
                std::process::exit(0);
            }
            other => panic!("unknown argument {other}"),
        }
    }
    if a.data.is_empty() {
        a.data.push("data".into());
    }
    a
}

fn pct(v: &[f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    let args = parse_args();
    let t_open = Instant::now();
    let engine = Engine::open(EngineConfig {
        plugins: Default::default(),
        data: args.data.clone(),
        cache_tiles: 0,
        threads: 1,
        bench_log: None,
        read_mode: args.reader,
        state_dir: args.state_dir.clone(),
        devices: Default::default(),
        automation: Default::default(),
        phone: Default::default(),
    })
    .expect("open engine");
    println!(
        "opened {} layers in {:.0} ms (reader: {})",
        engine.layers().len(),
        t_open.elapsed().as_secs_f64() * 1000.0,
        args.reader.as_str()
    );
    for w in &engine.warnings {
        eprintln!("warning: {w}");
    }
    let layer_ids: Vec<String> = if args.layers.is_empty() && !args.overviews.is_empty() {
        vec![]
    } else if args.layers.is_empty() {
        engine.layers().iter().map(|l| l.info.id.clone()).collect()
    } else {
        args.layers.clone()
    };

    let mut report = Vec::new();
    println!("\n| layer | z | tiles | p50 ms | p95 ms | max ms | mean ms | feats/tile | KB/tile | setup % | read % | proc % | enc % | teardown % |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for id in &layer_ids {
        let Some(layer) = engine.layer(id) else {
            eprintln!("unknown layer {id}");
            continue;
        };
        let info = &layer.info;
        let pts = layer.sample_lonlat(args.samples * 4, 0x5EED).expect("sample");
        for &z in &args.zooms {
            if z < info.minzoom {
                println!("| {id} | {z} | below minzoom {} | | | | | | | | | |", info.minzoom);
                continue;
            }
            let tiles: BTreeSet<(u32, u32)> =
                pts.iter().map(|p| tile::lonlat_to_tile(p[0], p[1], z)).take(args.samples * 4).collect();
            let tiles: Vec<_> = tiles.into_iter().take(args.samples).collect();
            let (mut lat, mut feats, mut bytes, mut scanned, mut read, mut trunc) = (vec![], 0u64, 0u64, 0u64, 0.0, 0);
            let (mut setup, mut procm, mut encm, mut tear) = (0.0, 0.0, 0.0, 0.0);
            for &(x, y) in &tiles {
                let r = engine.render_tile(&layer, z, x, y, &RenderOpts::default()).expect("render");
                lat.push(r.total_ms);
                feats += r.features as u64;
                bytes += r.bytes.len() as u64;
                scanned += r.scanned as u64;
                read += r.read_ms;
                setup += r.setup_ms;
                procm += r.proc_ms;
                encm += r.enc_ms;
                tear += r.teardown_ms;
                trunc += r.truncated as u32;
            }
            let n = tiles.len().max(1) as f64;
            let total: f64 = lat.iter().sum();
            lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let row = serde_json::json!({
                "layer": id, "driver": info.driver, "reader": args.reader.as_str(), "z": z, "tiles": tiles.len(),
                "p50_ms": pct(&lat, 0.5), "p95_ms": pct(&lat, 0.95), "max_ms": lat.last().copied().unwrap_or(0.0),
                "mean_ms": total / n, "features_per_tile": feats as f64 / n, "kb_per_tile": bytes as f64 / n / 1024.0,
                "scanned_per_tile": scanned as f64 / n, "read_share": if total > 0.0 { read / total } else { 0.0 },
                "setup_share": setup / total.max(1e-9), "proc_share": procm / total.max(1e-9),
                "enc_share": encm / total.max(1e-9), "teardown_share": tear / total.max(1e-9),
                "truncated": trunc,
            });
            println!(
                "| {id} | {z} | {} | {:.1} | {:.1} | {:.1} | {:.1} | {:.0} | {:.1} | {:.0}% | {:.0}% | {:.0}% | {:.0}% | {:.0}% |",
                tiles.len(),
                pct(&lat, 0.5),
                pct(&lat, 0.95),
                lat.last().copied().unwrap_or(0.0),
                total / n,
                feats as f64 / n,
                bytes as f64 / n / 1024.0,
                100.0 * setup / total.max(1e-9),
                100.0 * read / total.max(1e-9),
                100.0 * procm / total.max(1e-9),
                100.0 * encm / total.max(1e-9),
                100.0 * tear / total.max(1e-9),
            );
            report.push(row);
        }
    }

    #[cfg(feature = "arrow")]
    for id in &args.arrow {
        let Some(layer) = engine.layer(id) else { continue };
        let t = Instant::now();
        match geospax_engine::arrow_export::export_points(&layer, None, usize::MAX, args.reader) {
            Ok(x) => {
                let total = t.elapsed().as_secs_f64() * 1000.0;
                println!(
                    "\nArrow export {id}: {} rows, {:.1} MB, read {:.0} ms + encode {:.0} ms = {:.0} ms",
                    x.rows,
                    x.bytes.len() as f64 / 1e6,
                    x.read_ms,
                    x.encode_ms,
                    total
                );
                report.push(serde_json::json!({ "arrow_layer": id, "reader": args.reader.as_str(), "rows": x.rows, "mb": x.bytes.len() as f64 / 1e6,
                    "read_ms": x.read_ms, "encode_ms": x.encode_ms, "total_ms": total }));
            }
            Err(e) => eprintln!("arrow export {id}: {e}"),
        }
    }

    for spec in &args.overviews {
        let (id, mz) = match spec.split_once(':') {
            Some((id, z)) => (id, Some(z.parse::<u8>().expect("maxzoom"))),
            None => (spec.as_str(), None),
        };
        let Some(layer) = engine.layer(id) else {
            eprintln!("unknown layer {id}");
            continue;
        };
        let Some(mz) = mz.or_else(|| overview::suggested_max_zoom(&layer.info)) else {
            eprintln!("{id}: no overview needed (pass {id}:MAXZOOM to force)");
            continue;
        };
        let out = overview::path_for(&engine.state_dir, id);
        let cancel = AtomicBool::new(false);
        let last = std::cell::Cell::new(0u64);
        let rep = overview::build(&engine, &layer, mz, &out, &cancel, &|done, total| {
            let pctd = done * 10 / total.max(1);
            if pctd != last.get() {
                last.set(pctd);
                eprint!("\r  building {id} z0-{mz}: {done}/{total} tiles");
            }
        })
        .expect("overview build");
        eprintln!();
        println!(
            "\nOverview {id} z0-{mz}: {} of {} tiles non-empty, {:.2} MB file ({:.2} MB raw MVT), {:.1} s on {} threads",
            rep.tiles_written,
            rep.tiles_visited,
            rep.file_bytes as f64 / 1e6,
            rep.bytes_raw as f64 / 1e6,
            rep.build_ms / 1000.0,
            rayon::current_num_threads()
        );
        println!("| z | tiles | max tile KB | mean tile KB | ms | densest cell (max / p90) |");
        println!("|---|---|---|---|---|---|");
        for zr in &rep.per_zoom {
            println!(
                "| {} | {} | {:.1} | {:.1} | {:.0} | {} / {} |",
                zr.z,
                zr.tiles,
                zr.max_tile_bytes as f64 / 1024.0,
                zr.bytes_raw as f64 / 1024.0 / zr.tiles.max(1) as f64,
                zr.ms,
                zr.density_max,
                zr.density_p90
            );
        }
        // serving latency straight from the archive (what /tiles does for z <= mz)
        let ov = overview::Overview::open(&out, &overview::Fingerprint::of(&layer)).expect("open overview");
        let pts = layer.sample_lonlat(args.samples * 4, 0xBEEF).expect("sample");
        let mut lat = Vec::new();
        let mut sizes = Vec::new();
        for z in (mz.saturating_sub(3))..=mz {
            let tiles: BTreeSet<(u32, u32)> = pts.iter().map(|p| tile::lonlat_to_tile(p[0], p[1], z)).collect();
            for (x, y) in tiles.into_iter().take(args.samples) {
                let t = Instant::now();
                let b = ov.reader.get(z, x, y).expect("read").unwrap_or_default();
                lat.push(t.elapsed().as_secs_f64() * 1000.0);
                sizes.push(b.len());
            }
        }
        lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "archive reads (z{}-{mz}, {} tiles): p50 {:.3} ms, p95 {:.3} ms, max {:.3} ms",
            mz.saturating_sub(3),
            lat.len(),
            pct(&lat, 0.5),
            pct(&lat, 0.95),
            lat.last().copied().unwrap_or(0.0)
        );
        let mut v = serde_json::to_value(&rep).unwrap();
        v["serve_p50_ms"] = pct(&lat, 0.5).into();
        v["serve_p95_ms"] = pct(&lat, 0.95).into();
        v["build_threads"] = rayon::current_num_threads().into();
        report.push(serde_json::json!({ "overview": v }));
    }

    if let Some(path) = args.json {
        std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).expect("write json");
        println!("\nwrote {}", path.display());
    }
}
