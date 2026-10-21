#!/usr/bin/env bash
# Install and smoke-test the GeoSpaX Windows installer under Wine (Linux dev boxes and CI; no Windows needed).
# Usage: scripts/test-package-windows.sh releases/GeoSpaX_<version>_x64-setup.exe [screenshot-dir]
#
# Checks: silent per-user install (no admin) with Start-menu entries; every DLL geospax.exe and
# geospax-server.exe import is either bundled or part of Windows; the CLI lists recipes and renders a map from
# a Garmin GPX track (bundled GDAL + fonts); geospax-server.exe serves the web UI, layers and reprojected
# vector tiles (bundled PROJ database) to a Linux browser; a camera card on drive E: shows up as a device;
# the phone link answers over HTTPS and a photo sent through it becomes a map; the server subscribes to an MQTT
# broker over TLS (private CA given as a Z:\ path) and maps a LoRaWAN uplink; lidar-to-terrain turns a LAS
# survey into maps and a 3D scene (glTF, viewer, picture) and a LAZ file (laz-rs) is decoded; silent uninstall
# removes the app and its shortcuts.
#
# Not covered here: the desktop window. It needs Microsoft Edge WebView2, which Wine cannot run, so the
# test pre-registers WebView2 to keep the installer from fetching it. The CI "windows" job starts the
# desktop app on a real Windows runner instead.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SETUP=$(realpath "$1")
SHOTS=${2:-}
[ -n "$SHOTS" ] && SHOTS=$(realpath "$SHOTS")
DEV=${GEOSPAX_DEVICES:-/tmp/geospax-devices}      # scripts/data-sample-devices.py
DATA_SRC=${GEOSPAX_DATA:-/opt/geospax-data}       # field_samples.geojson (scripts/data-sample-field.py) and,
                                                  # if present, natural_earth.gpkg (scripts/data-fetch-samples.sh)
PORT=${PORT:-18310}
W=${GEOSPAX_WINE_DIR:-/var/tmp/gx-wine-test}       # on disk: a Wine prefix is ~700 MB and /tmp is often a tmpfs
export WINEPREFIX=$W/prefix WINEDEBUG=-all WINEARCH=win64
# no Mono/Gecko prompts, no Linux menu entries from winemenubuilder
export WINEDLLOVERRIDES="mscoree=;mshtml=;winemenubuilder.exe=d"
OBJDUMP=$(command -v x86_64-w64-mingw32-objdump || command -v llvm-objdump)
PASS=0 FAIL=0
check() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "PASS  $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }
ok() { "$@" >/dev/null 2>&1 && echo 0 || echo 1; }
winpath() { echo "Z:${1//\//\\}"; }

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${BROKER_PID:-}" ] && kill "$BROKER_PID" 2>/dev/null || true
  wineserver -k 2>/dev/null || true
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null || true
  [ "${KEEP:-0}" = 1 ] || rm -rf "$W"   # the Wine prefix is ~800 MB; KEEP=1 leaves it for debugging
}
trap cleanup EXIT

rm -rf "$W" && mkdir -p "$W/data" "$W/state" "$W/run"
# The Wine prefix plus the installed app take ~1.7 GB. With less, the silent installer stops halfway without a
# word and every later check fails for the wrong reason, so say it up front.
free_mb=$(df -Pm "$W" | awk 'NR==2 {print $4}')
if [ "${free_mb:-0}" -lt 1900 ]; then
  echo "FAIL  only ${free_mb} MB free under $W; the Wine prefix and the install need about 1.7 GB (set GEOSPAX_WINE_DIR elsewhere)"
  exit 1
fi
cp "$DATA_SRC/field_samples.geojson" "$W/data/"
python3 "$HERE/data-sample-incidents.py" "$W/data" >/dev/null && rm -f "$W/data/incidents_truth.json"
[ -f "$DATA_SRC/natural_earth.gpkg" ] && cp "$DATA_SRC/natural_earth.gpkg" "$W/data/"
rm -f /tmp/.X97-lock
Xvfb :97 -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
export DISPLAY=:97
t0=$(date +%s)
wineboot --init >/dev/null 2>&1
wineserver -w
echo "Wine $(wine --version) prefix ready in $(( $(date +%s) - t0 )) s"

