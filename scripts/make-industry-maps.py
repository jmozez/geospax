#!/usr/bin/env python3
"""Industry showcase maps: each kit runs on real Papua New Guinea inputs, with a real online basemap.

  python3 scripts/industry-maps-data.py DATA      # fetch the inputs once
  python3 scripts/make-industry-maps.py DATA OUT  # run the 12 kits, write OUT/<kit>-map-pro-dark.png

Needs a release build (target/release/geospax-server) and network access for the tiles and DEMs.
"""
import json, math, os, re, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request
from osgeo import osr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA, OUT = sys.argv[1], sys.argv[2]
ONLY = sys.argv[3:] or None
PORT = 8793
BASE = f"http://127.0.0.1:{PORT}"
os.makedirs(OUT, exist_ok=True)


def call(method, path, body=None, ctype="application/json"):
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{BASE}/{path}", data=data, method=method, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def legs_from_lot():
    """Bearings (DD.MMSS) and distances round the OSM lot, in PNG94 / UTM 55S."""
    ring = json.load(open(os.path.join(DATA, "lae-lot.geojson")))["features"][0]["geometry"]["coordinates"][0]
    a, b = osr.SpatialReference(), osr.SpatialReference()
    a.ImportFromEPSG(4326); b.ImportFromEPSG(32755)
    a.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER); b.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(a, b)
    xy = [tr.TransformPoint(*p)[:2] for p in ring]
    out = []
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        b = math.degrees(math.atan2(x1 - x0, y1 - y0)) % 360
        d, m = int(b), (b - int(b)) * 60
        s = round((m - int(m)) * 60)
        mm, s = (int(m) + 1, 0) if s == 60 else (int(m), s)
        out.append(f"{d}.{mm:02d}{s:02d} {math.hypot(x1 - x0, y1 - y0):.2f}")
    return "\n".join(out), round(xy[0][0], 2), round(xy[0][1], 2)


legs, e0, n0 = legs_from_lot()
L = lambda n: n + ".geojson"
R = lambda n: n
# kit: (inputs, export.map with-dict)
SPEC = {
    "survey-plan": ({"legs": legs, "start_e": e0, "start_n": n0, "lots": L("lae-lot"), "interval": 50},
                    {"basemap": "osm", "title": "Survey plan: commercial lot, Lae (PNG94 / UTM 55S)", "subtitle": "Bearings and distances from the OSM lot outline, traverse adjusted by Bowditch"}),
    "power-corridor": ({"lines": L("power-lines"), "features": L("power-buildings"), "towers": L("power-towers")},
                       {"basemap": "esri-imagery", "title": "Transmission line corridor, Lae", "subtitle": "Easement 20 m, clearance 50 m, consultation 100 m from the mapped line"}),
    "petroleum-leases": ({"tenures": L("hela-licences"), "name_field": "licence", "expiry_field": "expiry", "constraints": L("hela-villages"), "wells": L("hela-wells"), "ends": L("hela-ends")},
                         {"basemap": "esri-topo", "title": "Petroleum licences and constraints, Hides, Hela Province", "subtitle": "Licence blocks and wells are illustrative; villages from OpenStreetMap"}),
    "mine-volumes": ({"before": R("srtm-2000"), "after": R("copernicus-2013"), "tenements": L("oktedi-lease"), "expiry_field": "expiry"},
                     {"basemap": "esri-imagery", "title": "Cut and fill, Ok Tedi (SRTM 2000 to Copernicus DEM)", "subtitle": "Surface change in metres; lease outline is illustrative"}),
    "harvest-planning": ({"coupes": L("bulolo-coupes"), "streams": L("bulolo-streams"), "ends": L("bulolo-ends")},
                         {"basemap": "topo", "title": "Net harvest area, Bulolo, Morobe Province", "subtitle": "Slopes under 30° outside 50 m stream buffers; coupes are illustrative"}),
    "maritime-watch": ({"pings": L("huon-ais"), "vessel_field": "mmsi", "time_field": "t", "cell_m": 1500},
                       {"basemap": "esri-imagery", "title": "Vessel traffic and events, Huon Gulf", "subtitle": "Sample AIS tracks (simulated) off the Port of Lae"}),
    "aerodrome-safeguarding": ({"runway": L("nadzab-runway"), "code": "4", "elevation": 72, "obstacles": L("nadzab-obstacles"), "top_field": "top"},
                               {"basemap": "topo", "title": "Obstacle limitation surfaces, Nadzab (AYNZ)", "subtitle": "ICAO Annex 14, code 4 precision runway; obstacle heights assumed"}),
    "delivery-routes": ({"network": L("lae-roads"), "facilities": L("lae-depot"), "bands": "5, 10, 15", "stops": L("lae-stops")},
                        {"basemap": "esri-dark", "title": "Delivery reach and route, Lae", "subtitle": "Drive time from the port depot on OpenStreetMap roads"}),
    "urban-planning": ({"zones": L("lae-zones"), "zone_field": "zone", "homes": L("lae-homes"), "parks": L("lae-parks")},
                       {"basemap": "esri-dark", "title": "Land use, density and park access, Lae", "subtitle": "OpenStreetMap land use and buildings; 400 m walk to green space"}),
    "rural-access": ({"settlements": L("morobe-villages"), "services": L("morobe-services")},
                     {"basemap": "esri-topo", "title": "Distance to health and education, Morobe highlands", "subtitle": "Villages, clinics and schools from OpenStreetMap"}),
    "asset-register": ({"assets": L("lae-assets-2026"), "installed_field": "installed", "inspected_field": "inspected", "condition_field": "condition", "criticality_field": "criticality", "before": L("lae-assets-2025"), "id_field": "id"},
                       {"basemap": "esri-dark", "title": "Asset risk and inspections, Lae", "subtitle": "Locations from OpenStreetMap; register attributes are illustrative"}),
    "el-nino-drought": ({"area": L("png-mainland"), "observed": R("chirps-ond-2015"), "normal": R("chirps-ond-normal-1991-2020")},
                        {"basemap": "esri-dark", "title": "El Niño 2015: October to December rainfall, Papua New Guinea", "subtitle": "CHIRPS v3 percent of the 1991 to 2020 normal, with NOAA ONI"}),
}



