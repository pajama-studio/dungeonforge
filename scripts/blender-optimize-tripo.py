#!/usr/bin/env python3
"""Prepare a Tripo GLB, run real Quad Remesher when available, and emit runtime LODs.

Run with Blender, for example:
  Blender --background --python scripts/blender-optimize-tripo.py -- \
    --input model.glb --out-dir artifacts/tripo/oracle/optimized --asset oracle

The direct decimation branch keeps the Tripo UV/PBR material. The Quad Remesher
branch intentionally receives a small neutral material because retopology does
not preserve the source UV layout; runtime uses the project's triplanar stone.
"""

from __future__ import annotations

import argparse
import bmesh
import hashlib
import json
from pathlib import Path
import sys
import time

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--asset", default="tripo-asset")
    parser.add_argument("--height", type=float, default=10.0)
    parser.add_argument("--direct-targets", default="120000,30000,8000,1500")
    parser.add_argument("--quad-target", type=int, default=18000)
    parser.add_argument("--quad-lod-targets", default="10000,2500")
    parser.add_argument("--quad-voxel-size", type=float, default=0.04)
    parser.add_argument("--quad-timeout", type=float, default=420.0)
    parser.add_argument("--skip-direct", action="store_true")
    parser.add_argument("--skip-quad", action="store_true")
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def select_only(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.hide_set(False)
    obj.hide_viewport = False
    obj.hide_render = False
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def import_joined_mesh(path: Path, name: str) -> bpy.types.Object:
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("The GLB contains no mesh objects")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = max(meshes, key=lambda obj: len(obj.data.polygons))
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = f"{name}_mesh"
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return obj


def world_bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    lo = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    hi = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return lo, hi


def normalize(obj: bpy.types.Object, height: float) -> None:
    lo, hi = world_bounds(obj)
    source_height = hi.z - lo.z
    if source_height <= 1e-8:
        raise RuntimeError("Cannot normalize a zero-height mesh")
    scale = height / source_height
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    lo, hi = world_bounds(obj)
    obj.location += Vector((-(lo.x + hi.x) * 0.5, -(lo.y + hi.y) * 0.5, -lo.z))
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def mesh_stats(obj: bpy.types.Object) -> dict:
    mesh = obj.data
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.edges.ensure_lookup_table()
    non_manifold = sum(1 for edge in bm.edges if not edge.is_manifold)
    boundary = sum(1 for edge in bm.edges if edge.is_boundary)
    loose = sum(1 for edge in bm.edges if not edge.link_faces)
    bm.free()
    lo, hi = world_bounds(obj)
    return {
        "vertices": len(mesh.vertices),
        "edges": len(mesh.edges),
        "faces": len(mesh.polygons),
        "triangles": len(mesh.loop_triangles),
        "quads": sum(1 for poly in mesh.polygons if len(poly.vertices) == 4),
        "ngons": sum(1 for poly in mesh.polygons if len(poly.vertices) > 4),
        "uvLayers": len(mesh.uv_layers),
        "materialSlots": len(obj.material_slots),
        "nonManifoldEdges": non_manifold,
        "boundaryEdges": boundary,
        "looseEdges": loose,
        "bounds": {
            "min": [round(value, 6) for value in lo],
            "max": [round(value, 6) for value in hi],
            "size": [round(hi[i] - lo[i], 6) for i in range(3)],
        },
    }


def clone_object(source: bpy.types.Object, name: str) -> bpy.types.Object:
    clone = source.copy()
    clone.data = source.data.copy()
    clone.name = name
    clone.data.name = f"{name}_mesh"
    bpy.context.collection.objects.link(clone)
    return clone


def decimate_to(obj: bpy.types.Object, target_triangles: int) -> None:
    current = mesh_stats(obj)["triangles"]
    if target_triangles >= current:
        return
    modifier = obj.modifiers.new(name="RuntimeDecimate", type="DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = max(0.0001, min(1.0, target_triangles / current))
    modifier.use_collapse_triangulate = True
    select_only(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    select_only(obj)
    kwargs = {
        "filepath": str(path),
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_materials": "EXPORT",
    }
    try:
        bpy.ops.export_scene.gltf(
            **kwargs,
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
        )
    except (TypeError, RuntimeError):
        bpy.ops.export_scene.gltf(**kwargs)


def artifact_record(path: Path, stats: dict, branch: str, target: int | None) -> dict:
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "branch": branch,
        "targetTriangles": target,
        "mesh": stats,
    }


def neutral_stone_material() -> bpy.types.Material:
    material = bpy.data.materials.get("Dungeonforge_TriplanarStone_Placeholder")
    if material is None:
        material = bpy.data.materials.new("Dungeonforge_TriplanarStone_Placeholder")
        material.diffuse_color = (0.105, 0.125, 0.15, 1.0)
        material.metallic = 0.0
        material.roughness = 0.9
    return material


def voxel_weld(source: bpy.types.Object, voxel_size: float) -> bpy.types.Object:
    """Create a watertight proxy before sending Tripo geometry to Quad Remesher."""
    proxy = clone_object(source, f"{source.name}_VOXEL_WELD")
    select_only(proxy)
    proxy.data.remesh_voxel_size = voxel_size
    proxy.data.remesh_voxel_adaptivity = 0.0
    result = bpy.ops.object.voxel_remesh()
    if "FINISHED" not in result:
        raise RuntimeError(f"Voxel remesh failed: {result}")
    for polygon in proxy.data.polygons:
        polygon.use_smooth = True
    return proxy


class QuadRemeshProxy:
    def __init__(self, progress_cls):
        self.the_input_object = None
        self.retopoFilename = None
        self.IsRemeshing = False
        self.Aborted = False
        self.progressData = progress_cls()
        self.messages: list[dict] = []

    def report(self, levels, message):
        record = {"levels": sorted(levels), "message": str(message)}
        self.messages.append(record)
        print("QUAD_REMESHER", json.dumps(record))


def run_quad_remesher(
    source: bpy.types.Object, target_quads: int, timeout: float, voxel_size: float
) -> tuple[bpy.types.Object | None, dict]:
    result = {
        "requested": True,
        "addon": "quad_remesher_1_4",
        "targetQuads": target_quads,
        "voxelWeldSize": voxel_size,
        "status": "not-started",
        "durationSeconds": 0.0,
        "messages": [],
    }
    started = time.monotonic()
    welded = None
    try:
        if "quad_remesher_1_4" not in bpy.context.preferences.addons:
            bpy.ops.preferences.addon_enable(module="quad_remesher_1_4")
        from quad_remesher_1_4 import qr_operators

        props = bpy.context.scene.qremesher
        props.target_count = target_quads
        props.adaptive_size = 72
        props.adapt_quad_count = False
        props.use_vertex_color = False
        props.use_materials = False
        props.use_normals = False
        props.autodetect_hard_edges = False
        props.symmetry_x = False
        props.symmetry_y = False
        props.symmetry_z = False
        props.hide_input = True

        welded = voxel_weld(source, voxel_size)
        result["preprocessMesh"] = mesh_stats(welded)
        select_only(welded)
        before = set(bpy.context.scene.objects)
        proxy = QuadRemeshProxy(qr_operators.QRCheckProgressData)
        qr_operators.doRemeshing_Start(proxy, bpy.context)
        result["messages"] = proxy.messages
        if not proxy.IsRemeshing:
            result["status"] = "failed-to-start"
            return None, result

        last_bucket = -1
        while time.monotonic() - started < timeout:
            progress, message, _sleep_advice = proxy.progressData.get_progress_status()
            bucket = int(max(0.0, min(1.0, progress)) * 10) if progress is not None else 0
            if bucket != last_bucket:
                print(f"QUAD_REMESHER_PROGRESS {progress}")
                last_bucket = bucket
            if progress == 2:
                qr_operators.doRemeshing_Finish(proxy, bpy.context)
                candidates = [
                    obj
                    for obj in bpy.context.scene.objects
                    if obj.type == "MESH" and obj not in before
                ]
                if not candidates:
                    candidates = [
                        obj
                        for obj in bpy.context.selected_objects
                        if obj.type == "MESH" and obj != welded
                    ]
                if not candidates:
                    raise RuntimeError("Quad Remesher completed but imported no result mesh")
                remeshed = max(candidates, key=lambda obj: len(obj.data.polygons))
                remeshed.name = f"{source.name}_QUAD"
                remeshed.data.name = f"{remeshed.name}_mesh"
                select_only(remeshed)
                remeshed.data.materials.clear()
                remeshed.data.materials.append(neutral_stone_material())
                bpy.data.objects.remove(welded, do_unlink=True)
                welded = None
                result["status"] = "success"
                return remeshed, result
            if progress == -2:
                result["status"] = "license-or-eula-required"
                result["message"] = message
                return None, result
            if progress is not None and progress < 0 and progress != -11:
                result["status"] = "engine-error"
                result["progressCode"] = progress
                result["message"] = message
                return None, result
            time.sleep(0.35)
        result["status"] = "timeout"
        process = proxy.progressData.RemeshingProcess
        if process is not None and process.poll() is None:
            process.terminate()
        return None, result
    except Exception as exc:  # Record the commercial-addon failure without losing direct LODs.
        result["status"] = "exception"
        result["error"] = f"{type(exc).__name__}: {exc}"
        return None, result
    finally:
        if welded is not None and welded.name in bpy.data.objects:
            bpy.data.objects.remove(welded, do_unlink=True)
        result["durationSeconds"] = round(time.monotonic() - started, 3)


def emit_decimated_branch(
    source: bpy.types.Object,
    out_dir: Path,
    asset: str,
    prefix: str,
    targets: list[int],
    branch: str,
    start_lod: int = 0,
) -> list[dict]:
    records = []
    for offset, target in enumerate(targets):
        index = start_lod + offset
        clone = clone_object(source, f"{asset}_{prefix.upper()}_LOD{index}")
        decimate_to(clone, target)
        stats = mesh_stats(clone)
        path = out_dir / f"{asset}-{prefix}-lod{index}-{stats['triangles']}tri.glb"
        export_glb(clone, path)
        records.append(artifact_record(path, stats, branch, target))
        bpy.data.objects.remove(clone, do_unlink=True)
    return records


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    direct_targets = [int(value) for value in args.direct_targets.split(",") if value]
    quad_lod_targets = [int(value) for value in args.quad_lod_targets.split(",") if value]
    report = {
        "schemaVersion": 1,
        "asset": args.asset,
        "source": {
            "path": str(input_path),
            "bytes": input_path.stat().st_size,
            "sha256": sha256(input_path),
        },
        "blender": bpy.app.version_string,
        "normalizationHeight": args.height,
        "artifacts": [],
    }

    source = import_joined_mesh(input_path, f"{args.asset}_SOURCE")
    normalize(source, args.height)
    select_only(source)
    source_stats = mesh_stats(source)
    report["source"]["mesh"] = source_stats
    print("SOURCE_STATS", json.dumps(source_stats))

    if not args.skip_direct:
        report["artifacts"].extend(
            emit_decimated_branch(
                source,
                out_dir,
                args.asset,
                "direct",
                direct_targets,
                "uv-preserving-direct-decimate",
            )
        )

    if args.skip_quad:
        report["quadRemesher"] = {"requested": False, "status": "skipped"}
    else:
        remeshed, quad_report = run_quad_remesher(
            source, args.quad_target, args.quad_timeout, args.quad_voxel_size
        )
        report["quadRemesher"] = quad_report
        if remeshed is not None:
            quad_stats = mesh_stats(remeshed)
            quad_path = out_dir / f"{args.asset}-quad-lod0-{quad_stats['triangles']}tri.glb"
            export_glb(remeshed, quad_path)
            report["artifacts"].append(
                artifact_record(quad_path, quad_stats, "quad-remesher", args.quad_target * 2)
            )
            report["artifacts"].extend(
                emit_decimated_branch(
                    remeshed,
                    out_dir,
                    args.asset,
                    "quad",
                    quad_lod_targets,
                    "quad-remesher-then-decimate",
                    start_lod=1,
                )
            )
            select_only(remeshed)
            bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / f"{args.asset}-quad-source.blend"))

    report_path = out_dir / "optimization-report.json"
    with report_path.open("w", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print("OPTIMIZATION_REPORT", str(report_path))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
