#!/usr/bin/env python3
"""Synthetic incident log for the hot spot recipe (points-to-hotspots): reported incidents in Lae
with three planted clusters on top of a uniform background, plus the truth to test against.

    python3 scripts/data-sample-incidents.py /opt/geospax-data     # -> incidents.geojson + incidents_truth.json
    python3 scripts/data-sample-incidents.py DIR --background 700 --seed 3

Fields: id (I0001…), kind (theft, break-in, assault, vehicle), reported (date), hour, cluster
(the planted cluster's name, or "background"; leave it out of analyses, it is the answer).
Deterministic for a given seed; stdlib only.
"""
import argparse
import json
import math
import os
import random

KINDS = ["theft", "break-in", "assault", "vehicle"]
# planted hot spots: name, lon, lat, sigma (m), incidents
CLUSTERS = [
    ("market", 146.9965, -6.7265, 260.0, 170),
    ("eriku", 146.9840, -6.7110, 300.0, 140),
    ("butibum", 147.0170, -6.6960, 210.0, 110),
]
BBOX = (146.955, -6.733, 147.035, -6.672)  # lon/lat, about 8.8 km × 6.7 km, on land (Lae)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--background", type=int, default=700)
    ap.add_argument("--seed", type=int, default=3)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    lat0 = (BBOX[1] + BBOX[3]) / 2
    m_lon = 111_320.0 * math.cos(math.radians(lat0))
    m_lat = 110_540.0
    pts = []
    for _ in range(a.background):
        pts.append((rnd.uniform(BBOX[0], BBOX[2]), rnd.uniform(BBOX[1], BBOX[3]), "background"))
    for name, lon, lat, sigma, n in CLUSTERS:
        k = 0
        while k < n:
            x = lon + rnd.gauss(0, sigma) / m_lon
            y = lat + rnd.gauss(0, sigma) / m_lat
            if BBOX[0] <= x <= BBOX[2] and BBOX[1] <= y <= BBOX[3]:
                pts.append((x, y, name))
                k += 1
    rnd.shuffle(pts)
    feats = []
    for i, (x, y, c) in enumerate(pts):
        feats.append({
            "type": "Feature",
            "properties": {
                "id": f"I{i + 1:04d}",
                "kind": KINDS[rnd.randrange(len(KINDS))],
                "reported": f"2026-{rnd.randint(7, 10):02d}-{rnd.randint(1, 28):02d}",
                "hour": rnd.randint(0, 23),
                "cluster": c,
            },
            "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]},
        })
    os.makedirs(a.out_dir, exist_ok=True)
    path = os.path.join(a.out_dir, "incidents.geojson")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "name": "incidents", "features": feats}, f)
    truth = {
        "clusters": [{"name": n, "lon": lon, "lat": lat, "sigma_m": s, "incidents": k} for n, lon, lat, s, k in CLUSTERS],
        "background": a.background,
        "bbox": BBOX,
        "seed": a.seed,
    }
    # the truth sits next to the data but is not GeoJSON, so GeoSpaX does not load it as a layer
    with open(os.path.join(a.out_dir, "incidents_truth.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, indent=1)
    print(f"wrote {len(feats)} incidents ({sum(c[4] for c in CLUSTERS)} in {len(CLUSTERS)} planted clusters) -> {path}")


if __name__ == "__main__":
    main()