# Pass 2: industry symbology on the kit's own outputs (literal layer ids), then the finished map.
def U(field, classes, caption="", opacity=0.85, width=None, size=None, labels=None, outline=None):
    s = {"visible": True, "opacity": opacity, "symbology": {"kind": "unique", "field": field, "caption": caption,
         "classes": [{"value": v, "color": c, "label": t} for v, c, t in classes], "other": "#7f8c98", "othersCount": 0}}
    if width: s["line"] = {"width": width}
    if size: s["point"] = {"size": size}
    if outline: s["outline"] = outline
    if labels: s["labels"] = {"on": True, "color": "#f2f5f7", "haloColor": "#0f151b", **labels}
    return s


def S(color, opacity=0.9, width=None, size=None, labels=None, outline=None, fill=True):
    s = {"visible": True, "opacity": opacity, "symbology": {"kind": "single", "color": color}}
    if width: s["line"] = {"width": width}
    if size: s["point"] = {"size": size}
    if outline: s["outline"] = outline
    if not fill: s["fill"] = {"fill": False}
    if labels: s["labels"] = {"on": True, "color": "#f2f5f7", "haloColor": "#0f151b", **labels}
    return s


YN = lambda yes, no, ty, tn: [(1, yes, ty), (0, no, tn)]
# kit: (layers bottom to top as (id fragment, style or None to keep), extra export.map params)
STYLE = {
    "survey-plan": ([("grid-epsg", S("#5b6976", 0.7, width=0.6, labels={"field": "label", "size": 9})),
                     ("lot-bearings", S("#ffd166", 1, width=2.6, labels={"field": "bearing", "field2": "distance_m", "suffix2": " m", "size": 11, "font": "bold", "overlap": True, "placement": "point"})),
                     ("traverse-stations", S("#ffffff", 1, size=6, labels={"field": "station", "size": 10}))],
                    {"extent": [147.00095, -6.72820, 147.00330, -6.72650], "exact": True, "rasters": []}),
    "power-corridor": ([("corridor-zones", U("zone", [("consultation", "#4cc9f0", "Consultation, 100 m"), ("clearance", "#ffb703", "Vegetation clearance, 50 m"), ("easement", "#e63946", "Easement, 20 m")], "", 0.5)),
                        ("@power-lines.geojson", S("#ffffff", 1, width=1.8)),
                        ("spans", U("too_long", YN("#ff5d8f", "#ffffff", "Span over limit", "Span within limit"), "", 1, width=1.6)),
                        ("tower-inventory", U("structure", [("terminal", "#ff5d8f", "Terminal tower"), ("angle", "#ffb703", "Angle tower"), ("suspension", "#ffffff", "Suspension tower")], "", 1, size=9))],
                       {"extent": [146.950, -6.685, 146.982, -6.657], "inset": "tr"}),
    "petroleum-leases": ([("tenure-check", U("status", [("no expiry date", "#2a9d8f", "Licence block")], "", 0.35, outline={"color": "#2a9d8f", "width": 2}, labels={"field": "licence", "size": 12, "font": "bold"})),
                          ("@hela-villages.geojson", S("#f4a261", 0.9)),
                          ("tenure-overlaps", U("kind", [("tenure overlap", "#e63946", "Licence overlap"), ("constraint overlap", "#ffb703", "Village inside a licence")], "", 0.85)),
                          ("least-cost-route", S("#00e5ff", 1, width=3)),
                          ("well-site", U("too_close", YN("#e63946", "#ffffff", "Well too close", "Well spacing OK"), "", 1, size=10))], {}),
    "harvest-planning": ([("@bulolo-streams.geojson", S("#4cc9f0", 1, width=1.4)),
                          ("coupe-net", S("#52b788", 0.55, outline={"color": "#1b4332", "width": 2}, labels={"field": "coupe", "size": 13, "font": "bold"})),
                          ("least-cost-route", S("#e63946", 1, width=3))],
                         {"extent": [146.600, -7.240, 146.703, -7.160], "inset": "tr", "rasters": []}),
    "maritime-watch": ([("ais-density", None),
                        ("vessel-tracks", S("#ffffff", 0.55, width=0.9)),
                        ("loitering-events", S("#ff006e", 1, size=12))], {}),
    "aerodrome-safeguarding": ([("obstacle-limitation", U("surface", [("Conical", "#8ecae6", "Conical surface"), ("Inner horizontal", "#219ebc", "Inner horizontal, 45 m"), ("Approach (runway end 1)", "#ffb703", "Approach, runway 09"), ("Approach (runway end 2)", "#fb8500", "Approach, runway 27")], "ICAO Annex 14 surfaces", 0.4, outline={"color": "#023047", "width": 1})),
                                ("@nadzab-runway.geojson", S("#ffffff", 1, width=4)),
                                ("obstacle-check", U("penetrates", YN("#e63946", "#80ed99", "Penetrates a surface", "Clear of all surfaces"), "", 1, size=6))], {}),
    "delivery-routes": ([("service-areas", U("band", [("0 to 5 min", "#80ed99", "0 to 5 min"), ("5 to 10 min", "#ffd166", "5 to 10 min"), ("10 to 15 min", "#ef476f", "10 to 15 min")], "Drive time from the depot", 0.9, width=1.6)),
                         ("optimised-route", S("#00e5ff", 1, width=3.5)),
                         ("stops-in-order", S("#ffffff", 1, size=10, labels={"field": "visit", "size": 11, "font": "bold"}))], {}),
    "urban-planning": ([("zoning-summary", U("zone", [("residential", "#f4a261", "Residential"), ("commercial", "#4361ee", "Commercial"), ("retail", "#7209b7", "Retail"), ("industrial", "#8d99ae", "Industrial"), ("recreation ground", "#52b788", "Recreation"), ("religious", "#e9c46a", "Religious"), ("cemetery", "#6c757d", "Cemetery")], "", 0.6)),
                        ("green-space", U("within_walk", YN("#80ed99", "#ef476f", "Home within 400 m of a park", "Home beyond 400 m"), "", 1, size=4))], {}),
    "rural-access": ([("service-access", {"visible": True, "opacity": 1, "point": {"size": 9},
                      "symbology": {"kind": "graduated", "field": "nearest_km", "caption": "Straight line to the nearest clinic or school", "unit": "km",
                                    "min": 0, "breaks": [1, 2, 3, 5, 10], "colors": ["#1a9850", "#91cf60", "#fee08b", "#fc8d59", "#d73027"]},
                      "labels": {"on": False}})], {"rasters": []}),
    "mine-volumes": ([("tenure-check", S("#ffffff", 1, outline={"color": "#ffffff", "width": 2}, fill=False))], {"rasters": ["elevation-change"]}),
    "el-nino-drought": ([("@png-mainland.geojson", S("#ffffff", 1, outline={"color": "#ffffff", "width": 1.5}, fill=False))], {"rasters": ["rainfall-anomaly-class"]}),
    "asset-register": ([("asset-register", U("risk_class", [("high", "#e63946", "High risk"), ("medium", "#ffb703", "Medium risk"), ("low", "#52b788", "Low risk")], "Condition x criticality", 1, size=7)),
                        ("change-alerts", U("change", [("added", "#00e5ff", "Added since 2025"), ("changed", "#ff00ff", "Changed since 2025")], "", 1, size=12, fill=None) if False else U("change", [("added", "#00e5ff", "Added since 2025"), ("changed", "#ff00ff", "Changed since 2025")], "", 0.9, size=13))], {}),
}


