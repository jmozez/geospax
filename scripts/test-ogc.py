#!/usr/bin/env python3
"""OGC API - Features: the layers as a standard feature service, checked over HTTP and with GDAL's
OAPIF client (what QGIS uses).   python3 scripts/test-ogc.py target/release/geospax-server"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request

bin_ = sys.argv[1] if len(sys.argv) > 1 else "target/release/geospax-server"
tmp = tempfile.mkdtemp(prefix="gx-ogc-")
subprocess.run([sys.executable, "scripts/test-edit-data.py", os.path.join(tmp, "data")], check=True, stdout=subprocess.DEVNULL)
port = 18145
srv = subprocess.Popen([bin_, "--data", os.path.join(tmp, "data"), "--state-dir", os.path.join(tmp, "state"), "--port", str(port), "--no-device-mounts", "--no-triggers"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = f"http://127.0.0.1:{port}/api/ogc"
ok = fail = 0
def check(c, msg):
    global ok, fail
    print(("  ok   " if c else "  FAIL ") + msg); ok += c; fail += (not c)
def get(u):
    with urllib.request.urlopen(u, timeout=30) as r:
        return r.headers.get("content-type", ""), json.loads(r.read())
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2); break
        except Exception: time.sleep(0.5)
    _, land = get(base)
    check(any(l["rel"] == "data" for l in land["links"]), "landing page links to the collections")
    _, conf = get(base + "/conformance")
    check(any(c.endswith("/conf/geojson") for c in conf["conformsTo"]), "conformance lists core and GeoJSON")
    _, cols = get(base + "/collections")
    ids = [c["id"] for c in cols["collections"]]
    check("reserves.geojson" in ids and "survey.geojson" in ids, f"one collection per layer ({len(ids)})")
    check(all(c["links"][1]["href"].startswith("http://") for c in cols["collections"]), "links are absolute")
    ct, page = get(base + "/collections/survey.geojson/items?limit=10")
    check(ct.startswith("application/geo+json") and page["type"] == "FeatureCollection" and page["numberReturned"] == 10, "items: a GeoJSON page of 10")
    check(any(l["rel"] == "next" for l in page["links"]), "paging: a next link")
    _, page2 = get(base + "/collections/survey.geojson/items?limit=10&offset=10")
    check(page2["features"][0]["id"] == 10, "offset moves the page")
    b = cols["collections"][ids.index("survey.geojson")]["extent"]["spatial"]["bbox"][0]
    mid = (b[0] + b[2]) / 2
    _, half = get(base + f"/collections/survey.geojson/items?limit=1000&bbox={b[0]},{b[1]},{mid},{b[3]}")
    _, full = get(base + "/collections/survey.geojson/items?limit=1000")
    check(0 < half["numberReturned"] < full["numberReturned"], f"bbox filters ({half['numberReturned']} of {full['numberReturned']})")
    _, f3 = get(base + "/collections/survey.geojson/items/3")
    check(f3["type"] == "Feature" and f3["id"] == 3 and f3["geometry"]["type"] == "Point", "one feature by id")
    # big-file reading: a layer saved as GeoParquet, read back for half its area only
    pq = os.path.join(tmp, "survey.parquet")
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/layers/survey.geojson/download?format=parquet", timeout=60) as r:
        open(pq, "wb").write(r.read())
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/geoparquet?url={urllib.parse.quote(pq)}&bbox={b[0]},{b[1]},{mid},{b[3]}", method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        got = json.loads(r.read())
    check(got["layers"] and 0 < got["features"] < full["numberReturned"], f"GeoParquet by URL reads only the area ({got['features']} of {full['numberReturned']})")
    if shutil.which("ogrinfo"):
        out = subprocess.run(["ogrinfo", "-ro", "-al", "-so", f"OAPIF:{base}", "survey.geojson"], capture_output=True, text=True, timeout=120).stdout
        check(f"Feature Count: {full['numberReturned']}" in out, "GDAL's OAPIF client (as in QGIS) reads the layer")
finally:
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)
print(f"{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
