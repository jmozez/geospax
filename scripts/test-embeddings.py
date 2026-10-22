#!/usr/bin/env python3
"""Satellite-embedding steps against known truth, offline.

A local mirror in the layout of the public AlphaEarth copy (<year>/<zone>/<name>.vrt + GeoTIFF) is
built with three known landscapes as vertical stripes (each a unit vector plus noise, quantised the
way the dataset is), a masked corner, and in 2018 a 50 × 50 px block that was landscape C turned
into A. GeoSpaX reads it through GEOSPAX_AEF_BASE and the checks are:

  fetch     the grid comes back whole, masked pixels stay masked, values survive the round trip
  similar   pixels of the clicked landscape are alike (≥ 0.95), the others are not
  cluster   three groups, one per stripe
  classify  labelled points → every stripe gets its class, leave-one-out accuracy 100 %
  change    the changed block (25 ha) is found, and nothing else

usage: test-embeddings.py BIN
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
W = H = 300
X0, Y0, RES = 400000.0, 9350000.0, 10.0  # UTM 55S, about 146.1 E, 5.9 S
EPSG = 32755
passed, failed = 0, []


def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}" + (f" ({extra})" if extra else ""))
    else:
        failed.append(name)
        print(f"  FAIL {name}" + (f" ({extra})" if extra else ""))


def unit(rng, n=64):
    v = rng.normal(size=n)
    return v / np.linalg.norm(v)


def quantise(v):
    """float in [-1, 1] → int8 with the dataset's mapping (inverse of (q/127.5)² · sign q)."""
    q = np.sign(v) * np.sqrt(np.abs(v)) * 127.5
    return np.clip(np.round(q), -127, 127).astype(np.int16)


def to_lonlat(pts):
    txt = "\n".join(f"{x} {y}" for x, y in pts)
    out = subprocess.run(["gdaltransform", "-s_srs", f"EPSG:{EPSG}", "-t_srs", "EPSG:4326", "-output_xy"], input=txt, capture_output=True, text=True, check=True).stdout
    return [tuple(map(float, l.split()[:2])) for l in out.strip().splitlines()]


rng = np.random.default_rng(42)
centres = [unit(rng) for _ in range(3)]
stripe = np.repeat(np.arange(3), 100)  # column → landscape


def year_grid(changed):
    v = np.empty((H, W, 64))
    for r in range(H):
        for c in range(W):
            k = stripe[c]
            if changed and 100 <= r < 150 and 200 <= c < 250:
                k = 0
            x = centres[k] + rng.normal(scale=0.08, size=64) / 8
            v[r, c] = x / np.linalg.norm(x)
    q = quantise(v)
    q[:10, :10, :] = -128  # masked corner
    return q


tmp = tempfile.mkdtemp(prefix="gx-emb-")
mirror = os.path.join(tmp, "mirror")
for year, changed in [(2024, False), (2018, True)]:
    d = os.path.join(mirror, str(year), "55S")
    os.makedirs(d)
    q = year_grid(changed)
    raw = os.path.join(tmp, f"g{year}.bin")
    q.transpose(2, 0, 1).astype("<i2").tofile(raw)  # band-sequential
    with open(raw[:-4] + ".hdr", "w") as f:
        f.write(f"ENVI\nsamples = {W}\nlines = {H}\nbands = 64\nheader offset = 0\nfile type = ENVI Standard\ndata type = 2\ninterleave = bsq\nbyte order = 0\n")
    tif = os.path.join(d, f"xsynthetic{year}-0000000000-0000000000.tiff")
    subprocess.run(["gdal_translate", "-q", "-of", "GTiff", "-ot", "Int8", "-a_srs", f"EPSG:{EPSG}", "-a_ullr", str(X0), str(Y0), str(X0 + W * RES), str(Y0 - H * RES),
                    "-a_nodata", "-128", "-co", "INTERLEAVE=BAND", "-co", "TILED=YES", raw, tif], check=True)
    subprocess.run(["gdalbuildvrt", "-q", tif.replace(".tiff", ".vrt"), tif], check=True)

