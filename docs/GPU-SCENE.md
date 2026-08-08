# GPU Scene phase 1

## Shipped path

`GpuMasonryScene` keeps generation, navigation, picking and structural damage
CPU-authoritative, while moving the dense middle-course masonry render path to
WebGPU:

- one immutable local-space matrix/color source pool (capacity 65,536);
- one small world-matrix table (capacity 128 slots) for rise animation and
  future streaming;
- one compute scan which rejects destroyed, hidden-LOD and off-frustum items;
- atomic compaction into high and middle LOD storage buffers;
- two `drawIndexedIndirect` commands sharing one indirect buffer;
- stable source IDs in the unused output-color W component for validation and
  future GPU picking;
- CPU source meshes retained at count zero for raycast damage authority;
- a localized occlusion fallback: only the slot between camera and player uses
  its per-slot fade mesh; the rest remain globally compacted.

The culling kernel uses exactly eight storage bindings, WebGPU's portable
minimum. If construction or compute fails, the class releases ownership back
to the existing per-slot meshes. `?gpuscene=0` explicitly selects that fallback.

## Measured result

The final comparison uses a deterministic camera, seed `359139884`, 1280×720,
DPR 1, clustered lighting, AO disabled, 25 warm-up frames, 100 loops and six
GPU-complete draws per loop. Two paired runs were averaged:

| Path | median frame | P95 frame | submitted render objects |
| --- | ---: | ---: | ---: |
| per-slot baseline | 5.913 ms | 14.742 ms | 346 |
| GPU Scene | 5.542 ms | 14.750 ms | 339 |

The median improves 6.27%; P95 is effectively unchanged (+0.05%). Dense
middle-course masonry falls from eight submitted objects to one. In the fixed
overview, 16,361 of 16,397 source instances survive per-instance culling.

Validation artifacts:

- `artifacts/iterations/gpu-scene-fixed-off-100.json`
- `artifacts/iterations/gpu-scene-fixed-on-100.json`
- `artifacts/iterations/gpu-scene-final-off-100-b.json`
- `artifacts/iterations/gpu-scene-final-on-100-b.json`
- `artifacts/iterations/gpu-scene-reforge-5.json`

GPU readback validation reports zero invalid matrices, non-finite transforms or
authority mismatches. Five in-page reforges report zero stale pool objects,
buffer-capacity failures, GPU validation errors or unreachable navigation.
The managed-brick destruction regression opens a real breach, hides three GPU
source instances, preserves route reachability and reports no blocked frame.

## Why this is not a meshlet renderer yet

Brick courses are repeated low-poly instances, so instance compaction produces
more value than subdividing each brick into meshlets. Meshlets are appropriate
for the dragon, oracle, cliffs and other large irregular meshes. A later phase
can preprocess those assets into clusters (bounds, normal cone, index/vertex
ranges), compute-compact visible cluster commands and draw them through a small
set of material/LOD bins.

The browser WebGPU path does not currently assume mesh shaders, bindless
materials or true multi-draw indirect. That keeps phase 1 portable and makes
fallback behavior explicit.

## Destruction data direction

Scene data should remain split into three layers:

1. immutable render records: local transform, material/geometry key and bounds;
2. mutable gameplay state: alive bit, support graph, health and nav ownership;
3. transient physics: only awake fracture clusters and GPU visual debris.

Do not create one rigid body per intact brick. Promote a damaged structural
cluster to Rapier only near gameplay, then return sleeping debris to a compact
GPU representation. The stable source ID written by phase 1 is the bridge
between render compaction and those sparse state tables.
