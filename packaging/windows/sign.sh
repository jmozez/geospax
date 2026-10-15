#!/usr/bin/env bash
# Authenticode-sign one Windows file in place (scripts/package-windows.sh calls this for geospax-server.exe, and
# Tauri's bundler calls it for geospax.exe and the installer through bundle.windows.signCommand).
#   WINDOWS_SIGN_PFX        PKCS#12 file with a code-signing certificate and its key (required)
#   WINDOWS_SIGN_PASSWORD   its password (optional)
#   WINDOWS_SIGN_TIMESTAMP  RFC 3161 time-stamping server (default http://timestamp.digicert.com; empty = none)
# A real certificate from a CA is what makes Windows SmartScreen trust the installer; a self-signed one only
# proves the plumbing works.
set -euo pipefail
f="$1"
: "${WINDOWS_SIGN_PFX:?set WINDOWS_SIGN_PFX to a .pfx code-signing certificate}"
ts=${WINDOWS_SIGN_TIMESTAMP-http://timestamp.digicert.com}
tmp="$f.signing"
osslsigncode sign -pkcs12 "$WINDOWS_SIGN_PFX" ${WINDOWS_SIGN_PASSWORD:+-pass "$WINDOWS_SIGN_PASSWORD"} \
  -n "GeoSpaX" -h sha256 ${ts:+-ts "$ts"} -in "$f" -out "$tmp" > /dev/null
mv -f "$tmp" "$f"
echo "signed $(basename "$f")"
