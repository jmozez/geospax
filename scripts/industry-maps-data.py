#!/usr/bin/env python3
"""Real inputs for the industry showcase maps (scripts/make-industry-maps.py), cached in a folder.

OpenStreetMap through Overpass (ODbL), CHIRPS v3 rainfall (UCSB CHC), SRTM through the AWS terrain tiles.
Where no public layer exists (licence blocks, coupes, an asset register, AIS), the inputs are drawn here
from real places and marked illustrative in the map captions.

  python3 scripts/industry-maps-data.py <folder>
"""
import json, math, os, random, subprocess, sys, time, urllib.parse, urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else "industry-data"
os.makedirs(OUT, exist_ok=True)
random.seed(1975)
UA = {"User-Agent": "GeoSpaX showcase maps (https://github.com/jmozez/geospax)"}


def overpass(q, name):
    path = os.path.join(OUT, f"osm-{name}.json")
    if not os.path.exists(path):
        body = urllib.parse.urlencode({"data": f"[out:json][timeout:120];{q}out geom;"}).encode()
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request("https://overpass-api.de/api/interpreter", body, UA), timeout=180) as r:
                    open(path, "wb").write(r.read())
                break
            except Exception as e:
                print("  overpass retry", name, e)
                time.sleep(20)
    return json.load(open(path))["elements"]


def feats(els, keep=lambda t: True, polygon=False, props=lambda t: t):
    out = []
    for e in els:
        t = e.get("tags", {})
        if not keep(t):
            continue
        if e["type"] == "node":
            g = {"type": "Point", "coordinates": [e["lon"], e["lat"]]}
        elif e["type"] == "way" and "geometry" in e:
            c = [[p["lon"], p["lat"]] for p in e["geometry"]]
            if polygon:
                if len(c) < 4 or c[0] != c[-1]:
                    continue
                g = {"type": "Polygon", "coordinates": [c]}
            else:
                g = {"type": "LineString", "coordinates": c}
        else:
            continue
        out.append({"type": "Feature", "properties": props(t), "geometry": g})
    return out


def save(name, fs):
    json.dump({"type": "FeatureCollection", "features": fs}, open(os.path.join(OUT, name + ".geojson"), "w"))
    print(f"  {name}: {len(fs)} features")


def centroid(f):
    g = f["geometry"]
    c = g["coordinates"][0] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "LineString" else [g["coordinates"]]
    return [sum(p[0] for p in c) / len(c), sum(p[1] for p in c) / len(c)]


def pt(lon, lat, **p):
    return {"type": "Feature", "properties": p, "geometry": {"type": "Point", "coordinates": [lon, lat]}}


def poly(coords, **p):
    return {"type": "Feature", "properties": p, "geometry": {"type": "Polygon", "coordinates": [coords + [coords[0]]]}}


def box(w, s, e, n, **p):
    return poly([[w, s], [e, s], [e, n], [w, n]], **p)


# --------------------------------------------------------------- Lae: roads, buildings, land use, services
print("Lae")
LAE = "(-6.755,146.96,-6.67,147.04)"
els = overpass(f'(way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|service)$"]{LAE};);', "lae-roads")
speed = {"trunk": 60, "primary": 50, "secondary": 40, "tertiary": 40, "unclassified": 30, "residential": 25, "service": 15}
save("lae-roads", feats(els, props=lambda t: {"name": t.get("name", ""), "highway": t["highway"], "speed_kmh": speed[t["highway"]]}))
els = overpass(f'(way["building"](-6.745,146.975,-6.70,147.02););', "lae-buildings")
b = feats(els, polygon=True, props=lambda t: {"building": t.get("building", "yes")})
save("lae-homes", [pt(*centroid(f), kind=f["properties"]["building"]) for f in b])
els = overpass(f'(way["landuse"]{LAE};way["leisure"~"park|pitch|golf_course|nature_reserve"]{LAE};);', "lae-landuse")
lu = feats(els, polygon=True, keep=lambda t: "landuse" in t, props=lambda t: {"zone": t["landuse"].replace("_", " ")})
save("lae-zones", lu)
save("lae-parks", feats(els, polygon=True, keep=lambda t: t.get("leisure") in ("park", "pitch", "golf_course", "nature_reserve") or t.get("landuse") in ("grass", "recreation_ground", "village_green"), props=lambda t: {"name": t.get("name", "")}))
els = overpass(f'(node["amenity"~"school|clinic|hospital|pharmacy|marketplace|fuel|bank"]{LAE};);', "lae-amenities")
am = feats(els, props=lambda t: {"name": t.get("name", t["amenity"]), "amenity": t["amenity"]})
depot = pt(146.9935, -6.7330, name="Depot (Lae port)")
stops = [f for f in am if f["properties"]["amenity"] in ("clinic", "hospital", "pharmacy") and f["properties"]["name"] not in ("clinic", "hospital", "pharmacy")][:12]
save("lae-depot", [depot])
save("lae-stops", [depot] + [pt(*f["geometry"]["coordinates"], name=f["properties"]["name"]) for f in stops])

