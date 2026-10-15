#!/usr/bin/env python3
"""GeoSpaX API stress test: mixed concurrent requests against a running server.

usage: scripts/bench-api-stress.py [BASE_URL] [--clients 16] [--requests 256] [--seed 7] [--json FILE]

The workload mixes vector tiles, classify (jenks, quantile, equal), unique values, project,
jobs and stats. It does not write anything. Tiles are density-weighted: a coarse tile grid is
probed once per layer extent, then requests pick dense areas more often and descend to a random
zoom inside each layer's z-range (a third of numeric-layer tiles ask for ?fields=height).
Exits non-zero if any request fails (HTTP >= 400 or a connection error).
"""
import argparse, json, math, random, statistics, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor


def tile_for(lon, lat, z):
    lat = max(min(lat, 85.0511), -85.0511)
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return z, min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_range(bounds, z):
    w, s, e, n = bounds
    _, x0, y0 = tile_for(w, n, z)
    _, x1, y1 = tile_for(e, s, z)
    return x0, y0, x1, y1


def probe_hotspots(base, layers, max_probe=160):
    """Density weights: fetch a coarse tile grid once per distinct extent; tile size = weight."""
    groups = {}
    for l in layers:
        if l.get("bounds"):
            groups.setdefault(tuple(round(v, 1) for v in l["bounds"]), []).append(l)
    out, todo = {}, []
    for key, ls in groups.items():
        pl = next((l for l in ls if l.get("driver") == "FlatGeobuf"), ls[0])  # cheapest reader
        z = pl.get("minzoom", 0)
        while z < pl.get("maxzoom", 14):
            x0, y0, x1, y1 = tile_range(pl["bounds"], z + 1)
            if (x1 - x0 + 1) * (y1 - y0 + 1) > max_probe:
                break
            z += 1
        x0, y0, x1, y1 = tile_range(pl["bounds"], z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                todo.append((key, (z, x, y), ("probe", f"{base}/tiles/{pl['id']}/{z}/{x}/{y}")))
    with ThreadPoolExecutor(4) as pool:
        sizes = list(pool.map(lambda t: fetch(t[2])[3], todo))
    for (key, t, _), size in zip(todo, sizes):
        if size > 0:
            out.setdefault(key, []).append((t, size))
    return groups, out, len(todo)


def build_plan(base, layers, n, rnd, hot):
    groups, weights, _ = hot
    group_of = {l["id"]: k for k, ls in groups.items() for l in ls}
    tiled = [l for l in layers if weights.get(group_of.get(l["id"]))]
    numeric = [l["id"] for l in layers if any(f.get("name") == "height" for f in l.get("fields", []))]
    plan = []
    for _ in range(n):
        r = rnd.random()
        if r < 0.60 and tiled:
            l = rnd.choice(tiled)
            cand = weights[group_of[l["id"]]]
            (z0, x0, y0), _ = rnd.choices(cand, weights=[c[1] for c in cand])[0]
            z = rnd.randint(max(z0, l.get("minzoom", 0)), l.get("maxzoom", 14))
            k = 2 ** (z - z0)
            x, y = x0 * k + rnd.randrange(k), y0 * k + rnd.randrange(k)
            q = "?fields=height" if (l["id"] in numeric and rnd.random() < 0.33) else ""
            plan.append(("tile", f"{base}/tiles/{l['id']}/{z}/{x}/{y}{q}"))
        elif r < 0.70 and numeric:
            m = rnd.choice(["jenks", "quantile", "equal"])
            plan.append(("classify", f"{base}/api/layers/{rnd.choice(numeric)}/classify?field=height&method={m}&classes={rnd.randint(4, 7)}"))
        elif r < 0.80 and numeric:
            plan.append(("unique", f"{base}/api/layers/{rnd.choice(numeric)}/unique?field=kind"))
        elif r < 0.90:
            plan.append(("project", f"{base}/api/project"))
        elif r < 0.95:
            plan.append(("jobs", f"{base}/api/jobs"))
        else:
            plan.append(("stats", f"{base}/api/stats"))
    return plan


def fetch(item):
    kind, url = item
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            body = r.read()
            return kind, url, r.status, len(body), (time.perf_counter() - t0) * 1000, None
    except urllib.error.HTTPError as e:
        return kind, url, e.code, 0, (time.perf_counter() - t0) * 1000, e.read()[:200].decode("utf-8", "replace")
    except Exception as e:  # connection reset, timeout, ...
        return kind, url, 0, 0, (time.perf_counter() - t0) * 1000, repr(e)


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://127.0.0.1:8080")
    ap.add_argument("--clients", type=int, default=16)
    ap.add_argument("--requests", type=int, default=256)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--json")
    a = ap.parse_args()
    base = a.base.rstrip("/")
    with urllib.request.urlopen(f"{base}/api/layers", timeout=30) as r:
        layers = json.load(r)
    layers = layers.get("layers", layers) if isinstance(layers, dict) else layers
    t0 = time.perf_counter()
    hot = probe_hotspots(base, layers)
    print(f"probed {hot[2]} tiles over {len(hot[0])} extents in {time.perf_counter() - t0:.1f} s (density weights)")
    plan = build_plan(base, layers, a.requests, random.Random(a.seed), hot)

    t0 = time.perf_counter()
    with ThreadPoolExecutor(a.clients) as pool:
        results = list(pool.map(fetch, plan))
    wall = time.perf_counter() - t0

    errors = [r for r in results if r[2] == 0 or r[2] >= 400]
    total_bytes = sum(r[3] for r in results)
    print(f"{len(results)} requests from {a.clients} clients in {wall:.1f} s: "
          f"{len(results) - len(errors)} ok, {len(errors)} errors, {total_bytes / 1e6:.1f} MB "
          f"({len(results) / wall:.0f} req/s)")
    print("| kind | n | p50 ms | p95 ms | max ms | KB mean |\n|---|---|---|---|---|---|")
    summary = {}
    for kind in sorted({r[0] for r in results}):
        rs = [r for r in results if r[0] == kind]
        ms = [r[4] for r in rs]
        row = dict(n=len(rs), p50_ms=pct(ms, 50), p95_ms=pct(ms, 95), max_ms=max(ms),
                   kb_mean=statistics.mean(r[3] for r in rs) / 1024)
        summary[kind] = row
        print(f"| {kind} | {row['n']} | {row['p50_ms']:.1f} | {row['p95_ms']:.1f} | {row['max_ms']:.1f} | {row['kb_mean']:.1f} |")
    for e in errors[:10]:
        print("ERROR", e[2], e[1], e[5])
    if a.json:
        with open(a.json, "w") as f:
            json.dump(dict(requests=len(results), clients=a.clients, errors=len(errors), wall_s=wall,
                           mb=total_bytes / 1e6, per_kind=summary), f, indent=1)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
