#!/usr/bin/env python3
"""UV-unwrap a GLB so Tripo has somewhere to paint.

Our own modular geometry is authored for topology, not texturing, and often
carries no UV map at all — the quad-remeshed pieces export POSITION and NORMAL
only. Tripo's re-texture step needs a UV layout; without one the task fails and
refunds.

Smart UV Project is the right tool here: the pieces are chunky and faceted, so
angle-based islands land on the natural planes, and we care about coverage and
no overlap rather than an artist-grade layout.

    blender --background --python blender-unwrap-glb.py -- \
        --input piece.glb --output piece-uv.glb [--angle 66] [--margin 0.02]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    # 66° splits on hard edges without shattering into confetti.
    parser.add_argument("--angle", type=float, default=66.0)
    # Island padding, in UV units. Texture bleed at 1024 needs roughly this.
    parser.add_argument("--margin", type=float, default=0.02)
    parser.add_argument("--force", action="store_true", help="re-unwrap even if UVs exist")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()), merge_vertices=True)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("no mesh in input")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = max(meshes, key=lambda o: len(o.data.polygons))
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active

    if obj.data.uv_layers and not args.force:
        print(f"already has {len(obj.data.uv_layers)} UV layer(s); keeping them", flush=True)
    else:
        for layer in list(obj.data.uv_layers):
            obj.data.uv_layers.remove(layer)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(
            angle_limit=args.angle * 3.14159265 / 180.0,
            island_margin=args.margin,
        )
        bpy.ops.object.mode_set(mode="OBJECT")
        print(f"unwrapped: {len(obj.data.polygons)} faces -> {len(obj.data.uv_layers)} UV layer", flush=True)

    # Tripo needs a material slot to hang the painted maps on.
    if not obj.data.materials:
        obj.data.materials.append(bpy.data.materials.new("AtomSurface"))

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    # Deliberately no Draco: this GLB is an upload for texturing, and the
    # service has to read the geometry, not stream it.
    bpy.ops.export_scene.gltf(
        filepath=str(out), export_format="GLB", use_selection=True,
        export_apply=True, export_materials="EXPORT",
    )
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)", flush=True)


if __name__ == "__main__":
    main()
