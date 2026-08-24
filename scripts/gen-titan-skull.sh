#!/usr/bin/env bash
# The dragon's new perch: a colossal titan skull it stands on.
#
# Two independent runs rather than `-n 2 --then texture`, which needs an
# interactive terminal to pick a winner before it will chain the texture step.
#
# Style is pinned to the measurement in abyss-landmarks (see ROCK_DARK): both
# shipped statues are painted near-neutral and dark, oracle at saturation 0.165
# and dragon at 0.050, around 0.176 luma. Asking for that directly is cheaper
# than re-tinting a saturated model afterwards.
set -euo pipefail
OUT="${1:-tripo-out/titan-skull}"
mkdir -p "$OUT"

PROMPT="a colossal ancient titan skull resting on its side, half sunk into rock,
broad weathered cranium forming a flat platform wide enough to stand on, deep
empty eye sockets, heavy cracked bone turned to stone, monumental scale,
hand-painted stylised stone, near-neutral dark grey slate with only a faint cool
cast, desaturated, matte, faceted planes, Lovecraftian drowned-city mood, no
ground plane, no pedestal"

for seed in 31 74; do
  echo "=== seed $seed ==="
  tripo make "$PROMPT" \
    --model tripo-v3.1 --for game-pc --then texture --seed "$seed" \
    --name "titan-skull-$seed" --out "$OUT/seed-$seed" \
    --yes --quiet --no-open --json > "$OUT/seed-$seed.json" 2> "$OUT/seed-$seed.log" \
    && echo "  ok" || echo "  FAILED (see $OUT/seed-$seed.log)"
done
tripo balance
