#!/usr/bin/env bash
# Install test for the Linux package: install the .deb, then use it the way a new user would.
#
#   scripts/test-package-linux.sh [DEB] [OUT_DIR]      default: newest releases/*.deb, bench/screenshots
#
# Checks: apt resolves the dependencies; both programs are on PATH; the installed server serves the
# UI from /usr/share/geospax/web; `geospax recipes` works without a window; the installed CLI turns a LiDAR
# survey into maps; the desktop app started
# with a fresh HOME creates ~/GeoSpaX (Data, Inbox, README); a GPX dropped into Inbox becomes a
# finished map with no switches; a restart does not redo it. Needs sudo, Xvfb, xwd, netpbm, dbus-x11.
set -uo pipefail
cd "$(dirname "$0")/.."
DEB="${1:-$(ls -t releases/geospax_*.deb 2>/dev/null | head -1)}"
OUT="${2:-bench/screenshots}"
SAMPLES="${SAMPLES:-/tmp/geospax-devices}"
mkdir -p "$OUT" && OUT=$(realpath "$OUT")   # absolute: the app runs from / and the server from /tmp
FAILS=0
ok() { echo "  ok    $1"; }
bad() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }
chk() { if eval "$1"; then ok "$2"; else bad "$2"; fi; }
[ -f "$DEB" ] || { echo "no package (run scripts/package-linux.sh first)"; exit 1; }
[ -d "$SAMPLES/GARMIN" ] || python3 scripts/data-sample-devices.py "$SAMPLES" > /dev/null

echo "== install $DEB"
chk "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --reinstall ./$DEB > /tmp/gx-apt.log 2>&1" "apt installs the package and its dependencies"
chk "[ \"\$(dpkg-query -W -f='\${Version}' geospax)\" = \"$(dpkg-deb -f "$DEB" Version)\" ]" "dpkg knows geospax $(dpkg-deb -f "$DEB" Version)"
chk "command -v geospax >/dev/null && command -v geospax-server >/dev/null" "geospax and geospax-server on PATH"
chk "[ -f /usr/share/applications/geospax.desktop ] && [ -f /usr/share/icons/hicolor/256x256/apps/geospax.png ]" "menu entry and icon installed"
if command -v desktop-file-validate >/dev/null; then
  chk "desktop-file-validate /usr/share/applications/geospax.desktop" "menu entry passes desktop-file-validate"
fi
N=$(cd /tmp && geospax recipes 2>/dev/null | grep -c ' gallery ')
chk "[ \"$N\" -ge 15 ]" "geospax recipes (no window): $N gallery recipes"
# LiDAR with the installed binary: a synthetic survey (LAS) -> terrain + canopy maps, outside the repo
LID=$(mktemp -d)
python3 scripts/data-sample-lidar.py "$LID/scene.las" > /dev/null
(cd /tmp && geospax-server run lidar-to-terrain --state-dir "$LID/state" --input source="$LID/scene.las" > "$OUT/test-package-lidar.log" 2>&1)
chk "ls \"$LID\"/state/runs/*lidar-to-terrain*/canopy.png > /dev/null 2>&1 && grep -q '40 tree tops' \"$OUT/test-package-lidar.log\"" "installed lidar-to-terrain: LAS survey -> terrain and canopy maps, 40 tree tops"
chk "head -c 4 \"$LID\"/state/runs/*lidar-to-terrain*/scene.glb | grep -q glTF && grep -q geospaxScene \"$LID\"/state/runs/*lidar-to-terrain*/scene.html && grep -q '40 trees modelled' \"$OUT/test-package-lidar.log\"" "installed build makes the 3D scene: scene.glb (glTF), offline viewer, 40 trees modelled"
rm -rf "$LID"

echo "== installed web edition"
PORT=8097 ST=$(mktemp -d)
(cd /tmp && mkdir -p "$ST/data" && exec geospax-server --data "$ST/data" --state-dir "$ST/state" --host 127.0.0.1 --port $PORT --no-device-mounts > "$OUT/test-package-server.log" 2>&1) &
SRV=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.25; done
chk "curl -sf http://127.0.0.1:$PORT/ | grep -q '<title>GeoSpaX'" "server started outside the repo serves the UI from /usr/share/geospax/web"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -rf "$ST"

