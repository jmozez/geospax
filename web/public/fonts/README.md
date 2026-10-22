# Map label fonts

MapLibre glyph files (signed-distance-field PBFs, 256 code points each) for the four styles of
**DejaVu Sans 2.37** (Book, Bold, Oblique, Bold Oblique), every range from U+0000 to U+FFFF. Map labels
use them with no network (`web/src/symbols.ts`, `GLYPHS`).

Made with `fontnik` 0.7.7 from the TTFs of the npm package `dejavu-fonts-ttf` 2.37.3. Ranges the font
does not cover are near-empty files, so MapLibre never asks for a missing one. Licence: Bitstream Vera
Fonts licence with DejaVu changes in the public domain (LICENSE-DejaVu.txt).
