#!/usr/bin/env python3
"""Import a GLB and save it as a self-contained .blend.

    Blender --background --python scripts/blender-glb-to-blend.py -- \
        --input model.glb --output warden.blend

Packs the images into the .blend so the file works on its own. A GLB carries
its textures inside it, but Blender unpacks them to temporary paths on import —
save without packing and the .blend opens with pink missing-texture materials
on any machine but the one that made it.

Welds on import for the same reason as blender-open-glb.py: glTF splits a vertex
at every UV seam, so an unwelded import reports tens of thousands of boundary
edges that are not real, and anything measuring or decimating from there is
working on a lie.
"""

from __future__ import annotations

import argparse
import sys

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--no-weld", action="store_true")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    bpy.ops.import_scene.gltf(filepath=args.input, merge_vertices=not args.no_weld)

    tris = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        obj.data.calc_loop_triangles()
        tris += len(obj.data.loop_triangles)

    # Textures live in the file, not beside it.
    for image in bpy.data.images:
        if image.source == "FILE" and not image.packed_file:
            try:
                image.pack()
            except RuntimeError as error:
                print(f"  (could not pack {image.name}: {error})")

    # Open in textured shading rather than flat grey.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            for space in area.spaces:
                if space.type == "VIEW_3D":
                    space.shading.type = "MATERIAL"
                    space.clip_end = 10000.0

    bpy.ops.wm.save_as_mainfile(filepath=args.output, compress=True)
    packed = sum(1 for i in bpy.data.images if i.packed_file)
    print(f"\n  saved {args.output}")
    print(f"  {tris:,} triangles, {packed} packed image(s)")


if __name__ == "__main__":
    main()
