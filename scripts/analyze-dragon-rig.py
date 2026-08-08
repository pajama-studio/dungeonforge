"""Inspect the admitted dragon shell before generating a four-leg rig.

Run with Blender, not system Python:
  Blender --background --python scripts/analyze-dragon-rig.py -- input.glb output.json
"""

import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector


def args_after_separator():
    if "--" not in sys.argv:
        raise RuntimeError("expected: -- input.glb output.json")
    return sys.argv[sys.argv.index("--") + 1:]


input_path, output_path = args_after_separator()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(Path(input_path).resolve()))

rows = []
global_min = Vector((float("inf"),) * 3)
global_max = Vector((float("-inf"),) * 3)
for obj in [candidate for candidate in bpy.context.scene.objects if candidate.type == "MESH"]:
    mesh = obj.data
    world = obj.matrix_world
    vertices = [world @ vertex.co for vertex in mesh.vertices]
    if not vertices:
        continue
    minimum = Vector((min(v[i] for v in vertices) for i in range(3)))
    maximum = Vector((max(v[i] for v in vertices) for i in range(3)))
    global_min = Vector((min(global_min[i], minimum[i]) for i in range(3)))
    global_max = Vector((max(global_max[i], maximum[i]) for i in range(3)))

    parent = list(range(len(mesh.vertices)))
    rank = [0] * len(parent)

    def find(v):
        while parent[v] != v:
            parent[v] = parent[parent[v]]
            v = parent[v]
        return v

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if rank[ra] < rank[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        if rank[ra] == rank[rb]:
            rank[ra] += 1

    for edge in mesh.edges:
        union(edge.vertices[0], edge.vertices[1])

    components = {}
    for index, vertex in enumerate(vertices):
        components.setdefault(find(index), []).append(vertex)
    face_counts = {}
    for polygon in mesh.polygons:
        root = find(polygon.vertices[0])
        face_counts[root] = face_counts.get(root, 0) + 1

    component_rows = []
    for root, points in components.items():
        lo = Vector((min(v[i] for v in points) for i in range(3)))
        hi = Vector((max(v[i] for v in points) for i in range(3)))
        center = (lo + hi) * 0.5
        component_rows.append({
            "vertices": len(points),
            "faces": face_counts.get(root, 0),
            "min": list(lo),
            "max": list(hi),
            "center": list(center),
            "size": list(hi - lo),
        })
    component_rows.sort(key=lambda row: row["faces"], reverse=True)
    rows.append({
        "object": obj.name,
        "vertices": len(mesh.vertices),
        "faces": len(mesh.polygons),
        "min": list(minimum),
        "max": list(maximum),
        "components": component_rows[:160],
    })

report = {
    "input": str(Path(input_path).resolve()),
    "bounds": {"min": list(global_min), "max": list(global_max), "size": list(global_max - global_min)},
    "axes": {"forward": "+X", "lateral": "Y", "up": "+Z"},
    "meshes": rows,
}
Path(output_path).parent.mkdir(parents=True, exist_ok=True)
Path(output_path).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"output": output_path, "bounds": report["bounds"], "meshes": len(rows)}))
