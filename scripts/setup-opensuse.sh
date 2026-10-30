#!/usr/bin/env bash
# GeoSpaX build tools on openSUSE Tumbleweed (for the .rpm): compilers, GDAL, WebKitGTK and Node from zypper,
# Rust from rustup. Run as root or with sudo.
set -euo pipefail
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
echo "== system packages"
ok=0
for i in 1 2 3 4 5; do
  $SUDO zypper -n --gpg-auto-import-keys refresh && \
  $SUDO zypper -n install --no-recommends gcc gcc-c++ make pkg-config clang clang-devel curl ca-certificates xz python3 file git \
    findutils tar gzip gdal gdal-devel 'pkgconfig(webkit2gtk-4.1)' 'pkgconfig(gtk+-3.0)' 'pkgconfig(libsoup-3.0)' \
    'pkgconfig(librsvg-2.0)' 'pkgconfig(openssl)' 'pkgconfig(ayatana-appindicator3-0.1)' nodejs npm rpm-build binutils && { ok=1; break; }
  sleep 60
done
[ $ok = 1 ] && command -v gdal-config >/dev/null || { echo "zypper could not install the build tools (mirror errors above)"; exit 1; }
echo "GDAL $(gdal-config --version)"
if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo "== Rust (rustup)"
  curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal
fi
