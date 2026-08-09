#!/usr/bin/env python3
"""Author the dungeon's structural modules as low-poly, UV-unwrapped GLBs.

These are the pieces that carry every frame — masonry blocks, steps, arch
voussoirs, planks, merlons. Today they are chamfered boxes built in
src/scene/kit/geometries.ts, and they are stacked by the thousand through
InstancedMesh, so the triangle budget per piece is tiny and must stay tiny.

The point of authoring them here rather than generating them is control: exact
CELL/COURSE dimensions so courses stack without seams, and enough carved relief
(bevels, a mortar recess, broken corners) that a texture pass has something to
key on. A featureless box comes back from texturing as flat colour — that
lesson cost one wasted task on a smooth remeshed rock.

Because a wall is discrete instanced blocks rather than a tiling sheet,
per-block texture variation is not a seam problem — it is what real masonry
looks like. Variants exist so the cell hash can choose between them.

    blender --background --python blender-author-modules.py -- --out-dir DIR
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

# Mirrors src/config.ts. Authoring against anything else guarantees seams.
CELL = 2.2
TH = 1.85
COURSE = TH / 2


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--only", default=None, help="author a single module by name")
    return parser.parse_args(argv)


def fresh() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def new_mesh(name: str) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    return obj


def box(bm: bmesh.types.BMesh, sx: float, sy: float, sz: float, at=(0.0, 0.0, 0.0)) -> list:
    """Axis-aligned box, returned as its faces so callers can bevel selectively."""
    verts = []
    for ix in (-0.5, 0.5):
        for iy in (-0.5, 0.5):
            for iz in (-0.5, 0.5):
                verts.append(bm.verts.new((at[0] + ix * sx, at[1] + iy * sy, at[2] + iz * sz)))
    bm.verts.ensure_lookup_table()
    idx = [
        (0, 1, 3, 2), (4, 6, 7, 5),      # -x, +x
        (0, 4, 5, 1), (2, 3, 7, 6),      # -y, +y
        (0, 2, 6, 4), (1, 5, 7, 3),      # -z, +z
    ]
    return [bm.faces.new([verts[i] for i in quad]) for quad in idx]


def finish(obj: bpy.types.Object, bm: bmesh.types.BMesh) -> None:
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.materials.append(bpy.data.materials.new(f"{obj.name}_surface"))


def unwrap(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


# ---------------------------------------------------------------- modules

def masonry_block(variant: int) -> bpy.types.Object:
    """One course of wall. Bevelled arris plus a recessed bed joint, so the
    texture pass has an edge to catch light on and a shadow line to sit in."""
    obj = new_mesh(f"masonry-block-{variant}")
    bm = bmesh.new()

    w, h, d = CELL * 1.02, COURSE * 1.02, CELL * 1.02
    faces = box(bm, w, h, d)

    # Chamfer every edge; the arris is what reads as cut stone at distance.
    bevel = 0.055 + 0.02 * variant
    bmesh.ops.bevel(
        bm, geom=list(bm.edges) + list(bm.verts), offset=bevel, segments=1, affect="EDGES",
    )

    # Recessed bed joint on the four upright faces: a shallow inset band at the
    # bottom, which is where mortar shadow lives on real coursed masonry.
    inset = 0.05 + 0.015 * variant
    band = [f for f in bm.faces if abs(f.normal.z) < 0.3 and f.calc_center_median().z < -h * 0.22]
    if band:
        result = bmesh.ops.inset_individual(bm, faces=band, thickness=0.03, depth=-inset)
        del result

    # Break one top corner progressively harder per variant, so a wall built
    # from three variants does not read as a repeat.
    if variant > 0:
        corner = max(bm.verts, key=lambda v: v.co.x + v.co.y + v.co.z)
        bmesh.ops.bevel(
            bm, geom=[corner], offset=0.07 * variant, segments=1, affect="VERTICES",
        )

    finish(obj, bm)
    return obj


def block_cap() -> bpy.types.Object:
    """Wall head: a weathered coping course with a slight overhang."""
    obj = new_mesh("masonry-cap")
    bm = bmesh.new()
    box(bm, CELL * 1.08, COURSE * 0.62, CELL * 1.08, at=(0, 0, 0))
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=0.075, segments=1, affect="EDGES")
    top = [f for f in bm.faces if f.normal.z > 0.85]
    if top:
        bmesh.ops.inset_individual(bm, faces=top, thickness=0.09, depth=-0.045)
    finish(obj, bm)
    return obj


def stair_step() -> bpy.types.Object:
    """One tread. Dimensions must match stepGeo or stairs stop meeting floors."""
    obj = new_mesh("stair-step")
    bm = bmesh.new()
    box(bm, CELL * 1.0, TH / 4, CELL / 4 + 0.06)
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=0.035, segments=1, affect="EDGES")
    # Worn nosing: the front top edge takes the traffic, so round it harder.
    front = [e for e in bm.edges
             if all(v.co.y > (CELL / 8) * 0.55 for v in e.verts)
             and all(v.co.z > (TH / 8) * 0.4 for v in e.verts)]
    if front:
        bmesh.ops.bevel(bm, geom=front, offset=0.05, segments=2, affect="EDGES")
    finish(obj, bm)
    return obj


def arch_voussoir() -> bpy.types.Object:
    """A single wedge of an arch ring. Tapered so a run of them closes a curve."""
    obj = new_mesh("arch-voussoir")
    bm = bmesh.new()
    faces = box(bm, CELL * 0.42, COURSE * 0.95, CELL * 0.9)
    # Taper the inner face to a wedge: scale the -z end in.
    for v in bm.verts:
        if v.co.z < 0:
            v.co.x *= 0.72
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=0.04, segments=1, affect="EDGES")
    del faces
    finish(obj, bm)
    return obj


def bridge_plank() -> bpy.types.Object:
    """Rope-bridge decking. Thin, so it needs the bevel to catch any light."""
    obj = new_mesh("bridge-plank")
    bm = bmesh.new()
    box(bm, 1.15, 0.085, 0.42)
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=0.018, segments=1, affect="EDGES")
    # Split the top face lengthwise so grain has somewhere to sit.
    top = [f for f in bm.faces if f.normal.z > 0.85]
    if top:
        bmesh.ops.inset_individual(bm, faces=top, thickness=0.035, depth=-0.012)
    finish(obj, bm)
    return obj


def merlon() -> bpy.types.Object:
    """Rampart tooth."""
    obj = new_mesh("merlon")
    bm = bmesh.new()
    box(bm, 0.72, 0.55, 0.72)
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=0.05, segments=1, affect="EDGES")
    finish(obj, bm)
    return obj


MODULES = {
    "masonry-block-0": lambda: masonry_block(0),
    "masonry-block-1": lambda: masonry_block(1),
    "masonry-block-2": lambda: masonry_block(2),
    "masonry-cap": block_cap,
    "stair-step": stair_step,
    "arch-voussoir": arch_voussoir,
    "bridge-plank": bridge_plank,
    "merlon": merlon,
}


def sculpt_high(obj: bpy.types.Object, seed: int) -> bpy.types.Object:
    """A high-poly twin of a module, for baking detail down onto the low-poly.

    Tripo's texture model is conditioned on 3D form; on a 44-triangle block it
    has nothing to read and returns flat colour (measured twice, 40 credits).
    Architectural modules therefore get their chisel marks the classical way:
    subdivide, displace with noise, bake the difference into a normal map. Costs
    no credits and gives detail we actually control.
    """
    high = obj.copy()
    high.data = obj.data.copy()
    high.name = f"{obj.name}-high"
    bpy.context.scene.collection.objects.link(high)

    sub = high.modifiers.new("sub", "SUBSURF")
    sub.subdivision_type = "SIMPLE"   # keep the silhouette; we want facets, not a pillow
    sub.levels = sub.render_levels = 4

    tex = bpy.data.textures.new(f"{obj.name}-chisel", type="CLOUDS")
    tex.noise_scale = 0.42
    tex.noise_depth = 4

    disp = high.modifiers.new("chisel", "DISPLACE")
    disp.texture = tex
    # Strength is relative to a 2.2-unit block: 0.045 was invisible once baked.
    disp.strength = 0.16
    disp.mid_level = 0.5

    fine_tex = bpy.data.textures.new(f"{obj.name}-grain", type="STUCCI")
    fine_tex.noise_scale = 0.13
    fine = high.modifiers.new("grain", "DISPLACE")
    fine.texture = fine_tex
    fine.strength = 0.05
    fine.mid_level = 0.5

    bpy.context.view_layer.objects.active = high
    for mod in ("sub", "chisel", "grain"):
        bpy.ops.object.modifier_apply(modifier=mod)
    return high


def main() -> None:
    args = parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    high_dir = out_dir / "high"
    high_dir.mkdir(parents=True, exist_ok=True)

    names = [args.only] if args.only else list(MODULES)
    for name in names:
        if name not in MODULES:
            raise SystemExit(f"unknown module: {name}")
        fresh()
        obj = MODULES[name]()
        unwrap(obj)

        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)

        high = sculpt_high(obj, seed=hash(name) & 0xffff)
        high_tris = sum(len(p.vertices) - 2 for p in high.data.polygons)
        bpy.ops.object.select_all(action="DESELECT")
        high.select_set(True)
        bpy.context.view_layer.objects.active = high
        bpy.ops.export_scene.gltf(
            filepath=str(high_dir / f"{name}.glb"), export_format="GLB",
            use_selection=True, export_apply=True, export_materials="EXPORT",
        )

        path = out_dir / f"{name}.glb"
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.export_scene.gltf(
            filepath=str(path), export_format="GLB", use_selection=True,
            export_apply=True, export_materials="EXPORT",
        )
        print(f"{name:20} {tris:>5} tris (high {high_tris:>7})  {path.stat().st_size / 1024:.0f} KB", flush=True)


if __name__ == "__main__":
    main()