TITLES = {'survey-plan': {'grid-epsg': 'PNG94 / UTM 55S grid, 50 m', 'lot-bearings': 'Lot boundary: bearing and distance', 'traverse-stations': 'Traverse stations, adjusted'}, 'power-corridor': {'corridor-zones': 'Corridor zones', 'power-lines': 'Transmission line (OSM)', 'tower-inventory': 'Towers', 'spans': 'Spans'}, 'petroleum-leases': {'tenure-check': 'Petroleum licences (illustrative)', 'hela-villages': 'Villages (OSM)', 'tenure-overlaps': 'Overlaps', 'least-cost-route': 'Pipeline route, least cost', 'well-site': 'Wells (illustrative)'}, 'mine-volumes': {'tenure-check': 'Mining lease (illustrative)'}, 'harvest-planning': {'bulolo-streams': 'Streams (OSM)', 'coupe-net': 'Coupes, net harvest area', 'least-cost-route': 'Haul road, least cost'}, 'maritime-watch': {'ais-density': 'AIS reports per 1.5 km cell', 'vessel-tracks': 'Vessel tracks (simulated)', 'loitering-events': 'Loitering events'}, 'aerodrome-safeguarding': {'obstacle-limitation': 'Obstacle limitation surfaces', 'nadzab-runway': 'Runway 09/27', 'obstacle-check': 'Obstacles (heights assumed)'}, 'delivery-routes': {'service-areas': 'Drive time', 'optimised-route': 'Optimised delivery route', 'stops-in-order': 'Stops, in visit order'}, 'urban-planning': {'zoning-summary': 'Land use (OSM)', 'green-space': 'Homes and park access'}, 'rural-access': {'service-access': 'Villages by distance to services'}, 'asset-register': {'asset-register': 'Asset risk', 'change-alerts': 'Register changes'}, 'el-nino-drought': {'png-mainland': 'Study area'}}


