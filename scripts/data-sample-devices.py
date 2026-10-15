#!/usr/bin/env python3
"""Build sample "devices" for testing and demos of the device hub (docs/DEVICES.md).

usage: scripts/data-sample-devices.py [OUT_DIR]      (default /tmp/geospax-devices)

Creates, around the synthetic data in the Papua New Guinea highlands:
  TEST-PHONE/   Android layout: DCIM/Camera/*.jpg with EXIF GPS, Android/, Download/morning-walk.gpx
  DJI-SD/       drone card: DCIM/100MEDIA/DJI_*.JPG with EXIF GPS + DJI XMP, DJI_0100.SRT flight telemetry
  GARMIN/       handheld GPS: Garmin/GPX/survey.gpx (track + waypoints)
  inbox/        field folder: logger.nmea (NMEA 0183 log)
  AQ-LOGGER/    portable air-quality monitor: DATA/*.csv (time, lat, lon, PM1/PM2.5/PM10, temperature,
                humidity) from a one-hour walk through town with a roadside PM2.5 hotspot
  WATCH/        sports watch: GARMIN/Activity/*.fit (FIT records: position, heart rate, altitude,
                speed, cadence, temperature)
  live-replay.nmea   for `geospax-server --gps file://OUT_DIR/live-replay.nmea?rate=5`
Needs GDAL command-line tools (gdal_create, gdal_translate). THE DATA IS SYNTHETIC.
"""
import math, os, random, subprocess, sys
from datetime import datetime, timedelta, timezone

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/geospax-devices")
rnd = random.Random(42)
HAGEN = (144.2300, -5.8600)   # Mount Hagen (synthetic cluster centre)
GOROKA = (145.3900, -6.0800)
T0 = datetime(2026, 10, 13, 8, 0, 0, tzinfo=timezone.utc)


def dms(v):
    v = abs(v)
    d = int(v); m = int((v - d) * 60); s = round(((v - d) * 60 - m) * 60, 2)
    return f"({d}) ({m}) ({s})"


def walk(start, n, step_m, heading=60.0, wobble=25.0):
    lon, lat = start
    pts = []
    for _ in range(n):
        heading += rnd.uniform(-wobble, wobble)
        dlat = step_m * math.cos(math.radians(heading)) / 111_320
        dlon = step_m * math.sin(math.radians(heading)) / (111_320 * math.cos(math.radians(lat)))
        lon, lat = lon + dlon, lat + dlat
        pts.append((lon, lat))
    return pts


