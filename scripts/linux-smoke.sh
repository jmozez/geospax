#!/usr/bin/env bash
# GeoSpaX: start the desktop app on a virtual screen and check it really works on this distribution.
#
#   scripts/linux-smoke.sh NAME COMMAND...       e.g.  linux-smoke.sh ubuntu-22.04 ./GeoSpaX.AppImage --appimage-extract-and-run
#
# Passes when the app is still running after 30 seconds, a GeoSpaX window is on screen, a screenshot of it is
# not blank (ImageMagick counts its colours) and the log has no GLIBC or missing-library errors.
# Writes linux-smoke/NAME.png, NAME.log and NAME.result (PASS or FAIL: reason).
set -uo pipefail
NAME=$1; shift
OUT="${SMOKE_OUT:-linux-smoke}"; mkdir -p "$OUT"
LOG="$OUT/$NAME.log" PNG="$OUT/$NAME.png" RES="$OUT/$NAME.result"
WAIT="${SMOKE_SECONDS:-30}"
fail() { echo "FAIL: $*" | tee "$RES"; tail -40 "$LOG" 2>/dev/null; exit 1; }

export DISPLAY=:99
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp > "$OUT/$NAME.xvfb.log" 2>&1 &
XPID=$!
sleep 2
kill -0 $XPID 2>/dev/null || fail "Xvfb did not start"
# containers run as root without user namespaces, so WebKit's bubblewrap sandbox cannot start there
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 NO_AT_BRIDGE=1 LIBGL_ALWAYS_SOFTWARE=1
if command -v dbus-run-session >/dev/null; then RUN=(dbus-run-session --); else RUN=(); fi
"${RUN[@]}" "$@" > "$LOG" 2>&1 &
APID=$!
for _ in $(seq 1 "$WAIT"); do sleep 1; kill -0 $APID 2>/dev/null || break; done
alive=0; kill -0 $APID 2>/dev/null && alive=1
win=$(xwininfo -root -tree 2>/dev/null | grep -i '"GeoSpaX' | head -1)
if command -v magick >/dev/null; then IMPORT=(magick import) IDENT=(magick identify); else IMPORT=(import) IDENT=(identify); fi
"${IMPORT[@]}" -display :99 -window root "$PNG" 2>>"$OUT/$NAME.xvfb.log" || true
colours=$("${IDENT[@]}" -format '%k' "$PNG" 2>/dev/null || echo 0)
kill $APID 2>/dev/null; sleep 1; pkill -f geospax 2>/dev/null; kill $XPID 2>/dev/null
libs=$(grep -E "GLIBC_[0-9.]+' not found|GLIBCXX_[0-9.]+' not found|error while loading shared libraries|cannot open shared object file" "$LOG" | head -3)
[ -z "$libs" ] || fail "library errors: $libs"
[ "$alive" = 1 ] || fail "the app exited within ${WAIT}s"
[ -n "$win" ] || fail "no GeoSpaX window on screen"
[ "${colours:-0}" -ge 64 ] 2>/dev/null || fail "screenshot looks blank ($colours colours)"
echo "PASS: running ${WAIT}s, window $(echo "$win" | grep -o '"[^"]*"' | head -1), $colours colours" | tee "$RES"
