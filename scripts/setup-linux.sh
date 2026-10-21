#!/usr/bin/env bash
# GeoSpaX: one-shot developer setup for Debian 12+/Ubuntu 22.04+.
#
#   scripts/setup-linux.sh [--test-tools] [--r] [--providers] [--rea] [--windows] [--swap 4G]
#
# Installs:
#   * system packages: GDAL (headers + CLI), clang/bindgen, Tauri 2 / WebKitGTK 4.1 libraries
#   * Rust (rustup, stable) and Node.js 24, unless already on PATH
#     (installed under $TOOLS, default /opt; env file: $TOOLS/rust-env.sh)
#   * --test-tools: Xvfb + friends (headless desktop smoke test), gdb, Mosquitto (MQTT sensor tests), and Playwright's
#     Chromium (headless web smoke test, under $TOOLS/pw)
#   * --r: R + sf + gstat for the R recipe steps (r-kriging); gstat comes from CRAN because
#     Debian 13 does not package it (README finding 24)
#   * --providers: GRASS (grass-core) and SAGA (saga) for the `grass` / `saga` recipe steps
#     (landforms-grass, wetness-saga); about 300 MB without recommended packages
#   * --rea: the REA reverse-engineering agent CLI (npm: rea-agents)
#   * --windows: cross-build the Windows edition from Linux (scripts/package-windows.sh): the MinGW-w64 GCC
#     toolchain and the Rust x86_64-pc-windows-gnu target (no Microsoft SDK download needed), NSIS, Wine (to
#     test the result) and GDAL for Windows from conda-forge (libgdal-core, via micromamba) in $TOOLS/gdal-win
#   * --swap SIZE: add a swap file (small VMs/CI: release builds with LTO need ~3 GB)
# Note: GDAL >= 3.6 is required, and 3.12+ is recommended (see README, finding 11).
# Debian 13 ships 3.10, Ubuntu 24.04 ships 3.8.
set -euo pipefail
TOOLS="${TOOLS:-/opt}"
TEST_TOOLS=0 REA=0 R_STEPS=0 PROVIDERS=0 WINDOWS=0 SWAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test-tools) TEST_TOOLS=1 ;;
    --rea) REA=1 ;;
    --r) R_STEPS=1 ;;
    --providers) PROVIDERS=1 ;;
    --windows) WINDOWS=1 ;;
    --swap) SWAP="$2"; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

if [ -n "$SWAP" ] && ! swapon --show | grep -q /swapfile; then
  echo "== swap $SWAP"
  $SUDO fallocate -l "$SWAP" /swapfile && $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile >/dev/null && $SUDO swapon /swapfile
fi

echo "== system packages"
PKGS="build-essential pkg-config clang libclang-dev curl ca-certificates xz-utils python3 file
      libgdal-dev gdal-bin
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev libxdo-dev libssl-dev"
[ "$TEST_TOOLS" = 1 ] && PKGS="$PKGS xvfb x11-apps netpbm dbus-x11 gdb mosquitto"
$SUDO apt-get update -q
# shellcheck disable=SC2086
DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -q --no-install-recommends $PKGS
echo "GDAL $(gdal-config --version)"

