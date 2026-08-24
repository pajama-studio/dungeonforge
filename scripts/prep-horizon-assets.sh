#!/usr/bin/env bash
# Turn the raw horizon generations into shippable silhouette props.
#
# These sit 60-140 units out and are read against the mist curtain, so the
# budget is silhouette, not surface: 8k triangles and a 512 albedo is already
# more than the distance can resolve. The raw generations are ~1.4M triangles
# and 45MB each, which is three orders of magnitude past what they need.
set -euo pipefail
B=/Applications/Blender.app/Contents/MacOS/Blender
OUT=public/assets/abyss/horizon
mkdir -p "$OUT" artifacts/tripo/horizon

for dir in tripo-out/horizon/*/; do
  name=$(basename "$dir")
  src=$(find "$dir" -name model.glb | head -1)
  [ -z "$src" ] && { echo "skip $name (no model)"; continue; }
  echo "=== $name ==="
  "$B" --background --python scripts/blender-optimize-tripo.py -- \
    --input "$src" --out-dir "artifacts/tripo/horizon/$name" --asset "$name" \
    --direct-targets "8000,2500" --skip-quad > "/tmp/opt-$name.log" 2>&1 \
    || { echo "  decimate FAILED (see /tmp/opt-$name.log)"; continue; }
  lod=$(ls "artifacts/tripo/horizon/$name"/*lod0*.glb 2>/dev/null | head -1)
  [ -z "$lod" ] && { echo "  no lod0 produced"; continue; }
  "$B" --background --python scripts/blender-resize-glb-textures.py -- \
    --input "$lod" --output "$OUT/$name.glb" --max-size 512 --draco \
    > "/tmp/tex-$name.log" 2>&1 || { echo "  resize FAILED"; continue; }
  echo "  $(( $(stat -f%z "$OUT/$name.glb") / 1024 )) KB"
done
echo; ls -la "$OUT"
