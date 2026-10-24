#!/usr/bin/env python3
"""Web services in the Explorer, end to end against a local mock server (no internet needed).

The mock speaks just enough of each protocol for GDAL and the engine: XYZ tiles, WMS 1.3.0
(GetCapabilities, GetMap), WMTS (GetCapabilities with a REST template), ArcGIS MapServer (?f=json,
/export) and FeatureServer (?f=json, /0/query?f=geojson), and OGC API Features (landing page,
conformance, collections, items), and a STAC API (collections, POST /search, a GeoTIFF asset served
with byte ranges), and an S3 bucket (ListObjects with folders; objects with byte ranges). Checks: each kind is added and lists its layers, map tiles come
back through the engine as images, features are downloaded for an area into a layer on the map, a
broken address is refused with a reason, a STAC collection is searched by area, date and cloud and its
asset is streamed and downloaded cut to an area (a job with the transfer gauge), cloud storage is browsed
folder by folder and its GeoTIFF and GeoJSON go on the map, and a server open to other devices
lets whoever has its token add services, refuses requests without it, and refuses new services when
started with --restricted.

    python3 scripts/test-services.py [--bin target/release/geospax-server]
"""
import argparse, json, os, struct, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
failed = []


def check(ok, msg):
    print(("  ok    " if ok else "  FAIL  ") + msg)
    if not ok:
        failed.append(msg)


def png(r, g, b):
    raw = b"".join(b"\x00" + bytes([r, g, b, 255]) * 256 for _ in range(256))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


TILE = png(30, 120, 200)
SCENE = {"path": None}  # the GeoTIFF the STAC asset points at (a sample raster), set in main()
STAC_ITEMS = [
    {"type": "Feature", "stac_version": "1.0.0", "id": f"S2_{d}", "collection": "sentinel-2-l2a", "bbox": [-180, -60, 180, 85],
     "geometry": {"type": "Polygon", "coordinates": [[[-180, -60], [180, -60], [180, 85], [-180, 85], [-180, -60]]]},
     "properties": {"datetime": f"2026-{d}T10:00:00Z", "eo:cloud_cover": c, "platform": "sentinel-2b"},
     "assets": {"red": {"href": "BASE/stac/scene.tif", "type": "image/tiff; application=geotiff; profile=cloud-optimized", "title": "Red", "roles": ["data"]},
                "thumbnail": {"href": "BASE/stac/thumb.png", "type": "image/png", "roles": ["thumbnail"]},
                "metadata": {"href": "BASE/stac/meta.xml", "type": "application/xml"}}}
    for d, c in (("09-01", 5.0), ("10-01", 60.0), ("08-01", 12.0))]

FIXTURE = os.path.join(HERE, "fixtures", "overture-buildings.parquet")


def gh_files():
    """The mock GitHub repository o/r on branch main: path -> bytes."""
    rec = lambda f, new: open(os.path.join(ROOT, "recipes", f), encoding="utf-8").read().replace(f"recipe: {f[:-5]}", f"recipe: {new}", 1).encode()
    return {"data/plots.geojson": json.dumps(FEATURES).encode(), "data/scene.tif": open(SCENE["path"], "rb").read(),
            "recipes/kriging.yaml": rec("interpolate-samples.yaml", "gh-kriging"), "recipes/py-stats.yaml": rec("python-spatial-stats.yaml", "gh-py-stats"),
            "README.md": b"# data"}  # 3 row groups of 4 buildings


def bucket(name="geo"):
    """The mock S3 buckets: "geo" (a scene and a GeoJSON) and "ovt" (Overture's layout, two releases)."""
    if name == "ovt":
        part = open(FIXTURE, "rb").read()
        return {f"release/{r}/theme=buildings/type=building/part-00000.parquet": part for r in ("2026-01-01.0", "2026-09-17.0")}
    if name != "geo":
        return None
    return {"scene.tif": open(SCENE["path"], "rb").read(), "vectors/plots.geojson": json.dumps(FEATURES).encode(), "vectors/readme.txt": b"notes"}


