#!/usr/bin/env bash
# GeoSpaX: build the RPM for Fedora or Enterprise Linux (RHEL, Rocky, AlmaLinux) with rpmbuild. Same layout as the .deb (scripts/package-linux.sh):
#
#   scripts/package-rpm.sh [--no-build] [OUT_DIR]          default OUT_DIR: releases/
#
#   /usr/bin/geospax, /usr/bin/geospax-server, /usr/share/geospax/{web,recipes,samples,plugins}, menu entry,
#   icons and docs. rpmbuild reads the libraries both binaries need (GDAL, WebKitGTK …) and requires them by
#   soname, so build on the release you ship for: CI builds one on Fedora 43 (.fc43), one on Fedora 44 (.fc44) and one on AlmaLinux 10
#   (.el10, for RHEL, Rocky and AlmaLinux 10).
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=1 OUT=releases
for a in "$@"; do case "$a" in --no-build) BUILD=0 ;; -h|--help) sed -n 2,9p "$0"; exit 0 ;; *) OUT="$a" ;; esac; done
[ -x "$HOME/.cargo/bin/cargo" ] && export PATH="$HOME/.cargo/bin:$PATH"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
ARCH=$(uname -m)

if [ "$BUILD" = 1 ]; then
  echo "== web + release build"
  (cd web && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npx vite build --logLevel warn)
  cargo build --release -p geospax-server -p geospax --features geospax/custom-protocol
fi
for b in target/release/geospax target/release/geospax-server web/dist/index.html; do
  [ -e "$b" ] || { echo "missing $b (run without --no-build)"; exit 1; }
done

TOP=$(mktemp -d)
trap 'rm -rf "$TOP"' EXIT
R="$TOP/root"
mkdir -p "$R/usr/bin" "$R/usr/share/applications" "$R/usr/share/geospax" "$R/usr/share/doc/geospax" "$R/usr/share/licenses/geospax"

echo "== files"
strip --strip-unneeded -o "$R/usr/bin/geospax" target/release/geospax
strip --strip-unneeded -o "$R/usr/bin/geospax-server" target/release/geospax-server
chmod 755 "$R/usr/bin/"*
cp -r web/dist "$R/usr/share/geospax/web"
cp -r recipes "$R/usr/share/geospax/recipes"
mkdir -p "$R/usr/share/geospax/samples" && cp -r samples/. "$R/usr/share/geospax/samples/"
mkdir -p "$R/usr/share/geospax/plugins" && tar -C plugins --exclude=node_modules --exclude=src --exclude=tests -cf - . | tar -C "$R/usr/share/geospax/plugins" -xf -
for s in 32x32 64x64 128x128; do
  install -Dm644 "apps/desktop/src-tauri/icons/$s.png" "$R/usr/share/icons/hicolor/$s/apps/geospax.png"
done
install -Dm644 apps/desktop/src-tauri/icons/128x128@2x.png "$R/usr/share/icons/hicolor/256x256/apps/geospax.png"
cat > "$R/usr/share/applications/geospax.desktop" <<'EOF'
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
for f in README.md CHANGELOG.md docs/USER_GUIDE.md; do install -m644 "$f" "$R/usr/share/doc/geospax/"; done
install -m644 LICENSE "$R/usr/share/licenses/geospax/LICENSE"
for d in packaging/third-party/*/; do
  install -Dm644 "$d/LICENSE.txt" "$R/usr/share/licenses/geospax/third-party/$(basename "$d")/LICENSE.txt"
done

echo "== rpmbuild"
mkdir -p "$TOP"/{BUILD,RPMS,SPECS,SRPMS,SOURCES}
cat > "$TOP/SPECS/geospax.spec" <<EOF
Name:           geospax
Version:        ${VERSION//-/~}
Release:        1%{?dist}
Summary:        Open-source GIS where every map is a re-runnable recipe
License:        MIT
URL:            https://github.com/jmozez/geospax
Requires:       dejavu-sans-fonts
Recommends:     python3, nodejs
Suggests:       R-core, grass, saga, mosquitto, gdal
%global debug_package %{nil}
%global __strip /bin/true
%global __brp_strip %{nil}
%global _build_id_links none

%description
GeoSpaX turns data into finished maps without a human in the loop. Plug in a
phone, GPS, camera, drone card or sensor logger, drop files into ~/GeoSpaX/Inbox,
or let a new satellite pass or a sensor threshold trigger a recipe: GeoSpaX
does the import, analysis, cartography and export (PNG, PDF, HTML report).

Includes the desktop app (geospax) and the web edition (geospax-server).
R, Python, GRASS and SAGA recipe steps use those tools when installed.

%install
cp -a "$R"/. %{buildroot}/

%files
%license /usr/share/licenses/geospax
%doc /usr/share/doc/geospax
/usr/bin/geospax
/usr/bin/geospax-server
/usr/share/geospax
/usr/share/applications/geospax.desktop
/usr/share/icons/hicolor/*/apps/geospax.png
EOF
rpmbuild -bb --quiet --define "_topdir $TOP" "$TOP/SPECS/geospax.spec"
mkdir -p "$OUT"
RPM=$(ls "$TOP"/RPMS/"$ARCH"/geospax-*.rpm)
cp "$RPM" "$OUT/"
RPM="$OUT/$(basename "$RPM")"
echo "== $RPM ($(du -h "$RPM" | cut -f1))"
rpm -qp --requires "$RPM" | grep -E '^lib(gdal|webkit2gtk)' || true
echo "install: sudo dnf install ./$RPM"
