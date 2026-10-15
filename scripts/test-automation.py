#!/usr/bin/env python3
"""Automation engine end-to-end test (docs/AUTOMATION.md). Stdlib only.

    python3 scripts/test-automation.py [--bin target/release/geospax-server] [--data DIR]
                                       [--samples /tmp/geospax-devices] [--out bench/screenshots] [--port 8098]

1. check: every gallery recipe validates; a broken recipe is rejected with every problem listed.
2. run:   every gallery recipe runs from the command line against the sample devices and data
          (r-kriging only when R with sf + gstat is installed); the files are checked
          (PNG size, SVG legend, report sections, KML, GeoJSON).
3. triggers on a live server: a phone "plugged in" (its folder appears) runs photos-to-map, a file
          dropped in a folder runs a folder-triggered recipe, a 3 s schedule fires repeatedly and an
          after: recipe follows it.
4. API:   run + poll + artifact download; saving a recipe with code needs ?approve=code.

Prints a timing table (bench/RESULTS.md §11) and writes OUT/automation-results.json.
Needs sample devices (scripts/data-sample-devices.py); field samples are generated in a temp dir.
"""
import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

FAILS = []


def check(cond, msg):
    print(("  ok    " if cond else "  FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)
    return cond


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def png_size_bytes(b):
    if b[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", b[16:24])


def check_artifacts(run, label):
    d = run["dir"]
    for name in run.get("artifacts", []):
        p = os.path.join(d, name)
        if not check(os.path.isfile(p), f"{label}: {name} exists"):
            continue
        if name.endswith(".png"):
            s = png_size(p)
            check(s is not None and s[0] >= 1000 and s[1] >= 700, f"{label}: {name} is a PNG page ({s[0]}x{s[1]})" if s else f"{label}: {name} is a PNG")
        elif name.endswith(".svg"):
            t = open(p, encoding="utf-8").read()
            check(t.startswith("<svg") and "Legend" in t and "Scale" in t, f"{label}: {name} has a legend and a scale ({len(t) // 1024} KB)")
        elif name.endswith(".html") and os.path.basename(name).startswith("scene"):
            t = open(p, encoding="utf-8").read()
            check("geospaxScene" in t and 'id="glb"' in t and "https://" not in t, f"{label}: {name} is the offline 3D viewer with the model inside ({len(t) // 1024} KB)")
        elif name.endswith(".html"):
            t = open(p, encoding="utf-8").read()
            check(all(s in t for s in ("How this map was made", "Automatic decisions", "Run log", "Provenance")), f"{label}: {name} has all report sections")
        elif name.endswith(".glb"):
            head = open(p, "rb").read(12)
            check(head[:4] == b"glTF" and int.from_bytes(head[4:8], "little") == 2 and int.from_bytes(head[8:12], "little") == os.path.getsize(p), f"{label}: {name} is glTF 2.0 ({os.path.getsize(p) // 1024} KB)")
        elif name.endswith(".pdf"):
            head = open(p, "rb").read(8)
            check(head.startswith(b"%PDF-"), f"{label}: {name} is a PDF ({os.path.getsize(p) // 1024} KB)")
        elif name.endswith(".kml"):
            check("<kml" in open(p, encoding="utf-8").read(), f"{label}: {name} is KML")
        elif name.endswith(".geojson"):
            fc = json.load(open(p, encoding="utf-8"))
            check(fc.get("type") == "FeatureCollection" and fc["features"], f"{label}: {name} is GeoJSON with {len(fc['features'])} features")


def online():
    """Raster recipes read the Copernicus DEM and Sentinel-2 over HTTP (GEOSPAX_OFFLINE=1 skips them)."""
    if os.environ.get("GEOSPAX_OFFLINE") == "1":
        return False
    import urllib.request
    try:
        urllib.request.urlopen("https://earth-search.aws.element84.com/v1/", timeout=8).read(64)
        return True
    except Exception:
        return False


def step_out(run, sid):
    for s in run.get("steps", []):
        if s["id"] == sid:
            return s.get("outputs") or {}
    return {}


def http(method, url, body=None, ctype="application/json"):
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": ctype} if data is not None else {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read()
    except (urllib.error.URLError, OSError):
        return 0, "", b""  # not listening (yet)


def jget(url):
    return json.loads(http("GET", url)[2])


def wait_for(fn, timeout, step=0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v, time.time() - t0
        time.sleep(step)
    return None, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default="target/release/geospax-server")
    ap.add_argument("--data", default="data")
    ap.add_argument("--samples", default="/tmp/geospax-devices")
    ap.add_argument("--out", default="bench/screenshots")
    ap.add_argument("--port", type=int, default=8098)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="geospax-automation-")
    field = os.path.join(tmp, "fielddata")
    subprocess.run([sys.executable, "scripts/data-sample-field.py", field], check=True, stdout=subprocess.DEVNULL)
    if not os.path.exists(os.path.join(a.data, "incidents.geojson")):
        subprocess.run([sys.executable, "scripts/data-sample-incidents.py", field], check=True, stdout=subprocess.DEVNULL)
    results = {"cli": {}, "triggers": {}}
    base_args = ["--data", a.data, "--data", field, "--no-device-mounts"]

    # ---------------------------------------------------------------- 1. check
    print("== check (validation)")
    listing = subprocess.run([a.bin, "recipes"], capture_output=True, text=True).stdout
    gallery = [l.split()[0] for l in listing.splitlines() if " gallery " in l]
    check(len(gallery) >= 15, f"{len(gallery)} gallery recipes: {', '.join(gallery)}")
    for rid in gallery:
        p = subprocess.run([a.bin, "check", rid], capture_output=True, text=True)
        check(p.returncode == 0, f"check {rid}")
    broken = os.path.join(tmp, "broken.yaml")
    with open(broken, "w") as f:
        f.write("recipe: broken\nsteps:\n  - id: a\n    use: export.mapp\n  - id: b\n    use: vector.buffer\n    with: { layer: \"${c.layer}\" }\n  - id: c\n    use: automap.style\n    with: { layers: \"${b.layer}\" }\n  - id: d\n    use: export.report\n    with: { title: \"${nowhere.x}\" }\n")
    p = subprocess.run([a.bin, "check", broken], capture_output=True, text=True)
    check(p.returncode == 1, "broken recipe rejected (exit 1)")
    for needle in ("did you mean 'export.map'", "needs 'distance'", "circle", "'nowhere'"):
        check(needle in p.stdout, f"broken recipe reports: {needle}")

    # ---------------------------------------------------------------- 2. run
    print("== run (command line)")
    have_r = subprocess.run(["Rscript", "-e", "library(sf); library(gstat)"], capture_output=True).returncode == 0 if shutil.which("Rscript") else False
    runs = [
        ("photos-to-map", [f"source={a.samples}/TEST-PHONE"]),
        ("track-to-map", [f"source={a.samples}/GARMIN"]),
        ("drone-flight-report", [f"source={a.samples}/DJI-SD"]),
        ("sensor-log-to-map", [f"source={a.samples}/AQ-LOGGER"]),
        ("points-to-hexbins", []),
        ("interpolate-samples", []),
        ("points-to-hotspots", []),
        ("python-spatial-stats", []),
    ]
    if have_r:
        runs.append(("r-kriging", []))
    else:
        print("  skip  r-kriging (needs R with sf and gstat)")
    net = online()
    if net:
        runs += [("terrain-report", []), ("latest-ndvi", [])]
        for rid, tool in (("landforms-grass", "grass"), ("wetness-saga", "saga_cmd")):
            if shutil.which(tool):
                runs.append((rid, []))
            else:
                print(f"  skip  {rid} (needs {tool})")
    else:
        print("  skip  terrain-report, latest-ndvi, landforms-grass, wetness-saga (offline)")
    state = os.path.join(tmp, "state-cli")
    for rid, inputs in runs:
        cmd = [a.bin, "run", rid, "--state-dir", state, "--json", *base_args]
        for kv in inputs:
            cmd += ["--input", kv]
        t0 = time.time()
        p = subprocess.run(cmd, capture_output=True, text=True)
        wall = time.time() - t0
        try:
            run = json.loads(p.stdout)
        except json.JSONDecodeError:
            check(False, f"run {rid}: JSON output ({p.stderr[-400:]})")
            continue
        ok = check(p.returncode == 0 and run["status"] == "done", f"run {rid}: {run['status']} in {run['elapsed_ms']:.0f} ms ({wall:.1f} s with process start) {run.get('error') or ''}")
        results["cli"][rid] = {"status": run["status"], "elapsed_ms": round(run["elapsed_ms"], 1), "wall_s": round(wall, 2),
                               "steps": {s["id"]: round(s["ms"], 1) for s in run["steps"]}, "why": {s["id"]: s["why"] for s in run["steps"]}}
        if ok:
            check_artifacts(run, rid)
        if ok and rid == "terrain-report":
            dem = step_out(run, "dem")
            check(dem.get("tiles", 0) >= 1 and 0 < dem.get("min", -1) < dem.get("max", 0), f"terrain: Copernicus DEM {dem.get('min', 0):.0f}-{dem.get('max', 0):.0f} m from {dem.get('tiles')} tile(s)")
            cls = step_out(run, "slope_classes").get("classes", [])
            check(len(cls) == 4 and abs(sum(c["percent"] for c in cls) - 100) < 0.5, f"terrain: 4 slope classes summing to {sum(c['percent'] for c in cls):.1f} %")
            check(step_out(run, "contours").get("lines", 0) > 10, f"terrain: {step_out(run, 'contours').get('lines')} contour lines every {step_out(run, 'contours').get('interval')} m")
            check(any(a.endswith(".pdf") for a in run["artifacts"]), "terrain: relief map also exported as PDF")
            check(step_out(run, "sample").get("correlation") is not None, f"terrain: sampled rasters at points, {step_out(run, 'sample').get('correlation')}")
        if ok and rid == "interpolate-samples":
            o = step_out(run, "surface")
            cv = o.get("cv") or {}
            check(o.get("method") in ("kriging", "idw") and bool(o.get("raster")) and (o.get("se") is not None) == bool(o.get("has_se")),
                  f"surface: {o.get('method')} ({(o.get('variogram') or {}).get('model')} variogram) chosen by cross-validation: RMSE {(cv.get('kriging') or {}).get('rmse', 0):.4f} vs IDW {(cv.get('idw') or {}).get('rmse', 0):.4f}")
            check(not o.get("has_se") or "uncertainty.png" in run["artifacts"], "surface: kriging also mapped its standard error")
        if ok and rid == "points-to-hotspots":
            o = step_out(run, "hot")
            check(o.get("hot", 0) > 0 and o.get("features", 0) >= 30 and o.get("moran", {}).get("z", 0) > 1.96,
                  f"hot spots: {o.get('hot')} hot / {o.get('cold')} cold of {o.get('features')} cells, band {o.get('distance_m', 0):.0f} m ({o.get('distance_rule')}), Moran's I z {o.get('moran', {}).get('z', 0):.1f}")
        if ok and rid == "latest-ndvi":
            nd = step_out(run, "ndvi")
            # guards against reflectance-offset bugs: real NDVI is not stuck near 1
            check(0.05 < nd.get("mean", 0) < 0.9 and nd.get("p98", 1) < 0.97, f"ndvi: mean {nd.get('mean', 0):.2f}, 98th pct {nd.get('p98', 0):.2f} on {nd.get('date')} ({nd.get('clear', 0) * 100:.0f} % clear)")
            check(nd.get("clear", 0) >= 0.7, "ndvi: the scene used is clear over the area")
            check(len(step_out(run, "classes").get("classes", [])) == 4, "ndvi: vegetation classes")
        if ok and rid == "sensor-log-to-map":
            imp, summ = step_out(run, "import"), step_out(run, "summary")
            check(imp.get("kind") == "sensor" and imp.get("readings") == 360, f"sensor log: {imp.get('readings')} readings from a {imp.get('kind')} device (1 row without a GPS fix skipped)")
            check(imp.get("reading_fields", [])[:3] == ["pm1", "pm2_5", "pm10"] and imp.get("units", {}).get("pm2_5") == "µg/m³", f"sensor log: fields {imp.get('reading_fields')} with units from the CSV header")
            pm = summ.get("fields", {}).get("pm2_5", {})
            check(summ.get("main") == "pm2_5" and 5 < pm.get("guideline", {}).get("above_pct", 0) < 60, f"sensor summary: maps PM2.5; {pm.get('guideline', {}).get('above_pct')} % of readings above the WHO 24-h guideline")
            style_why = " ".join(next(s["why"] for s in run["steps"] if s["id"] == "style"))
            check("WHO 2021" in style_why, "sensor map: PM2.5 classes anchored to the WHO guideline and interim targets")
            check(imp.get("tracks") == 1 and imp.get("track_km", 0) > 2, f"sensor log: the walk also became a {imp.get('track_km')} km track")
        if ok and rid == "landforms-grass":
            o = step_out(run, "landforms")
            check("GRASS" in o.get("version", ""), f"grass: {o.get('version')} in {o.get('seconds', 0):.1f} s")
        if ok and rid == "wetness-saga":
            o = step_out(run, "wetness")
            check("SAGA" in o.get("version", ""), f"saga: {o.get('version')} in {o.get('seconds', 0):.1f} s")
    # a sports watch with a FIT activity: track + per-second heart rate, cadence, temperature ...
    p = subprocess.run([a.bin, "run", "track-to-map", "--state-dir", state, "--json", *base_args, "--input", f"source={a.samples}/WATCH"], capture_output=True, text=True)
    try:
        run = json.loads(p.stdout)
        imp = step_out(run, "import")
        check(run["status"] == "done" and imp.get("readings") == 400 and "heart_rate" in imp.get("reading_fields", []) and imp.get("units", {}).get("heart_rate") == "bpm",
              f"watch FIT: {imp.get('readings')} readings ({', '.join(imp.get('reading_fields', []))}) + {imp.get('track_km')} km track in {run['elapsed_ms']:.0f} ms")
    except (json.JSONDecodeError, StopIteration, KeyError) as e:
        check(False, f"watch FIT run: {e} {p.stderr[-300:]}")
    hx = results["cli"].get("points-to-hexbins", {}).get("why", {}).get("hex", [""])[0]
    if hx:
        print(f"  info  hexbin: {hx}")
    for line in results["cli"].get("interpolate-samples", {}).get("why", {}).get("surface", [])[:2]:
        print(f"  info  surface: {line}")
    for line in results["cli"].get("points-to-hotspots", {}).get("why", {}).get("hot", [])[:3]:
        print(f"  info  hot spots: {line}")

    # ---------------------------------------------------------------- 3. triggers + 4. API
    print("== triggers (live server)")
    plug = os.path.join(tmp, "plug")
    drop = os.path.join(tmp, "drop")
    os.makedirs(plug)
    os.makedirs(drop)
    srv_state = os.path.join(tmp, "state-server")
    url = f"http://127.0.0.1:{a.port}"
    log = open(os.path.join(a.out, "test-automation-server.log"), "w")
    # MQTT broker for the live-sensor test (Debian: apt install mosquitto)
    broker, mqtt_port, mqtt_args = None, a.port + 10, []
    mosq = shutil.which("mosquitto") or ("/usr/sbin/mosquitto" if os.path.exists("/usr/sbin/mosquitto") else None)
    if mosq:
        broker = subprocess.Popen([mosq, "-p", str(mqtt_port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
        mqtt_args = ["--mqtt", f"mqtt://127.0.0.1:{mqtt_port}/#"]
    srv = subprocess.Popen([a.bin, *base_args, "--state-dir", srv_state, "--host", "127.0.0.1", "--port", str(a.port), "--web", "web/dist",
                            "--watch", os.path.join(plug, "PHONE"), "--watch", os.path.join(plug, "AQ"), "--auto", "photos-to-map,sensor-log-to-map", *mqtt_args], stdout=log, stderr=subprocess.STDOUT)
    try:
        up, _ = wait_for(lambda: http("GET", f"{url}/api/health")[0] == 200 if _alive(srv) else None, 30)
        if not check(bool(up), "server up"):
            raise SystemExit(1)

        def runs_of(rid, kind=None, status="done"):
            rs = jget(f"{url}/api/runs")["runs"]
            return [r for r in rs if r["recipe"] == rid and (kind is None or r["trigger"].get("kind") == kind) and r["status"] == status]

        # device trigger: the phone folder appears (= plugged in)
        t0 = time.time()
        shutil.copytree(os.path.join(a.samples, "TEST-PHONE"), os.path.join(plug, "PHONE"))
        r, _ = wait_for(lambda: runs_of("photos-to-map", "device"), 30)
        lat = time.time() - t0
        if check(bool(r), f"device trigger: phone plugged in -> photos-to-map done in {lat:.1f} s (poll every 5 s)"):
            results["triggers"]["device_s"] = round(lat, 1)
            check(r[0]["trigger"].get("device") == "PHONE", "device trigger: run knows which device")
        # ... and an air-quality logger: kind "sensor" with readings -> sensor-log-to-map
        t0 = time.time()
        shutil.copytree(os.path.join(a.samples, "AQ-LOGGER"), os.path.join(plug, "AQ"))
        r, _ = wait_for(lambda: runs_of("sensor-log-to-map", "device"), 30)
        if check(bool(r), f"device trigger: sensor logger plugged in -> sensor-log-to-map done in {time.time() - t0:.1f} s"):
            check(r[0]["trigger"].get("device_kind") == "sensor", "device trigger: logger recognised as a sensor device")
        dev = next((d for d in jget(f"{url}/api/devices")["devices"] if d["name"] == "AQ"), {})
        check(dev.get("readings") == 360 and "pm2_5" in (dev.get("reading_fields") or []), f"Devices pane: AQ logger with {dev.get('readings')} readings ({dev.get('reading_fields')})")

        # user recipes: folder trigger, schedule, after-chain
        sample = os.path.join(field, "field_samples.geojson")
        recipes = {
            "drop-samples": f"""recipe: drop-samples
title: New samples dropped -> surface
triggers:
  - folder: {{ path: {drop}, pattern: "*.geojson" }}
steps:
  - id: open
    use: io.open
    with: {{ path: "${{trigger.path}}/field_samples.geojson" }}
  - id: surface
    use: interpolate.idw
    with: {{ layer: "${{open.layer}}", name: surface }}
  - id: map
    use: export.svg
    with: {{ layers: ["${{surface.layer}}"], size: 900x650 }}
""",
            "tick": """recipe: tick
title: Every 3 s
triggers:
  - schedule: { every: 3s }
steps:
  - id: open
    use: io.open
    with: { layer: field_samples.geojson }
""",
            "after-tick": """recipe: after-tick
title: Follows tick
triggers:
  - after: tick
steps:
  - id: open
    use: io.open
    with: { layer: field_samples.geojson }
  - id: report
    use: export.report
""",
        }
        for rid, text in recipes.items():
            st, _, body = http("POST", f"{url}/api/recipes", text, "text/yaml")
            check(st == 201, f"save recipe {rid} (HTTP {st}) {body[:160] if st != 201 else ''}")
            st, _, _ = http("PUT", f"{url}/api/recipes/{rid}/auto", json.dumps({"enabled": True}))
            check(st == 200, f"auto on: {rid}")
        time.sleep(5)  # the folder watcher records what is already there
        t0 = time.time()
        shutil.copy(sample, drop)
        r, _ = wait_for(lambda: runs_of("drop-samples", "folder"), 40)
        lat = time.time() - t0
        if check(bool(r), f"folder trigger: file dropped -> drop-samples done in {lat:.1f} s (poll 4 s + settle)"):
            results["triggers"]["folder_s"] = round(lat, 1)
            check(any(a.endswith(".svg") for a in r[0]["artifacts"]), "folder trigger: produced a map")
        r, waited = wait_for(lambda: len(runs_of("tick", "schedule")) >= 2 and runs_of("tick", "schedule"), 20)
        check(bool(r), f"schedule trigger: tick ran {len(r or [])} times (every 3 s)")
        r, _ = wait_for(lambda: runs_of("after-tick", "after"), 20)
        check(bool(r), "after trigger: after-tick followed tick")
        for rid in ("tick", "after-tick", "drop-samples"):
            http("PUT", f"{url}/api/recipes/{rid}/auto", json.dumps({"enabled": False}))

        print("== API")
        t0 = time.time()
        st, _, body = http("POST", f"{url}/api/recipes/interpolate-samples/run", "{}")
        check(st == 202, f"POST run -> 202 (got {st})")
        run = json.loads(body)
        done, _ = wait_for(lambda: (lambda v: v if v["status"] in ("done", "failed") else None)(jget(f"{url}/api/runs/{run['id']}")), 60)
        check(bool(done) and done["status"] == "done", f"API run done in {time.time() - t0:.2f} s")
        st, ct, png = http("GET", f"{url}/api/runs/{run['id']}/files/map.png")
        check(st == 200 and ct == "image/png" and len(png) > 10_000, f"artifact download: map.png {len(png) // 1024} KB ({ct})")
        st, _, _ = http("GET", f"{url}/api/runs/{run['id']}/files/..%2Fsecret")
        check(st == 404, "artifact paths cannot escape the run folder")
        st, _, _ = http("POST", f"{url}/api/recipes/interpolate-samples/run", '{"inputs": {"nope": 1}}')
        check(st == 400, "unknown input -> 400")
        code = "recipe: code-test\nsteps:\n  - id: py\n    use: python\n    with: { code: \"result(x=1)\" }\n"
        st, _, _ = http("POST", f"{url}/api/recipes", code, "text/yaml")
        check(st == 403, "recipe with code is refused without ?approve=code")
        st, _, _ = http("POST", f"{url}/api/recipes?approve=code", code, "text/yaml")
        check(st == 201, "recipe with code saved with ?approve=code")
        st, _, body = http("POST", f"{url}/api/recipes/validate", "recipe: x\nsteps:\n  - use: nope.step\n", "text/yaml")
        v = json.loads(body)
        check(st == 200 and not v["ok"] and v["errors"], "validate endpoint reports errors")
        prov = jget(f"{url}/api/providers")
        print(f"  info  providers: " + ", ".join(f"{k} {'✓ ' + v.get('version', '') if v['available'] else '✗'}" for k, v in prov.items()))

        print("== webhook trigger")
        token = "test-hook-0123456789abcdef"
        hook = f"""recipe: hooked
title: Called by a webhook
inputs:
  note: {{ default: none }}
triggers:
  - webhook: {{ token: {token} }}
steps:
  - id: open
    use: io.open
    with: {{ layer: field_samples.geojson }}
  - id: report
    use: export.report
    with: {{ notes: "${{inputs.note}}" }}
"""
        st, _, body = http("POST", f"{url}/api/recipes", hook, "text/yaml")
        check(st == 201, f"save recipe with a webhook trigger (HTTP {st}) {body[:120] if st != 201 else ''}")
        st, _, _ = http("POST", f"{url}/api/hooks/{token}", '{"note": "x"}')
        check(st == 409, "webhook of a switched-off recipe -> 409")
        http("PUT", f"{url}/api/recipes/hooked/auto", json.dumps({"enabled": True}))
        t0 = time.time()
        st, _, body = http("POST", f"{url}/api/hooks/{token}", '{"note": "from CI", "extra": 42}')
        check(st == 202, f"webhook call -> 202 (got {st})")
        r, _ = wait_for(lambda: runs_of("hooked", "webhook"), 20)
        if check(bool(r), f"webhook trigger: run done in {time.time() - t0:.2f} s"):
            results["triggers"]["webhook_s"] = round(time.time() - t0, 2)
            full = jget(f"{url}/api/runs/{r[0]['id']}")
            check(full["inputs"].get("note") == "from CI" and full["trigger"].get("payload", {}).get("extra") == 42, "webhook: body became inputs; full payload kept on the trigger")
        st, _, _ = http("POST", f"{url}/api/hooks/not-a-real-token-123456", "{}")
        check(st == 404, "unknown webhook token -> 404")
        http("PUT", f"{url}/api/recipes/hooked/auto", json.dumps({"enabled": False}))

        print("== live sensors (HTTP, MQTT) + sensor triggers")
        sensors_tests(url, results, runs_of, mqtt_port if broker else None)

        if net:
            print("== rasters + stac trigger (live data)")
            t0 = time.time()
            st, _, body = http("POST", f"{url}/api/recipes/terrain-report/run", "{}")
            done, _ = wait_for(lambda: (lambda v: v if v["status"] in ("done", "failed") else None)(jget(f"{url}/api/runs/{json.loads(body)['id']}")), 120)
            check(bool(done) and done["status"] == "done", f"terrain-report via API in {time.time() - t0:.1f} s")
            rs = jget(f"{url}/api/rasters")["rasters"]
            kinds = sorted(r["kind"] for r in rs if r["id"].startswith("terrain-report."))
            check({"dem", "hillshade", "slope", "aspect", "classes"} <= set(kinds), f"/api/rasters lists {kinds}")
            check(set(done.get("rasters", [])) >= {"terrain-report.dem", "terrain-report.hillshade"}, "run JSON lists the rasters it made")
            dem = next(r for r in rs if r["id"] == "terrain-report.dem")
            t1 = time.time()
            st, ct, png = http("GET", f"{url}{dem['overlay']['url']}")
            check(st == 200 and ct == "image/png" and png_size_bytes(png), f"overlay PNG {png_size_bytes(png)} in {(time.time() - t1) * 1000:.0f} ms ({len(png) // 1024} KB)")
            check(dem["legend"]["type"] == "ramp" and len(dem["overlay"]["coordinates"]) == 4, "raster JSON has a legend and image corners")
            st, _, _ = http("PUT", f"{url}/api/rasters/terrain-report.dem/style", json.dumps({"kind": "stretch", "ramp": "magma", "min": 1600, "max": 2400}))
            check(st == 200 and jget(f"{url}/api/rasters/terrain-report.dem")["style"]["ramp"] == "magma", "raster style can be changed (PUT style)")
            box = dem["bounds"]
            watch = f"""recipe: stac-watch
title: New Sentinel-2 pass -> search
triggers:
  - stac: {{ every: 10s, area: [{box[0]:.4f}, {box[1]:.4f}, {box[2]:.4f}, {box[3]:.4f}], max_cloud: 60 }}
steps:
  - id: search
    use: rs.search
    with: {{ aoi: [{box[0]:.4f}, {box[1]:.4f}, {box[2]:.4f}, {box[3]:.4f}], buffer: 0, days: 40, max_cloud: 60 }}
"""
            st, _, body = http("POST", f"{url}/api/recipes", watch, "text/yaml")
            check(st == 201, f"save recipe with a stac trigger (HTTP {st}) {body[:160] if st != 201 else ''}")
            t0 = time.time()
            http("PUT", f"{url}/api/recipes/stac-watch/auto", json.dumps({"enabled": True}))
            r, _ = wait_for(lambda: runs_of("stac-watch", "stac"), 40)
            if check(bool(r), f"stac trigger: newest pass found -> stac-watch done in {time.time() - t0:.1f} s ({(r or [{}])[0].get('trigger', {}).get('text', '')})"):
                results["triggers"]["stac_s"] = round(time.time() - t0, 1)
                time.sleep(14)  # one more poll: no newer pass -> no new run
                check(len(runs_of("stac-watch", "stac", status=None) if False else [x for x in jget(f"{url}/api/runs")["runs"] if x["recipe"] == "stac-watch"]) == 1, "stac trigger: does not fire again for the same pass")
            http("PUT", f"{url}/api/recipes/stac-watch/auto", json.dumps({"enabled": False}))
    finally:
        srv.terminate()
        srv.wait(10)
        log.close()
        if broker:
            broker.terminate()
            broker.wait(5)

    print("== drop folders (inbox), restarts, sensor-log changes")
    inbox_tests(a, base_args, tmp, results)

    with open(os.path.join(a.out, "automation-results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print("== timings (ms per run, CLI, excluding process start)")
    for rid, r in results["cli"].items():
        steps = ", ".join(f"{k} {v:.0f}" for k, v in r["steps"].items())
        print(f"  {rid:<22} {r['elapsed_ms']:>7.0f}   [{steps}]")
    print(f"  triggers: {results['triggers']}")
    shutil.rmtree(tmp, ignore_errors=True)
    if FAILS:
        print(f"FAILED: {len(FAILS)} check(s)")
        sys.exit(1)
    print("PASS")


def inbox_tests(a, base_args, tmp, results):
    """v1.0: an --inbox folder is mapped without Auto, a plugged-in device is not; a restart does not
    re-process unchanged devices (seen.json); new files and appended sensor rows do trigger again."""
    inbox, inbox2, dev = (os.path.join(tmp, n) for n in ("INBOX", "INBOX2", "DEV"))
    os.makedirs(inbox)
    os.makedirs(inbox2)
    state = os.path.join(tmp, "state-inbox")
    port = a.port + 20
    url = f"http://127.0.0.1:{port}"
    args = [a.bin, *base_args, "--state-dir", state, "--host", "127.0.0.1", "--port", str(port), "--web", "web/dist",
            "--inbox", inbox, "--inbox", inbox2, "--watch", dev]   # note: no --auto

    def start(tag):
        log = open(os.path.join(a.out, f"test-automation-inbox-{tag}.log"), "w")
        p = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
        up, _ = wait_for(lambda: http("GET", f"{url}/api/health")[0] == 200 if _alive(p) else None, 30)
        check(bool(up), f"inbox server ({tag}) up")
        return p, log

    def runs(rid):
        return [r for r in jget(f"{url}/api/runs")["runs"] if r["recipe"] == rid and r["status"] in ("done", "failed")]

    def stop(p, log):
        p.terminate()
        p.wait(10)
        log.close()

    srv, log = start("first")
    try:
        time.sleep(1)
        t0 = time.time()
        shutil.copytree(os.path.join(a.samples, "GARMIN"), os.path.join(inbox, "GARMIN"))
        r, _ = wait_for(lambda: runs("track-to-map"), 30)
        if check(bool(r) and r[0]["status"] == "done", f"inbox: GPX dropped -> track-to-map done in {time.time() - t0:.1f} s with no Auto switch on"):
            results["triggers"]["inbox_s"] = round(time.time() - t0, 1)
        shutil.copytree(os.path.join(a.samples, "TEST-PHONE"), dev)
        listed, _ = wait_for(lambda: any(d["name"] == "DEV" for d in jget(f"{url}/api/devices")["devices"]) or None, 20)
        time.sleep(3)
        check(bool(listed) and not runs("photos-to-map"), "plugged-in device is listed but not processed without Auto (privacy promise)")
        # sensor log in the second inbox, then rows appended to its CSV
        aq = os.path.join(inbox2, "AQ")
        shutil.copytree(os.path.join(a.samples, "AQ-LOGGER"), aq)
        r, _ = wait_for(lambda: runs("sensor-log-to-map"), 30)
        check(bool(r), "inbox: sensor log dropped -> sensor-log-to-map")
        csvs = [os.path.join(dp, f) for dp, _, fs in os.walk(aq) for f in fs if f.lower().endswith(".csv")]
        if check(bool(csvs), f"sample logger has a CSV ({len(csvs)})"):
            time.sleep(1.2)  # signatures use whole-second mtimes
            with open(csvs[0]) as f:
                last = f.read().rstrip("\n").splitlines()[-1]
            with open(csvs[0], "a") as f:
                f.write(last + "\n")
            r, _ = wait_for(lambda: len(runs("sensor-log-to-map")) >= 2 or None, 30)
            check(bool(r), "rows appended to a sensor CSV are noticed -> recipe runs again")
    finally:
        stop(srv, log)
    n_track, n_sensor = None, None
    srv, log = start("restart")
    try:
        n_track, n_sensor = len(runs("track-to-map")), len(runs("sensor-log-to-map"))
        time.sleep(8)  # more than one device poll (5 s)
        check(len(runs("track-to-map")) == n_track and len(runs("sensor-log-to-map")) == n_sensor,
              f"restart: unchanged inbox content is not re-processed ({n_track} track run, {n_sensor} sensor runs kept)")
        with open(os.path.join(a.out, "test-automation-inbox-restart.log")) as f:
            check("unchanged since last session" in f.read(), "restart: log says the device was unchanged since last session")
        check(os.path.exists(os.path.join(state, "devices", "seen.json")), "seen.json written to the state folder")
        gpx = [os.path.join(dp, f) for dp, _, fs in os.walk(os.path.join(inbox, "GARMIN")) for f in fs if f.lower().endswith(".gpx")]
        shutil.copy(gpx[0], os.path.join(inbox, "GARMIN", "another-walk.gpx"))
        r, _ = wait_for(lambda: len(runs("track-to-map")) > n_track or None, 30)
        check(bool(r), "restart: a new file in the inbox triggers a new run")
    finally:
        stop(srv, log)


def _alive(p):
    return p.poll() is None


def mqtt_publish(port, msgs):
    """Minimal MQTT 3.1.1 publisher (QoS 0) so the test needs only the broker."""
    import socket
    def s16(b):
        return len(b).to_bytes(2, "big") + b
    def pkt(first, body):
        n, out = len(body), bytearray([first])
        while True:
            d, n = n % 128, n // 128
            out.append(d | (0x80 if n else 0))
            if not n:
                break
        return bytes(out) + body
    with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
        c.sendall(pkt(0x10, s16(b"MQTT") + bytes([4, 2, 0, 30]) + s16(b"geospax-ci-pub")))
        c.recv(4)
        for topic, payload in msgs:
            c.sendall(pkt(0x30, s16(topic.encode()) + json.dumps(payload).encode()))
            time.sleep(0.05)
        c.sendall(bytes([0xE0, 0]))


def sensors_tests(url, results, runs_of, mqtt_port):
    """Live sensor readings over HTTP and MQTT, the sensor trigger (threshold + cooldown) and a geofence."""
    post = lambda body: http("POST", f"{url}/api/devices/live", json.dumps(body))
    st, _, body = post({"id": "aq-ci", "name": "AQ CI", "lat": -5.86, "lon": 144.23, "values": {"pm2_5": 12.0, "temperature": 21}})
    check(st == 200 and json.loads(body).get("device") == "sensor-aq-ci", f"POST sensor reading -> live sensor 'sensor-aq-ci' (HTTP {st})")
    st, _, _ = post({"id": "aq-ci", "values": {"pm2_5": 13.0}})
    check(st == 200, "reading without a position uses the sensor's last one")
    st, _, body = post({"id": "never-seen", "values": {"pm2_5": 13.0}})
    check(st == 400 and b"no position" in body, "reading without any position yet -> 400")
    fc = jget(f"{url}/api/devices/readings?minutes=5&device=sensor-aq-*")
    vals = [f["properties"].get("pm2_5") for f in fc["features"]]
    check(vals == [12.0, 13.0], f"GET /api/devices/readings: {vals}")
    live = {d["id"]: d for d in jget(f"{url}/api/devices")["live"]}
    aq = live.get("sensor-aq-ci", {})
    check(aq.get("kind") == "sensor" and aq.get("readings") == 2 and aq.get("values", {}).get("pm2_5") == 13.0, f"Devices pane: live sensor with latest values {aq.get('values')}")

    # threshold trigger: air-quality-alert fires once, then the 30-minute cooldown holds
    http("PUT", f"{url}/api/recipes/air-quality-alert/auto", json.dumps({"enabled": True}))
    t0 = time.time()
    post({"id": "aq-ci", "lat": -5.8605, "lon": 144.2305, "values": {"pm2_5": 48.0}})
    r, _ = wait_for(lambda: runs_of("air-quality-alert", "sensor"), 30)
    if check(bool(r), f"sensor trigger: PM2.5 48 > 35 -> alert map + report in {time.time() - t0:.2f} s"):
        results["triggers"]["sensor_s"] = round(time.time() - t0, 2)
        full = jget(f"{url}/api/runs/{r[0]['id']}")
        check("pm2_5 = 48" in full["trigger"].get("text", ""), f"sensor trigger text: {full['trigger'].get('text')}")
        check(any(x.endswith(".png") for x in full["artifacts"]) and step_out(full, "live").get("count") == 3, "alert run: snapshot of 3 live readings, map and report")
    post({"id": "aq-ci", "values": {"pm2_5": 52.0}})
    time.sleep(1.5)
    n = len([x for x in jget(f"{url}/api/runs")["runs"] if x["recipe"] == "air-quality-alert"])
    check(n == 1, f"cooldown: a second high reading within 30 min does not start another run ({n} run)")
    http("PUT", f"{url}/api/recipes/air-quality-alert/auto", json.dumps({"enabled": False}))

    # geofence trigger: a phone entering a polygon layer (here: the countries layer, PNG)
    poly = next((l["id"] for l in jget(f"{url}/api/layers")["layers"] if l.get("geometry") == "polygon" and "countr" in l["id"].lower()), None)
    if poly:
        fence = f"""recipe: fence-ci
title: Geofence test
triggers:
  - sensor: {{ inside: {poly}, cooldown: 1s }}
steps:
  - id: note
    use: layout.auto
    with: {{ title: "${{trigger.text}}" }}
"""
        st, _, body = http("POST", f"{url}/api/recipes", fence, "text/yaml")
        check(st == 201, f"save a recipe with a geofence trigger (HTTP {st}) {body[:160] if st != 201 else ''}")
        http("PUT", f"{url}/api/recipes/fence-ci/auto", json.dumps({"enabled": True}))
        fence_runs = lambda: [x for x in jget(f"{url}/api/runs")["runs"] if x["recipe"] == "fence-ci"]
        post({"device": "fencer", "lat": -10.0, "lon": 150.5})  # Coral Sea: outside
        time.sleep(1.0)
        check(len(fence_runs()) == 0, "geofence: a position outside does not fire")
        t0 = time.time()
        post({"device": "fencer", "lat": -5.86, "lon": 144.23})  # Mount Hagen: inside
        r, _ = wait_for(lambda: [x for x in fence_runs() if x["status"] == "done"], 20)
        check(bool(r) and "entered" in jget(f"{url}/api/runs/{r[0]['id']}")["trigger"].get("text", ""), f"geofence: entering fires in {time.time() - t0:.2f} s")
        post({"device": "fencer", "lat": -5.861, "lon": 144.231})  # still inside
        time.sleep(1.2)
        check(len(fence_runs()) == 1, "geofence: moving inside does not fire again")
        post({"device": "fencer", "lat": -10.0, "lon": 150.5})
        post({"device": "fencer", "lat": -5.86, "lon": 144.23})
        r, _ = wait_for(lambda: len(fence_runs()) == 2 or None, 10)
        check(bool(r), "geofence: leaving and entering again fires again")
        http("PUT", f"{url}/api/recipes/fence-ci/auto", json.dumps({"enabled": False}))
    else:
        print("  skip  geofence (no countries polygon layer loaded)")

    if mqtt_port is None:
        print("  skip  MQTT (needs mosquitto: apt install mosquitto)")
        return
    up, _ = wait_for(lambda: (jget(f"{url}/api/devices").get("mqtt") or [{}])[0].get("connected") or None, 15)
    if not check(bool(up), "MQTT: subscribed to the broker"):
        return
    now = int(time.time())
    t0 = time.time()
    mqtt_publish(mqtt_port, [
        ("owntracks/ci/pixel", {"_type": "location", "lat": -5.861, "lon": 144.231, "tst": now, "acc": 8, "batt": 77, "tid": "ci"}),
        ("sensors/aq-mqtt", {"lat": -5.862, "lon": 144.232, "pm2_5": 22.5, "temperature": 19.0}),
        ("sensors/aq-mqtt", {"pm2_5": 24.0}),
        ("sensors/broken", "not json"),
    ])
    def seen():
        d = jget(f"{url}/api/devices")
        live = {x["id"]: x for x in d["live"]}
        return (d, live) if live.get("sensors-aq-mqtt", {}).get("readings") == 2 and "ci" in live else None
    got, _ = wait_for(seen, 10)
    if check(bool(got), f"MQTT: OwnTracks phone + sensor JSON visible in {time.time() - t0:.2f} s"):
        d, live = got
        results["triggers"]["mqtt_s"] = round(time.time() - t0, 2)
        check(live["ci"].get("kind") == "phone" and live["sensors-aq-mqtt"].get("values", {}).get("pm2_5") == 24.0, "MQTT: OwnTracks = phone; value-only message used the sensor's last position")
        m = d["mqtt"][0]
        check(m.get("messages") == 4 and m.get("ignored") == 1, f"MQTT status: {m.get('messages')} messages, {m.get('ignored')} ignored (not JSON)")


if __name__ == "__main__":
    main()