FEATURES = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "id": i, "properties": {"name": f"plot {i}", "ha": i * 1.5}, "geometry": {"type": "Point", "coordinates": [145 + i * 0.1, -6 - i * 0.05]}} for i in range(1, 9)]}

WMS_CAPS = """<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms"><Service><Name>WMS</Name><Title>Mock</Title></Service>
<Capability><Request><GetCapabilities><Format>text/xml</Format><DCPType><HTTP><Get><OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="BASE/wms?"/></Get></HTTP></DCPType></GetCapabilities>
<GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="BASE/wms?"/></Get></HTTP></DCPType></GetMap></Request>
<Layer><Title>Root</Title><CRS>EPSG:3857</CRS><CRS>EPSG:4326</CRS>
<EX_GeographicBoundingBox><westBoundLongitude>-180</westBoundLongitude><eastBoundLongitude>180</eastBoundLongitude><southBoundLatitude>-85</southBoundLatitude><northBoundLatitude>85</northBoundLatitude></EX_GeographicBoundingBox>
<Layer queryable="0"><Name>forest:cover</Name><Title>Forest cover</Title><CRS>EPSG:3857</CRS><EX_GeographicBoundingBox><westBoundLongitude>-180</westBoundLongitude><eastBoundLongitude>180</eastBoundLongitude><southBoundLatitude>-85</southBoundLatitude><northBoundLatitude>85</northBoundLatitude></EX_GeographicBoundingBox></Layer>
<Layer queryable="0"><Name>roads</Name><Title>Roads</Title><CRS>EPSG:3857</CRS><EX_GeographicBoundingBox><westBoundLongitude>-180</westBoundLongitude><eastBoundLongitude>180</eastBoundLongitude><southBoundLatitude>-85</southBoundLatitude><northBoundLatitude>85</northBoundLatitude></EX_GeographicBoundingBox></Layer>
</Layer></Capability></WMS_Capabilities>"""

