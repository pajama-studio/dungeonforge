#!/usr/bin/env bash
# Raw generation -> shippable tiers -> catalogue entry -> live on props.
#
# Matches what the existing drowned-court props ship, so the new arrivals sit on
# the same shelf without a reader having to know which batch they came from:
#
#   30k / 1024   hero, the tier a scene loads and the viewer opens on
#   8k  / 512    mid
#   2500 / 256   preview, and what the open web gets by default
#
# Texture size tracks triangle count deliberately. Carrying the source 2048 down
# to a 2500-triangle proxy is four megabytes of texture wrapped around nothing,
# and it is the single biggest waste in an asset pipeline that otherwise looks
# fine on paper.
#
#   ./scripts/pipeline-court-expansion.sh            # decimate + ship
#
# Shipping is where this script stops. The catalogue entry that puts a prop on
# props.pajama.studio is hand-written in ../props/catalog/drowned-court.json —
# name, summary and tags are editorial, and a generated placeholder for them is
# worse than an obviously absent one. This header used to advertise a
# `--catalog` flag; the script never parsed an argument in its life.
set -euo pipefail

B=/Applications/Blender.app/Contents/MacOS/Blender
SRC_ROOT=tripo-out/court-expansion
DEST=public/assets/abyss/court
WORK=artifacts/tripo/court-expansion
mkdir -p "$DEST" "$WORK"

shipped=0
skipped=0

for dir in "$SRC_ROOT"/*/; do
  slug=$(basename "$dir")
  src=$(find "$dir" -name model.glb 2>/dev/null | head -1)
  [ -z "$src" ] && { echo "  ! $slug — no model.glb"; skipped=$((skipped+1)); continue; }

  if [ -f "$DEST/$slug-render-30k.glb" ]; then
    echo "  = $slug (already shipped)"
    continue
  fi

  echo "=== $slug ==="
  "$B" --background --python scripts/blender-optimize-tripo.py -- \
    --input "$src" --out-dir "$WORK/$slug" --asset "$slug" \
    --direct-targets "30000,8000,2500" --skip-quad > "/tmp/opt-$slug.log" 2>&1 \
    || { echo "  ! decimate failed (see /tmp/opt-$slug.log)"; skipped=$((skipped+1)); continue; }

  ok=1
  # Match the tier by LOD index, not by the target triangle count. The decimator
  # names its output after the count it actually reached, which lands a few
  # triangles short whenever the mesh has no edge collapse left at the target —
  # lod1 of a 30k source comes out "7998tri", not "8000tri". Globbing for the
  # target made the miss silent: `ls` fails, pipefail propagates it, and set -e
  # took the whole run down before the "missing" branch below could report it.
  for pair in "lod0-:render-30k:1024" "lod1-:render-8k:512" "lod2-:render-2500:256"; do
    lod="${pair%%:*}"; rest="${pair#*:}"; name="${rest%%:*}"; tex="${rest##*:}"
    in=$(ls "$WORK/$slug"/*"$lod"*.glb 2>/dev/null | head -1 || true)
    [ -z "$in" ] && { echo "  ! missing $lod"; ok=0; break; }
    "$B" --background --python scripts/blender-resize-glb-textures.py -- \
      --input "$in" --output "$DEST/$slug-$name.glb" --max-size "$tex" --draco \
      > /dev/null 2>&1 || { echo "  ! resize failed for $name"; ok=0; break; }
    printf "  %-28s %5s KB\n" "$slug-$name.glb" "$(( $(stat -f%z "$DEST/$slug-$name.glb") / 1024 ))"
  done
  [ "$ok" = 1 ] && shipped=$((shipped+1)) || skipped=$((skipped+1))
done

echo
echo "shipped $shipped, skipped $skipped"