# Pretend Edge WebView2 is installed (HKLM 32-bit view + HKCU, the two keys the installer reads)
for key in 'HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
           'HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; do
  wine reg add "$key" /v pv /t REG_SZ /d 140.0.0.0 /f >/dev/null 2>&1
done

# --- install
t0=$(date +%s)
setup_rc=0
timeout 300 wine "$SETUP" /S >/dev/null 2>&1 || setup_rc=$?
wineserver -w
EXE=$(find "$WINEPREFIX/drive_c/users" -iname geospax.exe -path '*GeoSpaX*' | awk 'NR==1')
if [ -z "$EXE" ]; then
  echo "FAIL  silent install: geospax.exe not found under drive_c/users (is wine32 installed? the installer is 32-bit)"
  exit 1
fi
INST=$(dirname "$EXE")
check "$([ "$setup_rc" = 0 ] && echo 0 || echo 1)" "silent per-user install in $(( $(date +%s) - t0 )) s (exit code $setup_rc) -> ${INST#"$WINEPREFIX"/}"
for f in geospax-server.exe WebView2Loader.dll gdal.dll share/proj/proj.db share/gdal/gdalvrt.xsd fonts/DejaVuSans.ttf web/index.html \
         geospax-web.cmd recipes/track-to-map.yaml third-party-licenses/PACKAGES.txt uninstall.exe; do
  [ -f "$INST/$f" ] || { echo "      missing $f"; MISSING=1; }
done
check "${MISSING:-0}" "install folder has the server, GDAL/PROJ data, fonts, web UI, recipes, licenses, uninstaller"
SM="$WINEPREFIX/drive_c/users/$USER/AppData/Roaming/Microsoft/Windows/Start Menu/Programs"
check "$([ -n "$(find "$SM" -iname 'GeoSpaX.lnk' | head -1)" ] && [ -f "$SM/GeoSpaX Web Server.lnk" ] && echo 0 || echo 1)" \
  "Start menu: GeoSpaX + GeoSpaX Web Server"
echo "      $(du -sh "$INST" | cut -f1) installed, $(find "$INST" -maxdepth 1 -name '*.dll' | wc -l) DLLs"

