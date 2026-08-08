#!/usr/bin/env python3
"""Render deterministic multi-angle geometry review frames for a GLB."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--resolution", type=int, default=640)
    parser.add_argument("--keep-material", action="store_true")
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def neutral_material() -> bpy.types.Material:
    material = bpy.data.materials.new("ReviewBasalt")
    material.diffuse_color = (0.17, 0.205, 0.24, 1.0)
    material.metallic = 0.0
    material.roughness = 0.82
    return material


def add_area(name: str, location, energy: float, size: float, color) -> None:
    data = bpy.data.lights.new(name=name, type="AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    data.color = color
    light = bpy.data.objects.new(name, data)
    light.location = location
    bpy.context.collection.objects.link(light)
    look_at(light, Vector((0.0, 0.0, 4.5)))


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(input_path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh in review GLB")
    if not args.keep_material:
        material = neutral_material()
        for obj in meshes:
            obj.data.materials.clear()
            obj.data.materials.append(material)

    camera_data = bpy.data.cameras.new("ReviewCamera")
    camera_data.lens = 58
    camera_data.sensor_width = 36
    camera = bpy.data.objects.new("ReviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    add_area("Key", (-9.0, -11.0, 15.0), 1450, 7.0, (0.68, 0.8, 1.0))
    add_area("Fill", (11.0, -7.0, 7.0), 900, 6.0, (0.42, 0.62, 1.0))
    add_area("Rim", (2.0, 10.0, 13.0), 1750, 5.0, (0.35, 0.72, 1.0))

    scene = bpy.context.scene
    # Blender 5 exposes Eevee through the stable BLENDER_EEVEE identifier.
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = args.resolution
    scene.render.resolution_y = args.resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.world.color = (0.008, 0.012, 0.022)
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:  # Blender 3.6 exposes the same transform without prefix.
        scene.view_settings.look = "Medium High Contrast"

    target = Vector((0.0, 0.0, 4.8))
    views = {
        "front": (0.0, -19.5, 5.6),
        "three-quarter": (13.8, -13.8, 6.4),
        "side": (19.5, 0.0, 5.6),
        "back": (0.0, 19.5, 5.6),
    }
    for view, location in views.items():
        camera.location = location
        look_at(camera, target)
        scene.render.filepath = str(out_dir / f"{args.label}-{view}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
