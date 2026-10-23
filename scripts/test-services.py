#!/usr/bin/env python3
"""Web services in the Explorer, end to end against a local mock server (no internet needed).

The mock speaks just enough of each protocol for GDAL and the engine: XYZ tiles, WMS 1.3.0
(GetCapabilities, GetMap), WMTS (GetCapabilities with a REST template), ArcGIS MapServer (?f=json,
/export) and FeatureServer (?f=json, /0/query?f=geojson), and OGC API Features (landing page,
conformance, collections, items). Checks: each kind is added and lists its layers, map tiles come
back through the engine as images, features are downloaded for an area into a layer on the map, a
broken address is refused with a reason, and a server open to other devices refuses new services.

    python3 scripts/test-services.py [--bin target/release/geospax-server]
"""
import argparse, json, os, struct, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

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

    def do_GET(self):
        u = urlparse(self.path)
        q = {k.lower(): v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
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


def call(base, method, path, timeout=60):
    req = urllib.request.Request(base + path, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def start(bin, data, state, port, host="127.0.0.1"):
    env = dict(os.environ, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    args = [bin, "--data", data, "--state-dir", state, "--port", str(port), "--no-device-mounts", "--no-triggers"]
    if host != "127.0.0.1":
        args += ["--host", host, "--token", "t0ken"]
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
        from urllib.parse import quote
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
        code, body, _ = call(base, "POST", f"/api/services?kind=wms&url={quote(m + '/nothing-here', safe='')}")
        check(code == 400 and b"error" in body, f"a broken address is refused with a reason ({code} {body[:120].decode(errors='replace')})")
        code, body, _ = call(base, "GET", "/api/services")
        check(len(json.loads(body)["services"]) == len(cases), "the connections are listed (and kept in services.json)")
        sid = json.loads(body)["services"][0]["id"]
        code, _, _ = call(base, "DELETE", f"/api/services/{sid}")
        check(code == 200, "a connection is removed")
    finally:
        srv.kill()
    # open to other devices: no new services (the engine would fetch any address for them)
    shared = start(a.bin, data, os.path.join(tmp, "state2"), port + 1, host="0.0.0.0")
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port + 1}/api/services?kind=xyz&url=http%3A%2F%2Fx%2F%7Bz%7D", method="POST", headers={"Authorization": "Bearer t0ken"})
        try:
            urllib.request.urlopen(req, timeout=10)
            code = 200
        except urllib.error.HTTPError as e:
            code = e.code
        check(code == 403, f"a server open to other devices refuses new services ({code})")
    finally:
        shared.kill()
    print(f"\n{'PASS' if not failed else 'FAIL'}: {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
