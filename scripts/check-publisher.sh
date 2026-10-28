#!/usr/bin/env bash
# The publisher is "in4metrix" in every package: Windows installer (Apps & features "Publisher", the registry key
# that records the install folder), geospax.exe / geospax-server.exe version info, Tauri bundles (AppImage,
# field app), Flatpak metainfo, .deb and .rpm. The Windows installer hooks name the publisher's registry key
# themselves (upgrades from 3.0.0-3.0.2, which used "GeoSpaX contributors"), so they must agree with the bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
PUB=in4metrix
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1: $2"; else echo "FAIL  $1: '$2' (want '$3')"; fail=1; fi; }
json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval("d"+sys.argv[2]))' "$1" "$2"; }
check "desktop bundle.publisher" "$(json apps/desktop/src-tauri/tauri.conf.json '["bundle"]["publisher"]')" "$PUB"
check "field bundle.publisher" "$(json apps/field/src-tauri/tauri.conf.json '["bundle"]["publisher"]')" "$PUB"
check "Windows bundle.publisher" "$(json packaging/windows/tauri.windows.json '["bundle"]["publisher"]')" "$PUB"
for f in apps/desktop/src-tauri/tauri.conf.json apps/field/src-tauri/tauri.conf.json packaging/windows/tauri.windows.json; do
  c=$(json "$f" '["bundle"]["copyright"]')
  case "$c" in *"$PUB"*) echo "ok    $f copyright: $c" ;; *) echo "FAIL  $f copyright: '$c' does not name $PUB"; fail=1 ;; esac
done
check "installer hooks registry key" "$(sed -n 's/^!define GEOSPAX_PRODUCTKEY "Software\\\(.*\)\\GeoSpaX"$/\1/p' packaging/windows/installer-hooks.nsh)" "$PUB"
check "Flatpak developer name" "$(python3 -c 'import sys,xml.etree.ElementTree as E; print(E.parse(sys.argv[1]).find("developer/name").text)' packaging/flatpak/io.github.jmozez.GeoSpaX.metainfo.xml)" "$PUB"
grep -q "^Vendor: *$PUB " scripts/package-rpm.sh && echo "ok    rpm Vendor" || { echo "FAIL  rpm Vendor is not $PUB"; fail=1; }
grep -q "^MAINTAINER=\"\${MAINTAINER:-$PUB " scripts/package-linux.sh && echo "ok    deb Maintainer" || { echo "FAIL  deb Maintainer is not $PUB"; fail=1; }
grep -q "^Copyright: .*$PUB" scripts/package-linux.sh && echo "ok    deb copyright" || { echo "FAIL  deb copyright does not name $PUB"; fail=1; }
# the old publisher may only appear where old installs are recognised or removed, in the license and in the history
# ("in4metrix ... and GeoSpaX contributors", the LICENSE's copyright line, is fine anywhere)
old=$(git -c safe.directory="$PWD" ls-files | python3 -c '
import re, sys
skip = {"CHANGELOG.md", "LICENSE", "packaging/windows/installer-hooks.nsh", "scripts/check-publisher.sh",
        "scripts/test-windows-upgrade.ps1", "docs/FAQ.md"}  # the old registry key, named to remove it
for f in sys.stdin.read().split("\n"):
    # site/docs/*.html is generated from docs/ — a source on the skip list keeps that status rendered
    if not f or f in skip or f.startswith("site/docs/"): continue
    try: t = open(f, encoding="utf-8").read()
    except (UnicodeDecodeError, OSError): continue
    if re.search(r"(?<!and )GeoSpaX contributors", t): print(f)
')
if [ -n "$old" ]; then echo "FAIL  'GeoSpaX contributors' as a publisher in: $old"; fail=1; else echo "ok    no other 'GeoSpaX contributors'"; fi
[ "$fail" = 0 ] && echo "publisher: $PUB everywhere" || { echo "publisher check failed" >&2; exit 1; }
