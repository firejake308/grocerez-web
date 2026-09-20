#!/usr/bin/env bash
# Downloads a Geofabrik regional extract and clips it to a bounding box
# with osmium, so Overpass only has to import a metro-sized area instead
# of the whole state -- keeps the import within a $6/mo droplet's 1 GB RAM.
# Run this before the first `docker compose up`.
#
# Usage: ./fetch-overpass-extract.sh [minlon,minlat,maxlon,maxlat]
# Default bbox covers the Dallas-Fort Worth metro. Pass your own area, or
# skip clipping entirely (comment out the `osmium extract` line and use
# the downloaded .osm.pbf directly) once you've upgraded the droplet and
# want the whole state.
set -euo pipefail

BBOX="${1:-"-97.55,32.55,-96.55,33.10"}"   # min-lon,min-lat,max-lon,max-lat: DFW metro
EXTRACT_URL="${EXTRACT_URL:-https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/overpass-db"

mkdir -p "$OUT_DIR"
if ! command -v osmium &>/dev/null; then
  echo "Installing osmium-tool..."
  apt-get update -qq
  apt-get install -y -qq osmium-tool
fi

echo "Downloading $EXTRACT_URL ..."
curl -fL -o /tmp/region-full.osm.pbf "$EXTRACT_URL"

echo "Clipping to bbox $BBOX ..."
osmium extract --bbox "$BBOX" -o "$OUT_DIR/region.osm.bz2" --overwrite /tmp/region-full.osm.pbf
rm /tmp/region-full.osm.pbf

echo "Done: $OUT_DIR/region.osm.bz2 ($(du -h "$OUT_DIR/region.osm.bz2" | cut -f1))"
echo "Overpass will import this on its first 'docker compose up' -- that takes a few minutes."
