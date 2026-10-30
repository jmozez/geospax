#!/usr/bin/env bash
# GeoSpaX: build the AppImage, one file that runs on most Linux distributions without installing.
#
#   scripts/package-appimage.sh [OUT_DIR]          default OUT_DIR: releases/
#
# Built with Tauri's AppImage bundler, which copies the libraries GeoSpaX needs (GDAL, PROJ, WebKitGTK …)
# into the image; GDAL's and PROJ's data, the recipes, samples and plugins go in usr/share like the .deb.
# The AppImage runs on systems with the build system's glibc or newer: CI builds it on Ubuntu 22.04 (glibc 2.35)
# with GDAL 3.8 from the UbuntuGIS PPA, so it also runs on Mint 21 and Debian 12; scripts/check-glibc.sh enforces it.
# An AppRun hook sets WEBKIT_DISABLE_DMABUF_RENDERER=1 unless already set (blank windows on some GPU drivers).
# With TAURI_SIGNING_PRIVATE_KEY set it is also signed for the in-app updater (.AppImage.sig).
# BUNDLES=appimage,deb also writes a .deb from the Tauri bundler (needs libgdal34, so Ubuntu 22.04 with the
# UbuntuGIS PPA, Ubuntu 24.04 or Mint 22).
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

BUNDLES="${BUNDLES:-appimage}"
CONFIG=$(python3 - "$ST" "$GDAL_SHARE" "$PROJ_SHARE" "${TAURI_SIGNING_PRIVATE_KEY:+1}" <<'PY'
import json, sys
st, gdal, proj, sign = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
share = {"/usr/share/geospax": f"{st}/geospax"}
print(json.dumps({"bundle": {
    "createUpdaterArtifacts": bool(sign),
    "linux": {"appimage": {"bundleMediaFramework": False, "files": {
        "usr/share/gdal": gdal, "usr/share/proj": proj, "usr/share/geospax": f"{st}/geospax"}},
        "deb": {"depends": ["libgdal34 | libgdal34t64", "gdal-data", "proj-data"], "files": share},
        "rpm": {"depends": ["gdal-libs", "proj-data"], "files": share}}}}))
PY
)

echo "== web UI + AppImage (Tauri bundler)"
(cd web && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npx vite build --logLevel warn)
(cd apps/desktop && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && \
  npx tauri build --verbose --bundles "$BUNDLES" --config "$CONFIG" --features custom-protocol)
mkdir -p "$OUT"
for f in target/release/bundle/deb/*.deb target/release/bundle/rpm/*.rpm; do
  [ -f "$f" ] && [ "$f" -nt "$ST" ] && cp "$f" "$OUT/" && echo "== $OUT/$(basename "$f")"
done
case ",$BUNDLES," in *,appimage,*) ;; *) exit 0 ;; esac

IMG="$ROOT/$(ls -t target/release/bundle/appimage/*.AppImage | head -1)"
DEST="$(cd "$OUT" && pwd)/GeoSpaX-$VERSION-x86_64.AppImage"

echo "== AppRun hook (WEBKIT_DISABLE_DMABUF_RENDERER) and repack"
WORK="$ROOT/target/appimage-repack"
rm -rf "$WORK" && mkdir -p "$WORK"
(cd "$WORK" && "$IMG" --appimage-extract > /dev/null)
mkdir -p "$WORK/squashfs-root/apprun-hooks"
cp packaging/appimage/geospax-env.sh "$WORK/squashfs-root/apprun-hooks/geospax-env.sh"
grep -q apprun-hooks "$WORK/squashfs-root/AppRun" || { echo "AppRun does not read apprun-hooks"; exit 1; }
TOOL="$HOME/.cache/geospax/appimagetool-x86_64.AppImage"
if [ ! -x "$TOOL" ]; then
  mkdir -p "$(dirname "$TOOL")"
  curl -sSfL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi
rm -f "$DEST" "$DEST.sig"
ARCH=x86_64 "$TOOL" --no-appstream "$WORK/squashfs-root" "$DEST" > /dev/null
chmod 755 "$DEST"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  (cd apps/desktop && npx tauri signer sign "$DEST" > /dev/null)
fi
scripts/check-glibc.sh "${GLIBC_MAX:-2.35}" "$WORK/squashfs-root/usr/bin" "$WORK/squashfs-root/usr/lib"
rm -rf "$WORK"
echo "== $DEST ($(du -h "$DEST" | cut -f1))"
echo "run: chmod +x $(basename "$DEST") && ./$(basename "$DEST")"
