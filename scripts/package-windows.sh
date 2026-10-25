#!/usr/bin/env bash
# Build the GeoSpaX Windows edition on Linux (cross-compiled with MinGW-w64; no Windows machine needed):
#   releases/GeoSpaX_<version>_x64-setup.exe          per-user installer (Tauri NSIS bundler): no admin rights,
#                                                     Start-menu entries for the desktop app and the web server,
#                                                     uninstaller, silent WebView2 bootstrap when it is missing
#   target/windows/GeoSpaX-<version>-windows-x64.zip  portable folder: unzip anywhere and run (kept out of
#                                                     releases/ because of its size; CI attaches it to releases)
# Both contain geospax.exe (desktop), geospax-server.exe (web edition + CLI), geospax-web.cmd, the GDAL/PROJ
# DLLs the executables actually import (resolved with objdump), share\gdal + share\proj, DejaVu Sans,
# the web UI, the built-in recipes, the user guide and every license.
#
# Toolchain: Rust x86_64-pc-windows-gnu + MinGW-w64 GCC. GDAL comes from conda-forge's MSVC build; only its C API
# is used, so mixing the two C runtimes is safe (GDAL memory is always released through GDAL).
# Needs: scripts/setup-linux.sh --windows   (MinGW-w64, NSIS, Wine, GDAL for Windows in /opt/gdal-win)
# Usage: scripts/package-windows.sh [--no-build]
#   --no-build   reuse the built geospax-server.exe / geospax.exe (the installer and ZIP are always rebuilt)
# Code signing: set WINDOWS_SIGN_PFX (and WINDOWS_SIGN_PASSWORD) and both executables and the installer are
# Authenticode-signed with osslsigncode (packaging/windows/sign.sh). Without it they are unsigned.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BUILD=1
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

TOOLS=${TOOLS:-/opt}
GDAL_WIN=${GDAL_WIN:-$TOOLS/gdal-win}
TARGET=x86_64-pc-windows-gnu
REL=$ROOT/target/$TARGET/release
STAGE=$ROOT/target/windows/runtime      # becomes the install folder (next to geospax.exe)
VERSION=$(awk -F'"' '/^version = /{print $2; exit}' Cargo.toml)
OBJDUMP=$(command -v x86_64-w64-mingw32-objdump || command -v llvm-objdump)
[ -f "$GDAL_WIN/Library/lib/gdal.lib" ] || { echo "GDAL for Windows missing: run scripts/setup-linux.sh --windows" >&2; exit 1; }
[ -f "$TOOLS/rust-env.sh" ] && . "$TOOLS/rust-env.sh"
export GDAL_HOME=$GDAL_WIN/Library
GDAL_VERSION=$(python3 -c 'import json,glob,sys; print(json.load(open(glob.glob(sys.argv[1] + "/conda-meta/libgdal-core-*.json")[0]))["version"])' "$GDAL_WIN")
export GDAL_VERSION
echo "== GeoSpaX $VERSION for Windows (GDAL $GDAL_VERSION from conda-forge)"
# the NSIS bundler stages ~250 MB of temp files; /tmp is often a small tmpfs
export TMPDIR=$ROOT/target/windows/tmp
rm -rf "$TMPDIR" && mkdir -p "$TMPDIR"

t0=$(date +%s)
# geospax-server.exe here; geospax.exe is built by the Tauri CLI below (building it here too would compile it
# twice, since the CLI passes its merged config to tauri-build)
if [ "$BUILD" = 1 ] || [ ! -f "$REL/geospax-server.exe" ]; then
  echo "== geospax-server.exe"
  cargo build --release --target "$TARGET" -p geospax-server
fi
cargo fetch -q --target "$TARGET"
[ -f web/dist/index.html ] || (cd web && npm run build)

echo "== staging the runtime folder"
rm -rf "$STAGE" && mkdir -p "$STAGE"/{share,fonts,recipes,docs,third-party-licenses}
cp -p "$REL/geospax-server.exe" "$STAGE/"
SIGN_CONFIG=()
if [ -n "${WINDOWS_SIGN_PFX:-}" ]; then
  command -v osslsigncode >/dev/null || { echo "WINDOWS_SIGN_PFX is set but osslsigncode is missing (setup-linux.sh --windows)" >&2; exit 1; }
  packaging/windows/sign.sh "$STAGE/geospax-server.exe"
  SIGN_CONFIG=(--config "{\"bundle\":{\"windows\":{\"signCommand\":\"$ROOT/packaging/windows/sign.sh %1\"}}}")