echo "== desktop first run (fresh HOME, started from the menu = no arguments)"
FAKE=$(mktemp -d)
export DISPLAY=:98 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
Xvfb :98 -screen 0 1440x900x24 -nolisten tcp > /dev/null 2>&1 &
XVFB=$!
APP=""
cleanup() { [ -n "$APP" ] && kill "$APP" 2>/dev/null; kill "$XVFB" 2>/dev/null; }
trap cleanup EXIT
sleep 1
start_app() {  # start_app LOG_NAME [phone]
  (cd / && HOME="$FAKE" GEOSPAX_PHONE="$([ "${2:-}" = phone ] && echo 1)" GEOSPAX_PHONE_PORT=18767 \
    exec dbus-launch --exit-with-session geospax > "$OUT/test-package-desktop-$1.log" 2>&1) &
  APP=$!
}
start_app first
for _ in $(seq 1 30); do [ -f "$FAKE/GeoSpaX/README.txt" ] && break; sleep 0.5; done
chk "[ -d \"$FAKE/GeoSpaX/Data\" ] && [ -d \"$FAKE/GeoSpaX/Inbox\" ] && [ -d \"$FAKE/GeoSpaX/.geospax\" ] && [ -f \"$FAKE/GeoSpaX/README.txt\" ]" "~/GeoSpaX created with Data/, Inbox/, .geospax/ and README.txt"
sleep 4
T0=$(date +%s.%N)
cp -r "$SAMPLES/GARMIN" "$FAKE/GeoSpaX/Inbox/"
MAP=""
for _ in $(seq 1 60); do
  MAP=$(ls "$FAKE"/GeoSpaX/.geospax/runs/*track-to-map*/map.png 2>/dev/null | head -1)
  [ -n "$MAP" ] && break; sleep 0.5
done
LAT=$(python3 -c "import time; print(f'{time.time() - $T0:.1f}')")
chk "[ -n \"$MAP\" ] && [ -s \"$MAP\" ]" "GPX dropped into ~/GeoSpaX/Inbox -> finished map in ${LAT} s, no switches"
RUN=$(dirname "${MAP:-/nonexistent/x}")
chk "[ -f \"$RUN/report.html\" ] && ls \"$RUN\"/*.kml > /dev/null 2>&1" "the run also wrote the report and KML"
[ -n "$MAP" ] && cp "$MAP" "$OUT/36-installed-inbox-map.png"
sleep 6   # let the UI pick up the new layers
xwd -root -silent | xwdtopnm 2>/dev/null | pnmtopng > "$OUT/35-installed-desktop-first-run.png"
chk "kill -0 $APP 2>/dev/null" "desktop app still running"
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; APP=""
sleep 1
start_app restart phone
sleep 9   # one device poll and more
RUNS=$(ls -d "$FAKE"/GeoSpaX/.geospax/runs/*track-to-map* 2>/dev/null | wc -l)
chk "[ \"$RUNS\" -eq 1 ]" "restart: the Inbox is not processed again ($RUNS run)"
chk "grep -q 'unchanged since last session' \"$OUT/test-package-desktop-restart.log\"" "restart: log says unchanged since last session"
# the desktop app's phone link (HTTPS on :18767): a photo sent from a "phone" lands in ~/GeoSpaX/Inbox and is mapped
TOKEN=$(python3 -c "import json; print(json.load(open('$FAKE/GeoSpaX/.geospax/phone/link.json'))['token'])" 2>/dev/null || true)
PAGE=$(curl -sk https://127.0.0.1:18767/ | grep -c "send from this phone" || true)
MAPS0=$(ls "$FAKE"/GeoSpaX/.geospax/runs/*/map.png 2>/dev/null | wc -l)
curl -sk --data-binary @"$SAMPLES/TEST-PHONE/DCIM/Camera/PXL_20261013_080500.jpg" \
  "https://127.0.0.1:18767/api/phone/upload?t=$TOKEN&batch=deb1&name=PXL_20261013_080500.jpg" > /dev/null || true
curl -sk -X POST "https://127.0.0.1:18767/api/phone/commit?t=$TOKEN&batch=deb1" > /dev/null || true
# the Inbox already holds the Garmin GPX, so the drop folder is a GPS device: whichever recipe matches maps the photo
MAPS1=$MAPS0
for _ in $(seq 1 40); do
  MAPS1=$(ls "$FAKE"/GeoSpaX/.geospax/runs/*/map.png 2>/dev/null | wc -l)
  [ "$MAPS1" -gt "$MAPS0" ] && break; sleep 0.5
done
NEWRUN=$(ls -td "$FAKE"/GeoSpaX/.geospax/runs/*/ 2>/dev/null | head -1 | xargs -r basename | sed 's/^[0-9-]*-//')
chk "[ \"$PAGE\" -ge 1 ] && ls -d \"$FAKE/GeoSpaX/Inbox/Phone \"* > /dev/null 2>&1 && [ \"$MAPS1\" -gt \"$MAPS0\" ]" "desktop phone link: HTTPS page, photo sent -> ~/GeoSpaX/Inbox/Phone … -> new map ($NEWRUN)"
rm -rf "$FAKE"
echo
if [ "$FAILS" -gt 0 ]; then echo "FAILED: $FAILS check(s)"; exit 1; fi
echo "PASS"