# --------------------------------------------------------------- Lae: street assets (illustrative register)
els = overpass('(node["power"~"pole|tower"](-6.74,146.98,-6.71,147.02);node["highway"="street_lamp"](-6.74,146.98,-6.71,147.02);node["man_made"~"water_tower|storage_tank|mast"](-6.75,146.97,-6.70,147.03););', "lae-assets")
assets, before = [], []
if len(els) < 60:  # few street assets are mapped in Lae, so register the mapped buildings as facilities
    els += [{"lon": c[0], "lat": c[1], "tags": {"man_made": "facility"}} for c in (centroid(f) for f in b[::6])]
for i, e in enumerate(els[:400]):
    t = e.get("tags", {})
    kind = t.get("power") or t.get("highway") or t.get("man_made")
    inst = random.randint(1978, 2022)
    cond = min(5, max(1, round((2026 - inst) / 10 + random.gauss(0, 0.8))))
    crit = {"tower": 5, "water_tower": 5, "storage_tank": 4, "mast": 3, "pole": 3, "street_lamp": 2, "facility": 3}.get(kind, 2)
    insp = 2026 - min(12, int(random.expovariate(1 / 3)))
    p = {"id": f"LAE-{i + 1:04d}", "type": kind.replace("_", " "), "installed": inst, "inspected": f"{insp}-{random.randint(1, 12):02d}-15", "condition": cond, "criticality": crit}
    assets.append(pt(e["lon"], e["lat"], **p))
    if random.random() > 0.08:
        q = dict(p, condition=max(1, cond - (1 if random.random() < 0.15 else 0)))
        before.append(pt(e["lon"], e["lat"], **q))
save("lae-assets-2026", assets)
save("lae-assets-2025", before)

# --------------------------------------------------------------- Nadzab airport: runway and obstacles
print("Nadzab")
els = overpass('(way["aeroway"="runway"](-6.59,146.70,-6.55,146.75););', "nadzab-runway")
rw = max(feats(els), key=lambda f: len(f["geometry"]["coordinates"]) and abs(f["geometry"]["coordinates"][0][0] - f["geometry"]["coordinates"][-1][0]))
c = rw["geometry"]["coordinates"]
save("nadzab-runway", [{"type": "Feature", "properties": {"name": "Nadzab (Tomodachi) runway 09/27"}, "geometry": {"type": "LineString", "coordinates": [c[0], c[-1]]}}])
els = overpass('(node["power"="tower"](-6.65,146.60,-6.50,146.86);node["man_made"~"mast|tower|communications_tower"](-6.65,146.60,-6.50,146.86);way["building"](-6.60,146.68,-6.55,146.78););', "nadzab-obstacles")
obs = []
for f in feats(els, polygon=False):
    lon, lat = centroid(f)
    t = 35 if f["geometry"]["type"] == "Point" else 8
    obs.append(pt(lon, lat, kind="tower or mast" if t == 35 else "building", top=round(72 + t + random.uniform(-2, 6), 1)))
save("nadzab-obstacles", obs)

# --------------------------------------------------------------- Energy: the Ramu grid line into Lae
print("power line")
els = overpass('(way["power"="line"](-6.72,146.86,-6.66,146.98);node["power"="tower"](-6.72,146.86,-6.66,146.98);way["building"](-6.72,146.86,-6.66,146.98););', "power")
lines = [f for f in feats(els, keep=lambda t: t.get("power") == "line", props=lambda t: {"name": t.get("name", ""), "voltage": t.get("voltage", "")})]
save("power-lines", lines)
save("power-towers", [pt(e["lon"], e["lat"], ref=e.get("tags", {}).get("ref", "")) for e in els if e["type"] == "node"])
save("power-buildings", [pt(*centroid(f), kind="building") for f in feats(els, polygon=True, keep=lambda t: "building" in t)])

