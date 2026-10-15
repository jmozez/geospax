#!/usr/bin/env python3
"""LiDAR checks (docs/AUTOMATION.md `lidar.grid`, docs/RESULTS.md §18).

1. Synthetic scenes with known truth (scripts/data-sample-lidar.py), classified and
   unclassified, through the lidar-to-terrain recipe on the command line: terrain error against
   the true ground, tree tops found and their heights, buildings and their roof heights, noise
   handling, contours, maps and report.
2. Real files, downloaded once into --cache: laspy's simple.laz (LAZ without a coordinate
   system: must ask for epsg:), PDAL's autzen_trim.las (Oregon Lambert in feet, gridded in UTM
   with heights in metres) and autzen-classified.laz (LAS 1.4 point format 7, 10.7 million
   points: speed). Skipped with --offline.
3. The drop folder: a point cloud dropped into --inbox starts lidar-to-terrain by itself, and
   the Devices pane lists a lidar device with its point clouds.
4. The 3D scene of every full run (docs/AUTOMATION.md `scene.3d`, docs/RESULTS.md §19): the
   glTF binary (container, meshes, georeference, the Khronos glTF-Validator when installed:
   --validator, else next to Playwright), the still picture, the self-contained viewer in Chromium (scripts/
   test-web-scene.mjs, when Playwright is installed) and the report's 3D section.

  python3 scripts/test-lidar.py --bin target/release/geospax-server --out bench/screenshots \\
      [--cache /var/tmp/geospax-lidar] [--port 8160] [--offline | --quick] [--results bench/lidar-results.json] \\
      [--pw /opt/pw/node_modules/playwright] [--validator /opt/pw/node_modules/gltf-validator]
"""
import argparse
import importlib.util
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SAMPLES = {
    "simple.laz": "https://github.com/laspy/laspy/raw/master/tests/data/simple.laz",
    "autzen_trim.las": "https://github.com/PDAL/PDAL/raw/master/test/data/las/autzen_trim.las",
    "autzen-classified.laz": "https://github.com/PDAL/data/raw/main/autzen/autzen-classified.laz",
}
GRID_ONLY = """recipe: lidar-grid-only
version: 1
title: LiDAR grid only (test)
inputs:
  source: { type: device, default: auto }
  epsg: { type: number, default: auto }
steps:
  - id: lidar
    use: lidar.grid
    with: { source: "${inputs.source}", epsg: "${inputs.epsg}" }
"""

fails = []


def check(ok, msg):
    print(("  ok    " if ok else "  FAIL  ") + msg, flush=True)
    if not ok:
        fails.append(msg)
    return ok