fi
# GNU builds load WebView2 through WebView2Loader.dll (MSVC builds link it statically); it goes next to
# geospax.exe. The webview2-com-sys crate ships it, so take the copy matching Cargo.lock.
WV2=$(awk '/^name = "webview2-com-sys"/{getline; gsub(/"/, "", $3); print $3; exit}' Cargo.lock)
cp "$(ls "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/webview2-com-sys-"$WV2"/x64/WebView2Loader.dll | awk 'NR==1')" "$STAGE/"
cp -rp "$GDAL_WIN/Library/share/gdal" "$GDAL_WIN/Library/share/proj" "$STAGE/share/"
cp -rp web/dist "$STAGE/web"
cp -p recipes/*.yaml "$STAGE/recipes/"
mkdir -p "$STAGE/samples" && cp -r samples/. "$STAGE/samples/"   # sample data (Data › Sample data)
mkdir -p "$STAGE/plugins" && tar -C plugins --exclude=node_modules --exclude=src --exclude=tests -cf - . | tar -C "$STAGE/plugins" -xf -   # bundled plugins (GeoLibre tools run on Node.js when it is installed)
cp -p docs/USER_GUIDE.md "$STAGE/docs/"
cp -p LICENSE "$STAGE/LICENSE.txt"
cp -p packaging/windows/geospax-web.cmd packaging/windows/README.txt "$STAGE/"
cp -p /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf "$STAGE/fonts/"
cp -rp "$GDAL_WIN/third-party-licenses/." "$STAGE/third-party-licenses/"
mkdir -p "$STAGE/third-party-licenses/dejavu-fonts"
cp -p /usr/share/doc/fonts-dejavu-core/copyright "$STAGE/third-party-licenses/dejavu-fonts/LICENSE.txt"
printf '%-22s %-14s %s\n' dejavu-fonts "$(dpkg-query -W -f '${Version}' fonts-dejavu-core 2>/dev/null || echo 2.37)" "Bitstream-Vera AND LicenseRef-Public-Domain" \
  >> "$STAGE/third-party-licenses/PACKAGES.txt"
# notices that travel with the binaries (packaging/third-party/README.md): one folder per crate
declare -A TP_LICENSE=([webpki-roots]="CDLA-Permissive-2.0 (Mozilla root certificates, compiled in)" [jpeg-encoder]="(MIT OR Apache-2.0) AND IJG (3D scene textures)")
for d in packaging/third-party/*/; do
  n="$(basename "$d")"
  mkdir -p "$STAGE/third-party-licenses/$n"
  cp -p "$d/LICENSE.txt" "$STAGE/third-party-licenses/$n/LICENSE.txt"
  printf '%-22s %-14s %s\n' "$n" "$(awk -v n="$n" '$0 == "name = \"" n "\"" {getline; gsub(/"/, "", $3); print $3; exit}' Cargo.lock)" \
    "${TP_LICENSE[$n]:-see LICENSE.txt}" >> "$STAGE/third-party-licenses/PACKAGES.txt"
done
touch -r "$GDAL_WIN/third-party-licenses/PACKAGES.txt" "$STAGE/third-party-licenses/PACKAGES.txt"

# DLLs: the transitive imports of both executables that GDAL's conda-forge build (or MinGW's runtime, should
# anything link it dynamically) provides. System DLLs such as kernel32 or the Universal CRT come with Windows.
python3 - "$OBJDUMP" "$GDAL_WIN" "$STAGE" "$REL/geospax.exe" <<'PY'
import glob, pathlib, shutil, subprocess, sys
objdump, env, stage, desktop = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
available = {}
for d in [env / "Library" / "bin", env, *map(pathlib.Path, glob.glob("/usr/lib/gcc/x86_64-w64-mingw32/*-win32")), pathlib.Path("/usr/x86_64-w64-mingw32/lib")]:
    for f in d.glob("*.dll"):
        available.setdefault(f.name.lower(), f)
def imports(path):
    out = subprocess.run([objdump, "-p", str(path)], capture_output=True, text=True, check=True).stdout
    return [l.split("DLL Name:")[1].strip().lower() for l in out.splitlines() if "DLL Name:" in l]
# geospax.exe exists only after the Tauri build below (first build on a fresh tree): both executables link the
# same engine, so the server's imports cover it, and the desktop's are checked again once it is built
todo, seen, total = [stage / "geospax-server.exe"] + ([desktop] if desktop.exists() else []), set(), 0
while todo:
    for name in imports(todo.pop()):
        if name in seen or name not in available or name.startswith("api-ms-win-") or name == "ucrtbase.dll":
            continue
        seen.add(name)
        dst = stage / available[name].name
        shutil.copy2(available[name], dst)
        total += dst.stat().st_size
        todo.append(dst)
print(f"{len(seen)} DLLs, {total / 1e6:.0f} MB: " + " ".join(sorted(seen)))
PY

echo "== installer (Tauri NSIS bundler)"
# The overlay adds the staged folder as resources; tauri-build checks they exist, so staging comes first.
# In-app updates (docs/FAQ.md): with TAURI_SIGNING_PRIVATE_KEY set, the installer is also signed for
# the updater (setup.exe.sig); the release job turns the signatures into latest.json, which installed copies read from the
# newest GitHub release. Without the key the installer is built as before and updates are notices only.
UPDATER_CONFIG=()
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  UPDATER_CONFIG=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
else
  echo "   (no TAURI_SIGNING_PRIVATE_KEY: no updater signature, installed copies will only be told of new versions)"
fi
(cd apps/desktop && npx tauri build --target "$TARGET" --bundles nsis \
  --config ../../packaging/windows/tauri.windows.json "${SIGN_CONFIG[@]}" "${UPDATER_CONFIG[@]}" --features custom-protocol)
SETUP=$(ls -t "$REL"/bundle/nsis/GeoSpaX_"$VERSION"_x64-setup.exe | awk 'NR==1')
# every DLL the desktop imports that is not part of Windows must be in the staged folder
python3 - "$OBJDUMP" "$GDAL_WIN" "$STAGE" "$REL/geospax.exe" <<'PY'
import glob, pathlib, subprocess, sys
objdump, env, stage, desktop = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
ours = {f.name.lower() for d in [env / "Library" / "bin", env, *map(pathlib.Path, glob.glob("/usr/lib/gcc/x86_64-w64-mingw32/*-win32"))] for f in d.glob("*.dll")}
out = subprocess.run([objdump, "-p", str(desktop)], capture_output=True, text=True, check=True).stdout
need = {l.split("DLL Name:")[1].strip().lower() for l in out.splitlines() if "DLL Name:" in l}
staged = {f.name.lower() for f in stage.glob("*.dll")}
# API sets and the Universal CRT come with Windows (as in the scan above)
missing = sorted(n for n in need if n in ours and n not in staged and not n.startswith("api-ms-win-") and n != "ucrtbase.dll")
if missing:
    sys.exit("geospax.exe imports DLLs that were not staged: " + " ".join(missing))
print(f"geospax.exe: all {len(need)} imports are Windows DLLs or staged")
PY
mkdir -p releases
rm -f releases/GeoSpaX_*_x64-setup.exe releases/GeoSpaX_*_x64-setup.exe.sig
cp "$SETUP" releases/
# the updater signature; the release job writes latest.json from it (scripts/update-feed.py)
[ -f "$SETUP.sig" ] && cp "$SETUP.sig" releases/

echo "== portable ZIP"
PORT=$ROOT/target/windows/GeoSpaX-$VERSION-windows-x64
rm -rf "$PORT" "$PORT.zip" && cp -r "$STAGE" "$PORT" && cp "$REL/geospax.exe" "$PORT/"
(cd "$ROOT/target/windows" && zip -q -r -9 "$(basename "$PORT").zip" "$(basename "$PORT")")
rm -rf "$PORT"

# checksums of whatever is in releases/ (no .deb when only the Windows edition was built)
(cd releases && shopt -s nullglob && files=(./*.deb ./*.exe) && sha256sum "${files[@]}" | sed 's| \./| |' > SHA256SUMS)
rm -rf "$TMPDIR"
echo "== done in $(( $(date +%s) - t0 )) s"
ls -la releases/GeoSpaX_"$VERSION"_x64-setup.exe "$PORT.zip" | awk '{printf "%6.1f MB  %s\n", $5 / 1e6, $NF}'
echo "installed size: $(du -sh "$STAGE" | cut -f1) + geospax.exe $(du -h "$REL/geospax.exe" | cut -f1)"
