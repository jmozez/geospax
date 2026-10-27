#!/usr/bin/env bash
# Run the whole GeoSpaX test suite with one command and print a pass/fail summary
# (engine, tiles, stress, web UI incl. the ribbon tools, devices + sensors, automation + sensor triggers, MQTT, sensor networks, LiDAR,
# spatial statistics, desktop).
#   scripts/test-all.sh [DATA_DIR] [OUT_DIR]
# Expects: release binaries built (cargo build --release -p geospax-server [-p geospax ...]),
# web/dist built, sample data from scripts/data-fetch-samples.sh (the soil samples of
# scripts/data-sample-field.py are added to DATA when missing). Optional parts are skipped
# when their tools are missing: Playwright (PW=.../node_modules/playwright) for the web UI
# tests, Xvfb + target/release/geospax for the desktop test.
set -uo pipefail
cd "$(dirname "$0")/.."
DATA="${1:-data}"
OUT="${2:-bench/screenshots}"
PORT="${PORT:-8099}"
URL="http://127.0.0.1:$PORT"
PW="${PW:-/opt/pw/node_modules/playwright}"
[ -f /opt/rust-env.sh ] && source /opt/rust-env.sh
mkdir -p "$OUT"
declare -a RESULTS
run() {  # run NAME CMD...
  local name="$1"; shift
  echo; echo "=== $name"
  local t0=$SECONDS
  if "$@"; then RESULTS+=("PASS  $name ($((SECONDS - t0)) s)"); else RESULTS+=("FAIL  $name ($((SECONDS - t0)) s)"); fi
}
skip() { RESULTS+=("skip  $1 ($2)"); }

run "engine unit tests" cargo test --release -q -p geospax-engine

# The 60 soil samples the automation, statistics and plugin tests map ("area: auto" picks them)
if [ ! -f "$DATA/field_samples.geojson" ]; then
  echo "adding $DATA/field_samples.geojson (scripts/data-sample-field.py)"
  python3 scripts/data-sample-field.py "$DATA" > /dev/null
fi

# Sample devices (phone, drone card, GPS, inbox, air-quality logger, FIT watch, live GNSS replay)
# and an isolated state dir,
# so the run never touches your project, overviews or imported devices.
SAMPLES="${SAMPLES:-/tmp/geospax-devices}"
python3 scripts/data-sample-devices.py "$SAMPLES" > /dev/null
STATE="$(mktemp -d)"
./target/release/geospax-server --data "$DATA" --state-dir "$STATE" --host 127.0.0.1 --port "$PORT" --web web/dist \
  --no-device-mounts --watch "$SAMPLES/TEST-PHONE" --watch "$SAMPLES/DJI-SD" --watch "$SAMPLES/GARMIN" --watch "$SAMPLES/inbox" \
  --watch "$SAMPLES/AQ-LOGGER" --watch "$SAMPLES/WATCH" \
  --gps "file://$SAMPLES/live-replay.nmea?rate=5" > "$OUT/test-all-server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$STATE"' EXIT
for _ in $(seq 1 60); do curl -sf "$URL/api/health" >/dev/null && break; sleep 0.5; done

