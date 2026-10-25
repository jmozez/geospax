#!/usr/bin/env bash
# GeoSpaX build tools on Fedora (the RPM is built on the Fedora release it is for, like the .deb on Debian):
# compilers, GDAL, WebKitGTK and Node from dnf, Rust from rustup.
#   scripts/setup-fedora.sh            (as root, or with sudo)
set -euo pipefail
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
echo "== system packages"
$SUDO dnf install -y -q --setopt=install_weak_deps=False \
  gcc gcc-c++ make pkgconf-pkg-config clang clang-devel curl ca-certificates xz python3 file git findutils \
  gdal gdal-devel \
  webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel libappindicator-gtk3-devel libxdo-devel openssl-devel \
  nodejs npm rpm-build binutils
echo "GDAL $(gdal-config --version)"
if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo "== Rust (rustup)"
  curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal
fi
echo "Rust: $("$HOME/.cargo/bin/cargo" --version 2>/dev/null || cargo --version)"
