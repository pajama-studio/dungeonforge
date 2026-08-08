#!/usr/bin/env python3
"""Remove tiny disconnected islands from an admitted open-shell GLB.

Large boundary loops are intentionally preserved (e.g. torn dragon wings).
The script only removes loose/small components, welds near-duplicate vertices,
recalculates normals, and exports a geometry-only uncompressed runtime GLB.
"""

from __future__ import annotations

import argparse
import bmesh
import json
from pathlib import Path
import sys

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--min-component-faces", type=int, default=45)
    parser.add_argument("--relative-component-floor", type=float, default=0.001)
    parser.add_argument("--merge-distance", type=float, default=0.00035)
    return parser.parse_args(argv)


def stats(obj: bpy.types.Object) -> dict:
    mesh = obj.data
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    boundary = sum(1 for edge in bm.edges if edge.is_boundary)
    non_manifold = sum(1 for edge in bm.edges if not edge.is_manifold)
    loose = sum(1 for edge in bm.edges if not edge.link_faces)
    bm.free()
    return {
        "vertices": len(mesh.vertices),
        "faces": len(mesh.polygons),
        "triangles": len(mesh.loop_triangles),
        "boundaryEdges": boundary,
        "nonManifoldEdges": non_manifold,
        "looseEdges": loose,
    }


def face_components(bm: bmesh.types.BMesh) -> list[list[bmesh.types.BMFace]]:
    unseen = set(bm.faces)
    components = []
    while unseen:
        seed = unseen.pop()
        component = [seed]
        stack = [seed]
        while stack:
            face = stack.pop()
            for edge in face.edges:
                for neighbor in edge.link_faces:
                    if neighbor in unseen:
                        unseen.remove(neighbor)
                        component.append(neighbor)
                        stack.append(neighbor)
        components.append(component)
    return sorted(components, key=len, reverse=True)


def main() -> None:
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh in input GLB")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = max(meshes, key=lambda item: len(item.data.polygons))
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    before = stats(obj)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    components = face_components(bm)
    threshold = max(
        args.min_component_faces,
        round((len(components[0]) if components else 0) * args.relative_component_floor),
    )
    removed_sizes = [len(component) for component in components if len(component) < threshold]
    doomed = [face for component in components if len(component) < threshold for face in component]
    if doomed:
        bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=args.merge_distance)
    loose_verts = [vertex for vertex in bm.verts if not vertex.link_faces]
    if loose_verts:
        bmesh.ops.delete(bm, geom=loose_verts, context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    obj.data.validate(clean_customdata=True)
    obj.data.materials.clear()
    after = stats(obj)

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="NONE",
    )
    report = {
        "input": str(Path(args.input).resolve()),
        "output": str(output),
        "before": before,
        "after": after,
        "componentFaceCounts": [len(component) for component in components[:64]],
        "componentThreshold": threshold,
        "removedComponentFaceCounts": removed_sizes,
        "preservedOpenBoundaries": True,
    }
    report_path = Path(args.report).resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
