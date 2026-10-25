#!/usr/bin/env python3
"""Write latest.json, the in-app update feed, from the updater signatures in a release folder.

    scripts/update-feed.py VERSION RELEASES_DIR        (the release job, after all packages are in)

Installed copies (Windows setup, AppImage) read it from the newest GitHub release:
https://github.com/jmozez/geospax/releases/latest/download/latest.json. Platforms without a signature
(no TAURI_SIGNING_PRIVATE_KEY in CI) are left out; with none at all, no feed is written.
"""
import datetime
import json
import pathlib
import sys

version, root = sys.argv[1].removeprefix("v"), pathlib.Path(sys.argv[2])
base = f"https://github.com/jmozez/geospax/releases/download/v{version}"
platforms = {}
for key, pattern in (("windows-x86_64", "GeoSpaX_*_x64-setup.exe.sig"), ("linux-x86_64", "GeoSpaX-*-x86_64.AppImage.sig")):
    sigs = sorted(root.rglob(pattern))
    if sigs:
        name = sigs[0].name.removesuffix(".sig")
        platforms[key] = {"signature": sigs[0].read_text().strip(), "url": f"{base}/{name}"}
if not platforms:
    print("no updater signatures: no latest.json")
    sys.exit(0)
feed = {
    "version": version,
    "notes": f"https://github.com/jmozez/geospax/releases/tag/v{version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}
(root / "latest.json").write_text(json.dumps(feed, indent=2) + "\n")
print("latest.json:", ", ".join(platforms))
