#!/usr/bin/env bash
# The round-9 character acceptance crops, so the same four views can be pulled
# from any two builds and compared without re-deriving the boxes each time.
#
#   <tag>_char   the whole figure at 2x — silhouette, camo, kit
#   <tag>_head   the head/neck junction at 4x — the thing round 9 rebuilt
#   <tag>_torso  torso and thigh at 1:1 — where the print has to survive
#   <tag>_40px   the figure downsampled to 40 px tall and blown back up nearest
#                neighbour. This is the acceptance test: at 40 px he must still
#                read as a specific soldier and not as one olive blob.
#
# Boxes are for the canonical `gameplay` shot at 1920x1080. If the framing
# solver moves the player, re-derive them; probes/r9_cast.js prints where every
# soldier lands on screen.
#
# usage: probes/charcrop.sh <shots-dir> <tag> [out-dir]
set -euo pipefail
DIR="$1"; TAG="$2"; OUT="${3:-crops}"
mkdir -p "$OUT"
magick "$DIR/gameplay.png" -crop 460x740+500+330 +repage -resize 200% "$OUT/${TAG}_char.png"
magick "$DIR/gameplay.png" -crop 250x290+565+345 +repage -resize 400% "$OUT/${TAG}_head.png"
magick "$DIR/gameplay.png" -crop 380x430+520+620 +repage              "$OUT/${TAG}_torso.png"
magick "$DIR/gameplay.png" -crop 460x740+500+330 +repage -resize x40 -resize 500% -filter point "$OUT/${TAG}_40px.png"
echo "$OUT/${TAG}_*.png"
