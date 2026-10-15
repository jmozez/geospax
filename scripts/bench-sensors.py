#!/usr/bin/env python3
"""Sensor-hub throughput (docs/DEVICES.md §4, bench/RESULTS.md §13).

usage: scripts/bench-sensors.py [--bin target/release/geospax-server] [--data DIR] [--rows 200000]
                                [--posts 2000] [--messages 5000] [--port 8130] [--out bench/sensors.json]

1. A big logger file: writes a CSV with --rows readings (PM, temperature, humidity) and runs
   `sensor-log-to-map` on it from the command line (import, summary, map: per-step times).
2. HTTP push: --posts sensor readings over one keep-alive connection to POST /api/devices/live.
3. MQTT: --messages sensor messages published as fast as possible to a local Mosquitto
   (skipped without `mosquitto`); time until the server has taken all of them.
Starts its own server and broker with a temporary state dir. THE DATA IS SYNTHETIC.
"""
import argparse, http.client, json, math, os, random, shutil, socket, subprocess, sys, tempfile, time


def big_csv(path, rows, rnd):
    lon, lat, heading, pm = 144.234, -5.857, 110.0, 9.0
    with open(path, "w", encoding="utf-8") as f:
        f.write("timestamp,latitude,longitude,PM2.5 (µg/m³),PM10 (µg/m³),Temperature (°C),Humidity (%)\n")
        t0 = 1_791_000_000
        for i in range(rows):
            heading += rnd.uniform(-15, 15)
            lat += 1.0 * math.cos(math.radians(heading)) / 111_320
            lon += 1.0 * math.sin(math.radians(heading)) / 110_800
            pm = max(3.0, pm + (9.0 + 40.0 * (math.sin(i / 900.0) > 0.97) - pm) * 0.2 + rnd.gauss(0, 1.0))
            f.write(f"{t0 + i},{lat:.6f},{lon:.6f},{pm:.1f},{pm * 1.6:.1f},{20 + rnd.gauss(0, 0.3):.1f},{80 + rnd.gauss(0, 2):.0f}\n")


