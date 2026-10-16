#!/usr/bin/env python3
"""Plugins test (docs/PLUGINS.md): every manifest format is read, and a tool really runs.

    python3 scripts/test-plugins.py [http://127.0.0.1:8080]

Checks
  1. the two shipped plugins (native python + recipe) load and are runnable;
  2. running a python tool round-trips JSON through the engine;
  3. running a recipe tool starts a recipe run (history, artifacts);
  4. RustGIS (plugin.json), QGIS (metadata.txt) and ArcGIS Pro (Config.daml) manifests
     are imported with the right source, and each reports honestly what it cannot run;
  5. package files (.rgplugin, .esriAddInX) install through the API;
  6. the ribbon/palette see the plugin tools.
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
import zipfile

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILS = []
PASSES = [0]


def ok(name, cond, extra=""):
    if cond:
        PASSES[0] += 1
        print(f"  ok   {name}{(' (' + str(extra) + ')') if extra else ''}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}{(' (' + str(extra) + ')') if extra else ''}")


def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE}/api/{path}", data=data, method=method,
        headers={"content-type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"{}")


def api_err(path, method="POST", body=None):
    """Returns (status, parsed) — 4xx is a valid outcome for some checks."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE}/api/{path}", data=data, method=method,
        headers={"content-type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def wait_recipe(run_id, limit=180):
    for _ in range(limit * 2):
        try:
            run = api(f"runs/{run_id}")
        except Exception:
            time.sleep(0.5)
            continue
        if run.get("status") in ("done", "failed", "cancelled", "interrupted"):
            return run
        time.sleep(0.5)
    return {"status": "timeout"}


print("1 · shipped plugins")
state = api("plugins")
by_id = {p["id"]: p for p in state["plugins"]}
ok("example-python loaded", "example-python" in by_id, sorted(by_id))
ok("python plugin is runnable", by_id.get("example-python", {}).get("runnable") is True,
   by_id.get("example-python", {}).get("kind"))
ok("python plugin declares 2 tools", len(by_id.get("example-python", {}).get("tools", [])) == 2)
ok("field-recipes is a recipe plugin", by_id.get("field-recipes", {}).get("kind") == "recipe")
ok("recipe tools point at recipes",
   all(t.get("recipe") for t in by_id.get("field-recipes", {}).get("tools", [])),
   [t.get("recipe") for t in by_id.get("field-recipes", {}).get("tools", [])])
ok("runtimes reported", "python3" in state.get("runtimes", {}), state.get("runtimes"))

print("\n2 · run a python tool")
res = api("plugins/example-python/tools/layer-report/run", "POST",
          {"params": {"layer": "field_samples.geojson", "field": "land_use"}})
ok("tool ran", res.get("kind") == "python", json.dumps(res)[:120])
ok("tool result is ok", (res.get("result") or {}).get("ok") is True, (res.get("result") or {}).get("message"))
bad = api_err("plugins/example-python/tools/nope/run", "POST", {"params": {}})
ok("unknown tool is a 400", bad[0] == 400, bad[1].get("error"))

print("\n3 · run a recipe-backed tool (history + artifacts)")
run = api("plugins/field-recipes/tools/points-to-hexbins/run", "POST", {"params": {"layer": "synthetic.points"}})
ok("recipe tool started a run", bool((run.get("run") or {}).get("id")), (run.get("run") or {}).get("id"))
if (run.get("run") or {}).get("id"):
    finished = wait_recipe(run["run"]["id"])
    ok("recipe finished", finished.get("status") == "done", finished.get("status"))
    ok("recipe made artifacts", len(finished.get("artifacts", [])) >= 1, finished.get("artifacts"))

print("\n4 · foreign manifests (RustGIS, QGIS, ArcGIS Pro)")
# The server is started with --plugins /tmp/geospax-plugin-test; drop the fixtures in.
tmp = "/tmp/geospax-plugin-test"
shutil.rmtree(tmp, ignore_errors=True)
os.makedirs(tmp, exist_ok=True)
for name in ("hello-rustgis", "qgis-plugin", "arcgis-addin"):
    shutil.copytree(os.path.join(ROOT, "tests/fixtures/plugins", name), os.path.join(tmp, name))

state = api("plugins/reload", "POST")
by_id = {p["id"]: p for p in state["plugins"]}
rg = by_id.get("hello-rustgis")
ok("RustGIS plugin.json read", rg is not None and rg["source"] == "rustgis", rg and rg["source"])
if rg:
    ok("RustGIS tool imported", [t["id"] for t in rg["tools"]] == ["bounding-boxes"], rg["tools"])
    ok("RustGIS command imported", any(c["id"] == "layer-report" for c in rg["commands"]), rg["commands"])
    ok("RustGIS params mapped to GeoSpaX kinds",
       [p["kind"] for p in rg["tools"][0]["params"]] == ["layer", "bool"], rg["tools"][0]["params"])
    ok("missing WASM is reported, not hidden",
       rg["runnable"] is False and "plugin.wasm" in (rg.get("warning") or ""), rg.get("needs"))

qg = by_id.get("save_attributes")
ok("QGIS metadata.txt read", qg is not None and qg["source"] == "qgis", qg and qg["source"])
if qg:
    ok("QGIS author and category survive", qg.get("author") == "Ujaval Gandhi", qg.get("author"))
    ok("no qgis_process here is reported", "qgis_process" in (qg.get("needs") or ""), qg.get("needs"))

# one id, one plugin: an installed copy shadows the folder copy (later folder wins)
ag = [p for p in state["plugins"] if p["source"] == "arcgis"]
ok("ArcGIS Config.daml read", len(ag) == 1, [(p["id"], p["path"]) for p in ag])
if ag:
    a = ag[0]
    ok("add-in name from Config.daml", a["name"] == "Field Tools", a["name"])
    ok("add-in buttons imported as commands",
       sorted(c["id"] for c in a["commands"]) == ["ProAppModule_Button1", "ProAppModule_Tool1"],
       [c["title"] for c in a["commands"]])
    ok(".NET limit stated honestly",
       "CLR" in (a.get("warning") or "") or ".NET" in (a.get("warning") or ""), (a.get("warning") or "")[:70])

print("\n5 · packages install")
# build .rgplugin and .esriAddInX packages from the fixtures, then install them
pkg_dir = "/tmp/geospax-plugin-pkgs"
shutil.rmtree(pkg_dir, ignore_errors=True)
os.makedirs(pkg_dir, exist_ok=True)
rgp = os.path.join(pkg_dir, "hello-rustgis-0.1.0.rgplugin")
with zipfile.ZipFile(rgp, "w") as z:
    z.write(os.path.join(ROOT, "tests/fixtures/plugins/hello-rustgis/plugin.json"), "plugin.json")
esri = os.path.join(pkg_dir, "FieldTools-1.0.esriAddInX")
with zipfile.ZipFile(esri, "w") as z:
    src = os.path.join(ROOT, "tests/fixtures/plugins/arcgis-addin")
    for root, _dirs, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, src).replace("\\", "/"))
