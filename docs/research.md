# Research: procedurally generating 3D stone-labyrinth fortress dungeons

> 2026-08-06 · A synthesis of four parallel investigations (classic algorithms /
> 3D verticality / industry pipelines / rendering technique).
> Target image: a night isometric multi-level stone labyrinth fortress — thick-walled
> maze, walkable wall tops, grand staircases, a raised temple at the back,
> a circular sigil plaza, towers, torches + blue banners, abyss fog, a red-lit chamber.

## 1. Conclusion first

There is **no single algorithm** for this kind of dungeon in the industry; every
mature system is a **layered pipeline (abstract first, refine later)**:

```
macro topology (graph) → height layering (tier field) → floor plan (maze/rooms) →
connectivity guarantee (stairs/bridges) → modular assembly (marching-squares → 3D kit) →
dressing rules (torches/banners/variant swaps) → rendering (instancing + bloom + fog)
```

For this particular image, the best-evidenced recipe is:

- **Floor plan**: Nystrom-style rooms-and-mazes (growing-tree maze + braiding loops +
  thick-wall tile grid) — an exact match for the dense-maze feel; Diablo-style room
  scattering (TinyKeep) produces sparse room clusters, not this.
- **Vertical**: quantize the height field into discrete tiers + a "neighbours differ by ≤1"
  smoothing rule (SC2 cliffs / Tivolt terracing), a per-tier connected-component graph +
  spanning-tree edge selection for stair placement, BFS acceptance (the standard recipe).
- **Landmarks**: fixed at the graph level first (the Unexplored principle) — temple
  (weenie), sigils, tower and bridge all have their position and connectivity decided on
  the abstract graph before they become geometry; **carving the ravine first and then
  hunting for a bridge site is an anti-pattern**.
