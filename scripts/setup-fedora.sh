#!/usr/bin/env bash
# GeoSpaX build tools on Fedora or Enterprise Linux (RHEL, Rocky, AlmaLinux 10). An RPM is built on the
# release it is for, like the .deb on Debian: compilers, GDAL, WebKitGTK and Node from dnf (on Enterprise
# Linux with EPEL and CRB, where WebKitGTK and several -devel packages live), Rust from rustup.
#   scripts/setup-fedora.sh            (as root, or with sudo)
set -euo pipefail
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
if ! grep -q '^ID="\?fedora"\?$' /etc/os-release; then
  echo "== EPEL + CRB (Enterprise Linux)"
  $SUDO dnf install -y -q dnf-plugins-core epel-release
  $SUDO dnf config-manager --set-enabled crb
fi
echo "== system packages"
$SUDO dnf install -y -q --allowerasing --setopt=install_weak_deps=False \
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
