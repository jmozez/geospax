#!/usr/bin/env python3
"""Demo feed for the sensor networks (docs/DEVICES.md §4), no hardware needed: a mock OGC SensorThings service with
four stations in Port Moresby, plus LoRaWAN uplinks in The Things Stack and ChirpStack formats published to an MQTT
broker. Values drift, and the TTN air-quality node crosses the PM2.5 alert level now and then.

  python3 scripts/demo-sensor-networks.py --mqtt 127.0.0.1:1883 --topic sensors --sta-port 8140 [--every 20]
  geospax-server ... --mqtt "mqtt://127.0.0.1:1883/sensors/#" --sta "http://127.0.0.1:8140/v1.1?every=10"
"""
import argparse
import datetime
import importlib.util
import os
import random
import time

spec = importlib.util.spec_from_file_location("sn", os.path.join(os.path.dirname(os.path.abspath(__file__)), "test-sensor-networks.py"))
sn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mqtt", default="127.0.0.1:1883", help="broker host:port (plain MQTT)")
    ap.add_argument("--topic", default="sensors", help="topic prefix GeoSpaX subscribes to")
    ap.add_argument("--sta-port", type=int, default=8140)
    ap.add_argument("--every", type=float, default=20, help="seconds between updates")
    a = ap.parse_args()
    host, port = a.mqtt.rsplit(":", 1)
    if host not in ("127.0.0.1", "localhost"):
        raise SystemExit("the demo publishes to a local broker only")
    sta = sn.Sta(a.sta_port)
    sta.serve()
    print(f"SensorThings demo service: http://127.0.0.1:{a.sta_port}/v1.1  ·  LoRaWAN uplinks -> {a.mqtt} {a.topic}/…", flush=True)
    rnd = random.Random(7)
    pm, level, n = 18.0, 82.0, 0
    while True:
        now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        t = now.isoformat().replace("+00:00", "Z")
        n += 1
        # SensorThings stations report new observations
        sta.advance(1, "PM2.5", round(max(2, 14 + rnd.gauss(0, 4)), 1), t)
        sta.advance(2, "PM2.5", round(max(2, 9 + rnd.gauss(0, 3)), 1), t)
        sta.advance(4, "Water level", round(112 + 6 * rnd.random(), 1), t)
        # a TTN air-quality node by a smoky road: every 6th update crosses 35 µg/m³
        pm = 41.0 + rnd.random() * 8 if n % 6 == 0 else max(5.0, min(30.0, pm + rnd.gauss(0, 3)))
        try:
            sn.mqtt_publish(int(port), f"{a.topic}/ttn/v3/air-quality@ttn/devices/aq-node-7/up",
                            sn.ttn_uplink("aq-node-7", round(pm, 1), -9.4402, 147.1931, t))
            level = max(20.0, level - rnd.random() * 0.8)
            sn.mqtt_publish(int(port), f"{a.topic}/chirpstack/application/7b2c/device/0004a30b001c0530/event/up",
                            {"time": t, "deviceInfo": {"deviceName": "tank-hohola", "devEui": "0004a30b001c0530"},
                             "object": {"level_cm": round(level, 1), "temperature": round(26 + rnd.gauss(0, 0.5), 1)},
                             "rxInfo": [{"gatewayId": "a84041ffff1ec39c", "rssi": -64 - rnd.randint(0, 8), "snr": round(9 + rnd.random() * 2, 2),
                                         "location": {"latitude": -9.4195, "longitude": 147.1712}}]})
        except OSError as e:
            print(f"broker {a.mqtt}: {e}", flush=True)
        time.sleep(a.every)


if __name__ == "__main__":
    main()
