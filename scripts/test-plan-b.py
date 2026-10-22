#!/usr/bin/env python3
"""Plan-B data against known answers, offline: GEBCO, Hansen forest change, ecoregions and WoRMS.

Each source is pointed at a local mirror with its provider's own layout (`base:`), so the whole path
runs as it does online: the cut, the mosaic, the recoding, the styles, the classes, the credits.

  GEBCO      a 0.5° grid on GEBCO's 15″ cells: sea (−1,500 m) in the west, land (+400 m) in the east;
             TID: land 0, multibeam 11, satellite gravity 40 → the cut equals the grid cell for cell,
             the style splits at sea level, the TID classes carry GEBCO's labels and shares
  Hansen     two 1° tiles either side of 150°E (1″ cells): tree cover 80 % west, 20 % east; loss in
             2005 in a strip, 2024 in another → the mosaic joins the tiles, loss years are years,
             no-loss cells are clear; an area over 2° is refused with the reason
  Ecoregions a zipped shapefile with two ecoregions meeting at 147.5°E → clipped to the area, areas
             on the sphere, RESOLVE's colours as the style
  WoRMS      a local server answering with WoRMS's answers recorded on 2026-10-22
             (tests/fixtures/worms/match-names.json) → ok, synonym, check spelling, ambiguous, not in
             WoRMS; "within Cnidaria" settles the Acropora homonym; a second run asks WoRMS nothing

usage: test-plan-b.py BIN
"""
import http.server
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import numpy as np

BIN = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
passed, failed = 0, []


def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
    else:
        failed.append(name)
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f" ({extra})" if extra else ""))


tmp = tempfile.mkdtemp(prefix="gx-planb-")
data = os.path.join(tmp, "data")
os.makedirs(data)


