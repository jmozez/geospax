#!/usr/bin/env python3
"""Makes apps/field/public/geoid/egm2008-15m.bin, the EGM2008 geoid the field app turns GPS heights into
heights above sea level with.

Input: GeographicLib's egm2008-5.pgm (5' grid), from
https://sourceforge.net/projects/geographiclib/files/geoids-distrib/egm2008-5.tar.bz2
Output: every 3rd cell (a 0.25 degree grid), int16 little-endian centimetres, 721 rows (90N to 90S) by
1441 columns (0 to 360 east, the first column repeated at the end). Bilinear interpolation of this grid is
within 1.5 m of the 5' grid everywhere (rms 0.07 m globally, 0.16 m over Papua New Guinea).

    python3 scripts/make-geoid-grid.py egm2008-5.pgm apps/field/public/geoid/egm2008-15m.bin
"""
import sys

import numpy as np


def read_pgm(path):
    d = open(path, 'rb').read()
    pos = 0
    for line in d.split(b'\n'):
        pos += len(line) + 1
        if line.strip() == b'65535':
            break
    # GeographicLib's PGM: N = 0.003 * value - 108 metres (the Offset and Scale in its header)
    return np.frombuffer(d[pos:], dtype='>u2').reshape(2161, 4320).astype(np.float64) * 0.003 - 108


def main():
    src, out = sys.argv[1], sys.argv[2]
    g = read_pgm(src)[::3, ::3]
    g = np.concatenate([g, g[:, :1]], axis=1)
    assert g.shape == (721, 1441), g.shape
    open(out, 'wb').write(np.round(g * 100).astype('<i2').tobytes())
    print(out, g.shape)


if __name__ == '__main__':
    main()
