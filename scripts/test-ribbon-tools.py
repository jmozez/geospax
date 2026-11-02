#!/usr/bin/env python3
"""New ribbon tools against known answers: exact zonal statistics, topology check and the Edit tab's
split / merge / cut / reshape (zonal_steps.rs, edit.rs).

    scripts/test-ribbon-tools.py BIN

Test data (UTM 55S, made here):
  cols.tif   10 × 10 cells of 10 m whose value is the column index (0 … 9)
  zones      A: x 5–30 m, y 0–20 m below the top: exact coverage gives 0.5 + 1 + 1 cells per row, so
             mean = (0·0.5 + 1 + 2) / 2.5 = 1.2 (cell centres alone would give 1.5), count 5, sum 6
             B: a strip x 0–50 m, y 30–32 m, between cell centres (centre-based tools give nothing):
             count = 5 × 0.2 = 1.0, mean = 2.0
  tiles      a 3 × 3 grid of 100 m squares without the middle one (a 10 000 m² gap), the first square
             stretched 10 m into its neighbour (a 1 000 m² overlap), and a bow-tie (invalid)
  parcel     one 100 m square, to split, merge, cut and reshape
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BIN = sys.argv[1] if len(sys.argv) > 1 else "target/release/geospax-server"
PORT = 18097
BASE = f"http://127.0.0.1:{PORT}"
X0, Y0 = 500000.0, 9250000.0
passed, failed = 0, []


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}/{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}{f' ({extra})' if extra else ''}")
    else:
        failed.append(name)
        print(f"  FAIL {name}{f' ({extra})' if extra else ''}")


def utm_layer(path, feats):
    """Polygons given in metres from (X0, Y0) (y downwards) → GeoJSON in WGS 84 via ogr2ogr."""
    src = path + ".utm.geojson"
    fc = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:32755"}}, "features": []}
    for props, rings in feats:
        fc["features"].append({"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [[[X0 + x, Y0 - y] for x, y in r] for r in rings]}})
    json.dump(fc, open(src, "w"))
    subprocess.run(["ogr2ogr", "-q", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-lco", "COORDINATE_PRECISION=10", path, src], check=True)
    os.remove(src)


def box(x0, y0, x1, y1):
    return [[(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]]


tmp = tempfile.mkdtemp(prefix="gx-ribbon-")
data = os.path.join(tmp, "data")
os.makedirs(data)
# the raster: value = column index
asc = os.path.join(tmp, "cols.asc")
with open(asc, "w") as f:
    f.write(f"ncols 10\nnrows 10\nxllcorner {X0}\nyllcorner {Y0 - 100}\ncellsize 10\nNODATA_value -9999\n")
    for _ in range(10):
        f.write(" ".join(str(c) for c in range(10)) + "\n")
subprocess.run(["gdal_translate", "-q", "-of", "GTiff", "-a_srs", "EPSG:32755", asc, os.path.join(data, "cols.tif")], check=True)
utm_layer(os.path.join(data, "zones.geojson"), [({"name": "A"}, box(5, 0, 30, 20)), ({"name": "B"}, box(0, 30, 50, 32))])
tiles = []
for i in range(3):
    for j in range(3):
        if (i, j) == (1, 1):
            continue
        x1 = 110 if (i, j) == (0, 0) else 100 * i + 100
        tiles.append(({"tile": f"{i}{j}"}, box(100 * i, 100 * j, x1, 100 * j + 100)))
tiles.append(({"tile": "bowtie"}, [[(1000, 0), (1100, 100), (1100, 0), (1000, 100), (1000, 0)]]))
utm_layer(os.path.join(data, "tiles.geojson"), tiles)
utm_layer(os.path.join(data, "parcel.geojson"), [({"owner": "Kila"}, box(0, 0, 100, 100))])


def utm_any(path, feats):
    """Points or lines in metres from (X0, Y0) → GeoJSON in WGS 84."""
    src = path + ".utm.geojson"
    fc = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:32755"}}, "features": []}
    for props, kind, coords in feats:
        c = [X0 + coords[0], Y0 - coords[1]] if kind == "Point" else [[X0 + x, Y0 - y] for x, y in coords]
        fc["features"].append({"type": "Feature", "properties": props, "geometry": {"type": kind, "coordinates": c}})
    json.dump(fc, open(src, "w"))
    subprocess.run(["ogr2ogr", "-q", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-lco", "COORDINATE_PRECISION=10", path, src], check=True)
    os.remove(src)


# journal methods: 40 plots in the parcel's north-west corner (x, y 2–38 m); yield jumps from 10 to 30
# where slope passes 50, and noise is unrelated; a second raster whose value is the row index
plots = []
for i in range(40):
    x, y = 2 + (i % 8) * 5, 2 + (i // 8) * 8
    slope = i * 2.5
    plots.append(({"plot": i, "slope": slope, "noise": (i * 7919) % 13, "yield": 10 if slope < 50 else 30}, "Point", (x, y)))
asc2 = os.path.join(tmp, "rows.asc")
with open(asc2, "w") as f:
    f.write(f"ncols 10\nnrows 10\nxllcorner {X0}\nyllcorner {Y0 - 100}\ncellsize 10\nNODATA_value -9999\n")
    for r in range(10):
        f.write(" ".join(str(r) for _ in range(10)) + "\n")
subprocess.run(["gdal_translate", "-q", "-of", "GTiff", "-a_srs", "EPSG:32755", asc2, os.path.join(data, "rows.tif")], check=True)

# for layers.combine: 3 wells in tile 00 (yields 10, 20, 30), 1 in tile 22, 1 outside every tile;
# a road crossing tile 01 west → east (100 m inside it) and running on 50 m past it
utm_any(os.path.join(data, "wells.geojson"), [({"well": "W1", "yield": 10}, "Point", (20, 20)), ({"well": "W2", "yield": 20}, "Point", (50, 50)), ({"well": "W3", "yield": 30}, "Point", (80, 80)),
                                              ({"well": "W4", "yield": 5}, "Point", (250, 250)), ({"well": "W5", "yield": 7}, "Point", (900, 900))])
utm_any(os.path.join(data, "plots.geojson"), plots)
utm_any(os.path.join(data, "roads.geojson"), [({"road": "R1"}, "LineString", [(-50, 150), (150, 150)])])

srv = subprocess.Popen([BIN, "--data", data, "--state-dir", os.path.join(tmp, "state"), "--port", str(PORT), "--no-device-mounts", "--no-triggers"],
                       stdout=subprocess.DEVNULL, stderr=open(os.path.join(tmp, "server.log"), "w"))
try:
    for _ in range(60):
        try:
            if call("GET", "api/health")[0] == 200:
                break
        except OSError:
            pass
        time.sleep(0.5)
    s, ls = call("GET", "api/layers")
    lst = ls["layers"] if isinstance(ls, dict) else ls
    ids = {l["id"].split(".")[0].lower(): l["id"] for l in lst}
    print("  layers:", sorted(ids))
    s, rs = call("GET", "api/rasters")
    rid = next(r["id"] for r in rs["rasters"] if "cols" in r["id"])

    def run(recipe, inputs):
        s, r = call("POST", f"api/recipes/{recipe}/run", {"inputs": inputs})
        if s != 202:
            return None, r
        for _ in range(240):
            s, r = call("GET", f"api/runs/{r['id']}")
            if r.get("status") in ("done", "failed", "error", "cancelled"):
                break
            time.sleep(0.5)
        return r, r

    def rows(layer):
        s, t = call("POST", f"api/layers/{layer}/table", {"limit": 100})
        return [dict(zip(t["fields"], r["values"])) for r in t["rows"]]

    def out_layer(run, step):
        for st in run.get("steps", []):
            if st.get("id") == step:
                return (st.get("outputs") or {}).get("layer")
        return None

    print("exact zonal statistics")
    r, info = run("zonal-statistics", {"layer": ids["zones"], "raster": rid, "stats": "mean,count,sum,min,max"})
    check("zonal run finished", r and r.get("status") == "done", json.dumps(info)[:300])
    zl = out_layer(r or {}, "zonal")
    z = {x["name"]: x for x in rows(zl)} if zl else {}
    a, b = z.get("A", {}), z.get("B", {})
    check("A: mean 1.2 (centre-based would give 1.5)", abs((a.get("z_mean") or 0) - 1.2) < 2e-3, a.get("z_mean"))
    check("A: count 5 cells (2.5 × 2)", abs((a.get("z_count") or 0) - 5) < 2e-3, a.get("z_count"))
    check("A: sum 6", abs((a.get("z_sum") or 0) - 6) < 5e-3, a.get("z_sum"))
    check("A: min 0, max 2", a.get("z_min") == 0 and a.get("z_max") == 2, f"{a.get('z_min')}–{a.get('z_max')}")
    check("B: thin strip between centres still gets 1.0 cell", abs((b.get("z_count") or 0) - 1.0) < 2e-3, b.get("z_count"))
    check("B: mean 2.0", abs((b.get("z_mean") or 0) - 2.0) < 2e-3, b.get("z_mean"))

    print("topology check")
    r, info = run("check-topology", {"layer": ids["tiles"]})
    check("topology run finished", r and r.get("status") == "done", json.dumps(info)[:300])
    tl = out_layer(r or {}, "topology")
    errs = rows(tl) if tl else []
    kinds = sorted(e["error"] for e in errs)
    check("one overlap, one gap, one invalid", kinds == ["gap", "invalid geometry", "overlap"], kinds)
    ov = next((e for e in errs if e["error"] == "overlap"), {})
    gap = next((e for e in errs if e["error"] == "gap"), {})
    check("overlap ≈ 1 000 m²", abs((ov.get("area_m2") or 0) - 1000) / 1000 < 0.01, ov.get("area_m2"))
    check("overlap names the two tiles", len((ov.get("features") or "").split("&")) == 2, ov.get("features"))
    check("gap ≈ 10 000 m²", abs((gap.get("area_m2") or 0) - 10000) / 10000 < 0.01, gap.get("area_m2"))

    print("split, merge, cut, reshape")
    pid = ids["parcel"]

    def feats():
        s, t = call("POST", f"api/layers/{pid}/table", {"limit": 100})
        return t.get("rows", [])

    def area(fid):
        s, f = call("GET", f"api/layers/{pid}/features/{fid}")
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        tot = 0.0
        for p in polys:
            for k, r in enumerate(p):
                a = 0.5 * sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))
                tot += abs(a) * (1 if k == 0 else -1)
        return tot

    fid0 = feats()[0]["fid"]
    full = area(fid0)
    s, z0 = call("GET", f"api/layers/{pid}/features/{fid0}")
    ring = (z0["geometry"]["coordinates"][0] if z0["geometry"]["type"] == "Polygon" else z0["geometry"]["coordinates"][0][0])
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    xm, w = (x0 + x1) / 2, x1 - x0
    s, r = call("POST", f"api/layers/{pid}/geometry-edit", {"op": "split", "fids": [fid0], "sketch": {"type": "LineString", "coordinates": [[xm, y0 - w], [xm, y1 + w]]}})
    check("split into two", s == 200 and len(r.get("fids", [])) == 2, r.get("error", r.get("fids")))
    halves = [area(f) for f in r.get("fids", [])]
    check("halves of equal area", len(halves) == 2 and abs(halves[0] - halves[1]) / full < 1e-6, [round(h / full, 6) for h in halves])
    check("attributes kept on both", all(row["values"][row_fields.index("owner")] == "Kila" for row in feats() for row_fields in [call("POST", f"api/layers/{pid}/table", {"limit": 1})[1]["fields"]]))
    s, r = call("POST", f"api/layers/{pid}/geometry-edit", {"op": "merge", "fids": r.get("fids", [])})
    check("merged back into one", s == 200 and len(feats()) == 1 and abs(area(r["fids"][0]) - full) / full < 1e-6, r.get("error"))
    fid = r["fids"][0]
    q = w / 4
    cutter = {"type": "Polygon", "coordinates": [[[x0 - q, y0 - q], [x0 + q, y0 - q], [x0 + q, y0 + q], [x0 - q, y0 + q], [x0 - q, y0 - q]]]}
    s, r = call("POST", f"api/layers/{pid}/geometry-edit", {"op": "cut", "fids": [fid], "sketch": cutter})
    parts = sorted(area(f) / full for f in r.get("fids", []))
    check("cut a corner off (1/16 and 15/16)", s == 200 and len(parts) == 2 and abs(parts[0] - 1 / 16) < 1e-3, [round(p, 6) for p in parts])
    s, r2 = call("POST", f"api/layers/{pid}/geometry-edit", {"op": "merge", "fids": r.get("fids", [])})
    fid = r2["fids"][0]
    # reshape outwards: a bump of w/2 × w/2 on the east side
    bump = {"type": "LineString", "coordinates": [[x1, y0 + w / 4], [x1 + w / 2, y0 + w / 4], [x1 + w / 2, y0 + 3 * w / 4], [x1, y0 + 3 * w / 4]]}
    s, r = call("POST", f"api/layers/{pid}/geometry-edit", {"op": "reshape", "fids": [fid], "sketch": bump})
    check("reshape adds the bump (+25 %)", s == 200 and abs(area(fid) / full - 1.25) < 2e-3, r.get("error", round(area(fid) / full, 6)))
    # reshape inwards: a notch back in removes the bump and a strip
    notch = {"type": "LineString", "coordinates": [[x1 + w, y0 + w / 8], [xm, y0 + w / 8], [xm, y1 + w / 8]]}
    s, r = call("POST", f"api/layers/{pid}/geometry-edit", {"op": "reshape", "fids": [fid], "sketch": notch})
    check("reshape inwards keeps the larger part", s == 200 and area(fid) < 1.25 * full, r.get("error", round(area(fid) / full, 4)))
    s, r = call("POST", f"api/layers/{pid}/geometry-edit", {"op": "split", "fids": [fid], "sketch": {"type": "LineString", "coordinates": [[x0 - 2 * w, y0 - 2 * w], [x0 - w, y0 - w]]}})
    check("a line that misses is refused with a reason", s == 400 and "cross" in r.get("error", ""), r.get("error"))
    print("combine two layers (Lazy › Combine with …)")
    r, info = run("combine-layers", {"layer": ids["tiles"], "other": ids["wells"], "field": "yield"})
    check("points in areas run", r and r.get("status") == "done", json.dumps(info)[:200])
    cl = out_layer(r or {}, "combined")
    t = {x["tile"]: x for x in rows(cl)} if cl else {}
    ok_counts = t.get("00", {}).get("n_wells") == 3 and t.get("22", {}).get("n_wells") == 1 and t.get("01", {}).get("n_wells") == 0
    check("wells counted per tile (3, 1, 0)", ok_counts, {k: v.get("n_wells") for k, v in t.items()})
    check("sum and mean of yield in tile 00 (60, 20)", t.get("00", {}).get("sum_yield") == 60 and t.get("00", {}).get("mean_yield") == 20, t.get("00"))
    r, info = run("combine-layers", {"layer": ids["tiles"], "other": ids["roads"]})
    cl = out_layer(r or {}, "combined")
    t = {x["tile"]: x for x in rows(cl)} if cl else {}
    ln = t.get("01", {}).get("len_m_roads") or 0
    check("road length inside tile 01 ≈ 100 m", abs(ln - 100) < 1.5, ln)
    check("no road in tile 22", (t.get("22", {}).get("len_m_roads") or 0) == 0)
    r, info = run("combine-layers", {"layer": ids["wells"], "other": ids["tiles"]})
    cl = out_layer(r or {}, "combined")
    w = {x["well"]: x for x in rows(cl)} if cl else {}
    check("each well's tile (W1 → 00, W5 → none)", w.get("W1", {}).get("in_tiles") == "00" and w.get("W5", {}).get("in_tiles") in (None, ""), {k: v.get("in_tiles") for k, v in w.items()})
    r, info = run("combine-layers", {"layer": ids["roads"], "other": ids["wells"]})
    cl = out_layer(r or {}, "combined")
    rd = rows(cl) if cl else []
    near = rd[0].get("near_m_wells") if rd else None
    check("road to nearest well = 70 m (perpendicular to W3, not a vertex)", near is not None and abs(near - 70) < 1, near)

    print("journal methods")
    r, info = run("geographical-detector", {"layer": ids["plots"], "y": "yield", "x": "slope,noise"})
    det = next((st.get("outputs") for st in (r or {}).get("steps", []) if st.get("id") == "detector"), {}) or {}
    q = {row["factor"]: row["q"] for row in det.get("rows", [])}
    check("geodetector: slope explains yield (q ≈ 1)", q.get("slope", 0) > 0.95, q)
    check("geodetector: noise explains little (q < 0.3)", q.get("noise", 1) < 0.3, q)
    check("interaction detector reported", len(det.get("interactions", [])) == 1, det.get("interactions"))
    rid2 = next(x["id"] for x in call("GET", "api/rasters")[1]["rasters"] if "rows" in x["id"])
    r, info = run("area-of-applicability", {"layer": ids["plots"], "rasters": f"{rid},{rid2}"})
    a = next((st.get("outputs") for st in (r or {}).get("steps", []) if st.get("id") == "aoa"), {}) or {}
    check("AOA: rasters made", bool(a.get("di")) and bool(a.get("aoa")), json.dumps(info)[:300] if not a else a)
    check("AOA covers the sampled corner, not the whole grid (10–50 %)", 10 <= (a.get("inside_pct") or 0) <= 50, a.get("inside_pct"))
    r, info = run("knndm-folds", {"layer": ids["plots"], "area": ids["parcel"], "folds": 4})
    k = next((st.get("outputs") for st in (r or {}).get("steps", []) if st.get("id") == "folds"), {}) or {}
    check("kNNDM: folds no worse than random", k.get("w") is not None and k["w"] <= k["w_random"] + 1e-6, k or json.dumps(info)[:300])
    fl = rows(k["layer"]) if k.get("layer") else []
    check("kNNDM: every plot has a fold 1–4", fl and all(1 <= (x.get("fold") or 0) <= 4 for x in fl), sorted({x.get("fold") for x in fl}))

    print("export data (Share › Export data)")
    import io, zipfile
    for fmt, magic in [("gpkg", b"SQLite format 3"), ("geojson", b"{"), ("kml", b"<?xml"), ("csv", b"WKT"), ("shp", b"PK")]:
        try:
            with urllib.request.urlopen(f"{BASE}/api/layers/{ids['zones']}/download?format={fmt}", timeout=60) as resp:
                body, cd = resp.read(), resp.headers.get("Content-Disposition", "")
            ok = body.startswith(magic)
            if fmt == "shp":
                names = zipfile.ZipFile(io.BytesIO(body)).namelist()
                ok = ok and any(n.endswith(".shp") for n in names) and any(n.endswith(".dbf") for n in names) and any(n.endswith(".prj") for n in names)
            if fmt == "geojson":
                ok = ok and len(json.loads(body)["features"]) == 2
            check(f"{fmt} download", ok and "attachment" in cd, f"{len(body)} bytes, {cd}")
        except Exception as e:  # noqa: BLE001
            check(f"{fmt} download", False, str(e))
    s, r = call("GET", f"api/layers/{ids['zones']}/download?format=xls")
    check("an unknown format is refused", s == 400, r.get("error"))
finally:
    srv.terminate()
    srv.wait()
    if failed:
        print(open(os.path.join(tmp, "server.log")).read()[-3000:])
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