def tif(path, arr, x0, y0, res, dtype, gdal_type, nodata=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    arr = np.asarray(arr, dtype)
    raw = path + ".bin"
    arr.tofile(raw)
    h, w = arr.shape
    with open(path + ".hdr", "w") as f:
        f.write(f"ENVI\nsamples = {w}\nlines = {h}\nbands = 1\nheader offset = 0\nfile type = ENVI Standard\ndata type = {gdal_type}\ninterleave = bsq\nbyte order = 0\n")
    args = ["gdal_translate", "-q", "-of", "GTiff", "-co", "COMPRESS=DEFLATE", "-a_srs", "EPSG:4326", "-a_ullr", str(x0), str(y0), str(x0 + w * res), str(y0 - h * res)]
    if nodata is not None:
        args += ["-a_nodata", str(nodata)]
    subprocess.run(args + [raw, path], check=True)
    os.remove(raw)
    os.remove(path + ".hdr")


# ---- GEBCO mirror: 120 × 120 cells of 15″ (0.5°) at 147.0–147.5°E, 9.5–10.0°S
G = 240
gx0, gy0, gn = 147.0, -9.5, 120
elev = np.where(np.arange(gn)[None, :] < 60, -1500, 400).repeat(gn, 0).astype(np.int16)
elev[0, 0] = -32767  # GEBCO's nodata
tidg = np.where(np.arange(gn)[None, :] < 60, 40, 0).repeat(gn, 0).astype(np.int8)
tidg[:30, :60] = 11  # the north-west quarter of the sea is multibeam
gebco = os.path.join(tmp, "gebco")
tif(os.path.join(gebco, "gebco_2026", "gebco_2026.tif"), elev, gx0, gy0, 1 / G, np.int16, 2, -32767)
tif(os.path.join(gebco, "gebco_2026_tid", "gebco_2026_tid.tif"), tidg, gx0, gy0, 1 / G, np.uint8, 1)

# ---- Hansen mirror: two tiles 00N_140E and 00N_150E, each a 1° window at 9.0–10.0°S on 1″ cells
H = 3600
hansen = os.path.join(tmp, "hansen")
os.makedirs(hansen)
for tile, x0, cover in (("00N_140E", 149.0, 80), ("00N_150E", 150.0, 20)):
    tc = np.full((H, H), cover, np.uint8)
    ly = np.zeros((H, H), np.uint8)
    ly[1800:1810, :] = 5    # a strip lost in 2005 (rows at 9.500–9.503°S)
    ly[1600:1605, :] = 24   # another lost in 2024 (9.444–9.446°S)
    tif(os.path.join(hansen, f"Hansen_GFC-2025-v1.13_treecover2000_{tile}.tif"), tc, x0, -9.0, 1 / H, np.uint8, 1)
    tif(os.path.join(hansen, f"Hansen_GFC-2025-v1.13_lossyear_{tile}.tif"), ly, x0, -9.0, 1 / H, np.uint8, 1)

# ---- Ecoregions mirror: two polygons meeting at 147.5°E (0.5° squares), in a zipped shapefile
eco = os.path.join(tmp, "eco")
os.makedirs(eco)
gj = os.path.join(tmp, "eco.geojson")
feats = []
for name, x0, color, biome in (("Lowland test forest", 147.0, "#38A700", "Tropical & Subtropical Moist Broadleaf Forests"), ("Montane test forest", 147.5, "#7AB6F5", "Montane Grasslands & Shrublands")):
    ring = [[x0, -6.5], [x0 + 0.5, -6.5], [x0 + 0.5, -6.0], [x0, -6.0], [x0, -6.5]]
    feats.append({"type": "Feature", "properties": {"ECO_NAME": name, "BIOME_NAME": biome, "REALM": "Australasia", "ECO_ID": len(feats) + 1, "NNH_NAME": "Nature Could Reach Half Protected", "COLOR": color}, "geometry": {"type": "Polygon", "coordinates": [ring]}})
json.dump({"type": "FeatureCollection", "features": feats}, open(gj, "w"))
shp = os.path.join(tmp, "shp")
os.makedirs(shp)
subprocess.run(["ogr2ogr", "-q", "-f", "ESRI Shapefile", os.path.join(shp, "Ecoregions2017.shp"), gj, "-nln", "Ecoregions2017"], check=True)
with zipfile.ZipFile(os.path.join(eco, "Ecoregions2017.zip"), "w") as z:
    for f in os.listdir(shp):
        z.write(os.path.join(shp, f), f)

# ---- WoRMS mirror: recorded answers, one list per asked name; 204 when nothing matches
REC = json.load(open(os.path.join(HERE, "..", "tests", "fixtures", "worms", "match-names.json")))["answers"]
asked = []


class Worms(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        names = urllib.parse.parse_qs(u.query).get("scientificnames[]", [])
        asked.append(names)
        out = [REC.get(n, []) for n in names]
        if not any(out):
            self.send_response(204)
            self.end_headers()
            return
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


wsrv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Worms)
threading.Thread(target=wsrv.serve_forever, daemon=True).start()
WORMS = f"http://127.0.0.1:{wsrv.server_address[1]}"
names = ["Chelonia mydas", "Acropora formosa", "Chelonia mydass", "Tridacna gigas", "Ornithoptera priamus", "Acropora sp.", " Chelonia  mydas ", ""]
json.dump({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"species": n, "n": i}, "geometry": {"type": "Point", "coordinates": [147.1 + i * 0.01, -9.6]}} for i, n in enumerate(names)]}, open(os.path.join(data, "reef.geojson"), "w"))

PORT = 18097
srv = subprocess.Popen([BIN, "--data", data, "--state-dir", os.path.join(tmp, "state"), "--port", str(PORT), "--web", "web/dist", "--no-device-mounts", "--no-triggers"],
                       stdout=subprocess.DEVNULL, stderr=open(os.path.join(tmp, "server.log"), "w"))
BASE = f"http://127.0.0.1:{PORT}"


def call(method, path, body=None, ctype="application/json"):
    d = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{BASE}/{path}", data=d, method=method, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def run(rid, use, w, report=False):
    y = f"recipe: {rid}\nversion: 1\ntitle: {rid}\nsteps:\n  - id: s\n    use: {use}\n    with: {json.dumps(w)}\n"
    y += '  - id: report\n    use: export.report\n    needs: ["s"]\n    with: {}\noutputs: [report]\n' if report else "outputs: [s]\n"
    call("POST", "api/recipes", y.encode(), "text/yaml")
    s, r = call("POST", f"api/recipes/{rid}/run", {})
    for _ in range(600):
        s, r = call("GET", f"api/runs/{r['id']}")
        if r["status"] not in ("running", "queued"):
            break
        time.sleep(0.5)
    return r


def sidecar(path):
    return json.load(open(path + ".gsx.json"))


def report_text(r):
    p = (r.get("outputs") or {}).get("report", {}).get("html") or next((os.path.join(r["dir"], a) for a in r.get("artifacts", []) if a.endswith(".html")), None)
    return open(p).read() if p and os.path.exists(p) else ""


