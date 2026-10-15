#!/usr/bin/env python3
"""Synthetic field samples for the geostatistics recipes (interpolate-samples, r-kriging,
python-spatial-stats): soil samples around Mt Hagen with a smooth spatial trend plus noise.

    python3 scripts/data-sample-field.py /opt/geospax-data        # -> field_samples.geojson
    python3 scripts/data-sample-field.py DIR --count 120 --seed 7

Fields: site (S01…), ph, moisture_pct, organic_c_pct, land_use, sampled_at. Deterministic for a
given seed; stdlib only.
"""
import argparse
import json
import math
import os
import random

LAND_USE = ["garden", "coffee", "grassland", "forest", "fallow"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--count", type=int, default=60)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    lon0, lat0 = 144.235, -5.862  # Mt Hagen
    feats = []
    for i in range(a.count):
        # clustered sampling: villages/gardens, plus some spread-out sites
        if i % 3 == 0:
            lon = lon0 + rnd.uniform(-0.045, 0.045)
            lat = lat0 + rnd.uniform(-0.035, 0.035)
        else:
            cx, cy = [(144.21, -5.85), (144.255, -5.875), (144.24, -5.84)][i % 3]
            lon = cx + rnd.gauss(0, 0.008)
            lat = cy + rnd.gauss(0, 0.006)
        u, v = (lon - lon0) / 0.05, (lat - lat0) / 0.04
        # smooth trends: more acidic to the north-west (volcanic soils), wetter in the valley
        ph = 5.6 + 0.55 * u - 0.35 * v + 0.25 * math.sin(3 * u) * math.cos(2 * v) + rnd.gauss(0, 0.12)
        moisture = 32 + 9 * math.exp(-((v + 0.3) ** 2) * 3) - 4 * u + rnd.gauss(0, 2.0)
        organic = max(0.4, 3.1 - 0.6 * (ph - 5.5) + rnd.gauss(0, 0.35))
        land = LAND_USE[(int((u + 1.5) * 2) + int((v + 1.5) * 3) + rnd.randint(0, 1)) % len(LAND_USE)]
        feats.append({
            "type": "Feature",
            "properties": {
                "site": f"S{i + 1:02d}",
                "ph": round(ph, 2),
                "moisture_pct": round(moisture, 1),
                "organic_c_pct": round(organic, 2),
                "land_use": land,
                "sampled_at": f"2026-10-{(i % 9) + 3:02d}",
            },
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        })
    os.makedirs(a.out_dir, exist_ok=True)
    path = os.path.join(a.out_dir, "field_samples.geojson")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "name": "field_samples", "features": feats}, f)
    print(f"wrote {len(feats)} samples -> {path}")


if __name__ == "__main__":
    main()