def style_pass(kit, run, look, text):
    if kit not in STYLE:
        return None
    layers, extra = STYLE[kit]
    outs = run.get("layers", [])
    ids, styles = [], {}
    for frag, st in layers:
        lid = frag[1:] if frag.startswith("@") else next((o for o in outs if frag in o), None)
        if not lid:
            print(kit, "no output for", frag)
            continue
        ids.append(lid)
        if st:
            styles[lid] = st
    extra = dict(extra)
    want = extra.pop("rasters", None)
    rasters = [x for x in run.get("rasters", []) if "dem" not in x and (want is None or any(k in x for k in want))]
    edit = {}
    for i in ids:
        keys = sorted((k for k in TITLES.get(kit, {}) if k in i), key=len)
        if keys:
            edit[i] = {"title": TITLES[kit][keys[-1]]}
    w = {**look, **extra, "legend_edit": edit, "name": f"{kit}-pro-dark", "layers": ids + rasters, "size": "1600x1100", "dpi": 150, "legend_title": "Legend", "theme": "dark"}
    steps = []
    if styles:
        steps.append({"id": "style", "use": "style.apply", "with": {"styles": styles, "save": False}})
    steps.append({"id": "map", "use": "export.map", "with": w})
    return {"recipe": f"kit-{kit}-styled", "title": f"{kit} styled", "steps": steps}


tmp = tempfile.mkdtemp(prefix="gx-maps-")
data = os.path.join(tmp, "data")
os.makedirs(data)
for f in os.listdir(DATA):
    if f.endswith(".geojson") or (f.endswith(".tif") and not f.startswith("chirps-ond-1") and not f.startswith("chirps-ond-20")) or f in ("chirps-ond-2015.tif",):
        shutil.copy(os.path.join(DATA, f), data)
