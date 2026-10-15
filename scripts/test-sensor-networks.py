#!/usr/bin/env python3
"""Sensors anywhere (docs/DEVICES.md §4): MQTT over TLS, LoRaWAN uplinks (The Things Stack, ChirpStack v4/v3)
and OGC SensorThings polling, against a real mosquitto broker with TLS listeners and a mock SensorThings
service. Needs mosquitto (Debian: apt install mosquitto) and openssl.

  scripts/test-sensor-networks.py --bin target/release/geospax-server --data DIR [--port 8129] [--out DIR]

Ports: PORT (GeoSpaX), PORT+1 plain MQTT, PORT+2 MQTT/TLS, PORT+3 MQTT/TLS with client certificates,
PORT+4 the mock SensorThings service.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

results = []


def check(cond, msg):
    results.append((bool(cond), msg))
    print(("PASS  " if cond else "FAIL  ") + msg, flush=True)
    return bool(cond)


def http(method, url, body=None, ctype="application/json"):
    req = urllib.request.Request(url, data=body.encode() if isinstance(body, str) else body, method=method)
    if body is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jget(url):
    return json.loads(http("GET", url)[1])


def wait_for(fn, timeout, step=0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = fn()
            if v:
                return v
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(step)
    return None


# ---------------------------------------------------------------- certificates (a private CA, like a site broker)

def make_certs(d):
    def sh(*cmd):
        subprocess.run(cmd, check=True, cwd=d, capture_output=True)
    ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
    for ca, cn in [("ca", "GeoSpaX Test CA"), ("other-ca", "Somebody Else CA")]:
        sh("openssl", "req", "-x509", *ec, "-keyout", f"{ca}.key", "-out", f"{ca}.pem", "-days", "2", "-subj", f"/CN={cn}")
    for name, usage, san in [("server", "serverAuth", "subjectAltName=IP:127.0.0.1,DNS:localhost\n"), ("client", "clientAuth", "")]:
        with open(os.path.join(d, f"{name}.ext"), "w") as f:
            f.write(f"{san}basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage={usage}\n")
        sh("openssl", "req", *ec, "-keyout", f"{name}.key", "-out", f"{name}.csr", "-subj", f"/CN=geospax-test-{name}")
        sh("openssl", "x509", "-req", "-in", f"{name}.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
           "-out", f"{name}.pem", "-days", "2", "-extfile", f"{name}.ext")
    return {k: os.path.join(d, f"{k}.pem") for k in ["ca", "other-ca", "server", "client"]} | {
        "server_key": os.path.join(d, "server.key"), "client_key": os.path.join(d, "client.key")}


# ---------------------------------------------------------------- MQTT publisher (QoS 0; no mosquitto-clients needed)

def mqtt_publish(port, topic, payload, host="127.0.0.1"):
    def s16(b):
        return len(b).to_bytes(2, "big") + b

    def pkt(first, body):
        n, out = len(body), bytearray()
        while True:
            b, n = n % 128, n // 128
            out.append(b | (0x80 if n else 0))
            if not n:
                break
        return bytes([first]) + bytes(out) + body
    data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    with socket.create_connection((host, port), 10) as s:
        s.sendall(pkt(0x10, s16(b"MQTT") + bytes([4, 2]) + (30).to_bytes(2, "big") + s16(f"test-pub-{os.getpid()}".encode())))
        assert s.recv(4)[:2] == b"\x20\x02", "no CONNACK"
        s.sendall(pkt(0x30, s16(topic.encode()) + data))
        s.sendall(b"\xe0\x00")


# ---------------------------------------------------------------- mock SensorThings service (FROST-like answers)

class Sta:
    def __init__(self, port):
        self.port, self.queries, self.lock = port, [], threading.Lock()
        self.things = {
            1: {"name": "Waigani station", "pos": [147.1802, -9.4310], "obs": {"PM2.5": (12.5, "µg/m³"), "Air temperature": (29.1, "°C")}, "t": "2026-10-15T01:00:00Z"},
            2: {"name": "Gerehu station", "pos": [147.1650, -9.3930], "obs": {"PM2.5": (8.0, "µg/m³")}, "t": "2026-10-15T01:00:00Z"},
            3: {"name": "Lab bench", "pos": None, "obs": {"pH": (7.1, "")}, "t": "2026-10-15T01:00:00Z"},
            4: {"name": "Boroko river gauge", "pos": [147.2005, -9.4652], "obs": {"Water level": (112.0, "cm")}, "t": "2026-10-15T01:00:00Z"},
        }

    def advance(self, tid, prop, value, t):
        with self.lock:
            th = self.things[tid]
            th["obs"][prop] = (value, th["obs"][prop][1])
            th["t"] = t

    def thing_json(self, tid):
        th = self.things[tid]
        ds = [{"name": f"{p} at {th['name']}", "unitOfMeasurement": {"name": p, "symbol": u, "definition": ""}, "ObservedProperty": {"name": p},
               "Observations": [{"result": v, "phenomenonTime": th["t"]}]} for p, (v, u) in th["obs"].items()]
        locs = [{"location": {"type": "Point", "coordinates": th["pos"]}}] if th["pos"] else []
        return {"@iot.id": tid, "@iot.selfLink": f"http://127.0.0.1:{self.port}/v1.1/Things({tid})", "name": th["name"], "Locations": locs, "Datastreams": ds}

    def serve(self):
        sta = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                if u.path != "/v1.1/Things":
                    self.send_error(404)
                    return
                q = urllib.parse.parse_qs(u.query)
                with sta.lock:
                    sta.queries.append(urllib.parse.unquote(u.query))
                    if q.get("$skip") == ["2"]:
                        body = {"value": [sta.thing_json(3), sta.thing_json(4)]}
                    else:
                        nxt = f"http://127.0.0.1:{sta.port}/v1.1/Things?$skip=2&{u.query}"
                        body = {"@iot.nextLink": nxt, "value": [sta.thing_json(1), sta.thing_json(2)]}
                b = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
        srv = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv


# ---------------------------------------------------------------- uplinks as the network servers publish them

def ttn_uplink(dev, pm, lat=None, lon=None, t="2026-10-15T01:00:00Z"):
    payload = {"pm2_5": pm, "pm10": round(pm * 1.6, 1), "temperature": 27.5, "battery": {"voltage": 3.61}}
    if lat is not None:
        payload |= {"latitude": lat, "longitude": lon}
    return {"end_device_ids": {"device_id": dev, "application_ids": {"application_id": "air-quality"}, "dev_eui": "70B3D57ED0061A2B"},
            "received_at": t,
            "uplink_message": {"f_port": 2, "f_cnt": 42, "frm_payload": "AQID", "decoded_payload": payload,
                               "rx_metadata": [{"gateway_ids": {"gateway_id": "pom-gw-1"}, "rssi": -101, "snr": 4.25, "location": {"latitude": -9.44, "longitude": 147.18}},
                                               {"gateway_ids": {"gateway_id": "pom-gw-2"}, "rssi": -87, "snr": 8.5, "location": {"latitude": -9.47, "longitude": 147.15}}],
                               "settings": {"data_rate": {"lora": {"bandwidth": 125000, "spreading_factor": 7}}, "frequency": "917000000"}}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default="target/release/geospax-server")
    ap.add_argument("--data", default="data")
    ap.add_argument("--out", default="bench/screenshots")
    ap.add_argument("--port", type=int, default=8129)
    a = ap.parse_args()
    mosq = shutil.which("mosquitto") or ("/usr/sbin/mosquitto" if os.path.exists("/usr/sbin/mosquitto") else None)
    if not mosq or not shutil.which("openssl"):
        print("skipped: needs mosquitto and openssl")
        return 0
    p_plain, p_tls, p_mtls, p_sta = a.port + 1, a.port + 2, a.port + 3, a.port + 4
    url = f"http://127.0.0.1:{a.port}"
    tmp = tempfile.mkdtemp(prefix="gx-sensor-networks-")
    procs = []
    try:
        c = make_certs(tmp)
        conf = os.path.join(tmp, "mosquitto.conf")
        with open(conf, "w") as f:
            f.write(f"allow_anonymous true\n\nlistener {p_plain} 127.0.0.1\n\n"
                    f"listener {p_tls} 127.0.0.1\ncafile {c['ca']}\ncertfile {c['server']}\nkeyfile {c['server_key']}\n\n"
                    f"listener {p_mtls} 127.0.0.1\ncafile {c['ca']}\ncertfile {c['server']}\nkeyfile {c['server_key']}\nrequire_certificate true\n")
        broker_log = open(os.path.join(a.out, "test-sensor-networks-broker.log"), "w")
        procs.append(subprocess.Popen([mosq, "-c", conf], stdout=broker_log, stderr=subprocess.STDOUT))
        up = wait_for(lambda: all(socket.create_connection(("127.0.0.1", p), 1).close() is None for p in (p_plain, p_tls, p_mtls)), 10)
        check(up, f"mosquitto with a plain, a TLS and a client-certificate listener (private CA from openssl) on {p_plain}-{p_mtls}")
        sta = Sta(p_sta)
        sta_srv = sta.serve()

        q = urllib.parse.quote
        mqtt = [
            f"mqtts://127.0.0.1:{p_tls}/v3/%2B/devices/%2B/up?ca={q(c['ca'])}",                                       # 0 TTN over TLS
            f"mqtts://127.0.0.1:{p_mtls}/application/%2B/device/%2B/event/up?ca={q(c['ca'])}&cert={q(c['client'])}&key={q(c['client_key'])}",  # 1 ChirpStack v4, mutual TLS
            f"mqtts://127.0.0.1:{p_tls}/wrong-ca/%23?ca={q(c['other-ca'])}",                                        # 2 wrong CA
            f"mqtts://127.0.0.1:{p_mtls}/no-client-cert/%23?ca={q(c['ca'])}",                                       # 3 broker wants a client cert
            f"mqtt://127.0.0.1:{p_plain}/application/%2B/device/%2B/rx",                                            # 4 ChirpStack v3 (plain)
        ]
        state = os.path.join(tmp, "state")
        log = open(os.path.join(a.out, "test-sensor-networks-server.log"), "w")
        args = [a.bin, "--data", a.data, "--state-dir", state, "--host", "127.0.0.1", "--port", str(a.port), "--web", "web/dist", "--no-device-mounts",
                "--sta", f"http://127.0.0.1:{p_sta}/v1.1?every=10", "--auto", "air-quality-alert"]
        for m in mqtt:
            args += ["--mqtt", m]
        procs.append(subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT))
        check(wait_for(lambda: http("GET", f"{url}/api/health")[0] == 200, 30), "GeoSpaX server up with 5 MQTT sources and 1 SensorThings service")

        def mq():
            return jget(f"{url}/api/devices")["mqtt"]

        def live(dev_id):
            return next((d for d in jget(f"{url}/api/devices")["live"] if d["id"] == dev_id), None)

        st = wait_for(lambda: (lambda m: m if m[0]["connected"] and m[1]["connected"] and m[4]["connected"] and m[2]["error"] and m[3]["error"] else None)(mq()), 30)
        st = st or mq()
        check(st[0]["connected"] and st[0]["url"].startswith("mqtts://127.0.0.1:"), f"mqtts:// with a private CA (?ca=): connected, shown as {st[0]['url'].split('?')[0]}")
        check(st[1]["connected"], "mutual TLS (?cert=&key=) to a broker that requires client certificates: connected")
        check(not st[2]["connected"] and "?ca=" in (st[2]["error"] or ""), f"certificate from an unknown CA refused, in words: {st[2]['error']}")
        check(not st[3]["connected"] and "client certificate" in (st[3]["error"] or ""), f"no client certificate for a broker that wants one, in words: {st[3]['error']}")

        # The Things Stack: uplink with a GPS payload over mqtts
        t0 = time.time()
        mqtt_publish(p_plain, "v3/air-quality@ttn/devices/aq-node-7/up", ttn_uplink("aq-node-7", 18.4, -9.4402, 147.1931))
        d = wait_for(lambda: live("aq-node-7"), 10)
        if check(d, f"TTN v3 uplink over mqtts -> live sensor aq-node-7 in {time.time() - t0:.2f} s"):
            v = d.get("values") or {}
            check(d["source"] == "LoRaWAN · TTN" and v.get("pm2_5") == 18.4 and v.get("battery_voltage") == 3.61,
                  f"decoded payload (nested battery.voltage flattened), source '{d['source']}': pm2_5={v.get('pm2_5')}, battery_voltage={v.get('battery_voltage')}")
            check(v.get("rssi") == -87 and v.get("snr") == 8.5 and v.get("gateways") == 2, f"radio from the strongest of 2 gateways: rssi {v.get('rssi')} dBm, snr {v.get('snr')} dB")
            f = next((f for f in jget(f"{url}/api/devices/live")["features"] if f["properties"].get("device") == "aq-node-7" and f["properties"].get("role") == "position"), None)
            check(f and f["geometry"]["coordinates"] == [147.1931, -9.4402], f"position from the tracker's GPS payload: {f and f['geometry']['coordinates']}")
        n_live = len(jget(f"{url}/api/devices")["live"])
        mqtt_publish(p_plain, "v3/air-quality@ttn/devices/aq-node-8/join", {"end_device_ids": {"device_id": "aq-node-8"}, "join_accept": {"session_key_id": "AYa"}})
        time.sleep(1.0)
        check(len(jget(f"{url}/api/devices")["live"]) == n_live and not live("aq-node-8"), "join-accept (no uplink) ignored: no sensor without readings")

        # ChirpStack v4 over mutual TLS: position from the gateway (no GPS in the payload)
        mqtt_publish(p_plain, "application/7b2c/device/0004a30b001c0530/event/up",
                     {"deduplicationId": "1f9e", "time": "2026-10-15T01:02:03Z", "deviceInfo": {"tenantName": "Water", "applicationName": "tanks", "deviceName": "tank-hohola", "devEui": "0004a30b001c0530"},
                      "fPort": 1, "data": "AFI=", "object": {"level_cm": 82.5, "temperature": 26.0},
                      "rxInfo": [{"gatewayId": "a84041ffff1ec39c", "rssi": -64, "snr": 10.25, "location": {"latitude": -9.4195, "longitude": 147.1712}}]})
        d = wait_for(lambda: live("tank-hohola"), 10)
        if check(d and d["source"] == "LoRaWAN · ChirpStack" and (d.get("values") or {}).get("level_cm") == 82.5, f"ChirpStack v4 uplink over mutual TLS -> tank-hohola, level_cm {d and d['values'].get('level_cm')}"):
            f = next((f for f in jget(f"{url}/api/devices/live")["features"] if f["properties"].get("device") == "tank-hohola" and f["properties"].get("role") == "position"), None)
            check(f and f["geometry"]["coordinates"] == [147.1712, -9.4195] and f["properties"].get("accuracy_m") == 2000,
                  f"no GPS in the payload: placed at the receiving gateway, accuracy {f and f['properties'].get('accuracy_m')} m")
        # ChirpStack v3 (plain MQTT): devEUI/deviceName, snr under loRaSNR
        mqtt_publish(p_plain, "application/3/device/0102030405060708/rx",
                     {"applicationID": "3", "applicationName": "farm", "deviceName": "rain-gauge-2", "devEUI": "AQIDBAUGBwg=", "fPort": 2,
                      "object": {"rain_mm": 1.2, "lat": -9.38, "lon": 147.21}, "rxInfo": [{"rssi": -71, "loRaSNR": 7.5, "name": "gw"}]})
        d = wait_for(lambda: live("rain-gauge-2"), 10)
        check(d and d["values"].get("rain_mm") == 1.2 and d["values"].get("snr") == 7.5, f"ChirpStack v3 uplink -> rain-gauge-2, rain_mm {d and d['values'].get('rain_mm')}, snr {d and d['values'].get('snr')}")

        # TTN webhook straight to GeoSpaX (no broker): same JSON over HTTP
        st_, body = http("POST", f"{url}/api/devices/live", json.dumps(ttn_uplink("aq-node-9", 9.0, -9.45, 147.19)))
        d = live("sensor-aq-node-9")
        check(st_ == 200 and d and d["source"] == "LoRaWAN · TTN", f"TTN webhook POST /api/devices/live -> HTTP {st_}, live sensor {d and d['id']}")

        def runs(dev):
            return [r for r in jget(f"{url}/api/runs")["runs"] if r["recipe"] == "air-quality-alert" and r["trigger"].get("device_id") == dev and r["status"] == "done"]
        # A LoRaWAN node crosses the PM2.5 level -> air-quality-alert (sensor trigger)
        t0 = time.time()
        mqtt_publish(p_plain, "v3/air-quality@ttn/devices/aq-node-7/up", ttn_uplink("aq-node-7", 41.2, -9.4402, 147.1931, "2026-10-15T01:05:00Z"))
        r = wait_for(lambda: runs("aq-node-7"), 60)
        if check(r, f"TTN node reports pm2_5 41.2 -> air-quality-alert map done in {time.time() - t0:.1f} s"):
            check(r[0]["trigger"].get("source") == "LoRaWAN · TTN" and any(x.endswith(".png") for x in r[0].get("artifacts", [])),
                  f"alert run says where the reading came from (source '{r[0]['trigger'].get('source')}') and has a map")

        # SensorThings: first poll (2 pages via @iot.nextLink), stations with a location become live sensors
        def sta_status():
            return jget(f"{url}/api/devices")["sta"][0]
        s = wait_for(lambda: (lambda x: x if x["polls"] >= 1 else None)(sta_status()), 30) or sta_status()
        check(s["things"] == 3 and s["readings"] == 3 and not s["error"], f"SensorThings first poll: {s['things']} stations (2 pages via @iot.nextLink; the one without a location skipped), {s['readings']} updates")
        qs = list(sta.queries)
        check(any("$expand=" in x and "Observations($orderby=phenomenonTime desc;$top=1" in x for x in qs) and any("$skip=2" in x for x in qs),
              f"one request per page asks only for the newest observation of each datastream ({len(qs)} requests)")
        d = live("sta-local-1")
        check(d and d["name"] == "Waigani station" and d["source"] == "SensorThings" and d["values"] == {"pm2_5": 12.5, "air_temperature": 29.1},
              f"station -> live sensor {d and d['id']} '{d and d['name']}': {d and d['values']}")
        g = live("sta-local-4")
        check(g and g["values"] == {"water_level": 112.0}, f"river gauge from page 2: {g and g['values']}")
        # Next poll with nothing new -> no duplicate readings; then one station reports a new observation
        s2 = wait_for(lambda: (lambda x: x if x["polls"] >= 2 else None)(sta_status()), 20) or sta_status()
        check(s2["polls"] >= 2 and s2["readings"] == 3, f"poll {s2['polls']} with no new observations: still {s2['readings']} updates (no duplicates)")
        sta.advance(1, "PM2.5", 48.0, "2026-10-15T01:10:00Z")
        t0 = time.time()
        s3 = wait_for(lambda: (lambda x: x if x["readings"] >= 4 else None)(sta_status()), 20) or sta_status()
        check(s3["readings"] == 4 and live("sta-local-1")["values"]["pm2_5"] == 48.0, f"Waigani reports PM2.5 48 -> exactly 1 new update ({s3['readings']} in total)")
        r = wait_for(lambda: runs("sta-local-1"), 60)
        check(r and r[0]["trigger"].get("source") == "SensorThings", f"SensorThings station above 35 -> air-quality-alert done {time.time() - t0:.1f} s after the observation")
        sta_srv.shutdown()
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [m for ok, m in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} sensor-network checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
