#!/usr/bin/env python3
"""Synthetic LiDAR point cloud with known truth (scripts/test-lidar.py, docs/RESULTS.md §18).

Writes a LAS 1.2 file (point format 1, EPSG:32755 GeoTIFF keys) of a 300 × 240 m scene near
Lae, Morobe: rolling ground with a 6 m hill, three buildings (a flat-roofed hall, a gabled house
and a flat-roofed tower) and trees of known height and crown size, plus birds and
below-ground noise. With --classified the points carry the classes vendor software writes
(2 ground, 5 high vegetation, 6 building, 7/18 noise); without it every point is class 1
("unclassified"), so GeoSpaX has to find the ground (SMRF) and the roofs itself.

A JSON file next to the LAS holds the truth: terrain formula, buildings, trees.

  python3 scripts/data-sample-lidar.py OUT.las [--classified] [--density 10] [--seed 42]
"""
import argparse
import datetime
import json
import math
import struct

import numpy as np

X0, Y0 = 499_800.0, 9_255_600.0  # UTM zone 55S (EPSG:32755), south-west corner
W, H = 300.0, 240.0

BUILDINGS = [
    # local x, y of the south-west corner, size (m), eaves and ridge height above ground
    {"name": "hall", "x": 40.0, "y": 40.0, "w": 24.0, "h": 16.0, "eaves": 6.0, "ridge": 6.0},
    {"name": "house", "x": 40.0, "y": 140.0, "w": 16.0, "h": 10.0, "eaves": 4.0, "ridge": 6.5},
    {"name": "tower", "x": 110.0, "y": 30.0, "w": 12.0, "h": 12.0, "eaves": 9.0, "ridge": 9.0},
]
PARK_TREES = [(90.0, 100.0, 12.0), (20.0, 95.0, 9.0), (75.0, 200.0, 15.0), (140.0, 120.0, 18.0)]


def ground(x, y):
    """Terrain height (m) at local coordinates."""
    r2 = (x - 200.0) ** 2 + (y - 120.0) ** 2
    return 40.0 + 0.03 * x + 6.0 * np.exp(-r2 / (2 * 40.0**2)) + 0.5 * np.sin(x / 25.0) * np.cos(y / 30.0)


def crown_radius(h):
    return 0.5 * (2.51503 + 0.00901 * h * h)


def make_trees(rng):
    trees = [{"x": x, "y": y, "h": h, "r": crown_radius(h)} for x, y, h in PARK_TREES]
    for _ in range(4000):
        h = float(rng.uniform(8.0, 25.0))
        r = crown_radius(h) * float(rng.uniform(0.9, 1.1))
        x, y = float(rng.uniform(160.0 + r, 292.0 - r)), float(rng.uniform(12.0 + r, 228.0 - r))
        if all(math.hypot(x - t["x"], y - t["y"]) >= r + t["r"] + 1.5 for t in trees):
            trees.append({"x": x, "y": y, "h": h, "r": r})
        if len(trees) >= 40:
            break
    return trees


