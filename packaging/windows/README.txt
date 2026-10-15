GeoSpaX for Windows
===================

geospax.exe            the desktop app (Start menu: GeoSpaX). Needs Microsoft Edge WebView2,
                       which Windows 10/11 already has (the installer adds it if missing).
geospax-web.cmd        the web edition: serves GeoSpaX at http://localhost:8080 (Start menu: GeoSpaX Web Server)
geospax-server.exe     the server and command line, e.g.
                         geospax-server.exe recipes
                         geospax-server.exe run track-to-map --input source=E:\

Your files: %USERPROFILE%\GeoSpaX\Data (maps and layers), %USERPROFILE%\GeoSpaX\Inbox (drop GPX/photos/logs here
and the matching recipe runs by itself). Plug in a camera card, GPS or drone SD card and it shows up under Devices.

Optional extras GeoSpaX finds by itself: Python 3 (python.org), R (cran.r-project.org; Program Files\R is searched),
GRASS GIS and SAGA (standalone installers or OSGeo4W). Set GEOSPAX_PYTHON / GEOSPAX_RSCRIPT / GEOSPAX_GRASS /
GEOSPAX_SAGA to point at a specific copy.

Bundled: GDAL 3.10 + PROJ 9.7 (conda-forge builds, share\gdal and share\proj), DejaVu Sans (fonts\).
Licenses: LICENSE-MIT.txt, LICENSE-APACHE.txt; third-party-licenses\ lists every bundled library and its license.
Docs: docs\USER_GUIDE.md (step-by-step guide; the source repository has README.md and the full docs\ folder)
