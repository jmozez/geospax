#!/usr/bin/env python3
"""Generate a synthetic, building-like dataset for data-plane benchmarking.

Writes two CSV files (stdlib only, deterministic seed):
  <out>/synthetic_buildings.csv  id,height,kind,wkt        (rotated rectangles, 8-60 m)
  <out>/synthetic_points.csv     id,height,kind,lon,lat    (one point per building)

Distribution: 70% gaussian clusters around five Papua New Guinea highland towns,
30% uniform background. THE DATA IS SYNTHETIC: it is not real building data.
"""
import argparse, math, os, random

CLUSTERS = [  # lon, lat, sigma_deg, weight
    (144.23, -5.86, 0.10, 0.30),  # Mount Hagen
    (145.39, -6.08, 0.08, 0.25),  # Goroka
    (144.97, -6.02, 0.06, 0.15),  # Kundiawa
    (143.65, -6.15, 0.06, 0.15),  # Mendi
    (143.71, -5.49, 0.05, 0.15),  # Wabag
]
BBOX = (143.4, -6.7, 145.8, -5.2)  # uniform background extent (lon/lat)
KINDS = ["residential"] * 6 + ["commercial"] * 2 + ["industrial", "public"]
M_PER_DEG = 111_320.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=1_000_000)
    ap.add_argument("--out", default="data")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    os.makedirs(a.out, exist_ok=True)
    weights = [c[3] for c in CLUSTERS]
    pb = open(os.path.join(a.out, "synthetic_buildings.csv"), "w", buffering=1 << 20)
    pp = open(os.path.join(a.out, "synthetic_points.csv"), "w", buffering=1 << 20)
    pb.write("id,height,kind,wkt\n")
    pp.write("id,height,kind,lon,lat\n")
    for i in range(1, a.count + 1):
        if rnd.random() < 0.7:
            lon0, lat0, sig, _ = rnd.choices(CLUSTERS, weights)[0]
            lon, lat = rnd.gauss(lon0, sig), rnd.gauss(lat0, sig)
        else:
            lon, lat = rnd.uniform(BBOX[0], BBOX[2]), rnd.uniform(BBOX[1], BBOX[3])
        w, l = rnd.uniform(8, 30), rnd.uniform(10, 60)  # metres
        ang = rnd.uniform(0, math.pi)
        ca, sa = math.cos(ang), math.sin(ang)
        kx = 1.0 / (M_PER_DEG * math.cos(math.radians(lat)))
        ky = 1.0 / M_PER_DEG
        pts = []
        for dx, dy in ((-l / 2, -w / 2), (-l / 2, w / 2), (l / 2, w / 2), (l / 2, -w / 2)):
            rx, ry = dx * ca - dy * sa, dx * sa + dy * ca
            pts.append(f"{lon + rx * kx:.7f} {lat + ry * ky:.7f}")
        pts.append(pts[0])
        h = round(rnd.uniform(3, 30), 1)
        kind = rnd.choice(KINDS)
        pb.write(f'{i},{h},{kind},"POLYGON(({",".join(pts)}))"\n')
        pp.write(f"{i},{h},{kind},{lon:.7f},{lat:.7f}\n")
    pb.close()
    pp.close()
    print(f"wrote {a.count} buildings + points to {a.out}")


if __name__ == "__main__":
    main()