def geotagged_jpeg(path, lon, lat, alt, when, make, model, direction=None, xmp=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    base = path + ".base.tif"
    rgb = [str(rnd.randint(40, 200)) for _ in range(3)]
    subprocess.run(["gdal_create", "-q", "-of", "GTiff", "-outsize", "64", "48", "-bands", "3", "-ot", "Byte",
                    "-burn", rgb[0], "-burn", rgb[1], "-burn", rgb[2], base], check=True)
    mo = [f"EXIF_GPSLatitude={dms(lat)}", f"EXIF_GPSLatitudeRef={'S' if lat < 0 else 'N'}",
          f"EXIF_GPSLongitude={dms(lon)}", f"EXIF_GPSLongitudeRef={'W' if lon < 0 else 'E'}",
          f"EXIF_GPSAltitude=({alt:.1f})", f"EXIF_DateTimeOriginal={when:%Y:%m:%d %H:%M:%S}",
          f"EXIF_Make={make}", f"EXIF_Model={model}"]
    if direction is not None:
        mo.append(f"EXIF_GPSImgDirection=({direction:.1f})")
    cmd = ["gdal_translate", "-q", "-of", "JPEG", base, path]
    for m in mo:
        cmd += ["-mo", m]
    subprocess.run(cmd, check=True)
    os.remove(base)
    for aux in (path + ".aux.xml",):
        if os.path.exists(aux):
            os.remove(aux)
    if xmp:  # insert an APP1 XMP segment right after SOI, as DJI cameras do
        data = open(path, "rb").read()
        packet = ('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
                  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description '
                  'xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" '
                  + " ".join(f'drone-dji:{k}="{v}"' for k, v in xmp.items())
                  + '/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>').encode()
        body = b"http://ns.adobe.com/xap/1.0/\x00" + packet
        seg = b"\xff\xe1" + (len(body) + 2).to_bytes(2, "big") + body
        open(path, "wb").write(data[:2] + seg + data[2:])


def nmea(sentence):
    cs = 0
    for ch in sentence:
        cs ^= ord(ch)
    return f"${sentence}*{cs:02X}"


def nmea_coord(v, pos, neg, width):
    a = abs(v); d = int(a); m = (a - d) * 60
    return f"{d:0{width}d}{m:07.4f}", pos if v >= 0 else neg


def nmea_log(pts, start, alt=1650.0):
    lines = []
    for i, (lon, lat) in enumerate(pts):
        t = start + timedelta(seconds=i * 2)
        la, ns = nmea_coord(lat, "N", "S", 2)
        lo, ew = nmea_coord(lon, "E", "W", 3)
        lines.append(nmea(f"GPGGA,{t:%H%M%S}.00,{la},{ns},{lo},{ew},1,09,0.9,{alt + i * 0.2:.1f},M,72.0,M,,"))
        lines.append(nmea(f"GPRMC,{t:%H%M%S}.00,A,{la},{ns},{lo},{ew},2.1,{rnd.uniform(0, 360):.1f},{t:%d%m%y},,,A"))
    return "\n".join(lines) + "\n"


def gpx(path, tracks, waypoints):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="GeoSpaX sample devices" xmlns="http://www.topografix.com/GPX/1/1">']
    for name, (lon, lat, ele) in waypoints:
        out.append(f'<wpt lat="{lat:.7f}" lon="{lon:.7f}"><ele>{ele:.1f}</ele><name>{name}</name></wpt>')
    for name, pts, start in tracks:
        out.append(f"<trk><name>{name}</name><trkseg>")
        for i, (lon, lat) in enumerate(pts):
            t = start + timedelta(seconds=i * 10)
            out.append(f'<trkpt lat="{lat:.7f}" lon="{lon:.7f}"><ele>{1640 + i * 0.3:.1f}</ele><time>{t:%Y-%m-%dT%H:%M:%SZ}</time></trkpt>')
        out.append("</trkseg></trk>")
    out.append("</gpx>")
    open(path, "w").write("\n".join(out))


FIT_EPOCH = 631065600  # 1989-12-31T00:00:00Z
CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
             0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]


def fit_crc(data, crc=0):
    for b in data:
        for nib in (b & 0xF, (b >> 4) & 0xF):
            tmp = CRC_TABLE[crc & 0xF]
            crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_TABLE[nib]
    return crc


def fit_file(path, points, start, rnd):
    """Minimal FIT activity (FIT protocol 1.0): file_id + one record per second-ish point."""
    import struct
    body = bytearray()
    # definition: local 0 = file_id (global 0): type enum, manufacturer u16, product u16, serial u32z, time_created u32
    body += bytes([0x40, 0, 0]) + struct.pack("<HB", 0, 5) + bytes([0, 1, 0x00, 1, 2, 0x84, 2, 2, 0x84, 3, 4, 0x8C, 4, 4, 0x86])
    ts0 = int(start.timestamp()) - FIT_EPOCH
    body += bytes([0x00]) + struct.pack("<BHHII", 4, 1, 3121, 3_456_789_012, ts0)
    # definition: local 1 = record (global 20)
    fields = [(253, 4, 0x86), (0, 4, 0x85), (1, 4, 0x85), (3, 1, 0x02), (4, 1, 0x02), (78, 4, 0x86), (73, 4, 0x86), (13, 1, 0x01)]
    body += bytes([0x41, 0, 0]) + struct.pack("<HB", 20, len(fields)) + b"".join(bytes(f) for f in fields)
    semis = lambda d: int(round(d * (2 ** 31) / 180.0))
    hr, alt = 98.0, 1660.0
    for i, (lon, lat) in enumerate(points):
        hr = min(182.0, max(95.0, hr + rnd.uniform(-2, 3.2) - (hr - 150) * 0.03))
        alt += rnd.uniform(-0.6, 0.8)
        speed = max(1.5, 2.9 + rnd.uniform(-0.4, 0.4))
        temp = 19 + i / len(points) * 3 + rnd.uniform(-0.3, 0.3)
        body += bytes([0x01]) + struct.pack("<IiiBBIIb", ts0 + i * 5, semis(lat), semis(lon), int(hr), int(84 + rnd.uniform(-3, 3)),
                                           int(round((alt + 500) * 5)), int(round(speed * 1000)), int(round(temp)))
    header = struct.pack("<BBHI4s", 12 + 2, 0x10, 2132, len(body), b".FIT")
    header += struct.pack("<H", fit_crc(header))
    data = header + bytes(body)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data + struct.pack("<H", fit_crc(data)))