run "tiles decode in GDAL" python3 scripts/test-tiles-gdal.py "$URL"
run "API stress (16 clients)" python3 scripts/bench-api-stress.py "$URL" --clients 16 --requests 256
if [ -d "$PW" ]; then
  run "web UI: viewer (Phase 0)" env PW="$PW" node scripts/test-web-viewer.mjs "$URL" "$OUT"
  run "web UI: symbology + overviews (Phase 1)" env PW="$PW" node scripts/test-web-symbology.mjs "$URL" "$OUT"
  run "web UI: devices + sensors (import, phone GPS, live sensor)" env PW="$PW" node scripts/test-web-devices.mjs "$URL" "$OUT"
  run "web UI: automation (run, map, report, auto, save recipe)" env PW="$PW" node scripts/test-web-automation.mjs "$URL" "$OUT"
  run "web UI: workbench (ribbon, docks, attributes, palette)" env PW="$PW" node scripts/test-web-workbench.mjs "$URL" "$OUT"
  run "web UI: every control in Lazy and Pro (ribbon, task bar, tree, cards, Inspector, Toolbox)" env PW="$PW" node scripts/test-web-controls.mjs "$URL" "$OUT"
  # the start screen needs a server with no data of its own
  START_DATA=$(mktemp -d) START_STATE=$(mktemp -d) START_FILES=$(mktemp -d)
  python3 scripts/data-sample-field.py "$START_FILES" >/dev/null
  ./target/release/geospax-server --data "$START_DATA" --state-dir "$START_STATE" --host 127.0.0.1 --port $((PORT + 7)) --web web/dist \
    --no-device-mounts --no-triggers >"$OUT/test-start-server.log" 2>&1 &
  START_PID=$!
  sleep 3
  run "web UI: start screen, drop a file, Finish my map" env PW="$PW" node scripts/test-web-start.mjs "http://127.0.0.1:$((PORT + 7))" "$START_FILES/field_samples.geojson" "$OUT"
  kill "$START_PID" 2>/dev/null || true
  # the ribbon tools need the editing test data (survey points with dates, reserves polygons)
  RIBBON_DATA=$(mktemp -d) RIBBON_STATE=$(mktemp -d)
  python3 scripts/test-edit-data.py "$RIBBON_DATA/data" >/dev/null
  ./target/release/geospax-server --data "$RIBBON_DATA/data" --state-dir "$RIBBON_STATE" --host 127.0.0.1 --port $((PORT + 8)) --web web/dist \
    --no-device-mounts --no-triggers >"$OUT/test-ribbon-server.log" 2>&1 &
  RIBBON_PID=$!
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$((PORT + 8))/api/health" >/dev/null && break; sleep 0.5; done
  run "web UI: ribbon tools (panels, coordinates, swipe, time slider, lasso, edit tools, web map)" env PW="$PW" \
    node scripts/test-web-ribbon.mjs "http://127.0.0.1:$((PORT + 8))" "$OUT"
  kill "$RIBBON_PID" 2>/dev/null || true
  rm -rf "$RIBBON_DATA" "$RIBBON_STATE"
  run "phone link (QR, HTTPS, send, camera, live track, map on the phone)" env PW="$PW" PORT="$((PORT + 21))" \
    node scripts/test-phone-link.mjs target/release/geospax-server "$SAMPLES" "$OUT"
else
  skip "web UI tests" "no Playwright at PW=$PW"
fi
# Recipes from the command line (every gallery recipe) and live triggers (device, folder,
# schedule, after) on a second server with its own state dir.
run "automation: recipes + triggers (CLI, API)" python3 scripts/test-automation.py --bin target/release/geospax-server \
  --data "$DATA" --samples "$SAMPLES" --out "$OUT" --port "$((PORT + 1))"
# MQTT over TLS (private CA, client certificates), LoRaWAN uplinks (TTN, ChirpStack) and OGC SensorThings
# polling against a real mosquitto broker and a mock SensorThings service (skips without mosquitto).
run "sensor networks (mqtts, LoRaWAN, SensorThings)" python3 scripts/test-sensor-networks.py --bin target/release/geospax-server \
  --data "$DATA" --out "$OUT" --port "$((PORT + 30))"
# LiDAR: synthetic scenes with known truth (DTM error, trees, buildings), real LAS/LAZ files
# (downloaded once to /var/tmp/geospax-lidar; skipped offline) and the drop-folder trigger.
run "LiDAR (point clouds -> terrain, canopy, trees, buildings)" python3 scripts/test-lidar.py --bin target/release/geospax-server \
  --out "$OUT" --port "$((PORT + 40))" --results "$OUT/../lidar-results.json"
# Spatial statistics: hot spots (planted clusters) and kriging (known surfaces), cross-checked
# against R spdep and gstat (those checks are skipped without R), plus a million-point timing.
run "plugins (five manifest formats, four runtimes)" python3 scripts/test-plugins.py "$URL"
run "spatial statistics (hot spots, kriging; checked against R spdep + gstat)" python3 scripts/test-stats.py \
  --bin target/release/geospax-server --data "$DATA" --out "$OUT" --pw "$PW" --results "$OUT/../stats-results.json"
if command -v Xvfb >/dev/null && [ -x target/release/geospax ]; then
  run "desktop: render + dropped-tile check" env COVERAGE_MAX=5 scripts/test-desktop.sh "$DATA" "$OUT" "transport=invoke&gldebug=1&view=12/-5.86/144.23" 90
else
  skip "desktop test" "needs Xvfb and target/release/geospax"
fi

echo; echo "=== summary"
printf '%s\n' "${RESULTS[@]}"
! printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL'