# sample points: 5 per landscape, away from the changed block and the masked corner
pts, labels = [], []
for k in range(3):
    for j in range(5):
        c = k * 100 + 20 + j * 15
        r = 200 + j * 15
        pts.append((X0 + (c + 0.5) * RES, Y0 - (r + 0.5) * RES))
        labels.append("ABC"[k])
ll = to_lonlat(pts)
data = os.path.join(tmp, "data")
os.makedirs(data)
with open(os.path.join(data, "samples.geojson"), "w") as f:
    json.dump({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"class": lab}, "geometry": {"type": "Point", "coordinates": list(p)}} for p, lab in zip(ll, labels)]}, f)
corners = to_lonlat([(X0 + 5, Y0 - 5), (X0 + W * RES - 5, Y0 - H * RES + 5)])
aoi = [corners[0][0], corners[1][1], corners[1][0], corners[0][1]]
click = to_lonlat([(X0 + 50.5 * RES, Y0 - 60.5 * RES)])[0]  # landscape A

PORT = 18097
env = dict(os.environ, GEOSPAX_AEF_BASE=mirror)
srv = subprocess.Popen([BIN, "--data", data, "--state-dir", os.path.join(tmp, "state"), "--port", str(PORT), "--web", "web/dist", "--no-device-mounts", "--no-triggers"],
                       env=env, stdout=subprocess.DEVNULL, stderr=open(os.path.join(tmp, "server.log"), "w"))
BASE = f"http://127.0.0.1:{PORT}"


def call(method, path, body=None, ctype="application/json"):
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{BASE}/{path}", data=data, method=method, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def read(path, dtype):
    out = os.path.join(tmp, "read.bin")
    subprocess.run(["gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", path, out], check=True)
    return np.fromfile(out, np.float32).reshape(-1, H, W)[0] if dtype == "band" else np.fromfile(out, np.float32)


