#!/usr/bin/env bash
# Run the GeoSpaX desktop edition on a virtual X display (Linux, headless/CI) and screenshot it.
#   scripts/test-desktop.sh DATA_DIR OUT_DIR [URL_QUERY] [SECONDS]
# URL_QUERY e.g. "bench=1&transport=invoke" auto-runs the camera-tour benchmark;
# "gldebug=1" screenshots once the map is idle; COVERAGE_MAX=5 then fails on dropped tiles.
# the report is appended to $OUT_DIR/desktop-bench.jsonl.
# Needs: Xvfb, xwd (x11-apps), netpbm, dbus-launch (dbus-x11).
# NOTE: Xvfb renders WebGL in software (llvmpipe) - functional check, not a GPU benchmark.
set -euo pipefail
DATA="${1:-data}"
OUT="${2:-bench/screenshots}"
QUERY="${3:-}"
WAIT="${4:-40}"
BIN="${BIN:-target/release/geospax}"
mkdir -p "$OUT"
export DISPLAY=:99
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
APP=""
cleanup() { [ -n "$APP" ] && kill "$APP" 2>/dev/null; kill "$XVFB" 2>/dev/null || true; }
trap cleanup EXIT
sleep 1
# WebKitGTK on a virtual display: no DMA-BUF, software GL.
export WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
export GEOSPAX_BENCH_LOG="$(realpath "$OUT")/desktop-bench.jsonl"
NAME="desktop"
if [ -n "$QUERY" ]; then
  export GEOSPAX_URL_QUERY="$QUERY"
  NAME="desktop-$(printf '%s' "$QUERY" | tr -c 'A-Za-z0-9.-' '_')"  # safe file name (view=z/lat/lon has slashes)
fi
LINES_BEFORE=$( [ -f "$GEOSPAX_BENCH_LOG" ] && wc -l < "$GEOSPAX_BENCH_LOG" || echo 0)
dbus-launch --exit-with-session "$BIN" "$DATA" > "$OUT/$NAME.log" 2>&1 &
APP=$!
for _ in $(seq 1 "$WAIT"); do
  sleep 1
  kill -0 "$APP" 2>/dev/null || { echo "desktop app exited early:"; cat "$OUT/$NAME.log"; exit 1; }
  if [ -n "$QUERY" ] && [ -f "$GEOSPAX_BENCH_LOG" ]; then
    NEW=$(tail -n +"$((LINES_BEFORE + 1))" "$GEOSPAX_BENCH_LOG")
    # client-log lines (from /api/log) are diagnostics, not benchmark reports
    if printf '%s\n' "$NEW" | grep -v '"kind":"client-log"' | grep -q .; then
      echo "benchmark report received"; sleep 2; break
    fi
    # with gldebug (and no bench tour), screenshot once the map reports idle
    case "$QUERY" in *bench*) ;; *)
      if printf '%s\n' "$NEW" | grep -q 'map idle'; then
        echo "map idle: $(printf '%s\n' "$NEW" | grep -o 'map idle after [0-9]* ms')"; sleep 2; break
      fi ;;
    esac
  fi
done
xwd -root -silent | xwdtopnm 2>/dev/null | pnmtopng > "$OUT/$NAME.png"
echo "screenshot: $OUT/$NAME.png"
if [ -n "${COVERAGE_MAX:-}" ]; then
  # Dropped-tile regression check (README finding 17); needs a dense view, e.g. URL_QUERY with view=12/-5.86/144.23
  python3 "$(dirname "$0")/test-tile-coverage.py" "$OUT/$NAME.png" --max-empty "$COVERAGE_MAX" || { echo "--- app log ---"; head -20 "$OUT/$NAME.log"; exit 1; }
fi
echo "--- app log ---"; head -20 "$OUT/$NAME.log"
