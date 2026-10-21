#!/usr/bin/env python3
"""Run every domain kit (recipes/kit-*.yaml) end to end against a running GeoSpaX server.

Kits that work on your own layers run as shipped. For kits that download data (GBIF, WorldClim,
SoilGrids, the Copernicus DEM), each download step is swapped for local test data with the same
outputs, so everything after it (the tools, maps and report) runs for real; the downloads themselves
are covered by the data.fetch unit tests and need internet.

  python3 scripts/test-kits.py http://127.0.0.1:8080        (server started with --data <test data>)
Test data: scripts/test-kits-data.R writes it.
"""
import json, re, sys, time, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"

def call(method, path, body=None, ctype="application/json"):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(f"{BASE}/{path}", data=data, method=method, headers={"content-type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")

def recipe_text(rid):
    return call("GET", f"api/recipes/{rid}")["recipe"]["yaml"] if "recipe" in call("GET", f"api/recipes/{rid}") else call("GET", f"api/recipes/{rid}")["yaml"]

def offline(text, swaps):
    """Drop the named download steps and put local ids where their outputs were used."""
    for step, refs in swaps.items():
        text = re.sub(rf"\n  - id: {step}\n    use: (data|dem)\.fetch\n    with: [^\n]*\n", "\n", text)
        for ref, local in refs.items():
            text = text.replace(f'"${{{step}.{ref}}}"', json.dumps(local))
    return text

def run(rid, inputs, text=None):
    if text:
        rid = rid + "-offline"
        text = re.sub(r"^recipe: .*$", f"recipe: {rid}", text, flags=re.M)
        r = call("POST", "api/recipes?approve=code", text.encode(), "text/yaml")
        if "error" in r:
            return {"status": "failed", "error": r["error"], "steps": []}
    run = call("POST", f"api/recipes/{rid}/run", {"inputs": inputs})
    if "id" not in run:
        return {"status": "failed", "error": run.get("error"), "steps": []}
    for _ in range(300):
        r = call("GET", f"api/runs/{run['id']}")
        if r["status"] in ("done", "failed"):
            return r
        time.sleep(1)
    return r

passed, failed = 0, []
def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}{f' ({extra})' if extra else ''}")
    else:
        failed.append(name)
        print(f"  FAIL {name}{f' ({extra})' if extra else ''}")

def why(r, step):
    return "; ".join(next((s.get("why") or [] for s in r.get("steps", []) if s["id"] == step), []))

def done(name, r, pngs):
    check(f"{name} finishes", r["status"] == "done", (r.get("error") or "")[:200])
    arts = r.get("artifacts", [])
    check(f"{name} makes its maps and report", all(p in arts for p in pngs) and "report.html" in arts, ", ".join(a for a in arts if a.endswith((".png", ".html"))))

kits = [r["id"] for r in call("GET", "api/recipes")["recipes"] if r["id"].startswith("kit-")]
print(f"{len(kits)} kits: {', '.join(kits)}")
check("nine kits ship", len(kits) >= 9)

print("\nconservation · protection gaps (habitat 4 blocks, protected = half of two)")
r = run("kit-protection-gaps", {"habitat": "habitat.geojson", "protected": "protected_areas.geojson"})
done("protection gaps", r, ["protection-gaps.png"])
check("25 % protected", "25.0 % protected" in why(r, "gap"), why(r, "gap")[:90])

print("\nforestry · fragmentation and connectivity (12 patches)")
r = run("kit-forest-fragmentation", {"patches": "forest_patches.geojson"})
done("forest fragmentation", r, ["core-areas.png", "connectivity.png"])
check("12 patches", "12 patch(es)" in why(r, "metrics"), why(r, "metrics")[:90])

print("\nland cover · two-date change (a third lost, as much gained)")
r = run("kit-land-cover-change", {"before": "mangrove_2015.geojson", "after": "mangrove_2025.geojson"})
done("land cover change", r, ["land-cover-change.png"])
check("net change zero", "Net change -0.0 %" in why(r, "change") or "Net change 0.0 %" in why(r, "change"), why(r, "change")[:90])

print("\nbiodiversity · survey diversity (3 clusters, 12 species)")
r = run("kit-survey-diversity", {"records": "bird_survey.geojson"})
done("survey diversity", r, ["richness.png", "clusters.png"])
check("12 species", "12 species" in why(r, "diversity"), why(r, "diversity")[:80])
check("3 clusters", "3 cluster(s)" in why(r, "clusters"), why(r, "clusters")[:80])
check("clustered pattern", "clustered" in why(r, "pattern"), why(r, "pattern")[:80])

print("\nagriculture and environment · vegetation change (planted loss strip)")
r = run("kit-vegetation-change", {"before": "ndvi_2020", "after": "ndvi_2024"})
done("vegetation change", r, ["vegetation-change.png", "difference.png"])
check("loss and no gain", "0 ha gain" in why(r, "change") and "loss" in why(r, "change"), why(r, "change")[:90])

print("\nbiodiversity · species distribution model (downloads swapped for local test data)")
text = offline(call("GET", "api/recipes/kit-species-distribution")["yaml"], {"occurrences": {"layer": "test_occurrences.geojson"}, "climate": {"raster_ids": ["climate"]}})
text = text.replace('"${occurrences.layer}"', '"test_occurrences.geojson"')
r = run("kit-species-distribution", {"area": "habitat.geojson", "method": "mahalanobis"}, text)
done("species distribution", r, ["suitability.png", "range.png"])
check("cross-validated AUC reported", "cross-validated AUC" in why(r, "sdm"), why(r, "sdm")[:100])

print("\nclimate · range shift (future = +2.5 °C: the range moves upslope)")
text = offline(call("GET", "api/recipes/kit-climate-range-shift")["yaml"], {"occurrences": {"layer": "test_occurrences.geojson"}, "climate": {"raster_ids": ["climate"]}, "future": {"raster_ids": ["climate_future"]}})
text = text.replace('"${occurrences.layer}"', '"test_occurrences.geojson"')
r = run("kit-climate-range-shift", {"area": "habitat.geojson"}, text)
done("range shift", r, ["suitability-now.png", "suitability-future.png", "range-change.png"])
tbl = dict(next((s.get("outputs", {}).get("table", []) for s in r.get("steps", []) if s["id"] == "sdm"), []))
check("range both lost and gained", tbl.get("Lost", "0 km²") != "0 km²" and tbl.get("Gained", "0 km²") != "0 km²", f"lost {tbl.get('Lost')}, gained {tbl.get('Gained')}")

print("\ndisaster and geoscience · steep slopes (DEM swapped for a local one)")
text = call("GET", "api/recipes/kit-steep-slopes")["yaml"]
text = re.sub(r"\n  - id: dem\n    use: dem\.fetch\n    with: [^\n]*\n", "\n", text).replace("{ products: [hillshade] }", "{ dem: test_dem, products: [hillshade] }").replace("dem: dem,", "dem: test_dem,")
r = run("kit-steep-slopes", {"area": "habitat.geojson"}, text)
done("steep slopes", r, ["slope-zones.png"])

print("\nsoil · topsoil properties (SoilGrids swapped for local rasters)")
text = offline(call("GET", "api/recipes/kit-soil-properties")["yaml"], {"ph": {"raster": "soil_ph"}, "carbon": {"raster": "soil_soc"}, "clay": {"raster": "soil_clay"}})
r = run("kit-soil-properties", {"area": "habitat.geojson"}, text)
done("soil properties", r, ["soil-ph.png", "soil-carbon.png", "soil-clay.png"])

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
