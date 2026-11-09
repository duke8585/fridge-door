#!/bin/sh
# Usage: make_covers.sh <asana export dir> <out dir>
# Whole image (never cropped), long edge max 1600 px, JPEG quality 82. Skips files already made.
set -eu
src="$1/files"; out="$2"
for f in "$src"/*/*; do
  case "$f" in *.txt) continue ;; esac
  rel=${f#"$src"/}; dst="$out/${rel%.*}.jpg"
  [ -s "$dst" ] && continue
  mkdir -p "$(dirname "$dst")"
  sips -Z 1600 -s format jpeg -s formatOptions 82 "$f" --out "$dst.tmp.jpg" >/dev/null && mv "$dst.tmp.jpg" "$dst"
done