if ! command -v cargo >/dev/null; then
  echo "== Rust (rustup -> $TOOLS)"
  $SUDO mkdir -p "$TOOLS/rustup" "$TOOLS/cargo" && $SUDO chown -R "$(id -u):$(id -g)" "$TOOLS/rustup" "$TOOLS/cargo"
  curl -sSf https://sh.rustup.rs | RUSTUP_HOME="$TOOLS/rustup" CARGO_HOME="$TOOLS/cargo" sh -s -- -y -q --profile minimal --no-modify-path
  printf 'export RUSTUP_HOME=%s/rustup\nexport CARGO_HOME=%s/cargo\nexport PATH=%s/cargo/bin:$PATH\n' "$TOOLS" "$TOOLS" "$TOOLS" | $SUDO tee "$TOOLS/rust-env.sh" >/dev/null
  echo "Rust installed: source $TOOLS/rust-env.sh"
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "== Node.js 24 -> $TOOLS/node24"
  NODE_TGZ=$(curl -s https://nodejs.org/dist/latest-v24.x/ | grep -o 'node-v24[0-9.]*-linux-x64.tar.xz' | head -1)
  curl -sSfL "https://nodejs.org/dist/latest-v24.x/$NODE_TGZ" -o /tmp/node.tar.xz
  $SUDO mkdir -p "$TOOLS/node24" && $SUDO tar -xJf /tmp/node.tar.xz -C "$TOOLS/node24" --strip-components=1
  $SUDO chown -R "$(id -u):$(id -g)" "$TOOLS/node24"
  for b in node npm npx; do $SUDO ln -sf "$TOOLS/node24/bin/$b" "/usr/local/bin/$b"; done
fi
echo "node $(node --version)"

if [ "$TEST_TOOLS" = 1 ]; then
  echo "== Playwright Chromium -> $TOOLS/pw"
  $SUDO mkdir -p "$TOOLS/pw" && $SUDO chown "$(id -u):$(id -g)" "$TOOLS/pw"
  (cd "$TOOLS/pw" && [ -f package.json ] || npm init -y >/dev/null; npm i -s playwright gltf-validator@2.0.0-dev.3.10 && npx -y playwright install --with-deps --only-shell chromium >/dev/null)
  echo "web smoke tests: PW=$TOOLS/pw/node_modules/playwright node scripts/test-web-symbology.mjs"
fi

if [ "$REA" = 1 ]; then
  echo "== REA (rea-agents)"
  npm i -g -s rea-agents
  [ -e /usr/local/bin/rea ] || $SUDO ln -sf "$(npm prefix -g)/bin/rea" /usr/local/bin/rea
  rea --version || true
fi
if [ "$WINDOWS" = 1 ]; then
  echo "== Windows cross-build tools"
  # (cargo-xwin + the MSVC SDK was tried first: unpacking the SDK cabinets took >15 min on 2 cores)
  # wine32 (i386 multiarch): the NSIS installer stub is a 32-bit program, so testing it needs 32-bit Wine
  $SUDO dpkg --add-architecture i386 && $SUDO apt-get update -q
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
    gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 nsis osslsigncode wine wine64 wine32:i386 bzip2 unzip zip
  [ -f "$TOOLS/rust-env.sh" ] && . "$TOOLS/rust-env.sh"
  rustup target add x86_64-pc-windows-gnu
  x86_64-w64-mingw32-gcc --version | awk 'NR==1' 
  # GDAL for Windows: conda-forge's libgdal-core (GPKG, Shapefile, FlatGeobuf, GeoJSON, GTiff/COG, /vsicurl/)
  # with import libraries for MSVC and every DLL it needs. Same GDAL minor version as the Linux build.
  # The LGPL builds of libspatialite and libarchive are pinned: the default "gpl_" builds pull in GPL-only
  # librttopo/lzo, which an MIT/Apache installer should not bundle. Every package's license files are kept in
  # gdal-win/third-party-licenses (shipped with the Windows edition); the step fails if a GPL-only package sneaks in.
  GDAL_WIN_VERSION="${GDAL_WIN_VERSION:-3.10}"
  if [ ! -f "$TOOLS/gdal-win/third-party-licenses/PACKAGES.txt" ]; then
    $SUDO rm -rf "$TOOLS/gdal-win"
    $SUDO mkdir -p "$TOOLS/mamba" "$TOOLS/gdal-win" && $SUDO chown -R "$(id -u):$(id -g)" "$TOOLS/mamba" "$TOOLS/gdal-win"
    [ -x "$TOOLS/mamba/bin/micromamba" ] || curl -sSfL https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C "$TOOLS/mamba" bin/micromamba
    export MAMBA_ROOT_PREFIX="$TOOLS/mamba"
    "$TOOLS/mamba/bin/micromamba" create -y -q -p "$TOOLS/gdal-win" --platform win-64 -c conda-forge \
      "libgdal-core=$GDAL_WIN_VERSION" "libspatialite=*=*lgpl*" "libarchive=*=*lgpl*" vc14_runtime
    python3 - "$TOOLS/gdal-win" "$TOOLS/mamba/pkgs" <<'PY'
import json, pathlib, re, shutil, sys
env, pkgs = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out = env / "third-party-licenses"; out.mkdir(exist_ok=True)
rows, bad = [], []
for meta in sorted((env / "conda-meta").glob("*.json")):
    m = json.loads(meta.read_text())
    lic = m.get("license", "?")
    rows.append(f'{m["name"]:<22} {m["version"]:<14} {lic}')
    if re.search(r"(?<!L)GPL", lic) and "LGPL" not in lic and "OR" not in lic.upper():
        bad.append(f'{m["name"]} ({lic})')
    for src in pkgs.glob(f"**/{meta.stem}/info/licenses"):  # micromamba >= 2 nests the cache by channel URL
        shutil.copytree(src, out / m["name"], dirs_exist_ok=True)
        break
    else:  # e.g. SQLite (public domain) and the "vc" metapackage ship no license file
        rows[-1] += "   (no license file in the package)"
if bad:
    sys.exit("GPL-only packages in the Windows GDAL bundle: " + ", ".join(bad))
(out / "PACKAGES.txt").write_text("Third-party libraries in the GeoSpaX Windows edition (conda-forge, win-64).\n"
    "Sources: https://github.com/conda-forge/<name>-feedstock and the upstream projects.\n\n"
    + "\n".join(rows) + "\n")
print(f"{len(rows)} packages, licenses in {out}")
PY
    "$TOOLS/mamba/bin/micromamba" clean -a -y -q >/dev/null
  fi
  echo "GDAL for Windows: $(ls "$TOOLS"/gdal-win/conda-meta/libgdal-core-*.json | xargs -n1 basename)"
fi

if [ "$PROVIDERS" = 1 ]; then
  echo "== GRASS + SAGA (recipe providers)"
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends grass-core saga
  grass --version | head -1 || true
  saga_cmd --version 2>/dev/null | head -1 || true
fi

if [ "$R_STEPS" = 1 ]; then
  echo "== R for recipe steps (sf from Debian, gstat from CRAN)"
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    r-base-core r-base-dev r-cran-sf r-cran-sp r-cran-zoo r-cran-fnn r-cran-spacetime r-cran-sftime r-cran-xts
  if ! Rscript -e 'library(gstat)' >/dev/null 2>&1; then
    $SUDO Rscript -e 'install.packages("gstat", repos = "https://cloud.r-project.org", lib = .Library)'
  fi
  Rscript -e 'library(sf); library(gstat); cat("R ready:", R.version.string, "· gstat", as.character(packageVersion("gstat")), "\n")'
fi

echo "== done"
