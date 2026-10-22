#!/usr/bin/env python3
"""Test data for scripts/test-edit.py: a synthetic survey along two transects and three reserves.

    scripts/test-edit-data.py <folder>

Writes survey.geojson (42 points: id, site, transect, elevation_m, species_richness, tree_cover_pct,
rainfall_mm, surveyed), the same points as a Shapefile (survey_shp.shp) and in UTM zone 55S
(survey_utm.gpkg, needs ogr2ogr), and reserves.geojson (three square reserves). Deterministic, no
downloads, no third-party data.
"""
import json
import math
import os
import subprocess
import sys

out = sys.argv[1] if len(sys.argv) > 1 else "edit-data"
os.makedirs(out, exist_ok=True)

feats = []
# YUS-like transect: 28 sites climbing from 50 m to 3,190 m, richness peaking mid-slope
for i in range(28):
    elev = 50 + i * 115
    lon, lat = 146.70 - i * 0.012, -5.95 + i * 0.008
    rich = round(90 * math.exp(-(((elev - 1800) / 900) ** 2)))
    feats.append((f"YUS-{i + 1:02d}", "YUS", elev, rich, lon, lat))
# Wilhelm-like transect: 14 high sites, few species
for i in range(14):
    elev = 2620 + i * 145
    lon, lat = 145.03 + i * 0.006, -5.78 - i * 0.004
    feats.append((f"WIL-{i + 1:02d}", "Wilhelm", elev, max(3, 30 - i * 2), lon, lat))

fc = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {
                "id": 100 + n,  # a property named like GeoJSON's feature id: trips up GDAL's SQLite dialect
                "site": s,
                "transect": t,
                "elevation_m": e,
                "species_richness": r,
                "tree_cover_pct": max(0, 95 - e // 50),
                "rainfall_mm": 2000 + e // 3,
                "surveyed": f"2023-0{1 + n % 9}-1{n % 9}",
            },
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        }
        for n, (s, t, e, r, lon, lat) in enumerate(feats)
    ],
}
json.dump(fc, open(os.path.join(out, "survey.geojson"), "w"))


def square(cx, cy, h):
    return [[[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h], [cx - h, cy - h]]]


reserves = {
    "type": "FeatureCollection",
    "features": [
        {"type": "Feature", "properties": {"name": n, "iucn": c}, "geometry": {"type": "Polygon", "coordinates": square(x, y, h)}}
        for n, c, x, y, h in [
            ("Upper slope reserve", "II", 146.47, -5.79, 0.05),  # around the YUS mid-slope sites
            ("Summit reserve", "Ia", 145.07, -5.81, 0.03),
            ("Coastal reserve", "IV", 147.30, -6.40, 0.05),  # far from every site
        ]
    ],
}
json.dump(reserves, open(os.path.join(out, "reserves.geojson"), "w"))

src = os.path.join(out, "survey.geojson")
for args in (["-f", "ESRI Shapefile", os.path.join(out, "survey_shp.shp"), src], ["-t_srs", "EPSG:32755", os.path.join(out, "survey_utm.gpkg"), src]):
    subprocess.run(["ogr2ogr", "-overwrite", *args], check=True, stderr=subprocess.DEVNULL)
print(f"test data in {out}: {len(fc['features'])} survey points, {len(reserves['features'])} reserves")
