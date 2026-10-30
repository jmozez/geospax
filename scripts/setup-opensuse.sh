#!/usr/bin/env bash
# GeoSpaX build tools on openSUSE Tumbleweed (for the .rpm): compilers, GDAL, WebKitGTK and Node from zypper,
# Rust from rustup. Run as root or with sudo.
set -euo pipefail
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
echo "== system packages"
for i in 1 2 3; do
  $SUDO zypper -n -q --gpg-auto-import-keys refresh && \
  $SUDO zypper -n -q install --no-recommends gcc gcc-c++ make pkg-config clang clang-devel curl ca-certificates xz python3 file git \
    findutils tar gzip gdal gdal-devel 'pkgconfig(webkit2gtk-4.1)' 'pkgconfig(gtk+-3.0)' 'pkgconfig(libsoup-3.0)' \
    'pkgconfig(librsvg-2.0)' 'pkgconfig(openssl)' 'pkgconfig(ayatana-appindicator3-0.1)' nodejs npm rpm-build binutils && break
  sleep 30
done
echo "GDAL $(gdal-config --version)"
if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo "== Rust (rustup)"
  curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal
fi