def aq_walk_csv(path, points, start, rnd, hotspot):
    """Air-quality monitor log: 10 s readings; PM rises near a busy roadside (hotspot)."""
    rows = ["timestamp,latitude,longitude,PM1 (µg/m³),PM2.5 (µg/m³),PM10 (µg/m³),Temperature (°C),Humidity (%),accuracy"]
    pm = 9.0
    for i, (lon, lat) in enumerate(points):
        d = math.hypot((lon - hotspot[0]) * 110_500, (lat - hotspot[1]) * 110_500)
        target = 9.0 + 52.0 * math.exp(-(d / 180.0) ** 2)
        pm += (target - pm) * 0.35 + rnd.gauss(0, 1.2)
        pm = max(3.0, pm)
        t = start + timedelta(seconds=10 * i)
        rows.append(f"{t.strftime('%Y-%m-%dT%H:%M:%SZ')},{lat:.6f},{lon:.6f},{pm * 0.68:.1f},{pm:.1f},{pm * 1.6 + rnd.uniform(0, 4):.1f},"
                    f"{18.5 + 3.0 * i / len(points) + rnd.gauss(0, 0.2):.1f},{86 - 14 * i / len(points) + rnd.gauss(0, 1):.0f},{rnd.uniform(3, 9):.0f}")
    # the monitor logs before the GPS has a fix: no position yet
    rows.insert(1, f"{(start - timedelta(seconds=10)).strftime('%Y-%m-%dT%H:%M:%SZ')},,,6.2,9.1,14.0,18.4,87,")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")


