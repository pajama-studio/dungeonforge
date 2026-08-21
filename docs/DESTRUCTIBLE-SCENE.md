# Dungeonforge whole-scene destructibility architecture

## Conclusion

Do not keep a resident rigid body for every brick, every pillar and every piece of
dressing. The best-performing approach is a hybrid architecture:

1. The complete scene keeps being rendered with partitioned instancing and surface culling.
2. Every destructible element carries only a lightweight
   `DestructibleId + damage/support metadata`.
3. On a hit, only the affected local structure is "activated" out of the static instance
   pool into a small number of rigid-body clusters.
4. Rapier/WASM owns the rigid-body clusters that affect gameplay; WebGPU compute owns the
   visual debris, which is numerous but does not affect gameplay.
5. Sleeping rigid bodies are re-baked into static rubble instances, releasing the physics
   objects.

This means "the whole scene is destructible", but not "the whole scene runs physics every
frame".

## Data layers

### 1. Static GPU Scene

Each streaming slot is divided into roughly `16×16×8` structural units, which store:

- visible surface instances; interior bricks are still not submitted.
- a stable `DestructibleId = slot/type/localIndex/generation`.
- alive bit, damage, fracture template, material strength.
- a compact collider occupancy/height atlas.
- structural support nodes and their neighbour edges.

The full state keeps using the current InstancedMesh / fixed-capacity pools. If we later
bypass Three's submission layer, this can be upgraded to GPU compaction + indirect draw,
but the data model does not need to be redone.

### 2. Structural support graph

Walls, pillars, floor slabs, bridges, stairs and large props are structural nodes;
"load-bearing from below", "keyed in laterally" and "suspended" are edges with a strength.
One act of destruction only runs a bounded flood-fill from the damaged node:

- Components still connected to a foundation/anchor stay static.
- A small component that has lost its support is activated as a single compound rigid body.
- An unstable component that is too large is split along prefabricated fracture seams
  rather than activated brick by brick.

Node deletion is a poor fit for union-find alone; use a per-chunk local BFS/DFS instead.
Rust/WASM is well suited to that deterministic computation.

### 3. Two-layer physics

Gameplay physics uses Rapier/WASM:

- doors, chests, enemies, broken bridges, large wall sections and debris that can crush a
  character.
- only active islands near the camera/player are kept.
- large pieces use a convex hull or compound boxes, never a dynamic triangle mesh.
- a hard limit of 256–512 awake bodies is recommended; at most 16–32 clusters activated
  per frame.

Visual physics uses WebGPU compute:

- brick chips, wood splinters, dust, leaves, sparks and small stones.
- queries the static occupancy/height texture; no pairwise collision between individual
  debris fragments.
- fixed capacity of 2K–8K with ring reuse; over budget, shorten lifetimes and drop small
  fragments first.
- on sleep, write into static rubble instances, or recycle while out of sight.

Putting all rigid-body physics on the GPU is not recommended: the support graph, character
damage, navigation and saving all need CPU-authoritative state, GPU readback would cancel
out the gains, and browser WebGPU binding/device limits vary noticeably.

## Data flow for a single hit

1. A BVH/instance ray query yields a `DestructibleId`.
2. The damage event modifies the local damage field and hides or replaces the full
   instance.
3. Rust/WASM recomputes the support components of that chunk only.
4. Destabilised clusters are moved out of the static pool and a small number of Rapier
   bodies are created.
5. The same event writes visual debris commands into the fixed GPU debris pool.
6. A conservative nav blocker is added immediately; affected nav tiles are rebuilt in the
   background.
7. Once a rigid body sleeps it is baked into static rubble and its body/collider destroyed.
8. Saving records only the seed + the destruction event log/bitset, never the serialized
   scene.

## What destruction means for "every element"

- Walls/pillars/floor slabs/bridges/stairs: structural damage, support collapse, local nav
  rebuild.
- Doors/chests/altars: prefabricated fracture states + a small number of gameplay rigid
  bodies.
- Enemies: character physics and a hit-reaction system; they never enter the building
  support graph.
- Vegetation/banners/ropes: after the attachment is cut, use a simplified chain or go
  straight to GPU fragments.
- Flames/light beams/smoke: destroy the corresponding emitter/anchor, spawn no rigid body.
- Blood/moss/stains: erased, scorched or covered by rubble — only the decal alive bit
  changes.
- Floors: create the hole blocker first, then rebuild navigation locally; game rules can
  keep load-bearing on the critical path from failing completely.

## Current implementation and the next phase

GPU debris today has a fixed capacity of 768, real WalkMap ground sampling, size-aware
contact, a bounded ground region, gravity, bounce, friction and sleep. Fragments share the
same procedural stone factory as the original bricks (hand-painted noise, mortar, wear,
pitting, cracks, relief normals and Lambert lighting), and copy the actual colour of the
instance that was hit; non-uniform scale and tumbling correct the normals in step.

A 24-destruction browser regression produced 270 fragments, 22 groups of inherited colour
and 2 real route breaches, with 100% material/colour inheritance and 0 GPU validation
errors and 0 instance-buffer overruns. The direct hit and the chained collapse from the
same click merge into a single command transaction and upload only the modified range of
the ring pool: in this sample that fell from a whole-buffer-equivalent 1,400,832 B to
20,520 B, a 98.54% reduction. The old path, dirtying per fragment, was equivalent to 1,350
markings; the current one is 120.

The recommended build order is:

1. Establish a unified `DestructibleRegistry` so buildings, props, vegetation and emitters
   all have stable IDs.
2. Bring in Rapier, activating only chests, doors and one wall cluster, to validate the
   two-layer physics lifecycle.
3. Generate a support graph and occupancy atlas per slot, covering walls, pillars, bridges
   and floor slabs first.
4. Add the active-body budget, sleep baking, the event log and local nav tiles.
5. Only then do wide-area chain collapse, flame/acid material damage and enemy physics
   interaction.