def roof(b, x, y):
    """Roof height above ground for points inside building b (ridge along the long side)."""
    if b["ridge"] == b["eaves"]:
        return np.full_like(x, b["eaves"])
    yc = b["y"] + b["h"] / 2.0
    return b["eaves"] + (b["ridge"] - b["eaves"]) * (1.0 - np.abs(y - yc) / (b["h"] / 2.0))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--classified", action="store_true")
    ap.add_argument("--density", type=float, default=10.0, help="pulses per m² (default 10)")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    trees = make_trees(np.random.default_rng(7))

    n = int(W * H * a.density)
    x = rng.uniform(0.0, W, n)
    y = rng.uniform(0.0, H, n)
    g = ground(x, y)
    z = g + rng.normal(0.0, 0.03, n)
    cls = np.full(n, 2, np.uint8)
    inten = rng.normal(300, 30, n)
    # buildings: a single return on the roof
    for b in BUILDINGS:
        m = (x >= b["x"]) & (x < b["x"] + b["w"]) & (y >= b["y"]) & (y < b["y"] + b["h"])
        z[m] = g[m] + roof(b, x[m], y[m]) + rng.normal(0.0, 0.03, m.sum())
        cls[m] = 6
        inten[m] = rng.normal(500, 40, m.sum())
    # trees: first return on the crown (paraboloid from 45 % of the height up), often a ground echo
    top = np.full(n, -np.inf)
    for t in trees:
        d2 = (x - t["x"]) ** 2 + (y - t["y"]) ** 2
        m = (d2 < t["r"] ** 2) & (cls != 6)
        zc = t["h"] * (1.0 - 0.55 * d2[m] / t["r"] ** 2)
        top[m] = np.maximum(top[m], zc)
    veg = np.isfinite(top)
    z[veg] = g[veg] + top[veg] - np.abs(rng.normal(0.0, 0.15, veg.sum()))
    cls[veg] = 5
    inten[veg] = rng.normal(150, 30, veg.sum())
    ret = np.ones(n, np.uint8)
    nret = np.ones(n, np.uint8)
    echo = veg & (rng.uniform(0, 1, n) < 0.4)
    nret[echo] = 2
    # ground echoes of the vegetated pulses
    ex, ey = x[echo], y[echo]
    ez = ground(ex, ey) + rng.normal(0.0, 0.03, echo.sum())
    x = np.concatenate([x, ex])
    y = np.concatenate([y, ey])
    z = np.concatenate([z, ez])
    cls = np.concatenate([cls, np.full(echo.sum(), 2, np.uint8)])
    inten = np.concatenate([inten, rng.normal(250, 30, echo.sum())])
    ret = np.concatenate([ret, np.full(echo.sum(), 2, np.uint8)])
    nret = np.concatenate([nret, np.full(echo.sum(), 2, np.uint8)])
    # birds and below-ground multipath
    k = 25
    bx, by = rng.uniform(0, W, k), rng.uniform(0, H, k)
    lx, ly = rng.uniform(0, W, k), rng.uniform(0, H, k)
    x = np.concatenate([x, bx, lx])
    y = np.concatenate([y, by, ly])
    z = np.concatenate([z, ground(bx, by) + rng.uniform(40, 80, k), ground(lx, ly) - rng.uniform(4, 12, k)])
    cls = np.concatenate([cls, np.full(k, 18, np.uint8), np.full(k, 7, np.uint8)])
    inten = np.concatenate([inten, np.full(2 * k, 50.0)])
    ret = np.concatenate([ret, np.ones(2 * k, np.uint8)])
    nret = np.concatenate([nret, np.ones(2 * k, np.uint8)])
    if not a.classified:
        cls[:] = 1

    total = len(x)
    order = rng.permutation(total)  # interleave like a real flight line
    gx, gy, gz = x[order] + X0, y[order] + Y0, z[order]
    scale = 0.001
    rec = np.zeros(total, dtype=np.dtype([("X", "<i4"), ("Y", "<i4"), ("Z", "<i4"), ("i", "<u2"), ("flags", "u1"), ("cls", "u1"), ("angle", "i1"), ("user", "u1"), ("src", "<u2"), ("t", "<f8")]))
    rec["X"] = np.round((gx - X0) / scale)
    rec["Y"] = np.round((gy - Y0) / scale)
    rec["Z"] = np.round(gz / scale)
    rec["i"] = np.clip(inten[order], 0, 65535)
    rec["flags"] = ret[order] | (nret[order] << 3)
    rec["cls"] = cls[order]
    rec["src"] = 1
    rec["t"] = np.arange(total) * 1e-5 + 3.0e8

    # GeoKeyDirectory: projected, pixel-is-area, EPSG:32755, metres
    keys = [1, 1, 0, 5, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32755, 3076, 0, 1, 9001, 4099, 0, 1, 9001]
    gk = struct.pack(f"<{len(keys)}H", *keys)
    vlr = struct.pack("<H16sHH32s", 0, b"LASF_Projection", 34735, len(gk), b"GeoKeyDirectoryTag") + gk
    offset = 227 + len(vlr)
    by_ret = [int((ret == 1).sum()), int((ret == 2).sum()), 0, 0, 0]
    today = datetime.date(2026, 10, 16)
    hdr = struct.pack(
        "<4sHHIHH8sBB32s32sHHHIIBHI5I3d3d6d",
        b"LASF", 0, 0, 0, 0, 0, b"\0" * 8, 1, 2,
        b"GeoSpaX synthetic scene", b"data-sample-lidar.py", today.timetuple().tm_yday, today.year,
        227, offset, 1, 1, 28, total, *by_ret,
        scale, scale, scale, X0, Y0, 0.0,
        float(gx.max()), float(gx.min()), float(gy.max()), float(gy.min()), float(gz.max()), float(gz.min()),
    )
    assert len(hdr) == 227
    with open(a.out, "wb") as f:
        f.write(hdr)
        f.write(vlr)
        f.write(rec.tobytes())

    truth = {
        "crs": "EPSG:32755", "origin": [X0, Y0], "size": [W, H], "points": total, "pulses_per_m2": a.density,
        "classified": a.classified,
        "terrain": "40 + 0.03 x + 6 exp(-((x-200)^2 + (y-120)^2) / 3200) + 0.5 sin(x/25) cos(y/30), x and y in metres from the origin",
        "buildings": [dict(b, area=b["w"] * b["h"]) for b in BUILDINGS],
        "trees": [{k: round(v, 3) for k, v in t.items()} for t in trees],
    }
    with open(a.out.rsplit(".", 1)[0] + ".truth.json", "w") as f:
        json.dump(truth, f, indent=1)
    print(f"{a.out}: {total} points, {len(trees)} trees, {len(BUILDINGS)} buildings, {'classified' if a.classified else 'unclassified'}")


if __name__ == "__main__":
    main()
