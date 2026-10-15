#!/usr/bin/env python3
"""Simulate live geotagged sensors for demos of the sensor hub (docs/DEVICES.md §5).

usage: scripts/demo-sensor-feed.py [--url http://127.0.0.1:8080] [--mqtt HOST:PORT]
                                   [--rate 2] [--count 0] [--topic sensors]

Two air-quality sensors walk around Mount Hagen and report PM2.5, PM10, temperature and humidity
every --rate seconds, over HTTP (POST /api/devices/live) or, with --mqtt, as JSON messages on
<topic>/<sensor id> (start the server with --mqtt mqtt://HOST:PORT/sensors/#). Every few minutes
one of them passes a smoky roadside and PM2.5 rises above 35 µg/m³, which fires the
air-quality-alert recipe when its trigger is on. --count stops after that many rounds (0 = run
until stopped). Standard library only. THE DATA IS SYNTHETIC.
"""
import argparse, json, math, random, socket, sys, time, urllib.request

HAGEN = (144.2300, -5.8600)


def mqtt_connect(host, port, client="geospax-demo-feed"):
    def s16(b):
        return len(b).to_bytes(2, "big") + b
    c = socket.create_connection((host, port), timeout=10)
    c.sendall(packet(0x10, s16(b"MQTT") + bytes([4, 2, 0, 60]) + s16(client.encode())))
    ack = c.recv(4)
    if len(ack) < 4 or ack[3] != 0:
        sys.exit(f"MQTT broker at {host}:{port} refused the connection")
    return c


def packet(first, body):
    n, out = len(body), bytearray([first])
    while True:
        d, n = n % 128, n // 128
        out.append(d | (0x80 if n else 0))
        if not n:
            break
    return bytes(out) + body


def mqtt_publish(c, topic, payload):
    t = topic.encode()
    c.sendall(packet(0x30, len(t).to_bytes(2, "big") + t + json.dumps(payload).encode()))


def http_post(url, payload):
    req = urllib.request.Request(f"{url.rstrip('/')}/api/devices/live", json.dumps(payload).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--mqtt", help="HOST:PORT of an MQTT broker (default: post over HTTP)")
    ap.add_argument("--topic", default="sensors")
    ap.add_argument("--rate", type=float, default=2.0, help="seconds between rounds")
    ap.add_argument("--count", type=int, default=0, help="rounds (0 = until stopped)")
    a = ap.parse_args()
    rnd = random.Random(7)
    sensors = [
        {"id": "aq-north", "name": "AQ walker north", "pos": [HAGEN[0] + 0.004, HAGEN[1] + 0.006], "heading": 120.0, "phase": 0.0},
        {"id": "aq-south", "name": "AQ walker south", "pos": [HAGEN[0] - 0.006, HAGEN[1] - 0.004], "heading": 40.0, "phase": 0.5},
    ]
    conn = None
    if a.mqtt:
        host, _, port = a.mqtt.partition(":")
        conn = mqtt_connect(host, int(port or 1883))
    print(f"feeding {len(sensors)} sensors every {a.rate:g} s via {'MQTT ' + a.mqtt if a.mqtt else a.url}", flush=True)
    t0, n = time.time(), 0
    while a.count == 0 or n < a.count:
        t = time.time() - t0
        for s in sensors:
            s["heading"] += rnd.uniform(-20, 20)
            step = 4.0 * a.rate  # metres: a slow walk
            lon, lat = s["pos"]
            s["pos"] = [lon + step * math.sin(math.radians(s["heading"])) / (111_320 * math.cos(math.radians(lat))),
                        lat + step * math.cos(math.radians(s["heading"])) / 111_320]
            # a smoky roadside every ~6 minutes (one sensor at a time)
            smoke = 45.0 * max(0.0, math.sin(2 * math.pi * (t / 360.0 + s["phase"]))) ** 12
            pm25 = max(3.0, 9.0 + smoke + rnd.gauss(0, 1.5))
            msg = {"id": s["id"], "name": s["name"], "lat": round(s["pos"][1], 6), "lon": round(s["pos"][0], 6), "t": round(time.time(), 1),
                   "values": {"pm2_5": round(pm25, 1), "pm10": round(pm25 * 1.6 + rnd.uniform(0, 3), 1),
                              "temperature": round(20.0 + 2.0 * math.sin(t / 900.0) + rnd.gauss(0, 0.2), 1), "humidity": round(78 + rnd.gauss(0, 2))}}
            try:
                if conn:
                    mqtt_publish(conn, f"{a.topic}/{s['id']}", msg)
                else:
                    http_post(a.url, msg)
            except OSError as e:
                print(f"send failed: {e}", flush=True)
        n += 1
        if n % 30 == 1:
            print(f"round {n}: " + ", ".join(f"{s['id']} at {s['pos'][1]:.4f},{s['pos'][0]:.4f}" for s in sensors), flush=True)
        time.sleep(a.rate)
    if conn:
        conn.sendall(bytes([0xE0, 0]))
        conn.close()


if __name__ == "__main__":
    main()