def raster_info(rid):
    return next(r for r in call("GET", "api/rasters")[1]["rasters"] if r["id"] == rid)


def read(path):
    out = os.path.join(tmp, "read.bin")
    subprocess.run(["gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", path, out], check=True)
    hdr = open(out[:-4] + ".hdr").read()
    w = int(hdr.split("samples = ")[1].split()[0])
    return np.fromfile(out, np.float32).reshape(-1, w)


try:
    for _ in range(60):
        try:
            if call("GET", "api/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)

    print("GEBCO")
    r = run("gebco", "data.fetch", {"source": "gebco", "layers": "elevation, tid", "aoi": [147.1, -9.9, 147.4, -9.6], "buffer": 0, "base": gebco})
    check("run done", r["status"] == "done", r.get("error") or "")
    o = r["steps"][0]["outputs"] or {}
    cut = read(o["rasters"][0]["path"])
    # the area snapped to GEBCO's cells: columns 24–96, rows 24–96 of the mirror
    want = elev[24:96, 24:96].astype(np.float32)
    want[want == -32767] = -9999
    check("the cut equals the grid cell for cell", cut.shape == want.shape and np.array_equal(cut, want), f"{cut.shape} vs {want.shape}")
    ri = raster_info("gebco.gebco_2026")
    st, lg = ri.get("style", {}), ri.get("legend", {})
    check("drawn split at sea level", st.get("kind") == "split" and st.get("at") == 0 and st.get("below") == "ocean", json.dumps(st)[:120])
    check("legend marks sea level at the middle", (lg.get("mid") or {}).get("label") == "0 (sea level)" and len(lg.get("offsets", [])) == len(lg.get("colors", [])) and lg["offsets"][7] == 0.5 and lg["offsets"][8] == 0.5)
    cr = sidecar(o["rasters"][0]["path"]).get("credit", "")
    check("credit says not for navigation", "not for navigation" in cr, cr)
    tid = raster_info("gebco.gebco_2026_tid")
    items = {i["label"].split(" · ")[0]: i for i in tid["legend"]["items"]}
    check("TID classes with GEBCO's labels", set(items) == {"0 Land", "11 Multibeam echo-sounder", "40 Predicted from satellite gravity"}, ", ".join(items))
    # cut rows 24–96, cols 24–96: multibeam rows 24–30 of 72 sea columns 24–60 → 6 × 36 of 72 × 72
    mb = float(items["11 Multibeam echo-sounder"]["label"].split(" · ")[1].rstrip(" %"))
    check("TID shares", abs(mb - 6 * 36 / (72 * 72) * 100) < 0.6, f"multibeam {mb} %")
    check("citation with GEBCO's DOI in the methods", any("10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa" in m for m in r.get("methods") or []) or "4f68d5c7" in json.dumps(r))

    print("Hansen forest change")
    r = run("hansen", "data.fetch", {"source": "hansen", "aoi": [149.9, -9.6, 150.1, -9.4], "buffer": 0, "base": hansen}, report=True)
    check("run done", r["status"] == "done", r.get("error") or "")
    o = r["steps"][0]["outputs"] or {}
    tc = read(o["rasters"][0]["path"])
    check("two tiles joined: 80 % west of 150°E, 20 % east", tc.shape == (720, 720) and (tc[:, :360] == 80).all() and (tc[:, 360:] == 20).all(), f"{tc.shape}")
    ly = read(o["rasters"][1]["path"])
    # the mirror's 2005 strip: rows 1800–1810 of a tile from 9.0°S → 9.5–9.5028°S; the cut starts at 9.4°S (row 1440)
    years = sorted(set(np.unique(ly).tolist()) - {-9999.0})
    check("loss stored as years", years == [2005.0, 2024.0], f"{years}")
    check("2005 and 2024 exactly where the strips are", (ly[360:370, :] == 2005).all() and (ly[160:165, :] == 2024).all() and (ly[350:360, :] == -9999).all() and (ly[370:380, :] == -9999).all() and int((ly != -9999).sum()) == 15 * 720)
    li = raster_info("hansen.hansen_lossyear")
    check("loss legend in years", li["legend"].get("labels") == ["2001", "2025"] and li["style"].get("ramp") == "loss", json.dumps(li["legend"].get("labels")))
    cr = sidecar(o["rasters"][1]["path"]).get("credit", "")
    check("Hansen credit", cr == "Source: Hansen/UMD/Google/USGS/NASA (CC-BY 4.0)", cr)
    rep = report_text(r)
    check("the pixel-count caveat and the citation are in the report's methods", "should not be estimated from pixel counts" in rep and "Science 342" in rep, f"{len(rep)} chars")
    r = run("hansen-big", "data.fetch", {"source": "hansen", "aoi": [140.0, -10.0, 145.0, -6.0], "buffer": 0, "base": hansen})
    check("an area over 2° is refused with the reason", r["status"] == "failed" and "220 km" in (r.get("error") or ""), (r.get("error") or "")[:90])

    print("Ecoregions")
    r = run("eco", "data.fetch", {"source": "ecoregions", "aoi": [147.25, -6.4, 147.75, -6.1], "buffer": 0, "base": eco})
    check("run done", r["status"] == "done", r.get("error") or "")
    o = r["steps"][0]["outputs"] or {}
    t = {e["ecoregion"]: e for e in o.get("table", [])}
    # each part is 0.25° × 0.3° at 6.25°S: R² · Δλ · (sin φ1 − sin φ2)
    R = 6371008.8  # the mean radius, as Turf and QGIS's spherical fallback
    want_km2 = R * R * math.radians(0.25) * (math.sin(math.radians(-6.1)) - math.sin(math.radians(-6.4))) / 1e6
    check("both ecoregions, clipped to the area", set(t) == {"Lowland test forest", "Montane test forest"}, ", ".join(t))
    check("areas on the sphere", all(abs(e["area_km2"] - want_km2) / want_km2 < 0.002 for e in t.values()), f"{[e['area_km2'] for e in t.values()]} vs {want_km2:.1f}")
    s, lst = call("GET", "api/project")
    style = json.dumps((lst.get("styles") or {}).get(o["layer"]) or lst)
    check("RESOLVE's colours as the style", "#38A700" in style and "#7AB6F5" in style)

    print("WoRMS")
    r = run("names", "taxa.worms", {"layer": "reef.geojson", "base": WORMS})
    check("run done", r["status"] == "done", r.get("error") or "")
    o = r["steps"][0]["outputs"] or {}
    v = {e["name"]: e for e in o.get("table", [])}
    check("ok", v["Chelonia mydas"]["verdict"] == "ok" and v["Tridacna gigas"]["verdict"] == "ok")
    check("synonym → accepted name", v["Acropora formosa"]["verdict"] == "synonym" and v["Acropora formosa"]["accepted"] == "Acropora muricata", json.dumps(v["Acropora formosa"]))
    check("misspelling flagged", v["Chelonia mydass"]["verdict"] == "check spelling" and v["Chelonia mydass"]["accepted"] == "Chelonia mydas")
    check("homonym flagged as ambiguous", v["Acropora"]["verdict"] == "ambiguous", json.dumps(v["Acropora"]))
    check("not in WoRMS", v["Ornithoptera priamus"]["verdict"] == "not in WoRMS")
    check("one request for the distinct names", len(asked) == 1 and len(asked[0]) == 6, f"{len(asked)} request(s), {len(asked[0]) if asked else 0} names")
    s, tb = call("POST", f"api/layers/{o['layer']}/table", {"limit": 20})
    rows = [dict(zip(tb["fields"], x["values"])) for x in tb["rows"]]
    check("every feature kept, its own name unchanged", len(rows) == len(names) and sorted(x["species"] for x in rows) == sorted(names))
    check("the blank name says so", any(x["species"] == "" and x["worms_verdict"] == "no name" for x in rows))
    r = run("names2", "taxa.worms", {"layer": "reef.geojson", "base": WORMS, "within": "Cnidaria, Chordata, Mollusca"})
    v = {e["name"]: e for e in (r["steps"][0]["outputs"] or {}).get("table", [])}
    check("within Cnidaria settles the homonym", v["Acropora"]["verdict"] == "ok" and v["Acropora"]["accepted"] == "Acropora", json.dumps(v["Acropora"]))
    check("a second run asks WoRMS nothing (answers kept 30 days)", len(asked) == 1 and r["steps"][0]["outputs"]["asked_worms"] == 0)
finally:
    srv.terminate()
    srv.wait()
    wsrv.shutdown()
    if not failed:
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("kept", tmp)

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
