#!/usr/bin/env python3
"""Editing, selection and attribute-table checks against a running server (edit.rs).

    scripts/test-edit.py [base-url]       (default http://127.0.0.1:18091)

The server's data folder is made by scripts/test-edit-data.py: a survey (survey.geojson), the same
points as a Shapefile (survey_shp.shp) and in UTM 55S (survey_utm.gpkg), and reserves
(reserves.geojson). Expected answers come from the data itself, read here with the standard
library, so the checks hold for any such folder.
"""
import json
import math
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18091").rstrip("/")
passed, failed = 0, []


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}/{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
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


layers = {l["id"]: l for l in call("GET", "api/layers")[1]["layers"]}
GJ = "survey.geojson"
SHP = "survey_shp.shp"
UTM = next(i for i in layers if i.startswith("survey_utm."))
PA = "reserves.geojson"
src = json.load(open(layers[GJ]["source"]))["features"]
n_all = len(src)
rich = [f["properties"]["species_richness"] for f in src]

print("attribute table")
for lid, rf in ((GJ, "species_richness"), (SHP, "species_ri"), (UTM, "species_richness")):
    s, t = call("POST", f"api/layers/{lid}/table", {"sort": rf, "desc": True, "limit": 5})
    vals = [r["values"][t["fields"].index(rf)] for r in t.get("rows", [])]
    check(f"{lid}: sorted descending", s == 200 and vals == sorted(rich, reverse=True)[:5], f"{vals}")
    check(f"{lid}: every field listed", s == 200 and len(t["fields"]) >= 7, f"{len(t.get('fields', []))} fields")
    check(f"{lid}: rows carry a WGS 84 bbox", s == 200 and all(r["bbox"] and 140 < r["bbox"][0] < 152 for r in t["rows"]), str(t["rows"][0]["bbox"] if t.get("rows") else None))
s, t = call("POST", f"api/layers/{GJ}/table", {"where": "transect = 'YUS'", "limit": 500})
check("table where clause", t["total"] == sum(1 for f in src if f["properties"]["transect"] == "YUS"), f"{t['total']}")
s, t = call("POST", f"api/layers/{GJ}/table", {"where": "nosuchfield > 1"})
check("a bad query is a 400 with a message", s == 400 and "error" in t, t.get("error", "")[:60])

search = lambda f, q: f"CAST({json.dumps(f)} AS TEXT) LIKE '%{q}%' ESCAPE '!'"
for lid in (GJ, UTM):
    s, t = call("POST", f"api/layers/{lid}/table", {"where": search("site", "WIL"), "limit": 500})
    check(f"{lid}: table search (text in any field)", s == 200 and t["total"] == sum(1 for f in src if "WIL" in f["properties"]["site"]), str(t.get("total", t.get("error"))))
s, t = call("POST", f"api/layers/{GJ}/table", {"sort": "elevation_m", "desc": True, "offset": 40, "limit": 10})
check("last page of a sorted table", s == 200 and len(t["rows"]) == n_all - 40 and t["rows"][-1]["values"][t["fields"].index("elevation_m")] == min(f["properties"]["elevation_m"] for f in src))

print("select by attributes")
s, r = call("POST", f"api/layers/{GJ}/select", {"where": "elevation_m > 2000"})
want = sum(1 for f in src if f["properties"]["elevation_m"] > 2000)
check("elevation_m > 2000", s == 200 and r["count"] == want, f"{r.get('count')} of {want}")
s, r2 = call("POST", f"api/layers/{GJ}/select", {"where": "species_richness >= 50", "within": r["fids"]})
want2 = sum(1 for f in src if f["properties"]["elevation_m"] > 2000 and f["properties"]["species_richness"] >= 50)
check("select from current selection", r2["count"] == want2, f"{r2['count']} of {want2}")

print("select by location")
s, inter = call("POST", f"api/layers/{GJ}/select", {"location": {"layer": PA, "relation": "intersects"}})
s, near = call("POST", f"api/layers/{GJ}/select", {"location": {"layer": PA, "relation": "within_distance", "distance_m": 20000}})
res = json.load(open(layers[PA]["source"]))["features"]
def inside(pt, poly):
    xs = [c[0] for c in poly[0]]; ys = [c[1] for c in poly[0]]
    return min(xs) <= pt[0] <= max(xs) and min(ys) <= pt[1] <= max(ys)
want_in = sum(1 for f in src if any(inside(f["geometry"]["coordinates"], r["geometry"]["coordinates"]) for r in res))
check("intersects = points inside the reserves", inter.get("count") == want_in and want_in > 0, f"{inter.get('count')} of {want_in}")
check("intersects ⊆ within 20 km", s == 200 and set(inter["fids"]) <= set(near["fids"]), f"{inter['count']} ⊆ {near['count']}")
s, far = call("POST", f"api/layers/{GJ}/select", {"location": {"layer": PA, "relation": "within_distance", "distance_m": 2_000_000}})
check("within 2,000 km selects everything", far["count"] == n_all, f"{far['count']}")
s, utm_near = call("POST", f"api/layers/{UTM}/select", {"location": {"layer": PA, "relation": "within_distance", "distance_m": 20000}})
check("same answer on the UTM copy", utm_near["count"] == near["count"], f"{utm_near['count']} vs {near['count']}")

print("definition query")
s, r = call("PUT", f"api/layers/{GJ}/filter", {"where": "transect = 'YUS'"})
yus = sum(1 for f in src if f["properties"]["transect"] == "YUS")
check("filtered count", s == 200 and r["layer"]["filtered_count"] == yus, f"{r['layer'].get('filtered_count')} of {yus}")
s, t = call("POST", f"api/layers/{GJ}/table", {"limit": 500})
check("table honours it", t["total"] == yus, f"{t['total']}")
s, r = call("POST", f"api/layers/{GJ}/select", {"where": "elevation_m > 0"})
check("selection honours it", r["count"] == yus, f"{r['count']}")
s, r = call("PUT", f"api/layers/{GJ}/filter", {"where": "bad syntax ((("})
check("a bad definition query is refused", s == 400, r.get("error", "")[:60])
call("PUT", f"api/layers/{GJ}/filter", {"where": ""})

print("feature ids survive the first edit (the edit copy keeps them)")
s, t = call("POST", f"api/layers/{GJ}/table", {"limit": 500})
before = {r["fid"]: r["values"][t["fields"].index("site")] for r in t["rows"]}
call("POST", f"api/layers/{GJ}/edit")
s, t = call("POST", f"api/layers/{GJ}/table", {"limit": 500})
after = {r["fid"]: r["values"][t["fields"].index("site")] for r in t["rows"]}
check("same fid → same feature", before == after and len(after) == n_all, f"fids {min(after)}–{max(after)}")
call("POST", f"api/layers/{GJ}/revert")

print("editing (UTM layer: geometry goes back to the layer's CRS)")
s, r = call("POST", f"api/layers/{UTM}/features", {"type": "Feature", "geometry": {"type": "Point", "coordinates": [146.5, -6.5]}, "properties": {"site": "NEW-1", "species_richness": "42"}})
check("add a feature", s == 201 and r["layer"]["edited"] and r["layer"]["feature_count"] == n_all + 1, str(r.get("error", r.get("fid"))))
fid = r.get("fid")
s, f = call("GET", f"api/layers/{UTM}/features/{fid}")
x, y = f["geometry"]["coordinates"][:2]
check("it reads back at the same place", abs(x - 146.5) < 1e-7 and abs(y + 6.5) < 1e-7, f"{x:.8f}, {y:.8f}")
check("typed attributes ('42' → 42)", f["properties"]["species_richness"] == 42 and f["properties"]["site"] == "NEW-1")
s, r = call("PUT", f"api/layers/{UTM}/features/{fid}", {"properties": {"species_richness": "abc"}})
check("a wrong type is refused", s == 400, r.get("error", ""))
s, r = call("PUT", f"api/layers/{UTM}/features/{fid}", {"geometry": {"type": "Point", "coordinates": [146.6, -6.4]}, "properties": {"site": "NEW-1b"}})
s, f = call("GET", f"api/layers/{UTM}/features/{fid}")
check("move and rename", f["properties"]["site"] == "NEW-1b" and abs(f["geometry"]["coordinates"][0] - 146.6) < 1e-7)
s, r = call("POST", f"api/layers/{UTM}/features", {"geometry": {"type": "LineString", "coordinates": [[146, -6], [147, -7]]}})
check("a line cannot go into a point layer", s == 400, r.get("error", ""))

print("fields and calculation")
s, r = call("POST", f"api/layers/{UTM}/fields", {"name": "density", "kind": "real"})
check("add a field", s == 201 and any(x["name"] == "density" for x in r["layer"]["fields"]))
s, r = call("POST", f"api/layers/{UTM}/calculate", {"field": "density", "expression": '"species_richness" * 1.0 / ("elevation_m" + 1)'})
check("calculate every row", s == 200 and r["updated"] == n_all + 1, str(r.get("updated", r.get("error"))))
s, t = call("POST", f"api/layers/{UTM}/table", {"limit": 1, "where": "site = 'YUS-09'"})
row = dict(zip(t["fields"], t["rows"][0]["values"]))
check("value is right", abs(row["density"] - row["species_richness"] / (row["elevation_m"] + 1)) < 1e-9, f"{row['density']}")
s, r = call("POST", f"api/layers/{UTM}/calculate", {"field": "band", "kind": "text", "expression": "CASE WHEN elevation_m >= 2000 THEN 'high' ELSE 'low' END", "where": "transect = 'YUS'"})
check("CASE into a new text field, YUS only", s == 200 and r["updated"] == yus, str(r.get("updated", r.get("error"))))
s, r = call("POST", f"api/layers/{UTM}/calculate", {"field": "density", "expression": "nosuch + 1"})
check("a bad expression changes nothing", s == 400, r.get("error", "")[:70])
s, r = call("POST", f"api/layers/{UTM}/calculate", {"field": "x_deg", "geometry": "x"})
s, t = call("POST", f"api/layers/{UTM}/table", {"limit": 1, "where": "site = 'YUS-09'"})
row = dict(zip(t["fields"], t["rows"][0]["values"]))
lon = next(f["geometry"]["coordinates"][0] for f in src if f["properties"]["site"] == "YUS-09")
check("calculate geometry x (WGS 84)", abs(row["x_deg"] - lon) < 1e-6, f"{row['x_deg']} vs {lon}")
s, r = call("DELETE", f"api/layers/{UTM}/fields/density")
check("delete a field", s == 200 and not any(x["name"] == "density" for x in r["layer"]["fields"]))

print("delete, export, revert")
s, r = call("POST", f"api/layers/{UTM}/features/delete", {"fids": [fid]})
check("delete the new feature", r.get("deleted") == 1 and r["layer"]["feature_count"] == n_all)
s, sel = call("POST", f"api/layers/{GJ}/select", {"where": "transect = 'YUS'"})
s, r = call("POST", f"api/layers/{GJ}/export", {"name": "YUS sites", "fids": sel["fids"]})
check("export the selection as a new layer", s == 201 and r["layer"]["feature_count"] == yus, r.get("error", r.get("layer", {}).get("id", "")))
s, r = call("POST", f"api/layers/{GJ}/export", {"name": "YUS sites", "fids": sel["fids"]})
check("a taken name is refused", s == 400)
s, r = call("POST", f"api/layers/{UTM}/revert")
check("revert to the original", s == 200 and not r["layer"]["edited"] and r["layer"]["feature_count"] == n_all and not any(x["name"] == "band" for x in r["layer"]["fields"]))

print("new layer and polygon area")
s, r = call("POST", "api/layers/new", {"name": "Study plots", "geometry": "polygon", "fields": [{"name": "plot", "kind": "text"}]})
nid = r.get("layer", {}).get("id")
check("create an empty polygon layer", s == 201 and r["layer"]["feature_count"] == 0, str(nid or r.get("error")))
sq = [[146.0, -6.0], [146.1, -6.0], [146.1, -6.1], [146.0, -6.1], [146.0, -6.0]]
s, r = call("POST", f"api/layers/{nid}/features", {"geometry": {"type": "Polygon", "coordinates": [sq]}, "properties": {"plot": "A"}})
s, r = call("POST", f"api/layers/{nid}/calculate", {"field": "area_ha", "geometry": "area_ha"})
s, t = call("POST", f"api/layers/{nid}/table", {})
area = dict(zip(t["fields"], t["rows"][0]["values"]))["area_ha"]
R = 6371008.8
exact = R * R * math.radians(0.1) * (math.sin(math.radians(6.1)) - math.sin(math.radians(6.0))) / 1e4
check("geodesic area of a 0.1° cell", abs(area - exact) / exact < 1e-6, f"{area:.2f} ha vs {exact:.2f}")
call("POST", f"api/layers/{nid}/revert")
call("POST", "api/layers/yus_sites.gpkg/revert")

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