def mqtt_flood(port, n):
    def s16(b):
        return len(b).to_bytes(2, "big") + b
    def pkt(first, body):
        k, out = len(body), bytearray([first])
        while True:
            d, k = k % 128, k // 128
            out.append(d | (0x80 if k else 0))
            if not k:
                break
        return bytes(out) + body
    c = socket.create_connection(("127.0.0.1", port), timeout=10)
    c.sendall(pkt(0x10, s16(b"MQTT") + bytes([4, 2, 0, 60]) + s16(b"geospax-bench")))
    c.recv(4)
    t = s16(b"bench/aq-flood")
    buf = bytearray()
    for i in range(n):
        msg = {"lat": -5.86 + i * 1e-6, "lon": 144.23, "pm2_5": 10 + (i % 30), "temperature": 20.5}
        buf += pkt(0x30, t + json.dumps(msg).encode())
        if len(buf) > 64_000:
            c.sendall(buf)
            buf.clear()
    c.sendall(bytes(buf) + bytes([0xE0, 0]))
    c.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--bin", default="target/release/geospax-server")
    ap.add_argument("--data", default="data")
    ap.add_argument("--rows", type=int, default=200_000)
    ap.add_argument("--posts", type=int, default=2000)
    ap.add_argument("--messages", type=int, default=5000)
    ap.add_argument("--port", type=int, default=8130)
    ap.add_argument("--out", default="bench/sensors.json")
    a = ap.parse_args()
    rnd = random.Random(1)
    tmp = tempfile.mkdtemp(prefix="geospax-bench-sensors-")
    res = {}
    try:
        # 1. a big logger file through the gallery recipe
        dev = os.path.join(tmp, "BIG-LOGGER")
        os.makedirs(dev)
        csv = os.path.join(dev, "walk.csv")
        big_csv(csv, a.rows, rnd)
        mb = os.path.getsize(csv) / 1e6
        t0 = time.time()
        p = subprocess.run([a.bin, "run", "sensor-log-to-map", "--data", a.data, "--no-device-mounts", "--state-dir", os.path.join(tmp, "s1"),
                            "--input", f"source={dev}", "--json"], capture_output=True, text=True)
        wall = time.time() - t0
        run = json.loads(p.stdout)
        steps = {s["id"]: round(s["ms"]) for s in run["steps"]}
        res["big_file"] = {"rows": a.rows, "mb": round(mb, 1), "status": run["status"], "elapsed_ms": round(run["elapsed_ms"]), "wall_s": round(wall, 1), "steps": steps,
                           "map_why": next((s["why"][0] for s in run["steps"] if s["id"] == "map"), "")}
        print(f"big file: {a.rows:,} rows ({mb:.1f} MB) -> {run['status']} in {run['elapsed_ms'] / 1000:.1f} s  {steps}")

        # 2 + 3. live pushes on a server (with a broker when available)
        broker, margs = None, []
        mosq = shutil.which("mosquitto") or ("/usr/sbin/mosquitto" if os.path.exists("/usr/sbin/mosquitto") else None)
        if mosq:
            broker = subprocess.Popen([mosq, "-p", str(a.port + 1)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.5)
            margs = ["--mqtt", f"mqtt://127.0.0.1:{a.port + 1}/bench/#"]
        srv = subprocess.Popen([a.bin, "--data", a.data, "--no-device-mounts", "--state-dir", os.path.join(tmp, "s2"), "--host", "127.0.0.1",
                                "--port", str(a.port), *margs], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(120):
                try:
                    c = http.client.HTTPConnection("127.0.0.1", a.port, timeout=5)
                    c.request("GET", "/api/health")
                    if c.getresponse().status == 200:
                        break
                except OSError:
                    time.sleep(0.25)
            c = http.client.HTTPConnection("127.0.0.1", a.port, timeout=10)
            lat = []
            t0 = time.time()
            for i in range(a.posts):
                body = json.dumps({"id": "bench-http", "lat": -5.86 + i * 1e-6, "lon": 144.23, "values": {"pm2_5": 10 + i % 30, "temperature": 20.5}})
                t1 = time.perf_counter()
                c.request("POST", "/api/devices/live", body, {"content-type": "application/json"})
                r = c.getresponse()
                r.read()
                lat.append((time.perf_counter() - t1) * 1000)
                if r.status != 200:
                    sys.exit(f"POST failed: {r.status}")
            dt = time.time() - t0
            lat.sort()
            res["http"] = {"posts": a.posts, "per_s": round(a.posts / dt), "p50_ms": round(lat[len(lat) // 2], 2), "p95_ms": round(lat[int(len(lat) * 0.95)], 2)}
            print(f"http push: {a.posts} readings in {dt:.2f} s = {a.posts / dt:.0f}/s (p50 {res['http']['p50_ms']} ms, p95 {res['http']['p95_ms']} ms)")
            if broker:
                def status():
                    c2 = http.client.HTTPConnection("127.0.0.1", a.port, timeout=5)
                    c2.request("GET", "/api/devices")
                    return json.loads(c2.getresponse().read())
                for _ in range(60):
                    if (status().get("mqtt") or [{}])[0].get("connected"):
                        break
                    time.sleep(0.25)
                t0 = time.time()
                mqtt_flood(a.port + 1, a.messages)
                got = 0
                while time.time() - t0 < 60:
                    got = (status().get("mqtt") or [{}])[0].get("messages", 0)
                    if got >= a.messages:
                        break
                    time.sleep(0.05)
                dt = time.time() - t0
                live = {d["id"]: d for d in status()["live"]}
                res["mqtt"] = {"messages": a.messages, "received": got, "seconds": round(dt, 2), "per_s": round(got / dt), "kept_readings": live.get("bench-aq-flood", {}).get("readings")}
                print(f"mqtt: {got}/{a.messages} messages in {dt:.2f} s = {got / dt:.0f}/s; live store keeps the newest {res['mqtt']['kept_readings']}")
            else:
                print("mqtt: skipped (no mosquitto)")
        finally:
            srv.terminate()
            srv.wait(10)
            if broker:
                broker.terminate()
                broker.wait(5)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(res, f, indent=2)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
