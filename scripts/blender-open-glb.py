#!/usr/bin/env python3
"""Open a GLB in the Blender GUI, textured, framed and ready to look at.

    /Applications/Blender.app/Contents/MacOS/Blender --python scripts/blender-open-glb.py -- \
        --input artifacts/tripo/warden/raw/tripo-out/.../model.glb

Two things this does that a plain File > Import does not:

  merge_vertices=True on import. glTF splits a vertex at every UV seam, so a
  Tripo statue arrives with tens of thousands of boundary edges that are not
  really boundaries. Sculpting, decimating or measuring an unwelded mesh all
  give wrong answers, and the tear only shows up later.

  Material Preview shading, so the baked albedo is actually visible. Solid
  shading is the default and shows flat grey, which reads as "the textures did
  not come through" when they did.
"""

from __future__ import annotations

import argparse
import sys

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--no-weld", action="store_true",
                        help="import exactly as authored, seams unwelded")
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def report(objects: list[bpy.types.Object]) -> None:
    tris = 0
    verts = 0
    images = set()
    for obj in objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        tris += len(mesh.loop_triangles)
        verts += len(mesh.vertices)
        for slot in obj.material_slots:
            if not slot.material or not slot.material.use_nodes:
                continue
            for node in slot.material.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    images.add((node.image.name, tuple(node.image.size)))
    print(f"\n  meshes     {sum(1 for o in objects if o.type == 'MESH')}")
    print(f"  triangles  {tris:,}")
    print(f"  vertices   {verts:,}")
    print(f"  textures   {len(images)}")
    for name, size in sorted(images):
        print(f"    {name}  {size[0]}x{size[1]}")


def main() -> None:
    args = parse_args()
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=args.input, merge_vertices=not args.no_weld)
    imported = [o for o in bpy.context.scene.objects]
    report(imported)

    for obj in imported:
        obj.select_set(True)
    if imported:
        bpy.context.view_layer.objects.active = imported[0]

    # Frame the import and switch to textured shading in every 3D viewport.
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type != "VIEW_3D":
                continue
            for space in area.spaces:
                if space.type == "VIEW_3D":
                    space.shading.type = "MATERIAL"
                    space.clip_end = 10000.0
            # view_all polls for a WINDOW region, not just the area — without
            # one it raises, and headless has no region at all.
            region = next((r for r in area.regions if r.type == "WINDOW"), None)
            if region is None:
                continue
            try:
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.view3d.view_all(center=False)
            except RuntimeError as error:
                print(f"  (could not frame the view: {error})")

    print(f"\n  opened {args.input}")


if __name__ == "__main__":
    main()