try:
    for _ in range(60):
        try:
            if call("GET", "api/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)
    recipe = "\n".join([
        "recipe: emb-truth", "version: 1", "title: embeddings truth", "steps:",
        "  - id: fetch", "    use: embeddings.fetch", f"    with: {json.dumps({'aoi': aoi, 'buffer': 0, 'year': 2024})}",
        "  - id: similar", "    use: embeddings.similar", f"    with: {json.dumps({'embeddings': '${fetch.raster}', 'point': list(click)})}",
        "  - id: groups", "    use: embeddings.cluster", '    with: {"embeddings": "${fetch.raster}", "classes": 3}',
        "  - id: classify", "    use: embeddings.classify", '    with: {"embeddings": "${fetch.raster}", "samples": "samples.geojson", "field": "class"}',
        "  - id: old", "    use: embeddings.fetch", f"    with: {json.dumps({'aoi': aoi, 'buffer': 0, 'year': 2018})}",
        "  - id: change", "    use: embeddings.change", '    with: {"before": "${old.raster}", "after": "${fetch.raster}"}',
        "outputs: [change]", ""])
    s, r = call("POST", "api/recipes", recipe.encode(), "text/yaml")
    check("recipe accepted", s in (200, 201), r.get("error", ""))
    s, run = call("POST", "api/recipes/emb-truth/run", {})
    rid = run["id"]
    for _ in range(300):
        s, run = call("GET", f"api/runs/{rid}")
        if run["status"] not in ("running", "queued"):
            break
        time.sleep(1)
    check("run finished", run["status"] == "done", run.get("error") or run["status"])
    out = {st["id"]: st.get("outputs") or {} for st in run.get("steps", [])}

    f = out.get("fetch", {})
    check("fetch: the whole grid, one file", f.get("size") == [W, H] and f.get("files") == 1, f"{f.get('size')} from {f.get('files')} file(s)")
    emb_path = f.get("path", "")
    eb = os.path.join(tmp, "e.bin")
    subprocess.run(["gdal_translate", "-q", "-of", "ENVI", "-ot", "Int16", emb_path, eb], check=True)
    raw = np.fromfile(eb, np.int16)
    e = raw.reshape(H, W, 64) if "bip" in open(eb[:-4] + ".hdr").read() else raw.reshape(64, H, W).transpose(1, 2, 0)
    check("fetch: masked corner stays masked, the rest is data", (e[:10, :10, 0] == -128).all() and (e[10:, 10:, 0] != -128).all())
    deq = np.sign(e) * (e / 127.5) ** 2
    norms = np.linalg.norm(deq[20:, 20:], axis=2)
    check("fetch: de-quantised vectors are unit length", abs(norms.mean() - 1) < 0.02, f"mean |v| {norms.mean():.3f}")

    sim = read(out["similar"]["path"], "band")
    a, bc = sim[20:, 20:100].mean(), sim[20:, 100:].mean()
    check("similar: the clicked landscape ≥ 0.95, the others below 0.6", a >= 0.95 and bc < 0.6, f"A {a:.3f}, B+C {bc:.3f}")
    check("similar: masked pixels are nodata", (sim[:10, :10] < -1000).all())

    g = read(out["groups"]["path"], "band")
    pure = [np.bincount(g[20:, k * 100 + 5:(k + 1) * 100 - 5].astype(int).ravel()).max() / g[20:, k * 100 + 5:(k + 1) * 100 - 5].size for k in range(3)]
    labs = [np.bincount(g[20:, k * 100 + 5:(k + 1) * 100 - 5].astype(int).ravel()).argmax() for k in range(3)]
    # the 2024 grid has no changed block, so each stripe is one landscape
    check("cluster: three groups, one per stripe", out["groups"].get("classes") == 3 and min(pure) > 0.98 and len(set(labs)) == 3, f"purity {', '.join(f'{p:.3f}' for p in pure)}")

    c = read(out["classify"]["path"], "band")
    names = out["classify"].get("classes", [])
    right = [np.mean(c[20:, k * 100:(k + 1) * 100] == names.index("ABC"[k]) + 1) for k in range(3)] if len(names) == 3 else [0]
    check("classify: each stripe gets its class", min(right) > 0.99, f"{', '.join(f'{x:.3f}' for x in right)}")
    check("classify: leave-one-out accuracy 100 %", out["classify"].get("accuracy") == 1.0 and out["classify"].get("samples") == 15)

    ch = out["change"]
    d = read(ch["path"], "band")
    block = d[100:150, 200:250].mean()
    rest = np.delete(d[20:, 20:].ravel(), np.ravel_multi_index(np.mgrid[80:130, 180:230].reshape(2, -1), (H - 20, W - 20)))
    check("change: the 25 ha block is found", abs(ch.get("area_ha", 0) - 25) < 2, f"{ch.get('area_ha', 0):.1f} ha")
    check("change: changed block high, the rest near 0", block > 0.5 and np.percentile(rest, 99) < 0.1, f"block {block:.2f}, rest p99 {np.percentile(rest, 99):.3f}")

    s, rl = call("GET", "api/rasters")
    kinds = {x["id"].split(".")[-1]: x.get("kind") for x in rl["rasters"]}
    check("rasters registered with their kinds", kinds.get("embeddings_2024") == "embedding" and kinds.get("similarity") == "similarity" and kinds.get("clusters") == "classes", json.dumps(kinds))
    with urllib.request.urlopen(f"{BASE}/api/rasters/emb-truth.embeddings_2024/overlay.png", timeout=60) as r:
        png = r.read()
    check("the embedding raster draws (3 axes as colours)", png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 1000, f"{len(png)} bytes")
finally:
    srv.terminate()
    srv.wait()
    if not failed:
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print(f"kept {tmp} (server.log)")

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
