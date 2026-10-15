#!/usr/bin/env python3
"""Detect dropped map tiles in a screenshot (regression test for README finding 17).

usage: scripts/test-tile-coverage.py SCREENSHOT.png [...] [--max-empty PCT] [--region X0,Y0,X1,Y1]

Splits the map area into 40x40 px blocks and counts blocks that are a single flat colour
(pure background, nothing drawn). Use it on a dense view, where every block should contain
features; 0% means complete, and one missing z12 tile at 1440x900 is roughly 14-25%.
The default region is the map area of the 1440x900 test window (340 px sidebar on the left).
Exits 1 if any screenshot exceeds --max-empty. Needs netpbm (pngtopnm); stdlib only otherwise.
"""
import argparse, subprocess, sys


def load_ppm(png):
    ppm = subprocess.run(['pngtopnm', png], capture_output=True, check=True).stdout
    fields, i = [], 0
    while len(fields) < 4:  # P6 header: magic, width, height, maxval (comments allowed)
        while ppm[i:i + 1].isspace():
            i += 1
        if ppm[i:i + 1] == b'#':
            while ppm[i:i + 1] != b'\n':
                i += 1
            continue
        j = i
        while not ppm[j:j + 1].isspace():
            j += 1
        fields.append(ppm[i:j])
        i = j
    return int(fields[1]), int(fields[2]), ppm[i + 1:]


def empty_share(png, region, block=40, step=4):
    w, h, px = load_ppm(png)
    x0, y0, x1, y1 = region
    x1, y1 = min(x1, w), min(y1, h)
    empty = total = 0
    for by in range(y0, y1 - block, block):
        for bx in range(x0, x1 - block, block):
            colours = set()
            for yy in range(by, by + block, step):
                row = yy * w
                for xx in range(bx, bx + block, step):
                    k = (row + xx) * 3
                    colours.add(px[k:k + 3])
            total += 1
            empty += len(colours) <= 2
    return empty / max(total, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('screenshots', nargs='+')
    ap.add_argument('--max-empty', type=float, default=5.0, help='fail above this percentage (default 5)')
    ap.add_argument('--region', default='345,5,1395,895')
    a = ap.parse_args()
    region = tuple(int(v) for v in a.region.split(','))
    failed = False
    for f in a.screenshots:
        pct = empty_share(f, region) * 100
        ok = pct <= a.max_empty
        failed |= not ok
        print(f"{'OK  ' if ok else 'FAIL'} {f}: {pct:.1f}% empty blocks (max {a.max_empty:g}%)")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
