#!/usr/bin/env python3
"""The twelve default domain plugins, every tool of every one, against known answers, offline.

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
library (gsx/<tool>, as recipes call it). Also: twelve plugins listed as default, none on a core tab.

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

PORT = 18099
srv = subprocess.Popen([BIN, "--data", data, "--state-dir", os.path.join(tmp, "state"), "--port", str(PORT), "--web", "web/dist", "--no-device-mounts", "--no-triggers"],
                       stdout=subprocess.DEVNULL, stderr=open(os.path.join(tmp, "server.log"), "w"))
BASE = f"http://127.0.0.1:{PORT}"


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
    want = ["agriculture", "biodiversity", "climate", "conservation", "disaster", "environment", "forestry", "geoscience", "hydrology", "lulc", "marine", "soil"]
    check("the twelve 2.0 domains, listed as default plugins", sorted(d[8:] for d in domains) == want and all(p.get("default") and p["runnable"] for p in domains.values()), ", ".join(sorted(d[8:] for d in domains)))
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
        "nearest-neighbour": ({"points": L("sites")}, lambda r: "cluster" in r["message"].lower()),
        "diversity": ({"occurrences": L("sites"), "species": "species"}, lambda r: num(r["message"], r"(\d+) (?:species|taxa)") == 3),
        "local-moran": ({"layer": L("sites"), "field": "score", "neighbours": "k-nearest", "k": 6, "permutations": 199}, lambda r: num(r["message"], r"(\d+) (?:in )?high[- ]high") == 10 or "10 High-High" in r["message"] or "High-High 10" in r["message"]),
        "spectral-index": ({"image": R("image"), "index": "NDVI", "band_a": 4, "band_b": 3, "threshold": 0.5}, lambda r: abs((num(r["message"], r"([\d.]+) ha") or -1) - 50) < 0.5),
        "raster-change": ({"before": R("ndvi_2015"), "after": R("ndvi_2024")}, lambda r: num(r["message"], r"([\d.]+) ha loss") == 20 and num(r["message"], r"([\d.]+) ha gain") == 0),
        "slope-zones": ({"dem": R("dem"), "breaks": "8, 20"}, lambda r: abs(num(r["message"], r"([\d.]+) ha steep") - 48.02) < 0.05),
        "sdm": ({"occurrences": L("sites"), "covariates": [R("image")], "method": "bioclim", "background": 500, "folds": 2}, lambda r: "AUC" in r["message"]),
        "elevation-profile": ({"layer": L("transect"), "dem": R("dem"), "spacing_m": 10}, lambda r: "profile" in r["message"].lower()),
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
