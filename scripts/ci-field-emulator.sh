#!/usr/bin/env bash
# GeoSpaX Field on a running Android emulator (CI: android-emulator job). Installs the debug APK, gives it
# the location permission, starts geospax-server here with the phone link on, opens the app and runs
# scripts/test-field-emulator.mjs (GPS fixes, pairing, sending a point).
#
#   scripts/ci-field-emulator.sh APK SERVER_BINARY
set -euo pipefail
APK=$1 SERVER=$2
PKG=io.github.jmozez.geospax.field
W=$(mktemp -d)
mkdir -p "$W/inbox" releases

adb wait-for-device
adb install -r -g "$APK"
adb shell pm grant "$PKG" android.permission.ACCESS_FINE_LOCATION
adb shell pm grant "$PKG" android.permission.ACCESS_COARSE_LOCATION
adb shell settings put secure location_mode 3 || true

# the computer side: the emulator reaches this machine's loopback as 10.0.2.2
"$SERVER" --port 18095 --state-dir "$W/state" --inbox "$W/inbox" --no-device-mounts > "$W/server.log" 2>&1 &
SPID=$!
trap 'kill $SPID 2>/dev/null || true; cp "$W/server.log" releases/emulator-server.log || true' EXIT
for i in $(seq 30); do curl -fs http://127.0.0.1:18095/api/health >/dev/null && break; sleep 1; done
PORT=$(curl -fs -X POST http://127.0.0.1:18095/api/phone/enable | python3 -c 'import json,sys; print(json.load(sys.stdin)["port"])')
TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$W/state/phone/link.json")
export PHONE_URL="https://10.0.2.2:$PORT/#t=$TOKEN" INBOX="$W/inbox" SHOT=releases/field-emulator.png

adb emu geo fix 147.1503 -6.7219 40
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
# the WebView's devtools socket appears once the page is up (debug builds only)
SOCK=
for i in $(seq 90); do
  SOCK=$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1 || true)
  [ -n "$SOCK" ] && break
  sleep 2
done
[ -n "$SOCK" ] || { echo "no WebView devtools socket"; adb logcat -d | tail -200; exit 1; }
adb forward tcp:9222 "localabstract:$SOCK"
node scripts/test-field-emulator.mjs || { adb logcat -d | grep -iE 'geospax|chromium|tauri|location' | tail -200; exit 1; }
adb exec-out screencap -p > releases/field-emulator-screen.png || true