# --- every import resolves (bundled or a Windows system DLL); the desktop exe's static stand-in for a GUI run.
# api-ms-win-* / ext-ms-* are API sets (the Universal CRT etc.) that the Windows 10/11 loader resolves itself.
SYS="$WINEPREFIX/drive_c/windows/system32"
unresolved=""
for exe in "$INST/geospax.exe" "$INST/geospax-server.exe" "$INST"/*.dll; do
  for dll in $("$OBJDUMP" -p "$exe" | awk -F'DLL Name: ' '/DLL Name:/{print tolower($2)}' | grep -v '^api-ms-win-\|^ext-ms-'); do
    [ -n "$(find "$INST" "$SYS" -maxdepth 1 -iname "$dll" -print -quit)" ] || unresolved="$unresolved $(basename "$exe"):$dll"
  done
done
check "$([ -z "$unresolved" ] && echo 0 || echo 1)" "every DLL import of geospax.exe, geospax-server.exe and the bundled DLLs resolves${unresolved:+ (missing:$unresolved)}"

SRV="$INST/geospax-server.exe"
# --- CLI: recipes + a map from a GPX track
out=$(timeout 120 wine "$SRV" recipes 2>&1 | tr -d '\r' || true)
check "$(echo "$out" | grep -q track-to-map && echo 0 || echo 1)" "geospax-server.exe recipes lists $(echo "$out" | grep -c '^[a-z]') recipes"
t0=$(date +%s)
json=$(timeout 300 wine "$SRV" run track-to-map --data "$(winpath "$W/data")" --state-dir "$(winpath "$W/state")" \
  --no-device-mounts --input "source=$(winpath "$DEV/GARMIN")" --json 2>"$W/run/stderr.txt" | tr -d '\r' || true)
secs=$(( $(date +%s) - t0 ))
png=$(find "$W/state" -name '*.png' -size +20k | awk 'NR==1')
check "$(echo "$json" | grep -q '"status": *"done"' && [ -n "$png" ] && echo 0 || echo 1)" \
  "run track-to-map (Garmin GPX) -> map PNG $( [ -n "$png" ] && du -k "$png" | cut -f1)KB in ${secs} s"
[ -n "$png" ] && [ -n "$SHOTS" ] && cp "$png" "$SHOTS/37-windows-wine-track-map.png"
run=$(dirname "${png:-$W/state/none/x}")
n=$(ls "$run" 2>/dev/null | grep -cE '\.(svg|kml|geojson|html)$' || true)
check "$([ "${n:-0}" -ge 4 ] && echo 0 || echo 1)" "track-to-map also wrote SVG, KML, GeoJSON and the HTML report ($n files)"
grep -qi "proj.db\|cannot find\|font" "$W/run/stderr.txt" && { echo "      stderr:"; head -5 "$W/run/stderr.txt"; }
# a second recipe: field samples -> kriged surface + standard error, GeoTIFFs written by the bundled GDAL
t0=$(date +%s)
timeout 300 wine "$SRV" run interpolate-samples --data "$(winpath "$W/data")" --state-dir "$(winpath "$W/state")" \
  --no-device-mounts >"$W/run/krige.txt" 2>&1 || true
tif="$W/state/outputs/interpolate-samples/surface.tif"
se="$W/state/outputs/interpolate-samples/surface_se.tif"
check "$([ -f "$tif" ] && [ -f "$se" ] && head -c 4 "$tif" | od -An -c | grep -q 'I   I   \*' && echo 0 || echo 1)" \
  "run interpolate-samples -> kriged surface + standard error GeoTIFFs $( [ -f "$tif" ] && du -k "$tif" | cut -f1)KB in $(( $(date +%s) - t0 )) s"
# a third: incidents -> hot spots (native Gi*), written as a GeoPackage (SQLite + SpatiaLite)
t0=$(date +%s)
timeout 300 wine "$SRV" run points-to-hotspots --data "$(winpath "$W/data")" --state-dir "$(winpath "$W/state")" \
  --no-device-mounts >"$W/run/hot.txt" 2>&1 || true
gpkg="$W/state/outputs/points-to-hotspots/hotspots.gpkg"
check "$([ -f "$gpkg" ] && head -c 15 "$gpkg" | grep -q 'SQLite format 3' && echo 0 || echo 1)" \
  "run points-to-hotspots -> hot spot GeoPackage $( [ -f "$gpkg" ] && du -k "$gpkg" | cut -f1)KB in $(( $(date +%s) - t0 )) s"

# --- LiDAR: a synthetic LAS survey through the whole recipe, and a LAZ file decoded by laz-rs
mkdir -p "$W/lidar"
if python3 -c "import numpy" 2>/dev/null; then
  python3 "$HERE/data-sample-lidar.py" "$W/lidar/scene.las" >/dev/null
  t0=$(date +%s)
  timeout 300 wine "$SRV" run lidar-to-terrain --state-dir "$(winpath "$W/lstate")" --no-device-mounts \
    --input "source=$(winpath "$W/lidar/scene.las")" >"$W/run/lidar.txt" 2>&1 || true
  canopy=$(find "$W/lstate" -name canopy.png -size +20k | awk 'NR==1')
  check "$([ -n "$canopy" ] && tr -d '\r' <"$W/run/lidar.txt" | grep -q '40 tree tops' && echo 0 || echo 1)" \
    "run lidar-to-terrain (LAS survey, 0.7 M points) -> terrain + canopy maps, 40 tree tops in $(( $(date +%s) - t0 )) s"
  [ -n "$canopy" ] && [ -n "$SHOTS" ] && cp "$canopy" "$SHOTS/47-windows-wine-lidar-canopy.png"
  # the 3D scene: glTF from the Windows build (JPEG texture, roofs, CPU-rendered picture with its north arrow)
  glb=$(find "$W/lstate" -name scene.glb -size +100k | awk 'NR==1')
  still=$(find "$W/lstate" -name scene.png -size +50k | awk 'NR==1')
  check "$([ -n "$glb" ] && [ -n "$still" ] && [ "$(head -c 4 "$glb")" = glTF ] && grep -q geospaxScene "$(dirname "$glb")/scene.html" && tr -d '\r' <"$W/run/lidar.txt" | grep -q '40 trees modelled' && echo 0 || echo 1)" \
    "3D scene from the Windows build: scene.glb (glTF), offline viewer, 3D picture, 40 trees modelled"
  [ -n "$still" ] && [ -n "$SHOTS" ] && cp "$still" "$SHOTS/52-windows-wine-scene.png"
else
  echo "  skip  lidar-to-terrain under Wine (python3-numpy not installed)"
fi
LAZ=/var/tmp/geospax-lidar/simple.laz
[ -s "$LAZ" ] || { LAZ="$W/lidar/simple.laz"; curl -sfL --max-time 60 -o "$LAZ" https://github.com/laspy/laspy/raw/master/tests/data/simple.laz || true; }
if [ -s "$LAZ" ]; then
  printf 'recipe: lidar-grid-only\nversion: 1\ntitle: LiDAR grid only (test)\ninputs:\n  source: { type: device, default: auto }\n  epsg: { type: number, default: auto }\nsteps:\n  - id: lidar\n    use: lidar.grid\n    with: { source: "${inputs.source}", epsg: "${inputs.epsg}" }\n' >"$W/lidar/grid-only.yaml"
  json=$(timeout 120 wine "$SRV" run "$(winpath "$W/lidar/grid-only.yaml")" --state-dir "$(winpath "$W/lstate2")" --no-device-mounts \
    --input "source=$(winpath "$LAZ")" --input epsg=2994 --json 2>/dev/null | tr -d '\r' || true)
  check "$(echo "$json" | grep -q '"points": *1065' && echo "$json" | grep -q '"status": *"done"' && echo 0 || echo 1)" \
    "LAZ decoded on Windows (laz-rs): simple.laz, 1065 points, Oregon feet gridded in UTM 10N"
else
  echo "  skip  LAZ under Wine (simple.laz not available offline)"
fi

# --- server: web UI + API + reprojected tiles; camera card on E:
# camera card on E:: a copy of the sample DJI card, with a volume label (Wine reads it from .windows-label)
mkdir -p "$W/card" && cp -r "$DEV/DJI-SD/." "$W/card/" && printf 'DJI-SD' >"$W/card/.windows-label"
ln -sfn "$W/card" "$WINEPREFIX/dosdevices/e:"
# a drive mapped while wineserver runs can miss its label on the first query (Windows reports a plugged-in
# drive's label at once): restart wineserver so the new drive is seen the way Windows sees a fresh card
wineserver -k 2>/dev/null || true
sleep 1
# MQTT broker with a TLS listener and a certificate from a private CA (skipped without mosquitto/openssl)
MOSQ=$(command -v mosquitto || { [ -x /usr/sbin/mosquitto ] && echo /usr/sbin/mosquitto; } || true)
MQTT_ARGS=()
if [ -n "$MOSQ" ] && command -v openssl >/dev/null; then
  T="$W/tls" && mkdir -p "$T"
  EC=(-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes)
  openssl req -x509 "${EC[@]}" -keyout "$T/ca.key" -out "$T/ca.pem" -days 2 -subj "/CN=GeoSpaX Wine Test CA" 2>/dev/null
  openssl req "${EC[@]}" -keyout "$T/server.key" -out "$T/server.csr" -subj "/CN=geospax-wine-broker" 2>/dev/null
  printf 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' >"$T/server.ext"
  openssl x509 -req -in "$T/server.csr" -CA "$T/ca.pem" -CAkey "$T/ca.key" -CAcreateserial -out "$T/server.pem" -days 2 \
    -extfile "$T/server.ext" 2>/dev/null
  printf 'allow_anonymous true\nlistener %s 127.0.0.1\nlistener %s 127.0.0.1\ncafile %s\ncertfile %s\nkeyfile %s\n' \
    "$((PORT + 3))" "$((PORT + 2))" "$T/ca.pem" "$T/server.pem" "$T/server.key" >"$T/mosquitto.conf"
  "$MOSQ" -c "$T/mosquitto.conf" >"$W/run/mosquitto.txt" 2>&1 &
  BROKER_PID=$!
  MQTT_ARGS=(--mqtt "mqtts://127.0.0.1:$((PORT + 2))/v3/%2B/devices/%2B/up?ca=$(winpath "$T/ca.pem")")
fi
wine "$SRV" --data "$(winpath "$W/data")" --state-dir "$(winpath "$W/state-srv")" --host 127.0.0.1 --port "$PORT" \
  --phone --phone-port "$((PORT + 1))" "${MQTT_ARGS[@]}" >"$W/run/server.txt" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
health=$(curl -sf "http://127.0.0.1:$PORT/api/health" || true)
VERSION=$(awk -F'"' '/^version = /{print $2; exit}' "$(dirname "$0")/../Cargo.toml")
check "$(echo "$health" | grep -q "\"$VERSION\"" && echo 0 || echo 1)" "server up: /api/health $health"
check "$(curl -sf "http://127.0.0.1:$PORT/" | grep -qi '<div id="map"\|GeoSpaX' && echo 0 || echo 1)" "web UI served from the install folder (web\\)"
layers=$(curl -sf "http://127.0.0.1:$PORT/api/layers" || true)
nl=$(echo "$layers" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("layers", d) if isinstance(d, dict) else d))' 2>/dev/null || echo 0)
check "$([ "${nl:-0}" -ge "$(ls "$W/data" | wc -l)" ] && echo 0 || echo 1)" "layers loaded: $nl from $(ls "$W/data" | tr '\n' ' ')"
# a z4 tile at the centre of the countries layer (or of the field samples), EPSG:4326 -> 3857 through PROJ
read -r lid tile < <(echo "$layers" | python3 -c '
import json, math, sys
d = json.load(sys.stdin); ls = d.get("layers", d) if isinstance(d, dict) else d
l = next((l for l in ls if "countr" in l["id"].lower()), ls[0])
w, s, e, n = l["bounds"]; lon, lat = (w + e) / 2, (s + n) / 2
z = 4; x = int((lon + 180) / 360 * 2**z)
y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z)
print(l["id"], f"{z}/{x}/{y}")' 2>/dev/null || echo "none 0/0/0")
code=$(curl -s -o "$W/run/tile.mvt" -w '%{http_code}' "http://127.0.0.1:$PORT/tiles/$lid/$tile" || true)
check "$([ "$code" = 200 ] && [ "$(stat -c %s "$W/run/tile.mvt" 2>/dev/null || echo 0)" -gt 100 ] && echo 0 || echo 1)" \
  "vector tile $lid $tile (EPSG:4326 -> 3857 via the bundled proj.db): HTTP $code, $(stat -c %s "$W/run/tile.mvt" 2>/dev/null || echo 0) bytes"
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/api/devices" >"$W/run/devices.json" 2>/dev/null && grep -q '"E:' "$W/run/devices.json" && break
  sleep 1
done
read -r e_ok others summary < <(python3 - "$W/run/devices.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(1, 1, "no device list"); sys.exit()
ds = d.get("devices", []) if isinstance(d, dict) else d
roots = [str(x.get("root", "")) for x in ds]
e = [x for x in ds if str(x.get("root", "")).upper().startswith("E:")]
bad = [r for r in roots if r.upper().startswith(("C:", "Z:"))]
desc = "; ".join(f'"{x.get("name")}" ({x.get("kind")}, {x.get("root")}, {x.get("photos_geotagged", 0)} geotagged photos)' for x in e) or "none"
print(0 if e else 1, 1 if bad else 0, desc + (f" | also scanned: {bad}" if bad else ""))
PY
)
check "$e_ok" "camera card on drive E: detected as a device: $summary"
check "$others" "C: (Windows) and Z: (the Linux root) are not scanned as devices"
# phone link: HTTPS (rustls/ring in the Windows build), pairing code, upload, commit -> a map
PH="https://127.0.0.1:$((PORT + 1))"
TOKEN=$(curl -sf "http://127.0.0.1:$PORT/api/phone" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("url") or "#t=").split("#t=")[1])' 2>/dev/null || true)
page=$(curl -sk "$PH/" | grep -o "send from this phone" | head -1 || true)
up=$(curl -sk --data-binary @"$DEV/TEST-PHONE/DCIM/Camera/PXL_20261013_080500.jpg" "$PH/api/phone/upload?t=$TOKEN&batch=wine1&name=PXL_20261013_080500.jpg" || true)
com=$(curl -sk -X POST "$PH/api/phone/commit?t=$TOKEN&batch=wine1" || true)
phone_run=none
for _ in $(seq 1 40); do   # the run appears, then finishes (slower under Wine)
  phone_run=$(curl -sf "http://127.0.0.1:$PORT/api/runs" | python3 -c '
import json, sys
rs = [r for r in json.load(sys.stdin)["runs"] if (r.get("trigger") or {}).get("device") == "From phone"]
print(rs[0]["recipe"] + " " + rs[0]["status"] if rs else "none")' 2>/dev/null || echo none)
  case "$phone_run" in *" done"|*" failed") break ;; esac
  sleep 1
done
check "$([ -n "$page" ] && echo "$up" | grep -q '"gps":"photo"' && echo "$com" | grep -q '"ok":true' && [ "$phone_run" = "photos-to-map done" ] && echo 0 || echo 1)" \
  "phone link over HTTPS: page, upload (photo GPS found), commit -> $phone_run"
# MQTT over TLS from the Windows build (rustls/ring and Mozilla's roots compiled with MinGW) + a LoRaWAN uplink
if [ ${#MQTT_ARGS[@]} -gt 0 ]; then
  lora=$(python3 - "$HERE/test-sensor-networks.py" "$PORT" <<'PY' 2>&1 || true
import importlib.util, json, sys, urllib.request
spec = importlib.util.spec_from_file_location("sn", sys.argv[1]); sn = importlib.util.module_from_spec(spec); spec.loader.exec_module(sn)
port = int(sys.argv[2])
def devices():
    return json.load(urllib.request.urlopen("http://127.0.0.1:%d/api/devices" % port, timeout=10))
if not sn.wait_for(lambda: (devices()["mqtt"] or [{}])[0].get("connected"), 40):
    print("not connected: %s" % ((devices()["mqtt"] or [{}])[0].get("error"),))
    sys.exit(0)
sn.mqtt_publish(port + 3, "v3/air-quality@ttn/devices/wine-node/up", sn.ttn_uplink("wine-node", 21.5, -9.44, 147.19))
l = sn.wait_for(lambda: next((x for x in devices()["live"] if x["id"] == "wine-node"), None), 15)
print("%s connected; %s" % (devices()["mqtt"][0]["url"], "wine-node from %s: pm2_5 %s" % (l["source"], l["values"].get("pm2_5")) if l else "no uplink"))
PY
)
  check "$(case "$lora" in *"LoRaWAN · TTN: pm2_5 21.5"*) echo 0 ;; *) echo 1 ;; esac)" \
    "MQTT over TLS from the Windows build (private CA at a Z:\\ path) + TTN uplink: $lora"
else
  echo "skip  mqtts:// check (needs mosquitto and openssl)"
fi
if [ -n "$SHOTS" ] && [ -d "${PW:-/opt/pw/node_modules/playwright}" ]; then
  PW=${PW:-/opt/pw/node_modules/playwright} node -e '
    const { chromium } = require(process.env.PW);
    (async () => {
      const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
      const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
      await p.goto(process.argv[1], { waitUntil: "networkidle" });
      await p.waitForTimeout(4000);
      await p.screenshot({ path: process.argv[2] });
      await b.close();
    })().catch(e => { console.error(e); process.exit(1); });' "http://127.0.0.1:$PORT/" "$SHOTS/38-windows-wine-web-ui.png" \
    && echo "      screenshot $SHOTS/38-windows-wine-web-ui.png"
fi
kill "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
wineserver -k 2>/dev/null || true
sleep 1

# --- uninstall
timeout 120 wine "$INST/uninstall.exe" /S >/dev/null 2>&1 || true
for _ in $(seq 1 60); do [ -f "$INST/geospax.exe" ] || break; sleep 1; done
wineserver -w
check "$([ ! -f "$INST/geospax.exe" ] && [ ! -f "$INST/gdal.dll" ] && [ ! -f "$SM/GeoSpaX Web Server.lnk" ] && echo 0 || echo 1)" \
  "silent uninstall removed the app, its DLLs and the Start-menu entries"

echo "Windows package (Wine): $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
