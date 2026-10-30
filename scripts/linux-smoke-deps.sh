#!/usr/bin/env bash
# GeoSpaX: what scripts/linux-smoke.sh needs on a bare distribution container: Xvfb, xwininfo, ImageMagick,
# D-Bus, fonts and the graphics libraries every desktop has. Detects apt, dnf, zypper or pacman.
set -euo pipefail
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q && apt-get install -y -q --no-install-recommends xvfb x11-utils imagemagick dbus dbus-x11 \
    fonts-dejavu-core libegl1 libgl1 libgles2 libgbm1 libdrm2 libfontconfig1 libharfbuzz0b libfribidi0 libx11-6 libx11-xcb1 \
    libxcb1 libwayland-client0 libgpg-error0 libcom-err2 procps file ca-certificates
elif command -v dnf >/dev/null; then
  dnf install -y -q --setopt=install_weak_deps=False xorg-x11-server-Xvfb xwininfo ImageMagick dbus-daemon dbus-tools \
    dejavu-sans-fonts mesa-libEGL mesa-libGL libglvnd-gles mesa-libgbm libdrm fontconfig harfbuzz fribidi libX11 libX11-xcb libxcb \
    libwayland-client procps-ng findutils file
elif command -v zypper >/dev/null; then
  ok=0
  for i in 1 2 3 4 5; do
    zypper -n --gpg-auto-import-keys refresh && zypper -n install --no-recommends xvfb-run xorg-x11-server-Xvfb xwininfo \
      ImageMagick dbus-1 dejavu-fonts Mesa-libEGL1 Mesa-libGL1 libGLESv2-2 libgbm1 libdrm2 fontconfig libharfbuzz0 libfribidi0 libX11-6 \
      libX11-xcb1 libxcb1 libwayland-client0 libcom_err2 libgpg-error0 procps findutils file && { ok=1; break; }
    sleep 60
  done
  [ $ok = 1 ] || { echo "zypper failed 5 times (mirror errors above)"; exit 1; }
elif command -v pacman >/dev/null; then
  pacman -Syu --noconfirm -q xorg-server-xvfb xorg-xwininfo imagemagick dbus ttf-dejavu mesa fontconfig harfbuzz fribidi \
    libx11 libxcb wayland libdrm procps-ng findutils file
fi
