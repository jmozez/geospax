#!/usr/bin/env bash
# GeoSpaX: fail if a Linux binary or bundled library needs a newer glibc than the oldest system we support.
#
#   scripts/check-glibc.sh [MAX] FILE_OR_DIR...        default MAX: 2.35 (Ubuntu 22.04, Mint 21)
#
# Reads the GLIBC_x.y symbol versions each ELF file imports (objdump -T) and reports the highest.
set -euo pipefail
MAX=2.35
if [[ "${1:-}" =~ ^[0-9]+\.[0-9]+$ ]]; then MAX=$1; shift; fi
[ $# -gt 0 ] || { sed -n 2,6p "$0"; exit 2; }
newer() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" != "$2" ]; }
bad=0 n=0
while IFS= read -r f; do
  head -c4 "$f" 2>/dev/null | grep -q $'\x7fELF' || continue
  need=$(objdump -T "$f" 2>/dev/null | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -Vu | tail -1)
  n=$((n+1))
  [ -n "$need" ] || continue
  if newer "$need" "$MAX"; then echo "::error::$f needs GLIBC_$need (newer than $MAX)"; bad=1; fi
done < <(find "$@" -type f)
echo "checked $n ELF files against glibc $MAX"
exit $bad
