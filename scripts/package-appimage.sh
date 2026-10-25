#!/usr/bin/env bash
# GeoSpaX: build the AppImage, one file that runs on most Linux distributions without installing.
#
#   scripts/package-appimage.sh [OUT_DIR]          default OUT_DIR: releases/
#
# Built with Tauri's AppImage bundler, which copies the libraries GeoSpaX needs (GDAL, PROJ, WebKitGTK …)
# into the image; GDAL's and PROJ's data, the recipes, samples and plugins go in usr/share like the .deb.
# The AppImage runs on systems with the build system's glibc or newer: CI builds it on Ubuntu 24.04.
# With TAURI_SIGNING_PRIVATE_KEY set it is also signed for the in-app updater (.AppImage.sig).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-releases}"
[ -f /opt/rust-env.sh ] && . /opt/rust-env.sh
[ -x "$HOME/.cargo/bin/cargo" ] && export PATH="$HOME/.cargo/bin:$PATH"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
ROOT=$PWD
# the AppImage tools are AppImages themselves; containers and CI runners have no FUSE to mount them
export APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1

echo "== staging usr/share"
ST="$ROOT/target/appimage-stage"
rm -rf "$ST" && mkdir -p "$ST/geospax/samples" "$ST/geospax/plugins"
cp -r recipes "$ST/geospax/recipes"
cp -r samples/. "$ST/geospax/samples/"
tar -C plugins --exclude=node_modules --exclude=src --exclude=tests -cf - . | tar -C "$ST/geospax/plugins" -xf -
GDAL_SHARE=$(gdal-config --datadir)
PROJ_SHARE=$(dirname "$(find /usr/share /usr/local/share -name proj.db -print -quit 2>/dev/null)")
[ -d "$GDAL_SHARE" ] && [ -f "$PROJ_SHARE/proj.db" ] || { echo "GDAL or PROJ data not found"; exit 1; }

CONFIG=$(python3 - "$ST" "$GDAL_SHARE" "$PROJ_SHARE" "${TAURI_SIGNING_PRIVATE_KEY:+1}" <<'PY'
import json, sys
st, gdal, proj, sign = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
print(json.dumps({"bundle": {
    "createUpdaterArtifacts": bool(sign),
    "linux": {"appimage": {"bundleMediaFramework": False, "files": {
        "usr/share/gdal": gdal, "usr/share/proj": proj, "usr/share/geospax": f"{st}/geospax"}}}}}))
PY
)

echo "== web UI + AppImage (Tauri bundler)"
(cd web && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npx vite build --logLevel warn)
(cd apps/desktop && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && \
  npx tauri build --verbose --bundles appimage --config "$CONFIG" --features custom-protocol)

IMG=$(ls -t target/release/bundle/appimage/*.AppImage | head -1)
mkdir -p "$OUT"
DEST="$OUT/GeoSpaX-$VERSION-x86_64.AppImage"
cp "$IMG" "$DEST" && chmod 755 "$DEST"
[ -f "$IMG.sig" ] && cp "$IMG.sig" "$DEST.sig"
echo "== $DEST ($(du -h "$DEST" | cut -f1))"
echo "run: chmod +x $(basename "$DEST") && ./$(basename "$DEST")"