- **Assembly**: tile grid → neighbourhood case-table (Diablo 1's marching-squares idea)
  picks a 3D module, rendered with instancing; Bad North's "tiles carry their own
  walkability metadata" is the strongest guarantee of stair correctness.
- **Rendering**: three.js WebGPU + TSL — MRT emissive bloom, `scene.fogNode` height fog,
  billboarding TSL flames, AgX tone mapping, per-instance AO tinting.

## 2. Algorithm families compared (when to use what)

| Family | Output shape | Connectivity | Match to this image | Role |
|---|---|---|---|---|
| maze (growing-tree) + braid + rooms | dense corridors, thick walls | guaranteed by construction | **exact match** | primary floor-plan generator |
| height-field quantization + stair repair | terraces, cliffs, ramps | guaranteed by BFS repair | **exact match** (vertical) | primary vertical generator |
| TinyKeep scatter + Delaunay + MST | organic room clusters + wide corridors | guaranteed by MST | low (too sparse) | not used; but keep its "graph as a first-class citizen" idea |
| BSP | rectilinear floor plans | guaranteed by the tree | medium | optional, for partitioning special rooms |
| cellular automata | organic caves | needs repair | low | only as garnish for "collapsed areas" |
| cyclic generation (Dormans) | designed-feeling loops + lock-and-key | guaranteed by construction | applies at the topology layer | simplified: directly generate 1 large loop + nested small loops |
| WFC / model synthesis | locally consistent tiles | **not guaranteed** | applies at the assembly layer | detailer only, never designer (the Caves of Qud lesson) |

Key references:
- maze braiding: knock dead ends open at a set proportion (p≈0.3–0.6) — the knob between
  "annoying maze" and "walled arena"
- Bob Nystrom [Rooms and Mazes](http://journal.stuffwithstuff.com/2014/12/21/rooms-and-mazes/):
  place rooms → fill the gaps with maze → open doors between regions → prune dead ends,
  which is exactly "stone-fortress rooms embedded in a dense maze"
- Boris the Brave's [Diablo 1](https://www.boristhebrave.com/2019/07/14/dungeon-generation-in-diablo-1/) /
  [Unexplored](https://www.boristhebrave.com/2021/04/10/dungeon-generation-in-unexplored/) /
  [Gungeon](https://www.boristhebrave.com/2019/07/28/dungeon-generation-in-enter-the-gungeon/)
  are three required-reading articles
- The verticality bible: Bad North (EPC2018 talk) — every tile carries "which sides you can
  enter and leave from" metadata, and the WFC collapse keeps the already-observed region
  navigable throughout; a staircase is just an ordinary tile whose low edge and high edge
  are both walkable
- Standard stair-repair recipe: flood-fill into tier components → component graph →
  spanning tree (+ loop edges) → place stairs along boundaries where the tier difference
  is 1 (**both ends must be verified to land on walkable cells**) → BFS from the entrance
  to accept the whole map, re-roll a derived seed on failure

## 3. Where industry pipelines converge

1. **Abstract first, art later** (Diablo's two-stage predungeon → tile selection;
   Gungeon's flow graph → room templates)
2. **Random composition, hand-authored pieces** (the D3/D4 trend: tiles are hand-made and
   the algorithm only places them; dressing is a swappable data layer —
   theme = data, geometry = shared)
3. **Variant swaps to break up tiling** (Diablo 1: identical variants may not be adjacent;
   LDtk auto-layer rule-based decals)
4. **Torches = a walk along wall cells + a minimum spacing (Chebyshev ≥4–5) + skip
   doorways**; the predecessor gpulab dungeon had already implemented a spatial-hash
   version of this (`src/gpulab/dungeon/generate.ts`, in that project, not this repo), so
   the approach carries over directly — Dungeonforge's equivalent is the min-Chebyshev
   bucket walk in `src/gen/dungeon.ts`
5. **The weenie principle** (Disney): one landmark taller than everything else and lit
   distinctively anchors the composition — here that is the temple; the most special node
   is fixed first during generation, and dressing density climbs toward it
6. A distance field (BFS from the entrance) serves several purposes at once: the difficulty
   curve, semantic rooms (entrance/treasure/boss) and dressing density

## 4. Rendering recipe (three.js 0.185 WebGPU + TSL)

- **Bloom**: MRT emissive bloom (`scenePass.setMRT({output, emissive})` →
  `bloom(emissiveTex)`) — only the emissive channel enters bloom, so flames/sigils/portals
  glow while sandstone walls do not, and no threshold needs tuning
- **Fog**: `scene.fogNode` = height fog + `triNoise3D` perturbation (the official
  `webgpu_custom_fog` example is exactly "fog pooling in low ground"), covering the whole
  scene at zero draw calls; the ravine adds 2–3 layers of scrolling noise fog planes +
  a few billboard fog puffs
- **Flames**: the official `webgpu_tsl_vfx_flames` recipe — sprite + `billboarding()` +
  cellular noise scrolling upward + a gradient ramp (night-torch orange:
  `#1a0500→#7a2000→#ff7b24→#ffd9a0→#fff6e0`), colour driven through emissiveNode
- **Light budget**: one shadow-casting directional light (cold moonlight) + a nearest-N
  pool of real PointLights for the torches (6–12, no shadows) + everything else pure
  emissive; `ClusteredLightsNode` (Forward+, thousands of lights) is the step up
- **Flicker**: 2–3 sines at coprime frequencies + noise, per-torch phase =
  `hash(instanceIndex)`
- **Instancing**: same geometry → InstancedMesh; multiple geometries sharing a material
  (the whole stone kit) → BatchedMesh in one draw; per-instance colour via `setColorAt`
  (available under WebGPU) or TSL `hash(instanceIndex)`
- **AO**: for a blocky scene the best answer is **baking per-instance AO tint at build
  time** (a Minecraft-style neighbourhood occlusion score multiplied into colorNode) —
  more stable than GTAO and more "hand-painted"; GTAO+TRAA can be added later
- **Grading**: AgX tone mapping (blue highlights do not skew purple, better than ACES) +
  night exposure ~0.5; emissive intensity 10×+ treated as lighting data; two-tone fog,
  warm near and cool far; vignette
- **Banners**: a plane with 20×30 segments, TSL positionNode double-sine displacement,
  `uv.y` weighting pinning the pole edge
- **Sigils**: polar-coordinate SDF (concentric rings via smoothstep + angular segment hash
  to break the rings + reciprocal glow), emissiveNode in blue/gold

## 5. Open-source references worth studying

- [majidmanzarpour/threejs-procedural-dungeon](https://github.com/majidmanzarpour/threejs-procedural-dungeon) — the closest ready-made reference (deterministic seed, five themes, instancing, bloom+tilt-shift)
- [felixturner hex-map-wfc](https://felixturner.github.io/hex-map-wfc/article/) — production-grade three.js WFC writeup: BatchedMesh 2 draw calls, WebGPU/TSL, chunked solving
- [marian42 infinite WFC city](https://marian42.de/article/wfc/) — 3D WFC vertical connector mechanism + chunked infinite generation
- [Vazgriz 3D dungeon](https://vazgriz.com/119/procedurally-generated-dungeons/) — TinyKeep made 3D + A* stairs
- [BorisTheBrave/DeBroglie](https://github.com/BorisTheBrave/DeBroglie) — WFC with global path constraints (C#, the approach ports)
- Prior work in the predecessor gpulab project: `src/gpulab/dungeon/generate.ts` — an existing deterministic flat dungeon generator (its RNG, torch spacing and BFS distance field are all reusable). That file is not part of this repo; Dungeonforge's generator is `src/gen/dungeon.ts`.

### `threejs-procedural-dungeon` absorption boundary (verified 2026-08-07)

The through-line of this reference is `scatter → separate → Delaunay → MST + loops →
room semantics → tile carve → BFS validation → decoration`, under an MIT licence. It is
suited to being a **reference for macro topology and narrative annotation**, not a base
for the current rendering architecture or the multi-level spatial implementation.

| Reference point | Use in Dungeonforge | Decision |
|---|---|---|
| MST guarantees connectivity, then short loops are added back by probability | used for the block/island-level candidate connection graph; Markov still only handles local 3D refinement inside a block | absorb the idea |
| BFS from the entrance yields depth, the critical path and room roles | drives enemy strength, chests, temple/elite rooms and the reward before a portal; inter-level connections enter the same semantic graph | port first |
| `doorway`, `nearDoor`, `interior`, scattering decoration only after an occupancy mask | unifies the constraints on pillars, chests, enemies and post-destruction routes, so a cell occupied by a pillar is never judged walkable | port first |
| generation-stage / graph / difficulty overlays with live statistics | gives multi-level connections, route backtracking and GPU Scene culling a visual acceptance check | absorb the idea |
| single-level 2D tiles, L-shaped corridors | cannot express the current random floor-to-floor joins, bridges, spiral stairs or the 3D structure inside a block | do not port |
| WebGL post-processing, one plain `InstancedMesh` per category | no HZB, cluster culling, GPU compaction or indirect draw, so it cannot solve heavy brick occlusion | do not port |
| generation, rendering and UI coupled in a single file | conflicts with the current pure-data worker + slot pool architecture | do not port |

If we later adapt its concrete implementation rather than only adopting the algorithmic
ideas, derived files must keep the MIT copyright attribution; at this stage we only record
the design patterns and copy no source code.

## 6. Recommended architecture for this image (dungeonforge v1)

```
seed
 └─ 1. macro graph: entrance (south) → temple (north, highest) critical path + 1-2 loops;
        landmark nodes: temple, sigils ×2 (blue/gold), tower, red-lit chamber, ravine + bridge
 └─ 2. tier field: fbm noise quantized 0..4 + a mound toward the temple (+2..3, ziggurat stepping)
        + a "neighbouring maze cells differ by ≤1" clamp (assigned as the BFS carries it)
 └─ 3. floor plan: growing-tree maze (newest/random ≈ 0.7/0.3) filling everything → braid p≈0.4
        → clear walls in landmark areas (sigil circle, temple platform, red room) → carve the
        ravine per the graph + fix the bridge before carving
 └─ 4. connectivity: stairs = opening cells where the tier difference is 1 (verify both ends);
        flood-fill BFS acceptance over the whole map, and where disconnected open stairs on the
        component boundary to repair; on failure re-roll a derived seed (≤5 times)
 └─ 5. assembly: neighbourhood case-table → stone courses (walls/crenellations/stairs/towers/ziggurat)
        → variant swaps (hue/brightness jitter, no identical neighbours) → rule-based placement
        of torches/banners/braziers
 └─ 6. rendering: BatchedMesh/InstancedMesh + baked per-instance AO
        + MRT emissive bloom + fogNode height fog + TSL flames/banners/sigils + AgX
```

A pure-data generator (zero THREE dependencies) + a deterministic seed + vitest invariant
tests (connectivity / stair legality / checksum), matching the engineering style of the
predecessor gpulab dungeon.