def main():
    # 1. Android phone: field-visit photos along a morning walk
    phone = os.path.join(OUT, "TEST-PHONE")
    os.makedirs(os.path.join(phone, "Android", "data"), exist_ok=True)
    route = walk((HAGEN[0] - 0.012, HAGEN[1] + 0.006), 90, 35)
    for i in range(12):
        lon, lat = route[i * 7]
        geotagged_jpeg(os.path.join(phone, "DCIM", "Camera", f"PXL_20261013_{8 + i // 6:02d}{(i * 5) % 60:02d}00.jpg"),
                       lon, lat, 1645 + rnd.uniform(-5, 5), T0 + timedelta(minutes=i * 5), "Google", "Pixel 8",
                       direction=rnd.uniform(0, 360))
    # one photo without GPS (location services off), so "without GPS" counts are exercised
    nogps = os.path.join(phone, "DCIM", "Camera", "IMG_no_gps.jpg")
    subprocess.run(["gdal_create", "-q", "-of", "GTiff", "-outsize", "64", "48", "-bands", "3", "-ot", "Byte",
                    "-burn", "90", nogps + ".base.tif"], check=True)
    subprocess.run(["gdal_translate", "-q", "-of", "JPEG", "-mo", "EXIF_Make=Google", "-mo", "EXIF_Model=Pixel 8",
                    nogps + ".base.tif", nogps], check=True)
    for extra in (nogps + ".base.tif", nogps + ".aux.xml"):
        if os.path.exists(extra):
            os.remove(extra)
    gpx(os.path.join(phone, "Download", "morning-walk.gpx"), [("Morning walk", route, T0)],
        [("Farm A", (*route[30], 1648.0)), ("Water point", (*route[60], 1652.0))])

    # 2. DJI drone SD card: a small survey grid + video telemetry
    dji = os.path.join(OUT, "DJI-SD")
    k = 0
    for row in range(3):
        for col in range(5):
            lon = GOROKA[0] + (col if row % 2 == 0 else 4 - col) * 0.0009
            lat = GOROKA[1] + row * 0.0007
            k += 1
            geotagged_jpeg(os.path.join(dji, "DCIM", "100MEDIA", f"DJI_{k:04d}.JPG"), lon, lat, 1680.0,
                           T0 + timedelta(hours=2, seconds=k * 4), "DJI", "FC3582",
                           xmp={"GimbalYawDegree": f"{90.0 if row % 2 == 0 else -90.0:+.2f}",
                                "RelativeAltitude": "+80.10", "AbsoluteAltitude": "+1680.20"})
    frames = walk((GOROKA[0] - 0.002, GOROKA[1] - 0.001), 60, 12, heading=45, wobble=8)
    srt = []
    for i, (lon, lat) in enumerate(frames):
        a, b = timedelta(milliseconds=i * 33), timedelta(milliseconds=(i + 1) * 33)
        fmt = lambda d: f"00:00:{d.seconds:02d},{d.microseconds // 1000:03d}"
        srt += [str(i + 1), f"{fmt(a)} --> {fmt(b)}",
                f'<font size="28">FrameCnt: {i + 1}, DiffTime: 33ms [iso : 100] [shutter : 1/500.0] '
                f"[latitude: {lat:.6f}] [longitude: {lon:.6f}] [rel_alt: 60.000 abs_alt: 1660.000]</font>", ""]
    os.makedirs(os.path.join(dji, "DCIM", "100MEDIA"), exist_ok=True)
    open(os.path.join(dji, "DCIM", "100MEDIA", "DJI_0100.SRT"), "w").write("\n".join(srt))

    # 3. Handheld GPS (Garmin): survey track + waypoints
    survey = walk((HAGEN[0] + 0.02, HAGEN[1] - 0.015), 120, 25, heading=200)
    gpx(os.path.join(OUT, "GARMIN", "Garmin", "GPX", "survey.gpx"), [("Boundary survey", survey, T0 + timedelta(days=-1))],
        [(f"BM{i}", (*survey[i * 30], 1700.0 + i)) for i in range(4)])

    # 4. Field inbox with an NMEA logger file, and a replay file for live GNSS
    os.makedirs(os.path.join(OUT, "inbox"), exist_ok=True)
    open(os.path.join(OUT, "inbox", "logger.nmea"), "w").write(nmea_log(walk((HAGEN[0] + 0.01, HAGEN[1] + 0.012), 80, 20), T0))
    open(os.path.join(OUT, "live-replay.nmea"), "w").write(nmea_log(walk((HAGEN[0] - 0.004, HAGEN[1] - 0.004), 300, 6), T0))
    # 5. Portable air-quality monitor: a one-hour walk with a roadside PM2.5 hotspot
    aq_route = walk((HAGEN[0] + 0.004, HAGEN[1] + 0.003), 360, 8, heading=110, wobble=18)
    aq_walk_csv(os.path.join(OUT, "AQ-LOGGER", "DATA", "2026-10-13_0900_walk.csv"), aq_route, T0 + timedelta(hours=1), rnd, aq_route[170])
    open(os.path.join(OUT, "AQ-LOGGER", "DEVICE.TXT"), "w").write("Portable PM monitor (synthetic sample)\nfirmware 2.4\n")

    # 6. Sports watch (Garmin layout) with a FIT run: heart rate, altitude, speed, cadence, temperature
    run = walk((HAGEN[0] - 0.015, HAGEN[1] - 0.01), 400, 14, heading=30, wobble=12)
    fit_file(os.path.join(OUT, "WATCH", "GARMIN", "Activity", "2026-10-14-06-30-00.fit"), run, T0 + timedelta(days=1, hours=-1.5), rnd)

    print(f"sample devices written to {OUT}:")
    for d in ("TEST-PHONE", "DJI-SD", "GARMIN", "inbox", "AQ-LOGGER", "WATCH"):
        n = sum(len(f) for _, _, f in os.walk(os.path.join(OUT, d)))
        print(f"  {d:<11} {n} files")


if __name__ == "__main__":
    main()