srv = subprocess.Popen([os.path.join(ROOT, "target/release/geospax-server"), "--data", data, "--state-dir", os.path.join(tmp, "state"), "--web", os.path.join(ROOT, "web/dist"), "--port", str(PORT), "--no-device-mounts", "--no-triggers"], stdout=open(os.path.join(tmp, "server.log"), "w"), stderr=subprocess.STDOUT)
try:
    for _ in range(120):
        try:
            if call("GET", "api/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.5)
    time.sleep(2)
    shots = []
    for kit, (inputs, look) in SPEC.items():
        if ONLY and kit not in ONLY:
            continue
        text = open(os.path.join(ROOT, "recipes", f"kit-{kit}.yaml"), encoding="utf-8").read()
        m = re.search(r"(    use: export\.map\n    with: \{)(.*)\}\n", text)
        w = re.sub(r'title: ("[^"]*"|[^,}]*)', "", m.group(2)).rstrip(", ")
        extra = ", ".join(f"{k}: {json.dumps(v)}" for k, v in look.items())
        text = text[: m.start()] + m.group(1) + w + ", " + extra + ', size: "1600x1100", dpi: 150, legend_title: "Legend", theme: dark }\n' + text[m.end():]
        if kit == "el-nino-drought":  # all of PNG is past dem.fetch's 120 km limit: a 1 km DEM made by the data script
            text = re.sub(r"\n  - id: dem\n    use: dem\.fetch\n(    when: [^\n]*\n)?    with: [^\n]*\n", "\n", text).replace("dem: dem", "dem: png-dem-1km")
        if kit == "petroleum-leases":  # a buried pipeline climbs steeper ground than a haul road
            text = text.replace("tool: gsx/route-suitability, params: { ", "tool: gsx/route-suitability, params: { max_grade_deg: 20, ")
        rid = f"kit-{kit}-showcase"
        text = re.sub(r"^recipe: .*$", f"recipe: {rid}", text, flags=re.M)
        s, j = call("POST", "api/recipes?approve=code", text.encode(), "text/yaml")
        if "error" in j:
            print(kit, "load failed", j["error"])
            continue
        s, run = call("POST", f"api/recipes/{rid}/run", {"inputs": inputs})
        r = {}
        for _ in range(1200):
            r = call("GET", f"api/runs/{run['id']}")[1]
            if r.get("status") in ("done", "failed"):
                break
            time.sleep(0.5)
        bad = [f"{x['id']}: {'; '.join(x.get('why') or [])}" for x in r.get("steps", []) if x.get("status") == "failed"]
        print(kit, r.get("status"), "; ".join(bad)[:300], (r.get("error") or "")[:400])
        rec = style_pass(kit, r, look, text)
        if rec and r.get("status") == "done":
            s, j = call("POST", "api/recipes?approve=code", json.dumps(rec).encode(), "text/yaml")
            if "error" in j:
                print(kit, "style load failed", j["error"])
            else:
                s, run = call("POST", f"api/recipes/{rec['recipe']}/run", {"inputs": {}})
                for _ in range(1200):
                    r2 = call("GET", f"api/runs/{run['id']}")[1]
                    if r2.get("status") in ("done", "failed"):
                        break
                    time.sleep(0.5)
                print(kit, "styled", r2.get("status"), (r2.get("error") or "")[:300], "; ".join(f"{x['id']}: {'; '.join(x.get('why') or [])}" for x in r2.get("steps", []) if x.get("status") == "failed")[:300])
        for root, _, files in os.walk(os.path.join(tmp, "state")):
            for fn in files:
                if fn.endswith(".png") and run["id"] in root:
                    shutil.copy(os.path.join(root, fn), os.path.join(OUT, f"{kit}-map-pro-dark.png"))
        shots.append({"kit": kit, "basemap": look["basemap"], "layers": r.get("layers", []), "rasters": r.get("rasters", [])})
    json.dump(shots, open(os.path.join(OUT, "shots.json"), "w"), indent=1)
    if os.environ.get("GX_KEEP"):
        print("server left running at", BASE, "pid", srv.pid)
        srv = None
finally:
    if srv:
        srv.terminate()
