#!/usr/bin/env bash
# Retake the ribbon screenshots used by README.md, docs/USER_GUIDE.md and the website.
#
#   scripts/shots-ribbon.sh [SERVER_BINARY]
#
# Needs a built web UI (web/dist), a server binary (default target/release/geospax-server), Playwright
# with Chromium (set PW to its module folder, for example PW=/opt/pw/node_modules/playwright) and
# Python 3 with Pillow. It starts a server on port 18121 with the test data from scripts/test-edit-data.py,
# runs scripts/shots-ribbon.mjs and writes the WebP files that README.md, docs/USER_GUIDE.md and
# site/index.html use to docs/assets and site/img.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER=${1:-target/release/geospax-server}
TMP=$(mktemp -d)
trap 'kill "${pid:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
python3 scripts/test-edit-data.py "$TMP/data" >/dev/null
"$SERVER" --data "$TMP/data" --state-dir "$TMP/state" --web web/dist --port 18121 \
  --no-device-mounts --no-triggers >"$TMP/server.log" 2>&1 &
pid=$!
for _ in $(seq 60); do curl -fs http://127.0.0.1:18121/api/health >/dev/null && break; sleep 0.5; done
node scripts/shots-ribbon.mjs http://127.0.0.1:18121 "$TMP/png"
python3 - "$TMP/png" <<'PY'
import sys, glob, os
from PIL import Image
src = sys.argv[1]
for f in sorted(glob.glob(os.path.join(src, '*.png'))):
    name = os.path.splitext(os.path.basename(f))[0]
    im = Image.open(f).convert('RGB')
    w = 1600
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    # the docs use the View tab and the two map shots; the home page only the map shots
    dirs = {'ribbon-view': ['docs/assets'], 'ribbon-swipe': ['docs/assets', 'site/img'],
            'ribbon-time': ['docs/assets', 'site/img']}.get(name, [])
    for d in dirs:
        im.save(os.path.join(d, name + '.webp'), 'WEBP', quality=82, method=6)
    if dirs: print('wrote', name + '.webp')
PY
