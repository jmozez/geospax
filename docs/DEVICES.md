# Device and sensor hub

GeoSpaX reads location and remote-sensing data straight from connected devices: phones, GPS/GNSS receivers, sports
watches, drones, cameras, sensor loggers and live IoT sensors. A plugged-in device can start a recipe by itself
([AUTOMATION.md](AUTOMATION.md) §3, `device` trigger), and a live sensor reading can too (`sensor` trigger: a
threshold or a geofence). That's the lazy-mapper promise: **plug it in, get a map. A sensor sees something, get a map.**

## 1. What GeoSpaX reads

| Device | Typical connection | What GeoSpaX extracts | Now |
|---|---|---|---|
| **Android phone** | **Wi-Fi via the phone link (scan a QR code, §3a)**, USB (MTP; mounted by gvfs on Linux), OwnTracks over MQTT | Photos with EXIF GPS (position, altitude, direction, time, camera); GPX/KML from tracker apps; sensor-app CSV exports; live location | ✅ mounted storage · phone page · OwnTracks · sensor-app CSV |
| **iPhone / iPad** | **Wi-Fi via the phone link (§3a)**, USB (PTP; gphoto2 mount on Linux), Files export, OwnTracks | JPEG/HEIC EXIF GPS; live location; sensor-app CSV exports (e.g. SensorLog) | ✅ JPEG; ✅ HEIC (verified with a libheif-encoded file; real iPhone files untested); phone page ✅ |
| **Handheld GPS** (Garmin and similar) | USB mass storage | GPX tracks and waypoints (`Garmin/GPX`); FIT activities | ✅ GPX · ✅ FIT |
| **Sports watches, bike computers, fitness sensors** | USB mass storage (`GARMIN/Activity/*.fit`), exported FIT files | Track + one reading per record: heart rate, cadence, power, temperature, altitude, speed, distance (units from the FIT profile) | ✅ FIT (`fitparser`, MIT) |
| **Sensor loggers**: portable air-quality monitors, weather, soil and water probes, IoT data loggers | USB / SD card / synced folder | CSV, TSV or JSON lines with latitude/longitude columns → a **readings** point layer (every numeric column, units from headers such as `PM2.5 (µg/m³)`), plus a track when the logger moved | ✅ |
| **GNSS receivers, RTK rovers** | USB/serial (NMEA 0183), Bluetooth SPP (`/dev/rfcomm*`), TCP, gpsd | Live fixes (GGA/RMC: position, altitude, speed, course, quality, satellites, HDOP) | ✅ NMEA (serial, TCP, file replay), gpsd · UBX, NTRIP/RTCM corrections, RINEX post-processing (RTKLIB) in P3 |
| **Live environmental / IoT sensors** | **MQTT** (built-in 3.1.1 subscriber, plain or TLS `mqtts://`), **HTTP push** (`POST /api/devices/live`) | Located readings → live layer, Devices pane values, `sensor` triggers (threshold, geofence) | ✅ MQTT · ✅ mqtts (own CA, client certificates) · ✅ HTTP |
| **LoRaWAN sensors** (air quality, water tanks, soil, rain gauges, GPS trackers) | Your network server's MQTT feed: **The Things Stack** (TTN v3) or **ChirpStack** (v4 and v3), or a TTN webhook to `POST /api/devices/live` | Decoded payload values, strongest gateway's RSSI/SNR, number of gateways; position from the payload (trackers), the console location, or the receiving gateway (§4) | ✅ |
| **OGC SensorThings services** (public air-quality and water-level networks, FROST servers, city IoT platforms) | HTTP polling (`--sta URL`) | Every station with a location → live sensor with the newest value of each datastream, named after the observed property with its unit (§4) | ✅ |
| **Drones** (DJI and others) | SD card / USB | Photo EXIF GPS + DJI XMP (gimbal yaw, relative altitude); `.SRT` video telemetry as flight tracks | ✅ |
| **Cameras** (GPS-enabled or phone-tagged) | SD / USB / PTP | EXIF GPS | ✅ |
| **Action cams** (GoPro, Insta360) | SD / USB | GPMF telemetry in MP4 (GPS, IMU) as tracks | P3 |
| **Thermal cameras** (FLIR R-JPEG, DJI thermal) | SD / USB | EXIF GPS ✅; radiometric temperature → temperature raster | P3/P4 |
| **Multispectral cameras** (MicaSense, DJI Multispectral, Parrot Sequoia) | SD / USB | Per-band TIFF with EXIF/XMP (band, irradiance) → reflectance, NDVI through OpenDroneMap | EXIF GPS ✅ · bands in P4 |
| **LiDAR point clouds** (drone LiDAR such as DJI Zenmuse L1/L2 after DJI Terra, airborne surveys, national LiDAR tiles, handheld SLAM exports) | USB drive, SD card, synced or drop folder | `.las`/`.laz` (LAS 1.0–1.4, COPC) counted from their headers: points, coordinate system, footprint, height range → `lidar` device; `lidar-to-terrain` makes bare-earth terrain, surface and canopy rasters, buildings and tree tops ([AUTOMATION.md §6c](AUTOMATION.md#6c-lidar-point-clouds-built)) and a 3D scene ([§6d](AUTOMATION.md#6d-3d-scenes-built)). A drop folder may hold a *link* to a folder of tiles: symlinks are followed (within the usual depth and file limits) | ✅ LAS/LAZ · E57/PLY and raw DJI `.LDR` not read (export LAS from the vendor software) |
| **Field spectroradiometers** | Files with GPS | Spectra → spectral-library points for classification | P4 |
| **Satellites** (a sensor, not a device) | STAC APIs | New scenes over your area → `stac` trigger → terrain/NDVI autopilot | ✅ Sentinel-2 L2A via Earth Search ([AUTOMATION.md §6b](AUTOMATION.md#6b-rasters-remote-sensing-and-providers-built)) |

## 2. Connections by edition and OS

| Connection | Desktop (Tauri) | Web edition | Notes |
|---|---|---|---|
| USB mass storage, SD cards | ✅ Linux `/media/$USER/*`, `/run/media/$USER/*`; macOS `/Volumes/*`; Windows: removable drive letters plus any drive with `DCIM`/`GARMIN`/`PRIVATE` at the top (fixed disks are skipped), named by volume label | Server-side only | Polled every 5 s; inotify/FSEvents later |
| Phones over MTP / PTP | ✅ Linux via gvfs mounts (`/run/user/<uid>/gvfs/mtp:*`, `gphoto2:*`) · Windows WPD and macOS in P3 | – | MTP reads are slow, so scans are bounded and cached |
| Serial / USB-CDC GNSS, Bluetooth SPP | ✅ Unix device files (`/dev/ttyUSB*`, `/dev/ttyACM*`, `/dev/rfcomm*`) · Windows COM ports (`serial://COM3?baud=4800`; line set with `mode.com`; not yet tried with real hardware) | Server-side only | BLE GNSS and BLE sensors (`btleplug`) in P3 |
| NMEA over TCP, gpsd | ✅ | ✅ (server) | Many phone apps and RTK receivers stream NMEA over TCP |
| **MQTT broker** (Mosquitto, EMQX, HiveMQ, Home Assistant, OwnTracks, The Things Stack, ChirpStack, AWS IoT Core) | ✅ `GEOSPAX_MQTT` | ✅ `--mqtt` | Subscribes with QoS 0, acknowledges QoS 1, reconnects with back-off (2 s → 60 s). `mqtt://` (plain, port 1883) or `mqtts://` (TLS 1.2/1.3 via rustls, port 8883): the broker's certificate is checked against Mozilla's CA list or your own CA (`?ca=`); client certificates with `?cert=&key=` |
| **OGC SensorThings API** (v1.0, v1.1) | ✅ `GEOSPAX_STA` | ✅ `--sta` | Polled every 60 s (`?every=` 10 s – 1 day); one request per 100 stations; `bbox=` limits it to your area |
| **HTTP push** (any sensor, script or gateway) | ✅ | ✅ | `POST /api/devices/live` with JSON (§4) |
| **Phone link** (Wi-Fi: photos, tracks, logs, camera, live location) | ✅ Devices → *Send from phone* | ✅ (`--phone`) | Any OS, any phone browser, no app. HTTPS with a self-signed certificate on port 8765, pairing code in the QR (§3a) |
| Phone page without the phone link (`/phone.html` from the web edition) | – | ✅ | Live location only, and only over HTTPS or localhost (secure context) |
| Web Serial / Web Bluetooth | – | Optional, Chromium browsers only | Not available in WebKit/Safari |
| Native mobile (Tauri mobile) | P3 | – | Background location, camera capture, phone sensors |

## 3. Automatic workflows

A device recipe runs when its **Auto** switch is on (UI, `--auto`, `GEOSPAX_AUTO`): the device hub calls the
automation engine for every new or changed device with geodata, and the matching recipe gets the device folder as
`source` ([AUTOMATION.md §3](AUTOMATION.md#3-triggers)). A recipe that takes the device replaces the plain auto-import.

**Drop folders are the exception (v1.0).** Files put into `~/GeoSpaX/Inbox` (installed desktop app) or into an
`--inbox DIR` (server) are taken by the matching device recipe *without* an Auto switch, because putting them there
is the consent. Plugged-in phones, cameras and loggers still wait for Auto or a click (§5). The hub also remembers
the content signature it last handled (`<state>/devices/seen.json`): a device that stays plugged in across a restart
is listed but not processed again, while new photos, tracks or appended sensor rows trigger a new run.
Live readings go the same way through the `sensor` trigger.

| Event | Default recipe | State |
|---|---|---|
| Geotagged photos (phone, camera, folder) | `photos-to-map`: photo points with camera-direction wedges, tracks, labelled waypoints; finished PNG/SVG map + report | ✅ ~5 s from plug-in (device poll) to map; the run takes 0.15 s |
| Tracks (GPS unit, watch, logs) | `track-to-map`: lines + waypoints (+ the watch's readings layer), map, KML for Google Earth, GeoJSON, report | ✅ |
| Drone card | `drone-flight-report`: flight path (SRT), photo positions, dissolved ground coverage in hectares (UTM), map + report | ✅ |
| **Sensor logger** (kind `sensor`, has readings) | `sensor-log-to-map`: readings coloured by the main measurement (PM2.5 classes anchored to the WHO guideline), the logger's track, per-measurement statistics, GeoJSON, report | ✅ 0.12 s per run; 5 s from plug-in |
| **Live reading above a threshold** | `air-quality-alert`: `sensor: { field: pm2_5, above: 35, cooldown: 30m }` → snapshot of every live sensor's last 2 h → map + report | ✅ 0.26 s from the reading to a finished map |
| **Device enters an area** | any recipe with `sensor: { inside: <polygon layer> }` (geofence) | ✅ fires on entering; once per cooldown |
| Drone image set | `drone-to-ortho`: orthomosaic + DSM (+ NDVI if multispectral) via OpenDroneMap | planned (P3/P4) |
| Multispectral/thermal frames | Index or temperature rasters after ortho | P4 |
| **LiDAR point clouds** (kind `lidar`, has point clouds) | `lidar-to-terrain`: ground from the vendor classes or the SMRF filter → terrain map (relief, contours, buildings), canopy map (canopy height, tree tops, buildings), canopy-height classes, **3D scene** (terrain, buildings, trees, point cloud: glTF + offline viewer + picture), report | ✅ 3.5 s for 0.7 M points; 8–9 s from dropping a folder to a finished report; 15 s for 10.7 M points |

## 3a. Send from phone (phone link)

The lazy way to get photos and tracks off a phone: no cable, no app, any OS (Windows, macOS, Linux) and any phone
(Android, iPhone).

1. In GeoSpaX, **Devices → Send from phone → Turn on**. A QR code appears (web edition: or start with `--phone`).
2. Point the phone's camera at it. The phone opens the GeoSpaX page and warns once about the certificate, which is
   this computer's own: choose *Advanced → Continue*.
3. **Choose files** (photos from the gallery, GPX/KML tracks, sensor CSVs), **Take a photo**, or **Share live
   location**. When the files are in, GeoSpaX moves them as one batch into the drop folder, the matching recipe
   (photos-to-map, track-to-map, sensor-log-to-map) runs, and the finished map appears on the phone too.

**Where photo locations come from.** Phones often strip GPS from photos picked in the browser, so GeoSpaX tries in order:
- the photo's own EXIF GPS;
- a position from the phone itself: **Take a photo** sends the phone's GPS position along, and GeoSpaX writes it into
  an XMP sidecar (`IMG.jpg.xmp`) only if the photo has no location of its own;
- the GPS track by time. While **Share live location** is on, the phone's live track goes into the batch as a timed
  GPX, and photos without GPS are placed on it by their capture time. The same works for any device or folder that
  holds a GPS track (a Garmin GPX next to camera photos, say): GeoSpaX interpolates between the two track points
  around the photo time, if they are at most 5 minutes apart, and snaps to the nearest point within 60 s of either
  end. The camera's time zone comes from EXIF `OffsetTimeOriginal`, else this computer's. Lightroom, darktable and
  digiKam sidecars (`exif:GPSLatitude`) are read too.

The photos layer records how each photo got its position in a `placed` field (`exif`, `sidecar`, `track`), and
`GET /api/devices` counts them (`photos_placed`).

**Safety.**
- The phone link is off until you turn it on (remembered across restarts; *Turn off* closes the port).
- It listens on its own port (default 8765, or the next free one) with HTTPS. Every request needs the 128-bit
  pairing code from the QR code; **New code** changes it, and phones paired earlier must scan again.
- Apart from upload and commit it forwards only live positions, run status and finished maps; settings and data
  are out of reach.
- Uploads are limited to 64 MB per file (videos are not mapped). A batch the phone never finishes is committed
  after two quiet minutes.
- Files land in the drop folder: desktop `~/GeoSpaX/Inbox/Phone <date time>/`, web edition `--inbox` or
  `<state>/phone/From phone/`.
- The certificate and pairing code live in `<state>/phone/`. On Windows the firewall asks once whether GeoSpaX may
  accept connections on private networks.

| Phone link endpoint (port 8765) | |
|---|---|
| `GET /` | The phone page (pairing code from the QR address, kept in the phone's storage) |
| `GET /api/phone/hello?t=` | Which computer this is, upload limit |
| `POST /api/phone/upload?t=&batch=&name=[&lat=&lon=&acc=&ts=]` | One file (raw body); with a position (camera mode) a sidecar is written if the photo has none |
| `POST /api/phone/commit?t=&batch=[&live=phone-<id>]` | Move the batch into the drop folder (adding the live track as GPX) and look at it now |
| `POST /api/devices/live?t=` · `GET /api/runs?t=` · `GET /api/runs/{id}/files/{name}?t=` | Live location, run status, the finished map and report |

## 4. Sensors in detail

### Sensor files on a device

A file is a **sensor log** when its first lines say so (no configuration):

- **CSV / TSV / TXT** (comma, semicolon or tab; quoted fields; decimal commas with semicolons): the header has a
  latitude column (`lat`, `latitude`, `gps_lat`, `geo:lat`, `locationLatitude(WGS84)` …) and a longitude column
  (`lon`, `lng`, `long`, `longitude`, `geo:long` …). A time column (`time`, `timestamp`, `datetime`, `loggingTime` …)
  is kept as text.
- **JSON lines / JSON arrays** (`.jsonl`, `.ndjson`, `.json`): records with lat/lon keys, a nested
  `location`/`position` object, or a GeoJSON Point `geometry` (values from `properties`).
- **FIT** (`.fit`): every `record` message with a position.

Every numeric column becomes a measurement (up to 32 per file, 64 per device). Names are cleaned to snake_case and
units are taken from the header (`PM2.5 (µg/m³)` → `pm2_5` in µg/m³; `Temperature [°C]` → `temperature` in °C).
Bookkeeping columns (ids, accuracy, HDOP, satellites, bearing) are skipped, and rows without a fix (empty or 0/0
coordinates) are counted and skipped. A logger that moved (timed rows a few metres apart) also gets a **track**; a list
of fixed stations does not. The device's GeoPackage gains a `readings` layer: `time`, `source`, `device` and one real
field per measurement, so every tool, recipe step and R/Python code step can use it.

### Live readings over HTTP

`POST /api/devices/live` takes one JSON object per reading:

```json
{ "id": "aq-01", "name": "Market street monitor", "lat": -5.8601, "lon": 144.2302,
  "values": { "pm2_5": 41.2, "pm10": 66.0, "temperature": 23.1 } }
```

- Flat numeric keys work too (`{"id": "probe-7", "lat": …, "lon": …, "soil_moisture": 31.5}`), and numeric strings count.
- A reading without `lat`/`lon` uses the sensor's last position (fixed stations send it once).
- `t` is optional: seconds or milliseconds since 1970, or ISO 8601 text.
- Live ids are `sensor-<id>` for sensors and `phone-<id>` for the phone page.
- The response gives the live id: `{"ok": true, "device": "sensor-aq-01"}`.

### Live readings over MQTT

`--mqtt mqtt://[user[:password]@]host[:1883]/topic/filter/#` (repeatable; desktop: `GEOSPAX_MQTT=url1,url2`). Each
message is parsed like an HTTP push.

Brokers on the internet need TLS: `mqtts://[user[:password]@]host[:8883]/topic/#`. The broker's certificate must be valid
for the host name and signed by a CA in Mozilla's list (the `webpki-roots` set, built in, so it works the same on
every OS). There is no switch to skip the check. Options after `?`:

| Option | For |
|---|---|
| `ca=/path/ca.pem` | A broker with a certificate from your own CA (a site or lab broker, a Mosquitto you set up) |
| `cert=/path/client.pem&key=/path/client.key` | Brokers that want a client certificate (AWS IoT Core, Azure IoT Hub, Mosquitto with `require_certificate true`) |

Paths with spaces or `&` are percent-encoded (`%20`, `%26`). When TLS fails, the Devices pane says why in words: the
CA is unknown (add `?ca=`), the certificate is for another host name or has expired, the broker wants a client
certificate, or the port speaks plain MQTT. The device id comes from the payload (`id`, `device`, `sensor_id`, `tid`) or
else from the topic (`sensors/aq-02` → `sensors-aq-02`). Supported payloads:

- the generic JSON above;
- **OwnTracks** location messages (`_type: location`; `tst`, `acc`, `vel` in km/h, `batt`). A phone running the free
  OwnTracks app becomes a live device, with no GeoSpaX app on the phone.

Messages that are not JSON objects are counted as ignored. The Devices pane shows each subscription's state, message
count and last error, with passwords masked.

### LoRaWAN sensors (The Things Stack, ChirpStack)

LoRaWAN sensors talk to gateways, and the gateways forward to a network server. GeoSpaX subscribes to the network
server's MQTT feed and recognises its uplink messages, so no adapter or mapping file is needed:

| Network server | Subscribe to | Notes |
|---|---|---|
| **The Things Stack** (TTN v3, The Things Industries) | `mqtts://APP-ID@TENANT:API-KEY@eu1.cloud.thethings.network/v3/%2B/devices/%2B/up` | Username is the application id with `@ttn` on TTN; the password is an API key with "read application traffic". Use your cluster (`eu1`, `nam1`, `au1`) |
| **ChirpStack v4** | `mqtt://chirpstack-host/application/%2B/device/%2B/event/up` | JSON marshaler (the default) |
| **ChirpStack v3** | `mqtt://chirpstack-host/application/%2B/device/%2B/rx` | JSON marshaler |

Or, without a broker: add a **webhook** integration in The Things Stack pointing at `https://your-geospax/api/devices/live`
(uplink messages only). The same message format is understood over HTTP.

What one uplink becomes:

- **Device:** the device id (TTN) or device name (ChirpStack); the Devices pane shows *LoRaWAN · TTN* or
  *LoRaWAN · ChirpStack* as the source.
- **Values:** every number in the decoded payload (`decoded_payload` or `object`, so set up a payload formatter or
  codec). One level of nesting is flattened (`battery.voltage` → `battery_voltage`). It also adds `rssi` and `snr` of
  the strongest gateway and `gateways` (how many heard it), which is handy for coverage maps.
- **Position**, first that applies:
  1. latitude/longitude in the decoded payload (GPS trackers);
  2. the location set for the device in the network console;
  3. the strongest receiving gateway's location, with an accuracy of 2,000 m. The sensor is somewhere near that
     gateway, which is enough to see which area a reading belongs to but not for a street-level map.
- **Ignored:** join, ack, downlink and status events (they carry no readings).

Sensor triggers work as for any live sensor: `air-quality-alert` fires when a LoRaWAN node reports `pm2_5` above 35.

### OGC SensorThings services

The [OGC SensorThings API](https://www.ogc.org/standards/sensorthings/) is how many public sensor networks publish
their data: air-quality and water-level networks, FROST servers, city IoT platforms. `--sta https://host/v1.1`
(desktop: `GEOSPAX_STA=url1,url2`) polls a service; options go after `?`, joined with `&`:

| Option | Default | For |
|---|---|---|
| `every=300` | 60 | Seconds between polls (10 s to 1 day) |
| `bbox=minlon,minlat,maxlon,maxlat` | – | Only stations in your area. Sent to the service as `st_intersects(Locations/location, geography'POLYGON(…)')`, so the service does the filtering |
| `filter=ODATA` | – | Any SensorThings `$filter` on Things, e.g. `filter=substringof('StadtRad',name)`. Encode `&` as `%26` and a literal `+` as `%2B` |
| `max=5000` | 1,000 | Most stations per poll (100 to 10,000) |
| `name=hamburg` | from the host name | The service part of station ids (`sta-hamburg-6211`), for triggers such as `device: "sta-hamburg-*"` |

Big city platforms list tens of thousands of Things; use `bbox=` for the area you map instead of raising `max`.

Tested against two public services (October 2026):

| Service | Command | Result |
|---|---|---|
| Fraunhofer IOSB air-quality FROST (European stations) | `--sta https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1` | 988 stations with `no2`, `pm10`, `pm2_5`, `o3`, `co` … |
| Hamburg urban data platform | `--sta "https://iot.hamburg.de/v1.1?bbox=9.95,53.54,10.03,53.57"` | 293 stations in the bbox (traffic counters, bike-share stations) instead of the first 1,000 of the whole city; German names folded to ASCII (`anzahl_kfz_je_zahlstelle`) |

- One request per 100 stations asks for each Thing's location and, per datastream, only the newest observation
  (`$expand=…Observations($orderby=phenomenonTime desc;$top=1)`). Pages follow `@iot.nextLink`.
- Each Thing with a point location becomes a live sensor `sta-<service>-<id>` with the Thing's name. The service part
  is `name=` or the telling part of the host name (`iot.hamburg.de` → `sta-hamburg-6211`), so two services never mix
  up their stations. Values are named after the
  observed property and its unit: `PM2.5` in µg/m³ → `pm2_5`, `Water level` in cm → `water_level`. Accented letters
  are folded (`Température` → `temperature`); two datastreams with the same name become `pm2_5` and `pm2_5_2`. Things
  without a location and non-numeric results are skipped.
- A station is updated only when its newest observation is newer than at the last poll, so readings are not
  duplicated and triggers fire once per real observation.
- The Devices pane shows each service with its number of stations, updates and the last poll time, or the error
  ([screenshot](../bench/screenshots/42-sensor-networks-devices.png)).

To try all of this without hardware, `scripts/demo-sensor-networks.py` serves a SensorThings service with stations in
Port Moresby and publishes TTN and ChirpStack uplinks to a local broker:

```bash
python3 scripts/demo-sensor-networks.py --mqtt 127.0.0.1:1883 --topic sensors --sta-port 8140 &
geospax-server --mqtt "mqtt://127.0.0.1:1883/sensors/#" --sta "http://127.0.0.1:8140/v1.1?every=10&name=demo" --auto air-quality-alert
```

### Sensor triggers

```yaml
triggers:
  - sensor: { field: pm2_5, above: 35, cooldown: 30m }          # threshold, any live sensor
  - sensor: { field: water_level, above: 2.4, device: "gauge-*" } # wildcard on the sensor id or name
  - sensor: { inside: farm.parcels }                             # geofence: a phone/GNSS/sensor enters a polygon layer
  - sensor: { field: temperature, below: 2, inside: farm.parcels, cooldown: 2h }   # frost inside the parcels
```

- `above:` / `below:` need a `field:`. A geofence alone fires on **entering** (outside → inside).
- With a field, a geofence restricts the threshold to readings inside the polygons.
- `cooldown` (default 10 min) is per recipe and per device.
- The run gets `${trigger.device}`, `${trigger.value}`, `${trigger.threshold}`, `${trigger.lat}`, `${trigger.lon}`,
  `${trigger.text}` (e.g. "AQ CI reported pm2_5 = 48 (above 35) at 08:41") and every value of the reading.
- Inputs named `device`, `lat` and `lon` are filled in.

### Sensor steps

- **`sensor.snapshot`** writes the last `minutes` of live readings to `<recipe>.live_readings`, each sensor's path
  as `<recipe>.live_tracks`, and its latest position (labelled with its name) as `<recipe>.live_latest`.
- **`sensor.summary`** computes count, mean, 95th percentile and maximum per measurement, and flags air quality
  against the **WHO 2021 global air quality guidelines**: PM2.5 15 µg/m³ and PM10 45 µg/m³ (24-hour), NO₂ 25 µg/m³
  (24-hour), O₃ 100 µg/m³ (8-hour), SO₂ 40 µg/m³ (24-hour), CO 4 mg/m³ (24-hour).
  - It picks the field to map: a pollutant first, then heart rate, CO₂, noise, temperature …
  - The report says plainly that single readings only indicate exposure and are not 24-hour means.
- **AutoMap** classes PM2.5 and PM10 at the guideline and the WHO interim targets.
  - PM2.5: 15 / 25 / 37.5 / 50 / 75 µg/m³. PM10: 45 / 50 / 75 / 100 / 150 µg/m³.
  - Colours follow an air-quality index, from green ("guideline met") to dark red ("above IT-1").
  - This replaces statistical breaks that mean nothing to a reader.

## 5. Privacy and safety

- Location history and photo locations are personal data. **Auto-import is off by default**: the first time a device appears, GeoSpaX asks. Drop folders (§3) are the only exception, because you put the files there yourself.
- Live sharing from a phone needs an explicit **Start** on that phone and stops when the page closes. OwnTracks shares only what you configure in the app.
- The phone link (§3a) is off until you turn it on, needs the pairing code from the QR code on every request, uses HTTPS, and stays on your network.
- Everything stays on the machine (desktop) or your own server (web). Nothing goes to third parties; the MQTT broker is one you run or choose.
- MQTT credentials are never shown in the UI or logs. Use `mqtts://` for any broker outside your LAN: certificates are always verified, and there is no "insecure" switch. API keys belong in the URL's password part, which is masked everywhere.
- Exports strip EXIF location unless you choose to keep it. Imports can be forgotten per device.

## 6. Architecture

```
 device roots (mounts, gvfs, --watch dirs)        live sources
        │  poll every 5 s                          phone page / sensors: POST /api/devices/live
        ▼                                          MQTT/TLS subscriber (OwnTracks, sensor JSON, LoRaWAN)
                                                   SensorThings poller
  DeviceWatcher ──► scan (bounded walk, classifiers)  NMEA serial/TCP/file · gpsd
        │            photos: EXIF GPS + DJI XMP                 │
        │            tracks: GPX/KML (GDAL), NMEA, SRT          ▼
        │            sensor logs: CSV/TSV/JSON, FIT       LiveStore (fixes + readings per device)
        ▼                                                    │            │
  import job (job registry) ──► <state>/devices/<id>.gpkg    │            └─► sensor hook ──► sensor triggers
        │                photos · tracks · waypoints · readings              (threshold, geofence, cooldown)
        ▼                                                    ▼
  layers hot-registered in the engine ──► map, symbology,   GET /api/devices/live · /api/devices/readings
                                          recipes, triggers
```

- Code:
  - `crates/engine/src/devices.rs`: discovery, scan, import, live store, NMEA/gpsd/SRT parsers.
  - `crates/engine/src/sensors.rs`: sensor CSV/JSON/FIT readers, live message parsing (including LoRaWAN uplinks), the MQTT client with TLS, WHO guideline levels.
  - `crates/engine/src/sta.rs`: OGC SensorThings polling.
  - `automation/mod.rs` (`on_sensor`): sensor triggers.
- **Device trigger:**
  - With a device recipe on **Auto**, a new device runs that recipe: import → AutoMap → finished map → report.
  - Without one, `--auto-import` (desktop: `GEOSPAX_AUTO_IMPORT=1`) still imports new devices without a click.
  - Several devices at once queue one run per device (measured: phone, drone card and two GPS folders were mapped in 0.3 s after the first scan).
- `geospax run photos-to-map --input source=/media/$USER/PHONE` does the same from the command line. `source: auto`
  picks the connected device (phones and cameras first, sensor loggers last).

## 7. What is built (v1)

**API**

| Method | Path | |
|---|---|---|
| GET | `/api/devices` | Detected devices with scan summary (photos, tracks, waypoints, readings and their fields, `point_clouds` and `cloud_points`), watched roots, live devices with latest values, MQTT subscriptions (`mqtt`), SensorThings services (`sta`) |
| POST | `/api/devices/rescan` | Scan now |
| POST | `/api/devices/{id}/import` | Import as layers (a job; 202 + job id) |
| GET | `/api/devices/live` | Live positions (with latest sensor values) + recent tracks as GeoJSON |
| POST | `/api/devices/live` | Push a fix or a sensor reading (phone page, sensors, gateways) |
| GET | `/api/phone` | Phone link state: running, address, QR code (SVG), drop folder |
| POST | `/api/phone/enable` · `/api/phone/disable` · `/api/phone/reset` | Turn the phone link on or off, or make a new pairing code |
| GET | `/api/devices/readings?minutes=60&device=aq-*` | Live sensor readings as GeoJSON points |

**Options** (server flags; desktop environment variables)

| Server | Desktop | Meaning |
|---|---|---|
| `--watch DIR` (repeatable) | `GEOSPAX_WATCH=dir1:dir2` | Extra folders to treat as devices (e.g. a synced phone folder, a logger's export folder) |
| `--inbox DIR` (repeatable) | `~/GeoSpaX/Inbox` (built in) | Drop folders: the matching device recipe maps whatever lands there, no Auto switch needed |
| `--auto-import` | `GEOSPAX_AUTO_IMPORT=1` | Import new devices automatically (when no device recipe is on Auto) |
| `--auto photos-to-map,sensor-log-to-map,air-quality-alert` | `GEOSPAX_AUTO=…` | Recipes on Auto: plug in (or a sensor reports) → finished map + report |
| `--gps SOURCE` (repeatable) | `GEOSPAX_GPS=src1,src2` | Live GNSS: `/dev/ttyUSB0`, `serial:///dev/ttyACM0?baud=9600`, `tcp://host:port`, `gpsd://host:2947`, `file:///path/log.nmea[?rate=10]` |
| `--mqtt URL` (repeatable) | `GEOSPAX_MQTT=url1,url2` | Live sensors, OwnTracks phones and LoRaWAN uplinks from an MQTT broker: `mqtt://[user:pass@]host[:1883]/topic/#`, `mqtts://…[:8883]/…[?ca=…&cert=…&key=…]` |
| `--sta URL` (repeatable) | `GEOSPAX_STA=url1,url2` | OGC SensorThings services to poll: `https://host/v1.1[?every=60&bbox=minlon,minlat,maxlon,maxlat&filter=…&max=1000]` |
| `--phone`, `--phone-port N` | Devices → *Send from phone* (`GEOSPAX_PHONE=1`, `GEOSPAX_PHONE_PORT` for tests) | Phone link (§3a), default port 8765 |

Imported devices persist: their GeoPackages are re-registered at startup. A device with point clouds imports a
`point_clouds` layer: one footprint per LAS/LAZ file with its points, coordinate system, LAS version and height range
(a tile index). Measured results: [bench/RESULTS.md §10](../bench/RESULTS.md) (devices), §13 (sensors),
§17 (sensor networks) and §18 (LiDAR).

The UI has a **Devices** section in Contents. It lists detected devices with photo, track, reading and point-cloud counts (and the
measurements), live devices with their tracks, live sensors with their latest values, MQTT status and SensorThings services.
**Import & map** styles the new layers with AutoMap (`GET /api/layers/{id}/autostyle`), the same choice a recipe
makes: readings come out coloured by their main measurement, PM in WHO classes. **Send from phone** (§3a) shows the QR code for the phone link; the
phone page it opens sends files, geotagged camera photos and live location.
`scripts/demo-sensor-feed.py` simulates two walking air-quality sensors (HTTP or MQTT) for demos.

**Next:** BLE sensors, GoPro GPMF, thermal and multispectral frames, SensorThings MQTT extension (push instead of polling).
