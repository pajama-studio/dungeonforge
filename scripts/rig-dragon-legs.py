"""Add deterministic four-leg and neck deformation rigs to the dragon GLB.

The Tripo shell is highly fragmented, so connectivity cannot identify limbs.
Weights are assigned from conservative anatomical volumes in the normalized
dragon space (+X forward, Y lateral, +Z up). Wings, tail, head and torso stay
on the root; only the four low, near-body leg volumes deform.

Run with Blender:
  Blender --background --python scripts/rig-dragon-legs.py -- input.glb output.glb report.json
"""

import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector


def cli_args():
    if "--" not in sys.argv:
        raise RuntimeError("expected: -- input.glb output.glb report.json")
    return sys.argv[sys.argv.index("--") + 1:]


args = cli_args()
if len(args) < 3:
    raise RuntimeError("expected: -- input.glb output.glb report.json [--no-draco]")
input_path, output_path, report_path = args[:3]
use_draco = "--no-draco" not in args[3:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(Path(input_path).resolve()))
meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
if len(meshes) != 1:
    raise RuntimeError(f"expected one dragon mesh, found {len(meshes)}")
dragon = meshes[0]
dragon.name = "AbyssDragonRigged"
bpy.context.view_layer.objects.active = dragon
dragon.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

armature_data = bpy.data.armatures.new("AbyssDragonLegRig")
armature = bpy.data.objects.new("AbyssDragonLegRig", armature_data)
bpy.context.collection.objects.link(armature)
bpy.context.view_layer.objects.active = armature
armature.select_set(True)
dragon.select_set(False)
bpy.ops.object.mode_set(mode="EDIT")

root = armature_data.edit_bones.new("dragon_root")
root.head = (0, 0, 0)
root.tail = (0, 0, 1)

# Front/rear coordinates were measured from the normalized admitted shell.
# Each chain follows the visible hanging limb instead of an abstract quadruped.
leg_specs = {
    "fore_left":  {"hip": (0.25, 1.28, 4.75), "knee": (0.05, 1.42, 2.45), "ankle": (0.42, 1.34, 0.72), "toe": (1.02, 1.34, 0.38)},
    "fore_right": {"hip": (0.25, -1.28, 4.75), "knee": (0.05, -1.42, 2.45), "ankle": (0.42, -1.34, 0.72), "toe": (1.02, -1.34, 0.38)},
    "hind_left":  {"hip": (-2.25, 1.58, 4.95), "knee": (-2.38, 1.72, 2.55), "ankle": (-1.86, 1.62, 0.74), "toe": (-1.18, 1.60, 0.36)},
    "hind_right": {"hip": (-2.25, -1.58, 4.95), "knee": (-2.38, -1.72, 2.55), "ankle": (-1.86, -1.62, 0.74), "toe": (-1.18, -1.60, 0.36)},
}

for name, spec in leg_specs.items():
    upper = armature_data.edit_bones.new(f"{name}_upper")
    upper.head, upper.tail, upper.parent = spec["hip"], spec["knee"], root
    lower = armature_data.edit_bones.new(f"{name}_lower")
    lower.head, lower.tail, lower.parent, lower.use_connect = spec["knee"], spec["ankle"], upper, True
    foot = armature_data.edit_bones.new(f"{name}_foot")
    foot.head, foot.tail, foot.parent, foot.use_connect = spec["ankle"], spec["toe"], lower, True
    target = armature_data.edit_bones.new(f"ik_{name}_target")
    # CCDIKSolver uses the effector bone origin (the ankle), not its tail/toe.
    target.head = spec["ankle"]
    target.tail = Vector(spec["ankle"]) + Vector((0, 0, 0.35))
    target.parent = root
    target.use_deform = False

# A restrained three-bone neck chain lets the perched dragon keep its body on
# the rock while its head tracks the maze/oracle confrontation. +X is forward.
neck_specs = {
    "base": ((0.95, 0, 5.85), (2.15, 0, 5.62)),
    "mid": ((2.15, 0, 5.62), (3.45, 0, 5.18)),
    "head": ((3.45, 0, 5.18), (5.35, 0, 4.72)),
}
neck_parent = root
for segment in ("base", "mid", "head"):
    neck = armature_data.edit_bones.new(f"neck_{segment}")
    neck.head, neck.tail = neck_specs[segment]
    neck.parent = neck_parent
    neck.use_connect = neck_parent is not root
    neck_parent = neck