# --------------------------------------------------------------- Logging: Bulolo, streams and roads
print("Bulolo")
els = overpass('(way["waterway"~"river|stream"](-7.26,146.58,-7.14,146.72);way["highway"](-7.26,146.58,-7.14,146.72););', "bulolo")
save("bulolo-streams", feats(els, keep=lambda t: "waterway" in t, props=lambda t: {"name": t.get("name", ""), "waterway": t["waterway"]}))
coupes = []
for i, (x, y) in enumerate([(146.615, -7.175), (146.640, -7.175), (146.665, -7.175), (146.615, -7.200), (146.640, -7.200), (146.665, -7.200)]):
    coupes.append(box(x, y - 0.022, x + 0.023, y, coupe=f"C{i + 1}", year=2027 + i // 3))
save("bulolo-coupes", coupes)
save("bulolo-ends", [pt(146.640, -7.205, name="Bulolo sawmill road"), pt(146.672, -7.186, name="Landing C3")])

# --------------------------------------------------------------- Petroleum: Hides, Hela Province
print("Hela")
els = overpass('(node["place"~"village|hamlet|town"](-6.2,142.6,-5.8,143.1);way["boundary"="protected_area"](-6.2,142.6,-5.8,143.1););', "hela")
save("hela-villages", [poly([[e["lon"] + 0.0025 * math.cos(a / 8 * math.tau), e["lat"] + 0.0025 * math.sin(a / 8 * math.tau)] for a in range(8)], name=e["tags"].get("name", "village")) for e in els if e["type"] == "node"])
blocks = [box(142.70, -6.06, 142.86, -5.92, licence="PDL A (illustrative)", expiry="2031-06-30"),
          box(142.84, -6.10, 143.00, -5.96, licence="PDL B (illustrative)", expiry="2027-03-31"),
          box(142.62, -6.18, 142.78, -6.04, licence="PPL C (illustrative)", expiry="2026-09-30")]
save("hela-licences", blocks)
save("hela-wells", [pt(142.760 + random.uniform(-0.04, 0.06), -5.99 + random.uniform(-0.05, 0.05), well=f"W-{i + 1}") for i in range(9)])
save("hela-ends", [pt(142.745, -5.985, name="Gas conditioning plant"), pt(142.93, -6.06, name="Pipeline tie-in")])

# --------------------------------------------------------------- Mining: Ok Tedi, two real surfaces
print("Ok Tedi")
W, S, E, N = 141.10, -5.25, 141.18, -5.17
hgt = os.path.join(OUT, "S06E141.hgt")
if not os.path.exists(os.path.join(OUT, "srtm-2000.tif")):
    urllib.request.urlretrieve("https://elevation-tiles-prod.s3.amazonaws.com/skadi/S06/S06E141.hgt.gz", hgt + ".gz")
    subprocess.run(["gunzip", "-f", hgt + ".gz"], check=True)
    cop = "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S06_00_E141_00_DEM/Copernicus_DSM_COG_10_S06_00_E141_00_DEM.tif"
    for src, dst in [(hgt, "srtm-2000.tif"), (cop, "copernicus-2013.tif")]:
        subprocess.run(["gdalwarp", "-q", "-overwrite", "-t_srs", "EPSG:32754", "-te_srs", "EPSG:4326", "-te", str(W), str(S), str(E), str(N), "-tr", "30", "30", "-r", "bilinear", src, os.path.join(OUT, dst)], check=True)
    subprocess.run(["gdalwarp", "-q", "-overwrite", "-te", *subprocess.run(["python3", "-c", f"from osgeo import gdal;d=gdal.Open('{OUT}/srtm-2000.tif');g=d.GetGeoTransform();print(g[0],g[3]+g[5]*d.RasterYSize,g[0]+g[1]*d.RasterXSize,g[3])"], capture_output=True, text=True).stdout.split(), "-tr", "30", "30", os.path.join(OUT, "copernicus-2013.tif"), os.path.join(OUT, "copernicus-2013b.tif")], check=True)
    os.replace(os.path.join(OUT, "copernicus-2013b.tif"), os.path.join(OUT, "copernicus-2013.tif"))
save("oktedi-lease", [poly([[141.112, -5.235], [141.165, -5.240], [141.172, -5.190], [141.125, -5.180]], lease="Mining lease (illustrative outline)", expiry="2033-12-31")])

# --------------------------------------------------------------- Maritime: Huon Gulf sample AIS
print("Huon Gulf")
ais, t0 = [], 1_761_955_200
lanes = [((147.00, -6.74), (147.35, -7.10)), ((147.00, -6.74), (147.60, -6.80)), ((147.00, -6.74), (147.20, -6.95))]
for v in range(18):
    (x0, y0), (x1, y1) = random.choice(lanes)
    out = random.random() < 0.5
    n = 120
    loiter = v in (3, 11)
    gap = v in (7,)
    for k in range(n):
        f = k / n
        if out:
            f = 1 - f
        x = x0 + (x1 - x0) * f + random.gauss(0, 0.003)
        y = y0 + (y1 - y0) * f + random.gauss(0, 0.003)
        if loiter and 40 < k < 80:
            x, y = 147.18 + 0.004 * math.cos(k / 3) + random.gauss(0, 0.0008), -6.92 + 0.004 * math.sin(k / 3)
        if gap and 50 < k < 85:
            continue
        ais.append(pt(x, y, mmsi=f"55300{v:04d}", t=t0 + v * 1800 + k * 300))
save("huon-ais", ais)

# --------------------------------------------------------------- Rural: Menyamya, Morobe highlands
print("Morobe highlands")
els = overpass('(node["place"~"village|hamlet|town"](-7.40,145.85,-7.05,146.20);nwr["amenity"~"clinic|hospital|school|doctors"](-7.70,145.50,-6.80,146.60);nwr["healthcare"](-7.70,145.50,-6.80,146.60););', "morobe")
save("morobe-villages", [pt(e["lon"], e["lat"], name=e["tags"].get("name", "")) for e in els if "place" in e.get("tags", {})])
save("morobe-services", [pt(*(centroid(feats([e])[0]) if e["type"] != "node" else (e["lon"], e["lat"])), name=e["tags"].get("name", e["tags"].get("amenity", "service"))) for e in els if "place" not in e.get("tags", {})])

# --------------------------------------------------------------- Survey: a real lot in Lae (OSM outline)
print("survey lot")
els = overpass('(way["landuse"~"commercial|retail|industrial"](-6.735,146.99,-6.72,147.005););', "lae-lots")
lots = sorted(feats(els, polygon=True, props=lambda t: {"name": t.get("name", "Lot")}), key=lambda f: -len(f["geometry"]["coordinates"][0]))
lot = [f for f in lots if 4 <= len(f["geometry"]["coordinates"][0]) <= 9][:1] or lots[:1]
save("lae-lot", lot)

# --------------------------------------------------------------- Climate: CHIRPS v3 OND 2015 and its 1991-2020 normal
print("CHIRPS")
win = ["-projwin", "140.8", "-1.0", "156.2", "-11.8"]
url = "/vsicurl/https://data.chc.ucsb.edu/products/CHIRPS/v3.0/monthly/global/tifs/chirps-v3.0.{y}.{m:02d}.tif"
def season(y):
    f = os.path.join(OUT, f"chirps-ond-{y}.tif")
    if not os.path.exists(f):
        parts = []
        for m in (10, 11, 12):
            p = os.path.join(OUT, f"c-{y}-{m}.tif")
            subprocess.run(["gdal_translate", "-q", *win, url.format(y=y, m=m), p], check=True)
            parts.append(p)
        subprocess.run(["gdal_calc.py", "--quiet", "-A", parts[0], "-B", parts[1], "-C", parts[2], "--calc", "where((A<0)|(B<0)|(C<0),-9999,A+B+C)", "--NoDataValue=-9999", "--type=Float32", "--outfile", f], check=True)
        for p in parts:
            os.remove(p)
    return f
obs = season(2015)
norm = os.path.join(OUT, "chirps-ond-normal-1991-2020.tif")
if not os.path.exists(norm):
    yrs = [season(y) for y in range(1991, 2021)]
    import numpy as np
    from osgeo import gdal
    stack = np.stack([gdal.Open(y).ReadAsArray() for y in yrs]).astype("float32")
    mean = np.where((stack < 0).any(0), -9999, stack.mean(0))
    ref = gdal.Open(obs)
    d = gdal.GetDriverByName("GTiff").Create(norm, ref.RasterXSize, ref.RasterYSize, 1, gdal.GDT_Float32)
    d.SetGeoTransform(ref.GetGeoTransform()); d.SetProjection(ref.GetProjection())
    d.GetRasterBand(1).SetNoDataValue(-9999); d.GetRasterBand(1).WriteArray(mean); d = None
save("png-mainland", [box(141.0, -10.7, 151.0, -2.5, name="Papua New Guinea")])
print("done")

# --------------------------------------------------------------- a 1 km DEM of PNG (frost risk), from the AWS terrain tiles
dem = os.path.join(OUT, "png-dem-1km.tif")
if not os.path.exists(dem):
    import numpy as np
    from osgeo import gdal
    z = 7
    tx = lambda lon: int((lon + 180) / 360 * 2 ** z)
    ty = lambda lat: int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** z)
    xs, ys = range(tx(140.8), tx(156.2) + 1), range(ty(-1.0), ty(-11.8) + 1)
    mos = np.zeros((256 * len(ys), 256 * len(xs)), "float32")
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            p = os.path.join(OUT, f"t{z}-{x}-{y}.png")
            if not os.path.exists(p):
                urllib.request.urlretrieve(f"https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png", p)
            a = gdal.Open(p).ReadAsArray().astype("float32")
            mos[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = a[0] * 256 + a[1] + a[2] / 256 - 32768
    m = 2 * math.pi * 6378137 / 2 ** z
    x0, y0 = xs[0] * m - math.pi * 6378137, math.pi * 6378137 - ys[0] * m
    src = gdal.GetDriverByName("MEM").Create("", mos.shape[1], mos.shape[0], 1, gdal.GDT_Float32)
    src.SetGeoTransform((x0, m / 256, 0, y0, 0, -m / 256)); src.SetProjection("EPSG:3857"); src.GetRasterBand(1).WriteArray(np.maximum(mos, 0))
    gdal.Warp(dem, src, dstSRS="EPSG:4326", outputBounds=(140.8, -11.8, 156.2, -1.0), xRes=0.01, yRes=0.01, resampleAlg="bilinear")
    for f in os.listdir(OUT):
        if f.startswith(f"t{z}-"):
            os.remove(os.path.join(OUT, f))


# --------------------------------------------------------------- route ends on ground the route tool can join
def snap(name, bbox, avoid=None):
    """Moves each end to the nearest cell of the largest connected area under 11° (the route tool's
    limit is 12°), so a least-cost route exists in steep country."""
    import numpy as np
    from osgeo import gdal
    from scipy import ndimage
    w, s_, e, n = bbox
    t = f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S{math.ceil(-s_):02d}_00_E{int(w):03d}_00_DEM/Copernicus_DSM_COG_10_S{math.ceil(-s_):02d}_00_E{int(w):03d}_00_DEM.tif"
    d = gdal.Translate("", t, format="MEM", projWin=[w, n, e, s_])
    a = d.ReadAsArray().astype(float)
    g = d.GetGeoTransform()
    dy, dx = np.gradient(a, 30.8, 30.8 * math.cos(math.radians((s_ + n) / 2)))
    ok = ndimage.binary_erosion(np.degrees(np.arctan(np.hypot(dx, dy))) < 11, iterations=2)
    for v in json.load(open(os.path.join(OUT, avoid + ".geojson")))["features"] if avoid else []:
        ring = v["geometry"]["coordinates"][0]
        vx, vy = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
        yy, xx = np.indices(ok.shape)
        ok &= np.hypot(g[0] + (xx + 0.5) * g[1] - vx, g[3] + (yy + 0.5) * g[5] - vy) > 0.0045
    lab, _ = ndimage.label(ok, structure=np.ones((3, 3)))
    big = np.argmax(np.bincount(lab.ravel())[1:]) + 1
    rr, cc = np.nonzero(lab == big)
    path = os.path.join(OUT, name + ".geojson")
    fc = json.load(open(path))
    for f in fc["features"]:
        lon, lat = f["geometry"]["coordinates"]
        c0, r0 = (lon - g[0]) / g[1], (lat - g[3]) / g[5]
        k = np.argmin((cc - c0) ** 2 + (rr - r0) ** 2)
        f["geometry"]["coordinates"] = [g[0] + (cc[k] + 0.5) * g[1], g[3] + (rr[k] + 0.5) * g[5]]
    json.dump(fc, open(path, "w"))


snap("bulolo-ends", (146.618, -7.220, 146.686, -7.177))
snap("hela-ends", (142.76, -6.05, 142.92, -5.99), "hela-villages")
print("snapped")
