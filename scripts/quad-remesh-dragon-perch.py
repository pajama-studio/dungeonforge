#!/usr/bin/env python3
"""Headless Quad Remesher pass for the Tripo dragon-perch source.

Runs Exoside's installed Blender add-on directly instead of relying on a UI
modal timer, then exports a material-free GLB for the project's shared
triplanar hand-painted stone shader.
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector


def arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--target-quads", type=int, default=1000)
    return parser.parse_args(argv)


def mesh_metrics(obj: bpy.types.Object) -> dict:
    mesh = obj.data
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    boundary_edges = sum(edge.is_boundary for edge in bm.edges)
    non_manifold_edges = sum(not edge.is_manifold for edge in bm.edges)
    bm.free()
    return {
        "vertices": len(mesh.vertices),
        "edges": len(mesh.edges),
        "faces": len(mesh.polygons),
        "quads": sum(len(p.vertices) == 4 for p in mesh.polygons),
        "ngons": sum(len(p.vertices) > 4 for p in mesh.polygons),
        "triangles": len(mesh.loop_triangles),
        "boundaryEdges": boundary_edges,
        "nonManifoldEdges": non_manifold_edges,
        "dimensions": list(obj.dimensions),
    }


def main() -> None:
    args = arguments()
    input_path = str(Path(args.input).resolve())
    output_path = Path(args.output).resolve()
    report_path = Path(args.report).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.preferences.addon_enable(module="quad_remesher_1_4")
    from quad_remesher_1_4 import qr_operators

    bpy.ops.import_scene.gltf(filepath=input_path)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh found in Tripo GLB")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    source = bpy.context.active_object
    source.name = "dragon_slate_perch_qr_source"
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    # glTF duplicates vertices along UV and split-normal seams. Welding only
    # coincident positions restores the actual watertight Tripo surface before
    # QR sees it; otherwise every texture seam becomes a protected open border.
    bm = bmesh.new()
    bm.from_mesh(source.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(source.data)
    bm.free()
    source.data.update()

    props = bpy.context.scene.qremesher
    props.target_count = args.target_quads
    props.adaptive_size = 100
    props.adapt_quad_count = False
    props.use_vertex_color = False
    props.use_materials = False
    props.use_normals = False
    # The Tripo reduction is intentionally faceted. Treating every imported
    # split normal as a hard edge forced QR to preserve ~18k faces despite a
    # 1k target. Silhouette curvature matters here; micro-facets move to the
    # shared hand-painted material/normal response.
    props.autodetect_hard_edges = False
    props.symmetry_x = False
    props.symmetry_y = False
    props.symmetry_z = False
    props.hide_input = True

    class HeadlessOperatorState:
        def __init__(self) -> None:
            self.the_input_object = None
            self.retopoFilename = None
            self.IsRemeshing = False
            self.Aborted = False
            self.NeedReCallStartFromTimer = False
            self.progressData = qr_operators.QRCheckProgressData()

        @staticmethod
        def report(level, message) -> None:
            print(f"QUAD_REMESHER report={sorted(level)} message={message}", flush=True)

    operator = HeadlessOperatorState()
    qr_operators.doRemeshing_Start(operator, bpy.context)
    if not operator.IsRemeshing:
        raise RuntimeError("Quad Remesher did not start; check engine/license logs")

    deadline = time.monotonic() + 360
    last_progress = -1
    while time.monotonic() < deadline:
        value, label, _ = operator.progressData.get_progress_status()
        percent = round(value * 100) if 0 <= value <= 1 else value
        if percent != last_progress:
            print(f"QUAD_REMESHER progress={percent} label={label}", flush=True)
            last_progress = percent
        if value == 2:
            break
        if value < 0 and value not in (-10, -11):
            raise RuntimeError(f"Quad Remesher failed: {value} {label}")
        time.sleep(0.25)
    else:
        raise TimeoutError("Quad Remesher exceeded 360 seconds")

    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.wm.fbx_import(filepath=operator.retopoFilename)
    outputs = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]
    if len(outputs) != 1:
        raise RuntimeError(f"Expected one remeshed output, found {len(outputs)}")
    result = outputs[0]
    result.name = "dragon_slate_perch_qr_1k"
    result.data.name = "dragon_slate_perch_qr_1k_geometry"
    result.hide_set(False)
    result.hide_viewport = False
    result.hide_render = False
    bpy.ops.object.select_all(action="DESELECT")
    result.select_set(True)
    bpy.context.view_layer.objects.active = result

    # Bake the asset into the existing procedural perch's local contract.
    # Blender Z -> glTF Y (height), Blender +Y -> glTF -Z (forward thrust).
    # The old solver therefore keeps its support frame while the new visual
    # swaps in without another runtime transform or draw.
    result.rotation_euler[2] = math.pi * 0.5
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    desired = (190.0, 320.0, 145.0)
    result.scale = tuple(desired[i] / max(1e-6, result.dimensions[i]) for i in range(3))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    local_min = Vector(tuple(min(corner[i] for corner in result.bound_box) for i in range(3)))
    local_max = Vector(tuple(max(corner[i] for corner in result.bound_box) for i in range(3)))
    local_center = (local_min + local_max) * 0.5
    result.location = Vector((-local_center.x, 60.0 - local_center.y, 128.0 - local_max.z))
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    # Preserve the Tripo silhouette while widening only the four anatomical
    # contact shoulders. Coordinates are Blender local space after the above
    # normalization (GLB x=x, y=z, z=-y). This is a vertex-only deformation:
    # Quad Remesher's 1k topology, watertightness and draw count stay intact.
    contact_pads = [
        (-15.0, 162.5, 123.5),
        (15.0, 162.5, 131.0),
        (-18.2, 137.0, 121.5),
        (18.2, 137.0, 122.0),
    ]
    pad_radius = 38.0
    bm = bmesh.new()
    bm.from_mesh(result.data)
    bm.normal_update()
    raised_vertices = set()
    for vertex in bm.verts:
        # Only lift the visible/upward shell. Side and underside vertices stay
        # anchored, producing natural broken ledge walls rather than a blob.
        if vertex.normal.z < 0.05:
            continue
        for pad_x, pad_y, pad_height in contact_pads:
            distance = math.hypot(vertex.co.x - pad_x, vertex.co.y - pad_y)
            if distance >= pad_radius:
                continue
            t = 1.0 - distance / pad_radius
            weight = t * t * (3.0 - 2.0 * t)
            irregular_top = pad_height - distance * 0.055 + math.sin(vertex.co.x * 0.21 + vertex.co.y * 0.13) * 0.7
            if irregular_top > vertex.co.z:
                vertex.co.z += (irregular_top - vertex.co.z) * weight
                raised_vertices.add(vertex.index)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(result.data)
    bm.free()
    result.data.update()

    for slot in list(result.material_slots):
        result.data.materials.pop(index=0)
    metrics = mesh_metrics(result)
    if metrics["boundaryEdges"] != 0:
        raise RuntimeError(f"Remesh is open: {metrics['boundaryEdges']} boundary edges")

    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="NONE",
        export_normals=True,
        export_texcoords=False,
    )
    report = {
        "source": input_path,
        "output": str(output_path),
        "targetQuads": args.target_quads,
        "quadRemesher": "1.4",
        "settings": {"adaptiveSize": 100, "exactQuadCount": True, "detectHardEdges": False},
        "contactShoulders": {
            "count": len(contact_pads),
            "radius": pad_radius,
            "raisedVertices": len(raised_vertices),
            "preservesTopology": True,
        },
        "metrics": metrics,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