ok("packages built", os.path.exists(rgp) and os.path.exists(esri))

status, body = api_err("plugins/import", "POST", {"path": rgp})
ok(".rgplugin installs", status == 200 and body.get("plugin", {}).get("id") == "hello-rustgis", body.get("error"))
ok("installed under the state plugins dir, not a --plugins folder",
   "/.geospax/plugins/hello-rustgis" in (body.get("plugin", {}).get("path") or ""),
   body.get("plugin", {}).get("path"))
ok("package name keeps the id, drops the version",
   os.path.isdir((body.get("plugin", {}) or {}).get("path", "")), (body.get("plugin", {}) or {}).get("path"))
status, body = api_err("plugins/import", "POST", {"path": esri})
ok(".esriAddInX installs", status == 200, body.get("error"))
if status == 200:
    ok("ArcGIS package keeps its toolboxes",
       os.path.isfile(os.path.join(tmp, body["plugin"]["path"], "Toolboxes/field_tools.pyt").replace("\\", "/"))
       or os.path.isfile(os.path.join(body["plugin"]["path"], "Toolboxes", "field_tools.pyt")),
       body["plugin"]["path"])
status, body = api_err("plugins/import", "POST", {"path": "/definitely/not/here"})
ok("a missing path is a clean 400", status == 400, body.get("error"))
api("plugins/reload", "POST")

print("\n6 · CLI")
cli = subprocess.run([os.path.join(ROOT, "target/release/geospax-server"), "plugins", "check",
                      os.path.join(ROOT, "plugins/example-python")],
                     capture_output=True, text=True, timeout=60)
ok("plugins check passes on the example", cli.returncode == 0, cli.stdout.strip()[:90])
cli_bad = subprocess.run([os.path.join(ROOT, "target/release/geospax-server"), "plugins", "check", "/tmp"],
                         capture_output=True, text=True, timeout=60)
ok("plugins check rejects a folder with no manifest", cli_bad.returncode == 1, cli_bad.stderr.strip()[:60])
cli_list = subprocess.run([os.path.join(ROOT, "target/release/geospax-server"), "plugins", "list",
                           "--dir", os.path.join(ROOT, "plugins")],
                          capture_output=True, text=True, timeout=60)
ok("plugins list shows both shipped plugins",
   "Example Python tools" in cli_list.stdout and "Field kit" in cli_list.stdout, cli_list.stdout.strip()[:80])

shutil.rmtree(tmp, ignore_errors=True)
shutil.rmtree(pkg_dir, ignore_errors=True)
print(f"\n{PASSES[0]}/{PASSES[0] + len(FAILS)} checks passed")
if FAILS:
    print("failed: " + ", ".join(FAILS))
    sys.exit(1)