neck_tip = armature_data.edit_bones.new("neck_tip")
neck_tip.head = neck_specs["head"][1]
neck_tip.tail = Vector(neck_tip.head) + Vector((0.35, 0, -0.06))
neck_tip.parent = neck_parent
neck_tip.use_connect = True
neck_tip.use_deform = False
neck_target = armature_data.edit_bones.new("ik_neck_target")
neck_target.head = neck_tip.head
neck_target.tail = Vector(neck_target.head) + Vector((0, 0, 0.35))
neck_target.parent = root
neck_target.use_deform = False

bpy.ops.object.mode_set(mode="OBJECT")
modifier = dragon.modifiers.new("DragonLegSkin", "ARMATURE")
modifier.object = armature
dragon.parent = armature

groups = {"dragon_root": dragon.vertex_groups.new(name="dragon_root")}
for leg_name in leg_specs:
    for segment in ("upper", "lower", "foot"):
        key = f"{leg_name}_{segment}"
        groups[key] = dragon.vertex_groups.new(name=key)
for segment in ("base", "mid", "head"):
    key = f"neck_{segment}"
    groups[key] = dragon.vertex_groups.new(name=key)


def smoothstep(edge0, edge1, value):
    if edge0 == edge1:
        return 0.0
    x = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return x * x * (3 - 2 * x)


# Preserve disconnected talon/foot islands as rigid pieces. Tripo's shell is
# split into hundreds of components; a single claw component can cross the
# soft z threshold even though it must move as one solid shape. Classifying
# compact low components before vertex weighting prevents intra-claw shear.
component_parent = list(range(len(dragon.data.vertices)))


def component_find(index):
    while component_parent[index] != index:
        component_parent[index] = component_parent[component_parent[index]]
        index = component_parent[index]
    return index


def component_union(a, b):
    ra, rb = component_find(a), component_find(b)
    if ra != rb:
        component_parent[rb] = ra


for edge in dragon.data.edges:
    component_union(edge.vertices[0], edge.vertices[1])
components = {}
for vertex in dragon.data.vertices:
    components.setdefault(component_find(vertex.index), []).append(vertex.index)
rigid_region_by_vertex = {}
rigid_component_counts = {name: 0 for name in leg_specs}
for indices in components.values():
    points = [dragon.data.vertices[index].co for index in indices]
    lo = Vector((min(point[axis] for point in points) for axis in range(3)))
    hi = Vector((max(point[axis] for point in points) for axis in range(3)))
    center = (lo + hi) * 0.5
    compact_low = lo.z < 1.55 and hi.z < 2.05 and (hi.z - lo.z) < 1.75
    if not compact_low or not (0.42 < abs(center.y) < 3.2):
        continue
    if -0.95 < center.x < 2.45:
        fore_hind = "fore"
    elif -3.85 < center.x <= -0.95:
        fore_hind = "hind"
    else:
        continue
    region = f"{fore_hind}_{'left' if center.y >= 0 else 'right'}"
    rigid_component_counts[region] += 1
    for index in indices:
        rigid_region_by_vertex[index] = region


