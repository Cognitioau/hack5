#!/usr/bin/env bash
# Rebuilds every copy of the zombie-brain mark from mark.png, a 1024px black-and-white drawing of it
# (white is the mark). Needs ImageMagick, potrace and rsvg-convert: brew install imagemagick potrace librsvg.
# The mark was drawn with an image model, mirrored about its middle so it is exactly symmetric, and given
# back its one lit eye, the right one. Run from anywhere: bash site/brand/build-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Trace at double size, softened first so potrace draws smooth curves instead of pixel steps.
magick brand/mark.png -resize 200% -blur 0x3 -threshold 50% -negate "$tmp/mark.pbm"
potrace "$tmp/mark.pbm" -s --flat --turdsize 60 --alphamax 1.0 --opttolerance 0.25 -o "$tmp/mark.svg"
d=$(tr '\n' ' ' < "$tmp/mark.svg" | sed -E 's/.*<path d="([^"]+)".*/\1/; s/ +/ /g; s/ $//')
# potrace writes in tenths of a pixel with y flipped; this square frames the mark with a little room.
viewbox='313 312 1420 1420'
transform='translate(0 2048) scale(.1 -.1)'

cat > public/favicon.svg <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="$viewbox">
  <path fill="#6CFF2F" transform="$transform" d="$d" />
</svg>
SVG
MARK_PATH="$d" MARK_VIEWBOX="$viewbox" perl -0pi -e \
  's{<symbol id="zb-mark" viewBox="[^"]*">\s*<path fill="currentColor" transform="[^"]*" d="[^"]*" />}{<symbol id="zb-mark" viewBox="$ENV{MARK_VIEWBOX}">\n        <path fill="currentColor" transform="translate(0 2048) scale(.1 -.1)" d="$ENV{MARK_PATH}" />}s or die "zb-mark symbol not found in index.html\n"' \
  index.html

for size in 16 32 48; do rsvg-convert -w "$size" -h "$size" public/favicon.svg -o "$tmp/icon-$size.png"; done
magick "$tmp/icon-16.png" "$tmp/icon-32.png" "$tmp/icon-48.png" public/favicon.ico
# iOS rounds the corners itself and shows transparency as black, so the touch icon is a full square.
rsvg-convert -w 148 -h 148 public/favicon.svg -o "$tmp/touch.png"
magick -size 180x180 xc:'#050607' "$tmp/touch.png" -gravity center -composite -strip public/apple-touch-icon.png
echo "Rebuilt favicon.svg, favicon.ico, apple-touch-icon.png and the zb-mark symbol. Bump ?v= in index.html."
