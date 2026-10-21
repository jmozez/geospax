#!/usr/bin/env bash
# GeoSpaX: build the Linux installer (.deb) with plain dpkg-deb (no extra tooling, no downloads).
#
#   scripts/package-linux.sh [--no-build] [OUT_DIR]          default OUT_DIR: releases/
#
# One package, both editions:
#   /usr/bin/geospax              desktop app (Tauri) + CLI: geospax run|watch|recipes …
#   /usr/bin/geospax-server       web edition + the same CLI; serves /usr/share/geospax/web
#   /usr/share/applications/…     menu entry; icons in hicolor; docs in /usr/share/doc/geospax
#
# Runtime dependencies are computed from the binaries' NEEDED libraries (GDAL, WebKitGTK, …) and
# the Debian packages that own them on *this* machine, so build on the distro you ship for:
# a package built on Debian 13 needs GDAL 3.10 (libgdal36); Ubuntu 24.04 builds get libgdal34.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=1 OUT=releases
for a in "$@"; do case "$a" in --no-build) BUILD=0 ;; -h|--help) sed -n 2,13p "$0"; exit 0 ;; *) OUT="$a" ;; esac; done
[ -f /opt/rust-env.sh ] && . /opt/rust-env.sh
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
ARCH=$(dpkg --print-architecture)
MAINTAINER="${MAINTAINER:-GeoSpaX contributors <maintainers@geospax.invalid>}"

if [ "$BUILD" = 1 ]; then
  echo "== web + release build"
  (cd web && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npx vite build --logLevel warn)
  # same command as the dev loop, so the build cache is shared
  cargo build --release -p geospax-server -p geospax --features geospax/custom-protocol
fi
for b in target/release/geospax target/release/geospax-server web/dist/index.html; do
  [ -e "$b" ] || { echo "missing $b (run without --no-build)"; exit 1; }
done

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
P="$STAGE/geospax_${VERSION}_${ARCH}"
mkdir -p "$P/DEBIAN" "$P/usr/bin" "$P/usr/share/applications" "$P/usr/share/geospax" "$P/usr/share/doc/geospax"

echo "== files"
strip --strip-unneeded -o "$P/usr/bin/geospax" target/release/geospax
strip --strip-unneeded -o "$P/usr/bin/geospax-server" target/release/geospax-server
chmod 755 "$P/usr/bin/"*
cp -r web/dist "$P/usr/share/geospax/web"
cp -r recipes "$P/usr/share/geospax/recipes"        # examples to copy and edit (the gallery is built in)
for s in 32x32 64x64 128x128; do
  install -Dm644 "apps/desktop/src-tauri/icons/$s.png" "$P/usr/share/icons/hicolor/$s/apps/geospax.png"
done
install -Dm644 apps/desktop/src-tauri/icons/128x128@2x.png "$P/usr/share/icons/hicolor/256x256/apps/geospax.png"
cat > "$P/usr/share/applications/geospax.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=GeoSpaX
GenericName=Automated GIS
Comment=Maps that make themselves: plug in a device or drop data, get a finished map
Exec=geospax
Icon=geospax
Terminal=false
Categories=Science;Geography;
Keywords=GIS;map;GPS;drone;satellite;remote sensing;sensor;recipe;
EOF
for f in README.md CHANGELOG.md docs/USER_GUIDE.md LICENSE-MIT LICENSE-APACHE; do
  [ -f "$f" ] && install -m644 "$f" "$P/usr/share/doc/geospax/"
done
cat > "$P/usr/share/doc/geospax/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: GeoSpaX
Files: *
Copyright: 2026 GeoSpaX contributors
License: Apache-2.0 or MIT
 See /usr/share/doc/geospax/LICENSE-APACHE and /usr/share/doc/geospax/LICENSE-MIT.
 .
 The binaries also contain Mozilla's root certificate list (webpki-roots crate, CDLA-Permissive-2.0), used to
 check MQTT brokers' TLS certificates: see /usr/share/doc/geospax/third-party/webpki-roots/LICENSE.txt.
 .
 This software is based in part on the work of the Independent JPEG Group (jpeg-encoder crate, used for the
 textures of 3D scenes): see /usr/share/doc/geospax/third-party/jpeg-encoder/LICENSE.txt.
EOF
for d in packaging/third-party/*/; do
  install -Dm644 "$d/LICENSE.txt" "$P/usr/share/doc/geospax/third-party/$(basename "$d")/LICENSE.txt"
done

echo "== dependencies"
LDCONFIG=$(command -v ldconfig || echo /sbin/ldconfig)   # /sbin is not on a normal user's PATH
# owner package of every NEEDED library of both binaries (like dpkg-shlibdeps, without versions)
DEPS=$(for bin in target/release/geospax target/release/geospax-server; do objdump -p "$bin" | awk '/NEEDED/{print $2}'; done | sort -u |
  while read -r lib; do
    path=$("$LDCONFIG" -p | awk -v l="$lib" '$1 == l {print $NF; exit}')
    [ -n "$path" ] || { echo "WARN: $lib not found by ldconfig" >&2; continue; }
    { dpkg -S "$path" 2>/dev/null || dpkg -S "$(readlink -f "$path")" 2>/dev/null; } | awk -F: 'NR == 1 {print $1}'
  done | sort -u | paste -sd, | sed 's/,/, /g')
[ -n "$DEPS" ] || { echo "could not compute dependencies"; exit 1; }
SIZE=$(du -sk --exclude=DEBIAN "$P" | cut -f1)
cat > "$P/DEBIAN/control" <<EOF
Package: geospax
Version: $VERSION
Architecture: $ARCH
Maintainer: $MAINTAINER
Installed-Size: $SIZE
Section: science
Priority: optional
Depends: $DEPS, fonts-dejavu-core
Recommends: python3
Suggests: r-base-core, r-cran-sf, grass-core, saga, mosquitto, gdal-bin
Description: open-source GIS where every map is a re-runnable recipe
 GeoSpaX turns data into finished maps without a human in the loop. Plug in a
 phone, GPS, camera, drone card or sensor logger, drop files into ~/GeoSpaX/Inbox,
 or let a new satellite pass or a sensor threshold trigger a recipe: GeoSpaX
 does the import, analysis, cartography and export (PNG, PDF, HTML report).
 .
 Includes the desktop app (geospax) and the web edition (geospax-server).
 R, Python, GRASS and SAGA recipe steps use those tools when installed.
EOF
echo "Depends: $DEPS, fonts-dejavu-core"

mkdir -p "$OUT"
DEB="$OUT/geospax_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group -Zxz "$P" "$DEB" >/dev/null
echo "== $DEB ($(du -h "$DEB" | cut -f1), installed $((SIZE / 1024)) MB)"
echo "install: sudo apt install ./$DEB"