weighted_counts = {name: 0 for name in leg_specs}
neck_weighted_count = 0
for vertex in dragon.data.vertices:
    x, y, z = vertex.co
    rigid_region = rigid_region_by_vertex.get(vertex.index)
    side_name = rigid_region.split("_")[1] if rigid_region else ("left" if y >= 0 else "right")
    fore = rigid_region.startswith("fore") if rigid_region else x >= -0.82
    region = rigid_region or (("fore" if fore else "hind") + "_" + side_name)
    side_abs = abs(y)
    x_mask = (
        smoothstep(-0.82, -0.45, x) * (1 - smoothstep(1.45, 1.72, x))
        if fore else
        smoothstep(-3.65, -3.28, x) * (1 - smoothstep(-0.82, -0.45, x))
    )
    lateral_mask = smoothstep(0.48, 0.82, side_abs) * (1 - smoothstep(2.45, 2.95, side_abs))
    height_mask = 1 - smoothstep(4.65, 5.35, z)
    limb_weight = x_mask * lateral_mask * height_mask
    # Claw clusters extend beyond the soft anatomical boxes used by the leg
    # volume. Give the entire low cluster an almost-rigid foot assignment so
    # adjacent vertices cannot receive wildly different transforms and stretch
    # a talon into the long strips seen in the runtime screenshot.
    rigid_claw = rigid_region is not None or (
        z < 1.48 and 0.10 < side_abs < 4.05 and
        ((fore and -0.95 < x < 2.95) or ((not fore) and -4.25 < x < 0.35))
    )
    if rigid_claw:
        limb_weight = max(limb_weight, 0.98)

    neck_lateral = 1 - smoothstep(0.72, 1.52, side_abs)
    neck_forward = smoothstep(0.62, 1.18, x) * (1 - smoothstep(5.72, 6.22, x))
    neck_height = smoothstep(3.55, 4.25, z) * (1 - smoothstep(8.55, 9.35, z))
    neck_weight = neck_lateral * neck_forward * neck_height

    # Overlapping ramps keep knee/ankle and neck segment transitions smooth.
    foot_w = 0.98 if rigid_claw else (1 - smoothstep(0.82, 1.42, z)) * limb_weight
    upper_w = 0 if rigid_claw else smoothstep(2.05, 3.0, z) * limb_weight
    lower_w = 0 if rigid_claw else max(0.0, limb_weight - foot_w - upper_w)
    neck_head_w = smoothstep(3.35, 4.42, x) * neck_weight
    neck_base_w = (1 - smoothstep(1.62, 2.55, x)) * neck_weight
    neck_mid_w = max(0.0, neck_weight - neck_head_w - neck_base_w)
    weights = {
        f"{region}_foot": foot_w,
        f"{region}_lower": lower_w,
        f"{region}_upper": upper_w,
        "neck_base": neck_base_w,
        "neck_mid": neck_mid_w,
        "neck_head": neck_head_w,
    }
    non_root = sum(weights.values())
    if non_root < 0.025:
        groups["dragon_root"].add([vertex.index], 1.0, "REPLACE")
        continue
    deform_total = min(0.98, non_root)
    deform_scale = deform_total / non_root
    weights = {name: weight * deform_scale for name, weight in weights.items()}
    weights["dragon_root"] = 1.0 - deform_total
    for group_name, weight in weights.items():
        if weight > 1e-5:
            groups[group_name].add([vertex.index], weight, "REPLACE")
    if limb_weight >= 0.025:
        weighted_counts[region] += 1
    if neck_weight >= 0.025:
        neck_weighted_count += 1

# Keep the armature visible to exporters and make the mesh the active object.
armature.show_in_front = True
bpy.context.view_layer.objects.active = dragon
dragon.select_set(True)
armature.select_set(True)

Path(output_path).parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(Path(output_path).resolve()),
    export_format="GLB",
    use_selection=True,
    export_apply=False,
    export_yup=True,
    export_skins=True,
    export_all_influences=False,
    export_def_bones=False,
    export_draco_mesh_compression_enable=use_draco,
    export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14,
    export_draco_normal_quantization=10,
    export_draco_texcoord_quantization=12,
)

report = {
    "input": str(Path(input_path).resolve()),
    "output": str(Path(output_path).resolve()),
    "bones": [bone.name for bone in armature.data.bones],
    "legSpecs": leg_specs,
    "neckSpecs": neck_specs,
    "weightedVertices": weighted_counts,
    "neckWeightedVertices": neck_weighted_count,
    "rigidClawComponents": rigid_component_counts,
    "vertices": len(dragon.data.vertices),
    "polygons": len(dragon.data.polygons),
    "bytes": Path(output_path).stat().st_size,
    "compression": "draco" if use_draco else "uncompressed-runtime",
}
Path(report_path).parent.mkdir(parents=True, exist_ok=True)
Path(report_path).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"output": output_path, "bytes": report["bytes"], "weightedVertices": weighted_counts}))
