#!/usr/bin/env python3
"""The default domain plugins, every tool of every one, against known answers, offline.

A 1 km × 1 km test landscape (UTM 55S, 10 m pixels) whose answers are known by construction:
  image.tif     4 bands; west half vegetated (red 0.05, NIR 0.5), east half bare (0.3, 0.35)
                → NDVI extent = the west half = 50 ha
  ndvi_2015/24  NDVI 0.8 everywhere; in 2024 the north 200 m strip drops to 0.1 → 20 ha loss, no gain
  dem.tif       west half rises 5 cm per m (2.9°, gentle), east half 70 cm per m (35°, steep)
                → steep = the east half less the edge cells slope needs neighbours for (98 × 49 px = 48.02 ha)
  habitat       the south half (50 ha); protected: the west quarter (25 ha) → 12.5 ha protected (25 %)
  habitat_2024  the south half minus its east 100 m (45 ha) → 5 ha lost
  patches       two 1 ha squares 300 m apart → 2 patches, 2 ha; connected at 400 m, not at 200 m
  sites         3 tight groups of 10 points, one species each, a score high only in group A
  transect      a line west → east across the DEM
Each domain plugin runs each of its tools through its own id (POST /api/plugins/geospax-<d>/tools/…),
and each answer is checked; the same tool must answer the same from every domain and from the GSX
library (gsx/<tool>, as recipes call it). Also: every domain plugin listed as default, none on a core tab.

usage: test-domain-plugins.py BIN
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import numpy as np

BIN = sys.argv[1]
X0, Y0, N, PX = 400000.0, 9351000.0, 100, 10.0
passed, failed = 0, []


def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
    else:
        failed.append(name)
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f" ({extra})" if extra else ""))


tmp = tempfile.mkdtemp(prefix="gx-domains-")
data = os.path.join(tmp, "data")
os.makedirs(data)


def raster(name, arr):
    arr = np.asarray(arr, np.float32)
    if arr.ndim == 2:
        arr = arr[None]
    raw = os.path.join(tmp, name + ".bin")
    arr.tofile(raw)
    with open(raw[:-4] + ".hdr", "w") as f:
        f.write(f"ENVI\nsamples = {N}\nlines = {N}\nbands = {arr.shape[0]}\nheader offset = 0\nfile type = ENVI Standard\ndata type = 4\ninterleave = bsq\nbyte order = 0\n")
    subprocess.run(["gdal_translate", "-q", "-of", "GTiff", "-a_srs", "EPSG:32755", "-a_ullr", str(X0), str(Y0), str(X0 + N * PX), str(Y0 - N * PX), raw, os.path.join(data, name + ".tif")], check=True)


west = np.zeros((N, N), bool)
west[:, : N // 2] = True
img = np.zeros((4, N, N), np.float32)
img[0], img[1] = 0.05, 0.08
img[2] = np.where(west, 0.05, 0.30)
img[3] = np.where(west, 0.50, 0.35)
raster("image", img)
raster("ndvi_2015", np.full((N, N), 0.8))
after = np.full((N, N), 0.8)
after[:20] = 0.1
raster("ndvi_2024", after)
x = (np.arange(N) + 0.5) * PX
z = np.where(x < 500, x * 0.05, 25 + (x - 500) * 0.7)
raster("dem", np.tile(z, (N, 1)))
# a large pair (1,000,000 cells): Math.min(...cells) once overflowed the stack on rasters this size
BIG = 1000
big = np.full((BIG, BIG), 0.8, np.float32)
big.tofile(os.path.join(tmp, "big.bin"))
for nm, arr in (("big_2015", big), ("big_2024", np.where(np.arange(BIG)[:, None] < 250, 0.1, big).astype(np.float32))):
    arr.tofile(os.path.join(tmp, nm + ".bin"))
    with open(os.path.join(tmp, nm + ".hdr"), "w") as f:
        f.write(f"ENVI\nsamples = {BIG}\nlines = {BIG}\nbands = 1\nheader offset = 0\nfile type = ENVI Standard\ndata type = 4\ninterleave = bsq\nbyte order = 0\n")
    subprocess.run(["gdal_translate", "-q", "-of", "GTiff", "-a_srs", "EPSG:32755", "-a_ullr", str(X0), str(Y0), str(X0 + BIG), str(Y0 - BIG), os.path.join(tmp, nm + ".bin"), os.path.join(data, nm + ".tif")], check=True)


def vector(name, feats):
    src = os.path.join(tmp, name + ".geojson")
    with open(src, "w") as f:
        json.dump({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:32755"}}, "features": feats}, f)
    subprocess.run(["ogr2ogr", "-q", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-lco", "COORDINATE_PRECISION=9", os.path.join(data, name + ".geojson"), src], check=True)


def box(x0, y0, x1, y1, **props):
    ring = [[X0 + x0, Y0 - 1000 + y0], [X0 + x1, Y0 - 1000 + y0], [X0 + x1, Y0 - 1000 + y1], [X0 + x0, Y0 - 1000 + y1], [X0 + x0, Y0 - 1000 + y0]]
    return {"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [ring]}}


vector("habitat", [box(0, 0, 1000, 500, cost=1, cover=50)])
vector("protected", [box(0, 0, 250, 1000, name="reserve")])
vector("habitat_2024", [box(0, 0, 900, 500, cover=45)])
vector("patches", [box(100, 600, 200, 700), box(500, 600, 600, 700)])
vector("units", [box(i * 250, 0, (i + 1) * 250, 500, cost=c, forest=f) for i, (c, f) in enumerate([(4, 10), (1, 6), (1, 6), (5, 3)])])
rng = np.random.default_rng(7)
pts = []
for gi, (cx, cy, sp, score) in enumerate([(150, 250, "Ornithoptera", 90), (750, 250, "Troides", 10), (450, 800, "Papilio", 10)]):
    for k in range(10):
        dx, dy = rng.normal(0, 8, 2)
        pts.append({"type": "Feature", "properties": {"site": gi * 10 + k, "species": sp, "score": float(score + k % 3), "dist_m": float(50 * k), "elev": float(k)},
                    "geometry": {"type": "Point", "coordinates": [X0 + cx + dx, Y0 - 1000 + cy + dy]}})
vector("sites", pts)
vector("transect", [{"type": "Feature", "properties": {"name": "west-east"}, "geometry": {"type": "LineString", "coordinates": [[X0 + 5, Y0 - 500], [X0 + 995, Y0 - 500]]}}])


# industry landscapes, in the same 1 km square (box coordinates: x east, y north from the south edge)
def pt(x, y, **props):
    return {"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": [X0 + x, Y0 - 1000 + y]}}


def line(coords, **props):
    return {"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": [[X0 + x, Y0 - 1000 + y] for x, y in coords]}}


# the transect runs along y = 500: buildings 10, 30, 80 and 200 m off it
vector("buildings", [pt(300, 510), pt(400, 470), pt(600, 580), pt(700, 700)])
chm = np.full((N, N), 2.0)
chm[:, 90:] = 14.0  # trees 14 m tall in the east 100 m: over the 12 - 3 = 9 m allowed
raster("chm", chm)
vector("towers", [pt(100, 500, n=1), pt(300, 500, n=2), pt(500, 500, n=3), pt(700, 500, n=4), pt(900, 700, n=5)])
vector("tenures", [box(0, 0, 500, 500, name="PPL 1", expiry="1 Jan 2026"), box(400, 0, 900, 500, name="PPL 2", expiry="1 Jan 2027")])
vector("wells", [pt(100, 100), pt(150, 100), pt(800, 100), pt(950, 950)])
vector("ends", [pt(50, 500), pt(450, 500)])
vector("ends_east", [pt(300, 500), pt(450, 500)])
dem_after = np.tile(z, (N, 1))
dem_after[40:50, 10:20] -= 2.0  # a 100 m × 100 m pit, 2 m deep: 20,000 m³ cut
raster("dem_after", dem_after)
vector("streams", [line([(500, 0), (500, 1000)])])
t0 = 1790000000  # 2026-09-21
ais = [pt(100, 100, mmsi="A", t=t0 + h * 3600) for h in range(10)]
ais += [pt(900, 900, mmsi="B", t=t0 + h * 3600) for h in (0, 10)]
vector("ais", ais)
vector("runway", [line([(300, 500), (700, 500)])])
vector("obstacles", [pt(500, 700, top=50.0), pt(500, 800, top=30.0)])
vector("roads", [line([(x, 500) for x in range(0, 1001, 100)])])
vector("depot", [pt(5, 500)])
vector("farend", [pt(995, 500)])
vector("stops", [pt(100, 100), pt(700, 100), pt(300, 100), pt(500, 100)])
vector("clinic", [pt(450, 800, name="clinic")])
vector("assets", [pt(100, 900, id=1, installed=1980, inspected="1 Jan 2025", condition=5, criticality=4), pt(200, 900, id=2, installed=2020, inspected="1 Jun 2026", condition=1, criticality=2), pt(300, 900, id=3, installed=2000, inspected="", condition=3, criticality=3)])
vector("assets_2026", [pt(150, 900, id=1, installed=1980, inspected="1 Jan 2025", condition=4, criticality=4), pt(300, 900, id=3, installed=2000, inspected="", condition=3, criticality=3), pt(400, 900, id=4, installed=2026, inspected="", condition=1, criticality=3)])
raster("rain_obs", np.where(west, 100.0, 30.0))
raster("rain_norm", np.full((N, N), 100.0))
ENSO = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "plugins", "gsx", "tests", "fixtures", "enso", "oni.ascii.txt")

PORT = 18099
srv = subprocess.Popen([BIN, "--data", data, "--state-dir", os.path.join(tmp, "state"), "--port", str(PORT), "--web", "web/dist", "--no-device-mounts", "--no-triggers"],
                       stdout=subprocess.DEVNULL, stderr=open(os.path.join(tmp, "server.log"), "w"))
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def call(method, path, body=None):
    d = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}/{path}", data=d, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def num(msg, pattern):
    m = re.search(pattern, msg)
    return float(m.group(1).replace(",", "")) if m else None


try:
    for _ in range(120):
        try:
            if call("GET", "api/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)
    layers = {l["id"].split(".")[0]: l["id"] for l in call("GET", "api/layers")[1]["layers"]}
    rasters = {r["id"].split(".")[0]: r["id"] for r in call("GET", "api/rasters")[1]["rasters"]}
    L, R = layers.get, rasters.get

    print("the plugins")
    plugins = call("GET", "api/plugins")[1]["plugins"]
    domains = {p["id"]: p for p in plugins if p["id"].startswith("geospax-")}
    want = ["agriculture", "assets", "aviation", "biodiversity", "climate", "conservation", "disaster", "energy", "environment", "forestry", "geoscience", "hydrology",
            "lulc", "marine", "maritime", "mining", "petroleum", "rural", "soil", "surveying", "transport", "urban"]
    check("the 22 domains, listed as default plugins", sorted(d[8:] for d in domains) == want and all(p.get("default") and p["runnable"] for p in domains.values()), ", ".join(sorted(d[8:] for d in domains)))
    lib = next(p for p in plugins if p["id"] == "gsx")
    check("GSX is a library (runs, not listed)", lib.get("library") is True and lib["runnable"])
    check("no domain tool on the Analysis, Imagery or Modelling tab", all(not t.get("tab") for p in domains.values() for t in p["tools"]))
    check("every library tool belongs to a domain", {t["id"] for t in lib["tools"]} <= {t["id"] for p in domains.values() for t in p["tools"]})

    # each tool's parameters on the test landscape and what it must answer
    P = {
        "overlay": ({"a": L("habitat"), "b": L("protected"), "operation": "intersect"}, lambda r: r["message"].startswith("intersect: 1 polygon")),
        "protection-gap": ({"habitat": L("habitat"), "protected": L("protected")}, lambda r: abs(num(r["message"], r"([\d.]+) ?% protected") - 25) < 0.5),
        "suitability": ({"layer": L("sites"), "criteria": "score:1"}, lambda r: num(r["message"], r"Scored (\d+)") == 30),
        "distance-decay": ({"layer": L("sites"), "field": "dist_m", "half_life": 100}, lambda r: num(r["message"], r"Scored (\d+)") == 30),
        "priority-sites": ({"habitat": L("sites"), "protected": L("protected"), "score": "score", "min_score": 50}, lambda r: num(r["message"], r"(\d+) unprotected") is None and "No unprotected" in r["message"]),
        "representation": ({"units": L("units"), "cost": "cost", "targets": "forest:12"}, lambda r: num(r["message"], r"(\d+) of 4") == 2 and num(r["message"], r"cost ([\d.]+)") == 2 and "optimal" in r["message"]),
        "hotspot-grid": ({"layer": L("sites"), "cell_km": 0.2}, lambda r: num(r["message"], r"(\d+) with data") == 3),
        "fragmentation": ({"patches": L("patches"), "edge_m": 10}, lambda r: num(r["message"], r"(\d+) patch") == 2 and abs(num(r["message"], r"patch\(es\), ([\d.]+) ha") - 2) < 0.05),
        "connectivity": ({"patches": L("patches"), "threshold_m": 450}, lambda r: num(r["message"], r"(\d+) component") == 1),
        "change": ({"t1": L("habitat"), "t2": L("habitat_2024"), "year1": 2015, "year2": 2024}, lambda r: abs((num(r["message"], r"lost ([\d.]+) ha") or num(r["message"], r"loss ([\d.]+) ha") or -1) - 5) < 0.1),
        "dbscan": ({"points": L("sites"), "epsilon_m": 60, "min_points": 4}, lambda r: num(r["message"], r"(\d+) cluster") == 3),
        "on-land": ({"points": L("sites"), "land_polygons": L("habitat")}, lambda r: num(r["message"], r"of (\d+) record") == 30),
        "nearest-neighbour": ({"points": L("sites")}, lambda r: "cluster" in r["message"].lower()),
        "diversity": ({"occurrences": L("sites"), "species": "species"}, lambda r: num(r["message"], r"(\d+) (?:species|taxa)") == 3),
        "local-moran": ({"layer": L("sites"), "field": "score", "neighbours": "k-nearest", "k": 6, "permutations": 199}, lambda r: num(r["message"], r"(\d+) (?:in )?high[- ]high") == 10 or "10 High-High" in r["message"] or "High-High 10" in r["message"]),
        "spectral-index": ({"image": R("image"), "index": "NDVI", "band_a": 4, "band_b": 3, "threshold": 0.5}, lambda r: abs((num(r["message"], r"([\d.]+) ha") or -1) - 50) < 0.5),
        "raster-change": ({"before": R("ndvi_2015"), "after": R("ndvi_2024")}, lambda r: num(r["message"], r"([\d.]+) ha loss") == 20 and num(r["message"], r"([\d.]+) ha gain") == 0),
        "slope-zones": ({"dem": R("dem"), "breaks": "8, 20"}, lambda r: abs(num(r["message"], r"([\d.]+) ha steep") - 48.02) < 0.05),
        "sdm": ({"occurrences": L("sites"), "covariates": [R("image")], "method": "bioclim", "background": 500, "folds": 2}, lambda r: "AUC" in r["message"]),
        "elevation-profile": ({"layer": L("transect"), "dem": R("dem"), "spacing_m": 10}, lambda r: "profile" in r["message"].lower()),
        # surveying and cartography
        "datum-transform": ({"coordinates": "147 -9", "source_crs": "EPSG:4326", "target_crs": "EPSG:32755"}, lambda r: "Transformed 1 point" in r["message"] and "500000" in json.dumps(r)),
        "traverse-adjust": ({"legs": "0 100\n90 100.02\n180 100\n270 100", "start_e": 500000, "start_n": 9000000, "crs": "EPSG:32755"}, lambda r: "1:20,001" in r["message"] and "passes" in r["message"]),
        "bearing-distance": ({"layer": L("patches"), "crs": "EPSG:32755"}, lambda r: num(r["message"], r"(\d+) side") == 8 and abs(num(r["message"], r"([\d.]+) m in all") - 800) < 0.5),
        "survey-plan": ({"lots": L("patches"), "title": "Test", "crs": "EPSG:32755"}, lambda r: "2 lot(s)" in r["message"] and bool(r.get("figures"))),
        "map-grid": ({"layer": L("habitat"), "crs": "EPSG:32755", "interval": 100}, lambda r: "grid line" in r["message"]),
        # energy, oil and gas, mining
        "corridor-zones": ({"lines": L("transect"), "features": L("buildings")}, lambda r: "3 zone(s)" in r["message"] and "3 of 4 feature" in r["message"]),
        "lidar-clearance": ({"chm": R("chm"), "lines": L("transect"), "corridor_m": 20}, lambda r: r["message"].startswith("40 of 400 corridor")),
        "tower-inventory": ({"towers": L("towers"), "id_field": "n", "max_span_m": 250}, lambda r: "5 structures, 4 spans" in r["message"] and "2 suspension, 0 angle, 3 terminal; 1 span(s) over 250" in r["message"]),
        "tenure-check": ({"tenures": L("tenures"), "name_field": "name", "expiry_field": "expiry", "constraints": L("protected"), "as_of": "2026-10-28"}, lambda r: abs(num(r["message"], r"tenure\(s\), ([\d.]+) ha") - 50) < 0.1 and "ha; 1 overlap(s) between tenures, 1 with constraints; 1 expired, 1 expiring" in r["message"]),
        "well-sites": ({"wells": L("wells"), "leases": L("tenures"), "min_spacing_m": 400}, lambda r: r["message"] == "4 well(s): 2 closer than 400 m to another, 1 outside every lease"),
        "route-suitability": ({"surface": R("dem"), "ends": L("ends")}, lambda r: r["message"].startswith("Route of 0.40 km")),
        "volume-change": ({"before": R("dem"), "after": R("dem_after")}, lambda r: r["message"].startswith("Cut 20,000 m³ over 1.00 ha, fill 0 m³")),
        "harvest-coupes": ({"coupes": L("habitat"), "streams": L("streams"), "dem": R("dem"), "buffer_m": 50, "max_slope_deg": 30}, lambda r: abs(num(r["message"], r"([\d.]+) ha gross") - 50) < 0.1 and 22 < num(r["message"], r"([\d.]+) ha net") < 24.5),
        # maritime, aeronautical, transport
        "ais-density": ({"pings": L("ais"), "vessel_field": "mmsi", "cell_m": 200}, lambda r: r["message"] == "12 report(s) in 2 cell(s); busiest cell 10"),
        "ais-loitering": ({"pings": L("ais"), "vessel_field": "mmsi", "time_field": "t", "radius_m": 100}, lambda r: r["message"].startswith("2 vessel(s): 1 loitering event(s), 1 AIS gap(s)")),
        "ols-surfaces": ({"runway": L("runway"), "code": "1", "obstacles": L("obstacles"), "top_field": "top"}, lambda r: "400 m runway; 1 of 2 obstacle(s) penetrate" in r["message"]),
        "service-area": ({"network": L("roads"), "facilities": L("depot"), "bands": "300, 650", "speed_kmh": 0, "demand": L("farend")}, lambda r: r["message"] == "6 network segment(s) within 650 m of 1 facility(ies); 0 of 1 demand point(s) served"),
        "route-optimise": ({"stops": L("stops")}, lambda r: r["message"].startswith("Visit order 1 > 3 > 4 > 2 > 1: 1.20 km")),
        # urban and rural planning, assets
        "zoning-summary": ({"zones": L("units"), "zone_field": "cost", "features": L("sites")}, lambda r: r["message"] == "3 zone class(es) over 50.0 ha"),
        "density-grid": ({"points": L("sites"), "cell_m": 200}, lambda r: 3 <= num(r["message"], r"(\d+) occupied") <= 6),
        "green-access": ({"homes": L("sites"), "parks": L("patches"), "walk_m": 200}, lambda r: r["message"].startswith("33.3 % of homes")),
        "service-access": ({"settlements": L("sites"), "services": L("clinic"), "thresholds": "0.2, 0.5"}, lambda r: "66.7 % beyond 0.2 km, 66.7 % beyond 0.5 km" in r["message"]),
        "asset-register": ({"assets": L("assets"), "installed_field": "installed", "inspected_field": "inspected", "condition_field": "condition", "criticality_field": "criticality", "as_of": "2026-10-28"}, lambda r: r["message"] == "3 asset(s): 2 inspection(s) overdue, 1 past design life, 1 high risk"),
        "change-alert": ({"before": L("assets"), "after": L("assets_2026"), "id_field": "id"}, lambda r: r["message"] == "1 added, 1 removed, 1 moved, 1 changed"),
        # climate and ENSO
        "enso-index": ({"index": "oni", "file": ENSO}, lambda r: "JAS 2026 = +2.16, El Niño (very strong)" in r["message"]),
        "rainfall-anomaly": ({"observed": R("rain_obs"), "normal": R("rain_norm")}, lambda r: r["message"].startswith("Mean 65 % of normal; 50.0 % of the area below 80 %")),
        "drought-risk": ({"rain_pct": R("rain_obs"), "dem": R("dem"), "oni": 2.16}, lambda r: "50.0 % of the area at high or severe" in r["message"] and "0.0 % at frost risk" in r["message"]),
        "seasonal-outlook": ({"probability": R("rain_obs")}, lambda r: r["message"].startswith("50.0 % of the area is likely drier")),
    }
    answers = {}
    for d in sorted(domains):
        print(d)
        for t in domains[d]["tools"]:
            tid = t["id"]
            if tid not in P:
                check(f"{tid}: has a test case", False)
                continue
            params, good = P[tid]
            s, j = call("POST", f"api/plugins/{d}/tools/{tid}/run", {"params": params})
            r = j.get("result") or {}
            msg = r.get("message") or j.get("error") or json.dumps(j)[:160]
            try:
                right = s == 200 and r.get("ok") and good(r)
            except Exception:
                right = False
            check(f"{tid}", right, msg)
            answers.setdefault(tid, []).append(r.get("message"))
    print("industry and climate kits (downloads swapped for the test data)")
    fix = os.path.dirname(ENSO)
    SHOTS = []
    KITS = {
        "kit-survey-plan": {"legs": "0 100\n90 100.02\n180 100\n270 100", "lots": L("patches")},
        "kit-power-corridor": {"lines": L("transect"), "features": L("buildings"), "chm": R("chm"), "towers": L("towers")},
        "kit-petroleum-leases": {"tenures": L("tenures"), "name_field": "name", "expiry_field": "expiry", "constraints": L("protected"), "wells": L("wells"), "ends": L("ends_east")},
        "kit-mine-volumes": {"before": R("dem"), "after": R("dem_after"), "tenements": L("tenures"), "expiry_field": "expiry"},
        "kit-harvest-planning": {"coupes": L("habitat"), "streams": L("streams"), "ends": L("ends")},
        "kit-maritime-watch": {"pings": L("ais"), "vessel_field": "mmsi", "time_field": "t", "cell_m": 200},
        "kit-aerodrome-safeguarding": {"runway": L("runway"), "code": "1", "obstacles": L("obstacles"), "top_field": "top"},
        "kit-delivery-routes": {"network": L("roads"), "facilities": L("depot"), "bands": "300, 650", "speed_kmh": 0, "stops": L("stops")},
        "kit-urban-planning": {"zones": L("units"), "zone_field": "cost", "homes": L("sites"), "parks": L("patches"), "walk_m": 200},
        "kit-rural-access": {"settlements": L("sites"), "services": L("clinic"), "thresholds": "0.2, 0.5"},
        "kit-asset-register": {"assets": L("assets_2026"), "installed_field": "installed", "inspected_field": "inspected", "condition_field": "condition", "criticality_field": "criticality", "before": L("assets"), "id_field": "id"},
        "kit-el-nino-drought": {"area": L("habitat"), "observed": R("rain_obs"), "normal": R("rain_norm")},
    }
    for kid, inputs in KITS.items():
        text = open(os.path.join(ROOT, "recipes", f"{kid}.yaml"), encoding="utf-8").read()
        text = re.sub(r"\n  - id: dem\n    use: dem\.fetch\n(    when: [^\n]*\n)?    with: [^\n]*\n", "\n", text)
        text = text.replace("dem: dem", f"dem: {R('dem')}").replace("surface: dem", f"surface: {R('dem')}")
        text = text.replace("params: { index: oni }", f"params: {{ index: oni, file: {json.dumps(ENSO)} }}")
        text = text.replace("params: { index: soi }", f"params: {{ index: soi, file: {json.dumps(os.path.join(fix, 'soi_monthly.txt'))} }}")
        text = text.replace("gsx/drought-risk, params: { ", "gsx/drought-risk, params: { oni: 2.16, ")
        rid = kid + "-offline"
        text = re.sub(r"^recipe: .*$", f"recipe: {rid}", text, flags=re.M)
        req = urllib.request.Request(f"{BASE}/api/recipes?approve=code", data=text.encode(), method="POST", headers={"Content-Type": "text/yaml"})
        try:
            with urllib.request.urlopen(req, timeout=60) as rr:
                j = json.loads(rr.read() or b"{}")
        except urllib.error.HTTPError as e:
            j = json.loads(e.read() or b"{}")
        if "error" in j:
            check(f"{kid} loads", False, str(j["error"])[:200])
            continue
        s, run = call("POST", f"api/recipes/{rid}/run", {"inputs": inputs})
        r = {"status": "failed", "error": run.get("error")}
        for _ in range(300 if "id" in run else 0):
            r = call("GET", f"api/runs/{run['id']}")[1]
            if r.get("status") in ("done", "failed"):
                break
            time.sleep(0.5)
        arts = r.get("artifacts", [])
        bad = [f"{x['id']}: {'; '.join(x.get('why') or [])}" for x in r.get("steps", []) if x.get("status") == "failed"]
        if os.environ.get("GX_SHOTS") and r.get("status") == "done":  # keep the maps (README screenshots)
            os.makedirs(os.environ["GX_SHOTS"], exist_ok=True)
            for root, _, files in os.walk(os.path.join(tmp, "state")):
                for fn in files:
                    if fn.endswith(".png") and run["id"] in root:
                        shutil.copy(os.path.join(root, fn), os.path.join(os.environ["GX_SHOTS"], f"{kid}-{fn}"))
            SHOTS.append({"kit": kid, "layers": r.get("layers", []), "rasters": r.get("rasters", [])})
        check(f"{kid} runs to its map and report", r.get("status") == "done" and "report.html" in arts and any(a.endswith(".png") for a in arts), (r.get("error") or "; ".join(bad) or ", ".join(arts))[:220])
    if os.environ.get("GX_SHOTS") and SHOTS:  # the app itself, dark theme, Pro mode, one shot per kit
        with open(os.path.join(tmp, "shots.json"), "w") as f:
            json.dump(SHOTS, f)
        subprocess.run(["node", "scripts/shots-industry.mjs", BASE, os.environ["GX_SHOTS"], os.path.join(tmp, "shots.json")])
    print("large rasters")
    s, j = call("POST", "api/plugins/geospax-forestry/tools/raster-change/run", {"params": {"before": R("big_2015"), "after": R("big_2024")}})
    msg = (j.get("result") or {}).get("message") or j.get("error", "")
    check("raster change on 1,000,000 cells (a quarter lost: 25 ha)", s == 200 and num(msg, r"([\d.]+) ha loss") == 25, msg)
    print("same answer everywhere")
    for tid, (params, _) in P.items():
        s, j = call("POST", f"api/plugins/gsx/tools/{tid}/run", {"params": params})
        msgs = set(answers.get(tid, [])) | {(j.get("result") or {}).get("message")}
        check(f"{tid}: every domain and gsx/{tid} agree", len(msgs) == 1, f"{len(answers.get(tid, []))} domain(s)")
finally:
    srv.terminate()
    srv.wait()
    if not failed:
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("kept", tmp)

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