def load_sample_module():
    spec = importlib.util.spec_from_file_location("lidar_sample", os.path.join(HERE, "data-sample-lidar.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def step_out(run, sid):
    for s in run.get("steps", []):
        if s["id"] == sid:
            return s.get("outputs") or {}
    return {}


def step_why(run, sid):
    for s in run.get("steps", []):
        if s["id"] == sid:
            return s.get("why") or []
    return []


def run_cli(a, state, recipe, inputs):
    cmd = [a.bin, "run", recipe, "--state-dir", state, "--json"]
    for k, v in inputs.items():
        cmd += ["--input", f"{k}={v}"]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    wall = time.time() - t0
    try:
        return json.loads(p.stdout), wall
    except json.JSONDecodeError:
        return {"status": "no-json", "error": (p.stderr or p.stdout)[-800:], "steps": [], "artifacts": []}, wall


def xyz(path):
    """(x, y, z) of every cell with data."""
    p = subprocess.run(["gdal_translate", "-q", "-of", "XYZ", path, "/vsistdout/"], capture_output=True, text=True, check=True)
    for line in p.stdout.splitlines():
        x, y, z = map(float, line.split())
        if z > -9000:
            yield x, y, z


def features(gpkg):
    p = subprocess.run(["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", gpkg], capture_output=True, text=True, check=True)
    return json.loads(p.stdout)["features"]


def to_utm(pts, epsg):
    if not pts:
        return []
    inp = "\n".join(f"{lon} {lat}" for lon, lat in pts) + "\n"
    p = subprocess.run(["gdaltransform", "-s_srs", "EPSG:4326", "-t_srs", f"EPSG:{epsg}"], input=inp, capture_output=True, text=True, check=True)
    return [tuple(map(float, line.split()[:2])) for line in p.stdout.strip().splitlines()]


def http(method, url, body=None, timeout=10):
    req = urllib.request.Request(url, data=body, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception:
        return 0, b""


def wait_for(fn, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return v, time.time() - t0
        time.sleep(0.3)
    return None, time.time() - t0


def glb_parts(path):
    """(JSON document, BIN chunk) of a glTF binary, checking the container."""
    b = open(path, "rb").read()
    magic, ver, total = struct.unpack_from("<4sII", b, 0)
    jl, jt = struct.unpack_from("<I4s", b, 12)
    doc = json.loads(b[20:20 + jl])
    bl, bt = struct.unpack_from("<I4s", b, 20 + jl)
    ok = magic == b"glTF" and ver == 2 and total == len(b) and jt == b"JSON" and bt == b"BIN\0" and doc["buffers"][0]["byteLength"] == bl
    return doc, b[28 + jl:28 + jl + bl], ok


def scene_checks(a, run, label, buildings, trees, points_colour=None, shot=None):
    """The 3D scene of a lidar-to-terrain run: GLB (container, meshes, georeference, Khronos
    validator), the still picture, the offline viewer (Playwright), and the report section."""
    so = step_out(run, "scene")
    files = {f.rsplit(".", 1)[-1]: os.path.join(run["dir"], f) for f in so.get("files", [])}
    if not check(run["status"] == "done" and all(os.path.exists(files.get(k, "")) for k in ("glb", "html", "png")),
                 f"{label}: 3D scene written (scene.glb, scene.html, scene.png) in {so.get('seconds')} s"):
        return {}
    check(so.get("buildings") == buildings and so.get("trees") == trees and so.get("points", 0) > 50_000,
          f"{label}: {so.get('buildings')}/{buildings} buildings extruded, {so.get('trees')}/{trees} trees modelled, {so.get('points')} points, {so.get('triangles')} triangles")
    doc, binc, ok = glb_parts(files["glb"])
    names = [m["name"] for m in doc["meshes"]]
    geo = doc["asset"].get("extras", {}).get("geospax", {})
    check(ok and names == ["Terrain", "Terrain sides", "Buildings", "Trees", "Point cloud"] and "KHR_materials_unlit" in doc.get("extensionsUsed", []),
          f"{label}: GLB container valid; meshes {', '.join(names)}")
    check(geo.get("crs_epsg") in (32755, 32610) and len(geo.get("origin", [])) == 3 and -180 <= geo.get("origin_lonlat", [999])[0] <= 180,
          f"{label}: georeferenced: EPSG:{geo.get('crs_epsg')}, origin {[round(v) for v in geo.get('origin', [])]}, ×{geo.get('vertical_exaggeration')} terrain")
    if os.path.exists(a.validator):
        p = subprocess.run(["node", os.path.join(HERE, "validate-gltf.mjs"), files["glb"]], capture_output=True, text=True, env={**os.environ, "GLTF_VALIDATOR": a.validator})
        v = json.loads(p.stdout.splitlines()[0]) if p.stdout.strip() else {}
        check(p.returncode == 0 and v.get("errors") == 0 and v.get("warnings") == 0, f"{label}: Khronos glTF-Validator: {v.get('errors')} errors, {v.get('warnings')} warnings ({v.get('triangles')} triangles, {v.get('drawCalls')} draw calls)")
    from PIL import Image
    im = Image.open(files["png"]).convert("RGB")
    px = im.load()
    w, h = im.size
    model = sum(1 for y in range(0, h, 4) for x in range(0, w, 4) if not (px[x, y][2] > px[x, y][0] + 12 and px[x, y][2] > 200)) / ((w // 4) * (h // 4))
    check((w, h) == (1600, 1000) and 0.3 < model < 0.95, f"{label}: scene.png {w}×{h}, the model fills {model * 100:.0f} % (sky behind)")
    html = open(files["html"], encoding="utf-8").read()
    check(len(html) > os.path.getsize(files["glb"]) * 1.3 and "<script src" not in html and "http://" not in html and "https://" not in html,
          f"{label}: scene.html is self-contained ({len(html) / 1e6:.1f} MB, the model inside, no links out)")
    rep = os.path.join(run["dir"], "report.html")
    text = open(rep, encoding="utf-8").read() if os.path.exists(rep) else ""
    check("3D view" in text and 'href="scene.html"' in text and "data:image/jpeg;base64," in text and "3D scene:" in text,
          f"{label}: the report shows the 3D view, links the viewer and the model, and explains the scene")
    if points_colour:
        check(points_colour in " ".join(step_why(run, "scene")), f"{label}: points coloured by {points_colour}")
    r = {k: so.get(k) for k in ("exaggeration", "mesh", "texture", "triangles", "buildings", "trees", "points", "glb_bytes", "html_bytes", "seconds")}
    if os.path.exists(a.pw):
        out = a.out or os.path.join(os.path.dirname(rep), "shots")
        name = f"scene-{label.replace(' ', '-').replace('.', '-')}"
        p = subprocess.run(["node", os.path.join(HERE, "test-web-scene.mjs"), out, f"{name}={files['html']}"], capture_output=True, text=True, env={**os.environ, "PW": a.pw}, timeout=300)
        res = next((json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")), {})
        fails = [c for c in res.get("checks", []) if c.startswith("FAIL")]
        check(p.returncode == 0 and res.get("checks") and not fails,
              f"{label}: viewer in Chromium: ready in {res.get('load_s')} s, turn/zoom/pan/compass/reset and layer switches work, offline{(' — ' + '; '.join(fails)) if fails else ''}{p.stderr[-300:] if p.returncode and not res else ''}")
        r["viewer_load_s"] = res.get("load_s")
        if shot and a.out:
            for suffix, dest in (("", shot[0]), ("-points", shot[1])):
                src = os.path.join(out, f"{name}{suffix}.png")
                if os.path.exists(src):
                    shutil.copy(src, os.path.join(a.out, dest))
            if len(shot) > 2:
                shutil.copy(files["png"], os.path.join(a.out, shot[2]))
            for suffix in ("", "-points"):
                src = os.path.join(out, f"{name}{suffix}.png")
                if os.path.exists(src):
                    os.remove(src)
    return r


def synthetic(a, tmp, results, M):
    print("synthetic scenes (known truth)")
    out = {}
    for variant in ("classified", "unclassified"):
        las = os.path.join(tmp, f"scene-{variant}.las")
        subprocess.run([sys.executable, os.path.join(HERE, "data-sample-lidar.py"), las] + (["--classified"] if variant == "classified" else []), check=True, capture_output=True)
        truth = json.load(open(las[:-4] + ".truth.json"))
        state = os.path.join(tmp, f"state-{variant}")
        run, wall = run_cli(a, state, "lidar-to-terrain", {"source": las})
        ok = check(run["status"] == "done", f"{variant}: lidar-to-terrain {run['status']} in {run.get('elapsed_ms', 0) / 1000:.1f} s ({wall:.1f} s with process start) {run.get('error') or ''}")
        if not ok:
            continue
        lo = step_out(run, "lidar")
        outs = os.path.join(state, "outputs", "lidar-to-terrain")
        r = {"points": lo.get("points"), "resolution": lo.get("resolution"), "ground": lo.get("ground"), "lidar_s": lo.get("seconds"), "recipe_s": round(run["elapsed_ms"] / 1000, 2)}
        check(lo.get("ground") == ("classes" if variant == "classified" else "smrf"), f"{variant}: ground from {lo.get('ground')}")
        check(lo.get("epsg") == 32755 and lo.get("resolution") == 0.5, f"{variant}: gridded in EPSG:{lo.get('epsg')} at {lo.get('resolution')} m for {lo.get('density')} points/m²")
        # noise: classified noise classes are left out; unclassified birds must not become trees
        if variant == "classified":
            check(lo.get("points_read", 0) - lo.get("points", 0) == 50, f"classified: {lo.get('points_read', 0) - lo.get('points', 0)} noise points (classes 7, 18) left out")
        else:
            check(lo.get("points_read") == lo.get("points") and lo.get("chm_p95", 99) < 26 and lo.get("tallest_tree", 99) < 26,
                  f"unclassified: 25 birds 40-80 m up removed from the surface (canopy p95 {lo.get('chm_p95')} m, tallest {lo.get('tallest_tree')} m)")

        # terrain error against the true ground (cells inside the scene)
        x0, y0 = truth["origin"]
        errs, under = [], []
        for x, y, z in xyz(os.path.join(outs, "dtm.tif")):
            lx, ly = x - x0, y - y0
            if not (0.5 <= lx <= truth["size"][0] - 0.5 and 0.5 <= ly <= truth["size"][1] - 0.5):
                continue
            e = z - float(M.ground(lx, ly))
            errs.append(e)
            if any(b["x"] <= lx < b["x"] + b["w"] and b["y"] <= ly < b["y"] + b["h"] for b in truth["buildings"]):
                under.append(e)
        rmse = math.sqrt(sum(e * e for e in errs) / len(errs))
        p95 = sorted(abs(e) for e in errs)[int(0.95 * (len(errs) - 1))]
        rmse_b = math.sqrt(sum(e * e for e in under) / max(1, len(under)))
        lim = 0.10 if variant == "classified" else 0.20
        check(rmse < lim and rmse_b < 0.5, f"{variant}: terrain RMSE {rmse * 100:.1f} cm (95 % within {p95 * 100:.1f} cm) over {len(errs)} cells; {rmse_b * 100:.1f} cm under the buildings")
        r.update({"dtm_rmse_cm": round(rmse * 100, 1), "dtm_p95_cm": round(p95 * 100, 1), "dtm_rmse_under_buildings_cm": round(rmse_b * 100, 1)})

        # tree tops against the true trees
        feats = features(os.path.join(outs, "trees.gpkg"))
        det = to_utm([f["geometry"]["coordinates"][:2] for f in feats], 32755)
        dets = [(x - x0, y - y0, f["properties"]["height_m"]) for (x, y), f in zip(det, feats)]
        used, herr, matched = set(), [], 0
        for t in truth["trees"]:
            best = min(((math.hypot(d[0] - t["x"], d[1] - t["y"]), k) for k, d in enumerate(dets) if k not in used), default=(99, None))
            if best[0] <= 1.5:
                used.add(best[1])
                matched += 1
                herr.append(dets[best[1]][2] - t["h"])
        fp = len(dets) - len(used)
        mae = sum(abs(e) for e in herr) / max(1, len(herr))
        need = 0.95 if variant == "classified" else 0.9
        check(matched >= need * len(truth["trees"]) and fp <= 2, f"{variant}: {matched} of {len(truth['trees'])} trees found within 1.5 m, {fp} false tree tops")
        check(mae < (0.5 if variant == "classified" else 0.8) and max(abs(e) for e in herr) < 1.5, f"{variant}: tree heights off by {mae:.2f} m on average (worst {max(abs(e) for e in herr):.2f} m)")
        r.update({"trees_true": len(truth["trees"]), "trees_found": matched, "trees_false": fp, "tree_height_mae_m": round(mae, 2)})

        # buildings: count, footprint area, roof height (90th percentile of the roof)
        feats = features(os.path.join(outs, "buildings.gpkg"))
        cents = []
        for f in feats:
            ring = f["geometry"]["coordinates"][0] if f["geometry"]["type"] == "Polygon" else f["geometry"]["coordinates"][0][0]
            cents.append((sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)))
        cu = to_utm(cents, 32755)
        good = 0
        notes = []
        for b in truth["buildings"]:
            cx, cy = b["x"] + b["w"] / 2 + x0, b["y"] + b["h"] / 2 + y0
            k = min(range(len(cu)), key=lambda i: math.hypot(cu[i][0] - cx, cu[i][1] - cy), default=None)
            if k is None or math.hypot(cu[k][0] - cx, cu[k][1] - cy) > 4:
                notes.append(f"{b['name']} missing")
                continue
            pr = feats[k]["properties"]
            want_h = b["eaves"] + 0.9 * (b["ridge"] - b["eaves"])
            ok_b = abs(pr["area_m2"] - b["area"]) <= 0.15 * b["area"] and abs(pr["height_m"] - want_h) <= 0.6
            good += ok_b
            notes.append(f"{b['name']} {pr['area_m2']:.0f}/{b['area']:.0f} m² {pr['height_m']:.1f}/{want_h:.1f} m")
        check(len(feats) == 3 and good == 3, f"{variant}: {len(feats)} buildings ({'; '.join(notes)})")
        r["buildings"] = notes

        # contours stay clean on a 50 cm DTM; maps and report
        cl = step_out(run, "contours")
        check(0 < cl.get("lines", 0) < 80, f"{variant}: {cl.get('lines')} contour lines every {cl.get('interval')} m (traced on a 2 m average)")
        arts = [os.path.join(run["dir"], x) for x in run.get("artifacts", [])]
        has = lambda name: any(x.endswith(name) for x in arts)
        check(has("terrain.png") and has("canopy.png") and has("canopy.pdf") and has("report.html"), f"{variant}: terrain and canopy maps (PNG, SVG, PDF) and the report")
        rep = next((x for x in arts if x.endswith("report.html")), None)
        text = open(rep, encoding="utf-8").read() if rep and os.path.exists(rep) else ""
        check("Canopy cover" in text and "Trees" in text and ("SMRF" in text) == (variant == "unclassified"), f"{variant}: report explains the canopy, trees and how ground was found")
        r["scene"] = scene_checks(a, run, variant, lo.get("building_count"), lo.get("tree_count"), "their classes" if variant == "classified" else "elevation")
        if variant == "unclassified" and a.out:
            for name, shot in (("terrain.png", "43-lidar-terrain.png"), ("canopy.png", "44-lidar-canopy.png")):
                src = next((x for x in arts if x.endswith(name)), None)
                if src and os.path.exists(src):
                    shutil.copy(src, os.path.join(a.out, shot))
        out[variant] = r
    results["synthetic"] = out


def real(a, tmp, results):
    print("real point clouds")
    os.makedirs(a.cache, exist_ok=True)
    for name, url in SAMPLES.items():
        if a.quick and name == "autzen-classified.laz":
            continue
        dest = os.path.join(a.cache, name)
        if not os.path.exists(dest):
            try:
                urllib.request.urlretrieve(url, dest + ".part")
                os.replace(dest + ".part", dest)
            except Exception as e:
                check(False, f"download {name}: {e}")
                return
    grid_only = os.path.join(tmp, "lidar-grid-only.yaml")
    open(grid_only, "w").write(GRID_ONLY)
    out = {}
    # 1. LAZ without a coordinate system
    simple = os.path.join(a.cache, "simple.laz")
    run, _ = run_cli(a, os.path.join(tmp, "state-simple"), grid_only, {"source": simple})
    check(run["status"] == "failed" and "epsg" in (run.get("error") or ""), f"simple.laz (no coordinate system): asks for epsg: — \"{(run.get('error') or '')[:110]}…\"")
    run, _ = run_cli(a, os.path.join(tmp, "state-simple2"), grid_only, {"source": simple, "epsg": "2994"})
    lo = step_out(run, "lidar")
    check(run["status"] == "done" and lo.get("points") == 1065 and lo.get("epsg") == 32610, f"simple.laz with epsg=2994: {lo.get('points')} points decoded (LAZ), gridded in EPSG:{lo.get('epsg')} at {lo.get('resolution')} m")
    # 2. feet-based coordinates through the whole recipe
    trim = os.path.join(a.cache, "autzen_trim.las")
    run, wall = run_cli(a, os.path.join(tmp, "state-trim"), "lidar-to-terrain", {"source": trim})
    lo = step_out(run, "lidar")
    why = " ".join(step_why(run, "lidar"))
    check(run["status"] == "done", f"autzen_trim.las: lidar-to-terrain {run['status']} in {run.get('elapsed_ms', 0) / 1000:.1f} s {run.get('error') or ''}")
    check(lo.get("epsg") == 32610 and ("feet" in why.lower() or "foot" in why.lower()), f"autzen_trim.las: Oregon Lambert (feet) gridded in UTM 10N (EPSG:{lo.get('epsg')})")
    check(100 < lo.get("ground_min", 0) < lo.get("ground_max", 0) < 200, f"autzen_trim.las: ground {lo.get('ground_min')}-{lo.get('ground_max')} m (heights converted from feet; Eugene, Oregon lies at about 130 m)")
    out["autzen_trim"] = {k: lo.get(k) for k in ("points", "density", "resolution", "ground", "tree_count", "building_count", "ground_min", "ground_max", "seconds")}
    # 3. 10.7 million LAZ points (LAS 1.4, point format 7)
    if a.quick:
        print("  skip  autzen-classified.laz (--quick)")
        results["real"] = out
        return
    big = os.path.join(a.cache, "autzen-classified.laz")
    run, wall = run_cli(a, os.path.join(tmp, "state-big"), "lidar-to-terrain", {"source": big})
    lo = step_out(run, "lidar")
    why = step_why(run, "lidar")
    check(run["status"] == "done" and lo.get("points", 0) > 10_000_000, f"autzen-classified.laz: {lo.get('points', 0) / 1e6:.1f} M points, lidar-to-terrain {run['status']} in {run.get('elapsed_ms', 0) / 1000:.1f} s {run.get('error') or ''}")
    if run["status"] == "done":
        rate = next((w for w in why if w.startswith("read in")), "")
        check(lo.get("ground") == "classes" and lo.get("building_count", 0) >= 5 and lo.get("tree_count", 0) >= 100,
              f"autzen-classified.laz: ground from {lo.get('ground')}, {lo.get('building_count')} buildings, {lo.get('tree_count')} trees (tallest {lo.get('tallest_tree')} m), {rate}")
        out["autzen_classified"] = {k: lo.get(k) for k in ("points", "density", "resolution", "size", "ground", "tree_count", "tallest_tree", "building_count", "canopy_cover", "seconds")}
        out["autzen_classified"]["recipe_s"] = round(run["elapsed_ms"] / 1000, 2)
        out["autzen_classified"]["read"] = rate
        out["autzen_classified"]["scene"] = scene_checks(a, run, "autzen", lo.get("building_count"), lo.get("tree_count"), "the colours stored in the file",
                                                         shot=("48-scene-viewer.png", "49-scene-points.png", "50-scene-still.png"))
    results["real"] = out


def inbox(a, tmp, results):
    print("drop folder")
    box = os.path.join(tmp, "inbox")
    os.makedirs(box)
    state = os.path.join(tmp, "state-inbox")
    url = f"http://127.0.0.1:{a.port}"
    log = open(os.path.join(tmp, "server.log"), "w")
    srv = subprocess.Popen([a.bin, "--state-dir", state, "--host", "127.0.0.1", "--port", str(a.port), "--web", os.path.join(ROOT, "web", "dist"), "--inbox", box], stdout=log, stderr=subprocess.STDOUT)
    try:
        up, _ = wait_for(lambda: http("GET", f"{url}/api/health")[0] == 200 if srv.poll() is None else None, 30)
        if not check(bool(up), "server with a drop folder up"):
            return
        src = os.path.join(tmp, "scene-unclassified.las")
        staged = os.path.join(tmp, "drive", "survey-2026-10")
        os.makedirs(staged)
        shutil.copy(src, os.path.join(staged, "block-a.las"))
        t0 = time.time()
        os.rename(staged, os.path.join(box, "survey-2026-10"))

        def done_run():
            rs = json.loads(http("GET", f"{url}/api/runs")[1])["runs"]
            return next((r for r in rs if r["recipe"] == "lidar-to-terrain" and r["status"] in ("done", "failed")), None)

        run, _ = wait_for(done_run, 90)
        took = time.time() - t0
        ok = check(bool(run) and run["status"] == "done", f"dropping a folder with a LAS file started lidar-to-terrain by itself: {run['status'] if run else 'no run'} {took:.1f} s after the drop")
        if ok:
            tr = run.get("trigger", {})
            check(tr.get("kind") == "device" and tr.get("device_kind") == "lidar", f"trigger: {tr.get('kind')} · {tr.get('device_kind')} · {tr.get('device')}")
        devs = json.loads(http("GET", f"{url}/api/devices")[1]).get("devices", [])
        d = next((d for d in devs if d.get("point_clouds")), None)
        check(bool(d) and d["kind"] == "lidar" and d["point_clouds"] == 1 and d.get("cloud_points", 0) > 700_000 and d.get("bounds"),
              f"Devices pane: {d['kind'] if d else '-'} device with {d.get('point_clouds') if d else 0} point cloud ({(d or {}).get('cloud_points')} points) and its footprint")
        results["inbox"] = {"drop_to_done_s": round(took, 1)}
    finally:
        srv.terminate()
        try:
            srv.wait(10)
        except subprocess.TimeoutExpired:
            srv.kill()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", default=os.path.join(ROOT, "target", "release", "geospax-server"))
    ap.add_argument("--out", default=os.path.join(ROOT, "bench", "screenshots"))
    ap.add_argument("--cache", default="/var/tmp/geospax-lidar")
    ap.add_argument("--port", type=int, default=8160)
    ap.add_argument("--offline", action="store_true", help="skip the downloaded real-world files")
    ap.add_argument("--quick", action="store_true", help="skip the 74 MB / 10.7 million point file (CI)")
    ap.add_argument("--results", default=os.path.join(ROOT, "bench", "lidar-results.json"))
    ap.add_argument("--pw", default=os.environ.get("PW", "/opt/pw/node_modules/playwright"), help="Playwright, for the 3D viewer check (skipped when missing)")
    ap.add_argument("--validator", default=None, help="npm gltf-validator folder (default: $GLTF_VALIDATOR, else next to Playwright; skipped when missing)")
    a = ap.parse_args()
    a.bin = os.path.abspath(a.bin)
    a.validator = a.validator or os.environ.get("GLTF_VALIDATOR") or os.path.join(os.path.dirname(a.pw), "gltf-validator")
    M = load_sample_module()
    results = {}
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="gx-lidar-", dir="/var/tmp") as tmp:
        synthetic(a, tmp, results, M)
        if a.offline:
            print("real point clouds: skipped (--offline)")
        else:
            real(a, tmp, results)
        inbox(a, tmp, results)
    results["seconds"] = round(time.time() - t0, 1)
    if a.results:
        os.makedirs(os.path.dirname(a.results), exist_ok=True)
        json.dump(results, open(a.results, "w"), indent=1)
    print(f"\n{'PASS' if not fails else 'FAIL'}: lidar checks in {results['seconds']} s" + (f" — {len(fails)} failed:\n  " + "\n  ".join(fails) if fails else ""))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
