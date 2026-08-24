#!/usr/bin/env python3
"""Downsize embedded GLB textures for distant runtime assets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-size", type=int, default=1024)
    # Normal maps need their own budget. They export as lossless PNG (JPEG
    # artifacts in a normal map read as shading errors), so a 1024 normal costs
    # ~1.7 MB where a 1024 albedo JPEG costs ~165 KB — the normal alone is 80%
    # of the file. Halving just the normal keeps the albedo crisp.
    parser.add_argument("--normal-max-size", type=int, default=None)
    parser.add_argument("--draco", action="store_true")
    parser.add_argument("--strip-materials", action="store_true")
    args = parser.parse_args(argv)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    # Weld on import for the same reason the optimizer does: an unwelded mesh
    # carries a duplicate vertex at every UV seam, and re-exporting one costs
    # both file size and any chance of a later geometry pass staying watertight.
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()), merge_vertices=True)
    # Identify which images are wired into a Normal Map node, so they can be
    # budgeted separately from colour textures.
    # Walk the links rather than comparing node identity: Blender hands out a
    # fresh RNA wrapper on each access, so `link.to_node is node` is False even
    # for the same node, and the whole check silently finds nothing.
    normal_images = set()
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for link in material.node_tree.links:
            if link.to_node.type == "NORMAL_MAP" and getattr(link.from_node, "image", None):
                normal_images.add(link.from_node.image.name)

    resized = []
    for image in bpy.data.images:
        width, height = image.size[:]
        if width <= 0 or height <= 0:
            continue
        is_normal = image.name in normal_images
        limit = args.normal_max_size if (is_normal and args.normal_max_size) else args.max_size
        if max(width, height) <= limit:
            continue
        scale = limit / max(width, height)
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        image.scale(*target)
        resized.append({
            "name": image.name,
            "kind": "normal" if is_normal else "color",
            "from": [width, height],
            "to": list(target),
        })

    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            if args.strip_materials:
                obj.data.materials.clear()
            obj.select_set(True)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    export_args = {
        "filepath": str(output),
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_materials": "NONE" if args.strip_materials else "EXPORT",
    }
    if args.draco:
        export_args["export_draco_mesh_compression_enable"] = True
        export_args["export_draco_mesh_compression_level"] = 6
    bpy.ops.export_scene.gltf(**export_args)
    print("TEXTURE_RESIZE", json.dumps(resized))


if __name__ == "__main__":
    main()
