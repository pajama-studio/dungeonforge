#!/usr/bin/env python3
"""Bake a normal map from the generated high-poly onto a decimated LOD.

Decimation from ~1.4M triangles to 30k throws away every chisel mark; the
albedo still carries painted detail, but the surface goes smooth and the
statue reads as soap. Baking the high-poly's normals into the low-poly's UV
layout puts that detail back as shading, which is the whole reason the low-poly
is usable at all.

The bake is done once, high-poly -> LOD0, and the resulting map is valid for
every lower tier too: decimation preserves the UV layout (that is why a single
albedo already serves all tiers), so the same tangent-space map applies.

    blender --background --python blender-bake-normals.py -- \
        --high raw.glb --low lod0.glb --output baked.glb --size 1024

Requires Cycles. Uses GPU when one is available; Metal on Apple silicon is
several times faster than CPU for this.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--high", required=True, help="high-poly source GLB")
    parser.add_argument("--low", required=True, help="decimated GLB to bake onto")
    parser.add_argument("--output", required=True)
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--samples", type=int, default=1)
    # Fractions of the model's bounding-box diagonal. Absolute distances are
    # useless here because assets arrive normalized to different heights.
    parser.add_argument("--ray-distance", type=float, default=0.02)
    parser.add_argument("--extrusion", type=float, default=0.01)
    # Bounds-fitting is right when the high-poly is a raw generated asset at a
    # different scale from the normalized LOD. It is WRONG when both were
    # authored in the same space and the high-poly is a displaced twin:
    # displacement grows the bounds, so fitting shrinks the cage and bakes a
    # subtly wrong map.
    parser.add_argument("--no-align", action="store_true")
    parser.add_argument("--draco", action="store_true")
    parser.add_argument("--margin", type=int, default=8)
    return parser.parse_args(argv)


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path: str, name: str) -> bpy.types.Object:
    """Import and join to a single object.

    merge_vertices matters as much here as in the optimizer: an unwelded mesh
    bakes seams as visible hard edges.
    """
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(Path(path).resolve()), merge_vertices=True)
    fresh = [o for o in set(bpy.context.scene.objects) - before if o.type == "MESH"]
    if not fresh:
        raise RuntimeError(f"no mesh in {path}")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in fresh:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = max(fresh, key=lambda o: len(o.data.polygons))
    if len(fresh) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    return obj


def diagonal(obj: bpy.types.Object) -> float:
    """Bounding-box diagonal in world space, from the object's own bound_box —
    cheap, and exact enough to scale ray distances by."""
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    return max(1e-6, sum((hi[i] - lo[i]) ** 2 for i in range(3)) ** 0.5)


def bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    lo = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    hi = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    return lo, hi


def align_to(high: bpy.types.Object, low: bpy.types.Object) -> None:
    """Put the high-poly exactly where the low-poly is.

    The optimizer normalizes every LOD to a fixed height, while the raw Tripo
    source keeps its native scale. Bake rays are cast from the low-poly surface
    outward, so if the two meshes do not occupy the same space every ray misses
    and the bake silently returns a perfectly flat map — which is precisely what
    happened the first time this ran.
    """
    hlo, hhi = bounds(high)
    llo, lhi = bounds(low)

    hsize = hhi - hlo
    lsize = lhi - llo
    axes = [(lsize[i] / hsize[i]) for i in range(3) if hsize[i] > 1e-9]
    if not axes:
        return
    factor = sum(axes) / len(axes)

    high.scale = tuple(s * factor for s in high.scale)
    bpy.context.view_layer.update()

    hlo, hhi = bounds(high)
    offset = ((llo + lhi) / 2) - ((hlo + hhi) / 2)
    high.location = high.location + offset
    bpy.context.view_layer.update()

    hlo, hhi = bounds(high)
    drift = max(abs((hhi[i] - hlo[i]) - lsize[i]) for i in range(3))
    print(f"aligned high-poly: scale x{factor:.4f}, residual extent drift {drift:.4f}", flush=True)


def configure_cycles(samples: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    prefs = bpy.context.preferences.addons.get("cycles")
    if prefs is None:
        return
    cprefs = prefs.preferences
    for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            cprefs.compute_device_type = backend
        except TypeError:
            continue
        cprefs.get_devices()
        usable = [d for d in cprefs.devices if d.type == backend]
        if usable:
            for device in cprefs.devices:
                device.use = device.type == backend
            scene.cycles.device = "GPU"
            print(f"bake device: {backend} ({len(usable)} device(s))", flush=True)
            return
    print("bake device: CPU", flush=True)


def prepare_target(low: bpy.types.Object, size: int) -> tuple[bpy.types.Image, bpy.types.Material]:
    """Give the low-poly a material whose active node is the bake target.

    Cycles bakes into whichever image node is selected/active on the active
    material, so the target has to exist on the object before baking.
    """
    if not low.data.uv_layers:
        raise RuntimeError("low-poly has no UV map; nothing to bake into")

    material = low.data.materials[0] if low.data.materials else None
    if material is None:
        material = bpy.data.materials.new("BakedNormalMaterial")
        low.data.materials.append(material)
    material.use_nodes = True

    image = bpy.data.images.new("BakedNormal", width=size, height=size, alpha=False, float_buffer=False)
    # 0.5, 0.5, 1.0 is a flat tangent-space normal: anything the bake misses
    # stays neutral instead of black.
    image.generated_color = (0.5, 0.5, 1.0, 1.0)
    image.colorspace_settings.name = "Non-Color"

    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    node.select = True
    material.node_tree.nodes.active = node
    return image, material


def wire_normal_map(material: bpy.types.Material, image: bpy.types.Image) -> None:
    """Hook the baked image up as the material's normal input, so the exported
    glTF carries it as a real normal texture rather than an orphan image."""
    tree = material.node_tree
    principled = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if principled is None:
        return

    tex = next((n for n in tree.nodes if n.type == "TEX_IMAGE" and n.image == image), None)
    if tex is None:
        return
    tex.image.colorspace_settings.name = "Non-Color"

    normal_map = next((n for n in tree.nodes if n.type == "NORMAL_MAP"), None)
    if normal_map is None:
        normal_map = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(normal_map.inputs["Color"], tex.outputs["Color"])
    tree.links.new(principled.inputs["Normal"], normal_map.outputs["Normal"])


def bake(args: argparse.Namespace) -> None:
    reset()
    low = import_glb(args.low, "LOW")
    high = import_glb(args.high, "HIGH")
    if args.no_align:
        print("alignment skipped: high and low authored in the same space", flush=True)
    else:
        align_to(high, low)

    scale = diagonal(low)
    configure_cycles(args.samples)
    image, material = prepare_target(low, args.size)

    # Smooth shading on the low-poly, so the baked map encodes the difference
    # between the smooth interpolated normal and the real high-poly surface.
    # Baking onto flat-shaded geometry produces faceting the map cannot undo.
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.shade_smooth()

    settings = bpy.context.scene.render.bake
    settings.use_selected_to_active = True
    settings.cage_extrusion = args.extrusion * scale
    settings.max_ray_distance = args.ray_distance * scale
    settings.margin = args.margin
    settings.use_clear = True

    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low  # active object receives the bake

    print(f"baking {args.size}px  extrusion={settings.cage_extrusion:.4f} "
          f"ray={settings.max_ray_distance:.4f}", flush=True)
    bpy.ops.object.bake(type="NORMAL", use_clear=True)

    image.pack()
    wire_normal_map(material, image)

    bpy.data.objects.remove(high, do_unlink=True)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.context.view_layer.objects.active = low

    kwargs = {
        "filepath": str(out),
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_materials": "EXPORT",
    }
    if args.draco:
        kwargs["export_draco_mesh_compression_enable"] = True
        kwargs["export_draco_mesh_compression_level"] = 6
    bpy.ops.export_scene.gltf(**kwargs)
    print(f"wrote {out} ({out.stat().st_size / 1048576:.2f} MB)", flush=True)


if __name__ == "__main__":
    bake(parse_args())
