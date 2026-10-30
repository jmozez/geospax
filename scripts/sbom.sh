#!/usr/bin/env sh
# CycloneDX software bills of materials for a GeoSpaX build: one per Rust package (engine, server,
# desktop, field) and one per npm app (web, desktop shell, field). Needs cargo-cyclonedx
# (cargo install --locked cargo-cyclonedx) and npm 10 or later.
#
#   scripts/sbom.sh OUT_DIR
set -eu
out=${1:-sbom}
mkdir -p "$out"
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
cargo cyclonedx --format json --spec-version 1.5 --override-filename geospax-sbom-rust >/dev/null
find crates apps -name 'geospax-sbom-rust.json' -not -path '*/node_modules/*' | while read -r f; do
  pkg=$(basename "$(dirname "$f")")
  [ "$pkg" = "src-tauri" ] && pkg=$(basename "$(dirname "$(dirname "$f")")")
  mv "$f" "$out/geospax-$pkg-rust.cdx.json"
done
for app in web apps/desktop apps/field; do
  [ -f "$app/package-lock.json" ] || continue
  (cd "$app" && npm sbom --sbom-format cyclonedx --package-lock-only --omit dev) > "$out/geospax-$(basename "$app")-npm.cdx.json"
done
ls "$out"
