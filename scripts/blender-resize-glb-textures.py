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
    parser.add_argument("--draco", action="store_true")
    parser.add_argument("--strip-materials", action="store_true")
    args = parser.parse_args(argv)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))
    resized = []
    for image in bpy.data.images:
        width, height = image.size[:]
        if width <= 0 or height <= 0 or max(width, height) <= args.max_size:
            continue
        scale = args.max_size / max(width, height)
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        image.scale(*target)
        resized.append({"name": image.name, "from": [width, height], "to": list(target)})

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
