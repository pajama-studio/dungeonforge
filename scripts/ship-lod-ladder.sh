#!/usr/bin/env bash
# Build the full LOD ladder for the assets generated this session, sized so each
# tier's texture matches what its triangle count can carry. A 1.5k-triangle
# proxy behind a 2048 albedo is 4MB of texture wrapped around nothing.
set -euo pipefail
B=/Applications/Blender.app/Contents/MacOS/Blender

ship() {  # <src glb> <dest> <texture max>
  local src="$1" dest="$2" tex="$3"
  [ -f "$src" ] || { echo "  missing $src"; return; }
  "$B" --background --python scripts/blender-resize-glb-textures.py -- \
    --input "$src" --output "$dest" --max-size "$tex" --draco > /dev/null 2>&1 \
    && printf "  %-46s %5s KB\n" "$(basename "$dest")" "$(( $(stat -f%z "$dest") / 1024 ))" \
    || echo "  FAILED $dest"
}

echo "titan skull"
S=artifacts/tripo/titan-skull/optimized
D=public/assets/abyss/dragon
ship "$S/titan-skull-direct-lod0-120000tri.glb" "$D/titan-skull-perch-120k.glb" 2048
ship "$S/titan-skull-direct-lod2-8000tri.glb"   "$D/titan-skull-perch-8k.glb"   512
ship "$S/titan-skull-direct-lod3-1498tri.glb"   "$D/titan-skull-perch-1500.glb" 256

echo "horizon"
D=public/assets/abyss/horizon
for name in horizon-arch-buttress horizon-cliff-terrace horizon-spire-needle horizon-tower-ruin horizon-ziggurat-ruin; do
  ship "artifacts/tripo/horizon/$name/${name}-direct-lod1-2500tri.glb" "$D/${name}-2500.glb" 256
done
