#!/usr/bin/env bash
# Generate the horizon set that replaces the box-built canyon.
#
# These are silhouette pieces: they sit 60-140 units out and are read against
# the mist, so what matters is the profile — layered strata, broken tops, an
# uneven skyline. They share the hand-painted stylised stone language of the
# oracle (tripo-v3.1) so the far ring and the landmarks look quarried from the
# same rock.
#
# 30 credits per model + 20 per texture = 50 each.
set -euo pipefail

OUT="${1:-tripo-out/horizon}"
mkdir -p "$OUT"

STYLE="hand-painted stylised stone, dark slate and basalt with teal-grey mineral
veining, faceted planes, matte, no vegetation, no ground plane, Lovecraftian
drowned-city mood"

gen() {
  local name="$1" prompt="$2"
  echo "=== $name ==="
  tripo make "$prompt, $STYLE" \
    --model tripo-v3.1 \
    --for game-pc \
    --then texture \
    --name "$name" \
    --out "$OUT/$name" \
    --yes --quiet --no-open --json \
    > "$OUT/$name.json" 2> "$OUT/$name.log" \
    && echo "  ok  $name" \
    || echo "  FAILED $name (see $OUT/$name.log)"
}

gen horizon-cliff-terrace   "a colossal layered sea cliff, terraced strata stepping back, craggy weathered face"
gen horizon-spire-needle    "a gaunt jagged rock spire, tall narrow monolith, chipped angular strata, leaning slightly"
gen horizon-tower-ruin      "a ruined cyclopean watchtower, collapsed broken top, massive weathered megalithic blocks"
gen horizon-ziggurat-ruin   "a collapsed stepped ziggurat, tilted sinking terraces, barnacle-crusted drowned masonry"
gen horizon-arch-buttress   "an eroded natural rock arch buttress, stone bridge span, deep horizontal strata"

echo
echo "done — artifacts under $OUT"
tripo balance
