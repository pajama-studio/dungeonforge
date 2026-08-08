#!/usr/bin/env python3
"""Render a bbox-framed neutral turntable for an arbitrary GLB."""

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--label", default="review")
    parser.add_argument("--resolution", type=int, default=720)
    return parser.parse_args(argv)


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    corners = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    return (
        Vector(tuple(min(point[axis] for point in corners) for axis in range(3))),
        Vector(tuple(max(point[axis] for point in corners) for axis in range(3))),
    )


def add_area(name: str, center: Vector, offset: Vector, energy: float, size: float, color) -> None:
    data = bpy.data.lights.new(name=name, type="AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    data.color = color
    light = bpy.data.objects.new(name, data)
    light.location = center + offset
    bpy.context.collection.objects.link(light)
    look_at(light, center)


def main() -> None:
    options = args()
    out_dir = Path(options.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(Path(options.input).resolve()))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh in GLB")

    material = bpy.data.materials.new("ColdHandPaintedSlateReview")
    material.diffuse_color = (0.13, 0.17, 0.23, 1)
    material.metallic = 0
    material.roughness = 0.94
    for mesh in meshes:
        mesh.data.materials.clear()
        mesh.data.materials.append(material)

    lower, upper = world_bounds(meshes)
    center = (lower + upper) * 0.5
    size = upper - lower
    radius = size.length * 0.5
    camera_data = bpy.data.cameras.new("ReviewCamera")
    camera_data.lens = 54
    camera_data.sensor_width = 36
    camera = bpy.data.objects.new("ReviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)

    span = max(size)
    energy_scale = max(0.02, span * span)
    add_area("Key", center, Vector((-1.15, -1.35, 1.65)) * span, 32 * energy_scale, span * 0.9, (0.66, 0.78, 1))
    add_area("Fill", center, Vector((1.5, -0.7, 0.45)) * span, 14 * energy_scale, span * 0.75, (0.36, 0.52, 0.78))
    add_area("Rim", center, Vector((0.35, 1.4, 1.15)) * span, 38 * energy_scale, span * 0.65, (0.5, 0.72, 1))

    scene = bpy.context.scene
    scene.camera = camera
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = options.resolution
    scene.render.resolution_y = options.resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.world.color = (0.006, 0.01, 0.018)
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        scene.view_settings.look = "Medium High Contrast"

    fov = 2 * math.atan(camera_data.sensor_width / (2 * camera_data.lens))
    distance = radius / max(0.1, math.sin(fov * 0.5)) * 1.12
    directions = {
        "front": Vector((0, -1, 0.18)),
        "three-quarter": Vector((0.72, -0.72, 0.26)),
        "side": Vector((1, 0, 0.18)),
        "rear": Vector((0, 1, 0.18)),
        "high": Vector((0.64, -0.55, 0.72)),
    }
    for name, direction in directions.items():
        camera.location = center + direction.normalized() * distance
        look_at(camera, center)
        scene.render.filepath = str(out_dir / f"{options.label}-{name}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