WMTS_CAPS = """<?xml version="1.0"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0"><Contents>
<Layer><ows:Title>Relief</ows:Title><ows:Identifier>relief</ows:Identifier><Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format>
<TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible</TileMatrixSet></TileMatrixSetLink>
<ResourceURL format="image/png" resourceType="tile" template="BASE/wmts/relief/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png"/></Layer>
</Contents></Capabilities>"""


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, ct="application/json", code=200):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.replace("BASE", f"http://127.0.0.1:{self.server.server_port}").encode()
        self.send_response(code)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def object(self, head):
        """An object of the mock S3 bucket, with byte ranges; None when the path is not one."""
        p = urlparse(self.path).path
        parts = unquote(p).lstrip("/").split("/", 1)
        if len(parts) < 2 or not parts[1] or bucket(parts[0]) is None:
            return None
        data = bucket(parts[0]).get(parts[1])
        if data is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes=") and not head:
            a, b = rng[6:].split("-")
            a, b = int(a), min(int(b) if b else len(data) - 1, len(data) - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
            chunk = data[a:b + 1]
        else:
            self.send_response(200)
            chunk = data
        self.send_header("Content-Length", str(len(chunk)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", "Mon, 01 Jan 2026 00:00:00 GMT")
        self.end_headers()
        if not head:
            self.wfile.write(chunk)
        return True

    def do_HEAD(self):
        if self.object(True):
            return
        if urlparse(self.path).path.startswith("/ghraw/o/r/main/"):
            data = gh_files().get(unquote(urlparse(self.path).path[len("/ghraw/o/r/main/"):]))
            self.send_response(200 if data is not None else 404)
            self.send_header("Content-Length", str(len(data or b"")))
            self.send_header("Accept-Ranges", "bytes")
            return self.end_headers()
        if urlparse(self.path).path == "/stac/scene.tif":
            self.send_response(200)
            self.send_header("Content-Type", "image/tiff")
            self.send_header("Content-Length", str(os.path.getsize(SCENE["path"])))
            self.send_header("Accept-Ranges", "bytes")
            return self.end_headers()
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if urlparse(self.path).path == "/stac/search":
            lte = body.get("query", {}).get("eo:cloud_cover", {}).get("lte", 100)
            lo, hi = (body.get("datetime", "../..").split("/") + [".."])[:2]
            feats = [f for f in STAC_ITEMS if f["properties"]["eo:cloud_cover"] <= lte and body.get("collections") == ["sentinel-2-l2a"]
                     and (lo == ".." or f["properties"]["datetime"] >= lo) and (hi == ".." or f["properties"]["datetime"] <= hi)]
            return self.send(json.dumps({"type": "FeatureCollection", "features": feats, "numberMatched": len(feats)}), "application/geo+json")
        self.send({"error": "not found"}, code=404)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k.lower(): v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        # GitHub's API (contents of a folder or a file) and raw file downloads, for the repository o/r
        base = f"http://127.0.0.1:{self.server.server_port}"
        if p == "/gh/repos/o/r":
            return self.send({"default_branch": "main", "full_name": "o/r"})
        if p.startswith("/gh/repos/o/r/contents"):
            files = gh_files()
            path = unquote(p[len("/gh/repos/o/r/contents"):]).strip("/")
            if q.get("ref") != "main":
                return self.send({"message": "No commit found for the ref"}, code=404)
            if path in files:
                return self.send({"type": "file", "name": path.split("/")[-1], "path": path, "size": len(files[path]), "download_url": f"{base}/ghraw/o/r/main/{path}"})
            pre = path + "/" if path else ""
            kids = {}
            for f, b in files.items():
                if f.startswith(pre):
                    head = f[len(pre):].split("/")[0]
                    kids[head] = "dir" if "/" in f[len(pre):] else "file"
            if not kids:
                return self.send({"message": "Not Found"}, code=404)
            return self.send([{"name": n, "path": pre + n, "type": t, "size": len(files.get(pre + n, b"")), "download_url": f"{base}/ghraw/o/r/main/{pre + n}" if t == "file" else None} for n, t in sorted(kids.items())])
        if p.startswith("/ghraw/o/r/main/"):
            data = gh_files().get(unquote(p[len("/ghraw/o/r/main/"):]))
            if data is None:
                return self.send({"error": "not found"}, code=404)
            rng = self.headers.get("Range")  # raw.githubusercontent.com serves byte ranges
            if rng and rng.startswith("bytes="):
                a_, b_ = rng[6:].split("-")
                a_, b_ = int(a_), min(int(b_) if b_ else len(data) - 1, len(data) - 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {a_}-{b_}/{len(data)}")
                chunk = data[a_:b_ + 1]
            else:
                self.send_response(200)
                chunk = data
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            return self.wfile.write(chunk)
        if p.strip("/") in ("geo", "ovt"):  # S3 ListObjects (path style): one level, folders as CommonPrefixes
            objs = bucket(p.strip("/"))
            prefix = q.get("prefix", "")
            keys = [k for k in objs if k.startswith(prefix)]
            files = [k for k in keys if "/" not in k[len(prefix):]]
            dirs = sorted({prefix + k[len(prefix):].split("/")[0] + "/" for k in keys if "/" in k[len(prefix):]})
            body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>geo</Name>"
            body += f"<Prefix>{prefix}</Prefix><KeyCount>{len(files) + len(dirs)}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>"
            body += "".join(f"<Contents><Key>{k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>{len(objs[k])}</Size></Contents>" for k in files)
            body += "".join(f"<CommonPrefixes><Prefix>{d}</Prefix></CommonPrefixes>" for d in dirs) + "</ListBucketResult>"
            return self.send(body, "application/xml")
        if self.object(False):
            return
        base = f"http://127.0.0.1:{self.server.server_port}"
        if p.startswith("/xyz/"):
            return self.send(TILE, "image/png")
        if p == "/wms":
            if q.get("request", "").lower() == "getcapabilities":
                return self.send(WMS_CAPS, "text/xml")
            if q.get("request", "").lower() == "getmap" and q.get("layers") in ("forest:cover", "roads"):
                return self.send(TILE, "image/png")
            return self.send("<ServiceException>bad</ServiceException>", "text/xml")
        if p == "/wmts":
            return self.send(WMTS_CAPS, "text/xml")
        if p.startswith("/wmts/relief/GoogleMapsCompatible/"):
            return self.send(TILE, "image/png")
        if p == "/arcgis/rest/services/Land/MapServer":
            return self.send({"mapName": "Land use", "layers": [{"id": 0, "name": "land"}]})
        if p == "/arcgis/rest/services/Land/MapServer/export":
            return self.send(TILE, "image/png")
        if p == "/arcgis/rest/services/Plots/FeatureServer":
            return self.send({"layers": [{"id": 0, "name": "plots"}]})
        if p == "/arcgis/rest/services/Plots/FeatureServer/0/query":
            return self.send(FEATURES, "application/geo+json")
        if p == "/stac/collections":
            return self.send({"collections": [{"id": "sentinel-2-l2a", "title": "Sentinel-2 Level-2A", "description": "Surface reflectance"}], "links": []})
        if p == "/stac/scene.tif":
            data = open(SCENE["path"], "rb").read()
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                a, b = rng[6:].split("-")
                a, b = int(a), min(int(b) if b else len(data) - 1, len(data) - 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
                chunk = data[a:b + 1]
            else:
                self.send_response(200)
                chunk = data
            self.send_header("Content-Type", "image/tiff")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            return self.wfile.write(chunk)
        # OGC API Features
        if p in ("/ogc", "/ogc/"):
            return self.send({"links": [
                {"href": f"{base}/ogc/conformance", "rel": "conformance", "type": "application/json"},
                {"href": f"{base}/ogc/collections", "rel": "data", "type": "application/json"}]})
        if p == "/ogc/conformance":
            return self.send({"conformsTo": ["http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core", "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson"]})
        if p == "/ogc/collections":
            return self.send({"collections": [{"id": "plots", "title": "Plots", "links": [{"href": f"{base}/ogc/collections/plots/items", "rel": "items", "type": "application/geo+json"}],
                                               "extent": {"spatial": {"bbox": [[144, -7, 147, -5]]}}}], "links": []})
        if p == "/ogc/collections/plots":
            return self.send({"id": "plots", "title": "Plots", "links": [{"href": f"{base}/ogc/collections/plots/items", "rel": "items", "type": "application/geo+json"}]})
        if p == "/ogc/collections/plots/items":
            return self.send(dict(FEATURES, numberMatched=len(FEATURES["features"]), numberReturned=len(FEATURES["features"]), links=[]), "application/geo+json")
        self.send({"error": "not found"}, code=404)


def call(base, method, path, timeout=60, body=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def start(bin, data, state, port, host="127.0.0.1", extra_env=None, restricted=False):
    env = dict(os.environ, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost", **(extra_env or {}))
    args = [bin, "--data", data, "--state-dir", state, "--port", str(port), "--no-device-mounts", "--no-triggers"]
    if host != "127.0.0.1":
        args += ["--host", host, "--token", "t0ken"] + (["--restricted"] if restricted else [])
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2)
            return p
        except Exception:
            time.sleep(0.5)
    raise SystemExit("the server did not start")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(ROOT, "target/release/geospax-server"))
    a = ap.parse_args()
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
        os.environ.pop(k, None)
    mock = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    m = f"http://127.0.0.1:{mock.server_port}"
    tmp = tempfile.mkdtemp(prefix="gx-services-")
    data = os.path.join(tmp, "data")
    os.makedirs(data)
    port = 18731
    base = f"http://127.0.0.1:{port}"
    srv = start(a.bin, data, os.path.join(tmp, "state"), port)
    try:
        pass
        cases = [
            ("xyz", f"{m}/xyz/{{z}}/{{x}}/{{y}}.png", "tiles", 1),
            ("wms", f"{m}/wms", "forest:cover", 2),
            ("wmts", f"{m}/wmts", "relief", 1),
            ("arcgis-map", f"{m}/arcgis/rest/services/Land/MapServer", "map", 1),
            ("arcgis-feature", f"{m}/arcgis/rest/services/Plots/FeatureServer", "0", 1),
            ("ogcapi", f"{m}/ogc", "plots", 1),
        ]
        for kind, url, layer, nlayers in cases:
            code, body, _ = call(base, "POST", f"/api/services?kind={kind}&url={quote(url, safe='')}")
            ok = code == 200
            check(ok, f"{kind}: added ({code} {body[:160].decode(errors='replace') if not ok else ''})")
            if not ok:
                continue
            sid = json.loads(body)["service"]["id"]
            code, body, _ = call(base, "GET", f"/api/services/{sid}/layers")
            ls = json.loads(body).get("layers", []) if code == 200 else []
            check(len(ls) == nlayers and any(l["id"] == layer for l in ls), f"{kind}: lists its layers ({[l['id'] for l in ls]})")
            if kind in ("arcgis-feature", "ogcapi"):
                code, body, _ = call(base, "POST", f"/api/services/{sid}/fetch?layer={quote(layer)}&bbox=144,-8,147,-5")
                r = json.loads(body) if body else {}
                check(code == 200 and r.get("features") == 8, f"{kind}: features for the area go on the map ({code} {r.get('features', r.get('error'))})")
            else:
                code, body, ct = call(base, "GET", f"/api/services/{sid}/tile/3/7/4.png?layer={quote(layer)}")
                check(code == 200 and body[:4] == b"\x89PNG", f"{kind}: a map tile comes back through the engine ({code} {ct})")
        # STAC: a catalog lists its collections; a search filters by area, date and cloud, newest first
        call(base, "POST", "/api/samples/png")
        sdir = os.path.join(tmp, "state", "samples", "png")
        SCENE["path"] = os.path.join(sdir, next(f for f in sorted(os.listdir(sdir)) if f.endswith(".tif")))
        code, body, _ = call(base, "POST", f"/api/services?kind=stac&url={quote(m + '/stac', safe='')}&title=Mock%20STAC")
        check(code == 200, f"stac: catalog added ({code} {body[:160].decode(errors='replace')})")
        stac_id = json.loads(body)["service"]["id"] if code == 200 else ""
        code, body, _ = call(base, "GET", f"/api/services/{stac_id}/layers")
        ls = json.loads(body).get("layers", []) if code == 200 else []
        check([(l["id"], l["type"]) for l in ls] == [("sentinel-2-l2a", "collection")], f"stac: lists its collections ({ls})")
        q = {"service": stac_id, "collection": "sentinel-2-l2a", "bbox": [140, -10, 150, 0], "datetime": "2026-08-15T00:00:00Z/2026-12-31T23:59:59Z", "max_cloud": 20, "limit": 10}
        code, body, _ = call(base, "POST", "/api/stac/search", body=q)
        items = json.loads(body).get("items", []) if code == 200 else []
        check([i["id"] for i in items] == ["S2_09-01"], f"stac: search by date and cloud ({code} {[i['id'] for i in items] or body[:200]})")
        q.update(datetime="", max_cloud=None)
        code, body, _ = call(base, "POST", "/api/stac/search", body=q)
        items = json.loads(body).get("items", []) if code == 200 else []
        check([i["id"] for i in items] == ["S2_10-01", "S2_09-01", "S2_08-01"], f"stac: newest first ({[i['id'] for i in items]})")
        it = items[0] if items else {"assets": [], "thumbnail": None}
        check([a["key"] for a in it["assets"]] == ["red"] and it["assets"][0]["cog"] and (it["thumbnail"] or "").endswith("thumb.png"),
              f"stac: GeoTIFF assets kept, thumbnail found, other assets left out ({it['assets']})")
        href = f"{m}/stac/scene.tif"
        code, body, _ = call(base, "POST", "/api/stac/add", body={"href": href, "id": "s2_red", "title": "Red", "stream": True})
        r = json.loads(body) if body else {}
        check(code == 200 and r.get("streamed") and r.get("rasters"), f"stac: an asset is streamed onto the map ({code} {r})")
        code, body, _ = call(base, "POST", "/api/stac/add", body={"href": href, "id": "s2_red_cut", "title": "Red (cut)", "stream": False, "bbox": [0, 0, 60, 40]})
        job = json.loads(body).get("job") if code == 200 else None
        j = {}
        for _ in range(120):
            if job is None:
                break
            j = json.loads(call(base, "GET", f"/api/jobs/{job}")[1])
            if j["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.25)
        rid = (j.get("result") or {}).get("rasters", [None])[0]
        out = (j.get("result") or {}).get("path", "")
        check(j.get("status") == "done" and rid and os.path.exists(out) and j.get("transfer") is None,
              f"stac: an asset is downloaded cut to an area, as a job ({j.get('status')} {j.get('message')} {out})")
        if rid:
            code, body, _ = call(base, "GET", f"/api/rasters/{rid}")
            b = (json.loads(body) if code == 200 else {}).get("bounds") or []
            check(code == 200 and b and b[0] >= -0.5 and b[2] <= 60.5 and b[3] <= 40.5, f"stac: the download covers the area asked for ({b})")
        # cloud storage: an S3 bucket (S3-compatible endpoint), public, browsed by folder
        code, body, _ = call(base, "POST", f"/api/services?kind=cloud&url=s3%3A%2F%2Fgeo&title=Bucket&endpoint={quote(m, safe='')}")
        check(code == 200, f"cloud: S3 bucket connected ({code} {body[:200].decode(errors='replace')})")
        cid = json.loads(body)["service"]["id"] if code == 200 else ""
        code, body, _ = call(base, "GET", f"/api/services/{cid}/layers")
        ls = json.loads(body).get("layers", []) if code == 200 else []
        check([(l["id"], l["type"]) for l in ls] == [("vectors", "folder"), ("scene.tif", "file")], f"cloud: top folder lists folders then files ({code} {ls or body[:200]})")
        code, body, _ = call(base, "GET", f"/api/services/{cid}/list?path=vectors")
        ls = json.loads(body).get("layers", []) if code == 200 else []
        check([l["id"] for l in ls] == ["vectors/plots.geojson"] and ls[0]["kind"] == "vector", f"cloud: a sub-folder, only files GeoSpaX opens ({code} {ls or body[:200]})")
        code, body, _ = call(base, "POST", f"/api/services/{cid}/open?path=scene.tif")
        r = json.loads(body) if body else {}
        check(code == 200 and len(r.get("rasters", [])) == 1, f"cloud: a GeoTIFF goes on the map read in place ({code} {r})")
        code, body, _ = call(base, "POST", f"/api/services/{cid}/open?path=vectors%2Fplots.geojson")
        r = json.loads(body) if body else {}
        lid = (r.get("layers") or [None])[0]
        lays = json.loads(call(base, "GET", "/api/layers")[1])
        lays = lays.get("layers", lays) if isinstance(lays, dict) else lays
        n = next((l.get("feature_count") for l in lays if l.get("id") == lid), None)
        check(code == 200 and n == 8, f"cloud: a GeoJSON becomes a layer ({code} {r} {n} features)")
        code, _, _ = call(base, "GET", f"/api/services/{cid}/list?path=..%2Fother")
        check(code == 502, f"cloud: paths outside the connection are refused ({code})")
        code, body, _ = call(base, "POST", "/api/stac/add", body={"href": "file:///etc/passwd", "id": "x", "title": "x", "stream": True})
        check(code == 400, f"stac: only web addresses are accepted ({code})")
        code, body, _ = call(base, "POST", f"/api/services?kind=wms&url={quote(m + '/nothing-here', safe='')}")
        check(code == 400 and b"error" in body, f"a broken address is refused with a reason ({code} {body[:120].decode(errors='replace')})")
        code, body, _ = call(base, "GET", "/api/services")
        check(len(json.loads(body)["services"]) == len(cases) + 2, "the connections are listed (and kept in services.json)")
        sid = json.loads(body)["services"][0]["id"]
        code, _, _ = call(base, "DELETE", f"/api/services/{sid}")
        check(code == 200, "a connection is removed")
    finally:
        srv.kill()
    # Overture Maps from an S3 bucket in Overture's layout (two releases; the newest is used): the job
    # reads the footer, keeps the one row group in the area, and puts 3 buildings on the map
    ovt = start(a.bin, data, os.path.join(tmp, "state3"), port + 2, extra_env={
        "GEOSPAX_OVERTURE_ROOT": "/vsis3/ovt/release", "AWS_S3_ENDPOINT": f"127.0.0.1:{mock.server_port}", "AWS_HTTPS": "NO",
        "AWS_VIRTUAL_HOSTING": "FALSE", "AWS_NO_SIGN_REQUEST": "YES"})
    try:
        ob = f"http://127.0.0.1:{port + 2}"
        code, body, _ = call(ob, "GET", "/api/overture")
        check(code == 200 and any(t["id"] == "buildings" for t in json.loads(body)["themes"]), "overture: themes listed")
        code, body, _ = call(ob, "POST", "/api/overture?theme=buildings&bbox=9.99,4.99,10.025,5.1")
        job = json.loads(body).get("job") if code == 200 else None
        j = {}
        for _ in range(120):
            if job is None:
                break
            j = json.loads(call(ob, "GET", f"/api/jobs/{job}")[1])
            if j["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.25)
        r = j.get("result") or {}
        check(j.get("status") == "done" and r.get("features") == 3 and r.get("release") == "2026-09-17.0" and r.get("layers"),
              f"overture: buildings for the area from the newest release ({j.get('status')} {j.get('message')} {r})")
        code, body, _ = call(ob, "POST", "/api/overture?theme=buildings&bbox=0,0,5,5")
        check(code == 400 and b"zoom in" in body, f"overture: a too-large area is refused ({code})")
        # a .parquet file in a data folder opens as a layer too
        import shutil
        shutil.copy(FIXTURE, os.path.join(data, "buildings.parquet"))
        code, body, _ = call(ob, "POST", f"/api/browse/add?path={quote(os.path.join(data, 'buildings.parquet'), safe='')}")
        r = json.loads(body) if body else {}
        check(code == 200 and len(r.get("layers", [])) == 1, f"geoparquet: a file in a data folder becomes a layer ({code} {r})")
    finally:
        ovt.kill()
    # GitHub: a repository is connected as owner/repo, its folders are listed (data files and recipes only),
    # a GeoJSON becomes a layer, a GeoTIFF is read in place, a plain recipe is added to the recipes, and a
    # recipe that runs code is only added once approved
    gsrv = start(a.bin, data, os.path.join(tmp, "state-gh"), port + 4, extra_env={"GEOSPAX_GITHUB_API": f"{m}/gh"})
    try:
        gb = f"http://127.0.0.1:{port + 4}"
        code, body, _ = call(gb, "POST", "/api/services?kind=github&url=https%3A%2F%2Fgithub.com%2Fo%2Fr")
        svc = json.loads(body).get("service", {}) if code == 200 else {}
        check(code == 200 and svc.get("title") == "o/r", f"github: repository connected as o/r ({code} {body[:160].decode(errors='replace')})")
        gid = svc.get("id", "")
        ls = json.loads(call(gb, "GET", f"/api/services/{gid}/layers")[1]).get("layers", [])
        check([l["id"] for l in ls] == ["data", "recipes"], f"github: top folders, README left out ({[l['id'] for l in ls]})")
        ls = json.loads(call(gb, "GET", f"/api/services/{gid}/list?path=data")[1]).get("layers", [])
        check(sorted((l["id"], l["kind"]) for l in ls) == [("data/plots.geojson", "vector"), ("data/scene.tif", "raster")], f"github: a folder's data files ({ls})")
        code, body, _ = call(gb, "POST", f"/api/services/{gid}/open?path=data%2Fplots.geojson")
        r = json.loads(body) if body else {}
        check(code == 200 and len(r.get("layers", [])) == 1, f"github: a GeoJSON becomes a layer ({code} {r})")
        code, body, _ = call(gb, "POST", f"/api/services/{gid}/open?path=data%2Fscene.tif")
        r = json.loads(body) if body else {}
        check(code == 200 and len(r.get("rasters", [])) == 1, f"github: a GeoTIFF goes on the map ({code} {r})")
        code, body, _ = call(gb, "POST", f"/api/services/{gid}/open?path=recipes%2Fkriging.yaml")
        r = json.loads(body) if body else {}
        check(code == 200 and (r.get("recipe") or {}).get("id") == "gh-kriging", f"github: a recipe is added ({code} {str(r)[:160]})")
        code, body, _ = call(gb, "POST", f"/api/services/{gid}/open?path=recipes%2Fpy-stats.yaml")
        check(code == 502 and b"runs Python or R code" in body, f"github: a recipe that runs code needs approval ({code} {body[:120]})")
        code, body, _ = call(gb, "POST", f"/api/services/{gid}/open?path=recipes%2Fpy-stats.yaml&approve=code")
        check(code == 200, f"github: ... and is added once approved ({code} {body[:160]})")
        ids = [r["id"] for r in json.loads(call(gb, "GET", "/api/recipes")[1]).get("recipes", [])]
        check("gh-kriging" in ids and "gh-py-stats" in ids, "github: both recipes are listed")
        code, _, _ = call(gb, "GET", f"/api/services/{gid}/list?path=..%2Fx")
        check(code == 502, f"github: paths outside the repository are refused ({code})")
    finally:
        gsrv.kill()
        time.sleep(0.5)
    # Python environments: a project's .venv in a data folder is found next to the system Python, its
    # packages are read, an arbitrary program is refused, and choosing it is kept for the next start
    pdata = os.path.join(tmp, "pydata")
    os.makedirs(os.path.join(pdata, ".venv", "bin"))
    venv_py = os.path.join(pdata, ".venv", "bin", "python")
    os.symlink(sys.executable, venv_py)
    pstate = os.path.join(tmp, "state-py")
    for round_ in (1, 2):
        psrv = start(a.bin, pdata, pstate, port + 3)
        try:
            pb = f"http://127.0.0.1:{port + 3}"
            envs = json.loads(call(pb, "GET", "/api/python")[1])["environments"]
            venv = next((e for e in envs if e["path"] == venv_py), None)
            if round_ == 1:
                check(venv is not None and venv["kind"] == "venv", f"python: the data folder's .venv is found ({[e['label'] for e in envs]})")
                code, body, _ = call(pb, "GET", f"/api/python/packages?path={quote(venv_py, safe='')}")
                r = json.loads(body) if body else {}
                check(code == 200 and "geopandas" in r.get("packages", {}) and r.get("total", 0) >= 1, f"python: its packages are read ({code} {str(r)[:120]})")
                code, _, _ = call(pb, "POST", "/api/python/use?path=%2Fbin%2Fsh")
                check(code == 400, f"python: a program that is not a found environment is refused ({code})")
                code, _, _ = call(pb, "POST", f"/api/python/use?path={quote(venv_py, safe='')}")
                check(code == 200, f"python: an environment is chosen ({code})")
            else:
                check(venv is not None and venv["current"], f"python: the choice is kept after a restart ({venv})")
        finally:
            psrv.kill()
            time.sleep(0.5)
    # open to other devices: the token is the password, and whoever has it can add services; without it
    # nothing is answered; started with --restricted, new services are refused even with the token
    def post(p, path, token):
        req = urllib.request.Request(f"http://127.0.0.1:{p}{path}", method="POST", headers={"Authorization": f"Bearer {token}"} if token else {})
        try:
            urllib.request.urlopen(req, timeout=20)
            return 200
        except urllib.error.HTTPError as e:
            return e.code
    add_xyz = f"/api/services?kind=xyz&url={quote(m + '/xyz/{z}/{x}/{y}.png', safe='')}"
    for restricted, label in ((False, "open to other devices"), (True, "--restricted")):
        srv2 = start(a.bin, data, os.path.join(tmp, f"state-r{int(restricted)}"), port + 1, host="0.0.0.0", restricted=restricted)
        try:
            code = post(port + 1, add_xyz, "t0ken")
            check(code == (403 if restricted else 200), f"{label}: with the token, a new service is {'refused' if restricted else 'added'} ({code})")
            code = post(port + 1, add_xyz, None)
            check(code == 401, f"{label}: without the token, nothing is answered ({code})")
        finally:
            srv2.kill()
            time.sleep(0.5)
    print(f"\n{'PASS' if not failed else 'FAIL'}: {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
