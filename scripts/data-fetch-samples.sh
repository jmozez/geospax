#!/usr/bin/env bash
# Prepare benchmark data. Requires GDAL CLI tools (ogr2ogr) and python3.
#   scripts/data-fetch-samples.sh [DATA_DIR] [SYNTHETIC_COUNT]
# Produces:
#   natural_earth.gpkg          countries / roads / rivers / places   (public domain)
#   synthetic.gpkg              buildings (polygons) + points           (1M each by default)
#   synthetic_buildings.fgb     FlatGeobuf copy   (format comparison)
#   shp/synthetic_buildings.shp Shapefile copy    (format comparison, with .qix index)
set -euo pipefail
OUT="${1:-data}"
COUNT="${2:-1000000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/raw" "$OUT/shp"
NE=https://naciscdn.org/naturalearth/10m

fetch() { # theme/name
  local n; n=$(basename "$1")
  [ -s "$OUT/raw/$n.zip" ] || curl -sSfL -o "$OUT/raw/$n.zip" "$NE/$1.zip"
}
fetch cultural/ne_10m_admin_0_countries
fetch cultural/ne_10m_populated_places_simple
fetch cultural/ne_10m_roads
fetch physical/ne_10m_rivers_lake_centerlines

if [ ! -s "$OUT/natural_earth.gpkg" ]; then
  echo "[1/3] Natural Earth -> natural_earth.gpkg"
  Z="/vsizip/$(realpath "$OUT/raw")"
  ogr2ogr -f GPKG "$OUT/natural_earth.gpkg" "$Z/ne_10m_admin_0_countries.zip" \
    -nln countries -nlt PROMOTE_TO_MULTI -select NAME,ISO_A3,CONTINENT,POP_EST
  ogr2ogr -update "$OUT/natural_earth.gpkg" "$Z/ne_10m_rivers_lake_centerlines.zip" \
    -nln rivers -nlt PROMOTE_TO_MULTI -select name,scalerank
  ogr2ogr -update "$OUT/natural_earth.gpkg" "$Z/ne_10m_roads.zip" \
    -nln roads -nlt PROMOTE_TO_MULTI -select name,type,scalerank
  ogr2ogr -update "$OUT/natural_earth.gpkg" "$Z/ne_10m_populated_places_simple.zip" \
    -nln places -select name,pop_max,featurecla
fi

if [ ! -s "$OUT/synthetic.gpkg" ]; then
  echo "[2/3] Synthetic data ($COUNT features) -> synthetic.gpkg"
  python3 "$HERE/data-gen-synthetic.py" --count "$COUNT" --out "$OUT"
  ogr2ogr -f GPKG "$OUT/synthetic.gpkg" "$OUT/synthetic_buildings.csv" -nln buildings \
    -oo GEOM_POSSIBLE_NAMES=wkt -oo KEEP_GEOM_COLUMNS=NO -oo AUTODETECT_TYPE=YES \
    -a_srs EPSG:4326 -nlt POLYGON -gt 100000
  ogr2ogr -update "$OUT/synthetic.gpkg" "$OUT/synthetic_points.csv" -nln points \
    -oo X_POSSIBLE_NAMES=lon -oo Y_POSSIBLE_NAMES=lat -oo KEEP_GEOM_COLUMNS=NO \
    -oo AUTODETECT_TYPE=YES -a_srs EPSG:4326 -nlt POINT -gt 100000
  rm -f "$OUT/synthetic_buildings.csv" "$OUT/synthetic_points.csv"
fi

if [ ! -s "$OUT/synthetic_buildings.fgb" ]; then
  echo "[3/3] Format variants (FlatGeobuf, Shapefile)"
  ogr2ogr -f FlatGeobuf "$OUT/synthetic_buildings.fgb" "$OUT/synthetic.gpkg" buildings
  ogr2ogr -f "ESRI Shapefile" "$OUT/shp/synthetic_buildings.shp" "$OUT/synthetic.gpkg" buildings
  ogrinfo "$OUT/shp/synthetic_buildings.shp" -sql "CREATE SPATIAL INDEX ON synthetic_buildings" >/dev/null
fi
echo "done:"; ls -lh "$OUT" "$OUT/shp"
