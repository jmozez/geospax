#!/usr/bin/env python3
"""Decode engine tiles with GDAL's independent MVT driver (ogrinfo) and check
feature counts + extents. Usage: scripts/test-tiles-gdal.py [http://127.0.0.1:8080]"""
import math, subprocess, urllib.request, re, json
import sys
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
def tile_of(lon, lat, z):
    n = 2 ** z; lat_r = math.radians(lat)
    return z, int((lon + 180) / 360 * n), int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)
def merc_bounds(z, x, y):
    s = 2 * math.pi * 6378137 / 2 ** z; o = math.pi * 6378137
    return (x * s - o, o - (y + 1) * s, (x + 1) * s - o, o - y * s)
cases = [("natural_earth.countries", (0, 0, 0)), ("natural_earth.countries", tile_of(145, -6, 5)),
         ("natural_earth.roads", tile_of(10, 50, 6)), ("natural_earth.places", tile_of(10, 50, 3)),
         ("natural_earth.rivers", tile_of(-90, 40, 4)),
         ("synthetic.buildings", tile_of(144.23, -5.86, 11)), ("synthetic.buildings", tile_of(144.23, -5.86, 14)),
         ("synthetic_buildings.fgb", tile_of(144.23, -5.86, 14)), ("synthetic_buildings.shp", tile_of(144.23, -5.86, 14)),
         ("synthetic.points", tile_of(145.39, -6.08, 13))]
ok = True
for layer, (z, x, y) in cases:
    url = f"{BASE}/tiles/{layer}/{z}/{x}/{y}.mvt"
    with urllib.request.urlopen(url) as r:
        body = r.read(); st = r.headers.get("Server-Timing"); nf = r.headers.get("X-Tile-Features")
    fn = f"/tmp/{layer}-{z}-{x}-{y}.mvt"; open(fn, "wb").write(body)
    if not body:
        print(f"{layer:26} {z}/{x}/{y}: EMPTY"); continue
    out = subprocess.run(["ogrinfo", "-ro", "-so", "-al", "-oo", f"Z={z}", "-oo", f"X={x}", "-oo", f"Y={y}", fn],
                         capture_output=True, text=True)
    cnt = sum(int(c) for c in re.findall(r"Feature Count: (\d+)", out.stdout))
    ext = re.search(r"Extent: \(([-\d.]+), ([-\d.]+)\) - \(([-\d.]+), ([-\d.]+)\)", out.stdout)
    tb = merc_bounds(z, x, y); buf = (tb[2] - tb[0]) * (64 / 4096) * 1.01
    inside = ext and float(ext[1]) >= tb[0] - buf and float(ext[3]) <= tb[2] + buf and float(ext[2]) >= tb[1] - buf and float(ext[4]) <= tb[3] + buf
    good = out.returncode == 0 and cnt == int(nf) and inside
    ok &= bool(good)
    total = re.search(r"total;dur=([\d.]+)", st or ""); 
    print(f"{layer:26} {z:>2}/{x}/{y}: {len(body)/1024:7.1f} KB  features={nf:>6} gdal_decoded={cnt:>6}  within_buffered_tile={bool(inside)}  engine={total[1] if total else '?'} ms  {'OK' if good else 'FAIL ' + out.stderr[:200]}")
print("ALL_VALID" if ok else "SOME_FAILED")
