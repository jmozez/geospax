#!/usr/bin/env python3
"""Your own ONNX model (ai.detect) against known answers, offline.

A 128 × 128 px RGB image (1 m pixels, UTM 55S) with a red 20 × 20 px "roof" at rows 20–39, cols 70–89
goes through the fixture models of scripts/make-onnx-fixtures.py:

  seg_red  segmentation → a class raster: "red roof" exactly on the 400 roof pixels, background elsewhere
  det_v8   YOLOv8 layout, fixed boxes per 64 px tile → 4 tiles × 2 boxes (the duplicate and the low
           score dropped), each where the model put it, in map coordinates, with its class and area
  det_v5   the same boxes through the YOLOv5 layout (objectness × class score)
plus: models are listed with the task and labels read from the file; a file that is not a model and
an unknown model are refused with a reason; results join Contents (GET /api/rev changes).

usage: test-detect.py BIN
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import numpy as np

BIN = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "tests", "fixtures", "onnx")
X0, Y0 = 400000.0, 9350000.0
passed, failed = 0, []


def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
    else:
        failed.append(name)
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f" ({extra})" if extra else ""))


tmp = tempfile.mkdtemp(prefix="gx-detect-")
data = os.path.join(tmp, "data")
os.makedirs(data)
img = np.zeros((3, 128, 128), np.uint8)
img[0], img[1], img[2] = 100, 110, 100
img[:, 20:40, 70:90] = np.array([230, 20, 20], np.uint8)[:, None, None]
raw = os.path.join(tmp, "img.bin")
img.tofile(raw)
with open(raw[:-4] + ".hdr", "w") as f:
    f.write("ENVI\nsamples = 128\nlines = 128\nbands = 3\nheader offset = 0\nfile type = ENVI Standard\ndata type = 1\ninterleave = bsq\nbyte order = 0\n")
subprocess.run(["gdal_translate", "-q", "-of", "GTiff", "-a_srs", "EPSG:32755", "-a_ullr", str(X0), str(Y0), str(X0 + 128), str(Y0 - 128), raw, os.path.join(data, "image.tif")], check=True)

PORT = 18098
srv = subprocess.Popen([BIN, "--data", data, "--state-dir", os.path.join(tmp, "state"), "--port", str(PORT), "--web", "web/dist", "--no-device-mounts", "--no-triggers"],
                       stdout=subprocess.DEVNULL, stderr=open(os.path.join(tmp, "server.log"), "w"))
BASE = f"http://127.0.0.1:{PORT}"


def call(method, path, body=None, ctype="application/json"):
    d = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{BASE}/{path}", data=d, method=method, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def run_recipe(rid, steps):
    y = ["recipe: " + rid, "version: 1", "title: " + rid, "steps:"]
    for i, (use, w) in enumerate(steps):
        y += [f"  - id: s{i}", f"    use: {use}", f"    with: {json.dumps(w)}"]
    y += ["outputs: [s0]", ""]
    s, r = call("POST", "api/recipes", "\n".join(y).encode(), "text/yaml")
    if s not in (200, 201):
        return {"status": "rejected", "error": r.get("error")}
    s, run = call("POST", f"api/recipes/{rid}/run", {})
    for _ in range(240):
        s, run = call("GET", f"api/runs/{run['id']}")
        if run["status"] not in ("running", "queued"):
            break
        time.sleep(0.5)
    return run


def read_band(path):
    out = os.path.join(tmp, "read.bin")
    subprocess.run(["gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", path, out], check=True)
    return np.fromfile(out, np.float32).reshape(128, 128)


try:
    for _ in range(60):
        try:
            if call("GET", "api/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)

    print("models")
    for m in ("seg_red", "det_v8", "det_v5"):
        with open(os.path.join(FIX, f"{m}.onnx"), "rb") as f:
            s, r = call("POST", f"api/models?name={m}.onnx", f.read(), "application/octet-stream")
        check(f"{m} added", s == 201, r.get("error", ""))
    s, r = call("GET", "api/models")
    ms = {m["name"]: m for m in r["models"]}
    check("tasks read from the models", ms["seg_red"]["task"] == "segment" and ms["det_v8"]["task"] == "detect" and ms["det_v5"]["task"] == "detect",
          ", ".join(f"{k}: {v['task']}" for k, v in ms.items()))
    check("labels read from the model metadata", ms["det_v8"]["labels"] == ["tree", "house"] and ms["seg_red"]["labels"] == ["background", "red roof"])
    s, r = call("PUT", "api/models/det_v8", {"licence": "CC0-1.0 (test fixture)", "source": "scripts/make-onnx-fixtures.py"})
    check("licence and source saved with the model", r.get("licence") == "CC0-1.0 (test fixture)")
    s, r = call("POST", "api/models?name=notes.onnx", b"not a model", "application/octet-stream")
    check("a file that is not a model is refused", s == 400 and "not a model" in r.get("error", ""), r.get("error", "")[:70])
    s, r = call("POST", "api/models?name=readme.txt", b"x", "application/octet-stream")
    check("a non-.onnx file is refused", s == 400)

    print("segmentation")
    rev0 = call("GET", "api/rev")[1]["rev"]
    run = run_recipe("seg", [("ai.detect", {"model": "seg_red", "raster": "image"})])
    check("run done", run["status"] == "done", run.get("error") or "")
    o = run["steps"][0]["outputs"] or {}
    cls = read_band(o["path"])
    roof = np.zeros((128, 128), bool)
    roof[20:40, 70:90] = True
    check("red roof exactly on the roof pixels", (cls[roof] == 2).all() and (cls[~roof] == 1).all(), f"{int((cls == 2).sum())} px")
    check("class names and counts", o.get("classes") == ["background", "red roof"] and o.get("counts") == [128 * 128 - 400, 400], json.dumps(o.get("counts")))
    check("the result joins the map (catalogue changed)", call("GET", "api/rev")[1]["rev"] != rev0)

    for model in ("det_v8", "det_v5"):
        print(model)
        run = run_recipe(model, [("ai.detect", {"model": model, "raster": "image", "tile": 64, "overlap": 0})])
        check("run done", run["status"] == "done", run.get("error") or "")
        o = run["steps"][0]["outputs"] or {}
        check("4 tiles, 2 boxes each after NMS and the threshold", o.get("tiles") == 4 and o.get("count") == 8 and o.get("raw") == 12, f"tiles {o.get('tiles')}, raw {o.get('raw')}, kept {o.get('count')}")
        check("classes counted", sorted(map(tuple, o.get("by_class", []))) == [("house", 4), ("tree", 4)], json.dumps(o.get("by_class")))
        s, t = call("POST", f"api/layers/{o['layer']}/table", {"limit": 50, "sort": "score", "desc": True})
        fields = t["fields"]
        rows = [dict(zip(fields, r["values"])) for r in t["rows"]]
        trees = [r for r in rows if r["class"] == "tree"]
        houses = [r for r in rows if r["class"] == "house"]
        check("scores and areas", all(abs(r["score"] - 0.9) < 1e-3 and r["area_m2"] == 64 for r in trees) and all(abs(r["score"] - 0.85) < 1e-3 and r["area_m2"] == 60 for r in houses),
              f"tree {trees[0]['score'] if trees else '-'} / {trees[0]['area_m2'] if trees else '-'} m², house {houses[0]['area_m2'] if houses else '-'} m²")
        # every box back in UTM: the corners must be whole pixels where the model put them
        gpkg = os.path.join(tmp, "state", "outputs", model, "detections.gpkg")
        csv = subprocess.run(["ogr2ogr", "-f", "CSV", "/vsistdout/", gpkg, "-t_srs", "EPSG:32755", "-lco", "GEOMETRY=AS_WKT"], capture_output=True, text=True).stdout
        boxes = []
        for line in csv.strip().splitlines()[1:]:
            wkt = line.split('"')[1]
            pts = [tuple(map(float, xy.split())) for xy in wkt[wkt.rfind("(") + 1:wkt.find(")")].split(",")]
            xs, ys = [p[0] - X0 for p in pts], [Y0 - p[1] for p in pts]
            boxes.append((round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)))
        want = sorted([(12 + tx, 12 + ty, 20 + tx, 20 + ty) for tx in (0, 64) for ty in (0, 64)] + [(43 + tx, 37 + ty, 53 + tx, 43 + ty) for tx in (0, 64) for ty in (0, 64)])
        check("every box where the model put it (to 1 cm)", sorted(boxes) == want, f"{sorted(boxes)[:2]} …")
        if model == "det_v8":
            methods = " ".join(run.get("methods") or [])
            check("the licence is in the methods", "CC0-1.0 (test fixture)" in json.dumps(run), "")

    print("errors")
    run = run_recipe("nomodel", [("ai.detect", {"model": "missing", "raster": "image"})])
    check("an unknown model is refused with a reason", run["status"] == "failed" and "Models" in (run.get("error") or ""), (run.get("error") or "")[:80])
    run = run_recipe("badbands", [("ai.detect", {"model": "seg_red", "raster": "image", "bands": [1, 2, 4]})])
    check("a band the image does not have is refused", run["status"] == "failed" and "band 4" in (run.get("error") or ""), (run.get("error") or "")[:80])
finally:
    srv.terminate()
    srv.wait()
    if not failed:
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("kept", tmp)

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
